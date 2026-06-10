# Account System

## AccountFolder

`AccountFolder` is an interior node of the account tree. It groups accounts and sub-folders and carries an `Orientation`.

```ts
const netAssets = new AccountFolder("Net Assets", Orientation.Positive);
const netWorth  = new AccountFolder("Net Worth",  Orientation.Negative);
const ledger    = new Ledger(netAssets, netWorth);

const assets        = netAssets.addFolder("Assets",         Orientation.Positive);
const currentAssets = assets.addFolder("Current Assets",    Orientation.Positive);
```

---

## Account

`Account` is a leaf node. It holds per-position `AccountEngine`s and is the only type that generates transaction inputs and outputs.

```ts
const cash = currentAssets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
```

**`generateInputs(position, quantity, transactions)`** — pulls value out of the account. Consumes existing `UTXO` lots using the configured disposal method. If more is requested than available, creates a fresh `UTXI` for the shortfall.

**`generateOutputs(position, quantity, transactions)`** — delivers value into the account. Settles existing `UTXI` obligations. Creates a fresh `UTXO` for any surplus.

The `transactions` parameter is required because lot availability is computed dynamically by scanning history — there is no cached balance state.

---

## Orientation

```ts
enum Orientation { Positive = 1, Negative = -1 }
```

Each node in the account tree has a `localOrientation`. The `rootOrientation` of a node is the product of all its ancestors' orientations, including its own.

```
netAssets (+1) → assets (+1) → currentAssets (+1) → cash (+1)  → rootOrientation = +1
netWorth  (-1) → openingBalance (+1)                            → rootOrientation = -1
netWorth  (-1) → netIncome (+1) → capitalGains (+1)             → rootOrientation = -1
```

The `rawBalance` of an account is `UTXO availability − UTXI availability` — always computed the same way regardless of account type.

The `balance` displayed on a financial statement is `rawBalance × rootOrientation`. This single rule replaces all hardcoded debit/credit semantics.

---

## AccountEngine

Each `Account` maintains a per-position `AccountEngine` created on demand when a new position is first touched. The engine holds the raw `UTXO[]` and `UTXI[]` lists and implements the generation logic using the account's configured disposal methods.

`AccountEngine` is an internal detail — callers interact with `Account.generateInputs()` and `Account.generateOutputs()`.

---

## ComputedAccount

`ComputedAccount` is an abstract base for read-only equity accounts whose balances are derived by scanning transactions rather than by maintaining lots.

Two concrete subtypes:

### ResidualAccount

Owns `ResidualUTXI` (gain) and `ResidualUTXO` (loss) lots. Lots are registered by the equity-policy layer:

```ts
const capitalGains = netIncome.addResidualAccount("Capital Gains (Losses)", Orientation.Positive);

// called by ExchangeResolution / exchange()
residualAccount.addResidualInput(quantity, position, originBasis)  // gain
residualAccount.addResidualOutput(quantity, position, originBasis) // loss
```

Each `ResidualAccount` scans only its own lots for its balance. Multiple residual accounts can coexist (capital gains, FX gains, operating income) without crosstalk.

The `originBasis` argument is a `Map<Position, bigint>` that records the deep-origin composition of the residual, enabling the cost basis engine to trace lineage through residual lots in subsequent transactions.

### ExchangePositionsAccount

A computed account that scans all transactions for remaining `ExchangedUTXO` and `ExchangedUTXI` availability:

- Remaining `ExchangedUTXO` availability → positive raw balance (asset still held at exchange)
- Remaining `ExchangedUTXI` availability → negative raw balance (exchange's reciprocal claim)

```ts
const exchangePositions = netWorth.addExchangeAccount("Net Transfers In (Out)", Orientation.Positive);
```

Adding this account to the equity tree ensures `ledger.verify()` passes even with open, partially-settled exchanges: each open exchange contributes a matching +/− pair that cancels with the asset-side flows that funded it.

---

## Ledger Verification

`ledger.verify()` checks that for every position, the sum of all root balances across `netAssets` and `netWorth` equals zero (exactly, in `bigint`). Open exchange positions are handled automatically because `ExchangePositionsAccount` is part of the equity tree — no special adjustment is needed.

---

## Related Documents

- [Transaction Primitives](../concepts/transactions.md) — The UTXO/UTXI lots that accounts generate
- [Exchanges](../concepts/exchanges.md) — ExchangedUTXO/UTXI and ResidualUTXO/UTXI lot types
- [Disposal Methods](../reference/disposal-methods.md) — How accounts select which lots to consume
