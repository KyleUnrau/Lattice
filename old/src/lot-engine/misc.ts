import type { Result } from "../utils.js";
import {
    Transaction,
    Position,
    AccountTransactionEntry,
    TransactionFlow,
} from "../ledger-kernel/transaction.js";
import { Account } from "../ledger-kernel/account.js";
import { Ledger } from "../ledger-kernel/ledger.js";

type BasisCosts = Map<Position, number>;

export interface Lot {
    quantity: number;
    basis: BasisCosts;
}

export interface LotDisposal {
    quantity: number;
    basis: BasisCosts;
}

export interface ExternalBasisResolver {
    resolveAccountAcquisitionBasis(
        transaction: Transaction,
        entry: AccountTransactionEntry
    ): Result<BasisCosts, Error>;

    resolveDisposalAllocation(
        lots: readonly Lot[],
        disposeQuantity: number
    ): Map<Lot, number>;
}

export class LotEngine {
    public lots: Map<Account, Map<Position, Lot[]>>;

    constructor(public readonly ledger: Ledger) {
        const built = LotEngine.build(ledger);
        if (!built.ok) throw built.error;

        this.lots = built.value;
    }

    public static build(
        ledger: Ledger
    ): Result<Map<Account, Map<Position, Lot[]>>, Error> {
        const lots = new Map<Account, Map<Position, Lot[]>>();

        for (const transaction of ledger.transactions) {
            const applied = this.applyTransaction(lots, transaction);
            if (!applied.ok) return applied;
        }

        return { ok: true, value: lots };
    }

    public static applyTransaction(
        lots: Map<Account, Map<Position, Lot[]>>,
        transaction: Transaction
    ): Result<undefined, Error> {
        const matched = this.buildMatchedEntryDeltas(transaction);

        for (const flow of transaction.flows) {
            const applied = this.applyFlow(lots, flow);
            if (!applied.ok) return applied;
        }

        for (const entry of transaction.entries) {
            const remainingDelta = this.getRemainingEntryDelta(matched, entry);

            if (Math.abs(remainingDelta) < entry.position.minimumIncrement / 2) continue;

            if (remainingDelta < 0) {
                const disposed = this.applyEntryDisposal(
                    lots,
                    entry.account,
                    entry.position,
                    -remainingDelta
                );
                if (!disposed.ok) return disposed;
            } else {
                const acquired = this.applyEntryAcquisition(
                    lots,
                    transaction,
                    {
                        account: entry.account,
                        position: entry.position,
                        delta: remainingDelta
                    }
                );
                if (!acquired.ok) return acquired;
            }
        }

        return { ok: true, value: undefined };
    }

    public static applyFlow(
        lots: Map<Account, Map<Position, Lot[]>>,
        flow: TransactionFlow
    ): Result<undefined, Error> {
        const sourceLots = this.getLots(lots, flow.from.account, flow.from.position);

        const disposal = this.applyDisposal(
            sourceLots,
            flow.from.quantity,
            flow.from.position.minimumIncrement,
            flow.from.position.basisResolver
        );
        if (!disposal.ok) return disposal;

        const transferredBasis = this.sumBasisCosts(disposal.value);

        return this.createLot(
            lots,
            flow.to.account,
            flow.to.position,
            flow.to.quantity,
            transferredBasis
        );
    }

    public static applyEntryDisposal(
        lots: Map<Account, Map<Position, Lot[]>>,
        account: Account,
        position: Position,
        disposeQuantity: number
    ): Result<Map<Lot, LotDisposal>, Error> {
        const holdingLots = this.getLots(lots, account, position);

        return this.applyDisposal(
            holdingLots,
            disposeQuantity,
            position.minimumIncrement,
            position.basisResolver
        );
    }

    public static applyEntryAcquisition(
        lots: Map<Account, Map<Position, Lot[]>>,
        transaction: Transaction,
        entry: AccountTransactionEntry
    ): Result<undefined, Error> {
        const basis = entry.position.basisResolver.resolveAccountAcquisitionBasis(
            transaction,
            entry
        );
        if (!basis.ok) return basis;

        return this.createLot(
            lots,
            entry.account,
            entry.position,
            entry.delta,
            basis.value
        );
    }

