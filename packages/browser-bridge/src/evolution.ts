import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type Card,
  type CardRank,
  type NormalizedEvent,
} from '@baccarat/contracts';

type EvolutionMessage = {
  type?: string;
  args?: Record<string, any>;
};

function parseCard(value: string): Card | null {
  const match = /^([0-9AJQK]+)([SHDC])$/i.exec(value.trim());
  if (!match) return null;
  const rankText = match[1].toUpperCase();
  const rank: CardRank = rankText === '1' ? 'A' : (rankText as CardRank);
  return { rank, suit: match[2].toUpperCase() };
}

export class EvolutionBaccaratParser {
  /** 每次运行生成唯一前缀，避免重启后 eventId 与旧账本冲突。 */
  private readonly runId = Math.random().toString(36).slice(2, 10);
  private seqByTable = new Map<string, number>();
  private shoeSeqByTable = new Map<string, number>();
  private shoeIdByTable = new Map<string, string>();
  private lastGameCountByTable = new Map<string, number>();
  private lastGameDataByTable = new Map<string, { playerCards: Card[]; bankerCards: Card[] }>();
  /** 已上报过的牌(按 tableId+handId),用于跨消息对账,防止间歇性丢牌。 */
  private seenCardsByHand = new Map<string, Set<string>>();
  private lastShoeCardsOutByTable = new Map<string, number>();
  private lastShoeTransitionAtByTable = new Map<string, number>();
  private redCardFiredByTable = new Set<string>();
  private settledByTable = new Set<string>();
  /** 结果先到而牌面不完整时挂起,等后续快照补齐牌面后补结算。 */
  private pendingResults = new Map<string, { handId: string; version: unknown; result: Record<string, any> }>();
  private openedWindows = new Set<string>();
  private closedWindows = new Set<string>();

  parse(raw: string): NormalizedEvent[] {
    let message: EvolutionMessage;
    try {
      message = JSON.parse(raw) as EvolutionMessage;
    } catch {
      return [];
    }
    const type = typeof message.type === 'string' ? message.type : '';
    const args = message.args ?? {};
    const tableId = typeof args.tableId === 'string' ? args.tableId : '';
    if (!tableId) return [];

    const events: NormalizedEvent[] = [];
    this.ensureShoe(tableId, events);

    switch (type) {
      case 'baccarat.shoeState':
      case 'baccarat.encodedShoeState':
        this.handleShoeState(tableId, args, events);
        break;
      case 'baccarat.cardDealt':
        this.handleCardDealt(tableId, args, events);
        break;
      case 'baccarat.newGame':
        this.handleNewGame(tableId, args, events);
        break;
      case 'baccarat.gameState':
      case 'baccarat.tableState':
      case 'baccarat.resolved':
        this.handleGameState(tableId, args, events);
        break;
      default:
        break;
    }

    return events;
  }

  private nextSeq(tableId: string): number {
    const next = (this.seqByTable.get(tableId) ?? 0) + 1;
    this.seqByTable.set(tableId, next);
    return next;
  }

  private ensureShoe(tableId: string, events: NormalizedEvent[]): void {
    if (this.shoeIdByTable.has(tableId)) return;
    const shoeId = `evo-${tableId}-1`;
    this.shoeIdByTable.set(tableId, shoeId);
    this.shoeSeqByTable.set(tableId, 1);
    events.push(this.makeEvent(tableId, 'newShoeSignal', `shoe:${shoeId}`, {
      shoeId,
      profile: {
        ...defaultProfile(tableId),
        autoConfirmNewShoe: true,
      },
    }));
  }

  private makeEvent(
    tableId: string,
    type: NormalizedEvent['type'],
    stableKey: string,
    extra: Record<string, unknown>,
  ): NormalizedEvent {
    return {
      type,
      eventId: `evo:${this.runId}:${type}:${stableKey}`,
      tableId,
      timestamp: new Date().toISOString(),
      sourceSeq: this.nextSeq(tableId),
      source: 'evolution',
      schemaVersion: EVENT_SCHEMA_VERSION,
      ...extra,
    } as NormalizedEvent;
  }

  private beginNewShoe(tableId: string, events: NormalizedEvent[]): void {
    const now = Date.now();
    const previousTransition = this.lastShoeTransitionAtByTable.get(tableId);
    if (previousTransition !== undefined && now - previousTransition < 5000) return;
    this.lastShoeTransitionAtByTable.set(tableId, now);
    const shoeSeq = (this.shoeSeqByTable.get(tableId) ?? 1) + 1;
    const shoeId = `evo-${tableId}-${shoeSeq}`;
    this.shoeSeqByTable.set(tableId, shoeSeq);
    this.shoeIdByTable.set(tableId, shoeId);
    events.push(this.makeEvent(tableId, 'newShoeSignal', `shoe:${shoeId}`, {
      shoeId,
      profile: {
        ...defaultProfile(tableId),
        autoConfirmNewShoe: true,
      },
    }));
  }

