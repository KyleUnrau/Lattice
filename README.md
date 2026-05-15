# Ledger Kernel

A graph-oriented accounting kernel for modeling deterministic financial state, transaction lineage, position flows, and exchange relationships.

This project explores an alternative accounting architecture inspired by both traditional double-entry accounting and UTXO-style transactional systems such as Bitcoin. Instead of reducing all activity into a single reporting currency and opaque journal balances, the system models explicit positions, consumable transaction outputs, fragmented lineage, and exchange links between independent transaction graphs.

The result is a foundation for:

* Multi-position accounting
* Deterministic cost-basis tracking
* FIFO/LIFO/average disposal engines
* Transaction lineage graphs
* Fragmented lot accounting
* Cross-position exchanges
* Future unrealized valuation layers
* Alternative equity policy systems
* High-fidelity accounting reconstruction from history alone

---

# Core Ideas

## Positions Are First-Class

A `Position` represents any tracked quantity:

* CAD
* USD
* Shares
* Commodities
* Inventory
* Crypto
* Debt instruments
* Loyalty points
* Anything measurable

```ts
export interface Position {
    name: string;
}
```

Every transaction is constrained to a single position internally. Cross-position movement is represented through explicit exchange relationships instead of collapsing everything into a synthetic base currency. 

---

# Transaction Model

The system is built around two primitive concepts:

* `TXO` — Transaction Output
* `TXI` — Transaction Input

Both are consumable over time.

This creates a graph of financial lineage where balances emerge from the remaining unconsumed portions of historical outputs and inputs.

## TXOs

A `TXO` represents a produced quantity.

```ts
const output = cash.stageOutput(cad, 1000);
```

Internally:

* TXOs track consumptions
* Remaining quantity is computed dynamically
* Partial fragmentation is supported

```ts
public calculateAvailable(): number {
    let available: number = this.quantity;
    for (const consumption of this.consumptions) available -= consumption.quantity;

    return available;
}
```



---

## TXIs

A `TXI` represents required balancing quantity entering the opposite side of the accounting graph.

Like TXOs:

* They can be fragmented
* They track consumptions
* Remaining quantities are dynamically calculated



---

# Why Both TXOs and TXIs Exist

Traditional accounting typically tracks balances through aggregated debits and credits.

This kernel instead models:

* Positive residual ownership (`TXO`)
* Negative residual obligations (`TXI`)

Both become consumable primitives.

This allows:

* Symmetric accounting logic
* Explicit fragmentation
* Deterministic disposal
* Bidirectional lineage traversal
* Reconstruction of historical state from transaction graphs alone

---

# Grouped Inputs and Outputs

Transactions may contain grouped staged components.

This allows automatic fragmentation handling:

```ts
{
    stagedType: "grouped-output",
    outputs: [...]
}
```

The engine can therefore:

* Consume prior fragments
* Create remainder fragments
* Generate new residual lots
* Preserve deterministic lineage

without requiring manual bookkeeping by the caller.



---

# Disposal Engines

Disposal methods are pluggable.

Current implementation includes FIFO:

```ts
export type DisposalMethod<T extends TXO | TXI> =
    (components: T[], delta: number) => Map<T, number>;
```



Example FIFO implementation:

```ts
export const fifo = <T extends TXO | TXI>(
    components: T[],
    quantity: number
): Map<T, number> => {
```



The FIFO engine:

* Consumes oldest available quantities first
* Supports partial fragmentation
* Produces deterministic consumption mappings

This design allows future support for:

* LIFO
* Average cost
* Highest-cost
* Tax-optimized disposal
* Custom user-defined policies

---

# Account Architecture

Accounts exist within a hierarchical folder structure.

```ts
const assets = netAssets.addFolder("Assets", Orientation.Positive);
const liabilities = netAssets.addFolder("Liabilities", Orientation.Negative);
```



Accounts themselves contain position-specific transaction engines.

```ts
public positionEngines: Map<Position, AccountTransactionEngine> = new Map();
```



This means a single account may independently manage:

* CAD balances
* USD balances
* Share positions
* Inventory positions
* Any arbitrary asset class

without flattening them into a single reporting dimension.

---

# Orientation System

Instead of hardcoded debit/credit semantics, the system uses recursive orientation propagation.

```ts
export enum Orientation {
    Positive = 1,
    Negative = -1
}
```



Root orientation is computed recursively through folder ancestry:

```ts
public getRootOrientation(): Orientation {
    if (this.parent === null) return this.localOrientation;
    return this.parent.getRootOrientation() * this.localOrientation;
}
```



This creates a mathematically minimal alternative to traditional debit/credit polarity rules while still preserving full double-entry integrity.

---

# Ledger Verification

The ledger verifies that all root balances net to zero per position.

```ts
public verify(): Result<undefined, Error> {
    const rootBalances: Map<Position, number> = this.getRootBalances();

    for (const [position, rootBalance] of rootBalances) {
        if (rootBalance !== 0)
```



This ensures:

