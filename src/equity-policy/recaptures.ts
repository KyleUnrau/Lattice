import type { Position } from "../ledger-kernel/positions.js";
import type { Transaction } from "../ledger-kernel/transactions.js";
import { UTXOConsumption, type Input } from "../ledger-kernel/transactions/inputs.js";
import type { UTXIConsumption } from "../ledger-kernel/transactions/outputs.js";
import type { UnwindPlan } from "./book-value/lineage.js";
import type { ExchangeRecapture, HopTransaction } from "./exchange/types.js";

/**
 * Shared recapture-plan primitives used by both the exchange-resolution layer
 * ({@link computeRecaptureResolution}) and the {@link expense} layer. These turn an
 * {@link UnwindPlan} into executed, position-classified {@link ExchangeRecapture}s; the
 * proceeds-vs-origin policy on top of them differs per use case and lives in those layers.
 */

/** The surface (consumed) position being spent and the total quantity consumed across `inputs`. */
export interface ConsumptionSummary {
    /** Position of the consumed UTXOs, or `undefined` when `inputs` contains no consumptions. */
    surfacePosition: Position | undefined;
    /** Summed quantity of the consumed UTXOs. */
    totalConsumed: bigint;
}

/** Summarizes the consumed portion of `inputs`: which position is being spent and how much. */
export function summarizeConsumption(inputs: Input[]): ConsumptionSummary {
    const consumptions = inputs.filter((i): i is UTXOConsumption => i instanceof UTXOConsumption);
    return {
        surfacePosition: consumptions[0]?.source.position,
        totalConsumed: consumptions.reduce((sum, c) => sum + c.quantity, 0n),
    };
}

/**
 * Issues one {@link ExchangeRecapture} per distinct exchange in `plan`, at the plan's grouped
 * to-side quantity. Zero-quantity edges are skipped.
 */
export function executeRecaptures(plan: UnwindPlan, transactions: Transaction[]): ExchangeRecapture[] {
    const recaptures: ExchangeRecapture[] = [];
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
    /** Intermediate positions crossed by a multi-hop unwind; each transaction nets to zero. */
    hops: HopTransaction[];
    /** Recaptures reclaiming value at a terminal (non-hop) position, keyed by that position. */
    terminalReclaims: Map<Position, ExchangeRecapture[]>;
}

/**
 * Classifies `recaptures` by position relative to `surfacePosition`:
 *
 * - a recapture whose `from` settles in the surface position is a **surface settlement**;
 * - a position that is both *reclaimed* (some `recapture.to` lands there) and *settled*
 *   (some `recapture.from` lands there), other than the surface, is an **intermediate hop**
 *   whose inputs reclaim the inner edge and whose outputs settle the next — netting to zero;
 * - a position that is reclaimed but not settled is a **terminal reclaim** (an origin for a full
 *   unwind, the target for a loop closure).
 */
export function classifyRecaptures(recaptures: ExchangeRecapture[], surfacePosition: Position): RecaptureClassification {
    const reclaims = new Map<Position, ExchangeRecapture[]>(); // recapture.to reclaims value into this position
    const settles = new Map<Position, ExchangeRecapture[]>();  // recapture.from settles value in this position
    const add = (map: Map<Position, ExchangeRecapture[]>, position: Position, recapture: ExchangeRecapture): void => {
        const group = map.get(position);
        if (group) group.push(recapture);
        else map.set(position, [recapture]);
    };
    for (const recapture of recaptures) {
        add(reclaims, recapture.to.source.position, recapture);
        add(settles, recapture.from.source.position, recapture);
    }

    const hops: HopTransaction[] = [];
    const terminalReclaims = new Map<Position, ExchangeRecapture[]>();
    for (const [position, group] of reclaims) {
        if (settles.has(position) && position !== surfacePosition) {
            hops.push({ position, inputs: group.map(r => r.to), outputs: settles.get(position)!.map(r => r.from) });
        } else {
            terminalReclaims.set(position, group);
        }
    }

    const surfaceSettlements = (settles.get(surfacePosition) ?? []).map(r => r.from);
    return { surfaceSettlements, hops, terminalReclaims };
}
