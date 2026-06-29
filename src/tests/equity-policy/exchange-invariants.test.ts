import { test } from "node:test";
import assert from "node:assert/strict";

import { UTXOConsumption } from "../../ledger-kernel/transactions/inputs.js";
import { UTXO } from "../../ledger-kernel/transactions/outputs.js";
import { ResidualUTXI } from "../../ledger-kernel/transactions/special-edges/residual.js";
import { assertPositionUnifiromity, type Position } from "../../ledger-kernel/positions.js";
import { collectOriginLeaves } from "../../equity-policy/book-value/lineage.js";
import { TerminalResolution } from "../../equity-policy/terminal.js";
import { commitSwap, makeFixture, openInto, type Fixture } from "../utils/ledger-fixture.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The origin-position composition of a lot's available value (where its basis ultimately came from). */
function originOf(f: Fixture, lot: UTXO): Map<Position, bigint> {
    const available = lot.calculateAvailable(f.ledger.transactions);
    return collectOriginLeaves(f.engine.compute([new UTXOConsumption(available, lot)]));
}

/** All UTXO lots an account currently holds in a position (committed or not), in creation order. */
function lotsOf(_f: Fixture, account: { getLotStore(p: Position): { utxos: UTXO[] } }, position: Position): UTXO[] {
    return account.getLotStore(position).utxos;
}

/** The open-position balance an exchange account reports for a position. */
function open(f: Fixture, account: { getSignedBalanceScaled(p: Position, t: any): bigint }, position: Position): bigint {
    return account.getSignedBalanceScaled(position, f.ledger.transactions);
}

// ---------------------------------------------------------------------------
// 1. Forward exchanges create provenance only for the exchanged portion.
// ---------------------------------------------------------------------------

test("INV1: a forward exchange attributes basis only to the exchanged portion, never to leftovers or later lots", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000); // lot O: 1000 CAD of origin equity

    // Exchange 400 of the 1000 CAD into 300 USD (a pure forward — CAD is origin, nothing loops).
    commitSwap(f, f.cash, f.cad, 400, f.cash, f.usd, 300, f.cadToUsd);

    // Later, an entirely independent equity injection of fresh CAD (lot F). It must stay isolated.
    openInto(f, f.cash, f.cad, 500);

    assert.ok(f.ledger.verify().ok);

    // The USD lot's basis traces to EXACTLY the 400 CAD that was exchanged — not 700, not 900.
    const usdLot = lotsOf(f, f.cash, f.usd).find(u => u.calculateAvailable(f.ledger.transactions) > 0n)!;
    const usdOrigin = originOf(f, usdLot);
    assert.deepEqual([...usdOrigin.keys()], [f.cad], "USD basis is purely CAD-origin");
    assert.equal(usdOrigin.get(f.cad), 40000n, "USD basis = exactly the 400 CAD exchanged");

    // The two CAD lots remain independent origin equity: the 600 CAD leftover of lot O and the 500
    // CAD of lot F each trace to plain CAD, with no USD lineage smeared back in.
    const cadLots = lotsOf(f, f.cash, f.cad).filter(u => u.calculateAvailable(f.ledger.transactions) > 0n);
    const cadAvail = cadLots.map(u => u.calculateAvailable(f.ledger.transactions)).sort();
    assert.deepEqual(cadAvail, [50000n, 60000n], "leftover 600 CAD + fresh 500 CAD remain as distinct lots");
    for (const lot of cadLots) assert.deepEqual([...originOf(f, lot).keys()], [f.cad], "CAD lots stay pure CAD origin");

    // Cash holds 600 CAD leftover + 500 CAD fresh + 300 USD; nothing realized yet.
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 1100);
    assert.equal(f.cash.getBalance(f.usd, f.ledger.transactions), 300);
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n);
});

// ---------------------------------------------------------------------------
// 2. Multi-hop recapture works recursively (and is structurally inspectable).
// ---------------------------------------------------------------------------

