import type { Position } from "./positions.js";
import type { Result } from "../utils.js";
import { Transaction } from "./transactions.js";
import type { AccountFolder } from "./accounts.js";
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

    /** Constructs, validates, and appends a new {@link Transaction} to the history. */
    public newTransaction(stagedInputs: Input[], stagedOutputs: Output[]): Transaction {
        const transaction = new Transaction(stagedInputs, stagedOutputs, this.transactions);
        this.transactions.push(transaction);
        return transaction;
    }

    /**
     * Checks that every position's combined root balance across `netAssets` and `equity`
     * sums to zero (within floating-point epsilon). Open exchange positions are automatically
     * accounted for via {@link ExchangePositionsAccount} in the equity tree — no external
     * adjustment is needed.
     */
    public verify(): Result<undefined, Error> {
        const rootBalances: Map<Position, number> = this.getRootBalances();

        for (const [position, rootBalance] of rootBalances) {
            if (Math.abs(rootBalance) > Number.EPSILON) return {ok: false, error: new Error(`Ledger invalid, root balance for ${position.name} calculated as ${rootBalance} instead of 0`)};
        }

        return {ok: true, value: undefined};
    }

    public getRootBalances(): Map<Position, number> {
        const rootBalances: Map<Position, number> = new Map();

        for (const [position, rootBalance] of this.netAssets.getRootBalances(this.transactions))
            rootBalances.set(position, rootBalance + (rootBalances.get(position) ?? 0));
        for (const [position, rootBalance] of this.equity.getRootBalances(this.transactions))
            rootBalances.set(position, rootBalance + (rootBalances.get(position) ?? 0));

        return rootBalances;
    }
}
