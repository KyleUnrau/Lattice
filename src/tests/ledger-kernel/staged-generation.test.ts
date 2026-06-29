import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, openInto } from "../utils/ledger-fixture.js";
import { Transaction } from "../../ledger-kernel/transactions/transaction.js";
import { GenerationContext } from "../../ledger-kernel/generation-context.js";
import { UTXI, UTXOConsumption } from "../../ledger-kernel/transactions/inputs.js";
import { UTXO } from "../../ledger-kernel/transactions/outputs.js";

test("a generation session keeps lot availability accurate across multiple draws", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const generation = new GenerationContext(f.ledger.transactions);

    // First draw consumes the whole committed 1000 lot.
    const first = generation.generateInputs(f.cash, f.cad, 1000);
    assert.equal(first.length, 1);
    assert.ok(first[0] instanceof UTXOConsumption, "first draw should consume the committed UTXO lot");

    // Second draw must see cash as exhausted (the first draw is staged) and mint a remainder UTXI
    // instead of double-drawing the already-spent lot.
    const second = generation.generateInputs(f.cash, f.cad, 50);
    assert.equal(second.length, 1);
    assert.ok(second[0] instanceof UTXI, "second draw must mint a remainder UTXI, not re-consume the spent lot");
    assert.equal((second[0] as UTXI).quantity, 5000n, "remainder must be the full 50 CAD (5000 in cents)");
});

test("Transaction.verify throws when two consumptions over-draw the same lot", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const draw = f.cash.generateInputs(f.cad, 1000, f.ledger.transactions);
    const source = (draw[0] as UTXOConsumption).source;

    // Two full-balance consumptions of the same lot: each fits individually, together they double-spend.
    const c1 = new UTXOConsumption(source.quantity, source);
    const c2 = new UTXOConsumption(source.quantity, source);
    const balancingOutput = new UTXO(source.quantity * 2n, f.cad);

    assert.throws(
        () => new Transaction([c1, c2], [balancingOutput], f.ledger.transactions),
        /over-consume the lot/,
        "constructing a transaction that over-draws a single lot must throw"
    );
});

test("ledger.verify backstops over-consumption spread across a batch of transactions", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);
    assert.ok(f.ledger.verify().ok, "ledger starts balanced and valid");

    // Both transactions are built against the same pre-commit snapshot, so each one's own verify sees
    // the full 1000 available and passes — the double-spend only becomes visible once both are committed.
    const t1 = new Transaction(
        f.cash.generateInputs(f.cad, 1000, f.ledger.transactions),
        f.inventory.generateOutputs(f.cad, 1000, f.ledger.transactions),
        f.ledger.transactions
    );
    const t2 = new Transaction(
        f.cash.generateInputs(f.cad, 1000, f.ledger.transactions),
        f.wallet.generateOutputs(f.cad, 1000, f.ledger.transactions),
        f.ledger.transactions
    );

    const event = f.ledger.beginEvent();
    event.record(t1);
    event.record(t2);
    event.register();

    const result = f.ledger.verify();
    assert.ok(!result.ok, "ledger.verify must reject a history where a lot has been over-consumed");
});

test("uncommitted lots still do not affect balances until committed", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    f.cash.generateOutputs(f.cad, 750, f.ledger.transactions);

    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 1000, "uncommitted receipt must not change the balance");
    assert.ok(f.ledger.verify().ok, "ledger must still verify with an uncommitted lot outstanding");
});
