import type { Orientation } from "../ledger.js";
import type { Position } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { ExchangedUTXI, ExchangedUTXO, ResidualUTXI, ResidualUTXO } from "../transactions/cross-position.js";
import type { ExchangeAccountMarker } from "../transactions/cross-position.js";
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

    public getBalanceRaw(position: Position, transactions: Transaction[]): bigint {
        return BigInt(this.getEffectiveOrientation()) * this.getSignedBalanceScaled(position, transactions);
    }

    public getBalancesRaw(transactions: Transaction[]): Map<Position, bigint> {
        const result = new Map<Position, bigint>();
        for (const [position, signed] of this.getSignedBalancesScaled(transactions))
            result.set(position, BigInt(this.getEffectiveOrientation()) * signed);
        return result;
    }

    public getBalance(position: Position, transactions: Transaction[]): number {
        return unscale(this.getBalanceRaw(position, transactions), position);
    }

    public getBalances(transactions: Transaction[]): Map<Position, number> {
        const result = new Map<Position, number>();
        for (const [pos, raw] of this.getBalancesRaw(transactions)) result.set(pos, unscale(raw, pos));
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
export class ExchangePositionsAccount extends ComputedAccount implements ExchangeAccountMarker {
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

    public addResidualOutput(quantity: bigint, position: Position, originBasis: Map<Position, bigint>): ResidualUTXO {
        const utxo = new ResidualUTXO(quantity, position, originBasis, this);
        this.utxos.push(utxo);
        return utxo;
    }

    public getSignedBalanceScaled(position: Position, transactions: Transaction[]): bigint {
        let balance = 0n;
        for (const utxi of this.utxis)
            if (utxi.position === position && utxi.isCommitted(transactions)) balance -= utxi.calculateAvailable(transactions);
        for (const utxo of this.utxos)
            if (utxo.position === position && utxo.isCommitted(transactions)) balance += utxo.calculateAvailable(transactions);
        return balance;
    }

    public getSignedBalancesScaled(transactions: Transaction[]): Map<Position, bigint> {
        const positions = new Set<Position>([
            ...this.utxis.map(t => t.position),
            ...this.utxos.map(t => t.position),
        ]);
        const result = new Map<Position, bigint>();
        for (const position of positions) {
            const balance = this.getSignedBalanceScaled(position, transactions);
            if (balance !== 0n) result.set(position, balance);
        }
        return result;
    }
}