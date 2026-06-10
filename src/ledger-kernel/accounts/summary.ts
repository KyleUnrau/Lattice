
export interface AccountSummary {
    name: string;
    balance: number;
}

export interface FolderSummary {
    name: string;
    balance: number;
    children: NodeSummary[];
}

export type NodeSummary = AccountSummary | FolderSummary;
