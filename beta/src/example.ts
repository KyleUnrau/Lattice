import { AccountFolder, Orientation } from "./ledger-kernel/accounts.js";
import { Kernel } from "./ledger-kernel/misc.js";


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
