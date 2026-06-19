import type { Result } from "../utils.js";
import { assertPositionUnifiromity, unscale, type Position } from "./positions.js";
import { UTXI, UTXOConsumption, type Input } from "./transactions/inputs.js";
import { UTXIConsumption, UTXO, type Output } from "./transactions/outputs.js";

/**
 * The minimal, structural shape of a transaction needed to compute lot availability — just
 * the `inputs` and `outputs` lists. {@link Transaction} implements it, but a provisional,
 * unverified `{ inputs, outputs }` record can also stand in. This lets generation account for
 * pending-but-not-yet-committed consumptions (see {@link GenerationContext}) without
 * constructing a real {@link Transaction}, which would require a balanced set of entries.
 */
export interface TransactionLike {
    inputs: Input[];
    outputs: Output[];
}

/**
 * An atomic, single-position accounting record. Enforces two structural invariants
 * at construction time — all inputs and outputs must share the same {@link Position},
 * and `sum(inputs) === sum(outputs)`. Throws immediately if either is violated.
 */
export class Transaction implements TransactionLike {
    public position: Position;

    public inputs: Input[];
    public outputs: Output[];

    constructor(
        inputs: Input[],
        outputs: Output[],
        transactions: Transaction[]
    ) {
        const verification: Result<Position, Error> = this.verify(inputs, outputs, transactions);
        if (!verification.ok) throw verification.error;

        this.position = verification.value;

        this.inputs = inputs;
        this.outputs = outputs;
    }

    /**
     * Validates inputs and outputs before committing them to the transaction.
     * Checks position homogeneity, balance equality, and that every consumption
     * references a source with sufficient remaining availability.
     * Returns the shared {@link Position} on success.
     */
    public verify(
        inputs: Input[],
        outputs: Output[],
        transactions: Transaction[]
    ): Result<Position, Error> {
        if (inputs.length === 0 || outputs.length === 0) throw new Error("Cannot construct a transaction with no inputs or no outputs.");

        let inputsSum: bigint = 0n;
        let outputsSum: bigint = 0n;

        let position: Position | null = null;
        function verifyPosition(instancePosition: Position): void {
            if (!position) position = instancePosition;
            if (position !== instancePosition) throw new Error(`Mismatched positions included within a transaction, must all be tied to same position.`);
        }

        // Over-consumption must be checked per-source in aggregate, not per-consumption: two
        // consumptions of the same lot can each individually fit within its balance yet together
        // exceed it (double-spend within one transaction). Sum each source's draws, then compare
        // the total against the lot's availability in the committed history.
        const utxoDraws = new Map<UTXO, bigint>();
        const utxiDraws = new Map<UTXI, bigint>();

        try {
            for (const input of inputs) {
                if (input instanceof UTXOConsumption) utxoDraws.set(input.source, (utxoDraws.get(input.source) ?? 0n) + input.quantity);

                inputsSum += input.quantity;
                verifyPosition(input instanceof UTXI ? input.position : input.source.position);
            }

            for (const output of outputs) {
                if (output instanceof UTXIConsumption) utxiDraws.set(output.source, (utxiDraws.get(output.source) ?? 0n) + output.quantity);

                outputsSum += output.quantity;
                verifyPosition(output instanceof UTXO ? output.position : output.source.position);
            }

            for (const [utxo, drawn] of utxoDraws) {
                if (utxo.calculateAvailable(transactions) < drawn) throw new Error(`Attempted to construct a transaction whose UTXOConsumptions draw ${drawn} from a UTXO with only ${utxo.calculateAvailable(transactions)} available — the inputs appear to have been generated incorrectly and over-consume the lot`);
            }

            for (const [utxi, drawn] of utxiDraws) {
                if (utxi.calculateAvailable(transactions) < drawn) throw new Error(`Attempted to construct a transaction whose UTXIConsumptions draw ${drawn} from a UTXI with only ${utxi.calculateAvailable(transactions)} available — the outputs appear to have been generated incorrectly and over-consume the lot`);
            }
        } catch (err: any) { return {ok: false, error: err instanceof Error ? err : new Error(err.toString())}; }


        if (!position) return {ok: false, error: new Error("An unexpected error occurred: verifyPosition broke an invariant.")};
        this.position = position;

        if (inputsSum !== outputsSum) return {ok: false, error: new Error(`Attempted to construct a transaction with inputs totalling ${inputsSum} and outputs totalling ${outputsSum}`)};

        return {ok: true, value: position};
    }
}

