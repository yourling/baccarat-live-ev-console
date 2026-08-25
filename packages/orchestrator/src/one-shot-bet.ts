import type { BetExecutionRequest, BrowserAdapter } from '@baccarat/adapter-contract';
import {
  newId,
  type BetIntent,
  type BetReceipt,
  type BettingMarket,
  type RiskLimits,
  type ShoeStateProjection,
  type TableProfile,
} from '@baccarat/contracts';
import { SqliteLedger } from '@baccarat/ledger-state';
import { RiskManager } from '@baccarat/risk-execution';

export interface OneShotBetCommand {
  readonly shoeId: string;
  readonly handId: string;
  readonly market: BettingMarket;
  readonly amount: number;
}

export type OneShotBetRejectionReason =
  | 'invalid-command'
  | 'physical-shoe-required'
  | 'connected-required'
  | 'betting-window-required'
  | 'current-shoe-mismatch'
  | 'current-hand-mismatch'
  | 'shoe-sealed'
  | 'betting-window-closed'
  | 'auto-bet-armed'
  | 'executor-required'
  | 'duplicate'
  | 'risk-rejected'
  | 'exact-amount-not-reserved'
  | 'receipt-mismatch'
  | 'platform-rejected';

type OneShotUnknownReason = 'executor-no-receipt' | 'executor-error' | 'platform-unknown';

export type OneShotBetResult =
  | { readonly status: 'ACCEPTED'; readonly receipt: BetReceipt; readonly reservationId: string }
  | {
      readonly status: 'REJECTED';
      readonly reason: OneShotBetRejectionReason;
      readonly receipt?: BetReceipt;
      readonly reservationId?: string;
      readonly riskReason?: string;
    }
  | {
      readonly status: 'UNKNOWN';
      readonly reason: OneShotUnknownReason;
      readonly receipt?: BetReceipt;
      readonly reservationId: string;
    };

export interface OneShotBetContext {
  readonly tableId: string;
  readonly projection: ShoeStateProjection;
  readonly profile: TableProfile;
  readonly ledger: SqliteLedger;
  readonly riskManager: RiskManager;
  readonly riskLimits: RiskLimits;
  readonly executor: Pick<BrowserAdapter, 'requestBet'> | null;
  readonly requestTimeoutMs: number;
  readonly recordReceipt: (command: OneShotBetCommand, receipt: BetReceipt) => Promise<void>;
}

export async function executeOneShotBet(
  command: OneShotBetCommand,
  context: OneShotBetContext,
): Promise<OneShotBetResult> {
  const invalid = validateCommand(command);
  if (invalid) return rejected(invalid);
  const gate = gateReason(command, context);
  if (gate) return rejected(gate);
  if (context.executor === null) return rejected('executor-required');
  if (hasDuplicate(context.ledger, context.tableId, command)) return rejected('duplicate');

  const normalizedAmount = String(command.amount);
  const intent: BetIntent = {
    intentId: newId('int'),
    tableId: context.tableId,
    shoeId: command.shoeId,
    handId: command.handId,
    market: command.market,
    amount: command.amount,
    mode: 'live',
    idempotencyKey: `${context.tableId}:${command.shoeId}:${command.handId}:${command.market}:${normalizedAmount}:one-shot`,
    strategy: { type: 'fixed', market: command.market },
    decisionSnapshotId: `one-shot:${context.tableId}:${command.shoeId}:${command.handId}:${command.market}:${normalizedAmount}`,
    createdAt: new Date().toISOString(),
  };
  const reserve = context.riskManager.tryReserve(
    intent,
    context.profile,
    { ...context.riskLimits, insufficientBehavior: 'skip' },
  );
  if (!reserve.ok || !reserve.reservation || reserve.amount === undefined) {
    return rejected('risk-rejected', { riskReason: reserve.reason });
  }
  const reservationId = reserve.reservation.reservationId;
  if (reserve.amount !== command.amount || reserve.reservation.amount !== command.amount) {
    context.riskManager.release(reservationId, false, 'exact-amount-not-reserved');
    return rejected('exact-amount-not-reserved', { reservationId });
  }

  const request: BetExecutionRequest = { intent, mode: 'live', reservationId };
  let receipt: BetReceipt | null;
  try {
    receipt = await withTimeout(context.executor.requestBet(request), context.requestTimeoutMs);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return unknown(context, reservationId, 'executor-error');
  }
  if (receipt === null) return unknown(context, reservationId, 'executor-no-receipt');
  if (!receiptMatchesIntent(receipt, intent, reservationId)) {
    context.riskManager.release(reservationId, false, 'receipt-mismatch', receipt.receiptId);
    return rejected('receipt-mismatch', { reservationId });
  }
  if (receipt.status === 'SIMULATED') {
    context.riskManager.release(reservationId, false, 'receipt-mismatch', receipt.receiptId);
    return rejected('receipt-mismatch', { reservationId });
  }

  await context.recordReceipt(command, receipt);
  switch (receipt.status) {
    case 'ACCEPTED':
      return { status: 'ACCEPTED', receipt, reservationId };
    case 'REJECTED':
      return { status: 'REJECTED', reason: 'platform-rejected', receipt, reservationId };
    case 'UNKNOWN':
      return { status: 'UNKNOWN', reason: 'platform-unknown', receipt, reservationId };
    default:
      return assertNever(receipt.status);
  }
}

