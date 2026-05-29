import { TXO } from "../transactions/outputs.js";
import { TXI } from "../transactions/inputs.js";
import type { Transaction } from "../transactions.js";

export type DisposalMethod<T extends TXO | TXI> = (components: T[], delta: number, transactions: Transaction[]) => Map<T, number>;