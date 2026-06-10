# Overview

Ledger Kernel is a graph-oriented accounting system designed for tracking financial state across multiple independent positions — currencies, commodities, crypto assets, or any measurable quantity — with full provenance tracing through chains of exchanges.

It sits in a design space between three existing approaches:

| System | Strength | Limitation |
|---|---|---|
| Traditional double-entry | Simple, universal | Collapses multi-position history into one reporting currency; no cost basis |
| UTXO ledger (e.g. Bitcoin) | Consumable lots, natural audit trail | No cross-asset tracking; no cost basis engine |
| Cost-basis engines | Tracks acquisition cost | Typically bolted onto existing records; not a first-class accounting model |

Ledger Kernel takes the best of all three: it enforces double-entry conservation at every transaction, models value as consumable lots with natural lineage, and tracks cross-position exchange rates so that cost basis is a structural property of the transaction graph rather than metadata.

---

## The Core Problem

When value moves through a chain of exchanges — say, CAD → USD → Oranges → CAD — traditional accounting must answer:

1. When the loop closes, what was the original cost?
2. What is the realized gain or loss?
3. Which portion of the basis is still deferred vs recognized?

These questions are difficult when cost basis is stored as annotations on records. They become natural when cost basis is a *structural property* of the transaction graph itself: every exchange captures a locked rate, every recapture unwinds at that locked rate, and every residual (gain/loss) carries the deep-origin basis of the value it represents.

---

## Key Design Commitments

**Positions are first-class.** Every quantity lives in exactly one position. Cross-position movement requires an explicit `Exchange` object — there is no implicit unit conversion.

**Single-position transactions.** Each `Transaction` is constrained to one position. Multi-position events are modeled as a pair (or chain) of single-position transactions linked by an `Exchange`.

**All balances are derived.** There are no mutable balance tables. Every balance is computed by scanning the full transaction history. This makes the transaction graph the single source of truth.

**Conservation is enforced structurally.** `Transaction` construction throws if `sum(inputs) ≠ sum(outputs)`. Imbalance cannot exist at rest.

**Orientation replaces debit/credit.** The account tree propagates a multiplicative orientation (`+1` or `−1`) from root to leaf. The signed balance of any account is `rawBalance × rootOrientation`. There are no hardcoded debit/credit labels.

**Kernel enforces structure; policy enforces meaning.** The ledger kernel holds structural invariants. The equity-policy layer (swap, expense, recapture) holds business logic. Neither layer reaches into the other's domain.

---

## What This System Is Not

It is not a general-purpose accounting package or ERP. It has no chart-of-accounts templates, reporting formats, currency conversion tables, or persistence layer. It is an accounting *kernel* — a foundation that enforces the structural rules while leaving policy decisions to the layers above it.

---

## Related Documents

- [Transaction Primitives](transactions.md) — UTXO/UTXI, the conservation model, consumable lots
- [Exchanges](exchanges.md) — Cross-position exchange objects and locked-rate recapture
- [Two-Layer Design](../architecture/layers.md) — How kernel and equity-policy relate
- [Four-Phase Example](../guides/example.md) — A concrete walkthrough of the CAD → USD → Oranges → CAD loop
