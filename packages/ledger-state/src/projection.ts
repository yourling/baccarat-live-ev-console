import {
  assertValidBurnModel,
  assertValidCard,
  assertValidEventEnvelope,
  assertValidTableProfile,
  isValidContinuityProof,
  type BurnModel,
  type Card,
  type CardRank,
  CARD_RANKS,
  type NormalizedEvent,
  type ShoeStateProjection,
  type TableProfile,
  defaultProfile,
  initialDeckCounts,
  sha256,
  stableStringify,
} from '@baccarat/contracts';

const EMPTY = {
  'A':0,'2':0,'3':0,'4':0,'5':0,'6':0,'7':0,'8':0,'9':0,'10':0,'J':0,'Q':0,'K':0
} as Record<string, number>;

/** A hand needs at least four cards, six with draws. Below this the shoe cannot deal. */
export const PHYSICAL_SHOE_UNDEALABLE_REMAINING = 6;
/**
 * Live dealer shoes are cut. We never see that card. Pair EV from the last
 * half-deck is not a betting universe — those cards will be shuffled, not dealt
 * as a normal first-two. Physical-shoe betting stops here; observation continues
 * until the next shuffle.
 */
export const PHYSICAL_SHOE_BETTABLE_REMAINING = 26;

export class ProjectionError extends Error {
  constructor(message: string, readonly eventId?: string) {
    super(eventId ? `${message} (event: ${eventId})` : message);
    this.name = 'ProjectionError';
  }
}

function fail(message: string, event?: NormalizedEvent): never {
  throw new ProjectionError(message, event?.eventId);
}

