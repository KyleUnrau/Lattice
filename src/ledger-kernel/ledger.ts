import type { Position } from "./positions.js";
import type { Output, StagedGroupedOutput, StagedOutput, StagedTXIConsumption, StagedTXO, TXO } from "./transactions/outputs.js";
import type { TXI, StagedGroupedInput, StagedTXOConsumption, StagedTXI, StagedInput, Input } from "./transactions/inputs.js";
import type { Result } from "../utils.js";
import { Transaction } from "./transactions.js";
import type { DisposalMethod } from "./disposal-methods/disposals.js";

export enum Orientation {
    Positive = 1,
    Negative = -1
}

export class Ledger {
    public transactions: Transaction[] = [];

    constructor(
        public netAssets: AccountFolder,
        public equity: AccountFolder
    ) {}

    public newTransaction(stagedInputs: StagedInput[], stagedOutputs: StagedOutput[]): Transaction {
        const transaction = new Transaction(stagedInputs, stagedOutputs);
        this.transactions.push(transaction);
        return transaction;
    }

    public exchangePosition(from: Output, to: Input): void {
        from.exchangedInput = to;
        to.exchangedOutput = from;
    }

    public verify(): Result<undefined, Error> {
        const rootBalances: Map<Position, number> = this.getRootBalances();

        for (const [position, rootBalance] of rootBalances) {
            if (rootBalance !== 0) return {ok: false, error: new Error(`Ledger invalid, root balance for ${position.name} calculated as ${rootBalance} instead of 0`)};
        }

        return {ok: true, value: undefined};
    }

    public getRootBalances(): Map<Position, number> {
        const rootBalances: Map<Position, number> = new Map();

        for (const [position, rootBalance] of this.netAssets.getRootBalances()) rootBalances.set(position, rootBalance + (rootBalances.get(position) || 0));
        for (const [position, rootBalance] of this.equity.getRootBalances()) rootBalances.set(position, rootBalance + (rootBalances.get(position) || 0));

        return rootBalances;
    }
}

export type AccountNode = Account | AccountFolder;

export class Account {
    public positionEngines: Map<Position, AccountTransactionEngine> = new Map();

    constructor(
        public name: string,
        public localOrientation: Orientation,
        public parent: AccountFolder | null,
        public txoDisposalMethod: DisposalMethod<TXO>,
        public txiDisposalMethod: DisposalMethod<TXI>
    ) { }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }

    public getRootBalance(position: Position): number {
        if (!this.positionEngines.has(position)) return 0;
        return this.getEngine(position).getRootBalance();
    }

    public getRootBalances(): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const [position, engine] of this.positionEngines) result.set(position, engine.getRootBalance());
        return result;
    }

    public getBalance(position: Position): number {
        return this.getRootBalance(position) * this.getRootOrientation();
    }

    public getBalances(): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const [position, rootBalance] of this.getRootBalances()) result.set(position, rootBalance * this.getRootOrientation());
        return result;
    }

    public getEngine(position: Position): AccountTransactionEngine {
        if (!this.positionEngines.has(position)) this.positionEngines.set(position, new AccountTransactionEngine(position, this.txoDisposalMethod, this.txiDisposalMethod));
        return this.positionEngines.get(position)!;
    }

    public stageOutput(position: Position, quantity: number): StagedOutput {
        return this.getEngine(position).stageOutput(quantity);
    }

    public stageInput(position: Position, quantity: number): StagedInput {
        return this.getEngine(position).stageInput(quantity);
    }
}

export class AccountFolder {
    constructor(
        public name: string,
        public localOrientation: Orientation,
        public children: AccountNode[] = [],
        public parent: AccountFolder | null = null,
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
    ): Account {
        const child = new Account(name, localOrientation, this, txoDisposalMethod, txiDisposalMethod);
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

    public getRootBalance(position: Position): number {
        let rootBalance: number = 0;
        for (const child of this.children) rootBalance += child.getRootBalance(position);
        return rootBalance;
    }

    public getRootBalances(): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const child of this.children) {
            const rootBalances: Map<Position, number> = child.getRootBalances();
            for (const [position, rootBalance] of rootBalances) result.set(position, rootBalance + (result.get(position) || 0));
        }

        return result;
    }

    public getBalance(position: Position): number {
        return this.getRootBalance(position) * this.getRootOrientation();
    }

    public getBalances(): Map<Position, number> {
        const result: Map<Position, number> = new Map();
        for (const [position, rootBalance] of this.getRootBalances()) result.set(position, rootBalance * this.getRootOrientation());
        return result;
    }
}

export class AccountTransactionEngine {
    public txos: TXO[] = [];
    public txis: TXI[] = [];

    constructor(
        public position: Position,
        public txoDisposalMethod: DisposalMethod<TXO>,
        public txiDisposalMethod: DisposalMethod<TXI>
    ) {}

    public stageInput(quantity: number): StagedTXI | StagedGroupedInput {
        if (quantity <= 0) throw new Error(`Cannot input a non-positive number from an account`);

        const outputTotal: number = this.txos.reduce((sum, txo) => sum + txo.calculateAvailable(), 0);
        const consumptionTotal: number = Math.min(outputTotal, quantity);
        const consumptionAmounts: Map<TXO, number> | null = consumptionTotal !== 0 ? this.txoDisposalMethod(this.txos, consumptionTotal) : null;

        let consumptionTotalVerification: number = 0;
        const consumptions: StagedTXOConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([txo, amount]: [TXO, number]): StagedTXOConsumption => {
                consumptionTotalVerification += amount;
                return txo.consumeStage(amount);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The txoDisposalMethod returned a delta with of ${consumptionTotalVerification} which differs from the amount attempting to input of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0) {
            const input: StagedTXI = {stagedType: "txi", quantity: remainder, position: this.position, accountEngine: this};
            if (consumptions.length === 0) return input;
            return {stagedType: "grouped-input", inputs: [...consumptions, input]};
        } else return {stagedType: "grouped-input", inputs: consumptions};
    }

    public stageOutput(quantity: number): StagedTXO | StagedGroupedOutput {
        if (quantity <= 0) throw new Error(`Cannot output a non-positive number from an account`);
        
        const inputTotal: number = this.txis.reduce((sum, txi) => sum + txi.calculateAvailable(), 0);
        const consumptionTotal: number = Math.min(inputTotal, quantity);
        const consumptionAmounts: Map<TXI, number> | null = consumptionTotal !== 0 ? this.txiDisposalMethod(this.txis, consumptionTotal) : null;

        let consumptionTotalVerification: number = 0;
        const consumptions: StagedTXIConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([txi, amount]: [TXI, number]): StagedTXIConsumption => {
                consumptionTotalVerification += amount;
                return txi.consumeStage(amount);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The txiDisposalMethod returned a delta with of ${consumptionTotalVerification} which differs from the amount attempting to output of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0) {
            const output: StagedTXO = {stagedType: "txo", quantity: remainder, position: this.position, accountEngine: this};
            if (consumptions.length === 0) return output;
            return {stagedType: "grouped-output", outputs: [...consumptions, output]};
        } else return {stagedType: "grouped-output", outputs: consumptions};
    }

    public getRootBalance(): number {
        let rootBalance: number = 0;

        for (const txi of this.txis) rootBalance -= txi.calculateAvailable();
        for (const txo of this.txos) rootBalance += txo.calculateAvailable();

        return rootBalance;
    }
}