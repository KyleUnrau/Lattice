import { test } from "node:test";
import assert from "node:assert/strict";
import { ExpenseResolution } from "../../equity-policy/expense.js";
import { commitSwap, makeFixture, openInto } from "../utils/ledger-fixture.js";

// Commits an expense end to end: the consuming/surface transaction plus the hop and
// expense-recognition transactions the resolution emits.
function commitExpense(f: ReturnType<typeof makeFixture>, inputs: ReturnType<typeof f.cash.generateInputs>) {
    const resolution = new ExpenseResolution(inputs, f.ledger.transactions, f.engine, f.exchangeExpense);
    f.ledger.newTransaction(inputs, resolution.getFromOutputs());
    for (const tx of resolution.constructIntermediateTransactions()) f.ledger.addTransaction(tx);
    for (const tx of resolution.constructExpenseTransactions()) f.ledger.addTransaction(tx);
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
    assert.equal(f.cadToUsd.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n);
    assert.equal(f.cadToUsd.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n);
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
        assert.equal(f.cadToUsd.getSignedBalanceScaled(position, f.ledger.transactions), 0n, `cadToUsd ${position.name}`);
        assert.equal(f.usdToOranges.getSignedBalanceScaled(position, f.ledger.transactions), 0n, `usdToOranges ${position.name}`);
    }
});

test("expensing residual-derived value closes the residual leg and recognizes its inherited origin basis", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad); // 0.01 BTC → 1000 CAD
    commitSwap(f, f.cash, f.cad, 1000, f.cash, f.usd, 750, f.cadToUsd);    // 1000 CAD → 750 USD
    commitSwap(f, f.cash, f.usd, 750, f.cash, f.cad, 1100, f.usdToCad);    // close loop: 100 CAD gain, 0.001 BTC basis

    // Cash holds 1100 CAD = 1000 recovered (BTC-derived) + 100 residual-derived (gain). Expense it all.
    const inputs = f.cash.generateInputs(f.cad, 1100, f.ledger.transactions);
    const resolution = commitExpense(f, inputs);

    assert.ok(f.ledger.verify().ok, "ledger must verify after expensing residual-derived value");

    // The recovered (non-residual) portion fully unwinds to its BTC origin: 0.01 BTC of cost basis.
    assert.equal(resolution.recaptureGroups.length, 1);
    assert.equal(resolution.recaptureGroups[0]!.position, f.btc);
    assert.equal(resolution.recaptureGroups[0]!.totalQuantity, 1000000n, "0.01 BTC recovered basis");
    assert.equal(resolution.originAmounts.length, 0, "no no-lineage surface value — it was all BTC-derived");

    // The residual-derived portion is settled: its leg is closed and its deferred equity is
    // re-recognized in the ORIGIN position (BTC), not left as origin CAD.
    assert.equal(resolution.residualCloseOutputs.length, 1, "the residual leg is closed");
    assert.equal(resolution.residualRecognitions.length, 1);
    assert.equal(resolution.residualRecognitions[0]!.position, f.btc, "deferred gain recognized in BTC origin");
    assert.equal(resolution.residualRecognitions[0]!.quantity, 100000n, "0.001 BTC of inherited basis");

    // Cash fully expensed; total expense recognized in BTC = 0.01 (basis) + 0.001 (realized deferral) = 0.011.
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 0);
    assert.equal(f.exchangeExpense.getBalance(f.btc, f.ledger.transactions), 0.011);
    assert.equal(f.exchangeExpense.getBalance(f.cad, f.ledger.transactions), 0, "nothing expensed in CAD");

    // The provisional CAD gain is reversed and surfaces in BTC; the BTC→CAD path is fully recaptured.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "provisional CAD gain reversed");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.btc, f.ledger.transactions), -100000n, "0.001 BTC gain realized");
    assert.equal(f.btcToCad.getSignedBalanceScaled(f.btc, f.ledger.transactions), 0n, "BTC→CAD settled");
    assert.equal(f.btcToCad.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n);
});
