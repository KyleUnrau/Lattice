import type { BookValueEngine } from "./book-value/engine.js";
import { assertPositionUnifiromity, type Position } from "../ledger-kernel/positions.js";
import { sumNodeQuantityScaled, Transaction } from "../ledger-kernel/transactions.js";
import { ResidualUTXI } from "../ledger-kernel/transactions/cross-position.js";
import { ResidualAccount } from "../ledger-kernel/accounts/computed.js";
import type { Input } from "../ledger-kernel/transactions/inputs.js";
import type { Output } from "../ledger-kernel/transactions/outputs.js";
import { unwind, executeRecaptures, classifyRecaptures } from "./recaptures.js";
import type { HopTransaction, Recapture, RecaptureClassification, UnwindPlan } from "./recaptures.js";
import type { Account } from "../ledger-kernel/accounts/account.js";

/** A residual settled by being expensed: its inherited origin-position basis is re-recognized as a capital gain. */
export type ExpenseResidualRecognition = {
    position: Position;
    quantity: bigint;
    /** The capital-gain lot recognized for this settled residual; pairs against an expense output. */
    gainLot: ResidualUTXI;
};

/** A terminal **origin** position recovered by the full unwind: its recaptured basis is expensed there. */
export type ExpenseRecapturedGroup = {
    position: Position;
    recaptures: Recapture[];
    totalQuantity: bigint;
};

export class ExpenseTransactions {
    constructor(
        public readonly from: Transaction,
        public readonly intermediates: Transaction[],
        public readonly externalExpenses: Transaction[]
    ) {}

    public flatten(): Transaction[] {
        return [
            this.from,
            ...this.intermediates,
            ...this.externalExpenses
        ];
    }
}

/**
 * Records an expense across the **full provenance** of the consumed inputs, *without* committing any
 * transaction — the caller owns assembly. Mirrors {@link ExchangeResolution}: pass the consumed
 * `inputs`, the engine, the transaction history, and the `account` the expense is recognized in;
 * the constructor unwinds the lineage and precomputes every kernel line, which the caller assembles
 * via {@link getFromOutputs} / {@link constructFromTransaction} (the consuming transaction),
 * {@link constructIntermediateTransactions} (the per-position hops of a multi-hop unwind), and
 * {@link constructExpenseTransactions} (the per-origin recognition transactions).
 *
 * Because an expense consumes the value entirely, the whole exchange lineage is unwound to its
 * origins ({@link unwind} in full mode): every edge is recaptured at its locked rate, intermediate
 * positions net to zero through hop transactions, and the recovered value is recognized as an
 * expense in the **terminal origin** position(s) it ultimately came from ({@link recaptureGroups}).
 * Surface-position value with no lineage is expensed directly in the consuming transaction
 * ({@link originAmounts}). Residual-derived value has its leg closed ({@link residualCloseOutputs})
 * and its deferred origin-basis equity re-recognized — within the same {@link ResidualAccount} that
 * originally minted the residual (read off `node.residual.account`), not the expense account — then
 * expensed there ({@link residualRecognitions}).
 *
 * Commit order: the consuming transaction first, then the hops (so the origin amounts they thread
 * are available), then the expense recognitions.
 */
export class ExpenseResolution {
    /** One group per terminal-origin position recovered by the unwind; each drives one expense transaction. */
    public readonly recaptureGroups: ExpenseRecapturedGroup[];
    /** Surface-position portions with no exchange lineage; expensed directly in the consuming transaction. */
    public readonly originAmounts: { position: Position; quantity: bigint }[];
    /** Per-origin-position capital-gain recognitions for settled residual-derived value; each pairs with an expense output. */
    public readonly residualRecognitions: ExpenseResidualRecognition[];
    /** Surface-position settlements closing the residual legs of expensed residual-derived value. */
    public readonly residualCloseOutputs: Output[];

    /** Surface-position recapture settlements (outermost edges' to-sides) — belong in the consuming transaction. */
    private readonly surfaceSettlements: Output[];
    /** Intermediate positions crossed by a multi-hop unwind; each transaction nets to zero. */
    private readonly hops: HopTransaction[];
    /** Direct expense debits for the no-lineage {@link originAmounts}, in the surface position. */
    private readonly directExpenseOutputs: Output[];
    /** Recognition entries: each reclaimed origin amount / settled-residual gain paired with its expense debit. */
    private readonly expenseEntries: { inputs: Input[]; outputs: Output[] }[];

    private readonly fromPosition: Position;

    constructor(
        public readonly inputs: Input[],
        private readonly transactions: Transaction[],
        engine: BookValueEngine,
        private readonly account: Account
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

        this.directExpenseOutputs = this.generateDirectExpenseOutputs();
        this.expenseEntries = this.buildExpenseEntries();
    }

