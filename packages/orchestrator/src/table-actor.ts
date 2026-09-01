import type {
  BetExecutionRequest,
  BrowserAdapter,
} from '@baccarat/adapter-contract';
import {
  EVENT_SCHEMA_VERSION,
  assertValidRiskLimits,
  assertValidTableProfile,
  type BetIntent,
  type BetReceipt,
  type BetTier,
  type DecisionSnapshot,
  type ExecutionMode,
  type ManualCorrection,
  type NormalizedEvent,
  type RiskExposureState,
  type RiskLimits,
  type RiskReservation,
  type ShoeStateProjection,
  type TableProfile,
  newId,
} from '@baccarat/contracts';
import {
  SqliteLedger,
  applyEvent,
  effectiveShoeBaseline,
  emptyProjection,
  modelRevisionFor,
  operationalReceiptCommitStarted,
  profileVersionFor,
} from '@baccarat/ledger-state';
import { evaluatePairMarket } from '@baccarat/probability';
import { RiskManager, emptyRiskState } from '@baccarat/risk-execution';
import {
  executeControlledOperationalWager,
  type ControlledOperationalWagerCommand,
  type ControlledOperationalWagerResult,
  type OperationalWagerExecutor,
  type OperationalWagerTerms,
} from './controlled-wager.js';
import {
  executeOneShotBet,
  type OneShotBetCommand,
  type OneShotBetResult,
} from './one-shot-bet.js';
import { selectMarkets } from './strategy.js';

export interface TableActorOptions {
  tableId: string;
  profile: TableProfile;
  ledger: SqliteLedger;
  riskManager: RiskManager;
  executor?: Pick<BrowserAdapter, 'requestBet'> | null;
  operationalExecutor?: OperationalWagerExecutor | null;
  operationalWagerTerms?: OperationalWagerTerms;
  canExecuteAutomaticBets?: (tableId: string) => boolean;
  onBettingWindowOpened?: (tableId: string) => void;
  executionMode: 'shadow' | 'simulated' | 'live';
  defaultBetAmount: number;
  riskLimits: RiskLimits;
  requestTimeoutMs?: number;
}

interface QueueItem {
  run: () => Promise<void>;
  reject: (reason?: unknown) => void;
}

export interface TableActorSnapshot {
  tableId: string;
  profile: TableProfile;
  projection: ShoeStateProjection;
  executionMode: 'shadow' | 'simulated' | 'live';
  defaultBetAmount: number;
  pendingEvents: number;
}

// allow: SIZE_OK — event-sourced per-table state machine; one-shot execution is extracted.
export class TableActor {
  readonly tableId: string;
  private readonly ledger: SqliteLedger;
  private readonly riskManager: RiskManager;
  private executor: Pick<BrowserAdapter, 'requestBet'> | null;
  private operationalExecutor: OperationalWagerExecutor | null;
  private readonly operationalWagerTerms?: OperationalWagerTerms;
  private readonly canExecuteAutomaticBets: (tableId: string) => boolean;
  private readonly onBettingWindowOpened?: (tableId: string) => void;
  private profile: TableProfile;
  private executionMode: 'shadow' | 'simulated' | 'live';
  private defaultBetAmount: number;
  private riskLimits: RiskLimits;
  private readonly requestTimeoutMs: number;
  private queue: QueueItem[] = [];
  private processing = false;
  private projection: ShoeStateProjection;
  private readonly reminderKeys = new Set<string>();
  private readonly placedKeys = new Set<string>();
  private readonly placedHandKeys = new Set<string>();
  private readonly evaluatedWindows = new Map<string, { hadClosesAt: boolean }>();
  private syntheticSeq = SYNTHETIC_SEQ_BASE;
  private alternateNext: 'bankerPair' | 'playerPair';

  constructor(options: TableActorOptions) {
    if (!Number.isFinite(options.defaultBetAmount) || options.defaultBetAmount <= 0) {
      throw new Error('defaultBetAmount must be a positive finite number');
    }
    this.tableId = options.tableId;
    this.ledger = options.ledger;
    this.riskManager = options.riskManager;
    this.executor = options.executor ?? null;
    this.operationalExecutor = options.operationalExecutor ?? null;
    this.operationalWagerTerms = options.operationalWagerTerms;
    this.canExecuteAutomaticBets = options.canExecuteAutomaticBets ?? (() => true);
    this.onBettingWindowOpened = options.onBettingWindowOpened;
    this.profile = structuredClone(options.profile);
    this.executionMode = options.executionMode;
    this.defaultBetAmount = options.defaultBetAmount;
    this.riskLimits = structuredClone(options.riskLimits);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
    this.syntheticSeq = Math.max(SYNTHETIC_SEQ_BASE, this.ledger.nextSourceSeq(this.tableId));

    const replay = this.ledger.replay(this.tableId, { latestShoeOnly: true });
    this.projection = replay.state.get(this.tableId) ?? emptyProjection(this.tableId);

    for (const row of this.ledger.listReceipts(this.tableId)) {
      this.placedKeys.add(placedKey(row.tableId, row.shoeId, row.handId, row.market));
    }
    for (const reservation of this.ledger.listReservations(this.tableId)) {
      if ((reservation.executionSource ?? 'strategy') === 'strategy') {
        this.placedHandKeys.add(placedHandKey(reservation.tableId, reservation.shoeId, reservation.handId));
      }
    }
    for (const decision of this.ledger.listDecisions(this.tableId)) {
      if (decision.eligible) {
        this.reminderKeys.add(reminderKey(decision.shoeId, decision.handId, decision.modelRevision, decision.market));
      }
    }

    if (this.profile.betStrategy.type === 'alternate') {
      const receipts = this.ledger.listReceipts(this.tableId);
      const last = receipts[receipts.length - 1];
      this.alternateNext = last
        ? last.receipt.market === 'bankerPair' ? 'playerPair' : 'bankerPair'
        : this.profile.betStrategy.start;
    } else {
      this.alternateNext = 'bankerPair';
    }

    this.riskManager.reconcileTable(this.tableId, this.projection.shoeId, this.projection.sealed);
  }

