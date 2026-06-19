import { type Position } from "../ledger-kernel/positions.js";
import type { Transaction } from "../ledger-kernel/transactions.js";
import type { Exchange } from "../ledger-kernel/transactions/cross-position.js";
import type { Input, UTXOConsumption } from "../ledger-kernel/transactions/inputs.js";
import type { Output, UTXIConsumption } from "../ledger-kernel/transactions/outputs.js";
import { collectChainEdges, groupRecapturesByExchange, collectResidualNodes, collectCarryBacks } from "./book-value/lineage.js";
import type { ResidualCarryBack } from "./book-value/lineage.js";
import type { BasisPath, ResidualPath } from "./book-value/engine.js";

/** A single-position settlement transaction emitted as part of a multi-hop unwind. */
export interface HopTransaction {
    position: Position;
    inputs: Input[];
    outputs: Output[];
}

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
    /**
     * Loop mode only: residual slivers whose origin matches the target — each closes its surface
     * leg and recovers its origin basis. Slivers that do *not* match the target are absent (they
     * remain unresolved residual edges and flow into the forward exchange). Empty in full mode.
     */
    residualCarryBacks: ResidualCarryBack[];
    /**
     * Full mode only (`stopAt === null`): every `ResidualPath` in the consumed lineage, settled to
     * origin by {@link TerminalResolution}. Empty in loop mode (use {@link residualCarryBacks}).
     */
    residualNodes: ResidualPath[];
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
        // Loop mode carries directly-held residuals back to the target; full mode settles every
        // residual to origin separately (via residualNodes).
        residualCarryBacks: stopAt === null ? [] : collectCarryBacks(basis, stopAt),
        residualNodes: stopAt === null ? collectResidualNodes(basis) : [],
    };
}

/** The paired outputs of {@link Exchange.recapture} — the two sides of a locked-rate reversal. */
export interface Recapture {
    /** {@link UTXIConsumption} settling the to-side of the original exchange. Goes in a transaction's outputs. */
    settlement: UTXIConsumption;
    /** {@link UTXOConsumption} reclaiming the from-side of the original exchange. Goes in a transaction's inputs. */
    reclaim: UTXOConsumption;
}

/**
 * Issues one {@link Recapture} per distinct exchange in `plan`, at the plan's grouped
 * to-side quantity. Zero-quantity edges are skipped.
 */
export function executeRecaptures(plan: UnwindPlan, transactions: Transaction[]): Recapture[] {
    const recaptures: Recapture[] = [];
    for (const [exchange, { toQuantity }] of plan.recaptures) {
        if (toQuantity <= 0n) continue;
        recaptures.push(exchange.recapture(toQuantity, transactions));
    }
    return recaptures;
}

/** Partitions executed recaptures by the role each position plays in the unwound chain. */
export interface RecaptureClassification {
    /** Settlements landing in the surface position — belong in the consuming transaction. Recapture to-side settlements plus any injected settlements (e.g. a directly-held residual close) at the surface. */
    surfaceSettlements: Output[];
    /** Summed quantity of {@link surfaceSettlements}; pre-computed so callers avoid a redundant reduce. */
    surfaceSettled: bigint;
    /** Intermediate positions crossed by a multi-hop unwind; each transaction nets to zero. */
    hops: HopTransaction[];
    /** Recaptures reclaiming value at a terminal (non-hop) position, keyed by that position. */
    terminalReclaims: Map<Position, Recapture[]>;
}

/**
 * Classifies `recaptures` by position relative to `surfacePosition`:
 *
 * - a recapture whose `from` settles in the surface position is a **surface settlement**;
 * - a position that is both *reclaimed* (some `recapture.reclaim` lands there) and *settled*
 *   (some `recapture.settlement` lands there), other than the surface, is an **intermediate hop**
 *   whose inputs reclaim the inner edge and whose outputs settle the next — netting to zero;
 * - a position that is reclaimed but not settled is a **terminal reclaim** (an origin for a full
 *   unwind, the target for a loop closure).
 *
 * `injectedSettlements` adds non-recapture settlement outputs at a position (e.g. a nested
 * carry-back's residual-leg close), so that position is balanced as a hop (or folded into the
 * surface settlements when it *is* the surface) rather than mistaken for a terminal reclaim.
 */
export function classifyRecaptures(
    recaptures: Recapture[],
    surfacePosition: Position,
    injectedSettlements: { position: Position; outputs: Output[] }[] = []
): RecaptureClassification {
    const reclaims = new Map<Position, Recapture[]>(); // recapture.reclaim reclaims value into this position
    const settles = new Map<Position, Recapture[]>();  // recapture.settlement settles value in this position
    const add = (map: Map<Position, Recapture[]>, position: Position, recapture: Recapture): void => {
        const group = map.get(position);
        if (group) group.push(recapture);
        else map.set(position, [recapture]);
    };
    for (const recapture of recaptures) {
        add(reclaims, recapture.reclaim.source.position, recapture);
        add(settles, recapture.settlement.source.position, recapture);
    }

    const injected = new Map<Position, Output[]>();
    for (const { position, outputs } of injectedSettlements) {
        const group = injected.get(position);
        if (group) group.push(...outputs);
        else injected.set(position, [...outputs]);
    }

    const hops: HopTransaction[] = [];
    const terminalReclaims = new Map<Position, Recapture[]>();
    for (const [position, group] of reclaims) {
        const injectedOutputs = injected.get(position) ?? [];
        if ((settles.has(position) || injectedOutputs.length > 0) && position !== surfacePosition) {
            hops.push({
                position,
                inputs: group.map(r => r.reclaim),
                outputs: [...(settles.get(position) ?? []).map(r => r.settlement), ...injectedOutputs],
            });
            injected.delete(position);
        } else {
            terminalReclaims.set(position, group);
        }
    }

    const surfaceSettlements = [
        ...(settles.get(surfacePosition) ?? []).map(r => r.settlement),
        ...(injected.get(surfacePosition) ?? []),
    ];
    const surfaceSettled = surfaceSettlements.reduce((s, o) => s + o.quantity, 0n);
    return { surfaceSettlements, surfaceSettled, hops, terminalReclaims };
}