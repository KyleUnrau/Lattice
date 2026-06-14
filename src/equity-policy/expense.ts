import type { BookValueEngine } from "./book-value/engine.js";
import type { Ledger } from "../ledger-kernel/ledger.js";
import type { Position } from "../ledger-kernel/positions.js";
import type { Transaction } from "../ledger-kernel/transactions.js";
import type { ExchangeRecapture, HopTransaction } from "./exchange/index.js";
import type { ResidualUTXI } from "../ledger-kernel/transactions/cross-position.js";
import type { ResidualAccount } from "../ledger-kernel/accounts/computed.js";
import type { Input } from "../ledger-kernel/transactions/inputs.js";
import type { Output } from "../ledger-kernel/transactions/outputs.js";
import { unwind } from "./book-value/lineage.js";
import { classifyRecaptures, executeRecaptures, summarizeConsumption } from "./recaptures.js";
import type { Account } from "../ledger-kernel/accounts/account.js";

/** A residual settled by being expensed: its origin-position basis is recognized as a capital gain. */
export type ExpenseResidualRecognition = {
    position: Position;
    quantity: bigint;
    /** The capital-gain lot recognized for this settled residual; pairs against an expense output. */
    gainLot: ResidualUTXI;
};

/** All recaptures whose reclaimed from-side is a terminal origin position to be expensed. */
export type ExpenseRecaptureGroup = {
    position: Position;
    recaptures: ExchangeRecapture[];
    totalQuantity: bigint;
};

/**
 * The resolved result of an {@link expense} call.
 *
 * - `recaptureGroups` — one group per terminal **origin** position recovered by fully unwinding
 *   the consumed value; each drives one expense transaction in that position.
 * - `originAmounts` — surface-position portions with no exchange lineage; expensed directly in the
 *   consuming transaction.
 * - `intermediateTransactions` — the per-position hop transactions threading a multi-hop unwind.
 */
export class ExpenseResolution {
    constructor(
        public readonly recaptureGroups: ExpenseRecaptureGroup[],
        public readonly originAmounts: Array<{ position: Position; quantity: bigint }>,
        public readonly intermediateTransactions: HopTransaction[] = [],
        /** Surface-position settlements closing the residual legs of expensed residual-derived value. */
        public readonly residualCloseOutputs: Output[] = [],
        /** Per-origin-position capital-gain recognitions for settled residuals; each pairs with an expense output. */
        public readonly residualRecognitions: ExpenseResidualRecognition[] = [],
        private readonly surfaceRecaptureSettlements: Output[] = [],
    ) {}

    /**
     * Outputs for the consuming transaction's surface portion: surface-position recapture
     * settlements, direct expense outputs for any no-lineage origin amounts, and the closed legs
     * of any settled residuals.
     */
    getFromOutputs(account: Account, transactions: Transaction[]): Output[] {
        return [
            ...this.surfaceRecaptureSettlements,
            ...this.originAmounts.flatMap(o => account.getLotStore(o.position).generateOutputsRaw(o.quantity, transactions)),
            ...this.residualCloseOutputs,
        ];
    }

    /**
     * `{ inputs, outputs }` pairs recognizing the expense: one transaction per terminal-origin
     * recapture group (reclaimed origin amount → expense output in that position) and one per
     * settled-residual recognition (recognized capital-gain lot → expense output).
     */
    getExpenseEntries(account: Account, transactions: Transaction[]): { inputs: Input[]; outputs: Output[] }[] {
        return [
            ...this.recaptureGroups.map(group => ({
                inputs: group.recaptures.map(r => r.reclaim),
                outputs: account.getLotStore(group.position).generateOutputsRaw(group.totalQuantity, transactions),
            })),
            ...this.residualRecognitions.map(r => ({
                inputs: [r.gainLot] as Input[],
                outputs: account.getLotStore(r.position).generateOutputsRaw(r.quantity, transactions),
            })),
        ];
    }