    public static applyDisposal(
        lots: readonly Lot[],
        disposeQuantity: number,
        minimumIncrement: number,
        basisResolver: ExternalBasisResolver
    ): Result<Map<Lot, LotDisposal>, Error> {
        if (disposeQuantity <= 0) {
            return {
                ok: false,
                error: new Error(
                    `Disposal quantity must be greater than 0, got ${disposeQuantity}`
                )
            };
        }

        const allocations = basisResolver.resolveDisposalAllocation(
            lots,
            disposeQuantity
        );

        const disposals = new Map<Lot, LotDisposal>();
        let totalDisposed = 0;

        for (const [lot, quantityConsumed] of allocations) {
            if (quantityConsumed <= 0) {
                return {
                    ok: false,
                    error: new Error(
                        `Disposal allocation returned non-positive quantity ${quantityConsumed}`
                    )
                };
            }

            if (quantityConsumed > lot.quantity) {
                return {
                    ok: false,
                    error: new Error(
                        "Disposal allocation attempted to consume more than a lot contains."
                    )
                };
            }

            const proportion = quantityConsumed / lot.quantity;
            const basisDisposed: BasisCosts = new Map();

            for (const [position, amount] of lot.basis) {
                const consumedBasis = amount * proportion;
                basisDisposed.set(position, consumedBasis);
                lot.basis.set(position, amount - consumedBasis);
            }

            lot.quantity -= quantityConsumed;
            totalDisposed += quantityConsumed;

            disposals.set(lot, {
                quantity: quantityConsumed,
                basis: basisDisposed
            });
        }

        if (Math.abs(totalDisposed - disposeQuantity) > minimumIncrement / 2) {
            return {
                ok: false,
                error: new Error(
                    `Disposal allocation mismatch. Expected ${disposeQuantity}, got ${totalDisposed}.`
                )
            };
        }

        return { ok: true, value: disposals };
    }

    public static createLot(
        lots: Map<Account, Map<Position, Lot[]>>,
        account: Account,
        position: Position,
        quantity: number,
        basis: BasisCosts
    ): Result<undefined, Error> {
        if (quantity <= 0) {
            return {
                ok: false,
                error: new Error(
                    `Cannot create a lot with non-positive quantity ${quantity}`
                )
            };
        }

        const holdingLots = this.getLots(lots, account, position);

        holdingLots.push({
            quantity,
            basis: this.cloneBasisCosts(basis)
        });

        return { ok: true, value: undefined };
    }

    public static getLots(
        lots: Map<Account, Map<Position, Lot[]>>,
        account: Account,
        position: Position
    ): Lot[] {
        if (!lots.has(account)) lots.set(account, new Map());

        const accountLots = lots.get(account)!;
        if (!accountLots.has(position)) accountLots.set(position, []);

        return accountLots.get(position)!;
    }

    public static cloneBasisCosts(basis: BasisCosts): BasisCosts {
        return new Map(basis);
    }

    public static sumBasisCosts(disposals: Map<Lot, LotDisposal>): BasisCosts {
        const total: BasisCosts = new Map();

        for (const [, disposal] of disposals) {
            for (const [position, amount] of disposal.basis) {
                total.set(position, (total.get(position) || 0) + amount);
            }
        }

        return total;
    }

    /**
     * Deep-clones a lot map so that prospective reads can operate on the clone
     * without mutating the engine's live state.
     */
    public static deepCloneLots(
        lots: Map<Account, Map<Position, Lot[]>>
    ): Map<Account, Map<Position, Lot[]>> {
        const clone = new Map<Account, Map<Position, Lot[]>>();

        for (const [account, positionMap] of lots) {
            const clonedPositionMap = new Map<Position, Lot[]>();

            for (const [position, lotList] of positionMap) {
                clonedPositionMap.set(
                    position,
                    lotList.map(lot => ({
                        quantity: lot.quantity,
                        basis: new Map(lot.basis),
                    }))
                );
            }

            clone.set(account, clonedPositionMap);
        }

        return clone;
    }

