import type { TerminalAccount, ResidualAccount } from "../ledger-kernel/accounts/computed.js";
import { type Position, assertPositionUnifiromity } from "../ledger-kernel/positions.js";
import { Transaction, TransactionGroup, sumNodeQuantityScaled } from "../ledger-kernel/transactions.js";
import type { ResidualUTXI } from "../ledger-kernel/transactions/residual.js";
import type { Input } from "../ledger-kernel/transactions/inputs.js";
import type { Output } from "../ledger-kernel/transactions/outputs.js";
import type { BookValueEngine } from "./book-value/engine.js";
import { type Recapture, type HopTransaction, unwind, classifyRecaptures, executeRecaptures, type RecaptureClassification, type UnwindPlan } from "./recaptures.js";


/** A residual settled by being terminated: its inherited origin-position basis is re-recognized as a capital gain. */
export type TerminalResidualRecognition = {
    position: Position;
    quantity: bigint;
    /** The capital-gain lot recognized for this settled residual; pairs against a terminal output. */
    gainLot: ResidualUTXI;
};

/** A terminal **origin** position recovered by the full unwind: its recaptured basis is terminated there. */
export type TerminalRecapturedGroup = {
    position: Position;
    recaptures: Recapture[];
    totalQuantity: bigint;
};

export class TerminalTransactions {
    constructor(
        public readonly from: Transaction,
        public readonly intermediates: TransactionGroup,
        public readonly externalTerminals: TransactionGroup,
        public readonly resolution: TerminalResolution
    ) { }

    /**
     * The role-annotated {@link TransactionGroup} for this terminal event. Member order matches
     * {@link flatten} exactly, so committing the group reproduces the same history.
     */
    public toGroup(): TransactionGroup {
        const members: (Transaction | TransactionGroup)[] = [this.from];
        if (this.intermediates.members.length !== 0) members.push(this.intermediates);
        if (this.externalTerminals.members.length !== 0) members.push(this.externalTerminals);
        return new TransactionGroup(members);
    }

    public flatten(): Transaction[] {
        return this.toGroup().flatten();
    }
}
/**
 * Records a terminal settlement across the **full provenance** of the consumed inputs, *without*
 * committing any transaction — the caller owns assembly. Mirrors {@link ExchangeResolution}: pass the
 * consumed `inputs`, the engine, the transaction history, and the `account` the value is recognized in;
 * the constructor unwinds the lineage and precomputes every kernel line, which the caller assembles
 * via {@link getFromOutputs} / {@link constructFromTransaction} (the consuming transaction),
 * {@link constructIntermediateTransactions} (the per-position hops of a multi-hop unwind), and
 * {@link constructTerminalTransactions} (the per-origin recognition transactions).
 *
 * Because a terminal settlement consumes the value entirely, the whole exchange lineage is unwound to
 * its origins ({@link unwind} in full mode): every edge is recaptured at its locked rate, intermediate
 * positions net to zero through hop transactions, and the recovered value is recognized in the
 * **terminal origin** position(s) it ultimately came from ({@link recaptureGroups}). Surface-position
 * value with no lineage is recognized directly in the consuming transaction ({@link originAmounts}).
 * *Suspended* residual-derived value (a residual whose surface position differs from its origin) has
 * its leg closed ({@link residualCloseOutputs}) and its deferred origin-basis equity re-recognized —
 * within the same {@link ResidualAccount} that originally minted the residual (read off
 * `node.residual.account`), not the terminal account — then recognized there
 * ({@link residualRecognitions}). A residual already recognized *at its own origin* (surface position
 * == origin position, e.g. an A→B→A loop gain at A) is **not** a suspended edge: its value flows as
 * ordinary basis, terminalized by the enclosing exchange recapture or the surface remainder, and its
 * gain is left untouched — never closed, re-anchored, or re-recognized by the terminal settlement.
 *
 * Commit order: the consuming transaction first, then the hops (so the origin amounts they thread
 * are available), then the terminal recognitions.
 */

export class TerminalResolution {
    /** One group per terminal-origin position recovered by the unwind; each drives one recognition transaction. */
    public readonly recaptureGroups: TerminalRecapturedGroup[];
    /** Surface-position portions with no exchange lineage; recognized directly in the consuming transaction. */
    public readonly originAmounts: { position: Position; quantity: bigint; }[];
    /** Per-origin-position capital-gain recognitions for settled residual-derived value; each pairs with a terminal output. */
    public readonly residualRecognitions: TerminalResidualRecognition[];
    /** Surface-position settlements closing the residual legs of terminated residual-derived value. */
    public readonly residualCloseOutputs: Output[];

