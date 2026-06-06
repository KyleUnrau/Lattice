import { clear } from "node:console";

import { dump, runCLI, write } from "./utils.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { TXO, type Output } from "./ledger-kernel/transactions/outputs.js";
import { TXI, TXOConsumption, type Input } from "./ledger-kernel/transactions/inputs.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { Account, AccountFolder, ExchangePositionsAccount, ResidualAccount } from "./ledger-kernel/accounts.js";
import type { Position } from "./ledger-kernel/positions.js";
import { Exchange, ResidualTXI, ResidualTXO } from "./ledger-kernel/transactions/exchange.js";
import { BookValueEngine } from "./ledger-kernel/book-value/engine.js";
import { expense, exchange, type RecaptureResolution, type ExpenseResolution } from "./ledger-kernel/equity-policy.js";

// Positions
const btc: Position = { name: "Bitcoin" };
const cad: Position = { name: "Canadian Dollars" };
const usd: Position = { name: "United States Dollars" };

// Chart of accounts
const netAssets: AccountFolder = new AccountFolder("Net Assets", Orientation.Positive);
const netWorth: AccountFolder = new AccountFolder("Net Worth", Orientation.Negative);
const ledger: Ledger = new Ledger(netAssets, netWorth);
const engine = new BookValueEngine(ledger.transactions);

const assets: AccountFolder = netAssets.addFolder("Assets", Orientation.Positive);
const currentAssets: AccountFolder = assets.addFolder("Current Assets", Orientation.Positive);
const netIncome: AccountFolder = netWorth.addFolder("Net Income", Orientation.Positive);
const expenses: AccountFolder = netIncome.addFolder("Expenses", Orientation.Negative);

const cash: Account = currentAssets.addAccount("Cash", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const wallet: Account = currentAssets.addAccount("Cryptocurrency Wallet", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const openingBalance: Account = netWorth.addAccount("Opening Balance", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const exchangeExpense: Account = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<TXO>, fifo<TXI>);
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
    exchange: RecaptureResolution
} {
    const fromInputs = wallet.generateInputs(btc, 0.01, ledger.transactions);
    const swap = exchange(fromInputs, cad, 1000, engine, ledger.transactions, capitalGains);

    // Consuming side: close any recaptured prior exchanges, then open the forward exchange (if any).
    const fromOutputs: Output[] = [
        ...swap.recaptures.map(r => r.from),
        ...(swap.exchange ? [swap.exchange.from] : []),
        ...(swap.residual instanceof ResidualTXO ? [swap.residual] : []),
    ];
    const from: TransactionConstruct = {
        inputs: fromInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(fromInputs, fromOutputs),
    };

    // Receiving side: re-open recaptured prior-exchange from-sides, the forward exchange to-side,
    // and any gain residual — together they fund the actual proceeds output.
    const toInputs: Input[] = [
        ...swap.recaptures.map(r => r.to),
        ...(swap.exchange ? [swap.exchange.to] : []),
        ...(swap.residual instanceof ResidualTXI ? [swap.residual] : []),
    ];
    const toOutputs: Output[] = cash.generateOutputs(cad, 1000, ledger.transactions);
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
    cadExchange: RecaptureResolution,
    expenseResolution: ExpenseResolution
} {
    const exchangeInputs = cash.generateInputs(cad, 500, ledger.transactions);
    const expenseInputs  = cash.generateInputs(cad, 25,  ledger.transactions);

    const cadExchange = exchange(exchangeInputs, usd, 375, engine, ledger.transactions, capitalGains);
    const expenseRes  = expense(expenseInputs, engine, ledger.transactions);

    // Consuming tx: close any exchange recaptures, open the forward exchange (if any), handle
    // expense recapture froms and origin expense outputs — all in one combined transaction.
    const fromOutputs: Output[] = [
        ...cadExchange.recaptures.map(r => r.from),
        ...(cadExchange.exchange ? [cadExchange.exchange.from] : []),
        ...(cadExchange.residual instanceof ResidualTXO ? [cadExchange.residual] : []),
        ...expenseRes.recaptureGroups.flatMap(g => g.recaptures.map(r => r.from)),
        ...expenseRes.originAmounts.flatMap(o =>
            exchangeExpense.generateOutputs(o.position, o.quantity, ledger.transactions)),
    ];
    const fromInputs = [...exchangeInputs, ...expenseInputs];
    const from: TransactionConstruct = {
        inputs: fromInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(fromInputs, fromOutputs),
    };

    // One expense tx per origin position: recapture.to → exchangeExpense
    const expenseTransactions = expenseRes.recaptureGroups.map(group =>
        ledger.newTransaction(
            group.recaptures.map(r => r.to),
            exchangeExpense.generateOutputs(group.position, group.totalQuantity, ledger.transactions)
        )
    );

    // Receiving tx: re-open exchange recapture from-sides, forward exchange to-side, gain residual.
    const toInputs: Input[] = [
        ...cadExchange.recaptures.map(r => r.to),
        ...(cadExchange.exchange ? [cadExchange.exchange.to] : []),
        ...(cadExchange.residual instanceof ResidualTXI ? [cadExchange.residual] : []),
    ];
    const toOutputs = cash.generateOutputs(usd, 375, ledger.transactions);
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    return { from, to, expenseTransactions, cadExchange, expenseResolution: expenseRes };
}

// ─── Phase #3: Exchange 375 USD → 550 CAD (50 CAD capital gain) ──────────────
function phase3(): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    usdExchange: RecaptureResolution
} {
    const actualProceeds = 550;
    const usdInputs = cash.generateInputs(usd, 375, ledger.transactions);
    const usdExchange = exchange(usdInputs, cad, actualProceeds, engine, ledger.transactions, capitalGains);

    // Consuming tx: close recaptured prior exchanges, then open the forward exchange (if any).
    // For phase3 the full 375 USD traces to cadExchange, so exchange is null — recaptures only.
    const fromOutputs: Output[] = [
        ...usdExchange.recaptures.map(r => r.from),
        ...(usdExchange.exchange ? [usdExchange.exchange.from] : []),
        ...(usdExchange.residual instanceof ResidualTXO ? [usdExchange.residual] : []),
    ];
    const from: TransactionConstruct = {
        inputs: usdInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(usdInputs, fromOutputs),
    };

    // Receiving tx: re-open recapture from-sides, forward exchange to-side, gain residual.
    // The 50 CAD gain (residualQuantity) lands in capitalGains via ResidualTXI.
    const toInputs: Input[] = [
        ...usdExchange.recaptures.map(r => r.to),
        ...(usdExchange.exchange ? [usdExchange.exchange.to] : []),
        ...(usdExchange.residual instanceof ResidualTXI ? [usdExchange.residual] : []),
    ];
    const toOutputs = cash.generateOutputs(cad, actualProceeds, ledger.transactions);
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    return { from, to, usdExchange };
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
    TXO,
    TXI,
    TXOConsumption,
    Exchange,
    BookValueEngine,
    expense,
    exchange,
    runCLI,
    phase0,
    phase1,
    phase2,
    phase3
});
