import { createInterface } from "node:readline/promises";

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function tryCatch<T, E = Error>(fn: () => T): Result<T, E> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err as E };
  }
}

export async function tryCatchAsync<T, E = Error>(
  fn: () => Promise<T>
): Promise<Result<T, E>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err as E };
  }
}

export function must<T, E = Error>(result: Result<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export async function mustAsync<T, E = Error>(result: Result<T, E> | Promise<Result<T, E>>): Promise<T> {
  const syncResult: Result<T, E> = await result;

  if (!syncResult.ok) throw syncResult.error;
  return syncResult.value;
}

export function roundTo(input: number, roundTo: number): number {
    return Math.round(input / roundTo) * roundTo;
}

export function round(input: number, decimals: number): number {
    const pow: number = Math.pow(10, -decimals);
    return roundTo(input, pow);
}
export function runCLI(context: Record<string, unknown>): void {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

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
            const fn = new Function(...names, `return (${response});`);
            const result = fn(...values);

            if (result !== undefined) console.log("Returned:", result);
        } catch (err) {
            console.log("Thrown Error:", err);
        }

        void invokeCLI();
    }

    void invokeCLI();
}
