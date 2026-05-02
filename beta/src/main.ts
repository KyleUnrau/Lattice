import { Account, AccountFolder, Orientation, type AccountNode } from "./ledger-kernel/accounts.js";
import type { Result } from "./utils.js";

type Transaction = AccountTransaction | ExchangeTransaction;

class Kernel {
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
    private lotEngines: Map<Account, LotEngine> = new Map();

    constructor(
        public readonly ledger: Ledger,
        public readonly name: string
    ) { }

    public includeEntries(entries: AccountTransactionEntry[]): void {
        for (const entry of entries) {
            
        }
    }
}

class LotEngine {
    private lots: Lot[] = [];

    constructor(
        public account: Account
    ) { }
}

class Lot {
    private entries: LotEntry[] = [];

    constructor(initialQuantity: number, sources: LotEntry[]) {
        this.entries.push({delta: initialQuantity, sources});
    }
}

interface LotEntry {
    delta: number;
    sources: LotEntry[];
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

const assets = new AccountFolder("Assets", Orientation.Positive);
const liabilities = new AccountFolder("Liabilities", Orientation.Negative);
const netWorth = new AccountFolder("Net Worth", Orientation.Negative);
const accounts = [assets, liabilities, netWorth];

const cash = assets.addAccount("Cash", Orientation.Positive);

const initialState = netWorth.addAccount("Initial State", Orientation.Positive);

const kernel = new Kernel();
const personalLedger = kernel.addLedger(accounts);

const cad = personalLedger.addPosition("CAD");

cad.includeEntries([
    {
        account: initialState,
        delta: 1000
    },
    {
        account: cash,
        delta: 1000
    }
]);

console.log(cad);

cad.includeEntries([
    {
        account: initialState,
        delta: 1000
    },
    {
        account: cash,
        delta: 1000
    }
]);