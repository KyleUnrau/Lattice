import type { Recapture } from "../../equity-policy/recaptures.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { ExchangeAccount, ResidualAccount } from "../accounts/computed.js";
import { UTXI } from "./inputs.js";
import { UTXO } from "./outputs.js";

/**
 * Where an {@link Exchange}'s open position is booked. Either a single {@link ExchangeAccount}
 * scoping both sides, or a `{from, to}` pair scoping each side independently — letting the value
 * given away and the value received land in distinct equity accounts (e.g. separate "Transfers
 * Out" and "Transfers In" lines). Imported as a type only, so this carries no runtime dependency
 * on `accounts/computed.ts` (which depends on this module for its `instanceof` checks).
 */
export type ExchangeTarget = ExchangeAccount | { from: ExchangeAccount; to: ExchangeAccount };

/**
 * Links two single-position transactions through a locked conversion rate.
 * `.from` is an {@link ExchangedUTXO} placed in the source transaction's outputs (value given away);
 * `.to` is an {@link ExchangedUTXI} placed in the destination transaction's inputs (value received).
 * The rate is immutable after construction: `from.quantity / to.quantity`.
 *
 * `fromAccount`/`toAccount` are the {@link ExchangeAccount}s that book each side's open position;
 * an {@link ExchangeAccount} sums a side only when that side's account is itself. They are derived
 * from the {@link ExchangeTarget} passed at construction (a single account scopes both sides).
 *
 * Prefer constructing exchanges via {@link ExchangeResolution} rather than instantiating this class
 * directly, so that prior exchange lineages are recaptured correctly and a forward exchange is only
 * created when actually needed.
 */
export class Exchange {
    public readonly from: ExchangedUTXO;
    public readonly to: ExchangedUTXI;
    /** Books the from-side (value given away) open position. */
    public readonly fromAccount: ExchangeAccount;
    /** Books the to-side (value received) open position. */
    public readonly toAccount: ExchangeAccount;

    constructor(
        from: {quantity: bigint, position: Position},
        to: {quantity: bigint, position: Position},
        target: ExchangeTarget
    ) {
        this.from = new ExchangedUTXO(from.quantity, from.position, this);
        this.to = new ExchangedUTXI(to.quantity, to.position, this);
        this.fromAccount = "from" in target ? target.from : target;
        this.toAccount = "to" in target ? target.to : target;
    }

    /**
     * Partially or fully unwinds this exchange at its original locked rate.
     * `recapture.settlement` is a {@link UTXIConsumption} that settles part of the to-side (`.to`);
     * `recapture.reclaim` is a {@link UTXOConsumption} that reclaims the corresponding part of the
     * from-side (`.from`).
     *
     * @param quantity - Amount of the to-side to recapture; must not exceed remaining availability.
     * @param fromQuantity - The exact from-side amount to reclaim. Pass the value the unwind already
     *   tracked for this edge ({@link RecaptureEdge.fromQuantity}) so the reclaim threads the loop
     *   without rounding drift; omit to re-derive it from the locked rate (the round-trip can lose a
     *   remainder when `quantity` was itself rounded, unbalancing an intermediate hop).
     */
    public recapture(quantity: bigint, transactions: Transaction[], fromQuantity?: bigint): Recapture {
        const reclaimQuantity: bigint = fromQuantity ?? this.from.quantity * quantity / this.to.quantity;

        return {
            settlement: this.to.consume(quantity, transactions),
            reclaim: this.from.consume(reclaimQuantity, transactions)
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
