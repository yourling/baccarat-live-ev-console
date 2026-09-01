import type { ShoeBaseline, ShoeStateProjection } from '@baccarat/contracts';

export function initialShoeTotal(numberOfDecks: number): number {
  return numberOfDecks * 52;
}

/**
 * Display and auto-bet must not trust a physical-shoe label when inventory
 * cannot be true. DOM road count is used only for restart/old-ledger recovery,
 * never to fight a just-shuffled shoe that still has few tracked hands.
 */
export function effectiveShoeBaseline(
  projection: Pick<
    ShoeStateProjection,
    'shoeBaseline' | 'seenCards' | 'handNumber' | 'remainingTotal' | 'profileSnapshot'
  >,
  gameCount?: number,
): ShoeBaseline {
  if (projection.shoeBaseline !== 'physical-shoe') return 'unknown-monitor-session';
  const initial = initialShoeTotal(projection.profileSnapshot.numberOfDecks);
  if (
    projection.seenCards.length < 8
    && typeof gameCount === 'number'
    && gameCount >= 8
  ) {
    return 'unknown-monitor-session';
  }
  if (
    projection.handNumber >= 8
    && projection.remainingTotal >= initial - projection.handNumber
  ) {
    return 'unknown-monitor-session';
  }
  return 'physical-shoe';
}
