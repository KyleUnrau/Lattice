import type { Result } from "../utils.js";
import type { Position } from "./positions.js";
import { UTXI, UTXOConsumption, type Input } from "./transactions/inputs.js";
import { UTXIConsumption, UTXO, type Output } from "./transactions/outputs.js";

/**
 * An atomic, single-position accounting record. Enforces two structural invariants
 * at construction time — all inputs and outputs must share the same {@link Position},
 * and `sum(inputs) === sum(outputs)`. Throws immediately if either is violated.
 */
export class Transaction {
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

        let inputsSum: number = 0;
        let outputsSum: number = 0;

        let position: Position | null = null;
        function verifyPosition(instancePosition: Position): void {
            if (!position) position = instancePosition;
            if (position !== instancePosition) throw new Error(`Mismatched positions included within a transaction, must all be tied to same position.`);
        }

        try {
            for (const input of inputs) {
                if (input instanceof UTXOConsumption) {
                    if (input.source.calculateAvailable(transactions) < input.quantity) throw new Error(`Attempted to construct a transaction with a UTXOConsumption that appears to have been generated incorrectly and attempted to draw from a UTXO with an insufficient available balance`);
                }

                inputsSum += input.quantity;
                verifyPosition(input instanceof UTXI ? input.position : input.source.position);
            }

            for (const output of outputs) {
                if (output instanceof UTXIConsumption) {
                    if (output.source.calculateAvailable(transactions) < output.quantity) throw new Error(`Attempted to construct a transaction with a UTXIConsumption that appears to have been generated incorrectly and attempted to draw from a UTXI with an insufficient available balance`);
                }

                outputsSum += output.quantity;
                verifyPosition(output instanceof UTXO ? output.position : output.source.position);
            }
        } catch (err: any) { return {ok: false, error: err instanceof Error ? err : new Error(err.toString())}; }


        if (!position) return {ok: false, error: new Error("An unexpected error occurred: verifyPosition broke an invariant.")};
        this.position = position;

        if (inputsSum !== outputsSum) return {ok: false, error: new Error(`Attempted to construct a transaction with inputs totalling ${inputsSum} and outputs totalling ${outputsSum}`)};

        return {ok: true, value: position};
    }
}