    /**
     * Commits the hop transactions and expense entries via `ledger.newTransaction` (hops first,
     * so the reclaimed origin amounts they thread are available). Call after committing the
     * consuming transaction.
     */
    createTransactions(account: Account, ledger: Ledger): Transaction[] {
        const hops = this.intermediateTransactions.map(({ inputs, outputs }) => ledger.newTransaction(inputs, outputs));
        const entries = this.getExpenseEntries(account, ledger.transactions)
            .map(({ inputs, outputs }) => ledger.newTransaction(inputs, outputs));
        return [...hops, ...entries];
    }
}

/**
 * Records an expense across the full provenance of the consumed inputs.
 *
 * Because an expense consumes the value entirely, the whole exchange lineage is unwound to its
 * origins ({@link unwind} in full mode): every edge is recaptured at its locked rate, intermediate
 * positions net to zero through hop transactions, and the recovered value is recognized as an
 * expense in the **terminal origin** position(s) it ultimately came from. Surface-position value
 * with no lineage is expensed directly in the consuming transaction. Residual-derived value has
 * its leg closed and its deferred origin-basis equity re-recognized — as a position-shift into the
 * origin position **within the same {@link ResidualAccount} that originally minted the residual**
 * (read off `node.residual.account`), not in any externally supplied account — then expensed there.
 *
 * @param inputs - Expense inputs to record, typically drawn from a single account.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 */
export function expense(
    inputs: Input[],
    engine: BookValueEngine,
    transactions: Transaction[]
): ExpenseResolution {
    const { surfacePosition, totalConsumed } = summarizeConsumption(inputs);
    if (surfacePosition === undefined) return new ExpenseResolution([], []);

    const plan = unwind(engine.compute(inputs), null);
    const recaptures = executeRecaptures(plan, transactions);

    // A full unwind recaptures every edge: each terminal reclaim is an origin position whose
    // recovered basis is expensed; intermediate positions thread through hop transactions; and
    // surface-position settlements (outermost edges' to-sides) belong in the consuming transaction.
    const { surfaceSettlements, hops: intermediateTransactions, terminalReclaims } = classifyRecaptures(recaptures, surfacePosition);

    const recaptureGroups: ExpenseRecaptureGroup[] = [...terminalReclaims].map(([position, group]) => ({
        position,
        recaptures: group,
        totalQuantity: group.reduce((s, r) => s + r.reclaim.quantity, 0n),
    }));
    const surfaceSettled = surfaceSettlements.reduce((s, o) => s + o.quantity, 0n);

    // Residual-derived value: close the leg, then re-recognize its deferred origin-basis equity in
    // the origin position. This is a position-shift within the residual's *own* account, so totals
    // are bucketed per owning account (keyed off the lot, which now carries its account) — value
    // tracing through residuals from different accounts must not collapse into one.
    const residualCloseOutputs: Output[] = [];
    const residualOriginTotals = new Map<ResidualAccount, Map<Position, bigint>>();
    for (const node of plan.residualNodes) {
        residualCloseOutputs.push(node.residual.consume(node.quantity, transactions));
        let byPosition = residualOriginTotals.get(node.residual.account);
        if (!byPosition) residualOriginTotals.set(node.residual.account, byPosition = new Map<Position, bigint>());
        for (const [position, quantity] of node.originBasis)
            byPosition.set(position, (byPosition.get(position) ?? 0n) + quantity);
    }
    const residualSurface = residualCloseOutputs.reduce((sum, o) => sum + o.quantity, 0n);

    // No-lineage surface value is expensed directly. Derive it as the remainder so the consuming
    // transaction balances exactly against the consumed amount.
    const originAmounts: Array<{ position: Position; quantity: bigint }> = [];
    const directSurface = totalConsumed - surfaceSettled - residualSurface;
    if (directSurface > 0n) originAmounts.push({ position: surfacePosition, quantity: directSurface });

    const residualRecognitions: ExpenseResidualRecognition[] = [];
    for (const [account, byPosition] of residualOriginTotals) {
        for (const [position, quantity] of byPosition) {
            const gainLot = account.addResidualInput(quantity, position, new Map<Position, bigint>([[position, quantity]]));
            residualRecognitions.push({ position, quantity, gainLot });
        }
    }

    return new ExpenseResolution(
        recaptureGroups,
        originAmounts,
        intermediateTransactions,
        residualCloseOutputs,
        residualRecognitions,
        surfaceSettlements,
    );
}
