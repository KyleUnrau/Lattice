import type { BookValueEngine } from "../book-value/engine.js";
import type { BasisPath, ResidualPath } from "../book-value/types.js";
import { scale, type Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { Exchange } from "../transactions/cross-position.js";
import type { ExchangeRecapture } from "./exchange.js";
import type { UTXO } from "../transactions/outputs.js";

export type RecaptureableNode = {
    exchange: Exchange;
    toQuantity: bigint;
    fromQuantity: bigint;
};

/**
 * Recursively walks a {@link BasisPath} tree and collects every exchange node whose
 * from-side position matches `targetPosition`. Exchange paths with a non-matching
 * from-side are recursed into to find deeper attribution. Origin paths are ignored.
 *
 * Residual paths are skipped: a residual is recognized gain/loss layered on top of the
 * recapturable principal, so its lineage carries provenance for the basis trace but is not
 * itself recapturable — recursing into it would re-attribute the already-consumed from-side
 * of the underlying exchange and over-subscribe it.
 */
export function collectRecaptureableNodes(basis: BasisPath[], targetPosition: Position): RecaptureableNode[] {
    const result: RecaptureableNode[] = [];

    for (const path of basis) {
        if (path.type === "origin" || path.type === "residual") continue;

        if (path.exchange.from.position === targetPosition) {
            result.push({ exchange: path.exchange, toQuantity: path.quantity, fromQuantity: path.fromQuantity });
        } else {
            result.push(...collectRecaptureableNodes(path.basis, targetPosition));
        }
    }

    return result;
}

/**
 * Collects every {@link ResidualPath} in a basis tree — the residual-derived portions of consumed
 * value. Recurses through exchange nodes (a residual can sit behind a later exchange); residual
 * nodes are terminal and not recursed into.
 */
export function collectResidualNodes(basis: BasisPath[]): ResidualPath[] {
    const result: ResidualPath[] = [];
    for (const path of basis) {
        if (path.type === "residual") result.push(path);
        else if (path.type === "exchange") result.push(...collectResidualNodes(path.basis));
    }
    return result;
}

/**
 * Reduces a {@link BasisPath} tree to its terminal origin-position composition — the
 * `{position → quantity}` map of where the traced value ultimately came from. Exchange nodes
 * recurse into their from-side basis; residual nodes contribute their recorded `originBasis`
 * (a residual is terminal — its lineage is the basis it carries, not a deeper walk).
 */
export function collectOriginLeaves(basis: BasisPath[]): Map<Position, bigint> {
    const result = new Map<Position, bigint>();
    const add = (position: Position, quantity: bigint): void => {
        result.set(position, (result.get(position) ?? 0n) + quantity);
    };

    for (const path of basis) {
        if (path.type === "origin") add(path.position, path.quantity);
        else if (path.type === "exchange") for (const [p, q] of collectOriginLeaves(path.basis)) add(p, q);
        else for (const [p, q] of path.originBasis) add(p, q);
    }

    return result;
}

/**
 * Aggregates recapturable nodes by exchange instance, summing the to-side and from-side
 * quantities across all nodes sharing the same exchange. Ensures each exchange is recaptured
 * exactly once even when its lineage appears across multiple consumed UTXOs.
 */
export function groupRecapturesByExchange(nodes: RecaptureableNode[]): Map<Exchange, { toSideQuantity: bigint; fromQuantity: bigint; }> {
    const grouped = new Map<Exchange, { toSideQuantity: bigint; fromQuantity: bigint; }>();

    for (const node of nodes) {
        const existing = grouped.get(node.exchange) ?? { toSideQuantity: 0n, fromQuantity: 0n };
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
    totalCostBasis: bigint;
    residualQuantity: bigint;
    newExchangeToQuantity: bigint;
    newExchangeFromQuantity: bigint;
    /**
     * The origin-position composition (magnitude) of `residualQuantity`, derived from the recaptured
     * principal's lineage and scaled by the residual's share. e.g. a 50 CAD residual on a 500 CAD
     * principal that traces to 0.005 BTC yields `{BTC: 0.0005}`. Empty when there is no residual or
     * no recaptured principal. Carried onto the residual lot so it can later settle into its origin.
     */
    residualOriginBasis: Map<Position, bigint>;
    /**
     * Residual-derived portions of the consumed value (open residuals being spent). These are NOT
     * forward-exchanged as origin value; the caller settles each — closing the residual leg and
     * recognizing its destination-position proceeds.
     */
    residualNodes: ResidualPath[];
    /** The destination-position proceeds attributable to {@link residualNodes} (their market share). */
    residualDerivedProceeds: bigint;
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
    consumedUTXOs: { source: UTXO; quantity: bigint; }[],
    targetPosition: Position,
    totalActualReceived: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): RecaptureComputation {
    const totalConsumed = consumedUTXOs.reduce((sum, c) => sum + c.quantity, 0n);

    const allBasis: BasisPath[] = consumedUTXOs.flatMap(({ source, quantity }) => engine.compute(source, quantity));

    const nodes = collectRecaptureableNodes(allBasis, targetPosition);
    const grouped = groupRecapturesByExchange(nodes);

    const recaptures: ExchangeRecapture[] = [];
    let totalCostBasis = 0n;
    let totalRecapturedToSide = 0n;
    const perExchange: { exchange: Exchange; toSideQuantity: bigint; fromQuantity: bigint; }[] = [];

    for (const [ex, { toSideQuantity }] of grouped) {
        const recapture = ex.recapture(toSideQuantity, transactions);
        recaptures.push(recapture);
        totalCostBasis += recapture.to.quantity;
        totalRecapturedToSide += toSideQuantity;
        // recapture.to reclaims ex.from at the locked rate — the from-side (origin-direction) amount.
        perExchange.push({ exchange: ex, toSideQuantity, fromQuantity: recapture.to.quantity });
    }

    const scaledProceeds = scale(totalActualReceived, targetPosition);
    const totalActualForRecaptured = totalConsumed > 0n
        ? scaledProceeds * totalRecapturedToSide / totalConsumed
        : 0n;

    const residualQuantity = totalActualForRecaptured - totalCostBasis;

    // Residual-derived value among the consumed inputs is settled by the caller (close the residual
    // leg, recognize its destination proceeds), not forward-exchanged as origin value.
    const residualNodes = collectResidualNodes(allBasis);
    const residualDerivedTotal = residualNodes.reduce((sum, n) => sum + n.quantity, 0n);
    const residualDerivedProceeds = totalConsumed > 0n
        ? scaledProceeds * residualDerivedTotal / totalConsumed
        : 0n;

    // Origin-position basis of the residual: trace each recaptured exchange's from-side to its
    // origin composition, then scale by the residual's share of the recaptured principal. This is
    // the deferred equity the residual carries (e.g. a 50 CAD residual ↔ 0.0005 BTC).
    const residualOriginBasis = new Map<Position, bigint>();
    if (residualQuantity !== 0n && totalCostBasis > 0n) {
        const principalOrigin = new Map<Position, bigint>();
        for (const { exchange: ex, fromQuantity } of perExchange) {
            if (fromQuantity <= 0n) continue;
            for (const [position, quantity] of collectOriginLeaves(engine.compute(ex.from, fromQuantity)))
                principalOrigin.set(position, (principalOrigin.get(position) ?? 0n) + quantity);
        }
        const magnitude = residualQuantity < 0n ? -residualQuantity : residualQuantity;
        for (const [position, quantity] of principalOrigin)
            residualOriginBasis.set(position, quantity * magnitude / totalCostBasis);
    }

    // The true-origin portion (no lineage, not residual-derived) opens the forward exchange. Any
    // rounding remainder in the proceeds split rides on the forward when a true-origin portion
    // exists; otherwise it is folded into the residual settlement so the books stay exact.
    let newExchangeToQuantity = totalConsumed - totalRecapturedToSide - residualDerivedTotal;
    let newExchangeFromQuantity = scaledProceeds - totalActualForRecaptured - residualDerivedProceeds;
    let settledProceeds = residualDerivedProceeds;
    if (newExchangeToQuantity <= 0n) {
        settledProceeds += newExchangeFromQuantity;
        newExchangeToQuantity = 0n;
        newExchangeFromQuantity = 0n;
    }

    return {
        recaptures,
        totalCostBasis,
        residualQuantity,
        newExchangeToQuantity,
        newExchangeFromQuantity,
        residualOriginBasis,
        residualNodes,
        residualDerivedProceeds: settledProceeds
    };
}
