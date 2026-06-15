import { clear } from "node:console";

import { runCLI } from "./utils.js";
import { scale, unscale } from "./ledger-kernel/positions.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { AccountFolder } from "./ledger-kernel/accounts/folder.js";
import { Account } from "./ledger-kernel/accounts/account.js";
import { Exchange } from "./ledger-kernel/transactions/cross-position.js";
import { BookValueEngine } from "./equity-policy/book-value/engine.js";
import { unwind } from "./equity-policy/recaptures.js";
import { ScenarioExpensesCase1 } from "./scenarios.js";
import { ExchangeResolution } from "./equity-policy/exchange.js";
import { ExpenseResolution } from "./equity-policy/expense.js";

runCLI({
    ledger: ScenarioExpensesCase1.ledger,
    engine: ScenarioExpensesCase1.engine,
    positions: ScenarioExpensesCase1.positions,
    accounts: ScenarioExpensesCase1.accounts,
    phases: ScenarioExpensesCase1.phases,
    buildSampleLedger: ScenarioExpensesCase1.buildSampleLedger,
    fifo,
    clear,
    Account,
    AccountFolder,
    Ledger,
    Orientation,
    Transaction,
    Exchange,
    BookValueEngine,
    ExchangeResolution,
    ExpenseResolution,
    scale,
    unscale,
    unwind
});
