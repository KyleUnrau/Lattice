# Unwind Algorithm

The unwind algorithm decides which exchange edges to recapture when consumed value has prior lineage. It is the core of the equity-policy layer's gain/loss recognition logic.

Entry point: `unwind(basis, stopAt)` in `src/equity-policy/recaptures.ts`.

---

## Two Modes

**Loop mode** (`stopAt` is a `Position`): used when value is being exchanged into a specific target position. Only edges that form a loop back to `stopAt` are recaptured. An intermediate edge is recaptured only proportionally to the looped fraction of its from-side lineage. Edges with no loop below them are left open — they become part of a new forward exchange.

**Full mode** (`stopAt` is `null`): used when value fully leaves the system (expense, total disposal). Every exchange edge in the basis tree is recaptured; the recovered basis bottoms out at the origin-position leaves.

---

## Loop Mode in Detail

Given a basis tree for consumed value, and a target position `stopAt`:

1. Walk each `ExchangePath` recursively.
2. If `exchange.from.position === stopAt`, this edge is the **loop ancestor**: the value loops back to the target. Recapture this edge entirely; record its from-side as recovered basis; stop recursing (its from-side keeps its own deeper provenance).
3. If the edge's from-side lineage contains loops somewhere deeper, recapture this intermediate edge **proportionally** — only the fraction of `qFrom` that participates in a loop, threading the recovered value to the loop ancestor below.
4. If no loop exists below an edge, leave it open. It becomes part of a forward exchange, preserving the cost basis chain without realizing anything.

`loopedSurfaceQuantity` — the portion of the surface-position consumption that ultimately participated in a loop — is returned as the proration weight for splitting proceeds between the recaptured and forward portions.

---

## UnwindPlan

`unwind()` returns:

```ts
interface UnwindPlan {
    recaptures: Map<Exchange, { toQuantity: bigint; fromQuantity: bigint }>;
    recovered: Map<Position, bigint>;          // basis amounts recovered at recovery points
    loopedSurfaceQuantity: bigint;             // surface quantity that looped (proration weight)
    residualCarryBacks: ResidualCarryBack[];   // loop mode: residuals whose origin == target
    residualNodes: ResidualPath[];             // full mode: every residual, settled to origin
}
```

- **`recaptures`** — one entry per distinct `Exchange` instance, with summed to-side and from-side quantities across all branches. Even when the same exchange appears in multiple basis paths (because the consumed UTXOs each carry a fraction of it), it is recaptured exactly once.
- **`recovered`** — the terminal-position basis recovered from closed loops: for loop mode this is the from-side basis of the loop ancestors; for full mode this is the origin-position leaves.
- **`residualCarryBacks`** — *loop mode only*. A residual is a **directional suspended edge** from its origin position(s) to its surface. Only directly-held residuals whose origin basis includes `stopAt` are surfaced here: moving such value back toward its origin carries it back (settle the surface leg, re-recognize at origin). Residual slivers whose origin is **not** the target are deliberately absent — they flow through the forward exchange, so a residual never leaks "upward" into an unrelated position.
- **`residualNodes`** — *full mode only* (`stopAt === null`). Every `ResidualPath` in the consumed lineage; `ExpenseResolution` settles each to its origin.

---

## Multi-Hop Loops

When the loop path crosses intermediate positions (e.g. CAD → USD → Oranges → CAD, where CAD is `stopAt`), `ExchangeResolution.getIntermediateTransactions()` generates a single-position transaction for each intermediate position in the recapture chain:

- Inputs: reclaim the inner edge's from-side (a `UTXOConsumption`)
- Outputs: settle the next edge's to-side (a `UTXIConsumption`)

These transactions net to zero for every intermediate position, ensuring `ledger.verify()` still passes.

---

## Residual-Derived Value

A residual is a **directional suspended edge** from its origin position(s) to its current surface
position. When consumed inputs include value that originated from a prior `ResidualUTXI` (a
recognized gain later deposited into an account and now being spent), direction matters:

- **Carry-back** (`stopAt` ∈ the residual's origin basis): the value is moving back toward its
  origin. In loop mode, `unwind` surfaces these as `residualCarryBacks`, and `ExchangeResolution`
  settles each — consuming the residual leg (`residual.consume(...)` → a `UTXIConsumption` in the
  surface transaction's outputs) and re-recognizing the deferred equity in the target (origin)
  position, proportional to the proceeds attributable to that sliver. This is what `INV5`
  exercises (residual-derived CAD converted back into its BTC origin).

- **Forward** (`stopAt` ∉ the residual's origin basis): the value is moving into an unrelated
  position. The residual is **not** settled — it flows through the forward exchange like any other
  un-looped value, carrying its lineage onward and leaving the residual edge unresolved. The
  deferred gain/loss stays at its origin and must not leak "upward" into the destination. This is
  what `INV5b` guards (the original `event3` bug).

> **Follow-up.** The carry-back currently re-recognizes the deferred equity as the full proceeds
> attributable to the sliver (correct at unit rates; see the `INV5` `TODO(residual-settlement)`).
> Precisely netting proceeds against the inherited origin basis — and treating realized/terminal
> **losses** through the shared expense machinery at origin — requires residuals to retain real
> suspended-edge basis, and is part of the terminal-resolution generalization.

---

## Helper Functions

| Function | File | Exported | Purpose |
|---|---|---|---|
| `unwind(basis, stopAt)` | `recaptures.ts` | Yes | Main entry point; returns `UnwindPlan` |
| `executeRecaptures(plan, transactions)` | `recaptures.ts` | Yes | Issues one `Recapture` per exchange in plan |
| `classifyRecaptures(recaptures, surface)` | `recaptures.ts` | Yes | Partitions recaptures into surface settlements, hops, and terminal reclaims |
| `collectOriginLeaves(basis)` | `book-value/lineage.ts` | Yes | Reduces a basis tree to its terminal origin-position composition |
| `collectChainEdges(basis, stopAt)` | `book-value/lineage.ts` | No (internal) | Recursive edge collector; loop vs full mode |
| `groupRecapturesByExchange(edges)` | `book-value/lineage.ts` | No (internal) | Aggregates `RecaptureEdge[]` by exchange instance |
| `collectCarryBacks(basis, target)` | `book-value/lineage.ts` | Yes | Selects directly-held residual slivers whose origin == `target` (carry-backs) |
| `collectResidualNodes(basis)` | `book-value/lineage.ts` | No (internal) | Finds all `ResidualPath` leaves in a basis tree (full-mode settlement) |

---

## Related Documents

- [Cost Basis Engine](cost-basis.md) — How the `BasisPath` tree is built
- [Exchanges](../concepts/exchanges.md) — Exchange, recapture, residual lots
- [Four-Phase Example](../guides/example.md) — Concrete walkthrough of loop detection and recapture
