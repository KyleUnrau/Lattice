import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOriginLeaves } from "../equity-policy/book-value/lineage.js";
import { ExchangeResolution } from "../equity-policy/exchange/resolution.js";
import { UTXOConsumption } from "../ledger-kernel/transactions/inputs.js";
import { makeFixture, openInto, commitSwap } from "./test-support/ledger-fixture.js";

// Helper: the open-position balance an ExchangePositionsAccount reports for a position.
function openBalance(account: { getRootRawBalance(p: any, t: any): bigint }, position: any, transactions: any): bigint {
    return account.getRootRawBalance(position, transactions);
}

test("forward exchange links only the exchanged portion and the ledger stays balanced", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const result = commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);

    assert.ok(f.ledger.verify().ok, "ledger must verify after a forward exchange");

    // The exchange edge spans exactly the exchanged portion — 500 CAD ↔ 375 USD — and nothing more.
    assert.notEqual(result.resolution.exchange, null);
    assert.equal(result.resolution.exchange!.from.quantity, 50000n, "from-side = 500 CAD");
    assert.equal(result.resolution.exchange!.to.quantity, 37500n, "to-side = 375 USD");

    // The open position lives only on its scoped account; the other exchange account is untouched.
    assert.equal(openBalance(f.cadToUsd, f.cad, f.ledger.transactions), 50000n);
    assert.equal(openBalance(f.cadToUsd, f.usd, f.ledger.transactions), -37500n);
    assert.equal(openBalance(f.usdToOranges, f.cad, f.ledger.transactions), 0n);

    // No gain/loss yet — the value is suspended in the forward exchange.
    assert.equal(f.capitalGains.getRootRawBalance(f.cad, f.ledger.transactions), 0n);

    // Asset balances reflect the partial conversion.
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 500);
    assert.equal(f.cash.getBalance(f.usd, f.ledger.transactions), 375);
});

test("a closed loop recaptures every edge, recognizes the gain, and leaves no stale positions", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.inventory, f.oranges, 1500, f.usdToOranges);

    // Phase 3 closes the CAD→USD→Oranges→CAD loop for 600 CAD (a 100 CAD gain). The exchange
    // account is required but carries zero balance since no forward leg opens.
    const closing = commitSwap(f, f.inventory, f.oranges, 1500, f.cash, f.cad, 600, f.orangesToCad);

    assert.ok(f.ledger.verify().ok, "ledger must verify after loop closure");

    // Both exchanges are fully settled — every open position nets to zero.
    for (const position of [f.cad, f.usd, f.oranges]) {
        assert.equal(openBalance(f.cadToUsd, position, f.ledger.transactions), 0n, `cadToUsd open ${position.name}`);
        assert.equal(openBalance(f.usdToOranges, position, f.ledger.transactions), 0n, `usdToOranges open ${position.name}`);
    }

    // 100 CAD gain recognized (equity, negative root balance).
    assert.equal(f.capitalGains.getRootRawBalance(f.cad, f.ledger.transactions), -10000n);

    // Cash: 500 CAD left over from phase 1 + 600 CAD proceeds = 1100 CAD; oranges fully sold.
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 1100);
    assert.equal(f.inventory.getBalance(f.oranges, f.ledger.transactions), 0);

    // Pure loop closure: no forward exchange.
    assert.equal(closing.resolution.exchange, null);
});

test("the recovered-loop residual carries proportional origin basis", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.inventory, f.oranges, 1500, f.usdToOranges);
    const closing = commitSwap(f, f.inventory, f.oranges, 1500, f.cash, f.cad, 600, f.orangesToCad);

    assert.equal(closing.resolution.residuals.length, 1);
    const residual = closing.resolution.residuals[0]!;
    // The 100 CAD gain traces back through Oranges→USD→CAD to the original CAD opening balance.
    assert.equal(residual.originBasis.get(f.cad), 10000n);
});

test("a partial exchange resolves only its portion; the rest is an independent transaction", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    // Exchange 400 of the 1000 CAD into 300 USD via the resolution layer (separate transactions).
    const exchangedInputs = f.cash.generateInputs(f.cad, 400, f.ledger.transactions);
    const res = new ExchangeResolution(exchangedInputs, f.usd, 300, f.engine, f.ledger.transactions,
                                       { gain: f.capitalGains, loss: f.capitalLosses }, f.cadToUsd);

    f.ledger.newTransaction(exchangedInputs, res.getFromOutputs());
    for (const hop of res.getIntermediateTransactions()) f.ledger.newTransaction(hop.inputs, hop.outputs);
    f.ledger.newTransaction(
        res.getToInputs(),
        [...f.cash.generateOutputs(f.usd, 300, f.ledger.transactions), ...res.getToOutputs()],
    );

    // The forward exchange links ONLY the exchanged 400 CAD ↔ 300 USD.
    assert.notEqual(res.exchange, null);
    assert.equal(res.exchange!.from.quantity, 40000n);
    assert.equal(res.exchange!.to.quantity, 30000n);

    // Withdraw the remaining 100 CAD as a fully independent transaction (its own input→output flow).
    f.ledger.newTransaction(
        f.cash.generateInputs(f.cad, 100, f.ledger.transactions),
        f.drawings.generateOutputs(f.cad, 100, f.ledger.transactions),
    );

    assert.ok(f.ledger.verify().ok, "ledger must verify after a partial exchange + independent withdrawal");

    // 1000 CAD = 400 exchanged + 100 withdrawn + 500 remaining; 300 USD received.
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 500);
    assert.equal(f.cash.getBalance(f.usd, f.ledger.transactions), 300);
    assert.equal(f.drawings.getBalance(f.cad, f.ledger.transactions), 100);

    // The exchanged USD's basis traces purely to the CAD origin — the withdrawal did not bleed in.
    const usdUtxo = f.cash.getEngine(f.usd).utxos.find(u => u.calculateAvailable(f.ledger.transactions) > 0n)!;
    const leaves = collectOriginLeaves(f.engine.compute([new UTXOConsumption(usdUtxo.quantity, usdUtxo)]));
    assert.deepEqual([...leaves.keys()], [f.cad]);
    assert.equal(leaves.get(f.cad), 40000n);
});
