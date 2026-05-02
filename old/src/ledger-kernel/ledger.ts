import { Position, Transaction, AccountTransactionEntry } from "./transaction.js";
import type { Result } from "../utils.js";
import { Account, AccountFolder, LedgerNode, Orientation } from "./account.js";

export class Ledger {
    constructor(
        public nodes: LedgerNode[],
        public originationClearing: Account,
        public transactions: Transaction[] = []
    ) { }

    public resolveRootOrientation(
        node: LedgerNode | undefined,
        nodes: LedgerNode[] = this.nodes,
        parentOrientation: Orientation = Orientation.Positive
    ): Result<Orientation, Error> {
        if (node === undefined) return { ok: true, value: parentOrientation };

        for (const n of nodes) {
            if (n === node) return { ok: true, value: n.orientation * parentOrientation };

            if (n instanceof AccountFolder) {
                const childResult = this.resolveRootOrientation(
                    node,
                    n.children,
                    n.orientation * parentOrientation
                );

                if (childResult.ok) return childResult;
            }
        }

        return {
            ok: false,
            error: new Error(`Could not find the node "${node.name}" within the ledger.`)
        };
    }

    public resolveRootEffect(node: LedgerNode, delta: number): Result<number, Error> {
        const rootOrientation = this.resolveRootOrientation(node);
        if (!rootOrientation.ok) return rootOrientation;

        return { ok: true, value: rootOrientation.value * delta };
    }

    public resolveRootEffects(
        node: LedgerNode,
        balances: Map<Position, number>
    ): Result<Map<Position, number>, Error> {
        const rootOrientation = this.resolveRootOrientation(node);
        if (!rootOrientation.ok) return rootOrientation;

        const value = new Map<Position, number>();

        for (const [position, balance] of balances) {
            value.set(position, rootOrientation.value * balance);
        }

        return { ok: true, value };
    }

    public getTransactionEntries(transaction: Transaction): Result<AccountTransactionEntry[], Error> {
        return transaction.resolveEffectiveEntries(this);
    }

    public getAccountBalances(account: Account): Result<Map<Position, number>, Error> {
        const balances = new Map<Position, number>();

        for (const transaction of this.transactions) {
            const entries = this.getTransactionEntries(transaction);
            if (!entries.ok) return entries;

            for (const entry of entries.value) {
                if (entry.account !== account) continue;

                balances.set(
                    entry.position,
                    (balances.get(entry.position) || 0) + entry.delta
                );
            }
        }

        return { ok: true, value: balances };
    }

    public getAccountRootEffects(account: Account): Result<Map<Position, number>, Error> {
        const balances = this.getAccountBalances(account);
        if (!balances.ok) return balances;

        return this.resolveRootEffects(account, balances.value);
    }

    public getRootEffects(node?: LedgerNode): Result<Map<Position, number>, Error> {
        if (node instanceof Account) return this.getAccountRootEffects(node);

        const rootEffects = new Map<Position, number>();
        const children = node === undefined ? this.nodes : node.children;

        for (const child of children) {
            const childRootEffects = this.getRootEffects(child);
            if (!childRootEffects.ok) return childRootEffects;

            for (const [position, balance] of childRootEffects.value) {
                rootEffects.set(
                    position,
                    (rootEffects.get(position) || 0) + balance
                );
            }
        }

        return { ok: true, value: rootEffects };
    }

    public getBalances(node?: LedgerNode): Result<Map<Position, number>, Error> {
        const rootEffects = this.getRootEffects(node);
        if (!rootEffects.ok) return rootEffects;

        const rootOrientation = this.resolveRootOrientation(node);
        if (!rootOrientation.ok) return rootOrientation;

        const value = new Map<Position, number>();

        for (const [position, rootEffect] of rootEffects.value) {
            value.set(position, rootEffect * rootOrientation.value);
        }

        return { ok: true, value };
    }
}