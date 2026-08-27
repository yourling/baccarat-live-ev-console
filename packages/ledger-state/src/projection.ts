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
    currentHandId: null,
    observedHandIds: [],
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
      const shoeBaseline = event.baseline ?? (event.source === 'mstrom-protocol' || event.source === 'mstrom-runtime' ? 'unknown-monitor-session' : 'physical-shoe');
      const profile = withProfile({ ...(event.profile ?? {}) } as TableProfile, event.tableId);
      updated.shoeId = shoeId;
      updated.shoeBaseline = shoeBaseline;
      updated.profileSnapshot = profile;
      updated.modelRevision = modelRevisionFor(profile);
      updated.remainingCounts = recomputeRemaining(profile.numberOfDecks, [], profile.burnModel) as ShoeStateProjection['remainingCounts'];
      updated.remainingTotal = sumCounts(updated.remainingCounts);
      updated.seenCards = [];
      updated.currentHandId = null;
      updated.observedHandIds = [];
      updated.handNumber = 0;
      updated.redCardSeen = false;
      updated.burnModel = structuredClone(profile.burnModel);
      updated.sealed = false;
      updated.status = profile.autoConfirmNewShoe ? 'TRACKING' : 'WAITING_CONFIRMATION';
      updated.autoBetStatus = shoeBaseline === 'unknown-monitor-session'
        ? 'DISARMED'
        : profile.autoBetArmedByDefault ? 'ARMED' : 'DISARMED';
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
      const rank = event.card.rank;
      const physicalInventoryIsKnown = updated.shoeBaseline === 'physical-shoe';
      if (physicalInventoryIsKnown && updated.remainingCounts[rank] <= 0) {
        fail(`card rank ${rank} observed more times than remaining shoe inventory allows`, event);
      }
      updated.remainingCounts = {
        ...updated.remainingCounts,
        [rank]: Math.max(0, updated.remainingCounts[rank] - 1),
      };
      updated.remainingTotal = Math.max(0, updated.remainingTotal - 1);
      updated.seenCards.push({ ...event.card });
      const handState = beginHand(updated, event.handId);
      if (
        handState !== 'stale'
        && (updated.status === 'BETTING_WINDOW' || updated.status === 'PENDING_SETTLEMENT')
      ) {
        updated.status = 'TRACKING';
      }
      break;
    }
    case 'bettingWindowOpened': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      nonEmptyString(event.handId, 'handId', event);
      assertMarket(event.market, 'market', event);
      if (!isCurrentShoe(event.shoeId, current)) break;
      if (updated.redCardSeen || updated.status === 'INVALIDATED' || updated.status === 'RESYNCING' || updated.status === 'WAITING_CONFIRMATION') {
        break;
      }
      const handState = beginHand(updated, event.handId);
      if (handState === 'stale' || (handState === 'current' && updated.status !== 'BETTING_WINDOW')) break;
      updated.status = 'BETTING_WINDOW';
      break;
    }
    case 'bettingWindowClosed': {
      nonEmptyString(event.shoeId, 'shoeId', event);
      nonEmptyString(event.handId, 'handId', event);
      assertMarket(event.market, 'market', event);
      if (!isCurrentShoe(event.shoeId, current)) break;
      if (updated.redCardSeen) {
        updated.status = 'RED_CARD_WIND_DOWN';
      } else if (updated.status === 'BETTING_WINDOW' && updated.currentHandId === event.handId) {
        updated.status = 'TRACKING';
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
      if (beginHand(updated, event.handId) === 'stale') break;
      if (updated.redCardSeen) {
        updated.status = 'WAITING_NEW_SHOE';
        updated.sealed = true;
      } else if (updated.status === 'BETTING_WINDOW' || updated.status === 'TRACKING' || updated.status === 'PENDING_SETTLEMENT') {
        updated.status = 'TRACKING';
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
      break;
    }
    case 'connectionLost': {
      updated.connectionStatus = 'DISCONNECTED';
      updated.autoBetStatus = 'DISARMED';
      if (!updated.sealed && updated.shoeId) updated.status = 'RESYNCING';
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
      break;
    }
    case 'autoArmChanged': {
      if (event.shoeId && event.shoeId !== updated.shoeId) break;
      if (typeof event.armed !== 'boolean') fail('armed must be boolean', event);
      if (!event.armed) {
        updated.autoBetStatus = 'DISARMED';
        break;
      }
      if (updated.shoeBaseline === 'unknown-monitor-session' || updated.redCardSeen || updated.status === 'INVALIDATED' || updated.status === 'RESYNCING' || updated.status === 'WAITING_CONFIRMATION') {
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
