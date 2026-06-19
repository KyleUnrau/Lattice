import type { Position } from "../positions.js";
import type { TerminalAccount } from "../accounts/computed.js";
import { UTXO } from "./outputs.js";

/**
 * A **terminal settlement record** — the final recognition of origin-basis value leaving the system:
 * an expense, a realized exchange loss, or a negative-residual settlement. It is *output-shaped* so
 * it can balance the transaction it settles and be summed for reporting, but it is **not** ordinary
 * inventory: it is never held in a {@link PositionLotStore}, never selected by a disposal method, and
 * never appears as a transaction source.
 *
 * Terminality is encoded structurally:
 * - it lives only in a {@link TerminalAccount}, which exposes no `generateInputs` (cannot be a source);
 * - {@link consume} is overridden to throw, so even a stray attempt to spend one fails loudly.
 *
 * The owning {@link account} is referenced back so balances can be attributed without scanning.
 */
export class TerminalUTXO extends UTXO {
    public type = "terminal-utxo";

    constructor(
        quantity: bigint,
        position: Position,
        public readonly account: TerminalAccount
    ) { super(quantity, position); }

    /** Terminal records are final; they can never be consumed, exchanged, or transferred. */
    public override consume(): never {
        throw new Error("TerminalUTXO is a terminal settlement record and cannot be consumed");
    }
}
