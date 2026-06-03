import type { Exchange, ExchangeRecapture } from "./transactions/exchange.js";
import { TXOConsumption, type Input } from "./transactions/inputs.js";
import { TXO } from "./transactions/outputs.js";
import type { Transaction } from "./transactions.js";
import type { Position } from "./positions.js";
import { BookValueEngine } from "./book-value/engine.js";
import type { BasisPath } from "./book-value/types.js";

type RecaptureableNode = {
    exchange: Exchange;
    toQuantity: number;
    fromQuantity: number;
};

/**
 * The resolved result of tracing consumed outputs back to a target position.
 *
 * - `recaptures` — one recapture per distinct exchange found in the lineage
 * - `totalCostBasis` — aggregate cost in the target position across all recaptures
 * - `residualQuantity` — gain or loss: prorated actual proceeds minus cost basis; zero for expenses
 * - `newExchangeToQuantity` — consumed quantity not attributable to any exchange, needing a new exchange
 * - `newExchangeFromQuantity` — target-position equivalent for `newExchangeToQuantity` at the implied rate
 */
export type RecaptureResolution = {
    recaptures: ExchangeRecapture[];
    totalCostBasis: number;
    residualQuantity: number;
    newExchangeToQuantity: number;
    newExchangeFromQuantity: number;
};

/**
 * Recursively walks a {@link BasisPath} tree and collects every exchange node whose
 * from-side position matches `targetPosition`. Exchange paths with a non-matching
 * from-side and residual paths are recursed into to find deeper attribution.
 * Origin paths are ignored.
 */
export function collectRecaptureableNodes(basis: BasisPath[], targetPosition: Position): RecaptureableNode[] {
    const result: RecaptureableNode[] = [];

    for (const path of basis) {
        if (path.type === "origin") continue;

        if (path.type === "exchange" && path.exchange.from.position === targetPosition) {
            result.push({ exchange: path.exchange, toQuantity: path.quantity, fromQuantity: path.fromQuantity });
        } else if (path.type === "exchange") {
            result.push(...collectRecaptureableNodes(path.basis, targetPosition));
        } else if (path.type === "residual") {
            if (path.exchange.from.position !== targetPosition) {
                result.push(...collectRecaptureableNodes(path.basis, targetPosition));
            }
        }
    }

    return result;
}

/**
 * Aggregates recapturable nodes by exchange instance, summing the to-side and from-side
 * quantities across all nodes sharing the same exchange. Ensures each exchange is recaptured
 * exactly once even when its lineage appears across multiple consumed TXOs.
 */
export function groupRecapturesByExchange(nodes: RecaptureableNode[]): Map<Exchange, { toSideQuantity: number; fromQuantity: number }> {
    const grouped = new Map<Exchange, { toSideQuantity: number; fromQuantity: number }>();

    for (const node of nodes) {
        const existing = grouped.get(node.exchange) ?? { toSideQuantity: 0, fromQuantity: 0 };
        grouped.set(node.exchange, {
            toSideQuantity: existing.toSideQuantity + node.toQuantity,
            fromQuantity: existing.fromQuantity + node.fromQuantity
        });
    }

    return grouped;
}

/**
 * Resolves consumed TXOs against a target position given a known total proceeds amount.
 *
 * For each exchange found in the basis lineage, a recapture transaction is issued at the
 * exchange's original locked rate. Proceeds are prorated across recaptured and non-recaptured
 * portions by their share of total consumed quantity. Any consumed quantity with no exchange
 * lineage in the target position is returned as `newExchangeToQuantity`, paired with its
 * target-position equivalent in `newExchangeFromQuantity`.
 *
 * @param consumedTXOs - TXOs being consumed, with the partial quantity consumed from each.
 * @param targetPosition - The position to resolve cost basis into (e.g. BTC).
 * @param totalActualReceived - Total proceeds in `targetPosition` for the full consumed quantity.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 */
