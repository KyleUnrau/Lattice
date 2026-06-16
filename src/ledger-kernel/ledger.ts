import type { Position } from "./positions.js";
import type { Result } from "../utils.js";
import { Transaction, TransactionGroup, type TransactionLike } from "./transactions.js";
import type { AccountFolder } from "./accounts/folder.js";
import type { FolderSummary } from "./accounts/summary.js";
import { GenerationContext } from "./generation-context.js";

export enum Orientation {
    Positive = 1,
    Negative = -1
}

/**
 * The top-level container for a double-entry ledger. Holds the ordered {@link Transaction}
 * history and the two root {@link AccountFolder}s (`netAssets` and `equity`). All balance
 * queries and the structural invariant check run through this class.
 */
export class Ledger {
    public groups: TransactionGroup[] = [];

    /**
     * The flat commit history, in order. Callers (e.g. {@link BookValueEngine}) routinely capture
     * this array once and rely on later commits remaining visible through that same reference —
     * so this is a single array mutated in place by {@link appendGroup}, not a value recomputed
     * fresh from `groups` on every access.
     */
    public readonly transactions: Transaction[] = [];

    constructor(
        public netAssets: AccountFolder,
        public equity: AccountFolder
    ) {}

    public beginEvent(): EventBuilder {
        return new EventBuilder(this);
    }

    /** Registers an already-committed group as a top-level event. Used by {@link record} and {@link EventBuilder}. */
    public appendGroup(group: TransactionGroup): TransactionGroup {
        this.groups.push(group);
        this.transactions.push(...group.flatten());
        return group;
    }

    public getSignedBalancesScaled(): Map<Position, bigint> {
        const signedBalances = new Map<Position, bigint>();

        for (const [position, balance] of this.netAssets.getSignedBalancesScaled(this.transactions))
            signedBalances.set(position, balance + (signedBalances.get(position) ?? 0n));
        for (const [position, balance] of this.equity.getSignedBalancesScaled(this.transactions))
            signedBalances.set(position, balance + (signedBalances.get(position) ?? 0n));

        return signedBalances;
    }

    /**
     * Checks that every position's combined root balance across `netAssets` and `equity`
     * sums to zero (within floating-point epsilon). Open exchange positions are automatically
     * accounted for via {@link ExchangePositionsAccount} in the equity tree — no external
     * adjustment is needed.
     */
    public verify(): Result<undefined, Error> {
        const signedBalances = this.getSignedBalancesScaled();

        for (const [position, balance] of signedBalances) {
            if (balance !== 0n) return {ok: false, error: new Error(`Ledger invalid, root balance for ${position.name} calculated as ${balance} instead of 0`)};
        }

        // Backstop: no lot may ever be over-consumed. The per-transaction check catches double-spend
        // within a single transaction, but over-consumption spread across separately-constructed
        // transactions in one batch can only be detected here, against the full committed history.
        for (const account of [...this.netAssets.getAccounts(), ...this.equity.getAccounts()]) {
            for (const store of account.lotStores.values()) {
                for (const utxo of store.utxos) {
                    if (utxo.calculateAvailable(this.transactions) < 0n) return {ok: false, error: new Error(`Ledger invalid, a UTXO for ${utxo.position.name} in account "${account.name}" has been over-consumed (available ${utxo.calculateAvailable(this.transactions)})`)};
                }
                for (const utxi of store.utxis) {
                    if (utxi.calculateAvailable(this.transactions) < 0n) return {ok: false, error: new Error(`Ledger invalid, a UTXI for ${utxi.position.name} in account "${account.name}" has been over-consumed (available ${utxi.calculateAvailable(this.transactions)})`)};
                }
            }
        }

        return {ok: true, value: undefined};
    }

    public summarize(position: Position): LedgerSummary {
        return {
            position,
            netAssets: this.netAssets.summarize(position, this.transactions),
            equity: this.equity.summarize(position, this.transactions),
        };
    }
}

export interface LedgerSummary {
    position: Position;
    netAssets: FolderSummary;
    equity: FolderSummary;
}

/**
 * Accumulates several sub-flows into one composite {@link TransactionGroup}. Each {@link record}
 * commits its sub-flow's leaves to the ledger immediately — so a subsequent resolution constructed
 * against `ledger.transactions` sees them as already spent — while nesting the sub-flow under the
 * event being built. {@link register} registers the composite as a single top-level event. Obtain one
 * via {@link Ledger.beginEvent}.
 */
export class EventBuilder {
    public readonly context: GenerationContext;
    public readonly members: (Transaction | TransactionGroup)[] = [];

    constructor(
        private readonly ledger: Ledger
    ) {
        this.context = new GenerationContext(ledger.transactions);
    }

    /** Commits `group`'s leaves now and nests it under the event as a sub-flow. */
    public record(transaction: Transaction | TransactionGroup): void {
        this.members.push(transaction);
    }

    public newTransaction(transactionLike: TransactionLike): Transaction {
        const transaction: Transaction = (transactionLike instanceof Transaction) ? transactionLike : new Transaction(transactionLike.inputs, transactionLike.outputs, this.view());
        this.record(transaction);
        return transaction;
    } 

    public newGroup(...transactionLikes: (TransactionLike | TransactionGroup)[]): TransactionGroup {
        const members: (Transaction | TransactionGroup)[] = [];
        for (const transactionLike of transactionLikes) {
            if (transactionLike instanceof Transaction || transactionLike instanceof TransactionGroup) members.push(transactionLike);
            else members.push(new Transaction(transactionLike.inputs, transactionLike.outputs, this.view()));
        }

        const group = new TransactionGroup(members);
        this.record(group);
        return group;
    }

    public generateGroup(): TransactionGroup {
        if (this.members.length === 1 && this.members[0] instanceof TransactionGroup) return this.members[0];
        return new TransactionGroup(this.members);
    }

    /** Registers the accumulated sub-flows as one composite top-level event. */
    public register(): TransactionGroup {
        return this.ledger.appendGroup(this.generateGroup());
    }

    public view(): Transaction[] {
        return [...this.ledger.transactions, ...this.members.flatMap((value) => ((value instanceof Transaction) ? value : value.flatten()))];
    }
}
