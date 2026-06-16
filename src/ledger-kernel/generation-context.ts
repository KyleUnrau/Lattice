import type { Account } from "./accounts/account.js";
import type { Position } from "./positions.js";
import type { TransactionLike } from "./transactions.js";
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
