import type { ResidualAccount } from "../accounts.js";
import type { BookValueEngine } from "../book-value/engine.js";
import type { BasisPath } from "../book-value/types.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { Exchange } from "../transactions/cross-position.js";
import type { Input, UTXOConsumption } from "../transactions/inputs.js";
import type { Output, UTXO } from "../transactions/outputs.js";
import { collectOriginLeaves, collectRecaptureableNodes, groupRecapturesByExchange } from "./recapture.js";

/** A from-side of a recaptured exchange (the recaptured principal), traceable to its origin. */
export interface PrincipalLeg {
    /** The exchange's from-side UTXO (in the surface position), e.g. an `ExchangedUTXO` of CAD. */
    from: UTXO;
    /** The recaptured from-side quantity, in the surface position. */
    fromQuantity: bigint;
}

/** The origin amounts reclaimed by recapturing a principal's origin exchanges, per origin position. */
export interface ReclaimedOrigin {
    position: Position;
    /** The `recapture.to` reclaims (in `position`); place in a transaction's inputs. */
    tos: UTXOConsumption[];
    /** Total reclaimed, summed across `tos`. */
    total: bigint;
}

/**
 * Recaptures the origin exchanges of a recaptured principal for `magnitude` of surface value,
 * walking the principal's basis to its origin positions. Returns:
 *
 * - `surfaceOutputs` — the origin exchanges' to-side settlements (`recapture.from`, in the surface
 *   position), summing exactly to `magnitude` (remainder on the last target) so the consuming
 *   surface transaction stays balanced.
 * - `reclaimed` — the reclaimed origin amounts (`recapture.to`) grouped by origin position, for the
 *   caller to recognize (as a loss, an expense, a new basis, etc.).
 *
 * This is the shared core of residual settlement: a residual's surface value is unwound back through
 * the locked rates that created it into the origin-position basis it carries.
 *
 * @param magnitude - Surface-position amount to unwind (positive).
 * @param principal - From-sides of the recaptured principal whose origin lineage backs the value.
 * @param totalCostBasis - The principal's total surface-position value (the proration base).
 */
export function recaptureToOrigin(
    magnitude: bigint,
    principal: PrincipalLeg[],
    totalCostBasis: bigint,
    engine: BookValueEngine,
    transactions: Transaction[]
): { surfaceOutputs: Output[]; reclaimed: ReclaimedOrigin[]; } {
    if (magnitude <= 0n || totalCostBasis <= 0n) return { surfaceOutputs: [], reclaimed: [] };

    const principalBasis: BasisPath[] = principal.flatMap(
        ({ from, fromQuantity }) => fromQuantity > 0n ? engine.compute(from, fromQuantity) : []
    );

    const targets: { exchange: Exchange; position: Position; toSideQuantity: bigint; }[] = [];
    for (const position of collectOriginLeaves(principalBasis).keys()) {
        for (const [exchange, { toSideQuantity }] of groupRecapturesByExchange(collectRecaptureableNodes(principalBasis, position)))
            targets.push({ exchange, position, toSideQuantity });
    }

    const surfaceOutputs: Output[] = [];
    const byPosition = new Map<Position, ReclaimedOrigin>();
    let allocated = 0n;
    for (let i = 0; i < targets.length; i++) {
        const { exchange, position, toSideQuantity } = targets[i]!;
        const recapQty = i === targets.length - 1 ? magnitude - allocated : toSideQuantity * magnitude / totalCostBasis;
        allocated += recapQty;
        if (recapQty <= 0n) continue;

        const recapture = exchange.recapture(recapQty, transactions);
        surfaceOutputs.push(recapture.from);
        const bucket = byPosition.get(position) ?? { position, tos: [], total: 0n };
        bucket.tos.push(recapture.to);
        bucket.total += recapture.to.quantity;
        byPosition.set(position, bucket);
    }

    return { surfaceOutputs, reclaimed: [...byPosition.values()] };
}

/**
 * Settles a residual **loss** of `magnitude` (surface position) immediately into its origin
 * positions, expense-style: the origin exchanges are recaptured and the reclaimed origin amounts
 * are recognized as `ResidualUTXO` losses in `residualAccount`.
 *
 * - `surfaceOutputs` belong in the surface transaction consuming the loss (they replace the
 *   surface-position loss residual).
 * - `recognitions` are standalone single-position transactions writing the loss into the origin
 *   position(s); the caller commits them.
 */
export function settleLossIntoOrigin(
    magnitude: bigint,
    principal: PrincipalLeg[],
    totalCostBasis: bigint,
    residualAccount: ResidualAccount,
    engine: BookValueEngine,
    transactions: Transaction[]
): { surfaceOutputs: Output[]; recognitions: { inputs: Input[]; outputs: Output[]; }[]; } {
    const { surfaceOutputs, reclaimed } = recaptureToOrigin(magnitude, principal, totalCostBasis, engine, transactions);

    const recognitions = reclaimed.map(({ position, tos, total }) => {
        const loss = residualAccount.addResidualOutput(total, position, new Map<Position, bigint>([[position, total]]));
        return { inputs: tos as Input[], outputs: [loss] as Output[] };
    });

    return { surfaceOutputs, recognitions };
}