    /** Surface-position recapture settlements (outermost edges' to-sides) — belong in the consuming transaction. */
    private readonly surfaceSettlements: Output[];
    /** Intermediate positions crossed by a multi-hop unwind; each transaction nets to zero. */
    private readonly hops: HopTransaction[];
    /** Direct terminal debits for the no-lineage {@link originAmounts}, in the surface position. */
    private readonly directTerminalOutputs: Output[];
    /** Recognition entries: each reclaimed origin amount / settled-residual gain paired with its terminal debit. */
    private readonly terminalEntries: { inputs: Input[]; outputs: Output[]; }[];

    private readonly fromPosition: Position;

    constructor(
        public readonly inputs: Input[],
        private readonly transactions: Transaction[],
        engine: BookValueEngine,
        private readonly account: TerminalAccount
    ) {
        this.fromPosition = assertPositionUnifiromity({ inputs });
        const totalConsumed = sumNodeQuantityScaled(inputs);

        // Full unwind to origin: recapture every edge, then classify each by the role its position
        // plays — surface settlement, intermediate hop, or terminal origin reclaim.
        const plan = unwind(engine.compute(inputs), null);
        const classification = classifyRecaptures(executeRecaptures(plan, transactions), this.fromPosition);

        this.surfaceSettlements = classification.surfaceSettlements;
        this.hops = classification.hops;
        this.recaptureGroups = this.groupTerminalReclaims(classification);

        const { closeOutputs, recognitions } = this.settleResiduals(plan);
        this.residualCloseOutputs = closeOutputs;
        this.residualRecognitions = recognitions;

        this.originAmounts = this.computeOriginAmounts(totalConsumed, classification.surfaceSettled, closeOutputs);

        this.directTerminalOutputs = this.generateDirectTerminalOutputs();
        this.terminalEntries = this.buildTerminalEntries();
    }

    // Each terminal reclaim is an origin position whose recovered basis is recognized; sum the
    // group's reclaimed quantities to size that position's recognition.
    private groupTerminalReclaims(classification: RecaptureClassification): TerminalRecapturedGroup[] {
        return [...classification.terminalReclaims].map(([position, recaptures]) => ({
            position,
            recaptures,
            totalQuantity: recaptures.reduce((sum, r) => sum + r.reclaim.quantity, 0n),
        }));
    }

    // Residual-derived value: close each *suspended* residual leg, then re-recognize its deferred
    // origin-basis equity in the origin position. The recognition is a position-shift within the
    // residual's *own* account (keyed off the lot, which carries its account), so value tracing
    // through residuals from different accounts never collapses into one.
    //
    // A residual is a suspended edge only while its surface position differs from its origin. The
    // share of a residual's origin basis sitting *at its own surface position* is already recognized
    // at origin — ordinary value, not a deferred edge — so it is excluded here: its surface value
    // flows as ordinary basis (already terminalized by the enclosing exchange's full recapture when
    // the residual is nested behind a forward edge, or by the surface remainder when directly held),
    // and its already-recognized gain is left untouched. A residual whose origin is *entirely* its
    // own surface position (e.g. an A→B→A loop gain recognized at A) is therefore never closed or
    // re-recognized by a later terminal settlement — only the genuinely-suspended (away-from-surface)
    // share settles to its true origin.
    private settleResiduals(plan: UnwindPlan): { closeOutputs: Output[]; recognitions: TerminalResidualRecognition[]; } {
        const closeOutputs: Output[] = [];
        const originTotals = new Map<ResidualAccount, Map<Position, bigint>>();
        for (const node of plan.residualNodes) {
            const surface = node.residual.position;
            const originTotal = [...node.originBasis.values()].reduce((sum, q) => sum + q, 0n);
            const suspendedTotal = originTotal - (node.originBasis.get(surface) ?? 0n);
            if (suspendedTotal <= 0n) continue; // recognized-at-origin: not a suspended edge, leave it.

            // Close only the suspended share of the surface leg; the at-origin share stays put and
            // flows as ordinary basis, so it is neither double-closed nor double-counted.
            const closeQuantity = node.quantity * suspendedTotal / originTotal;
            closeOutputs.push(node.residual.consume(closeQuantity, this.transactions));
            let byPosition = originTotals.get(node.residual.account);
            if (!byPosition) originTotals.set(node.residual.account, byPosition = new Map<Position, bigint>());
            for (const [position, quantity] of node.originBasis) {
                if (position === surface) continue; // recognized-at-origin share — excluded from settlement.
                byPosition.set(position, (byPosition.get(position) ?? 0n) + quantity);
            }
        }

        const recognitions: TerminalResidualRecognition[] = [];
        for (const [account, byPosition] of originTotals)
            for (const [position, quantity] of byPosition) {
                const gainLot = account.addResidualInput(quantity, position, new Map<Position, bigint>([[position, quantity]]));
                recognitions.push({ position, quantity, gainLot });
            }

        return { closeOutputs, recognitions };
    }

