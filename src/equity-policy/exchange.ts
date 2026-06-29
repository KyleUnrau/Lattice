import type { BookValueEngine } from "./book-value/engine.js";
import { assertPositionUnifiromity, type Position } from "../ledger-kernel/positions.js";
import { splitInputs, sumNodeQuantityScaled } from "../ledger-kernel/transactions/utils.js";
import { Transaction } from "../ledger-kernel/transactions/transaction.js";
import { TransactionGroup } from "../ledger-kernel/transactions/group.js";
import { ResidualUTXI } from "../ledger-kernel/transactions/special-edges/residual.js";
import { Exchange, type ExchangeTarget } from "../ledger-kernel/transactions/special-edges/exchange.js";
import { type Input } from "../ledger-kernel/transactions/inputs.js";
import { type Output } from "../ledger-kernel/transactions/outputs.js";
import { classifyRecaptures, executeRecaptures, unwind, type Recapture } from "./recaptures.js";
import { gainAccountOf, lossAccountOf, type ResidualTarget } from "../ledger-kernel/accounts/computed.js";
import { type HopTransaction } from "./recaptures.js";
import { collectOriginLeaves, forwardSurfaceQuantity, type ResidualCarryBack } from "./book-value/lineage.js";
import { TerminalResolution } from "./terminal.js";

interface ResidualSettlement {
    /** Surface-position settlements closing the legs of *directly-held* carried-back residuals (consuming/from transaction). */
    closedOutputs: Output[];
    /** Target-position gain re-recognitions: the deferred residual re-expressed at origin (`basisAmount`) plus any positive incremental gain. */
    mintedInputs: Input[];
    /** Target-position terminal losses: the *negative* incremental of a carry-back (residual shrinkage), settled to the loss sink at origin. */
    terminalLossOutputs: Output[];
    /** Nested carry-backs only: recaptures of the enclosing forward edges that rewind the residual's value back to its own surface. */
    enclosingRecaptures: Recapture[];
    /** Nested carry-backs only: each residual's leg close, injected as a settlement at the residual's surface position (which becomes a hop). */
    hopCloseSettlements: { position: Position; outputs: Output[] }[];
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
    /**
     * A surface-position settlement that mops up the rounding remainder left un-settled by the
     * loop/carry-back to-side truncation — the part of the draw in excess of the genuine-forward
     * surface ({@link forwardSurfaceQuantity}). It settles a sliver of an already-recaptured surface
     * to-side at no extra basis, so the loop closes exactly and the sliver's proceeds fall into the
     * recognized gain instead of stranding behind a forward edge nothing will close. Present whenever
     * `remainder > genuineForwardSurface` (including the all-loops case where the genuine forward is
     * zero); `null` when the remainder is entirely genuine forward (handled by
     * {@link forwardExchangeToQuantity}).
     */
    surfaceRemainderSettlement: Output | null;
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

export type { ExchangeTarget };

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
 * shortfall is full-unwound to its cost-basis origin through an internal {@link TerminalResolution}
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
     * origin (an {@link TerminalResolution} into the loss {@link TerminalAccount}). `null` otherwise.
     */
    public readonly terminalLoss: TerminalResolution | null;

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
        exchangeAccount: ExchangeTarget
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
            //
            // The lost slice is prorated across the reclaims by each one's recovered-basis share, not
            // taken from the front of the list. When a loop recovers basis from several distinct
            // origins (one reclaim each), this terminalizes the loss at every origin proportionally
            // rather than dumping it all on whichever reclaim happens to be first.
            const loss = -this.recaptureResolution.residualQuantity;
            const targetReclaims = this.recaptureResolution.recaptures
                .filter(r => r.reclaim.source.position === this.toPosition)
                .map(r => r.reclaim);
            const [lostReclaims, keptReclaims] = this.prorateReclaimLoss(targetReclaims, loss);
            this.keptTargetReclaims = keptReclaims;
            this.terminalLoss = lostReclaims.length > 0
                ? new TerminalResolution(lostReclaims, transactions, engine, lossAccountOf(residualTarget))
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

