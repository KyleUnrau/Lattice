# Ledger Kernel

A graph-oriented accounting kernel for modeling deterministic financial state, transaction lineage, position flows, cost basis, and exchange relationships across multiple independent positions.

This project explores an accounting architecture that sits between traditional double-entry bookkeeping, UTXO-style transaction systems, and cost-basis engines. Instead of collapsing all activity into a single reporting currency and opaque journal balances, the system models explicit positions, consumable transaction outputs, fragmented lineage, and exchange links between independent transaction graphs.

---

## Core Ideas

### Positions Are First-Class

A `Position` represents any tracked quantity — currency, commodity, share, crypto asset, or anything measurable.

```ts
const btc: Position = { name: "Bitcoin" };
const cad: Position = { name: "Canadian Dollars" };
```

Every transaction is constrained to a **single position** internally. Cross-position movement happens through explicit `Exchange` objects, never by collapsing everything into a synthetic base currency.

### Double-Entry Integrity Without Debit/Credit Labels

The system enforces `sum(inputs) === sum(outputs)` at transaction construction time. If they don't match, the transaction throws. There are no debit/credit keywords — polarity emerges from the orientation hierarchy of the account tree.

---

## Transaction Primitives

The system is built around two consumable primitives:

| Primitive | Meaning |
|-----------|---------|
| `TXO` | A produced quantity (output) — stored value in an account |
| `TXI` | A required balancing quantity (input) — an obligation or inflow |

Both support partial consumption. Remaining availability is computed dynamically by scanning the full transaction history.

### TXO

A `TXO` is produced by a transaction and registered in an account's engine. It tracks how much of its original quantity has been consumed via `TXOConsumption` objects in later transactions.

```ts
// produce 1000 CAD into cash account
const outputs = cash.generateOutputs(cad, 1000, ledger.transactions);
// returns [TXO(1000 CAD)] when no prior TXI obligations exist
```

`TXO.calculateAvailable(transactions)` scans all transactions for `TXOConsumption` objects that reference this TXO and subtracts them from the original quantity.

### TXI

A `TXI` is the symmetric counterpart — a balancing input representing value entering the system (an opening balance, equity contribution, or exchange receipt). It also supports partial consumption via `TXIConsumption` objects in transaction outputs.

```ts
// bring 0.02 BTC from the opening balance
const inputs = openingBalance.generateInputs(btc, 0.02, ledger.transactions);
// returns [TXI(0.02 BTC)] when no prior TXO lots cover it
```

### Consumptions

| Type | Appears as | Points to |
|------|-----------|-----------|
| `TXOConsumption` | Transaction **input** | Source `TXO` |
| `TXIConsumption` | Transaction **output** | Source `TXI` |

Union types:
- `Input = TXI | TXOConsumption`
- `Output = TXO | TXIConsumption`

---

## Exchange

Cross-position transfers are modeled as `Exchange` objects that lock a rate at creation time.

```ts
const exchange0 = new Exchange(
    { quantity: 0.01, position: btc },  // from: what you give
    { quantity: 1000, position: cad }   // to: what you receive
);
```

`exchange0.from` is an `ExchangedTXO` (goes into a BTC transaction's outputs — you're giving BTC away).  
`exchange0.to` is an `ExchangedTXI` (goes into a CAD transaction's inputs — you're receiving CAD).

### Exchange Transaction Pairs

An exchange always spans two single-position transactions:

```ts
// BTC transaction: wallet gives 0.01 BTC to the exchange
ledger.newTransaction(wallet.generateInputs(btc, 0.01, txs), [exchange0.from]);

// CAD transaction: cash receives 1000 CAD from the exchange
ledger.newTransaction([exchange0.to], cash.generateOutputs(cad, 1000, txs));
```

### Recapture

An exchange can be partially or fully unwound at the original locked rate:

```ts
const reversal = exchange0.recapture(25, ledger.transactions);
// reversal.from: TXIConsumption(25 CAD)  — settles part of exchange0.to
// reversal.to:   TXOConsumption(0.00025 BTC) — reclaims part of exchange0.from
```

The recapture rate is always `from.quantity / to.quantity` — the original locked rate regardless of current market.

### Exchange Subtypes

