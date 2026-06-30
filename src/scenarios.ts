import { BookValueEngine } from "./equity-policy/book-value/engine.js";
import { ExchangeResolution } from "./equity-policy/exchange.js";
import { TerminalResolution } from "./equity-policy/terminal.js";
import type { Account } from "./ledger-kernel/accounts/account.js";
import { AccountFolder } from "./ledger-kernel/accounts/folder.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { TransactionGroup } from "./ledger-kernel/transactions/group.js";
import type { Position } from "./ledger-kernel/positions.js";
import type { UTXI } from "./ledger-kernel/transactions/inputs.js";
import type { UTXO } from "./ledger-kernel/transactions/outputs.js";
import { GenerationContext } from "./ledger-kernel/generation-context.js";

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
    events: TransactionGroup[];
}

export namespace ScenarioLedger {
    interface Positions {
        a: Position;
        b: Position;
        c: Position;
    }

    export const positions: Positions = {
        a: { name: "Position A (Currency)", decimals: 2 },
        b: { name: "Position B (Currency)", decimals: 2 },
        c: { name: "Position C (Inventory)", decimals: 0 }
    }

    function generateAccounts() {
        const netAssets = new AccountFolder("Net Assets", Orientation.Positive);
        const equity = new AccountFolder("Net Worth", Orientation.Negative);

        const assets = netAssets.addFolder("Assets", Orientation.Positive);
        const cash = assets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
        const inventory = assets.addAccount("Inventory", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);

        const liabilities = netAssets.addFolder("Liabilities", Orientation.Negative);
        const accountsPayable = liabilities.addAccount("Accounts Payable", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);

        const openingBalance = equity.addAccount("Opening Balance", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
        const netCapitalGains = equity.addFolder({positive: "Net Capital Gains", negative: "Net Capital Loss"}, Orientation.Positive);
        
        const capitalGains = netCapitalGains.addFolder("Capital Gains", Orientation.Positive);
        const gainsFromA = capitalGains.addResidualAccount("Capital Gains from Disposition of A", Orientation.Positive);
        const gainsFromB = capitalGains.addResidualAccount("Capital Gains from Disposition of B", Orientation.Positive)

        const capitalLosses = netCapitalGains.addFolder("Capital Loss", Orientation.Negative);
        const lossesFromA = capitalLosses.addTerminalAccount("Capital Loss from Disposition of A", Orientation.Positive);
        const lossesFromB = capitalLosses.addTerminalAccount("Capital Loss from Disposition of B", Orientation.Positive);

        const netTransfers = equity.addFolder("Net Transfers", Orientation.Positive);

        const transfersFrom = netTransfers.addFolder("Transfers From", Orientation.Positive);
        const fromA = transfersFrom.addExchangeAccount("Transfers from A", Orientation.Positive);
        const fromB = transfersFrom.addExchangeAccount("Transfers from B", Orientation.Positive);

        const transfersTo = netTransfers.addFolder("Transfers To", Orientation.Negative);
        const toA = transfersTo.addExchangeAccount("Transfers to A", Orientation.Positive);
        const toB = transfersTo.addExchangeAccount("Transfers to B", Orientation.Positive);

        const netIncome = equity.addFolder("Net Income", Orientation.Positive);
        const revenues = netIncome.addFolder("Revenues", Orientation.Positive);
        const inventoryProfit = revenues.addResidualAccount("Profit from Disposition of Inventory", Orientation.Positive);

        const expenses = netIncome.addFolder("Expenses", Orientation.Negative);
        const salesTax = expenses.addTerminalAccount("Sales Tax", Orientation.Positive);
        const exchangeExpense = expenses.addTerminalAccount("Exchange Expense", Orientation.Positive);
        const rentExpense = expenses.addTerminalAccount("Rent Expense", Orientation.Positive);
        const inventoryLoss = expenses.addTerminalAccount("Losses from the Disposition of Inventory", Orientation.Positive);
        const spoilageExpense = expenses.addTerminalAccount("Spoilage Expense", Orientation.Positive);

        return {
            netAssets,
            equity,

            assets,
            cash,
            inventory,

            liabilities,
            accountsPayable,

            openingBalance,
            netCapitalGains,

            capitalGains,
            gainsFromA,
            gainsFromB,

            capitalLosses,
            lossesFromA,
            lossesFromB,

            residualA: {gain: gainsFromA, loss: lossesFromA},
            residualB: {gain: gainsFromB, loss: lossesFromB},

            netTransfers,

            transfersFrom,
            fromA,
            fromB,

            transfersTo,
            toA,
            toB,

            netIncome,
            revenues,
            inventoryProfit,

            expenses,
            salesTax,
            exchangeExpense,
            rentExpense,
            inventoryLoss,
            spoilageExpense
        };
    }

    export const accounts = generateAccounts();

    export const ledger: Ledger = new Ledger(accounts.netAssets, accounts.equity);
    export const engine = new BookValueEngine(ledger.transactions);

    export const events: Record<string, () => any> = {
        event0: () => {
            const event = ledger.beginEvent();
            event.context.generateInputs(accounts.openingBalance, positions.a, 1000);
            event.context.generateOutputs(accounts.cash, positions.a, 1000);
            event.newTransaction(event.context);
            return event.register();
        },
        event1: () => {
            const event = ledger.beginEvent();
            const fromInputs = event.context.generateInputs(accounts.cash, positions.a, 500);
            const toOutputs = event.context.generateOutputs(accounts.cash, positions.b, 250);
            const exchange = new ExchangeResolution(
                fromInputs,
                toOutputs,
                event.view(),
                engine,
                accounts.residualA,
                {from: accounts.toB, to: accounts.fromA}
            );

            event.record(exchange.constructTransactions());
            return event.register();
        },
        event2: () => {
            const event = ledger.beginEvent();
            const fromInputs = event.context.generateInputs(accounts.cash, positions.b, 250);
            const toOutputs = event.context.generateOutputs(accounts.cash, positions.a, 550);
            const exchange = new ExchangeResolution(
                fromInputs,
                toOutputs,
                event.view(),
                engine,
                accounts.residualB,
                {from: accounts.toA, to: accounts.fromB}
            );

            event.record(exchange.constructTransactions());
            return event.register();
        },
        event3: () => {
            const event = ledger.beginEvent();
            const fromInputs = event.context.generateInputs(accounts.cash, positions.a, 500);
            const toOutputs = event.context.generateOutputs(accounts.cash, positions.b, 250);
            const exchange = new ExchangeResolution(
                fromInputs,
                toOutputs,
                event.view(),
                engine,
                accounts.residualA,
                {from: accounts.toB, to: accounts.fromA}
            );

            event.record(exchange.constructTransactions());
            return event.register();
        },
        event4: () => {
            const event = ledger.beginEvent();
            event.context.generateInputs(accounts.accountsPayable, positions.b, 250);
            event.context.generateOutputs(accounts.cash, positions.b, 250);
            event.newTransaction(event.context);
            return event.register();
        },
        event5: () => {
            const event = ledger.beginEvent();
            const fromInputs = event.context.generateInputs(accounts.cash, positions.b, 500);
            const toOutputs = event.context.generateOutputs(accounts.cash, positions.a, 900);
            const exchange = new ExchangeResolution(
                fromInputs,
                toOutputs,
                event.view(),
                engine,
                accounts.residualB,
                {from: accounts.toA, to: accounts.fromB}
            );

            event.record(exchange.constructTransactions());
            return event.register();
        },
        event6: () => {
            const event = ledger.beginEvent();
            const exchange = new ExchangeResolution(
                event.context.generateInputs(accounts.cash, positions.a, 1450),
                event.context.generateOutputs(accounts.cash, positions.b, 725),
                event.view(),
                engine,
                accounts.residualA,
                {from: accounts.toB, to: accounts.fromA}
            );

            event.record(exchange.constructTransactions());
            return event.register();
        }
    }

    export function buildSampleLedger(): LedgerView {
        const returnEvents: any[] = [];

        for (const event of Object.values(events)) returnEvents.push(event());

        return {
            ledger: ledger,
            engine: engine,
            positions: Object.values(positions),
            events: returnEvents
        };
    }
}