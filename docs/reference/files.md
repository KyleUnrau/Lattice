# File Structure

Current annotated source tree. Files marked **[kernel]** enforce structural invariants; files marked **[policy]** implement business logic on top.

```
src/
├── scenario.ts                                Scenario definitions and LedgerView; entry point for the explorer
├── debug.ts                                   REPL entry point — injects scenario state and kernel/policy types via runCLI
├── utils.ts                                   Result type, runCLI REPL runner, muldiv
│
├── ledger-kernel/                             [kernel] Core double-entry infrastructure
│   ├── positions.ts                           Position interface, scale/unscale/formatQuantity
│   ├── transactions.ts                        Transaction class, construction and aggregate over-consumption validation; TransactionLike interface; sumNodeQuantityScaled
│   ├── ledger.ts                              Ledger container, newTransaction, record/beginEvent (group overlay), beginGeneration, verify (zero-sum + lot-availability backstop), Orientation enum, EventBuilder
│   ├── generation-context.ts                  GenerationContext — staging session for multiple draws before commit (Ledger.beginGeneration)
│   ├── transaction-group.ts                   TransactionGroup — recursive, non-authoritative semantic overlay grouping related transactions into business events
│   │
│   ├── accounts/                              [kernel] Account system
│   │   ├── node.ts                            AccountNode interface (common to Account and AccountFolder)
│   │   ├── account.ts                         Account leaf class; generateInputs/generateOutputs
│   │   ├── folder.ts                          AccountFolder tree node; addAccount/addFolder/addResidualAccount/addExchangeAccount; getAccounts
│   │   ├── position-lot-store.ts              PositionLotStore per-position lot store; generateInputs/generateOutputs
│   │   ├── computed.ts                        ComputedAccount, ResidualAccount, ExchangeAccount; ResidualTarget, gainAccountOf, lossAccountOf
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
│   │   ├── engine.ts                          BookValueEngine — backward basis traversal; BasisPath, OriginPath, ExchangePath, ResidualPath types
│   │   └── lineage.ts                         collectOriginLeaves() (public); collectChainEdges(),
│   │                                          groupRecapturesByExchange(), collectResidualNodes() (internal)
│   ├── exchange.ts                            ExchangeResolution — assembles kernel lines for a cross-position exchange
│   ├── expense.ts                             ExpenseResolution — full-unwind expense recording
│   └── recaptures.ts                          unwind(), executeRecaptures(), classifyRecaptures(); UnwindPlan, Recapture, HopTransaction
│
├── ui/                                        Transaction explorer web UI
│   ├── explorer/
│   │   ├── server.ts                          HTTP server; routes /api/state, /api/tx/:n, /api/lot/:id, /api/exchange/:id
│   │   ├── web.ts                             Embedded HTML/CSS/JS page
│   │   ├── registry.ts                        Stable UUID-keyed registry for lots and exchanges
│   │   └── serialize.ts                       DTO builders for the JSON API
│   └── graph-visualization/
│       └── transaction-graph.ts               Transaction graph export
│
└── tests/                                     Test suite
    ├── utils/
    │   └── ledger-fixture.ts                  Shared account setup helpers for tests
    ├── ledger-kernel/
    │   ├── uncommitted-lots.test.ts           Kernel lot-availability invariant tests
    │   ├── staged-generation.test.ts          GenerationContext staging + over-consumption guard tests
    │   └── transaction-groups.test.ts         TransactionGroup overlay: record/beginEvent, member order, identity, verify
    └── equity-policy/
        ├── exchange.test.ts                   Exchange/ExchangeResolution integration tests
        ├── exchange-invariants.test.ts        Exchange invariant tests
        └── expense.test.ts                    ExpenseResolution tests
```

---

## Layer Boundary

`equity-policy/` imports from `ledger-kernel/`. `ledger-kernel/` never imports from `equity-policy/`.

---

## Related Documents

- [Two-Layer Design](../architecture/layers.md) — What each layer owns
- [Disposal Methods](disposal-methods.md) — The `DisposalMethod` interface
