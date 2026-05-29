import type { Result } from "../utils.js";
import type { Position } from "./positions.js";
import { TXI, TXOConsumption, type Input } from "./transactions/inputs.js";
import { TXIConsumption, TXO, type Output } from "./transactions/outputs.js";

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
                if (input instanceof TXOConsumption) {
                    if (input.source.calculateAvailable(transactions) < input.quantity) throw new Error(`Attempted to construct a transaction with a TXO consumption object that appears to have been generated incorrectly and attempted to draw from a TXO with an insufficient available balance`);
                }

                inputsSum += input.quantity;
                verifyPosition(input instanceof TXI ? input.position : input.source.position);
            }

            for (const output of outputs) {
                if (output instanceof TXIConsumption) {
                    if (output.source.calculateAvailable(transactions) < output.quantity) throw new Error(`Attempted to construct a transaction with a TXI consumption object that appears to have been generated incorrectly and attempted to draw from a TXI with an insufficient available balance`);
                }
                
                outputsSum += output.quantity;
                verifyPosition(output instanceof TXO ? output.position : output.source.position);
            }
        } catch (err: any) { return {ok: false, error: err instanceof Error ? err : new Error(err.toString())}; }


        if (!position) return {ok: false, error: new Error("An unexpected error occurred: verifyPosition broke an invariant.")};
        this.position = position;

        if (inputsSum !== outputsSum) return {ok: false, error: new Error(`Attempted to construct a transaction with inputs totalling ${inputsSum} and outputs totalling ${outputsSum}`)};

        return {ok: true, value: position};
    }
}