function nonEmptyString(value: unknown, field: string, event: NormalizedEvent): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`, event);
  return value as string;
}

function assertMarket(value: unknown, field: string, event: NormalizedEvent): void {
  if (value !== 'bankerPair' && value !== 'playerPair') fail(`${field} must be bankerPair or playerPair`, event);
}

export function emptyProjection(tableId: string): ShoeStateProjection {
  return {
    shoeId: '',
    shoeBaseline: 'unknown-monitor-session',
    tableId,
    profileSnapshot: defaultProfile(tableId),
    modelRevision: 'initial-empty',
    status: 'WAITING_NEW_SHOE',
    remainingCounts: { ...EMPTY } as ShoeStateProjection['remainingCounts'],
    remainingTotal: 0,
    seenCards: [],
    cardInventoryKeys: [],
    currentHandId: null,
    observedHandIds: [],
    currentHandHasCards: false,
    bettingWindowClosesAt: null,
    handNumber: 0,
    redCardSeen: false,
    burnModel: { kind: 'unknown' },
    eventWatermark: 0,
    autoBetStatus: 'DISARMED',
    connectionStatus: 'CONNECTED',
    sealed: false,
  };
}

function cloneProjection(s: ShoeStateProjection): ShoeStateProjection {
  return {
    ...s,
    profileSnapshot: structuredClone(s.profileSnapshot),
    remainingCounts: { ...s.remainingCounts },
    seenCards: s.seenCards.map(c => ({ ...c })),
    cardInventoryKeys: [...(s.cardInventoryKeys ?? [])],
    observedHandIds: [...s.observedHandIds],
    burnModel: structuredClone(s.burnModel),
  };
}

function beginHand(
  projection: ShoeStateProjection,
  handId: string,
): 'new' | 'current' | 'stale' {
  if (projection.currentHandId === handId) return 'current';
  if (projection.observedHandIds.includes(handId)) return 'stale';
  projection.observedHandIds.push(handId);
  projection.currentHandId = handId;
  projection.currentHandHasCards = false;
  projection.bettingWindowClosesAt = null;
  projection.handNumber = projection.observedHandIds.length;
  return 'new';
}

function withProfile(profile: TableProfile, tableId: string): TableProfile {
  const base = defaultProfile(tableId);
  const merged: TableProfile = {
    ...base,
    ...profile,
    pairRule: profile.pairRule ?? base.pairRule,
    odds: { ...base.odds, ...(profile.odds ?? {}) },
    burnModel: profile.burnModel ?? base.burnModel,
    limits: { ...base.limits, ...(profile.limits ?? {}) },
    monitorUrl: typeof profile.monitorUrl === 'string' ? profile.monitorUrl : undefined,
  };
  assertValidTableProfile(merged);
  return merged;
}

export function modelRevisionFor(profile: TableProfile): string {
  return sha256(stableStringify({
    decks: profile.numberOfDecks,
    burn: profile.burnModel,
    odds: profile.odds,
    minEV: profile.minEV,
    limits: profile.limits,
    strategy: profile.betStrategy,
    betTiers: profile.betTiers ?? [],
  })).slice(0, 16);
}

export function profileVersionFor(profile: TableProfile): number {
  const digest = sha256(stableStringify({
    tableId: profile.tableId,
    decks: profile.numberOfDecks,
    pairRule: profile.pairRule,
    burn: profile.burnModel,
    odds: profile.odds,
    minEV: profile.minEV,
    limits: profile.limits,
    strategy: profile.betStrategy,
    betTiers: profile.betTiers ?? [],
    autoConfirmNewShoe: profile.autoConfirmNewShoe,
    autoBetArmedByDefault: profile.autoBetArmedByDefault,
  }));
  return Number.parseInt(digest.slice(0, 8), 16);
}

function sumCounts(counts: Record<CardRank, number>): number {
  return CARD_RANKS.reduce((sum, r) => sum + counts[r], 0);
}

function recomputeRemaining(
  numberOfDecks: number,
  seenCards: Card[],
  burnModel: BurnModel,
): Record<CardRank, number> {
  const counts = initialDeckCounts(numberOfDecks) as Record<CardRank, number>;
  for (const card of seenCards) {
    if (counts[card.rank] <= 0) {
      fail(`seen cards exceed inventory after deck-count correction to ${numberOfDecks}`);
    }
    counts[card.rank] -= 1;
  }
  for (const card of burnModel.knownCards ?? []) {
    if (counts[card.rank] <= 0) {
      fail(`known burn cards exceed inventory for ${numberOfDecks} decks`);
    }
    counts[card.rank] -= 1;
  }
  return counts;
}

function assertCards(cards: unknown, field: string, event: NormalizedEvent): void {
  if (!Array.isArray(cards) || cards.length < 2) fail(`${field} must be an array of at least 2 cards`, event);
  for (let i = 0; i < cards.length; i++) assertValidCard(cards[i] as Card, `${field}[${i}]`);
}

function isCurrentShoe(eventShoeId: string, current: ShoeStateProjection): boolean {
  return current.shoeId !== '' && eventShoeId === current.shoeId && !current.sealed;
}

function recoverLiveFeed(projection: ShoeStateProjection): void {
  if (projection.status !== 'RESYNCING') return;
  // A current-shoe protocol event means the feed is back. Waiting for a
  // cursor proof here leaves auto-bet and 开盘 stuck while hands still settle.
  projection.status = 'TRACKING';
  projection.connectionStatus = 'CONNECTED';
}

function acceptLivePlay(projection: ShoeStateProjection): void {
  if (projection.status !== 'WAITING_CONFIRMATION') return;
  // Verified physical shoes, and any shoe already dealing, are not shuffling.
  projection.status = 'TRACKING';
}

function rejectOverdrawnRank(projection: ShoeStateProjection, rank: CardRank): boolean {
  if (projection.shoeBaseline !== 'physical-shoe') return false;
  if (projection.remainingCounts[rank] > 0) return false;
  // A ghost extra copy of an exhausted rank must not kill a still-dealable
  // +EV shoe. Only drop the physical label when the cut is already here.
  if (projection.remainingTotal <= PHYSICAL_SHOE_BETTABLE_REMAINING) {
    projection.shoeBaseline = 'unknown-monitor-session';
    projection.autoBetStatus = 'DISARMED';
  }
  return true;
}

function cardCopyId(card: Card): string {
  const raw = typeof card.raw === 'string' ? card.raw.trim().toUpperCase() : '';
  if (raw.length > 0) return raw;
  return `${card.rank}${card.suit ?? ''}`;
}

/** 该手已经计入库存的牌数（用于发现"手内漏采"，见 TableActor 的缺牌计数）。 */
export function countHandInventory(projection: ShoeStateProjection, handId: string): number {
  const prefix = `${handId}:`;
  return (projection.cardInventoryKeys ?? []).filter(key => key.startsWith(prefix)).length;
}

/**
 * FIX(C-P1-4): 把各 runtime 的 position 语义归一化到 'player' | 'banker'。
 *
 * `cardObserved.position` 在 contracts 里是可选字符串，三个 runtime 各有写法：
 *   - runtime-common（Pragmatic/BG）：'player' / 'banker'
 *   - winfinity-runtime：`${area}:${left|right|extra}`，如 'player:left'
 *   - 部分历史事件完全不带 position
 * 库存 key 是 `${handId}:${position}:${copyId}`，不归一化就永远对不上，
 * 也就无法判断"这手在 player 侧到底计过几张"。
 */
function normalizePosition(position: string | undefined): 'player' | 'banker' | undefined {
  if (position === undefined) return undefined;
  if (position.startsWith('player') || position === 'p') return 'player';
  if (position.startsWith('banker') || position === 'b') return 'banker';
  return undefined;
}

type InventoryPositionTally = { player: number; banker: number; unknown: number };

/**
 * 按归一化 position 统计该手已计入库存的张数。
 *
 * key 形状：`${handId}:${position}:${copyId}`。`position` 段是 `*`（cardObserved
 * 没带 position 时写的）或无法归一化时归入 `unknown` —— 这部分**不参与差集**，
 * 宁可漏补也不双扣。
 */
function tallyHandInventory(projection: ShoeStateProjection, handId: string): InventoryPositionTally {
  const tally: InventoryPositionTally = { player: 0, banker: 0, unknown: 0 };
  const prefix = `${handId}:`;
  for (const key of projection.cardInventoryKeys ?? []) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const separator = rest.indexOf(':');
    const rawPosition = separator < 0 ? '' : rest.slice(0, separator);
    const position = rawPosition.length === 0 || rawPosition === '*'
      ? undefined
      : normalizePosition(rawPosition);
    if (position === undefined) tally.unknown += 1;
    else tally[position] += 1;
  }
  return tally;
}

/**
 * 该手还有几张牌没有进库存（补不回来的部分）。
 *
 * FIX(C-P1-4): 修复前 `applySettledHandCards` 只要该手有任意一张牌进过库存就
 * 整手跳过补录，漏采的张永不扣减、`remainingTotal` 永久偏高；唯一检测是
 * TableActor.missingUnobservedCards（只在内存、阈值 >10 才移出监控）。
 * 现在按 position 差集补齐，并由本函数向 actor 暴露真实缺口，用于阻断下注。
 *
 * 语义：每个已计入的 key 都真实扣过一次库存（不论 position 能否识别），所以
 * `unknown` 的 key 可以用来抵消任一 position 的缺口；两者都抵消不了的部分才是
 * "确定缺的牌"。未采到任何一张时返回牌数（与"整手补录"前的旧检测一致，
 * 调用方用"该手是否已有库存"自行区分重启补录与真实漏采）。
 */
export function countMissingHandCards(
  projection: ShoeStateProjection,
  handId: string,
  playerCards: readonly unknown[],
  bankerCards: readonly unknown[],
): number {
  const tally = tallyHandInventory(projection, handId);
  const playerShort = Math.max(0, playerCards.length - tally.player);
  const bankerShort = Math.max(0, bankerCards.length - tally.banker);
  const coveredByUnknown = Math.min(tally.unknown, playerShort + bankerShort);
  return Math.max(0, playerShort + bankerShort - coveredByUnknown);
}

function consumeInventoryCard(
  projection: ShoeStateProjection,
  handId: string,
  card: Card,
  position: 'player' | 'banker',
): void {
  const copyId = cardCopyId(card);
  const inventoryKey = `${handId}:${position}:${copyId}`;
  projection.cardInventoryKeys = projection.cardInventoryKeys ?? [];
  if (projection.cardInventoryKeys.includes(inventoryKey)) return;
  projection.cardInventoryKeys.push(inventoryKey);
  const rank = card.rank;
  if (rejectOverdrawnRank(projection, rank)) return;
  projection.remainingCounts = {
    ...projection.remainingCounts,
    [rank]: Math.max(0, projection.remainingCounts[rank] - 1),
  };
  projection.remainingTotal = Math.max(0, projection.remainingTotal - 1);
  projection.seenCards.push({ ...card });
  applyPhysicalShoeLifecycle(projection);
}

/**
 * 用 handSettled 携带的完整牌面补齐该手漏采的库存。
 *
 * FIX(C-P1-4): 修复前是"该手只要有任意一张牌进过库存就整手跳过"，
 * 手内漏采的张永不扣减 —— 4 张的手只采到 1 张时 `remainingTotal` 是 415 而不是
 * 412。**确定成立的后果**是：剩余库存偏高 → 封靴线
 * （`PHYSICAL_SHOE_UNDEALABLE_REMAINING`）与停注线
 * （`PHYSICAL_SHOE_BETTABLE_REMAINING`）被整体推迟，等于在已过切牌线的靴上继续下注。
 *
 * FIX(P2-4) 方向断言更正：旧注释写"对子 EV 偏高"。审查用 30 个 seed 实测
 * （`review/scripts/math/14-missed-card-direction.ts`，15 正 15 负）证明**方向不成立**：
 * 漏采对子 EV 的污染方向取决于漏掉的是哪些 rank 的剩余分布，量级 < 0.35pp。
 * 因此本修复的目标是"`remainingTotal` 不偏高、封靴/停注线不被推迟"，
 * **不是**"修正 EV 偏高"；回归测试也只断言 remainingTotal / seenCards / 逐 rank
 * 计数 / 幂等这些确定成立的量。
 *
 * 现在逐张按 position 差集补齐：
 *   1. 统计该手已计入张数（player / banker / unknown）；
 *   2. 每个 position 只补"应有张数 - 已计入张数"，从后往前补
 *      （同一手里靠前的牌更可能已经被 cardObserved 采到，尾部才是漏掉的）；
 *   3. `unknown` 的已计入 key 视为"可能属于任一 position"：它先抵掉缺口，
 *      再决定还能补几张 —— 且任何时刻该手 key 总数不超过牌数，**绝不多扣**；
 *   4. 一张都没采到时合计为 0，整手补录（重启后只有 handSettled 的正常路径）。
 *
 * 幂等：补完后该手 key 数等于牌数，再次调用差集为 0，不增不减。
 * 返回补完后仍对不上的张数（未知 position 导致的残留），供诊断与缺牌计数。
 */
function applySettledHandCards(
  projection: ShoeStateProjection,
  handId: string,
  playerCards: readonly Card[],
  bankerCards: readonly Card[],
): number {
  const tally = tallyHandInventory(projection, handId);
  const paperCards = playerCards.length + bankerCards.length;
  // 每张已计入的 key 都已经扣过一张库存；该手最多还能补这么多张，否则就是双扣。
  let headroom = Math.max(0, paperCards - tally.player - tally.banker - tally.unknown);
  const playerShort = Math.max(0, playerCards.length - tally.player);
  const bankerShort = Math.max(0, bankerCards.length - tally.banker);
  // 从后往前补：front 的牌更可能已被 cardObserved 采到。
  const playerBackfill = Math.min(playerShort, headroom);
  headroom -= playerBackfill;
  const bankerBackfill = Math.min(bankerShort, headroom);
  for (const card of playerCards.slice(playerCards.length - playerBackfill)) {
    consumeInventoryCard(projection, handId, card, 'player');
  }
  for (const card of bankerCards.slice(bankerCards.length - bankerBackfill)) {
    consumeInventoryCard(projection, handId, card, 'banker');
  }
  return countMissingHandCards(projection, handId, playerCards, bankerCards);
}

function applyPhysicalShoeLifecycle(projection: ShoeStateProjection): void {
  if (projection.shoeBaseline !== 'physical-shoe') return;
  if (projection.remainingTotal < PHYSICAL_SHOE_UNDEALABLE_REMAINING) {
    projection.sealed = true;
    projection.status = 'WAITING_NEW_SHOE';
    projection.autoBetStatus = 'DISARMED';
    return;
  }
  if (projection.remainingTotal < PHYSICAL_SHOE_BETTABLE_REMAINING && projection.autoBetStatus === 'ARMED') {
    projection.autoBetStatus = 'DISARMED';
  }
}

export function isPhysicalShoeBettable(projection: Pick<ShoeStateProjection, 'shoeBaseline' | 'remainingTotal' | 'sealed'>): boolean {
  return projection.shoeBaseline === 'physical-shoe'
    && !projection.sealed
    && projection.remainingTotal >= PHYSICAL_SHOE_BETTABLE_REMAINING;
}


export function applyEvent(
  state: Map<string, ShoeStateProjection>,
  event: NormalizedEvent,
  sourceIndex: number,
): Map<string, ShoeStateProjection> {
  assertValidEventEnvelope(event);
  const next = new Map(state);
  const current = state.get(event.tableId) ?? emptyProjection(event.tableId);
  const updated = cloneProjection(current);
  updated.eventWatermark = sourceIndex;

  switch (event.type) {
    case 'newShoeSignal': {
      const shoeId = nonEmptyString(event.shoeId, 'shoeId', event);
      const shoeBaseline = event.baseline ?? 'unknown-monitor-session';
      const profile = withProfile({ ...(event.profile ?? {}) } as TableProfile, event.tableId);
      updated.shoeId = shoeId;
      updated.shoeBaseline = shoeBaseline;
      updated.profileSnapshot = profile;
      updated.modelRevision = modelRevisionFor(profile);
      updated.remainingCounts = recomputeRemaining(profile.numberOfDecks, [], profile.burnModel) as ShoeStateProjection['remainingCounts'];
      updated.remainingTotal = sumCounts(updated.remainingCounts);
      updated.seenCards = [];
      updated.cardInventoryKeys = [];
      updated.currentHandId = null;
      updated.observedHandIds = [];
      updated.currentHandHasCards = false;
      updated.bettingWindowClosesAt = null;
      updated.handNumber = 0;
      updated.redCardSeen = false;
      updated.burnModel = structuredClone(profile.burnModel);
      updated.sealed = false;
      updated.status = profile.autoConfirmNewShoe ? 'TRACKING' : 'WAITING_CONFIRMATION';
      updated.autoBetStatus = profile.autoBetArmedByDefault ? 'ARMED' : 'DISARMED';
      updated.connectionStatus = 'CONNECTED';
      break;
    }
    case 'shoeConfirmation': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      if (event.shoeId !== updated.shoeId) break;
      if (typeof event.approved !== 'boolean') fail('approved must be boolean', event);
      if (event.approved && updated.status === 'WAITING_CONFIRMATION') updated.status = 'TRACKING';
      break;
    }
    case 'cardObserved': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      nonEmptyString(event.handId, 'handId', event);
      assertValidCard(event.card);
      if (!isCurrentShoe(event.shoeId, current)) break;
      recoverLiveFeed(updated);
      acceptLivePlay(updated);
      const copyId = typeof event.card.raw === 'string' && event.card.raw.trim().length > 0
        ? event.card.raw.trim().toUpperCase()
        : `${event.card.rank}${event.card.suit ?? ''}`;
      const inventoryKey = `${event.handId}:${event.position ?? '*'}:${copyId}`;
      updated.cardInventoryKeys = updated.cardInventoryKeys ?? [];
      if (updated.cardInventoryKeys.includes(inventoryKey)) break;
      updated.cardInventoryKeys.push(inventoryKey);
      const rank = event.card.rank;
      const physicalInventoryIsKnown = updated.shoeBaseline === 'physical-shoe';
      if (rejectOverdrawnRank(updated, rank)) break;
      updated.remainingCounts = {
        ...updated.remainingCounts,
        [rank]: Math.max(0, updated.remainingCounts[rank] - 1),
      };
      updated.remainingTotal = Math.max(0, updated.remainingTotal - 1);
      updated.seenCards.push({ ...event.card });
      applyPhysicalShoeLifecycle(updated);
      const handState = beginHand(updated, event.handId);
      if (handState !== 'stale') updated.currentHandHasCards = true;
      if (
        handState !== 'stale'
        && (updated.status === 'BETTING_WINDOW' || updated.status === 'PENDING_SETTLEMENT')
      ) {
        updated.status = 'TRACKING';
        updated.bettingWindowClosesAt = null;
      }
      break;
    }
    case 'bettingWindowOpened': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      nonEmptyString(event.handId, 'handId', event);
      assertMarket(event.market, 'market', event);
      if (!isCurrentShoe(event.shoeId, current)) break;
      recoverLiveFeed(updated);
      acceptLivePlay(updated);
      if (updated.redCardSeen || updated.status === 'INVALIDATED') {
        break;
      }
      if (updated.shoeBaseline === 'physical-shoe' && !isPhysicalShoeBettable(updated)) {
        break;
      }
      const handState = beginHand(updated, event.handId);
      if (handState === 'stale') break;
      if (handState === 'current' && updated.currentHandHasCards) break;
      updated.status = 'BETTING_WINDOW';
      if (typeof event.closesAt === 'string' && event.closesAt.length > 0) {
        updated.bettingWindowClosesAt = event.closesAt;
      }
      break;
    }
    case 'bettingWindowClosed': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      nonEmptyString(event.handId, 'handId', event);
      assertMarket(event.market, 'market', event);
      if (!isCurrentShoe(event.shoeId, current)) break;
      if (updated.redCardSeen) {
        updated.status = 'RED_CARD_WIND_DOWN';
        updated.bettingWindowClosesAt = null;
      } else if (updated.status === 'BETTING_WINDOW' && updated.currentHandId === event.handId) {
        updated.status = 'TRACKING';
        updated.bettingWindowClosesAt = null;
      }
      break;
    }

    case 'redCardSeen': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      if (!isCurrentShoe(event.shoeId, current)) break;
      updated.redCardSeen = true;
      updated.status = 'RED_CARD_WIND_DOWN';
      updated.autoBetStatus = 'DISARMED';
      if (event.handId) updated.currentHandId = event.handId;
      break;
    }
    case 'handSettled': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      nonEmptyString(event.handId, 'handId', event);
      assertCards(event.playerCards, 'playerCards', event);
      assertCards(event.bankerCards, 'bankerCards', event);
      if (event.outcomes) {
        if (typeof event.outcomes.bankerPair !== 'boolean' || typeof event.outcomes.playerPair !== 'boolean') {
          fail('outcomes.bankerPair and outcomes.playerPair must be boolean', event);
        }
      }
      if (!isCurrentShoe(event.shoeId, current)) break;
      recoverLiveFeed(updated);
      acceptLivePlay(updated);
      if (beginHand(updated, event.handId) === 'stale') break;
      // FIX(C-P1-4): 逐张按 position 差集补齐（修复"整手跳过"导致 remainingTotal 偏高）。
      // 返回值是补不回来的张数，由 TableActor 计入缺牌数并阻断下注（C-P1-3）。
      applySettledHandCards(updated, event.handId, event.playerCards, event.bankerCards);
      if (updated.redCardSeen) {
        updated.status = 'WAITING_NEW_SHOE';
        updated.sealed = true;
      } else if (updated.status === 'BETTING_WINDOW' || updated.status === 'TRACKING' || updated.status === 'PENDING_SETTLEMENT') {
        updated.status = 'TRACKING';
        updated.bettingWindowClosesAt = null;
      }
      break;
    }
    case 'burnModelUpdated': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      assertValidBurnModel(event.burnModel, 'burnModel');
      if (!isCurrentShoe(event.shoeId, current)) break;
      updated.burnModel = structuredClone(event.burnModel);
      updated.profileSnapshot = { ...updated.profileSnapshot, burnModel: structuredClone(event.burnModel) };
      updated.remainingCounts = recomputeRemaining(
        updated.profileSnapshot.numberOfDecks,
        updated.seenCards,
        updated.burnModel,
      ) as ShoeStateProjection['remainingCounts'];
      updated.remainingTotal = sumCounts(updated.remainingCounts);
      updated.modelRevision = modelRevisionFor(updated.profileSnapshot);
      updated.autoBetStatus = 'NEEDS_MANUAL_RECOVERY';
      applyPhysicalShoeLifecycle(updated);
      break;
    }
    case 'connectionLost': {
      updated.connectionStatus = 'DISCONNECTED';
      updated.autoBetStatus = 'DISARMED';
      if (!updated.sealed && updated.shoeId) updated.status = 'RESYNCING';
      // Feed gaps and extension flashes are not reshuffles. Keep the physical
      // shoe so remaining-card inventory survives multi-table BG silence.
      if (
        updated.shoeBaseline === 'physical-shoe'
        && event.reason !== 'browser-extension-disconnected'
        && event.reason !== 'table-feed-stale'
        && event.reason !== 'process-restarted'
        && event.reason !== 'extension-session-restarted'
      ) {
        updated.shoeBaseline = 'unknown-monitor-session';
      }
      break;
    }
    case 'connectionRestored': {
      if (isValidContinuityProof(event.continuityProof)) {
        updated.connectionStatus = 'CONNECTED';
        if (updated.status === 'RESYNCING') {
          updated.status = updated.redCardSeen ? 'RED_CARD_WIND_DOWN' : 'TRACKING';
        }
      } else {
        updated.connectionStatus = 'RESYNCING';
        if (!updated.sealed && updated.shoeId) updated.status = 'RESYNCING';
      }
      break;
    }
    case 'shoeInvalidated': {
      if (!event.shoeId || event.shoeId === updated.shoeId) {
        updated.status = 'INVALIDATED';
        updated.sealed = true;
        updated.autoBetStatus = 'DISARMED';
      }
      break;
    }

    case 'manualCorrection': {
      if (event.shoeId && event.shoeId !== updated.shoeId) break;
      const correction = event.correction;
      if (correction.kind === 'burnModel') {
        assertValidBurnModel(correction.burnModel, 'correction.burnModel');
        updated.burnModel = structuredClone(correction.burnModel);
        updated.profileSnapshot = { ...updated.profileSnapshot, burnModel: structuredClone(correction.burnModel) };
      } else if (correction.kind === 'numberOfDecks') {
        if (!Number.isInteger(correction.numberOfDecks) || correction.numberOfDecks <= 0 || correction.numberOfDecks > 20) {
          fail('correction.numberOfDecks must be an integer in 1..20', event);
        }
        updated.profileSnapshot = { ...updated.profileSnapshot, numberOfDecks: correction.numberOfDecks };
      } else {
        fail('unknown manual correction kind', event);
      }
      updated.remainingCounts = recomputeRemaining(
        updated.profileSnapshot.numberOfDecks,
        updated.seenCards,
        updated.burnModel,
      ) as ShoeStateProjection['remainingCounts'];
      updated.remainingTotal = sumCounts(updated.remainingCounts);
      updated.modelRevision = modelRevisionFor(updated.profileSnapshot);
      updated.autoBetStatus = correction.requireRearm === false ? updated.autoBetStatus : 'NEEDS_MANUAL_RECOVERY';
      applyPhysicalShoeLifecycle(updated);
      break;
    }
    case 'autoArmChanged': {
      if (event.shoeId && event.shoeId !== updated.shoeId) break;
      if (typeof event.armed !== 'boolean') fail('armed must be boolean', event);
      if (!event.armed) {
        updated.autoBetStatus = 'DISARMED';
        break;
      }
      if (updated.redCardSeen || updated.status === 'INVALIDATED' || updated.status === 'RESYNCING' || updated.status === 'WAITING_CONFIRMATION') {
        break;
      }
      if (updated.shoeBaseline === 'physical-shoe' && !isPhysicalShoeBettable(updated)) {
        break;
      }
      updated.autoBetStatus = 'ARMED';
      break;
    }
    case 'autoDisarmChanged': {
      if (event.shoeId && event.shoeId !== updated.shoeId) break;
      updated.autoBetStatus = 'DISARMED';
      break;
    }
    case 'betReceipt': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      nonEmptyString(event.handId, 'handId', event);
      assertMarket(event.market, 'market', event);
      if (!event.receipt || typeof event.receipt !== 'object') fail('receipt is required', event);
      if (!isCurrentShoe(event.shoeId, current)) break;
      // 回执不改变牌靴库存；仅作为审计事件保留。
      break;
    }
  }

  next.set(event.tableId, updated);
  return next;
}

export function replayEvents(events: NormalizedEvent[]): Map<string, ShoeStateProjection> {
  let state = new Map<string, ShoeStateProjection>();
  events
    .slice()
    .sort((a, b) => a.sourceSeq - b.sourceSeq || a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId))
    .forEach((event, index) => {
      state = applyEvent(state, event, index + 1);
    });
  return state;
}
