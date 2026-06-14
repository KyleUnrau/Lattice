import { PositionLotStore } from "./position-lot-store.js";
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
 * Manages per-position {@link PositionLotStore}s containing UTXO and UTXI lots. Implements
 * the double-sided ledger entry point: `generateInputs` consumes existing UTXO lots to
 * produce transaction inputs; `generateOutputs` produces transaction outputs (new lots),
 * settling existing UTXI obligations first. Both methods use the account's configured
 * {@link DisposalMethod}s for lot selection.
 */

export class Account implements AccountNode {
    public readonly lotStores: Map<Position, PositionLotStore> = new Map();

    constructor(
        public name: string,
        public localOrientation: Orientation,
        public parent: AccountFolder | null,
        public readonly utxoDisposalMethod: DisposalMethod<UTXO>,
        public readonly utxiDisposalMethod: DisposalMethod<UTXI>
    ) { }

    public getEffectiveOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getEffectiveOrientation() * this.localOrientation;
    }

    public getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint {
        if (!this.lotStores.has(position)) return 0n;
        return this.getLotStore(position).getSignedBalanceScaled(transactions);
    }

    public getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position] of this.lotStores) result.set(position, this.getSignedBalanceScaled(position, transactions));
        return result;
    }

    public getBalanceRaw(position: Position, transactions: Transaction[]): bigint {
        return BigInt(this.getEffectiveOrientation()) * this.getSignedBalanceScaled(position, transactions);
    }

    public getBalancesRaw(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position] of this.lotStores) result.set(position, this.getBalanceRaw(position, transactions));
        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return unscale(this.getBalanceRaw(position, transactions), position);
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result = new Map<Position, number>();
        for (const [pos] of this.lotStores) result.set(pos, this.getBalance(pos, transactions));
        return result;
    }

    public getLotStore(position: Position): PositionLotStore {
        if (!this.lotStores.has(position)) this.lotStores.set(position, new PositionLotStore(position, this.utxoDisposalMethod, this.utxiDisposalMethod));
        return this.lotStores.get(position)!;
    }

    public generateInputs(position: Position, value: number, transactions: Transaction[]): Input[] {
        return this.getLotStore(position).generateInputs(value, transactions);
    }

    public generateOutputs(position: Position, value: number, transactions: Transaction[]): Output[] {
        return this.getLotStore(position).generateOutputs(value, transactions);
    }

    public summarize(position: Position, transactions: Transaction[]): AccountSummary {
        return { name: this.name, balance: this.getBalance(position, transactions) };
    }
}
