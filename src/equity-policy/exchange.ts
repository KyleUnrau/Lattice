import type { BookValueEngine, ResidualPath } from "./book-value/engine.js";
import { assertPositionUnifiromity, type Position } from "../ledger-kernel/positions.js";
import { sumNodeQuantityScaled, Transaction } from "../ledger-kernel/transactions.js";
import { Exchange, ResidualUTXI, ResidualUTXO } from "../ledger-kernel/transactions/cross-position.js";
import { type Input } from "../ledger-kernel/transactions/inputs.js";
import { type Output } from "../ledger-kernel/transactions/outputs.js";
import { classifyRecaptures, executeRecaptures, unwind, type Recapture } from "./recaptures.js";
import { ExchangeAccount, gainAccountOf, lossAccountOf, type ResidualTarget } from "../ledger-kernel/accounts/computed.js";
import { type HopTransaction } from "./recaptures.js";
import { collectOriginLeaves } from "./book-value/lineage.js";

interface ResidualSettlement {
    closedOutputs: Output[];
    mintedInputs: Input[];
}

// Internal intermediate shape — not part of the public API.
export type ExchangeRecaptureResolution = {
    /** One recapture per distinct exchange on the recovered loop path(s); may span positions. */
    recaptures: Recapture[];
    /** Recovered basis in `targetPosition` (the loop principal). */
    totalCostBasis: bigint;
    /** Gain (>0) or loss (<0) residual in `targetPosition`; balances the target transaction. */
    residualQuantity: bigint;
    /** Forward-exchange surface-side quantity (origin/forward portion with no loop). */
    forwardExchangeToQuantity: bigint;
    /** Forward-exchange target-side quantity at the actual proceeds rate. */
    forwardExchangeFromQuantity: bigint;
    /**
     * The origin-position composition of `residualQuantity`, derived from the recovered loop
     * principal's deep lineage and scaled by the residual's share. Carried onto the residual lot
     * so it can later settle into its origin.
     */
    residualOriginBasis: Map<Position, bigint>;
    /**
     * Residual-derived portions of the consumed value (open residuals being spent). The caller
     * settles each — closing the residual leg and recognizing its destination proceeds.
     */
    residualNodes: ResidualPath[];
    /** The destination-position proceeds attributable to {@link residualNodes}. */
    residualDerivedProceeds: bigint;
};

export class ExchangeTransactions {
    constructor(
        public readonly from: Transaction,
        public readonly to: Transaction,
        public readonly intermediates: Transaction[]
    ) {}

