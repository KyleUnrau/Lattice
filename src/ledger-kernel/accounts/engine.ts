import type { DisposalMethod } from "../disposal-methods/disposals.js";
import { type Position, scale } from "../positions.js";
import type { Transaction } from "../transactions.js";
import { UTXI, type Input, type UTXOConsumption } from "../transactions/inputs.js";
import { UTXO, type Output, type UTXIConsumption } from "../transactions/outputs.js";


/**
 * Per-position lot store for a single {@link Account}. Holds the raw {@link UTXO} and
 * {@link UTXI} lists and implements the generation logic using the account's configured
 * {@link DisposalMethod}s. Not instantiated directly — created on demand by `Account.getEngine`.
 */

export class AccountEngine {
    public readonly utxos: UTXO[] = [];
    public readonly utxis: UTXI[] = [];

    constructor(
        public readonly position: Position,
        public readonly utxoDisposalMethod: DisposalMethod<UTXO>,
        public readonly utxiDisposalMethod: DisposalMethod<UTXI>
    ) { }

    public generateInputs(humanValue: number, transactions: Transaction[]): Input[] {
        return this.generateInputsRaw(scale(humanValue, this.position), transactions);
    }

    public generateInputsRaw(quantity: bigint, transactions: Transaction[]): Input[] {
        if (quantity <= 0n) throw new Error(`Cannot input a non-positive number from an account`);

        const outputTotal: bigint = this.utxos.reduce((sum, utxo) => sum + utxo.calculateAvailable(transactions), 0n);
        const consumptionTotal: bigint = outputTotal < quantity ? outputTotal : quantity;
        const consumptionAmounts: Map<UTXO, bigint> | null = consumptionTotal !== 0n ? this.utxoDisposalMethod(this.utxos, consumptionTotal, transactions) : null;

        let consumptionTotalVerification: bigint = 0n;
        const consumptions: UTXOConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([utxo, amount]: [UTXO, bigint]): UTXOConsumption => {
                consumptionTotalVerification += amount;
                return utxo.consume(amount, transactions);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The utxoDisposalMethod returned a delta of ${consumptionTotalVerification} which differs from the amount attempting to input of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0n) {
            const utxi: UTXI = new UTXI(remainder, this.position);
            this.utxis.push(utxi);
            return [...consumptions, utxi];
        } else return consumptions;
    }

    public generateOutputs(humanValue: number, transactions: Transaction[]): Output[] {
        return this.generateOutputsRaw(scale(humanValue, this.position), transactions);
    }

    public generateOutputsRaw(quantity: bigint, transactions: Transaction[]): Output[] {
        if (quantity <= 0n) throw new Error(`Cannot output a non-positive number from an account`);

        const inputTotal: bigint = this.utxis.reduce((sum, utxi) => sum + utxi.calculateAvailable(transactions), 0n);
        const consumptionTotal: bigint = inputTotal < quantity ? inputTotal : quantity;
        const consumptionAmounts: Map<UTXI, bigint> | null = consumptionTotal !== 0n ? this.utxiDisposalMethod(this.utxis, consumptionTotal, transactions) : null;

        let consumptionTotalVerification: bigint = 0n;
        const consumptions: UTXIConsumption[] = consumptionAmounts ? Array.from(consumptionAmounts.entries()).map(
            ([utxi, amount]: [UTXI, bigint]): UTXIConsumption => {
                consumptionTotalVerification += amount;
                return utxi.consume(amount, transactions);
            }
        ) : [];

        if (consumptionTotalVerification !== consumptionTotal) throw new Error(`The utxiDisposalMethod returned a delta of ${consumptionTotalVerification} which differs from the amount attempting to output of ${consumptionTotal}`);

        const remainder = quantity - consumptionTotal;
        if (remainder > 0n) {
            const utxo: UTXO = new UTXO(remainder, this.position);
            this.utxos.push(utxo);
            return [...consumptions, utxo];
        } else return consumptions;
    }

    public getRootBalance(transactions: Transaction[]): bigint {
        let rootBalance = 0n;
        for (const utxi of this.utxis) if (utxi.isCommitted(transactions)) rootBalance -= utxi.calculateAvailable(transactions);
        for (const utxo of this.utxos) if (utxo.isCommitted(transactions)) rootBalance += utxo.calculateAvailable(transactions);
        return rootBalance;
    }
}
