import { test } from "node:test";
import assert from "node:assert/strict";

import { makeFixture, openInto, commitSwap } from "../test-support/ledger-fixture.js";
import { expense } from "./expense.js";

// Commits an expense end to end: the consuming/surface transaction plus the hop and
// expense-recognition transactions the resolution emits.
function commitExpense(f: ReturnType<typeof makeFixture>, inputs: ReturnType<typeof f.cash.generateInputs>) {
    const resolution = expense(inputs, f.engine, f.ledger.transactions);
    f.ledger.newTransaction(inputs, resolution.getFromOutputs(f.exchangeExpense, f.ledger.transactions));
    resolution.createTransactions(f.exchangeExpense, f.ledger);
    return resolution;
}

test("expensing forward-exchanged value recaptures the edge and recognizes the basis at origin", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd); // 500 CAD → 375 USD (forward)

    // Expense the 375 USD entirely; its basis fully unwinds to the 500 CAD origin.
    const inputs = f.cash.generateInputs(f.usd, 375, f.ledger.transactions);
    commitExpense(f, inputs);

    assert.ok(f.ledger.verify().ok, "ledger must verify after expensing");

    // The USD is gone; the untouched 500 CAD remains in cash.
    assert.equal(f.cash.getBalance(f.usd, f.ledger.transactions), 0);
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 500);

    // The expense is recognized in the origin position (CAD) at its basis (500).
    assert.equal(f.exchangeExpense.getBalance(f.cad, f.ledger.transactions), 500);

    // The recaptured exchange nets to zero — no stale open positions.
    assert.equal(f.cadToUsd.getRootRawBalance(f.cad, f.ledger.transactions), 0n);
    assert.equal(f.cadToUsd.getRootRawBalance(f.usd, f.ledger.transactions), 0n);
});

test("expensing multi-hop value threads intermediate positions through hop transactions", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.inventory, f.oranges, 1500, f.usdToOranges);

    // Expense the 1500 oranges; provenance unwinds Oranges → USD → CAD across two exchanges.
    const inputs = f.inventory.generateInputs(f.oranges, 1500, f.ledger.transactions);
    commitExpense(f, inputs);

    assert.ok(f.ledger.verify().ok, "ledger must verify after a multi-hop expense");

    // Oranges fully expensed; recognized at the CAD origin basis (500).
    assert.equal(f.inventory.getBalance(f.oranges, f.ledger.transactions), 0);
    assert.equal(f.exchangeExpense.getBalance(f.cad, f.ledger.transactions), 500);

    // Both exchanges net to zero across every position — the USD hop cancelled out.
    for (const position of [f.cad, f.usd, f.oranges]) {
        assert.equal(f.cadToUsd.getRootRawBalance(position, f.ledger.transactions), 0n, `cadToUsd ${position.name}`);
        assert.equal(f.usdToOranges.getRootRawBalance(position, f.ledger.transactions), 0n, `usdToOranges ${position.name}`);
    }
});
