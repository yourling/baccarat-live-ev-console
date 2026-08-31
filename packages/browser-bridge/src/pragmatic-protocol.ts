import type { PragmaticRuntimeSnapshot, PragmaticTableSnapshot } from './pragmatic-runtime.js';

interface RoundCards {
  playerCards: string[];
  bankerCards: string[];
  seenKeys: Set<string>;
  gameSettled?: boolean;
  closed?: boolean;
}

interface ProtocolTableState {
  tableId: string;
  roundId?: string;
  bettingOpen?: boolean;
  countdown?: number;
  lastSeq: number;
  lastCardSeq: number;
  previousRoundIds: string[];
  rounds: Map<string, RoundCards>;
  shoeReset?: string;
}

interface FinishedShuffle {
  tableId: string;
  token: string;
  seq: number;
}

const TABLE_ID_PATTERN = /^[a-z0-9]{4,32}$/i;
const ROUND_ID_PATTERN = /^[a-z0-9-]{1,64}$/i;
const CARD_CODE_PATTERN = /^(10|[2-9AJQK]|[01])([SHDC])([0-8])?$/i;
const KIND_ORDER = [
  'game',
  'betsopen',
  'timer',
  'betsclosingsoon',
  'betsclosed',
  'startDealing',
  'card',
  'cardinc',
  'gameresult',
  'startshuffling',
  'endshuffling',
  'currentShoe',
] as const;

export const PRAGMATIC_KNOWN_KINDS = KIND_ORDER;

type ProtocolKind = typeof KIND_ORDER[number];
const KNOWN_KIND_SET = new Set<string>(KIND_ORDER);
const CARDISH_KEY = /(?:^|_)(?:sc|place|card|cards|playerCards|bankerCards|luckyCards|cardCount|pc|bc)(?:_|$)|card/i;
const NOT_CARDISH_KEY = /smallhand|bighand|discard|scorecard/i;

function scalarString(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  return pattern.test(text) ? text : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function normalizeRank(token: string): string {
  const rank = token.toUpperCase();
  if (rank === '0') return '10';
  if (rank === '1') return 'A';
  return rank;
}

function cardToken(value: unknown): string | undefined {
  const match = typeof value === 'string' ? CARD_CODE_PATTERN.exec(value.trim()) : null;
  if (!match) return undefined;
  return `${normalizeRank(match[1]!)}${match[2]!.toUpperCase()}${match[3] ?? ''}`;
}

function cardsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      const card = cardToken(item);
      return card === undefined ? [] : [card];
    });
  }
  if (typeof value !== 'string') return [];
  return value.split(/[,\s|]+/).flatMap(item => {
    const card = cardToken(item);
    return card === undefined ? [] : [card];
  });
}

function roundCards(state: ProtocolTableState, roundId: string): RoundCards {
  const existing = state.rounds.get(roundId);
  if (existing) return existing;
  const created: RoundCards = { playerCards: [], bankerCards: [], seenKeys: new Set<string>() };
  state.rounds.set(roundId, created);
  if (state.rounds.size > 8) {
    const oldest = state.rounds.keys().next().value;
    if (oldest !== undefined && oldest !== roundId) state.rounds.delete(oldest);
  }
  return created;
}

function addCard(cards: string[], card: string): boolean {
  if (cards.length >= 3) return false;
  cards.push(card);
  return true;
}

export function pragmaticProtocolTableId(raw: string): string | undefined {
  const frames = protocolFrames(raw);
  for (const frame of frames) {
    const tableId = scalarString(frame.record.table ?? frame.record.tableId, TABLE_ID_PATTERN);
    if (tableId !== undefined) return tableId;
  }
  return undefined;
}

const SECRET_KEY = /token|auth|cookie|balance|session|passwd|secret|uId|^ck$/i;

function summarizeGameresultValue(key: string, value: unknown, depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '<redacted>';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item, index) => summarizeGameresultValue(String(index), item, depth + 1));
  }
  if (typeof value === 'object' && depth < 3) {
    const record = value as Record<string, unknown>;
    return {
      keys: Object.keys(record),
      ...Object.fromEntries(
        Object.entries(record).slice(0, 40).map(([nestedKey, nestedValue]) => [
          nestedKey,
          summarizeGameresultValue(nestedKey, nestedValue, depth + 1),
        ]),
      ),
    };
  }
  return typeof value;
}

