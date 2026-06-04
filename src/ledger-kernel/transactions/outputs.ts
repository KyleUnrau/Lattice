import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { TXOConsumption, type TXI } from "./inputs.js";

export type Output = TXO | TXIConsumption;

/**
 * A produced output — value stored in an account after a transaction. Supports
 * partial consumption via {@link TXOConsumption} objects in later transaction inputs.
 * Availability is computed dynamically by scanning the full transaction history.
 */
export class TXO {
    public type = "txo";
    public quantity: number;

    constructor(
        quantity: number,
        public position: Position
    ) {
        if (quantity < 0) throw new Error("The quantity of a TXO cannot be less than 0");
        this.quantity = quantity;
    }

    /** Returns all {@link TXOConsumption}s referencing this TXO across the transaction history. */
    public getConsumptions(transactions: Transaction[]): TXOConsumption[] {
        const consumptions: TXOConsumption[] = [];

        for (const transaction of transactions) {
            for (const input of transaction.inputs) {
                if (input instanceof TXOConsumption && input.source === this) consumptions.push(input);
            }
        }

        return consumptions;
    }

    /** Remaining quantity not yet consumed by any {@link TXOConsumption} in the history. */
    public calculateAvailable(transactions: Transaction[]): number {
        let available: number = this.quantity;
        for (const consumption of this.getConsumptions(transactions)) available -= consumption.quantity;

        return available;
    }

    /**
     * Creates a {@link TXOConsumption} for `quantity` units, asserting the available balance
     * is sufficient. The returned object must be placed in a transaction's inputs.
     */
    public consume(quantity: number, transactions: Transaction[]): TXOConsumption {
        if (quantity < 0) throw new Error(`Attempted to consume a negative number from a TXO`);

        const available: number = this.calculateAvailable(transactions);
        if (quantity > available) throw new Error(`Attempted to consume ${quantity} from a TXO that only has ${available} remaining.`);

        return new TXOConsumption(quantity, this);
    }
}

/**
 * A transaction output that settles a portion of a prior {@link TXI}. Points to its
 * source by reference; `quantity` must not exceed the TXI's remaining available balance
 * at the time the settling transaction is constructed.
 */
export class TXIConsumption {
    public readonly type = "txi-consumption";
    public quantity: number;

    constructor(
        quantity: number,
        public source: TXI
    ) {
        if (quantity < 0) throw new Error("The quantity of a TXO cannot be less than 0");
        this.quantity = quantity;
    }
}
