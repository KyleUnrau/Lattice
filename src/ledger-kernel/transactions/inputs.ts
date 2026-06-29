import type { Position } from "../positions.js";
import type { TransactionLike } from "./transaction.js";
import { UTXIConsumption, type UTXO } from "./outputs.js";

export type Input = UTXI | UTXOConsumption;

/**
 * An unspent transaction input — value entering the system without consuming a prior output.
 * Used for opening balances, equity injections, and exchange receipts. Supports
 * partial settlement via {@link UTXIConsumption} objects in later transaction outputs.
 */
export class UTXI {
    public type = "utxi";
    public quantity: bigint;

    constructor(
        quantity: bigint,
        public position: Position
    ) {
        if (quantity < 0n) throw new Error(`The quantity of a UTXI must be a non-negative integer, got ${quantity}`);
        this.quantity = quantity;
    }

    /** Returns all {@link UTXIConsumption}s referencing this UTXI across the transaction history. */
    public getConsumptions(transactions: readonly TransactionLike[]): UTXIConsumption[] {
        const consumptions: UTXIConsumption[] = [];

        for (const transaction of transactions) {
            for (const output of transaction.outputs) {
                if (output instanceof UTXIConsumption && output.source === this) consumptions.push(output);
            }
        }

        return consumptions;
    }

    /** Remaining quantity not yet settled by any {@link UTXIConsumption} in the history. */
    public calculateAvailable(transactions: readonly TransactionLike[]): bigint {
        let available: bigint = this.quantity;
        for (const consumption of this.getConsumptions(transactions)) available -= consumption.quantity;
        return available;
    }

    /**
     * Whether this UTXI has been committed — i.e. it appears as an input of some transaction in
     * `transactions`. A generated-but-not-yet-committed lot returns `false`, so balances exclude it
     * until the transaction that introduces it is appended to the ledger.
     */
    public isCommitted(transactions: readonly TransactionLike[]): boolean {
        return transactions.some(transaction => transaction.inputs.includes(this));
    }

    /**
     * Creates a {@link UTXIConsumption} for `quantity` units, asserting the available balance
     * is sufficient. The returned object must be placed in a transaction's outputs.
     */
    public consume(quantity: bigint, transactions: readonly TransactionLike[]): UTXIConsumption {
        if (quantity < 0n) throw new Error(`Attempted to consume a negative number from a UTXI`);

        const available: bigint = this.calculateAvailable(transactions);
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
    public quantity: bigint;

    constructor(
        quantity: bigint,
        public source: UTXO
    ) {
        if (quantity < 0n) throw new Error(`The quantity of a UTXOConsumption must be a non-negative integer, got ${quantity}`);
        this.quantity = quantity;
    }
}
