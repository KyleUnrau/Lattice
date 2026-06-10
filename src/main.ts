import { clear } from "node:console";

import { dump, muldiv, runCLI, write } from "./utils.js";
import { formatQuantity } from "./ledger-kernel/positions.js";
import { scale, unscale } from "./ledger-kernel/positions.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { UTXO, type Output } from "./ledger-kernel/transactions/outputs.js";
import { UTXI, UTXOConsumption, type Input } from "./ledger-kernel/transactions/inputs.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { Account, AccountFolder, ExchangePositionsAccount, ResidualAccount } from "./ledger-kernel/accounts.js";
import type { Position } from "./ledger-kernel/positions.js";
import { Exchange } from "./ledger-kernel/transactions/cross-position.js";
import { BookValueEngine } from "./ledger-kernel/book-value/engine.js";
import { exchange } from "./ledger-kernel/equity-policy/exchange.js";
import { expense } from "./ledger-kernel/equity-policy/expense.js";
import { computeRecaptureResolution, groupRecapturesByExchange } from "./ledger-kernel/equity-policy/recapture.js";
import { consumedUTXOsFromInputs } from "./ledger-kernel/equity-policy/utils.js";

// Positions (quantities stored in smallest tradable unit)
const btc: Position = { name: "Bitcoin", decimals: 8 };
const cad: Position = { name: "Canadian Dollars", decimals: 2 };
const usd: Position = { name: "United States Dollars", decimals: 2 };

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
const wallet: Account = currentAssets.addAccount("Cryptocurrency Wallet", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
const openingBalance: Account = netWorth.addAccount("Opening Balance", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
const exchangeExpense: Account = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
const capitalGains: ResidualAccount = netIncome.addResidualAccount("Capital Gains (Losses)", Orientation.Positive);
const exchangePositions: ExchangePositionsAccount = netWorth.addExchangeAccount("Net Transfers In (Out)", Orientation.Positive);

interface TransactionConstruct {
    inputs: Input[],
    outputs: Output[],
    transaction: Transaction,
}

function phase0(): TransactionConstruct {
     const inputs = openingBalance.generateInputs(cad, 1000, ledger.transactions);
     const outputs = cash.generateOutputs(cad, 1000, ledger.transactions);

     return {
        inputs,
        outputs,
        transaction: ledger.newTransaction(inputs, outputs)
     };
}

runCLI({
    btc,
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
    wallet,
    openingBalance,
    exchangeExpense,
    capitalGains: capitalGains,
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
    exchange,
    muldiv,
    scale,
    unscale,
    formatQuantity,
    consumedUTXOsFromInputs,
    computeRecaptureResolution,
    groupRecapturesByExchange,
    runCLI,
    phase0
});