function isCardishKey(key: string): boolean {
  if (NOT_CARDISH_KEY.test(key)) return false;
  return CARDISH_KEY.test(key);
}

function collectCardSignals(
  key: string,
  value: unknown,
  output: Array<Record<string, unknown>>,
  depth = 0,
): void {
  if (output.length >= 40 || depth > 4) return;
  if (isCardishKey(key)) {
    output.push({
      key,
      value: summarizeGameresultValue(key, value, Math.max(0, 2 - depth)),
    });
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.slice(0, 8).entries()) {
      collectCardSignals(String(index), item, output, depth + 1);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      collectCardSignals(nestedKey, nestedValue, output, depth + 1);
    }
  }
}

function xmlOpeningTags(raw: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const pattern = /<([A-Za-z][\w:.-]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const tag = match[1]!;
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 40) break;
  }
  return tags;
}

function xmlUnknownRecords(raw: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const pattern = /<([A-Za-z][\w:.-]*)\s+([^>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const tag = match[1]!;
    if (KNOWN_KIND_SET.has(tag) || KNOWN_KIND_SET.has(tag.toLowerCase())) continue;
    const record: Record<string, unknown> = { tag };
    for (const attribute of match[2]!.matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)) {
      record[attribute[1]!] = summarizeGameresultValue(attribute[1]!, attribute[2]);
    }
    records.push(record);
    if (records.length >= 16) break;
  }
  return records;
}

export function inspectPragmaticWsFrame(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return { format: 'empty' };
  const cardSignals: Array<Record<string, unknown>> = [];
  if (trimmed.startsWith('<')) {
    const tags = xmlOpeningTags(trimmed);
    const knownTags = tags.filter(tag => KNOWN_KIND_SET.has(tag) || KNOWN_KIND_SET.has(tag.toLowerCase()));
    const unknownTags = tags.filter(tag => !KNOWN_KIND_SET.has(tag) && !KNOWN_KIND_SET.has(tag.toLowerCase()));
    const unknownRecords = xmlUnknownRecords(trimmed);
    for (const record of unknownRecords) {
      for (const [key, value] of Object.entries(record)) collectCardSignals(key, value, cardSignals);
    }
    return {
      format: 'xml',
      tags,
      knownTags,
      unknownTags,
      unknownRecords,
      ...(cardSignals.length === 0 ? {} : { cardSignals }),
      preview: trimmed.slice(0, 500),
    };
  }
  try {
    const root = JSON.parse(trimmed) as unknown;
    if (typeof root !== 'object' || root === null) {
      return { format: 'json', note: 'non-object root', preview: trimmed.slice(0, 200) };
    }
    if (Array.isArray(root)) {
      collectCardSignals('root', root, cardSignals);
      return {
        format: 'json-array',
        length: root.length,
        firstKeys: root.slice(0, 3).flatMap(item => (
          typeof item === 'object' && item !== null && !Array.isArray(item)
            ? Object.keys(item as Record<string, unknown>).slice(0, 20)
            : []
        )),
        ...(cardSignals.length === 0 ? {} : { cardSignals }),
        preview: trimmed.slice(0, 300),
      };
    }
    const recordRoot = root as Record<string, unknown>;
    const rootKeys = Object.keys(recordRoot);
    const knownKeys = rootKeys.filter(key => KNOWN_KIND_SET.has(key));
    const unknownKeys = rootKeys.filter(key => !KNOWN_KIND_SET.has(key));
    const unknownRecords: Record<string, unknown> = {};
    for (const key of unknownKeys.slice(0, 24)) {
      unknownRecords[key] = summarizeGameresultValue(key, recordRoot[key]);
      collectCardSignals(key, recordRoot[key], cardSignals);
    }
    for (const key of knownKeys) collectCardSignals(key, recordRoot[key], cardSignals);
    const compactKnown = Object.fromEntries(knownKeys.slice(0, 12).map(key => {
      const record = recordRoot[key];
      if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        return [key, summarizeGameresultValue(key, record)];
      }
      const nested = record as Record<string, unknown>;
      return [key, {
        table: nested.table ?? nested.tableId,
        game: nested.game ?? nested.id ?? nested.gameId,
        seq: nested.seq,
        ...(nested.sc === undefined ? {} : { sc: nested.sc }),
        ...(nested.place === undefined ? {} : { place: nested.place }),
        ...(nested.value === undefined ? {} : { value: nested.value }),
      }];
    }));
    return {
      format: 'json',
      rootKeys,
      knownKeys,
      unknownKeys,
      known: compactKnown,
      ...(unknownKeys.length === 0 ? {} : { unknownRecords }),
      ...(cardSignals.length === 0 ? {} : { cardSignals }),
    };
  } catch {
    return {
      format: 'text',
      preview: trimmed.slice(0, 500),
    };
  }
}

