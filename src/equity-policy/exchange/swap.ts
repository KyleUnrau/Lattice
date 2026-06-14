import type { BookValueEngine } from "../book-value/engine.js";
import type { Position } from "../../ledger-kernel/positions.js";
import { unscale } from "../../ledger-kernel/positions.js";
import { Transaction } from "../../ledger-kernel/transactions.js";
import type { Input } from "../../ledger-kernel/transactions/inputs.js";
import { UTXO, type Output } from "../../ledger-kernel/transactions/outputs.js";
import { ExchangeResolution } from "./resolution.js";
import type { ResidualTarget } from "./types.js";
import type { ExchangePositionsAccount } from "../../ledger-kernel/accounts/computed.js";

/** Inputs to {@link swap} — a single high-level "exchange one position into another" event. */
export interface SwapRequest {
    /**
     * The exchanged-portion inputs, drawn by the caller from whichever source account(s) they
     * like. These are referenced verbatim — `swap` does not draw or compute them. Their summed
     * surface value is what gets resolved into the target position.
     */
    fromInputs: Input[];
    /**
     * The proceeds outputs, deposited by the caller into whichever destination account(s) they
     * like. Their shared {@link Position} defines the target position and their summed quantity
     * defines the actual proceeds the exchange resolves against.
     */
    toOutputs: Output[];
    engine: BookValueEngine;
    /** Transaction history used to trace basis, issue recaptures, and verify the built transactions. */
    transactions: Transaction[];
    /** Where recognized gains/losses are booked. A plain account receives both; `{ gain, loss }` splits them. */
    residualAccount: ResidualTarget;
    /** Scopes the forward exchange to this account's open-position view. Required; supply the account even when the exchange fully closes a loop and no forward leg opens (the account will simply carry a zero balance). */
    exchangeAccount: ExchangePositionsAccount;
}

/** The resolved accounting effects of a {@link swap}. */
export interface SwapResult {
    /** The resolution describing recaptures, forward exchange, and residuals. */
    resolution: ExchangeResolution;
    /**
     * Outputs for the consuming/surface transaction. The caller pairs these with the `fromInputs`
     * it supplied to build (and commit) that transaction however it sees fit.
     */
    fromOutputs: Output[];
    /** The receiving/target transaction, already constructed (not committed to any ledger). */
    to: Transaction;
    /** The per-position hop transactions threading a multi-hop loop unwind, in order. */
    intermediates: Transaction[];
}

/**
 * The high-level helper for an "exchange one position into another" event. The caller draws the
 * exchanged `fromInputs` and stages the `toOutputs` proceeds themselves — across as many accounts
 * as they like — and `swap` resolves the exchange (via {@link ExchangeResolution}) and builds the
 * downstream transactions, *without* touching a ledger. It returns:
 *
 *   - `fromOutputs` — the consuming/surface outputs; the caller assembles the consuming transaction
 *     from these plus its own `fromInputs`,
 *   - `intermediates` — the per-position hop transactions threading a multi-hop loop unwind, and
 *   - `to` — the receiving/target transaction.
 *
 * Commit them in dependency order: consuming → intermediate hops → receiving.
 *
 * The engine traces the consumed value's provenance and derives every accounting effect —
 * recapturing whatever loops back to the target position, opening a forward exchange for the
 * portion that does not, recognizing gain/loss, and settling any residual-derived value. The
 * target position and actual proceeds are read directly off `toOutputs` (their shared position and
 * summed quantity). If a forward exchange must open, `exchangeAccount` is used (see
 * {@link ExchangeResolution}).
 *
 * For anything more nuanced still — mixing the exchange with unrelated deposits / withdrawals /
 * fees in the same transaction — drop down to {@link ExchangeResolution} directly: it yields the
 * exact recapture / forward / residual lines and you assemble every transaction yourself (keeping
 * independent sub-flows in their own transactions, per the basis-engine's uniform-blend rule).
 */
export function swap(request: SwapRequest): SwapResult {
    const { fromInputs, toOutputs, engine, transactions, residualAccount, exchangeAccount } = request;

    const targetPosition = outputPosition(toOutputs[0]!);
    const actualProceeds = unscale(toOutputs.reduce((sum, o) => sum + o.quantity, 0n), targetPosition);

    const resolution = new ExchangeResolution(fromInputs, targetPosition, actualProceeds, engine, transactions, residualAccount, exchangeAccount);

    const intermediates = resolution.getIntermediateTransactions()
        .map(hop => new Transaction(hop.inputs, hop.outputs, transactions));

    const to = new Transaction(
        resolution.getToInputs(),
        [...toOutputs, ...resolution.getToOutputs()],
        transactions
    );

    return { resolution, fromOutputs: resolution.getFromOutputs(), to, intermediates };
}

/** The {@link Position} an output lands in — its own for a {@link UTXO}, its source's for a consumption. */
function outputPosition(output: Output): Position {
    return output instanceof UTXO ? output.position : output.source.position;
}
