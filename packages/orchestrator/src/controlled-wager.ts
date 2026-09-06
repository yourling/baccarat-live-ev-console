import {
  isOperationalWagerMarket,
  type OperationalWagerExecutionRequest,
  type OperationalWagerMarket,
  type OperationalWagerReceipt,
  type OperationalWagerSource,
} from '@baccarat/adapter-contract';
import {
  type ExecutionMode,
  type OddsConfig,
  type ShoeStateProjection,
  type TableProfile,
  newId,
} from '@baccarat/contracts';
import {
  SqliteLedger,
  effectiveShoeBaseline,
  isPhysicalShoeBettable,
  type OperationalWagerRecord,
} from '@baccarat/ledger-state';
import { RiskManager } from '@baccarat/risk-execution';

export interface OperationalWagerTerms {
  readonly banker: OddsConfig;
  readonly player: OddsConfig;
  readonly tiePolicy: 'push';
}

/**
 * Explicit standard commission baccarat terms. Platforms with no-commission
 * or Super Six rules must provide different terms instead of reusing this.
 */
export const STANDARD_COMMISSION_BACCARAT_TERMS: OperationalWagerTerms = {
  banker: { netWin: 0.95, loss: 1 },
  player: { netWin: 1, loss: 1 },
  tiePolicy: 'push',
};

export interface ControlledOperationalWagerCommand {
  readonly market: OperationalWagerMarket;
  readonly amount: number;
  readonly source: OperationalWagerSource;
  readonly handId?: string;
  readonly createdAt?: string;
}

export interface ControlledOperationalWagerResult {
  readonly status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  readonly tableId: string;
  readonly reason?: string;
  readonly reservationId?: string;
  readonly wager?: OperationalWagerRecord['wager'];
  readonly receipt?: OperationalWagerReceipt;
}

export type OperationalWagerExecutor = {
  requestOperationalWager(request: OperationalWagerExecutionRequest): Promise<OperationalWagerReceipt | null>;
};

export interface ControlledOperationalWagerContext {
  readonly tableId: string;
  readonly projection: ShoeStateProjection;
  readonly profile: TableProfile;
  readonly ledger: SqliteLedger;
  readonly riskManager: RiskManager;
  readonly riskLimits: Parameters<RiskManager['tryReserveExecution']>[3];
  readonly executionMode: ExecutionMode;
  readonly executor: OperationalWagerExecutor | null;
  readonly terms?: OperationalWagerTerms;
  readonly canExecuteAutomaticBets: () => boolean;
  readonly requestTimeoutMs: number;
}

export async function executeControlledOperationalWager(
  command: ControlledOperationalWagerCommand,
  context: ControlledOperationalWagerContext,
): Promise<ControlledOperationalWagerResult> {
  const rejected = (reason: string): ControlledOperationalWagerResult => ({
    status: 'REJECTED',
    tableId: context.tableId,
    reason,
  });
  if (!isOperationalWagerMarket(command.market)) return rejected('unsupported-market');
  if (!Number.isFinite(command.amount) || command.amount <= 0) return rejected('invalid-amount');
  if (context.executionMode !== 'live') {
    return rejected('live-execution-required');
  }

  const projection = context.projection;
  const manualHandId = command.source === 'manual' && typeof command.handId === 'string' && command.handId.trim().length > 0
    ? command.handId.trim()
    : undefined;
  if (projection.connectionStatus !== 'CONNECTED') return rejected('connected-required');
  if (projection.status !== 'BETTING_WINDOW') return rejected('betting-window-required');
  if (
    effectiveShoeBaseline(projection) !== 'physical-shoe'
    || !isPhysicalShoeBettable(projection)
  ) {
    return rejected('physical-shoe-required');
  }
  if (context.riskManager.hasUnknownReservations(context.tableId)) {
    return rejected('unknown-execution-pending');
  }
  if (projection.sealed) return rejected('shoe-sealed');
  if (command.source !== 'manual' && !projection.currentHandId) return rejected('current-hand-required');
  if (command.source === 'manual' && !manualHandId && !projection.currentHandId) {
    return rejected('current-hand-required');
  }
  if (context.executor === null) return rejected('browser-bridge-unavailable');

  const wagerId = newId('opw');
  const shoeId = projection.shoeId || `manual-test-shoe-${wagerId}`;
  const liveHandId = projection.currentHandId && projection.currentHandId.length > 0
    ? projection.currentHandId
    : undefined;
  const handId = command.source === 'manual'
    ? (projection.status === 'BETTING_WINDOW' && liveHandId ? liveHandId : manualHandId ?? liveHandId ?? `manual-test-${wagerId}`)
    : liveHandId ?? `manual-test-${wagerId}`;
  if (context.ledger.hasOperationalWager(
    context.tableId,
    shoeId,
    handId,
    command.market,
    command.source,
  )) {
    return rejected('duplicate');
  }

  const odds = operationalOdds(command.market, context.profile, context.terms);
  if (odds === null) return rejected('operational-terms-not-configured');
  const reserve = context.riskManager.tryReserveExecution({
    intentId: wagerId,
    tableId: context.tableId,
    shoeId,
    handId,
    market: command.market,
    executionSource: command.source,
    amount: command.amount,
  }, context.profile.limits, odds, context.riskLimits);
  if (!reserve.ok || reserve.reservation === undefined) {
    return rejected(reserve.reason ?? 'risk-rejected');
  }

  const reservation = reserve.reservation;
  const wager: OperationalWagerRecord['wager'] = {
    wagerId,
    tableId: context.tableId,
    shoeId,
    handId,
    market: command.market,
    amount: reservation.amount,
    source: command.source,
    createdAt: command.createdAt ?? new Date().toISOString(),
  };

  const request: OperationalWagerExecutionRequest = { mode: 'live', wager };
  let receipt: OperationalWagerReceipt | null;
  try {
    receipt = await withTimeout(
      context.executor!.requestOperationalWager(request),
      context.requestTimeoutMs,
    );
  } catch (error) {
    const reason = bridgeRequestErrorReason(error);
    const errorReceipt = operationalReceiptFromError(error);
    const matchingReceipt = errorReceipt && receiptMatchesWager(errorReceipt, wager)
      ? errorReceipt
      : undefined;
    context.riskManager.markUnknown(
      reservation.reservationId,
      reason,
      matchingReceipt?.receiptId,
    );
    const result = saveResult(
      context.ledger,
      wager,
      reservation.reservationId,
      'UNKNOWN',
      reason,
      matchingReceipt,
    );
    return result;
  }
  if (receipt === null) {
    const reason = 'bridge-no-receipt';
    context.riskManager.markUnknown(reservation.reservationId, reason);
    const result = saveResult(
      context.ledger,
      wager,
      reservation.reservationId,
      'UNKNOWN',
      reason,
    );
    return result;
  }
  if (!receiptMatchesWager(receipt, wager)) {
    const reason = 'bridge-receipt-mismatch';
    context.riskManager.markUnknown(reservation.reservationId, reason, receipt.receiptId);
    const result = saveResult(
      context.ledger,
      wager,
      reservation.reservationId,
      'UNKNOWN',
      reason,
    );
    return result;
  }

  if (receipt.status === 'ACCEPTED') {
    context.riskManager.attachReceipt(reservation.reservationId, receipt.receiptId);
    return saveResult(
      context.ledger,
      wager,
      reservation.reservationId,
      'ACCEPTED',
      undefined,
      receipt,
    );
  }
  if (receipt.status === 'REJECTED') {
    if (receiptCommitStarted(receipt)) {
      const reason = 'committed-rejection-uncertain';
      context.riskManager.markUnknown(reservation.reservationId, reason, receipt.receiptId);
      const result = saveResult(
        context.ledger,
        wager,
        reservation.reservationId,
        'UNKNOWN',
        reason,
        receipt,
      );
      return result;
    }
    const reason = receiptReason(receipt) ?? 'receipt-rejected';
    context.riskManager.release(
      reservation.reservationId,
      false,
      reason,
      receipt.receiptId,
    );
    return saveResult(
      context.ledger,
      wager,
      reservation.reservationId,
      'REJECTED',
      reason,
      receipt,
    );
  }

  const reason = 'platform-acknowledgement-unknown';
  context.riskManager.markUnknown(reservation.reservationId, reason, receipt.receiptId);
  const result = saveResult(
    context.ledger,
    wager,
    reservation.reservationId,
    'UNKNOWN',
    reason,
    receipt,
  );
  return result;
}

