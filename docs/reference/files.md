# File Structure

Current annotated source tree. Files marked **[kernel]** enforce structural invariants; files marked **[policy]** implement business logic on top.

```
src/
├── main.ts                                    REPL entry point; chart of accounts and phase functions
├── utils.ts                                   Result type, CLI runner, dump/write helpers, muldiv
├── archived.ts                                Archived example code (not imported)
│
├── ledger-kernel/                             [kernel] Core double-entry infrastructure
│   ├── positions.ts                           Position interface, scale/unscale/formatQuantity
│   ├── transactions.ts                        Transaction class, construction and validation
│   ├── ledger.ts                              Ledger container, newTransaction, verify, Orientation enum
│   ├── accounts.ts                            Re-export barrel for account types (transitional)
│   │
│   ├── accounts/                              [kernel] Account system
│   │   ├── node.ts                            AccountNode interface (common to Account and AccountFolder)
│   │   ├── account.ts                         Account leaf class; generateInputs/generateOutputs
│   │   ├── folder.ts                          AccountFolder tree node; addAccount/addFolder
│   │   ├── engine.ts                          AccountEngine per-position lot store
│   │   ├── computed.ts                        ComputedAccount, ResidualAccount, ExchangePositionsAccount
│   │   └── summary.ts                         AccountSummary, FolderSummary display types
│   │
│   ├── transactions/                          [kernel] Lot and exchange primitives
│   │   ├── inputs.ts                          UTXI, UTXOConsumption, Input union type
│   │   ├── outputs.ts                         UTXO, UTXIConsumption, Output union type
│   │   └── cross-position.ts                 Exchange, ExchangedUTXO/UTXI, ResidualUTXO/UTXI, ExchangeRecapture
│   │
│   └── disposal-methods/                      [kernel] Lot selection strategies
│       ├── disposals.ts                       DisposalMethod<T> type definition
│       └── basic-fifo.ts                      FIFO implementation
│
└── equity-policy/                             [policy] Business logic layered on the kernel
    ├── book-value/
    │   ├── engine.ts                          BookValueEngine — backward basis traversal
    │   └── types.ts                           BasisPath, OriginPath, ExchangePath, ResidualPath
    ├── lineage.ts                             unwind(), collectChainEdges(), groupRecapturesByExchange(),
    │                                          collectResidualNodes(), collectOriginLeaves()
    ├── recapture.ts                           computeRecaptureResolution() — full recapture math pipeline
    ├── exchange.ts                            ExchangeResolution class, ExchangeRecapture, HopTransaction
    ├── swap.ts                                swap() high-level exchange entry point, SwapRequest, SwapResult
    ├── expense.ts                             expense() full-unwind expense recording, ExpenseResolution
    └── utils.ts                               consumedUTXOsFromInputs() helper
```

---

## Layer Boundary

`equity-policy/` imports from `ledger-kernel/`. `ledger-kernel/` never imports from `equity-policy/`.

---

## Related Documents

- [Two-Layer Design](../architecture/layers.md) — What each layer owns
- [Disposal Methods](disposal-methods.md) — The `DisposalMethod` interface
