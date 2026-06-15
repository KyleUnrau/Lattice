import { BookValueEngine } from "./equity-policy/book-value/engine.js";
import { ExchangeResolution, ExchangeTransactions } from "./equity-policy/exchange.js";
import { ExpenseResolution, type ExpenseTransactions } from "./equity-policy/expense.js";
import type { Account } from "./ledger-kernel/accounts/account.js";
import type { ExchangeAccount, ResidualAccount } from "./ledger-kernel/accounts/computed.js";
import { AccountFolder } from "./ledger-kernel/accounts/folder.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import type { Position } from "./ledger-kernel/positions.js";
import type { Transaction } from "./ledger-kernel/transactions.js";
import type { UTXI } from "./ledger-kernel/transactions/inputs.js";
import type { UTXO } from "./ledger-kernel/transactions/outputs.js";

/**
 * A self-contained, serialization-ready handle on a ledger for the explorer. Bundles the
 * {@link Ledger} (which owns the transaction history) with the live {@link BookValueEngine}
 * and the list of {@link Position}s that appear in the book. The server reads — never mutates —
 * this view, and builds fresh per-slice engines for as-of basis queries.
 */
export interface LedgerView {
    ledger: Ledger;
    engine: BookValueEngine;
    positions: Position[];
}

export namespace ScenarioExpensesCase1 {
    interface Positions {
        cad: Position;
        usd: Position;
    }

    export const positions: Positions = {
        cad: { name: "Canadian Dollars", decimals: 2 },
        usd: { name: "United States Dollars", decimals: 2 }
    }

    interface Accounts {
        netAssets: AccountFolder;
        equity: AccountFolder;

        assets: AccountFolder;
        cash: Account;

        openingBalance: Account;
        capitalGainsOrLosses: ResidualAccount;
        netTransfers: ExchangeAccount;

        netIncome: AccountFolder;
        expenses: AccountFolder;
        groceryExpense: Account;
    }

    function generateAccounts(): Accounts {
        const netAssets = new AccountFolder("Net Assets", Orientation.Positive);
        const equity = new AccountFolder("Net Worth", Orientation.Negative);

        const assets = netAssets.addFolder("Assets", Orientation.Positive);
        const cash = assets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);

        const openingBalance = equity.addAccount("Opening Balance", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
        const capitalGainsOrLosses = equity.addResidualAccount("Capital Gains", Orientation.Positive, "Capital Losses");
        const netTransfers = equity.addExchangeAccount("Net Transfers", Orientation.Positive);

        const netIncome = equity.addFolder("Net Income", Orientation.Positive);
        const expenses = netIncome.addFolder("Expenses", Orientation.Negative);
        const groceryExpense = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
        
        return {
            netAssets,
            equity,
            assets,
            cash,
            openingBalance,
            capitalGainsOrLosses,
            netTransfers,
            netIncome,
            expenses,
            groceryExpense,
        };
    }

    export const accounts = generateAccounts();

    export const ledger: Ledger = new Ledger(accounts.netAssets, accounts.equity);
    export const engine = new BookValueEngine(ledger.transactions);

    export const phases = {
        phase0: (): Transaction => {
            const inputs = accounts.openingBalance.generateInputs(positions.cad, 1000, ledger.transactions);
            const outputs = accounts.cash.generateOutputs(positions.cad, 1000, ledger.transactions);

            return ledger.newTransaction(inputs, outputs);
        },
        phase1: (): {
            resolution: ExchangeResolution,
            transactions: ExchangeTransactions
        } => {
            const inputs = accounts.cash.generateInputs(positions.cad, 500, ledger.transactions);
            const outputs = accounts.cash.generateOutputs(positions.usd, 375, ledger.transactions);

            const resolution = new ExchangeResolution(inputs, outputs, ledger.transactions, engine, accounts.capitalGainsOrLosses, accounts.netTransfers);
            const transactions = resolution.constructTransactions();

            ledger.addTransaction(...transactions.flatten());
            
            return {
                resolution,
                transactions
            };
        },
        phase2: (): {
            resolution: ExchangeResolution,
            transactions: ExchangeTransactions
        } => {
            const inputs = accounts.cash.generateInputs(positions.usd, 375, ledger.transactions);
            const outputs = accounts.cash.generateOutputs(positions.cad, 550, ledger.transactions);

            const resolution = new ExchangeResolution(inputs, outputs, ledger.transactions, engine, accounts.capitalGainsOrLosses, accounts.netTransfers);
            const transactions = resolution.constructTransactions();

            ledger.addTransaction(...transactions.flatten());

            return {
                resolution,
                transactions
            };
        }
    };

    export function buildSampleLedger(): LedgerView {
        for (const phase of Object.values(phases)) phase();

        return {
            ledger: ledger,
            engine: engine,
            positions: Object.values(positions)
        };
    }
}