function validateCommand(command: OneShotBetCommand): OneShotBetRejectionReason | null {
  return command
    && typeof command.shoeId === 'string'
    && command.shoeId.length > 0
    && typeof command.handId === 'string'
    && command.handId.length > 0
    && isMarket(command.market)
    && Number.isFinite(command.amount)
    && command.amount > 0
    ? null
    : 'invalid-command';
}

function gateReason(
  command: OneShotBetCommand,
  context: OneShotBetContext,
): OneShotBetRejectionReason | null {
  const { projection } = context;
  if (projection.shoeBaseline !== 'physical-shoe') return 'physical-shoe-required';
  if (projection.connectionStatus !== 'CONNECTED') return 'connected-required';
  if (projection.status !== 'BETTING_WINDOW') return 'betting-window-required';
  if (command.shoeId !== projection.shoeId) return 'current-shoe-mismatch';
  if (command.handId !== projection.currentHandId) return 'current-hand-mismatch';
  if (projection.sealed) return 'shoe-sealed';
  if (!isWindowOpen(context.ledger, context.tableId, command)) return 'betting-window-closed';
  if (projection.autoBetStatus === 'ARMED') return 'auto-bet-armed';
  return null;
}

function isMarket(value: unknown): value is BettingMarket {
  return value === 'bankerPair' || value === 'playerPair';
}

function hasDuplicate(
  ledger: SqliteLedger,
  tableId: string,
  command: OneShotBetCommand,
): boolean {
  return ledger.hasReceipt(tableId, command.shoeId, command.handId, command.market)
    || ledger.listReservations(tableId).some(reservation => (
      reservation.shoeId === command.shoeId
      && reservation.handId === command.handId
      && reservation.market === command.market
    ));
}

function isWindowOpen(
  ledger: SqliteLedger,
  tableId: string,
  command: OneShotBetCommand,
): boolean {
  let latest: 'opened' | 'closed' | null = null;
  for (const event of ledger.listEvents(tableId)) {
    if (
      (event.type === 'bettingWindowOpened' || event.type === 'bettingWindowClosed')
      && event.shoeId === command.shoeId
      && event.handId === command.handId
      && event.market === command.market
    ) {
      latest = event.type === 'bettingWindowOpened' ? 'opened' : 'closed';
    }
  }
  return latest === 'opened';
}

function receiptMatchesIntent(
  receipt: BetReceipt,
  intent: BetIntent,
  reservationId: string,
): boolean {
  return receipt.intentId === intent.intentId
    && receipt.reservationId === reservationId
    && receipt.market === intent.market
    && receipt.amount === intent.amount
    && receipt.mode === intent.mode
    && receipt.mode === 'live';
}

function rejected(
  reason: OneShotBetRejectionReason,
  details: { readonly receipt?: BetReceipt; readonly reservationId?: string; readonly riskReason?: string } = {},
): OneShotBetResult {
  return { status: 'REJECTED', reason, ...details };
}

function unknown(
  context: OneShotBetContext,
  reservationId: string,
  reason: 'executor-no-receipt' | 'executor-error',
): OneShotBetResult {
  context.riskManager.markUnknown(reservationId, `one-shot-${reason}`);
  return { status: 'UNKNOWN', reason, reservationId };
}

function assertNever(value: never): never {
  throw new Error(`unexpected bet receipt status: ${String(value)}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OneShotTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class OneShotTimeoutError extends Error {
  readonly name = 'OneShotTimeoutError';
  constructor(timeoutMs: number) {
    super(`one-shot bet request timed out after ${timeoutMs}ms`);
  }
}
