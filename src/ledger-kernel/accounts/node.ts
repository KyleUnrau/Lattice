import type { AccountFolder } from "./folder.js";
import type { NodeSummary } from "./summary.js";
import type { Orientation } from "../ledger.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";


/**
 * Every node in the account tree (leaf account, folder, or computed account) satisfies
 * this interface. Balances vary along two axes:
 *
 * - **sign**: `getSignedBalanceScaled` uses the ledger-wide lot convention (UTXO positive,
 *   UTXI negative) that makes the zero-sum invariant hold, before orientation. `getBalanceRaw`
 *   (and the human-scaled `getBalance`) additionally apply the node's effective
 *   {@link Orientation} so the account presents its natural sign.
 * - **unit**: `getSignedBalanceScaled` / `getBalanceRaw` return `bigint` smallest units for
 *   precision; `getBalance` / `getBalances` return human-readable `number` (scaled by
 *   `position.decimals`).
 */

export interface AccountNode {
    name: string;
    parent: AccountFolder | null;
    getEffectiveOrientation(): Orientation;
    getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint;
    getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint>;
    getBalanceRaw(position: Position, transactions: Transaction[]): bigint;
    getBalancesRaw(transactions: Transaction[]): Map<Position, bigint>;
    getBalance(position: Position, transactions: Transaction[]): number;
    getBalances(transactions: Transaction[]): Map<Position, number>;
    summarize(position: Position, transactions: Transaction[]): NodeSummary;
}
