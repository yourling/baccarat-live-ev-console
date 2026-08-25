import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@baccarat/contracts';
import { MstromProtocolEventParser } from '../src/mstrom-protocol-events.js';
import { parseMstromFrame, type MstromFrame } from '../src/mstrom-protocol.js';

type RawMstromCapture = {
  readonly ts: string;
  readonly base64: string;
  readonly type: number;
  readonly len: number;
};

type ReplayResult = {
  readonly frames: readonly MstromFrame[];
  readonly events: readonly NormalizedEvent[];
};

const D056_ROUND_FILES = [
  '../../../.tmp-mstrom/rounds/D056/GD056268221BL.jsonl',
  '../../../.tmp-mstrom/rounds/D056/GD056268221BM.jsonl',
] as const;

const EXPLICIT_SHUFFLE_SNAPSHOT_BASE64 = 'AAIQFgAAADEAAedJAABOMDcyIAQoCAoDQkFDEg1HTjA3MjI2ODIxMTJNGAtAGZABAQ==';

function readCapture(line: string, source: string, lineNumber: number): RawMstromCapture {
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`invalid capture object in ${source}:${lineNumber}`);
  }

  const ts = Reflect.get(value, 'ts');
  const base64 = Reflect.get(value, 'base64');
  const type = Reflect.get(value, 'type');
  const len = Reflect.get(value, 'len');
  if (
    typeof ts !== 'string' ||
    typeof base64 !== 'string' ||
    !Number.isInteger(type) ||
    !Number.isInteger(len)
  ) {
    throw new Error(`invalid capture fields in ${source}:${lineNumber}`);
  }
  return { ts, base64, type, len };
}

function readReplayFile(relativePath: string): readonly RawMstromCapture[] {
  const source = new URL(relativePath, import.meta.url).pathname;
  const content = readFileSync(new URL(relativePath, import.meta.url), 'utf8').trim();
  if (content.length === 0) throw new Error(`empty replay fixture: ${source}`);
  return content.split(/\r?\n/).map((line, index) => readCapture(line, source, index + 1));
}

function replay(files: readonly string[]): ReplayResult {
  const parser = new MstromProtocolEventParser();
  const frames: MstromFrame[] = [];
  const events: NormalizedEvent[] = [];

  for (const file of files) {
    for (const capture of readReplayFile(file)) {
      const bytes = Uint8Array.from(Buffer.from(capture.base64, 'base64'));
      expect(bytes).toHaveLength(capture.len);
      const parsed = parseMstromFrame(bytes);
      if (!parsed.ok) {
        throw new Error(`failed to parse ${file} at ${capture.ts}: ${parsed.error.message}`);
      }
      expect(parsed.frame.type).toBe(capture.type);
      frames.push(parsed.frame);
      events.push(...parser.ingest(parsed.frame, capture.ts));
    }
  }

  return { frames, events };
}

describe('real mstrom shoe-boundary replays', () => {
  it('replays D056 BL and BM as ordinary rounds without a physical-shoe signal', () => {
    const result = replay(D056_ROUND_FILES);
    const shoeSignals = result.events.filter(event => event.type === 'newShoeSignal');

    expect(result.frames).toHaveLength(45);
    expect(result.frames.every(frame => frame.tableId === 'D056')).toBe(true);
    expect(result.frames.some(frame => frame.kind === 'type3')).toBe(true);
    const type3Frames = result.frames.filter(frame => frame.kind === 'type3');
    expect(type3Frames.some(frame => frame.status.statusLength === 20 && frame.status.markets.length === 0))
      .toBe(true);
    expect(type3Frames.some((frame, index) => {
      const previous = type3Frames[index - 1];
      return previous !== undefined
        && previous.status.counterA !== undefined
        && frame.status.counterA !== undefined
        && previous.status.counterA - frame.status.counterA > 32;
    })).toBe(true);
    expect(type3Frames.some((frame, index) => (
      frame.status.statusLength === 20
      && type3Frames[index + 1]?.status.statusLength === 20
    ))).toBe(true);
    expect(shoeSignals.map(event => event.baseline)).toEqual(['unknown-monitor-session']);
    expect(shoeSignals.filter(event => event.baseline === 'physical-shoe')).toHaveLength(0);
    expect(result.events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(4);
    expect(result.events.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(4);
  });

  it('emits one physical-shoe signal for the real gmstatus=11 frame and deduplicates the boundary', () => {
    const parsed = parseMstromFrame(
      Uint8Array.from(Buffer.from(EXPLICIT_SHUFFLE_SNAPSHOT_BASE64, 'base64')),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.kind).toBe('type2');
    if (parsed.frame.kind !== 'type2') return;

    expect({
      tableId: parsed.frame.tableId,
      x16: parsed.frame.x16,
      roundId: parsed.frame.roundId,
      gameStatus: parsed.frame.gameStatus,
    }).toEqual({
      tableId: 'N072',
      x16: 0x1016,
      roundId: 'GN0722682112M',
      gameStatus: 11,
    });

    const parser = new MstromProtocolEventParser();
    const first = parser.ingest(parsed.frame, '2026-08-23T13:05:00.000Z');
    const duplicate = parser.ingest(parsed.frame, '2026-08-23T13:05:01.000Z');
    const firstPhysicalSignals = first.filter(
      event => event.type === 'newShoeSignal' && event.baseline === 'physical-shoe',
    );
    const duplicatePhysicalSignals = duplicate.filter(
      event => event.type === 'newShoeSignal' && event.baseline === 'physical-shoe',
    );

    expect(firstPhysicalSignals).toHaveLength(1);
    expect(firstPhysicalSignals[0]).toEqual(expect.objectContaining({
      type: 'newShoeSignal',
      tableId: 'N072',
      baseline: 'physical-shoe',
    }));
    expect(duplicate).toEqual([]);
    expect(duplicatePhysicalSignals).toHaveLength(0);
  });
});
