import type { ShoeStateProjection } from '@baccarat/contracts';

const BG_TABLE_ID = /^[A-Z]\d{2}$/i;
const ROAD_WRAP_MAX = 8;
const ROAD_WRAP_MIN_PREVIOUS = 10;
const ROAD_WRAP_MIN_DROP = 8;
const EARLY_SHOE_ROAD_MAX = 20;
const DEEP_SHOE_HAND_MIN = 45;

export function isBgMonitorTableId(tableId: string): boolean {
  return BG_TABLE_ID.test(tableId.trim());
}

/** Keep in sync with isWrapShapedRoadCount in @baccarat/ledger-state. */
export function isWrapShapedRoadCount(handNumber: number, gameCount: number): boolean {
  return Number.isInteger(handNumber)
    && Number.isInteger(gameCount)
    && handNumber >= ROAD_WRAP_MIN_PREVIOUS
    && gameCount >= 1
    && gameCount <= ROAD_WRAP_MAX
    && handNumber - gameCount >= ROAD_WRAP_MIN_DROP;
}

/** Keep in sync with isMissedShuffleRoadCount in @baccarat/ledger-state. */
export function isMissedShuffleRoadCount(handNumber: number, gameCount: number): boolean {
  return Number.isInteger(handNumber)
    && Number.isInteger(gameCount)
    && handNumber >= DEEP_SHOE_HAND_MIN
    && gameCount > ROAD_WRAP_MAX
    && gameCount <= EARLY_SHOE_ROAD_MAX
    && handNumber - gameCount >= ROAD_WRAP_MIN_DROP;
}

export function monitorDisplayedGameCount(
  roadCount: number | undefined,
  handNumber: number,
  trustRoad = false,
): number | undefined {
  if (typeof roadCount === 'number' && roadCount >= 1 && roadCount <= 80) {
    // A just-shuffled physical shoe has 0 tracked hands. A deep road here is
    // lagged previous-shoe HISTORY / seq math, not the bead plate.
    if (trustRoad && handNumber < 1 && roadCount > 20) return undefined;
    // Stuck early HISTORY 局3 on a 50-hand tracked shoe is not a new shoe.
    if (isWrapShapedRoadCount(handNumber, roadCount)) return handNumber;
    // Deep shoe: HISTORY window stays ~21 while protocol has 50+.
    if (handNumber >= 40 && handNumber - roadCount >= 8) return handNumber;
    // HISTORY often dumps ~29 rows while the felt is 局 18. Prefer the lower
    // mid-shoe count instead of advertising the inflated packet length.
    if (
      handNumber >= 8
      && handNumber <= 40
      && roadCount >= 9
      && roadCount <= 40
      && Math.abs(roadCount - handNumber) >= 8
    ) {
      return Math.min(roadCount, handNumber);
    }
    if (!trustRoad && handNumber >= 1 && roadCount - handNumber >= 8) return handNumber;
    return roadCount;
  }
  return handNumber >= 1 ? handNumber : undefined;
}

/**
 * BG pages show the shoe road (1-80). Protocol seqNos are millions and must
 * not be used as the visible 局号. Pragmatic keeps the platform round id.
 */
export function monitorDisplayedRoundLabel(
  tableId: string,
  projection: Pick<ShoeStateProjection, 'currentHandId' | 'handNumber'> & { readonly status?: ShoeStateProjection['status'] },
  metadata?: { readonly roundId?: string; readonly gameCount?: number },
  evidenceReason?: string,
): { readonly label: string; readonly title: string; readonly pageRound?: number } {
  const protocolRound = projection.currentHandId || metadata?.roundId || '';
  if (
    isBgMonitorTableId(tableId)
    && projection.handNumber < 1
    && (projection.status === 'WAITING_NEW_SHOE'
      || evidenceReason === 'protocol-shuffle'
      || evidenceReason === 'road-wrap')
  ) {
    return { label: '新靴', title: '洗牌 / 新靴', pageRound: undefined };
  }
  const pageRound = monitorDisplayedGameCount(
    metadata?.gameCount,
    projection.handNumber,
    isBgMonitorTableId(tableId),
  );
  if (isBgMonitorTableId(tableId)) {
    if (pageRound !== undefined) {
      return {
        label: String(pageRound),
        title: protocolRound ? `本靴第 ${pageRound} 局 · 协议 ${protocolRound}` : `本靴第 ${pageRound} 局`,
        pageRound,
      };
    }
    return {
      label: '等待局号',
      title: protocolRound ? `等待局号 · 协议 ${protocolRound}` : '等待局号',
      pageRound,
    };
  }
  if (protocolRound) {
    return {
      label: protocolRound,
      title: pageRound !== undefined ? `${protocolRound} · #${pageRound}` : protocolRound,
      pageRound,
    };
  }
  return { label: '等待局号', title: '等待局号', pageRound };
}
