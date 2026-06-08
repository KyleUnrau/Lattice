import type { ResidualAccount } from "../accounts.js";
import type { BookValueEngine } from "../book-value/engine.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { Exchange, ResidualUTXI, ResidualUTXO } from "../transactions/cross-position.js";
import type { Input, UTXOConsumption } from "../transactions/inputs.js";
import type { Output, UTXIConsumption } from "../transactions/outputs.js";
import { computeRecaptureResolution } from "./recapture.js";
import { consumedUTXOsFromInputs } from "./utils.js";

/** The paired outputs of {@link Exchange.recapture} — the two sides of a locked-rate reversal. */
export interface ExchangeRecapture {
    /** {@link UTXIConsumption} settling the to-side of the original exchange. Goes in a transaction's outputs. */
    from: UTXIConsumption;
    /** {@link UTXOConsumption} reclaiming the from-side of the original exchange. Goes in a transaction's inputs. */
    to: UTXOConsumption;
}

/**
 * The resolved result of an {@link exchange} call.
 *
 * - `recaptures` — one recapture per distinct exchange found in the lineage. Also used for tax reporting.
 * - `exchange` — forward exchange at the actual proceeds rate, covering only origin-portion inputs.
 *   Non-null only when inputs with no prior exchange lineage exist; null when all inputs were fully
 *   recaptured from prior exchanges.
 * - `residual` — {@link ResidualUTXI} for a gain, {@link ResidualUTXO} for a loss, or `null` when
 *   actual proceeds exactly equal cost basis.
 *
 * Use {@link ExchangeResolution.getFromOutputs} and {@link ExchangeResolution.getToInputs} to build
 * the transaction entry arrays rather than constructing them manually.
 */
export class ExchangeResolution {
    constructor(
        public readonly recaptures: ExchangeRecapture[],
        public readonly exchange: Exchange | null,
        public readonly residual: ResidualUTXI | ResidualUTXO | null
    ) { }

    /** Outputs for the consuming transaction: recapture settlements and forward exchange from-side. */
    getFromOutputs(): Output[] {
        return [
            ...this.recaptures.map(r => r.from),
            ...(this.exchange ? [this.exchange.from] : []),
        ];
    }

    /** Inputs for the receiving transaction: recapture reclaims, forward exchange to-side, and any gain residual. */
    getToInputs(): Input[] {
        return [
            ...this.recaptures.map(r => r.to),
            ...(this.exchange ? [this.exchange.to] : []),
            ...(this.residual instanceof ResidualUTXI ? [this.residual] : []),
        ];
    }

    /**
     * Outputs for the receiving transaction: a loss residual when actual proceeds fall short of
     * cost basis. Empty when there is a gain or no residual. Include alongside
     * `account.generateOutputs(...)` in the receiving transaction — the residual is in
     * `targetPosition` and belongs on that side of the exchange.
     */
    getToOutputs(): Output[] {
        return this.residual instanceof ResidualUTXO ? [this.residual] : [];
    }
}

/**
 * Records an exchange of inputs into `targetPosition`.
 *
 * Traces the basis of all consumed inputs and separates them into two groups:
 *
 * **Recaptured portion** — inputs with prior exchange lineage in `targetPosition`. Each prior
 * exchange is settled via a {@link ExchangeRecapture}: include `recapture.from` in the consuming
 * transaction's outputs and `recapture.to` in the receiving transaction's inputs. The prorated
 * actual proceeds versus cost basis yields a gain or loss, surfaced as a `residual`
 * ({@link ResidualUTXI} or {@link ResidualUTXO}).
 *
 * **Origin portion** — inputs with no prior exchange lineage. A forward `exchange` is created at
 * the actual market rate for this portion only, creating new suspended cost basis that can be
 * recaptured and produce a residual in a subsequent transaction.
 *
 * When all consumed inputs are fully recaptured, `exchange` is `null` — no new suspended cost
 * basis is created. The `recaptures` array (plus `residual` if applicable) alone drives the
 * transaction entries.
 *
 * @param inputs - Inputs in the source position being exchanged away.
 * @param targetPosition - The position being received (e.g. CAD).
 * @param actualProceeds - Total received in `targetPosition` at the market rate (raw bigint quantity).
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
): ExchangeResolution {
    const consumedUTXOs = consumedUTXOsFromInputs(inputs);
    const resolution = computeRecaptureResolution(
        consumedUTXOs, targetPosition, actualProceeds, engine, transactions
    );

    // Forward exchange only when there are origin amounts (no prior exchange lineage).
    // It covers exactly the origin portion at the actual market rate, creating new
    // suspended cost basis for future recapture.
    const forwardExchange: Exchange | null = resolution.newExchangeToQuantity > 0n
        ? new Exchange(
            { quantity: resolution.newExchangeToQuantity, position: consumedUTXOs[0]!.source.position },
            { quantity: resolution.newExchangeFromQuantity, position: targetPosition }
        )
        : null;

    // Residual represents the gain or loss on the recaptured portion only.
    // Registered directly in residualAccount so it is isolated from other ResidualAccounts.
    // Tagged to the forward exchange for basis tracing when one exists; null in the
    // pure-recapture case (engine treats it as an origin path).
    const residual: ResidualUTXI | ResidualUTXO | null = resolution.residualQuantity !== 0n
        ? resolution.residualQuantity > 0n
            ? residualAccount.addResidualInput(resolution.residualQuantity, targetPosition, forwardExchange)
            : residualAccount.addResidualOutput(-resolution.residualQuantity, targetPosition, forwardExchange)
        : null;

    return new ExchangeResolution(resolution.recaptures, forwardExchange, residual);
}
