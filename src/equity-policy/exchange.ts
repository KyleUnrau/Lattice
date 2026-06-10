import type { ResidualAccount } from "../ledger-kernel/accounts.js";
import type { BookValueEngine } from "./book-value/engine.js";
import type { Position } from "../ledger-kernel/positions.js";
import type { Transaction } from "../ledger-kernel/transactions.js";
import { Exchange, ResidualUTXI, ResidualUTXO } from "../ledger-kernel/transactions/cross-position.js";
import type { Input, UTXOConsumption } from "../ledger-kernel/transactions/inputs.js";
import type { Output, UTXIConsumption } from "../ledger-kernel/transactions/outputs.js";
import { computeRecaptureResolution } from "./recapture.js";
import { consumedUTXOsFromInputs } from "./utils.js";

/** The paired outputs of {@link Exchange.recapture} — the two sides of a locked-rate reversal. */
export interface ExchangeRecapture {
    /** {@link UTXIConsumption} settling the to-side of the original exchange. Goes in a transaction's outputs. */
    from: UTXIConsumption;
    /** {@link UTXOConsumption} reclaiming the from-side of the original exchange. Goes in a transaction's inputs. */
    to: UTXOConsumption;
}

type RecaptureResolution = ReturnType<typeof computeRecaptureResolution>;

/** A single-position settlement transaction emitted as part of a multi-hop unwind. */
export interface HopTransaction {
    position: Position;
    inputs: Input[];
    outputs: Output[];
}

/**
 * Records an exchange of inputs into `targetPosition` and resolves all basis-tracking work.
 *
 * The consumed value's full provenance is unwound (see {@link computeRecaptureResolution}):
 * where the lineage loops back to `targetPosition`, **every** exchange edge on the path is
 * recaptured at its locked rate; where it does not loop, the portion opens a forward exchange
 * that carries provenance onward. A recovered loop spanning multiple positions settles through a
 * chain of single-position transactions threaded by {@link Exchange.recapture}.
 *
 * Build the entry arrays via {@link getFromOutputs} (the consuming/surface transaction's outputs),
 * {@link getToInputs} / {@link getToOutputs} (the receiving/target transaction), and
 * {@link getIntermediateTransactions} (the per-position hop transactions for a deep loop).
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
        inputs: Input[],
        targetPosition: Position,
        actualProceeds: number,
        engine: BookValueEngine,
        transactions: Transaction[],
        residualAccount: ResidualAccount
    ) {
        const consumedUTXOs = consumedUTXOsFromInputs(inputs);
        const resolution = computeRecaptureResolution(consumedUTXOs, targetPosition, actualProceeds, engine, transactions);

        this.surfacePosition = resolution.surfacePosition;
        this.targetPosition = targetPosition;
        this.recaptures = resolution.recaptures;
        this.exchange = this.forwardExchange(resolution, resolution.surfacePosition, targetPosition);
        this.residuals = this.resolveResidual(resolution, targetPosition, residualAccount);

        const nodeResult = this.settleResidualNodes(resolution, targetPosition, transactions, residualAccount);
        this.residualCloseOutputs = nodeResult.closeOutputs;
        this.residualMintInputs = nodeResult.mintInputs;
    }

    // Forward exchange only for the portion that did not loop back to the target. Creates suspended
    // cost basis at the actual market rate, carrying the consumed value's provenance onward.
    private forwardExchange(resolution: RecaptureResolution, sourcePosition: Position, targetPosition: Position): Exchange | null {
        if (resolution.newExchangeToQuantity <= 0n) return null;
        return new Exchange(
            { quantity: resolution.newExchangeToQuantity, position: sourcePosition },
            { quantity: resolution.newExchangeFromQuantity, position: targetPosition }
        );
    }

    // Gain and loss are recognized symmetrically in the target position as residual lots carrying
    // the recovered loop's deep-origin basis: a gain is a target-side input, a loss a target-side
    // output. Either way the residual lot is registered in `residualAccount` and recognized
    // immediately, and balances the target transaction by construction.
    private resolveResidual(
        resolution: RecaptureResolution,
        targetPosition: Position,
        residualAccount: ResidualAccount
    ): (ResidualUTXI | ResidualUTXO)[] {
        if (resolution.residualQuantity > 0n)
            return [residualAccount.addResidualInput(resolution.residualQuantity, targetPosition, resolution.residualOriginBasis)];
        if (resolution.residualQuantity < 0n)
            return [residualAccount.addResidualOutput(-resolution.residualQuantity, targetPosition, resolution.residualOriginBasis)];
        return [];
    }

    // Residual-derived value among the consumed inputs: close each open residual leg and mint a new
    // gain in the destination position, re-denominating deferred equity when the residual closes the loop.
    private settleResidualNodes(
        resolution: RecaptureResolution,
        targetPosition: Position,
        transactions: Transaction[],
        residualAccount: ResidualAccount
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
                mintInputs.push(residualAccount.addResidualInput(share, targetPosition, new Map([[targetPosition, share]])));
        }

        return { closeOutputs, mintInputs };
    }

    /** Outputs for the consuming/surface transaction: surface-position recapture settlements, the forward from-side, and closed residual legs. */
    public getFromOutputs(): Output[] {
        return [
            ...this.recaptures.filter(r => r.from.source.position === this.surfacePosition).map(r => r.from),
            ...(this.exchange ? [this.exchange.from] : []),
            ...this.residualCloseOutputs,
        ];
    }

    /** Inputs for the receiving/target transaction: target-position recapture reclaims, forward to-side, gain residual, and settled-residual mints. */
    public getToInputs(): Input[] {
        return [
            ...this.recaptures.filter(r => r.to.source.position === this.targetPosition).map(r => r.to),
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
        const byPosition = new Map<Position, HopTransaction>();
        const bucket = (position: Position): HopTransaction => {
            let entry = byPosition.get(position);
            if (!entry) { entry = { position, inputs: [], outputs: [] }; byPosition.set(position, entry); }
            return entry;
        };

        for (const recapture of this.recaptures) {
            const toPos = recapture.from.source.position;   // settling this edge's to-side
            const fromPos = recapture.to.source.position;   // reclaiming this edge's from-side
            if (toPos !== this.surfacePosition && toPos !== this.targetPosition) bucket(toPos).outputs.push(recapture.from);
            if (fromPos !== this.surfacePosition && fromPos !== this.targetPosition) bucket(fromPos).inputs.push(recapture.to);
        }

        return [...byPosition.values()];
    }
}
