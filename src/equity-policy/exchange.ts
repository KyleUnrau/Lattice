import type { BookValueEngine } from "./book-value/engine.js";
import { assertPositionUnifiromity, type Position } from "../ledger-kernel/positions.js";
import { splitInputs, sumNodeQuantityScaled, Transaction } from "../ledger-kernel/transactions.js";
import { TransactionGroup } from "../ledger-kernel/transactions.js";
import { Exchange, ResidualUTXI } from "../ledger-kernel/transactions/cross-position.js";
import { type Input } from "../ledger-kernel/transactions/inputs.js";
import { type Output } from "../ledger-kernel/transactions/outputs.js";
import { classifyRecaptures, executeRecaptures, unwind, type Recapture } from "./recaptures.js";
import { ExchangeAccount, gainAccountOf, lossAccountOf, type ResidualTarget } from "../ledger-kernel/accounts/computed.js";
import { type HopTransaction } from "./recaptures.js";
import { collectOriginLeaves, type ResidualCarryBack } from "./book-value/lineage.js";
import { ExpenseResolution } from "./expense.js";

interface ResidualSettlement {
    /** Surface-position settlements closing the carried-back residual legs (consuming/from transaction). */
    closedOutputs: Output[];
    /** Target-position gain re-recognitions: the deferred residual re-expressed at origin (`basisAmount`) plus any positive incremental gain. */
    mintedInputs: Input[];
    /** Target-position terminal losses: the *negative* incremental of a carry-back (residual shrinkage), settled to the loss sink at origin. */
    terminalLossOutputs: Output[];
}

// Internal intermediate shape — not part of the public API.
export type ExchangeRecaptureResolution = {
    /** One recapture per distinct exchange on the recovered loop path(s); may span positions. */
    recaptures: Recapture[];
    /** Recovered basis in `targetPosition` (the loop principal). */
    totalCostBasis: bigint;
    /** Gain (>0) residual in `targetPosition`. A loss (<0) is decomposed away before this is built (see {@link ExchangeResolution}). */
    residualQuantity: bigint;
    /** Forward-exchange surface-side quantity (origin/forward portion with no loop). */
    forwardExchangeToQuantity: bigint;
    /** Forward-exchange target-side quantity at the actual proceeds rate. */
    forwardExchangeFromQuantity: bigint;
    /**
     * The origin-position composition of `residualQuantity`, derived from the recovered loop
     * principal's deep lineage and scaled by the residual's share. Carried onto the residual lot
     * so it can later carry back into its origin.
     */
    residualOriginBasis: Map<Position, bigint>;
    /**
     * Residual-derived slivers whose origin matches the target — the **carry-backs**. Each settles:
     * its surface leg is closed and its deferred equity re-recognized in the target (its origin).
     * Non-matching residual-derived value is absent (it flows through the forward exchange instead).
     */
    residualCarryBacks: ResidualCarryBack[];
    /** The target-position proceeds attributable to {@link residualCarryBacks}. */
    residualDerivedProceeds: bigint;
};

export class ExchangeTransactions {
    constructor(
        public readonly from: Transaction,
        public readonly to: Transaction,
        public readonly intermediates: TransactionGroup,
        public readonly terminalLoss: TransactionGroup,
        public readonly resolution: ExchangeResolution
    ) {}

    /**
     * The role-annotated {@link TransactionGroup} for this exchange. Member order matches
     * {@link flatten} exactly, so committing the group reproduces the same history.
     */
    public toGroup(): TransactionGroup {
        const members: (Transaction | TransactionGroup)[] = [this.from, this.to];
        if (this.intermediates.members.length !== 0) members.push(this.intermediates);
        if (this.terminalLoss.members.length !== 0) members.push(this.terminalLoss);
        return new TransactionGroup(members);
    }

    public flatten(): Transaction[] {
        return this.toGroup().flatten();
    }
}

