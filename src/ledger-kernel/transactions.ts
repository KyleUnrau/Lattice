import type { Result } from "../utils.js";
import type { Position } from "./positions.js";
import { TXI, TXOConsumption, GroupedInput, type InputMapping, type StagedGroupedInput, type StagedTXI, type StagedTXOConsumption, type StagedInput, type Input } from "./transactions/inputs.js";
import { TXIConsumption, TXO, GroupedOutput, type OutputMapping, type StagedGroupedOutput, type StagedTXIConsumption, type StagedTXO, type StagedOutput, type Output } from "./transactions/outputs.js";

export class Transaction {
    public position: Position;

    public inputs: InputMapping;
    public outputs: OutputMapping;

    constructor(
        stagedInputs: StagedInput[],
        stagedOutputs: StagedOutput[],
    ) {
        const inputs: InputMapping = {
            txis: new Map(),
            txoConsumptions: new Map(),
            groupedInputs: new Map()
        };

        const outputs: OutputMapping = {
            txos: new Map(),
            txiConsumptions: new Map(),
            groupedOutputs: new Map()
        };
        
        const verification: Result<Position, Error> = this.verify(stagedInputs, stagedOutputs);
        if (!verification.ok) throw verification.error;

        this.position = verification.value;

        for (const stagedInput of stagedInputs) {
            if (stagedInput.stagedType === "txi") {
                if (inputs.txis.has(stagedInput)) throw new Error(`Cannot construct a transaction with two identical TXIs`);
                inputs.txis.set(stagedInput, this.generateTXI(stagedInput));
            } else if (stagedInput.stagedType === "txo-consumption") {
                if (inputs.txoConsumptions.has(stagedInput)) throw new Error(`Cannot construct a transaction with two identical TXO consumptions`);
                inputs.txoConsumptions.set(stagedInput, this.generateTXOConsumption(stagedInput));
            } else if (stagedInput.stagedType === "grouped-input") {
                if (inputs.groupedInputs.has(stagedInput)) throw new Error(`Cannot construct a transaction with two identical input groups`);
                inputs.groupedInputs.set(stagedInput, this.generateGroupedInput(stagedInput));
            } else throw new Error(`Unknown staged input type when processing inputs`);
        }

        for (const stagedOutput of stagedOutputs) {
            if (stagedOutput.stagedType === "txo") {
                if (outputs.txos.has(stagedOutput)) throw new Error(`Cannot construct a transaction with two identical TXOs`);
                outputs.txos.set(stagedOutput, this.generateTXO(stagedOutput));
            } else if (stagedOutput.stagedType === "txi-consumption") {
                if (outputs.txiConsumptions.has(stagedOutput)) throw new Error(`Cannot construct a transaction with two identical TXI consumptions`);
                outputs.txiConsumptions.set(stagedOutput, this.generateTXIConsumption(stagedOutput));
            } else if (stagedOutput.stagedType === "grouped-output") {
                if (outputs.groupedOutputs.has(stagedOutput)) throw new Error(`Cannot construct a transaction with two identical grouped output`);
                outputs.groupedOutputs.set(stagedOutput, this.generateGroupedOutput(stagedOutput));
            } else throw new Error(`Unknown staged output type when processing outputs`);
        }

        this.inputs = inputs;
        this.outputs = outputs;
    }

    public getInputFromStaged(stagedInput: StagedInput): Input {
        let result: Input | undefined;

        if (stagedInput.stagedType === "txi") result = this.inputs.txis.get(stagedInput);
        else if (stagedInput.stagedType === "txo-consumption") result = this.inputs.txoConsumptions.get(stagedInput);
        else if (stagedInput.stagedType === "grouped-input") result = this.inputs.groupedInputs.get(stagedInput);
        else throw new Error(`Unknown staged object type when attempting to get input from staged`);

        if (!result) throw new Error(`Could not find this input from this transaction`);

        return result;
    }

    public getOutputFromStaged(stagedOutput: StagedOutput): Output {
        let result: Output | undefined;

        if (stagedOutput.stagedType === "txo") result = this.outputs.txos.get(stagedOutput);
        else if (stagedOutput.stagedType === "txi-consumption") result = this.outputs.txiConsumptions.get(stagedOutput);
        else if (stagedOutput.stagedType === "grouped-output") result = this.outputs.groupedOutputs.get(stagedOutput);
        else throw new Error(`Unknown staged object type when attempting to get output from staged`);

        if (!result) throw new Error(`Could not find this output from this transaction`);

        return result;
    }

