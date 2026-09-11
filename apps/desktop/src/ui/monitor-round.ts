import type { ShoeStateProjection } from '@baccarat/contracts';

const BG_TABLE_ID = /^[A-Z]\d{2}$/i;
const WINFINITY_STREAM_ID = /^[a-z0-9]+-bac\d+$/i;
const WINFINITY_FALLBACK_ID = /^wnf-[a-f0-9]{24}$/i;
const ROAD_WRAP_MAX = 8;
const ROAD_WRAP_MIN_PREVIOUS = 10;
const ROAD_WRAP_MIN_DROP = 8;
const EARLY_SHOE_ROAD_MAX = 20;
const DEEP_SHOE_HAND_MIN = 45;

export function isBgMonitorTableId(tableId: string): boolean {
  return BG_TABLE_ID.test(tableId.trim());
}

export function isWinfinityMonitorTableId(tableId: string): boolean {
  const trimmed = tableId.trim();
  return WINFINITY_STREAM_ID.test(trimmed) || WINFINITY_FALLBACK_ID.test(trimmed);
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
function trackedRoundNote(handNumber: number, displayed: number | undefined): string | undefined {
  if (displayed === undefined || handNumber < 1) return undefined;
  if (Math.abs(displayed - handNumber) < 2) return undefined;
  return `已跟 ${handNumber}`;
}

function laggedWinfinityRoad(handNumber: number, road: number): boolean {
  return road - handNumber >= 8;
}

export function isVerifiedPhysicalShoeReason(reason: string | undefined, gameCount?: number): boolean {
  if (reason === 'protocol-shuffle' || reason === 'manual-confirm') return true;
  return reason === 'road-wrap' && typeof gameCount === 'number' && gameCount >= 1 && gameCount <= ROAD_WRAP_MAX;
}

/**
 * Remaining / pair EV follow a physical shoe only when inventory can be the
 * same shoe the platform is showing. Winfinity tile `#N` is the felt: a wrap
 * to 局 1-8 against a deep tracked shoe is a new shoe, not lagged HISTORY.
 */
export function isDisplayedPhysicalShoe(
  tableId: string,
  projection: Pick<
    ShoeStateProjection,
    'handNumber' | 'seenCards' | 'remainingTotal' | 'shoeId' | 'shoeBaseline' | 'profileSnapshot'
  >,
  evidence?: { readonly reason?: string; readonly gameCount?: number },
  gameCount?: number,
): boolean {
  const road = gameCount ?? evidence?.gameCount;
  const initial = projection.profileSnapshot.numberOfDecks * 52;
  if (
    typeof road === 'number'
    && road >= 8
    && projection.handNumber < 8
    && projection.seenCards.length < 8
    && projection.remainingTotal >= initial - 16
    && !isVerifiedPhysicalShoeReason(evidence?.reason, evidence?.gameCount)
  ) {
    return false;
  }
  if (typeof road === 'number' && isMissedShuffleRoadCount(projection.handNumber, road)) {
    return false;
  }
  if (
    isWinfinityMonitorTableId(tableId)
    && typeof road === 'number'
    && isWrapShapedRoadCount(projection.handNumber, road)
  ) {
    return false;
  }
  if (projection.remainingTotal < 26) return false;
  return projection.shoeId.length > 0
    && projection.shoeBaseline === 'physical-shoe'
    && (evidence === undefined
      || evidence.reason === 'attach'
      || isVerifiedPhysicalShoeReason(evidence.reason, evidence.gameCount));
}

export function monitorDisplayedRoundLabel(
  tableId: string,
  projection: Pick<ShoeStateProjection, 'currentHandId' | 'handNumber'> & { readonly status?: ShoeStateProjection['status'] },
  metadata?: { readonly roundId?: string; readonly gameCount?: number },
  evidenceReason?: string,
  inventoryKnown = false,
): {
  readonly label: string;
  readonly title: string;
  readonly pageRound?: number;
  readonly trackedLabel?: string;
} {
  const protocolRound = projection.currentHandId || metadata?.roundId || '';
  if (
    (isBgMonitorTableId(tableId) || isWinfinityMonitorTableId(tableId))
    && projection.handNumber < 1
    && (projection.status === 'WAITING_NEW_SHOE'
      || evidenceReason === 'protocol-shuffle'
      || evidenceReason === 'road-wrap')
  ) {
    const road = metadata?.gameCount;
    if (typeof road !== 'number' || road > ROAD_WRAP_MAX) {
      return { label: '新靴', title: '洗牌 / 新靴', pageRound: undefined };
    }
  }
  if (isWinfinityMonitorTableId(tableId)) {
    const road = metadata?.gameCount;
    const hasRoad = typeof road === 'number' && road >= 1 && road <= 80;
    if (hasRoad) {
      // A just-shuffled physical shoe still showing the previous tile # is lag.
      // Wrap-shaped `#8` on a deep shoe is the platform: keep that 局号.
      if (inventoryKnown && laggedWinfinityRoad(projection.handNumber, road)) {
        if (projection.handNumber < 1) {
          return { label: '新靴', title: '洗牌 / 新靴', pageRound: undefined };
        }
        return {
          label: String(projection.handNumber),
          title: [
            `本靴第 ${projection.handNumber} 局`,
            protocolRound ? `协议 ${protocolRound}` : undefined,
          ].filter(Boolean).join(' · '),
          pageRound: projection.handNumber,
        };
      }
      const trackedLabel = inventoryKnown
        ? undefined
        : trackedRoundNote(projection.handNumber, road);
      return {
        label: String(road),
        title: [
          `本靴第 ${road} 局`,
          trackedLabel,
          protocolRound ? `协议 ${protocolRound}` : undefined,
        ].filter(Boolean).join(' · '),
        pageRound: road,
        ...(trackedLabel === undefined ? {} : { trackedLabel }),
      };
    }
    if (projection.handNumber >= 1) {
      return {
        label: String(projection.handNumber),
        title: protocolRound ? `本靴第 ${projection.handNumber} 局 · 协议 ${protocolRound}` : `本靴第 ${projection.handNumber} 局`,
        pageRound: projection.handNumber,
      };
    }
    return {
      label: '等待局号',
      title: protocolRound ? `等待局号 · 协议 ${protocolRound}` : '等待局号',
      pageRound: undefined,
    };
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
