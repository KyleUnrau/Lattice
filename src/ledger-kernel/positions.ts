import { UTXI, type Input } from "./transactions/inputs.js";
import { UTXO, type Output } from "./transactions/outputs.js";

/**
 * Any tracked quantity — currency, commodity, crypto asset, or anything else measurable.
 * `decimals` is the base-10 exponent of the smallest tradable unit (e.g. 2 for cents,
 * 8 for satoshis). All quantities stored in the ledger are integers in that unit.
 */
export interface Position {
    name: string;
    decimals: number;
}

/**
 * Converts a human-readable value to the position's smallest-unit integer, rounding
 * half-up. e.g. `scale(500, cad)` → `50000`, `scale(123.456789, cad)` → `12346`.
 */
export function scale(humanValue: number, position: Position): bigint {
    return BigInt(Math.round(humanValue * 10 ** position.decimals));
}

/**
 * Converts a smallest-unit integer back to a human-readable float.
 * e.g. `unscale(50000, cad)` → `500`, `unscale(100_000_000, btc)` → `1`.
 */
export function unscale(rawValue: bigint, position: Position): number {
    return Number(rawValue) / 10 ** position.decimals;
}

/**
 * Formats a smallest-unit integer quantity to a human-readable decimal string
 * using the scaling factor embedded in `position.decimals`.
 * e.g. `formatQuantity(100_050n, cad)` → `"1000.50"`
 */
export function formatQuantity(quantity: bigint, position: Position): string {
    const factor = BigInt(10 ** position.decimals);
    const whole = quantity / factor;
    const frac = (quantity % factor).toString().padStart(position.decimals, '0');
    return position.decimals === 0 ? `${whole}` : `${whole}.${frac}`;
}

/** Extracts the {@link Position} from any {@link Input} or {@link Output} node. */
export function getPosition(node: Input | Output): Position {
    return (node instanceof UTXI || node instanceof UTXO) ? node.position : node.source.position;
}

/**
 * Asserts that every node in `nodes` belongs to the same {@link Position} and returns it.
 * Throws immediately if any two nodes differ. Accepts a flat array of inputs or outputs, or
 * a `{inputs, outputs}` shape to check both sides of a transaction in one call.
 */
export function assertPositionUnifiromity(
    nodes:
        {inputs: Input[], outputs?: Output[]} |
        {inputs?: Input[], outputs: Output[]} |
        Input[] | Output[]
): Position {
    let uniformPosition: Position | null = null;
    function checkPosition(position: Position) {
        if (uniformPosition === null) { uniformPosition = position; return; }
        if (uniformPosition !== position) throw new Error(`Attempted to assert position uniformity but failed with a node for ${position} being included in a set with another position ${uniformPosition}`);
    }

    if (Array.isArray(nodes)) for (const node of nodes) checkPosition(getPosition(node));
    else {
        if (nodes.inputs) for (const input of nodes.inputs) checkPosition(getPosition(input));
        if (nodes.outputs) for (const output of nodes.outputs) checkPosition(getPosition(output));
    }

    if (uniformPosition === null) throw new Error(`Attempted to assert position uniformity with no inputs or outputs`);
    return uniformPosition;
}