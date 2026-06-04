import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { TXIConsumption, type TXO } from "./outputs.js";

export type Input = TXI | TXOConsumption;

/**
 * A balancing input — value entering the system without consuming a prior output.
 * Used for opening balances, equity injections, and exchange receipts. Supports
 * partial settlement via {@link TXIConsumption} objects in later transaction outputs.
 */
export class TXI {
    public type = "txi";
    public quantity: number;

    constructor(
        quantity: number,
        public position: Position
    ) {
        if (quantity < 0) throw new Error("The quantity of a TXI cannot be less than 0");
        this.quantity = quantity;
    }

    /** Returns all {@link TXIConsumption}s referencing this TXI across the transaction history. */
    public getConsumptions(transactions: Transaction[]): TXIConsumption[] {
        const consumptions: TXIConsumption[] = [];

        for (const transaction of transactions) {
            for (const output of transaction.outputs) {
                if (output instanceof TXIConsumption && output.source === this) consumptions.push(output);
            }
        }

        return consumptions;
    }

    /** Remaining quantity not yet settled by any {@link TXIConsumption} in the history. */
    public calculateAvailable(transactions: Transaction[]): number {
        let available: number = this.quantity;
        for (const consumption of this.getConsumptions(transactions)) available -= consumption.quantity;

        return available;
    }

    /**
     * Creates a {@link TXIConsumption} for `quantity` units, asserting the available balance
     * is sufficient. The returned object must be placed in a transaction's outputs.
     */
    public consume(quantity: number, transactions: Transaction[]): TXIConsumption {
        if (quantity < 0) throw new Error(`Attempted to consume a negative number from a TXI`);

        const available: number = this.calculateAvailable(transactions);
        if (quantity > available) throw new Error(`Attempted to consume ${quantity} from a TXI that only has ${available} remaining.`);

        return new TXIConsumption(quantity, this);
    }
}

/**
 * A transaction input that consumes a portion of a prior {@link TXO}. Points to its
 * source by reference; `quantity` must not exceed the TXO's remaining available balance
 * at the time the consuming transaction is constructed.
 */
export class TXOConsumption {
    public readonly type = "txo-consumption";
    public quantity: number;

    constructor(
        quantity: number,
        public source: TXO
    ) {
        if (quantity < 0) throw new Error("The quantity of a TXO cannot be less than 0");
        this.quantity = quantity;
    }
}
