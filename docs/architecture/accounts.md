# Account System

## AccountFolder

`AccountFolder` is an interior node of the account tree. It groups accounts and sub-folders and carries an `Orientation`.

```ts
const netAssets = new AccountFolder("Net Assets", Orientation.Positive);
const equity    = new AccountFolder("Net Worth",  Orientation.Negative);
const ledger    = new Ledger(netAssets, equity);

const assets        = netAssets.addFolder("Assets",         Orientation.Positive);
const currentAssets = assets.addFolder("Current Assets",    Orientation.Positive);
```

---

## Account

`Account` is a leaf node. It holds per-position `PositionLotStore`s and is the only type that generates transaction inputs and outputs.

```ts
const cash = currentAssets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
```

**`generateInputs(position, quantity, transactions)`** — produces transaction *inputs* that pull value out of the account. Consumes existing `UTXO` lots using the configured disposal method. If more is requested than available, creates a fresh `UTXI` for the shortfall.

**`generateOutputs(position, quantity, transactions)`** — produces transaction *outputs* that deliver value into the account. Settles existing `UTXI` obligations. Creates a fresh `UTXO` for any surplus.

The `transactions` parameter is required because lot availability is computed dynamically by scanning history — there is no cached balance state.

> **Generating more than once before commit:** calling `generateInputs`/`generateOutputs` twice for the same account + position off raw `ledger.transactions` double-counts the lots, since the first call's consumptions aren't committed yet. Use `ledger.beginGeneration()` to obtain a `GenerationContext` whose `generateInputs(account, …)` / `generateOutputs(account, …)` keep availability accurate across the calls. See [Transaction Primitives → Staging Multiple Draws](../concepts/transactions.md).

---

## Orientation

```ts
enum Orientation { Positive = 1, Negative = -1 }
```

Each node in the account tree has a `localOrientation`. The `effectiveOrientation` of a node is the product of all its ancestors' orientations, including its own.

```
netAssets (+1) → assets (+1) → currentAssets (+1) → cash (+1)  → effectiveOrientation = +1
equity    (-1) → openingBalance (+1)                          → effectiveOrientation = -1
equity    (-1) → netIncome (+1) → capitalGains (+1)           → effectiveOrientation = -1
```

The **canonical** balance of an account (`getSignedBalanceScaled`) is `UTXO availability − UTXI availability` — always computed the same way regardless of account type, in the ledger-wide sign convention that makes the zero-sum invariant hold.

The **oriented** balance displayed on a financial statement (`getBalanceRaw`, or `getBalance` for the human-scaled number) is `signedBalance × effectiveOrientation`. This single rule replaces all hardcoded debit/credit semantics.

---

## PositionLotStore

Each `Account` maintains a per-position `PositionLotStore` created on demand when a new position is first touched. The store holds the raw `UTXO[]` and `UTXI[]` lists and implements the input/output generation logic using the account's configured disposal methods.

`PositionLotStore` is an internal detail — callers interact with `Account.generateInputs()` and `Account.generateOutputs()`.

---

## ComputedAccount

`ComputedAccount` is an abstract base for read-only equity accounts whose balances are derived by scanning transactions rather than by maintaining lots.

Two concrete subtypes:

### ResidualAccount (gains)

Owns `ResidualUTXI` **gain** lots — *directional suspended residual edges*. Losses are **not** held here: they are terminal and settle into a `TerminalAccount` (below). Lots are registered by the equity-policy layer:

```ts
// called by ExchangeResolution / swap() / expense()
residualAccount.addResidualInput(quantity, position, originBasis)  // gain edge
```

Each `ResidualAccount` scans only its own lots for its balance. Multiple residual accounts can coexist (capital gains, FX gains) without crosstalk.

The `originBasis` argument is a `Map<Position, bigint>` recording the deep-origin composition of the gain — its **residual-basis** — enabling the cost basis engine to trace lineage through residual lots, and enabling carry-back to re-recognize the deferred gain at its origin. Each lot carries a back-reference to the `ResidualAccount` that created it (`ResidualUTXI.account`), so a later carry-back realizes the gain in the **same** account that deferred it.