test("INV2: closing a CAD→USD→Oranges→CAD loop recaptures both prior edges and leaves no stale positions", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);       // edge 1: CAD→USD
    commitSwap(f, f.cash, f.usd, 375, f.inventory, f.oranges, 1500, f.usdToOranges); // edge 2: USD→Oranges
    const closing = commitSwap(f, f.inventory, f.oranges, 1500, f.cash, f.cad, 600, f.orangesToCad); // close → CAD

    assert.ok(f.ledger.verify().ok);

    // STRUCTURE: both prior edges are recaptured (one recapture per distinct exchange).
    assert.equal(closing.resolution.recaptures.length, 2, "both CAD→USD and USD→Oranges recaptured");

    // The recaptures reclaim the from-sides (CAD, USD) and settle the to-sides (USD, Oranges).
    const reclaimed = closing.resolution.recaptures.map(r => r.reclaim.source.position).sort((a, b) => a.name.localeCompare(b.name));
    const settled = closing.resolution.recaptures.map(r => r.settlement.source.position).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(reclaimed, [f.cad, f.usd], "recaptures reclaim CAD and USD from-sides");
    assert.deepEqual(settled, [f.oranges, f.usd], "recaptures settle Oranges and USD to-sides");

    // STRUCTURE: exactly one intermediate hop — the USD position threaded between Oranges and CAD.
    assert.equal(closing.intermediates.length, 1, "one hop transaction for the USD intermediate");
    assert.equal(closing.intermediates[0]!.position, f.usd, "the hop nets out the USD position");

    // Pure loop closure: no forward exchange opens.
    assert.equal(closing.resolution.exchange, null);

    // No stale open balances on any intermediate exchange account, in any position.
    for (const position of [f.cad, f.usd, f.oranges]) {
        assert.equal(open(f, f.cadToUsd, position), 0n, `cadToUsd open ${position.name}`);
        assert.equal(open(f, f.usdToOranges, position), 0n, `usdToOranges open ${position.name}`);
        assert.equal(open(f, f.orangesToCad, position), 0n, `orangesToCad open ${position.name}`);
    }

    // 100 CAD gain recognized (proceeds 600 vs 500 basis).
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -10000n);
});

// ---------------------------------------------------------------------------
// 3. Residual gains inherit basis from the recaptured path proportionally.
// ---------------------------------------------------------------------------

test("INV3: a recovered-loop residual gain inherits proportional BTC origin basis, not origin CAD", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad); // 0.01 BTC → 1000 CAD (CAD now BTC-derived)
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);     // 500 CAD → 375 USD

    // Close CAD→USD→CAD: 500 CAD basis returns as 550 CAD ⇒ 50 CAD gain.
    const closing = commitSwap(f, f.cash, f.usd, 375, f.cash, f.cad, 550, f.usdToCad);

    assert.ok(f.ledger.verify().ok);

    // Only the inner CAD→USD edge is recaptured; the outer BTC→CAD edge stays open (deeper provenance).
    assert.equal(closing.resolution.recaptures.length, 1, "only CAD→USD recaptured, not BTC→CAD");

    // KEY INVARIANT: the 50 CAD gain is not basis-free / origin-CAD — it carries the proportional BTC
    // basis of the recaptured path. 50/500 of the loop principal's 0.005 BTC basis = 0.0005 BTC.
    assert.equal(closing.resolution.createdResiduals.length, 1);
    const residual = closing.resolution.createdResiduals[0]!;
    assert.ok(residual instanceof ResidualUTXI, "a gain is recognized as a ResidualUTXI");
    assert.equal(residual.quantity, 5000n, "50 CAD gain");
    assert.equal(residual.originBasis.get(f.btc), 50000n, "gain inherits 0.0005 BTC origin basis");
    assert.equal(residual.originBasis.has(f.cad), false, "gain is NOT attributed to origin CAD");

    // 50 CAD gain recognized in equity; inner loop settled; outer BTC leg remains open (unrealized).
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n);
    assert.equal(open(f, f.cadToUsd, f.cad), 0n);
    assert.equal(open(f, f.cadToUsd, f.usd), 0n);
    assert.equal(open(f, f.usdToCad, f.cad), 0n);
    assert.equal(open(f, f.btcToCad, f.btc), 1000000n, "BTC→CAD still open: 0.01 BTC suspended");
});

// ---------------------------------------------------------------------------
// 4. Residual losses are symmetrical (and preserve origin attribution).
// ---------------------------------------------------------------------------

test("INV4: a recovered-loop loss is terminal — unrecovered basis is settled at its BTC origin, not held as a movable destination lot", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad);
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);

    // Close CAD→USD→CAD: 500 CAD basis returns as only 450 CAD ⇒ 50 CAD loss = 0.0005 BTC of basis.
    const closing = commitSwap(f, f.cash, f.usd, 375, f.cash, f.cad, 450, f.usdToCad);

    assert.ok(f.ledger.verify().ok);

    // A loss is NOT a movable residual gain. No gain residual is created; the loss is terminal.
    assert.equal(closing.resolution.createdResiduals.length, 0, "no gain residual on a losing loop");
    assert.notEqual(closing.resolution.terminalLoss, null, "the loss is settled terminally (an expense to origin)");

    // KEY INVARIANT: the loss lands at its cost-basis ORIGIN (BTC), through the terminal loss
    // account — NOT as a destination-CAD lot. 50 CAD lost = 0.0005 BTC of unrecovered basis.
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.btc, f.ledger.transactions), 50000n, "0.0005 BTC loss recognized at the BTC origin");
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "nothing held in destination CAD");

    // The inner loop is settled; the BTC→CAD leg is partially unsuspended for exactly the lost slice.
    assert.equal(open(f, f.cadToUsd, f.cad), 0n);
    assert.equal(open(f, f.cadToUsd, f.usd), 0n);
    assert.equal(open(f, f.usdToCad, f.cad), 0n);
    assert.equal(open(f, f.btcToCad, f.btc), 950000n, "0.01 BTC less the 0.0005 BTC reclaimed for the loss");
});

