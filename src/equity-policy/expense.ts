import type { Account, ResidualAccount } from "../ledger-kernel/accounts.js";
import type { BookValueEngine } from "./book-value/engine.js";
import type { Ledger } from "../ledger-kernel/ledger.js";
import type { Position } from "../ledger-kernel/positions.js";
import type { Transaction } from "../ledger-kernel/transactions.js";
import type { ExchangeRecapture, HopTransaction } from "./exchange.js";
import type { ResidualUTXI } from "../ledger-kernel/transactions/cross-position.js";
import type { Input } from "../ledger-kernel/transactions/inputs.js";
import type { Output } from "../ledger-kernel/transactions/outputs.js";
import { unwind } from "./lineage.js";
import { consumedUTXOsFromInputs } from "./utils.js";

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
            ...this.originAmounts.flatMap(o => account.getEngine(o.position).generateOutputsRaw(o.quantity, transactions)),
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
                inputs: group.recaptures.map(r => r.to),
                outputs: account.getEngine(group.position).generateOutputsRaw(group.totalQuantity, transactions),
            })),
            ...this.residualRecognitions.map(r => ({
                inputs: [r.gainLot] as Input[],
                outputs: account.getEngine(r.position).generateOutputsRaw(r.quantity, transactions),
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
 * its leg closed and its origin basis recognized as a capital gain, then expensed in that position.
 *
 * @param inputs - Expense inputs to record, typically drawn from a single account.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 * @param residualAccount - The {@link ResidualAccount} to recognize settled-residual capital gains in.
 */
export function expense(
    inputs: Input[],
    engine: BookValueEngine,
    transactions: Transaction[],
    residualAccount: ResidualAccount
): ExpenseResolution {
    const consumedUTXOs = consumedUTXOsFromInputs(inputs);
    const surfacePosition = consumedUTXOs[0]?.source.position;
    const totalConsumed = consumedUTXOs.reduce((sum, c) => sum + c.quantity, 0n);
    const allBasis = consumedUTXOs.flatMap(c => engine.compute(c.source, c.quantity));

    const plan = unwind(allBasis, null);

    const recaptures: ExchangeRecapture[] = [];
    for (const [exchange, { toQuantity }] of plan.recaptures) {
        if (toQuantity <= 0n) continue;
        recaptures.push(exchange.recapture(toQuantity, transactions));
    }

    // Bucket recaptures by position: a position that is both reclaimed (a from-side) and settled
    // (a to-side) is an intermediate hop (nets to zero); one reclaimed but never settled is a
    // terminal origin to be expensed.
    const reclaims = new Map<Position, ExchangeRecapture[]>();   // recapture.to lands here (from-side)
    const settles = new Map<Position, ExchangeRecapture[]>();    // recapture.from lands here (to-side)
    for (const recapture of recaptures) {
        const fromPos = recapture.to.source.position;
        const toPos = recapture.from.source.position;
        (reclaims.get(fromPos) ?? reclaims.set(fromPos, []).get(fromPos)!).push(recapture);
        (settles.get(toPos) ?? settles.set(toPos, []).get(toPos)!).push(recapture);
    }

    const recaptureGroups: ExpenseRecaptureGroup[] = [];
    const intermediateTransactions: HopTransaction[] = [];
    let surfaceSettled = 0n;
    for (const [position, group] of reclaims) {
        const isIntermediate = settles.has(position) && position !== surfacePosition;
        if (isIntermediate) {
            intermediateTransactions.push({
                position,
                inputs: group.map(r => r.to),
                outputs: settles.get(position)!.map(r => r.from),
            });
        } else {
            recaptureGroups.push({ position, recaptures: group, totalQuantity: group.reduce((s, r) => s + r.to.quantity, 0n) });
        }
    }
    // Surface-position settlements (outermost edges' to-sides) belong in the consuming transaction.
    const surfaceRecaptureSettlements: Output[] = (settles.get(surfacePosition!) ?? []).map(r => r.from);
    surfaceSettled = surfaceRecaptureSettlements.reduce((s, o) => s + o.quantity, 0n);

    // Residual-derived value: close the leg, recognize its origin basis as a capital gain.
    const residualCloseOutputs: Output[] = [];
    const residualOriginTotals = new Map<Position, bigint>();
    for (const node of plan.residualNodes) {
        residualCloseOutputs.push(node.residual.consume(node.quantity, transactions));
        for (const [position, quantity] of node.originBasis)
            residualOriginTotals.set(position, (residualOriginTotals.get(position) ?? 0n) + quantity);
    }
    const residualSurface = residualCloseOutputs.reduce((sum, o) => sum + o.quantity, 0n);

    // No-lineage surface value is expensed directly. Derive it as the remainder so the consuming
    // transaction balances exactly against the consumed amount.
    const originAmounts: Array<{ position: Position; quantity: bigint }> = [];
    if (surfacePosition) {
        const direct = totalConsumed - surfaceSettled - residualSurface;
        if (direct > 0n) originAmounts.push({ position: surfacePosition, quantity: direct });
    }

    const residualRecognitions: ExpenseResidualRecognition[] = [];
    for (const [position, quantity] of residualOriginTotals) {
        const gainLot = residualAccount.addResidualInput(quantity, position, new Map<Position, bigint>([[position, quantity]]));
        residualRecognitions.push({ position, quantity, gainLot });
    }

    return new ExpenseResolution(
        recaptureGroups,
        originAmounts,
        intermediateTransactions,
        residualCloseOutputs,
        residualRecognitions,
        surfaceRecaptureSettlements,
    );
}
