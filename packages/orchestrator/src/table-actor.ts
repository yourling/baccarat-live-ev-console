import type {
  BetExecutionRequest,
  BrowserAdapter,
} from '@baccarat/adapter-contract';
import { BUNDLED_PLATFORM_DESCRIPTORS } from '@baccarat/adapter-contract';
import { preferredMarketForBoth, selectBetAmount, selectMarkets } from './strategy.js';
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
  countHandInventory,
  countMissingHandCards,
  effectiveShoeBaseline,
  emptyProjection,
  isPhysicalShoeBettable,
  isPrematurePhysicalShoeReset,
  isWrapShapedRoadCount,
  modelRevisionFor,
  operationalReceiptCommitStarted,
  profileVersionFor,
  type ShoeBaselineEvidence,
} from '@baccarat/ledger-state';
import { evaluatePairMarket, evaluatePairMarketFromRemaining } from '@baccarat/probability';
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
import { isPairBettingWindowReady } from './betting-window.js';
import { ShoeHoldPolicy } from './shoe-hold.js';

export interface TableActorOptions {
  tableId: string;
  profile: TableProfile;
  ledger: SqliteLedger;
  riskManager: RiskManager;
  executor?: Pick<BrowserAdapter, 'requestBet'> | null;
  operationalExecutor?: OperationalWagerExecutor | null;
  operationalWagerTerms?: OperationalWagerTerms;
  canExecuteAutomaticBets?: (tableId: string) => boolean;
  onBettingWindowOpened?: (tableId: string, closesAt?: string) => void;
  observedGameCount?: (tableId: string) => number | undefined;
  observedShoeEvidence?: (tableId: string) => ShoeBaselineEvidence | undefined;
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
  missingUnobservedCards: number;
}

/**
 * 靴代际比较只信任声明了 shoeGenerationContinuity 的平台（如 BG，其解析器
 * 通过 seedShoeSequence 保证代际跨进程重启单调）。其余平台的靴 ID 不携带
 * 可信代际，保持 undefined —— 行为与旧版仅识别 BG 靴 ID 形状时一致。
 */
export class TableActor {
  readonly tableId: string;
  private readonly ledger: SqliteLedger;
  private readonly riskManager: RiskManager;
  private executor: Pick<BrowserAdapter, 'requestBet'> | null;
  private operationalExecutor: OperationalWagerExecutor | null;
  private readonly operationalWagerTerms?: OperationalWagerTerms;
  private readonly canExecuteAutomaticBets: (tableId: string) => boolean;
  private readonly onBettingWindowOpened?: (tableId: string, closesAt?: string) => void;
  private readonly observedGameCount?: (tableId: string) => number | undefined;
  private readonly observedShoeEvidence?: (tableId: string) => ShoeBaselineEvidence | undefined;
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
  private readonly pausedDecisionKeys = new Set<string>();
  private lastSettledHandSeq: number | undefined;
  private missingUnobservedCards = 0;
  /**
   * 已做过"手内漏采"计数的手。同一手的结算会被重复投递：解析器身份变化
   * （runId/generation bump）产生新 eventId 绕过两级 eventId 去重；
   * ledger 按 event_id 去重命中的重复事件走 recoverSideEffects 再次进入本方法。
   * 不去重的话每次重复投递都把同一手的缺牌数再累加一遍，几次就跨过
   * 缺牌 >10 移出监控的阈值，桌被误移出。
   */
  private missingCountedHands = new Set<string>();
  /** 漏采导致的人工修复原因（每靴清理，见 retainKeysForShoe / newShoeSignal）。 */
  private readonly pendingManualRecoveryReasons = new Set<string>();
  /**
   * 靴保持策略：hold 判定/出口/一次性信号缓存/结算暂存，全部独立模块
   * （见 ./shoe-hold.ts，AGENTS.md 靴硬规则的载体）。
   */
  private readonly shoeHold: ShoeHoldPolicy;
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
    this.observedGameCount = options.observedGameCount;
    this.observedShoeEvidence = options.observedShoeEvidence;
    this.profile = structuredClone(options.profile);
    this.executionMode = options.executionMode;
    this.defaultBetAmount = options.defaultBetAmount;
    this.riskLimits = structuredClone(options.riskLimits);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
    this.shoeHold = new ShoeHoldPolicy(
      this.tableId,
      tableId => this.observedGameCount?.(tableId),
    );
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
      shoeHoldPending: this.isShoeHoldPending(),
      observedGameCount: this.observedGameCount?.(this.tableId),
      observedShoeEvidence: this.observedShoeEvidence?.(this.tableId),
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
      shoeHoldPending: this.isShoeHoldPending(),
      observedGameCount: this.observedGameCount?.(this.tableId),
      observedShoeEvidence: this.observedShoeEvidence?.(this.tableId),
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

