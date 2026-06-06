import { UTXOConsumption, type Input } from "../transactions/inputs.js";
import type { UTXO } from "../transactions/outputs.js";

/**
 * Extracts {@link UTXOConsumption} inputs from a mixed input array, returning each as a
 * `{ source, quantity }` pair suitable for {@link computeRecaptureResolution}.
 * Non-consumption inputs (exchange inputs, origin UTXIs) are silently ignored.
 */
export function consumedUTXOsFromInputs(inputs: Input[]): { source: UTXO; quantity: number }[] {
    return inputs.filter((i): i is UTXOConsumption => i instanceof UTXOConsumption)
        .map(c => ({ source: c.source, quantity: c.quantity }));
}