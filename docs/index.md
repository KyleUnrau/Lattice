# Ledger Kernel — Documentation

## Concepts

Start here to understand the mental model before reading code.

- [Overview](concepts/overview.md) — What this project is, what problem it solves, and how it differs from conventional accounting systems
- [Positions & Quantities](concepts/positions.md) — The `Position` type, decimal scaling, and why all quantities are stored as `bigint`
- [Transaction Primitives](concepts/transactions.md) — UTXO and UTXI lots, consumptions, the single-position constraint, and the conservation law
- [Exchanges](concepts/exchanges.md) — Cross-position `Exchange` objects, locked rates, recapture, and residual gain/loss lots

## Architecture

How the system is structured and why.

- [Two-Layer Design](architecture/layers.md) — Ledger kernel vs equity-policy: what each layer owns and why they are separate
- [Account System](architecture/accounts.md) — `Account`, `AccountFolder`, orientation propagation, and the computed equity account types
- [Cost Basis Engine](architecture/cost-basis.md) — `BookValueEngine`, the `BasisPath` tree, and how lineage traversal works
- [Unwind Algorithm](architecture/unwind.md) — Loop-mode vs full-mode recapture, the `unwind()` function, and multi-hop settlement
- [Architectural Invariants](architecture/invariants.md) — The hard constraints enforced by the kernel and the policy decisions left to higher layers

## Guides

Practical how-to documentation.

- [Getting Started](guides/getting-started.md) — Install, build, run, and use the interactive REPL
- [Four-Phase Example](guides/example.md) — Step-by-step walkthrough of the CAD → USD → Oranges → CAD loop scenario

## Reference

Lookup material for development.

- [File Structure](reference/files.md) — Annotated source tree with one-line descriptions of every file
- [Disposal Methods](reference/disposal-methods.md) — The `DisposalMethod` interface, the built-in FIFO implementation, and how to add others
