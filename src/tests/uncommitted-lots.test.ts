import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, openInto } from "./test-support/ledger-fixture.js";

test("generated lots only affect balances once their transaction is committed", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    assert.ok(f.ledger.verify().ok);
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 1000);

    // Generate a 750 CAD receipt into cash WITHOUT building or committing a transaction for it.
    const receipt = f.cash.generateOutputs(f.cad, 750, f.ledger.transactions);

    // Balances, summary, and verify must ignore the uncommitted lot.
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 1000, "uncommitted receipt must not change the balance");
    assert.equal(f.ledger.summarize(f.cad).netAssets.balance, 1000, "uncommitted receipt must not change the summary");
    assert.ok(f.ledger.verify().ok, "ledger must still verify with an uncommitted lot outstanding");

    // Committing it inside a balanced transaction makes it count.
    const equityInputs = f.openingBalance.generateInputs(f.cad, 750, f.ledger.transactions);
    f.ledger.newTransaction(equityInputs, receipt);

    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 1750, "committed receipt now counts");
    assert.ok(f.ledger.verify().ok, "ledger still balances after committing the receipt");
});