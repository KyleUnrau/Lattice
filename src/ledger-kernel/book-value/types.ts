import type { Exchange, ResidualUTXI } from "../transactions/cross-position.js";
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
    readonly quantity: bigint;
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
    readonly quantity: bigint;
    readonly fromQuantity: bigint;
    readonly basis: BasisPath[];
}

/**
 * Residual node — the basis trace crossed a {@link ResidualUTXI} (deferred residual equity).
 * `quantity` is the surface-position amount attributed to this node; `originBasis` is the
 * proportional origin-position composition that amount carries, and `residual` references the
 * lot itself so a consumer can settle (partially close) it. Terminal: a residual does not recurse
 * further — its lineage is captured by `originBasis`.
 */
export interface ResidualPath {
    readonly type: "residual";
    readonly residual: ResidualUTXI;
    readonly quantity: bigint;
    readonly originBasis: Map<Position, bigint>;
}
