import { ResidualUTXI } from "../../ledger-kernel/transactions/special-edges/residual.js";
import { ExchangedUTXI, type Exchange } from "../../ledger-kernel/transactions/special-edges/exchange.js";
import { UTXI, UTXOConsumption, type Input } from "../../ledger-kernel/transactions/inputs.js";
import { UTXIConsumption, UTXO } from "../../ledger-kernel/transactions/outputs.js";
import type { Transaction } from "../../ledger-kernel/transactions/transaction.js";
import { assertPositionUnifiromity, type Position } from "../../ledger-kernel/positions.js";

/** A node in the cost basis tree returned by {@link BookValueEngine.compute}. */
export type BasisPath = OriginPath | ExchangePath | ResidualPath;

/**
 * Terminal node — the basis trace reached a plain {@link UTXI} with no exchange lineage.
 * Represents an opening balance, equity injection, or other unattributed inflow.
 */
export interface OriginPath {
    readonly type: "origin";
    readonly quantity: bigint;
    readonly position: Position;
}

/**
 * Exchange node — the basis trace crossed an {@link ExchangedUTXI}.
 * `quantity` is the to-side amount attributed to this node; `fromQuantity` is the
 * equivalent from-side amount at the exchange's locked rate; `basis` recurses into
 * the from-side's own lineage.
 */
export interface ExchangePath {
    readonly type: "exchange";
    readonly exchange: Exchange;
    readonly quantity: bigint;
    readonly fromQuantity: bigint;
    readonly basis: BasisPath[];
}

/**
 * Residual node — the basis trace crossed a {@link ResidualUTXI} (deferred residual equity).
 * `quantity` is the surface-position amount attributed to this node; `originBasis` is the
 * proportional origin-position composition that amount carries, and `residual` references the
 * lot itself so a consumer can settle (partially close) it. Terminal: a residual does not recurse
 * further — its lineage is captured by `originBasis`.
 */
export interface ResidualPath {
    readonly type: "residual";
    readonly residual: ResidualUTXI;
    readonly quantity: bigint;
    readonly originBasis: Map<Position, bigint>;
}

/**
 * Traverses the transaction graph to compute the cost basis of a given output quantity
 * back to its origin inputs. Each output is traced through exchanges, residuals, and
 * UTXO consumptions until reaching origin UTXIs, producing a tree of {@link BasisPath} nodes.
 */
export class BookValueEngine {
    constructor(private readonly transactions: Transaction[]) {}
    
    /**
     * Computes the basis paths for a set of consumed `inputs`, tracing each consumed UTXO
     * backwards through the transaction graph until every branch reaches an origin input.
     * Non-consumption inputs (origin UTXIs, exchange inputs) carry no consumable lineage and
     * are ignored. Returns one {@link BasisPath} leaf per distinct lineage — exchange paths,
     * residual paths, and origin paths.
     *
     * @param inputs - The inputs being consumed, typically a transaction's input array.
     */
    public compute(inputs: Input[]): BasisPath[] {
        const consumedUTXOs = this.consumedUTXOsFromInputs(inputs);

        return consumedUTXOs.flatMap(({ source, quantity }) => this.traceUTXO(source, quantity));
    }

    /**
     * Traces the cost basis of `quantity` units of a single committed `utxo` back to its origin
     * inputs, independent of whether the lot has been consumed. Defaults to the lot's full
     * quantity. Exposed for inspection tooling (e.g. the transaction explorer); the resolution
     * pipeline uses {@link compute} on actual consumptions instead.
     *
     * @param utxo - The output whose basis is being traced.
     * @param quantity - Portion of `utxo` to trace; defaults to its full `quantity`.
     */
    public traceLot(utxo: UTXO, quantity: bigint = utxo.quantity): BasisPath[] {
        return this.traceUTXO(utxo, quantity);
    }

    /**
     * Computes the basis paths for `quantity` units of a single `utxo`, tracing backwards
     * through the transaction graph until every branch reaches an origin input.
     *
     * @param utxo - The output whose basis is being traced.
     * @param quantity - Portion of `utxo` to trace; must be positive and ≤ `utxo.quantity`.
     */
    private traceUTXO(utxo: UTXO, quantity: bigint): BasisPath[] {
        return this.traceUTXOFrom(utxo, quantity, new Set());
    }

