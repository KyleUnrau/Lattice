import type { Orientation } from "../ledger.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { ExchangedUTXI, ExchangedUTXO, ResidualUTXI } from "../transactions/cross-position.js";
import type { ExchangeAccountMarker } from "../transactions/cross-position.js";
import { TerminalUTXO } from "../transactions/terminal.js";
import { unscale } from "../positions.js";
import type { AccountNode } from "./node.js";
import type { AccountSummary } from "./summary.js";
import type { AccountFolder } from "./folder.js";

/**
 * Base class for read-only accounts whose balance is derived by scanning the transaction
 * history rather than being tracked via explicit lot entries. Subclasses implement
 * `getSignedBalanceScaled` and `getSignedBalancesScaled`; the common orientation and display
 * logic lives here. No `generateInputs` or `generateOutputs` — these accounts cannot be used
 * as sources or destinations in transaction construction.
 */
export abstract class ComputedAccount implements AccountNode {
    public parent: AccountFolder | null = null;

    constructor(
        public name: string,
        public localOrientation: Orientation
    ) {}

    public getEffectiveOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getEffectiveOrientation() * this.localOrientation;
    }

    public abstract getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint;
    public abstract getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint>;

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
 * Adding this as a child of the equity folder ensures `equity.getSignedBalancesScaled()` includes
 * open positions automatically — no adjustment is needed inside `ledger.verify()`.
 */
export class ExchangeAccount extends ComputedAccount implements ExchangeAccountMarker {
    public getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint {
        let balance = 0n;
        for (const tx of transactions) {
            for (const output of tx.outputs)
                if (output instanceof ExchangedUTXO && output.position === position
                        && (output.exchange.account === undefined || output.exchange.account === this))
                    balance += output.calculateAvailable(transactions);
            for (const input of tx.inputs)
                if (input instanceof ExchangedUTXI && input.position === position
                        && (input.exchange.account === undefined || input.exchange.account === this))
                    balance -= input.calculateAvailable(transactions);
        }
        return balance;
    }

    public getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint> {
        const positions = new Set<Position>();
        for (const tx of transactions) {
            for (const output of tx.outputs)
                if (output instanceof ExchangedUTXO && (output.exchange.account === undefined || output.exchange.account === this))
                    positions.add(output.position);
            for (const input of tx.inputs)
                if (input instanceof ExchangedUTXI && (input.exchange.account === undefined || input.exchange.account === this))
                    positions.add(input.position);
        }
        const result = new Map<Position, bigint>();
        for (const position of positions) {
            const balance = this.getSignedBalanceScaled(position, transactions);
            if (balance !== 0n) result.set(position, balance);
        }
        return result;
    }
}

/**
 * Tracks recognized **gains** as an equity account. A gain is a *directional suspended residual
 * edge*: a {@link ResidualUTXI} carrying its origin-position residual-basis, recognized at its
 * surface and able to later carry back toward its origin. Unlike the scan-based
 * {@link ExchangeAccount}, this account owns its residual lots directly — each is registered via
 * {@link addResidualInput}, called by {@link ExchangeResolution} and {@link ExpenseResolution}.
 * Multiple ResidualAccounts (e.g. "Capital Gains", "FX Gains") can coexist without crosstalk.
 *
 * Losses are **not** held here — they are terminal and settle into a {@link TerminalAccount} at
 * their cost-basis origin. Gains reduce the root balance (increasing equity inside a
 * positive-orientation equity folder like netIncome).
 */
export class ResidualAccount extends ComputedAccount {
    private readonly utxis: ResidualUTXI[] = [];

    /**
     * @param negativeLabel - When provided, `summarize()` returns this name instead of `name`
     *   whenever the balance in the queried position is negative. Enables a single account to
     *   display as e.g. "Capital Gains" when net-positive and "Capital Losses" when net-negative.
     */
    constructor(name: string, localOrientation: Orientation, public readonly negativeLabel?: string) {
        super(name, localOrientation);
    }

    public override summarize(position: Position, transactions: Transaction[]): AccountSummary {
        const balance = this.getBalance(position, transactions);
        const name = this.negativeLabel !== undefined && balance < 0 ? this.negativeLabel : this.name;
        return { name, balance };
    }

    public addResidualInput(quantity: bigint, position: Position, originBasis: Map<Position, bigint>): ResidualUTXI {
        const utxi = new ResidualUTXI(quantity, position, originBasis, this);
        this.utxis.push(utxi);
        return utxi;
    }

    public getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint {
        let balance = 0n;
        for (const utxi of this.utxis)
            if (utxi.position === position && utxi.isCommitted(transactions)) balance -= utxi.calculateAvailable(transactions);
        return balance;
    }

    public getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint> {
        const positions = new Set<Position>(this.utxis.map(t => t.position));
        const result = new Map<Position, bigint>();
        for (const position of positions) {
            const balance = this.getSignedBalanceScaled(position, transactions);
            if (balance !== 0n) result.set(position, balance);
        }
        return result;
    }
}

/**
 * Routes recognized residual value: gains to a {@link ResidualAccount} (a suspended residual-basis
 * edge that may later carry back), losses to a {@link TerminalAccount} (a final sink at origin —
 * losses are terminal, never movable destination lots).
 */
export type ResidualTarget = { gain: ResidualAccount; loss: TerminalAccount; };

/** Returns the {@link ResidualAccount} that should receive gain residuals from `target`. */
export function gainAccountOf(target: ResidualTarget): ResidualAccount {
    return target.gain;
}

/** Returns the {@link TerminalAccount} that should sink loss settlements from `target`. */
export function lossAccountOf(target: ResidualTarget): TerminalAccount {
    return target.loss;
}

/**
 * A **terminal sink** for final origin-basis settlement events — expenses, realized exchange losses,
 * and negative-residual settlements. Unlike an ordinary {@link Account}, it owns no
 * {@link PositionLotStore} and has **no** `generateInputs`/`generateOutputs`: it can never be a
 * transaction *source*, and the {@link TerminalUTXO}s it emits are non-consumable. It therefore
 * records final settlement value (participating in net-zero and summaries) without ever becoming
 * spendable inventory.
 *
 * Recognitions are minted via {@link recognize}, which returns a {@link TerminalUTXO} the caller
 * places in a transaction's outputs. The balance is the sum of this account's committed terminal
 * records — mirroring how an expense {@link Account}'s UTXO debits accumulate.
 */
export class TerminalAccount extends ComputedAccount {
    private readonly terminals: TerminalUTXO[] = [];

    /** Mints a terminal settlement record for `quantity` in `position`, owned by this account. Place it in a transaction's outputs. */
    public recognize(quantity: bigint, position: Position): TerminalUTXO {
        const terminal = new TerminalUTXO(quantity, position, this);
        this.terminals.push(terminal);
        return terminal;
    }

    public getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint {
        let balance = 0n;
        for (const terminal of this.terminals)
            if (terminal.position === position && terminal.isCommitted(transactions)) balance += terminal.calculateAvailable(transactions);
        return balance;
    }

    public getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint> {
        const positions = new Set<Position>(this.terminals.map(t => t.position));
        const result = new Map<Position, bigint>();
        for (const position of positions) {
            const balance = this.getSignedBalanceScaled(position, transactions);
            if (balance !== 0n) result.set(position, balance);
        }
        return result;
    }
}
