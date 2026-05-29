import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { TXOConsumption, type TXI } from "./inputs.js";

export type Output = TXO | TXIConsumption;

export class TXO {
    public readonly type = "txo";
    public quantity: number;

    constructor(
        quantity: number,
        public position: Position
    ) {
        if (quantity < 0) throw new Error("The quantity of a TXO cannot be less than 0");
        this.quantity = quantity;
    }

    public getConsumptions(transactions: Transaction[]): TXOConsumption[] {
        const consumptions: TXOConsumption[] = [];

        for (const transaction of transactions) {
            for (const input of transaction.inputs) {
                if (input instanceof TXOConsumption && input.source === this) consumptions.push(input);
            }
        }

        return consumptions;
    }

    public calculateAvailable(transactions: Transaction[]): number {
        let available: number = this.quantity;
        for (const consumption of this.getConsumptions(transactions)) available -= consumption.quantity;

        return available;
    }

    public consume(quantity: number, transactions: Transaction[]): TXOConsumption {
        if (quantity < 0) throw new Error(`Attempted to consume a negative number from a TXO`);

        const available: number = this.calculateAvailable(transactions);
        if (quantity > available) throw new Error(`Attempted to consume ${quantity} from a TXO that only has ${available} remaining.`);

        return new TXOConsumption(quantity, this);
    }
}

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