    /** Asserts position uniformity across `inputs`, then filters to the {@link UTXOConsumption} `{ source, quantity }` pairs the basis trace operates on. Non-consumption inputs (origin UTXIs, exchange inputs) carry no consumable lineage and are ignored. */
    private consumedUTXOsFromInputs(inputs: Input[]): { source: UTXO; quantity: bigint }[] {
        assertPositionUnifiromity({inputs});

        return inputs.filter((i): i is UTXOConsumption => i instanceof UTXOConsumption)
            .map(c => ({ source: c.source, quantity: c.quantity }));
    }

    /**
     * Finds the transaction that produced `utxo` and attributes `quantity` to each of its inputs
     * by the input's **forward weight** (see {@link forwardInputWeights}), then recurses via
     * {@link traceInput}. `visited` guards against cycles in the traversal path.
     *
     * Forward weighting — rather than a flat `quantity / totalOutputQty` share — is what keeps a
     * recapture-settlement output (a looped edge being closed) from diluting the basis of the
     * genuinely-forward outputs it shares a transaction with. See {@link forwardInputWeights}.
     */
    private traceUTXOFrom(utxo: UTXO, quantity: bigint, visited: Set<UTXO>): BasisPath[] {
        if (quantity <= 0n) throw new Error(`quantity must be positive, got ${quantity}`);
        if (quantity > utxo.quantity) throw new Error(`quantity ${quantity} exceeds utxo.quantity ${utxo.quantity}`);

        if (visited.has(utxo)) throw new Error(`Cycle detected: UTXO encountered twice in traversal path`);

        const nextVisited = new Set(visited);
        nextVisited.add(utxo);

        const producingTx = this.findProducingTransaction(utxo);
        if (!producingTx) throw new Error(`UTXO has no producing transaction — ledger invariant violated`);

        const forwardWeights = this.forwardInputWeights(producingTx, nextVisited);
        const totalForwardWeight = [...forwardWeights.values()].reduce((sum, w) => sum + w, 0n);

        const result: BasisPath[] = [];
        for (const input of producingTx.inputs) {
            const weight = forwardWeights.get(input) ?? 0n;
            const attributedQty = weight * quantity / totalForwardWeight;
            if (attributedQty === 0n) continue;
            result.push(...this.traceInput(input, attributedQty, nextVisited));
        }
        return result;
    }

    /**
     * Apportions a producing transaction's input quantities into the share that flows **forward**
     * (carries basis to the transaction's value-bearing outputs) versus the share consumed by a
     * **recapture settlement** (a {@link UTXIConsumption} that closes an exchange to-side).
     *
     * A loop-close consuming transaction has the shape `IN[looped lot, forward lot] OUT[settle(edge.to),
     * forwardFromSide]`: the looped lot returns to *settle* its edge, and the forward lot funds the new
     * forward from-side. A flat proportional attribution would smear the looped lot's already-recaptured
     * lineage onto the forward from-side — a phantom edge that, when the from-side is later consumed at a
     * loss and fully unwound, drives a second recapture of the already-settled edge (whose to-side has no
     * availability left). Instead, each settlement's quantity is subtracted from the forward weight of the
     * input(s) whose most-recent exchanged provenance is that settled edge, so the forward outputs are
     * attributed only across genuinely-forward input value.
     *
     * The remaining weights sum to the transaction's forward-output total (by conservation: every input
     * unit either settles an edge or moves forward), so {@link traceUTXOFrom} can divide by their sum.
     */
    private forwardInputWeights(producingTx: Transaction, visited: Set<UTXO>): Map<Input, bigint> {
        const weights = new Map<Input, bigint>(producingTx.inputs.map(input => [input, input.quantity]));

        for (const output of producingTx.outputs) {
            if (!(output instanceof UTXIConsumption) || !(output.source instanceof ExchangedUTXI)) continue;
            const settledEdge = output.source.exchange;
            let remaining = output.quantity;
            for (const input of producingTx.inputs) {
                if (remaining === 0n) break;
                const weight = weights.get(input)!;
                if (weight === 0n) continue;
                const looped = this.inputEdgeQuantity(input, weight, settledEdge, visited);
                const claimed = looped < remaining ? looped : remaining;
                weights.set(input, weight - claimed);
                remaining -= claimed;
            }
        }

        return weights;
    }

