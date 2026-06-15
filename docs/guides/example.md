# Four-Phase Example

This walkthrough traces a complete multi-hop exchange loop: CAD → USD → Oranges → CAD. The scenario is exercised by the integration tests in `src/tests/equity-policy/exchange.test.ts` and the test fixture in `src/tests/utils/ledger-fixture.ts`. Each phase builds on the ledger state left by prior phases. The loop closes in phase 3, where the engine recursively recaptures every edge in the chain and recognizes the net gain.

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
  ├─ Transfers CAD→USD     [ExchangeAccount, scoped] (+)
  ├─ Transfers USD→Oranges  [ExchangeAccount, scoped] (+)
  ├─ Transfers Oranges→CAD  [ExchangeAccount, scoped] (+)
  └─ Net Income (+)
       ├─ Net Capital Gains (Losses) (+)
       │    ├─ Capital Gains [ResidualAccount] (+)
       │    └─ Capital Loss  [ResidualAccount] (−)
       └─ Expenses (−)
            └─ Exchange Expense (+)
```

All positions use 2 decimal places (`decimals: 2`) except Oranges (`decimals: 0`, whole units).

Gains and losses route to **separate accounts** under a `Net Capital Gains (Losses)` folder: `capitalGains` (`+`) receives gain `ResidualUTXI` lots and `capitalLosses` (`−`) receives loss `ResidualUTXO` lots. The folder balance nets them. Each exchange passes `{ gain: capitalGains, loss: capitalLosses }` as `residualAccount`.

**The three exchange accounts are scoped**: each `ExchangeResolution` passes its own `exchangeAccount` so its forward exchange is tagged exclusively to that account. No account tracks exchanges from the other directions.

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
    const fromInputs = cash.generateInputs(cad, 500, ledger.transactions);
    const toOutputs  = cash.generateOutputs(usd, 375, ledger.transactions);
    const res = new ExchangeResolution(
        fromInputs, toOutputs, ledger.transactions, engine,
        { gain: capitalGains, loss: capitalLosses }, cadToUsdPositions
    );
    ledger.newTransaction(fromInputs, res.getFromOutputs());
    for (const tx of res.constructIntermediateTransactions()) ledger.addTransaction(tx);
    ledger.newTransaction(res.getToInputs(), res.getToOutputs());
}
```

500 CAD is exchanged for 375 USD. The basis engine traces the 500 CAD to the phase 0 `UTXI` — a plain origin path with no prior exchange lineage in USD. Since there is no loop to recapture, the entire portion opens a **forward exchange** at the locked rate of 500 CAD / 375 USD. The forward exchange is tagged to `cadToUsdPositions`, so only that account tracks this open position.

**Transactions committed (by the caller):**

