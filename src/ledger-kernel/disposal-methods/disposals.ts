import { UTXO } from "../transactions/outputs.js";
import { UTXI } from "../transactions/inputs.js";
import type { TransactionLike } from "../transactions/transaction.js";

/**
 * Selects which lots to consume and in what amounts when `delta` units are requested.
 * Returns a `Map` from lot to quantity consumed; the sum of values must equal `delta`.
 * `transactions` is required because lot availability is computed dynamically from history,
 * not stored on the lot itself.
 */
export type DisposalMethod<T extends UTXO | UTXI> = (components: T[], delta: bigint, transactions: readonly TransactionLike[]) => Map<T, bigint>;