| Class | Extends | Meaning |
|-------|---------|---------|
| `ExchangedTXO` | `TXO` | "From" side of an exchange — value given away |
| `ExchangedTXI` | `TXI` | "To" side of an exchange — value received |
| `ResidualTXO` | `TXO` | A loss relative to an exchange's locked rate |
| `ResidualTXI` | `TXI` | A gain relative to an exchange's locked rate |

`Residual` variants carry an `.exchange` back-reference so the book value engine can trace their lineage and the equity policy can recognize their origin rate when converting back to the original position.

---

## Account System

### Account

A single `Account` manages per-position engines containing `TXO` and `TXI` lists. It is the only concrete account type.

```ts
const cash = currentAssets.addAccount("Cash", Orientation.Positive, fifo<TXO>, fifo<TXI>);
```

Key methods:

```ts
account.generateInputs(position, quantity, transactions)   // consume TXOs → return TXOConsumptions (+ TXI if needed)
account.generateOutputs(position, quantity, transactions)  // settle TXIs → return TXIConsumptions (+ TXO if needed)
account.generateResidualInput(position, quantity, exchange)  // ResidualTXI — exchange-tagged gain/income
account.generateResidualOutput(position, quantity, exchange) // ResidualTXO — exchange-tagged loss/expense
```

`generateInputs` pulls value out of the account (spending) by consuming existing `TXO` lots via the disposal method. If more is requested than available, it creates a fresh `TXI` for the shortfall.

`generateOutputs` delivers value into the account by settling existing `TXI` obligations. If more is delivered than owed, it creates a fresh `TXO` for the surplus.

### AccountFolder

A folder groups accounts and sub-folders. It has an `Orientation` that propagates multiplicatively through the tree.

```ts
const netAssets = new AccountFolder("Net Assets", Orientation.Positive);
const netWorth  = new AccountFolder("Net Worth",  Orientation.Negative);
const ledger    = new Ledger(netAssets, netWorth);
```

### Orientation System

```ts
enum Orientation { Positive = 1, Negative = -1 }
```

Each account/folder has a `localOrientation`. The `getRootOrientation()` is the product of all ancestors' orientations. This replaces hardcoded debit/credit semantics with a single multiplicative property. The `getRootBalance()` is orientation-independent (raw TXO − TXI), while `getBalance()` applies the root orientation for financial statement presentation.

### AccountEngine

The per-position engine inside each `Account` holds the raw `TXO[]` and `TXI[]` lists and implements the disposal logic. It is not directly instantiated by callers.

---

## Disposal Methods

A disposal method selects which existing TXO (or TXI) lots to consume when a given quantity is requested.

```ts
type DisposalMethod<T extends TXO | TXI> =
    (components: T[], quantity: number, transactions: Transaction[]) => Map<T, number>;
```

Currently implemented: **FIFO** (`basic-fifo.ts`) — consumes oldest available lots first.

The `transactions` parameter is required because availability is computed dynamically by scanning the full history, not stored in the lot itself.

Other policies (LIFO, average cost, highest-cost, tax-optimized) can be plugged in by implementing the same function signature.

---

## Book Value Engine

The `BookValueEngine` answers: *"Where did this value come from?"* for any `TXO` and quantity. It performs backward traversal through the TXI/TXO consumption graph, crossing exchange boundaries to produce a structured `BasisPath[]` tree.

```ts
const engine = new BookValueEngine(ledger.transactions);
const paths   = engine.compute(someTXO, quantity);
```

### BasisPath Types

```ts
type BasisPath = OriginPath | ExchangePath | ResidualPath;
```

| Type | Meaning |
|------|---------|
| `OriginPath` | Reached a plain `TXI` — opening balance, equity injection, or recognized gain. No further lineage. |
| `ExchangePath` | Crossed an `ExchangedTXI` — value came from an exchange. Carries `quantity` (to-side), `fromQuantity` (from-side at locked rate), and recursive `basis` of the from-side. |
| `ResidualPath` | Crossed a `ResidualTXI` — an exchange-tagged gain with recursive basis. Same shape as `ExchangePath` but tagged `"residual"`. |

### Traversal Algorithm

1. Find the transaction that produced the TXO (by scanning all `tx.outputs`).
2. Compute `inputFraction = quantity / totalOutputQuantity` (all outputs, including `TXIConsumption`s, participate in the denominator).
3. For each input, multiply its quantity by `inputFraction` and dispatch:
   - `TXOConsumption` → recurse into source TXO (transparent pass-through)
   - `ExchangedTXI` → emit `ExchangePath`; recurse into `exchange.from` for the basis
   - `ResidualTXI` → emit `ResidualPath`; recurse into `exchange.from` for the basis
   - plain `TXI` → emit `OriginPath`
