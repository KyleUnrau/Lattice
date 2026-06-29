import type { Transaction } from "./transaction.js";


/**
 * A read-only, recursive **overlay** that records which committed {@link Transaction}s form one
 * business event, and what role each plays. A single economic action — an exchange, an expense,
 * or a composite "split this draw into an expense and an exchange" — typically lands as several
 * atomic, single-position transactions; the kernel's flat history erases the link between them.
 * A `TransactionGroup` re-annotates that link *without altering the history*.
 *
 * **It is not authoritative.** The flat `Ledger.transactions` array remains the single source of
 * truth for lot availability, cost-basis lineage, and `Ledger.verify()`. A group only holds
 * references — by identity — to transactions already in that array, so it can never change
 * availability, lineage, or commit order. Removing every group would leave the ledger's mechanics
 * untouched.
 *
 * Build one from a resolution's transactions via `toGroup(...)`, or compose several with
 * `Ledger.beginEvent(...)`; commit one with `Ledger.record(...)`.
 */

export class TransactionGroup {
    constructor(
        public readonly members: (Transaction | TransactionGroup)[]
    ) { }

    /**
     * The group's leaf {@link Transaction}s in depth-first order — exactly the sequence committed
     * to the ledger. This is the single source of truth for member ordering: a resolution wrapper's
     * own `flatten()` delegates here so the two can never drift.
     */
    public flatten(): Transaction[] {
        return this.members.flatMap(member => member instanceof TransactionGroup ? member.flatten() : [member]);
    }
}
