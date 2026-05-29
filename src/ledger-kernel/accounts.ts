import type { DisposalMethod } from "./disposal-methods/disposals.js";
import type { Orientation } from "./ledger.js";
import type { Position } from "./positions.js";
import type { Transaction } from "./transactions.js";
import { TXI, TXOConsumption, type Input } from "./transactions/inputs.js";
import { TXO, type Output, type TXIConsumption } from "./transactions/outputs.js";

export type AccountNode = Account | AccountFolder;


export abstract class Account {
    constructor(
        public name: string,
        public localOrientation: Orientation,
        public parent: AccountFolder | null
    ) { }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }

    public abstract getRootBalance(position: Position, transactions: Transaction[]): number;
    public abstract getRootBalances(transactions: Transaction[]): Map<Position, number>;
    public abstract getBalance(position: Position, transactions: Transaction[]): number;
    public abstract getBalances(transactions: Transaction[]): Map<Position, number>;
}

export class AccountFolder {
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
        txoDisposalMethod: DisposalMethod<TXO>,
        txiDisposalMethod: DisposalMethod<TXI>
    ): StandardAccount {
        const child = new StandardAccount(name, localOrientation, this, txoDisposalMethod, txiDisposalMethod);
        this.addChild(child);
        return child;
    }

    public addFolder(name: string, localOrientation: Orientation): AccountFolder {
        const folder = new AccountFolder(name, localOrientation);
        this.addChild(folder);
        return folder;
    }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }

    public getRootBalance(position: Position, transactions: Transaction[]): number {
        let rootBalance: number = 0;
        for (const child of this.children) rootBalance += child.getRootBalance(position, transactions);
        return rootBalance;
    }

    public getRootBalances(transactions: Transaction[]): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const child of this.children) {
            const rootBalances: Map<Position, number> = child.getRootBalances(transactions);
            for (const [position, rootBalance] of rootBalances) result.set(position, rootBalance + (result.get(position) || 0));
        }

        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return this.getRootBalance(position, transactions) * this.getRootOrientation();
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const [position, rootBalance] of this.getRootBalances(transactions)) result.set(position, rootBalance * this.getRootOrientation());
        return result;
    }
}

export class StandardAccount extends Account {
    public engines: Map<Position, StandardAccountEngine> = new Map();

    constructor(
        name: string,
        localOrientation: Orientation,
        parent: AccountFolder | null,
        public txoDisposalMethod: DisposalMethod<TXO>,
        public txiDisposalMethod: DisposalMethod<TXI>
    ) { super(name, localOrientation, parent); }

    public getRootBalance(position: Position, transactions: Transaction[]): number {
        if (!this.engines.has(position)) return 0;
        return this.getEngine(position).getRootBalance(transactions);
    }

    public getRootBalances(transactions: Transaction[]): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const [position, _engine] of this.engines) result.set(position, this.getRootBalance(position, transactions));
        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return this.getRootBalance(position, transactions) * this.getRootOrientation();
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const [position, rootBalance] of this.getRootBalances(transactions)) result.set(position, rootBalance * this.getRootOrientation());
        return result;
    }

    public getEngine(position: Position): StandardAccountEngine {
        if (!this.engines.has(position)) this.engines.set(position, new StandardAccountEngine(position, this.txoDisposalMethod, this.txiDisposalMethod));
        return this.engines.get(position)!;
    }

    public generateInputs(position: Position, quantity: number, transactions: Transaction[]): Input[] {
        return this.getEngine(position).generateInputs(quantity, transactions);
    }

    public generateOutputs(position: Position, quantity: number, transactions: Transaction[]): Output[] {
        return this.getEngine(position).generateOutputs(quantity, transactions);
    }
}

export class StandardAccountEngine {
    public txos: TXO[] = [];
    public txis: TXI[] = [];

    constructor(
        public position: Position,
        public txoDisposalMethod: DisposalMethod<TXO>,
        public txiDisposalMethod: DisposalMethod<TXI>
    ) { }

    public generateInputs(quantity: number, transactions: Transaction[]): Input[] {
        if (quantity <= 0) throw new Error(`Cannot input a non-positive number from an account`);

        const outputTotal: number = this.txos.reduce((sum, txo) => sum + txo.calculateAvailable(transactions), 0);
        const consumptionTotal: number = Math.min(outputTotal, quantity);
        const consumptionAmounts: Map<TXO, number> | null = consumptionTotal !== 0 ? this.txoDisposalMethod(this.txos, consumptionTotal, transactions) : null;

        let consumptionTotalVerification: number = 0;
        const consumptions: TXOConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([txo, amount]: [TXO, number]): TXOConsumption => {
                consumptionTotalVerification += amount;
                return txo.consume(amount, transactions);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The txoDisposalMethod returned a delta with of ${consumptionTotalVerification} which differs from the amount attempting to input of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0) {
            const txi: TXI = new TXI(remainder, this.position);
            this.txis.push(txi);
            return [...consumptions, txi];
        } else return consumptions;
    }

    public generateOutputs(quantity: number, transactions: Transaction[]): Output[] {
        if (quantity <= 0) throw new Error(`Cannot output a non-positive number from an account`);

        const inputTotal: number = this.txis.reduce((sum, txi) => sum + txi.calculateAvailable(transactions), 0);
        const consumptionTotal: number = Math.min(inputTotal, quantity);
        const consumptionAmounts: Map<TXI, number> | null = consumptionTotal !== 0 ? this.txiDisposalMethod(this.txis, consumptionTotal, transactions) : null;

        let consumptionTotalVerification: number = 0;
        const consumptions: TXIConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([txi, amount]: [TXI, number]): TXIConsumption => {
                consumptionTotalVerification += amount;
                return txi.consume(amount, transactions);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The txiDisposalMethod returned a delta with of ${consumptionTotalVerification} which differs from the amount attempting to output of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0) {
            const txo: TXO = new TXO(remainder, this.position);
            this.txos.push(txo);
            return [...consumptions, txo];
        } else return consumptions;
    }

    public getRootBalance(transactions: Transaction[]): number {
        let rootBalance: number = 0;

        for (const txi of this.txis) rootBalance -= txi.calculateAvailable(transactions);
        for (const txo of this.txos) rootBalance += txo.calculateAvailable(transactions);

        return rootBalance;
    }
}

export class ExchangeAccount extends Account {
    
}