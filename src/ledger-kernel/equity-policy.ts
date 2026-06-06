import { Exchange, ResidualUTXI, ResidualUTXO } from "./transactions/exchange.js";
import type { ExchangeRecapture } from "./transactions/exchange.js";
import type { ResidualAccount } from "./accounts.js";
import { UTXOConsumption, type Input } from "./transactions/inputs.js";
import { UTXO } from "./transactions/outputs.js";
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
 * - `recaptures` — one recapture per distinct exchange found in the lineage. Include
 *   `recapture.from` (UTXIConsumption) in the consuming transaction's outputs and
 *   `recapture.to` (UTXOConsumption) in the receiving transaction's inputs to close those
 *   prior exchange positions. Also used for tax reporting.
 * - `totalCostBasis` — aggregate cost in the target position across all recaptures
 * - `residualQuantity` — gain (positive) or loss (negative): prorated actual proceeds for the
 *   recaptured portion minus `totalCostBasis`
 * - `newExchangeToQuantity` — consumed quantity with no prior exchange lineage in `targetPosition`
 * - `newExchangeFromQuantity` — prorated proceeds for the origin portion (`newExchangeToQuantity`)
 * - `exchange` — forward exchange at the **actual proceeds rate** covering only the origin portion
 *   (`newExchangeToQuantity` → `newExchangeFromQuantity`). Non-null only when origin amounts exist.
 *   Use `exchange.from` in the consuming transaction's outputs and `exchange.to` in the receiving
 *   transaction's inputs. Creates new suspended cost basis that can be recaptured in a subsequent
 *   transaction. Null when all consumed inputs were fully recaptured from prior exchanges.
 * - `residual` — {@link ResidualUTXI} for a gain, {@link ResidualUTXO} for a loss, or `null` when
 *   actual proceeds exactly equal cost basis. Include in the receiving transaction's inputs (gain)
 *   or outputs (loss). Tagged to the forward `exchange` (when non-null) so the basis engine can
 *   trace lineage; tagged to `null` in the pure-recapture case, where the engine treats it as an
 *   origin path.
 */
