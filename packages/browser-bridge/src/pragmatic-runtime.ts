import {
  type NormalizedEvent,
} from '@baccarat/contracts';
import { PRAGMATIC_PLATFORM_ID } from '@baccarat/adapter-contract';
import {
  MAX_BACCARAT_SHOE_HANDS,
  ROAD_WRAP_MAX,
  SnapshotRuntimeParserBase,
  isIdleDealtShoeShuffle,
  isRoadWrapToNewShoe,
  mergeHandCards,
  parseCards,
  type SnapshotSource,
} from './runtime-common.js';

export { isIdleDealtShoeShuffle, isRoadWrapToNewShoe } from './runtime-common.js';
export type { ParserShoeEvidence, ParserShoeReason } from './runtime-common.js';

export interface PragmaticTableSnapshot {
  readonly tableId: string;
  readonly displayName?: string;
  readonly roundId?: string;
  readonly gameCount?: number;
  readonly bettingOpen?: boolean;
  readonly countdown?: number;
  readonly playerCards?: readonly string[];
  readonly bankerCards?: readonly string[];
  readonly visible?: boolean;
  readonly minBet?: number;
  readonly shoeReset?: string;
  readonly shuffleEvent?: boolean;
  readonly source?: 'dom' | 'protocol';
  readonly gameSettled?: boolean;
}

export interface PragmaticRuntimeSnapshot {
  readonly version: 1;
  readonly view: 'single' | 'multi';
  readonly observedAt: string;
  readonly tables: readonly PragmaticTableSnapshot[];
}

/**
 * Countdown is not parsed as gameCount. A deep-road drop to an early count
 * is a new shoe; open it on the first observation.
 */
const GAME_COUNT_ANOMALY_MIN_HANDS = 8;
const GAME_COUNT_ANOMALY_MIN_GAP = 8;

export function isJoinableNewShoeRoadCount(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return isRoadWrapToNewShoe(previous, gameCount);
}

function isPhysicalShoeFromRoadCount(
  previous: number | undefined,
  gameCount: number,
): boolean {
  return isRoadWrapToNewShoe(previous, gameCount);
}

export function isPlausibleGameCountAdvance(
  previous: number | undefined,
  gameCount: number,
): boolean {
  if (!Number.isInteger(gameCount) || gameCount < 1) return false;
  if (previous === undefined) return true;
  if (gameCount === previous) return true;
  if (gameCount > previous && gameCount - previous <= 5) return true;
  if (previous <= 8 && gameCount < previous) return true;
  return isRoadWrapToNewShoe(previous, gameCount);
}

export function selectStableGameCount(
  previous: number | undefined,
  incoming: number,
): number | undefined {
  if (!Number.isInteger(incoming) || incoming < 1) return previous;
  return isPlausibleGameCountAdvance(previous, incoming) ? incoming : previous;
}

export function selectObservedGameCount(
  evidenceReason: string | undefined,
  accepted: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined) return accepted;
  if (evidenceReason === 'protocol-shuffle' && accepted === undefined && incoming > ROAD_WRAP_MAX) {
    return undefined;
  }
  return selectStableGameCount(accepted, incoming);
}

/**
 * Internal handNumber is how many hands this shoeId has seen.
 * DOM road is what the table shows. A wrap is a new shoe, not an anomaly.
 * A lagged high road right after protocol-shuffle is also not an anomaly.
 * Once we have tracked a real shoe, a large mismatch means inventory/identity
 * cannot be trusted: drop the table and wait for the next physical shoe.
 */
export function isInternalExternalGameCountAnomaly(
  handNumber: number,
  roadCount: number | undefined,
  evidenceReason?: string,
): boolean {
  if (!Number.isInteger(handNumber) || handNumber < GAME_COUNT_ANOMALY_MIN_HANDS) return false;
  if (!Number.isInteger(roadCount) || (roadCount ?? 0) < 1) return false;
  const road = roadCount!;
  if (isRoadWrapToNewShoe(handNumber, road)) return false;
  // A just-shuffled shoe has no stable road yet. NEXT_SHOES may stamp 1
  // while HISTORY/replay still carries the previous shoe, or the new shoe
  // is still short. Kicking the table out here drops it before the first
  // post-shuffle START_BET, so it never re-joins on the new shoe.
  if (evidenceReason === 'protocol-shuffle' && (handNumber <= ROAD_WRAP_MAX || road <= ROAD_WRAP_MAX)) {
    return false;
  }
  return Math.abs(road - handNumber) >= GAME_COUNT_ANOMALY_MIN_GAP;
}

