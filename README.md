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

The system is built around two consumable lot types:

| Primitive | Meaning |
|-----------|---------|
| `UTXO` | An **unspent transaction output** — a produced lot of value stored in an account |
| `UTXI` | An **unspent transaction input** — an unsettled obligation or equity inflow |

The "unspent" prefix distinguishes the standing lot from the spending/settlement reference that appears inside a transaction's arrays. Both support partial consumption; remaining availability is computed dynamically by scanning the full transaction history.

### UTXO

A `UTXO` is produced by a transaction and registered in an account's engine. It tracks how much of its original quantity has been consumed via `UTXOConsumption` objects in later transactions.

```ts
// produce 1000 CAD into cash account
const outputs = cash.generateOutputs(cad, 1000, ledger.transactions);
// returns [UTXO(1000 CAD)] when no prior UTXI obligations exist
```

`UTXO.calculateAvailable(transactions)` scans all transactions for `UTXOConsumption` objects that reference this UTXO and subtracts them from the original quantity.

### UTXI

A `UTXI` is the symmetric counterpart — a balancing input representing value entering the system (an opening balance, equity contribution, or exchange receipt). It also supports partial consumption via `UTXIConsumption` objects in transaction outputs.

```ts
// bring 0.02 BTC from the opening balance
const inputs = openingBalance.generateInputs(btc, 0.02, ledger.transactions);
// returns [UTXI(0.02 BTC)] when no prior UTXO lots cover it
```

### Consumptions

| Type | Appears as | Points to |
|------|-----------|-----------|
| `UTXOConsumption` | Transaction **input** | Source `UTXO` |
| `UTXIConsumption` | Transaction **output** | Source `UTXI` |

Union types:
- `Input = UTXI | UTXOConsumption`
- `Output = UTXO | UTXIConsumption`

---

## Exchange

