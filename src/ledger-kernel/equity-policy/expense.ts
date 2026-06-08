import type { Account } from "../accounts.js";
import type { BookValueEngine } from "../book-value/engine.js";
import type { Ledger } from "../ledger.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { ExchangeRecapture } from "./exchange.js";
import type { Input } from "../transactions/inputs.js";
import type { Output } from "../transactions/outputs.js";
import { type RecaptureableNode, groupRecapturesByExchange } from "./recapture.js";
import { consumedUTXOsFromInputs } from "./utils.js";

/**
 * All recaptures for a single origin position, collected from one or more exchanges
 * whose from-side is that position.
 *
 * - `recaptures` — one entry per distinct exchange; `.from` goes in the consuming
 *   transaction's outputs, `.to` goes in the expense transaction's inputs
 * - `totalQuantity` — aggregate from-side quantity to expense in `position`
 */
export type ExpenseRecaptureGroup = {
    position: Position;
    recaptures: ExchangeRecapture[];
    totalQuantity: bigint;
};

/**
 * The resolved result of an {@link expense} call.
 *
 * - `recaptureGroups` — one group per distinct origin position found in the basis;
 *   each group drives one expense transaction in that position
 * - `originAmounts` — portions with no exchange lineage; expensed directly in the
 *   consuming transaction as outputs in the expense account
 *
 * Use {@link ExpenseResolution.getFromOutputs} and {@link ExpenseResolution.getExpenseEntries}
 * to build the transaction entry arrays rather than constructing them manually.
 */
export class ExpenseResolution {
    constructor(
        public readonly recaptureGroups: ExpenseRecaptureGroup[],
        public readonly originAmounts: Array<{ position: Position; quantity: bigint }>,
    ) {}

    /**
     * Outputs for the consuming transaction's expense portion: recapture settlements
     * (from-sides of prior exchange recaptures) followed by direct expense outputs for
     * any origin amounts. Call before committing the consuming transaction.
     */
    getFromOutputs(account: Account, transactions: Transaction[]): Output[] {
        return [
            ...this.recaptureGroups.flatMap(g => g.recaptures.map(r => r.from)),
            ...this.originAmounts.flatMap(o => account.getEngine(o.position).generateOutputsRaw(o.quantity, transactions)),
        ];
    }

    /**
     * Returns `{ inputs, outputs }` pairs for building one expense transaction per recapture group.
     * Each pair's inputs are the recapture to-sides; outputs are new expense account entries.
     * Call after committing the consuming transaction.
     */
    getExpenseEntries(account: Account, transactions: Transaction[]): { inputs: Input[]; outputs: Output[] }[] {
        return this.recaptureGroups.map(group => ({
            inputs: group.recaptures.map(r => r.to),
            outputs: account.getEngine(group.position).generateOutputsRaw(group.totalQuantity, transactions),
        }));
    }

    /**
     * Convenience wrapper over {@link getExpenseEntries}: commits one transaction per recapture
     * group via `ledger.newTransaction`. Call after committing the consuming transaction.
     */
    createTransactions(account: Account, ledger: Ledger): Transaction[] {
        return this.getExpenseEntries(account, ledger.transactions)
            .map(({ inputs, outputs }) => ledger.newTransaction(inputs, outputs));
    }
}

/**
 * Records an expense across all exchange lineages of the consumed inputs.
 *
 * Traces the top-level basis paths for every consumed UTXO. Exchange and residual
 * paths are recaptured at their locked rates and grouped by origin position, so each
 * portion of the expense is recognised in the position it was originally derived from.
 * Origin paths (no exchange lineage) are surfaced as direct expense amounts in their
 * own position. Each recapture group drives a separate expense transaction; origin
 * amounts are balanced inside the consuming transaction itself.
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
    const consumedUTXOs = consumedUTXOsFromInputs(inputs);
    const allBasis = consumedUTXOs.flatMap(c => engine.compute(c.source, c.quantity));

    const exchangeNodes: RecaptureableNode[] = [];
    const originTotals = new Map<Position, bigint>();

    for (const path of allBasis) {
        if (path.type === "exchange" || path.type === "residual") {
            exchangeNodes.push({ exchange: path.exchange, toQuantity: path.quantity, fromQuantity: path.fromQuantity });
        } else if (path.type === "origin") {
            originTotals.set(path.position, (originTotals.get(path.position) ?? 0n) + path.quantity);
        }
    }

    const grouped = groupRecapturesByExchange(exchangeNodes);
    const byPosition = new Map<Position, ExpenseRecaptureGroup>();

    for (const [ex, { toSideQuantity, fromQuantity }] of grouped) {
        const pos = ex.from.position;
        const recapture = ex.recapture(toSideQuantity, transactions);
        const existing = byPosition.get(pos) ?? { position: pos, recaptures: [], totalQuantity: 0n };
        byPosition.set(pos, {
            position: pos,
            recaptures: [...existing.recaptures, recapture],
            totalQuantity: existing.totalQuantity + fromQuantity
        });
    }

    return new ExpenseResolution(
        Array.from(byPosition.values()),
        Array.from(originTotals.entries()).map(([position, quantity]) => ({ position, quantity }))
    );
}