export function inspectPragmaticGameresult(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!/gameresult/i.test(trimmed)) return undefined;
  if (trimmed.startsWith('<')) {
    const frames = protocolFrames(trimmed).filter(frame => frame.kind === 'gameresult');
    return {
      format: 'xml',
      count: frames.length,
      records: frames.map(frame => summarizeGameresultValue('gameresult', frame.record)),
      preview: trimmed.slice(0, 500),
    };
  }
  try {
    const root = JSON.parse(trimmed) as unknown;
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      return { format: 'json', note: 'non-object root', preview: trimmed.slice(0, 200) };
    }
    const recordRoot = root as Record<string, unknown>;
    const rootKeys = Object.keys(recordRoot);
    const resultKey = rootKeys.find(key => /gameresult/i.test(key));
    if (resultKey === undefined) {
      return { format: 'json', rootKeys, note: 'substring match without result object' };
    }
    return {
      format: 'json',
      rootKeys,
      resultKey,
      record: summarizeGameresultValue(resultKey, recordRoot[resultKey]),
    };
  } catch {
    return { format: 'text', preview: trimmed.slice(0, 500) };
  }
}

function protocolFrames(raw: string): Array<{ kind: ProtocolKind; record: Record<string, unknown> }> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) return xmlFrames(trimmed);
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return [];
  const recordRoot = root as Record<string, unknown>;
  return KIND_ORDER.flatMap(kind => {
    const value = recordRoot[kind];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    return [{ kind, record: value as Record<string, unknown> }];
  });
}

function xmlFrames(raw: string): Array<{ kind: ProtocolKind; record: Record<string, unknown> }> {
  const frames: Array<{ kind: ProtocolKind; record: Record<string, unknown> }> = [];
  const pattern = /<(cardinc|card|betsopen|betsclosed|betsclosingsoon|startDealing|gameresult|startshuffling|endshuffling|currentShoe|timer|game)\s+([^>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const kind = KIND_ORDER.find(candidate => candidate.toLowerCase() === match![1]!.toLowerCase());
    if (kind === undefined) continue;
    const record: Record<string, unknown> = {};
    for (const attribute of match[2]!.matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)) {
      record[attribute[1]!] = attribute[2];
    }
    frames.push({ kind, record });
  }
  return frames;
}

function snapshotOf(state: ProtocolTableState, roundId: string | undefined, observedAt: string): PragmaticRuntimeSnapshot {
  const cards = roundId === undefined
    ? { playerCards: [], bankerCards: [], seenKeys: new Set<string>() }
    : roundCards(state, roundId);
  const table: PragmaticTableSnapshot = {
    tableId: state.tableId,
    ...(roundId === undefined ? {} : { roundId }),
    ...(state.bettingOpen === undefined ? {} : { bettingOpen: state.bettingOpen }),
    ...(state.countdown === undefined ? {} : { countdown: state.countdown }),
    playerCards: cards.playerCards.slice(0, 3),
    bankerCards: cards.bankerCards.slice(0, 3),
    visible: false,
    source: 'protocol',
    ...(cards.gameSettled === true ? { gameSettled: true } : {}),
    ...(state.shoeReset === undefined ? {} : { shoeReset: state.shoeReset }),
  };
  return { version: 1, view: 'multi', observedAt, tables: [table] };
}

export class PragmaticProtocolState {
  private readonly tables = new Map<string, ProtocolTableState>();
  private readonly shufflingTables = new Map<string, string>();
  private lastFinishedShuffle?: FinishedShuffle;