// ---------------------------------------------------------------------------
// 4b. A loop loss whose recovered basis spans multiple origins must prorate the
//     terminal loss across those origins, never front-load it onto the first reclaim.
// ---------------------------------------------------------------------------

test("INV4b: a loop loss with recovered basis from two distinct origins prorates the terminal loss across both, not onto whichever reclaim is first", () => {
    const f = makeFixture();

    // Two equal CAD lots from two distinct origins:
    //   • 500 CAD derived from 500 USD (origin USD, rate 1:1)
    //   • 500 CAD derived from 0.01 BTC (origin BTC)
    openInto(f, f.cash, f.usd, 500);
    commitSwap(f, f.cash, f.usd, 500, f.cash, f.cad, 500, f.usdToCad);     // 500 CAD, origin USD
    openInto(f, f.wallet, f.btc, 0.01);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 500, f.btcToCad);  // 500 CAD, origin BTC

    // Forward each CAD lot into Oranges as a SEPARATE edge, so the loop has two distinct ancestor
    // reclaims (one per origin). FIFO consumes the USD-derived lot first, so the USD reclaim is first.
    commitSwap(f, f.cash, f.cad, 500, f.inventory, f.oranges, 500, f.cadToOranges); // edge1: CAD(USD)→Oranges
    commitSwap(f, f.cash, f.cad, 500, f.inventory, f.oranges, 500, f.cadToOranges); // edge2: CAD(BTC)→Oranges

    // Close the loop back to CAD at a LOSS: 1000 CAD of recovered basis returns as only 800 CAD ⇒
    // 200 CAD loss. Recovered basis is 50% USD-origin + 50% BTC-origin, so the loss must split 50/50.
    const closing = commitSwap(f, f.inventory, f.oranges, 1000, f.cash, f.cad, 800, f.orangesToCad);

    assert.ok(f.ledger.verify().ok, "ledger verifies after a multi-origin loop loss");

    // No movable residual loss is created; the loss is terminal.
    assert.equal(closing.resolution.createdResiduals.length, 0, "no gain residual on a losing loop");
    assert.notEqual(closing.resolution.terminalLoss, null, "the loss is terminal");

    // KEY INVARIANT: the 200 CAD loss is PRORATED across the two origin reclaims (100 CAD each),
    // not front-loaded onto whichever reclaim appears first. 100 CAD of USD-basis = 100 USD;
    // 100 CAD of BTC-basis = 0.002 BTC. Neither origin absorbs the whole loss.
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.usd, f.ledger.transactions), 10000n, "100 USD of the loss lands at the USD origin");
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.btc, f.ledger.transactions), 200000n, "0.002 BTC of the loss lands at the BTC origin");
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "nothing terminalized in the CAD loop position");
});

// ---------------------------------------------------------------------------
// 5. Residual-derived value settles when it later closes back to its origin asset.
// ---------------------------------------------------------------------------

test("INV5: residual-derived CAD settles back against its inherited BTC basis instead of opening a fresh CAD→BTC exchange", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad);
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.cash, f.cad, 550, f.usdToCad); // 50 CAD residual gain, 0.0005 BTC basis

    // Cash now holds 1050 CAD = 500 leftover (BTC-derived forward) + 550 loop proceeds
    // (500 recovered BTC-derived + 50 residual-derived). Convert it ALL back to BTC at the
    // unchanged rate (1050 CAD = 0.0105 BTC) so the residual-derived portion is included deterministically.
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 1050);
    const back = commitSwap(f, f.cash, f.cad, 1050, f.wallet, f.btc, 0.0105, f.cadToBtc);

    assert.ok(f.ledger.verify().ok);

    // KEY INVARIANT: the residual-derived CAD does NOT behave like fresh/origin CAD. There is no
    // unrelated market-rate CAD→BTC forward exchange — the value settles back along its provenance.
    assert.equal(back.resolution.exchange, null, "no fresh CAD→BTC forward exchange opens");
    assert.equal(open(f, f.cadToBtc, f.cad), 0n, "the CAD→BTC scratch account carries nothing");
    assert.equal(open(f, f.cadToBtc, f.btc), 0n);

    // The BTC→CAD path is recaptured (the inherited basis is reclaimed), and the residual leg is closed.
    assert.equal(back.resolution.recaptures.length, 1, "BTC→CAD recaptured");
    assert.equal(back.resolution.residualCloseOutputs.length, 1, "the residual leg is settled/closed");
    assert.equal(open(f, f.btcToCad, f.btc), 0n, "BTC→CAD fully settled");
    assert.equal(open(f, f.btcToCad, f.cad), 0n);

    // The deferred 50 CAD gain is re-recognized in the origin asset: the CAD gain leg is reversed
    // (back to 0) and the gain surfaces as 0.0005 BTC — matching the inherited basis at the unchanged
    // rate, so the round trip nets out economically.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "provisional CAD gain reversed");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.btc, f.ledger.transactions), -50000n, "gain realized as 0.0005 BTC");

    // Economic truth: 0.01 BTC round-tripped to 0.0105 BTC; wallet = 0.01 untouched + 0.0105 = 0.0205.
    assert.equal(f.wallet.getBalance(f.btc, f.ledger.transactions), 0.0205);
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 0);

    // TODO(residual-settlement): the swap path settles the residual by closing the deferred CAD leg
    // and minting a NEW gain of the full BTC proceeds attributable to it (originBasis = those proceeds),
    // rather than explicitly netting proceeds against the inherited `node.originBasis` (0.0005 BTC) and
    // recognizing only the difference. At the unchanged rate above the totals are economically correct,
    // but the per-transaction gain/loss split at NON-unit rates is not yet asserted here because the
    // settlement does not expose an inherited-basis-vs-proceeds breakdown. Expose that breakdown (e.g.
    // a settlement record carrying {inheritedBasis, proceeds, recognizedGain}) to allow a precise
    // varying-rate assertion.
});

