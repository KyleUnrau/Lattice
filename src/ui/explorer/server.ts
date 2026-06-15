import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Registry } from "./registry.js";
import { buildState, buildTransaction, buildLot, buildExchange } from "./serialize.js";
import { PAGE } from "./web.js";
import { ScenarioExpensesCase1, type LedgerView } from "../../scenarios.js";

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Serves the transaction explorer over HTTP: a single-page UI at `/` and a small read-only JSON
 * API at `/api/*` over the live in-memory {@link LedgerView}. Every endpoint accepts an `upTo`
 * query parameter — the as-of cursor — so balances, availability, and basis reflect the ledger
 * state after the first `upTo` transactions.
 */
export function startExplorer(view: LedgerView, port: number = PORT): void {
    const registry = new Registry(view);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        try {
            route(view, registry, req, res);
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    });

    server.listen(port, () => {
        console.log(`Lattice transaction explorer → http://localhost:${port}`);
        console.log(`  ${view.ledger.transactions.length} transactions across ${view.positions.length} positions.`);
    });
}

function route(view: LedgerView, registry: Registry, req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname;
    const upTo = url.searchParams.has("upTo") ? Number(url.searchParams.get("upTo")) : undefined;

    if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
    }

    if (path === "/api/state") {
        sendJson(res, 200, buildState(view, registry, upTo));
        return;
    }

    const txMatch = /^\/api\/tx\/(\d+)$/.exec(path);
    if (txMatch) {
        const dto = buildTransaction(view, registry, Number(txMatch[1]), upTo);
        dto ? sendJson(res, 200, dto) : sendJson(res, 404, { error: "transaction not found" });
        return;
    }

    const lotMatch = /^\/api\/lot\/([\w-]+)$/.exec(path);
    if (lotMatch) {
        const dto = buildLot(view, registry, lotMatch[1]!, upTo);
        dto ? sendJson(res, 200, dto) : sendJson(res, 404, { error: "lot not found" });
        return;
    }

    const exMatch = /^\/api\/exchange\/([\w-]+)$/.exec(path);
    if (exMatch) {
        const dto = buildExchange(view, registry, exMatch[1]!, upTo);
        dto ? sendJson(res, 200, dto) : sendJson(res, 404, { error: "exchange not found" });
        return;
    }

    sendJson(res, 404, { error: `no route for ${path}` });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

// Start with the bundled sample ledger when run directly.
startExplorer(ScenarioExpensesCase1.buildSampleLedger());
