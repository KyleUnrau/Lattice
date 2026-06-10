# Transaction Primitives

## The Conservation Law

Every `Transaction` enforces:

```
sum(inputs) === sum(outputs)   (in the same position, as bigint)
```

This is checked at construction time. A transaction that does not balance throws immediately — imbalance cannot exist at rest in the ledger.

Additionally, every input and output in a single transaction must belong to the **same position**. Cross-position movement requires an `Exchange`; see [Exchanges](exchanges.md).

---

## Lot Types

The system is built on two consumable lot types:

| Type | Role | Appears in |
|---|---|---|
| `UTXO` | An unspent transaction **output** — produced value stored in an account | `tx.outputs` |
| `UTXI` | An unspent transaction **input** — a balancing inflow or unsettled obligation | `tx.inputs` |

"Unspent" distinguishes the standing lot from the reference that appears inside a later transaction when the lot is partially or fully consumed.

Both lot types support **partial consumption**: a lot can be consumed across multiple transactions in portions, and its remaining availability is computed dynamically by scanning the full transaction history.

---

## Inputs

```ts
type Input = UTXI | UTXOConsumption
```

**`UTXI`** — value entering the system without consuming a prior output. Used for:
- Opening balances
- Equity injections
- The "to" side of an exchange receipt (via `ExchangedUTXI`)

**`UTXOConsumption`** — a reference to a prior `UTXO`, consuming up to its remaining availability. Represents spending an existing lot.

---

## Outputs

```ts
type Output = UTXO | UTXIConsumption
```

**`UTXO`** — value produced by a transaction and stored in an account. The canonical "value at rest" unit.

**`UTXIConsumption`** — settles part of a prior `UTXI` obligation. Represents delivering value that was owed.

---

## How Availability Works

Availability is not stored in the lot itself. Instead:

```
available(lot) = lot.quantity − sum of all consumptions referencing this lot
```

`UTXO.calculateAvailable(transactions)` and `UTXI.calculateAvailable(transactions)` scan the full transaction list to compute this on demand. This means the transaction graph is the single source of truth — there is no separate balance state to keep synchronized.

---

## Transaction Construction

Transactions are constructed through `Ledger.newTransaction(inputs, outputs)`. The ledger:

1. Verifies all inputs and outputs share one position
2. Verifies `sum(inputs) === sum(outputs)`
3. Appends the transaction to its ordered history

```ts
// example: credit 1000 CAD opening balance into cash
const inputs  = openingBalance.generateInputs(cad, 1000, ledger.transactions);
const outputs = cash.generateOutputs(cad, 1000, ledger.transactions);
ledger.newTransaction(inputs, outputs);
```

`generateInputs` pulls from the account by consuming existing `UTXO` lots. If more is requested than available, it creates a fresh `UTXI` for the shortfall.

`generateOutputs` delivers into the account by settling existing `UTXI` obligations. If more is delivered than owed, it creates a fresh `UTXO` for the surplus.

---

## Exchange Subtypes

For cross-position movement, the system extends these primitives with exchange-tagged variants. See [Exchanges](exchanges.md) for the full picture.

| Subtype | Extends | Meaning |
|---|---|---|
| `ExchangedUTXO` | `UTXO` | From-side of an exchange; value given away |
| `ExchangedUTXI` | `UTXI` | To-side of an exchange; value received |
| `ResidualUTXO` | `UTXO` | A recognized loss relative to recovered cost basis |
| `ResidualUTXI` | `UTXI` | A recognized gain relative to recovered cost basis |

---

## Related Documents

- [Positions & Quantities](positions.md) — How quantities are scaled and stored as bigint
- [Exchanges](exchanges.md) — The Exchange object, recapture, and residual lots
- [Account System](../architecture/accounts.md) — How accounts generate inputs and outputs