  enqueue(event: NormalizedEvent): Promise<void> {
    if (event.tableId !== this.tableId) {
      return Promise.reject(new Error(`event tableId ${event.tableId} does not match actor tableId ${this.tableId}`));
    }
    return this.enqueueTask(() => this.handleEvent(event));
  }

  placeOneShotBet(command: OneShotBetCommand): Promise<OneShotBetResult> {
    return this.enqueueTask(() => executeOneShotBet(command, {
      tableId: this.tableId,
      projection: this.projection,
      profile: this.profile,
      ledger: this.ledger,
      riskManager: this.riskManager,
      riskLimits: this.riskLimits,
      executor: this.executor,
      requestTimeoutMs: Math.max(this.requestTimeoutMs, 12_000),
      recordReceipt: (receiptCommand, receipt) => this.recordOneShotReceipt(receiptCommand, receipt),
    }));
  }

  placeOperationalWager(
    command: ControlledOperationalWagerCommand,
  ): Promise<ControlledOperationalWagerResult> {
    return this.enqueueTask(() => executeControlledOperationalWager(command, {
      tableId: this.tableId,
      projection: this.projection,
      profile: this.profile,
      ledger: this.ledger,
      riskManager: this.riskManager,
      riskLimits: this.riskLimits,
      executionMode: this.executionMode,
      executor: this.operationalExecutor,
      terms: this.operationalWagerTerms,
      canExecuteAutomaticBets: () => this.canExecuteAutomaticBets(this.tableId),
      requestTimeoutMs: Math.max(this.requestTimeoutMs, 12_000),
    }));
  }

