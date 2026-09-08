import type { ShoeBaseline, ShoeStateProjection } from '@baccarat/contracts';

export function initialShoeTotal(numberOfDecks: number): number {
  return numberOfDecks * 52;
}

export type ShoeBaselineReason =
  | 'attach'
  | 'protocol-shuffle'
  | 'road-wrap'
  | 'manual-confirm'
  | 'inventory-contradiction'
  | 'restart-empty-inventory';

export interface ShoeBaselineEvidence {
  readonly reason: ShoeBaselineReason;
  readonly previousGameCount?: number;
  readonly gameCount?: number;
}

export const VERIFIED_PHYSICAL_SHOE_REASONS = [
  'protocol-shuffle',
  'road-wrap',
  'manual-confirm',
] as const;

export type VerifiedPhysicalShoeReason = (typeof VERIFIED_PHYSICAL_SHOE_REASONS)[number];

const ROAD_WRAP_MAX = 8;
const ROAD_WRAP_MIN_PREVIOUS = 10;
const ROAD_WRAP_MIN_DROP = 8;
const EARLY_SHOE_ROAD_MAX = 20;
const DEEP_SHOE_HAND_MIN = 45;
/** Recent BG cuts land around 127-165 remaining. Above this is not a cut. */
const PREMATURE_RESET_REMAINING_MIN = 180;
const UNDEALABLE_REMAINING = 26;

/**
 * HISTORY/DOM sometimes stays at 局 1-8 while protocol has already tracked
 * a full mid/late shoe. That shape matches a road wrap, but if this shoeId
 * was not actually reset, the tracked remaining cards are the truth.
 */
export function isWrapShapedRoadCount(handNumber: number, gameCount: number): boolean {
  return Number.isInteger(handNumber)
    && Number.isInteger(gameCount)
    && handNumber >= ROAD_WRAP_MIN_PREVIOUS
    && gameCount >= 1
    && gameCount <= ROAD_WRAP_MAX
    && handNumber - gameCount >= ROAD_WRAP_MIN_DROP;
}

/**
 * A live physical shoe that still has a mid/late inventory must not be
 * replaced by a protocol-shuffle pulse. Typical cut is 127-165 remaining.
 * Road wrap to #1-#8 is allowed even with high remaining.
 * Missed shuffle: bead plate still 局 9-20 while this shoeId already played
 * 45+ hands. Wrap-shaped 1-8 is not this.
 */
export function isPrematurePhysicalShoeReset(
  projection: Pick<
    ShoeStateProjection,
    'shoeBaseline' | 'seenCards' | 'remainingTotal' | 'handNumber' | 'sealed'
  >,
): boolean {
  if (projection.shoeBaseline !== 'physical-shoe') return false;
  if (projection.sealed) return false;
  if (projection.seenCards.length === 0) return false;
  if (projection.handNumber < ROAD_WRAP_MIN_PREVIOUS) return false;
  if (projection.handNumber >= DEEP_SHOE_HAND_MIN) return false;
  if (projection.remainingTotal < UNDEALABLE_REMAINING) return false;
  return projection.remainingTotal > PREMATURE_RESET_REMAINING_MIN;
}

export function isMissedShuffleRoadCount(handNumber: number, gameCount: number): boolean {
  return Number.isInteger(handNumber)
    && Number.isInteger(gameCount)
    && handNumber >= DEEP_SHOE_HAND_MIN
    && gameCount > ROAD_WRAP_MAX
    && gameCount <= EARLY_SHOE_ROAD_MAX
    && handNumber - gameCount >= ROAD_WRAP_MIN_DROP;
}

export function isVerifiedPhysicalShoeReason(
  reason: string | undefined,
): reason is VerifiedPhysicalShoeReason {
  return reason === 'protocol-shuffle' || reason === 'road-wrap' || reason === 'manual-confirm';
}

export function isVerifiedPhysicalShoeEvidence(
  evidence?: Pick<ShoeBaselineEvidence, 'reason' | 'gameCount'>,
): boolean {
  if (evidence?.reason === 'protocol-shuffle' || evidence?.reason === 'manual-confirm') return true;
  return evidence?.reason === 'road-wrap'
    && typeof evidence.gameCount === 'number'
    && evidence.gameCount >= 1
    && evidence.gameCount <= ROAD_WRAP_MAX;
}

export function shoeBaselineReasonLabel(evidence: ShoeBaselineEvidence): string {
  switch (evidence.reason) {
    case 'attach':
      return '入桌，未见洗牌';
    case 'protocol-shuffle':
      return '协议洗牌';
    case 'road-wrap':
      return evidence.previousGameCount !== undefined && evidence.gameCount !== undefined
        ? `路子 ${evidence.previousGameCount}→${evidence.gameCount}`
        : '路子回绕';
    case 'manual-confirm':
      return '人工确认';
    case 'inventory-contradiction':
      return '剩余张数与路子矛盾';
    case 'restart-empty-inventory':
      return '路子已深但未见牌面';
  }
}

