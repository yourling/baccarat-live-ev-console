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

function handHasInventory(projection: ShoeStateProjection, handId: string): boolean {
  return (projection.cardInventoryKeys ?? []).some(key => key.startsWith(`${handId}:`));
}

function consumeInventoryCard(projection: ShoeStateProjection, handId: string, card: Card, position: 'player' | 'banker'): void {
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

function applySettledHandCards(
  projection: ShoeStateProjection,
  handId: string,
  playerCards: readonly Card[],
  bankerCards: readonly Card[],
): void {
  // cardObserved is memory-only. Restart/actor rebuild only has handSettled.
  // If this hand already consumed live observations, do not double-count.
  if (handHasInventory(projection, handId)) return;
  for (const card of playerCards) consumeInventoryCard(projection, handId, card, 'player');
  for (const card of bankerCards) consumeInventoryCard(projection, handId, card, 'banker');
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
      if (updated.redCardSeen || updated.status === 'INVALIDATED' || updated.status === 'WAITING_CONFIRMATION') {
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
      if (beginHand(updated, event.handId) === 'stale') break;
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
