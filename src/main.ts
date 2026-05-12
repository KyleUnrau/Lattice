import { clear } from "node:console";

import { dump, runCLI, write } from "./utils.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { AccountTransactionEngine } from "./ledger-kernel/accounts.js";
import {  TXO, TXI, Transaction } from "./ledger-kernel/transactions.js";
import type { Position } from "./ledger-kernel/positions.js";

const cad: Position = { name: "Canadian Dollars" };
const usd: Position = { name: "United States Dollars" };

const openingBalance: AccountTransactionEngine = new AccountTransactionEngine(cad, fifo<TXO>, fifo<TXI>);
const cadCash: AccountTransactionEngine = new AccountTransactionEngine(cad, fifo<TXO>, fifo<TXI>);
const exchangeExpense: AccountTransactionEngine = new AccountTransactionEngine(cad, fifo<TXO>, fifo<TXI>);
const transfersToUSD: AccountTransactionEngine = new AccountTransactionEngine(cad, fifo<TXO>, fifo<TXI>);

const transfersFromCAD: AccountTransactionEngine = new AccountTransactionEngine(usd, fifo<TXO>, fifo<TXI>);
const usdCash: AccountTransactionEngine = new AccountTransactionEngine(usd, fifo<TXO>, fifo<TXI>);

const entry1 = openingBalance.inputStage(1000);
const entry2 = cadCash.outputStage(1000);

const trans1 = new Transaction([entry1], [entry2]);

const entry3 = cadCash.inputStage(525);
const entry4 = exchangeExpense.outputStage(25);
const entry5 = transfersToUSD.outputStage(500);

const entry6 = transfersFromCAD.inputStage(375);
const entry7 = usdCash.outputStage(375);

const trans2cad = new Transaction([entry3], [entry4, entry5]);
const trans2usd = new Transaction([entry6], [entry7]);

Transaction.exchangeLink(trans2cad.getOutputFromStaged(entry5), trans2usd.getInputFromStaged(entry6));

runCLI({
    cad,
    usd,
    openingBalance,
    cadCash,
    exchangeExpense, 
    transfersToUSD,
    transfersFromCAD,
    usdCash,
    entry1,
    entry2,
    trans1,
    entry3,
    entry4,
    entry5,
    entry6,
    entry7,
    trans2cad,
    trans2usd,
    fifo,
    clear,
    dump,
    write,
    Transaction,
    TXO,
    TXI
});