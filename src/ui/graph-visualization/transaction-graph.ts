import { writeFileSync } from "node:fs";

import { type Position, formatQuantity } from "../../ledger-kernel/positions.js";
import type { Transaction } from "../../ledger-kernel/transactions.js";
import { UTXI, UTXOConsumption, type Input } from "../../ledger-kernel/transactions/inputs.js";
import { UTXIConsumption, UTXO, type Output } from "../../ledger-kernel/transactions/outputs.js";
import {
    Exchange,
    ExchangedUTXI,
    ExchangedUTXO,
    ResidualUTXI,
    ResidualUTXO,
} from "../../ledger-kernel/transactions/cross-position.js";

/**
 * Renders a set of {@link Transaction}s into a draw.io (`.drawio`) diagram of the underlying
 * lot graph and writes it to `outPath`.
 *
 * Layout is **banded** (see {@link assignLayout}): lots that hold value — UTXO/UTXI and the
 * exchange sides — sit on a top lane in causal order, one per column; every consumption is
 * stacked in a column directly beneath the lot it draws from, so "what consumes what" reads
 * vertically and the forward flow reads left→right.
 *
 * Edge colour carries meaning: an **ordinary consumption** is a faint grey dotted line (not
 * emphasised); an **exchange** crossing a position boundary is blue (the from↔to link); a
 * **recapture** that resolves an exchange is orange; a **residual** (gain/loss recognition) is
 * crimson. Plain within-transaction transfers are thin grey.
 *
 * Pure with respect to the ledger: it only reads `transactions`, never mutates them. Account
 * names are not shown because lots carry no back-reference to their owning account.
 *
 * @param transactions - The ordered transaction history to render (e.g. `ledger.transactions`).
 * @param outPath - Filesystem path the `.drawio` XML is written to.
 */
export function generateTransactionGraph(transactions: Transaction[], outPath: string): void {
    const nodes = buildNodes(transactions);
    const edges = buildEdges(transactions, nodes);
    assignLayout(nodes, edges);
    writeFileSync(outPath, buildDrawioXml([...nodes.values()], edges), "utf8");
}

// --- node styling (shape = structural type, fill = side, accents for exchange/residual) -----

const GREEN_BOX = "rounded=1;whiteSpace=wrap;html=1;arcSize=9;strokeColor=#54c45e;fillColor=#e3fae3;strokeWidth=1.5;fontSize=12;";
const RED_DASHED_BOX = "rounded=1;whiteSpace=wrap;html=1;arcSize=9;strokeColor=#e81313;fillColor=#ffd9d9;dashed=1;fixDash=1;dashPattern=6 5;strokeWidth=1.5;fontSize=12;";
const GREEN_BOX_EXCHANGE = "rounded=1;whiteSpace=wrap;html=1;arcSize=9;strokeColor=#2962ff;fillColor=#e3fae3;strokeWidth=2.5;fontSize=12;";
const RED_DASHED_EXCHANGE = "rounded=1;whiteSpace=wrap;html=1;arcSize=9;strokeColor=#2962ff;fillColor=#ffd9d9;dashed=1;fixDash=1;dashPattern=6 5;strokeWidth=2.5;fontSize=12;";
const VIOLET_BOX = "rounded=1;whiteSpace=wrap;html=1;arcSize=9;strokeColor=#8e24aa;fillColor=#f3e0fb;strokeWidth=2;fontSize=12;";
const VIOLET_DASHED_BOX = "rounded=1;whiteSpace=wrap;html=1;arcSize=9;strokeColor=#8e24aa;fillColor=#f3e0fb;dashed=1;fixDash=1;dashPattern=6 5;strokeWidth=2;fontSize=12;";
const RED_HEXAGON = "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;strokeColor=#e81313;fillColor=#ffd9d9;dashed=1;fixDash=1;dashPattern=6 5;strokeWidth=1.5;fontSize=12;";
const GREEN_HEXAGON = "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;strokeColor=#54c45e;fillColor=#e3fae3;strokeWidth=1.5;fontSize=12;";

// --- edge styling (colour = relationship meaning) ------------------------------------------

