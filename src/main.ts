import { clear } from "node:console";

import { muldiv, runCLI } from "./utils.js";
import { formatQuantity } from "./ledger-kernel/positions.js";
import { scale, unscale } from "./ledger-kernel/positions.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { UTXO } from "./ledger-kernel/transactions/outputs.js";
import { UTXI, UTXOConsumption } from "./ledger-kernel/transactions/inputs.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { AccountFolder } from "./ledger-kernel/accounts/folder.js";
import { Account } from "./ledger-kernel/accounts/account.js";
import type { Position } from "./ledger-kernel/positions.js";
import { Exchange } from "./ledger-kernel/transactions/cross-position.js";
import { BookValueEngine } from "./equity-policy/book-value/engine.js";
import { ExchangeResolution, gainAccountOf, lossAccountOf, swap, computeRecaptureResolution } from "./equity-policy/exchange/index.js";
import { expense } from "./equity-policy/expense.js";
import { unwind } from "./equity-policy/book-value/lineage.js";
import type { ExchangePositionsAccount, ResidualAccount } from "./ledger-kernel/accounts/computed.js";

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

// Design A: dual-name — one account whose display name flips between "Capital Gains" and
// "Capital Losses" depending on whether the per-position balance is positive or negative.
const netCapitalGains: AccountFolder = netIncome.addFolder("Net Capital Gains (Losses)", Orientation.Positive);

const capitalGains: ResidualAccount = netCapitalGains.addResidualAccount("Capital Gains", Orientation.Positive);
const capitalLosses: ResidualAccount = netCapitalGains.addResidualAccount("Capital Loss", Orientation.Negative);

// Design B alternative (split accounts — uncomment to route gains/losses separately):
// const capitalGains: ResidualAccount = netIncome.addResidualAccount("Capital Gains", Orientation.Positive);
// const capitalLosses: ResidualAccount = netIncome.addResidualAccount("Capital Losses", Orientation.Negative);
// Then pass `{ gain: capitalGains, loss: capitalLosses }` as `residualAccount` in each swap.

// Scoped exchange accounts — each swap is tagged to its own account so open positions are
// classified by direction rather than merged into a single net figure.
const cadToUsdPositions: ExchangePositionsAccount = netWorth.addExchangeAccount("Transfers CAD→USD", Orientation.Positive);
const usdToOrangesPositions: ExchangePositionsAccount = netWorth.addExchangeAccount("Transfers USD→Oranges", Orientation.Positive);
const orangesToCadPositions: ExchangePositionsAccount = netWorth.addExchangeAccount("Transfers Oranges→CAD", Orientation.Positive);

function phase0(): Transaction {
     const inputs = openingBalance.generateInputs(cad, 1000, ledger.transactions);
     const outputs = cash.generateOutputs(cad, 1000, ledger.transactions);

     return ledger.newTransaction(inputs, outputs);
}

// Draws the exchanged inputs, stages the proceeds, runs `swap`, and commits the resulting
// transaction chain to the ledger in dependency order: consuming → hops → receiving.
function commitSwap(
    fromAccount: Account, fromPosition: Position, quantity: number,
    toAccount: Account, toPosition: Position, proceeds: number,
    exchangeAccount: ExchangePositionsAccount
) {
    const fromInputs = fromAccount.generateInputs(fromPosition, quantity, ledger.transactions);
    const toOutputs = toAccount.generateOutputs(toPosition, proceeds, ledger.transactions);

    const result = swap({
        fromInputs, toOutputs, engine, transactions: ledger.transactions,
        residualAccount: { gain: capitalGains, loss: capitalLosses }, exchangeAccount,
    });

    ledger.newTransaction(fromInputs, result.fromOutputs);
    ledger.addTransaction(...result.intermediates, result.to);
    return result;
}

// CAD 500 → USD 375 (forward exchange; CAD basis carried onto USD).
function phase1() {
    const fromInputs = cash.generateInputs(cad, 500, ledger.transactions);
    const toOutputs = cash.generateOutputs(usd, 375, ledger.transactions);

    const exchange = swap({
        fromInputs,
        toOutputs,
        engine,
        transactions: ledger.transactions,
        residualAccount: {gain: capitalGains, loss: capitalLosses},
        exchangeAccount: cadToUsdPositions
    });

    const from = ledger.newTransaction(fromInputs, exchange.fromOutputs);
    ledger.addTransaction(exchange.to, ...exchange.intermediates);
    
    return {
        from,
        to: exchange.to,
        intermediates: exchange.intermediates,
        resolution: exchange.resolution
    };
}

// USD 375 → Oranges 1500 (forward exchange; USD→CAD provenance inherited by oranges).
function phase2() {
    const fromInputs = cash.generateInputs(usd, 375, ledger.transactions);
    const toOutputs = inventory.generateOutputs(oranges, 1500, ledger.transactions);

    const exchange = swap({
        fromInputs,
        toOutputs,
        engine,
        transactions: ledger.transactions,
        residualAccount: {gain: capitalGains, loss: capitalLosses},
        exchangeAccount: usdToOrangesPositions
    });

    const from = ledger.newTransaction(fromInputs, exchange.fromOutputs);
    ledger.addTransaction(exchange.to, ...exchange.intermediates);

    return {
        from,
        to: exchange.to,
        intermediates: exchange.intermediates,
        resolution: exchange.resolution
    };
}

// Oranges 1500 → CAD 600 — closes the CAD→USD→Oranges→CAD loop. The engine recursively
// recaptures every edge (USD→Oranges and CAD→USD) and recognizes the 100 CAD gain.
function phase3(proceeds: number = 600) {
    const fromInputs = inventory.generateInputs(oranges, 1500, ledger.transactions);
    const toOutputs = cash.generateOutputs(cad, proceeds, ledger.transactions);

    const exchange = swap({
        fromInputs,
        toOutputs,
        engine,
        transactions: ledger.transactions,
        residualAccount: {gain: capitalGains, loss: capitalLosses},
        exchangeAccount: orangesToCadPositions
    });

    const from = ledger.newTransaction(fromInputs, exchange.fromOutputs);
    ledger.addTransaction(exchange.to, ...exchange.intermediates);

    return {
        from,
        to: exchange.to,
        intermediates: exchange.intermediates,
        resolution: exchange.resolution
    };
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
    capitalLosses,
    cadToUsdPositions,
    usdToOrangesPositions,
    orangesToCadPositions,
    gainAccountOf,
    lossAccountOf,
    engine,
    fifo,
    clear,
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
    computeRecaptureResolution,
    unwind,
    phase0,
    phase1,
    phase2,
    phase3
});
