import { BookValueEngine } from "../../equity-policy/book-value/engine.js";
import { type SwapResult, swap } from "../../equity-policy/exchange/swap.js";
import type { Account } from "../../ledger-kernel/accounts/account.js";
import type { ResidualAccount, ExchangePositionsAccount } from "../../ledger-kernel/accounts/computed.js";
import { AccountFolder } from "../../ledger-kernel/accounts/folder.js";
import { fifo } from "../../ledger-kernel/disposal-methods/basic-fifo.js";
import { Ledger, Orientation } from "../../ledger-kernel/ledger.js";
import type { Position } from "../../ledger-kernel/positions.js";
import type { UTXI } from "../../ledger-kernel/transactions/inputs.js";
import type { UTXO } from "../../ledger-kernel/transactions/outputs.js";

/**
 * A self-contained chart of accounts + ledger for tests, mirroring the shape of `src/main.ts`
 * but constructed fresh on every call so test cases never share mutable lot state.
 */
export interface Fixture {
    cad: Position;
    usd: Position;
    oranges: Position;
    btc: Position;
    ledger: Ledger;
    engine: BookValueEngine;
    cash: Account;
    inventory: Account;
    wallet: Account;
    drawings: Account;
    openingBalance: Account;
    exchangeExpense: Account;
    capitalGains: ResidualAccount;
    capitalLosses: ResidualAccount;
    cadToUsd: ExchangePositionsAccount;
    usdToOranges: ExchangePositionsAccount;
    orangesToCad: ExchangePositionsAccount;
    btcToCad: ExchangePositionsAccount;
    usdToCad: ExchangePositionsAccount;
    cadToBtc: ExchangePositionsAccount;
}

export function makeFixture(): Fixture {
    const cad: Position = { name: "Canadian Dollars", decimals: 2 };
    const usd: Position = { name: "United States Dollars", decimals: 2 };
    const oranges: Position = { name: "Oranges", decimals: 0 };
    const btc: Position = { name: "Bitcoin", decimals: 8 };

    const netAssets = new AccountFolder("Net Assets", Orientation.Positive);
    const netWorth = new AccountFolder("Net Worth", Orientation.Negative);
    const ledger = new Ledger(netAssets, netWorth);
    const engine = new BookValueEngine(ledger.transactions);

    const assets = netAssets.addFolder("Assets", Orientation.Positive);
    const currentAssets = assets.addFolder("Current Assets", Orientation.Positive);
    const netIncome = netWorth.addFolder("Net Income", Orientation.Positive);
    const expenses = netIncome.addFolder("Expenses", Orientation.Negative);

    const cash = currentAssets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
    const inventory = currentAssets.addAccount("Inventory", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
    const wallet = currentAssets.addAccount("Cryptocurrency Wallet", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
    const openingBalance = netWorth.addAccount("Opening Balance", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
    const drawings = netWorth.addAccount("Drawings", Orientation.Negative, fifo<UTXO>, fifo<UTXI>);
    const exchangeExpense = expenses.addAccount("Exchange Expense", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);

    const netCapitalGains = netIncome.addFolder("Net Capital Gains (Losses)", Orientation.Positive);
    const capitalGains = netCapitalGains.addResidualAccount("Capital Gains", Orientation.Positive, "Capital Losses");
    const capitalLosses = netCapitalGains.addResidualAccount("Capital Loss", Orientation.Negative);

    const cadToUsd = netWorth.addExchangeAccount("Transfers CAD→USD", Orientation.Positive);
    const usdToOranges = netWorth.addExchangeAccount("Transfers USD→Oranges", Orientation.Positive);
    const orangesToCad = netWorth.addExchangeAccount("Transfers Oranges→CAD", Orientation.Positive);
    const btcToCad = netWorth.addExchangeAccount("Transfers BTC→CAD", Orientation.Positive);
    const usdToCad = netWorth.addExchangeAccount("Transfers USD→CAD", Orientation.Positive);
    const cadToBtc = netWorth.addExchangeAccount("Transfers CAD→BTC", Orientation.Positive);

    return { cad, usd, oranges, btc, ledger, engine, cash, inventory, wallet, drawings, openingBalance, exchangeExpense, capitalGains, capitalLosses, cadToUsd, usdToOranges, orangesToCad, btcToCad, usdToCad, cadToBtc };
}

/** Commits an opening-balance credit of `value` units of `position` into `cash`. */
export function openInto(f: Fixture, account: Account, position: Position, value: number): void {
    f.ledger.newTransaction(
        f.openingBalance.generateInputs(position, value, f.ledger.transactions),
        account.generateOutputs(position, value, f.ledger.transactions),
    );
}

/**
 * Drives a full-quantity, two-account exchange end to end: draws `quantity` of `fromPosition` from
 * `fromAccount`, stages `proceeds` of `toPosition` into `toAccount`, runs {@link swap}, and commits
 * the consuming → hops → receiving chain to the ledger. Returns the {@link SwapResult}.
 */
export function commitSwap(
    f: Fixture,
    fromAccount: Account, fromPosition: Position, quantity: number,
    toAccount: Account, toPosition: Position, proceeds: number,
    exchangeAccount: ExchangePositionsAccount
): SwapResult {
    const fromInputs = fromAccount.generateInputs(fromPosition, quantity, f.ledger.transactions);
    const toOutputs = toAccount.generateOutputs(toPosition, proceeds, f.ledger.transactions);

    const result = swap({
        fromInputs, toOutputs, engine: f.engine, transactions: f.ledger.transactions,
        residualAccount: { gain: f.capitalGains, loss: f.capitalLosses }, exchangeAccount,
    });

    f.ledger.newTransaction(fromInputs, result.fromOutputs);
    f.ledger.addTransaction(...result.intermediates, result.to);
    return result;
}
