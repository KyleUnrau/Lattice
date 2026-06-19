# Exchanges

## What an Exchange Is

An `Exchange` links two single-position transactions at a **locked conversion rate**. Once created, the rate is immutable.

```ts
// Exchange(from, to) where each side is { quantity: bigint, position: Position }
const ex = new Exchange(
    { quantity: 50000n, position: cad },  // from: 500.00 CAD
    { quantity: 37500n, position: usd }   // to:   375.00 USD
);

ex.from  // ExchangedUTXO: the "given-away" lot; goes in the CAD transaction's outputs
ex.to    // ExchangedUTXI: the "received" lot;   goes in the USD transaction's inputs
```

The locked rate is always `from.quantity / to.quantity` — the ratio at the time of the exchange.

---

## Transaction Pair Pattern

Because every transaction is single-position, an exchange always spans exactly two transactions:

```ts
// CAD transaction: source account gives away 500 CAD
ledger.newTransaction(
    cadAccount.generateInputs(cad, 500, ledger.transactions),
    [ex.from]   // ExchangedUTXO output
);

// USD transaction: destination account receives 375 USD
ledger.newTransaction(
    [ex.to],    // ExchangedUTXI input
    usdAccount.generateOutputs(usd, 375, ledger.transactions)
);
```

In practice, `ExchangeResolution` constructs these transaction pairs automatically — you rarely build them by hand.

---

## Recapture

When value later moves back toward the origin position (or out of the system entirely), the exchange can be **recaptured** at its original locked rate:

```ts
const recapture = ex.recapture(toSideQuantity, transactions);
// recapture.settlement  UTXIConsumption — settles part of ex.to;   goes in outputs
// recapture.reclaim     UTXOConsumption — reclaims part of ex.from; goes in inputs
```

Recapture is the mechanism through which:
- Deferred cost basis becomes realized
- Gain/loss can be measured against the locked rate
- Multi-hop chains are unwound in dependency order

---

## Residuals — gains are suspended edges, losses are terminal

When a recaptured loop shows a difference between the locked-rate cost basis and the actual proceeds, gains and losses are recognized **asymmetrically**:

| Outcome | Representation | Placed in |
|---|---|---|
| **Gain** (proceeds > basis) | `ResidualUTXI` — a *directional suspended residual edge* | Receiving transaction inputs |
| **Loss** (proceeds < basis) | `TerminalUTXO` — a *terminal settlement record* at the cost-basis origin | A `TerminalAccount` sink (origin position) |

A gain (`ResidualUTXI`) carries an **`originBasis`** (`Map<Position, bigint>`) recording the deep-origin composition it traces back to, and is held in a `ResidualAccount`. It is a *suspended edge*, not movable inventory: when re-exchanged, direction decides its fate (see [Unwind → Residual-Derived Value](../architecture/unwind.md)):

- toward one of its origins (`target` ∈ `originBasis`) → **carried back**: the surface leg is closed and the deferred residual re-recognized at the origin using its residual-basis, plus an incremental gain (or a terminal loss if it shrank) for `proceeds − basisAmount`. The origin receives the actual proceeds once — the split only classifies that value. This also resolves a **nested** carry-back, where the residual moved forward (e.g. CAD→USD) before returning toward origin: the enclosing forward edges are recaptured for the residual's portion to rewind the value to the residual's surface, where the leg closes.
- into any other position → **flows forward** as ordinary value, leaving the residual unresolved. The deferred gain never leaks "upward" into the destination.

A **loss is terminal**: it represents unrecovered origin basis. It is resolved on the loop's role-pure target reclaims — the reclaims are split into the proceeds-backing portion and the shortfall, and the shortfall is full-unwound to its cost-basis origin (via {@link ExpenseResolution} into the loss `TerminalAccount`) — never minted as a movable destination lot. Resolving the loss on the reclaims (not by carving the consumed surface) keeps any carry-back/forward surface intact even when one consumed lot blends loop capital with residual-derived value. A `TerminalUTXO` is output-shaped (so it balances its transaction and is summed for reporting) but is structurally non-consumable: a `TerminalAccount` has no `generateInputs`, holds no `PositionLotStore`, and `TerminalUTXO.consume()` throws.

---

## Two Layers: Primitives and Resolution

The exchange system is split into two layers. Use the highest one that fits; drop down when you need more control.

| Layer | What it is | Where | Owns transactions? |
|---|---|---|---|
| **Exchange primitives** | `Exchange`, `ExchangedUTXO/UTXI`, `ResidualUTXO/UTXI`, `Exchange.recapture` — the kernel-level locked-rate links and their consumption. | `ledger-kernel/transactions/cross-position.ts` | No — they are lines you place into transactions. |
| **Exchange resolution** | `ExchangeResolution` — given the consumed `fromInputs` and the pre-generated `toOutputs`, computes every line (recaptures, forward exchange, gain/loss residuals, residual-node settlements) and exposes them via `getFromOutputs()`, `getToInputs()`, `getToOutputs()`, and `constructIntermediateTransactions()`. | `equity-policy/exchange.ts` | No — the caller assembles and commits all transactions. |

---

## Using ExchangeResolution

`ExchangeResolution` is the primary entry point for recording an exchange. Pre-generate both sides of the exchange, construct the resolution, then assemble the transactions from the lines it returns.