    public flatten(): Transaction[] {
        return [
            this.from,
            this.to,
            ...this.intermediates
        ];
    }
}

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
 * {@link constructIntermediateTransactions} (the per-position hop transactions for a deep loop).
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
    /** Forward exchange at the actual proceeds rate; null when all consumed value looped or was residual-derived. */
    public readonly exchange: Exchange | null;
    /** Gain (`ResidualUTXI`) or loss (`ResidualUTXO`) on the recovered loop, carrying origin basis. */
    public readonly createdResiduals: (ResidualUTXI | ResidualUTXO)[];
    /** Settlements closing the residual legs of residual-derived value being consumed (surface position). */
    public readonly settledResiduals: ResidualSettlement;

    private readonly recaptureResolution: ExchangeRecaptureResolution;

    private readonly fromPosition: Position;
    private readonly toPosition: Position;

    constructor(
        public readonly fromInputs: Input[],
        private readonly toOutputs: Output[],
        private readonly transactions: Transaction[],
        engine: BookValueEngine,
        residualTarget: ResidualTarget,
        exchangeAccount: ExchangeAccount
    ) {
        this.fromPosition = assertPositionUnifiromity({inputs: fromInputs});
        this.toPosition = assertPositionUnifiromity({outputs: toOutputs});

        this.recaptureResolution = this.computeRecaptureResolution(this.toPosition, engine);

        this.exchange = this.forwardExchange(
            this.fromPosition,
            this.toPosition,
            this.recaptureResolution,
            exchangeAccount
        );

        this.createdResiduals = this.resolveResidual(
            this.toPosition,
            this.recaptureResolution,
            residualTarget
        );

        this.settledResiduals = this.settleResidualNodes(
            this.toPosition,
            this.recaptureResolution
        );
    }

    private computeRecaptureResolution(
        toPosition: Position,
        engine: BookValueEngine
    ): ExchangeRecaptureResolution {

        const surfacePosition = assertPositionUnifiromity(this.fromInputs);
        const fromQuantity = sumNodeQuantityScaled(this.fromInputs);
        const outputQuantity = sumNodeQuantityScaled(this.toOutputs);

        const plan = unwind(engine.compute(this.fromInputs), toPosition);

        // Execute one recapture per distinct exchange on the recovered loop path(s).
        const recaptures = executeRecaptures(plan, this.transactions);

        // Recovered basis = the reclaimed from-sides that land in the target position (the loop
        // ancestor edges). surfaceSettled = the outermost edges' to-sides settled in the surface
        // position — what the consuming transaction must balance against.
        let totalCostBasis = 0n;
        let surfaceSettled = 0n;
        for (const recapture of recaptures) {
            if (recapture.reclaim.source.position === toPosition) totalCostBasis += recapture.reclaim.quantity;
            if (recapture.settlement.source.position === surfacePosition) surfaceSettled += recapture.settlement.quantity;
        }

        // Residual-derived value among the consumed inputs is settled by the caller, not forward-exchanged.
        const residualNodes = plan.residualNodes;
        const residualDerivedTotal = residualNodes.reduce((sum: bigint, n: ResidualPath) => sum + n.quantity, 0n);
        const residualDerivedProceeds = fromQuantity > 0n ? outputQuantity * residualDerivedTotal / fromQuantity : 0n;

        // The forward portion is whatever surface value neither looped nor came from a residual.
        // Deriving it from the actually-settled surface amount keeps the consuming transaction exact.
        const forwardExchangeToQuantity = fromQuantity - surfaceSettled - residualDerivedTotal;
        const forwardExchangeFromQuantity = forwardExchangeToQuantity > 0n && fromQuantity > 0n
            ? outputQuantity * forwardExchangeToQuantity / fromQuantity
            : 0n;

        // Gain (>0) / loss (<0) on the recovered loop: proceeds minus everything else accounted for.
        // Absorbing the rounding remainder here keeps the target transaction balanced exactly.
        const residualQuantity = outputQuantity - totalCostBasis - forwardExchangeFromQuantity - residualDerivedProceeds;

        // Deep origin composition of the loop principal, scaled by the residual's share — the
        // deferred equity the residual carries until it later settles into its origin.
        const residualOriginBasis = new Map<Position, bigint>();
        if (residualQuantity !== 0n && totalCostBasis > 0n) {
            const principalOrigin = new Map<Position, bigint>();
            for (const recapture of recaptures) {
                if (recapture.reclaim.source.position !== toPosition || recapture.reclaim.quantity <= 0n) continue;
                for (const [position, quantity] of collectOriginLeaves(engine.compute([recapture.reclaim])))
                    principalOrigin.set(position, (principalOrigin.get(position) ?? 0n) + quantity);
            }
            const magnitude = residualQuantity < 0n ? -residualQuantity : residualQuantity;
            for (const [position, quantity] of principalOrigin)
                residualOriginBasis.set(position, quantity * magnitude / totalCostBasis);
        }

        return {
            recaptures,
            totalCostBasis,
            residualQuantity,
            forwardExchangeToQuantity,
            forwardExchangeFromQuantity,
            residualOriginBasis,
            residualNodes,
            residualDerivedProceeds,
        };
    }

    public get recaptures(): Recapture[] { return this.recaptureResolution.recaptures; }
    public get residualCloseOutputs(): Output[] { return this.settledResiduals.closedOutputs; }

    // Forward exchange only for the portion that did not loop back to the target. Creates suspended
    // cost basis at the actual market rate, carrying the consumed value's provenance onward.
    // Tagging with `exchangeAccount` scopes this exchange to that account's open-position view.
    // `exchangeAccount` is always supplied by callers (required in the constructor); when the
    // exchange fully closes a loop and forwardExchangeToQuantity is zero, it is simply not used.
    private forwardExchange(
        fromPosition: Position,
        toPosition: Position,
        recaptureResolution: ExchangeRecaptureResolution,
        exchangeAccount: ExchangeAccount
    ): Exchange | null {
        if (recaptureResolution.forwardExchangeToQuantity <= 0n) return null;
        return new Exchange(
            { quantity: recaptureResolution.forwardExchangeToQuantity, position: fromPosition },
            { quantity: recaptureResolution.forwardExchangeFromQuantity, position: toPosition },
            exchangeAccount
        );
    }

    // Gain and loss are recognized symmetrically in the target position as residual lots carrying
    // the recovered loop's deep-origin basis: a gain is a target-side input, a loss a target-side
    // output. Either way the residual lot is recognized immediately and balances the target
    // transaction by construction. Gains and losses route to their respective accounts via `target`.
    private resolveResidual(
        toPosition: Position,
        recaptureResolution: ExchangeRecaptureResolution,
        target: ResidualTarget
    ): (ResidualUTXI | ResidualUTXO)[] {
        if (recaptureResolution.residualQuantity > 0n)
            return [gainAccountOf(target).addResidualInput(recaptureResolution.residualQuantity, toPosition, recaptureResolution.residualOriginBasis)];
        if (recaptureResolution.residualQuantity < 0n)
            return [lossAccountOf(target).addResidualOutput(-recaptureResolution.residualQuantity, toPosition, recaptureResolution.residualOriginBasis)];
        return [];
    }

    // Residual-derived value among the consumed inputs: close each open residual leg and mint a new
    // gain in the destination position, re-denominating deferred equity when the residual closes the
    // loop. The mint lands in the residual's *own* account (read off `node.residual.account`), so a
    // residual's equity is realized in the account that deferred it rather than an arbitrary one.
    private settleResidualNodes(
        toPosition: Position,
        recaptureResolution: ExchangeRecaptureResolution
    ): ResidualSettlement {
        if (recaptureResolution.residualNodes.length === 0) return { closedOutputs: [], mintedInputs: [] };

        const closeOutputs: Output[] = [];
        const mintInputs: Input[] = [];
        const totalResidual = recaptureResolution.residualNodes.reduce((sum, n) => sum + n.quantity, 0n);
        let allocated = 0n;

        for (let i = 0; i < recaptureResolution.residualNodes.length; i++) {
            const node = recaptureResolution.residualNodes[i]!;
            closeOutputs.push(node.residual.consume(node.quantity, this.transactions));

            const share = i === recaptureResolution.residualNodes.length - 1
                ? recaptureResolution.residualDerivedProceeds - allocated
                : recaptureResolution.residualDerivedProceeds * node.quantity / totalResidual;
            allocated += share;
            if (share > 0n)
                mintInputs.push(node.residual.account.addResidualInput(share, toPosition, new Map([[toPosition, share]])));
        }

        return { closedOutputs: closeOutputs, mintedInputs: mintInputs };
    }

    /** Outputs for the consuming/surface transaction: surface-position recapture settlements, the forward from-side, and closed residual legs. */
    public getFromOutputs(): Output[] {
        return [
            ...this.recaptureResolution.recaptures.filter(r => r.settlement.source.position === this.fromPosition).map(r => r.settlement),
            ...(this.exchange ? [this.exchange.from] : []),
            ...this.settledResiduals.closedOutputs,
        ];
    }

    /** Inputs for the receiving/target transaction: target-position recapture reclaims, forward to-side, gain residual, and settled-residual mints. */
    public getToInputs(): Input[] {
        return [
            ...this.recaptureResolution.recaptures.filter(r => r.reclaim.source.position === this.toPosition).map(r => r.reclaim),
            ...(this.exchange ? [this.exchange.to] : []),
            ...this.createdResiduals.filter((r): r is ResidualUTXI => r instanceof ResidualUTXI),
            ...this.settledResiduals.mintedInputs,
        ];
    }

    /** Outputs for the receiving/target transaction: loss residual (when proceeds fall short of recovered basis). */
    public getToOutputs(): Output[] {
        return [...this.toOutputs, ...this.createdResiduals.filter((r): r is ResidualUTXO => r instanceof ResidualUTXO)];
    }

    /** The consuming/surface transaction: `fromInputs` against {@link getFromOutputs}, plus any `additionalNodes`. */
    public constructFromTransaction(
        additionalNodes?: {inputs: Input[], outputs: Output[]}
    ): Transaction {
        if (additionalNodes) return new Transaction(
            [...this.fromInputs, ...additionalNodes.inputs],
            [...this.getFromOutputs(), ...additionalNodes.outputs],
            this.transactions
        );

        return new Transaction(this.fromInputs, this.getFromOutputs(), this.transactions);
    }

    /** The receiving/target transaction: {@link getToInputs} against {@link getToOutputs}, plus any `additionalNodes`. */
    public constructToTransaction(
        additionalNodes?: {inputs: Input[], outputs: Output[]}
    ): Transaction {
        if (additionalNodes) return new Transaction(
            [...this.getToInputs(), ...additionalNodes.inputs],
            [...this.getToOutputs(), ...additionalNodes.outputs],
            this.transactions
        );

        return new Transaction(this.getToInputs(), this.getToOutputs(), this.transactions);
    }

    /**
     * The per-position hop transactions threading a multi-hop loop unwind: each position crossed
     * between the surface and the target gets one balanced transaction whose inputs reclaim the
     * inner edge's from-side and whose outputs settle the next edge's to-side (netting to zero).
     * Commit these (in array order) between the consuming and receiving transactions.
     */
    public getRecaptureHops(): HopTransaction[] {
        return classifyRecaptures(this.recaptureResolution.recaptures, this.fromPosition).hops;
    }

    public constructIntermediateTransactions(): Transaction[] {
        return this.getRecaptureHops().map(hop => new Transaction(hop.inputs, hop.outputs, this.transactions));
    }

    public constructTransactions(additionalNodes?: {inputs: Input[], outputs: Output[]}): ExchangeTransactions {
        return new ExchangeTransactions(
            this.constructFromTransaction(additionalNodes),
            this.constructToTransaction(),
            this.constructIntermediateTransactions()
        );
    }
}