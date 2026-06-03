import { ExchangedTXI, ResidualTXI } from "../transactions/exchange.js";
import { TXI, TXOConsumption, type Input } from "../transactions/inputs.js";
import { TXO } from "../transactions/outputs.js";
import type { Transaction } from "../transactions.js";
import type { BasisPath, ExchangePath, OriginPath, ResidualPath } from "./types.js";

export type { BasisPath, ExchangePath, OriginPath, ResidualPath } from "./types.js";

/**
 * Traverses the transaction graph to compute the cost basis of a given output quantity
 * back to its origin inputs. Each output is traced through exchanges, residuals, and
 * TXO consumptions until reaching origin TXIs, producing a tree of {@link BasisPath} nodes.
 */
export class BookValueEngine {
    constructor(private readonly transactions: Transaction[]) {}

    /**
     * Computes the basis paths for `quantity` units of `txo`, tracing backwards through
     * the transaction graph until every branch reaches an origin input. Returns one
     * {@link BasisPath} leaf per distinct lineage — exchange paths, residual paths, and origin paths.
     *
     * @param txo - The output whose basis is being traced.
     * @param quantity - Portion of `txo` to trace; must be positive and ≤ `txo.quantity`.
     */
    public compute(txo: TXO, quantity: number): BasisPath[] {
        if (quantity <= 0) throw new Error(`quantity must be positive, got ${quantity}`);
        if (quantity > txo.quantity) throw new Error(`quantity ${quantity} exceeds txo.quantity ${txo.quantity}`);
        return this.traceTXO(txo, quantity, new Set<TXO>());
    }

    /**
     * Finds the transaction that produced `txo` and proportionally attributes `quantity`
     * to each of its inputs by the fraction `quantity / totalOutputQty`, then recurses
     * via {@link traceInput}.
     */
    private traceTXO(txo: TXO, quantity: number, visited: Set<TXO> = new Set()): BasisPath[] {
        if (visited.has(txo)) throw new Error(`Cycle detected: TXO encountered twice in traversal path`);

        const nextVisited = new Set(visited);
        nextVisited.add(txo);

        const producingTx = this.findProducingTransaction(txo);
        if (!producingTx) throw new Error(`TXO has no producing transaction — ledger invariant violated`);

        const totalOutputQty = producingTx.outputs.reduce((sum, out) => sum + out.quantity, 0);
        const inputFraction = quantity / totalOutputQty;

        const result: BasisPath[] = [];
        for (const input of producingTx.inputs) {
            const attributedQty = input.quantity * inputFraction;
            if (attributedQty < Number.EPSILON) continue;
            result.push(...this.traceInput(input, attributedQty, nextVisited));
        }
        return result;
    }

    /**
     * Dispatches basis tracing for a single input based on its concrete type:
     * - {@link TXOConsumption} — recurses into the consumed source TXO
     * - {@link ExchangedTXI} — emits an {@link ExchangePath} and recurses into the exchange's from-side
     * - {@link ResidualTXI} — emits a {@link ResidualPath} and recurses into the exchange's from-side
     * - {@link TXI} — emits an {@link OriginPath}, terminating the branch
     */
    private traceInput(input: Input, quantity: number, visited: Set<TXO> = new Set()): BasisPath[] {
        if (input instanceof TXOConsumption) {
            return this.traceTXO(input.source, quantity, visited);
        }

        if (input instanceof ExchangedTXI) {
            const ex = input.exchange;
            const fromQty = quantity * (ex.from.quantity / ex.to.quantity);
            const basis = this.traceTXO(ex.from, fromQty, visited);
            return [{ type: "exchange", exchange: ex, quantity, fromQuantity: fromQty, basis } satisfies ExchangePath];
        }

        if (input instanceof ResidualTXI) {
            const ex = input.exchange;
            const fromQty = quantity * (ex.from.quantity / ex.to.quantity);
            const basis = this.traceTXO(ex.from, fromQty, visited);
            return [{ type: "residual", exchange: ex, quantity, fromQuantity: fromQty, basis } satisfies ResidualPath];
        }

        if (input instanceof TXI) {
            return [{ type: "origin", quantity, position: input.position } satisfies OriginPath];
        }

        throw new Error(`Unknown input type encountered: ${(input as { type?: unknown }).type}`);
    }

    /** Searches the transaction history for the transaction that produced `txo` by reference equality. */
    private findProducingTransaction(txo: TXO): Transaction | undefined {
        for (const tx of this.transactions) {
            for (const output of tx.outputs) {
                if (output === txo) return tx;
            }
        }
        return undefined;
    }
}
