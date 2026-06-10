import { ExchangedUTXI, ResidualUTXI } from "../transactions/cross-position.js";
import { UTXI, UTXOConsumption, type Input } from "../transactions/inputs.js";
import { UTXO } from "../transactions/outputs.js";
import type { Transaction } from "../transactions.js";
import type { Position } from "../positions.js";
import type { BasisPath, ExchangePath, OriginPath, ResidualPath } from "./types.js";

export type { BasisPath, ExchangePath, OriginPath, ResidualPath } from "./types.js";

/**
 * Traverses the transaction graph to compute the cost basis of a given output quantity
 * back to its origin inputs. Each output is traced through exchanges, residuals, and
 * UTXO consumptions until reaching origin UTXIs, producing a tree of {@link BasisPath} nodes.
 */
export class BookValueEngine {
    constructor(private readonly transactions: Transaction[]) {}

    /**
     * Computes the basis paths for `quantity` units of `utxo`, tracing backwards through
     * the transaction graph until every branch reaches an origin input. Returns one
     * {@link BasisPath} leaf per distinct lineage — exchange paths, residual paths, and origin paths.
     *
     * @param utxo - The output whose basis is being traced.
     * @param quantity - Portion of `utxo` to trace; must be positive and ≤ `utxo.quantity`.
     */
    public compute(utxo: UTXO, quantity: bigint): BasisPath[] {
        if (quantity <= 0n) throw new Error(`quantity must be positive, got ${quantity}`);
        if (quantity > utxo.quantity) throw new Error(`quantity ${quantity} exceeds utxo.quantity ${utxo.quantity}`);
        return this.traceUTXO(utxo, quantity, new Set<UTXO>());
    }

    /**
     * Finds the transaction that produced `utxo` and proportionally attributes `quantity`
     * to each of its inputs by the fraction `quantity / totalOutputQty`, then recurses
     * via {@link traceInput}.
     */
    private traceUTXO(utxo: UTXO, quantity: bigint, visited: Set<UTXO> = new Set()): BasisPath[] {
        if (visited.has(utxo)) throw new Error(`Cycle detected: UTXO encountered twice in traversal path`);

        const nextVisited = new Set(visited);
        nextVisited.add(utxo);

        const producingTx = this.findProducingTransaction(utxo);
        if (!producingTx) throw new Error(`UTXO has no producing transaction — ledger invariant violated`);

        const totalOutputQty = producingTx.outputs.reduce((sum, out) => sum + out.quantity, 0n);

        const result: BasisPath[] = [];
        for (const input of producingTx.inputs) {
            const attributedQty = input.quantity * quantity / totalOutputQty;
            if (attributedQty === 0n) continue;
            result.push(...this.traceInput(input, attributedQty, nextVisited));
        }
        return result;
    }

    /**
     * Dispatches basis tracing for a single input based on its concrete type:
     * - {@link UTXOConsumption} — recurses into the consumed source UTXO
     * - {@link ExchangedUTXI} — emits an {@link ExchangePath} and recurses into the exchange's from-side
     * - {@link ResidualUTXI} — emits a {@link ResidualPath} and recurses into the exchange's from-side
     * - {@link UTXI} — emits an {@link OriginPath}, terminating the branch
     */
    private traceInput(input: Input, quantity: bigint, visited: Set<UTXO> = new Set()): BasisPath[] {
        if (input instanceof UTXOConsumption) {
            return this.traceUTXO(input.source, quantity, visited);
        }

        if (input instanceof ExchangedUTXI) {
            const ex = input.exchange;
            const fromQty = quantity * ex.from.quantity / ex.to.quantity;
            const basis = this.traceUTXO(ex.from, fromQty, visited);
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