  ingest(raw: string, observedAt = new Date().toISOString()): PragmaticRuntimeSnapshot | undefined {
    const frames = protocolFrames(raw);
    if (frames.length === 0) return undefined;
    const tableId = frames
      .map(frame => scalarString(frame.record.table ?? frame.record.tableId, TABLE_ID_PATTERN))
      .find(value => value !== undefined)
      ?? this.tableIdForCurrentShoe(frames);
    if (tableId === undefined) return undefined;
    const state = this.tables.get(tableId) ?? {
      tableId,
      lastSeq: -1,
      lastCardSeq: -1,
      previousRoundIds: [],
      rounds: new Map<string, RoundCards>(),
    };
    let changed = false;
    let snapshotRoundId = state.roundId;
    for (const frame of frames) {
      const applied = this.applyFrame(frame.kind, frame.record, state);
      if (!applied.changed) continue;
      changed = true;
      if (applied.snapshotRoundId !== undefined) snapshotRoundId = applied.snapshotRoundId;
    }
    this.tables.set(tableId, state);
    return changed ? snapshotOf(state, snapshotRoundId, observedAt) : undefined;
  }

  snapshot(tableId: string, observedAt = new Date().toISOString()): PragmaticRuntimeSnapshot | undefined {
    const state = this.tables.get(tableId);
    return state === undefined ? undefined : snapshotOf(state, state.roundId, observedAt);
  }

  reset(): void {
    this.tables.clear();
    this.shufflingTables.clear();
    this.lastFinishedShuffle = undefined;
  }

  private tableIdForCurrentShoe(
    frames: Array<{ kind: ProtocolKind; record: Record<string, unknown> }>,
  ): string | undefined {
    if (!frames.some(frame => frame.kind === 'currentShoe')) return undefined;
    const seq = frames
      .map(frame => finiteNumber(frame.record.seq))
      .find(value => value !== undefined);
    if (this.shufflingTables.size === 1) return this.shufflingTables.keys().next().value;
    if (this.shufflingTables.size === 0 && this.lastFinishedShuffle !== undefined) {
      if (seq === undefined || seq - this.lastFinishedShuffle.seq <= 300) {
        return this.lastFinishedShuffle.tableId;
      }
    }
    return undefined;
  }

  private beginShuffle(
    state: ProtocolTableState,
    seq: number | undefined,
  ): { changed: boolean; snapshotRoundId?: string } {
    const token = this.shufflingTables.get(state.tableId)
      ?? `protocol:${state.tableId}:${seq ?? Date.now()}`;
    this.shufflingTables.set(state.tableId, token);
    const changed = state.shoeReset !== token;
    state.shoeReset = token;
    if (changed) this.clearRoundInventory(state);
    return { changed: true, snapshotRoundId: state.roundId };
  }

  private finishShuffle(
    state: ProtocolTableState,
    seq: number | undefined,
  ): { changed: boolean; snapshotRoundId?: string } {
    const token = this.shufflingTables.get(state.tableId)
      ?? (this.lastFinishedShuffle?.tableId === state.tableId ? this.lastFinishedShuffle.token : undefined)
      ?? `protocol:${state.tableId}:${seq ?? Date.now()}`;
    this.shufflingTables.delete(state.tableId);
    this.lastFinishedShuffle = { tableId: state.tableId, token, seq: seq ?? 0 };
    const changed = state.shoeReset !== token;
    state.shoeReset = token;
    if (changed) this.clearRoundInventory(state);
    return { changed: true, snapshotRoundId: state.roundId };
  }

  private clearRoundInventory(state: ProtocolTableState): void {
    state.rounds.clear();
    state.previousRoundIds = [];
    if (state.roundId !== undefined) roundCards(state, state.roundId);
  }