    // Each terminal reclaim is an origin position whose recovered basis is expensed; sum the
    // group's reclaimed quantities to size that position's expense.
    private groupTerminalReclaims(classification: RecaptureClassification): ExpenseRecapturedGroup[] {
        return [...classification.terminalReclaims].map(([position, recaptures]) => ({
            position,
            recaptures,
            totalQuantity: recaptures.reduce((sum, r) => sum + r.reclaim.quantity, 0n),
        }));
    }

    // Residual-derived value: close each open residual leg, then re-recognize its deferred
    // origin-basis equity in the origin position. The recognition is a position-shift within the
    // residual's *own* account (keyed off the lot, which carries its account), so value tracing
    // through residuals from different accounts never collapses into one.
    private settleResiduals(plan: UnwindPlan): { closeOutputs: Output[]; recognitions: ExpenseResidualRecognition[] } {
        const closeOutputs: Output[] = [];
        const originTotals = new Map<ResidualAccount, Map<Position, bigint>>();
        for (const node of plan.residualNodes) {
            closeOutputs.push(node.residual.consume(node.quantity, this.transactions));
            let byPosition = originTotals.get(node.residual.account);
            if (!byPosition) originTotals.set(node.residual.account, byPosition = new Map<Position, bigint>());
            for (const [position, quantity] of node.originBasis)
                byPosition.set(position, (byPosition.get(position) ?? 0n) + quantity);
        }

        const recognitions: ExpenseResidualRecognition[] = [];
        for (const [account, byPosition] of originTotals)
            for (const [position, quantity] of byPosition) {
                const gainLot = account.addResidualInput(quantity, position, new Map<Position, bigint>([[position, quantity]]));
                recognitions.push({ position, quantity, gainLot });
            }

        return { closeOutputs, recognitions };
    }

    // No-lineage surface value is expensed directly. Derive it as the remainder of the consumed
    // amount after surface settlements and closed residual legs, so the consuming transaction
    // balances exactly.
    private computeOriginAmounts(
        totalConsumed: bigint,
        surfaceSettled: bigint,
        residualCloseOutputs: Output[]
    ): { position: Position; quantity: bigint }[] {
        const residualSurface = residualCloseOutputs.reduce((sum, o) => sum + o.quantity, 0n);
        const directSurface = totalConsumed - surfaceSettled - residualSurface;
        return directSurface > 0n ? [{ position: this.fromPosition, quantity: directSurface }] : [];
    }

    // Surface-position expense debits for the no-lineage origin amounts (the consuming transaction's
    // own expense recognition).
    private generateDirectExpenseOutputs(): Output[] {
        return this.originAmounts.flatMap(o => this.account.generateOutputs(o.position, o.quantity, this.transactions));
    }

    // One recognition entry per terminal-origin reclaim (reclaimed origin amount → expense output)
    // and one per settled-residual recognition (recognized capital-gain lot → expense output).
    private buildExpenseEntries(): { inputs: Input[]; outputs: Output[] }[] {
        return [
            ...this.recaptureGroups.map(group => ({
                inputs: group.recaptures.map(r => r.reclaim),
                outputs: this.account.generateOutputs(group.position, group.totalQuantity, this.transactions),
            })),
            ...this.residualRecognitions.map(r => ({
                inputs: [r.gainLot] as Input[],
                outputs: this.account.generateOutputs(r.position, r.quantity, this.transactions),
            })),
        ];
    }

    /**
     * Outputs for the consuming transaction (surface position): the surface-position recapture
     * settlements, the direct expense debits for any no-lineage origin amounts, and the closed legs
     * of any settled residuals — together balancing exactly against the consumed `inputs`.
     */
    public getFromOutputs(): Output[] {
        return [...this.surfaceSettlements, ...this.directExpenseOutputs, ...this.residualCloseOutputs];
    }

    /** The consuming transaction: the consumed `inputs` against {@link getFromOutputs}, plus any `additionalNodes`. */
    public constructFromTransaction(additionalNodes?: { inputs: Input[]; outputs: Output[] }): Transaction {
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
    public constructIntermediateTransactions(): Transaction[] {
        return this.hops.map(hop => new Transaction(hop.inputs, hop.outputs, this.transactions));
    }

    /**
     * The expense-recognition transactions: one per terminal-origin recapture group (reclaimed
     * origin amount → expense output in that position) and one per settled-residual recognition
     * (recognized capital-gain lot → expense output). Commit these last.
     */
    public constructExpenseTransactions(): Transaction[] {
        return this.expenseEntries.map(entry => new Transaction(entry.inputs, entry.outputs, this.transactions));
    }

    public constructTransactions(additionalNodes?: {inputs: Input[]; outputs: Output[]}): ExpenseTransactions {
        return new ExpenseTransactions(
            this.constructFromTransaction(additionalNodes),
            this.constructIntermediateTransactions(),
            this.constructExpenseTransactions()
        );
    }
}
