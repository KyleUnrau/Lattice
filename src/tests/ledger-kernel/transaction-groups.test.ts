import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, openInto, commitSwap } from "../utils/ledger-fixture.js";
import { TransactionGroup } from "../../ledger-kernel/transactions/group.js";
import { Transaction } from "../../ledger-kernel/transactions/transaction.js";
import { ExchangeResolution } from "../../equity-policy/exchange.js";
import { TerminalResolution } from "../../equity-policy/terminal.js";

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

test("ExchangeTransactions.toGroup() drops empty role-groups: a pure forward exchange yields [from, to]", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const fromInputs = f.cash.generateInputs(f.cad, 500, f.ledger.transactions);
    const toOutputs = f.cash.generateOutputs(f.usd, 375, f.ledger.transactions);
    const resolution = new ExchangeResolution(
        fromInputs, toOutputs, f.ledger.transactions,
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );
    const exchangeTxs = resolution.constructTransactions();

    // A pure forward exchange threads no intermediate hops and recognizes no terminal loss, so both
    // role-groups are empty and toGroup() omits them rather than preserving empty noise members.
    assert.equal(exchangeTxs.intermediates.members.length, 0, "no intermediate hops on a pure forward exchange");
    assert.equal(exchangeTxs.terminalLoss.members.length, 0, "no terminal loss on a pure forward exchange");

    const group = exchangeTxs.toGroup();
    assert.deepEqual(group.members, [exchangeTxs.from, exchangeTxs.to], "empty intermediates/terminalLoss are dropped");
    assert.deepEqual(group.flatten(), exchangeTxs.flatten(), "toGroup().flatten() matches the wrapper's own flatten()");

    const event = f.ledger.beginEvent();
    event.record(group);
    event.register();
    assert.ok(f.ledger.verify().ok);
});

test("ExchangeTransactions.toGroup() orders members from → to → intermediates when a hop is present", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);
    // Build a CAD→USD→Oranges loop so closing it back to CAD threads one USD intermediate hop.
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.inventory, f.oranges, 1500, f.usdToOranges);

    // Close Oranges→CAD at a gain (600 CAD vs 500 basis) WITHOUT committing, so the wrapper can be
    // inspected. The gain keeps terminalLoss empty, leaving members exactly [from, to, intermediates].
    const fromInputs = f.inventory.generateInputs(f.oranges, 1500, f.ledger.transactions);
    const toOutputs = f.cash.generateOutputs(f.cad, 600, f.ledger.transactions);
    const resolution = new ExchangeResolution(
        fromInputs, toOutputs, f.ledger.transactions,
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.orangesToCad
    );
    const exchangeTxs = resolution.constructTransactions();

    // The multi-hop unwind threads a real USD intermediate hop, so intermediates is non-empty here.
    assert.notEqual(exchangeTxs.intermediates.members.length, 0, "the loop close threads a real intermediate hop");
    assert.equal(exchangeTxs.terminalLoss.members.length, 0, "closing at a gain produces no terminal loss");

    const group = exchangeTxs.toGroup();
    assert.deepEqual(
        group.members,
        [exchangeTxs.from, exchangeTxs.to, exchangeTxs.intermediates],
        "members mirror from → to → intermediates in commit order"
    );
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
    const expense = new TerminalResolution(expensedInputs, event.view(), f.engine, f.exchangeExpense);
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
