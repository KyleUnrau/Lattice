import { ResidualAccount, ExchangeAccount } from "./computed.js";
import type { DisposalMethod } from "../disposal-methods/disposals.js";
import type { Orientation } from "../ledger.js";
import { type Position, unscale } from "../positions.js";
import type { Transaction } from "../transactions.js";
import type { UTXI } from "../transactions/inputs.js";
import type { UTXO } from "../transactions/outputs.js";
import { Account } from "./account.js";
import type { AccountNode } from "./node.js";
import type { FolderSummary, NodeSummary } from "./summary.js";


/**
 * A named node in the account tree that groups {@link Account}s and sub-folders.
 * Propagates {@link Orientation} multiplicatively to all descendants so root balance
 * polarity emerges from the hierarchy rather than from hardcoded debit/credit labels.
 */

export class AccountFolder implements AccountNode {
    constructor(
        public name: string,
        public localOrientation: Orientation,
        public children: AccountNode[] = [],
        public parent: AccountFolder | null = null
    ) {
        for (const child of this.children) child.parent = this;
    }

    public hasChild(child: AccountNode): boolean {
        for (const immediateChild of this.children) {
            if (child === immediateChild) return true;
            else if (immediateChild instanceof AccountFolder) return immediateChild.hasChild(child);
        }
        return false;
    }

    public addChild(child: AccountNode): void {
        if (this.hasChild(child)) throw new Error(`Cannot add the same children twice within an account folder structure`);
        this.children.push(child);
        child.parent = this;
    }

    public addAccount(
        name: string,
        localOrientation: Orientation,
        utxoDisposalMethod: DisposalMethod<UTXO>,
        utxiDisposalMethod: DisposalMethod<UTXI>
    ): Account {
        const child = new Account(name, localOrientation, this, utxoDisposalMethod, utxiDisposalMethod);
        this.addChild(child);
        return child;
    }

    public addResidualAccount(name: string, localOrientation: Orientation, negativeLabel?: string): ResidualAccount {
        const child = new ResidualAccount(name, localOrientation, negativeLabel);
        this.addChild(child);
        return child;
    }

    public addExchangeAccount(name: string, localOrientation: Orientation): ExchangeAccount {
        const child = new ExchangeAccount(name, localOrientation);
        this.addChild(child);
        return child;
    }

    public addFolder(name: string, localOrientation: Orientation): AccountFolder {
        const folder = new AccountFolder(name, localOrientation);
        this.addChild(folder);
        return folder;
    }

    public getEffectiveOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getEffectiveOrientation() * this.localOrientation;
    }

    public getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint {
        let sum = 0n;
        for (const child of this.children) sum += child.getSignedBalanceScaled(position, transactions);
        return sum;
    }

    public getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const child of this.children) {
            for (const [position, bal] of child.getSignedBalancesScaled(transactions))
                result.set(position, (result.get(position) ?? 0n) + bal);
        }
        return result;
    }

    public getBalanceScaled(position: Position, transactions: Transaction[]): bigint {
        return BigInt(this.getEffectiveOrientation()) * this.getSignedBalanceScaled(position, transactions);
    }

    public getBalancesScaled(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position, signed] of this.getSignedBalancesScaled(transactions))
            result.set(position, BigInt(this.getEffectiveOrientation()) * signed);
        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return unscale(this.getBalanceScaled(position, transactions), position);
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result = new Map<Position, number>();
        for (const [pos, raw] of this.getBalancesScaled(transactions)) result.set(pos, unscale(raw, pos));
        return result;
    }

    public summarize(position: Position, transactions: Transaction[]): FolderSummary {
        const children: NodeSummary[] = this.children.map(child => child.summarize(position, transactions));
        return { name: this.name, balance: this.getBalance(position, transactions), children };
    }
}
