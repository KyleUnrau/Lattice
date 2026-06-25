import type { Transaction } from "../../ledger-kernel/transactions.js";
import type { Input } from "../../ledger-kernel/transactions/inputs.js";
import type { Output } from "../../ledger-kernel/transactions/outputs.js";
import { Account } from "../../ledger-kernel/accounts/account.js";
import { AccountFolder } from "../../ledger-kernel/accounts/folder.js";
import type { AccountNode } from "../../ledger-kernel/accounts/node.js";
import {
    Exchange,
    ExchangedUTXI,
    ExchangedUTXO,
    ResidualUTXI,
} from "../../ledger-kernel/transactions/cross-position.js";
import { TerminalUTXO } from "../../ledger-kernel/transactions/terminal.js";
import type { LedgerView } from "../../scenarios.js";

/** Any value-bearing lot or consumption record that can appear in a transaction's inputs/outputs. */
export type LotLike = Input | Output;

/**
 * Assigns stable, reference-derived identifiers to every lot, consumption, exchange, and account
 * in a {@link LedgerView}, and resolves which account owns each lot. The kernel models identity by
 * reference equality (lots carry no id and no back-reference to their account), so this registry is
 * the explorer's bridge from in-memory objects to the string ids the HTTP API and UI traffic in.
 *
 * Ids are deterministic for a fixed history: accounts `A0…` in tree order, lots/consumptions `n0…`
 * in transaction-encounter order (matching the draw.io graph generator), exchanges `x0…`.
 */
export class Registry {
    readonly lotId = new Map<LotLike, string>();
    readonly lotById = new Map<string, LotLike>();
    readonly exchangeId = new Map<Exchange, string>();
    readonly exchangeById = new Map<string, Exchange>();
    readonly accountId = new Map<AccountNode, string>();
    readonly accountById = new Map<string, AccountNode>();
    private readonly owner = new Map<LotLike, AccountNode>();

    constructor(view: LedgerView) {
        this.indexAccount(view.ledger.netAssets);
        this.indexAccount(view.ledger.equity);
        this.indexAccountLots();
        for (const tx of view.ledger.transactions) {
            for (const input of tx.inputs) this.register(input);
            for (const output of tx.outputs) this.register(output);
        }
    }

    /** DFS over the account tree, assigning `A{n}` ids in encounter order. */
    private indexAccount(node: AccountNode): void {
        const id = `A${this.accountId.size}`;
        this.accountId.set(node, id);
        this.accountById.set(id, node);
        if (node instanceof AccountFolder) for (const child of node.children) this.indexAccount(child);
    }

    /** Maps every lot held in a regular {@link Account}'s lot stores back to that account. */
    private indexAccountLots(): void {
        for (const node of this.accountId.keys()) {
            if (!(node instanceof Account)) continue;
            for (const store of node.lotStores.values()) {
                for (const utxo of store.utxos) this.owner.set(utxo, node);
                for (const utxi of store.utxis) this.owner.set(utxi, node);
            }
        }
    }

    /** Assigns an id to a lot/consumption (once) and resolves ownership for exchange/residual lots. */
    private register(obj: LotLike): void {
        if (this.lotId.has(obj)) return;
        const id = `n${this.lotId.size}`;
        this.lotId.set(obj, id);
        this.lotById.set(id, obj);

        if (obj instanceof ResidualUTXI || obj instanceof TerminalUTXO) this.owner.set(obj, obj.account);
        if (obj instanceof ExchangedUTXO) {
            this.owner.set(obj, obj.exchange.fromAccount);
            this.registerExchange(obj.exchange);
        }
        if (obj instanceof ExchangedUTXI) {
            this.owner.set(obj, obj.exchange.toAccount);
            this.registerExchange(obj.exchange);
        }
    }

    private registerExchange(exchange: Exchange): void {
        if (this.exchangeId.has(exchange)) return;
        const id = `x${this.exchangeId.size}`;
        this.exchangeId.set(exchange, id);
        this.exchangeById.set(id, exchange);
    }

    public idOf(lot: LotLike): string | undefined { return this.lotId.get(lot); }
    public ownerOf(lot: LotLike): AccountNode | undefined { return this.owner.get(lot); }
    public accountIdOf(node: AccountNode): string | undefined { return this.accountId.get(node); }
    public exchangeIdOf(exchange: Exchange): string | undefined { return this.exchangeId.get(exchange); }

    /** The index of the transaction whose outputs/inputs contain `lot`, or `null` if not found. */
    public transactionIndexOf(lot: LotLike, transactions: Transaction[], side: "input" | "output"): number | null {
        for (let i = 0; i < transactions.length; i++) {
            const pool = side === "input" ? transactions[i]!.inputs : transactions[i]!.outputs;
            if ((pool as LotLike[]).includes(lot)) return i;
        }
        return null;
    }
}
