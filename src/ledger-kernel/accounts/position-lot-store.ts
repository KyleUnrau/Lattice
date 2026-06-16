import type { DisposalMethod } from "../disposal-methods/disposals.js";
import { type Position, scale } from "../positions.js";
import type { Transaction, TransactionLike } from "../transactions.js";
import { UTXI, type Input, type UTXOConsumption } from "../transactions/inputs.js";
import { UTXO, type Output, type UTXIConsumption } from "../transactions/outputs.js";


/**
 * Per-position lot store for a single {@link Account}. Holds the raw {@link UTXO} and
 * {@link UTXI} lists and implements the input/output generation logic using the account's
 * configured {@link DisposalMethod}s. Not instantiated directly — created on demand by
 * `Account.getLotStore`.
 */
export class PositionLotStore {
    public readonly utxos: UTXO[] = [];
    public readonly utxis: UTXI[] = [];

    constructor(
        public readonly position: Position,
        public readonly utxoDisposalMethod: DisposalMethod<UTXO>,
        public readonly utxiDisposalMethod: DisposalMethod<UTXI>
    ) { }

    public generateInputs(quantity: number | bigint, transactions: readonly TransactionLike[]): Input[] {
        const scaledQuantity: bigint = (typeof quantity === "number") ? scale(quantity, this.position) : quantity;
        return this.generateInputsScaled(scaledQuantity, transactions);
    }

    public generateInputsScaled(quantity: bigint, transactions: readonly TransactionLike[]): Input[] {
        if (quantity <= 0n) throw new Error(`Cannot input a non-positive number from an account`);

        // Only draw from lots that are committed (or staged into the provisional record passed in
        // `transactions`). This excludes stale uncommitted lots left behind by an abandoned
        // generation, which would otherwise read as available and let us consume phantom value.
        const availableUtxos: UTXO[] = this.utxos.filter(utxo => utxo.isCommitted(transactions));
        const outputTotal: bigint = availableUtxos.reduce((sum, utxo) => sum + utxo.calculateAvailable(transactions), 0n);
        const consumptionTotal: bigint = outputTotal < quantity ? outputTotal : quantity;
        const consumptionAmounts: Map<UTXO, bigint> | null = consumptionTotal !== 0n ? this.utxoDisposalMethod(availableUtxos, consumptionTotal, transactions) : null;

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

    public generateOutputs(quantity: number | bigint, transactions: readonly TransactionLike[]): Output[] {
        const scaledQuantity: bigint = (typeof quantity === "number") ? scale(quantity, this.position) : quantity;
        return this.generateOutputsScaled(scaledQuantity, transactions);
    }

    public generateOutputsScaled(quantity: bigint, transactions: readonly TransactionLike[]): Output[] {
        if (quantity <= 0n) throw new Error(`Cannot output a non-positive number from an account`);

        // Only settle UTXIs that are committed (or staged into the provisional record passed in
        // `transactions`), so a stale uncommitted obligation can't be settled against phantom value.
        const availableUtxis: UTXI[] = this.utxis.filter(utxi => utxi.isCommitted(transactions));
        const inputTotal: bigint = availableUtxis.reduce((sum, utxi) => sum + utxi.calculateAvailable(transactions), 0n);
        const consumptionTotal: bigint = inputTotal < quantity ? inputTotal : quantity;
        const consumptionAmounts: Map<UTXI, bigint> | null = consumptionTotal !== 0n ? this.utxiDisposalMethod(availableUtxis, consumptionTotal, transactions) : null;

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

    public getSignedBalanceScaled(transactions: Transaction[]): bigint {
        let balance = 0n;
        for (const utxi of this.utxis) if (utxi.isCommitted(transactions)) balance -= utxi.calculateAvailable(transactions);
        for (const utxo of this.utxos) if (utxo.isCommitted(transactions)) balance += utxo.calculateAvailable(transactions);
        return balance;
    }
}
