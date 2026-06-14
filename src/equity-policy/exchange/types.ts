import { ResidualAccount } from "../../ledger-kernel/accounts/computed.js";
import type { Input, UTXOConsumption } from "../../ledger-kernel/transactions/inputs.js";
import type { Output, UTXIConsumption } from "../../ledger-kernel/transactions/outputs.js";
import type { Position } from "../../ledger-kernel/positions.js";

/**
 * Either a single {@link ResidualAccount} that receives both gains and losses, or a pair that
 * separates them — pass `{ gain, loss }` to route e.g. "Capital Gains" and "Capital Losses"
 * to distinct accounts. All equity-policy functions accept this union transparently.
 */
export type ResidualTarget = ResidualAccount | { gain: ResidualAccount; loss: ResidualAccount };

/** Returns the account that should receive gain residuals from `target`. */
export function gainAccountOf(target: ResidualTarget): ResidualAccount {
    return target instanceof ResidualAccount ? target : target.gain;
}

/** Returns the account that should receive loss residuals from `target`. */
export function lossAccountOf(target: ResidualTarget): ResidualAccount {
    return target instanceof ResidualAccount ? target : target.loss;
}

/** The paired outputs of {@link Exchange.recapture} — the two sides of a locked-rate reversal. */
export interface ExchangeRecapture {
    /** {@link UTXIConsumption} settling the to-side of the original exchange. Goes in a transaction's outputs. */
    from: UTXIConsumption;
    /** {@link UTXOConsumption} reclaiming the from-side of the original exchange. Goes in a transaction's inputs. */
    to: UTXOConsumption;
}

/** A single-position settlement transaction emitted as part of a multi-hop unwind. */
export interface HopTransaction {
    position: Position;
    inputs: Input[];
    outputs: Output[];
}