  private handleNewGame(tableId: string, args: Record<string, any>, events: NormalizedEvent[]): void {
    const shoeCardsOut = Number(args.shoeCardsOut);
    if (!Number.isFinite(shoeCardsOut)) return;
    const previous = this.lastShoeCardsOutByTable.get(tableId);
    if (previous !== undefined && shoeCardsOut < previous) {
      this.beginNewShoe(tableId, events);
    }
    this.lastShoeCardsOutByTable.set(tableId, shoeCardsOut);
  }

  private handleShoeState(tableId: string, args: Record<string, any>, events: NormalizedEvent[]): void {
    const gameCount = Number(args.stats?.gameCount ?? 0);
    const previous = this.lastGameCountByTable.get(tableId);
    if (previous !== undefined && gameCount < previous) {
      this.beginNewShoe(tableId, events);
    }
    if (previous === undefined || gameCount !== previous) {
      this.lastGameCountByTable.set(tableId, gameCount);
    }
  }

  /**
   * 记录并按需补发一张牌。
   * 同一手牌中重复出现的牌只发一次;来自 cardDealt 与后续快照的同一张牌也会去重。
   * 这样即使单条 cardDealt 消息丢失(截断/断线窗口),之后的任何完整快照都会自动补齐。
   */
  private recordCard(
    tableId: string,
    handId: string,
    rawCard: string,
    position: 'player' | 'banker' | undefined,
    events: NormalizedEvent[],
  ): void {
    const card = parseCard(rawCard);
    if (!card || !handId) return;
    const key = `${tableId}:${handId}`;
    let seen = this.seenCardsByHand.get(key);
    if (!seen) {
      seen = new Set();
      this.seenCardsByHand.set(key, seen);
      // 粗略修剪:只保留最近 80 手的记录。
      if (this.seenCardsByHand.size > 80) {
        const oldest = this.seenCardsByHand.keys().next().value;
        if (oldest !== undefined) this.seenCardsByHand.delete(oldest);
      }
    }
    const cardKey = `${position ?? ''}:${card.rank}${card.suit}`;
    if (seen.has(cardKey)) return;
    seen.add(cardKey);
    const shoeId = this.shoeIdByTable.get(tableId) ?? '';
    events.push(this.makeEvent(tableId, 'cardObserved', `card:${handId}:${rawCard}:${position ?? ''}`, {
      shoeId,
      handId,
      card,
      ...(position ? { position } : {}),
    }));
  }

  private handleCardDealt(tableId: string, args: Record<string, any>, events: NormalizedEvent[]): void {
    const handId = typeof args.gameId === 'string' ? args.gameId : '';
    if (!handId) return;
    const position = args.spot === 'Player' ? 'player' : args.spot === 'Banker' ? 'banker' : undefined;
    this.recordCard(tableId, handId, typeof args.card === 'string' ? args.card : '', position, events);
    this.lastGameDataByTable.set(tableId, {
      playerCards: this.parseCards(args.gameData?.playerHand?.cards),
      bankerCards: this.parseCards(args.gameData?.bankerHand?.cards),
    });
    this.maybeFlushPendingResult(tableId, handId, events);
  }