// ---------------------------------------------------------------------------
// 5b. Residual-derived value moved toward an UNRELATED target must not leak upward.
// ---------------------------------------------------------------------------

test("INV5b: residual-derived value exchanged into a non-origin target flows forward — the deferred gain stays at its origin, never re-anchored to the destination", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad); // CAD now BTC-derived
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.cash, f.cad, 550, f.usdToCad); // 50 CAD residual gain, origin BTC

    // The deferred gain sits in CAD, inheriting BTC origin basis.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n, "50 CAD gain deferred");

    // Now move the residual-derived CAD into USD — an UNRELATED target (origin is BTC, not USD).
    // Cash holds 1050 CAD (BTC-derived + residual-derived); convert it all to USD.
    const moved = commitSwap(f, f.cash, f.cad, 1050, f.cash, f.usd, 800, f.cadToUsd);

    assert.ok(f.ledger.verify().ok, "ledger verifies after moving residual-derived value to a non-origin target");

    // KEY INVARIANT (the event3 bug): the residual is NOT carried back / re-anchored. No leg is
    // closed, and a plain forward exchange opens for the whole draw — the residual edge stays open.
    assert.equal(moved.resolution.residualCloseOutputs.length, 0, "no residual leg closed — this is not a carry-back");
    assert.notEqual(moved.resolution.exchange, null, "a forward exchange opens for the residual-derived value");

    // The deferred gain must NOT leak upward into USD; it remains exactly where it was, in CAD,
    // until value actually returns toward its true (BTC) origin.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n, "no gain leaks into the USD destination");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n, "the deferred CAD gain is untouched");

    // The USD proceeds' basis traces back through the forward exchange to the true origin (BTC),
    // never re-anchored to CAD or USD by a spurious re-mint.
    const usdLot = lotsOf(f, f.cash, f.usd).find(u => u.calculateAvailable(f.ledger.transactions) > 0n)!;
    assert.deepEqual([...originOf(f, usdLot).keys()], [f.btc], "USD basis still traces to the BTC origin");
});

// ---------------------------------------------------------------------------
// 5c. Carry-back at a non-unit rate splits the residual realization (no double-count).
// ---------------------------------------------------------------------------

test("INV5c: carrying a gain residual back at a NON-unit rate re-recognizes it at origin and recognizes only the incremental as extra gain — total realized = actual proceeds", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad);  // 0.01 BTC → 1000 CAD
    commitSwap(f, f.cash, f.cad, 1000, f.cash, f.usd, 750, f.cadToUsd);     // 1000 CAD → 750 USD
    commitSwap(f, f.cash, f.usd, 750, f.cash, f.cad, 1100, f.usdToCad);     // loop: 100 CAD gain, 0.001 BTC residual-basis

    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -10000n, "100 CAD gain deferred in CAD");

    // Carry all 1100 CAD back into BTC, but at an APPRECIATED rate: 1100 CAD = 0.0121 BTC.
    // The recovered 1000 CAD (BTC-derived) gains 0.001 BTC; the 100 CAD residual's proceeds
    // (0.0011 BTC) exceed its 0.001 BTC residual-basis, so the carry-back splits into a 0.001 BTC
    // re-recognition + a 0.0001 BTC incremental gain.
    commitSwap(f, f.cash, f.cad, 1100, f.wallet, f.btc, 0.0121, f.cadToBtc);

    assert.ok(f.ledger.verify().ok, "ledger verifies after a non-unit carry-back");

    // The deferred CAD gain is reversed and realized in BTC; nothing double-counts.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "deferred CAD gain reversed");
    // Total BTC gain = loop 0.001 + re-recognition 0.001 + incremental 0.0001 = 0.0021 BTC.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.btc, f.ledger.transactions), -210000n, "0.0021 BTC total gain realized at origin");
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.btc, f.ledger.transactions), 0n, "no loss — every leg appreciated");

    // Economic truth: 0.01 BTC round-tripped to 0.0121 BTC; wallet = 0.01 untouched + 0.0121.
    assert.equal(f.wallet.getBalance(f.btc, f.ledger.transactions), 0.0221);
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 0);
});

