import type { Position } from "./positions.js";
import type { Result } from "../utils.js";
import { Transaction } from "./transactions.js";
import type { AccountFolder } from "./accounts/folder.js";
import type { FolderSummary } from "./accounts/summary.js";
import type { Input } from "./transactions/inputs.js";
import type { Output } from "./transactions/outputs.js";

export enum Orientation {
    Positive = 1,
    Negative = -1
}

/**
 * The top-level container for a double-entry ledger. Holds the ordered {@link Transaction}
 * history and the two root {@link AccountFolder}s (`netAssets` and `equity`). All balance
 * queries and the structural invariant check run through this class.
 */
export class Ledger {
    public transactions: Transaction[] = [];

    constructor(
        public netAssets: AccountFolder,
        public equity: AccountFolder
    ) {}

    /**
     * Append one or more existing Transactions to the ledger history.
     * @param transaction - One or more Transaction instances to add
     */
    public addTransaction(...transaction: Transaction[]): void {
        this.transactions.push(...transaction);
    }

    /** Constructs, validates, and appends a new {@link Transaction} to the history. */
    public newTransaction(stagedInputs: Input[], stagedOutputs: Output[]): Transaction {
        const transaction = new Transaction(stagedInputs, stagedOutputs, this.transactions);
        this.addTransaction(transaction);
        return transaction;
    }

    /**
     * Checks that every position's combined root balance across `netAssets` and `equity`
     * sums to zero (within floating-point epsilon). Open exchange positions are automatically
     * accounted for via {@link ExchangePositionsAccount} in the equity tree — no external
     * adjustment is needed.
     */
    public verify(): Result<undefined, Error> {
        const rootBalances = this.getRootBalances();

        for (const [position, rootBalance] of rootBalances) {
            if (rootBalance !== 0n) return {ok: false, error: new Error(`Ledger invalid, root balance for ${position.name} calculated as ${rootBalance} instead of 0`)};
        }

        return {ok: true, value: undefined};
    }

    public getRootBalances(): Map<Position, bigint> {
        const rootBalances = new Map<Position, bigint>();

        for (const [position, rootBalance] of this.netAssets.getRootRawBalances(this.transactions))
            rootBalances.set(position, rootBalance + (rootBalances.get(position) ?? 0n));
        for (const [position, rootBalance] of this.equity.getRootRawBalances(this.transactions))
            rootBalances.set(position, rootBalance + (rootBalances.get(position) ?? 0n));

        return rootBalances;
    }

    public summarize(position: Position): LedgerSummary {
        return {
            position,
            netAssets: this.netAssets.summarize(position, this.transactions),
            equity: this.equity.summarize(position, this.transactions),
        };
    }
}

export interface LedgerSummary {
    position: Position;
    netAssets: FolderSummary;
    equity: FolderSummary;
}
