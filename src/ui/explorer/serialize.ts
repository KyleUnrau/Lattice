import { type Position, formatQuantity, unscale } from "../../ledger-kernel/positions.js";
import { Transaction } from "../../ledger-kernel/transactions/transaction.js";
import { TransactionGroup } from "../../ledger-kernel/transactions/group.js";
import { UTXI, UTXOConsumption } from "../../ledger-kernel/transactions/inputs.js";
import { UTXO, UTXIConsumption } from "../../ledger-kernel/transactions/outputs.js";
import { ResidualUTXI } from "../../ledger-kernel/transactions/special-edges/residual.js";
import {
    ExchangedUTXI,
    ExchangedUTXO
} from "../../ledger-kernel/transactions/special-edges/exchange.js";
import { TerminalUTXO } from "../../ledger-kernel/transactions/special-edges/terminal.js";
import { Account } from "../../ledger-kernel/accounts/account.js";
import { AccountFolder } from "../../ledger-kernel/accounts/folder.js";
import { ResidualAccount, ExchangeAccount, TerminalAccount } from "../../ledger-kernel/accounts/computed.js";
import type { AccountNode } from "../../ledger-kernel/accounts/node.js";
import { BookValueEngine, type BasisPath } from "../../equity-policy/book-value/engine.js";
import { collectOriginLeaves } from "../../equity-policy/book-value/lineage.js";
import { Registry, type LotLike } from "./registry.js";
import type { LedgerView } from "../../scenarios.js";

// --- small helpers --------------------------------------------------------------------------

type Dict = Record<string, unknown>;

/** The slice of history representing the ledger "as of" the cursor — the first `upTo` transactions. */
function sliceUpTo(view: LedgerView, upTo: number): Transaction[] {
    return view.ledger.transactions.slice(0, upTo);
}

function clampUpTo(view: LedgerView, raw: number | undefined): number {
    const total = view.ledger.transactions.length;
    if (raw === undefined || Number.isNaN(raw)) return total;
    return Math.max(0, Math.min(total, Math.trunc(raw)));
}

function positionOf(obj: LotLike): Position {
    if (obj instanceof UTXOConsumption || obj instanceof UTXIConsumption) return obj.source.position;
    return obj.position;
}

function quantityFields(quantity: bigint, position: Position): Dict {
    return {
        quantityRaw: quantity.toString(),
        quantityFmt: formatQuantity(quantity, position),
        quantityAmount: unscale(quantity, position),
    };
}

function originBasisDTO(basis: Map<Position, bigint>): Dict[] {
    return [...basis.entries()].map(([position, quantity]) => ({
        position: position.name,
        ...quantityFields(quantity, position),
    }));
}

function ownerDTO(obj: LotLike, reg: Registry): Dict | null {
    const owner = reg.ownerOf(obj);
    if (!owner) return null;
    return { id: reg.accountIdOf(owner) ?? null, name: owner.name };
}

// --- line classification (mirrors the proven draw.io edge semantics) ------------------------

interface Classification { category: string; role: string; }

/** Categorizes a single input/output by its structural role in the ledger graph. */
function classify(obj: LotLike, side: "input" | "output"): Classification {
    if (side === "input") {
        if (obj instanceof UTXOConsumption)
            return obj.source instanceof ExchangedUTXO
                ? { category: "recapture", role: "Recapture · reclaim" }
                : { category: "spend", role: "Spend" };
        if (obj instanceof ExchangedUTXI) return { category: "exchange", role: "Exchange · received" };
        if (obj instanceof ResidualUTXI) return { category: "residual", role: "Gain recognized" };
        return { category: "origin", role: "Origin inflow" };
    }
    if (obj instanceof UTXIConsumption)
        return obj.source instanceof ExchangedUTXI
            ? { category: "recapture", role: "Recapture · settle" }
            : { category: "settle", role: "Settle obligation" };
    if (obj instanceof ExchangedUTXO) return { category: "exchange", role: "Exchange · given" };
    if (obj instanceof TerminalUTXO) return { category: "terminal", role: "Terminal settlement" };
    return { category: "rest", role: "New lot (at rest)" };
}