// ---------------------------------------------------------------------------
// 5d. Coupled: a single exchange that BOTH carries a residual back AND closes an
//     ordinary loop at a loss. The terminal-loss decomposition must not carve into
//     (or distort) the carry-back surface — the two slices settle independently.
// ---------------------------------------------------------------------------

test("INV5d: carry-back + loop-loss in ONE exchange settle independently — the loss does not cannibalize the carry-back surface", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad);  // 1000 CAD, basis 0.01 BTC
    commitSwap(f, f.cash, f.cad, 1000, f.cash, f.usd, 750, f.cadToUsd);     // 1000 CAD → 750 USD
    commitSwap(f, f.cash, f.usd, 750, f.cash, f.cad, 1100, f.usdToCad);     // loop: 100 CAD gain, 0.001 BTC residual-basis

    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -10000n, "100 CAD gain deferred in CAD");

    // Cash holds a single 1100 CAD lot whose lineage is BOTH the recovered 1000 CAD of BTC-derived
    // capital (basis 0.01 BTC) AND the 100 CAD residual (basis 0.001 BTC). Carry it ALL back into BTC
    // at a DEPRECIATED rate (1100 CAD → 0.0099 BTC), so:
    //   • the ordinary loop (1000 CAD ↔ 0.01 BTC basis) returns only 0.009 BTC ⇒ 0.001 BTC loss, and
    //   • the carry-back (100 CAD residual, 0.001 BTC basis) returns 0.0009 BTC ⇒ 0.0001 BTC incremental loss.
    const closing = commitSwap(f, f.cash, f.cad, 1100, f.wallet, f.btc, 0.0099, f.cadToBtc);

    assert.ok(f.ledger.verify().ok, "ledger verifies for a coupled carry-back + loop-loss exchange");

    // The loop lost, so there is NO loop gain residual; the carry-back leg is still closed exactly once.
    assert.equal(closing.resolution.createdResiduals.length, 0, "the losing loop creates no gain residual");
    assert.equal(closing.resolution.residualCloseOutputs.length, 1, "the carry-back residual leg is closed");
    assert.notEqual(closing.resolution.terminalLoss, null, "the ordinary loop loss is terminal");

    // CARRY-BACK closes correctly: the deferred CAD gain is fully reversed (the WHOLE 100 CAD residual
    // carried back — the loss decomposition did not eat any of it).
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "deferred CAD gain fully reversed");

    // The residual-basis is re-recognized at origin in FULL: 0.001 BTC gain (not a shrunken slice).
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.btc, f.ledger.transactions), -100000n, "full 0.001 BTC residual-basis re-recognized at BTC origin");

    // Terminal losses at origin = ordinary loop loss (0.001 BTC) + carry-back incremental (0.0001 BTC).
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.btc, f.ledger.transactions), 110000n, "0.0011 BTC total terminal loss at BTC origin");
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "nothing terminalized in destination CAD");

    // Economic truth: 0.01 BTC invested, 0.0099 BTC returned; wallet = 0.01 untouched + 0.0099.
    assert.equal(f.wallet.getBalance(f.btc, f.ledger.transactions), 0.0199);
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 0);
});

// ---------------------------------------------------------------------------
// 5e. Nested carry-back: a residual created at surface B (origin A) whose value
//     moved forward B→C must still carry back when C later returns to origin A.
// ---------------------------------------------------------------------------

test("INV5e: a residual that moved forward (CAD→USD) still carries back to its BTC origin when USD later returns to BTC", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad);  // CAD now BTC-derived
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.cash, f.cad, 550, f.usdToCad);      // 50 CAD residual gain, origin BTC

    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n, "50 CAD gain deferred at surface B (CAD)");

    // Move the residual-derived CAD FORWARD into USD (non-matching target — the residual stays
    // anchored to BTC behind a forward CAD→USD edge; the deferred gain does not leak into USD).
    commitSwap(f, f.cash, f.cad, 1050, f.cash, f.usd, 840, f.cadToUsd);
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n, "deferred gain untouched after the forward move");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n, "no gain leaked into USD");

    // Now USD returns to BTC (C→A): the nested residual behind the CAD→USD edge must be discovered
    // and carried back to its BTC origin, closing its leg through the CAD hop.
    const back = commitSwap(f, f.cash, f.usd, 840, f.wallet, f.btc, 0.0105, f.usdToBtc);

    assert.ok(f.ledger.verify().ok, "ledger verifies after a nested carry-back");

    // The residual is resolved at its true origin: the deferred CAD gain reverses to 0 and surfaces
    // as 0.0005 BTC, re-anchored to BTC and not to the intermediate USD/CAD positions.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), 0n, "deferred CAD gain reversed by the nested carry-back");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n, "no residual re-anchored to the intermediate USD position");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.btc, f.ledger.transactions), -50000n, "gain realized as 0.0005 BTC at the BTC origin");

    // Economic truth: 0.01 BTC round-tripped to 0.0105 BTC; wallet = 0.01 untouched + 0.0105.
    assert.equal(f.wallet.getBalance(f.btc, f.ledger.transactions), 0.0205);
    assert.equal(f.cash.getBalance(f.usd, f.ledger.transactions), 0);
    assert.equal(f.cash.getBalance(f.cad, f.ledger.transactions), 0);
});

