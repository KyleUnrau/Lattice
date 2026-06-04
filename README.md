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

Cross-position transfers are modeled as `Exchange` objects that lock a conversion rate at creation time.

The `exchange()` equity-policy function is the primary way to create exchanges during transaction construction. It returns a `forwardExchange: Exchange | null` and a `RecaptureResolution` — see the [Equity Policy](#equity-policy) section. The `Exchange` class can also be instantiated directly when constructing the initial side of a known conversion (e.g. `exchange1` in a CAD→USD swap) before any prior lineage exists.

```ts
// Exchange kernel primitives (from transactions/exchange.ts)
exchange.from  // ExchangedTXO — the "from" side; goes in the source transaction's outputs
exchange.to    // ExchangedTXI — the "to" side; goes in the destination transaction's inputs
```

### Exchange Transaction Pairs

An exchange always spans two single-position transactions:

```ts
// BTC transaction: wallet gives 0.01 BTC to the exchange
ledger.newTransaction(wallet.generateInputs(btc, 0.01, txs), [swap.forwardExchange.from]);

// CAD transaction: cash receives 1000 CAD from the exchange
ledger.newTransaction([swap.forwardExchange.to], cash.generateOutputs(cad, 1000, txs));
```

### Recapture

An exchange can be partially or fully unwound at the original locked rate:

```ts
const recapture = exchange1.recapture(375, ledger.transactions);
// recapture.from: TXIConsumption(375 CAD)  — settles part of exchange1.to
// recapture.to:   TXOConsumption(500 CAD rate-equivalent) — reclaims from exchange1.from
```

The recapture rate is always `from.quantity / to.quantity` — the original locked rate regardless of current market. Recaptures are computed automatically by `computeRecaptureResolution()` and returned via the `resolution.recaptures` array.

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

A single `Account` manages per-position engines containing `TXO` and `TXI` lists. It is the only concrete account type that generates transaction inputs and outputs.

```ts
const cash = currentAssets.addAccount("Cash", Orientation.Positive, fifo<TXO>, fifo<TXI>);
```

Key methods:

```ts
account.generateInputs(position, quantity, transactions)   // consume TXOs → return TXOConsumptions (+ TXI if needed)
account.generateOutputs(position, quantity, transactions)  // settle TXIs → return TXIConsumptions (+ TXO if needed)
account.generateResidualInput(position, quantity, exchange)  // ResidualTXI — exchange-tagged gain
account.generateResidualOutput(position, quantity, exchange) // ResidualTXO — exchange-tagged loss
```

`generateInputs` pulls value out of the account (spending) by consuming existing `TXO` lots via the disposal method. If more is requested than available, it creates a fresh `TXI` for the shortfall.

`generateOutputs` delivers value into the account by settling existing `TXI` obligations. If more is delivered than owed, it creates a fresh `TXO` for the surplus.

### ExchangePositionsAccount

`ExchangePositionsAccount` is a read-only computed equity account — it has no `generateInputs()` or `generateOutputs()`. Its balance is derived on demand by scanning every `ExchangedTXO` and `ExchangedTXI` across all transactions:

- Remaining `ExchangedTXO` availability contributes a positive root balance (asset still held at exchange).
- Remaining `ExchangedTXI` availability contributes a negative root balance (exchange's reciprocal claim).

Adding it to the equity tree ensures that `netAssets.getRootBalances() + equity.getRootBalances() === 0` even with open, partially-recaptured exchanges — each open exchange contributes a matching +/− pair that cancels with the account flows that funded it.

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
| `OriginPath` | Reached a plain `TXI` — opening balance, equity injection, or unattributed inflow. No further lineage. |
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

The equity policy (`equity-policy.ts`) answers two questions: *"How should consumed inputs be attributed back to their origin position?"* and *"How should gains and losses be carried without breaking the basis chain?"*

### collectRecaptureableNodes

```ts
collectRecaptureableNodes(basis: BasisPath[], targetPosition: Position): RecaptureableNode[]
```

Walks the full `BasisPath` tree recursively. Collects every `ExchangePath` whose `exchange.from.position === targetPosition` (these exchanges can be recaptured at locked rate). Non-recapturable exchange nodes are recursed into to find deeper recapturable exchanges. Origin paths are ignored.

### groupRecapturesByExchange

Aggregates `RecaptureableNode[]` by exchange instance, summing to-side and from-side quantities across all nodes sharing the same exchange. Ensures each exchange is recaptured exactly once even when its lineage appears in multiple consumed TXOs.

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
3. Call `exchange.recapture(toSideQuantity, transactions)` for each → produces `ExchangeRecapture[]`.
4. Compute `totalActualForRecaptured = totalActualReceived × (totalRecapturedToSide / totalConsumed)`.
5. Return:

```ts
type RecaptureResolution = {
    recaptures: ExchangeRecapture[];   // recapture objects to include in transactions
    totalCostBasis: number;            // sum of original "from" quantities at locked rate
    residualQuantity: number;          // actualForRecaptured − costBasis (positive=gain, negative=loss)
    newExchangeToQuantity: number;     // consumed quantity not covered by any recapture
    newExchangeFromQuantity: number;   // target-position equivalent for newExchangeToQuantity
};
```

### expense

```ts
expense(inputs: Input[], engine: BookValueEngine, transactions: Transaction[]): ExpenseResolution
```

Records an expense by tracing the top-level basis paths of all consumed inputs. Exchange and residual paths are recaptured at locked rates and grouped by origin position, so each portion of the expense is recognized in the position it was originally derived from. Origin-path amounts (no exchange lineage) are surfaced as direct expense amounts in their own position.

Returns an `ExpenseResolution` with:
- `recaptureGroups` — one `ExpenseRecaptureGroup` per distinct origin position; each group drives a separate expense transaction.
- `originAmounts` — portions with no exchange lineage; expensed directly in the consuming transaction.

### exchange

```ts
exchange(
    inputs: Input[],
    targetPosition: Position,
    actualProceeds: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): ExchangeResolution
```

Records an exchange of inputs into `targetPosition`. Traces the basis of consumed inputs to compute cost basis and gain/loss, then decides whether a `forwardExchange` is needed:

**`forwardExchange: Exchange | null`**

- **Non-null** when `|residualQuantity| > ε` (gain or loss present) OR when any consumed quantity has no prior exchange lineage (`newExchangeToQuantity > ε`). The `forwardExchange` spans the full consumed quantity at the actual market rate, carrying the complete basis chain through one consistent exchange node. Its `.from` goes in the consuming transaction's outputs; its `.to` goes in the receiving transaction's inputs, alongside any recapture entries.
- **Null** (pure recapture) when all consumed quantity traces exactly to prior exchanges that close at their locked rates with zero residual. The existing `resolution.recaptures` alone settle all open positions cleanly.

`resolution.residualQuantity` is always available for tax reporting regardless of whether `forwardExchange` is null.

**Why `forwardExchange` instead of injecting a residual TXI for the gain:**  
A plain `TXI` (origin path) carries zero cost basis. If a 50 CAD gain were injected as a `TXI` and the 550 CAD were later exchanged for BTC, the 50/550 portion would trace as an unattributed inflow — breaking proportional cost basis for the entire position. With `forwardExchange` covering all 550 CAD at the actual rate, the basis engine traces: 550 CAD → `forwardExchange` → 375 USD → `exchange1` → 500 CAD → `btcExchange` → BTC, preserving the full chain.

### Transaction Construction Pattern

```ts
const swap = exchange(fromInputs, targetPosition, actualProceeds, engine, ledger.transactions);

// consuming transaction: recaptures settle prior exchanges; forwardExchange.from anchors the new one
const fromOutputs: Output[] = [
    ...swap.resolution.recaptures.map(r => r.from),
    ...(swap.forwardExchange ? [swap.forwardExchange.from] : [])
];
ledger.newTransaction(fromInputs, fromOutputs);

// receiving transaction: forwardExchange.to (or recapture.to) → account outputs
const toInputs: Input[] = [
    ...swap.resolution.recaptures.map(r => r.to),
    ...(swap.forwardExchange ? [swap.forwardExchange.to] : [])
];
ledger.newTransaction(toInputs, cash.generateOutputs(targetPosition, actualProceeds, ledger.transactions));

// swap.resolution.residualQuantity — gain (positive) or loss (negative) for tax reporting
```

---

## Ledger

The `Ledger` holds the ordered `Transaction[]` list and the two root `AccountFolder`s.

```ts
const ledger = new Ledger(netAssets, netWorth);
ledger.newTransaction(inputs, outputs);  // validates and appends
ledger.verify();                         // returns { ok: true } or { ok: false, error }
```

### Verification

`ledger.verify()` checks that every position's total root balance — the sum of `netAssets.getRootBalances()` and `equity.getRootBalances()` — equals zero (within floating-point epsilon).

Open exchange positions are handled structurally: `ExchangePositionsAccount` is added to the equity tree with the appropriate orientation. Its `getRootBalance()` scans all transactions for remaining `ExchangedTXO`/`ExchangedTXI` availability and contributes the net to the equity sum. No special adjustment is needed inside `verify()` — the equity account tree already accounts for it.

A fully-settled exchange (both sides consumed to zero) contributes nothing to `ExchangePositionsAccount`.

---

## Example Flow (main.ts)

The included example demonstrates a four-phase BTC/CAD/USD scenario. Each phase is a self-contained function that generates and commits its transactions when called, building on the ledger state left by prior phases.

| Phase | Description |
|-------|-------------|
| `phase0` | Opening balance: 0.02 BTC credited to wallet |
| `phase1` | Exchange 0.01 BTC → 1000 CAD; BTC has no prior CAD lineage so `forwardExchange` covers the full amount |
| `phase2` | 500 CAD exchanged for 375 USD via equity policy (CAD has no prior USD lineage → `forwardExchange`); 25 CAD expensed and traced back to BTC via phase1's exchange chain |
| `phase3` | 375 USD exchanged for 550 CAD (50 CAD gain); `forwardExchange` at actual rate carries the full 550 CAD basis chain through USD → CAD → BTC |

All phases pass `ledger.verify()` when called in sequence.

### Phase Functions

Each phase function follows the same structure:

```ts
function phase1(): { from: TransactionConstruct, to: TransactionConstruct, exchange: ExchangeResolution } {
    const fromInputs = wallet.generateInputs(btc, 0.01, ledger.transactions);
    const swap = exchange(fromInputs, cad, 1000, engine, ledger.transactions);

    // from: consuming transaction (wallet BTC → exchange)
    const fromOutputs: Output[] = swap.resolution.recaptures.map(r => r.from);
    if (swap.forwardExchange) fromOutputs.push(swap.forwardExchange.from);

    // to: receiving transaction (exchange → cash CAD)
    const toInputs: Input[] = swap.resolution.recaptures.map(r => r.to);
    if (swap.forwardExchange) toInputs.push(swap.forwardExchange.to);

    return {
        from: { inputs: fromInputs, outputs: fromOutputs, transaction: ledger.newTransaction(fromInputs, fromOutputs) },
        to:   { inputs: toInputs,   outputs: toOutputs,   transaction: ledger.newTransaction(toInputs, cash.generateOutputs(cad, 1000, ledger.transactions)) },
        exchange: swap
    };
}
```

The phase functions are available in the REPL context so they can be called interactively to build up ledger state and then inspected.

---

## File Overview

```
src/
├── main.ts                                    Phase functions and CLI sandbox
├── utils.ts                                   Result type, CLI runner, debugging helpers
└── ledger-kernel/
    ├── positions.ts                           Position interface
    ├── transactions.ts                        Transaction construction and validation
    ├── ledger.ts                              Ledger container and verification
    ├── accounts.ts                            Account, AccountFolder, AccountEngine, ExchangePositionsAccount
    ├── equity-policy.ts                       exchange(), expense(), computeRecaptureResolution()
    ├── transactions/
    │   ├── inputs.ts                          TXI, TXOConsumption
    │   ├── outputs.ts                         TXO, TXIConsumption
    │   └── exchange.ts                        Exchange, ExchangedTXO/TXI, ResidualTXO/TXI, ExchangeRecapture
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
> phase0()
> phase1()
> ledger.verify()
> cash.getBalances(ledger.transactions)
> dump(engine.compute(someTXO, 500))
> ledger.getRootBalances()
```

All named variables from `main.ts` (positions, accounts, engine, phase functions, constructors) are available in the REPL context.

---

## Architectural Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Single position per transaction | `Transaction` constructor throws on mismatch |
| `sum(inputs) === sum(outputs)` | `Transaction` constructor throws on imbalance |
| TXO availability never over-consumed | `TXO.consume()` checks against `calculateAvailable()` |
| TXI availability never over-consumed | `TXI.consume()` checks against `calculateAvailable()` |
| Book value traversal is acyclic | Per-branch visited set in `BookValueEngine` |
| Ledger nets to zero per position | `Ledger.verify()` including `ExchangePositionsAccount` in equity |
| ExchangePositionsAccount is read-only | No `generateInputs()`/`generateOutputs()` — positions settle only via `Exchange.recapture()` |

**Policy decisions (not invariants):** which lots to consume (disposal method), when to recognize gain/loss, whether a `forwardExchange` is needed, how residuals are tagged.

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
- Injecting origin TXIs for gains (breaks cost basis chain for subsequent transactions)

---

## License

This project is source-available but not open source. All rights reserved unless explicitly granted.

You may view, study, and experiment with the code for personal and educational purposes. You may not redistribute, sublicense, use commercially, create derivatives for distribution, or rehost publicly without permission.

The licensing model may evolve as the project matures. Contact the author for collaboration, research, or licensing inquiries.