// --- basis tree -----------------------------------------------------------------------------

/** Recursively serializes a {@link BasisPath} tree for the inspector. */
function serializeBasis(paths: BasisPath[], reg: Registry): Dict[] {
    return paths.map((p): Dict => {
        if (p.type === "origin")
            return { type: "origin", position: p.position.name, ...quantityFields(p.quantity, p.position) };
        if (p.type === "residual")
            return {
                type: "residual",
                residualId: reg.idOf(p.residual) ?? null,
                position: p.residual.position.name,
                ...quantityFields(p.quantity, p.residual.position),
                originBasis: originBasisDTO(p.originBasis),
            };
        return {
            type: "exchange",
            exchangeId: reg.exchangeIdOf(p.exchange) ?? null,
            toPosition: p.exchange.to.position.name,
            fromPosition: p.exchange.from.position.name,
            ...quantityFields(p.quantity, p.exchange.to.position),
            fromFmt: formatQuantity(p.fromQuantity, p.exchange.from.position),
            basis: serializeBasis(p.basis, reg),
        };
    });
}

// --- line DTO -------------------------------------------------------------------------------

function lineDTO(obj: LotLike, side: "input" | "output", reg: Registry, slice: Transaction[]): Dict {
    const position = positionOf(obj);
    const { category, role } = classify(obj, side);

    const dto: Dict = {
        id: reg.idOf(obj),
        side,
        type: (obj as { type: string }).type,
        category,
        role,
        position: position.name,
        ...quantityFields(obj.quantity, position),
        owner: ownerDTO(obj, reg),
    };

    if (obj instanceof UTXOConsumption || obj instanceof UTXIConsumption) {
        dto.sourceLotId = reg.idOf(obj.source) ?? null;
        dto.sourceAvailableFmt = formatQuantity(obj.source.calculateAvailable(slice), obj.source.position);
        if (obj.source instanceof ExchangedUTXO || obj.source instanceof ExchangedUTXI)
            dto.exchangeId = reg.exchangeIdOf(obj.source.exchange) ?? null;
    }
    if (obj instanceof ExchangedUTXO || obj instanceof ExchangedUTXI) {
        dto.exchangeId = reg.exchangeIdOf(obj.exchange) ?? null;
        dto.counterpartLotId = reg.idOf(obj instanceof ExchangedUTXO ? obj.exchange.to : obj.exchange.from) ?? null;
    }
    if (obj instanceof ResidualUTXI)
        dto.originBasis = originBasisDTO(obj.originBasis);
    if (obj instanceof UTXO || obj instanceof UTXI)
        dto.availableFmt = formatQuantity(obj.calculateAvailable(slice), position);

    return dto;
}

// --- account tree ---------------------------------------------------------------------------

function accountKind(node: AccountNode): string {
    if (node instanceof AccountFolder) return "folder";
    if (node instanceof ResidualAccount) return "residual";
    if (node instanceof ExchangeAccount) return "exchange";
    if (node instanceof Account) return "account";
    return "node";
}

function accountDTO(node: AccountNode, reg: Registry, slice: Transaction[]): Dict {
    const balances: Dict[] = [];
    for (const [position, raw] of node.getBalancesScaled(slice)) {
        if (raw === 0n) continue;
        balances.push({ position: position.name, amount: unscale(raw, position), fmt: formatQuantity(raw, position) });
    }
    const dto: Dict = {
        id: reg.accountIdOf(node) ?? null,
        name: node.name,
        kind: accountKind(node),
        balances,
    };
    if (node instanceof AccountFolder)
        dto.children = node.children.map(child => accountDTO(child, reg, slice));
    return dto;
}

// --- group tree -----------------------------------------------------------------------------

/** Serializes a {@link TransactionGroup} into its leaf tx indices and members (leaf tx indices or nested groups). */
function serializeGroup(group: TransactionGroup, txIndex: Map<Transaction, number>): Dict {
    return {
        txIndices: group.flatten().map(tx => txIndex.get(tx) ?? null),
        members: group.members.map((member): Dict =>
            member instanceof TransactionGroup
                ? { group: serializeGroup(member, txIndex) }
                : { txIndex: member instanceof Transaction ? txIndex.get(member) ?? null : null }),
    };
}

