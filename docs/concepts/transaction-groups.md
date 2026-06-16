# Transaction Groups

A single economic action rarely lands as a single `Transaction`. An exchange produces a consuming
transaction, a receiving transaction, and (for multi-hop unwinds) intermediate hop transactions; an
expense fans out into the consuming transaction plus per-origin recognitions. A composite event —
"split this draw into an expense and an exchange" — can be several atomic transactions. The kernel's
flat history records each one correctly but erases the link between them, so visualization and
exploration lose the shape of what actually happened.

A **`TransactionGroup`** restores that link.

---

## What it is

A recursive, read-only tree that annotates which committed transactions form one business event:

```ts
class TransactionGroup {
  members: (Transaction | TransactionGroup)[];
  flatten(): Transaction[];               // in-order leaves — exactly the committed sequence
}
```

Each member points either at a leaf `Transaction` or at a nested subgroup. Nesting is what lets a
composite event hold an expense sub-flow and an exchange sub-flow as distinct children.

---

## It is not authoritative

This is the load-bearing rule. The flat `Ledger.transactions` array remains the **single source of
truth** for lot availability, cost-basis lineage, and `Ledger.verify()`. A group holds only
references — by identity — to transactions already in that array. It cannot change a balance, a
lineage trace, or commit order. Deleting every group would leave the ledger's mechanics untouched.

Grouping therefore never conflicts with the [invariants](../architecture/invariants.md): it adds
nothing the kernel must enforce.

---

## Committing groups

One entry point on `Ledger`: **`beginEvent()` → `EventBuilder`**.

`EventBuilder` accumulates one or more sub-flows, then registers them all as a single top-level
event:

- **`record(transactionOrGroup)`** — nests an already-built `Transaction` or `TransactionGroup` under
  the event being built. Its leaves are immediately visible (via `view()`) to anything built afterward.
- **`newTransaction(transactionLike)`** — builds and records a `Transaction` from raw inputs/outputs.
- **`newGroup(...transactionLikes)`** — builds and records several transactions (or existing
  groups/transactions) as one nested subgroup.
- **`view()`** — the committed history plus everything recorded on this event so far, for constructing
  the next sub-flow's inputs/outputs against.
- **`register()`** — wraps everything recorded so far into one `TransactionGroup` and appends it to the
  ledger as a single top-level event.

A single resolution:

```ts
const event = ledger.beginEvent();
event.record(resolution.constructTransactions().toGroup());
event.register();
```

A composite of several sub-flows that must be committed in sequence, because each later sub-flow is
constructed against the *committed* history of the earlier ones (e.g. an expense, then an exchange
drawing on the remaining lots — see the [uniform-blend rule](../architecture/invariants.md)):

```ts
const event = ledger.beginEvent();
event.record(expense.constructTransactions().toGroup());
// the exchange below is built against event.view(), which already includes the expense above
event.record(exchange.constructTransactions().toGroup());
event.register();
```

The resulting flat history and commit order are byte-for-byte what committing the sub-flows separately
would produce.

---

## Where members come from

The equity-policy resolution wrappers already hold their transactions in commit order, so
`toGroup()` is pure annotation — no new logic:

| Wrapper | Members (in commit order) |
|---|---|
| `ExchangeTransactions` | `from`, `to`, `intermediates` |
| `ExpenseTransactions` | `from`, `intermediates`, `externalExpenses` |

Each wrapper's `flatten()` delegates to `toGroup().flatten()`, so member order and commit order can
never drift apart.

---

## In the explorer

`serialize.ts` serializes `ledger.groups` into a tree of leaf transaction indices and nested member
groups. The timeline renders collapsible **event** blocks instead of an undifferentiated row of
chips, with nested composites indented. Any ungrouped transaction still renders flat. The
per-transaction, lot, and exchange views are unchanged.

---

## Related Documents

- [Transaction Primitives](transactions.md) — The atomic `Transaction` and how the flat history works
- [Architectural Invariants](../architecture/invariants.md) — Why groups never affect verification
- [Two-Layer Design](../architecture/layers.md) — Kernel structure vs. equity-policy meaning
