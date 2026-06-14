# Four-Phase Example

The example in `src/main.ts` demonstrates a complete multi-hop exchange loop: CAD → USD → Oranges → CAD. Each phase builds on the ledger state left by prior phases. The loop closes in phase 3, where the engine recursively recaptures every edge in the chain and recognizes the net gain.

---

## Chart of Accounts

```
Net Assets (+)
  └─ Assets (+)
       └─ Current Assets (+)
            ├─ Cash (+)
            ├─ Inventory (+)
            └─ Cryptocurrency Wallet (+)

Net Worth (−)
  ├─ Opening Balance (+)
  ├─ Transfers CAD→USD    [ExchangePositionsAccount, scoped] (+)
  ├─ Transfers USD→Oranges [ExchangePositionsAccount, scoped] (+)
  └─ Net Income (+)
       ├─ Capital Gains [ResidualAccount, dual-name] (+)
       └─ Expenses (−)
            └─ Exchange Expense (+)
```

All positions use 2 decimal places (`decimals: 2`) except Oranges (`decimals: 0`, whole units).

**Capital Gains** uses the dual-name feature: its `negativeLabel` is `"Capital Losses"`, so `summarize()` returns `"Capital Losses"` in any position where the balance is net-negative.

**The two exchange accounts are scoped**: each `swap()` call passes `exchangeAccount` so its forward exchange is tagged exclusively to that account. Neither account tracks exchanges from the other direction.

---

## Phase 0 — Opening Balance

```ts
function phase0() {
    const inputs  = openingBalance.generateInputs(cad, 1000, ledger.transactions);
    const outputs = cash.generateOutputs(cad, 1000, ledger.transactions);
    return ledger.newTransaction(inputs, outputs);
}
```

A plain 1000 CAD credit from the opening balance equity account into cash. No exchange involved — the `UTXO` produced in cash has a single `OriginPath` in the basis engine: a plain `UTXI` from `openingBalance`.

**Ledger state after phase 0:**
- `cash` holds 1000 CAD
- `openingBalance` shows −1000 CAD (equity, so negative means "contributed")

---

## Phase 1 — CAD → USD (Forward Exchange)

```ts
function phase1() {
    return swap({
        source: cash, from: cad, quantity: 500,
        destination: cash, to: usd, proceeds: 375,
        engine, ledger,
        residualAccount: capitalGains,
        exchangeAccount: cadToUsdPositions
    });
}
```

500 CAD is exchanged for 375 USD. The basis engine traces the 500 CAD to the phase 0 `UTXI` — a plain origin path with no prior exchange lineage in USD. Since there is no loop to recapture, the entire portion opens a **forward exchange** at the locked rate of 500 CAD / 375 USD. The forward exchange is tagged to `cadToUsdPositions`, so only that account tracks this open position.

**Transactions committed (by `swap()`):**

1. *Consuming:* `cash.generateInputs(cad, 500)` → `[exchange.from]` (ExchangedUTXO; 500 CAD given away)
2. *Receiving:* `[exchange.to]` (ExchangedUTXI; 375 USD received) → `cash.generateOutputs(usd, 375)`

No intermediate hop transactions (single exchange edge).

**Ledger state after phase 1:**
- `cash`: 500 CAD, 375 USD
- `cadToUsdPositions`: +500 CAD, −375 USD (open exchange position)
- `usdToOrangesPositions`: 0 (no exchanges tagged here yet)
- `capitalGains`: 0 (no gain/loss; value suspended in forward exchange)

---

## Phase 2 — USD → Oranges (Forward Exchange)

```ts
function phase2() {
    return swap({
        source: cash, from: usd, quantity: 375,
        destination: inventory, to: oranges, proceeds: 1500,
        engine, ledger,
        residualAccount: capitalGains,
        exchangeAccount: usdToOrangesPositions
    });
}
```

375 USD is exchanged for 1500 Oranges. The engine traces the 375 USD to the phase 1 `ExchangedUTXI`. The target position is Oranges — there is no loop back to Oranges in the USD lineage — so again, the entire portion opens a **forward exchange** at 375 USD / 1500 Oranges. The locked rate for the phase 1 CAD→USD exchange is inherited: Oranges now carries provenance tracing back through USD to the original CAD basis. The forward exchange is tagged to `usdToOrangesPositions`.

**Transactions committed:**

