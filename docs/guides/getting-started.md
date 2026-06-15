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

## Transaction Explorer

```bash
npm run explore
```

Compiles and starts the web-based transaction explorer at `http://localhost:4000`. The explorer loads the scenario defined in `src/scenario.ts`, then serves a single-page UI and a small read-only JSON API (`/api/state`, `/api/tx/:n`, `/api/lot/:id`, `/api/exchange/:id`). Every endpoint accepts an `upTo` query parameter so balances, availability, and basis reflect the ledger state after the first `upTo` transactions.

## Debug REPL

```bash
npm run debug
```

Starts a Node.js process with `--inspect` that runs an interactive REPL via `src/debug.ts`. All of the following are available without any prefix:

**Scenario:** `ledger`, `engine`, `positions`, `accounts`, `phases`, `buildSampleLedger`

**Equity-policy classes:** `ExchangeResolution`, `ExpenseResolution`

**Equity-policy functions:** `unwind`

**Kernel constructors:** `Account`, `AccountFolder`, `Ledger`, `Orientation`, `Transaction`, `Exchange`, `BookValueEngine`

**Utilities:** `fifo`, `scale`, `unscale`, `clear`

## Basic REPL Session

```
> buildSampleLedger()    // Runs the scenario and returns a LedgerView
> ledger.verify()
// { ok: true }
```

## Running Tests

```bash
npm test
```

Compiles and runs the full test suite under `src/tests/`. Tests are written using Node's built-in `node:test` runner.

---

## Related Documents

- [Four-Phase Example](example.md) — What each phase does and why
- [Overview](../concepts/overview.md) — What this project is
- [File Structure](../reference/files.md) — Where everything lives