  async flush(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  getProjection(): ShoeStateProjection {
    return structuredClone(this.projection);
  }

  peekProjection(): ShoeStateProjection {
    return this.projection;
  }

  peekExecutionMode(): ExecutionMode {
    return this.executionMode;
  }

  setExecutor(executor: Pick<BrowserAdapter, 'requestBet'> | null): void {
    this.executor = executor;
  }

  setOperationalExecutor(executor: OperationalWagerExecutor | null): void {
    this.operationalExecutor = executor;
  }

  getProfile(): TableProfile {
    return structuredClone(this.profile);
  }

  getRiskLimits(): RiskLimits {
    return structuredClone(this.riskLimits);
  }

  updateRiskLimits(limits: RiskLimits): void {
    assertValidRiskLimits(limits);
    this.riskLimits = structuredClone(limits);
  }

  updateConfiguration(profile: TableProfile, defaultBetAmount: number): void {
    assertValidTableProfile(profile);
    if (profile.tableId !== this.tableId) throw new Error(`profile tableId ${profile.tableId} does not match actor tableId ${this.tableId}`);
    if (!Number.isFinite(defaultBetAmount) || defaultBetAmount <= 0) {
      throw new RangeError('defaultBetAmount must be a positive finite number');
    }
    this.profile = structuredClone(profile);
    this.defaultBetAmount = defaultBetAmount;
    this.projection = {
      ...this.projection,
      profileSnapshot: structuredClone(profile),
      modelRevision: modelRevisionFor(profile),
    };
  }

  setExecutionMode(_mode: ExecutionMode): void {
    this.executionMode = 'live';
  }

  snapshot(): TableActorSnapshot {
    const projection = this.projection;
    return {
      tableId: this.tableId,
      profile: this.profile,
      projection: {
        ...projection,
        remainingCounts: { ...projection.remainingCounts },
        seenCards: [],
        cardInventoryKeys: [],
        observedHandIds: projection.observedHandIds.length > 8
          ? projection.observedHandIds.slice(-8)
          : projection.observedHandIds,
      },
      executionMode: this.executionMode,
      defaultBetAmount: this.defaultBetAmount,
      pendingEvents: this.queue.length,
    };
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        try {
          await item.run();
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private enqueueTask<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: async () => {
          resolve(await task());
        },
        reject,
      });
      void this.drain();
    });
  }

  private async handleEvent(event: NormalizedEvent): Promise<void> {
    const previousProjection = this.projection;
    const watermark = previousProjection.eventWatermark + 1;
    const tentativeState = applyEvent(new Map([[this.tableId, previousProjection]]), event, watermark);
    const tentativeProjection = tentativeState.get(this.tableId) ?? emptyProjection(this.tableId);
    const appended = this.ledger.appendEvent(event);
    if (appended === 'duplicate') {
      await this.recoverSideEffects(event, previousProjection);
      return;
    }
    this.projection = tentativeProjection;

    if (event.type === 'newShoeSignal') {
      this.evaluatedWindows.clear();
      if (previousProjection.shoeId && previousProjection.shoeId !== event.shoeId) {
        this.riskManager.expireOpenForShoe(this.tableId, previousProjection.shoeId, 'new-shoe-signal-received');
      }
      return;
    }
    if (event.type === 'bettingWindowOpened') {
      await this.evaluateWindow(event, this.projection);
      return;
    }
    if (event.type === 'bettingWindowClosed' && event.openingObserved === false) {
      this.recordUnobservableWindow(event, this.projection);
      return;
    }
    if (event.type === 'handSettled') {
      this.applyHandSettlement(event);
      return;
    }
    if (event.type === 'betReceipt') {
      await this.processReceipt(event.receipt, event.shoeId, event.handId, event.market);
      return;
    }
    if (event.type === 'shoeInvalidated') {
      const invalidatedShoe = event.shoeId ?? previousProjection.shoeId;
      if (invalidatedShoe) {
        this.riskManager.expireOpenForShoe(this.tableId, invalidatedShoe, 'shoe-invalidated');
      }
    }
  }

  private async recoverSideEffects(event: NormalizedEvent, previousProjection: ShoeStateProjection): Promise<void> {
    if (event.type === 'newShoeSignal') {
      if (previousProjection.shoeId && previousProjection.shoeId !== event.shoeId) {
        this.riskManager.expireOpenForShoe(this.tableId, previousProjection.shoeId, 'new-shoe-signal-received');
      }
      return;
    }
    if (event.type === 'bettingWindowOpened') {
      await this.evaluateWindow(event, this.projection);
      return;
    }
    if (event.type === 'bettingWindowClosed' && event.openingObserved === false) {
      this.recordUnobservableWindow(event, this.projection);
      return;
    }
    if (event.type === 'handSettled') {
      this.applyHandSettlement(event);
      return;
    }
    if (event.type === 'betReceipt') {
      await this.processReceipt(event.receipt, event.shoeId, event.handId, event.market);
      return;
    }
    if (event.type === 'shoeInvalidated') {
      const invalidatedShoe = event.shoeId ?? previousProjection.shoeId;
      if (invalidatedShoe) {
        this.riskManager.expireOpenForShoe(this.tableId, invalidatedShoe, 'shoe-invalidated');
      }
    }
  }

  private applyHandSettlement(event: Extract<NormalizedEvent, { type: 'handSettled' }>): void {
    const settlement = {
      outcomes: event.outcomes,
      playerCards: event.playerCards,
      bankerCards: event.bankerCards,
    };
    this.riskManager.settleHand(this.tableId, event.shoeId, event.handId, settlement);
    this.settleCommittedUnknownOperationalWagers(event, settlement);
  }

  private settleCommittedUnknownOperationalWagers(
    event: Extract<NormalizedEvent, { type: 'handSettled' }>,
    settlement: {
      outcomes?: { bankerPair: boolean; playerPair: boolean };
      playerCards: readonly { rank: string }[];
      bankerCards: readonly { rank: string }[];
    },
  ): void {
    for (const record of this.ledger.listOperationalWagersTail(200)) {
      if (record.status !== 'UNKNOWN' || record.reservationId === undefined) continue;
      if (record.receipt?.status !== 'UNKNOWN') continue;
      if (record.wager.tableId !== this.tableId) continue;
      if (record.wager.handId !== event.handId) continue;
      if (!operationalReceiptCommitStarted(record.receipt?.raw)) continue;
      const reservation = this.riskManager.snapshot(this.tableId)
        .find(candidate => candidate.reservationId === record.reservationId);
      if (reservation === undefined) continue;
      if (reservation.status === 'UNKNOWN') {
        try {
          this.riskManager.settleUnknown(record.reservationId, settlement, 'committed-hand-settled');
        } catch {
          continue;
        }
      } else if (reservation.status !== 'SETTLED') {
        continue;
      }
      if (record.reconciliation !== undefined) continue;
      this.ledger.reconcileOperationalWager(record.wager.wagerId, {
        status: 'ACCEPTED',
        reason: 'committed-hand-settled',
        reconciledAt: new Date().toISOString(),
      });
    }
  }

  private async evaluateWindow(
    event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>,
    projection: ShoeStateProjection,
  ): Promise<void> {
    if (event.shoeId !== projection.shoeId || projection.sealed) return;
    if (projection.status !== 'BETTING_WINDOW') return;
    if (effectiveShoeBaseline(projection) !== 'physical-shoe') {
      this.requestKeepalive();
      return;
    }
    const evalKey = `${event.shoeId}:${event.handId}:${event.market}`;
    const previousEval = this.evaluatedWindows.get(evalKey);
    const hasClosesAt = typeof event.closesAt === 'string' && event.closesAt.length > 0;
    if (previousEval !== undefined && (previousEval.hadClosesAt || !hasClosesAt)) return;
    const evaluation = evaluatePairMarket(this.profile, event.market, projection.seenCards);
    const eligible = evaluation.evLower >= this.profile.minEV;
    const reason = eligible
      ? `evLower=${evaluation.evLower.toFixed(6)} >= minEV=${this.profile.minEV}`
      : `evLower=${evaluation.evLower.toFixed(6)} < minEV=${this.profile.minEV}`;

    if (projection.autoBetStatus !== 'ARMED') {
      this.requestKeepalive();
      return;
    }
    this.evaluatedWindows.set(evalKey, { hadClosesAt: hasClosesAt || previousEval?.hadClosesAt === true });
    if (!this.canExecuteAutomaticBets(this.tableId)) {
      this.recordDecision(event, projection, eligible, reason, 'global-automation-disabled');
      return;
    }

    const strategyResult = selectMarkets(this.profile.betStrategy, {
      market: event.market,
      eventId: event.eventId,
      alternateNext: this.alternateNext,
    });

    const snapshot = this.recordDecision(
      event,
      projection,
      eligible,
      reason,
      strategyResult.auditNote,
      strategyResult.choice,
    );
    if (!snapshot) return;

    if (!eligible) {
      this.requestKeepalive();
      return;
    }
    // 策略门控:策略未选中当前市场时,只记录决策审计,绝不创建 intent/下注。
    if (!strategyResult.selected) {
      this.requestKeepalive();
      return;
    }
    if (this.profile.betStrategy.type === 'both') {
      const banker = evaluatePairMarket(this.profile, 'bankerPair', projection.seenCards);
      const player = evaluatePairMarket(this.profile, 'playerPair', projection.seenCards);
      const preferredMarket = player.evLower > banker.evLower ? 'playerPair' : 'bankerPair';
      if (event.market !== preferredMarket) {
        this.requestKeepalive();
        return;
      }
    }
    const closesAt = event.closesAt ?? projection.bettingWindowClosesAt;
    const eventMs = Date.parse(event.timestamp);
    const closesAtMs = typeof closesAt === 'string' ? Date.parse(closesAt) : Number.NaN;
    const liveSkewMs = Number.isFinite(eventMs) ? Math.abs(Date.now() - eventMs) : Number.POSITIVE_INFINITY;
    const windowNowMs = liveSkewMs < 60_000 ? Date.now() : eventMs;
    if (Number.isFinite(windowNowMs) && Number.isFinite(closesAtMs) && closesAtMs - windowNowMs < 3_000) {
      this.requestKeepalive();
      return;
    }
    const handPlaced = placedHandKey(this.tableId, event.shoeId, event.handId);
    if (this.placedHandKeys.has(handPlaced)) return;
    const reminder = reminderKey(event.shoeId, event.handId, projection.modelRevision, event.market);
    if (this.reminderKeys.has(reminder)) return;
    this.reminderKeys.add(reminder);

    const placed = placedKey(this.tableId, event.shoeId, event.handId, event.market);
    if (this.placedKeys.has(placed) || this.ledger.hasReceipt(this.tableId, event.shoeId, event.handId, event.market)) {
      return;
    }

    const intent: BetIntent = {
      intentId: newId('int'),
      tableId: this.tableId,
      shoeId: event.shoeId,
      handId: event.handId,
      market: event.market,
      amount: selectBetAmount(this.profile, evaluation.evLower, this.defaultBetAmount, this.riskLimits),
      mode: 'live',
      idempotencyKey: `${this.tableId}:${event.shoeId}:${event.handId}:${event.market}:${projection.modelRevision}`,
      strategy: this.profile.betStrategy,
      decisionSnapshotId: snapshot.snapshotId,
      createdAt: new Date().toISOString(),
    };

    const reserve = this.riskManager.tryReserve(intent, this.profile, this.riskLimits);
    if (!reserve.ok) {
      this.requestKeepalive();
      return;
    }
    const reservation = reserve.reservation!;
    this.placedKeys.add(placed);
    this.placedHandKeys.add(handPlaced);

    if (!this.executor) {
      this.riskManager.release(reservation.reservationId, false, 'no-executor-configured');
      this.requestKeepalive();
      return;
    }

    const req: BetExecutionRequest = { intent, mode: 'live', reservationId: reservation.reservationId };
    let receipt: BetReceipt | null;
    try {
      receipt = await withTimeout(this.executor.requestBet(req), this.requestTimeoutMs);
    } catch {
      receipt = unknownExecutionReceipt(intent, reservation, 'executor-timeout-or-error');
    }
    receipt ??= unknownExecutionReceipt(intent, reservation, 'executor-no-receipt');
    if (receipt) {
      if (!receiptMatchesIntent(receipt, intent, reservation)) {
        this.riskManager.release(reservation.reservationId, false, 'receipt-mismatch', receipt.receiptId);
        return;
      }
      if (isRetryableWindowRejection(receipt)) {
        this.placedKeys.delete(placed);
        this.placedHandKeys.delete(handPlaced);
        this.reminderKeys.delete(reminder);
        this.evaluatedWindows.delete(evalKey);
        this.riskManager.release(reservation.reservationId, false, 'window-not-ready', receipt.receiptId);
        return;
      }
      const receiptEvent: NormalizedEvent = {
        type: 'betReceipt',
        eventId: newId('evt'),
        tableId: this.tableId,
        timestamp: receipt.createdAt,
        sourceSeq: this.nextSyntheticSeq(),
        source: 'orchestrator',
        schemaVersion: EVENT_SCHEMA_VERSION,
        shoeId: event.shoeId,
        handId: event.handId,
        market: event.market,
        receipt,
      };
      await this.handleEvent(receiptEvent);
    }
  }

  private requestKeepalive(): void {
    this.onBettingWindowOpened?.(this.tableId);
  }

  private recordUnobservableWindow(
    event: Extract<NormalizedEvent, { type: 'bettingWindowClosed' }>,
    projection: ShoeStateProjection,
  ): void {
    if (event.shoeId !== projection.shoeId || projection.sealed) return;
    if (projection.autoBetStatus !== 'ARMED') return;
    this.recordDecision(
      event,
      projection,
      false,
      'betting-window-not-observable; execution-forbidden',
    );
  }

  private recordDecision(
    event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' | 'bettingWindowClosed' }>,
    projection: ShoeStateProjection,
    eligible: boolean,
    reason: string,
    auditNote?: string,
    strategyChoice?: DecisionSnapshot['strategyChoice'],
  ): DecisionSnapshot | null {
    const result = evaluatePairMarket(this.profile, event.market, projection.seenCards);
    const snapshot: DecisionSnapshot = {
      snapshotId: newId('dec'),
      tableId: this.tableId,
      shoeId: event.shoeId,
      handId: event.handId,
      market: event.market,
      eventId: event.eventId,
      eventWatermark: projection.eventWatermark,
      profileVersion: profileVersionFor(this.profile),
      modelRevision: projection.modelRevision,
      pMean: result.pMean,
      pLower: result.pLower,
      evMean: result.evMean,
      evLower: result.evLower,
      eligible,
      reason: auditNote ? `${reason}; strategy=${auditNote}` : reason,
      strategyChoice: strategyChoice ?? [],
      conservativePolicy: 'worst-case-burn-composition-v1',
      createdAt: event.timestamp,
    };
    return this.ledger.saveDecision(snapshot) ? snapshot : null;
  }
  private async processReceipt(
    receipt: BetReceipt,
    shoeId: string,
    handId: string,
    market: string,
  ): Promise<void> {
    if (!this.ledger.hasReceipt(this.tableId, shoeId, handId, market)) {
      this.ledger.saveReceipt(receipt, this.tableId, shoeId, handId, market);
    }
    this.placedKeys.add(placedKey(this.tableId, shoeId, handId, market));
    if (receipt.status === 'ACCEPTED' || receipt.status === 'SIMULATED') {
      this.advanceAlternate(market);
      this.riskManager.attachReceipt(receipt.reservationId, receipt.receiptId);
      return;
    }
    if (receipt.status === 'REJECTED') {
      this.riskManager.release(receipt.reservationId, false, 'receipt-rejected', receipt.receiptId);
      return;
    }
    this.riskManager.markUnknown(
      receipt.reservationId,
      'platform-acknowledgement-unknown',
      receipt.receiptId,
    );
  }

  private async disarmForUnknown(reason: string): Promise<void> {
    if (this.projection.autoBetStatus !== 'ARMED') return;
    await this.handleEvent({
      type: 'autoDisarmChanged',
      eventId: newId('evt'),
      tableId: this.tableId,
      timestamp: new Date().toISOString(),
      sourceSeq: this.nextSyntheticSeq(),
      source: 'orchestrator',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: this.projection.shoeId || undefined,
      reason,
    });
  }

  private async recordOneShotReceipt(
    command: OneShotBetCommand,
    receipt: BetReceipt,
  ): Promise<void> {
    await this.handleEvent({
      type: 'betReceipt',
      eventId: newId('evt'),
      tableId: this.tableId,
      timestamp: receipt.createdAt,
      sourceSeq: this.nextSyntheticSeq(),
      source: 'orchestrator-one-shot',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: command.shoeId,
      handId: command.handId,
      market: command.market,
      receipt,
    });
  }

  /** alternate 策略轮替指针推进;仅在该策略下生效。 */
  private advanceAlternate(market: string): void {
    if (this.profile.betStrategy.type !== 'alternate') return;
    this.alternateNext = market === 'bankerPair' ? 'playerPair' : 'bankerPair';
  }

  private nextSyntheticSeq(): number {
    const next = this.ledger.allocateSourceSeq(
      this.tableId,
      Math.max(SYNTHETIC_SEQ_BASE, this.syntheticSeq),
    );
    this.syntheticSeq = next + 1;
    return next;
  }

  async setAutoBet(armed: boolean, shoeId?: string): Promise<void> {
    const event: NormalizedEvent = armed
      ? { type: 'autoArmChanged', eventId: newId('evt'), tableId: this.tableId, timestamp: new Date().toISOString(), sourceSeq: this.nextSyntheticSeq(), source: 'console', schemaVersion: EVENT_SCHEMA_VERSION, armed: true, shoeId }
      : { type: 'autoDisarmChanged', eventId: newId('evt'), tableId: this.tableId, timestamp: new Date().toISOString(), sourceSeq: this.nextSyntheticSeq(), source: 'console', schemaVersion: EVENT_SCHEMA_VERSION, shoeId, reason: 'manual-disarm' };
    await this.enqueue(event);
  }

  async applyManualCorrection(correction: ManualCorrection, shoeId?: string): Promise<void> {
    const event: NormalizedEvent = {
      type: 'manualCorrection',
      eventId: newId('evt'),
      tableId: this.tableId,
      timestamp: new Date().toISOString(),
      sourceSeq: this.nextSyntheticSeq(),
      source: 'console',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId,
      correction,
    };
    await this.enqueue(event);
  }
}

