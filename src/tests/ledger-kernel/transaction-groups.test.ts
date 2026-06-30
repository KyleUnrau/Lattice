import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, openInto, commitSwap } from "../utils/ledger-fixture.js";
import { TransactionGroup, OrderedTransactionGroup } from "../../ledger-kernel/transactions/group.js";
import { Transaction } from "../../ledger-kernel/transactions/transaction.js";
import { ExchangeResolution, ExchangeTransactions } from "../../equity-policy/exchange.js";
import { TerminalResolution, TerminalTransactions } from "../../equity-policy/terminal.js";

// ---------------------------------------------------------------------------
// Transaction.flatten()
// ---------------------------------------------------------------------------

test("Transaction.flatten() returns a single-element array containing itself", () => {
    const f = makeFixture();
    const event = f.ledger.beginEvent();
    const tx = event.newTransaction({
        inputs: f.openingBalance.generateInputs(f.cad, 100, event.view()),
        outputs: f.cash.generateOutputs(f.cad, 100, event.view()),
    });
    event.register();

    const flat = tx.flatten();
    assert.equal(flat.length, 1);
    assert.equal(flat[0], tx);
});

// ---------------------------------------------------------------------------
// EventBuilder.newTransaction / register()
// ---------------------------------------------------------------------------

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
    assert.deepEqual([...group.flatten()], [tx]);
    assert.equal(f.ledger.transactions.length, 1, "the committed transaction is now visible on the ledger");
    assert.equal(f.ledger.transactions[0], tx);
    assert.ok(f.ledger.verify().ok);
});

// ---------------------------------------------------------------------------
// ExchangeTransactions semantic structure
// ---------------------------------------------------------------------------

test("ExchangeTransactions is a TransactionGroup subclass with kind 'exchange'", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const fromInputs = f.cash.generateInputs(f.cad, 500, f.ledger.transactions);
    const toOutputs = f.cash.generateOutputs(f.usd, 375, f.ledger.transactions);
    const resolution = new ExchangeResolution(
        fromInputs, toOutputs, f.ledger.transactions,
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );
    const exchangeTxs = resolution.constructTransactions();

    assert.ok(exchangeTxs instanceof ExchangeTransactions, "ExchangeTransactions is the concrete type");
    assert.ok(exchangeTxs instanceof TransactionGroup, "ExchangeTransactions extends TransactionGroup");
    assert.equal(exchangeTxs.kind, "exchange");
});

test("ExchangeTransactions.members drops empty intermediates and absent terminalLoss", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const fromInputs = f.cash.generateInputs(f.cad, 500, f.ledger.transactions);
    const toOutputs = f.cash.generateOutputs(f.usd, 375, f.ledger.transactions);
    const resolution = new ExchangeResolution(
        fromInputs, toOutputs, f.ledger.transactions,
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );
    const exchangeTxs = resolution.constructTransactions();

    // A pure forward exchange threads no intermediate hops and recognizes no terminal loss.
    assert.equal(exchangeTxs.intermediates.members.length, 0, "no intermediate hops on a pure forward exchange");
    assert.equal(exchangeTxs.terminalLoss, undefined, "no terminal loss on a pure forward exchange");

    // members omits the empty intermediates group and the absent terminalLoss
    assert.deepEqual(exchangeTxs.members, [exchangeTxs.from, exchangeTxs.to], "only from and to are present");
    assert.deepEqual([...exchangeTxs.flatten()], [exchangeTxs.from, exchangeTxs.to], "flatten returns from then to");

    const event = f.ledger.beginEvent();
    event.record(exchangeTxs);
    event.register();
    assert.ok(f.ledger.verify().ok);
});

test("ExchangeTransactions.members orders from → to → intermediates when a hop is present", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);
    // Build a CAD→USD→Oranges loop so closing it back to CAD threads one USD intermediate hop.
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.inventory, f.oranges, 1500, f.usdToOranges);

    // Close Oranges→CAD at a gain (600 CAD vs 500 basis). The gain keeps terminalLoss undefined,
    // leaving members exactly [from, to, intermediates].
    const fromInputs = f.inventory.generateInputs(f.oranges, 1500, f.ledger.transactions);
    const toOutputs = f.cash.generateOutputs(f.cad, 600, f.ledger.transactions);
    const resolution = new ExchangeResolution(
        fromInputs, toOutputs, f.ledger.transactions,
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.orangesToCad
    );
    const exchangeTxs = resolution.constructTransactions();

    assert.notEqual(exchangeTxs.intermediates.members.length, 0, "the loop close threads a real intermediate hop");
    assert.equal(exchangeTxs.terminalLoss, undefined, "closing at a gain produces no terminal loss");

    // Commit order: from → to → intermediates. This is an existing ledger-history convention;
    // tests assert it explicitly so it is not changed silently.
    assert.deepEqual(
        exchangeTxs.members,
        [exchangeTxs.from, exchangeTxs.to, exchangeTxs.intermediates],
        "members mirror from → to → intermediates in commit order"
    );

    const event = f.ledger.beginEvent();
    event.record(exchangeTxs);
    event.register();
    assert.ok(f.ledger.verify().ok);
});

