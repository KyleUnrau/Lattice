# Getting Started

## Prerequisites

- Node.js 18+
- npm

## Install and Build

```bash
npm install
npm run build
```

The build compiles TypeScript from `src/` to `dist/` using the configuration in `tsconfig.json`.

## Run the Interactive REPL

```bash
npm start
```

This starts an interactive Node.js REPL with the full ledger state and all named variables from `src/main.ts` available in scope.

## REPL Context

All of the following are available without any prefix:

**Positions:** `cad`, `usd`, `oranges`

**Accounts:** `cash`, `inventory`, `wallet`, `openingBalance`, `exchangeExpense`, `capitalGains`

**Exchange position accounts:** `cadToUsdPositions`, `usdToOrangesPositions`

**Account folders:** `netAssets`, `netWorth`, `assets`, `currentAssets`, `netIncome`, `expenses`

**Infrastructure:** `ledger`, `engine`

**Phase functions:** `phase0()`, `phase1()`, `phase2()`, `phase3()`

**Equity-policy functions:** `swap`, `expense`, `ExchangeResolution`

**Residual routing helpers:** `gainAccountOf`, `lossAccountOf`

**Utilities:** `dump`, `write`, `scale`, `unscale`, `formatQuantity`, `muldiv`

**Constructors:** `Account`, `AccountFolder`, `Ledger`, `Orientation`, `Transaction`, `UTXO`, `UTXI`, `UTXOConsumption`, `Exchange`, `BookValueEngine`

## Basic Session

```
> phase0()      // Opening balance: 1000 CAD into cash
> phase1()      // Exchange 500 CAD → 375 USD (tagged to cadToUsdPositions)
> phase2()      // Exchange 375 USD → 1500 Oranges (tagged to usdToOrangesPositions)
> phase3()      // Sell 1500 Oranges → 600 CAD (closes the CAD→USD→Oranges→CAD loop)

> ledger.verify()
// { ok: true }

> cash.getBalances(ledger.transactions)
// Shows cash account balances per position

> capitalGains.getRootRawBalance(cad, ledger.transactions)
// -10000n  (100.00 CAD gain; negative root balance because rootOrientation = -1)

> cadToUsdPositions.getRootRawBalances(ledger.transactions)
// After phase1 (before phase3): Map { cad => 50000n, usd => -37500n }
// After phase3: empty Map (exchange settled)

> usdToOrangesPositions.getRootRawBalances(ledger.transactions)
// After phase2 (before phase3): Map { usd => 37500n, oranges => -1500n }
// After phase3: empty Map (exchange settled)
```

## Inspecting Basis

```
// After phase3, inspect where some CAD in cash came from
> const utxo = /* some UTXO from cash */
> dump(engine.compute([new UTXOConsumption(someQuantity, utxo)]))
```

`dump(value)` produces a deep-inspected, human-readable string. `write(value)` writes the same to `output.txt`.

## Phase Function Signatures

`phase3` accepts an optional proceeds argument to experiment with different gain/loss scenarios:

```
> phase3(700)   // sell oranges for 700 CAD instead — larger gain
> phase3(450)   // sell for 450 CAD — a loss
```

---

## Related Documents

- [Four-Phase Example](example.md) — What each phase does and why
- [Overview](../concepts/overview.md) — What this project is
- [File Structure](../reference/files.md) — Where everything lives