1. *Consuming:* `cash.generateInputs(usd, 375)` → `[exchange2.from]` (ExchangedUTXO)
2. *Receiving:* `[exchange2.to]` (ExchangedUTXI) → `inventory.generateOutputs(oranges, 1500)`

**Ledger state after phase 2:**
- `cash`: 500 CAD
- `inventory`: 1500 Oranges
- `cadToUsdPositions`: +500 CAD, −375 USD (phase 1 exchange still open)
- `usdToOrangesPositions`: +375 USD, −1500 Oranges (phase 2 exchange now open)
- `capitalGains`: 0

---

## Phase 3 — Oranges → CAD (Loop Closure, Gain Recognition)

```ts
function phase3(proceeds: number = 600) {
    return swap({
        source: inventory, from: oranges, quantity: 1500,
        destination: cash, to: cad, proceeds,
        engine, ledger, residualAccount: capitalGains
    });
}
```

1500 Oranges are sold for 600 CAD. The engine traces the Oranges to `exchange2.to` (an `ExchangedUTXI`), which traces further to `exchange2.from` (USD), which traces to `exchange1.to` (ExchangedUTXI), which traces to `exchange1.from` (CAD). **CAD is the target position** — the loop closes.

Note that `exchangeAccount` is required and is supplied even here (`orangesToCadPositions`). Because the loop closes completely, no forward exchange opens and the account carries a zero balance — but it must still be provided.

**Unwind plan (loop mode, `stopAt = cad`):**

| Exchange | Recapture to-side | Recapture from-side |
|---|---|---|
| Oranges→USD exchange (exchange2) | 1500 Oranges at locked rate → 375 USD | Recovers 375 USD |
| USD→CAD exchange (exchange1) | 375 USD at locked rate → 500 CAD | Recovers 500 CAD (the cost basis) |

Cost basis recovered: **500 CAD**. Actual proceeds: **600 CAD**. Gain: **100 CAD**.

The gain is recognized as a `ResidualUTXI` (100 CAD) registered in `capitalGains`.

**Transactions committed (in dependency order):**

1. *Consuming:* `inventory.generateInputs(oranges, 1500)` → `[recapture2.from, exchange1.from (exchange.from)]`

   Wait — let me clarify: because both exchanges are fully looped, there is no forward exchange here. All consumed value loops back to CAD. `ExchangeResolution.exchange` is `null` (pure-loop case). The consuming transaction outputs include `recapture2.from` only (settling the Oranges→USD exchange's to-side).

2. *Intermediate hop (USD):* Inputs `[recapture2.to]` (reclaim exchange2's from-side: 375 USD) → Outputs `[recapture1.from]` (settle exchange1's to-side: 375 USD). This transaction nets to zero in USD.

3. *Receiving:* `[recapture1.to, residual]` → `cash.generateOutputs(cad, 600)`
   - `recapture1.to`: reclaims exchange1's from-side (500 CAD)
   - `residual` (ResidualUTXI, 100 CAD gain): registered in `capitalGains`
   - Total inputs: 500 + 100 = 600 CAD ✓

**Ledger state after phase 3:**
- `cash`: 500 CAD (original) + 600 CAD (proceeds) = 1100 CAD
- `inventory`: 0 Oranges
- `cadToUsdPositions`: 0 for all positions (exchange settled)
- `usdToOrangesPositions`: 0 for all positions (exchange settled)
- `capitalGains`: −100 CAD root balance (gain reduces equity; `rootOrientation = −1`; `summarize()` returns `"Capital Gains"` since balance is net-negative-root which displays as positive)

```
> ledger.verify()
{ ok: true }
```

---

## What Changes with Different Proceeds

`phase3()` accepts an optional proceeds override:

- `phase3(500)` — break-even: cost basis = proceeds → no residual, `capitalGains` stays at 0
- `phase3(450)` — loss: proceeds < cost basis → `ResidualUTXO` (loss) in `capitalGains`, positive root balance
- `phase3(700)` — larger gain: residual = 200 CAD

---

## Related Documents

- [Getting Started](getting-started.md) — How to run this scenario
- [Exchanges](../concepts/exchanges.md) — Exchange objects and recapture
- [Unwind Algorithm](../architecture/unwind.md) — How the loop detection and recapture work
- [Cost Basis Engine](../architecture/cost-basis.md) — How the engine traces Oranges → USD → CAD lineage
