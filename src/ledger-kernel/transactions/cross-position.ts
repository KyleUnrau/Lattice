import type { ExchangeRecapture } from "../../equity-policy/exchange/types.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { ResidualAccount } from "../accounts/computed.js";
import { UTXI } from "./inputs.js";
import { UTXO } from "./outputs.js";

/**
 * Implemented by {@link ExchangePositionsAccount} and used as an opaque tag on {@link Exchange}
 * to scope which exchanges a given account includes in its balance computation. Defined here
 * rather than in `accounts/computed.ts` to avoid a circular import.
 */
export interface ExchangeAccountMarker {}

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
        from: {quantity: bigint, position: Position},
        to: {quantity: bigint, position: Position},
        public readonly account?: ExchangeAccountMarker
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
    public recapture(quantity: bigint, transactions: Transaction[]): ExchangeRecapture {
        const toQuantity: bigint = this.from.quantity * quantity / this.to.quantity;

        return {
            from: this.to.consume(quantity, transactions),
            to: this.from.consume(toQuantity, transactions)
        };
    }
}

/** The from-side of an {@link Exchange} — value given away; placed in a transaction's outputs. */
export class ExchangedUTXO extends UTXO {
    public type = "exchanged-utxo";

    constructor(
        quantity: bigint,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}

/** The to-side of an {@link Exchange} — value received; placed in a transaction's inputs. */
export class ExchangedUTXI extends UTXI {
    public type = "exchanged-utxi";

    constructor(
        quantity: bigint,
        position: Position,
        public readonly exchange: Exchange
    ) { super(quantity, position); }
}

/**
 * A loss (shortfall) relative to an exchange's locked rate, recognized in the surface position.
 * Placed in a transaction's outputs. The owning {@link ResidualAccount} that minted this lot is
 * referenced by {@link account}, so a later settlement can re-recognize the deferred equity within
 * the same account it originated in rather than an arbitrary one.
 *
 * `originBasis` records the origin-position composition (e.g. `{BTC: 0.0005}`) that this residual's
 * surface amount traces back to — the deferred equity it carries until settlement. The basis engine
 * surfaces this directly as a {@link ResidualPath} so consumers can settle the residual into its
 * origin positions.
 */
export class ResidualUTXO extends UTXO {
    public type = "residual-utxo";

    constructor(
        quantity: bigint,
        position: Position,
        public readonly originBasis: Map<Position, bigint>,
        public readonly account: ResidualAccount
    ) { super(quantity, position); }
}

/**
 * A gain (surplus) relative to an exchange's locked rate, recognized in the surface position.
 * Placed in a transaction's inputs. The owning {@link ResidualAccount} that minted this lot is
 * referenced by {@link account}, so a later settlement can re-recognize the deferred equity within
 * the same account it originated in rather than an arbitrary one.
 *
 * `originBasis` records the origin-position composition (e.g. `{BTC: 0.0005}`) that this residual's
 * surface amount traces back to — the deferred equity it carries until settlement. The basis engine
 * surfaces this directly as a {@link ResidualPath} so consumers can settle the residual into its
 * origin positions.
 */
export class ResidualUTXI extends UTXI {
    public type = "residual-utxi";

    constructor(
        quantity: bigint,
        position: Position,
        public readonly originBasis: Map<Position, bigint>,
        public readonly account: ResidualAccount
    ) { super(quantity, position); }
}
