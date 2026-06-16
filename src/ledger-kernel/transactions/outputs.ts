import type { Position } from "../positions.js";
import type { TransactionLike } from "../transactions.js";
import { UTXOConsumption, type UTXI } from "./inputs.js";

export type Output = UTXO | UTXIConsumption;

/**
 * An unspent transaction output — value stored in an account after a transaction. Supports
 * partial consumption via {@link UTXOConsumption} objects in later transaction inputs.
 * Availability is computed dynamically by scanning the full transaction history.
 */
export class UTXO {
    public type = "utxo";
    public quantity: bigint;

    constructor(
        quantity: bigint,
        public position: Position
    ) {
        if (quantity < 0n) throw new Error(`The quantity of a UTXO must be a non-negative integer, got ${quantity}`);
        this.quantity = quantity;
    }

    /** Returns all {@link UTXOConsumption}s referencing this UTXO across the transaction history. */
    public getConsumptions(transactions: readonly TransactionLike[]): UTXOConsumption[] {
        const consumptions: UTXOConsumption[] = [];

        for (const transaction of transactions) {
            for (const input of transaction.inputs) {
                if (input instanceof UTXOConsumption && input.source === this) consumptions.push(input);
            }
        }

        return consumptions;
    }

    /** Remaining quantity not yet consumed by any {@link UTXOConsumption} in the history. */
    public calculateAvailable(transactions: readonly TransactionLike[]): bigint {
        let available: bigint = this.quantity;
        for (const consumption of this.getConsumptions(transactions)) available -= consumption.quantity;
        return available;
    }

    /**
     * Whether this UTXO has been committed — i.e. it appears as an output of some transaction in
     * `transactions`. A generated-but-not-yet-committed lot returns `false`, so balances exclude it
     * until the transaction that introduces it is appended to the ledger.
     */
    public isCommitted(transactions: readonly TransactionLike[]): boolean {
        return transactions.some(transaction => transaction.outputs.includes(this));
    }

    /**
     * Creates a {@link UTXOConsumption} for `quantity` units, asserting the available balance
     * is sufficient. The returned object must be placed in a transaction's inputs.
     */
    public consume(quantity: bigint, transactions: readonly TransactionLike[]): UTXOConsumption {
        if (quantity < 0n) throw new Error(`Attempted to consume a negative number from a UTXO`);

        const available: bigint = this.calculateAvailable(transactions);
        if (quantity > available) throw new Error(`Attempted to consume ${quantity} from a UTXO that only has ${available} remaining.`);

        return new UTXOConsumption(quantity, this);
    }
}

/**
 * A transaction output that settles a portion of a prior {@link UTXI}. Points to its
 * source by reference; `quantity` must not exceed the UTXI's remaining available balance
 * at the time the settling transaction is constructed.
 */
export class UTXIConsumption {
    public readonly type = "utxi-consumption";
    public quantity: bigint;

    constructor(
        quantity: bigint,
        public source: UTXI
    ) {
        if (quantity < 0n) throw new Error(`The quantity of a UTXIConsumption must be a non-negative integer, got ${quantity}`);
        this.quantity = quantity;
    }
}
