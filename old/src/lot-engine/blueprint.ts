import { type Result, roundTo } from "../utils.js";
import {
    Position,
    AccountTransactionEntry,
    TransactionFlow,
    Transaction,
    constructTransaction,
} from "../ledger-kernel/transaction.js";
import { Account } from "../ledger-kernel/account.js";
import { Ledger } from "../ledger-kernel/ledger.js";
import { LotEngine } from "./misc.js";

/**
 * A derived entry is a ledger entry whose delta is not known at blueprint
 * authoring time.  Instead of supplying a hard-coded number, the author
 * declares *how* the delta should be computed once lot-engine state is
 * available.
 */
export interface DerivedEntry {
    account: Account;
    position: Position;
    derivation: Derivation;
}

/**
 * Union of all supported derivation strategies.  New strategies can be added
 * here without touching the rest of the transaction or ledger kernel.
 */
export type Derivation = BasisRemainderDerivation;

/**
 * The delta for this entry equals:
 *
 *   (proceeds received in `proceedsPosition`)
 *   minus
 *   (cost basis consumed from `flow.from`, expressed in `proceedsPosition`)
 *
 * In other words: the entry absorbs the gain or loss that arises when the
 * quantity disposed of via `flow` is compared to the proceeds recorded
 * elsewhere in the transaction.
 *
 * `flow`            — the TransactionFlow whose "from" side is being disposed.
 *                     Must also appear in `TransactionBlueprint.flows`.
 *
 * `proceedsPosition` — the position in which proceeds are denominated.
 *                      The basis consumed will be looked up under this same
 *                      position key, so the two are directly comparable.
 *
 * `proceedsQuantity` — the gross proceeds received for the disposed units
 *                      (i.e. the `flow.to.quantity` value, or whatever
 *                      explicit amount represents the consideration received).
 *                      Provided explicitly so that the derivation is
 *                      self-contained and does not need to re-parse entries.
 *
 * Example — sell 40 oranges, receive CAD 160, account for gain/loss:
 *
 *   derivation: {
 *     kind: "basis-remainder",
 *     flow: { from: inventory/oranges/40, to: cash/cad/160 },
 *     proceedsPosition: cad,
 *     proceedsQuantity: 160,
 *   }
 *
 * If the 40 oranges cost CAD 17.38 in basis, the derived delta will be
 * 160 − 17.38 = 142.62.  A positive value means a gain (credit to the
 * gain/loss account); a negative value means a loss (debit).
 */
export interface BasisRemainderDerivation {
    kind: "basis-remainder";
    flow: TransactionFlow;
    proceedsPosition: Position;
    proceedsQuantity: number;
}

/**
 * A blueprint is the author-facing description of a transaction that may
 * contain entries whose amounts depend on lot-engine state.
 *
 * `entries`        — explicit, fully-stated ledger entries (same as today).
 * `derivedEntries` — entries whose delta will be computed at resolution time.
 * `flows`          — position/basis linkages between entries (same as today).
 *
 * All three collections refer to the *same* logical transaction.  A blueprint
 * with no derivedEntries is equivalent to calling constructTransaction()
 * directly.
 */
export interface TransactionBlueprint {
    date: Date;
    entries: AccountTransactionEntry[];
    derivedEntries: DerivedEntry[];
    flows: TransactionFlow[];
}

/**
 * Resolves a single DerivedEntry against the current lot-engine snapshot,
 * returning a concrete AccountTransactionEntry.
 *
 * The lot map passed in must already reflect all prior committed transactions
 * but must NOT yet reflect the transaction being constructed (because the
 * disposal described by the derivation has not happened yet).
 */
function resolveDerivedEntry(
    lotEngine: LotEngine,
    derived: DerivedEntry
): Result<AccountTransactionEntry, Error> {
    const { derivation } = derived;

    switch (derivation.kind) {
        case "basis-remainder": {
            // Ask the lot engine: "if I disposed flow.from right now, what
            // basis (in each position) would I consume?"  This is a read-only
            // prospective query — it does not mutate the engine's state.
            const basisResult = lotEngine.resolveFlowBasis(derivation.flow);
            if (!basisResult.ok) return basisResult;

            const consumedBasis = basisResult.value.get(derivation.proceedsPosition) ?? 0;
            const delta = derivation.proceedsQuantity - consumedBasis;

            return {
                ok: true,
                value: {
                    account: derived.account,
                    position: derived.position,
                    delta,
                },
            };
        }

        // Exhaustiveness guard — TypeScript will error here if a new
        // Derivation variant is added without a matching case.
        default: {
            const _exhaustive = derivation;
            return {
                ok: false,
                error: new Error(
                    `Unknown derivation kind: ${(_exhaustive as Derivation).kind}`
                ),
            };
        }
    }
}

/**
 * Constructs a concrete, balance-verified Transaction from a blueprint.
 *
 * Steps:
 *   1. Resolve each DerivedEntry against the lot engine's current state.
 *   2. Merge the resulting concrete entries with the blueprint's explicit
 *      entries.
 *   3. Delegate to constructTransaction() for origination-clearing
 *      derivation and balance verification — exactly as a manually
 *      authored transaction would be.
 *
 * The lot engine's state is NOT mutated.  The caller is responsible for
 * committing the returned Transaction to the ledger and rebuilding / updating
 * the engine if required.
 */
export function constructTransactionFromBlueprint(
    ledger: Ledger,
    lotEngine: LotEngine,
    blueprint: TransactionBlueprint
): Result<Transaction, Error> {
    const resolvedDerived: AccountTransactionEntry[] = [];

    for (const derived of blueprint.derivedEntries) {
        const resolved = resolveDerivedEntry(lotEngine, derived);
        if (!resolved.ok) return resolved;
        resolvedDerived.push(resolved.value);
    }

    const allEntries: AccountTransactionEntry[] = [
        ...blueprint.entries,
        ...resolvedDerived,
    ];

    return constructTransaction(ledger, blueprint.date, allEntries, blueprint.flows);
}