import type { Position } from "../positions.js";
import { TXI, type Input } from "../transactions/inputs.js";
import { TXO, type Output } from "../transactions/outputs.js";

type BasisComponent = {
    position: Position;
    quantity: number;
    originalInput: Input;
    output: {
        finalOutput: Output;
        component: BasisComponent;
    } | null;
};
/*
class BookValueEngine {
    public compute(node: Input | Output): BasisComponent[] {
        if (node instanceof TXO) {
            node.transaction.inputs.txis.forEach((txi: TXI): void => { this.compute(txi); });
        }
    }

    public computeTXO(node: TXO): BasisComponent[] {}
}
*/