function selectBetAmount(profile: TableProfile, ev: number, defaultBetAmount: number, riskLimits: RiskLimits): number {
  const sizing = riskLimits.betSizing;
  if (sizing?.mode === 'capitalPercent') {
    const amount = (sizing.bankroll ?? 0) * (sizing.percent ?? 0);
    return sizing.maxPerBet === undefined ? amount : Math.min(amount, sizing.maxPerBet);
  }
  let amount = defaultBetAmount;
  for (const tier of profile.betTiers ?? []) {
    if (ev >= tier.minEV) amount = tier.amount;
    else break;
  }
  return amount;
}

function unknownExecutionReceipt(
  intent: BetIntent,
  reservation: RiskReservation,
  reason: 'executor-timeout-or-error' | 'executor-no-receipt',
): BetReceipt {
  return {
    receiptId: `unknown-${intent.intentId}`,
    intentId: intent.intentId,
    reservationId: reservation.reservationId,
    status: 'UNKNOWN',
    amount: intent.amount,
    market: intent.market,
    mode: intent.mode,
    externalRef: `orchestrator:${intent.tableId}:${intent.handId}:${reason}`,
    createdAt: new Date().toISOString(),
    raw: { reason },
  };
}

export interface TableSettingsUpdate {
  minEV: number;
  betTiers: BetTier[];
  defaultBetAmount: number;
  monitorUrl?: string;
}

