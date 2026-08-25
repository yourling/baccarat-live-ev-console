import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findTableKey, parseMstromFrame, type MstromParseResult } from '../src/mstrom-protocol.js';

type Fixture = {
  readonly id: string;
  readonly category: string;
  readonly table: string;
  readonly type: number;
  readonly x16: string;
  readonly seq: number;
  readonly base64: string;
  readonly notes: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFixtures(): readonly Fixture[] {
  const source = readFileSync(
    new URL('../../../.tmp-mstrom/card-research/15-fixtures.json', import.meta.url),
    'utf8',
  );
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed)) {
    throw new Error('15-fixtures.json must contain an array');
  }

  const fixtures: Fixture[] = [];
  for (const value of parsed) {
    if (!isRecord(value)) {
      throw new Error('fixture entry must be an object');
    }
    const { id, category, table, type, x16, seq, base64, notes } = value;
    if (
      typeof id !== 'string' ||
      typeof category !== 'string' ||
      typeof table !== 'string' ||
      typeof type !== 'number' ||
      typeof x16 !== 'string' ||
      typeof seq !== 'number' ||
      typeof base64 !== 'string' ||
      typeof notes !== 'string'
    ) {
      throw new Error('fixture entry has an invalid shape');
    }
    fixtures.push({ id, category, table, type, x16, seq, base64, notes });
  }
  return fixtures;
}

function bytesFromBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function fixture(id: string): Fixture {
  const value = readFixtures().find((entry) => entry.id === id);
  if (!value) {
    throw new Error(`fixture not found: ${id}`);
  }
  return value;
}

function parseFixture(id: string): Exclude<MstromParseResult, { ok: false }> {
  const value = parseMstromFrame(bytesFromBase64(fixture(id).base64));
  if (!value.ok) {
    throw new Error(`${id}: ${value.error.code}: ${value.error.message}`);
  }
  return value;
}

