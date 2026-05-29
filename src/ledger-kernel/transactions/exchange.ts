import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { TXI, TXOConsumption } from "./inputs.js";
import { TXIConsumption, TXO } from "./outputs.js";

export class Exchange {
    public from: ExchangedTXO;
    public to: ExchangedTXI;

    constructor(
        from: {quantity: number, position: Position},
        to: {quantity: number, position: Position}
    ) {
        this.from = new ExchangedTXO(from.quantity, from.position, this);
        this.to = new ExchangedTXI(to.quantity, to.position, this);
    }

    public recapture(quantity: number, transactions: Transaction[]): ReverseExchange {
        const toQuantity: number = (this.from.quantity / this.to.quantity) * quantity;
        
        return {
            from: this.to.consume(quantity, transactions),
            to: this.from.consume(toQuantity, transactions)
        };
    }
}

export interface ReverseExchange {
    from: TXIConsumption;
    to: TXOConsumption
}

export class ExchangedTXO extends TXO {
    constructor(
        quantity: number,
        position: Position,
        public exchange: Exchange
    ) { super(quantity, position); }
}

export class ExchangedTXI extends TXI {
    constructor(
        quantity: number,
        position: Position,
        public exchange: Exchange
    ) { super(quantity, position); }
}