function validSnapshot(value: unknown): value is PragmaticRuntimeSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PragmaticRuntimeSnapshot>;
  return candidate.version === 1
    && (candidate.view === 'single' || candidate.view === 'multi')
    && typeof candidate.observedAt === 'string'
    && Array.isArray(candidate.tables);
}

/**
 * Protocol frames omit gameCount. DOM snapshots carry the road #, but their
 * round/card fields are unsafe to ingest on multibaccarat. Keep only tableId
 * and gameCount so a missed shuffle can still open a physical shoe.
 */
export function pragmaticGameCountSnapshot(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const snapshot = parsed as Partial<PragmaticRuntimeSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.tables)) return undefined;
  const tables: Array<{ tableId: string; gameCount: number }> = [];
  for (const table of snapshot.tables) {
    if (!table || typeof table.tableId !== 'string' || table.tableId.length === 0) continue;
    if (!Number.isInteger(table.gameCount) || (table.gameCount ?? 0) < 1) continue;
    tables.push({ tableId: table.tableId, gameCount: table.gameCount! });
  }
  if (tables.length === 0) return undefined;
  return JSON.stringify({
    version: 1,
    view: snapshot.view === 'single' ? 'single' : 'multi',
    observedAt: typeof snapshot.observedAt === 'string' ? snapshot.observedAt : new Date().toISOString(),
    tables,
  });
}

export class PragmaticRuntimeParser extends SnapshotRuntimeParserBase {
  constructor() {
    super({
      platformId: PRAGMATIC_PLATFORM_ID,
      eventIdPrefix: 'pragmatic',
      eventSourceName: 'pragmatic-runtime',
      shoeIdPrefix: 'pragmatic',
    });
  }

  protected clearPlatformState(_tableId: string): void {
    // Pragmatic keeps no extra per-table state beyond the shared base.
  }

  protected clearPlatformShoeState(_tableId: string): void {
    // Pragmatic keeps no extra per-shoe state beyond the shared base.
  }

  parse(raw: string, isSelected: (tableId: string) => boolean = () => true): NormalizedEvent[] {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!validSnapshot(snapshot)) return [];