export interface OrchestratorOptions {
  ledger: SqliteLedger;
  riskLimits: RiskLimits;
  executor?: Pick<BrowserAdapter, 'requestBet'> | null;
  operationalExecutor?: OperationalWagerExecutor | null;
  operationalWagerTerms?: OperationalWagerTerms;
  canExecuteAutomaticBets?: (tableId: string) => boolean;
  onBettingWindowOpened?: (tableId: string) => void;
}

export interface RegisteredTableConfig {
  profile: TableProfile;
  executionMode: 'shadow' | 'simulated' | 'live';
  defaultBetAmount: number;
}

export interface OrchestratorSnapshot {
  riskState: RiskExposureState;
  riskLimits: RiskLimits;
  tables: Record<string, TableActorSnapshot>;
}

const SYNTHETIC_SEQ_BASE = 1_000_000_000;
const TABLE_CONFIG_KEY = 'orchestrator:tables:v1';
const RISK_LIMITS_KEY = 'orchestrator:risk-limits:v1';

export class Orchestrator {
  private readonly ledger: SqliteLedger;
  private readonly riskManager: RiskManager;
  private readonly actors = new Map<string, TableActor>();
  private riskLimits: RiskLimits;
  private executor: Pick<BrowserAdapter, 'requestBet'> | null;
  private operationalExecutor: OperationalWagerExecutor | null;
  private readonly operationalWagerTerms?: OperationalWagerTerms;
  private readonly canExecuteAutomaticBets: (tableId: string) => boolean;
  private readonly onBettingWindowOpened?: (tableId: string) => void;