export type RecaptureResolution = {
    recaptures: ExchangeRecapture[];
    totalCostBasis: number;
    residualQuantity: number;
    newExchangeToQuantity: number;
    newExchangeFromQuantity: number;
    exchange: Exchange | null;
    residual: ResidualUTXI | ResidualUTXO | null;
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
 * Resolves consumed UTXOs against a target position given a known total proceeds amount.
 *
 * For each exchange found in the basis lineage, a recapture transaction is issued at the
 * exchange's original locked rate. Proceeds are prorated across recaptured and non-recaptured
 * portions by their share of total consumed quantity. Any consumed quantity with no exchange
 * lineage in the target position is returned as `newExchangeToQuantity`, paired with its
 * target-position equivalent in `newExchangeFromQuantity`. `exchange` is always `null` here —
 * it is populated by {@link exchange} after this function returns.
 *
 * @param consumedUTXOs - UTXOs being consumed, with the partial quantity consumed from each.
 * @param targetPosition - The position to resolve cost basis into (e.g. BTC).
 * @param totalActualReceived - Total proceeds in `targetPosition` for the full consumed quantity.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 */
export function computeRecaptureResolution(
    consumedUTXOs: { source: UTXO; quantity: number }[],
    targetPosition: Position,
    totalActualReceived: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): Omit<RecaptureResolution, 'exchange' | 'residual'> {
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

/**
 * Extracts {@link UTXOConsumption} inputs from a mixed input array, returning each as a
 * `{ source, quantity }` pair suitable for {@link computeRecaptureResolution}.
 * Non-consumption inputs (exchange inputs, origin UTXIs) are silently ignored.
 */
export function consumedUTXOsFromInputs(inputs: Input[]): { source: UTXO; quantity: number }[] {
    return inputs.filter((i): i is UTXOConsumption => i instanceof UTXOConsumption)
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
 * Records an expense across all exchange lineages of the consumed inputs.
 *
 * Traces the top-level basis paths for every consumed UTXO. Exchange and residual
 * paths are recaptured at their locked rates and grouped by origin position, so each
 * portion of the expense is recognised in the position it was originally derived from.
 * Origin paths (no exchange lineage) are surfaced as direct expense amounts in their
 * own position. Each recapture group drives a separate expense transaction; origin
 * amounts are balanced inside the consuming transaction itself.
 *
 * @param inputs - Expense inputs to record, typically drawn from a single account.
 * @param engine - Book value engine used to trace basis paths.
 * @param transactions - Full transaction history, required to issue recaptures.
 */
export function expense(
    inputs: Input[],
    engine: BookValueEngine,
    transactions: Transaction[]
): ExpenseResolution {
    const consumedUTXOs = consumedUTXOsFromInputs(inputs);
    const allBasis = consumedUTXOs.flatMap(c => engine.compute(c.source, c.quantity));

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

    for (const [ex, { toSideQuantity, fromQuantity }] of grouped) {
        const pos = ex.from.position;
        const recapture = ex.recapture(toSideQuantity, transactions);
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

/**
 * Records an exchange of inputs into `targetPosition`.
 *
 * Traces the basis of all consumed inputs and separates them into two groups:
 *
 * **Recaptured portion** — inputs with prior exchange lineage in `targetPosition`. Each prior
 * exchange is settled via a {@link ExchangeRecapture}: include `recapture.from` in the consuming
 * transaction's outputs and `recapture.to` in the receiving transaction's inputs. The prorated
 * actual proceeds versus `totalCostBasis` yields a `residualQuantity` gain or loss, surfaced as
 * a `residual` ({@link ResidualUTXI} or {@link ResidualUTXO}).
 *
 * **Origin portion** — inputs with no prior exchange lineage (`newExchangeToQuantity > ε`). A
 * forward `exchange` is created at the actual market rate for this portion only, creating new
 * suspended cost basis that can be recaptured and produce a residual in a subsequent transaction.
 * Include `exchange.from` in the consuming transaction's outputs and `exchange.to` in the
 * receiving transaction's inputs.
 *
 * When all consumed inputs are fully recaptured, `exchange` is `null` — no new suspended cost
 * basis is created. The `recaptures` array (plus `residual` if applicable) alone drives the
 * transaction entries.
 *
 * @param inputs - Inputs in the source position being exchanged away.
 * @param targetPosition - The position being received (e.g. CAD).
 * @param actualProceeds - Total received in `targetPosition` at the market rate.
 * @param engine - Book value engine for basis tracing.
 * @param transactions - Full transaction history for recaptures.
 * @param residualAccount - The {@link ResidualAccount} to route any recognised gain or loss to.
 */
export function exchange(
    inputs: Input[],
    targetPosition: Position,
    actualProceeds: number,
    engine: BookValueEngine,
    transactions: Transaction[],
    residualAccount: ResidualAccount
): RecaptureResolution {
    const consumedUTXOs = consumedUTXOsFromInputs(inputs);
    const resolution = computeRecaptureResolution(
        consumedUTXOs, targetPosition, actualProceeds, engine, transactions
    );

    // Forward exchange only when there are origin amounts (no prior exchange lineage).
    // It covers exactly the origin portion at the actual market rate, creating new
    // suspended cost basis for future recapture.
    const forwardExchange: Exchange | null = resolution.newExchangeToQuantity > Number.EPSILON
        ? new Exchange(
            { quantity: resolution.newExchangeToQuantity, position: consumedUTXOs[0]!.source.position },
            { quantity: resolution.newExchangeFromQuantity, position: targetPosition }
          )
        : null;

    // Residual represents the gain or loss on the recaptured portion only.
    // Registered directly in residualAccount so it is isolated from other ResidualAccounts.
    // Tagged to the forward exchange for basis tracing when one exists; null in the
    // pure-recapture case (engine treats it as an origin path).
    const residual: ResidualUTXI | ResidualUTXO | null =
        Math.abs(resolution.residualQuantity) > Number.EPSILON
            ? resolution.residualQuantity > 0
                ? residualAccount.addResidualInput(resolution.residualQuantity, targetPosition, forwardExchange)
                : residualAccount.addResidualOutput(-resolution.residualQuantity, targetPosition, forwardExchange)
            : null;

    return { ...resolution, exchange: forwardExchange, residual };
}
