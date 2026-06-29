import type { ResidualAccount } from "../../accounts/computed.js";
import type { Position } from "../../positions.js";
import { UTXI } from "../inputs.js";


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
