import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { UTXI, UTXOConsumption } from "./inputs.js";
import { UTXIConsumption, UTXO } from "./outputs.js";

/**
 * Links two single-position transactions through a locked conversion rate.
 * `.from` is an {@link ExchangedUTXO} placed in the source transaction's outputs (value given away);
 * `.to` is an {@link ExchangedUTXI} placed in the destination transaction's inputs (value received).
 * The rate is immutable after construction: `from.quantity / to.quantity`.
 *
 * Prefer constructing exchanges via the `exchange()` equity-policy function rather than
 * instantiating this class directly, so that prior exchange lineages are recaptured correctly
 * and `forwardExchange` is only created when actually needed.
 */
export class Exchange {
    public readonly from: ExchangedUTXO;
    public readonly to: ExchangedUTXI;

    constructor(
        from: {quantity: number, position: Position},
        to: {quantity: number, position: Position}
    ) {
        this.from = new ExchangedUTXO(from.quantity, from.position, this);
        this.to = new ExchangedUTXI(to.quantity, to.position, this);
    }

    /**
     * Partially or fully unwinds this exchange at its original locked rate.
     * `recapture.from` is a {@link UTXIConsumption} that settles part of `.to`;
     * `recapture.to` is a {@link UTXOConsumption} that reclaims the corresponding part of `.from`.
     *
     * @param quantity - Amount of the to-side to recapture; must not exceed remaining availability.
     */
    public recapture(quantity: number, transactions: Transaction[]): ExchangeRecapture {
        const toQuantity: number = (this.from.quantity / this.to.quantity) * quantity;

        return {
            from: this.to.consume(quantity, transactions),
            to: this.from.consume(toQuantity, transactions)
        };
    }
}

/** The paired outputs of {@link Exchange.recapture} — the two sides of a locked-rate reversal. */
export interface ExchangeRecapture {
    /** {@link UTXIConsumption} settling the to-side of the original exchange. Goes in a transaction's outputs. */
    from: UTXIConsumption;
    /** {@link UTXOConsumption} reclaiming the from-side of the original exchange. Goes in a transaction's inputs. */
    to: UTXOConsumption
}

/** The from-side of an {@link Exchange} — value given away; placed in a transaction's outputs. */
export class ExchangedUTXO extends UTXO {
    public type = "exchanged-utxo";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}

/** The to-side of an {@link Exchange} — value received; placed in a transaction's inputs. */
export class ExchangedUTXI extends UTXI {
    public type = "exchanged-utxi";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}

/**
 * A loss (shortfall) relative to an exchange's locked rate, tagged to its originating exchange.
 * Placed in a transaction's outputs. Ownership (which {@link ResidualAccount} this belongs to) is
 * tracked by the account itself, not by this primitive.
 *
 * When `exchange` is non-null the basis engine traces lineage through the exchange's from-side.
 * When `exchange` is null (pure-recapture case) the engine treats this as an origin path.
 */
export class ResidualUTXO extends UTXO {
    public type = "residual-utxo";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange | null
    ) { super(quantity, position); }
}

/**
 * A gain (surplus) relative to an exchange's locked rate, tagged to its originating exchange.
 * Placed in a transaction's inputs. Ownership (which {@link ResidualAccount} this belongs to) is
 * tracked by the account itself, not by this primitive.
 *
 * When `exchange` is non-null the basis engine traces lineage through the exchange's from-side.
 * When `exchange` is null (pure-recapture case) the engine treats this as an origin path.
 */
export class ResidualUTXI extends UTXI {
    public type = "residual-utxi";

    constructor(
        quantity: number,
        position: Position,
        public readonly exchange: Exchange | null
    ) { super(quantity, position); }
}