function operationalOdds(
  market: OperationalWagerMarket,
  profile: TableProfile,
  terms: OperationalWagerTerms | undefined,
): OddsConfig | null {
  if (market === 'bankerPair' || market === 'playerPair') return profile.odds[market];
  if (terms === undefined || terms.tiePolicy !== 'push') return null;
  return terms[market];
}

function saveResult(
  ledger: SqliteLedger,
  wager: OperationalWagerRecord['wager'],
  reservationId: string,
  status: ControlledOperationalWagerResult['status'],
  reason?: string,
  receipt?: OperationalWagerReceipt,
): ControlledOperationalWagerResult {
  ledger.saveOperationalWager({
    wager,
    reservationId,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(receipt === undefined ? {} : { receipt }),
  });
  return {
    status,
    tableId: wager.tableId,
    wager,
    reservationId,
    ...(reason === undefined ? {} : { reason }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function receiptReason(receipt: OperationalWagerReceipt): string | undefined {
  const raw = receipt.raw;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const reason = Reflect.get(raw, 'reason');
  return typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : undefined;
}

function receiptMatchesWager(
  receipt: OperationalWagerReceipt,
  wager: OperationalWagerRecord['wager'],
): boolean {
  return receipt.wagerId === wager.wagerId
    && receipt.tableId === wager.tableId
    && receipt.shoeId === wager.shoeId
    && receipt.handId === wager.handId
    && receipt.market === wager.market
    && receipt.amount === wager.amount
    && receipt.source === wager.source;
}

function receiptCommitStarted(receipt: OperationalWagerReceipt): boolean {
  return typeof receipt.raw === 'object'
    && receipt.raw !== null
    && Reflect.get(receipt.raw, 'commitStarted') === true;
}

function operationalReceiptFromError(error: unknown): OperationalWagerReceipt | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const receipt = Reflect.get(error, 'receipt');
  if (typeof receipt !== 'object' || receipt === null) return undefined;
  const status = Reflect.get(receipt, 'status');
  if (status !== 'ACCEPTED' && status !== 'REJECTED' && status !== 'UNKNOWN') return undefined;
  return receipt as OperationalWagerReceipt;
}

function bridgeRequestErrorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = Reflect.get(error, 'name');
    const message = Reflect.get(error, 'message');
    if (
      name === 'OperationalWagerRuntimeRevisionError'
      || (typeof message === 'string' && message.includes('runtime revision mismatch'))
    ) {
      return 'browser-extension-bet-runtime-outdated';
    }
  }
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const message = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  return message.length === 0 ? 'bridge-request-error' : `bridge-request-error:${message}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`requestOperationalWager timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