  private handleGameState(tableId: string, args: Record<string, any>, events: NormalizedEvent[]): void {
    // tableState 结构：args.currentGame 内嵌 gameData/gameId/version
    const currentGame = args.currentGame ?? {};
    const handId = typeof args.gameId === 'string' ? args.gameId
      : typeof currentGame.gameId === 'string' ? currentGame.gameId : '';
    if (!handId) return;

    const gameData = args.gameData ?? currentGame.gameData ?? {};
    const playerCards = this.parseCards(gameData.playerHand?.cards);
    const bankerCards = this.parseCards(gameData.bankerHand?.cards);
    if (playerCards.length > 0 || bankerCards.length > 0) {
      this.lastGameDataByTable.set(tableId, { playerCards, bankerCards });
    }

    // 自愈对账:快照里出现“未见过的牌”时补发 cardObserved。
    // 即使单条 cardDealt 消息丢失(传输截断/断线窗口),结算前的任意快照都能补齐牌面。
    const rawPlayerCards = Array.isArray(gameData.playerHand?.cards) ? gameData.playerHand.cards : [];
    const rawBankerCards = Array.isArray(gameData.bankerHand?.cards) ? gameData.bankerHand.cards : [];
    for (const raw of rawPlayerCards) this.recordCard(tableId, handId, String(raw), 'player', events);
    for (const raw of rawBankerCards) this.recordCard(tableId, handId, String(raw), 'banker', events);

    const shoeId = this.shoeIdByTable.get(tableId) ?? '';
    const betting = typeof args.betting === 'string' ? args.betting
      : typeof currentGame.betting === 'string' ? currentGame.betting : '';

    // 红牌/切牌信号：Evolution 用 cuttingCard / isBurning 表示。
    const cuttingCard = Boolean(args.cuttingCard ?? currentGame.cuttingCard);
    if (cuttingCard && !this.redCardFiredByTable.has(`${tableId}:${shoeId}`)) {
      this.redCardFiredByTable.add(`${tableId}:${shoeId}`);
      events.push(this.makeEvent(tableId, 'redCardSeen', `red:${shoeId}:${handId}`, {
        shoeId,
        handId,
        rawEvidence: 'evolution-cutting-card',
      }));
    }

    // 从 shoeCardsOut 下降检测新靴，作为 shoeState gameCount 之外的兜底。
    const shoeCardsOut = typeof args.shoeCardsOut === 'number' ? args.shoeCardsOut
      : typeof currentGame.shoeCardsOut === 'number' ? currentGame.shoeCardsOut : undefined;
    if (shoeCardsOut !== undefined) {
      const previousShoeCardsOut = this.lastShoeCardsOutByTable.get(tableId);
      if (previousShoeCardsOut !== undefined && shoeCardsOut < previousShoeCardsOut) {
        this.beginNewShoe(tableId, events);
      }
      this.lastShoeCardsOutByTable.set(tableId, shoeCardsOut);
    }

    if (betting === 'BetsOpen') {
      for (const market of ['bankerPair', 'playerPair'] as const) {
        const key = `${tableId}:${handId}:${market}`;
        if (this.openedWindows.has(key)) continue;
        this.openedWindows.add(key);
        events.push(this.makeEvent(tableId, 'bettingWindowOpened', `open:${handId}:${market}`, {
          shoeId,
          handId,
          market,
        }));
      }
    } else if (betting === 'BetsClosed') {
      for (const market of ['bankerPair', 'playerPair'] as const) {
        const key = `${tableId}:${handId}:${market}`;
        if (this.closedWindows.has(key)) continue;
        this.closedWindows.add(key);
        events.push(this.makeEvent(tableId, 'bettingWindowClosed', `close:${handId}:${market}`, {
          shoeId,
          handId,
          market,
        }));
      }
    }

    const result = args.result ?? gameData.result ?? currentGame.gameData?.result;
    const version = args.version ?? currentGame.version ?? 0;
    if (result) {
      const key = `${tableId}:${handId}:${version}`;
      if (this.settledByTable.has(key)) return;
      const last = this.lastGameDataByTable.get(tableId);
      // 以结算消息自带的牌面为权威;该消息未带牌面时才回退到最近一次快照。
      const current = { playerCards, bankerCards };
      const cards = (current.playerCards.length > 0 || current.bankerCards.length > 0)
        ? current
        : (last ?? current);
      // 结果先到而牌面不完整:挂起结果,等后续快照补齐牌面后补结算(EVO 的 result 往往只发一次)。
      if (cards.playerCards.length < 2 || cards.bankerCards.length < 2) {
        this.pendingResults.set(tableId, { handId, version, result });
        return;
      }
      this.pendingResults.delete(tableId);
      this.settledByTable.add(key);
      events.push(this.makeEvent(tableId, 'handSettled', `settle:${handId}:${version}`, {
        shoeId,
        handId,
        playerCards: cards.playerCards,
        bankerCards: cards.bankerCards,
        outcomes: {
          bankerPair: Boolean(result.bankerPair),
          playerPair: Boolean(result.playerPair),
        },
      }));
    }
    this.maybeFlushPendingResult(tableId, handId, events);
  }

  /** 挂起结果的补结算:任意后续消息把该手牌面补齐到 ≥2/≥2 时,用挂起的结果完成结算。 */
  private maybeFlushPendingResult(tableId: string, handId: string, events: NormalizedEvent[]): void {
    const pending = this.pendingResults.get(tableId);
    if (!pending || pending.handId !== handId) return;
    const settleKey = `${tableId}:${handId}:${pending.version}`;
    if (this.settledByTable.has(settleKey)) {
      this.pendingResults.delete(tableId);
      return;
    }
    const last = this.lastGameDataByTable.get(tableId);
    if (!last || last.playerCards.length < 2 || last.bankerCards.length < 2) return;
    this.pendingResults.delete(tableId);
    this.settledByTable.add(settleKey);
    events.push(this.makeEvent(tableId, 'handSettled', `settle:${handId}:${pending.version}`, {
      shoeId: this.shoeIdByTable.get(tableId) ?? '',
      handId,
      playerCards: last.playerCards,
      bankerCards: last.bankerCards,
      outcomes: {
        bankerPair: Boolean(pending.result.bankerPair),
        playerPair: Boolean(pending.result.playerPair),
      },
    }));
  }

  private parseCards(values: unknown): Card[] {
    if (!Array.isArray(values)) return [];
    return values
      .map(value => parseCard(String(value)))
      .filter((card): card is Card => card !== null);
  }
}
