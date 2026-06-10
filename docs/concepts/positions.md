# Positions & Quantities

## The Position Type

A `Position` is any tracked, measurable quantity — a currency, commodity, crypto asset, or abstract unit.

```ts
interface Position {
    name: string;     // display label, e.g. "Canadian Dollars"
    decimals: number; // scale factor: number of decimal places in the human-readable unit
}
```

Examples:

```ts
const cad:     Position = { name: "Canadian Dollars",       decimals: 2 }; // cents
const usd:     Position = { name: "United States Dollars",  decimals: 2 }; // cents
const oranges: Position = { name: "Oranges",                decimals: 0 }; // whole units
```

Positions are plain objects with no methods. They serve as identity keys — the same position instance is referenced by every lot and transaction that touches that asset.

---

## Why Bigint

All internal quantities are stored and computed as `bigint` in the smallest tradable unit (cents for CAD, satoshis for BTC, whole units for integers). This guarantees:

- No floating-point rounding errors accumulate over long chains of transactions
- `sum(inputs) === sum(outputs)` can be checked exactly
- Proportional allocations (e.g. "what fraction of these proceeds corresponds to this lot?") use integer multiply-then-divide via `muldiv(a, b, c)` rather than floating-point arithmetic

Human-readable values (e.g. the `500` in "500 CAD") are converted to and from the internal representation at the boundary — when calling `generateInputs()`/`generateOutputs()` and when displaying output.

---

## Scaling Utilities

```ts
// src/ledger-kernel/positions.ts

scale(position, humanValue): bigint
// Converts a human-readable number to the smallest unit.
// scale(cad, 500)     → 50000n  (500 dollars → 50,000 cents)
// scale(oranges, 10)  → 10n

unscale(position, rawValue): number
// Converts a smallest-unit bigint back to a human-readable number.
// unscale(cad, 50000n) → 500

formatQuantity(position, rawValue): string
// Formats a smallest-unit bigint as a display string with correct decimal places.
// formatQuantity(cad, 50025n) → "500.25"
```

These functions are used at the REPL boundary and in the example's output helpers. Inside the kernel and equity-policy, all arithmetic operates directly on `bigint` values.

---

## muldiv

Integer proportional math uses `muldiv(a, b, c)` (`a * b / c` in `bigint`):

```ts
muldiv(proceeds, lotQuantity, totalQuantity)
// Distributes `proceeds` proportionally to `lotQuantity / totalQuantity`,
// computed exactly in bigint without intermediate floating-point.
```

This avoids the "multiply floats then truncate" error that compounds across lot chains.

---

## Related Documents

- [Transaction Primitives](transactions.md) — How positions appear in UTXO/UTXI lots
- [Exchanges](exchanges.md) — How locked exchange rates relate from-position quantities to to-position quantities
