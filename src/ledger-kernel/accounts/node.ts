import type { AccountFolder } from "./folder.js";
import type { NodeSummary } from "./summary.js";
import type { Orientation } from "../ledger.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions/transaction.js";


/**
 * Every node in the account tree (leaf account, folder, or computed account) satisfies
 * this interface. Balances vary along two axes:
 *
 * - **sign**: `getSignedBalanceScaled` uses the ledger-wide lot convention (UTXO positive,
 *   UTXI negative) that makes the zero-sum invariant hold, before orientation. `getBalanceScaled`
 *   (and the human-scaled `getBalance`) additionally apply the node's effective
 *   {@link Orientation} so the account presents its natural sign.
 * - **unit**: `getSignedBalanceScaled` / `getBalanceScaled` return `bigint` smallest units for
 *   precision; `getBalance` / `getBalances` return human-readable `number` (scaled by
 *   `position.decimals`).
 */

export type AccountName = string | {positive: string, negative: string, zero?: string};

export function getDisplayName(name: AccountName, balance: number): string {
    if (typeof name === "string") return name;

    if (balance < 0) return name.negative;
    if (balance && name.zero) return name.zero;

    return name.positive;
}

export interface AccountNode {
    name: string | {positive: string, negative: string};
    parent: AccountFolder | null;
    getEffectiveOrientation(): Orientation;
    getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint;
    getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint>;
    getBalanceScaled(position: Position, transactions: Transaction[]): bigint;
    getBalancesScaled(transactions: Transaction[]): Map<Position, bigint>;
    getBalance(position: Position, transactions: Transaction[]): number;
    getBalances(transactions: Transaction[]): Map<Position, number>;
    summarize(position: Position, transactions: Transaction[]): NodeSummary;
}
