/**
 * Pragmatic / BG 两平台共用的「快照式」运行时解析器基座。
 *
 * 两个平台的差异只存在于：
 * 1. 靴代际/洗牌启发式（ingestTable / ingestShoeReset，各自实现）；
 * 2. 事件 ID 前缀、source 标签、靴 ID 前缀（options 注入）；
 * 3. BG 特有的 banker lead 粘滞与靴内重放（通过 hooks 注入）。
 *
 * 卡牌解析、百家乐补牌规则、开窗/关窗、结算去重、事件序号等
 * 百家乐领域机制全部收敛在这里，平台实现不得各自拷贝。
 */
import {
  EVENT_SCHEMA_VERSION,
  defaultProfile,
  type Card,
  type CardRank,
  type NormalizedEvent,
  type ShoeBaseline,
} from '@baccarat/contracts';

// ---------------------------------------------------------------------------
// 共享纯函数与常量
// ---------------------------------------------------------------------------

export const ROAD_WRAP_MAX = 8;
export const ROAD_WRAP_MIN_PREVIOUS = 10;
export const ROAD_WRAP_MIN_DROP = 8;
const GAME_COUNT_CATCH_UP_MAX = 5;
export const MAX_BACCARAT_SHOE_HANDS = 80;
/** A dealt shoe silent this long is shuffling. Missed NEXT_SHOES during stale. */
export const SHUFFLE_IDLE_GAP_MS = 6 * 60 * 1000;

export type ParserShoeReason = 'attach' | 'protocol-shuffle' | 'road-wrap' | 'manual-confirm';

export interface ParserShoeEvidence {
  readonly reason: ParserShoeReason;
  readonly previousGameCount?: number;
  readonly gameCount?: number;
}

export type SnapshotSource = 'dom' | 'protocol';
export type HandCards = { playerCards: Card[]; bankerCards: Card[]; source?: SnapshotSource };

export function isRoadWrapToNewShoe(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return previous !== undefined
    && previous >= ROAD_WRAP_MIN_PREVIOUS
    && gameCount >= 1
    && gameCount <= ROAD_WRAP_MAX
    && previous - gameCount >= ROAD_WRAP_MIN_DROP;
}

export function isIdleDealtShoeShuffle(
  handsThisShoe: number | undefined,
  lastHandAtMs: number | undefined,
  observedAtMs: number,
): boolean {
  if ((handsThisShoe ?? 0) < ROAD_WRAP_MIN_PREVIOUS) return false;
  if (lastHandAtMs === undefined || !Number.isFinite(observedAtMs)) return false;
  return observedAtMs - lastHandAtMs >= SHUFFLE_IDLE_GAP_MS;
}

export function cardIdentity(card: Card): string {
  const raw = typeof card.raw === 'string' ? card.raw.trim().toUpperCase() : '';
  if (raw.length > 0) return raw;
  return `${card.rank}${card.suit ?? ''}`;
}

export function mergeCardList(
  existing: readonly Card[] | undefined,
  incoming: readonly Card[],
  incomingSource: SnapshotSource | undefined,
  existingSource: SnapshotSource | undefined,
): Card[] {
  if (incoming.length === 0) return existing ? [...existing] : [];
  if (!existing || existing.length === 0) return [...incoming];
  const overlap = Math.min(existing.length, incoming.length);
  let conflict = false;
  for (let index = 0; index < overlap; index += 1) {
    if (cardIdentity(existing[index]!) !== cardIdentity(incoming[index]!)) {
      conflict = true;
      break;
    }
  }
  if (!conflict) {
    const merged = incoming.length > existing.length ? [...incoming] : [...existing];
    return merged.slice(0, 3);
  }
  if (incomingSource === 'protocol' && existingSource !== 'protocol') {
    return incoming.slice(0, 3);
  }
  return existing.slice(0, 3);
}

export function mergeHandCards(
  existing: HandCards | undefined,
  incomingPlayer: readonly Card[],
  incomingBanker: readonly Card[],
  incomingSource: SnapshotSource | undefined,
): HandCards {
  const source = incomingSource === 'protocol' || existing?.source === 'protocol'
    ? 'protocol'
    : incomingSource ?? existing?.source;
  return {
    playerCards: mergeCardList(existing?.playerCards, incomingPlayer, incomingSource, existing?.source),
    bankerCards: mergeCardList(existing?.bankerCards, incomingBanker, incomingSource, existing?.source),
    ...(source === undefined ? {} : { source }),
  };
}

