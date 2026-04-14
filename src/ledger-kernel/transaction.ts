import { ExternalBasisResolver } from "../lot-engine/misc.js";
import { type Result, roundTo } from "../utils.js";
import { Account } from "./account.js";
import { Ledger } from "./ledger.js";

export interface Position {
    name: string;
    minimumIncrement: number;
    basisResolver: ExternalBasisResolver;
}

export interface AccountTransactionEntry {
    account: Account;
    position: Position;
    delta: number;
}

export interface TransactionFlow {
    from: FlowItem;
    to: FlowItem;
}

export interface FlowItem {
    account: Account;
    position: Position;
    quantity: number;
}

export class Transaction {
    constructor(
        public readonly date: Date,
        public readonly entries: AccountTransactionEntry[],
        public readonly flows: TransactionFlow[] = []
    ) { }

    public resolveOriginationClearingEntries(ledger: Ledger): Result<AccountTransactionEntry[], Error> {
        const entries: AccountTransactionEntry[] = [];

        for (const flow of this.flows) {
            const fromRootEffect = ledger.resolveRootEffect(flow.from.account, flow.from.quantity);
            if (!fromRootEffect.ok) return fromRootEffect;

            entries.push({
                account: ledger.originationClearing,
                position: flow.from.position,
                delta: -fromRootEffect.value
            });

            const toRootEffect = ledger.resolveRootEffect(flow.to.account, flow.to.quantity);
            if (!toRootEffect.ok) return toRootEffect;

            entries.push({
                account: ledger.originationClearing,
                position: flow.to.position,
                delta: toRootEffect.value
            });
        }

        return { ok: true, value: entries };
    }

    public resolveEffectiveEntries(ledger: Ledger): Result<AccountTransactionEntry[], Error> {
        const clearingEntries = this.resolveOriginationClearingEntries(ledger);
        if (!clearingEntries.ok) return clearingEntries;

        return {
            ok: true,
            value: [
                ...this.entries,
                ...clearingEntries.value
            ]
        };
    }

    public verifyBalance(ledger: Ledger): Result<undefined, Error> {
        const effectiveEntries = this.resolveEffectiveEntries(ledger);
        if (!effectiveEntries.ok) return effectiveEntries;

        const sums: Map<Position, number> = new Map();

        for (const entry of effectiveEntries.value) {
            const rootEffect = ledger.resolveRootEffect(entry.account, entry.delta);
            if (!rootEffect.ok) return rootEffect;

            sums.set(entry.position, (sums.get(entry.position) || 0) + rootEffect.value);
        }

        for (const [position, sum] of sums.entries()) {
            const roundedSum = roundTo(sum, position.minimumIncrement);

            if (roundedSum !== 0) {
                return {
                    ok: false,
                    error: new Error(
                        `Invalid transaction, sum of effective entries for ${position.name} is ${roundedSum} and not 0. ` +
                        `(Minimum increment: ${position.minimumIncrement})`
                    )
                };
            }
        }

        return { ok: true, value: undefined };
    }
}

export function constructTransaction(
    ledger: Ledger,
    date: Date,
    entries: AccountTransactionEntry[],
    flows: TransactionFlow[] = []
): Result<Transaction, Error> {
    const transaction = new Transaction(date, entries, flows);

    const verifyBalance = transaction.verifyBalance(ledger);
    return verifyBalance.ok
        ? { ok: true, value: transaction }
        : verifyBalance;
}