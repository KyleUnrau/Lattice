import type { Orientation } from "../ledger.js";

export interface AccountSummary {
    name: string;
    orientation: {
        local: Orientation;
        effective: Orientation;
    };
    balance: number;
}

export interface FolderSummary {
    name: string;
    orientation: {
        local: Orientation;
        effective: Orientation;
    };
    balance: number;
    children: NodeSummary[];
}

export type NodeSummary = AccountSummary | FolderSummary;