const CARD_PATTERN = /^(10|[2-9AJQK]|[01])([SHDC])([0-8])?$/i;

export function parseCard(value: string): Card | null {
  const match = CARD_PATTERN.exec(value.trim());
  if (!match) return null;
  const rankToken = match[1]!.toUpperCase();
  const rank = (rankToken === '0' ? '10' : rankToken === '1' ? 'A' : rankToken) as CardRank;
  return {
    rank,
    suit: match[2]!.toUpperCase(),
    raw: value.trim().toUpperCase(),
  };
}

export function parseCards(values: readonly string[] | undefined): Card[] {
  return (values ?? []).map(parseCard).filter((card): card is Card => card !== null);
}

export function cardPoint(card: { rank: string }): number {
  if (card.rank === 'A') return 1;
  if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 0;
  return Number(card.rank);
}

export function handScore(cards: readonly { rank: string }[]): number {
  return cards.reduce((score, card) => (score + cardPoint(card)) % 10, 0);
}

export function bankerDraws(bankerTotal: number, playerThird: number): boolean {
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return playerThird !== 8;
  if (bankerTotal === 4) return playerThird >= 2 && playerThird <= 7;
  if (bankerTotal === 5) return playerThird >= 4 && playerThird <= 7;
  if (bankerTotal === 6) return playerThird === 6 || playerThird === 7;
  return false;
}

export function isCompleteBaccaratHand(
  playerCards: readonly { rank: string }[],
  bankerCards: readonly { rank: string }[],
): boolean {
  if (playerCards.length < 2 || playerCards.length > 3 || bankerCards.length < 2 || bankerCards.length > 3) {
    return false;
  }
  const playerInitial = handScore(playerCards.slice(0, 2));
  const bankerInitial = handScore(bankerCards.slice(0, 2));
  if (playerInitial >= 8 || bankerInitial >= 8) return playerCards.length === 2 && bankerCards.length === 2;
  if (playerCards.length === 2) {
    if (playerInitial < 6) return false;
    return bankerCards.length === 2 ? bankerInitial >= 6 : bankerInitial <= 5;
  }
  if (playerInitial > 5) return false;
  const playerThird = playerCards[2];
  if (playerThird === undefined) return false;
  const bankerShouldDraw = bankerDraws(bankerInitial, cardPoint(playerThird));
  return bankerCards.length === 3 ? bankerShouldDraw : !bankerShouldDraw;
}

// ---------------------------------------------------------------------------
// 珠盘路子（bead plate）投影：当前靴每局结果 + 对子标记，供中控 UI 渲染。
// ---------------------------------------------------------------------------

export type BeadResult = 'banker' | 'player' | 'tie';

export interface BeadHand {
  readonly handId: string;
  readonly result: BeadResult;
  readonly bankerPair: boolean;
  readonly playerPair: boolean;
}

export function beadResultOf(
  playerCards: readonly { rank: string }[],
  bankerCards: readonly { rank: string }[],
): BeadResult {
  const player = handScore(playerCards);
  const banker = handScore(bankerCards);
  return banker === player ? 'tie' : banker > player ? 'banker' : 'player';
}