    const events: NormalizedEvent[] = [];
    for (const table of snapshot.tables) {
      if (!table || typeof table.tableId !== 'string' || table.tableId.length === 0) continue;
      if (!isSelected(table.tableId)) continue;
      // FIX(C-P2-5): 逐桌隔离 —— 单桌解析异常不能连累同帧其他健康桌。
      // 修复前 `parse()` 没有 try/catch，一张脏牌抛 TypeError 会让**整帧 3 桌**的
      // 数据全部丢失且静默无日志（b10c 实证）。
      const tableEvents: NormalizedEvent[] = [];
      try {
        this.ingestTable(table, snapshot.observedAt, tableEvents);
      } catch (error) {
        this.noteRejectedTable(table.tableId);
        console.error(
          `[bridge-parse] pragmatic table ${table.tableId}: ${error instanceof Error ? error.name : 'error'} — table dropped, other tables continue`,
        );
        continue;
      }
      events.push(...tableEvents);
    }
    return events;
  }

  observedTableIds(raw: string): string[] {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!validSnapshot(snapshot)) return [];
    return snapshot.tables
      .map(table => table && typeof table.tableId === 'string' ? table.tableId : '')
      .filter(tableId => tableId.length > 0);
  }

  private ingestTable(
    table: PragmaticTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    const tableId = table.tableId;
    const idleShuffle = isIdleDealtShoeShuffle(
      this.currentHandsThisShoe(tableId),
      this.lastHandAtMs(tableId),
      Date.parse(observedAt),
    );
    this.ingestShoeReset(table, observedAt, events);
    if (
      idleShuffle
      && !events.some(event =>
        event.tableId === tableId
        && event.type === 'newShoeSignal'
        && event.baseline === 'physical-shoe')
    ) {
      this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
      this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
    }

    if (Number.isInteger(table.gameCount) && (table.gameCount ?? 0) >= 1) {
      const previous = this.acceptedGameCount(tableId);
      const gameCount = table.gameCount!;
      const stalePreviousShoeRoad = this.currentEvidenceReason(tableId) === 'protocol-shuffle'
        && previous === undefined
        && gameCount > ROAD_WRAP_MAX;
      if (stalePreviousShoeRoad) {
        // Protocol shuffle and lagged DOM still carry the previous shoe's road #.
      } else if (isPhysicalShoeFromRoadCount(previous, gameCount)) {
        this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
        this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', {
          reason: 'road-wrap',
          previousGameCount: previous,
          gameCount,
        });
        this.setAcceptedGameCount(tableId, gameCount);
      } else if (isPlausibleGameCountAdvance(previous, gameCount)) {
        this.setAcceptedGameCount(tableId, gameCount);
      }
    }

    const handId = typeof table.roundId === 'string' ? table.roundId.trim() : '';
    if (!handId || handId === '—') return;
    if (this.handSettledAlready(tableId, handId)) return;

    this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);

    const source: SnapshotSource | undefined =
      table.source === 'protocol' || table.source === 'dom' ? table.source : undefined;
    // FIX(C-P2-5): 脏牌不再抛错，被拒数量记进 parserDiagnostics。
    const playerCards = this.parseCardsFor(tableId, table.playerCards);
    const bankerCards = this.parseCardsFor(tableId, table.bankerCards);
    const handKey = `${tableId}:${handId}`;
    const hasCardPayload = table.playerCards !== undefined || table.bankerCards !== undefined;

    if (this.handFinished(tableId, handId)) {
      if (hasCardPayload && (playerCards.length > 0 || bankerCards.length > 0)) {
        const merged = mergeHandCards(this.handCards(tableId, handId), playerCards, bankerCards, source);
        this.rememberHandCards(tableId, handId, merged);
        this.recordCards(tableId, handId, 'player', merged.playerCards, observedAt, events);
        this.recordCards(tableId, handId, 'banker', merged.bankerCards, observedAt, events);
      }
      this.settleRememberedHand(tableId, handId, observedAt, events);
      return;
    }

    const previousHandId = this.lastRoundFor(tableId);
    if (previousHandId !== undefined && previousHandId !== handId) {
      this.markHandFinished(tableId, previousHandId);
      this.closeWindows(tableId, previousHandId, observedAt, events);
      this.settleRememberedHand(tableId, previousHandId, observedAt, events);
      const nextHands = (this.currentHandsThisShoe(tableId) ?? 1) + 1;
      if (nextHands > MAX_BACCARAT_SHOE_HANDS) {
        this.beginNewShoe(tableId, observedAt, events, 'unknown-monitor-session', {
          reason: 'attach',
        });
        this.setHandsThisShoe(tableId, 1);
      } else {
        this.setHandsThisShoe(tableId, nextHands);
      }
    } else if (previousHandId === undefined) {
      this.setHandsThisShoe(tableId, 1);
    }
    this.setLastRound(tableId, handId, observedAt);

    const emptyOpenBoundary = table.bettingOpen === true
      && playerCards.length === 0
      && bankerCards.length === 0;
    if (emptyOpenBoundary) this.markCardBoundary(tableId, handId);
    const mayAcceptCards = source === 'protocol'
      || previousHandId === undefined
      || this.handHasCardBoundary(tableId, handId);
    if (mayAcceptCards && hasCardPayload && (playerCards.length > 0 || bankerCards.length > 0)) {
      const merged = mergeHandCards(this.handCards(tableId, handId), playerCards, bankerCards, source);
      this.rememberHandCards(tableId, handId, merged);
      this.recordCards(tableId, handId, 'player', merged.playerCards, observedAt, events);
      this.recordCards(tableId, handId, 'banker', merged.bankerCards, observedAt, events);
    }

    const rememberedCards = this.handCards(tableId, handId);
    const hasObservedCards = (rememberedCards?.playerCards.length ?? 0)
      + (rememberedCards?.bankerCards.length ?? 0) > 0;
    if (table.bettingOpen === true && !hasObservedCards) {
      this.openWindows(tableId, handId, table.countdown, observedAt, events);
    } else if (table.bettingOpen === false || table.gameSettled === true) {
      this.closeWindows(tableId, handId, observedAt, events);
      this.settleRememberedHand(tableId, handId, observedAt, events);
    }
  }

  private ingestShoeReset(
    table: PragmaticTableSnapshot,
    observedAt: string,
    events: NormalizedEvent[],
  ): void {
    const tableId = table.tableId;
    const token = typeof table.shoeReset === 'string' && table.shoeReset.length > 0
      ? table.shoeReset
      : undefined;
    if (token === undefined) {
      return;
    }
    const previousToken = this.lastShoeResetToken(tableId);
    if (previousToken !== token) {
      this.setLastShoeResetToken(tableId, token);
      this.ensureShoe(tableId, 'unknown-monitor-session', observedAt, events);
      // A leftover currentShoe token on first attach is not a shuffle.
      // startshuffling/endshuffling may set shuffleEvent on that first token;
      // only a later token change is protocol-shuffle.
      if (previousToken !== undefined) {
        this.beginNewShoe(tableId, observedAt, events, 'physical-shoe', { reason: 'protocol-shuffle' });
      }
      return;
    }
    // Same token + sticky shuffleEvent is leftover currentShoe, not a new shoe.
  }
}
