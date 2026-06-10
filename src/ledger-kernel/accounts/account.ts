import { AccountEngine } from "./engine.js";
import { AccountFolder } from "./folder.js";
import type { DisposalMethod } from "../disposal-methods/disposals.js";
import type { Orientation } from "../ledger.js";
import { type Position, unscale } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { UTXI, Input } from "../transactions/inputs.js";
import type { UTXO, Output } from "../transactions/outputs.js";
import type { AccountNode } from "./node.js";
import type { AccountSummary } from "./summary.js";


/**
 * Manages per-position {@link AccountEngine}s containing UTXO and UTXI lots. Implements
 * the double-sided ledger entry point: `generateInputs` pulls value out (spending/disposal)
 * by consuming existing UTXO lots; `generateOutputs` pushes value in (receipt/income) by
 * settling existing UTXI obligations. Both methods use the account's configured
 * {@link DisposalMethod}s for lot selection.
 */

export class Account implements AccountNode {
    public readonly engines: Map<Position, AccountEngine> = new Map();

    constructor(
        public name: string,
        public localOrientation: Orientation,
        public parent: AccountFolder | null,
        public readonly utxoDisposalMethod: DisposalMethod<UTXO>,
        public readonly utxiDisposalMethod: DisposalMethod<UTXI>
    ) { }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }

    public getRootRawBalance(position: Position, transactions: Transaction[]): bigint {
        if (!this.engines.has(position)) return 0n;
        return this.getEngine(position).getRootBalance(transactions);
    }

    public getRootRawBalances(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position] of this.engines) result.set(position, this.getRootRawBalance(position, transactions));
        return result;
    }

    public getRawBalance(position: Position, transactions: Transaction[]): bigint {
        return BigInt(this.getRootOrientation()) * this.getRootRawBalance(position, transactions);
    }

    public getRawBalances(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position] of this.engines) result.set(position, this.getRawBalance(position, transactions));
        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return unscale(this.getRawBalance(position, transactions), position);
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result = new Map<Position, number>();
        for (const [pos] of this.engines) result.set(pos, this.getBalance(pos, transactions));
        return result;
    }

    public getEngine(position: Position): AccountEngine {
        if (!this.engines.has(position)) this.engines.set(position, new AccountEngine(position, this.utxoDisposalMethod, this.utxiDisposalMethod));
        return this.engines.get(position)!;
    }

    public generateInputs(position: Position, value: number, transactions: Transaction[]): Input[] {
        return this.getEngine(position).generateInputs(value, transactions);
    }

    public generateOutputs(position: Position, value: number, transactions: Transaction[]): Output[] {
        return this.getEngine(position).generateOutputs(value, transactions);
    }

    public summarize(position: Position, transactions: Transaction[]): AccountSummary {
        return { name: this.name, balance: this.getBalance(position, transactions) };
    }
}
