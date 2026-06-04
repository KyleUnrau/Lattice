import { clear } from "node:console";

import { dump, runCLI, write } from "./utils.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { TXO } from "./ledger-kernel/transactions/outputs.js";
import { TXI, TXOConsumption } from "./ledger-kernel/transactions/inputs.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { Account, AccountFolder, ExchangePositionsAccount } from "./ledger-kernel/accounts.js";
import type { Position } from "./ledger-kernel/positions.js";
import { Exchange } from "./ledger-kernel/transactions/exchange.js";
import { BookValueEngine } from "./ledger-kernel/book-value/engine.js";
import { expense, exchange } from "./ledger-kernel/equity-policy.js";

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
const capitalGains: Account = netIncome.addAccount("Capital Gains", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const exchangePositions = new ExchangePositionsAccount("Exchange Positions", Orientation.Positive);
netWorth.addChild(exchangePositions);

// ─── Phase #0: Opening balance 0.02 BTC ──────────────────────────────────────
function phase0() {
    const inputs = openingBalance.generateInputs(btc, 0.02, ledger.transactions);
    const outputs = wallet.generateOutputs(btc, 0.02, ledger.transactions);

    return {
        input: inputs,
        output: outputs,
        transaction: ledger.newTransaction(inputs, outputs)
    }
}

// ─── Phase #1: Exchange 0.01 BTC → 1000 CAD ──────────────────────────────────
function phase1() {
    const fromInput = wallet.generateInputs(btc, 0.01, ledger.transactions);
    const phaseExchange = exchange(fromInput, cad, 1000, engine, ledger.transactions);

    const fromOutput = [phaseExchange.actualExchange.from];
}

const trans1input = wallet.generateInputs(btc, 0.01, ledger.transactions);
const btcExchange = exchange(trans1input, cad, 1000, engine, ledger.transactions);

const trans1output = [btcExchange.actualExchange.from];
const trans1 = ledger.newTransaction(trans1input, trans1output);

const trans2input  = [btcExchange.actualExchange.to];
const trans2output = cash.generateOutputs(cad, 1000, ledger.transactions);
const trans2 = ledger.newTransaction(trans2input, trans2output);

// ─── Phase #2: 525 CAD total ─────────────────────────────────────────────────
//   500 CAD → Exchange#1 (CAD→USD)
//    25 CAD → expense; traces each CAD portion back to its origin position
//             automatically (BTC via exchange0 in this example).

const exchange1 = new Exchange({ quantity: 500, position: cad }, { quantity: 375, position: usd });

// Generate exchange and expense inputs separately so the basis engine can isolate each.
const trans3inputExchange = cash.generateInputs(cad, 500, ledger.transactions);
const trans3inputExpense  = cash.generateInputs(cad, 25,  ledger.transactions);

const expenseResolution = expense(trans3inputExpense, engine, ledger.transactions);

// Tx #3 (CAD): consume 500 + 25 = 525 CAD
//   → exchange1.from  (500 CAD to Exchange#1)
//   → recapture.from  (settles each exchange's to-side, one entry per exchange in the lineage)
//   → direct expense  (origin CAD with no exchange lineage, if any)
const trans3input  = [...trans3inputExchange, ...trans3inputExpense];
const trans3output = [
    exchange1.from,
    ...expenseResolution.recaptureGroups.flatMap(g => g.recaptures.map(r => r.from)),
    ...expenseResolution.originAmounts.flatMap(o =>
        exchangeExpense.generateOutputs(o.position, o.quantity, ledger.transactions))
];
const trans3 = ledger.newTransaction(trans3input, trans3output);

// Tx #4…N (one per origin position): reclaim each position from its recapture and expense it.
const expenseTransactions = expenseResolution.recaptureGroups.map(group =>
    ledger.newTransaction(
        group.recaptures.map(r => r.to),
        exchangeExpense.generateOutputs(group.position, group.totalQuantity, ledger.transactions)
    )
);

// Tx #5 (USD): receive 375 USD from Exchange #1
const trans5input  = [exchange1.to];
const trans5output = cash.generateOutputs(usd, 375, ledger.transactions);
const trans5 = ledger.newTransaction(trans5input, trans5output);

// ─── Phase #3: Exchange 375 USD → 550 CAD (50 CAD capital gain) ──────────────
const actualProceeds = 550;
const trans6inputUSD = cash.generateInputs(usd, 375, ledger.transactions);
const usdExchange = exchange(trans6inputUSD, cad, actualProceeds, engine, ledger.transactions);

// resolution.residualQuantity = 50 CAD gain (positive) or loss (negative) for tax reporting.
// The actualExchange carries the full exchange chain so the 550 CAD can trace back through
// USD → exchange1 → CAD → btcExchange → BTC when subsequently spent or exchanged.
const residual = usdExchange.resolution.residualQuantity;

// Tx #6 (USD): consume 375 USD → actualExchange.from (ExchangedTXO)
const trans6 = ledger.newTransaction(trans6inputUSD, [usdExchange.actualExchange.from]);

// Tx #7 (CAD): actualExchange.to (ExchangedTXI) → 550 CAD cash
const trans7 = ledger.newTransaction(
    [usdExchange.actualExchange.to],
    cash.generateOutputs(cad, actualProceeds, ledger.transactions)
);

// ─── Verify ──────────────────────────────────────────────────────────────────
const verification = ledger.verify();
if (!verification.ok) throw verification.error;

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
    btcExchange,
    exchange1,
    expenseResolution,
    expenseTransactions,
    usdExchange,
    trans0,
    trans1,
    trans2,
    trans3,
    trans5,
    trans6,
    trans7,
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
    runCLI
});
