# File Structure

Current annotated source tree. Files marked **[kernel]** enforce structural invariants; files marked **[policy]** implement business logic on top.

```
src/
├── main.ts                                    REPL entry point; chart of accounts and phase functions
├── utils.ts                                   Result type, CLI runner, dump/write helpers, muldiv
│
├── ledger-kernel/                             [kernel] Core double-entry infrastructure
│   ├── positions.ts                           Position interface, scale/unscale/formatQuantity
│   ├── transactions.ts                        Transaction class, construction and validation
│   ├── ledger.ts                              Ledger container, newTransaction, addTransaction, verify, Orientation enum
│   │
│   ├── accounts/                              [kernel] Account system
│   │   ├── node.ts                            AccountNode interface (common to Account and AccountFolder)
│   │   ├── account.ts                         Account leaf class; generateInputs/generateOutputs
│   │   ├── folder.ts                          AccountFolder tree node; addAccount/addFolder/addResidualAccount/addExchangeAccount
│   │   ├── position-lot-store.ts              PositionLotStore per-position lot store; generateInputsRaw/generateOutputsRaw
│   │   ├── computed.ts                        ComputedAccount, ResidualAccount, ExchangePositionsAccount
│   │   └── summary.ts                         AccountSummary, FolderSummary display types
│   │
│   ├── transactions/                          [kernel] Lot and exchange primitives
│   │   ├── inputs.ts                          UTXI, UTXOConsumption, Input union type
│   │   ├── outputs.ts                         UTXO, UTXIConsumption, Output union type
│   │   └── cross-position.ts                  Exchange, ExchangedUTXO/UTXI, ResidualUTXO/UTXI, ExchangeAccountMarker
│   │
│   └── disposal-methods/                      [kernel] Lot selection strategies
│       ├── disposals.ts                       DisposalMethod<T> type definition
│       └── basic-fifo.ts                      FIFO implementation
│
├── equity-policy/                             [policy] Business logic layered on the kernel
│   ├── book-value/
│   │   ├── engine.ts                          BookValueEngine — backward basis traversal; compute(inputs) is the public entry
│   │   ├── lineage.ts                         unwind(), collectOriginLeaves() (public); collectChainEdges(),
│   │   │                                      groupRecapturesByExchange(), collectResidualNodes() (internal)
│   │   └── types.ts                           BasisPath, OriginPath, ExchangePath, ResidualPath
│   ├── exchange/                              Exchange pipeline — everything needed to record an exchange
│   │   ├── index.ts                           Public re-exports for the exchange module
│   │   ├── types.ts                           ResidualTarget, gainAccountOf, lossAccountOf, ExchangeRecapture, HopTransaction
│   │   ├── recapture.ts                       computeRecaptureResolution() — proceeds split, gain/loss, forward-exchange math
│   │   ├── resolution.ts                      ExchangeResolution — builds accounting entries (inputs/outputs) from the recapture math
│   │   └── swap.ts                            swap() high-level helper; SwapRequest, SwapResult
│   ├── recaptures.ts                          Shared recapture-plan primitives: summarizeConsumption(), executeRecaptures(), classifyRecaptures()
│   └── expense.ts                             expense() full-unwind expense recording, ExpenseResolution
│
└── tests/                                     Test suite
    ├── utils/
    │   └── ledger-fixture.ts                  Shared account setup helpers for tests
    ├── ledger-kernel/
    │   └── uncommitted-lots.test.ts           Kernel lot-availability invariant tests
    └── equity-policy/
        ├── exchange.test.ts                   Exchange/swap integration tests
        ├── exchange-invariants.test.ts        Exchange invariant tests
        └── expense.test.ts                    Expense function tests
```

---

## Layer Boundary

`equity-policy/` imports from `ledger-kernel/`. `ledger-kernel/` never imports from `equity-policy/`.

---

## Related Documents

- [Two-Layer Design](../architecture/layers.md) — What each layer owns
- [Disposal Methods](disposal-methods.md) — The `DisposalMethod` interface
