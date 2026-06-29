import type { BasisPath, ExchangePath, ResidualPath } from "./engine.js";
import type { Position } from "../../ledger-kernel/positions.js";
import type { ResidualUTXI } from "../../ledger-kernel/transactions/residual.js";
import type { Exchange } from "../../ledger-kernel/transactions/exchange.js";

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
 * A residual sliver whose origin position matches the loop-mode target — a **carry-back**. The
 * residual is a directional suspended edge from `originPosition` to `surfacePosition`; when value
 * moves back into the origin, that sliver closes: `surfaceQuantity` of the residual leg is settled
 * in `surfacePosition` and `basisAmount` of origin basis is recovered in `originPosition`. The
 * `(proceeds − basisAmount)` difference realizes as a fresh gain/loss at the origin.
 *
 * Slivers whose origin does **not** match the target are *not* represented here: they stay
 * unresolved residual edges and their surface movement falls through into a plain forward exchange.
 *
 * A residual can also be reached *through* one or more forward exchange edges (its value moved on
 * before returning toward origin) — a **nested** carry-back. {@link enclosingEdges} records that
 * chain of edges (outermost first), each carrying the residual's proportional share so the value can
 * be rewound from the consuming surface back to the residual's own surface, where its leg closes. A
 * directly-held (top-level) residual has an empty chain and `surfacePosition === the consuming surface`.
 */
export type ResidualCarryBack = {
    residual: ResidualUTXI;
    surfacePosition: Position;
    surfaceQuantity: bigint;
    originPosition: Position;
    basisAmount: bigint;
    /** Enclosing forward edges between the consuming surface and the residual's surface, outermost first; empty when directly held. */
    enclosingEdges: RecaptureEdge[];
};

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
export function collectChainEdges(
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
        // Residual nodes are not recaptured here. In loop mode a *directly-held* residual that
        // points back to the target is carried back by the caller (see {@link collectCarryBacks});
        // a residual sitting behind a forward exchange stays an unresolved edge — skipping it leaves
        // its enclosing exchange open (forward). In full mode residuals settle to origin separately.
        if (path.type === "residual") continue;

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
 * Selects the **carry-back** slivers from a consumed basis tree for a loop-mode target. A residual
 * is a directional suspended edge from its origin positions to its surface; a residual whose origin
 * basis includes `target` carries that sliver back — settling its surface leg and recovering its
 * origin basis. Slivers whose origin does not include `target` are left unresolved (they flow forward).
 *
 * The walk recurses **through forward exchange edges** to discover *nested* carry-backs — a residual
 * whose value moved forward (e.g. CAD→USD) before later returning toward its origin. The chain of
 * enclosing edges is recorded on each {@link ResidualCarryBack} (outermost first), scaled so each
 * edge reclaims the residual's proportional share down to the residual's own surface, where the leg
 * closes. Loop-ancestor edges (whose from-side is already the `target`) are not recursed into: their
 * from-side is the origin position itself, so nothing behind them carries back toward `target`.
 */
export function collectCarryBacks(basis: BasisPath[], target: Position): ResidualCarryBack[] {
    const carryBacks: ResidualCarryBack[] = [];
    collectCarryBacksInto(basis, target, [], carryBacks);
    return carryBacks;
}

function collectCarryBacksInto(
    basis: BasisPath[],
    target: Position,
    chain: ExchangePath[],
    out: ResidualCarryBack[]
): void {
    for (const path of basis) {
        if (path.type === "residual") {
            const originTotal = [...path.originBasis.values()].reduce((s, q) => s + q, 0n);
            const basisAmount = path.originBasis.get(target);
            if (basisAmount === undefined || basisAmount <= 0n || originTotal <= 0n) continue;
            const surfaceQuantity = path.quantity * basisAmount / originTotal;
            if (surfaceQuantity <= 0n) continue;

            // Scale the residual's surface share up through each enclosing edge's locked rate, from
            // innermost to outermost, so each edge reclaims exactly the residual's portion. Stored
            // outermost-first; `enclosingEdges[0].toQuantity` is the footprint in the consuming surface.
            const enclosingEdges: RecaptureEdge[] = [];
            let reclaim = surfaceQuantity;
            for (let i = chain.length - 1; i >= 0; i--) {
                const ex = chain[i]!.exchange;
                const toQuantity = ex.to.quantity * reclaim / ex.from.quantity;
                enclosingEdges.unshift({ exchange: ex, toQuantity, fromQuantity: reclaim });
                reclaim = toQuantity;
            }

            out.push({
                residual: path.residual,
                surfacePosition: path.residual.position,
                surfaceQuantity,
                originPosition: target,
                basisAmount,
                enclosingEdges,
            });
        } else if (path.type === "exchange" && path.exchange.from.position !== target) {
            collectCarryBacksInto(path.basis, target, [...chain, path], out);
        }
    }
}

/**
 * The exact surface-position quantity of a consumed `basis` whose provenance is **genuinely
 * forward** relative to loop-mode `target` — value that neither loops back to `target` nor is a
 * residual whose origin includes `target` (a carry-back). This is the surface that legitimately
 * opens a forward exchange.
 *
 * It is computed straight from the basis tree, so — unlike the recapture/carry-back surface, whose
 * to-sides are rounded down as each edge is threaded — it is independent of that truncation. When it
 * is `0n`, the entire draw provably loops or carries back: any surface the recaptures/carry-backs
 * leave un-settled is pure rounding noise and must be settled *into the loop* (recognizing its
 * proceeds as gain) rather than stranded behind a forward edge that nothing will ever close.
 */
export function forwardSurfaceQuantity(basis: BasisPath[], target: Position): bigint {
    let forward = 0n;
    for (const path of basis) {
        if (path.type === "origin") {
            // A bare origin in loop mode is a dead end (surface value with no exchange to unwind);
            // moving it onward is a genuine forward.
            forward += path.quantity;
        } else if (path.type === "residual") {
            // Only the share whose origin is NOT the target flows forward; the target-origin share
            // is a carry-back (settled in place, never forwarded).
            const originTotal = [...path.originBasis.values()].reduce((sum, q) => sum + q, 0n);
            const matching = path.originBasis.get(target) ?? 0n;
            if (originTotal > 0n) forward += path.quantity * (originTotal - matching) / originTotal;
        } else if (path.exchange.from.position !== target) {
            // An intermediate edge: only the fraction of its surface whose deeper lineage is itself
            // forward continues forward; the looped / carried-back fraction does not. (A loop-ancestor
            // edge — from-side IS the target — loops entirely and contributes nothing.)
            const subForward = forwardSurfaceQuantity(path.basis, target);
            if (path.fromQuantity > 0n) forward += path.quantity * subForward / path.fromQuantity;
        }
    }
    return forward;
}

/**
 * Aggregates {@link RecaptureEdge}s by exchange instance, summing the to-side and from-side
 * quantities across all edges sharing the same exchange. Ensures each exchange is recaptured
 * exactly once even when its lineage appears across multiple consumed UTXOs or branches.
 */
export function groupRecapturesByExchange(edges: RecaptureEdge[]): Map<Exchange, { toQuantity: bigint; fromQuantity: bigint; }> {
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