  private applyFrame(
    kind: ProtocolKind,
    record: Record<string, unknown>,
    state: ProtocolTableState,
  ): { changed: boolean; snapshotRoundId?: string } {
    const seq = finiteNumber(record.seq);
    const isCard = kind === 'card' || kind === 'cardinc';
    const roundId = scalarString(record.game ?? record.id ?? record.gameId, ROUND_ID_PATTERN);
    const delayedExistingRound = roundId !== undefined
      && roundId !== state.roundId
      && (state.previousRoundIds.includes(roundId) || state.rounds.has(roundId));
    const isNewRound = roundId !== undefined && roundId !== state.roundId && !delayedExistingRound;
    const targetRound = roundId === undefined ? undefined : state.rounds.get(roundId);
    const targetClosed = targetRound?.closed === true || targetRound?.gameSettled === true;
    const targetHasCards = ((targetRound?.playerCards.length ?? 0) + (targetRound?.bankerCards.length ?? 0)) > 0;
    const windowKind = kind === 'timer' || kind === 'betsopen';
    const staleSeq = !isCard && seq !== undefined && seq <= state.lastSeq;
    const allowLowerSeqWindow = windowKind
      && !targetClosed
      && !targetHasCards
      && (isNewRound || roundId === state.roundId || (roundId === undefined && state.roundId !== undefined));

    if (staleSeq && !allowLowerSeqWindow) {
      return { changed: false };
    }
    if (!isCard && seq !== undefined && !staleSeq) state.lastSeq = seq;

    if (roundId !== undefined && roundId !== state.roundId) {
      if (isCard && delayedExistingRound) {
        const added = this.addRecordedCard(record, roundCards(state, roundId), seq, state);
        return { changed: added, snapshotRoundId: roundId };
      }
      if (!isCard && delayedExistingRound) {
        return { changed: false };
      }
      if (state.roundId !== undefined) {
        state.previousRoundIds.push(state.roundId);
        if (state.previousRoundIds.length > 8) state.previousRoundIds.shift();
      }
      state.roundId = roundId;
      state.bettingOpen = undefined;
      state.countdown = undefined;
      roundCards(state, roundId);
    }

    if (kind === 'game') return { changed: isNewRound, snapshotRoundId: state.roundId };
    if (kind === 'timer') {
      const countdown = finiteNumber(record.value);
      const previous = state.countdown;
      state.countdown = countdown;
      let changed = previous === undefined && countdown !== undefined;
      if (countdown === 0) {
        if (state.bettingOpen !== false) changed = true;
        state.bettingOpen = false;
        if (state.roundId !== undefined) roundCards(state, state.roundId).closed = true;
      }
      return { changed, snapshotRoundId: state.roundId };
    }
    if (kind === 'betsopen') {
      state.bettingOpen = true;
      return { changed: true, snapshotRoundId: state.roundId };
    }
    if (kind === 'betsclosingsoon') return { changed: false };
    if (kind === 'betsclosed' || kind === 'startDealing') {
      state.bettingOpen = false;
      if (state.roundId !== undefined) roundCards(state, state.roundId).closed = true;
      return { changed: true, snapshotRoundId: state.roundId };
    }
    if (kind === 'gameresult') {
      state.bettingOpen = false;
      const currentId = roundId ?? state.roundId;
      if (currentId !== undefined) {
        const cards = roundCards(state, currentId);
        cards.gameSettled = true;
        cards.closed = true;
        const player = cardsFromValue(record.playerCards ?? record.player ?? record.pc);
        const banker = cardsFromValue(record.bankerCards ?? record.banker ?? record.bc);
        if (player.length > cards.playerCards.length) cards.playerCards = player;
        if (banker.length > cards.bankerCards.length) cards.bankerCards = banker;
        return { changed: true, snapshotRoundId: currentId };
      }
      return { changed: true, snapshotRoundId: state.roundId };
    }
    if (kind === 'startshuffling') {
      return this.beginShuffle(state, seq);
    }
    if (kind === 'endshuffling') {
      return this.finishShuffle(state, seq);
    }
    if (kind === 'currentShoe') {
      if (!isTruthyFlag(record.changeShoe)) return { changed: false };
      const activeToken = this.shufflingTables.get(state.tableId);
      if (activeToken !== undefined) {
        state.shoeReset = activeToken;
        return { changed: true, snapshotRoundId: state.roundId };
      }
      if (this.lastFinishedShuffle?.tableId === state.tableId) {
        state.shoeReset = this.lastFinishedShuffle.token;
        return { changed: true, snapshotRoundId: state.roundId };
      }
      return this.finishShuffle(state, seq);
    }
    if (!isCard) return { changed: false };
    const currentId = roundId ?? state.roundId;
    if (currentId === undefined) return { changed: false };
    const added = this.addRecordedCard(record, roundCards(state, currentId), seq, state);
    return { changed: added, snapshotRoundId: currentId };
  }

  private addRecordedCard(
    record: Record<string, unknown>,
    cards: RoundCards,
    seq: number | undefined,
    state: ProtocolTableState,
  ): boolean {
    const token = cardToken(record.sc) ?? cardToken(record.value);
    const place = scalarString(record.place, /^(?:player|banker)$/i)?.toLowerCase();
    if (token === undefined || place === undefined) return false;
    const key = `${place}:${token}`;
    if (cards.seenKeys.has(key)) return false;
    const side = place === 'player' ? cards.playerCards : cards.bankerCards;
    const added = addCard(side, token);
    if (!added) return false;
    cards.seenKeys.add(key);
    if (seq !== undefined && seq > state.lastCardSeq) state.lastCardSeq = seq;
    return true;
  }
}