  constructor(options: OrchestratorOptions) {
    this.ledger = options.ledger;
    assertValidRiskLimits(options.riskLimits);
    this.riskLimits = structuredClone(options.riskLimits);
    const persistedLimits = this.ledger.getConfig<RiskLimits>(RISK_LIMITS_KEY);
    if (persistedLimits) this.riskLimits = persistedLimits;
    this.ledger.setConfig(RISK_LIMITS_KEY, this.riskLimits);
    this.executor = options.executor ?? null;
    this.operationalExecutor = options.operationalExecutor ?? null;
    this.operationalWagerTerms = options.operationalWagerTerms;
    this.canExecuteAutomaticBets = options.canExecuteAutomaticBets ?? (() => true);
    this.onBettingWindowOpened = options.onBettingWindowOpened;
    this.riskManager = new RiskManager(
      this.ledger,
      this.ledger.getRiskState() ?? emptyRiskState(todayUtc()),
    );
    this.restoreTables();
  }

  setExecutor(executor: Pick<BrowserAdapter, 'requestBet'> | null): void {
    this.executor = executor;
    for (const actor of this.actors.values()) actor.setExecutor(executor);
  }

  registerTable(
    profile: TableProfile,
    _executionMode: 'shadow' | 'simulated' | 'live' = 'live',
    defaultBetAmount = 100,
  ): TableActor {
    assertValidTableProfile(profile);
    if (!Number.isFinite(defaultBetAmount) || defaultBetAmount <= 0) {
      throw new RangeError('defaultBetAmount must be a positive finite number');
    }
    const configs = this.listTableConfigs();
    configs[profile.tableId] = { profile: structuredClone(profile), executionMode: 'live', defaultBetAmount };
    this.ledger.setConfig(TABLE_CONFIG_KEY, configs);
    const actor = this.createActor(configs[profile.tableId]!);
    this.actors.set(profile.tableId, actor);
    return actor;
  }