// ---------------------------------------------------------------------------
// 5f. An already-at-origin residual gain (surface == origin) that later flows FORWARD
//     behind a non-matching exchange must NOT be settled when the forward output is
//     terminalized. The recognized gain is closed equity, not a suspended edge: expensing
//     the downstream value unwinds the forward edge's basis only, never the residual.
//     (The event0→event4 scenario: 1000 A; 500 A→250 B; 250 B→550 A (50 A gain at A);
//      expense 50 A then 1000 A→500 B; expense 200 B.)
// ---------------------------------------------------------------------------

test("INV5f: expensing forward-exchanged value terminalizes only the forward edge's basis — an already-at-origin residual nested behind that edge is left untouched (no double-count, no mixed-position transaction)", () => {
    const f = makeFixture(); // A = cad, B = usd

    // event0 / event1: open 1000 A, then forward 500 A → 250 B.
    openInto(f, f.cash, f.cad, 1000);
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 250, f.cadToUsd);

    // event2: 250 B → 550 A closes the A→B→A loop and recognizes a 50 A gain AT A (surface == origin).
    commitSwap(f, f.cash, f.usd, 250, f.cash, f.cad, 550, f.usdToCad);
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n, "50 A gain recognized at its own origin A");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n, "no gain at B");

    // event3a: expense 50 A (drawn from the origin-A leftover, no residual lineage).
    {
        const inputs = f.cash.generateInputs(f.cad, 50, f.ledger.transactions);
        const res = new TerminalResolution(inputs, f.ledger.transactions, f.engine, f.exchangeExpense);
        const ev = f.ledger.beginEvent();
        ev.record(res.constructTransactions().toGroup());
        ev.register();
    }

    // event3b: exchange 1000 A → 500 B. This is an ORDINARY forward — the at-origin residual is part
    // of the consumed 1000 A and flows forward behind the new edge; it is NOT carried back or closed.
    const fwd = commitSwap(f, f.cash, f.cad, 1000, f.cash, f.usd, 500, f.cadToUsd);
    assert.notEqual(fwd.resolution.exchange, null, "event3 opens a plain 1000 A → 500 B forward exchange");
    assert.equal(fwd.resolution.residualCloseOutputs.length, 0, "the at-origin residual is not carried back by the forward exchange");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n, "the 50 A gain is untouched by event3");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n, "no gain re-anchored to B by event3");

    // event4: expense 200 B. Its basis traces to 400 A through the event3 forward edge (1000 A ↔ 500 B).
    const inputs = f.cash.generateInputs(f.usd, 200, f.ledger.transactions);
    const res = new TerminalResolution(inputs, f.ledger.transactions, f.engine, f.rentExpense);

    // (Q11/symptom) No residual leg is closed and nothing is re-recognized just because B is expensed.
    assert.equal(res.residualCloseOutputs.length, 0, "no residual leg closed by expensing B");
    assert.equal(res.residualRecognitions.length, 0, "no residual re-recognized by expensing B");
    // The terminal effect is the forward edge's basis ONLY: exactly 400 A, never 400 + 20.
    assert.equal(res.recaptureGroups.length, 1, "one terminal-origin reclaim");
    assert.equal(res.recaptureGroups[0]!.position, f.cad, "reclaimed at the A origin");
    assert.equal(res.recaptureGroups[0]!.totalQuantity, 40000n, "exactly 400 A of basis, not 420 A");

    // (Q9) constructTransactions() must not throw, and every constructed transaction is single-position.
    let built: ReturnType<typeof res.constructTransactions> | undefined;
    assert.doesNotThrow(() => { built = res.constructTransactions(); }, "constructTransactions() must not throw a mixed-position error");
    for (const tx of built!.flatten())
        assert.doesNotThrow(
            () => assertPositionUnifiromity({ inputs: tx.inputs, outputs: tx.outputs }),
            "every constructed terminal transaction must be single-position",
        );

    const ev = f.ledger.beginEvent();
    ev.record(built!.toGroup());
    ev.register();

    assert.ok(f.ledger.verify().ok, "ledger verifies after event4");

    // The event4 terminal expense is exactly 400 A and nothing in B (no double-count, no B leakage).
    assert.equal(f.rentExpense.getSignedBalanceScaled(f.cad, f.ledger.transactions), 40000n, "exactly 400 A terminalized at the A origin");
    assert.equal(f.rentExpense.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n, "nothing terminalized in B");

    // The event2 A residual/gain is NOT decreased by event4, and nothing is re-anchored into B.
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.cad, f.ledger.transactions), -5000n, "the 50 A gain at A is unchanged by event4");
    assert.equal(f.capitalGains.getSignedBalanceScaled(f.usd, f.ledger.transactions), 0n, "no residual re-anchored into B");
});

