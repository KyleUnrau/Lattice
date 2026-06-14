import { test } from "node:test";
import assert from "node:assert/strict";

import { UTXOConsumption } from "../../ledger-kernel/transactions/inputs.js";
import { UTXO } from "../../ledger-kernel/transactions/outputs.js";
import { ResidualUTXI, ResidualUTXO } from "../../ledger-kernel/transactions/cross-position.js";
import type { Position } from "../../ledger-kernel/positions.js";
import { collectOriginLeaves } from "../../equity-policy/book-value/lineage.js";
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
    assert.equal(closing.resolution.residuals.length, 1);
    const residual = closing.resolution.residuals[0]!;
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

test("INV4: a recovered-loop residual loss is symmetrical and preserves BTC origin attribution", () => {
    const f = makeFixture();
    openInto(f, f.wallet, f.btc, 0.02);
    commitSwap(f, f.wallet, f.btc, 0.01, f.cash, f.cad, 1000, f.btcToCad);
    commitSwap(f, f.cash, f.cad, 500, f.cash, f.usd, 375, f.cadToUsd);

    // Close CAD→USD→CAD: 500 CAD basis returns as only 450 CAD ⇒ 50 CAD loss.
    const closing = commitSwap(f, f.cash, f.usd, 375, f.cash, f.cad, 450, f.usdToCad);

    assert.ok(f.ledger.verify().ok);

    // The loss is the mirror of the gain: a ResidualUTXO carrying the same proportional BTC basis.
    assert.equal(closing.resolution.residuals.length, 1);
    const residual = closing.resolution.residuals[0]!;
    assert.ok(residual instanceof ResidualUTXO, "a loss is recognized as a ResidualUTXO");
    assert.equal(residual.quantity, 5000n, "50 CAD loss");
    assert.equal(residual.originBasis.get(f.btc), 50000n, "loss inherits 0.0005 BTC origin basis");

    // 50 CAD loss recognized (capital-loss account carries the residual lot); loop accounts settled.
    assert.equal(f.capitalLosses.getSignedBalanceScaled(f.cad, f.ledger.transactions), 5000n);
    assert.equal(open(f, f.cadToUsd, f.cad), 0n);
    assert.equal(open(f, f.cadToUsd, f.usd), 0n);
    assert.equal(open(f, f.usdToCad, f.cad), 0n);
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
