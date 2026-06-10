import type { DisposalMethod } from "./disposal-methods/disposals.js";
import type { Orientation } from "./ledger.js";
import type { Position } from "./positions.js";
import type { Transaction } from "./transactions.js";
import { UTXI, UTXOConsumption, type Input } from "./transactions/inputs.js";
import { UTXO, type Output, type UTXIConsumption } from "./transactions/outputs.js";
import { ExchangedUTXI, ExchangedUTXO, ResidualUTXI, ResidualUTXO } from "./transactions/cross-position.js";
import { scale, unscale } from "./positions.js";

/**
 * Every node in the account tree (leaf account, folder, or computed account) satisfies
 * this interface. Raw balance methods return `bigint` for precision; `getBalance` /
 * `getBalances` return human-readable `number` (orientation-corrected, scaled by
 * `position.decimals`).
 */
export interface AccountNode {
    name: string;
    parent: AccountFolder | null;
    getRootOrientation(): Orientation;
    getRootRawBalance(position: Position, transactions: Transaction[]): bigint;
    getRootRawBalances(transactions: Transaction[]): Map<Position, bigint>;
    getRawBalance(position: Position, transactions: Transaction[]): bigint;
    getRawBalances(transactions: Transaction[]): Map<Position, bigint>;
    getBalance(position: Position, transactions: Transaction[]): number;
    getBalances(transactions: Transaction[]): Map<Position, number>;
    summarize(position: Position, transactions: Transaction[]): NodeSummary;
}

export interface AccountSummary {
    name: string;
    balance: number;
}

export interface FolderSummary {
    name: string;
    balance: number;
    children: NodeSummary[];
}

export type NodeSummary = AccountSummary | FolderSummary;

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

    public addResidualAccount(name: string, localOrientation: Orientation): ResidualAccount {
        const child = new ResidualAccount(name, localOrientation);
        this.addChild(child);
        return child;
    }

    public addExchangeAccount(name: string, localOrientation: Orientation): ExchangePositionsAccount {
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

    public getRootRawBalance(position: Position, transactions: Transaction[]): bigint {
        let sum = 0n;
        for (const child of this.children) sum += child.getRootRawBalance(position, transactions);
        return sum;
    }

    public getRootRawBalances(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const child of this.children) {
            for (const [position, bal] of child.getRootRawBalances(transactions))
                result.set(position, (result.get(position) ?? 0n) + bal);
        }
        return result;
    }

    public getRawBalance(position: Position, transactions: Transaction[]): bigint {
        return BigInt(this.getRootOrientation()) * this.getRootRawBalance(position, transactions);
    }

    public getRawBalances(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position, rootBal] of this.getRootRawBalances(transactions))
            result.set(position, BigInt(this.getRootOrientation()) * rootBal);
        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return unscale(this.getRawBalance(position, transactions), position);
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result = new Map<Position, number>();
        for (const [pos, raw] of this.getRawBalances(transactions)) result.set(pos, unscale(raw, pos));
        return result;
    }

    public summarize(position: Position, transactions: Transaction[]): FolderSummary {
        const children: NodeSummary[] = this.children.map(child => child.summarize(position, transactions));
        return { name: this.name, balance: this.getBalance(position, transactions), children };
    }
}

/**
 * Base class for read-only accounts whose balance is derived by scanning the transaction
 * history rather than being tracked via explicit lot entries. Subclasses implement
 * `getRootRawBalance` and `getRootRawBalances`; the common orientation and display logic
 * lives here. No `generateInputs` or `generateOutputs` — these accounts cannot be used
 * as sources or destinations in transaction construction.
 */
export abstract class ComputedAccount implements AccountNode {
    public parent: AccountFolder | null = null;

