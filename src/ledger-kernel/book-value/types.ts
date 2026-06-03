import type { Exchange } from "../transactions/exchange.js";
import type { Position } from "../positions.js";

export type BasisPath = OriginPath | ExchangePath | ResidualPath;

export interface OriginPath {
    readonly type: "origin";
    readonly quantity: number;
    readonly position: Position;
}

export interface ExchangePath {
    readonly type: "exchange";
    readonly exchange: Exchange;
    readonly quantity: number;
    readonly fromQuantity: number;
    readonly basis: BasisPath[];
}

export interface ResidualPath {
    readonly type: "residual";
    readonly exchange: Exchange;
    readonly quantity: number;
    readonly fromQuantity: number;
    readonly basis: BasisPath[];
}