/**
 * The exchange-resolution layer: resolves **the portion of consumed value that is actually being
 * exchanged** into `targetPosition` and produces the kernel lines needed to record it, *without*
 * constructing or committing any transaction. The caller owns transaction assembly and may surround
 * these lines with unrelated deposits, withdrawals, fees, or adjustments (see the composition rules
 * below). This is the building block beneath the high-level {@link swap} helper.
 *
 * The exchanged portion's full provenance is unwound (see {@link computeRecaptureResolution}):
 * where the lineage loops back to `targetPosition`, **every** exchange edge on the path is
 * recaptured at its locked rate; where it does not loop, the portion opens a forward exchange
 * (scoped to `exchangeAccount`) that carries provenance onward. A recovered loop spanning multiple
 * positions settles through a chain of single-position transactions threaded by
 * {@link Exchange.recapture}.
 *
 * **Gains and losses are asymmetric.** A recovered loop whose proceeds *exceed* the recovered cost
 * basis recognizes the surplus as a {@link ResidualUTXI} gain in the target (a directional suspended
 * residual edge that can later carry back). A loop whose proceeds *fall short* is a **loss** —
 * unrecovered origin basis, which is *terminal*. The loss is resolved on the *target* side, not by
 * carving the consumed surface: the loop's **role-pure** target reclaims are split into the
 * proceeds-backing portion (which settles into the target) and the unrecovered shortfall, and the
 * shortfall is full-unwound to its cost-basis origin through an internal {@link ExpenseResolution}
 * into the loss {@link TerminalAccount} — never minted as a movable destination lot. Resolving the
 * loss on the reclaims (rather than the surface) keeps any carry-back/forward surface intact even
 * when a single consumed lot blends loop capital with residual-derived value.
 */
export class ExchangeResolution {
    /** Forward exchange at the actual proceeds rate; null when all consumed value looped or was residual-derived. */
    public readonly exchange: Exchange | null;
    /** Gain residuals (`ResidualUTXI`) recognized in the target on the recovered loop; losses are terminal (see {@link terminalLoss}). */
    public readonly createdResiduals: ResidualUTXI[];
    /** Settlements for residual-derived value carried back to its origin (close legs + re-recognize). */
    public readonly settledResiduals: ResidualSettlement;
    /**
     * For a losing exchange: the terminal settlement of the lost surface portion to its cost-basis
     * origin (an {@link ExpenseResolution} into the loss {@link TerminalAccount}). `null` otherwise.
     */
    public readonly terminalLoss: ExpenseResolution | null;

    private readonly recaptureResolution: ExchangeRecaptureResolution;

    /**
     * For a losing loop: the kept (proceeds-backing) `Pl` portion of the target-position loop
     * reclaims that settles into the proceeds; the lost `B − Pl` portion is diverted to
     * {@link terminalLoss}. `null` on a gain (the full reclaims settle into the proceeds).
     */
    private readonly keptTargetReclaims: Input[] | null;

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

        // One pass over the whole draw. The surface is never carved: the consuming transaction
        // settles all of it (loop settlements + carry-back closes + forward), and a loss is resolved
        // on the *target* side instead (see below). This keeps the carry-back and forward surface
        // slices intact even when a single consumed lot blends loop capital with residual-derived
        // value — a blended lot cannot be sliced into role-pure surface (tracing is proportional).
        this.recaptureResolution = this.computeRecaptureResolution(fromInputs, this.toPosition, engine);

        if (this.recaptureResolution.residualQuantity < 0n) {
            // A loss is unrecovered loop capital basis — terminal at the loop's deepest origin, never
            // a movable destination lot. The loop reclaimed `B` (totalCostBasis) into the target, but
            // the proceeds only back `Pl = B − loss`. So split the **role-pure** target reclaims (the
            // loop principal; carry-back/forward never appear here): settle `Pl` into the proceeds and
            // full-unwind the lost `B − Pl` slice to origin (a terminal loss into the loss account).
            const loss = -this.recaptureResolution.residualQuantity;
            const targetReclaims = this.recaptureResolution.recaptures
                .filter(r => r.reclaim.source.position === this.toPosition)
                .map(r => r.reclaim);
            const [lostReclaims, keptReclaims] = splitInputs(targetReclaims, loss);
            this.keptTargetReclaims = keptReclaims;
            this.terminalLoss = lostReclaims.length > 0
                ? new ExpenseResolution(lostReclaims, transactions, engine, lossAccountOf(residualTarget))
                : null;
        } else {
            this.keptTargetReclaims = null;
            this.terminalLoss = null;
        }

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

