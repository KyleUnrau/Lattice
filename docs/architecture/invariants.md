# Architectural Invariants

These are the hard constraints enforced by the kernel. They hold unconditionally, regardless of which equity-policy functions were used to construct the transactions.

| Invariant | Where Enforced |
|---|---|
| Single position per transaction | `Transaction` constructor throws on position mismatch |
| `sum(inputs) === sum(outputs)` | `Transaction` constructor throws on imbalance |
| UTXO availability never over-consumed | Three layers: `UTXO.consume()` during generation; the **aggregate per-source** check in the `Transaction` constructor (sums all consumptions of one lot, so two draws of the same lot can't each pass individually yet over-consume together); and the lot-availability backstop in `Ledger.verify()` |
| UTXI availability never over-consumed | Same three layers via `UTXI.consume()`, the `Transaction` constructor, and `Ledger.verify()` |
| No lot has negative availability | `Ledger.verify()` walks every `Account` lot store and rejects the ledger if any `UTXO`/`UTXI` has `calculateAvailable() < 0` — catches over-consumption smeared across separately-constructed transactions in one batch, which the per-transaction check cannot see |
| Ledger nets to zero per position | `Ledger.verify()` including `ExchangePositionsAccount` and `ResidualAccount` in equity |
| Book value traversal is acyclic | Per-branch visited set in `BookValueEngine` |
| `ExchangePositionsAccount` is read-only | Extends `ComputedAccount` — no `generateInputs()`/`generateOutputs()` |
| `ResidualAccount` is write-once per lot | Lots registered via `addResidualInput/Output`; the equity-policy layer is the only caller |
| Exchange positions settle only via recapture | `ExchangedUTXO`/`ExchangedUTXI` can only be consumed through `Exchange.recapture()` |
| Transaction groups are a non-authoritative overlay | `TransactionGroup` holds references (by identity) to transactions already in `Ledger.transactions`; it never affects availability, lineage, or `verify()`. The flat history stays the single source of truth — see [Transaction Groups](../concepts/transaction-groups.md) |

---

## Equity-Policy Invariants

These are upheld by the equity-policy layer (`ExchangeResolution`, `swap`, `expense`). The kernel does not enforce them — it only checks single-position and balance — so the policy layer must not violate them, and callers building transactions by hand must respect them too.

| Invariant | Why / Where |
|---|---|
| **Exchange edges link only the exchanged portion** | An exchange/recapture/residual line never spans more value than was actually exchanged. `ExchangeResolution`'s from-side outputs sum to exactly `sum(exchangedInputs)`; its to-side inputs balance exactly against `actualProceeds`. Pass only the exchanged portion as `exchangedInputs`. |
| **A transaction's outputs are a uniform blend of its inputs** | The `BookValueEngine` attributes each input's basis across *all* outputs proportionally. Lines may share a transaction only when they form one uniform blend; an independent sub-flow (a fee/withdrawal with its own input→output correspondence) must be a **separate transaction**, or its lineage bleeds into the others. See [Exchanges → Partial and Mixed Exchanges](../concepts/exchanges.md). |
| **A forward exchange is always scoped to a real `ExchangeAccount`** | `exchangeAccount` is a required `ExchangeTarget` (`ExchangeAccount \| { from, to }`) on `ExchangeResolution` and `SwapRequest`. Supply one for every exchange — even a pure loop closure that opens no forward leg (the account carries a zero balance). The type system enforces a concrete `ExchangeAccount` per side, so no untagged or mistyped open position can be created. |

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

`ledger.verify()` returns `{ ok: true }` or `{ ok: false, error: string }`. It performs two checks:

1. **Zero-sum** — the sum of all root balances across both root account folders equals zero for every position.
2. **Lot availability** — no `UTXO` or `UTXI` in any `Account` lot store has been over-consumed (`calculateAvailable() ≥ 0`). This backstops over-consumption that is spread across separately-constructed transactions in a single batch (e.g. a multi-transaction exchange resolution), which the per-transaction aggregate check in the `Transaction` constructor cannot detect on its own.

Open exchange positions are handled structurally — `ExchangePositionsAccount` and `ResidualAccount` are part of the equity tree and contribute their derived balances to the sum. No special adjustment is needed inside `verify()`.

---

## Related Documents

- [Two-Layer Design](layers.md) — Why the kernel enforces structure and equity-policy enforces meaning
- [Account System](accounts.md) — How orientation affects balance signs in `verify()`
- [Disposal Methods](../reference/disposal-methods.md) — The policy-level lot selection interface
