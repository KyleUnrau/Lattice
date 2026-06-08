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
import { exchange, type ExchangeResolution } from "./ledger-kernel/equity-policy/exchange.js";
import { expense, ExpenseResolution } from "./ledger-kernel/equity-policy/expense.js";
import { computeRecaptureResolution, groupRecapturesByExchange } from "./ledger-kernel/equity-policy/recapture.js";
import { consumedUTXOsFromInputs } from "./ledger-kernel/equity-policy/utils.js";

// Positions (quantities stored in smallest tradable unit)
const btc: Position = { name: "Bitcoin", decimals: 8 };           // 1 BTC = 100_000_000 sat
const cad: Position = { name: "Canadian Dollars", decimals: 2 };  // 1 CAD = 100 cents
const usd: Position = { name: "United States Dollars", decimals: 2 }; // 1 USD = 100 cents

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

// ─── Phase #0: Opening balance 0.02 BTC ──────────────────────────────────────
function phase0(): TransactionConstruct {
    const inputs = openingBalance.generateInputs(btc, 0.02, ledger.transactions);
    const outputs = wallet.generateOutputs(btc, 0.02, ledger.transactions);

    return {
        inputs: inputs,
        outputs: outputs,
        transaction: ledger.newTransaction(inputs, outputs)
    }
}

// ─── Phase #1: Exchange 0.01 BTC → 1000 CAD ──────────────────────────────────
function phase1(): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    exchange: ExchangeResolution
} {
    const fromInputs = wallet.generateInputs(btc, 0.01, ledger.transactions);
    const swap = exchange(fromInputs, cad, 1000, engine, ledger.transactions, capitalGains);
    const fromOutputs: Output[] = swap.getFromOutputs();
    const toInputs: Input[] = swap.getToInputs();
    const toOutputs: Output[] = [...cash.generateOutputs(cad, 1000, ledger.transactions), ...swap.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: fromInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(fromInputs, fromOutputs),
    };
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    return { from, to, exchange: swap };
}

// ─── Phase #2: 525 CAD — 500 CAD exchanged for 375 USD, 25 CAD expensed ──────
function phase2(): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    expenseTransactions: Transaction[],
    cadExchange: ExchangeResolution,
    expenseResolution: ExpenseResolution
} {
    const exchangeInputs = cash.generateInputs(cad, 500, ledger.transactions);
    const expenseInputs  = cash.generateInputs(cad, 25,  ledger.transactions);
    const cadExchange = exchange(exchangeInputs, usd, 375, engine, ledger.transactions, capitalGains);
    const expenseRes  = expense(expenseInputs, engine, ledger.transactions);

    const fromInputs = [...exchangeInputs, ...expenseInputs];
    const fromOutputs: Output[] = [
        ...cadExchange.getFromOutputs(),
        ...expenseRes.getFromOutputs(exchangeExpense, ledger.transactions),
    ];
    const toInputs: Input[] = cadExchange.getToInputs();
    const toOutputs = [...cash.generateOutputs(usd, 375, ledger.transactions), ...cadExchange.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: fromInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(fromInputs, fromOutputs),
    };
    const expenseTransactions = expenseRes.createTransactions(exchangeExpense, ledger);
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    return { from, to, expenseTransactions, cadExchange, expenseResolution: expenseRes };
}

// ─── Phase #3: Exchange 375 USD → 550 CAD (50 CAD capital gain) ──────────────
function phase3(proceeds: number): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    usdExchange: ExchangeResolution
} {
    const usdInputs = cash.generateInputs(usd, 375, ledger.transactions);
    const usdExchange = exchange(usdInputs, cad, proceeds, engine, ledger.transactions, capitalGains);
    // Consuming tx: close recaptured prior exchanges, then open the forward exchange (if any).
    // For phase3 the full 375 USD traces to cadExchange, so exchange is null — recaptures only.
    const fromOutputs: Output[] = usdExchange.getFromOutputs();
    // Receiving tx: re-open recapture from-sides, forward exchange to-side, gain residual.
    // The 50 CAD gain lands in capitalGains as a ResidualUTXI.
    const toInputs: Input[] = usdExchange.getToInputs();
    const toOutputs = [...cash.generateOutputs(cad, proceeds, ledger.transactions), ...usdExchange.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: usdInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(usdInputs, fromOutputs),
    };
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    return { from, to, usdExchange };
}

// ─── Phase #4: Exchange full CAD cash balance → BTC at 900,000 CAD/BTC ──────
function phase4(): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    cadExchange: ExchangeResolution
} {
    const cadBalance = cash.getBalance(cad, ledger.transactions);
    // 900,000 CAD/BTC = 90,000,000 cents per 100,000,000 sat
    const btcProceeds = cadBalance / 900_000;
    const cadInputs = cash.generateInputs(cad, cadBalance, ledger.transactions);
    const cadExchange = exchange(cadInputs, btc, btcProceeds, engine, ledger.transactions, capitalGains);
    const fromOutputs: Output[] = cadExchange.getFromOutputs();
    const toInputs: Input[] = cadExchange.getToInputs();
    const toOutputs = [...wallet.generateOutputs(btc, btcProceeds, ledger.transactions), ...cadExchange.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: cadInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(cadInputs, fromOutputs),
    };
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    return { from, to, cadExchange };
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
    exchange,
    muldiv,
    scale,
    unscale,
    formatQuantity,
    consumedUTXOsFromInputs,
    computeRecaptureResolution,
    groupRecapturesByExchange,
    runCLI,
    phase0,
    phase1,
    phase2,
    phase3,
    phase4
});