* Position conservation
* Accounting integrity
* Deterministic balancing
* No hidden quantity creation/destruction

---

# Exchange Links

Cross-position exchanges are modeled explicitly.

Example:

```ts
Transaction.exchangeLink(
    transaction2cad.getOutputFromStaged(entry5),
    transaction2usd.getInputFromStaged(entry6)
);
```



This creates a direct relationship between:

* The source position flow
* The destination position flow

rather than implicitly encoding exchange semantics into journal metadata.

This enables:

* Cost-basis lineage
* Exchange tracing
* Currency conversion graphs
* Realized gain reconstruction
* Position ancestry analysis

---

# Example Flow

The included example demonstrates:

1. Opening CAD balance
2. Exchange expense
3. CAD → USD transfer
4. Exchange linkage

```ts
const entry1 = openingBalance.stageInput(cad, 1000);
const entry2 = cash.stageOutput(cad, 1000);

const transaction = new Transaction([entry1], [entry2]);
```



Then:

```ts
const entry3 = cash.stageInput(cad, 525);
const entry4 = exchangeExpense.stageOutput(cad, 25);
const entry5 = netTransfers.stageOutput(cad, 500);
```



And finally:

```ts
const entry6 = netTransfers.stageInput(usd, 375);
const entry7 = cash.stageOutput(usd, 375);
```



This represents:

* Spending CAD
* Recognizing exchange expense
* Creating a transfer bridge
* Receiving USD
* Linking the exchange lineage

---

# CLI Environment

The repository includes a lightweight interactive CLI sandbox.

```ts
runCLI({
    cad,
    usd,
    ledger,
    cash,
    transaction
});
```



The CLI dynamically evaluates expressions inside the active ledger context:

```ts
const fn = new Function(...names, response);
```



This provides a rapid experimentation environment for:

* Inspecting balances
* Exploring lineage
* Testing fragmentation
* Simulating exchanges
* Verifying accounting behavior

---

# Architectural Goals

## Deterministic Reconstruction

All balances should emerge purely from transaction history.

No mutable balance tables should be required.

---

## Explicit Lineage

Every remaining quantity should be traceable through:

* Consumption graphs
* Exchange links
* Fragment ancestry
* Disposal history

---

## Position Purity

Positions should never be forcibly collapsed into arbitrary reporting currencies.

Reporting layers may exist above the kernel, but the kernel itself preserves native quantities.

---

## Policy Extensibility

The system is intentionally designed to support future pluggable policies:

* Equity policies
* Cost basis policies
* Reporting projections
* Tax treatments
* Valuation engines
* Consolidation layers

without mutating the core ledger semantics.

---

# Future Directions

Potential future work includes:

* DAG compression for lineage scaling
* Unrealized valuation layers
* Reporting engines
* Partnership/corporate projection systems
* Tax lot optimization
* Multi-ledger consolidation
* Event sourcing persistence
* Graph visualization
* Transaction query languages
* Immutable snapshots
* Distributed synchronization
* Cryptographic audit proofs

---

# Philosophy

This project treats accounting as:

* A graph problem
* A conservation problem
* A lineage problem
* A deterministic state reconstruction problem

rather than merely a collection of journal balances.

The system attempts to preserve the actual structure of financial history instead of prematurely collapsing information into summarized accounting artifacts.

In that sense, it sits somewhere between:

* Double-entry accounting
* UTXO transaction systems
* Event sourcing
* Graph databases
* Cost-basis engines
* Position tracking systems

while remaining minimal, explicit, and mathematically composable.

---

# Current State

This repository is currently an experimental accounting kernel prototype.

It already supports:

* Transaction balancing
* TXO/TXI fragmentation
* FIFO disposal
* Position-aware accounts
* Exchange linkage
* Recursive account orientation
* Deterministic balance computation

but remains under active architectural exploration.

---

# File Overview

| File              | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `ledger.ts`       | Core ledger, accounts, folders, transaction engines |
| `transactions.ts` | Transaction construction and validation             |
| `inputs.ts`       | TXI structures and TXO consumptions                 |
| `outputs.ts`      | TXO structures and TXI consumptions                 |
| `basic-fifo.ts`   | FIFO disposal implementation                        |
| `disposals.ts`    | Disposal engine typing                              |
| `positions.ts`    | Position definitions                                |
| `utils.ts`        | CLI utilities and debugging helpers                 |
| `main.ts`         | Example ledger construction and sandbox             |

---

# Example Concepts Supported

This architecture is intended to naturally model situations such as:

* Partial inventory consumption
* Multi-currency exchanges
* Fragmented cost basis
* Share lot accounting
* Capital gains realization
* Inventory lineage
* Recursive transaction ancestry
* Cross-position transfers
* Deterministic equity derivation

without special-case accounting logic.

---

# Running

Typical setup:

```bash
npm install
npm run build
npm start
```

Then interact through the CLI:

```txt
> ledger.verify()
> cash.getBalances()
> dump(transaction)
```

---

# License

Experimental project. No license currently specified.