        this.settledResiduals = this.settleCarryBacks(
            this.toPosition,
            this.recaptureResolution,
            residualTarget
        );
    }

    private computeRecaptureResolution(
        fromInputs: Input[],
        toPosition: Position,
        engine: BookValueEngine
    ): ExchangeRecaptureResolution {

        const surfacePosition = assertPositionUnifiromity(fromInputs);
        const fromQuantity = sumNodeQuantityScaled(fromInputs);
        const outputQuantity = sumNodeQuantityScaled(this.toOutputs);

        const plan = unwind(engine.compute(fromInputs), toPosition);

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

        // A residual is a directional suspended edge: only the slivers whose origin matches the
        // target carry back (settle to origin). Residual-derived surface whose origin is *not* the
        // target stays an unresolved edge — it flows through the forward exchange like any other
        // un-looped value, carrying its lineage onward, so a residual never leaks "upward" into an
        // unrelated target. (Carry-backs settle in the surface position; only directly-held residuals
        // are surfaced as carry-backs, so their surface == this surface position.)
        const residualCarryBacks = plan.residualCarryBacks;
        const carryBackSurfaceTotal = residualCarryBacks.reduce((sum, c) => sum + c.surfaceQuantity, 0n);
        const residualDerivedProceeds = fromQuantity > 0n ? outputQuantity * carryBackSurfaceTotal / fromQuantity : 0n;

        // The forward portion is whatever surface value neither looped nor carried a residual back.
        // Deriving it from the actually-settled surface amount keeps the consuming transaction exact.
        const forwardExchangeToQuantity = fromQuantity - surfaceSettled - carryBackSurfaceTotal;
        const forwardExchangeFromQuantity = forwardExchangeToQuantity > 0n && fromQuantity > 0n
            ? outputQuantity * forwardExchangeToQuantity / fromQuantity
            : 0n;

        // Gain (>0) on the recovered loop: proceeds minus everything else accounted for. A loss (<0)
        // is decomposed away by the constructor before this method is re-run on the kept portion, so
        // here it is expected to be ≥ 0 (any tiny rounding loss is absorbed by clamping to 0 below).
        const residualQuantity = outputQuantity - totalCostBasis - forwardExchangeFromQuantity - residualDerivedProceeds;

        // Deep origin composition of the loop principal, scaled by the residual's share — the
        // deferred equity the residual carries until it later carries back into its origin.
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
            residualCarryBacks,
            residualDerivedProceeds,
        };
    }

    public get recaptures(): Recapture[] { return this.recaptureResolution.recaptures; }
    public get residualCloseOutputs(): Output[] { return this.settledResiduals.closedOutputs; }

    // Forward exchange only for the portion that did not loop back to the target. Creates suspended
    // cost basis at the actual market rate, carrying the consumed value's provenance onward.
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

    // A surplus on the recovered loop is recognized as a `ResidualUTXI` gain in the target position,
    // carrying the recovered loop's deep-origin residual-basis. Losses are not handled here — they
    // are terminal and decomposed into an expense before this runs, so `residualQuantity` is ≥ 0.
    private resolveResidual(
        toPosition: Position,
        recaptureResolution: ExchangeRecaptureResolution,
        target: ResidualTarget
    ): ResidualUTXI[] {
        if (recaptureResolution.residualQuantity > 0n)
            return [gainAccountOf(target).addResidualInput(recaptureResolution.residualQuantity, toPosition, recaptureResolution.residualOriginBasis)];
        return [];
    }

    // Residual-derived value carried back to its origin (target == the residual's origin): close the
    // matching residual leg in the surface position and realize it at the origin. `basisAmount` is
    // residual-basis — the origin-position re-denomination of the deferred residual — *not* recovered
    // principal. So the realization SPLITS into two lines that together equal the actual proceeds
    // (the origin receives proceeds once; the split only classifies that value):
    //   • re-recognize the deferred residual at origin using `basisAmount` (a gain, in the residual's
    //     own account so its equity is realized where it was deferred);
    //   • the incremental `proceeds − basisAmount` is an additional gain if positive, or — if the
    //     residual shrank — a *terminal loss* settled to the loss sink at the origin (never a movable lot).
    // Residual slivers whose origin is *not* the target are absent here — they flow forward instead.
    private settleCarryBacks(
        toPosition: Position,
        recaptureResolution: ExchangeRecaptureResolution,
        target: ResidualTarget
    ): ResidualSettlement {
        const carryBacks = recaptureResolution.residualCarryBacks;
        if (carryBacks.length === 0) return { closedOutputs: [], mintedInputs: [], terminalLossOutputs: [] };

        const closeOutputs: Output[] = [];
        const mintInputs: Input[] = [];
        const terminalLossOutputs: Output[] = [];
        const totalSurface = carryBacks.reduce((sum, c) => sum + c.surfaceQuantity, 0n);
        let allocated = 0n;

        for (let i = 0; i < carryBacks.length; i++) {
            const carryBack = carryBacks[i]!;
            closeOutputs.push(carryBack.residual.consume(carryBack.surfaceQuantity, this.transactions));

            // The actual target proceeds attributable to this sliver (the last absorbs rounding).
            const proceeds = i === carryBacks.length - 1
                ? recaptureResolution.residualDerivedProceeds - allocated
                : recaptureResolution.residualDerivedProceeds * carryBack.surfaceQuantity / totalSurface;
            allocated += proceeds;

            // Re-recognize the deferred residual at origin (residual-basis denomination).
            const basisAmount = carryBack.basisAmount;
            if (basisAmount > 0n)
                mintInputs.push(carryBack.residual.account.addResidualInput(basisAmount, toPosition, new Map([[toPosition, basisAmount]])));

            // Incremental adjustment vs. the residual-basis: extra gain, or terminal-loss shrinkage.
            const incremental = proceeds - basisAmount;
            if (incremental > 0n)
                mintInputs.push(carryBack.residual.account.addResidualInput(incremental, toPosition, new Map([[toPosition, incremental]])));
            else if (incremental < 0n)
                terminalLossOutputs.push(lossAccountOf(target).recognize(-incremental, toPosition));
        }

        return { closedOutputs: closeOutputs, mintedInputs: mintInputs, terminalLossOutputs };
    }

    /** Outputs for the consuming/surface transaction: surface-position recapture settlements, the forward from-side, and closed carry-back legs. */
    public getFromOutputs(): Output[] {
        return [
            ...this.recaptureResolution.recaptures.filter(r => r.settlement.source.position === this.fromPosition).map(r => r.settlement),
            ...(this.exchange ? [this.exchange.from] : []),
            ...this.settledResiduals.closedOutputs,
        ];
    }

    /** Inputs for the receiving/target transaction: target-position recapture reclaims, forward to-side, the gain residual, and carry-back re-recognitions. */
    public getToInputs(): Input[] {
        // On a loss only the proceeds-backing `Pl` slice of the loop reclaims settles here; the lost
        // slice was diverted to {@link terminalLoss}. On a gain the full reclaims settle.
        const targetReclaims = this.keptTargetReclaims
            ?? this.recaptureResolution.recaptures.filter(r => r.reclaim.source.position === this.toPosition).map(r => r.reclaim);
        return [
            ...targetReclaims,
            ...(this.exchange ? [this.exchange.to] : []),
            ...this.createdResiduals,
            ...this.settledResiduals.mintedInputs,
        ];
    }

    /** Outputs for the receiving/target transaction: the proceeds, plus any terminal-loss shrinkage from carry-backs (recognized at origin == target). */
    public getToOutputs(): Output[] {
        return [...this.toOutputs, ...this.settledResiduals.terminalLossOutputs];
    }

    /** The consuming/surface transaction: the whole `fromInputs` against {@link getFromOutputs}, plus any `additionalNodes`. */
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

    public constructIntermediateTransactions(): TransactionGroup {
        return new TransactionGroup(this.getRecaptureHops().map(hop => new Transaction(hop.inputs, hop.outputs, this.transactions)));
    }

    /** The terminal-loss settlement transactions (lost surface expensed to origin), or an empty group when the exchange did not lose. */
    public constructTerminalLossTransactions(): TransactionGroup {
        return this.terminalLoss ? this.terminalLoss.constructTransactions().toGroup() : new TransactionGroup([]);
    }

    public constructTransactions(additionalNodes?: {inputs: Input[], outputs: Output[]}): ExchangeTransactions {
        return new ExchangeTransactions(
            this.constructFromTransaction(additionalNodes),
            this.constructToTransaction(),
            this.constructIntermediateTransactions(),
            this.constructTerminalLossTransactions(),
            this
        );
    }
}
