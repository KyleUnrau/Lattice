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

