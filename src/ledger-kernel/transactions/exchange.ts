import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { TXI, TXOConsumption } from "./inputs.js";
import { TXIConsumption, TXO } from "./outputs.js";

export class Exchange {
    public readonly from: ExchangedTXO;
    public readonly to: ExchangedTXI;

    constructor(
        from: {quantity: number, position: Position},
        to: {quantity: number, position: Position}
    ) {
        this.from = new ExchangedTXO(from.quantity, from.position, this);
        this.to = new ExchangedTXI(to.quantity, to.position, this);
    }

    public recapture(quantity: number, transactions: Transaction[]): ExchangeRecapture {
        const toQuantity: number = (this.from.quantity / this.to.quantity) * quantity;
        
        return {
            from: this.to.consume(quantity, transactions),
            to: this.from.consume(toQuantity, transactions)
        };
    }
}

export interface ExchangeRecapture {
    from: TXIConsumption;
    to: TXOConsumption
}

export class ExchangedTXO extends TXO {
    public type = "exchanged-txo";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}

export class ExchangedTXI extends TXI {
    public type = "exchanged-txi";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}

export class ResidualTXO extends TXO {
    public type = "residual-txo";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}

export class ResidualTXI extends TXI {
    public type = "residual-txi";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}