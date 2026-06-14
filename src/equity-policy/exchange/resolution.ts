import type { BookValueEngine } from "../book-value/engine.js";
import type { Position } from "../../ledger-kernel/positions.js";
import type { Transaction } from "../../ledger-kernel/transactions.js";
import { Exchange, ResidualUTXI, ResidualUTXO } from "../../ledger-kernel/transactions/cross-position.js";
import type { Input } from "../../ledger-kernel/transactions/inputs.js";
import type { Output } from "../../ledger-kernel/transactions/outputs.js";
import { computeRecaptureResolution } from "./recapture.js";
import { classifyRecaptures } from "../recaptures.js";
import { ExchangePositionsAccount } from "../../ledger-kernel/accounts/computed.js";
import { type ExchangeRecapture, type HopTransaction, type ResidualTarget, gainAccountOf, lossAccountOf } from "./types.js";

type RecaptureResolution = ReturnType<typeof computeRecaptureResolution>;

/**
 * The exchange-resolution layer: resolves **the portion of consumed value that is actually being
 * exchanged** into `targetPosition` and produces the kernel lines needed to record it, *without*
 * constructing or committing any transaction. The caller owns transaction assembly and may surround
 * these lines with unrelated deposits, withdrawals, fees, or adjustments (see the composition rules
 * below). This is the building block beneath the high-level {@link swap} helper.
 *
 * Pass only the {@link Input}s that represent the exchanged portion as `exchangedInputs`. If a
 * single draw is split between an exchange and some other effect (e.g. exchange 400 of a 500 CAD
 * draw, withdraw the other 100), pass only the 400-CAD consumptions here and record the 100-CAD
 * withdrawal in its own transaction. `actualProceeds` is the `targetPosition` amount received for
 * exactly that exchanged portion.
 *
 * The exchanged portion's full provenance is unwound (see {@link computeRecaptureResolution}):
 * where the lineage loops back to `targetPosition`, **every** exchange edge on the path is
 * recaptured at its locked rate; where it does not loop, the portion opens a forward exchange
 * (scoped to `exchangeAccount`, which is then **required** — see {@link forwardExchange}) that
 * carries provenance onward. A recovered loop spanning multiple positions settles through a chain
 * of single-position transactions threaded by {@link Exchange.recapture}.
 *
 * Build the entry arrays via {@link getFromOutputs} (the consuming/surface transaction's outputs),
 * {@link getToInputs} / {@link getToOutputs} (the receiving/target transaction), and
 * {@link getIntermediateTransactions} (the per-position hop transactions for a deep loop).
 *
 * **Composition rules.** Every exchange line produced here links *only* the exchanged portion: the
 * from-side outputs sum to exactly `sum(exchangedInputs)` and the to-side inputs balance exactly
 * against `actualProceeds`. So you may freely build other, independent transactions in the same
 * business event. You may also add extra lines to the consuming/receiving transactions themselves,
 * but only when they form a **uniform blend** with the exchange lines — the {@link BookValueEngine}
 * attributes every input's basis across all of a transaction's outputs proportionally, so an
 * *independent* sub-flow (a fee with its own input→output correspondence) must be a **separate
 * transaction**, or its lineage will bleed into the exchanged value. When in doubt, keep unrelated
 * effects in their own transactions.
 */
export class ExchangeResolution {
    /** One recapture per distinct prior exchange on the recovered loop path(s); may span positions. */
    public readonly recaptures: ExchangeRecapture[];
    /** Forward exchange at the actual proceeds rate; null when all consumed value looped or was residual-derived. */
    public readonly exchange: Exchange | null;
    /** Gain (`ResidualUTXI`) or loss (`ResidualUTXO`) on the recovered loop, carrying origin basis. */
    public readonly residuals: (ResidualUTXI | ResidualUTXO)[];
    /** Settlements closing the residual legs of residual-derived value being consumed (surface position). */
    public readonly residualCloseOutputs: Output[];
    /** Destination-position gains minted when settling consumed residual-derived value. */
    public readonly residualMintInputs: Input[];

    private readonly surfacePosition: Position;
    private readonly targetPosition: Position;

    constructor(
        exchangedInputs: Input[],
        targetPosition: Position,
        actualProceeds: number,
        engine: BookValueEngine,
        transactions: Transaction[],
        residualAccount: ResidualTarget,
        exchangeAccount: ExchangePositionsAccount
    ) {
        const resolution = computeRecaptureResolution(exchangedInputs, targetPosition, actualProceeds, engine, transactions);

        this.surfacePosition = resolution.surfacePosition;
        this.targetPosition = targetPosition;
        this.recaptures = resolution.recaptures;
        this.exchange = this.forwardExchange(resolution, resolution.surfacePosition, targetPosition, exchangeAccount);
        this.residuals = this.resolveResidual(resolution, targetPosition, residualAccount);

        const nodeResult = this.settleResidualNodes(resolution, targetPosition, transactions);
        this.residualCloseOutputs = nodeResult.closeOutputs;
        this.residualMintInputs = nodeResult.mintInputs;
    }