4. Cycle detection uses a per-branch visited set (copied on branch, not shared across siblings) to allow diamond-shaped DAGs without false positives.

**Invariants enforced:** quantity > 0, quantity ≤ txo.quantity, every TXO has a producing transaction, no ancestor cycles.

---

## Equity Policy

The equity policy answers: *"How should an exchange be settled when I convert back?"* given a set of consumed TXOs and a target position.

### collectRecaptureableNodes

```ts
collectRecaptureableNodes(basis: BasisPath[], targetPosition: Position): RecaptureableNode[]
```

Walks the full `BasisPath` tree recursively. Collects every `ExchangePath` whose `exchange.from.position === targetPosition` (these exchanges can be recaptured). `ResidualPath` nodes whose exchange points to the target are **skipped** — they represent already-recognized gains above the exchange's output and cannot be further recaptured from the exchange. Non-recapturable nodes are recursed into to find deeper recapturable exchanges.

### computeRecaptureResolution

```ts
computeRecaptureResolution(
    consumedTXOs: { source: TXO; quantity: number }[],
    targetPosition: Position,
    totalActualReceived: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): RecaptureResolution
```

Full resolution pipeline:
1. Compute `BasisPath[]` for every consumed TXO via the engine.
2. Collect and group recapturable nodes by exchange.
3. Call `exchange.recapture(toSideQuantity, transactions)` for each → produces `ReverseExchange[]`.
4. Compute `totalActualForRecaptured = totalActualReceived × (totalRecapturedToSide / totalConsumed)`.
5. Return:

```ts
type RecaptureResolution = {
    recaptures: ReverseExchange[];          // reverse exchange objects to include in transactions
    totalCostBasis: number;                 // sum of original "from" quantities (at locked rate)
    residualQuantity: number;               // actualForRecaptured − costBasis (positive=gain, negative=loss)
    newExchangeToSideQuantity: number;      // consumed quantity not covered by recaptures
    newExchangeFromQuantity: number;        // target position quantity for the new exchange
};
```

### Handling the Residual

`residualQuantity` is signed:
- **Positive (gain):** `account.generateResidualInput(position, residualQuantity, originExchange)` — creates a `ResidualTXI` that contributes to account income and carries the original exchange's rate for future lineage tracing.
- **Negative (loss):** `account.generateResidualOutput(position, -residualQuantity, originExchange)` — creates a `ResidualTXO` that contributes to account expense with the same rate tagging.
- **Zero:** no residual entry needed.

The `originExchange` tag is chosen as the exchange whose rate best represents the lineage of the gain or loss (e.g., the original BTC→CAD exchange when the gain is ultimately denominated in a BTC-derived position).

---

## Ledger

The `Ledger` holds the ordered `Transaction[]` list and the two root `AccountFolder`s.

```ts
const ledger = new Ledger(netAssets, netWorth);
ledger.newTransaction(inputs, outputs);  // validates and appends
ledger.verify();                         // returns { ok: true } or { ok: false, error }
```

### Verification

`ledger.verify()` checks that every position's total root balance equals zero (within floating-point epsilon). It sums:

