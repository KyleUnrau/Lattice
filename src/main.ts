import { clear } from "node:console";

import { dump, runCLI, write } from "./utils.js";
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";
import { TXIConsumption, TXO, type Output } from "./ledger-kernel/transactions/outputs.js";
import { TXI, type Input } from "./ledger-kernel/transactions/inputs.js";
import { Transaction } from "./ledger-kernel/transactions.js";
import { Ledger, Orientation } from "./ledger-kernel/ledger.js";
import { StandardAccount, AccountFolder } from "./ledger-kernel/accounts.js";
import type { Position } from "./ledger-kernel/positions.js";
import { Exchange, ExchangedTXO, type ReverseExchange } from "./ledger-kernel/transactions/exchange.js";

const btc: Position = { name: "Bitcoin" };
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

const cash: StandardAccount = currentAssets.addAccount("Cash", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const wallet: StandardAccount = currentAssets.addAccount("Cryptocurrency Wallet", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const openingBalance: StandardAccount = netWorth.addAccount("Opening Balance", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const exchangeExpense: StandardAccount = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<TXO>, fifo<TXI>);
const netTransfers: StandardAccount = netWorth.addAccount("Net Transfers", Orientation.Negative, fifo<TXO>, fifo<TXI>);
const capitalGains: StandardAccount = netIncome.addAccount("Capital Gains", Orientation.Positive, fifo<TXO>, fifo<TXI>);

const inputs: Input[][] = [];
const outputs: Output[][] = [];
const exchanges: Exchange[] = [];
const reverseExchanges: ReverseExchange[] = [];

inputs.push(openingBalance.generateInputs(btc, 0.02, ledger.transactions)); // Input #0
outputs.push(wallet.generateOutputs(btc, 0.02, ledger.transactions)); // Output #0
ledger.newTransaction(inputs[0]!, outputs[0]!); // Transaction #0

exchanges.push(new Exchange({quantity: 0.01, position: btc}, {quantity: 1000, position: cad})); // Exchange #0

inputs.push(cash.generateInputs(btc, 0.01, ledger.transactions)); // Input #1
outputs.push([exchanges[0]!.from]); // Output #1
ledger.newTransaction(inputs[1]!, outputs[1]!); // Transaction #1

inputs.push([exchanges[0]!.to]); // Input #2
outputs.push(cash.generateOutputs(cad, 1000, ledger.transactions)); // Output #2
ledger.newTransaction(inputs[2]!, outputs[2]!); // Transaction #2

exchanges.push(new Exchange({quantity: 500, position: cad}, {quantity: 375, position: usd})); // Exchange #1
reverseExchanges.push(exchanges[0]!.recapture(25, ledger.transactions)); // Reverse Exchange #0

inputs.push(cash.generateInputs(cad, 525, ledger.transactions)); // Input #3
outputs.push([exchanges[1]!.from]); // Output #3
outputs.push([reverseExchanges[0]!.from]); // Output #4
ledger.newTransaction(inputs[3]!, [...outputs[3]!, ...outputs[4]!]); // Transaction #3

inputs.push([reverseExchanges[0]!.to]); // Input #4
outputs.push(exchangeExpense.generateOutputs(btc, 0.00025, ledger.transactions)); // Output #5
ledger.newTransaction(inputs[4]!, outputs[5]!); // Transaction #4

inputs.push([exchanges[1]!.to]); // Input #5
outputs.push(cash.generateOutputs(usd, 375, ledger.transactions)); // Output #6
ledger.newTransaction(inputs[5]!, outputs[6]!); // Transaction #5

reverseExchanges.push(exchanges[1]!.recapture(375, ledger.transactions)); // Reverse Exchange #1

inputs.push(cash.generateInputs(usd, 375, ledger.transactions)); // Input #6
outputs.push([reverseExchanges[1]!.from]); // Output #7
ledger.newTransaction(inputs[6]!, outputs[7]!); // Transaction #6

inputs.push([reverseExchanges[1]!.to]); // Input #7
inputs.push(capitalGains.generateInputs(cad, 550 - reverseExchanges[1]!.to.quantity, ledger.transactions)); // Input #8
outputs.push(cash.generateOutputs(cad, 550, ledger.transactions)); // Output #8
ledger.newTransaction([...inputs[7]!, ...inputs[8]!], outputs[8]!); // Transaction #7

inputs.push(cash.generateInputs(cad, 550, ledger.transactions)); // Input #9
outputs.push(netTransfers.generateOutputs(cad, 500)) // Output #10
outputs.push(capitalGains.generateOutputs(cad, 50)); // Output #11
transactions.push(ledger.newTransaction(inputs[9]!, [...outputs[10]!, ...outputs[11]!])); // Transaction #8

inputs.push(netTransfers.generateInputs(btc, 0.005)); // Input #10
inputs.push(capitalGains.generateInputs(btc, 0.0005)); // Input #11
inputs.push(capitalGains.generateInputs(btc, 0.00025)); // Input #12
outputs.push(wallet.generateOutputs(btc, 0.00575)); // Output #12
transactions.push(ledger.newTransaction([...inputs[10]!, ...inputs[11]!, ...inputs[12]!], outputs[12]!)); // Transaction #9

ledger.exchangePosition(transactions[8]!.getOutputFromStaged(outputs[10]!), transactions[9]!.getInputFromStaged(inputs[10]!));
ledger.exchangePosition(transactions[8]!.getOutputFromStaged(outputs[11]!), transactions[9]!.getInputFromStaged(inputs[11]!));

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
    exchangeExpense,
    netTransfers,
    stagedInputs: inputs,
    stagedOutputs: outputs,
    fifo,
    clear,
    dump,
    write,
    StandardAccount: Account,
    AccountFolder,
    Ledger,
    Orientation,
    Transaction,
    TXO,
    TXI,
    runCLI
});