/*

// ─── Phase #0: Opening balance 0.02 BTC ──────────────────────────────────────
function phase0(): TransactionConstruct {
    const inputs = openingBalance.generateInputs(btc, 0.02, ledger.transactions);
    const outputs = wallet.generateOutputs(btc, 0.02, ledger.transactions);

    return {
        inputs: inputs,
        outputs: outputs,
        transaction: ledger.newTransaction(inputs, outputs)
    }
}

// ─── Phase #1: Exchange 0.01 BTC → 1000 CAD ──────────────────────────────────
function phase1(): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    exchange: ExchangeResolution
} {
    const fromInputs = wallet.generateInputs(btc, 0.01, ledger.transactions);
    const swap = exchange(fromInputs, cad, 1000, engine, ledger.transactions, capitalGainsBtc);
    const fromOutputs: Output[] = swap.getFromOutputs();
    const toInputs: Input[] = swap.getToInputs();
    const toOutputs: Output[] = [...cash.generateOutputs(cad, 1000, ledger.transactions), ...swap.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: fromInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(fromInputs, fromOutputs),
    };
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    for (const { inputs, outputs } of swap.getResidualSettlements())
        ledger.newTransaction(inputs, outputs);

    return { from, to, exchange: swap };
}

// ─── Phase #2: 525 CAD — 500 CAD exchanged for 375 USD, 25 CAD expensed ──────
function phase2(): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    expenseTransactions: Transaction[],
    cadExchange: ExchangeResolution,
    expenseResolution: ExpenseResolution
} {
    const exchangeInputs = cash.generateInputs(cad, 500, ledger.transactions);
    const expenseInputs  = cash.generateInputs(cad, 25,  ledger.transactions);
    const cadExchange = exchange(exchangeInputs, usd, 375, engine, ledger.transactions, capitalGainsBtc);
    const expenseRes  = expense(expenseInputs, engine, ledger.transactions, capitalGainsBtc);

    const fromInputs = [...exchangeInputs, ...expenseInputs];
    const fromOutputs: Output[] = [
        ...cadExchange.getFromOutputs(),
        ...expenseRes.getFromOutputs(exchangeExpense, ledger.transactions),
    ];
    const toInputs: Input[] = cadExchange.getToInputs();
    const toOutputs = [...cash.generateOutputs(usd, 375, ledger.transactions), ...cadExchange.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: fromInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(fromInputs, fromOutputs),
    };
    const expenseTransactions = expenseRes.createTransactions(exchangeExpense, ledger);
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    for (const { inputs, outputs } of cadExchange.getResidualSettlements())
        ledger.newTransaction(inputs, outputs);

    return { from, to, expenseTransactions, cadExchange, expenseResolution: expenseRes };
}

// ─── Phase #3: Exchange 375 USD → 550 CAD (50 CAD capital gain) ──────────────
function phase3(proceeds: number): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    usdExchange: ExchangeResolution
} {
    const usdInputs = cash.generateInputs(usd, 375, ledger.transactions);
    const usdExchange = exchange(usdInputs, cad, proceeds, engine, ledger.transactions, capitalGainsCad);
    // Consuming tx: close recaptured prior exchanges, then open the forward exchange (if any).
    // For phase3 the full 375 USD traces to cadExchange, so exchange is null — recaptures only.
    const fromOutputs: Output[] = usdExchange.getFromOutputs();
    // Receiving tx: re-open recapture from-sides, forward exchange to-side, gain residual.
    // The 50 CAD gain lands in capitalGains as a ResidualUTXI.
    const toInputs: Input[] = usdExchange.getToInputs();
    const toOutputs = [...cash.generateOutputs(cad, proceeds, ledger.transactions), ...usdExchange.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: usdInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(usdInputs, fromOutputs),
    };
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    // A loss residual settles immediately into its origin position(s) via standalone transactions.
    for (const { inputs, outputs } of usdExchange.getResidualSettlements())
        ledger.newTransaction(inputs, outputs);

    return { from, to, usdExchange };
}

// ─── Phase #4: Exchange full CAD cash balance → BTC at 900,000 CAD/BTC ──────
function phase4(): {
    from: TransactionConstruct,
    to: TransactionConstruct,
    cadExchange: ExchangeResolution
} {
    const cadBalance = cash.getBalance(cad, ledger.transactions);
    const btcProceeds = cadBalance / 80_000;
    const cadInputs = cash.generateInputs(cad, cadBalance, ledger.transactions);
    const cadExchange = exchange(cadInputs, btc, btcProceeds, engine, ledger.transactions, capitalGainsBtc);
    const fromOutputs: Output[] = cadExchange.getFromOutputs();
    const toInputs: Input[] = cadExchange.getToInputs();
    const toOutputs = [...wallet.generateOutputs(btc, btcProceeds, ledger.transactions), ...cadExchange.getToOutputs()];

    const from: TransactionConstruct = {
        inputs: cadInputs,
        outputs: fromOutputs,
        transaction: ledger.newTransaction(cadInputs, fromOutputs),
    };
    const to: TransactionConstruct = {
        inputs: toInputs,
        outputs: toOutputs,
        transaction: ledger.newTransaction(toInputs, toOutputs),
    };

    for (const { inputs, outputs } of cadExchange.getResidualSettlements())
        ledger.newTransaction(inputs, outputs);

    return { from, to, cadExchange };
}

phase0();
phase1();
phase2();
phase3(550);
phase4();
*/