describe('mstrom binary frame parser', () => {

  it('accepts M-prefixed table keys used by live link-game frames', () => {
    const bytes = new Uint8Array(24);
    bytes.set([0, 2, 0x10, 0x16, 0, 0, 0, 24, 0, 0, 0, 1], 0);
    bytes.set(new TextEncoder().encode('M091'), 12);
    expect(findTableKey(bytes)?.tableId).toBe('M091');
  });
  it('parses every verified base64 fixture and validates the final header', () => {
    for (const sample of readFixtures()) {
      const bytes = bytesFromBase64(sample.base64);
      const result = parseMstromFrame(bytes);

      expect(result.ok, `${sample.id}: ${result.ok ? 'unexpected success' : result.error.message}`).toBe(true);
      if (!result.ok) continue;

      expect(result.frame.tableId).toBe(sample.table);
      expect(result.frame.type).toBe(sample.type);
      expect(result.frame.x16).toBe(Number.parseInt(sample.x16, 16));
      expect(result.frame.totalLength).toBe(bytes.length);
      expect(result.frame.seq).toBe(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false));
    }
  });

  it('extracts the type2 phase, scores, result code, game type, and round id', () => {
    const betting = parseFixture('bcst-phase1-betting-01').frame;
    expect(betting.kind).toBe('type2');
    if (betting.kind !== 'type2') return;
    expect(betting.tableId).toBe('P020');
    expect(betting.gameType).toBe('BAC');
    expect(betting.roundId).toBe('GP020268211JD');
    expect(betting.phase).toBe(1);
    expect(betting.bankerScore).toBeUndefined();
    expect(betting.playerScore).toBeUndefined();
    expect(betting.resultCode).toBeUndefined();

    const reveal = parseFixture('bcst-phase0-reveal-03').frame;
    expect(reveal.kind).toBe('type2');
    if (reveal.kind !== 'type2') return;
    expect(reveal.gameType).toBe('BAC');
    expect(reveal.roundId).toBe('GP018268211GB');
    expect(reveal.phase).toBe(0);
    expect(reveal.bankerScore).toBe(9);
    expect(reveal.playerScore).toBe(3);
    expect(reveal.resultCode).toBe(1);
    expect(reveal.resultPayload?.[0]).toBe(1);

    const road = parseFixture('road-snapshot-02').frame;
    expect(road.kind).toBe('type2');
    if (road.kind !== 'type2') return;
    expect(road.tableId).toBe('P007');
    expect(road.gameType).toBe('BAC');
    expect(road.roundId).toBeUndefined();
    expect(road.phase).toBeUndefined();
    expect(road.roadCounter).toBe(32084);
    expect(road.roadData?.length).toBeGreaterThan(0);
  });

  it('decodes GAME_SNAPSHOT_PROTO field 3 as the site game status, including explicit shuffle status 11', () => {
    const bytes = Uint8Array.from(Buffer.from(
      'AAIQFgAAADEAAedJAABOMDcyIAQoCAoDQkFDEg1HTjA3MjI2ODIxMTJNGAtAGZABAQ==',
      'base64',
    ));
    const result = parseMstromFrame(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok || result.frame.kind !== 'type2') return;

    expect(result.frame.x16).toBe(0x1016);
    expect(result.frame.tableId).toBe('N072');
    expect(result.frame.roundId).toBe('GN0722682112M');
    expect(result.frame.gameType).toBe('BAC');
    expect(result.frame.gameStatus).toBe(11);
    expect(result.frame.phase).toBe(11);
  });

  it('keeps fixed-width protobuf wire types while extracting known fields', () => {
    const payload = Uint8Array.from([
      0x0a, 0x03, 0x42, 0x41, 0x43,
      0x12, 0x0b, 0x47, 0x50, 0x30, 0x30, 0x31, 0x32, 0x36, 0x38, 0x32, 0x31, 0x41,
      0x18, 0x01,
      0x20, 0x06,
      0x28, 0x08,
      0x52, 0x01, 0x01,
      0x59, 0, 1, 2, 3, 4, 5, 6, 7,
      0x65, 0, 1, 2, 3,
    ]);
    const prefix = Uint8Array.from([0, 2, 0x10, 0x16, 0, 0, 0, 0, 1, 2, 3, 4]);
    const table = new TextEncoder().encode('P001');
    const bytes = new Uint8Array(prefix.length + table.length + payload.length);
    bytes.set(prefix, 0);
    bytes.set(table, prefix.length);
    bytes.set(payload, prefix.length + table.length);
    new DataView(bytes.buffer).setUint32(4, bytes.length, false);

    const result = parseMstromFrame(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok || result.frame.kind !== 'type2') return;
    expect(result.frame.gameType).toBe('BAC');
    expect(result.frame.roundId).toBe('GP00126821A');
    expect(result.frame.phase).toBe(1);
    expect(result.frame.bankerScore).toBe(6);
    expect(result.frame.playerScore).toBe(8);
    expect(result.frame.resultCode).toBe(1);
    expect(result.frame.fields.map((field) => field.wireType)).toEqual([2, 2, 0, 0, 0, 2, 1, 5]);
  });

  it('minimally parses type3 countdown, phase, and markets', () => {
    const empty = parseFixture('status-empty-len20-01').frame;
    expect(empty.kind).toBe('type3');
    if (empty.kind !== 'type3') return;
    expect(empty.gameType).toBe('ROU');
    expect(empty.status.countdown).toBe(20);
    expect(empty.status.phase).toBe(0);
    expect(empty.status.counterA).toBe(20);
    expect(empty.status.counterC).toBe(20);
    expect(empty.status.statusLength).toBe(20);
    expect(empty.status.markets).toEqual([]);

    const multi = parseFixture('status-multimarket-02').frame;
    expect(multi.kind).toBe('type3');
    if (multi.kind !== 'type3') return;
    expect(multi.gameType).toBe('BAC');
    expect(multi.status.countdown).toBe(67);
    expect(multi.status.phase).toBe(39);
    expect(multi.status.counterA).toBe(67);
    expect(multi.status.counterC).toBe(67);
    expect(multi.status.statusLength).toBe(80);
    expect(multi.status.markets.map((market) => market.marketId)).toEqual([1, 2, 3, 11, 19]);
    expect(multi.status.markets.map((market) => market.amount)).toEqual([
      8552.92194980415,
      230,
      30,
      1840,
      50,
    ]);
  });

  it('returns a discriminated error result for malformed input without throwing', () => {
    const valid = bytesFromBase64(fixture('bcst-phase1-betting-01').base64);
    const cases: readonly [string, Uint8Array, string][] = [
      ['short header', valid.subarray(0, 11), 'truncated-header'],
      ['length mismatch', valid.slice().map((value, index) => (index === 7 ? value - 1 : value)), 'length-mismatch'],
      ['missing table id', Uint8Array.from([...valid.subarray(0, 12), ...new Uint8Array(valid.length - 12).fill(0)]), 'table-id-not-found'],
      ['truncated protobuf', valid.subarray(0, valid.length - 1), 'length-mismatch'],
    ];

    for (const [name, bytes, code] of cases) {
      expect(() => parseMstromFrame(bytes), name).not.toThrow();
      const result = parseMstromFrame(bytes);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, name).toBe(code);
    }

    const unsupported = valid.slice();
    unsupported[0] = 0;
    unsupported[1] = 4;
    const unsupportedResult = parseMstromFrame(unsupported);
    expect(unsupportedResult.ok).toBe(false);
    if (!unsupportedResult.ok) {
      expect(unsupportedResult.error.code).toBe('unsupported-frame-type');
    }
  });
});
