import { test } from "node:test";
import assert from "node:assert/strict";

import { ScenarioLedger } from "../../scenarios.js";
import { ExchangedUTXO, ExchangedUTXI } from "../../ledger-kernel/transactions/cross-position.js";

// ---------------------------------------------------------------------------
// Full-scenario unwind: events 0–12 drive every code path (forward exchanges,
// multi-hop loops, directly-held + nested carry-backs, terminal expenses, and
// inventory profit) and then event12 wraps the last of Position B back into A.
//
// Because EVERY position was ultimately funded from A, once B and C are fully
// unwound there must be no suspended exchange value left anywhere: Net Transfers
// is exactly zero in A, B and C, and the residual economic difference is fully
// classified into gain / profit — never stranded behind an un-closeable forward
// edge. This guards the event11 rounding bug, where a 1-unit-C truncation
// remainder opened a spurious forward C→A edge (1 C → 0.16 A), parking 0.16 A in
// Net Transfers and under-recognizing inventory profit by the same 0.16.
// ---------------------------------------------------------------------------

test("scenario unwind: after the whole book unwinds back to A, Net Transfers is zero everywhere and the rounding remainder lands in inventory profit (not stranded behind a forward edge)", () => {
    const { ledger, accounts, positions } = ScenarioLedger;
    const view = ScenarioLedger.buildSampleLedger();
    const txns = ledger.transactions;
    const { a, b, c } = positions;

    // The ledger as a whole is balanced (every position's root balance nets to zero).
    assert.ok(ledger.verify().ok, "ledger verifies after event12");

    // INVARIANT: Net Transfers is exactly zero in A, B and C — no suspended exchange
    // value remains once everything has returned to its A funding origin.
    assert.equal(accounts.netTransfers.getSignedBalanceScaled(a, txns), 0n, "A Net Transfers is zero");
    assert.equal(accounts.netTransfers.getSignedBalanceScaled(b, txns), 0n, "B Net Transfers is zero");
    assert.equal(accounts.netTransfers.getSignedBalanceScaled(c, txns), 0n, "C Net Transfers is zero");
    // …and no position anywhere carries an open transfer balance.
    assert.equal(accounts.netTransfers.getSignedBalancesScaled(txns).size, 0, "no position has an open Net Transfers balance");

    // No stale exchange edge remains open: every exchanged from-side and to-side is
    // fully consumed (both legs settled), so nothing is left dangling in equity.
    for (const tx of txns) {
        for (const output of tx.outputs)
            if (output instanceof ExchangedUTXO)
                assert.equal(output.calculateAvailable(txns), 0n, "every exchange from-side is fully recaptured");
        for (const input of tx.inputs)
            if (input instanceof ExchangedUTXI)
                assert.equal(input.calculateAvailable(txns), 0n, "every exchange to-side is fully settled");
    }

    // Positions B and C summarize to zero — no assets and no equity attributable to them.
    for (const position of [b, c]) {
        const summary = ledger.summarize(position);
        assert.equal(summary.netAssets.balance, 0, `${position.name} holds no net assets`);
        assert.equal(summary.equity.balance, 0, `${position.name} carries no equity`);
        assert.equal(accounts.cash.getSignedBalanceScaled(position, txns), 0n, `${position.name} cash is zero`);
        assert.equal(accounts.inventory.getSignedBalanceScaled(position, txns), 0n, `${position.name} inventory is zero`);
    }

    // Inventory profit is recognized in FULL at the A origin: 307.50, not 307.34. The extra
    // 0.16 is precisely the event11 truncation remainder, now classified as profit instead of
    // being stranded in Net Transfers.
    assert.equal(accounts.inventoryProfit.getBalanceScaled(a, txns), 30750n, "inventory profit is exactly 307.50 at A");
    assert.equal(accounts.inventoryProfit.getSignedBalancesScaled(txns).size, 1, "inventory profit lives only in A");

    // Capital gains are recognized at A and nowhere else; no losses anywhere (every leg of this
    // book appreciated or broke even), so nothing is double-counted into the terminal sinks.
    assert.equal(accounts.capitalGains.getBalanceScaled(a, txns), 7250n, "capital gains are 72.50 at A");
    assert.equal(accounts.capitalLosses.getSignedBalancesScaled(txns).size, 0, "no capital losses recognized");
    assert.equal(accounts.inventoryLoss.getSignedBalancesScaled(txns).size, 0, "no inventory losses recognized");

    // Terminal expenses are unchanged by the fix and not double-counted — each is exactly its
    // single recognized total, all at the A origin.
    assert.equal(accounts.salesTax.getSignedBalanceScaled(a, txns), 13000n, "sales tax total at A");
    assert.equal(accounts.exchangeExpense.getSignedBalanceScaled(a, txns), 5000n, "exchange expense total at A");
    assert.equal(accounts.rentExpense.getSignedBalanceScaled(a, txns), 40000n, "rent expense total at A");
    assert.equal(accounts.spoilageExpense.getSignedBalanceScaled(a, txns), 5000n, "spoilage expense total at A");

    // Sanity: the scenario ran all thirteen events.
    assert.equal(view.events.length, 13, "events 0 through 12 all committed");
});