// ---------------------------------------------------------------------------
// 6. Mixed-origin balances remain distinguishable (deterministic FIFO selection).
// ---------------------------------------------------------------------------

test("INV6: origin USD and CAD-derived USD stay distinct lots; FIFO consumes the oldest deterministically", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.usd, 1000);  // lot A: 1000 USD of origin equity (oldest)
    openInto(f, f.cash, f.cad, 1000);
    commitSwap(f, f.cash, f.cad, 1000, f.cash, f.usd, 1000, f.cadToUsd); // lot B: 1000 USD derived from CAD

    assert.ok(f.ledger.verify().ok);

    const [lotA, lotB] = lotsOf(f, f.cash, f.usd);
    assert.equal(lotA!.calculateAvailable(f.ledger.transactions), 100000n);
    assert.equal(lotB!.calculateAvailable(f.ledger.transactions), 100000n);

    // The two lots are NOT collapsed into "clean USD": each traces to its own distinct origin.
    assert.deepEqual([...originOf(f, lotA!).keys()], [f.usd], "lot A is origin USD");
    assert.equal(originOf(f, lotA!).get(f.usd), 100000n);
    assert.deepEqual([...originOf(f, lotB!).keys()], [f.cad], "lot B is CAD-derived USD");
    assert.equal(originOf(f, lotB!).get(f.cad), 100000n);

    // The configured disposal method is FIFO: consuming 1000 USD draws the OLDEST lot (lot A) in full,
    // deterministically, leaving the CAD-derived lot B untouched.
    const inputs = f.cash.generateInputs(f.usd, 1000, f.ledger.transactions);
    assert.equal(inputs.length, 1);
    assert.equal((inputs[0] as UTXOConsumption).source, lotA, "FIFO consumes the oldest (origin USD) lot first");
});

// ---------------------------------------------------------------------------
// 7. Intermediate hop transactions stay exactly balanced under rounding.
//    An edge whose from-side only PARTIALLY loops back is recaptured at a rounded
//    to-side; the reclaimed from-side must be the exact looped quantity the unwind
//    tracked, not a re-derivation from that rounded to-side, or the intermediate hop
//    is left short by the rounding remainder. (The event11 failure.)
// ---------------------------------------------------------------------------

/** Asserts every hop transaction nets to zero (inputs sum === outputs sum) in its single position. */
function assertHopsBalance(hops: { inputs: { quantity: bigint }[]; outputs: { quantity: bigint }[] }[]): void {
    for (const hop of hops) {
        const inSum = hop.inputs.reduce((s, i) => s + i.quantity, 0n);
        const outSum = hop.outputs.reduce((s, o) => s + o.quantity, 0n);
        assert.equal(inSum, outSum, "an intermediate hop transaction must net to zero");
    }
}

test("INV7: a partially-looped intermediate edge threads its EXACT looped from-side, so the hop stays balanced despite rounding", () => {
    const f = makeFixture(); // A = cad, B = usd, C = oranges

    // Build a MIXED-origin USD position: 100 USD derived from 30 CAD (loops back to CAD) plus
    // 200 USD of plain origin (does not loop). FIFO keeps them ordered cad-derived → origin.
    openInto(f, f.cash, f.cad, 1000);
    commitSwap(f, f.cash, f.cad, 30, f.cash, f.usd, 100, f.cadToUsd);  // A→B: 30 CAD → 100 USD (cad-derived)
    openInto(f, f.cash, f.usd, 200);                                   // 200 USD of origin equity

    // Forward all 300 USD into Oranges as ONE edge, so the Oranges lot is 1/3 cad-derived. The
    // CAD→USD→Oranges→CAD loop only recovers that 1/3, so the USD→Oranges edge is PARTIALLY looped:
    // its recapture to-side rounds (1000 × 100/300), and re-deriving the from-side from it would
    // drift away from the exact 100 USD that actually loops.
    commitSwap(f, f.cash, f.usd, 300, f.inventory, f.oranges, 1000, f.usdToOranges); // B→C, mixed
    const closing = commitSwap(f, f.inventory, f.oranges, 1000, f.cash, f.cad, 400, f.orangesToCad); // close → CAD

    assert.ok(f.ledger.verify().ok, "ledger verifies after closing a partially-looped multi-hop loop");

    // KEY INVARIANT: the USD intermediate hop nets to zero — the value arriving from the CAD→USD
    // settlement is reclaimed away exactly by the USD→Oranges from-side, with no stranded remainder.
    assert.equal(closing.intermediates.length, 1, "one USD intermediate hop");
    assert.equal(closing.intermediates[0]!.position, f.usd, "the hop nets out the USD position");
    assertHopsBalance(closing.resolution.getRecaptureHops());
});