        const basis = engine.compute(fromInputs);
        const plan = unwind(basis, toPosition);

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
        // A carry-back's footprint in the *consuming surface* position is the outermost enclosing
        // edge's to-side (for a nested carry-back) or its own surface quantity (directly held).
        const residualCarryBacks = plan.residualCarryBacks;
        const carryBackSurfaceTotal = residualCarryBacks.reduce((sum, c) => sum + (c.enclosingEdges[0]?.toQuantity ?? c.surfaceQuantity), 0n);
        const residualDerivedProceeds = fromQuantity > 0n ? outputQuantity * carryBackSurfaceTotal / fromQuantity : 0n;

        // The forward portion is whatever surface value neither looped nor carried a residual back.
        // The settled amounts (surfaceSettled, carryBackSurfaceTotal) are each rounded *down* as their
        // to-sides are threaded, so the leftover blends genuine-forward value with that truncation.
        // `forwardSurfaceQuantity` measures the genuine-forward surface straight from the basis tree.
        // When it is zero, the whole draw provably loops/carries back, so the leftover is pure rounding:
        // settle that sliver against an already-recaptured surface to-side (closing the loop exactly, at
        // no extra basis) and let its proceeds fall into the recognized gain — never open a forward edge
        // that nothing will close. When genuine forward exists, the leftover is a real forward as before.
        const remainder = fromQuantity - surfaceSettled - carryBackSurfaceTotal;
        const genuineForwardSurface = forwardSurfaceQuantity(basis, toPosition);

        // `remainder` blends two things: the genuine-forward surface (which legitimately opens a
        // forward edge carrying provenance onward) and the rounding truncation left behind as the
        // loop/carry-back to-sides are threaded (each rounded *down*). Split them: only the genuine
        // forward portion — capped at the remainder — opens a forward edge; the leftover is pure
        // rounding. `forwardSurfaceQuantity` reads straight from the basis tree, so it is the
        // truncation-free measure of the forward portion; `remainder >= genuineForwardSurface` always
        // holds (the settled surfaces are rounded down), so the `min` only guards arithmetic surprises.
        const forwardExchangeToQuantity = genuineForwardSurface < remainder ? genuineForwardSurface : remainder;
        const roundingRemainder = remainder - forwardExchangeToQuantity;
        if (remainder < 0n || forwardExchangeToQuantity < 0n || roundingRemainder < 0n)
            throw new Error(`exchange remainder split is negative (remainder=${remainder}, forward=${forwardExchangeToQuantity}, rounding=${roundingRemainder}): settled surface exceeds the draw`);

