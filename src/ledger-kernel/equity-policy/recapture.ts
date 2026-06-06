import type { BookValueEngine } from "../book-value/engine.js";
import type { BasisPath } from "../book-value/types.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { Exchange } from "../transactions/cross-position.js";
import type { ExchangeRecapture } from "./exchange.js";
import type { UTXO } from "../transactions/outputs.js";

export type RecaptureableNode = {
    exchange: Exchange;
    toQuantity: number;
    fromQuantity: number;
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
 * exactly once even when its lineage appears across multiple consumed UTXOs.
 */
export function groupRecapturesByExchange(nodes: RecaptureableNode[]): Map<Exchange, { toSideQuantity: number; fromQuantity: number; }> {
    const grouped = new Map<Exchange, { toSideQuantity: number; fromQuantity: number; }>();

    for (const node of nodes) {
        const existing = grouped.get(node.exchange) ?? { toSideQuantity: 0, fromQuantity: 0 };
        grouped.set(node.exchange, {
            toSideQuantity: existing.toSideQuantity + node.toQuantity,
            fromQuantity: existing.fromQuantity + node.fromQuantity
        });
    }

    return grouped;
}

// Internal intermediate shape — not part of the public API.
type RecaptureComputation = {
    recaptures: ExchangeRecapture[];
    totalCostBasis: number;
    residualQuantity: number;
    newExchangeToQuantity: number;
    newExchangeFromQuantity: number;
};

/**
 * Resolves consumed UTXOs against a target position given a known total proceeds amount.
 *
 * For each exchange found in the basis lineage, a recapture is issued at the exchange's original
 * locked rate. Proceeds are prorated across recaptured and non-recaptured portions by their share
 * of total consumed quantity. Any consumed quantity with no exchange lineage in the target position
 * is returned as `newExchangeToQuantity`, paired with its target-position equivalent in
 * `newExchangeFromQuantity`. The forward exchange and residual are assigned by {@link exchange}.
 *
 * @param consumedUTXOs - UTXOs being consumed, with the partial quantity consumed from each.
 * @param targetPosition - The position to resolve cost basis into (e.g. BTC).
 * @param totalActualReceived - Total proceeds in `targetPosition` for the full consumed quantity.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 */
export function computeRecaptureResolution(
    consumedUTXOs: { source: UTXO; quantity: number; }[],
    targetPosition: Position,
    totalActualReceived: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): RecaptureComputation {
    const totalConsumed = consumedUTXOs.reduce((sum, c) => sum + c.quantity, 0);

    const allBasis: BasisPath[] = consumedUTXOs.flatMap(({ source, quantity }) => engine.compute(source, quantity));

    const nodes = collectRecaptureableNodes(allBasis, targetPosition);
    const grouped = groupRecapturesByExchange(nodes);

    const recaptures: ExchangeRecapture[] = [];
    let totalCostBasis = 0;
    let totalRecapturedToSide = 0;

    for (const [ex, { toSideQuantity, fromQuantity }] of grouped) {
        recaptures.push(ex.recapture(toSideQuantity, transactions));
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
