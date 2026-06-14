# Exchanges

## What an Exchange Is

An `Exchange` links two single-position transactions at a **locked conversion rate**. Once created, the rate is immutable.

```ts
// Exchange(from, to) where each side is { quantity: bigint, position: Position }
const ex = new Exchange(
    { quantity: 50000n, position: cad },  // from: 500.00 CAD
    { quantity: 37500n, position: usd }   // to:   375.00 USD
);

ex.from  // ExchangedUTXO: the "given-away" lot; goes in the CAD transaction's outputs
ex.to    // ExchangedUTXI: the "received" lot;   goes in the USD transaction's inputs
```

The locked rate is always `from.quantity / to.quantity` — the ratio at the time of the exchange.

---

## Transaction Pair Pattern

Because every transaction is single-position, an exchange always spans exactly two transactions:

```ts
// CAD transaction: source account gives away 500 CAD
ledger.newTransaction(
    cadAccount.generateInputs(cad, 500, ledger.transactions),
    [ex.from]   // ExchangedUTXO output
);

// USD transaction: destination account receives 375 USD
ledger.newTransaction(
    [ex.to],    // ExchangedUTXI input
    usdAccount.generateOutputs(usd, 375, ledger.transactions)
);
```

In practice, `ExchangeResolution` and `swap()` construct these transaction pairs automatically — you rarely build them by hand.

---

## Recapture

When value later moves back toward the origin position (or out of the system entirely), the exchange can be **recaptured** at its original locked rate:

```ts
const recapture = ex.recapture(toSideQuantity, transactions);
// recapture.settlement  UTXIConsumption — settles part of ex.to;   goes in outputs
// recapture.reclaim     UTXOConsumption — reclaims part of ex.from; goes in inputs
```

Recapture is the mechanism through which:
- Deferred cost basis becomes realized
- Gain/loss can be measured against the locked rate
- Multi-hop chains are unwound in dependency order

---

## Residuals

When a recaptured exchange shows a difference between the locked rate value and the actual proceeds, that difference is recognized as a **residual** lot:

| Type | Meaning | Placed in |
|---|---|---|
| `ResidualUTXI` | A **gain** — proceeds exceeded locked cost basis | Receiving transaction inputs |
| `ResidualUTXO` | A **loss** — proceeds fell short of locked cost basis | Receiving transaction outputs |

Both types carry an **`originBasis`**: a `Map<Position, bigint>` recording the deep-origin composition of the value they represent. This allows the cost basis engine to trace lineage through residual lots into subsequent exchanges.

Residuals are registered directly in a `ResidualAccount` (an equity account), where they accumulate as the recognized gain/loss balance.

---

## Three Layers: Primitives, Resolution, Swap

The exchange system is deliberately split into three layers, from lowest to highest. Use the highest one that fits; drop down when you need more control.

| Layer | What it is | Where | Owns transactions? |
|---|---|---|---|
| **Exchange primitives** | `Exchange`, `ExchangedUTXO/UTXI`, `ResidualUTXO/UTXI`, `Exchange.recapture` — the kernel-level locked-rate links and their consumption. | `ledger-kernel/transactions/cross-position.ts` | No — they are lines you place into transactions. |
| **Exchange resolution** | `ExchangeResolution` (built on `computeRecaptureResolution` / `unwind`). Given **only the exchanged portion** of consumed value plus the proceeds, it computes every line — recaptures, the forward exchange, gain/loss residuals, residual-node settlements — and hands them back as arrays. | `equity-policy/exchange/resolution.ts` | No — **you** assemble the transactions. |
| **`swap()`** | The convenience helper for the clean, full-quantity case. The caller draws `fromInputs` and stages `toOutputs`; `swap` resolves the exchange and builds the downstream transactions, returning `{ fromOutputs, to, intermediates }`. Commit them in order: consuming → hops → receiving. | `equity-policy/exchange/swap.ts` | No — builds `to` and hop transactions but does not commit them; the caller commits all three. |

`swap()` is the right tool when the entire source draw is exchanged into the entire proceeds and nothing else shares those transactions. The moment that stops being true — a partial exchange, or an event that also has a fee/deposit/withdrawal — reach for `ExchangeResolution` directly and assemble the transactions yourself.

---

## Partial and Mixed Exchanges

`ExchangeResolution` resolves **the exchanged portion only**. Two guarantees follow by construction:

- Its from-side outputs sum to exactly `sum(exchangedInputs)`, and its to-side inputs balance exactly against `actualProceeds`. Every exchange/recapture/residual line links **only** the exchanged value.
- Everything else in the event is yours to build. Non-exchanged value simply lives in other transactions.