    private generateTXI(stagedTXI: StagedTXI): TXI {
        const input = new TXI(stagedTXI.quantity, stagedTXI.position, this);
        stagedTXI.accountEngine.txis.push(input);
        return input;
    }

    private generateTXO(stagedTXO: StagedTXO): TXO {
        const output = new TXO(stagedTXO.quantity, stagedTXO.position, this);
        stagedTXO.accountEngine.txos.push(output);
        return output;
    }

    private generateTXOConsumption(stagedTXOConsumption: StagedTXOConsumption): TXOConsumption {
        const input = new TXOConsumption(stagedTXOConsumption.quantity, stagedTXOConsumption.source, this);
        stagedTXOConsumption.source.consumptions.push(input);
        return input;
    }

    private generateTXIConsumption(StagedTXIConsumption: StagedTXIConsumption): TXIConsumption {
        const output = new TXIConsumption(StagedTXIConsumption.quantity, StagedTXIConsumption.source, this);
        StagedTXIConsumption.source.consumptions.push(output);
        return output;
    }

    private generateGroupedInput(stagedGroupedInput: StagedGroupedInput): GroupedInput {
        const childInputs: (TXI | TXOConsumption)[] = [];
        for (const childStagedInput of stagedGroupedInput.inputs) {
            if (childStagedInput.stagedType === "txi") childInputs.push(this.generateTXI(childStagedInput));
            else if (childStagedInput.stagedType === "txo-consumption") childInputs.push(this.generateTXOConsumption(childStagedInput));
            else throw new Error(`Unknown child staged object type when generating grouped input`);
        } return new GroupedInput(this, childInputs);
    }

    private generateGroupedOutput(stagedGroupedOutput: StagedGroupedOutput): GroupedOutput {
        const childOutputs: (TXO | TXIConsumption)[] = [];
        for (const childStagedOutput of stagedGroupedOutput.outputs) {
            if (childStagedOutput.stagedType === "txo") childOutputs.push(this.generateTXO(childStagedOutput));
            else if (childStagedOutput.stagedType === "txi-consumption") childOutputs.push(this.generateTXIConsumption(childStagedOutput));
            else throw new Error(`Unknown child staged object type when generating grouped output`);
        } return new GroupedOutput(this, childOutputs);
    }

    public verify(
        stagedInputs: (StagedGroupedInput | StagedTXI | StagedTXOConsumption)[],
        stagedOutputs: (StagedGroupedOutput | StagedTXO | StagedTXIConsumption)[]
    ): Result<Position, Error> {
        if (stagedInputs.length === 0 || stagedOutputs.length === 0) throw new Error("Cannot construct a transaction with no inputs or no outputs.");

        let inputsSum: number = 0;
        let outputsSum: number = 0;

        let position: Position | null = null;
        function verifyPosition(instancePosition: Position): void {
            if (!position) position = instancePosition;
            if (position !== instancePosition) throw new Error(`Mismatched positions included within a transaction, must all be tied to same position.`);
        }

        try {
            for (const stagedInput of stagedInputs) {
                if (stagedInput.stagedType === "grouped-input") {
                    for (const input of stagedInput.inputs) {
                        inputsSum += input.quantity;
                        verifyPosition(input.stagedType === "txi" ? input.position : input.source.position);
                    }
                } else {
                    inputsSum += stagedInput.quantity;
                    verifyPosition(stagedInput.stagedType === "txi" ? stagedInput.position : stagedInput.source.position);
                }
            }

            for (const stagedOutput of stagedOutputs) {
                if (stagedOutput.stagedType === "grouped-output") {
                    for (const output of stagedOutput.outputs) {
                        outputsSum += output.quantity;
                        verifyPosition(output.stagedType === "txo" ? output.position : output.source.position);
                    }
                } else {
                    outputsSum += stagedOutput.quantity;
                    verifyPosition(stagedOutput.stagedType === "txo" ? stagedOutput.position : stagedOutput.source.position);
                }
            }
        } catch (err: any) { return {ok: false, error: err instanceof Error ? err : new Error(err.toString())}; }

        if (!position) return {ok: false, error: new Error("An unexpected error occurred: verifyPosition broke an invariant.")};
        this.position = position;

        if (inputsSum !== outputsSum) return {ok: false, error: new Error(`Attempted to construct a transaction with inputs totalling ${inputsSum} and outputs totalling ${outputsSum}`)};

        return {ok: true, value: position};
    }
}