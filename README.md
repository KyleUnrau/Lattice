# Lattice — Accounting Software

A graph-oriented accounting system for modeling deterministic financial state, transaction lineage, position flows, cost basis, and exchange relationships across multiple independent positions.

The system enforces double-entry conservation at every transaction, models value as consumable lots with natural lineage, and tracks cross-position exchange rates so that cost basis is a structural property of the transaction graph — not metadata stored alongside it.

> **Status:** Active development. Core kernel and equity-policy layer are functional. The example scenario (CAD → USD → Oranges → CAD loop with gain recognition) runs end-to-end and passes ledger verification.

---

## Quick Start

```bash
npm install
npm run explore
```

`npm run explore` compiles and starts the web-based transaction explorer at `http://localhost:4000`. See [Getting Started](docs/guides/getting-started.md) for the debug REPL and other options.

---

## Documentation

- **[Documentation Index](docs/index.md)** — Full table of contents

**Concepts** (start here)
- [Overview](docs/concepts/overview.md) — What this is and how it differs from conventional accounting systems
- [Transaction Primitives](docs/concepts/transactions.md) — UTXO/UTXI lots, the conservation law, consumable lot model
- [Exchanges](docs/concepts/exchanges.md) — Cross-position exchange objects, locked rates, recapture, and residuals
- [Positions & Quantities](docs/concepts/positions.md) — The `Position` type and bigint scaling

**Architecture**
- [Two-Layer Design](docs/architecture/layers.md) — Kernel vs equity-policy separation
- [Account System](docs/architecture/accounts.md) — Account hierarchy, orientation, computed equity accounts
- [Cost Basis Engine](docs/architecture/cost-basis.md) — `BookValueEngine` and basis path traversal
- [Unwind Algorithm](docs/architecture/unwind.md) — Loop-mode vs full-mode recapture

**Guides**
- [Getting Started](docs/guides/getting-started.md) — Install, build, REPL usage
- [Four-Phase Example](docs/guides/example.md) — Step-by-step walkthrough of the CAD → USD → Oranges → CAD scenario

**Reference**
- [File Structure](docs/reference/files.md) — Annotated source tree
- [Disposal Methods](docs/reference/disposal-methods.md) — FIFO and how to add alternatives

---

## Core Ideas

**Positions are first-class.** Every quantity lives in exactly one position. Cross-position movement requires an explicit `Exchange` — no implicit unit conversion.

**Double-entry without debit/credit labels.** Conservation (`sum(inputs) === sum(outputs)`) is enforced at transaction construction time. Polarity emerges from the multiplicative orientation of the account tree, not hardcoded keywords.

**All balances are derived.** There are no mutable balance tables. Every balance is re-computed from the full transaction history on demand.

**Cost basis is structural.** The locked rate of an `Exchange` is immutable. Recapturing an exchange always uses the original rate. Gains and losses are the difference between actual proceeds and recovered locked-rate cost basis.

---

## License

Source-available, all rights reserved unless explicitly granted.

You may view, study, and experiment with the code for personal and educational purposes. You may not redistribute, sublicense, use commercially, create derivatives for distribution, or rehost publicly without permission.

Contact the author for collaboration, research, or licensing inquiries.
