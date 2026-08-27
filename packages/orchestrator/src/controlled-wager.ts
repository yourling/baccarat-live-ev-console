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
  readonly disarmOnUnknown: (reason: string) => Promise<void>;
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
  if (context.riskManager.hasUnknownReservations()) return rejected('unknown-execution-pending');
  if (command.source === 'keepalive' && !context.canExecuteAutomaticBets()) {
    return rejected('global-automation-disabled');
  }
  if (command.source === 'keepalive' && context.executionMode !== 'live') {
    return rejected('live-execution-required');
  }

  const projection = context.projection;
  const isManualSimulation = command.source === 'manual' && context.executionMode !== 'live';
  if (!isManualSimulation) {
    if (projection.shoeBaseline !== 'physical-shoe') return rejected('physical-shoe-required');
    if (projection.connectionStatus !== 'CONNECTED') return rejected('connected-required');
    if (projection.status !== 'BETTING_WINDOW') return rejected('betting-window-required');
    if (projection.sealed) return rejected('shoe-sealed');
    if (!projection.currentHandId) return rejected('current-hand-required');
    if (command.source === 'manual' && projection.autoBetStatus === 'ARMED') {
      return rejected('auto-bet-armed');
    }
    if (context.executor === null) return rejected('browser-bridge-unavailable');
  }

  const wagerId = newId('opw');
  const shoeId = projection.shoeId || `manual-test-shoe-${wagerId}`;
  const handId = projection.currentHandId || `manual-test-${wagerId}`;
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

  if (isManualSimulation) {
    const reason = `${context.executionMode}-simulated`;
    context.riskManager.release(reservation.reservationId, false, reason);
    return saveResult(context.ledger, wager, reservation.reservationId, 'ACCEPTED', reason);
  }

  const request: OperationalWagerExecutionRequest = { mode: 'live', wager };
  let receipt: OperationalWagerReceipt | null;
  try {
    receipt = await withTimeout(
      context.executor!.requestOperationalWager(request),
      context.requestTimeoutMs,
    );
  } catch (error) {
    const reason = bridgeRequestErrorReason(error);
    context.riskManager.markUnknown(reservation.reservationId, reason);
    const result = saveResult(
      context.ledger,
      wager,
      reservation.reservationId,
      'UNKNOWN',
      reason,
    );
    await context.disarmOnUnknown(reason);
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
    await context.disarmOnUnknown(reason);
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
    await context.disarmOnUnknown(reason);
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
    context.riskManager.release(
      reservation.reservationId,
      false,
      'receipt-rejected',
      receipt.receiptId,
    );
    return saveResult(
      context.ledger,
      wager,
      reservation.reservationId,
      'REJECTED',
      undefined,
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
  await context.disarmOnUnknown(reason);
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

function bridgeRequestErrorReason(error: unknown): string {
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