function compareBeadHandId(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isSafeInteger(na) && Number.isSafeInteger(nb) && `${na}` === a && `${nb}` === b) {
    return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 从逐手牌数据推导珠盘序列。仅收录完整成局的牌（与结算判定 isCompleteBaccaratHand
 * 同源），避免把仍在发牌中的最后一手画进路子。按局号升序，最多保留一靴 80 局。
 */
export function beadSequenceFromHands(
  hands: Iterable<{
    readonly handId: string;
    readonly playerCards: readonly { rank: string }[];
    readonly bankerCards: readonly { rank: string }[];
  }>,
): BeadHand[] {
  const beads: BeadHand[] = [];
  for (const hand of hands) {
    if (hand.playerCards.length < 2 || hand.bankerCards.length < 2) continue;
    if (!isCompleteBaccaratHand(hand.playerCards, hand.bankerCards)) continue;
    beads.push({
      handId: hand.handId,
      result: beadResultOf(hand.playerCards, hand.bankerCards),
      bankerPair: hand.bankerCards[0]!.rank === hand.bankerCards[1]!.rank,
      playerPair: hand.playerCards[0]!.rank === hand.playerCards[1]!.rank,
    });
  }
  beads.sort((a, b) => compareBeadHandId(a.handId, b.handId));
  return beads.slice(-MAX_BACCARAT_SHOE_HANDS);
}

// ---------------------------------------------------------------------------
// 快照解析器基类
// ---------------------------------------------------------------------------

export interface SnapshotParserOptions {
  /** 平台标识，盖戳到所有产出事件（NormalizedEvent.platformId）。 */
  readonly platformId: string;
  /** 事件 ID 前缀，如 'pragmatic' / 'bg'。 */
  readonly eventIdPrefix: string;
  /** 事件 source 标签，如 'pragmatic-runtime' / 'bg-runtime'。 */
  readonly eventSourceName: string;
  /** 靴 ID 前缀，如 'pragmatic' / 'bg'。 */
  readonly shoeIdPrefix: string;
}

export abstract class SnapshotRuntimeParserBase {
  private readonly runId = Math.random().toString(36).slice(2, 10);
  private readonly generationByTable = new Map<string, number>();
  private readonly seqByTable = new Map<string, number>();
  private readonly shoeSeqByTable = new Map<string, number>();
  private readonly shoeIdByTable = new Map<string, string>();
  private readonly lastShoeResetByTable = new Map<string, string>();
  private readonly lastGameCountByTable = new Map<string, number>();
  private readonly handsThisShoeByTable = new Map<string, number>();
  private readonly lastRoundByTable = new Map<string, string>();
  private readonly cardBoundaryByHand = new Set<string>();
  private readonly cardsByHand = new Map<string, HandCards>();
  private readonly seenCardsByHand = new Map<string, Set<string>>();
  private readonly openedWindows = new Set<string>();
  private readonly closedWindows = new Set<string>();
  private readonly windowOpenCount = new Map<string, number>();
  private readonly windowClosesAtMs = new Map<string, number>();
  private readonly lastWindowEmitAtMs = new Map<string, number>();
  private readonly settledHands = new Set<string>();
  private readonly finishedHands = new Set<string>();
  private readonly evidenceByTable = new Map<string, ParserShoeEvidence>();
  private readonly lastHandAtByTable = new Map<string, number>();

  protected readonly options: SnapshotParserOptions;

  protected constructor(options: SnapshotParserOptions) {
    this.options = options;
  }

  currentShoeId(tableId: string): string | undefined {
    return this.shoeIdByTable.get(tableId);
  }

  acceptedGameCount(tableId: string): number | undefined {
    return this.lastGameCountByTable.get(tableId);
  }

  shoeEvidence(tableId: string): ParserShoeEvidence | undefined {
    const evidence = this.evidenceByTable.get(tableId);
    return evidence === undefined ? undefined : { ...evidence };
  }

  recordShoeEvidence(tableId: string, evidence: ParserShoeEvidence): void {
    this.evidenceByTable.set(tableId, evidence);
  }

  openPhysicalShoe(tableId: string, timestamp: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    this.beginNewShoe(tableId, timestamp, events, 'physical-shoe', { reason: 'manual-confirm' });
    return events;
  }

  resetTable(tableId: string): void {
    this.generationByTable.set(tableId, (this.generationByTable.get(tableId) ?? 0) + 1);
    this.seqByTable.delete(tableId);
    this.shoeSeqByTable.delete(tableId);
    this.shoeIdByTable.delete(tableId);
    this.lastShoeResetByTable.delete(tableId);
    this.lastGameCountByTable.delete(tableId);
    this.handsThisShoeByTable.delete(tableId);
    this.lastRoundByTable.delete(tableId);
    this.lastHandAtByTable.delete(tableId);
    this.evidenceByTable.delete(tableId);
    this.clearPlatformState(tableId);
    this.clearHandState(tableId);
  }

  // -- 平台钩子 -------------------------------------------------------------

  /** 平台自有、按桌维度的全部状态（resetTable 时清理）。 */
  protected abstract clearPlatformState(tableId: string): void;

  /** 平台自有、按靴维度的状态（beginNewShoe/clearShoeTracking 时清理）。 */
  protected abstract clearPlatformShoeState(tableId: string): void;

  /** 记牌前的平台过滤（如 BG 的 banker lead 剥离）；返回 null 跳过该牌。 */
  protected beforeRecordCard(
    _tableId: string,
    _position: 'player' | 'banker',
    _index: number,
    card: Card,
  ): Card | null {
    return card;
  }

  /** 结算前调整手牌（如 BG 剥离粘滞 banker lead）。 */
  protected prepareSettlementCards(tableId: string, cards: HandCards): HandCards {
    void tableId;
    return cards;
  }

  // -- 共享机制 ---------------------------------------------------------------

  protected currentHandsThisShoe(tableId: string): number | undefined {
    return this.handsThisShoeByTable.get(tableId);
  }

  protected currentEvidenceReason(tableId: string): ParserShoeReason | undefined {
    return this.evidenceByTable.get(tableId)?.reason;
  }

  protected lastHandAtMs(tableId: string): number | undefined {
    return this.lastHandAtByTable.get(tableId);
  }

  protected handCards(tableId: string, handId: string): HandCards | undefined {
    return this.cardsByHand.get(`${tableId}:${handId}`);
  }

  protected rememberHandCards(tableId: string, handId: string, cards: HandCards): void {
    this.cardsByHand.set(`${tableId}:${handId}`, cards);
  }

  /** 当前靴珠盘序列（结果 + 对子标记）。cardsByHand 按靴清空，天然只含本靴。 */
  beadSequence(tableId: string): BeadHand[] {
    const prefix = `${tableId}:`;
    const hands: Array<{ handId: string; playerCards: HandCards['playerCards']; bankerCards: HandCards['bankerCards'] }> = [];
    for (const [key, cards] of this.cardsByHand) {
      if (!key.startsWith(prefix)) continue;
      hands.push({ handId: key.slice(prefix.length), playerCards: cards.playerCards, bankerCards: cards.bankerCards });
    }
    return beadSequenceFromHands(hands);
  }

  /** 该桌是否有解析器靴状态（用于适配器声明珠盘数据归属，避免默认平台误认领）。 */
  hasShoeState(tableId: string): boolean {
    return this.shoeIdByTable.has(tableId);
  }

  protected lastRoundFor(tableId: string): string | undefined {
    return this.lastRoundByTable.get(tableId);
  }

  protected handFinished(tableId: string, handId: string): boolean {
    return this.finishedHands.has(`${tableId}:${handId}`);
  }

  protected markHandFinished(tableId: string, handId: string): void {
    this.finishedHands.add(`${tableId}:${handId}`);
  }

  protected handSettledAlready(tableId: string, handId: string): boolean {
    return this.settledHands.has(`${tableId}:${handId}`);
  }

  protected handHasCardBoundary(tableId: string, handId: string): boolean {
    return this.cardBoundaryByHand.has(`${tableId}:${handId}`);
  }

  protected markCardBoundary(tableId: string, handId: string): void {
    this.cardBoundaryByHand.add(`${tableId}:${handId}`);
  }

  protected setLastShoeResetToken(tableId: string, token: string): void {
    this.lastShoeResetByTable.set(tableId, token);
  }

  protected lastShoeResetToken(tableId: string): string | undefined {
    return this.lastShoeResetByTable.get(tableId);
  }

  protected setAcceptedGameCount(tableId: string, gameCount: number): void {
    this.lastGameCountByTable.set(tableId, gameCount);
  }

  protected setHandsThisShoe(tableId: string, hands: number): void {
    this.handsThisShoeByTable.set(tableId, hands);
  }

  /** 靴代际（进程内单调递增；BG 通过 seedShoeSequence 跨重启保持连续）。 */
  currentShoeSequence(tableId: string): number | undefined {
    return this.shoeSeqByTable.get(tableId);
  }

  protected setShoeSequence(tableId: string, sequence: number): void {
    this.shoeSeqByTable.set(tableId, sequence);
  }

  protected nextSeq(tableId: string): number {
    const next = (this.seqByTable.get(tableId) ?? 0) + 1;
    this.seqByTable.set(tableId, next);
    return next;
  }

  protected makeEvent(
    tableId: string,
    type: NormalizedEvent['type'],
    stableKey: string,
    timestamp: string,
    extra: Record<string, unknown>,
  ): NormalizedEvent {
    return {
      type,
      eventId: `${this.options.eventIdPrefix}:${this.runId}:${this.generationByTable.get(tableId) ?? 0}:${tableId}:${type}:${stableKey}`,
      platformId: this.options.platformId,
      tableId,
      timestamp,
      sourceSeq: this.nextSeq(tableId),
      source: this.options.eventSourceName,
      schemaVersion: EVENT_SCHEMA_VERSION,
      ...extra,
    } as NormalizedEvent;
  }

  protected ensureShoe(
    tableId: string,
    baseline: ShoeBaseline,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    if (this.shoeIdByTable.has(tableId)) return;
    const sequence = (this.shoeSeqByTable.get(tableId) ?? 0) + 1;
    this.shoeSeqByTable.set(tableId, sequence);
    if (!this.evidenceByTable.has(tableId)) this.evidenceByTable.set(tableId, { reason: 'attach' });
    this.emitShoe(tableId, sequence, baseline, timestamp, events);
  }

  protected beginNewShoe(
    tableId: string,
    timestamp: string,
    events: NormalizedEvent[],
    baseline: ShoeBaseline,
    evidence?: ParserShoeEvidence,
  ): void {
    this.clearShoeTracking(tableId);
    const sequence = (this.shoeSeqByTable.get(tableId) ?? 1) + 1;
    this.shoeSeqByTable.set(tableId, sequence);
    if (evidence !== undefined) this.evidenceByTable.set(tableId, evidence);
    this.emitShoe(tableId, sequence, baseline, timestamp, events);
  }

  protected setLastRound(tableId: string, handId: string, observedAt: string): void {
    const previous = this.lastRoundByTable.get(tableId);
    this.lastRoundByTable.set(tableId, handId);
    if (previous === handId) return;
    const at = Date.parse(observedAt);
    if (Number.isFinite(at)) this.lastHandAtByTable.set(tableId, at);
  }

  private clearShoeTracking(tableId: string): void {
    this.lastGameCountByTable.delete(tableId);
    this.handsThisShoeByTable.delete(tableId);
    this.lastRoundByTable.delete(tableId);
    this.lastHandAtByTable.delete(tableId);
    this.evidenceByTable.delete(tableId);
    this.clearPlatformShoeState(tableId);
    this.clearHandState(tableId, { keepSettledHands: true });
  }

  private clearHandState(tableId: string, options: { readonly keepSettledHands?: boolean } = {}): void {
    const prefix = `${tableId}:`;
    for (const key of this.cardsByHand.keys()) if (key.startsWith(prefix)) this.cardsByHand.delete(key);
    for (const key of this.seenCardsByHand.keys()) if (key.startsWith(prefix)) this.seenCardsByHand.delete(key);
    for (const key of this.cardBoundaryByHand) if (key.startsWith(prefix)) this.cardBoundaryByHand.delete(key);
    for (const key of this.openedWindows) if (key.startsWith(prefix)) this.openedWindows.delete(key);
    for (const key of this.closedWindows) if (key.startsWith(prefix)) this.closedWindows.delete(key);
    for (const key of this.windowOpenCount.keys()) if (key.startsWith(prefix)) this.windowOpenCount.delete(key);
    for (const key of this.windowClosesAtMs.keys()) if (key.startsWith(prefix)) this.windowClosesAtMs.delete(key);
    for (const key of this.lastWindowEmitAtMs.keys()) if (key.startsWith(prefix)) this.lastWindowEmitAtMs.delete(key);
    for (const key of this.finishedHands) if (key.startsWith(prefix)) this.finishedHands.delete(key);
    if (options.keepSettledHands === true) return;
    for (const key of this.settledHands) if (key.startsWith(prefix)) this.settledHands.delete(key);
  }

  private emitShoe(
    tableId: string,
    sequence: number,
    baseline: ShoeBaseline,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const shoeId = `${this.options.shoeIdPrefix}-${tableId}-${sequence}`;
    this.shoeIdByTable.set(tableId, shoeId);
    events.push(this.makeEvent(tableId, 'newShoeSignal', `shoe:${shoeId}`, timestamp, {
      shoeId,
      baseline,
      profile: {
        ...defaultProfile(tableId),
        autoConfirmNewShoe: true,
      },
    }));
  }

  protected recordCards(
    tableId: string,
    handId: string,
    position: 'player' | 'banker',
    cards: readonly Card[],
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const handKey = `${tableId}:${handId}`;
    const seen = this.seenCardsByHand.get(handKey) ?? new Set<string>();
    this.seenCardsByHand.set(handKey, seen);
    cards.slice(0, 3).forEach((card, index) => {
      const filtered = this.beforeRecordCard(tableId, position, index, card);
      if (filtered === null) return;
      const identity = cardIdentity(filtered);
      if ([...seen].some(key => {
        const parts = key.split(':');
        return parts[0] === position && parts.slice(2).join(':') === identity;
      })) return;
      const cardKey = `${position}:${index}:${identity}`;
      if (seen.has(cardKey)) return;
      seen.add(cardKey);
      events.push(this.makeEvent(tableId, 'cardObserved', `card:${handId}:${cardKey}`, timestamp, {
        shoeId: this.shoeIdByTable.get(tableId) ?? '',
        handId,
        card: filtered,
        position,
      }));
    });
  }

  protected openWindows(
    tableId: string,
    handId: string,
    countdown: number | undefined,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const observedAtMs = Date.parse(timestamp);
    const closesAtMs = Number.isFinite(countdown) && Number.isFinite(observedAtMs)
      ? observedAtMs + Math.max(0, countdown!) * 1000
      : undefined;
    const shoeId = this.shoeIdByTable.get(tableId) ?? '';
    for (const market of ['bankerPair', 'playerPair'] as const) {
      const key = `${tableId}:${handId}:${market}`;
      const alreadyOpen = this.openedWindows.has(key) && !this.closedWindows.has(key);
      if (alreadyOpen) {
        const hadClosesAt = this.windowClosesAtMs.get(key) !== undefined;
        if (!Number.isFinite(closesAtMs) && !hadClosesAt) continue;
        if (hadClosesAt) {
          this.windowClosesAtMs.set(key, closesAtMs!);
          continue;
        }
      }
      this.openedWindows.add(key);
      this.closedWindows.delete(key);
      if (Number.isFinite(closesAtMs)) this.windowClosesAtMs.set(key, closesAtMs!);
      if (Number.isFinite(observedAtMs)) this.lastWindowEmitAtMs.set(key, observedAtMs);
      const closesAt = Number.isFinite(closesAtMs) ? new Date(closesAtMs!).toISOString() : undefined;
      let openCount = this.windowOpenCount.get(key) ?? 0;
      if (!alreadyOpen) {
        openCount += 1;
        this.windowOpenCount.set(key, openCount);
      }
      const base = `open:${shoeId}:${handId}:${market}`;
      const reopen = openCount > 1 ? `:reopen:${openCount - 1}` : '';
      const stableKey = alreadyOpen ? `${base}${reopen}:eta` : `${base}${reopen}`;
      events.push(this.makeEvent(tableId, 'bettingWindowOpened', stableKey, timestamp, {
        shoeId,
        handId,
        market,
        ...(closesAt === undefined ? {} : { closesAt }),
      }));
    }
  }

  protected closeWindows(
    tableId: string,
    handId: string,
    timestamp: string,
    events: NormalizedEvent[],
  ): void {
    const shoeId = this.shoeIdByTable.get(tableId) ?? '';
    for (const market of ['bankerPair', 'playerPair'] as const) {
      const key = `${tableId}:${handId}:${market}`;
      if (this.closedWindows.has(key)) continue;
      this.closedWindows.add(key);
      this.windowClosesAtMs.delete(key);
      const openCount = this.windowOpenCount.get(key) ?? 0;
      const reopen = openCount > 1 ? `:reopen:${openCount - 1}` : '';
      const unopened = openCount === 0 ? ':unopened' : '';
      events.push(this.makeEvent(tableId, 'bettingWindowClosed', `close:${shoeId}:${handId}:${market}${reopen}${unopened}`, timestamp, {
        shoeId,
        handId,
        market,
        openingObserved: this.openedWindows.has(key),
      }));
    }
  }

  protected settleRememberedHand(
    tableId: string,
    handId: string,
    timestamp: string,
    events: NormalizedEvent[],
    force = false,
  ): void {
    const handKey = `${tableId}:${handId}`;
    if (this.settledHands.has(handKey)) return;
    const remembered = this.cardsByHand.get(handKey);
    if (!remembered) return;
    const cards = this.prepareSettlementCards(tableId, remembered);
    if (cards.playerCards.length < 2 || cards.bankerCards.length < 2) return;
    if (!force && !isCompleteBaccaratHand(cards.playerCards, cards.bankerCards)) return;
    this.settledHands.add(handKey);
    events.push(this.makeEvent(tableId, 'handSettled', `settled:${this.shoeIdByTable.get(tableId) ?? ''}:${handId}`, timestamp, {
      shoeId: this.shoeIdByTable.get(tableId) ?? '',
      handId,
      playerCards: cards.playerCards,
      bankerCards: cards.bankerCards,
      outcomes: {
        playerPair: cards.playerCards[0]!.rank === cards.playerCards[1]!.rank,
        bankerPair: cards.bankerCards[0]!.rank === cards.bankerCards[1]!.rank,
      },
    }));
  }
}
