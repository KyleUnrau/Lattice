# Disposal Methods

A disposal method selects which existing lots to consume when a given quantity is requested from an account. It is the mechanism through which lot-level cost basis policies (FIFO, LIFO, specific identification) are applied.

---

## Type Signature

```ts
// src/ledger-kernel/disposal-methods/disposals.ts

type DisposalMethod<T extends UTXO | UTXI> =
    (components: T[], quantity: bigint, transactions: Transaction[]) => Map<T, bigint>;
```

- **`components`** — the lot list held by the account engine for this position
- **`quantity`** — the total amount to consume (in smallest-unit `bigint`)
- **`transactions`** — the full transaction history; required because lot availability is computed dynamically

The return value is a `Map` from lot to consumed quantity. The sum of all values must equal `quantity`.

---

## Built-In: FIFO

```ts
// src/ledger-kernel/disposal-methods/basic-fifo.ts

fifo<UTXO>   // for generateInputs (consuming UTXOs)
fifo<UTXI>   // for generateOutputs (settling UTXIs)
```

FIFO selects the oldest lots first (in insertion order), consuming each to its available balance before moving to the next. It is the default in all example accounts.

Usage:

```ts
import { fifo } from "./ledger-kernel/disposal-methods/basic-fifo.js";

const cash = currentAssets.addAccount("Cash", Orientation.Positive, fifo<UTXO>, fifo<UTXI>);
//                                                                   ^^^^^^^^^^  ^^^^^^^^^^
//                                    UTXO disposal method          UTXI disposal method
```

---

## Adding a New Disposal Method

Implement the `DisposalMethod<T>` signature. The simplest structure:

```ts
function myMethod<T extends UTXO | UTXI>(
    components: T[],
    quantity: bigint,
    transactions: Transaction[]
): Map<T, bigint> {
    const result = new Map<T, bigint>();
    let remaining = quantity;

    for (const lot of components /* in your chosen order */) {
        if (remaining <= 0n) break;
        const available = lot.calculateAvailable(transactions);
        if (available <= 0n) continue;
        const take = available < remaining ? available : remaining;
        result.set(lot, take);
        remaining -= take;
    }

    return result;
}
```

Pass it as the third or fourth argument to `addAccount`:

```ts
const account = folder.addAccount("Name", Orientation.Positive, myMethod<UTXO>, myMethod<UTXI>);
```

Different methods can be used for UTXO and UTXI disposal independently.

---

## Policy Note

The disposal method is a policy decision, not a structural invariant. Changing the method changes *which* lots are consumed (and therefore the cost basis chain for each transaction), but never violates conservation — the kernel ensures the total consumed always equals the requested quantity.

---

## Related Documents

- [Transaction Primitives](../concepts/transactions.md) — UTXO/UTXI lots and how availability is computed
- [Account System](../architecture/accounts.md) — How accounts use disposal methods
- [Architectural Invariants](../architecture/invariants.md) — What is policy vs what is invariant