    constructor(
        public name: string,
        public localOrientation: Orientation
    ) {}

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }

    public abstract getRootRawBalance(position: Position, transactions: Transaction[]): bigint;
    public abstract getRootRawBalances(transactions: Transaction[]): Map<Position, bigint>;

    public getRawBalance(position: Position, transactions: Transaction[]): bigint {
        return BigInt(this.getRootOrientation()) * this.getRootRawBalance(position, transactions);
    }

    public getRawBalances(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position, rootBal] of this.getRootRawBalances(transactions))
            result.set(position, BigInt(this.getRootOrientation()) * rootBal);
        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return unscale(this.getRawBalance(position, transactions), position);
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result = new Map<Position, number>();
        for (const [pos, raw] of this.getRawBalances(transactions)) result.set(pos, unscale(raw, pos));
        return result;
    }

    public summarize(position: Position, transactions: Transaction[]): AccountSummary {
        return { name: this.name, balance: this.getBalance(position, transactions) };
    }
}

/**
 * Tracks all open exchange positions across the transaction history as an equity account.
 * Scans every {@link ExchangedUTXO} (from-side) and {@link ExchangedUTXI} (to-side) for their
 * remaining availability. Matched exchange pairs at the same locked rate cancel to zero, so
 * only truly unresolved positions carry a balance.
 *
 * Adding this as a child of the equity folder ensures `equity.getRootRawBalances()` includes
 * open positions automatically — no adjustment is needed inside `ledger.verify()`.
 */
export class ExchangePositionsAccount extends ComputedAccount {
    public getRootRawBalance(position: Position, transactions: Transaction[]): bigint {
        let balance = 0n;
        for (const tx of transactions) {
            for (const output of tx.outputs)
                if (output instanceof ExchangedUTXO && output.position === position)
                    balance += output.calculateAvailable(transactions);
            for (const input of tx.inputs)
                if (input instanceof ExchangedUTXI && input.position === position)
                    balance -= input.calculateAvailable(transactions);
        }
        return balance;
    }

    public getRootRawBalances(transactions: Transaction[]): Map<Position, bigint> {
        const positions = new Set<Position>();
        for (const tx of transactions) {
            for (const output of tx.outputs)
                if (output instanceof ExchangedUTXO) positions.add(output.position);
            for (const input of tx.inputs)
                if (input instanceof ExchangedUTXI) positions.add(input.position);
        }
        const result = new Map<Position, bigint>();
        for (const position of positions) {
            const balance = this.getRootRawBalance(position, transactions);
            if (balance !== 0n) result.set(position, balance);
        }
        return result;
    }
}

/**
 * Tracks recognized gains and losses from exchanges as an equity account. Unlike the scan-based
 * {@link ExchangePositionsAccount}, this account owns its residual lots directly — each
 * {@link ResidualUTXI} (gain) and {@link ResidualUTXO} (loss) is registered here via
 * {@link addResidualInput} / {@link addResidualOutput}, called by the `exchange()` equity-policy
 * function. Multiple ResidualAccounts (e.g. "Capital Gains", "FX Gains", "Profit") can coexist
 * without crosstalk because each owns its own lot lists.
 *
 * Gains reduce the root balance (increasing equity inside a positive-orientation equity folder
 * like netIncome); losses increase it.
 */
export class ResidualAccount extends ComputedAccount {
    private readonly utxis: ResidualUTXI[] = [];
    private readonly utxos: ResidualUTXO[] = [];

    public addResidualInput(quantity: bigint, position: Position, originBasis: Map<Position, bigint>): ResidualUTXI {
        const utxi = new ResidualUTXI(quantity, position, originBasis);
        this.utxis.push(utxi);
        return utxi;
    }

    public addResidualOutput(quantity: bigint, position: Position, originBasis: Map<Position, bigint>): ResidualUTXO {
        const utxo = new ResidualUTXO(quantity, position, originBasis);
        this.utxos.push(utxo);
        return utxo;
    }

    public getRootRawBalance(position: Position, transactions: Transaction[]): bigint {
        let balance = 0n;
        for (const utxi of this.utxis)
            if (utxi.position === position) balance -= utxi.calculateAvailable(transactions);
        for (const utxo of this.utxos)
            if (utxo.position === position) balance += utxo.calculateAvailable(transactions);
        return balance;
    }

