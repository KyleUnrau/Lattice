import type { BookValueEngine } from "../book-value/engine.js";
import type { ResidualPath } from "../book-value/types.js";
import { scale, type Position } from "../../ledger-kernel/positions.js";
import type { Transaction } from "../../ledger-kernel/transactions.js";
import type { ExchangeRecapture } from "./types.js";
import type { Input } from "../../ledger-kernel/transactions/inputs.js";
import { collectOriginLeaves, unwind } from "../book-value/lineage.js";
import { executeRecaptures, summarizeConsumption } from "../recaptures.js";

// Internal intermediate shape — not part of the public API.
type RecaptureComputation = {
    /** One recapture per distinct exchange on the recovered loop path(s); may span positions. */
    recaptures: ExchangeRecapture[];
    /** Recovered basis in `targetPosition` (the loop principal). */
    totalCostBasis: bigint;
    /** Surface position of the consumed inputs (the position being spent). */
    surfacePosition: Position;
    /** Gain (>0) or loss (<0) residual in `targetPosition`; balances the target transaction. */
    residualQuantity: bigint;
    /** Forward-exchange surface-side quantity (origin/forward portion with no loop). */
    newExchangeToQuantity: bigint;
    /** Forward-exchange target-side quantity at the actual proceeds rate. */
    newExchangeFromQuantity: bigint;
    /**
     * The origin-position composition of `residualQuantity`, derived from the recovered loop
     * principal's deep lineage and scaled by the residual's share. Carried onto the residual lot
     * so it can later settle into its origin.
     */
    residualOriginBasis: Map<Position, bigint>;
    /**
     * Residual-derived portions of the consumed value (open residuals being spent). The caller
     * settles each — closing the residual leg and recognizing its destination proceeds.
     */
    residualNodes: ResidualPath[];
    /** The destination-position proceeds attributable to {@link residualNodes}. */
    residualDerivedProceeds: bigint;
};

/**
 * Resolves consumed UTXOs against a target position given a known total proceeds amount.
 *
 * Unwinds the consumed value's full provenance via {@link unwind}: where the lineage loops back
 * to `targetPosition`, every exchange edge on the path down to the loop ancestor is recaptured
 * proportionately at its locked rate (keeping exchange-state consistent across multi-hop chains);
 * where it does not loop, the portion opens a forward exchange carrying provenance onward.
 *
 * Proceeds are split by surface quantity: the forward portion and any residual-derived portion
 * take their proportional share, and the recovered loop's gain/loss residual absorbs the
 * remainder — so both the surface and target transactions balance exactly by construction.
 *
 * @param inputs - The exchanged-portion inputs being consumed (surface-position UTXO consumptions).
 * @param targetPosition - The proceeds position to resolve against (e.g. CAD).
 * @param totalActualReceived - Total proceeds in `targetPosition` for the full consumed quantity.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 */
export function computeRecaptureResolution(
    inputs: Input[],
    targetPosition: Position,
    totalActualReceived: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): RecaptureComputation {
    const { surfacePosition, totalConsumed } = summarizeConsumption(inputs);
    if (surfacePosition === undefined) throw new Error("computeRecaptureResolution requires at least one consumed input");

    const plan = unwind(engine.compute(inputs), targetPosition);

    // Execute one recapture per distinct exchange on the recovered loop path(s).
    const recaptures = executeRecaptures(plan, transactions);

    // Recovered basis = the reclaimed from-sides that land in the target position (the loop
    // ancestor edges). surfaceSettled = the outermost edges' to-sides settled in the surface
    // position — what the consuming transaction must balance against.
    let totalCostBasis = 0n;
    let surfaceSettled = 0n;
    for (const recapture of recaptures) {
        if (recapture.to.source.position === targetPosition) totalCostBasis += recapture.to.quantity;
        if (recapture.from.source.position === surfacePosition) surfaceSettled += recapture.from.quantity;
    }

    const scaledProceeds = scale(totalActualReceived, targetPosition);

    // Residual-derived value among the consumed inputs is settled by the caller, not forward-exchanged.
    const residualNodes = plan.residualNodes;
    const residualDerivedTotal = residualNodes.reduce((sum: bigint, n: ResidualPath) => sum + n.quantity, 0n);
    const residualDerivedProceeds = totalConsumed > 0n ? scaledProceeds * residualDerivedTotal / totalConsumed : 0n;

    // The forward portion is whatever surface value neither looped nor came from a residual.
    // Deriving it from the actually-settled surface amount keeps the consuming transaction exact.
    const newExchangeToQuantity = totalConsumed - surfaceSettled - residualDerivedTotal;
    const newExchangeFromQuantity = newExchangeToQuantity > 0n && totalConsumed > 0n
        ? scaledProceeds * newExchangeToQuantity / totalConsumed
        : 0n;

    // Gain (>0) / loss (<0) on the recovered loop: proceeds minus everything else accounted for.
    // Absorbing the rounding remainder here keeps the target transaction balanced exactly.
    const residualQuantity = scaledProceeds - totalCostBasis - newExchangeFromQuantity - residualDerivedProceeds;

    // Deep origin composition of the loop principal, scaled by the residual's share — the
    // deferred equity the residual carries until it later settles into its origin.
    const residualOriginBasis = new Map<Position, bigint>();
    if (residualQuantity !== 0n && totalCostBasis > 0n) {
        const principalOrigin = new Map<Position, bigint>();
        for (const recapture of recaptures) {
            if (recapture.to.source.position !== targetPosition || recapture.to.quantity <= 0n) continue;
            for (const [position, quantity] of collectOriginLeaves(engine.compute([recapture.to])))
                principalOrigin.set(position, (principalOrigin.get(position) ?? 0n) + quantity);
        }
        const magnitude = residualQuantity < 0n ? -residualQuantity : residualQuantity;
        for (const [position, quantity] of principalOrigin)
            residualOriginBasis.set(position, quantity * magnitude / totalCostBasis);
    }

    return {
        recaptures,
        totalCostBasis,
        surfacePosition,
        residualQuantity,
        newExchangeToQuantity,
        newExchangeFromQuantity,
        residualOriginBasis,
        residualNodes,
        residualDerivedProceeds,
    };
}
