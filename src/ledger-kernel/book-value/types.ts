import type { Exchange } from "../transactions/cross-position.js";
import type { Position } from "../positions.js";
import type { BookValueEngine } from "./engine.js";

/** A node in the cost basis tree returned by {@link BookValueEngine.compute}. */
export type BasisPath = OriginPath | ExchangePath | ResidualPath;

/**
 * Terminal node — the basis trace reached a plain {@link UTXI} with no exchange lineage.
 * Represents an opening balance, equity injection, or other unattributed inflow.
 */
export interface OriginPath {
    readonly type: "origin";
    readonly quantity: number;
    readonly position: Position;
}

/**
 * Exchange node — the basis trace crossed an {@link ExchangedUTXI}.
 * `quantity` is the to-side amount attributed to this node; `fromQuantity` is the
 * equivalent from-side amount at the exchange's locked rate; `basis` recurses into
 * the from-side's own lineage.
 */
export interface ExchangePath {
    readonly type: "exchange";
    readonly exchange: Exchange;
    readonly quantity: number;
    readonly fromQuantity: number;
    readonly basis: BasisPath[];
}

/**
 * Residual node — the basis trace crossed a {@link ResidualUTXI} (a gain tagged to an exchange).
 * Same shape as {@link ExchangePath} but signals that the value originated as a recognized
 * gain above the exchange's locked rate rather than as a direct exchange receipt.
 */
export interface ResidualPath {
    readonly type: "residual";
    readonly exchange: Exchange;
    readonly quantity: number;
    readonly fromQuantity: number;
    readonly basis: BasisPath[];
}
