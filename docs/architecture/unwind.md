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
    residualNodes: ResidualPath[];             // residual-derived value among the consumed inputs
}
```

- **`recaptures`** — one entry per distinct `Exchange` instance, with summed to-side and from-side quantities across all branches. Even when the same exchange appears in multiple basis paths (because the consumed UTXOs each carry a fraction of it), it is recaptured exactly once.
- **`recovered`** — the terminal-position basis recovered from closed loops: for loop mode this is the from-side basis of the loop ancestors; for full mode this is the origin-position leaves.
- **`residualNodes`** — `ResidualPath` nodes among the consumed lineage; settled separately by `ExchangeResolution` (the residual lot is consumed and a new gain minted in the target position).

---

## Multi-Hop Loops

When the loop path crosses intermediate positions (e.g. CAD → USD → Oranges → CAD, where CAD is `stopAt`), `ExchangeResolution.getIntermediateTransactions()` generates a single-position transaction for each intermediate position in the recapture chain:

- Inputs: reclaim the inner edge's from-side (a `UTXOConsumption`)
- Outputs: settle the next edge's to-side (a `UTXIConsumption`)

These transactions net to zero for every intermediate position, ensuring `ledger.verify()` still passes.

---

## Residual-Derived Value

When consumed inputs include value that originated from a prior `ResidualUTXI` (a recognized gain that was subsequently deposited into an account and is now being spent), the unwind algorithm surfaces those as `ResidualPath` nodes in `UnwindPlan.residualNodes`.

`ExchangeResolution` handles these by:
1. Consuming each residual lot (`residual.consume(...)` → a `UTXIConsumption` in the surface transaction's outputs)
2. Minting a new `ResidualUTXI` gain in the target position, proportional to the actual proceeds attributable to that residual lot

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
| `collectResidualNodes(basis)` | `book-value/lineage.ts` | No (internal) | Finds all `ResidualPath` leaves in a basis tree |

---

## Related Documents

- [Cost Basis Engine](cost-basis.md) — How the `BasisPath` tree is built
- [Exchanges](../concepts/exchanges.md) — Exchange, recapture, residual lots
- [Four-Phase Example](../guides/example.md) — Concrete walkthrough of loop detection and recapture
