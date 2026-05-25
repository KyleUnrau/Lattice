import { clear } from "node:console";

import { dump, runCLI, write } from "./utils.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { TXO } from "./ledger-kernel/transactions/outputs.js";
import { TXI } from "./ledger-kernel/transactions/inputs.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Account, AccountFolder, Ledger, Orientation } from "./ledger-kernel/ledger.js";
import type { Position } from "./ledger-kernel/positions.js";

const cad: Position = { name: "Canadian Dollars" };
const usd: Position = { name: "United States Dollars" };

const netAssets: AccountFolder = new AccountFolder("Net Assets", Orientation.Positive);
const netWorth: AccountFolder = new AccountFolder("Net Worth", Orientation.Negative);

const ledger: Ledger = new Ledger(netAssets, netWorth);

const assets: AccountFolder = netAssets.addFolder("Assets", Orientation.Positive);
const liabilities: AccountFolder = netAssets.addFolder("Liabilities", Orientation.Negative);

const currentAssets: AccountFolder = assets.addFolder("Current Assets", Orientation.Positive);
const netIncome: AccountFolder = netWorth.addFolder("Net Income", Orientation.Positive);
const expenses: AccountFolder = netIncome.addFolder("Expenses", Orientation.Negative);

const cash: Account = currentAssets.addAccount("Cash", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const openingBalance: Account = netWorth.addAccount("Opening Balance", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const exchangeExpense: Account = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const netTransfers: Account = netWorth.addAccount("Net Transfers", Orientation.Negative, fifo<TXO>, fifo<TXI>);

const entry1 = openingBalance.stageInput(cad, 1000);
const entry2 = cash.stageOutput(cad, 1000);

const transaction = ledger.newTransaction([entry1], [entry2]);

const entry3 = cash.stageInput(cad, 525);
const entry4 = exchangeExpense.stageOutput(cad, 25);
const entry5 = netTransfers.stageOutput(cad, 500);

const transaction2cad = ledger.newTransaction([entry3], [entry4, entry5]);

const entry6 = netTransfers.stageInput(usd, 375);
const entry7 = cash.stageOutput(usd, 375);

const transaction2usd = ledger.newTransaction([entry6], [entry7]);

ledger.exchangePosition(transaction2cad.getOutputFromStaged(entry5), transaction2usd.getInputFromStaged(entry6));

runCLI({
    cad,
    usd,
    netAssets,
    netWorth,
    ledger,
    assets,
    liabilities,
    currentAssets,
    cash,
    openingBalance,
    entry1,
    entry2,
    entry3,
    entry4,
    entry5,
    entry6,
    entry7,
    transaction,
    transaction2cad,
    transaction2usd,
    fifo,
    clear,
    dump,
    write,
    Account,
    AccountFolder,
    Ledger,
    Orientation,
    Transaction,
    TXO,
    TXI,
    runCLI
});