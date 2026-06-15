import { type Position } from "../ledger-kernel/positions.js";
import type { Transaction } from "../ledger-kernel/transactions.js";
import type { Exchange } from "../ledger-kernel/transactions/cross-position.js";
import type { Input, UTXOConsumption } from "../ledger-kernel/transactions/inputs.js";
import type { Output, UTXIConsumption } from "../ledger-kernel/transactions/outputs.js";
import { collectChainEdges, groupRecapturesByExchange, collectResidualNodes } from "./book-value/lineage.js";
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
        residualNodes: collectResidualNodes(basis),
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
    /** Settlements landing in the surface position — belong in the consuming transaction. */
    surfaceSettlements: UTXIConsumption[];
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
 */
export function classifyRecaptures(recaptures: Recapture[], surfacePosition: Position): RecaptureClassification {
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

    const hops: HopTransaction[] = [];
    const terminalReclaims = new Map<Position, Recapture[]>();
    for (const [position, group] of reclaims) {
        if (settles.has(position) && position !== surfacePosition) {
            hops.push({ position, inputs: group.map(r => r.reclaim), outputs: settles.get(position)!.map(r => r.settlement) });
        } else {
            terminalReclaims.set(position, group);
        }
    }

    const surfaceSettlements = (settles.get(surfacePosition) ?? []).map(r => r.settlement);
    const surfaceSettled = surfaceSettlements.reduce((s, o) => s + o.quantity, 0n);
    return { surfaceSettlements, surfaceSettled, hops, terminalReclaims };
}