1. *Consuming:* `fromInputs` → `res.getFromOutputs()` which includes `[exchange.from]` (ExchangedUTXO; 500 CAD given away)
2. *Receiving:* `res.getToInputs()` (ExchangedUTXI; 375 USD received) → `res.getToOutputs()` (the UTXO in cash)

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
    const fromInputs = cash.generateInputs(usd, 375, ledger.transactions);
    const toOutputs  = inventory.generateOutputs(oranges, 1500, ledger.transactions);
    const res = new ExchangeResolution(
        fromInputs, toOutputs, ledger.transactions, engine,
        { gain: capitalGains, loss: capitalLosses }, usdToOrangesPositions
    );
    ledger.newTransaction(fromInputs, res.getFromOutputs());
    for (const tx of res.constructIntermediateTransactions()) ledger.addTransaction(tx);
    ledger.newTransaction(res.getToInputs(), res.getToOutputs());
}
```

375 USD is exchanged for 1500 Oranges. The engine traces the 375 USD to the phase 1 `ExchangedUTXI`. The target position is Oranges — there is no loop back to Oranges in the USD lineage — so again, the entire portion opens a **forward exchange** at 375 USD / 1500 Oranges. The locked rate for the phase 1 CAD→USD exchange is inherited: Oranges now carries provenance tracing back through USD to the original CAD basis. The forward exchange is tagged to `usdToOrangesPositions`.

**Transactions committed (by the caller):**

1. *Consuming:* `fromInputs` → `res.getFromOutputs()` which includes `[exchange2.from]` (ExchangedUTXO)
2. *Receiving:* `res.getToInputs()` (ExchangedUTXI) → `res.getToOutputs()` (the UTXO in inventory)

**Ledger state after phase 2:**
- `cash`: 500 CAD
- `inventory`: 1500 Oranges
- `cadToUsdPositions`: +500 CAD, −375 USD (phase 1 exchange still open)
- `usdToOrangesPositions`: +375 USD, −1500 Oranges (phase 2 exchange now open)
- `capitalGains` / `capitalLosses`: 0

---

## Phase 3 — Oranges → CAD (Loop Closure, Gain Recognition)

```ts
function phase3(proceeds: number = 600) {
    const fromInputs = inventory.generateInputs(oranges, 1500, ledger.transactions);
    const toOutputs  = cash.generateOutputs(cad, proceeds, ledger.transactions);
    const res = new ExchangeResolution(
        fromInputs, toOutputs, ledger.transactions, engine,
        { gain: capitalGains, loss: capitalLosses }, orangesToCadPositions
    );
    ledger.newTransaction(fromInputs, res.getFromOutputs());
    for (const tx of res.constructIntermediateTransactions()) ledger.addTransaction(tx);
    ledger.newTransaction(res.getToInputs(), res.getToOutputs());
}
```

1500 Oranges are sold for 600 CAD. The engine traces the Oranges to `exchange2.to` (an `ExchangedUTXI`), which traces further to `exchange2.from` (USD), which traces to `exchange1.to` (ExchangedUTXI), which traces to `exchange1.from` (CAD). **CAD is the target position** — the loop closes.

`exchangeAccount` is required and is supplied even here (`orangesToCadPositions`). Because the loop closes completely, no forward exchange opens and the account carries a zero balance — but it must still be provided.

**Unwind plan (loop mode, `stopAt = cad`):**

| Exchange | Recapture to-side | Recapture from-side |
|---|---|---|
| Oranges→USD exchange (exchange2) | 1500 Oranges at locked rate → 375 USD | Recovers 375 USD |
| USD→CAD exchange (exchange1) | 375 USD at locked rate → 500 CAD | Recovers 500 CAD (the cost basis) |

Cost basis recovered: **500 CAD**. Actual proceeds: **600 CAD**. Gain: **100 CAD**.

The gain is recognized as a `ResidualUTXI` (100 CAD) registered in `capitalGains`.

**Transactions committed (in dependency order):**

Because both exchanges are fully looped, there is no forward exchange. `res.exchange` is `null`. All consumed value loops back to CAD.

1. *Consuming:* `fromInputs` (1500 Oranges) → `res.getFromOutputs()`: `[recapture2.settlement]` (settling exchange2's to-side; 1500 Oranges)

2. *Intermediate hop (USD) — via `res.constructIntermediateTransactions()`:* Inputs `[recapture2.reclaim]` (reclaim exchange2's from-side: 375 USD) → Outputs `[recapture1.settlement]` (settle exchange1's to-side: 375 USD). Nets to zero in USD.

3. *Receiving:* `res.getToInputs()` → `res.getToOutputs()` (600 CAD to cash)
   - Inputs: `recapture1.reclaim` (500 CAD reclaim) + `residual` (ResidualUTXI, 100 CAD gain)
   - Total inputs: 500 + 100 = 600 CAD ✓
   - The 100 CAD `ResidualUTXI` is registered in `capitalGains`

**Ledger state after phase 3:**
- `cash`: 500 CAD (original) + 600 CAD (proceeds) = 1100 CAD
- `inventory`: 0 Oranges
- `cadToUsdPositions`: 0 for all positions (exchange settled)
- `usdToOrangesPositions`: 0 for all positions (exchange settled)
- `orangesToCadPositions`: 0 (loop fully closed; no forward exchange opened)
- `capitalGains`: signed = −10000n (100.00 CAD gain as `ResidualUTXI`); oriented = +10000n (`effectiveOrientation = −1`); `getBalance(cad, ...)` = `100.00`
- `capitalLosses`: 0 (no loss)

```
> ledger.verify()
{ ok: true }
```

---

## What Changes with Different Proceeds

`phase3()` accepts an optional proceeds override:

- `phase3(500)` — break-even: cost basis = proceeds → no residual; both `capitalGains` and `capitalLosses` stay at 0
- `phase3(450)` — loss: proceeds < cost basis → `ResidualUTXO` (loss) registered in `capitalLosses`
- `phase3(700)` — larger gain: `ResidualUTXI` (200 CAD) registered in `capitalGains`

---

## Related Documents

- [Getting Started](getting-started.md) — How to run this scenario
- [Exchanges](../concepts/exchanges.md) — Exchange objects and recapture
- [Unwind Algorithm](../architecture/unwind.md) — How the loop detection and recapture work
- [Cost Basis Engine](../architecture/cost-basis.md) — How the engine traces Oranges → USD → CAD lineage