// --- public builders ------------------------------------------------------------------------

/** Top-level snapshot: positions, the account tree (balances as-of the cursor), and the transaction timeline. */
export function buildState(view: LedgerView, reg: Registry, upToRaw: number | undefined): Dict {
    const upTo = clampUpTo(view, upToRaw);
    const slice = sliceUpTo(view, upTo);
    const transactions = view.ledger.transactions;

    const timeline = transactions.map((tx, index) => {
        const categories = new Set<string>();
        for (const input of tx.inputs) categories.add(classify(input, "input").category);
        for (const output of tx.outputs) categories.add(classify(output, "output").category);
        return {
            index,
            position: tx.position.name,
            inputCount: tx.inputs.length,
            outputCount: tx.outputs.length,
            categories: [...categories],
            committed: index < upTo,
        };
    });

    const verification = view.ledger.verify();

    const txIndex = new Map<Transaction, number>(transactions.map((tx, index) => [tx, index]));

    return {
        upTo,
        total: transactions.length,
        valid: verification.ok,
        validationError: verification.ok ? null : verification.error.message,
        positions: view.positions.map(p => ({ name: p.name, decimals: p.decimals })),
        accounts: [
            accountDTO(view.ledger.netAssets, reg, slice),
            accountDTO(view.ledger.equity, reg, slice),
        ],
        transactions: timeline,
        groups: view.ledger.groups.map(group => serializeGroup(group, txIndex)),
    };
}

/** Full detail for one transaction: classified input/output lines plus the provenance of consumed value. */
export function buildTransaction(view: LedgerView, reg: Registry, index: number, upToRaw: number | undefined): Dict | null {
    const transactions = view.ledger.transactions;
    if (index < 0 || index >= transactions.length) return null;
    const tx = transactions[index]!;

    const upTo = clampUpTo(view, upToRaw);
    const slice = sliceUpTo(view, upTo);

    // Provenance must see at least through this transaction so ancestor producers resolve.
    const basisSlice = transactions.slice(0, Math.max(upTo, index + 1));
    const engine = new BookValueEngine(basisSlice);

    let provenance: Dict;
    try {
        const basis = engine.compute(tx.inputs);
        provenance = { basis: serializeBasis(basis, reg), origin: originBasisDTO(collectOriginLeaves(basis)) };
    } catch (err) {
        provenance = { basis: [], origin: [], error: err instanceof Error ? err.message : String(err) };
    }

    return {
        index,
        position: tx.position.name,
        committed: index < upTo,
        inputs: tx.inputs.map(input => lineDTO(input, "input", reg, slice)),
        outputs: tx.outputs.map(output => lineDTO(output, "output", reg, slice)),
        provenance,
    };
}