/**
 * A read-only, recursive **overlay** that records which committed {@link Transaction}s form one
 * business event, and what role each plays. A single economic action — an exchange, an expense,
 * or a composite "split this draw into an expense and an exchange" — typically lands as several
 * atomic, single-position transactions; the kernel's flat history erases the link between them.
 * A `TransactionGroup` re-annotates that link *without altering the history*.
 *
 * **It is not authoritative.** The flat `Ledger.transactions` array remains the single source of
 * truth for lot availability, cost-basis lineage, and `Ledger.verify()`. A group only holds
 * references — by identity — to transactions already in that array, so it can never change
 * availability, lineage, or commit order. Removing every group would leave the ledger's mechanics
 * untouched.
 *
 * Build one from a resolution's transactions via `toGroup(...)`, or compose several with
 * `Ledger.beginEvent(...)`; commit one with `Ledger.record(...)`.
 */
export class TransactionGroup {
    constructor(
        public readonly members: (Transaction | TransactionGroup)[]
    ) { }

    /**
     * The group's leaf {@link Transaction}s in depth-first order — exactly the sequence committed
     * to the ledger. This is the single source of truth for member ordering: a resolution wrapper's
     * own `flatten()` delegates here so the two can never drift.
     */
    public flatten(): Transaction[] {
        return this.members.flatMap(member => member instanceof TransactionGroup ? member.flatten() : [member]);
    }
}

/** Sums the quantities of `nodes` in smallest-unit `bigint`, asserting position uniformity. */
export function sumNodeQuantityScaled(nodes: Input[] | Output[]): bigint {
    assertPositionUnifiromity(nodes);
    return nodes.reduce((sum, o) => sum + o.quantity, 0n);
}

/**
 * Splits `inputs` at the `quantity` boundary into `[taken, rest]` where `taken` sums to exactly
 * `quantity` (assuming `quantity ≤ sum(inputs)`) and `rest` holds the remainder. A node straddling
 * the boundary is divided into two fresh nodes of the same kind/source. Used to carve a consumed
 * draw into independent sub-flows (e.g. the lost portion of a losing exchange, expensed to origin,
 * versus the proceeds-backing portion).
 */
export function splitInputs(inputs: Input[], quantity: bigint): [Input[], Input[]] {
    const taken: Input[] = [];
    const rest: Input[] = [];
    let remaining = quantity;

    for (const input of inputs) {
        if (remaining <= 0n) { rest.push(input); continue; }
        if (input.quantity <= remaining) { taken.push(input); remaining -= input.quantity; continue; }

        // This node straddles the boundary — divide it.
        const head = remaining;
        const tail = input.quantity - remaining;
        if (input instanceof UTXOConsumption) {
            taken.push(new UTXOConsumption(head, input.source));
            rest.push(new UTXOConsumption(tail, input.source));
        } else {
            taken.push(new UTXI(head, input.position));
            rest.push(new UTXI(tail, input.position));
        }
        remaining = 0n;
    }

    return [taken, rest];
}

/** Sums the quantities of `nodes` as a human-readable `number`, asserting position uniformity. */
export function sumNodeQuantity(nodes: Input[] | Output[]): number {
    const position = assertPositionUnifiromity(nodes);
    return unscale(sumNodeQuantityScaled(nodes), position);
}