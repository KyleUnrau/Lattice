import type { Account, ResidualAccount } from "../accounts.js";
import type { BookValueEngine } from "../book-value/engine.js";
import type { Ledger } from "../ledger.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { ExchangeRecapture } from "./exchange.js";
import type { ResidualUTXI } from "../transactions/cross-position.js";
import type { Input } from "../transactions/inputs.js";
import type { Output } from "../transactions/outputs.js";
import { type RecaptureableNode, groupRecapturesByExchange } from "./recapture.js";
import { consumedUTXOsFromInputs } from "./utils.js";

/** A residual settled by being expensed: its origin-position basis is recognized as a capital gain. */
export type ExpenseResidualRecognition = {
    position: Position;
    quantity: bigint;
    /** The capital-gain lot recognized for this settled residual; pairs against an expense output. */
    gainLot: ResidualUTXI;
};

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
        /** Surface-position settlements closing the residual legs of expensed residual-derived value. */
        public readonly residualCloseOutputs: Output[] = [],
        /** Per-origin-position capital-gain recognitions for settled residuals; each pairs with an expense output. */
        public readonly residualRecognitions: ExpenseResidualRecognition[] = [],
    ) {}

    /**
     * Outputs for the consuming transaction's expense portion: recapture settlements
     * (from-sides of prior exchange recaptures), direct expense outputs for any origin
     * amounts, and the closed legs of any settled residuals. Call before committing the
     * consuming transaction.
     */
    getFromOutputs(account: Account, transactions: Transaction[]): Output[] {
        return [
            ...this.recaptureGroups.flatMap(g => g.recaptures.map(r => r.from)),
            ...this.originAmounts.flatMap(o => account.getEngine(o.position).generateOutputsRaw(o.quantity, transactions)),
            ...this.residualCloseOutputs,
        ];
    }

    /**
     * Returns `{ inputs, outputs }` pairs for building one expense transaction per recapture group
     * and one per settled-residual recognition. Recapture-group inputs are the reclaimed origin
     * amounts; residual-recognition inputs are the recognized capital-gain lots. Both produce expense
     * account outputs in the origin position. Call after committing the consuming transaction.
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
 * Residual-derived value is settled rather than expensed at the surface: its leg is closed and its
 * origin-position basis is recognized as a capital gain in `residualAccount`, then expensed in that
 * origin position — so e.g. spending a 50 CAD residual carrying 0.0005 BTC yields a 0.0005 BTC gain
 * and a 0.0005 BTC expense.
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
    const allBasis = consumedUTXOs.flatMap(c => engine.compute(c.source, c.quantity));

    const exchangeNodes: RecaptureableNode[] = [];
    const originTotals = new Map<Position, bigint>();
    const residualCloseOutputs: Output[] = [];
    const residualOriginTotals = new Map<Position, bigint>();

    for (const path of allBasis) {
        if (path.type === "exchange") {
            exchangeNodes.push({ exchange: path.exchange, toQuantity: path.quantity, fromQuantity: path.fromQuantity });
        } else if (path.type === "residual") {
            // Settle the residual: close its leg in the surface position and recognize its
            // origin-position basis, which is then expensed in that origin position below.
            residualCloseOutputs.push(path.residual.consume(path.quantity, transactions));
            for (const [position, quantity] of path.originBasis)
                residualOriginTotals.set(position, (residualOriginTotals.get(position) ?? 0n) + quantity);
        } else {
            originTotals.set(path.position, (originTotals.get(path.position) ?? 0n) + path.quantity);
        }
    }

    const grouped = groupRecapturesByExchange(exchangeNodes);
    const byPosition = new Map<Position, ExpenseRecaptureGroup>();

    let recapturedSurface = 0n;
    for (const [ex, { toSideQuantity, fromQuantity }] of grouped) {
        const pos = ex.from.position;
        const recapture = ex.recapture(toSideQuantity, transactions);
        recapturedSurface += recapture.from.quantity;
        const existing = byPosition.get(pos) ?? { position: pos, recaptures: [], totalQuantity: 0n };
        byPosition.set(pos, {
            position: pos,
            recaptures: [...existing.recaptures, recapture],
            totalQuantity: existing.totalQuantity + fromQuantity
        });
    }

    // The basis decomposition can lose a few units to integer truncation in proportional
    // attribution. Fold any remainder into a direct surface-position expense so the consuming
    // transaction (which spends the full consumed amount) stays balanced.
    const surfacePosition = consumedUTXOs[0]?.source.position;
    if (surfacePosition) {
        const totalConsumed = consumedUTXOs.reduce((sum, c) => sum + c.quantity, 0n);
        const residualSurface = residualCloseOutputs.reduce((sum, o) => sum + o.quantity, 0n);
        const originSurface = originTotals.get(surfacePosition) ?? 0n;
        const remainder = totalConsumed - recapturedSurface - residualSurface - originSurface;
        if (remainder > 0n) originTotals.set(surfacePosition, originSurface + remainder);
    }

    const residualRecognitions: ExpenseResidualRecognition[] = [];
    for (const [position, quantity] of residualOriginTotals) {
        const gainLot = residualAccount.addResidualInput(quantity, position, new Map<Position, bigint>([[position, quantity]]));
        residualRecognitions.push({ position, quantity, gainLot });
    }

    return new ExpenseResolution(
        Array.from(byPosition.values()),
        Array.from(originTotals.entries()).map(([position, quantity]) => ({ position, quantity })),
        residualCloseOutputs,
        residualRecognitions
    );
}