```ts
// Pre-generate outputs for the receiving side, then pass them in.
const fromInputs = cadAccount.generateInputs(cad, 500, ledger.transactions);
const toOutputs  = usdAccount.generateOutputs(usd, 375, ledger.transactions);

const res = new ExchangeResolution(
    fromInputs,
    toOutputs,
    ledger.transactions,
    engine,
    residualAccount,       // ResidualTarget: where to recognize gains/losses
    cadToUsdPositions      // ExchangeAccount: required; tracks the open position
);

// Commit in dependency order: consuming → intermediate hops → receiving
ledger.newTransaction(fromInputs, res.getFromOutputs());
for (const tx of res.constructIntermediateTransactions()) ledger.addTransaction(tx);
ledger.newTransaction(res.getToInputs(), res.getToOutputs());
```

**`getFromOutputs()`** — outputs for the consuming/surface transaction: surface-position recapture settlements, the forward exchange from-side, and closed residual legs.

**`getToInputs()`** — inputs for the receiving/target transaction: target-position recapture reclaims, forward exchange to-side, gain residual, and settled-residual mints.

**`getToOutputs()`** — outputs for the receiving/target transaction: the `toOutputs` passed to the constructor plus any loss residual (when proceeds fall short of recovered basis).

**`constructIntermediateTransactions()`** — returns a `Transaction[]` for each intermediate position crossed by a multi-hop loop unwind. Commit these between the consuming and receiving transactions.

**`constructFromTransaction(additionalNodes?)`** — convenience builder: constructs the consuming transaction from `fromInputs` and `getFromOutputs()`, optionally appending extra inputs/outputs (only when they form a uniform blend — see composition rules below).

**`constructToTransaction(additionalNodes?)`** — convenience builder: constructs the receiving transaction from `getToInputs()` and `getToOutputs()`, optionally appending extra inputs/outputs.

**`residualAccount`** accepts either a single `ResidualAccount` (gains and losses share it) or `{ gain: ResidualAccount, loss: ResidualAccount }` to route them to separate accounts. `gainAccountOf(target)` and `lossAccountOf(target)` (exported from `ledger-kernel/accounts/computed.ts`) extract one side from a `ResidualTarget` when needed.

**`exchangeAccount`** scopes the forward exchange to a specific `ExchangeAccount`'s open-position view. It is **always required** — supply one even when the exchange fully closes a loop and no forward leg opens (the account will simply carry a zero balance). This keeps the type consistent and avoids silently minting an untagged, unscoped open position.

---

## Partial and Mixed Exchanges

`ExchangeResolution` resolves **the exchanged portion only**. Two guarantees follow by construction:

- Its from-side outputs sum to exactly `sum(fromInputs)`, and its to-side inputs balance exactly against the proceeds in `toOutputs`. Every exchange/recapture/residual line links **only** the exchanged value.
- Everything else in the event is yours to build. Non-exchanged value simply lives in other transactions.

```ts
// Exchange 400 of a 500 CAD draw into 300 USD; withdraw the other 100 CAD to a drawer account.
const exchangedInputs = cash.generateInputs(cad, 400, ledger.transactions);
const toOutputs = cash.generateOutputs(usd, 300, ledger.transactions);
const res = new ExchangeResolution(exchangedInputs, toOutputs, ledger.transactions, engine,
                                   capitalGains, cadToUsdPositions);

// Consuming (exchange) transaction — exchange lines only:
ledger.newTransaction(exchangedInputs, res.getFromOutputs());
for (const tx of res.constructIntermediateTransactions()) ledger.addTransaction(tx);
// Receiving (exchange) transaction — toOutputs already included in getToOutputs():
ledger.newTransaction(res.getToInputs(), res.getToOutputs());

// The withdrawal is an INDEPENDENT transaction, not extra lines on the one above:
ledger.newTransaction(cash.generateInputs(cad, 100, ledger.transactions),
                      drawer.generateOutputs(cad, 100, ledger.transactions));
```

### Why the withdrawal is its own transaction

The `BookValueEngine` attributes each input's basis across **all** of a transaction's outputs proportionally — it treats every transaction's outputs as a *uniform blend* of its inputs. That is exact for a pure exchange (all outputs derive uniformly from all inputs) and for proceeds that blend recovered basis with a gain. But if you drop an *independent* sub-flow — a fee or withdrawal with its own input→output correspondence — into the same single-position transaction, its lineage bleeds into the exchanged value and corrupts basis tracing.

So the rule is: **lines may share a transaction only when they form a single uniform blend. Independent effects go in separate transactions.** The kernel will not stop you (it only checks single-position + balance), so this is a discipline the equity-policy layer keeps — see [Invariants](../architecture/invariants.md).

---

## Open vs Settled

An exchange position is **open** as long as one or both sides have remaining unconsumed availability.

An exchange is **fully settled** when both `ex.from` and `ex.to` have zero remaining availability — both sides have been consumed exactly. A fully settled exchange contributes nothing to `ExchangeAccount`.

The `ExchangeAccount` computed equity account scans every `ExchangedUTXO` and `ExchangedUTXI` across all transactions and derives its balance from remaining availability. This ensures `ledger.verify()` can pass even with open exchange positions — the open portions cancel with matching entries on the asset side.

See [Unwind Algorithm](../architecture/unwind.md) for the recapture logic, and [Four-Phase Example](../guides/example.md) for a full walkthrough.

---

## Related Documents

- [Transaction Primitives](transactions.md) — UTXO/UTXI, the conservation model
- [Cost Basis Engine](../architecture/cost-basis.md) — How lineage is traced through exchange boundaries
- [Unwind Algorithm](../architecture/unwind.md) — How loop-mode vs full-mode recapture works
- [Account System](../architecture/accounts.md) — ResidualAccount, ExchangeAccount, ResidualTarget
