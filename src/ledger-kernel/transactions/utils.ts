import { assertPositionUnifiromity, unscale } from "../positions.js";
import { type Input, UTXOConsumption, UTXI } from "./inputs.js";
import type { Output } from "./outputs.js";


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
