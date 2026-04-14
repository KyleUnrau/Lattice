import { v4 as newUuid } from "uuid";

export enum Orientation {
    Positive = 1,
    Negative = -1
}

export type LedgerNode = Account | AccountFolder;

export class Account {
    constructor(
        public readonly name: string,
        public readonly orientation: Orientation,
        public readonly uuid: string = newUuid(),
    ) { }
}

export class AccountFolder {
    constructor(
        public readonly name: string,
        public readonly orientation: Orientation,
        public readonly uuid: string = newUuid(),
        public children: LedgerNode[] = [],
    ) { }
}

