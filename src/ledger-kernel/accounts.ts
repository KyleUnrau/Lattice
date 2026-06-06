import type { DisposalMethod } from "./disposal-methods/disposals.js";
import type { Orientation } from "./ledger.js";
import type { Position } from "./positions.js";
import type { Transaction } from "./transactions.js";
import { TXI, TXOConsumption, type Input } from "./transactions/inputs.js";
import { TXO, type Output, type TXIConsumption } from "./transactions/outputs.js";
import { ExchangedTXI, ExchangedTXO, ResidualTXI, ResidualTXO, type Exchange } from "./transactions/exchange.js";

export type AccountNode = Account | AccountFolder | ComputedAccount;

/**
 * Manages per-position {@link AccountEngine}s containing TXO and TXI lots. Implements
 * the double-sided ledger entry point: `generateInputs` pulls value out (spending/disposal)
 * by consuming existing TXO lots; `generateOutputs` pushes value in (receipt/income) by
 * settling existing TXI obligations. Both methods use the account's configured
 * {@link DisposalMethod}s for lot selection.
 */
export class Account {
    public readonly engines: Map<Position, AccountEngine> = new Map();

    constructor(
        public name: string,
        public localOrientation: Orientation,
        public parent: AccountFolder | null,
        public readonly txoDisposalMethod: DisposalMethod<TXO>,
        public readonly txiDisposalMethod: DisposalMethod<TXI>
    ) { }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }

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

    public getEngine(position: Position): AccountEngine {
        if (!this.engines.has(position)) this.engines.set(position, new AccountEngine(position, this.txoDisposalMethod, this.txiDisposalMethod));
        return this.engines.get(position)!;
    }

    public generateInputs(position: Position, quantity: number, transactions: Transaction[]): Input[] {
        return this.getEngine(position).generateInputs(quantity, transactions);
    }

    public generateOutputs(position: Position, quantity: number, transactions: Transaction[]): Output[] {
        return this.getEngine(position).generateOutputs(quantity, transactions);
    }
}

