import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { TXIConsumption, type TXO } from "./outputs.js";

export type Input = TXI | TXOConsumption;

// - TXI - //
export class TXI {
    public readonly type = "txi";
    public quantity: number;

    constructor(
        quantity: number,
        public position: Position
    ) {
        if (quantity < 0) throw new Error("The quantity of a TXI cannot be less than 0");
        this.quantity = quantity;
    }

    public getConsumptions(transactions: Transaction[]): TXIConsumption[] {
        const consumptions: TXIConsumption[] = [];

        for (const transaction of transactions) {
            for (const output of transaction.outputs) {
                if (output instanceof TXIConsumption && output.source === this) consumptions.push(output);
            }
        }

        return consumptions;
    }

    public calculateAvailable(transactions: Transaction[]): number {
        let available: number = this.quantity;
        for (const consumption of this.getConsumptions(transactions)) available -= consumption.quantity;

        return available;
    }

    public consume(quantity: number, transactions: Transaction[]): TXIConsumption {
        if (quantity < 0) throw new Error(`Attempted to consume a negative number from a TXI`);

        const available: number = this.calculateAvailable(transactions);
        if (quantity > available) throw new Error(`Attempted to consume ${quantity} from a TXI that only has ${available} remaining.`);

        return new TXIConsumption(quantity, this);
    }
}

// - TXO Consumption - //
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