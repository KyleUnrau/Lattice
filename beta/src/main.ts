interface TXO {
    delta: number;
    inputs: TXI[];
}

interface TXI {
    delta: number;
    outputs: TXO[];
}