    /**
     * Prospectively resolves the basis that would be consumed by a flow,
     * given a lot map snapshot, without mutating any state.
     *
     * Returns the summed BasisCosts that would transfer from flow.from to
     * flow.to if this flow were applied now.
     */
    public static resolveFlowBasis(
        lots: Map<Account, Map<Position, Lot[]>>,
        flow: TransactionFlow
    ): Result<BasisCosts, Error> {
        // Work on a clone so we never touch live lot state.
        const scratch = this.deepCloneLots(lots);
        const sourceLots = this.getLots(scratch, flow.from.account, flow.from.position);

        const disposal = this.applyDisposal(
            sourceLots,
            flow.from.quantity,
            flow.from.position.minimumIncrement,
            flow.from.position.basisResolver
        );
        if (!disposal.ok) return disposal;

        return { ok: true, value: this.sumBasisCosts(disposal.value) };
    }

    /**
     * Instance-level convenience wrapper around the static resolveFlowBasis,
     * operating against this engine's current lot state.
     */
    public resolveFlowBasis(flow: TransactionFlow): Result<BasisCosts, Error> {
        return LotEngine.resolveFlowBasis(this.lots, flow);
    }

    private static buildMatchedEntryDeltas(
        transaction: Transaction
    ): Map<AccountTransactionEntry, number> {
        const matched = new Map<AccountTransactionEntry, number>();

        for (const entry of transaction.entries) matched.set(entry, 0);

        for (const flow of transaction.flows) {
            this.consumeMatch(
                matched,
                transaction.entries,
                flow.from.account,
                flow.from.position,
                -flow.from.quantity
            );

            this.consumeMatch(
                matched,
                transaction.entries,
                flow.to.account,
                flow.to.position,
                flow.to.quantity
            );
        }

        return matched;
    }

    private static consumeMatch(
        matched: Map<AccountTransactionEntry, number>,
        entries: AccountTransactionEntry[],
        account: Account,
        position: Position,
        delta: number
    ): void {
        let remaining = delta;

        for (const entry of entries) {
            if (remaining === 0) break;
            if (entry.account !== account) continue;
            if (entry.position !== position) continue;

            const alreadyMatched = matched.get(entry) || 0;
            const available = entry.delta - alreadyMatched;

            if (delta < 0) {
                if (available >= 0) continue;

                const consume = Math.max(available, remaining);
                matched.set(entry, alreadyMatched + consume);
                remaining -= consume;
            } else {
                if (available <= 0) continue;

                const consume = Math.min(available, remaining);
                matched.set(entry, alreadyMatched + consume);
                remaining -= consume;
            }
        }
    }

    private static getRemainingEntryDelta(
        matched: Map<AccountTransactionEntry, number>,
        entry: AccountTransactionEntry
    ): number {
        return entry.delta - (matched.get(entry) || 0);
    }
}

/*
    Example FIFO resolver.
*/
export class FifoBasisResolver implements ExternalBasisResolver {
    public resolveDisposalAllocation(
        lots: readonly Lot[],
        disposeQuantity: number
    ): Map<Lot, number> {
        const result = new Map<Lot, number>();

        let remaining = disposeQuantity;

        for (const lot of lots) {
            if (remaining <= 0) break;
            if (lot.quantity <= 0) continue;

            const consume = Math.min(lot.quantity, remaining);
            if (consume > 0) {
                result.set(lot, consume);
                remaining -= consume;
            }
        }

        return result;
    }

    public resolveAccountAcquisitionBasis(
        _transaction: Transaction,
        entry: AccountTransactionEntry
    ): Result<BasisCosts, Error> {
        const basis: BasisCosts = new Map();
        basis.set(entry.position, entry.delta);

        return { ok: true, value: basis };
    }
}