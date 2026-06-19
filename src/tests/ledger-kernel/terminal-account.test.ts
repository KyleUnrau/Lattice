import { test } from "node:test";
import assert from "node:assert/strict";

import { TerminalUTXO } from "../../ledger-kernel/transactions/terminal.js";
import { TerminalAccount } from "../../ledger-kernel/accounts/computed.js";
import { Account } from "../../ledger-kernel/accounts/account.js";
import { TerminalResolution } from "../../equity-policy/terminal.js";
import { commitSwap, makeFixture, openInto } from "../utils/ledger-fixture.js";

// A terminal settlement record must never become spendable inventory. These tests pin the
// *structural* guarantees (not merely convention) that keep terminal value final.

test("TERM1: a TerminalUTXO cannot be consumed — consume() throws", () => {
    const f = makeFixture();
    const terminal = f.exchangeExpense.recognize(100n, f.cad);
    assert.ok(terminal instanceof TerminalUTXO);
    assert.throws(() => terminal.consume(), /terminal settlement record and cannot be consumed/);
});

test("TERM2: a TerminalAccount is not an ordinary Account and exposes no source capability", () => {
    const f = makeFixture();
    // It is a computed sink, not an inventory Account, so it can never be drawn from.
    assert.equal(f.exchangeExpense instanceof Account, false, "a TerminalAccount is not an Account");
    assert.equal(typeof (f.exchangeExpense as unknown as { generateInputs?: unknown }).generateInputs, "undefined", "no generateInputs — cannot be a transaction source");
    assert.equal(typeof (f.exchangeExpense as unknown as { lotStores?: unknown }).lotStores, "undefined", "no PositionLotStore lifecycle");
});

test("TERM3: an expensed terminal record is committed and counts toward balance, yet lives in no consumable lot store", () => {
    const f = makeFixture();
    openInto(f, f.cash, f.cad, 1000);

    const inputs = f.cash.generateInputs(f.cad, 200, f.ledger.transactions);
    const resolution = new TerminalResolution(inputs, f.ledger.transactions, f.engine, f.exchangeExpense);
    const event = f.ledger.beginEvent();
    event.record(resolution.constructTransactions().toGroup());
    event.register();

    assert.ok(f.ledger.verify().ok, "ledger verifies after expensing into a terminal account");
    assert.equal(f.exchangeExpense.getBalance(f.cad, f.ledger.transactions), 200, "the terminal record counts toward the account balance");

    // The terminal records are real transaction outputs, but they appear in NO account's lot store —
    // no FIFO/disposal/selection path can ever reach them.
    for (const account of [...f.ledger.netAssets.getAccounts(), ...f.ledger.equity.getAccounts()])
        for (const store of account.lotStores.values())
            for (const utxo of store.utxos)
                assert.equal(utxo instanceof TerminalUTXO, false, "no TerminalUTXO is ever held as a spendable lot");
});