  updateTableSettings(tableId: string, settings: TableSettingsUpdate): void {
    this.updateTableSettingsForTables([tableId], settings);
  }

  setOperationalExecutor(executor: OperationalWagerExecutor | null): void {
    this.operationalExecutor = executor;
    for (const actor of this.actors.values()) actor.setOperationalExecutor(executor);
  }

  updateTableSettingsForTables(tableIds: readonly string[], settings: TableSettingsUpdate): void {
    if (!Number.isFinite(settings.defaultBetAmount) || settings.defaultBetAmount <= 0) {
      throw new RangeError('defaultBetAmount must be a positive finite number');
    }
    const updates = tableIds.map(tableId => {
      const actor = this.actors.get(tableId);
      if (!actor) throw new Error(`unknown table ${tableId}`);
      const profile = {
        ...actor.getProfile(),
        minEV: settings.minEV,
        betTiers: structuredClone(settings.betTiers),
        ...(settings.monitorUrl === undefined ? {} : { monitorUrl: settings.monitorUrl.trim() }),
      };
      assertValidTableProfile(profile);
      return {
        tableId,
        actor,
        profile,
      };
    });
    const configs = this.listTableConfigs();
    for (const update of updates) {
      configs[update.tableId] = {
        profile: structuredClone(update.profile),
        executionMode: 'live',
        defaultBetAmount: settings.defaultBetAmount,
      };
    }
    this.ledger.setConfig(TABLE_CONFIG_KEY, configs);
    for (const update of updates) {
      update.actor.updateConfiguration(update.profile, settings.defaultBetAmount);
    }
  }

  updateTableExecutionMode(tableId: string, _mode: ExecutionMode): void {
    const actor = this.actors.get(tableId);
    if (!actor) throw new Error(`unknown table ${tableId}`);
    const configs = this.listTableConfigs();
    const config = configs[tableId];
    if (!config) throw new Error(`missing table config ${tableId}`);
    configs[tableId] = {
      profile: structuredClone(config.profile),
      executionMode: 'live',
      defaultBetAmount: config.defaultBetAmount,
    };
    this.ledger.setConfig(TABLE_CONFIG_KEY, configs);
    actor.setExecutionMode('live');
  }

  unregisterTable(tableId: string): void {
    const configs = this.listTableConfigs();
    delete configs[tableId];
    this.ledger.setConfig(TABLE_CONFIG_KEY, configs);
    this.actors.delete(tableId);
  }

  getActor(tableId: string): TableActor | undefined {
    return this.actors.get(tableId);
  }

  listTableConfigs(): Record<string, RegisteredTableConfig> {
    const configs = this.ledger.getConfig<Record<string, RegisteredTableConfig>>(TABLE_CONFIG_KEY) ?? {};
    const normalized: Record<string, RegisteredTableConfig> = {};
    let changed = false;
    for (const [tableId, config] of Object.entries(configs)) {
      normalized[tableId] = {
        profile: config.profile,
        executionMode: 'live',
        defaultBetAmount: config.defaultBetAmount,
      };
      if (config.executionMode !== 'live') changed = true;
    }
    if (changed) this.ledger.setConfig(TABLE_CONFIG_KEY, normalized);
    return normalized;
  }

  listActors(): TableActor[] {
    return [...this.actors.values()];
  }