const EDGE_BASE = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;";
type EdgeKind = "flow" | "consume" | "exchange" | "recapture" | "residual";
const EDGE_STYLE: Record<EdgeKind, string> = {
    flow: EDGE_BASE + "strokeColor=#9aa0a6;strokeWidth=1.5;",
    consume: EDGE_BASE + "strokeColor=#9aa0a6;strokeWidth=1.5;dashed=1;dashPattern=2 4;",
    exchange: EDGE_BASE + "strokeColor=#2962ff;strokeWidth=3;",
    recapture: EDGE_BASE + "strokeColor=#ff8c00;strokeWidth=3;",
    residual: EDGE_BASE + "strokeColor=#d11a6b;strokeWidth=2.5;",
};
const EDGE_COLOR: Record<EdgeKind, string> = {
    flow: "#9aa0a6", consume: "#9aa0a6", exchange: "#2962ff", recapture: "#ff8c00", residual: "#d11a6b",
};

// --- layout constants ----------------------------------------------------------------------

const NODE_W = 200;
const NODE_H = 80;
const COL_STEP = NODE_W + 80;
const LANE_ROW_STEP = NODE_H + 70;     // vertical gap between stacked lane nodes (rare collisions)
const STACK_STEP = NODE_H + 40;        // vertical gap between consumptions stacked under one lot
const BAND_GAP = 90;                   // gap between the lane band and the consumption band
const LEFT_MARGIN = 40;
const LEGEND_W = 372;
const LEGEND_H = 240;
const TOP_MARGIN = LEGEND_H + 60;

// --- node model ----------------------------------------------------------------------------

type LotLike = Input | Output;

interface NodeRec {
    id: string;
    obj: LotLike;
    typeName: string;
    style: string;
    isStack: boolean;
    position: Position;
    quantity: bigint;
    phase: number;
    role: string;
    order: number;
    layer: number;
    column: number;
    bandRow: number;
}

function isConsumption(node: LotLike): boolean {
    return node instanceof UTXOConsumption || node instanceof UTXIConsumption;
}
function isResidual(node: LotLike): boolean {
    return node instanceof ResidualUTXI || node instanceof ResidualUTXO;
}
/** Lane nodes hold value on the top band; consumptions and residuals are stacked beneath. */
function isLane(node: LotLike): boolean {
    return (node instanceof UTXO || node instanceof UTXI) && !isResidual(node);
}

/** Resolves the display name, style, stack flag, position, and quantity for any input/output. */
function classify(node: LotLike): Pick<NodeRec, "typeName" | "style" | "isStack" | "position" | "quantity"> {
    if (node instanceof UTXOConsumption)
        return { typeName: "UTXO Consumed", style: RED_HEXAGON, isStack: true, position: node.source.position, quantity: node.quantity };
    if (node instanceof UTXIConsumption)
        return { typeName: "UTXI Settled", style: GREEN_HEXAGON, isStack: true, position: node.source.position, quantity: node.quantity };

    // Order matters: subclasses before their base classes.
    if (node instanceof ResidualUTXO)
        return { typeName: "ResidualUTXO", style: VIOLET_BOX, isStack: true, position: node.position, quantity: node.quantity };
    if (node instanceof ResidualUTXI)
        return { typeName: "ResidualUTXI", style: VIOLET_DASHED_BOX, isStack: true, position: node.position, quantity: node.quantity };
    if (node instanceof ExchangedUTXO)
        return { typeName: "ExchangedUTXO", style: GREEN_BOX_EXCHANGE, isStack: false, position: node.position, quantity: node.quantity };
    if (node instanceof ExchangedUTXI)
        return { typeName: "ExchangedUTXI", style: RED_DASHED_EXCHANGE, isStack: false, position: node.position, quantity: node.quantity };
    if (node instanceof UTXO)
        return { typeName: "UTXO", style: GREEN_BOX, isStack: false, position: node.position, quantity: node.quantity };
    if (node instanceof UTXI)
        return { typeName: "UTXI", style: RED_DASHED_BOX, isStack: false, position: node.position, quantity: node.quantity };

    throw new Error(`Unknown node type encountered while rendering: ${(node as { type?: unknown }).type}`);
}

/** Builds one {@link NodeRec} per distinct lot/consumption, in transaction order. */
function buildNodes(transactions: Transaction[]): Map<LotLike, NodeRec> {
    const nodes = new Map<LotLike, NodeRec>();
    let order = 0;

    const add = (obj: LotLike, phase: number, role: string): void => {
        if (nodes.has(obj)) return;
        nodes.set(obj, { id: `n${order}`, obj, ...classify(obj), phase, role, order: order++, layer: 0, column: 0, bandRow: 0 });
    };

    transactions.forEach((tx, phase) => {
        tx.inputs.forEach((input, i) => add(input, phase, `inputs[${i}]`));
        tx.outputs.forEach((output, i) => add(output, phase, `outputs[${i}]`));
    });
    return nodes;
}

