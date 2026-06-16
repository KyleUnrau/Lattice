import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, openInto } from "../utils/ledger-fixture.js";
import { Transaction, TransactionGroup } from "../../ledger-kernel/transactions.js";
import { ExchangeResolution } from "../../equity-policy/exchange.js";
import { ExpenseResolution } from "../../equity-policy/expense.js";

test("EventBuilder.newTransaction commits a transaction and register() appends it as a top-level group", () => {
    const f = makeFixture();

    const event = f.ledger.beginEvent();
    const tx = event.newTransaction({
        inputs: f.openingBalance.generateInputs(f.cad, 1000, event.view()),
        outputs: f.cash.generateOutputs(f.cad, 1000, event.view()),
    });

    assert.equal(f.ledger.groups.length, 0, "nothing is registered until register() is called");

    const group = event.register();

    assert.ok(group instanceof TransactionGroup);
    assert.equal(f.ledger.groups.length, 1);
    assert.equal(f.ledger.groups[0], group, "the group is registered as a top-level event");
    assert.deepEqual(group.flatten(), [tx]);
    assert.equal(f.ledger.transactions.length, 1, "the committed transaction is now visible on the ledger");
    assert.equal(f.ledger.transactions[0], tx);
    assert.ok(f.ledger.verify().ok);
});

test("ExchangeTransactions.toGroup() flattens in from → to → intermediates order, matching flatten()", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const fromInputs = f.cash.generateInputs(f.cad, 500, f.ledger.transactions);
    const toOutputs = f.cash.generateOutputs(f.usd, 375, f.ledger.transactions);
    const resolution = new ExchangeResolution(
        fromInputs, toOutputs, f.ledger.transactions,
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );
    const exchangeTxs = resolution.constructTransactions();

    const group = exchangeTxs.toGroup();
    assert.deepEqual(group.members, [exchangeTxs.from, exchangeTxs.to, exchangeTxs.intermediates]);
    assert.deepEqual(group.flatten(), exchangeTxs.flatten(), "toGroup().flatten() matches the wrapper's own flatten()");

    const event = f.ledger.beginEvent();
    event.record(group);
    event.register();
    assert.ok(f.ledger.verify().ok);
});

test("beginEvent() nests sub-flows recorded before register() into one composite top-level group", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const event = f.ledger.beginEvent();

    const expensedInputs = f.cash.generateInputs(f.cad, 50, event.view());
    const expense = new ExpenseResolution(expensedInputs, event.view(), f.engine, f.exchangeExpense);
    const expenseGroup = expense.constructTransactions().toGroup();
    event.record(expenseGroup);

    const fromInputs = f.cash.generateInputs(f.cad, 500, event.view());
    const toOutputs = f.cash.generateOutputs(f.usd, 375, event.view());
    const exchange = new ExchangeResolution(
        fromInputs, toOutputs, event.view(),
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );
    const exchangeGroup = exchange.constructTransactions().toGroup();
    event.record(exchangeGroup);

    assert.equal(f.ledger.groups.length, 1, "only openInto's own event is registered so far");

    const composite = event.register();

    assert.equal(f.ledger.groups.length, 2, "the composite is registered as a second top-level event");
    assert.equal(f.ledger.groups[1], composite);
    assert.deepEqual(composite.members, [expenseGroup, exchangeGroup], "sub-flows are nested, not flattened");
    assert.equal(
        composite.flatten().length,
        expenseGroup.flatten().length + exchangeGroup.flatten().length,
        "the composite flattens through its nested groups"
    );
    assert.ok(f.ledger.verify().ok, "the ledger verifies once the composite is registered");
});

test("TransactionGroup.flatten() recurses depth-first through nested groups", () => {
    const f = makeFixture();

    const event = f.ledger.beginEvent();
    const tx = event.newTransaction({
        inputs: f.openingBalance.generateInputs(f.cad, 100, event.view()),
        outputs: f.cash.generateOutputs(f.cad, 100, event.view()),
    });
    event.register();
    const inner = new TransactionGroup([tx]);
    const outer = new TransactionGroup([inner]);

    assert.deepEqual(outer.flatten(), [tx]);
});