    public getRootRawBalances(transactions: Transaction[]): Map<Position, bigint> {
        const positions = new Set<Position>([
            ...this.utxis.map(t => t.position),
            ...this.utxos.map(t => t.position),
        ]);
        const result = new Map<Position, bigint>();
        for (const position of positions) {
            const balance = this.getRootRawBalance(position, transactions);
            if (balance !== 0n) result.set(position, balance);
        }
        return result;
    }
}

/**
 * Per-position lot store for a single {@link Account}. Holds the raw {@link UTXO} and
 * {@link UTXI} lists and implements the generation logic using the account's configured
 * {@link DisposalMethod}s. Not instantiated directly — created on demand by `Account.getEngine`.
 */
export class AccountEngine {
    public readonly utxos: UTXO[] = [];
    public readonly utxis: UTXI[] = [];

    constructor(
        public readonly position: Position,
        public readonly utxoDisposalMethod: DisposalMethod<UTXO>,
        public readonly utxiDisposalMethod: DisposalMethod<UTXI>
    ) { }

    public generateInputs(humanValue: number, transactions: Transaction[]): Input[] {
        return this.generateInputsRaw(scale(humanValue, this.position), transactions);
    }

    public generateInputsRaw(quantity: bigint, transactions: Transaction[]): Input[] {
        if (quantity <= 0n) throw new Error(`Cannot input a non-positive number from an account`);

        const outputTotal: bigint = this.utxos.reduce((sum, utxo) => sum + utxo.calculateAvailable(transactions), 0n);
        const consumptionTotal: bigint = outputTotal < quantity ? outputTotal : quantity;
        const consumptionAmounts: Map<UTXO, bigint> | null = consumptionTotal !== 0n ? this.utxoDisposalMethod(this.utxos, consumptionTotal, transactions) : null;

        let consumptionTotalVerification: bigint = 0n;
        const consumptions: UTXOConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([utxo, amount]: [UTXO, bigint]): UTXOConsumption => {
                consumptionTotalVerification += amount;
                return utxo.consume(amount, transactions);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The utxoDisposalMethod returned a delta of ${consumptionTotalVerification} which differs from the amount attempting to input of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0n) {
            const utxi: UTXI = new UTXI(remainder, this.position);
            this.utxis.push(utxi);
            return [...consumptions, utxi];
        } else return consumptions;
    }

    public generateOutputs(humanValue: number, transactions: Transaction[]): Output[] {
        return this.generateOutputsRaw(scale(humanValue, this.position), transactions);
    }

    public generateOutputsRaw(quantity: bigint, transactions: Transaction[]): Output[] {
        if (quantity <= 0n) throw new Error(`Cannot output a non-positive number from an account`);

        const inputTotal: bigint = this.utxis.reduce((sum, utxi) => sum + utxi.calculateAvailable(transactions), 0n);
        const consumptionTotal: bigint = inputTotal < quantity ? inputTotal : quantity;
        const consumptionAmounts: Map<UTXI, bigint> | null = consumptionTotal !== 0n ? this.utxiDisposalMethod(this.utxis, consumptionTotal, transactions) : null;

        let consumptionTotalVerification: bigint = 0n;
        const consumptions: UTXIConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([utxi, amount]: [UTXI, bigint]): UTXIConsumption => {
                consumptionTotalVerification += amount;
                return utxi.consume(amount, transactions);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The utxiDisposalMethod returned a delta of ${consumptionTotalVerification} which differs from the amount attempting to output of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0n) {
            const utxo: UTXO = new UTXO(remainder, this.position);
            this.utxos.push(utxo);
            return [...consumptions, utxo];
        } else return consumptions;
    }

    public getRootBalance(transactions: Transaction[]): bigint {
        let rootBalance = 0n;
        for (const utxi of this.utxis) rootBalance -= utxi.calculateAvailable(transactions);
        for (const utxo of this.utxos) rootBalance += utxo.calculateAvailable(transactions);
        return rootBalance;
    }
}
