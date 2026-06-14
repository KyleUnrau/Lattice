import { createInterface } from "node:readline/promises";

/** Discriminated union for fallible operations — avoids thrown exceptions at call sites. */
export type Result<T, E = Error> = { ok: true; value: T; } |
{ ok: false; error: E; };

/**
 * Launches an interactive REPL that evaluates arbitrary expressions against `context`.
 * Every key in `context` is injected as a local variable visible to each evaluated line.
 * Type "exit" to quit.
 */
export function runCLI(context: Record<string, unknown>): void {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    Object.assign(globalThis, context);

    async function invokeCLI(): Promise<void> {
        const response = await rl.question("> ");

        if (response.trim().toLowerCase() === "exit") {
            rl.close();
            return;
        }

        try {
            const names = Object.keys(context);
            const values = Object.values(context);

            // eslint-disable-next-line no-new-func
            const fn = new Function(...names, response);
            const result = fn(...values);

            if (result !== undefined) console.log("Returned:", result);
        } catch (err) {
            console.log("Thrown Error:", err);
        }

        void invokeCLI();
    }

    void invokeCLI();
}

/**
 * Integer multiply-then-divide: computes `floor(a * b / c)` using BigInt arithmetic
 * to avoid floating-point rounding. Use wherever a rate or proportional split would
 * otherwise produce a non-integer intermediate result.
 */
export function muldiv(a: number, b: number, c: number): number {
    return Number(BigInt(a) * BigInt(b) / BigInt(c));
}

