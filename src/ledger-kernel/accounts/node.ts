import type { AccountFolder } from "./folder.js";
import type { NodeSummary } from "./summary.js";
import type { Orientation } from "../ledger.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";


/**
 * Every node in the account tree (leaf account, folder, or computed account) satisfies
 * this interface. Raw balance methods return `bigint` for precision; `getBalance` /
 * `getBalances` return human-readable `number` (orientation-corrected, scaled by
 * `position.decimals`).
 */

export interface AccountNode {
    name: string;
    parent: AccountFolder | null;
    getRootOrientation(): Orientation;
    getRootRawBalance(position: Position, transactions: Transaction[]): bigint;
    getRootRawBalances(transactions: Transaction[]): Map<Position, bigint>;
    getRawBalance(position: Position, transactions: Transaction[]): bigint;
    getRawBalances(transactions: Transaction[]): Map<Position, bigint>;
    getBalance(position: Position, transactions: Transaction[]): number;
    getBalances(transactions: Transaction[]): Map<Position, number>;
    summarize(position: Position, transactions: Transaction[]): NodeSummary;
}