// ---------------------------------------------------------------------------
// TerminalTransactions semantic structure
// ---------------------------------------------------------------------------

test("TerminalTransactions is a TransactionGroup subclass with kind 'terminal'", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const inputs = f.cash.generateInputs(f.cad, 50, f.ledger.transactions);
    const resolution = new TerminalResolution(inputs, f.ledger.transactions, f.engine, f.exchangeExpense);
    const terminalTxs = resolution.constructTransactions();

    assert.ok(terminalTxs instanceof TerminalTransactions, "TerminalTransactions is the concrete type");
    assert.ok(terminalTxs instanceof TransactionGroup, "TerminalTransactions extends TransactionGroup");
    assert.equal(terminalTxs.kind, "terminal");
});

// ---------------------------------------------------------------------------
// EventBuilder.record() accepts TransactionMaterial directly (no .toGroup())
// ---------------------------------------------------------------------------

test("event.record(exchangeTxs) works without .toGroup() and a single-exchange event IS the ExchangeTransactions", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const event = f.ledger.beginEvent();
    const fromInputs = f.cash.generateInputs(f.cad, 500, event.view());
    const toOutputs = f.cash.generateOutputs(f.usd, 375, event.view());
    const exchange = new ExchangeResolution(
        fromInputs, toOutputs, event.view(),
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );
    const exchangeTxs = exchange.constructTransactions();
    event.record(exchangeTxs);

    // When the event has a single TransactionGroup member, generateGroup() returns it directly —
    // the registered top-level event IS the ExchangeTransactions, not a wrapper around it.
    const registered = event.register();
    assert.ok(registered instanceof ExchangeTransactions, "single-exchange event is the ExchangeTransactions itself");
    assert.equal(f.ledger.groups[1], exchangeTxs, "the semantic bundle is stored directly in ledger.groups");
    assert.ok(f.ledger.verify().ok);
});

test("event.record(resolution) uses the TransactionMaterialFactory interface to materialize on the fly", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const fromInputs = f.cash.generateInputs(f.cad, 500, f.ledger.transactions);
    const toOutputs = f.cash.generateOutputs(f.usd, 375, f.ledger.transactions);
    const resolution = new ExchangeResolution(
        fromInputs, toOutputs, f.ledger.transactions,
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );

    // Pass the resolution object itself — EventBuilder calls constructTransactions() internally.
    const event = f.ledger.beginEvent();
    event.record(resolution);
    const registered = event.register();

    assert.ok(registered instanceof ExchangeTransactions, "materialized from factory into ExchangeTransactions");
    assert.ok(f.ledger.verify().ok);
});

// ---------------------------------------------------------------------------
// Composite events preserve semantic members
// ---------------------------------------------------------------------------

test("beginEvent() nests sub-flows as semantic nodes rather than anonymous groups", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const event = f.ledger.beginEvent();

    const expensedInputs = f.cash.generateInputs(f.cad, 50, event.view());
    const expense = new TerminalResolution(expensedInputs, event.view(), f.engine, f.exchangeExpense);
    const expenseTxs = expense.constructTransactions();
    event.record(expenseTxs);

    const fromInputs = f.cash.generateInputs(f.cad, 500, event.view());
    const toOutputs = f.cash.generateOutputs(f.usd, 375, event.view());
    const exchange = new ExchangeResolution(
        fromInputs, toOutputs, event.view(),
        f.engine, { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd
    );
    const exchangeTxs = exchange.constructTransactions();
    event.record(exchangeTxs);

    assert.equal(f.ledger.groups.length, 1, "only openInto's own event is registered so far");

    const composite = event.register();

    assert.equal(f.ledger.groups.length, 2, "the composite is registered as a second top-level event");
    assert.equal(f.ledger.groups[1], composite);

    // The composite's members are the semantic bundles themselves — not anonymous .toGroup() results.
    assert.deepEqual(composite.members, [expenseTxs, exchangeTxs], "sub-flows are semantic nodes, not anonymous groups");
    assert.ok(composite.members[0] instanceof TerminalTransactions, "first member is a TerminalTransactions");
    assert.ok(composite.members[1] instanceof ExchangeTransactions, "second member is an ExchangeTransactions");

    assert.equal(
        composite.flatten().length,
        expenseTxs.flatten().length + exchangeTxs.flatten().length,
        "the composite flattens through its nested groups"
    );
    assert.ok(f.ledger.verify().ok, "the ledger verifies once the composite is registered");
});

// ---------------------------------------------------------------------------
// OrderedTransactionGroup recursive flatten
// ---------------------------------------------------------------------------

test("OrderedTransactionGroup.flatten() recurses depth-first through nested groups", () => {
    const f = makeFixture();

    const event = f.ledger.beginEvent();
    const tx = event.newTransaction({
        inputs: f.openingBalance.generateInputs(f.cad, 100, event.view()),
        outputs: f.cash.generateOutputs(f.cad, 100, event.view()),
    });
    event.register();

    const inner = new OrderedTransactionGroup([tx]);
    const outer = new OrderedTransactionGroup([inner]);

    assert.deepEqual([...outer.flatten()], [tx]);
});
