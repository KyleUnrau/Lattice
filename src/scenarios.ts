import { BookValueEngine } from "./equity-policy/book-value/engine.js";
import { ExchangeResolution } from "./equity-policy/exchange.js";
import { ExpenseResolution } from "./equity-policy/expense.js";
import type { Account } from "./ledger-kernel/accounts/account.js";
import type { ExchangeAccount, ResidualAccount } from "./ledger-kernel/accounts/computed.js";
import { AccountFolder } from "./ledger-kernel/accounts/folder.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { TransactionGroup } from "./ledger-kernel/transactions.js";
import type { Position } from "./ledger-kernel/positions.js";
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

export namespace ScenarioLedger {
    interface Positions {
        a: Position;
        b: Position;
    }

    export const positions: Positions = {
        a: { name: "Position A (Currency)", decimals: 2 },
        b: { name: "Position B (Currency)", decimals: 2 }
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
        exchangeExpense: Account;
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
        const exchangeExpense = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);

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
            exchangeExpense,
        };
    }

    export const accounts = generateAccounts();

    export const ledger: Ledger = new Ledger(accounts.netAssets, accounts.equity);
    export const engine = new BookValueEngine(ledger.transactions);

    export const events = {
        event0: (): TransactionGroup => {
            const event = ledger.beginEvent();

            const from = event.context.generateInputs(accounts.openingBalance, positions.a, 1000);
            const to = event.context.generateOutputs(accounts.cash, positions.a, 1000);
            event.newTransaction(event.context);

            return event.register();
        },
        event1: (): TransactionGroup => {
            const event = ledger.beginEvent();

            const fromInputs = event.context.generateInputs(accounts.cash, positions.a, 500);
            const toOutputs = event.context.generateOutputs(accounts.cash, positions.b, 250);
            const resolution = new ExchangeResolution(fromInputs, toOutputs, event.view(), engine, accounts.capitalGainsOrLosses, accounts.netTransfers);
            event.record(resolution.constructTransactions().toGroup());

            return event.register();
        },
        event2: (): TransactionGroup => {
            const event = ledger.beginEvent();

            const fromInputs = event.context.generateInputs(accounts.cash, positions.b, 250);
            const toOutputs = event.context.generateOutputs(accounts.cash, positions.a, 550);
            const resolution = new ExchangeResolution(fromInputs, toOutputs, event.view(), engine, accounts.capitalGainsOrLosses, accounts.netTransfers);
            event.record(resolution.constructTransactions().toGroup());

            return event.register();
        },
        event3: (): TransactionGroup => {
            const event = ledger.beginEvent();

            const expensedInputs = event.context.generateInputs(accounts.cash, positions.a, 50);
            const expense = new ExpenseResolution(expensedInputs, event.view(), engine, accounts.exchangeExpense);
            event.record(expense.constructTransactions().toGroup());

            const fromInputs = event.context.generateInputs(accounts.cash, positions.a, 1000);
            const toOutputs = event.context.generateOutputs(accounts.cash, positions.b, 500);
            const exchange = new ExchangeResolution(fromInputs, toOutputs, event.view(), engine, accounts.capitalGainsOrLosses, accounts.netTransfers);
            event.record(exchange.constructTransactions().toGroup());

            return event.register();
        }
    }

    export function buildSampleLedger(): LedgerView {
        for (const event of Object.values(events)) event();

        return {
            ledger: ledger,
            engine: engine,
            positions: Object.values(positions)
        };
    }
}