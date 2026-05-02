export enum Orientation {
    Positive = 1,
    Negative = -1
}

export type AccountNode = Account | AccountFolder;

export class Account {
    constructor(
        public name: string,
        public localOrientation: Orientation,
        public parent: AccountFolder | null = null,
    ) { }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }
}

export class AccountFolder {
    constructor(
        public name: string,
        public localOrientation: Orientation,
        public children: AccountNode[] = [],
        public parent: AccountFolder | null = null,
    ) {
        for (const child of this.children) child.parent = this;
    }

    public addChild(child: AccountNode): void {
        this.children.push(child);
        child.parent = this;
    }

    public addAccount(name: string, localOrientation: Orientation): Account {
        const child = new Account(name, localOrientation);
        this.addChild(child);
        return child;
    }

    public addFolder(name: string, localOrientation: Orientation): AccountFolder {
        const folder = new AccountFolder(name, localOrientation);
        this.addChild(folder);
        return folder;
    }

    public getRootOrientation(): Orientation {
        if (this.parent === null) return this.localOrientation;
        return this.parent.getRootOrientation() * this.localOrientation;
    }
}
