import type { Transaction } from "./transaction.js";
import type { TransactionMaterial } from "./material.js";

/**
 * The semantic base abstraction for a structured bundle of {@link Transaction}s. Every accounting
 * operation that spans more than one atomic transaction — an exchange, a terminal expense, a
 * composite event — is a `TransactionGroup` subclass that preserves its named roles while still
 * producing a deterministic flat list for the ledger.
 *
 * **It is not authoritative.** The flat `Ledger.transactions` array remains the single source of
 * truth for lot availability, cost-basis lineage, and `Ledger.verify()`. A group only holds
 * references — by identity — to already-committed transactions, so removing every group leaves
 * the ledger's mechanics untouched.
 *
 * Concrete subclasses:
 * - {@link OrderedTransactionGroup} — generic, anonymous sequential bundle
 * - `ExchangeTransactions` — semantic exchange bundle with named `from`, `to`, `intermediates`,
 *   `terminalLoss`, `resolution` fields
 * - `TerminalTransactions` — semantic terminal-expense bundle with named `from`, `intermediates`,
 *   `externalTerminals`, `resolution` fields
 */
export abstract class TransactionGroup implements TransactionMaterial {
    /** Discriminant for runtime inspection of what kind of accounting operation this group represents. */
    public abstract readonly kind: string;

    /**
     * The immediate children of this group, each of which is either a leaf {@link Transaction} or
     * a nested {@link TransactionGroup}. Implementations filter out empty children so that callers
     * see only meaningful members (e.g. `ExchangeTransactions` omits its `intermediates` when the
     * exchange requires no intermediate hops).
     */
    public abstract get members(): readonly TransactionMaterial[];

    /**
     * All leaf {@link Transaction}s in depth-first order — exactly the sequence committed to the
     * ledger. Derived from {@link members} so that member ordering is the single source of truth;
     * subclasses that override `members` get the correct `flatten()` for free.
     */
    public flatten(): readonly Transaction[] {
        return this._flat ??= this.members.flatMap(member => member.flatten());
    }
    private _flat?: readonly Transaction[];

    /** True when this group contributes no leaf transactions (e.g. an empty hop list). */
    public get isEmpty(): boolean {
        return this.members.length === 0;
    }
}

/**
 * A generic, ordered bundle of {@link TransactionMaterial}. Used for composite events that group
 * several semantic sub-flows (e.g. an expense followed by an exchange) and for internal sequential
 * groups such as intermediate hop lists. Unlike the named semantic subclasses, an
 * `OrderedTransactionGroup` carries no domain meaning beyond "these items happen in this order".
 */
export class OrderedTransactionGroup extends TransactionGroup {
    public readonly kind = "ordered";

    constructor(
        private readonly _members: readonly TransactionMaterial[]
    ) {
        super();
    }

    public get members(): readonly TransactionMaterial[] {
        return this._members;
    }
}
