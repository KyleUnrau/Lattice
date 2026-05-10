import { TXI, TXO } from "./transactions.js";
import type { Position } from "./positions.js";
import type { StagedGroupedInput, StagedGroupedOutput, StagedTXI, StagedTXIConsumption, StagedTXO, StagedTXOConsumption } from "./transactions.js";

export enum Orientation {
    Positive = 1,
    Negative = -1
}

export type AccountNode = Account | AccountFolder;

export class Account {
    constructor(
        public name: string,
        public localOrientation: Orientation,
        public parent: AccountFolder | null = null,
    ) { }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
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

    public addChild(child: AccountNode): void {
        this.children.push(child);
        child.parent = this;
    }

    public addAccount(name: string, localOrientation: Orientation): Account {
        const child = new Account(name, localOrientation);
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
}

export type DisposalMethod<T extends TXO | TXI> = (components: T[], delta: number) => Map<T, number>;

export class AccountTransactionEngine {
    public txos: TXO[] = [];
    public txis: TXI[] = [];

    constructor(
        public position: Position,
        public txoDisposalMethod: DisposalMethod<TXO>,
        public txiDisposalMethod: DisposalMethod<TXI>
    ) {}

    public inputStage(quantity: number): StagedGroupedInput {
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
            return {stagedType: "grouped-input", inputs: [...consumptions, input]};
        } else return {stagedType: "grouped-input", inputs: consumptions};
    }

    public outputStage(quantity: number): StagedGroupedOutput {
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
            return {stagedType: "grouped-output", outputs: [...consumptions, output]};
        } else return {stagedType: "grouped-output", outputs: consumptions};
    }


    public calculateRootBalance(): number {
        let rootBalance: number = 0;

        for (const txi of this.txis) rootBalance -= txi.calculateAvailable();
        for (const txo of this.txos) rootBalance += txo.calculateAvailable();

        return rootBalance;
    }
}