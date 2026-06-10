import type { ResidualAccount } from "../accounts.js";
import type { BookValueEngine } from "../book-value/engine.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { Exchange, ResidualUTXI, ResidualUTXO } from "../transactions/cross-position.js";
import type { Input, UTXOConsumption } from "../transactions/inputs.js";
import type { Output, UTXIConsumption } from "../transactions/outputs.js";
import { computeRecaptureResolution } from "./recapture.js";
import { settleLossIntoOrigin } from "./settlement.js";
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
 * - `residuals` — the open gain residual ({@link ResidualUTXI}) recognized in `targetPosition`,
 *   carrying its origin-position basis. A **loss** is not left here: it is settled immediately into
 *   its origin positions (see `getToOutputs` / `getResidualSettlements`).
 *
 * Use {@link ExchangeResolution.getFromOutputs} and {@link ExchangeResolution.getToInputs} to build
 * the transaction entry arrays rather than constructing them manually.
 */
export class ExchangeResolution {
    constructor(
        public readonly recaptures: ExchangeRecapture[],
        public readonly exchange: Exchange | null,
        public readonly residuals: (ResidualUTXI | ResidualUTXO)[],
        /** Origin-exchange settlements (surface position) for an immediately-settled loss residual. */
        public readonly residualSurfaceOutputs: Output[] = [],
        /** Standalone origin-position transactions recognizing a settled loss; commit via the caller. */
        public readonly residualSettlements: { inputs: Input[]; outputs: Output[]; }[] = [],
        /** Settlements closing the residual legs of residual-derived value being consumed (surface position). */
        public readonly residualCloseOutputs: Output[] = [],
        /** Destination-position gains minted when settling consumed residual-derived value. */
        public readonly residualMintInputs: Input[] = []
    ) { }

    /** Outputs for the consuming transaction: recapture settlements, forward from-side, and closed residual legs. */
    getFromOutputs(): Output[] {
        return [
            ...this.recaptures.map(r => r.from),
            ...(this.exchange ? [this.exchange.from] : []),
            ...this.residualCloseOutputs,
        ];
    }

    /** Inputs for the receiving transaction: recapture reclaims, forward to-side, gain residuals, and settled-residual mints. */
    getToInputs(): Input[] {
        return [
            ...this.recaptures.map(r => r.to),
            ...(this.exchange ? [this.exchange.to] : []),
            ...this.residuals.filter((r): r is ResidualUTXI => r instanceof ResidualUTXI),
            ...this.residualMintInputs,
        ];
    }

    /**
     * Outputs for the receiving transaction: when actual proceeds fall short of cost basis the loss
     * is settled into its origin position(s), and these settle the origin exchanges' to-sides in
     * `targetPosition`. Include alongside `account.generateOutputs(...)` in the receiving transaction.
     */
    getToOutputs(): Output[] {
        return this.residualSurfaceOutputs;
    }

    /**
     * Standalone single-position transactions that recognize a settled loss in its origin
     * position(s). Commit each via `ledger.newTransaction(inputs, outputs)` after the receiving
     * transaction. Empty unless a loss residual was settled.
     */
    getResidualSettlements(): { inputs: Input[]; outputs: Output[]; }[] {
        return this.residualSettlements;
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

    // A gain is recognized in the surface (target) position as an open residual carrying the
    // origin-position basis it traces back to (e.g. 50 CAD gain carrying {BTC: 0.0005}); it stays
    // deferred until the surface value is later consumed and settled. A loss is NOT left in the
    // surface position — it is settled immediately into its origin positions, expense-style.
    const residuals: (ResidualUTXI | ResidualUTXO)[] = [];
    let residualSurfaceOutputs: Output[] = [];
    let residualSettlements: { inputs: Input[]; outputs: Output[]; }[] = [];

    if (resolution.residualQuantity > 0n) {
        residuals.push(residualAccount.addResidualInput(resolution.residualQuantity, targetPosition, resolution.residualOriginBasis));
    } else if (resolution.residualQuantity < 0n) {
        const principal = resolution.recaptures.map(r => ({ from: r.to.source, fromQuantity: r.to.quantity }));
        const settled = settleLossIntoOrigin(
            -resolution.residualQuantity, principal, resolution.totalCostBasis, residualAccount, engine, transactions
        );
        residualSurfaceOutputs = settled.surfaceOutputs;
        residualSettlements = settled.recognitions;
    }

    // Settle any residual-derived value among the consumed inputs: close each open residual leg
    // (surface position) and recognize its destination-position proceeds as a new gain, rather than
    // forward-exchanging it as origin value. This re-denominates the deferred equity into the
    // destination position when the residual value closes the loop.
    const residualCloseOutputs: Output[] = [];
    const residualMintInputs: Input[] = [];
    if (resolution.residualNodes.length > 0) {
        const totalResidual = resolution.residualNodes.reduce((sum, n) => sum + n.quantity, 0n);
        let allocated = 0n;
        for (let i = 0; i < resolution.residualNodes.length; i++) {
            const node = resolution.residualNodes[i]!;
            residualCloseOutputs.push(node.residual.consume(node.quantity, transactions));

            const share = i === resolution.residualNodes.length - 1
                ? resolution.residualDerivedProceeds - allocated
                : resolution.residualDerivedProceeds * node.quantity / totalResidual;
            allocated += share;
            if (share > 0n)
                residualMintInputs.push(residualAccount.addResidualInput(share, targetPosition, new Map([[targetPosition, share]])));
        }
    }

    return new ExchangeResolution(
        resolution.recaptures, forwardExchange, residuals,
        residualSurfaceOutputs, residualSettlements, residualCloseOutputs, residualMintInputs
    );
}