    // Forward exchange only for the portion that did not loop back to the target. Creates suspended
    // cost basis at the actual market rate, carrying the consumed value's provenance onward.
    // Tagging with `exchangeAccount` scopes this exchange to that account's open-position view.
    // `exchangeAccount` is always supplied by callers (required in the constructor); when the
    // exchange fully closes a loop and forwardExchangeToQuantity is zero, it is simply not used.
    private forwardExchange(resolution: RecaptureResolution, sourcePosition: Position, targetPosition: Position, exchangeAccount: ExchangePositionsAccount): Exchange | null {
        if (resolution.forwardExchangeToQuantity <= 0n) return null;
        return new Exchange(
            { quantity: resolution.forwardExchangeToQuantity, position: sourcePosition },
            { quantity: resolution.forwardExchangeFromQuantity, position: targetPosition },
            exchangeAccount
        );
    }

    // Gain and loss are recognized symmetrically in the target position as residual lots carrying
    // the recovered loop's deep-origin basis: a gain is a target-side input, a loss a target-side
    // output. Either way the residual lot is recognized immediately and balances the target
    // transaction by construction. Gains and losses route to their respective accounts via `target`.
    private resolveResidual(
        resolution: RecaptureResolution,
        targetPosition: Position,
        target: ResidualTarget
    ): (ResidualUTXI | ResidualUTXO)[] {
        if (resolution.residualQuantity > 0n)
            return [gainAccountOf(target).addResidualInput(resolution.residualQuantity, targetPosition, resolution.residualOriginBasis)];
        if (resolution.residualQuantity < 0n)
            return [lossAccountOf(target).addResidualOutput(-resolution.residualQuantity, targetPosition, resolution.residualOriginBasis)];
        return [];
    }

    // Residual-derived value among the consumed inputs: close each open residual leg and mint a new
    // gain in the destination position, re-denominating deferred equity when the residual closes the
    // loop. The mint lands in the residual's *own* account (read off `node.residual.account`), so a
    // residual's equity is realized in the account that deferred it rather than an arbitrary one.
    private settleResidualNodes(
        resolution: RecaptureResolution,
        targetPosition: Position,
        transactions: Transaction[]
    ): { closeOutputs: Output[]; mintInputs: Input[]; } {
        if (resolution.residualNodes.length === 0) return { closeOutputs: [], mintInputs: [] };

        const closeOutputs: Output[] = [];
        const mintInputs: Input[] = [];
        const totalResidual = resolution.residualNodes.reduce((sum, n) => sum + n.quantity, 0n);
        let allocated = 0n;

        for (let i = 0; i < resolution.residualNodes.length; i++) {
            const node = resolution.residualNodes[i]!;
            closeOutputs.push(node.residual.consume(node.quantity, transactions));

            const share = i === resolution.residualNodes.length - 1
                ? resolution.residualDerivedProceeds - allocated
                : resolution.residualDerivedProceeds * node.quantity / totalResidual;
            allocated += share;
            if (share > 0n)
                mintInputs.push(node.residual.account.addResidualInput(share, targetPosition, new Map([[targetPosition, share]])));
        }

        return { closeOutputs, mintInputs };
    }

    /** Outputs for the consuming/surface transaction: surface-position recapture settlements, the forward from-side, and closed residual legs. */
    public getFromOutputs(): Output[] {
        return [
            ...this.recaptures.filter(r => r.settlement.source.position === this.surfacePosition).map(r => r.settlement),
            ...(this.exchange ? [this.exchange.from] : []),
            ...this.residualCloseOutputs,
        ];
    }

    /** Inputs for the receiving/target transaction: target-position recapture reclaims, forward to-side, gain residual, and settled-residual mints. */
    public getToInputs(): Input[] {
        return [
            ...this.recaptures.filter(r => r.reclaim.source.position === this.targetPosition).map(r => r.reclaim),
            ...(this.exchange ? [this.exchange.to] : []),
            ...this.residuals.filter((r): r is ResidualUTXI => r instanceof ResidualUTXI),
            ...this.residualMintInputs,
        ];
    }

    /** Outputs for the receiving/target transaction: loss residual (when proceeds fall short of recovered basis). */
    public getToOutputs(): Output[] {
        return this.residuals.filter((r): r is ResidualUTXO => r instanceof ResidualUTXO);
    }

    /**
     * The per-position hop transactions threading a multi-hop loop unwind: each position crossed
     * between the surface and the target gets one balanced transaction whose inputs reclaim the
     * inner edge's from-side and whose outputs settle the next edge's to-side (netting to zero).
     * Commit these (in array order) between the consuming and receiving transactions.
     */
    public getIntermediateTransactions(): HopTransaction[] {
        return classifyRecaptures(this.recaptures, this.surfacePosition).hops;
    }
}