1. All account root balances from the `netAssets` and `equity` trees.
2. **Open exchange position adjustments:** `ExchangedTXO` remaining availability is added (asset held at exchange); `ExchangedTXI` remaining availability is subtracted (exchange's reciprocal claim). This ensures the ledger balances even with open, unrecaptured exchanges — each open exchange contributes a matching +/− pair that cancels with the account flow that funded it.

A fully-settled exchange (both sides consumed to zero) contributes nothing to the adjustment.

---

## Example Flow (main.ts)

The included example demonstrates a six-phase BTC/CAD/USD scenario:

| Phase | Description |
|-------|-------------|
| 1 | Opening balance: 0.02 BTC into wallet |
| 2 | Exchange#0: 0.01 BTC → 1000 CAD |
| 3 | 525 CAD → Exchange#1 (500 CAD→375 USD) + partial Exchange#0 recapture fee (25 CAD→0.00025 BTC expense) |
| 4 | Equity policy: derive 375 USD basis, find Exchange#1 (CAD→USD), recapture 375 USD → cost basis 500 CAD; residual goes to capitalGains (gain or loss tagged to Exchange#0's rate) |
| 5 | Inject 2000 CAD opening balance |
| 6 | Equity policy: prorate 2550 CAD — Exchange#0-attributed portion recaptured (BTC back at original rate + BTC gain/loss to capitalGains); remainder creates Exchange#2 (CAD→BTC) |

All six phases pass `ledger.verify()` at the end.

### Key Pattern: Exchange Recapture via Equity Policy

Instead of referencing exchange objects directly by name, the equity policy derives which exchanges to recapture from the book value lineage:

```ts
const resolution = computeRecaptureResolution(
    consumedTXOsFromInputs(usdInputs),
    cad,               // target position
    actualCadReceived, // actual market amount received
    engine,
    ledger.transactions
);

// gain: income entry tagged to originating exchange rate
const gainTXI = resolution.residualQuantity > 0
    ? capitalGains.generateResidualInput(cad, resolution.residualQuantity, originExchange)
    : null;

// loss: expense entry tagged to originating exchange rate
const lossTXO = resolution.residualQuantity < 0
    ? capitalGains.generateResidualOutput(cad, -resolution.residualQuantity, originExchange)
    : null;
```

---

## File Overview

```
src/
├── main.ts                                    Example scenario and CLI sandbox
├── utils.ts                                   CLI runner and debugging helpers
└── ledger-kernel/
    ├── positions.ts                           Position interface
    ├── transactions.ts                        Transaction construction and validation
    ├── ledger.ts                              Ledger container and verification
    ├── accounts.ts                            Account, AccountFolder, AccountEngine
    ├── equity-policy.ts                       collectRecaptureableNodes, computeRecaptureResolution
    ├── transactions/
    │   ├── inputs.ts                          TXI, TXOConsumption
    │   ├── outputs.ts                         TXO, TXIConsumption
    │   └── exchange.ts                        Exchange, ExchangedTXO/TXI, ResidualTXO/TXI, ReverseExchange
    ├── disposal-methods/
    │   ├── disposals.ts                       DisposalMethod type
    │   └── basic-fifo.ts                      FIFO implementation
    └── book-value/
        ├── types.ts                           BasisPath, OriginPath, ExchangePath, ResidualPath
        └── engine.ts                          BookValueEngine
```

---

## Running

```bash
npm install
npm run build
npm start
```

The CLI evaluates arbitrary expressions in the context of the running ledger:

```
> ledger.verify()
> cash.getBalances(ledger.transactions)
> dump(engine.compute(cadInOutputs[0], 1000))
> ledger.getRootBalances()
```

All named variables from `main.ts` (accounts, exchanges, resolutions, engine, constructors) are available in the REPL context.

---

## Architectural Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Single position per transaction | `Transaction` constructor throws on mismatch |
| `sum(inputs) === sum(outputs)` | `Transaction` constructor throws on imbalance |
| TXO availability never over-consumed | `TXO.consume()` checks against `calculateAvailable()` |
| TXI availability never over-consumed | `TXI.consume()` checks against `calculateAvailable()` |
| Book value traversal is acyclic | Per-branch visited set in `BookValueEngine` |
| Ledger nets to zero per position | `Ledger.verify()` including open exchange adjustments |
| Residual quantity ≥ 0 for TXI/TXO | Callers negate before passing to `generateResidual*` |

**Policy decisions (not invariants):** which lots to consume (disposal method), when to recognize gain/loss, whether to recapture a given exchange, how residuals are tagged.

---

## Philosophical Notes

This system treats accounting as:

- A **graph problem** — every balance is a derived property of a consumption DAG
- A **conservation problem** — no quantity can appear or disappear without a corresponding entry
- A **lineage problem** — cost basis is a structural property of the graph, not metadata
- A **policy-separation problem** — the kernel enforces structural invariants; equity and reporting policies live above it

It deliberately avoids:
- Collapsing multi-position history into a single reporting currency at the kernel level
- Mutable balance tables (all balances are re-derived from transaction history)
- Hardcoded debit/credit semantics (orientation propagates multiplicatively)
- Special-case logic for specific asset types

---

## License

This project is source-available but not open source. All rights reserved unless explicitly granted.

You may view, study, and experiment with the code for personal and educational purposes. You may not redistribute, sublicense, use commercially, create derivatives for distribution, or rehost publicly without permission.

The licensing model may evolve as the project matures. Contact the author for collaboration, research, or licensing inquiries.
