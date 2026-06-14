# Architectural Invariants

These are the hard constraints enforced by the kernel. They hold unconditionally, regardless of which equity-policy functions were used to construct the transactions.

| Invariant | Where Enforced |
|---|---|
| Single position per transaction | `Transaction` constructor throws on position mismatch |
| `sum(inputs) === sum(outputs)` | `Transaction` constructor throws on imbalance |
| UTXO availability never over-consumed | `UTXO.consume()` checks against `calculateAvailable()` |
| UTXI availability never over-consumed | `UTXI.consume()` checks against `calculateAvailable()` |
| Ledger nets to zero per position | `Ledger.verify()` including `ExchangePositionsAccount` and `ResidualAccount` in equity |
| Book value traversal is acyclic | Per-branch visited set in `BookValueEngine` |
| `ExchangePositionsAccount` is read-only | Extends `ComputedAccount` — no `generateInputs()`/`generateOutputs()` |
| `ResidualAccount` is write-once per lot | Lots registered via `addResidualInput/Output`; the equity-policy layer is the only caller |
| Exchange positions settle only via recapture | `ExchangedUTXO`/`ExchangedUTXI` can only be consumed through `Exchange.recapture()` |

---

## Equity-Policy Invariants

These are upheld by the equity-policy layer (`ExchangeResolution`, `swap`, `expense`). The kernel does not enforce them — it only checks single-position and balance — so the policy layer must not violate them, and callers building transactions by hand must respect them too.

| Invariant | Why / Where |
|---|---|
| **Exchange edges link only the exchanged portion** | An exchange/recapture/residual line never spans more value than was actually exchanged. `ExchangeResolution`'s from-side outputs sum to exactly `sum(exchangedInputs)`; its to-side inputs balance exactly against `actualProceeds`. Pass only the exchanged portion as `exchangedInputs`. |
| **A transaction's outputs are a uniform blend of its inputs** | The `BookValueEngine` attributes each input's basis across *all* outputs proportionally. Lines may share a transaction only when they form one uniform blend; an independent sub-flow (a fee/withdrawal with its own input→output correspondence) must be a **separate transaction**, or its lineage bleeds into the others. See [Exchanges → Partial and Mixed Exchanges](../concepts/exchanges.md). |
| **A forward exchange is always scoped to an `ExchangePositionsAccount`** | `exchangeAccount` is a required parameter on `ExchangeResolution` and `SwapRequest`. Supply one for every exchange — even a pure loop closure that opens no forward leg (the account carries a zero balance). This prevents any untagged open position from being created. |

---

## Policy Decisions (Not Invariants)

The following are decided by the equity-policy layer and can vary without violating any structural rule:

- Which existing lots to consume when spending from an account (disposal method: FIFO, LIFO, specific identification, etc.)
- Which exchange edges to recapture on a given transaction (loop mode vs full mode, depth of recursion)
- Whether to open a forward exchange for the non-looping portion
- Which `ResidualAccount` a gain/loss routes to — including routing gains and losses to separate accounts via `ResidualTarget: { gain, loss }`
- Whether a `ResidualAccount` uses a `negativeLabel` to switch its display name based on balance sign
- Which `ExchangePositionsAccount` a forward exchange is scoped to (required in the type — see the equity-policy invariants above)
- When to call `expense()` vs `swap()` (full unwind vs loop unwind)

---

## Verification

`ledger.verify()` returns `{ ok: true }` or `{ ok: false, error: string }`. It checks the sum of all root balances across both root account folders equals zero for every position.

Open exchange positions are handled structurally — `ExchangePositionsAccount` and `ResidualAccount` are part of the equity tree and contribute their derived balances to the sum. No special adjustment is needed inside `verify()`.

---

## Related Documents

- [Two-Layer Design](layers.md) — Why the kernel enforces structure and equity-policy enforces meaning
- [Account System](accounts.md) — How orientation affects balance signs in `verify()`
- [Disposal Methods](../reference/disposal-methods.md) — The policy-level lot selection interface