/** Detail for a single lot/consumption: ownership, lifecycle, basis tree, and origin composition. */
export function buildLot(view: LedgerView, reg: Registry, id: string, upToRaw: number | undefined): Dict | null {
    const lot = reg.lotById.get(id);
    if (!lot) return null;

    const transactions = view.ledger.transactions;
    const upTo = clampUpTo(view, upToRaw);
    const slice = sliceUpTo(view, upTo);
    const position = positionOf(lot);

    const dto: Dict = {
        id,
        type: (lot as { type: string }).type,
        position: position.name,
        owner: ownerDTO(lot, reg),
        ...quantityFields(lot.quantity, position),
    };

    if (lot instanceof UTXOConsumption || lot instanceof UTXIConsumption) {
        dto.role = "consumption";
        dto.sourceLotId = reg.idOf(lot.source) ?? null;
        dto.sourceAvailableFmt = formatQuantity(lot.source.calculateAvailable(slice), lot.source.position);
        return dto;
    }

    // Value-bearing lot: lifecycle + provenance.
    dto.availableFmt = formatQuantity(lot.calculateAvailable(slice), position);
    dto.committed = lot.isCommitted(slice);

    if (lot instanceof UTXO) {
        dto.producedInTx = reg.transactionIndexOf(lot, transactions, "output");
        dto.consumptions = lot.getConsumptions(slice).map(c => ({
            byLotId: reg.idOf(c) ?? null,
            txIndex: reg.transactionIndexOf(c, transactions, "input"),
            qtyFmt: formatQuantity(c.quantity, position),
        }));
    } else {
        dto.introducedInTx = reg.transactionIndexOf(lot, transactions, "input");
        dto.settlements = lot.getConsumptions(slice).map(c => ({
            byLotId: reg.idOf(c) ?? null,
            txIndex: reg.transactionIndexOf(c, transactions, "output"),
            qtyFmt: formatQuantity(c.quantity, position),
        }));
    }

    if (lot instanceof ExchangedUTXO || lot instanceof ExchangedUTXI) dto.exchangeId = reg.exchangeIdOf(lot.exchange) ?? null;
    if (lot instanceof ResidualUTXI) dto.originBasis = originBasisDTO(lot.originBasis);

    // Basis trace: trace UTXO-side lots directly; for the UTXI side, trace the exchange's from-side.
    const engine = new BookValueEngine(transactions);
    try {
        let basis: BasisPath[] | null = null;
        if (lot instanceof UTXO) basis = engine.traceLot(lot);
        else if (lot instanceof ExchangedUTXI) basis = engine.traceLot(lot.exchange.from);
        if (basis) {
            dto.basis = serializeBasis(basis, reg);
            dto.originComposition = originBasisDTO(collectOriginLeaves(basis));
        }
    } catch (err) {
        dto.basisError = err instanceof Error ? err.message : String(err);
    }

    return dto;
}

/** Detail for a single exchange: locked rate, the two sides, recapture progress, and lifecycle. */
export function buildExchange(view: LedgerView, reg: Registry, id: string, upToRaw: number | undefined): Dict | null {
    const exchange = reg.exchangeById.get(id);
    if (!exchange) return null;

    const transactions = view.ledger.transactions;
    const upTo = clampUpTo(view, upToRaw);
    const slice = sliceUpTo(view, upTo);

    const { from, to, fromAccount, toAccount } = exchange;
    const fromAvailable = from.calculateAvailable(slice);
    const toAvailable = to.calculateAvailable(slice);
    // One scoping account when both sides book to the same place; otherwise show the from→to pair.
    const account = fromAccount === toAccount
        ? { id: reg.accountIdOf(fromAccount) ?? null, name: fromAccount.name }
        : { id: null, name: `${fromAccount.name} → ${toAccount.name}` };

    const recapturedTo = to.quantity - toAvailable;
    const status = recapturedTo === 0n ? "open" : toAvailable === 0n ? "recaptured" : "partial";

    // Transactions where either side is recaptured/consumed.
    const recaptureTxs = new Set<number>();
    for (const c of from.getConsumptions(slice)) {
        const i = reg.transactionIndexOf(c, transactions, "input");
        if (i !== null) recaptureTxs.add(i);
    }
    for (const c of to.getConsumptions(slice)) {
        const i = reg.transactionIndexOf(c, transactions, "output");
        if (i !== null) recaptureTxs.add(i);
    }

    return {
        id,
        account,
        from: {
            lotId: reg.idOf(from) ?? null,
            position: from.position.name,
            ...quantityFields(from.quantity, from.position),
            availableFmt: formatQuantity(fromAvailable, from.position),
        },
        to: {
            lotId: reg.idOf(to) ?? null,
            position: to.position.name,
            ...quantityFields(to.quantity, to.position),
            availableFmt: formatQuantity(toAvailable, to.position),
        },
        rate: unscale(from.quantity, from.position) / unscale(to.quantity, to.position),
        recovered: {
            fromFmt: formatQuantity(from.quantity - fromAvailable, from.position),
            toFmt: formatQuantity(recapturedTo, to.position),
        },
        status,
        openedInTx: reg.transactionIndexOf(from, transactions, "output"),
        receivedInTx: reg.transactionIndexOf(to, transactions, "input"),
        recapturedInTx: [...recaptureTxs].sort((a, b) => a - b),
    };
}