export function computeRecaptureResolution(
    consumedTXOs: { source: TXO; quantity: number }[],
    targetPosition: Position,
    totalActualReceived: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): RecaptureResolution {
    const totalConsumed = consumedTXOs.reduce((sum, c) => sum + c.quantity, 0);

    const allBasis: BasisPath[] = consumedTXOs.flatMap(({ source, quantity }) => engine.compute(source, quantity));

    const nodes = collectRecaptureableNodes(allBasis, targetPosition);
    const grouped = groupRecapturesByExchange(nodes);

    const recaptures: ExchangeRecapture[] = [];
    let totalCostBasis = 0;
    let totalRecapturedToSide = 0;

    for (const [exchange, { toSideQuantity, fromQuantity }] of grouped) {
        recaptures.push(exchange.recapture(toSideQuantity, transactions));
        totalCostBasis += fromQuantity;
        totalRecapturedToSide += toSideQuantity;
    }

    const totalActualForRecaptured = totalConsumed > 0
        ? totalActualReceived * (totalRecapturedToSide / totalConsumed)
        : 0;

    return {
        recaptures,
        totalCostBasis,
        residualQuantity: totalActualForRecaptured - totalCostBasis,
        newExchangeToQuantity: totalConsumed - totalRecapturedToSide,
        newExchangeFromQuantity: totalActualReceived - totalActualForRecaptured
    };
}

/**
 * Extracts {@link TXOConsumption} inputs from a mixed input array, returning each as a
 * `{ source, quantity }` pair suitable for {@link computeRecaptureResolution}.
 * Non-consumption inputs (exchange inputs, origin TXIs) are silently ignored.
 */
export function consumedTXOsFromInputs(inputs: Input[]): { source: TXO; quantity: number }[] {
    return inputs.filter((i): i is TXOConsumption => i instanceof TXOConsumption)
        .map(c => ({ source: c.source, quantity: c.quantity }));
}

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
    totalQuantity: number;
};

/**
 * The full result of resolving expense inputs across all exchange lineages.
 *
 * - `recaptureGroups` — one group per distinct origin position found in the basis;
 *   each group drives one expense transaction in that position
 * - `originAmounts` — portions with no exchange lineage; expense directly in their
 *   own position as outputs of the consuming transaction
 */
export type ExpenseResolution = {
    recaptureGroups: ExpenseRecaptureGroup[];
    originAmounts: Array<{ position: Position; quantity: number }>;
};

/**
 * Resolves expense inputs across all exchange lineages without requiring a known
 * target position.
 *
 * Traces the top-level basis paths for every consumed TXO. Exchange and residual
 * paths are recaptured at their locked rates and grouped by their origin position.
 * Origin paths (no exchange lineage) are surfaced as direct expense amounts in
 * their own position. Each recapture group drives a separate expense transaction;
 * origin amounts are balanced inside the consuming transaction itself.
 *
 * @param inputs - Expense inputs to resolve, typically drawn from a single account.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 */
export function resolveExpense(
    inputs: Input[],
    engine: BookValueEngine,
    transactions: Transaction[]
): ExpenseResolution {
    const consumedTXOs = consumedTXOsFromInputs(inputs);
    const allBasis = consumedTXOs.flatMap(c => engine.compute(c.source, c.quantity));

    const exchangeNodes: RecaptureableNode[] = [];
    const originTotals = new Map<Position, number>();

    for (const path of allBasis) {
        if (path.type === "exchange" || path.type === "residual") {
            exchangeNodes.push({ exchange: path.exchange, toQuantity: path.quantity, fromQuantity: path.fromQuantity });
        } else if (path.type === "origin") {
            originTotals.set(path.position, (originTotals.get(path.position) ?? 0) + path.quantity);
        }
    }

    const grouped = groupRecapturesByExchange(exchangeNodes);
    const byPosition = new Map<Position, ExpenseRecaptureGroup>();

    for (const [exchange, { toSideQuantity, fromQuantity }] of grouped) {
        const pos = exchange.from.position;
        const recapture = exchange.recapture(toSideQuantity, transactions);
        const existing = byPosition.get(pos) ?? { position: pos, recaptures: [], totalQuantity: 0 };
        byPosition.set(pos, {
            position: pos,
            recaptures: [...existing.recaptures, recapture],
            totalQuantity: existing.totalQuantity + fromQuantity
        });
    }

    return {
        recaptureGroups: Array.from(byPosition.values()),
        originAmounts: Array.from(originTotals.entries()).map(([position, quantity]) => ({ position, quantity }))
    };
}