/**
 * A named node in the account tree that groups {@link Account}s and sub-folders.
 * Propagates {@link Orientation} multiplicatively to all descendants so root balance
 * polarity emerges from the hierarchy rather than from hardcoded debit/credit labels.
 */
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
    ): Account {
        const child = new Account(name, localOrientation, this, txoDisposalMethod, txiDisposalMethod);
        this.addChild(child);
        return child;
    }

    public addResidualAccount(
        name: string,
        localOrientation: Orientation
    ): ResidualAccount {
        const child = new ResidualAccount(name, localOrientation);
        this.addChild(child);
        return child;
    }

    public addExchangeAccount(
        name: string,
        localOrientation: Orientation
    ): ExchangePositionsAccount {
        const child = new ExchangePositionsAccount(name, localOrientation);
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

/**
 * Per-position lot store for a single {@link Account}. Holds the raw {@link TXO} and
 * {@link TXI} lists and implements the generation logic using the account's configured
 * {@link DisposalMethod}s. Not instantiated directly — created on demand by `Account.getEngine`.
 */
export class AccountEngine {
    public readonly txos: TXO[] = [];
    public readonly txis: TXI[] = [];

    constructor(
        public readonly position: Position,
        public readonly txoDisposalMethod: DisposalMethod<TXO>,
        public readonly txiDisposalMethod: DisposalMethod<TXI>
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

/**
 * Base class for read-only accounts whose balance is derived by scanning the transaction
 * history rather than being tracked via explicit lot entries. Subclasses implement
 * `getRootBalance` and `getRootBalances`; the common orientation and display logic lives here.
 * No `generateInputs` or `generateOutputs` — these accounts cannot be used as sources or
 * destinations in transaction construction.
 */
export abstract class ComputedAccount {
    public parent: AccountFolder | null = null;

    constructor(
        public name: string,
        public localOrientation: Orientation
    ) {}

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }

    public abstract getRootBalance(position: Position, transactions: Transaction[]): number;
    public abstract getRootBalances(transactions: Transaction[]): Map<Position, number>;

    public getBalance(position: Position, transactions: Transaction[]): number {
        return this.getRootBalance(position, transactions) * this.getRootOrientation();
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result = new Map<Position, number>();
        for (const [position, rootBalance] of this.getRootBalances(transactions))
            result.set(position, rootBalance * this.getRootOrientation());
        return result;
    }
}

/**
 * Tracks all open exchange positions across the transaction history as an equity account.
 * Scans every {@link ExchangedTXO} (from-side) and {@link ExchangedTXI} (to-side) for their
 * remaining availability. Matched exchange pairs at the same locked rate cancel to zero, so
 * only truly unresolved positions carry a balance.
 *
 * Adding this as a child of the equity folder ensures `equity.getRootBalances()` includes
 * open positions automatically — no adjustment is needed inside `ledger.verify()`.
 */
export class ExchangePositionsAccount extends ComputedAccount {
    public getRootBalance(position: Position, transactions: Transaction[]): number {
        let balance = 0;
        for (const tx of transactions) {
            for (const output of tx.outputs)
                if (output instanceof ExchangedTXO && output.position === position)
                    balance += output.calculateAvailable(transactions);
            for (const input of tx.inputs)
                if (input instanceof ExchangedTXI && input.position === position)
                    balance -= input.calculateAvailable(transactions);
        }
        return balance;
    }

    public getRootBalances(transactions: Transaction[]): Map<Position, number> {
        const positions = new Set<Position>();
        for (const tx of transactions) {
            for (const output of tx.outputs)
                if (output instanceof ExchangedTXO) positions.add(output.position);
            for (const input of tx.inputs)
                if (input instanceof ExchangedTXI) positions.add(input.position);
        }
        const result = new Map<Position, number>();
        for (const position of positions) {
            const balance = this.getRootBalance(position, transactions);
            if (balance !== 0) result.set(position, balance);
        }
        return result;
    }
}

/**
 * Tracks recognized gains and losses from exchanges as an equity account. Unlike the scan-based
 * {@link ExchangePositionsAccount}, this account owns its residual lots directly — each
 * {@link ResidualTXI} (gain) and {@link ResidualTXO} (loss) is registered here via
 * {@link addResidualInput} / {@link addResidualOutput}, called by the `exchange()` equity-policy
 * function. Multiple ResidualAccounts (e.g. "Capital Gains", "FX Gains", "Profit") can coexist
 * without crosstalk because each owns its own lot lists.
 *
 * Gains reduce the root balance (increasing equity inside a positive-orientation equity folder
 * like netIncome); losses increase it.
 */
export class ResidualAccount extends ComputedAccount {
    private readonly txis: ResidualTXI[] = [];
    private readonly txos: ResidualTXO[] = [];

    public addResidualInput(quantity: number, position: Position, exchange: Exchange | null): ResidualTXI {
        const txi = new ResidualTXI(quantity, position, exchange);
        this.txis.push(txi);
        return txi;
    }

    public addResidualOutput(quantity: number, position: Position, exchange: Exchange | null): ResidualTXO {
        const txo = new ResidualTXO(quantity, position, exchange);
        this.txos.push(txo);
        return txo;
    }

    public getRootBalance(position: Position, transactions: Transaction[]): number {
        let balance = 0;
        for (const txi of this.txis)
            if (txi.position === position) balance -= txi.calculateAvailable(transactions);
        for (const txo of this.txos)
            if (txo.position === position) balance += txo.calculateAvailable(transactions);
        return balance;
    }

    public getRootBalances(transactions: Transaction[]): Map<Position, number> {
        const positions = new Set<Position>([
            ...this.txis.map(t => t.position),
            ...this.txos.map(t => t.position),
        ]);
        const result = new Map<Position, number>();
        for (const position of positions) {
            const balance = this.getRootBalance(position, transactions);
            if (balance !== 0) result.set(position, balance);
        }
        return result;
    }
}
