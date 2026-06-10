import { clear } from "node:console";

import { dump, muldiv, runCLI, write } from "./utils.js";
import { formatQuantity } from "./ledger-kernel/positions.js";
import { scale, unscale } from "./ledger-kernel/positions.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { UTXO } from "./ledger-kernel/transactions/outputs.js";
import { UTXI, UTXOConsumption } from "./ledger-kernel/transactions/inputs.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { ExchangePositionsAccount, ResidualAccount } from "./ledger-kernel/accounts.js";
import { AccountFolder } from "./ledger-kernel/accounts/folder.js";
import { Account } from "./ledger-kernel/accounts/account.js";
import type { Position } from "./ledger-kernel/positions.js";
import { Exchange } from "./ledger-kernel/transactions/cross-position.js";
import { BookValueEngine } from "./equity-policy/book-value/engine.js";
import { ExchangeResolution } from "./equity-policy/exchange.js";
import { expense } from "./equity-policy/expense.js";
import { swap } from "./equity-policy/swap.js";
import { computeRecaptureResolution } from "./equity-policy/recapture.js";
import { groupRecapturesByExchange, unwind } from "./equity-policy/lineage.js";
import { consumedUTXOsFromInputs } from "./equity-policy/utils.js";

// Positions (quantities stored in smallest tradable unit)
const cad: Position = { name: "Canadian Dollars", decimals: 2 };
const usd: Position = { name: "United States Dollars", decimals: 2 };
const oranges: Position = { name: "Oranges", decimals: 0 };

// Chart of accounts
const netAssets: AccountFolder = new AccountFolder("Net Assets", Orientation.Positive);
const netWorth: AccountFolder = new AccountFolder("Net Worth", Orientation.Negative);
const ledger: Ledger = new Ledger(netAssets, netWorth);
const engine = new BookValueEngine(ledger.transactions);

const assets: AccountFolder = netAssets.addFolder("Assets", Orientation.Positive);
const currentAssets: AccountFolder = assets.addFolder("Current Assets", Orientation.Positive);
const netIncome: AccountFolder = netWorth.addFolder("Net Income", Orientation.Positive);
const expenses: AccountFolder = netIncome.addFolder("Expenses", Orientation.Negative);

const cash: Account = currentAssets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
const inventory: Account = currentAssets.addAccount("Inventory", Orientation.Positive, fifo<UTXO>, fifo<UTXI>)
const wallet: Account = currentAssets.addAccount("Cryptocurrency Wallet", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
const openingBalance: Account = netWorth.addAccount("Opening Balance", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
const exchangeExpense: Account = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
const capitalGains: ResidualAccount = netIncome.addResidualAccount("Capital Gains (Losses)", Orientation.Positive);
const exchangePositions: ExchangePositionsAccount = netWorth.addExchangeAccount("Net Transfers In (Out)", Orientation.Positive);

function phase0(): Transaction {
     const inputs = openingBalance.generateInputs(cad, 1000, ledger.transactions);
     const outputs = cash.generateOutputs(cad, 1000, ledger.transactions);

     return ledger.newTransaction(inputs, outputs);
}

// CAD 500 → USD 375 (forward exchange; CAD basis carried onto USD).
function phase1() {
    return swap({ source: cash, from: cad, quantity: 500, destination: cash, to: usd, proceeds: 375,
                  engine, ledger, residualAccount: capitalGains });
}

// USD 375 → Oranges 1500 (forward exchange; USD→CAD provenance inherited by oranges).
function phase2() {
    return swap({ source: cash, from: usd, quantity: 375, destination: inventory, to: oranges, proceeds: 1500,
                  engine, ledger, residualAccount: capitalGains });
}

// Oranges 1500 → CAD 600 — closes the CAD→USD→Oranges→CAD loop. The engine recursively
// recaptures every edge (USD→Oranges and CAD→USD) and recognizes the 100 CAD gain.
function phase3(proceeds: number = 600) {
    return swap({ source: inventory, from: oranges, quantity: 1500, destination: cash, to: cad, proceeds,
                  engine, ledger, residualAccount: capitalGains });
}

runCLI({
    oranges,
    cad,
    usd,
    netAssets,
    netWorth,
    ledger,
    assets,
    currentAssets,
    netIncome,
    expenses,
    cash,
    inventory,
    wallet,
    openingBalance,
    exchangeExpense,
    capitalGains,
    exchangePositions,
    engine,
    fifo,
    clear,
    dump,
    write,
    Account,
    AccountFolder,
    Ledger,
    Orientation,
    Transaction,
    UTXO,
    UTXI,
    UTXOConsumption,
    Exchange,
    BookValueEngine,
    expense,
    ExchangeResolution,
    swap,
    muldiv,
    scale,
    unscale,
    formatQuantity,
    consumedUTXOsFromInputs,
    computeRecaptureResolution,
    groupRecapturesByExchange,
    unwind,
    phase0,
    phase1,
    phase2,
    phase3
});
