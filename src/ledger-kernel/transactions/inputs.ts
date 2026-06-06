import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { UTXIConsumption, type UTXO } from "./outputs.js";

export type Input = UTXI | UTXOConsumption;

/**
 * An unspent transaction input — value entering the system without consuming a prior output.
 * Used for opening balances, equity injections, and exchange receipts. Supports
 * partial settlement via {@link UTXIConsumption} objects in later transaction outputs.
 */
export class UTXI {
    public type = "utxi";
    public quantity: number;

    constructor(
        quantity: number,
        public position: Position
    ) {
        if (quantity < 0) throw new Error("The quantity of a UTXI cannot be less than 0");
        this.quantity = quantity;
    }

    /** Returns all {@link UTXIConsumption}s referencing this UTXI across the transaction history. */
    public getConsumptions(transactions: Transaction[]): UTXIConsumption[] {
        const consumptions: UTXIConsumption[] = [];

        for (const transaction of transactions) {
            for (const output of transaction.outputs) {
                if (output instanceof UTXIConsumption && output.source === this) consumptions.push(output);
            }
        }

        return consumptions;
    }

    /** Remaining quantity not yet settled by any {@link UTXIConsumption} in the history. */
    public calculateAvailable(transactions: Transaction[]): number {
        let available: number = this.quantity;
        for (const consumption of this.getConsumptions(transactions)) available -= consumption.quantity;

        return available;
    }

    /**
     * Creates a {@link UTXIConsumption} for `quantity` units, asserting the available balance
     * is sufficient. The returned object must be placed in a transaction's outputs.
     */
    public consume(quantity: number, transactions: Transaction[]): UTXIConsumption {
        if (quantity < 0) throw new Error(`Attempted to consume a negative number from a UTXI`);

        const available: number = this.calculateAvailable(transactions);
        if (quantity > available) throw new Error(`Attempted to consume ${quantity} from a UTXI that only has ${available} remaining.`);

        return new UTXIConsumption(quantity, this);
    }
}

/**
 * A transaction input that consumes a portion of a prior {@link UTXO}. Points to its
 * source by reference; `quantity` must not exceed the UTXO's remaining available balance
 * at the time the consuming transaction is constructed.
 */
export class UTXOConsumption {
    public readonly type = "utxo-consumption";
    public quantity: number;

    constructor(
        quantity: number,
        public source: UTXO
    ) {
        if (quantity < 0) throw new Error("The quantity of a UTXOConsumption cannot be less than 0");
        this.quantity = quantity;
    }
}
