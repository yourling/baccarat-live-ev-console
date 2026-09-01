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
      return '跟踪手数与库存矛盾';
    case 'restart-empty-inventory':
      return '路子已深但未见牌面';
  }
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
  return explainShoeBaseline(projection, gameCount).baseline;
}

export function explainShoeBaseline(
  projection: Pick<
    ShoeStateProjection,
    'shoeBaseline' | 'seenCards' | 'handNumber' | 'remainingTotal' | 'profileSnapshot'
  >,
  gameCount?: number,
  parserEvidence?: ShoeBaselineEvidence,
): { readonly baseline: ShoeBaseline; readonly evidence: ShoeBaselineEvidence } {
  if (projection.shoeBaseline !== 'physical-shoe') {
    return {
      baseline: 'unknown-monitor-session',
      evidence: parserEvidence?.reason === 'attach' || parserEvidence === undefined
        ? { reason: 'attach', ...(gameCount === undefined ? {} : { gameCount }) }
        : parserEvidence,
    };
  }
  const initial = initialShoeTotal(projection.profileSnapshot.numberOfDecks);
  if (
    projection.seenCards.length < 8
    && typeof gameCount === 'number'
    && gameCount >= 8
  ) {
    return {
      baseline: 'unknown-monitor-session',
      evidence: { reason: 'restart-empty-inventory', gameCount },
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
  return {
    baseline: 'physical-shoe',
    evidence: parserEvidence ?? { reason: 'protocol-shuffle' },
  };
}