  resetLiveShoeTracking(): void {
    this.projection = emptyProjection(this.tableId);
    this.evaluatedWindows.clear();
    this.pausedDecisionKeys.clear();
    this.lastSettledHandSeq = undefined;
    this.missingUnobservedCards = 0;
    this.missingCountedHands.clear();
    this.pendingManualRecoveryReasons.clear();
    // 重置的语义是"干净重来、等下一条洗牌证据"（与进程重启后全部待牌靴一致）。
    // 不清缓存的话：空投影的 shouldHoldCurrentPhysicalShoe 恒为 false，
    // 下一个事件会把陈旧的新靴信号补投到重置后的状态上 —— 系统以
    // "全新 416 张"的模型重建一个实际已打了一半的靴，看似合法实则 fail-open。
    this.shoeHold.reset();
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
      missingUnobservedCards: this.missingUnobservedCards,
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

  private shouldHoldCurrentPhysicalShoe(current: ShoeStateProjection): boolean {
    return this.shoeHold.shouldHold(current);
  }

  private bindIncomingShoe(event: NormalizedEvent): NormalizedEvent | null {
    return this.shoeHold.bind(event, this.projection);
  }

  /**
   * 记录"我们收到了换靴信号、但按规则先按住旧靴"。
   *
   * 只记第一次：如果在已有 hold 期间不断刷新，超时就永远不会到，
   * 退化成永久 hold。而 hold 的判据（handNumber / remainingTotal）在 hold
   * 期间是冻结的 —— 只要新靴信号持续到来就会一直成立。
   */
  private noteShoeHoldDeferred(): void {
    this.shoeHold.noteDeferred();
  }

  private deferShoeSignal(event: Extract<NormalizedEvent, { type: 'newShoeSignal' }>): void {
    this.shoeHold.deferSignal(event);
  }

  private holdSettlement(event: Extract<NormalizedEvent, { type: 'handSettled' }>): void {
    this.shoeHold.holdSettlement(event);
  }

  private clearShoeHold(): void {
    this.shoeHold.clear();
  }

  /**
   * 该桌是否处于"靴状态不确定"窗口。
   *
   * 这段窗口里系统仍显示旧靴的库存模型，但牌桌可能已经换靴 —— 所以下注必须
   * fail-closed，而不是拿一个可能与现实无关的库存去评估 EV。
   */
  isShoeHoldPending(now = Date.now()): boolean {
    return this.shoeHold.isPending(now);
  }

  private async handleEvent(event: NormalizedEvent): Promise<void> {
    // hold 解除后补投被缓存的新靴信号，让系统回到平台真实靴。
    // 解除判据必须与 bindIncomingShoe 的 hold 判据**同源**
    // （shouldHoldCurrentPhysicalShoe：路子回绕确认或超时），不能只用
    // isShoeHoldPending 的纯时间判 —— 否则路子回绕出口在 90 秒前解除 hold 时
    // （branch 2/3 放行并 clearShoeHold），缓存信号会在补投前被销毁，
    // 而新靴信号是一次性的，桌将永久僵在旧靴。
    // 必须在处理当前事件之前做：否则新靴的牌会被 isCurrentShoe 忽略，
    // 而 remainingTotal 又冻结着，等于永远追不上。
    const { signal: deferred, settlements: droppedSettlements } = this.shoeHold.drain(this.projection);
    if (deferred !== undefined) {
      // 递归调用：此刻 hold 已解除，bindIncomingShoe 不会再拦它。
      await this.handleEvent(deferred);
      // 补投已切到该靴：回放 hold 期间被丢弃的结算（每手只发一次，不回放
      // 那几手的牌就永远不从库存里扣）。回放先于当前事件，保持时序。
      for (const settlement of droppedSettlements) {
        await this.handleEvent(settlement);
      }
    }
    const bound = this.bindIncomingShoe(event);
    if (bound === null) return;
    event = bound;
    if (event.type === 'newShoeSignal') {
      // 只有事件源显式声明的实体靴（协议洗牌 / 人工确认，三个 runtime 均带
      // `autoConfirmNewShoe: true`）才自动进入跟踪。桌配置的 `autoConfirmNewShoe`
      // 为 true 时同样自动确认。除此之外一律等待人工确认 —— 不能因为
      // baseline 是 physical-shoe 就绕过桌配置。
      const incomingConfirm = event.profile?.autoConfirmNewShoe === true;
      event = {
        ...event,
        profile: {
          ...structuredClone(this.profile),
          autoConfirmNewShoe: incomingConfirm || this.profile.autoConfirmNewShoe,
        },
      };
    }
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
      this.pausedDecisionKeys.clear();
      this.lastSettledHandSeq = undefined;
      this.missingUnobservedCards = 0;
      this.missingCountedHands.clear();
      this.pendingManualRecoveryReasons.clear();
      this.retainKeysForShoe(event.shoeId);
      if (previousProjection.shoeId && previousProjection.shoeId !== event.shoeId) {
        this.riskManager.expireOpenForShoe(this.tableId, previousProjection.shoeId, 'new-shoe-signal-received');
      }
      return;
    }
    if (event.type === 'bettingWindowOpened') {
      this.onBettingWindowOpened?.(this.tableId, event.closesAt);
      await this.evaluateWindow(event, this.projection);
      return;
    }
    if (event.type === 'bettingWindowClosed' && event.openingObserved === false) {
      this.recordUnobservableWindow(event, this.projection);
      return;
    }
    if (event.type === 'handSettled') {
      this.applyHandSettlement(event, previousProjection);
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
      this.applyHandSettlement(event, previousProjection);
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

  missingUnobservedCardCount(): number {
    return this.missingUnobservedCards;
  }

  private applyHandSettlement(
    event: Extract<NormalizedEvent, { type: 'handSettled' }>,
    previousProjection: ShoeStateProjection,
  ): void {
    const seq = Number.parseInt(event.handId, 10);
    if (Number.isInteger(seq) && seq > 0) {
      if (this.lastSettledHandSeq !== undefined && seq > this.lastSettledHandSeq + 1) {
        this.missingUnobservedCards += (seq - this.lastSettledHandSeq - 1) * 6;
      }
      this.lastSettledHandSeq = seq;
    }
    // 手内漏采：这一手只 live 采到一部分牌、其余漏了。上面那段只认"手序跳号"
    // （整手丢失），看不见"手内少牌"。
    //
    // FIX(C-P1-4): 投影层已改成按 position 差集逐张补齐（`applySettledHandCards`），
    // 所以这里不再用"结算张数 - 已计入张数"估算，而是直接问投影"这手还差几张"：
    //   - 差几张就是我们确实没拿到、也补不回来的（position 无法归一化等）；
    //   - **整手都没采到**（重启后只有 handSettled、或晚到的一手）必须排除：
    //     那是正常的"用持久结算重建库存"路径，不是漏采。旧代码用
    //     `observedCardCount > 0` 排除它，这里保持同一语义。
    const missingKey = `${event.shoeId}:${event.handId}`;
    const observedCardCount = countHandInventory(previousProjection, event.handId);
    if (!this.missingCountedHands.has(missingKey)) {
      this.missingCountedHands.add(missingKey);
      const missingCards = observedCardCount > 0
        ? countMissingHandCards(previousProjection, event.handId, event.playerCards, event.bankerCards)
        : 0;
      if (missingCards > 0) {
        this.missingUnobservedCards += missingCards;
        // FIX(C-P1-3): 任何一张漏采都要立刻阻断该桌自动下注 —— 修复前只有
        // missingUnobservedCards > 10 才被 service 移出监控，少量漏采既不上报
        // 也不阻止下注，剩余库存偏高会一直用到下一靴。
        this.requireManualRecoveryForMissingCards(event, missingCards);
      }
    }
    const settlement = {
      outcomes: event.outcomes,
      playerCards: event.playerCards,
      bankerCards: event.bankerCards,
    };
    this.riskManager.settleHand(this.tableId, event.shoeId, event.handId, settlement);
    this.settleCommittedUnknownOperationalWagers(event, settlement);
    this.settleCommittedUnknownReceipts(event, settlement);
  }

  /**
   * FIX(C-P1-3): 漏采牌立即把该桌自动下注置为 NEEDS_MANUAL_RECOVERY。
   *
   * 通过投影事件 `autoDisarmChanged` 走正常事件流（落库 + 幂等），而不是直接改
   * 内存字段 —— 这样重启回放仍能看到"这桌被人工修复过"的审计痕迹。
   * 已处于 NEEDS_MANUAL_RECOVERY 时不重复投递（避免每次结算都写一条事件）。
   */
  private requireManualRecoveryForMissingCards(
    event: Extract<NormalizedEvent, { type: 'handSettled' }>,
    missingCards: number,
  ): void {
    if (this.projection.autoBetStatus === 'NEEDS_MANUAL_RECOVERY') return;
    const reason = `missing-unobserved-cards:${missingCards}@${event.handId}`;
    this.pendingManualRecoveryReasons.add(reason);
    // 同步应用（不经队列）：applyHandSettlement 本身就在 actor 的串行队列里，
    // 再 enqueue 会造成重入死锁。直接走一次 handleEvent 的同步路径太绕，
    // 这里按投影语义等价地落一条 autoDisarmChanged 事件。
    const disarmEvent: NormalizedEvent = {
      type: 'autoDisarmChanged',
      eventId: newId('evt'),
      tableId: this.tableId,
      timestamp: event.timestamp,
      sourceSeq: this.nextSyntheticSeq(),
      source: 'orchestrator',
      schemaVersion: EVENT_SCHEMA_VERSION,
      shoeId: event.shoeId,
      reason,
    };
    try {
      const watermark = this.projection.eventWatermark + 1;
      const next = applyEvent(
        new Map([[this.tableId, this.projection]]),
        disarmEvent,
        watermark,
      );
      this.ledger.appendEvent(disarmEvent);
      this.projection = next.get(this.tableId) ?? this.projection;
      // 投影的 autoDisarmChanged 只置 DISARMED；漏采要的是"必须人工修复"，
      // 因此再叠一层 NEEDS_MANUAL_RECOVERY（与 burnModelUpdated / 手工修正一致）。
      this.projection = { ...this.projection, autoBetStatus: 'NEEDS_MANUAL_RECOVERY' };
    } catch {
      // 账本失败不能吞掉"必须阻断下注"这个决定：至少把内存投影置为需要人工修复。
      this.projection = { ...this.projection, autoBetStatus: 'NEEDS_MANUAL_RECOVERY' };
    }
    this.recordMissingCardsDecision(event, missingCards);
  }

  /** 漏采阻断的决策审计：让运维在决策页直接看到"为什么这桌停了下注"。 */
  private recordMissingCardsDecision(
    event: Extract<NormalizedEvent, { type: 'handSettled' }>,
    missingCards: number,
  ): void {
    const snapshot: DecisionSnapshot = {
      snapshotId: newId('dec'),
      tableId: this.tableId,
      shoeId: event.shoeId,
      handId: event.handId,
      market: 'bankerPair',
      eventId: event.eventId,
      eventWatermark: this.projection.eventWatermark,
      profileVersion: profileVersionFor(this.profile),
      modelRevision: this.projection.modelRevision,
      pMean: 0,
      pLower: 0,
      evMean: 0,
      evLower: 0,
      eligible: false,
      reason: `missing-unobserved-cards: ${missingCards}; execution-forbidden; auto-bet requires manual recovery`,
      strategyChoice: [],
      conservativePolicy: 'worst-case-burn-composition-v1',
      createdAt: event.timestamp,
    };
    this.ledger.saveDecision(snapshot);
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
      // FIX(B-P1-2): 跨靴同 handId 不能确权上一靴的 Unknown 敞口 —— 平台换靴后
      // roundId/handId 会复位，BG 换靴 replay 还会用旧 handId 在新 shoeId 上重发
      // handSettled。必须严格同靴才允许自动收敛，跨靴的留给操作员核对。
      if (record.wager.shoeId !== event.shoeId) continue;
      if (record.wager.handId !== event.handId) continue;
      if (!operationalReceiptCommitStarted(record.receipt?.raw)) continue;
      const reservation = this.riskManager.snapshot(this.tableId)
        .find(candidate => candidate.reservationId === record.reservationId);
      if (reservation === undefined) continue;
      if (reservation.shoeId !== event.shoeId) continue;
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

  private settleCommittedUnknownReceipts(
    event: Extract<NormalizedEvent, { type: 'handSettled' }>,
    settlement: {
      outcomes?: { bankerPair: boolean; playerPair: boolean };
      playerCards: readonly { rank: string }[];
      bankerCards: readonly { rank: string }[];
    },
  ): void {
    for (const reservation of this.riskManager.snapshot(this.tableId)) {
      if (reservation.status !== 'UNKNOWN') continue;
      // FIX(B-P1-2): 同 `settleCommittedUnknownOperationalWagers` —— 严格同靴同手，
      // 跨靴 handId 撞号不得把上一靴的未知敞口"确权"掉。
      if (reservation.shoeId !== event.shoeId) continue;
      if (reservation.handId !== event.handId) continue;
      const stored = this.ledger.getReceipt(
        this.tableId,
        reservation.shoeId,
        reservation.handId,
        reservation.market,
      );
      if (stored?.receipt.status !== 'UNKNOWN') continue;
      if (!operationalReceiptCommitStarted(stored.receipt.raw)) continue;
      try {
        this.riskManager.settleUnknown(reservation.reservationId, settlement, 'committed-hand-settled');
      } catch {
        continue;
      }
    }
  }

  private async evaluateWindow(
    event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>,
    projection: ShoeStateProjection,
  ): Promise<void> {
    if (event.shoeId !== projection.shoeId || projection.sealed) return;
    if (projection.status !== 'BETTING_WINDOW') return;
    if (
      effectiveShoeBaseline(
        projection,
        this.observedGameCount?.(this.tableId),
        this.observedShoeEvidence?.(this.tableId),
      ) !== 'physical-shoe'
      || !isPhysicalShoeBettable(projection)
    ) {
      return;
    }
    const closesAt = event.closesAt ?? projection.bettingWindowClosesAt;
    const eventMs = Date.parse(event.timestamp);
    const liveSkewMs = Number.isFinite(eventMs) ? Math.abs(Date.now() - eventMs) : Number.POSITIVE_INFINITY;
    const windowNowMs = liveSkewMs < 60_000 ? Date.now() : eventMs;
    if (!isPairBettingWindowReady(closesAt, windowNowMs)) {
      return;
    }
    if (this.riskManager.hasUnknownReservations(this.tableId)) {
      return;
    }
    // FIX(B-P1-4): 结算缺口门 —— 本桌还有**其他手**的 RESERVED 未结算时，自动对子
    // 必须失败关闭。README/AGENTS 要求"新一局出现上一局未结算 reservation 时失败
    // 关闭该桌"，但修复前这里只查 UNKNOWN，于是结算帧丢失（仍是 RESERVED）时
    // 下一手照常下注，敞口与未知 PnL 叠加，perTableLossLimit 也按"未结算=没亏"错算。
    // 记一条 eligible=false 的决策审计，让运维能直接看到为什么没下注。
    const hasSettlementGap = this.riskManager.snapshot(this.tableId)
      .some(reservation => reservation.status === 'RESERVED' && reservation.handId !== event.handId);
    if (hasSettlementGap) {
      this.recordDecision(
        event,
        projection,
        false,
        'settlement-gap: prior hand reservation is unsettled; automatic execution fail-closed',
      );
      return;
    }
    // 靴状态不确定（收到换靴信号但先按住旧靴）：这段窗口里剩余库存可能与
    // 牌桌无关，不能拿它评估对子 EV。
    if (this.isShoeHoldPending()) return;
    const evalKey = `${event.shoeId}:${event.handId}:${event.market}`;
    const previousEval = this.evaluatedWindows.get(evalKey);
    const hasClosesAt = typeof event.closesAt === 'string' && event.closesAt.length > 0;
    if (previousEval !== undefined && (previousEval.hadClosesAt || !hasClosesAt)) return;
    const evaluation = this.evaluatePair(projection, event.market);
    const eligible = evaluation.evLower >= this.profile.minEV;
    const reason = eligible
      ? `evLower=${evaluation.evLower.toFixed(6)} >= minEV=${this.profile.minEV}`
      : `evLower=${evaluation.evLower.toFixed(6)} < minEV=${this.profile.minEV}`;

    if (projection.autoBetStatus !== 'ARMED') {
      if (!this.pausedDecisionKeys.has(evalKey)) {
        this.pausedDecisionKeys.add(evalKey);
        this.recordDecision(event, projection, eligible, reason, 'auto-bet-paused');
      }
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
      handKey: `${event.shoeId}:${event.handId}`,
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
      return;
    }
    // 策略门控:策略未选中当前市场时,只记录决策审计,绝不创建 intent/下注。
    if (!strategyResult.selected) {
      return;
    }
    if (this.profile.betStrategy.type === 'both') {
      const preferredMarket = preferredMarketForBoth(
        this.evaluatePair(projection, 'bankerPair'),
        this.evaluatePair(projection, 'playerPair'),
      );
      if (event.market !== preferredMarket) {
        return;
      }
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
      amount: selectBetAmount(this.profile, evaluation.evLower, this.defaultBetAmount, this.riskLimits.betSizing),
      mode: 'live',
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
    // FIX(B-P1-5): 风控可能把金额缩小（insufficientBehavior='shrink'），而发到桥的
    // intent.amount 是缩小前的原额 —— 修复前会出现"真金下 100、风控只记 10"，
    // 结算后 dayLoss/tableLosses/shoeLosses 只按缩额记账，限额体系被系统性低估。
    // 与 one-shot 对齐：金额不等时 fail-closed，释放预留并且不执行。
    // （桌面默认 insufficientBehavior='skip'，此路径需配 shrink 才可达。）
    if (reserve.amount !== intent.amount || reservation.amount !== intent.amount) {
      this.riskManager.release(reservation.reservationId, false, 'reserved-amount-mismatch');
      return;
    }
    this.placedKeys.add(placed);
    this.placedHandKeys.add(handPlaced);

    if (!this.executor) {
      this.riskManager.release(reservation.reservationId, false, 'no-executor-configured');
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
        const uncommittedRejected = receipt.status === 'REJECTED'
          && operationalReceiptCommitStarted(receipt.raw) !== true;
        if (uncommittedRejected) {
          this.riskManager.release(reservation.reservationId, false, 'receipt-mismatch', receipt.receiptId);
        } else {
          this.riskManager.markUnknown(reservation.reservationId, 'receipt-mismatch', receipt.receiptId);
        }
        return;
      }
      if (isRetryableWindowRejection(receipt)) {
        if (operationalReceiptCommitStarted(receipt.raw) !== true) {
          this.placedKeys.delete(placed);
          this.placedHandKeys.delete(handPlaced);
          this.reminderKeys.delete(reminder);
          this.evaluatedWindows.delete(evalKey);
          this.riskManager.release(reservation.reservationId, false, 'window-not-ready', receipt.receiptId);
          return;
        }
        this.riskManager.markUnknown(reservation.reservationId, 'window-not-ready-committed', receipt.receiptId);
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

  private evaluatePair(
    projection: ShoeStateProjection,
    market: Extract<NormalizedEvent, { type: 'bettingWindowOpened' }>['market'] | 'bankerPair' | 'playerPair',
  ) {
    return projection.shoeBaseline === 'physical-shoe' && projection.remainingTotal > 0
      ? evaluatePairMarketFromRemaining(this.profile, market, projection.remainingCounts)
      : evaluatePairMarket(this.profile, market, projection.seenCards);
  }

  private recordDecision(
    event: Extract<NormalizedEvent, { type: 'bettingWindowOpened' | 'bettingWindowClosed' }>,
    projection: ShoeStateProjection,
    eligible: boolean,
    reason: string,
    auditNote?: string,
    strategyChoice?: DecisionSnapshot['strategyChoice'],
  ): DecisionSnapshot | null {
    const result = this.evaluatePair(projection, event.market);
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
      if (operationalReceiptCommitStarted(receipt.raw)) {
        this.riskManager.markUnknown(
          receipt.reservationId,
          'committed-rejection-uncertain',
          receipt.receiptId,
        );
        return;
      }
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

  /**
   * 长时间无人值守下 placed/reminder 去重集合会随手数无限增长。
   * 每靴只保留当前靴的内存快查键：资金安全由账本收据（hasReceipt）与风控活跃键兜底，
   * 键格式固定，按段精确匹配当前靴；格式不符的键同样丢弃，避免脏键堆积。
   */
  private retainKeysForShoe(shoeId: string): void {
    for (const key of [...this.placedKeys]) {
      const segments = key.split(':');
      if (segments.length !== 4 || segments[1] !== shoeId) this.placedKeys.delete(key);
    }
    for (const key of [...this.placedHandKeys]) {
      const segments = key.split(':');
      if (segments.length !== 3 || segments[1] !== shoeId) this.placedHandKeys.delete(key);
    }
    for (const key of [...this.reminderKeys]) {
      const segments = key.split(':');
      if (segments.length !== 4 || segments[0] !== shoeId) this.reminderKeys.delete(key);
    }
  }


  private nextSyntheticSeq(): number {
    const next = this.ledger.allocateSourceSeq(
      this.tableId,
      Math.max(SYNTHETIC_SEQ_BASE, this.syntheticSeq),
    );
    this.syntheticSeq = next + 1;
    return next;
  }

  async setAutoBet(armed: boolean, shoeId?: string, reason = 'manual-disarm'): Promise<void> {
    const event: NormalizedEvent = armed
      ? { type: 'autoArmChanged', eventId: newId('evt'), tableId: this.tableId, timestamp: new Date().toISOString(), sourceSeq: this.nextSyntheticSeq(), source: 'console', schemaVersion: EVENT_SCHEMA_VERSION, armed: true, shoeId }
      : { type: 'autoDisarmChanged', eventId: newId('evt'), tableId: this.tableId, timestamp: new Date().toISOString(), sourceSeq: this.nextSyntheticSeq(), source: 'console', schemaVersion: EVENT_SCHEMA_VERSION, shoeId, reason };
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
  onBettingWindowOpened?: (tableId: string, closesAt?: string) => void;
  observedGameCount?: (tableId: string) => number | undefined;
  observedShoeEvidence?: (tableId: string) => ShoeBaselineEvidence | undefined;
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

/**
 * 收到换靴信号后"先按住旧靴"的最长时长。
 *
 * hold 的本意是防止滞后 DOM 把刚洗完的实体靴误降级（见 isPrematurePhysicalShoeReset）。
 * 但 hold 期间 handNumber 与 remainingTotal 都会冻结，只要新靴信号持续到来，
 * 判据就永久成立 —— 而这段窗口里系统仍会拿旧靴库存继续下注，牌桌却可能已经换靴。
 * 实测：换靴后 actor 仍停在旧靴，status 保持 BETTING_WINDOW，对子真金注照发。
 * 90 秒足够覆盖 DOM/路子的正常滞后，又不会让错误模型维持太久。
 */

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
  private readonly onBettingWindowOpened?: (tableId: string, closesAt?: string) => void;
  private readonly observedGameCount?: (tableId: string) => number | undefined;
  private readonly observedShoeEvidence?: (tableId: string) => ShoeBaselineEvidence | undefined;

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
    this.observedGameCount = options.observedGameCount;
    this.observedShoeEvidence = options.observedShoeEvidence;
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

  resetLiveShoeTracking(): void {
    for (const actor of this.actors.values()) actor.resetLiveShoeTracking();
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

  writeOffUnknownReservation(
    reservationId: string,
    reason: string,
  ): ReturnType<RiskManager['writeOffUnknown']> {
    return this.riskManager.writeOffUnknown(reservationId, reason);
  }

  /** 把已提交但长期未结算的预留升级为 UNKNOWN，使其进入可处置的告警流程。 */
  escalateOverdueReservations(
    maxAgeMs: number,
    now = Date.now(),
    reason = 'unsettled-past-timeout',
    notBefore?: number,
  ): ReturnType<RiskManager['escalateOverdueSettlements']> {
    return this.riskManager.escalateOverdueSettlements(maxAgeMs, now, reason, notBefore);
  }

  /**
   * FIX(B-P1-3 / D-P1-1): 启动恢复——把上一进程遗留的所有 RESERVED 敞口
   * （不论 createdAt、不论有无回执）升级为 UNKNOWN，使操作员可以勾销、迟到
   * 权威结算也能自动收敛。
   *
   * 生产接线点：`service.ts` 的启动序列（`initializeFailClosedRuntime` 之后、
   * `refreshAccountingIncidents` 之前）调用一次本方法。本包只提供透传。
   */
  escalateRestoredExposures(
    reason?: string,
  ): ReturnType<RiskManager['escalateRestoredExposures']> {
    return this.riskManager.escalateRestoredExposures(reason);
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
    // FIX(D-P2-2): 只丢弃预留、保留 dayLoss/tableLosses/shoeLosses/executedToday ——
    // "清除记录"不能成为绕过止损的入口。
    //
    // 顺序很关键：**先**把风控侧归零（内存 + risk_state 落盘），**再**删账本行。
    // 反过来（先删 reservations 再归零）时，若归零的落盘抛错，内存里会残留
    // 指向"已删除行"的 reservation —— 之后任何 release/settleHand 调
    // store.updateReservation 都会以 LedgerConflictError 中断整个事件流。
    // 按现在的顺序，最坏情况是"risk 已归零、DB 行没删干净"：下一次下注会撞上
    // 残留活跃行的 saveReservation 冲突 → fail-closed 返回 reservation-key-conflict
    // （宁可拒单，不会双下），且重启时 loadState 会从残留行重算敞口自愈。
    this.riskManager.dropReservationsKeepingAccounting();
    this.ledger.clearMonitorData();
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
      observedGameCount: this.observedGameCount,
      observedShoeEvidence: this.observedShoeEvidence,
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
