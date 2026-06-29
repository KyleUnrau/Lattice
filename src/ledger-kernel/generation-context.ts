import type { Account } from "./accounts/account.js";
import type { Ledger } from "./ledger.js";
import type { Position } from "./positions.js";
import { TransactionGroup } from "./transactions/group.js";
import { Transaction, type TransactionLike } from "./transactions/transaction.js";
import type { Input } from "./transactions/inputs.js";
import type { Output } from "./transactions/outputs.js";

/**
 * A staging session for generating multiple inputs/outputs before any transaction is committed.
 *
 * Lot availability is computed by scanning a transaction list, so generating two inputs (or two
 * outputs) from the same account + position straight off `ledger.transactions` double-counts the
 * same lots — the first call's consumptions aren't in the committed history yet, so the second
 * call sees the lots as fully available again.
 *
 * `GenerationContext` closes that gap: every generate call is given the live committed history
 * plus one *provisional* {@link TransactionLike} record holding everything staged so far. Because
 * availability subtracts the consumptions in that provisional record, each subsequent draw sees the
 * earlier staged ones as already spent. Staged remainder lots likewise read as committed within the
 * session, so an opposite-direction generate can consume them.
 *
 * The session never commits — callers still feed the returned inputs/outputs into
 * `Ledger.newTransaction` or a resolution. Obtain one via `Ledger.beginGeneration()`.
 */
export class GenerationContext implements TransactionLike {
    public readonly inputs: Input[] = [];
    public readonly outputs: Output[] = [];

    /** @param committed the ledger's live transaction array — read by reference, so transactions committed mid-session are seen. */
    constructor(private readonly committed: readonly TransactionLike[]) { }

    /** The committed history plus a provisional record of everything staged so far in this session. */
    public view(): readonly TransactionLike[] {
        return [...this.committed, { inputs: this.inputs, outputs: this.outputs }];
    }

    public addInputs(...inputs: Input[]): void {
        this.inputs.push(...inputs);
    }

    public generateInputs(account: Account, position: Position, quantity: number | bigint): Input[] {
        const generated: Input[] = account.generateInputs(position, quantity, this.view());
        this.addInputs(...generated);
        return generated;
    }

    public addOutputs(...outputs: Output[]): void {
        this.outputs.push(...outputs);
    }

    public generateOutputs(account: Account, position: Position, quantity: number | bigint): Output[] {
        const generated: Output[] = account.generateOutputs(position, quantity, this.view());
        this.addOutputs(...generated);
        return generated;
    }
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
