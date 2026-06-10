# Cost Basis Engine

The `BookValueEngine` answers: *"Where did this value come from?"* for any `UTXO` and quantity. It performs backward traversal through the UTXI/UTXO consumption graph, crossing exchange boundaries, to produce a structured `BasisPath[]` tree.

```ts
const engine = new BookValueEngine(ledger.transactions);
const paths  = engine.compute(someUTXO, quantity);
```

---

## BasisPath Types

```ts
type BasisPath = OriginPath | ExchangePath | ResidualPath
```

| Type | Meaning | Terminal? |
|---|---|---|
| `OriginPath` | Reached a plain `UTXI` — an opening balance, equity injection, or inflow with no prior exchange lineage | Yes |
| `ExchangePath` | Crossed an `ExchangedUTXI` — value came through an exchange; carries `basis` (recursive, from-side) | No |
| `ResidualPath` | Crossed a `ResidualUTXI` — a prior recognized gain carrying `originBasis` | Yes |

An `ExchangePath` carries:
- `quantity` — the to-side amount at this node
- `fromQuantity` — the equivalent from-side amount at the locked rate
- `exchange` — the `Exchange` object, allowing recapture
- `basis: BasisPath[]` — the recursive from-side lineage

A `ResidualPath` carries:
- `quantity` — the residual amount
- `originBasis: Map<Position, bigint>` — the deep-origin composition recorded when the residual was created

---

## Traversal Algorithm

For a given `(utxo, quantity)`:

1. Find the transaction that produced `utxo` by scanning `tx.outputs`.
2. Compute `inputFraction = quantity / totalOutputQuantity` (all outputs — including `UTXIConsumption`s — participate in the denominator, ensuring the fraction is correct even when both UTXO surplus and UTXI settlement appear in the same transaction).
3. For each input, multiply its quantity by `inputFraction` and dispatch on type:
   - `UTXOConsumption` → recurse into the source `UTXO` (transparent pass-through)
   - `ExchangedUTXI` → emit `ExchangePath`; recurse into `exchange.from` for the basis
   - `ResidualUTXI` → emit `ResidualPath` (terminal; carries `originBasis`)
   - plain `UTXI` → emit `OriginPath` (terminal)
4. Aggregate across all inputs, returning the full `BasisPath[]` for this level.

**Cycle detection** uses a per-branch visited set (copied on branch, not shared across siblings) to allow diamond-shaped DAGs without false positives.

---

## Invariants

- `quantity > 0` and `quantity ≤ utxo.quantity`
- Every `UTXO` has exactly one producing transaction
- No ancestor cycles in the consumption graph

---

## What the Engine Is Used For

The engine is called by the equity-policy layer, not directly in most user code:

- `ExchangeResolution` calls it via `computeRecaptureResolution` to decide which prior exchanges to recapture when a swap closes a loop
- `expense()` calls it to trace the full lineage of consumed value, recapturing every edge
- The REPL exposes `engine.compute(utxo, quantity)` directly for inspection

---

## Related Documents

- [Exchanges](../concepts/exchanges.md) — Exchange, ExchangedUTXI, ResidualUTXI
- [Unwind Algorithm](unwind.md) — What happens with the `BasisPath` tree once computed
- [Two-Layer Design](layers.md) — Why the engine lives in equity-policy, not the kernel