    /**
     * How much of `quantity` units of `input` has its most-recent exchanged provenance through
     * `exchange` — i.e. last passed through `exchange`'s to-side before reaching `input` (following
     * plain cash holds transparently). Used by {@link forwardInputWeights} to match a recapture
     * settlement to the looped input it closes.
     */
    private inputEdgeQuantity(input: Input, quantity: bigint, exchange: Exchange, visited: Set<UTXO>): bigint {
        if (input instanceof UTXOConsumption) return this.utxoEdgeQuantity(input.source, quantity, exchange, visited);
        if (input instanceof ExchangedUTXI) return input.exchange === exchange ? quantity : 0n;
        return 0n; // plain origin UTXI or a residual: not this edge's forward provenance.
    }

    /** Recurses {@link inputEdgeQuantity} through the lot's producing transaction (cash holds are transparent). */
    private utxoEdgeQuantity(utxo: UTXO, quantity: bigint, exchange: Exchange, visited: Set<UTXO>): bigint {
        if (visited.has(utxo)) return 0n;
        const nextVisited = new Set(visited);
        nextVisited.add(utxo);

        const producingTx = this.findProducingTransaction(utxo);
        if (!producingTx) return 0n;

        const totalOutputQty = producingTx.outputs.reduce((sum, out) => sum + out.quantity, 0n);
        let total = 0n;
        for (const input of producingTx.inputs) {
            const attributed = input.quantity * quantity / totalOutputQty;
            if (attributed === 0n) continue;
            total += this.inputEdgeQuantity(input, attributed, exchange, nextVisited);
        }
        return total;
    }

    /**
     * Dispatches basis tracing for a single input based on its concrete type:
     * - {@link UTXOConsumption} — recurses into the consumed source UTXO
     * - {@link ExchangedUTXI} — emits an {@link ExchangePath} and recurses into the exchange's from-side
     * - {@link ResidualUTXI} — emits a {@link ResidualPath} and recurses into the exchange's from-side
     * - {@link UTXI} — emits an {@link OriginPath}, terminating the branch
     */
    private traceInput(input: Input, quantity: bigint, visited: Set<UTXO>): BasisPath[] {
        if (input instanceof UTXOConsumption) {
            return this.traceUTXOFrom(input.source, quantity, visited);
        }

        if (input instanceof ExchangedUTXI) {
            const ex = input.exchange;
            const fromQty = quantity * ex.from.quantity / ex.to.quantity;
            const basis = this.traceUTXOFrom(ex.from, fromQty, visited);
            return [{ type: "exchange", exchange: ex, quantity, fromQuantity: fromQty, basis } satisfies ExchangePath];
        }

        if (input instanceof ResidualUTXI) {
            // Deferred residual equity: surface as a residual node carrying the proportional
            // origin-position basis for the traced quantity. Terminal — the lineage is the
            // recorded originBasis, not a deeper graph walk.
            const originBasis = new Map<Position, bigint>();
            for (const [position, basisQty] of input.originBasis)
                originBasis.set(position, basisQty * quantity / input.quantity);
            return [{ type: "residual", residual: input, quantity, originBasis } satisfies ResidualPath];
        }

        if (input instanceof UTXI) {
            return [{ type: "origin", quantity, position: input.position } satisfies OriginPath];
        }

        throw new Error(`Unknown input type encountered: ${(input as { type?: unknown }).type}`);
    }

    /** Searches the transaction history for the transaction that produced `utxo` by reference equality. */
    private findProducingTransaction(utxo: UTXO): Transaction | undefined {
        for (const tx of this.transactions) {
            for (const output of tx.outputs) {
                if (output === utxo) return tx;
            }
        }
        return undefined;
    }
}