/**
 * Display and auto-bet must not trust a physical-shoe label when inventory
 * cannot be true. DOM road count is used only for restart/old-ledger recovery,
 * never to fight a just-shuffled shoe that still has few tracked hands.
 */
export function isPhysicalShoeExecutable(
  projection: Pick<
    ShoeStateProjection,
    'shoeBaseline' | 'seenCards' | 'handNumber' | 'remainingTotal' | 'profileSnapshot' | 'sealed'
  >,
  gameCount?: number,
  parserEvidence?: ShoeBaselineEvidence,
): boolean {
  return effectiveShoeBaseline(projection, gameCount, parserEvidence) === 'physical-shoe'
    && projection.shoeBaseline === 'physical-shoe'
    && !projection.sealed
    && projection.remainingTotal >= UNDEALABLE_REMAINING;
}

export function effectiveShoeBaseline(
  projection: Pick<
    ShoeStateProjection,
    'shoeBaseline' | 'seenCards' | 'handNumber' | 'remainingTotal' | 'profileSnapshot'
  >,
  gameCount?: number,
  parserEvidence?: ShoeBaselineEvidence,
): ShoeBaseline {
  return explainShoeBaseline(projection, gameCount, parserEvidence).baseline;
}

export function explainShoeBaseline(
  projection: Pick<
    ShoeStateProjection,
    'shoeBaseline' | 'seenCards' | 'handNumber' | 'remainingTotal' | 'profileSnapshot'
  >,
  gameCount?: number,
  parserEvidence?: ShoeBaselineEvidence,
): { readonly baseline: ShoeBaseline; readonly evidence: ShoeBaselineEvidence } {
  const verified = isVerifiedPhysicalShoeEvidence(parserEvidence);
  const initial = initialShoeTotal(projection.profileSnapshot.numberOfDecks);
  const deepUnseenRoad = projection.seenCards.length < 8
    && projection.handNumber < 8
    && projection.remainingTotal >= initial - 16
    && typeof gameCount === 'number'
    && gameCount >= 8;
  // Lagged DOM road must not hide a just-shuffled physical shoe. Only demote
  // when this process has no verified shuffle evidence (restart/attach).
  if (deepUnseenRoad && !verified) {
    return {
      baseline: 'unknown-monitor-session',
      evidence: { reason: 'restart-empty-inventory', gameCount },
    };
  }
  if (projection.shoeBaseline !== 'physical-shoe') {
    if (verified && parserEvidence !== undefined) {
      return { baseline: 'physical-shoe', evidence: parserEvidence };
    }
    return {
      baseline: 'unknown-monitor-session',
      evidence: parserEvidence?.reason === 'attach' || parserEvidence === undefined
        ? { reason: 'attach', ...(gameCount === undefined ? {} : { gameCount }) }
        : parserEvidence,
    };
  }
  if (
    projection.handNumber >= 8
    && projection.remainingTotal >= initial - projection.handNumber
  ) {
    return {
      baseline: 'unknown-monitor-session',
      evidence: {
        reason: 'inventory-contradiction',
        ...(gameCount === undefined ? {} : { gameCount }),
      },
    };
  }
  if (typeof gameCount === 'number' && gameCount >= 1) {
    if (isMissedShuffleRoadCount(projection.handNumber, gameCount)) {
      return {
        baseline: 'unknown-monitor-session',
        evidence: { reason: 'inventory-contradiction', gameCount },
      };
    }
    // Parser should have opened a road-wrap. If it missed, do not advertise
    // late-shoe pair EV on mixed inventory (B17 EV 0.91).
    if (
      isWrapShapedRoadCount(projection.handNumber, gameCount)
      && projection.remainingTotal < 80
    ) {
      return {
        baseline: 'unknown-monitor-session',
        evidence: { reason: 'inventory-contradiction', gameCount },
      };
    }
    // A stuck early HISTORY road (局3) must not shrink the burn budget of a
    // 50-hand tracked shoe. Use the larger of road vs actually tracked hands.
    const handsForBudget = Math.max(gameCount, projection.handNumber);
    const minRemaining = initial - handsForBudget * 6 - 20;
    if (projection.remainingTotal < minRemaining) {
      return {
        baseline: 'unknown-monitor-session',
        evidence: { reason: 'inventory-contradiction', gameCount },
      };
    }
  }
  return {
    baseline: 'physical-shoe',
    evidence: verified && parserEvidence !== undefined
      ? parserEvidence
      : parserEvidence ?? { reason: 'attach' },
  };
}