interface EdgeRec { source: string; target: string; kind: EdgeKind; }

/**
 * Derives typed edges from the transaction graph:
 * - **consume**: a UTXO/UTXI at rest → the consumption that draws it down (ordinary spend/settle).
 * - **recapture**: a consumption whose source is an exchange side (an exchange being resolved).
 * - **exchange**: the from↔to sides of each {@link Exchange} (locked rate, boundary crossing).
 * - **residual**: any within-transaction edge incident to a residual (gain/loss) lot.
 * - **flow**: any other within-transaction transfer.
 */
function buildEdges(transactions: Transaction[], nodes: Map<LotLike, NodeRec>): EdgeRec[] {
    const edges: EdgeRec[] = [];
    const seenExchanges = new Set<Exchange>();
    const idOf = (obj: LotLike): string | undefined => nodes.get(obj)?.id;

    const link = (a: LotLike, b: LotLike, kind: EdgeKind): void => {
        const s = idOf(a);
        const t = idOf(b);
        if (s && t) edges.push({ source: s, target: t, kind });
    };

    for (const tx of transactions) {
        for (const input of tx.inputs) {
            if (input instanceof UTXOConsumption)
                link(input.source, input, input.source instanceof ExchangedUTXO ? "recapture" : "consume");

            for (const output of tx.outputs)
                link(input, output, isResidual(input) || isResidual(output) ? "residual" : "flow");
        }

        for (const output of tx.outputs) {
            if (output instanceof UTXIConsumption)
                link(output.source, output, output.source instanceof ExchangedUTXI ? "recapture" : "consume");
        }

        for (const node of [...tx.inputs, ...tx.outputs]) {
            const exchange = node instanceof ExchangedUTXO || node instanceof ExchangedUTXI ? node.exchange : null;
            if (!exchange || seenExchanges.has(exchange)) continue;
            seenExchanges.add(exchange);
            link(exchange.from, exchange.to, "exchange");
        }
    }
    return edges;
}

// --- layout engine: banded (lane lots on top, consumptions stacked beneath their source) ----

/**
 * Assigns each node a `column` and `bandRow`. Columns come from a longest-path pass over the
 * (acyclic) transaction graph; lane lots are compacted into consecutive columns in causal order.
 * Each consumption is placed in its source lot's column, and each residual under the lot it feeds;
 * within a column the stacked nodes are packed top-to-bottom. {@link buildDrawioXml} turns
 * `column`/`bandRow`/`isStack` into pixel coordinates across the two bands.
 */
function assignLayout(nodes: Map<LotLike, NodeRec>, edges: EdgeRec[]): void {
    const recs = [...nodes.values()];
    const byId = new Map(recs.map(r => [r.id, r]));
    const outAdj = new Map<string, string[]>(recs.map(r => [r.id, []]));
    for (const e of edges) outAdj.get(e.source)!.push(e.target);

    // Longest-path layering over the full DAG (every edge points forward in causal order).
    for (let iter = 0; iter < recs.length; iter++) {
        let changed = false;
        for (const e of edges) {
            const s = byId.get(e.source)!;
            const t = byId.get(e.target)!;
            if (t.layer < s.layer + 1) { t.layer = s.layer + 1; changed = true; }
        }
        if (!changed) break;
    }

    // Lane columns: one lot per column, ordered by causal depth (longest-path layer) then
    // by appearance — a strictly single-row backbone with no lane-on-lane stacking.
    const laneRecs = recs.filter(r => isLane(r.obj)).sort((a, b) => a.layer - b.layer || a.order - b.order);
    laneRecs.forEach((r, i) => { r.column = i; r.bandRow = 0; });

    // Stack columns: residuals sit under the lot they feed; consumptions under their source.
    const stackRecs = recs.filter(r => r.isStack);
    for (const r of stackRecs.filter(s => isResidual(s.obj))) {
        const target = outAdj.get(r.id)!.map(id => byId.get(id)!).find(t => isLane(t.obj));
        r.column = target?.column ?? 0;
    }
    for (const r of stackRecs.filter(s => isConsumption(s.obj))) {
        const source = nodes.get((r.obj as UTXOConsumption | UTXIConsumption).source);
        r.column = source?.column ?? 0;
    }

    // Stack rows: pack each column's stacked nodes top-to-bottom in encounter order.
    packRows(stackRecs);
}

