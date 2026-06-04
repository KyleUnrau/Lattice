import { TXO } from "../transactions/outputs.js";
import { TXI } from "../transactions/inputs.js";
import type { Transaction } from "../transactions.js";

/**
 * Selects which lots to consume and in what amounts when `delta` units are requested.
 * Returns a `Map` from lot to quantity consumed; the sum of values must equal `delta`.
 * `transactions` is required because lot availability is computed dynamically from history,
 * not stored on the lot itself.
 */
export type DisposalMethod<T extends TXO | TXI> = (components: T[], delta: number, transactions: Transaction[]) => Map<T, number>;