**Dual-name display** — an optional `negativeLabel` lets `summarize()` show an alternate name when the per-position balance is negative.

### TerminalAccount (terminal sink)

A computed sink for **final** origin-basis settlements — expenses, realized exchange losses, and negative-residual settlements. It owns **no** `PositionLotStore` and exposes no `generateInputs`/`generateOutputs`: it can never be a transaction *source*. Recognitions are minted via `recognize(quantity, position) → TerminalUTXO` and placed in a transaction's outputs; the balance is the sum of its committed `TerminalUTXO`s. Terminality is structural — a `TerminalUTXO` is excluded from every disposal/selection path and its `consume()` throws — so terminal value can never re-enter circulation as spendable inventory.

```ts
const exchangeExpense = expenses.addTerminalAccount("Exchange Expense", Orientation.Positive);
const capitalLosses   = expenses.addTerminalAccount("Capital Loss",     Orientation.Positive);
```

**Gain/loss routing** — `ResidualTarget` is `{ gain: ResidualAccount; loss: TerminalAccount }`. Gains recognize as suspended residual edges; losses sink terminally at origin. Use `gainAccountOf(target)` / `lossAccountOf(target)` (from `ledger-kernel/accounts/computed.ts`) to extract one side.

```ts
swap({ ..., residualAccount: { gain: capitalGains, loss: capitalLosses } });
```

### ExchangeAccount

A computed account that scans transactions for remaining `ExchangedUTXO` and `ExchangedUTXI` availability:

- Remaining `ExchangedUTXO` availability → positive raw balance (asset still held at exchange)
- Remaining `ExchangedUTXI` availability → negative raw balance (exchange's reciprocal claim)

Adding this account to the equity tree ensures `ledger.verify()` passes even with open, partially-settled exchanges: each open exchange contributes a matching +/− pair that cancels with the asset-side flows that funded it.

Every exchange is **always scoped** to a real `ExchangeAccount` per side via its `ExchangeTarget`. An `ExchangeAccount` sums an exchange's from-side only when `exchange.fromAccount === this`, and its to-side only when `exchange.toAccount === this`. There is no untagged/universal mode: the type system requires a concrete `ExchangeAccount` (or a `{ from, to }` pair), so an open position can never be silently minted unattributed.

**Single account, both sides** — one account tracks a whole exchange direction:

```ts
const cadToUsdPositions     = equity.addExchangeAccount("Transfers CAD→USD",     Orientation.Positive);
const usdToOrangesPositions = equity.addExchangeAccount("Transfers USD→Oranges", Orientation.Positive);

swap({ ..., exchangeAccount: cadToUsdPositions });     // phase 1 exchange tagged here
swap({ ..., exchangeAccount: usdToOrangesPositions }); // phase 2 exchange tagged here
```

**Split per side** — pass a `{ from, to }` pair to book the given-away and received legs in distinct accounts:

```ts
const transfersOut = equity.addExchangeAccount("Transfers Out", Orientation.Positive);
const transfersIn  = equity.addExchangeAccount("Transfers In",  Orientation.Negative);

swap({ ..., exchangeAccount: { from: transfersOut, to: transfersIn } });
```

Each forward exchange is tagged to exactly one account per side; an `ExchangeAccount` only ever sees the exchange sides that name it, so distinct directions/legs never cross-contaminate.

---

## Ledger Verification

`ledger.verify()` checks that for every position, the sum of all canonical balances across `netAssets` and `equity` equals zero (exactly, in `bigint`). It additionally walks every `Account` lot store (via `AccountFolder.getAccounts()`) and rejects the ledger if any `UTXO`/`UTXI` has been over-consumed (`calculateAvailable() < 0`). Open exchange positions are handled automatically because `ExchangeAccount` is part of the equity tree — no special adjustment is needed.

---

## Related Documents

- [Transaction Primitives](../concepts/transactions.md) — The UTXO/UTXI lots that accounts generate
- [Exchanges](../concepts/exchanges.md) — ExchangedUTXO/UTXI, ResidualUTXI (gain edges), and TerminalUTXO (terminal losses)
- [Disposal Methods](../reference/disposal-methods.md) — How accounts select which lots to consume