/** Packs a set of nodes into rows per column (row 0, 1, 2, …) in stable encounter order. */
function packRows(recs: NodeRec[]): void {
    const nextRow = new Map<number, number>();
    for (const r of [...recs].sort((a, b) => a.column - b.column || a.order - b.order)) {
        const row = nextRow.get(r.column) ?? 0;
        r.bandRow = row;
        nextRow.set(r.column, row + 1);
    }
}

// --- XML construction ----------------------------------------------------------------------

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function nodeLabel(r: NodeRec): string {
    const amount = `${formatQuantity(r.quantity, r.position)} (${r.position.name})`;
    return escapeXml(`<b>${r.typeName}</b><br>Phase #${r.phase} · ${r.role}<br><br>${amount}`);
}

function vertexCell(id: string, label: string, style: string, x: number, y: number, w = NODE_W, h = NODE_H): string {
    return `        <mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1">\n` +
        `          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />\n` +
        `        </mxCell>`;
}

function edgeCell(id: string, e: EdgeRec): string {
    return `        <mxCell id="${id}" style="${EDGE_STYLE[e.kind]}" edge="1" parent="1" source="${e.source}" target="${e.target}">\n` +
        `          <mxGeometry relative="1" as="geometry" />\n` +
        `        </mxCell>`;
}

function legendCell(): string {
    const swatch = (color: string, dotted = false): string =>
        `<span style="color:${color};font-weight:bold;letter-spacing:-1px;">${dotted ? "·····" : "&#9644;&#9644;&#9644;"}</span>`;
    const label = escapeXml(
        `<div style="text-align:left;">` +
        `<b>Legend</b><br>` +
        `<b>Nodes</b> &nbsp;box = lot at rest · hexagon = consumed/settled<br>` +
        `green = UTXO side · red dashed = UTXI side<br>` +
        `blue border = exchange side · violet = residual (gain/loss)<br>` +
        `<br><b>Edges</b><br>` +
        `${swatch(EDGE_COLOR.consume, true)} consume a lot (ordinary spend/settle)<br>` +
        `${swatch(EDGE_COLOR.exchange)} exchange — boundary crossing (from→to)<br>` +
        `${swatch(EDGE_COLOR.recapture)} recapture — exchange resolved<br>` +
        `${swatch(EDGE_COLOR.residual)} residual recognized (gain/loss)<br>` +
        `${swatch(EDGE_COLOR.flow)} transfer within a transaction` +
        `</div>`,
    );
    const style = "rounded=1;whiteSpace=wrap;html=1;arcSize=4;strokeColor=#888888;fillColor=#fbfbfb;align=left;verticalAlign=top;spacing=10;fontSize=12;";
    return vertexCell("legend", label, style, 0, 0, LEGEND_W, LEGEND_H);
}

function buildDrawioXml(nodes: NodeRec[], edges: EdgeRec[]): string {
    const laneRows = nodes.filter(n => !n.isStack).map(n => n.bandRow);
    const maxLaneRow = laneRows.length ? Math.max(...laneRows) : 0;
    const stackTop = TOP_MARGIN + (maxLaneRow + 1) * LANE_ROW_STEP + BAND_GAP;

    const cells: string[] = [legendCell()];
    for (const r of nodes) {
        const x = r.column * COL_STEP + LEFT_MARGIN;
        const y = r.isStack ? stackTop + r.bandRow * STACK_STEP : TOP_MARGIN + r.bandRow * LANE_ROW_STEP;
        cells.push(vertexCell(r.id, nodeLabel(r), r.style, x, y));
    }
    edges.forEach((e, i) => cells.push(edgeCell(`e${i}`, e)));

    return [
        `<mxfile host="app.diagrams.net">`,
        `  <diagram name="Transaction Graph" id="transaction-graph">`,
        `    <mxGraphModel dx="1422" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1100" math="0" shadow="0">`,
        `      <root>`,
        `        <mxCell id="0" />`,
        `        <mxCell id="1" parent="0" />`,
        ...cells,
        `      </root>`,
        `    </mxGraphModel>`,
        `  </diagram>`,
        `</mxfile>`,
        ``,
    ].join("\n");
}