        // The rounding sliver provably loops/carries back (it is the part of the draw with no genuine
        // forward provenance), so settle it against an already-recaptured surface to-side at no extra
        // basis — closing the loop exactly and letting its proceeds fall into the recognized gain,
        // instead of stranding it behind a forward edge nothing will ever close. Pick a surface to-side
        // that can still absorb it *on top of* its own recapture settlement (the to-sides were rounded
        // down, so at least one carries the leftover); availability here excludes the not-yet-committed
        // recapture settlement, hence the `settlement.quantity + roundingRemainder` headroom check.
        let surfaceRemainderSettlement: Output | null = null;
        if (roundingRemainder > 0n) {
            const surfaceRecapture = recaptures.find(r =>
                r.settlement.source.position === surfacePosition
                && r.settlement.source.calculateAvailable(this.transactions) >= r.settlement.quantity + roundingRemainder);
            if (!surfaceRecapture)
                throw new Error(`no surface to-side can absorb the ${roundingRemainder}-unit rounding remainder at ${surfacePosition.name}`);
            surfaceRemainderSettlement = surfaceRecapture.settlement.source.consume(roundingRemainder, this.transactions);
        }
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
            surfaceRemainderSettlement,
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
        exchangeAccount: ExchangeTarget
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
        if (recaptureResolution.residualQuantity > 0n) {
            if (process.env.LATTICE_DEBUG) this.traceMintBlend(toPosition, recaptureResolution);
            return [gainAccountOf(target).addResidualInput(recaptureResolution.residualQuantity, toPosition, recaptureResolution.residualOriginBasis)];
        }
        return [];
    }

    /**
     * DEBUG: shows why a gain residual minted in `toPosition` will shadow a still-open upstream edge.
     * A gain whose deep origin differs from its surface (`originBasis` has a position ≠ toPosition) is
     * deposited into the surface position alongside live upstream-edge value; the basis engine blends
     * the two, so later draws split between the (terminal) residual node and the live edge.
     */
    private traceMintBlend(toPosition: Position, rr: ExchangeRecaptureResolution): void {
        const lp = (p: Position): string => p.name.replace("Position ", "").slice(0, 1);
        const origin = [...rr.residualOriginBasis].map(([p, q]) => `${lp(p)}:${q}`).join(",");
        const deepOrigin = [...rr.residualOriginBasis.keys()].some(p => p !== toPosition);
        // Upstream edges whose to-side is this surface position and still has open availability —
        // the still-live edges this residual will blend with in cash.
        const upstream: string[] = [];
        const seen = new Set<Exchange>();
        for (const tx of this.transactions)
            for (const node of [...tx.inputs, ...tx.outputs]) {
                const ex = (node as { exchange?: Exchange }).exchange;
                if (!ex || seen.has(ex)) continue;
                seen.add(ex);
                if (ex.to.position === toPosition) {
                    const avail = ex.to.calculateAvailable(this.transactions);
                    if (avail > 0n) upstream.push(`${lp(ex.from.position)}->${lp(ex.to.position)} openTo=${avail}`);
                }
            }
        console.error(`[MINT gain ${rr.residualQuantity} in ${lp(toPosition)} origin={${origin}} deepOrigin=${deepOrigin}] principal=${rr.totalCostBasis} | open upstream edges into ${lp(toPosition)}: ${upstream.join(" | ") || "none"}`);
    }

    // Residual-derived value carried back to its origin (target == the residual's origin): close the
    // matching residual leg and realize it at the origin. `basisAmount` is residual-basis — the
    // origin-position re-denomination of the deferred residual — *not* recovered principal. So the
    // realization SPLITS into two lines that together equal the actual proceeds (the origin receives
    // proceeds once; the split only classifies that value):
    //   • re-recognize the deferred residual at origin using `basisAmount` (a gain, in the residual's
    //     own account so its equity is realized where it was deferred);
    //   • the incremental `proceeds − basisAmount` is an additional gain if positive, or — if the
    //     residual shrank — a *terminal loss* settled to the loss sink at the origin (never a movable lot).
    //
    // A *directly-held* residual closes its leg in the consuming (surface) transaction. A *nested*
    // residual (reached through forward edges) first rewinds the value to its own surface by
    // recapturing each enclosing edge for its portion; the leg then closes at that surface, which the
    // hop machinery threads as an intermediate position. Residual slivers whose origin is *not* the
    // target are absent here — they flow forward instead.
    private settleCarryBacks(
        toPosition: Position,
        recaptureResolution: ExchangeRecaptureResolution,
        target: ResidualTarget
    ): ResidualSettlement {
        const carryBacks = recaptureResolution.residualCarryBacks;
        const empty: ResidualSettlement = { closedOutputs: [], mintedInputs: [], terminalLossOutputs: [], enclosingRecaptures: [], hopCloseSettlements: [] };
        if (carryBacks.length === 0) return empty;

        const closeOutputs: Output[] = [];
        const mintInputs: Input[] = [];
        const terminalLossOutputs: Output[] = [];
        const enclosingRecaptures: Recapture[] = [];
        const hopCloseSettlements: { position: Position; outputs: Output[] }[] = [];

        // Proceeds are prorated by each carry-back's footprint in the consuming surface (the same
        // quantity that fed `residualDerivedProceeds`), so the split matches the proceeds exactly.
        const footprint = (c: ResidualCarryBack): bigint => c.enclosingEdges[0]?.toQuantity ?? c.surfaceQuantity;
        const totalFootprint = carryBacks.reduce((sum, c) => sum + footprint(c), 0n);
        let allocated = 0n;

        for (let i = 0; i < carryBacks.length; i++) {
            const carryBack = carryBacks[i]!;
            const close = carryBack.residual.consume(carryBack.surfaceQuantity, this.transactions);

            if (carryBack.enclosingEdges.length === 0) {
                closeOutputs.push(close);
            } else {
                for (const edge of carryBack.enclosingEdges)
                    // Reclaim the exact from-side the carry-back scaling tracked (the residual's
                    // surface share rewound through this edge), not a rate re-derivation from the
                    // rounded to-side — otherwise the residual's surface hop loses a remainder.
                    enclosingRecaptures.push(edge.exchange.recapture(edge.toQuantity, this.transactions, edge.fromQuantity));
                hopCloseSettlements.push({ position: carryBack.surfacePosition, outputs: [close] });
            }

            // The actual target proceeds attributable to this sliver (the last absorbs rounding).
            const proceeds = i === carryBacks.length - 1
                ? recaptureResolution.residualDerivedProceeds - allocated
                : recaptureResolution.residualDerivedProceeds * footprint(carryBack) / totalFootprint;
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

        return { closedOutputs: closeOutputs, mintedInputs: mintInputs, terminalLossOutputs, enclosingRecaptures, hopCloseSettlements };
    }

    // Splits the role-pure target `reclaims` (the recovered loop principal) into a lost portion
    // summing to `loss` and a kept portion, prorating the loss across each reclaim by its
    // recovered-basis share. The last reclaim absorbs any rounding remainder so the lost portion
    // totals exactly `loss`. This spreads a multi-origin loop loss across every origin proportionally
    // rather than draining the first reclaim before touching the next.
    private prorateReclaimLoss(reclaims: Input[], loss: bigint): [Input[], Input[]] {
        const totalBasis = reclaims.reduce((sum, r) => sum + r.quantity, 0n);
        const lost: Input[] = [];
        const kept: Input[] = [];
        let allocated = 0n;
        for (let i = 0; i < reclaims.length; i++) {
            const reclaim = reclaims[i]!;
            const lostHere = i === reclaims.length - 1
                ? loss - allocated
                : (totalBasis > 0n ? reclaim.quantity * loss / totalBasis : 0n);
            allocated += lostHere;
            const [lostPart, keptPart] = splitInputs([reclaim], lostHere);
            lost.push(...lostPart);
            kept.push(...keptPart);
        }
        return [lost, kept];
    }

    /** Outputs for the consuming/surface transaction: surface-position recapture settlements (loop and nested-carry-back enclosing edges), the forward from-side, and directly-held closed carry-back legs. */
    public getFromOutputs(): Output[] {
        return [
            ...this.recaptureResolution.recaptures.filter(r => r.settlement.source.position === this.fromPosition).map(r => r.settlement),
            ...this.settledResiduals.enclosingRecaptures.filter(r => r.settlement.source.position === this.fromPosition).map(r => r.settlement),
            ...(this.recaptureResolution.surfaceRemainderSettlement ? [this.recaptureResolution.surfaceRemainderSettlement] : []),
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
        // Thread the loop recaptures together with any nested carry-back enclosing recaptures, and
        // inject each nested residual's leg close so its surface position is balanced as a hop.
        const combined = [...this.recaptureResolution.recaptures, ...this.settledResiduals.enclosingRecaptures];
        return classifyRecaptures(combined, this.fromPosition, this.settledResiduals.hopCloseSettlements).hops;
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
