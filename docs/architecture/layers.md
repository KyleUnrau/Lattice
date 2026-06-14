# Two-Layer Design

The codebase is divided into two distinct layers with a clear boundary between them.

---

## Ledger Kernel (`src/ledger-kernel/`)

The kernel owns **structural invariants** — rules that are always true regardless of business context:

- Every transaction must balance: `sum(inputs) === sum(outputs)`
- Every transaction is single-position
- A lot cannot be consumed beyond its available quantity
- Balances are always re-derived from the transaction graph; no mutable state

The kernel provides the building blocks: `Position`, `Transaction`, `UTXO`, `UTXI`, `Exchange`, `Account`, `AccountFolder`, `Ledger`. It does not know or care about gain/loss recognition, cost basis, tax treatment, or disposal ordering beyond what the account's configured disposal method specifies.

---

## Equity Policy (`src/equity-policy/`)

The equity-policy layer owns **business logic** — decisions about *how* to record events that could legitimately be recorded different ways:

- Which prior exchanges to recapture (the unwind algorithm)
- How to recognize gain/loss when an exchange loop closes
- How to handle value that derives from a prior residual lot
- How to expense value that fully leaves the system

The equity-policy layer calls down into the kernel to create transactions, but the kernel never calls up into equity-policy. The kernel does not know that `ExchangeResolution` or `swap()` exist.

---

## The Boundary

The boundary is enforced by dependency direction: `equity-policy/` imports from `ledger-kernel/`, never the reverse.

Concretely:

- **Kernel**: `positions.ts`, `transactions.ts`, `ledger.ts`, `accounts/`, `transactions/`, `disposal-methods/`
- **Equity-policy**: `book-value/` (engine, lineage, types), `exchange/` (resolution, recapture, swap, types, index), `recaptures.ts`, `expense.ts`

---

## Why the Separation Matters

The kernel can be tested and reasoned about in isolation. A transaction that balances is valid regardless of how or why it was constructed. This makes it possible to:

1. Trust the kernel's structural guarantees unconditionally
2. Change equity-policy decisions (e.g., switch from FIFO to tax-optimized disposal) without touching the kernel
3. Add new equity-policy functions (a new realization strategy, a different gain-recognition rule) without any kernel changes
4. Verify the full ledger with `ledger.verify()` regardless of which policy functions constructed the transactions

---

## Call Chain for a Typical Swap

```
swap()                          ← equity-policy entry point
  └─ ExchangeResolution         ← equity-policy: full resolution
       ├─ computeRecaptureResolution()  ← equity-policy: recapture math
       │    ├─ BookValueEngine.compute()  ← equity-policy: basis tracing
       │    └─ unwind()          ← equity-policy: loop selection
       └─ ledger.newTransaction() ← kernel: commit each transaction
```

The kernel's `newTransaction` is called at the bottom of the chain, after all policy decisions are made.

---

## Related Documents

- [Architectural Invariants](invariants.md) — The full list of kernel-enforced constraints
- [Cost Basis Engine](cost-basis.md) — `BookValueEngine`, the equity-policy's basis tracer
- [Unwind Algorithm](unwind.md) — The recapture selection logic
- [File Structure](../reference/files.md) — Which files live in which layer
