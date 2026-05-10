import type { AccountNode, Account } from "./accounts.js";

type Transaction = AccountTransaction | ExchangeTransaction;
export class Kernel {
    constructor(
        public ledgers: Ledger[] = [],
        public transactions: Transaction[] = []
    ) { }

    public addLedger(accounts: AccountNode[]): Ledger {
        const ledger: Ledger = new Ledger(this, accounts);
        this.ledgers.push(ledger);
        return ledger;
    }
}

class Ledger {
    private positions: Set<Position> = new Set<Position>();

    constructor(
        public readonly kernel: Kernel,
        public accounts: AccountNode[]
    ) { }

    public addPosition(name: string): Position {
        const position: Position = new Position(this, name);
        this.positions.add(position);
        return position;
    }
}

class Position {
    constructor(
        public readonly ledger: Ledger,
        public readonly name: string
    ) { }

    public includeEntries(entries: AccountTransactionEntry[]): void {
        for (const entry of entries) {
        }
    }
}

interface AccountTransactionEntry {
    account: Account;
    delta: number;
}

interface AccountTransaction {
    ledger: Ledger;
    position: Position;
    transactions: AccountTransactionEntry[];
}

class ExchangeTransaction {
    constructor(
        public from: AccountTransaction,
        public to: AccountTransaction,
        public residual: Account
    ) { }
}