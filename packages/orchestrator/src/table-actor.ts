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
  type DecisionSnapshot,
  type ManualCorrection,
  type NormalizedEvent,
  type RiskExposureState,
  type RiskLimits,
  type ShoeStateProjection,
  type TableProfile,
  newId,
} from '@baccarat/contracts';
import {
  SqliteLedger,
  applyEvent,
  emptyProjection,
  profileVersionFor,
} from '@baccarat/ledger-state';
import { evaluatePairMarket } from '@baccarat/probability';
import { RiskManager, emptyRiskState } from '@baccarat/risk-execution';
import { selectMarkets } from './strategy.js';

export interface TableActorOptions {
  tableId: string;
  profile: TableProfile;
  ledger: SqliteLedger;
  riskManager: RiskManager;
  executor?: Pick<BrowserAdapter, 'requestBet'> | null;
  executionMode: 'shadow' | 'simulated';
  defaultBetAmount: number;
  riskLimits: RiskLimits;
  requestTimeoutMs?: number;
}

interface QueueItem {
  event: NormalizedEvent;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

export interface TableActorSnapshot {
  tableId: string;
  profile: TableProfile;
  projection: ShoeStateProjection;
  executionMode: 'shadow' | 'simulated';
  defaultBetAmount: number;
  pendingEvents: number;
}

export class TableActor {
  readonly tableId: string;
  private readonly ledger: SqliteLedger;
  private readonly riskManager: RiskManager;
  private executor: Pick<BrowserAdapter, 'requestBet'> | null;
  private profile: TableProfile;
  private executionMode: 'shadow' | 'simulated';
  private defaultBetAmount: number;
  private riskLimits: RiskLimits;
  private readonly requestTimeoutMs: number;
  private queue: QueueItem[] = [];
  private processing = false;
  private projection: ShoeStateProjection;
  private readonly reminderKeys = new Set<string>();
  private readonly placedKeys = new Set<string>();
  private alternateNext: 'bankerPair' | 'playerPair';

  constructor(options: TableActorOptions) {
    if (!Number.isFinite(options.defaultBetAmount) || options.defaultBetAmount <= 0) {
      throw new Error('defaultBetAmount must be a positive finite number');
    }
    this.tableId = options.tableId;
    this.ledger = options.ledger;
    this.riskManager = options.riskManager;
    this.executor = options.executor ?? null;
    this.profile = structuredClone(options.profile);
    this.executionMode = options.executionMode;
    this.defaultBetAmount = options.defaultBetAmount;
    this.riskLimits = structuredClone(options.riskLimits);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;

    const replay = this.ledger.replay(this.tableId);
    this.projection = replay.state.get(this.tableId) ?? emptyProjection(this.tableId);

    for (const row of this.ledger.listReceipts(this.tableId)) {
      this.placedKeys.add(placedKey(row.tableId, row.shoeId, row.handId, row.market));
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
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      void this.drain();
    });
  }