test("INV7b: a nested carry-back threads its EXACT enclosing-edge from-side, so the residual's surface hop stays balanced at a non-dividing rate", () => {
    const f = makeFixture(); // origin BTC, surface CAD, intermediate USD

    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad); // CAD now BTC-derived
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);
    commitSwap(f, f.cash, f.usd, 375, f.cash, f.cad, 550, f.usdToCad);     // 50 CAD residual gain, origin BTC

    // Move the residual-derived CAD FORWARD into USD at a NON-dividing rate, so when the residual
    // later carries back, rewinding its surface share through this enclosing CAD→USD edge rounds the
    // to-side — and re-deriving the from-side from it would short the residual's surface (CAD) hop.
    commitSwap(f, f.cash, f.cad, 1050, f.cash, f.usd, 833, f.cadToUsd);    // forward at an odd rate (nested)

    // USD returns to BTC: the nested residual carries back through the CAD→USD edge, closing its leg
    // at the CAD hop.
    const back = commitSwap(f, f.cash, f.usd, 833, f.wallet, f.btc, 0.0105, f.usdToBtc);

    assert.ok(f.ledger.verify().ok, "ledger verifies after a non-dividing nested carry-back");

    // KEY INVARIANT: every hop threading the carry-back nets to zero — the enclosing edge reclaims
    // exactly the residual's surface share, so the residual-leg close at the CAD hop is fully backed.
    const hops = back.resolution.getRecaptureHops();
    assert.ok(hops.some(h => h.position === f.cad), "the nested residual closes at the CAD surface hop");
    assertHopsBalance(hops);
});

// ---------------------------------------------------------------------------
// 8. A forward exchange minted in the same (loop-closing) transaction as a recapture
//    settlement must trace to its TRUE funder, not the edge being closed.
// ---------------------------------------------------------------------------

test("INV8: a forward from-side minted alongside a recapture settlement traces to its own origin, so a later loop loss unwinds it without re-recapturing the already-settled edge", () => {
    const f = makeFixture();

    // EX0: CAD→USD. The 250 USD it mints is CAD-derived.
    openInto(f, f.cash, f.cad, 500);
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 250, f.cadToUsd);

    // A SECOND, independent USD origin sits alongside the CAD-derived USD.
    openInto(f, f.cash, f.usd, 250);

    // Send all 500 USD back to CAD. This single consuming transaction has the loop-close shape:
    //   IN[250 USD (CAD-derived, closes EX0), 250 USD (origin)]  OUT[settle(EX0.to), EX2.from]
    // The 250 USD origin funds the forward EX2 (USD→CAD); the CAD-derived 250 USD settles EX0.
    const mint = commitSwap(f, f.cash, f.usd, 500, f.cash, f.cad, 900, f.usdToCad);
    const forward = mint.resolution.exchange;
    assert.notEqual(forward, null, "a forward USD→CAD edge is opened for the origin-USD portion");

    // ROOT-CAUSE INVARIANT: the forward from-side's basis is PURE origin USD — the value that
    // actually funded it — not a phantom blend through the EX0 edge that the same transaction closed.
    // (Before the settlement-aware attribution fix this read 125 USD via EX0 + 125 USD origin, because
    // the recapture-settlement output diluted the forward output's proportional share.)
    const forwardOrigin = collectOriginLeaves(f.engine.traceLot(forward!.from));
    assert.deepEqual([...forwardOrigin.keys()], [f.usd], "forward from-side is purely USD-origin");
    assert.equal(forwardOrigin.get(f.usd), 25000n, "all 250 USD of it");
    assert.equal(forwardOrigin.has(f.cad), false, "no phantom CAD lineage through the closed EX0 edge");

    // Now close the EX2-derived CAD back to USD at a LOSS. The lost slice of the recovered basis is the
    // forward from-side (EX2.from); unwinding it must reach origin USD directly. With the phantom CAD
    // lineage it instead tried to re-recapture EX0 — whose USD to-side was already fully settled — and
    // threw "Attempted to consume … from a UTXI that only has 0 remaining."
    const closing = commitSwap(f, f.cash, f.cad, 900, f.cash, f.usd, 400, f.cadToUsd);

    assert.ok(f.ledger.verify().ok, "ledger verifies after the loop loss unwinds the forward from-side");
    assert.notEqual(closing.resolution.terminalLoss, null, "the loop closes at a loss");

    // KEY INVARIANT: the loop loss lands at the forward from-side's true USD origin — 50 USD of
    // unrecovered basis (250 USD recovered, only 200 USD of proceeds back it) — never in CAD.
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.usd, f.ledger.transactions), 5000n, "50 USD loss recognized at the USD origin");
});
