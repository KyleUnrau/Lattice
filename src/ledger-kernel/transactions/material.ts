import type { Transaction } from "./transaction.js";

/**
 * Anything that can produce an ordered, flat list of {@link Transaction}s for committing to the
 * ledger. Both atomic {@link Transaction}s and structured bundles ({@link TransactionGroup},
 * {@link ExchangeTransactions}, {@link TerminalTransactions}) implement this interface so that
 * {@link EventBuilder.record} and the ledger machinery can treat them uniformly — without any
 * lossy conversion step like `.toGroup()`.
 */
export interface TransactionMaterial {
    flatten(): readonly Transaction[];
}

/**
 * An object that can construct {@link TransactionMaterial} but is not itself already flattened.
 * Resolution objects ({@link ExchangeResolution}, {@link TerminalResolution}) satisfy this through
 * their existing `constructTransactions()` methods, enabling call sites like:
 *
 *   event.record(exchangeResolution);
 *   event.record(terminalResolution);
 *
 * Because `constructTransactions()` may accept optional parameters, implementations are free to
 * add them; the interface covers only the no-argument invocation.
 */
export interface TransactionMaterialFactory<T extends TransactionMaterial = TransactionMaterial> {
    constructTransactions(): T;
}

/**
 * Type guard distinguishing {@link TransactionMaterial} from {@link TransactionMaterialFactory}.
 * Used by {@link EventBuilder.record} to accept either without requiring a manual call to
 * `constructTransactions()`.
 */
export function isTransactionMaterial(
    v: TransactionMaterial | TransactionMaterialFactory
): v is TransactionMaterial {
    return typeof (v as TransactionMaterialFactory).constructTransactions !== "function";
}