    // No-lineage surface value is recognized directly. Derive it as the remainder of the consumed
    // amount after surface settlements and closed residual legs, so the consuming transaction
    // balances exactly.
    private computeOriginAmounts(
        totalConsumed: bigint,
        surfaceSettled: bigint,
        residualCloseOutputs: Output[]
    ): { position: Position; quantity: bigint; }[] {
        const residualSurface = residualCloseOutputs.reduce((sum, o) => sum + o.quantity, 0n);
        const directSurface = totalConsumed - surfaceSettled - residualSurface;
        return directSurface > 0n ? [{ position: this.fromPosition, quantity: directSurface }] : [];
    }

    // Surface-position terminal debits for the no-lineage origin amounts (the consuming transaction's
    // own terminal recognition).
    private generateDirectTerminalOutputs(): Output[] {
        return this.originAmounts.map(o => this.account.recognize(o.quantity, o.position));
    }

    // One recognition entry per terminal-origin reclaim (reclaimed origin amount → terminal output)
    // and one per settled-residual recognition (recognized capital-gain lot → terminal output).
    private buildTerminalEntries(): { inputs: Input[]; outputs: Output[]; }[] {
        return [
            ...this.recaptureGroups.map(group => ({
                inputs: group.recaptures.map(r => r.reclaim),
                outputs: [this.account.recognize(group.totalQuantity, group.position)],
            })),
            ...this.residualRecognitions.map(r => ({
                inputs: [r.gainLot] as Input[],
                outputs: [this.account.recognize(r.quantity, r.position)],
            })),
        ];
    }

    /**
     * Outputs for the consuming transaction (surface position): the surface-position recapture
     * settlements, the direct terminal debits for any no-lineage origin amounts, and the closed legs
     * of any settled residuals — together balancing exactly against the consumed `inputs`.
     */
    public getFromOutputs(): Output[] {
        return [...this.surfaceSettlements, ...this.directTerminalOutputs, ...this.residualCloseOutputs];
    }

    /** The consuming transaction: the consumed `inputs` against {@link getFromOutputs}, plus any `additionalNodes`. */
    public constructFromTransaction(additionalNodes?: { inputs: Input[]; outputs: Output[]; }): Transaction {
        return new Transaction(
            [...this.inputs, ...(additionalNodes?.inputs ?? [])],
            [...this.getFromOutputs(), ...(additionalNodes?.outputs ?? [])],
            this.transactions
        );
    }

    /**
     * The per-position hop transactions threading a multi-hop unwind: each intermediate position
     * gets one balanced transaction reclaiming the inner edge's from-side and settling the next
     * edge's to-side (netting to zero). Commit these after the consuming transaction.
     */
    public constructIntermediateTransactions(): TransactionGroup {
        return new TransactionGroup(this.hops.map(hop => new Transaction(hop.inputs, hop.outputs, this.transactions)));
    }

    /**
     * The terminal-recognition transactions: one per terminal-origin recapture group (reclaimed
     * origin amount → terminal output in that position) and one per settled-residual recognition
     * (recognized capital-gain lot → terminal output). Commit these last.
     */
    public constructTerminalTransactions(): TransactionGroup {
        return new TransactionGroup(this.terminalEntries.map(entry => new Transaction(entry.inputs, entry.outputs, this.transactions)));
    }

    public constructTransactions(additionalNodes?: { inputs: Input[]; outputs: Output[]; }): TerminalTransactions {
        return new TerminalTransactions(
            this.constructFromTransaction(additionalNodes),
            this.constructIntermediateTransactions(),
            this.constructTerminalTransactions(),
            this
        );
    }
}