Cross-position transfers are modeled as `Exchange` objects that lock a conversion rate at creation time. The `exchange()` equity-policy function is the primary way to create exchanges — it handles prior lineage recapture, forward exchange creation, and residual gain/loss recognition in one step. See the [Equity Policy](#equity-policy) section.

```ts
// Exchange kernel primitives (from transactions/cross-position.ts)
exchange.from  // ExchangedUTXO — the "from" side; goes in the source transaction's outputs
exchange.to    // ExchangedUTXI — the "to" side; goes in the destination transaction's inputs
```

### Exchange Transaction Pairs

An exchange always spans two single-position transactions:

```ts
// BTC transaction: wallet gives 0.01 BTC to the exchange
ledger.newTransaction(wallet.generateInputs(btc, 0.01, txs), [swap.exchange.from]);

// CAD transaction: cash receives 1000 CAD from the exchange
ledger.newTransaction([swap.exchange.to], cash.generateOutputs(cad, 1000, txs));
```

### Recapture

An exchange can be partially or fully unwound at the original locked rate:

```ts
const recapture = exchange1.recapture(375, ledger.transactions);
// recapture.from: UTXIConsumption(375 CAD)  — settles part of exchange1.to; goes in tx outputs
// recapture.to:   UTXOConsumption(500 CAD)  — reclaims from exchange1.from; goes in tx inputs
```

The recapture rate is always `from.quantity / to.quantity` — the original locked rate regardless of current market. Recaptures are computed automatically by `computeRecaptureResolution()` and returned via `resolution.recaptures`.

### Exchange Subtypes

| Class | Extends | Placed in | Meaning |
|-------|---------|-----------|---------|
| `ExchangedUTXO` | `UTXO` | tx outputs | "From" side of an exchange — value given away |
| `ExchangedUTXI` | `UTXI` | tx inputs | "To" side of an exchange — value received |
| `ResidualUTXO` | `UTXO` | tx outputs | A loss relative to a recaptured exchange's locked rate |
| `ResidualUTXI` | `UTXI` | tx inputs | A gain relative to a recaptured exchange's locked rate |

`Residual` variants carry an `.exchange: Exchange | null` back-reference. When non-null, the book value engine traces their lineage through the referenced exchange's from-side. When null (pure-recapture case — all consumed inputs had prior exchange lineage), the engine treats the residual as an origin path.

---

## Account System

### Account

A single `Account` manages per-position `AccountEngine`s containing `UTXO` and `UTXI` lots. It is the only concrete account type that generates transaction inputs and outputs.

```ts
const cash = currentAssets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
```

Key methods:

```ts
account.generateInputs(position, quantity, transactions)   // consume UTXOs → UTXOConsumptions (+ UTXI if needed)
account.generateOutputs(position, quantity, transactions)  // settle UTXIs → UTXIConsumptions (+ UTXO if needed)
```

`generateInputs` pulls value out of the account (spending) by consuming existing `UTXO` lots via the disposal method. If more is requested than available, it creates a fresh `UTXI` for the shortfall.

`generateOutputs` delivers value into the account by settling existing `UTXI` obligations. If more is delivered than owed, it creates a fresh `UTXO` for the surplus.

### ResidualAccount

`ResidualAccount` is a read-only equity account that owns its own `ResidualUTXI` (gain) and `ResidualUTXO` (loss) lots directly. Lots are registered by the `exchange()` equity-policy function via:

```ts
residualAccount.addResidualInput(quantity, position, exchange)   // gain — ResidualUTXI
residualAccount.addResidualOutput(quantity, position, exchange)  // loss — ResidualUTXO
```

Each `ResidualAccount` scans only its own lots for balance — multiple accounts (e.g. "Capital Gains", "FX Gains", "Profit") can coexist without crosstalk. The `exchange` argument tags each lot to its forward exchange for basis tracing, or `null` in the pure-recapture case.

```ts
const capitalGains = netIncome.addResidualAccount("Capital Gains (Losses)", Orientation.Positive);
```

### ExchangePositionsAccount

`ExchangePositionsAccount` is a read-only computed equity account — it has no `generateInputs()` or `generateOutputs()`. Its balance is derived on demand by scanning every `ExchangedUTXO` and `ExchangedUTXI` across all transactions:

- Remaining `ExchangedUTXO` availability contributes a positive root balance (asset still held at exchange).
- Remaining `ExchangedUTXI` availability contributes a negative root balance (exchange's reciprocal claim).

Adding it to the equity tree ensures `netAssets.getRootBalances() + equity.getRootBalances() === 0` even with open, partially-recaptured exchanges — each open exchange contributes a matching +/− pair that cancels with the account flows that funded it.

```ts
const exchangePositions = netWorth.addExchangeAccount("Net Transfers In (Out)", Orientation.Positive);
```

### ComputedAccount

Both `ResidualAccount` and `ExchangePositionsAccount` extend `ComputedAccount`, an abstract base that provides orientation and display logic but no `generateInputs()`/`generateOutputs()`. This enforces that computed equity accounts cannot be used as sources or destinations in transaction construction.

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

Each account/folder has a `localOrientation`. The `getRootOrientation()` is the product of all ancestors' orientations. This replaces hardcoded debit/credit semantics with a single multiplicative property. The `getRootBalance()` is orientation-independent (raw UTXO − UTXI), while `getBalance()` applies the root orientation for financial statement presentation.

### AccountEngine

The per-position engine inside each `Account` holds the raw `UTXO[]` and `UTXI[]` lists and implements the disposal logic. It is not directly instantiated by callers.

---

## Disposal Methods

A disposal method selects which existing UTXO (or UTXI) lots to consume when a given quantity is requested.

```ts
type DisposalMethod<T extends UTXO | UTXI> =
    (components: T[], quantity: number, transactions: Transaction[]) => Map<T, number>;
```

Currently implemented: **FIFO** (`basic-fifo.ts`) — consumes oldest available lots first.

The `transactions` parameter is required because availability is computed dynamically by scanning the full history, not stored in the lot itself.

Other policies (LIFO, average cost, highest-cost, tax-optimized) can be plugged in by implementing the same function signature.

---

## Book Value Engine

The `BookValueEngine` answers: *"Where did this value come from?"* for any `UTXO` and quantity. It performs backward traversal through the UTXI/UTXO consumption graph, crossing exchange boundaries to produce a structured `BasisPath[]` tree.

```ts
const engine = new BookValueEngine(ledger.transactions);
const paths   = engine.compute(someUTXO, quantity);
```

### BasisPath Types

```ts
type BasisPath = OriginPath | ExchangePath | ResidualPath;
```

| Type | Meaning |
|------|---------|
| `OriginPath` | Reached a plain `UTXI` — opening balance, equity injection, or unattributed inflow. No further lineage. |
| `ExchangePath` | Crossed an `ExchangedUTXI` — value came from an exchange. Carries `quantity` (to-side), `fromQuantity` (from-side at locked rate), and recursive `basis` of the from-side. |
| `ResidualPath` | Crossed a `ResidualUTXI` — an exchange-tagged gain with recursive basis. Same shape as `ExchangePath` but tagged `"residual"`. |

### Traversal Algorithm

1. Find the transaction that produced the UTXO (by scanning all `tx.outputs`).
2. Compute `inputFraction = quantity / totalOutputQuantity` (all outputs, including `UTXIConsumption`s, participate in the denominator).
3. For each input, multiply its quantity by `inputFraction` and dispatch:
   - `UTXOConsumption` → recurse into source UTXO (transparent pass-through)
   - `ExchangedUTXI` → emit `ExchangePath`; recurse into `exchange.from` for the basis
   - `ResidualUTXI` with `exchange !== null` → emit `ResidualPath`; recurse into `exchange.from`
   - `ResidualUTXI` with `exchange === null` → emit `OriginPath` (pure-recapture gain; no further lineage)
   - plain `UTXI` → emit `OriginPath`
4. Cycle detection uses a per-branch visited set (copied on branch, not shared across siblings) to allow diamond-shaped DAGs without false positives.

**Invariants enforced:** quantity > 0, quantity ≤ utxo.quantity, every UTXO has a producing transaction, no ancestor cycles.

---

## Equity Policy

The equity policy module (split across `equity-policy/exchange.ts`, `equity-policy/expense.ts`, `equity-policy/recapture.ts`, and `equity-policy/utils.ts`) answers two questions: *"How should consumed inputs be attributed back to their origin position?"* and *"How should gains and losses be recognized without breaking the basis chain?"*

### collectRecaptureableNodes

```ts
collectRecaptureableNodes(basis: BasisPath[], targetPosition: Position): RecaptureableNode[]
```

Walks the full `BasisPath` tree recursively. Collects every `ExchangePath` whose `exchange.from.position === targetPosition` (these exchanges can be recaptured at locked rate). Non-recapturable exchange nodes are recursed into to find deeper recapturable exchanges. Origin paths are ignored.

### groupRecapturesByExchange

Aggregates `RecaptureableNode[]` by exchange instance, summing to-side and from-side quantities across all nodes sharing the same exchange. Ensures each exchange is recaptured exactly once even when its lineage appears in multiple consumed UTXOs.

### computeRecaptureResolution

```ts
computeRecaptureResolution(
    consumedUTXOs: { source: UTXO; quantity: number }[],
    targetPosition: Position,
    totalActualReceived: number,
    engine: BookValueEngine,
    transactions: Transaction[]
): RecaptureComputation
```

Full resolution pipeline:
1. Compute `BasisPath[]` for every consumed UTXO via the engine.
2. Collect and group recapturable nodes by exchange.
3. Call `exchange.recapture(toSideQuantity, transactions)` for each → produces `ExchangeRecapture[]`.
4. Compute `totalActualForRecaptured = totalActualReceived × (totalRecapturedToSide / totalConsumed)`.
5. Return `RecaptureComputation` — an internal intermediate type consumed by `exchange()`:

```ts
{
    recaptures: ExchangeRecapture[];   // recapture objects to include in transactions
    totalCostBasis: number;            // sum of original "from" quantities at locked rate
    residualQuantity: number;          // actualForRecaptured − costBasis (positive=gain, negative=loss)
    newExchangeToQuantity: number;     // consumed quantity not covered by any recapture (origin portion)
    newExchangeFromQuantity: number;   // prorated proceeds for the origin portion
}
```

### consumedUTXOsFromInputs

```ts
consumedUTXOsFromInputs(inputs: Input[]): { source: UTXO; quantity: number }[]
```

Filters a mixed input array to only `UTXOConsumption` entries and maps them to `{ source, quantity }` pairs suitable for `computeRecaptureResolution`. Non-consumption inputs (exchange inputs, origin UTXIs) are silently ignored.

### expense

```ts
expense(inputs: Input[], engine: BookValueEngine, transactions: Transaction[]): ExpenseResolution
```

Records an expense by tracing the top-level basis paths of all consumed inputs. Exchange and residual paths are recaptured at locked rates and grouped by origin position, so each portion of the expense is recognised in the position it was originally derived from. Origin-path amounts (no exchange lineage) are surfaced as direct expense amounts in their own position.

Returns an `ExpenseResolution`:

```ts
class ExpenseResolution {
    recaptureGroups: ExpenseRecaptureGroup[];        // one group per origin position; each drives an expense tx
    originAmounts: { position, quantity }[];         // no exchange lineage; direct expense in consuming tx

    getFromOutputs(account: Account, transactions: Transaction[]): Output[]
    getExpenseEntries(account: Account, transactions: Transaction[]): { inputs: Input[]; outputs: Output[] }[]
    createTransactions(account: Account, ledger: Ledger): Transaction[]
}
```

`getFromOutputs` assembles the consuming transaction's expense outputs: recapture from-sides (settling prior exchange to-sides) followed by direct expense outputs generated into `account` for any origin amounts. Call before committing the consuming transaction.

`getExpenseEntries` returns one `{ inputs, outputs }` pair per recapture group for manual construction of expense transactions. `createTransactions` wraps this and commits each pair via `ledger.newTransaction` — call after committing the consuming transaction.

### exchange

```ts
exchange(
    inputs: Input[],
    targetPosition: Position,
    actualProceeds: number,
    engine: BookValueEngine,
    transactions: Transaction[],
    residualAccount: ResidualAccount
): ExchangeResolution
```

Records an exchange of inputs into `targetPosition`. Traces the basis of consumed inputs, separates them into recaptured and origin portions, and returns an `ExchangeResolution`:

```ts
class ExchangeResolution {
    recaptures: ExchangeRecapture[];               // close prior exchange positions; used for tax reporting
    exchange: Exchange | null;                     // forward exchange for the origin portion; null on pure recapture
    residual: ResidualUTXI | ResidualUTXO | null;  // gain/loss lot registered in residualAccount; null if break-even

    getFromOutputs(): Output[]   // outputs for the consuming transaction
    getToInputs(): Input[]       // inputs for the receiving transaction
}
```

**Recaptured portion** — inputs with prior exchange lineage in `targetPosition`. Each prior exchange is settled via a `ExchangeRecapture`. The prorated actual proceeds versus cost basis yields a gain or loss, surfaced as a `residual` lot registered directly in `residualAccount`.

**Origin portion** — inputs with no prior exchange lineage. A forward `exchange` is created at the actual market rate covering only the origin portion, creating new suspended cost basis that can be recaptured and produce a residual in a subsequent transaction.

**Pure-recapture case** — when all consumed inputs trace entirely to prior exchanges in `targetPosition`, `exchange` is `null`. No new suspended cost basis is created; the residual (if non-zero) is tagged `null` and the basis engine treats it as an origin path.

### Transaction Construction Pattern

After calling `exchange()`, use the `ExchangeResolution` methods to build the transaction entry arrays:

```ts
const swap = exchange(fromInputs, targetPosition, actualProceeds, engine, ledger.transactions, capitalGains);

// consuming transaction: close prior exchanges, open forward exchange, emit any loss residual
const fromOutputs: Output[] = swap.getFromOutputs();
ledger.newTransaction(fromInputs, fromOutputs);

// receiving transaction: re-open recaptured from-sides, forward exchange to-side, emit any gain residual
const toInputs: Input[] = swap.getToInputs();
ledger.newTransaction(toInputs, cash.generateOutputs(targetPosition, actualProceeds, ledger.transactions));
```

`getFromOutputs()` assembles `recaptures[i].from` (`UTXIConsumption`), `exchange.from` (`ExchangedUTXO`), and `residual` if it is a `ResidualUTXO`. `getToInputs()` assembles `recaptures[i].to` (`UTXOConsumption`), `exchange.to` (`ExchangedUTXI`), and `residual` if it is a `ResidualUTXI`. Null components are omitted automatically.

When expense recaptures are combined with exchange recaptures in a single consuming transaction, spread both `getFromOutputs()` calls, then use `createTransactions` for the separate expense transactions after the consuming transaction commits:

```ts
const fromOutputs: Output[] = [
    ...cadExchange.getFromOutputs(),
    ...expenseRes.getFromOutputs(exchangeExpense, ledger.transactions),
];
ledger.newTransaction(fromInputs, fromOutputs);  // consuming tx commits here

const expenseTransactions = expenseRes.createTransactions(exchangeExpense, ledger);
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

Open exchange positions are handled structurally: `ExchangePositionsAccount` is added to the equity tree with the appropriate orientation. Its `getRootBalance()` scans all transactions for remaining `ExchangedUTXO`/`ExchangedUTXI` availability and contributes the net to the equity sum. `ResidualAccount` is similarly added to the equity tree; its balance is derived from the `ResidualUTXI`/`ResidualUTXO` lots it directly owns. No special adjustment is needed inside `verify()` — the account tree already accounts for both.

A fully-settled exchange (both sides consumed to zero) contributes nothing to `ExchangePositionsAccount`.

---

## Example Flow (main.ts)

The included example demonstrates a four-phase BTC/CAD/USD scenario. Each phase is a self-contained function that generates and commits its transactions when called, building on the ledger state left by prior phases.

| Phase | Description |
|-------|-------------|
| `phase0` | Opening balance: 0.02 BTC credited to wallet |
| `phase1` | Exchange 0.01 BTC → 1000 CAD; BTC has no prior CAD lineage so `exchange` (forward) covers the full origin portion |
| `phase2` | 500 CAD exchanged for 375 USD (CAD has no prior USD lineage → forward exchange); 25 CAD expensed and traced back to BTC via phase1's exchange chain |
| `phase3` | 375 USD exchanged for 550 CAD (50 CAD capital gain); all 375 USD traces to phase2's forward exchange so `exchange` is `null` (pure recapture), and the 50 CAD gain is recognized as a `ResidualUTXI` in `capitalGains` |

After all four phases: `ledger.verify()` passes; `capitalGains` carries a −50 CAD root balance (gain reduces equity); `exchangePositions` holds BTC +0.00975, CAD −975, USD 0.

### Phase Functions

Each phase function calls `exchange()` and builds its transactions using the returned `ExchangeResolution` methods:

```ts
function phase3() {
    const usdInputs = cash.generateInputs(usd, 375, ledger.transactions);
    const usdExchange = exchange(usdInputs, cad, 550, engine, ledger.transactions, capitalGains);
    // usdExchange.exchange === null  (pure recapture — all USD traced to cadExchange)
    // usdExchange.residual instanceof ResidualUTXI  (50 CAD gain, registered in capitalGains)

    ledger.newTransaction(usdInputs, usdExchange.getFromOutputs());
    ledger.newTransaction(usdExchange.getToInputs(), cash.generateOutputs(cad, 550, ledger.transactions));
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
    ├── accounts.ts                            Account, AccountFolder, AccountEngine,
    │                                          ComputedAccount, ExchangePositionsAccount,
    │                                          ResidualAccount
    ├── equity-policy/
    │   ├── exchange.ts                        exchange(), ExchangeResolution
    │   ├── expense.ts                         expense(), ExpenseResolution, ExpenseRecaptureGroup
    │   ├── recapture.ts                       computeRecaptureResolution(),
    │   │                                      collectRecaptureableNodes(),
    │   │                                      groupRecapturesByExchange()
    │   └── utils.ts                           consumedUTXOsFromInputs()
    ├── transactions/
    │   ├── inputs.ts                          UTXI, UTXOConsumption, type Input
    │   ├── outputs.ts                         UTXO, UTXIConsumption, type Output
    │   └── cross-position.ts                 Exchange, ExchangedUTXO/UTXI,
    │                                          ResidualUTXO/UTXI, ExchangeRecapture
    ├── disposal-methods/
    │   ├── disposals.ts                       DisposalMethod<T extends UTXO | UTXI>
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
> phase2()
> phase3()
> ledger.verify()
> cash.getBalances(ledger.transactions)
> capitalGains.getRootBalance(cad, ledger.transactions)
> exchangePositions.getRootBalances(ledger.transactions)
> dump(engine.compute(someUTXO, 500))
```

All named variables from `main.ts` (positions, accounts, engine, phase functions, constructors) are available in the REPL context.

---

## Architectural Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Single position per transaction | `Transaction` constructor throws on mismatch |
| `sum(inputs) === sum(outputs)` | `Transaction` constructor throws on imbalance |
| UTXO availability never over-consumed | `UTXO.consume()` checks against `calculateAvailable()` |
| UTXI availability never over-consumed | `UTXI.consume()` checks against `calculateAvailable()` |
| Book value traversal is acyclic | Per-branch visited set in `BookValueEngine` |
| Ledger nets to zero per position | `Ledger.verify()` including `ExchangePositionsAccount` and `ResidualAccount` in equity |
| `ExchangePositionsAccount` is read-only | Extends `ComputedAccount` — no `generateInputs()`/`generateOutputs()` |
| `ResidualAccount` is write-once per lot | Lots registered via `addResidualInput/Output`; only `exchange()` calls these |
| Exchange positions settle only via recapture | `ExchangedUTXO`/`ExchangedUTXI` can only be consumed through `Exchange.recapture()` |

**Policy decisions (not invariants):** which lots to consume (disposal method), when to recognize gain/loss, whether a forward exchange is needed, how residuals are tagged, which `ResidualAccount` a gain/loss routes to.

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
- Injecting origin UTXIs directly for gains (an origin path carries no exchange lineage, breaking cost basis tracing for subsequent transactions that spend those proceeds)

---

## License

This project is source-available but not open source. All rights reserved unless explicitly granted.

You may view, study, and experiment with the code for personal and educational purposes. You may not redistribute, sublicense, use commercially, create derivatives for distribution, or rehost publicly without permission.

The licensing model may evolve as the project matures. Contact the author for collaboration, research, or licensing inquiries.
