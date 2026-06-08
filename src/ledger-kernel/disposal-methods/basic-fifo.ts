import { UTXO } from "../transactions/outputs.js";
import { UTXI } from "../transactions/inputs.js";
import type { Transaction } from "../transactions.js";

/**
 * First-in-first-out {@link DisposalMethod}. Consumes the oldest available lots first,
 * iterating through `components` in order until `quantity` is fully satisfied.
 * Throws if the available total across all components is less than `quantity`.
 */
export const fifo = <T extends UTXO | UTXI>(
    components: T[],
    quantity: bigint,
    transactions: Transaction[]
): Map<T, bigint> => {
    if (quantity < 0n) throw new Error(`Attempted to invoke FIFO disposal method with a negative quantity`);

    const result = new Map<T, bigint>();
    let remainingQuantity = quantity;

    for (const component of components) {
        const available = component.calculateAvailable(transactions);

        const consume = available < remainingQuantity ? available : remainingQuantity;
        remainingQuantity -= consume;
        if (consume > 0n) result.set(component, consume);

        if (remainingQuantity <= 0n) break;
    }

    if (remainingQuantity !== 0n) throw new Error(`FIFO disposal method encountered an error, finishing with a remaining quantity of ${remainingQuantity}. Should only be invoked with a quantity delta less than sum of available amounts in components.`);

    return result;
};
