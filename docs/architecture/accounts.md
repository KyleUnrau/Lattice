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

### ResidualAccount

Owns `ResidualUTXI` (gain) and `ResidualUTXO` (loss) lots. Lots are registered by the equity-policy layer:

```ts
// called by ExchangeResolution / swap() / expense()
residualAccount.addResidualInput(quantity, position, originBasis)  // gain
residualAccount.addResidualOutput(quantity, position, originBasis) // loss
```

Each `ResidualAccount` scans only its own lots for its balance. Multiple residual accounts can coexist (capital gains, FX gains, operating income) without crosstalk.

The `originBasis` argument is a `Map<Position, bigint>` that records the deep-origin composition of the residual, enabling the cost basis engine to trace lineage through residual lots in subsequent transactions.

Every minted lot also carries a back-reference to the `ResidualAccount` that created it (`ResidualUTXI.account` / `ResidualUTXO.account`). This lets a later settlement re-recognize a residual's deferred equity in the **same** account that originally deferred it — when residual-derived value is expensed or re-exchanged, the closed leg's equity shifts position within its own account rather than being routed to an externally supplied one. Because of this, `expense()` needs no residual-target argument at all.

**Dual-name display** — an optional `negativeLabel` parameter causes `summarize()` to return an alternate name when the per-position balance is negative, allowing a single account to display as "Capital Gains" when net-positive and "Capital Losses" when net-negative:

```ts
// Single account, name adapts to the balance sign
const capitalGains = netIncome.addResidualAccount("Capital Gains", Orientation.Positive, "Capital Losses");
```

**Split gain/loss routing** — the `ResidualTarget` union type accepted by `swap()` and `ExchangeResolution` (for the *new* gain/loss they recognize against proceeds; settlements of pre-existing residuals self-route to their own account) allows gains and losses to be routed to separate accounts:

```ts
// Two accounts, each receives only one direction
const capitalGains  = netIncome.addResidualAccount("Capital Gains",  Orientation.Positive);
const capitalLosses = netIncome.addResidualAccount("Capital Losses", Orientation.Negative);

swap({ ..., residualAccount: { gain: capitalGains, loss: capitalLosses } });
```

Use `gainAccountOf(target)` and `lossAccountOf(target)` (exported from `ledger-kernel/accounts/computed.ts`) when you need to extract one account from a `ResidualTarget` in custom policy code.

### ExchangeAccount

A computed account that scans transactions for remaining `ExchangedUTXO` and `ExchangedUTXI` availability:

- Remaining `ExchangedUTXO` availability → positive raw balance (asset still held at exchange)
- Remaining `ExchangedUTXI` availability → negative raw balance (exchange's reciprocal claim)

Adding this account to the equity tree ensures `ledger.verify()` passes even with open, partially-settled exchanges: each open exchange contributes a matching +/− pair that cancels with the asset-side flows that funded it.

**Universal mode** (default) — one account covering all exchanges with no explicit scoping assignment:

```ts
const exchangePositions = equity.addExchangeAccount("Net Transfers In (Out)", Orientation.Positive);
// All swaps/ExchangeResolutions that don't pass exchangeAccount appear here
```

**Scoped mode** — multiple accounts, each tracking a specific exchange direction by passing the account to `swap()` or `ExchangeResolution`. Each forward exchange is tagged to exactly one account; exchanges tagged to a different account are excluded.

```ts
const cadToUsdPositions    = equity.addExchangeAccount("Transfers CAD→USD",    Orientation.Positive);
const usdToOrangesPositions = equity.addExchangeAccount("Transfers USD→Oranges", Orientation.Positive);

swap({ ..., exchangeAccount: cadToUsdPositions });    // phase 1 exchange tagged here
swap({ ..., exchangeAccount: usdToOrangesPositions }); // phase 2 exchange tagged here
```

When using scoped accounts, every forward exchange should be explicitly tagged to exactly one account. Untagged exchanges (those created by `swap()` or `ExchangeResolution` without an `exchangeAccount`) appear in all accounts that are in universal mode (i.e., have never been used as a tag). Mixing tagged and untagged exchanges on the same ledger is allowed but requires care: the universal account will capture everything untagged, while scoped accounts capture only their own.

---

## Ledger Verification

`ledger.verify()` checks that for every position, the sum of all canonical balances across `netAssets` and `equity` equals zero (exactly, in `bigint`). It additionally walks every `Account` lot store (via `AccountFolder.getAccounts()`) and rejects the ledger if any `UTXO`/`UTXI` has been over-consumed (`calculateAvailable() < 0`). Open exchange positions are handled automatically because `ExchangeAccount` is part of the equity tree — no special adjustment is needed.

---

## Related Documents

- [Transaction Primitives](../concepts/transactions.md) — The UTXO/UTXI lots that accounts generate
- [Exchanges](../concepts/exchanges.md) — ExchangedUTXO/UTXI and ResidualUTXO/UTXI lot types
- [Disposal Methods](../reference/disposal-methods.md) — How accounts select which lots to consume
