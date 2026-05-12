import fs from "fs";
import util from "node:util";
import { createInterface } from "node:readline/promises";

export type Result<T, E = Error> = { ok: true; value: T; } |
{ ok: false; error: E; };

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

export function dump(value: any): string {
    return util.inspect(value, {
        depth: null,        // recurse forever
        colors: false,       // nice terminal colors
        compact: false,     // easier to read
        showHidden: false,  // set true if you want non-enumerables/symbols
    });
}

export function write(value: any): void {
    fs.writeFileSync("output.txt", Buffer.from(dump(value), "utf8"));
}