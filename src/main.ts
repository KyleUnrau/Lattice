
import { Ledger } from "./ledger-kernel/ledger.js";
import { Account, AccountFolder, Orientation } from "./ledger-kernel/account.js";
import {
    Position,
    Transaction,
    AccountTransactionEntry,
    TransactionFlow,
    constructTransaction,
} from "./ledger-kernel/transaction.js";

import {
    LotEngine,
    FifoBasisResolver,
} from "./lot-engine/misc.js";

import { must, runCLI, type Result } from "./utils.js";

const basisResolver = new FifoBasisResolver();

const cad: Position = {
    name: "Canadian Dollars",
    minimumIncrement: 0.01,
    basisResolver,
};

const usd: Position = {
    name: "United States Dollars",
    minimumIncrement: 0.01,
    basisResolver,
};

const oranges: Position = {
    name: "Oranges",
    minimumIncrement: 0.01,
    basisResolver,
};

// Accounts / tree
const assets = new AccountFolder("Assets", Orientation.Positive);
const cash = new Account("Cash", Orientation.Positive);
const inventory = new Account("Inventory", Orientation.Positive);

const receivables = new AccountFolder("Accounts Receivable", Orientation.Positive);
const roddyReceivable = new Account("Accounts Receivable - Roddy", Orientation.Positive);
receivables.children.push(roddyReceivable);

assets.children.push(cash, inventory, receivables);

const netWorth = new AccountFolder("Net Worth", Orientation.Negative);
const originationClearing = new Account("Origination Clearing", Orientation.Positive);

const expenses = new AccountFolder("Expenses", Orientation.Negative);
const salesExpense = new Account("Sales Expense", Orientation.Positive);
const gstExpense = new Account("GST Expense", Orientation.Positive);
expenses.children.push(salesExpense, gstExpense);

const liabilities = new AccountFolder("Liabilities", Orientation.Negative);
const gstCollected = new Account("GST Collected", Orientation.Positive);
liabilities.children.push(gstCollected);

netWorth.children.push(originationClearing, expenses);

const ledger = new Ledger(
    [assets, liabilities, netWorth],
    originationClearing
);

// Helpers
function tx(
    date: Date,
    entries: AccountTransactionEntry[],
    flows: TransactionFlow[] = []
): Transaction {
    return must(constructTransaction(ledger, date, entries, flows));
}

const transactions: Transaction[] = [
    // Opening CAD cash
    tx(
        new Date("2026-01-01T00:00:00Z"),
        [
            { account: cash, position: cad, delta: 1000 },
            { account: originationClearing, position: cad, delta: 1000 },
        ]
    ),

    // Opening USD receivable from Roddy
    tx(
        new Date("2026-01-02T00:00:00Z"),
        [
            { account: roddyReceivable, position: usd, delta: 200 },
            { account: originationClearing, position: usd, delta: 200 },
        ]
    ),

    // JT1 — buy oranges with CAD, plus CAD expenses
    // CAD side:
    //   Cash -300
    //   Sales Expense +20
    //   GST Expense +15
    //   Origination Clearing +265
    //
    // Oranges side:
    //   Inventory +610
    //   Origination Clearing -610
    //
    // Flow:
    //   OriginationClearing/CAD -> Inventory/Oranges
    tx(
        new Date("2026-01-03T00:00:00Z"),
        [
            { account: cash, position: cad, delta: -300 },
            { account: salesExpense, position: cad, delta: 20 },
            { account: gstExpense, position: cad, delta: 15 },
            { account: inventory, position: oranges, delta: 610 },
        ],
        [
            {
                from: {
                    account: cash,
                    position: cad,
                    quantity: 265,
                },
                to: {
                    account: inventory,
                    position: oranges,
                    quantity: 610,
                },
            },
        ]
    ),

    // JT2 — sell some oranges for CAD
    //
    // CAD side:
    //   Cash +168
    //   GST Collected -8
    //   Origination Clearing -160
    //
    // Oranges side:
    //   Inventory -40
    //   Origination Clearing +40
    //
    // Flow:
    //   Inventory/Oranges -> Cash/CAD
    tx(
        new Date("2026-01-04T00:00:00Z"),
        [
            { account: cash, position: cad, delta: 168 },
            { account: gstCollected, position: cad, delta: -8 },
            { account: inventory, position: oranges, delta: -40 },
        ],
        [
            {
                from: {
                    account: inventory,
                    position: oranges,
                    quantity: 40,
                },
                to: {
                    account: cash,
                    position: cad,
                    quantity: 168,
                },
            },
        ]
),

    // JT3 — sell more oranges for USD
    //
    // USD side:
    //   Cash +150
    //   Origination Clearing -150
    //
    // Oranges side:
    //   Inventory -50
    //   Origination Clearing +50
    //
    // Flow:
    //   Inventory/Oranges -> Cash/USD
    tx(
        new Date("2026-01-05T00:00:00Z"),
        [
            { account: cash, position: usd, delta: 150 },
            { account: inventory, position: oranges, delta: -50 },
        ],
        [
            {
                from: {
                    account: inventory,
                    position: oranges,
                    quantity: 50,
                },
                to: {
                    account: cash,
                    position: usd,
                    quantity: 150,
                },
            },
        ]
    ),

    // JT4
    tx(
        new Date("2026-01-06T00:00:00Z"),
        [
            { account: cash, position: usd, delta: -150 },
            { account: cash, position: cad, delta: 193.55 },
        ],
        [
            {
                from: {
                    account: cash,
                    position: usd,
                    quantity: 150,
                },
                to: {
                    account: cash,
                    position: cad,
                    quantity: 193.55,
                },
            },
        ]
    ),
];

ledger.transactions.push(...transactions);

const engine = new LotEngine(ledger);

console.log("Asset balances:");
console.log(ledger.getBalances(assets));

console.log("\nNet worth balances:");
console.log(ledger.getBalances(netWorth));

console.log("\nLots:");
console.dir(engine.lots, { depth: null });

runCLI({
    ledger,
    engine,
    transactions,
    assets,
    liabilities,
    netWorth,
    cash,
    inventory,
    roddyReceivable,
    originationClearing,
    salesExpense,
    gstExpense,
    gstCollected,
    cad,
    usd,
    oranges,
});