```ts
// Exchange 400 of a 500 CAD position into USD; withdraw the other 100 CAD as cash.
const exchanged = cash.generateInputs(cad, 400, ledger.transactions);
const res = new ExchangeResolution(exchanged, usd, 300, engine, ledger.transactions,
                                   capitalGains, cadToUsdPositions);

// Consuming (exchange) transaction — exchange lines only:
ledger.newTransaction(exchanged, res.getFromOutputs());
res.getIntermediateTransactions().forEach(h => ledger.newTransaction(h.inputs, h.outputs));
// Receiving (exchange) transaction:
ledger.newTransaction(res.getToInputs(),
    [...cash.generateOutputs(usd, 300, ledger.transactions), ...res.getToOutputs()]);

// The withdrawal is an INDEPENDENT transaction, not extra lines on the one above:
ledger.newTransaction(cash.generateInputs(cad, 100, ledger.transactions),
                      drawer.generateOutputs(cad, 100, ledger.transactions));
```

### Why the withdrawal is its own transaction

The `BookValueEngine` attributes each input's basis across **all** of a transaction's outputs proportionally — it treats every transaction's outputs as a *uniform blend* of its inputs. That is exact for a pure exchange (all outputs derive uniformly from all inputs) and for proceeds that blend recovered basis with a gain. But if you drop an *independent* sub-flow — a fee or withdrawal with its own input→output correspondence — into the same single-position transaction, its lineage bleeds into the exchanged value and corrupts basis tracing.

So the rule is: **lines may share a transaction only when they form a single uniform blend. Independent effects go in separate transactions.** The kernel will not stop you (it only checks single-position + balance), so this is a discipline the equity-policy layer keeps — see [Invariants](../architecture/invariants.md).

---

## Open vs Settled

An exchange position is **open** as long as one or both sides have remaining unconsumed availability.

An exchange is **fully settled** when both `ex.from` and `ex.to` have zero remaining availability — both sides have been consumed exactly. A fully settled exchange contributes nothing to `ExchangePositionsAccount`.

The `ExchangePositionsAccount` computed equity account scans every `ExchangedUTXO` and `ExchangedUTXI` across all transactions and derives its balance from remaining availability. This ensures `ledger.verify()` can pass even with open exchange positions — the open portions cancel with matching entries on the asset side.

---

## The High-Level API

For the clean, full-quantity case you don't construct exchanges directly — `swap()` handles the full cycle (for partial or mixed events, drop down to `ExchangeResolution` as shown above):

```ts
const fromInputs = cadAccount.generateInputs(cad, 500, ledger.transactions);
const toOutputs = usdAccount.generateOutputs(usd, 375, ledger.transactions);

const result = swap({
    fromInputs, toOutputs, engine,
    transactions: ledger.transactions,
    residualAccount: capitalGains,       // where to recognize gains/losses
    exchangeAccount: cadToUsdPositions   // required; carries zero when no forward leg opens
});

// Commit in dependency order: consuming → intermediate hops → receiving
ledger.newTransaction(fromInputs, result.fromOutputs);
ledger.addTransaction(...result.intermediates, result.to);
```

`swap()` internally calls `ExchangeResolution`, which:
1. Traces the provenance of the consumed value via `BookValueEngine`
2. Identifies which prior exchanges loop back to `usd` and recaptures them
3. Opens a forward exchange for any portion without prior loop lineage (scoped to the required `exchangeAccount`)
4. Recognizes any gain/loss as a residual — gains go to the gain account, losses to the loss account (see `ResidualTarget` in [Account System](../architecture/accounts.md))
5. Returns the resolved lines; `swap()` builds the `to` and hop `Transaction` objects and returns `{ resolution, fromOutputs, to, intermediates }` for the caller to commit

**`residualAccount`** accepts either a single `ResidualAccount` (gains and losses share it) or `{ gain: ResidualAccount, loss: ResidualAccount }` to route them to separate accounts.

**`exchangeAccount`** scopes the forward exchange to a specific `ExchangePositionsAccount`'s open-position view. It is **always required** — supply one even when the exchange fully closes a loop and no forward leg opens (the account will simply carry a zero balance). This keeps the type consistent and avoids any risk of silently minting an untagged, unscoped open position.

See [Unwind Algorithm](../architecture/unwind.md) for the recapture logic, and [Four-Phase Example](../guides/example.md) for a full walkthrough.

---

## Related Documents

- [Transaction Primitives](transactions.md) — UTXO/UTXI, the conservation model
- [Cost Basis Engine](../architecture/cost-basis.md) — How lineage is traced through exchange boundaries
- [Unwind Algorithm](../architecture/unwind.md) — How loop-mode vs full-mode recapture works
