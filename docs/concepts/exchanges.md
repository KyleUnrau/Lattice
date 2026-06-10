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
// recapture.from  UTXIConsumption — settles part of ex.to;   goes in outputs
// recapture.to    UTXOConsumption — reclaims part of ex.from; goes in inputs
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

## Open vs Settled

An exchange position is **open** as long as one or both sides have remaining unconsumed availability.

An exchange is **fully settled** when both `ex.from` and `ex.to` have zero remaining availability — both sides have been consumed exactly. A fully settled exchange contributes nothing to `ExchangePositionsAccount`.

The `ExchangePositionsAccount` computed equity account scans every `ExchangedUTXO` and `ExchangedUTXI` across all transactions and derives its balance from remaining availability. This ensures `ledger.verify()` can pass even with open exchange positions — the open portions cancel with matching entries on the asset side.

---

## The High-Level API

In normal usage, you don't construct exchanges directly. The `swap()` function handles the full cycle:

```ts
swap({
    source: cadAccount, from: cad, quantity: 500,
    destination: usdAccount, to: usd, proceeds: 375,
    engine, ledger, residualAccount: capitalGains
});
```

`swap()` internally calls `ExchangeResolution`, which:
1. Traces the provenance of the consumed value via `BookValueEngine`
2. Identifies which prior exchanges loop back to `usd` and recaptures them
3. Opens a forward exchange for any portion without prior loop lineage
4. Recognizes any gain/loss as a residual in `capitalGains`
5. Commits all transactions (consuming, intermediate hops, receiving) to the ledger

See [Unwind Algorithm](../architecture/unwind.md) for the recapture logic, and [Four-Phase Example](../guides/example.md) for a full walkthrough.

---

## Related Documents

- [Transaction Primitives](transactions.md) — UTXO/UTXI, the conservation model
- [Cost Basis Engine](../architecture/cost-basis.md) — How lineage is traced through exchange boundaries
- [Unwind Algorithm](../architecture/unwind.md) — How loop-mode vs full-mode recapture works
