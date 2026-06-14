import type { BasisPath, ResidualPath } from "./types.js";
import type { Position } from "../../ledger-kernel/positions.js";
import type { Exchange } from "../../ledger-kernel/transactions/cross-position.js";

/**
 * A single exchange edge selected for recapture, with the to-side amount being recaptured
 * and the equivalent from-side amount at the exchange's locked rate.
 */
export type RecaptureEdge = {
    exchange: Exchange;
    toQuantity: bigint;
    fromQuantity: bigint;
};

/**
 * The result of unwinding a basis tree: which exchange edges to recapture (one entry per
 * distinct exchange, with summed quantities), the basis amounts recovered at the recovery
 * points, the surface-position quantity that participated in a recovery (the proration
 * weight), and the terminal residual nodes in the consumed lineage.
 */
export interface UnwindPlan {
    recaptures: Map<Exchange, { toQuantity: bigint; fromQuantity: bigint; }>;
    recovered: Map<Position, bigint>;
    loopedSurfaceQuantity: bigint;
    residualNodes: ResidualPath[];
}

/**
 * Recursively walks a {@link BasisPath} tree and selects the exchange edges to recapture,
 * propagating recovered basis backward through the inherited provenance chain.
 *
 * Two modes, controlled by `stopAt`:
 *
 * - **Loop mode** (`stopAt` is a position): recapture is triggered only where value returns
 *   to an ancestor position already present in its own lineage. An edge whose from-side is
 *   `stopAt` is the loop ancestor — recapture it, record its from-side as recovered basis, and
 *   stop (its from-side keeps its own deeper provenance). An intermediate edge is recaptured
 *   **only if** a loop exists somewhere in its from-side lineage, proportionally to the looped
 *   fraction; otherwise it is left open (pure forward provenance — exchanges do not realize).
 *
 * - **Full mode** (`stopAt` is `null`): the value fully leaves the system (expense / total
 *   disposal), so every exchange edge is recaptured and the recovered basis bottoms out at the
 *   origin-position leaves.
 *
 * `loopedQuantity` is the portion of this basis level's total quantity that reached a recovery
 * point, expressed in this level's own position — at the top level that is the surface position,
 * which is the correct proration weight for splitting proceeds.
 */
function collectChainEdges(
    basis: BasisPath[],
    stopAt: Position | null
): { edges: RecaptureEdge[]; recovered: Map<Position, bigint>; loopedQuantity: bigint; } {
    const edges: RecaptureEdge[] = [];
    const recovered = new Map<Position, bigint>();
    let loopedQuantity = 0n;

    const addRecovered = (position: Position, quantity: bigint): void => {
        recovered.set(position, (recovered.get(position) ?? 0n) + quantity);
    };
    const mergeRecovered = (other: Map<Position, bigint>): void => {
        for (const [position, quantity] of other) addRecovered(position, quantity);
    };

    for (const path of basis) {
        if (path.type === "residual") continue; // terminal; settled separately by the caller

        if (path.type === "origin") {
            // In full mode the origin leaf is the recovery point; in loop mode a bare origin
            // is a dead end (value already in this position with no exchange to unwind).
            if (stopAt === null) {
                addRecovered(path.position, path.quantity);
                loopedQuantity += path.quantity;
            }
            continue;
        }

        const { exchange, quantity: qTo, fromQuantity: qFrom } = path;

        if (stopAt !== null && exchange.from.position === stopAt) {
            // Loop ancestor: the whole edge loops back to the target. Recover its from-side
            // basis and stop — its from-side carries its own (still-open) deeper provenance.
            edges.push({ exchange, toQuantity: qTo, fromQuantity: qFrom });
            addRecovered(stopAt, qFrom);
            loopedQuantity += qTo;
            continue;
        }

        const sub = collectChainEdges(path.basis, stopAt);

        if (stopAt === null) {
            // Full unwind: recapture every edge in its entirety.
            edges.push({ exchange, toQuantity: qTo, fromQuantity: qFrom }, ...sub.edges);
            mergeRecovered(sub.recovered);
            loopedQuantity += qTo;
        } else if (sub.loopedQuantity > 0n) {
            // Intermediate edge on a loop path: recapture proportionally to the looped fraction
            // of its from-side, threading the reclaimed value down to the loop ancestor.
            const recapTo = qFrom > 0n ? qTo * sub.loopedQuantity / qFrom : 0n;
            edges.push({ exchange, toQuantity: recapTo, fromQuantity: sub.loopedQuantity }, ...sub.edges);
            mergeRecovered(sub.recovered);
            loopedQuantity += recapTo;
        }
        // else: no loop below this edge — leave it open (forward provenance, no realization).
    }

    return { edges, recovered, loopedQuantity };
}

/**
 * Aggregates {@link RecaptureEdge}s by exchange instance, summing the to-side and from-side
 * quantities across all edges sharing the same exchange. Ensures each exchange is recaptured
 * exactly once even when its lineage appears across multiple consumed UTXOs or branches.
 */
function groupRecapturesByExchange(edges: RecaptureEdge[]): Map<Exchange, { toQuantity: bigint; fromQuantity: bigint; }> {
    const grouped = new Map<Exchange, { toQuantity: bigint; fromQuantity: bigint; }>();
    for (const edge of edges) {
        const existing = grouped.get(edge.exchange) ?? { toQuantity: 0n, fromQuantity: 0n };
        grouped.set(edge.exchange, {
            toQuantity: existing.toQuantity + edge.toQuantity,
            fromQuantity: existing.fromQuantity + edge.fromQuantity,
        });
    }
    return grouped;
}

/**
 * Collects every {@link ResidualPath} in a basis tree — the residual-derived portions of
 * consumed value. Recurses through exchange nodes (a residual can sit behind a later exchange);
 * residual nodes are terminal and not recursed into.
 */
function collectResidualNodes(basis: BasisPath[]): ResidualPath[] {
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
 * recurse into their from-side basis; residual nodes contribute their recorded `originBasis`.
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
 * Unwinds a consumed basis tree into a recapture plan. See {@link collectChainEdges} for the
 * loop-vs-forward and full-unwind semantics.
 *
 * @param basis - The basis tree of the consumed value (from {@link BookValueEngine.compute}).
 * @param stopAt - The proceeds/target position for loop mode, or `null` for a full unwind to origin.
 */
export function unwind(basis: BasisPath[], stopAt: Position | null): UnwindPlan {
    const { edges, recovered, loopedQuantity } = collectChainEdges(basis, stopAt);
    return {
        recaptures: groupRecapturesByExchange(edges),
        recovered,
        loopedSurfaceQuantity: loopedQuantity,
        residualNodes: collectResidualNodes(basis),
    };
}