  async flush(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  getProjection(): ShoeStateProjection {
    return structuredClone(this.projection);
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

  snapshot(): TableActorSnapshot {
    return {
      tableId: this.tableId,
      profile: this.getProfile(),
      projection: this.getProjection(),
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
        const item = this.queue.shift()!;
        try {
          await this.handleEvent(item.event);
          item.resolve();
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.processing = false;
    }
  }
  private async handleEvent(event: NormalizedEvent): Promise<void> {
    const previousProjection = this.projection;
    const watermark = this.ledger.countEvents(this.tableId) + 1;
    const tentativeState = applyEvent(new Map([[this.tableId, previousProjection]]), event, watermark);
    const tentativeProjection = tentativeState.get(this.tableId) ?? emptyProjection(this.tableId);
    const appended = this.ledger.appendEvent(event);
    if (appended === 'duplicate') {
      await this.recoverSideEffects(event, previousProjection);
      return;
    }
    this.projection = tentativeProjection;

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
    if (event.type === 'handSettled') {
      this.riskManager.settleHand(
        this.tableId,
        event.shoeId,
        event.handId,
        event.outcomes,
        this.projection.profileSnapshot,
      );
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
    if (event.type === 'handSettled') {
      this.riskManager.settleHand(this.tableId, event.shoeId, event.handId, event.outcomes, this.projection.profileSnapshot);
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

  private async evaluateWindow(
    event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>,
    projection: ShoeStateProjection,
  ): Promise<void> {
    if (event.shoeId !== projection.shoeId || projection.sealed) return;
    if (projection.status !== 'BETTING_WINDOW') return;

    const evaluation = evaluatePairMarket(this.profile, event.market, projection.seenCards);
    const eligible = evaluation.evLower > this.profile.minEV;
    const reason = eligible
      ? `evLower=${evaluation.evLower.toFixed(6)} > minEV=${this.profile.minEV}`
      : `evLower=${evaluation.evLower.toFixed(6)} <= minEV=${this.profile.minEV}`;

    if (projection.autoBetStatus !== 'ARMED') {
      this.recordDecision(event, projection, eligible, reason, 'auto-not-armed');
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

    if (!eligible) return;
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
      amount: this.defaultBetAmount,
      mode: this.executionMode,
      idempotencyKey: `${this.tableId}:${event.shoeId}:${event.handId}:${event.market}:${projection.modelRevision}`,
      strategy: this.profile.betStrategy,
      decisionSnapshotId: snapshot.snapshotId,
      createdAt: new Date().toISOString(),
    };

    const reserve = this.riskManager.tryReserve(intent, this.profile, this.riskLimits);
    if (!reserve.ok) {
      return;
    }
    const reservation = reserve.reservation!;
    this.placedKeys.add(placed);

    if (this.executionMode === 'shadow') {
      this.riskManager.release(reservation.reservationId, true, 'shadow-execution');
      return;
    }

    if (!this.executor) {
      this.riskManager.release(reservation.reservationId, false, 'no-executor-configured');
      return;
    }

    const req: BetExecutionRequest = { intent, mode: 'simulated', reservationId: reservation.reservationId };
    let receipt: BetReceipt | null;
    try {
      receipt = await withTimeout(this.executor.requestBet(req), this.requestTimeoutMs);
    } catch {
      receipt = null;
    }
    if (receipt) {
      this.placedKeys.add(placed);
      this.ledger.saveReceipt(receipt, this.tableId, event.shoeId, event.handId, event.market);
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
      this.riskManager.attachReceipt(reservation.reservationId, receipt.receiptId);
    } else {
      this.riskManager.release(reservation.reservationId, false, 'executor-timeout-or-rejected');
    }
  }

  private recordDecision(
    event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>,
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
      createdAt: new Date().toISOString(),
    };
    return this.ledger.saveDecision(snapshot) ? snapshot : null;
  }
  private async processReceipt(
    receipt: BetReceipt,
    shoeId: string,
    handId: string,
    market: string,
  ): Promise<void> {
    if (this.ledger.hasReceipt(this.tableId, shoeId, handId, market)) return;
    this.ledger.saveReceipt(receipt, this.tableId, shoeId, handId, market);
    this.placedKeys.add(placedKey(this.tableId, shoeId, handId, market));
    if (this.profile.betStrategy.type === 'alternate') {
      this.alternateNext = market === 'bankerPair' ? 'playerPair' : 'bankerPair';
    }
    if (receipt.status === 'REJECTED') {
      const reservation = this.riskManager.snapshot().find(
        r => r.reservationId === receipt.reservationId && r.status === 'RESERVED',
      );
      if (reservation) {
        this.riskManager.release(reservation.reservationId, false, 'receipt-rejected', receipt.receiptId);
      }
    }
  }

  private nextSyntheticSeq(): number {
    return Math.max(SYNTHETIC_SEQ_BASE, this.ledger.nextSourceSeq(this.tableId));
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

export interface OrchestratorOptions {
  ledger: SqliteLedger;
  riskLimits: RiskLimits;
  executor?: Pick<BrowserAdapter, 'requestBet'> | null;
}

export interface RegisteredTableConfig {
  profile: TableProfile;
  executionMode: 'shadow' | 'simulated';
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

  constructor(options: OrchestratorOptions) {
    this.ledger = options.ledger;
    assertValidRiskLimits(options.riskLimits);
    this.riskLimits = structuredClone(options.riskLimits);
    const persistedLimits = this.ledger.getConfig<RiskLimits>(RISK_LIMITS_KEY);
    if (persistedLimits) this.riskLimits = persistedLimits;
    this.ledger.setConfig(RISK_LIMITS_KEY, this.riskLimits);
    this.executor = options.executor ?? null;
    this.riskManager = new RiskManager(
      this.ledger,
      this.ledger.getRiskState() ?? emptyRiskState(todayUtc()),
    );
    this.restoreTables();
  }

  registerTable(
    profile: TableProfile,
    executionMode: 'shadow' | 'simulated' = 'shadow',
    defaultBetAmount = 100,
  ): TableActor {
    assertValidTableProfile(profile);
    if (!Number.isFinite(defaultBetAmount) || defaultBetAmount <= 0) {
      throw new RangeError('defaultBetAmount must be a positive finite number');
    }
    const configs = this.listTableConfigs();
    configs[profile.tableId] = { profile: structuredClone(profile), executionMode, defaultBetAmount };
    this.ledger.setConfig(TABLE_CONFIG_KEY, configs);
    const actor = this.createActor(configs[profile.tableId]!);
    this.actors.set(profile.tableId, actor);
    return actor;
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
    return this.ledger.getConfig<Record<string, RegisteredTableConfig>>(TABLE_CONFIG_KEY) ?? {};
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

  snapshot(): OrchestratorSnapshot {
    const tables: Record<string, TableActorSnapshot> = {};
    for (const actor of this.actors.values()) tables[actor.tableId] = actor.snapshot();
    return {
      riskState: this.riskManager.getState(),
      riskLimits: this.getRiskLimits(),
      tables,
    };
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
      executionMode: config.executionMode,
      defaultBetAmount: config.defaultBetAmount,
      riskLimits: this.riskLimits,
    });
  }
}

function placedKey(tableId: string, shoeId: string, handId: string, market: string): string {
  return `${tableId}:${shoeId}:${handId}:${market}`;
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
