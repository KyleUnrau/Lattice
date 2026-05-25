import { TXO } from "../transactions/outputs.js";
import { TXI } from "../transactions/inputs.js";

export type DisposalMethod<T extends TXO | TXI> = (components: T[], delta: number) => Map<T, number>;