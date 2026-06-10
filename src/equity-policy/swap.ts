import type { Account, ResidualAccount } from "../ledger-kernel/accounts.js";
import type { BookValueEngine } from "./book-value/engine.js";
import type { Ledger } from "../ledger-kernel/ledger.js";
import type { Position } from "../ledger-kernel/positions.js";
import type { Transaction } from "../ledger-kernel/transactions.js";
import { ExchangeResolution } from "./exchange.js";

/** Inputs to {@link swap} — a single high-level "exchange one position into another" event. */
export interface SwapRequest {
    /** Account the given-away value is drawn from. */
    source: Account;
    /** Position being given away. */
    from: Position;
    /** Human-scale quantity of `from` to give away. */
    quantity: number;
    /** Account the received value lands in. */
    destination: Account;
    /** Position being received. */
    to: Position;
    /** Human-scale proceeds received in `to`. */
    proceeds: number;
    engine: BookValueEngine;
    ledger: Ledger;
    /** Account that recognized gains/losses are booked into. */
    residualAccount: ResidualAccount;
}

/** The committed accounting effects of a {@link swap}. */
export interface SwapResult {
    /** The resolution describing recaptures, forward exchange, and residuals. */
    resolution: ExchangeResolution;
    /** The consuming (surface-position) transaction. */
    consuming: Transaction;
    /** The per-position hop transactions threading a multi-hop loop unwind, in order. */
    intermediates: Transaction[];
    /** The receiving (target-position) transaction. */
    receiving: Transaction;
}

/**
 * Executes a complete exchange as a single business event: "exchange `quantity` of `from` into
 * `to` for `proceeds`". The engine traces the consumed value's provenance and derives every
 * accounting effect — recapturing whatever loops back to `to`, opening a forward exchange for the
 * portion that does not, recognizing gain/loss, and settling any residual-derived value — then
 * commits the full transaction chain to the ledger in dependency order:
 *
 *   consuming (surface) → intermediate hops → receiving (target)
 *
 * After it returns, every exchange edge touched by a closed loop is fully settled; no stale
 * exchange positions remain.
 */
export function swap(request: SwapRequest): SwapResult {
    const { source, from, quantity, destination, to, proceeds, engine, ledger, residualAccount } = request;

    const inputs = source.generateInputs(from, quantity, ledger.transactions);
    const resolution = new ExchangeResolution(inputs, to, proceeds, engine, ledger.transactions, residualAccount);

    const consuming = ledger.newTransaction(inputs, resolution.getFromOutputs());

    const intermediates = resolution.getIntermediateTransactions()
        .map(hop => ledger.newTransaction(hop.inputs, hop.outputs));

    const receiving = ledger.newTransaction(
        resolution.getToInputs(),
        [...destination.generateOutputs(to, proceeds, ledger.transactions), ...resolution.getToOutputs()]
    );

    return { resolution, consuming, intermediates, receiving };
}