  enqueue(tableId: string, event: NormalizedEvent): Promise<void> {
    const actor = this.actors.get(tableId);
    if (!actor) {
      return Promise.reject(new Error(`no actor registered for table ${tableId}`));
    }
    return actor.enqueue(event);
  }

  async flush(tableId?: string): Promise<void> {
    const actors = tableId ? this.actors.get(tableId) ? [this.actors.get(tableId)!] : [] : [...this.actors.values()];
    await Promise.all(actors.map(actor => actor.flush()));
  }

  getRiskState(): RiskExposureState {
    return this.riskManager.getState();
  }

  getRiskLimits(): RiskLimits {
    return structuredClone(this.riskLimits);
  }

  updateRiskLimits(limits: RiskLimits): void {
    assertValidRiskLimits(limits);
    this.riskLimits = structuredClone(limits);
    this.ledger.setConfig(RISK_LIMITS_KEY, this.riskLimits);
    for (const actor of this.actors.values()) actor.updateRiskLimits(this.riskLimits);
  }

  getReservations(tableId?: string): ReturnType<RiskManager['snapshot']> {
    return this.riskManager.snapshot(tableId);
  }

  settleUnknownReservation(
    reservationId: string,
    settlement: Parameters<RiskManager['settleUnknown']>[1],
    reason: string,
  ): ReturnType<RiskManager['settleUnknown']> {
    return this.riskManager.settleUnknown(reservationId, settlement, reason);
  }

  settleReservedReservationManually(
    reservationId: string,
    realizedPnl: number,
    reason: string,
  ): ReturnType<RiskManager['settleReservedManually']> {
    return this.riskManager.settleReservedManually(reservationId, realizedPnl, reason);
  }

  settleReleasedReservation(
    reservationId: string,
    settlement: Parameters<RiskManager['settleReleased']>[1],
    reason: string,
  ): ReturnType<RiskManager['settleReleased']> {
    return this.riskManager.settleReleased(reservationId, settlement, reason);
  }

  recoverAcceptedHandSettlement(
    tableId: string,
    shoeId: string,
    handId: string,
    settlement: Parameters<RiskManager['settleHand']>[3],
  ): ReturnType<RiskManager['settleHand']> {
    return this.riskManager.settleHand(tableId, shoeId, handId, settlement);
  }

  snapshot(): OrchestratorSnapshot {
    const tables: Record<string, TableActorSnapshot> = {};
    for (const actor of this.actors.values()) tables[actor.tableId] = actor.snapshot();
    return {
      riskState: this.riskManager.getState(),
      riskLimits: this.getRiskLimits(),
      tables,
    };
  }

  async clearMonitorData(): Promise<void> {
    await this.flush();
    this.ledger.clearMonitorData();
    this.riskManager.reset(todayUtc());
    this.actors.clear();
    this.restoreTables();
  }

  async close(): Promise<void> {
    await Promise.all([...this.actors.values()].map(actor => actor.flush()));
    this.ledger.close();
  }

  private restoreTables(): void {
    const configs = this.listTableConfigs();
    for (const config of Object.values(configs)) {
      const actor = this.createActor(config);
      this.actors.set(actor.tableId, actor);
    }
  }

  private createActor(config: RegisteredTableConfig): TableActor {
    return new TableActor({
      tableId: config.profile.tableId,
      profile: config.profile,
      ledger: this.ledger,
      riskManager: this.riskManager,
      executor: this.executor,
      operationalExecutor: this.operationalExecutor,
      operationalWagerTerms: this.operationalWagerTerms,
      canExecuteAutomaticBets: this.canExecuteAutomaticBets,
      onBettingWindowOpened: this.onBettingWindowOpened,
      executionMode: 'live',
      defaultBetAmount: config.defaultBetAmount,
      riskLimits: this.riskLimits,
    });
  }
}

function isRetryableWindowRejection(receipt: BetReceipt): boolean {
  if (receipt.status !== 'REJECTED') return false;
  const reason = typeof receipt.raw === 'object' && receipt.raw !== null
    ? String(Reflect.get(receipt.raw, 'reason') ?? '')
    : '';
  return /round-not-current|betting-window-closed|round-id-unreadable/.test(reason);
}

function receiptMatchesIntent(receipt: BetReceipt, intent: BetIntent, reservation: { reservationId: string }): boolean {
  return receipt.intentId === intent.intentId
    && receipt.reservationId === reservation.reservationId
    && receipt.market === intent.market
    && receipt.amount === intent.amount
    && receipt.mode === intent.mode;
}

function placedKey(tableId: string, shoeId: string, handId: string, market: string): string {
  return `${tableId}:${shoeId}:${handId}:${market}`;
}

function placedHandKey(tableId: string, shoeId: string, handId: string): string {
  return `${tableId}:${shoeId}:${handId}`;
}

function reminderKey(shoeId: string, handId: string, modelRevision: string, market: string): string {
  return `${shoeId}:${handId}:${modelRevision}:${market}`;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`requestBet timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
