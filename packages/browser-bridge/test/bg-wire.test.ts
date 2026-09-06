import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const protocolSource = readFileSync(
  new URL('../../../apps/browser-extension-bg/bg-protocol.js', import.meta.url),
  'utf8',
);

function loadProtocol(extra: Record<string, unknown> = {}) {
  const context = vm.createContext({
    globalThis: {},
    TextEncoder,
    TextDecoder,
    DataView,
    Uint8Array,
    ArrayBuffer,
    Math,
    Date,
    JSON,
    Number,
    String,
    Object,
    Set,
    console,
    setTimeout,
    Promise,
    ...extra,
  });
  vm.runInContext('globalThis.globalThis = globalThis;', context);
  vm.runInContext(protocolSource, context);
  return vm.runInContext('globalThis.BaccaratBgProtocol', context) as {
    encodeHeader(command: number, action: number, size: number, ext?: number): number;
    decodeHeader(word: number): { command: number; action: number; size: number; ext: number };
    decodePackets(buffer: ArrayBuffer): Array<{ command: number; action: number; ext: number; body: DataView }>;
    snapshotsFromPacket(packet: { command: number; action: number; ext: number; body: DataView }): Array<Record<string, unknown>>;
    baccaratCards(bytes: number[]): { playerCards: string[]; bankerCards: string[] };
    betChecksum(uid: number, seqNo: number, userFlag: number, amount: number, betType: number): number;
    encodeBet(input: Record<string, unknown>): ArrayBuffer;
    encodeRequestResult(tableId: string, seqNo: number, count: number): ArrayBuffer;
    ingestBuffer(buffer: ArrayBuffer, direction: 'send' | 'recv', socket?: { readyState: number; send?: (data: ArrayBuffer) => void }): Array<Record<string, unknown>>;
    submit(input: Record<string, unknown>): Promise<{ status: string; reason?: string; seen?: unknown }>;
    parseBetConfirm(body: DataView): { state: number; userFlag: number; errorCode: number } | null;
    session: {
      uid: number;
      token: string;
      userFlag: number;
      sockets: Array<{ readyState: number }>;
      lastConfirm: unknown;
      confirmWaitMs: number;
      recentPackets: unknown[];
      hallTableIds: string[];
      watchTimer: number;
      gameSocket: { readyState: number; send?: (data: ArrayBuffer) => void } | null;
      betSocket?: { readyState: number; send?: (data: ArrayBuffer) => void } | null;
      stickyBankerLeadByTable: Record<string, string>;
    };
  };
}

function packet(command: number, action: number, ext: number, body: Uint8Array): ArrayBuffer {
  const proto = loadProtocol();
  const size = 4 + body.length;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, proto.encodeHeader(command, action, size, ext), true);
  bytes.set(body, 4);
  return bytes.buffer;
}

function hallBody(rows: Array<{ id: string; type: number; seqNo?: number; state?: number }>): Uint8Array {
  const body = new Uint8Array(176 + rows.length * 72);
  const view = new DataView(body.buffer);
  view.setUint16(80, rows.length, true);
  rows.forEach((row, index) => {
    const offset = 176 + index * 72;
    body.set(new TextEncoder().encode(row.id), offset);
    view.setUint32(offset + 4, row.type, true);
    view.setUint32(offset + 24, row.state ?? 0, true);
    view.setUint32(offset + 68, row.seqNo ?? 0, true);
  });
  return body;
}

function hallPacket(rows: Array<{ id: string; type: number; seqNo?: number; state?: number }>): ArrayBuffer {
  return packet(1, 3, 0, hallBody(rows));
}

function startBetPacket(tableId: string, seqNo = 12345): ArrayBuffer {
  const body = new Uint8Array(24);
  const view = new DataView(body.buffer);
  body.set(new TextEncoder().encode(tableId), 0);
  view.setUint32(4, seqNo, true);
  return packet(2, 6, 8, body);
}

describe('BG live wire', () => {
  it('round-trips the 32-bit packet header', () => {
    const proto = loadProtocol();
    const word = proto.encodeHeader(2, 6, 28, 10);
    expect(proto.decodeHeader(word)).toEqual({ command: 2, action: 6, size: 28, ext: 10 });
  });

  it('decodes start-bet frames into an open window snapshot', () => {
    const proto = loadProtocol();
    const body = new Uint8Array(24);
    const view = new DataView(body.buffer);
    body.set(new TextEncoder().encode('B06'), 0);
    view.setUint32(4, 12345, true);
    body.set(new TextEncoder().encode('shoe-token-1'), 8);
    const packets = proto.decodePackets(packet(2, 6, 8, body));
    expect(packets).toHaveLength(1);
    expect(proto.snapshotsFromPacket(packets[0]!)).toEqual([
      expect.objectContaining({
        tableId: 'B06',
        roundId: '12345',
        bettingOpen: true,
        countdown: 8,
        source: 'protocol',
      }),
    ]);
    expect(proto.snapshotsFromPacket(packets[0]!)[0]).not.toHaveProperty('shoeReset');
  });

  it('maps baccarat result bytes to player and banker cards', () => {
    const proto = loadProtocol();
    expect(proto.baccaratCards([1, 14, 13, 27, 0, 0])).toEqual({
      playerCards: ['AS', 'KS'],
      bankerCards: ['AH', 'AC'],
    });
  });

  it('decodes next-shoes as a shuffle snapshot', () => {
    const proto = loadProtocol();
    const body = new Uint8Array(8);
    const view = new DataView(body.buffer);
    body.set(new TextEncoder().encode('B01'), 0);
    view.setUint32(4, 99, true);
    const snapshots = proto.snapshotsFromPacket(proto.decodePackets(packet(2, 1, 0, body))[0]!);
    expect(snapshots).toEqual([
      expect.objectContaining({
        tableId: 'B01',
        shuffleEvent: true,
        shoeReset: 'seq:99',
      }),
    ]);
    expect(snapshots[0]).not.toHaveProperty('roundId');
  });

  it('keeps the HISTORY bead count on START_BET instead of inventing seqNo-first+1', () => {
    const proto = loadProtocol();
    const history = new Uint8Array(16 + 12);
    const historyView = new DataView(history.buffer);
    history.set(new TextEncoder().encode('A30'), 0);
    historyView.setUint32(4, 1386465, true);
    historyView.setUint16(10, 2, true);
    history.set([1, 14, 13, 27, 0, 0, 2, 15, 3, 28, 0, 0], 16);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, history))[0]!)[0]).toEqual(
      expect.objectContaining({ tableId: 'A30', gameCount: 2, shoeReset: 'seq:1386465' }),
    );
    const start = new Uint8Array(24);
    const startView = new DataView(start.buffer);
    start.set(new TextEncoder().encode('A30'), 0);
    startView.setUint32(4, 1386500, true);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 6, 8, start))[0]!)).toEqual([
      expect.objectContaining({
        tableId: 'A30',
        roundId: '1386500',
        gameCount: 2,
        bettingOpen: true,
      }),
    ]);
  });


  it('strips a frozen HISTORY banker lead when the rest of the road still changes', () => {
    const proto = loadProtocol();
    const rows = 12;
    const history = new Uint8Array(16 + rows * 6);
    const historyView = new DataView(history.buffer);
    history.set(new TextEncoder().encode('B28'), 0);
    historyView.setUint32(4, 189993, true);
    historyView.setUint16(10, rows, true);
    for (let i = 0; i < rows; i += 1) {
      // HISTORY order [P2, B2, P1, B1, P3, B3] with B1 glued at 8S.
      history.set([1 + (i % 12), 14 + (i % 12), 27 + (i % 12), 8, 0, 40 + (i % 12)], 16 + i * 6);
    }
    const snap = proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, history))[0]!)[0] as {
      bankerCards: string[];
      historyHands: Array<{ bankerCards: string[] }>;
    };
    expect(snap.bankerCards[0]).toBe('8S');
    expect(snap.historyHands.every(hand => hand.bankerCards[0] === '8S')).toBe(true);
    expect((proto.session as { stickyBankerLeadByTable: Record<string, string> }).stickyBankerLeadByTable.B28).toBe('8S');
  });

  it('counts only settled HISTORY rows so cancelled games are not the table 局号', () => {
    const proto = loadProtocol();
    const cancelled = 11;
    const settled = 18;
    const rows = cancelled + settled;
    const history = new Uint8Array(16 + rows * 6);
    const historyView = new DataView(history.buffer);
    history.set(new TextEncoder().encode('B01'), 0);
    historyView.setUint32(4, 1000, true);
    historyView.setUint16(10, rows, true);
    for (let i = 0; i < cancelled; i += 1) history.set([0, 0, 0, 0, 0, 0], 16 + i * 6);
    for (let i = 0; i < settled; i += 1) history.set([1, 14, 13, 27, 0, 0], 16 + (cancelled + i) * 6);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, history))[0]!)[0]).toEqual(
      expect.objectContaining({
        tableId: 'B01',
        gameCount: 18,
        roundId: String(1000 + cancelled + settled - 1),
      }),
    );
    const start = new Uint8Array(24);
    const startView = new DataView(start.buffer);
    start.set(new TextEncoder().encode('B01'), 0);
    startView.setUint32(4, 1029, true);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 6, 8, start))[0]!)).toEqual([
      expect.objectContaining({ tableId: 'B01', gameCount: 18, bettingOpen: true }),
    ]);
  });

  it('keeps an empty HISTORY table visible so a shuffle gap is not feed-stale', () => {
    const proto = loadProtocol();
    const body = new Uint8Array(16);
    const view = new DataView(body.buffer);
    body.set(new TextEncoder().encode('A20'), 0);
    view.setUint32(4, 200, true);
    view.setUint16(10, 0, true);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, body))[0]!)).toEqual([
      expect.objectContaining({ tableId: 'A20', source: 'protocol', bettingOpen: false }),
    ]);
  });

  it('uses hall seqNo to trim HISTORY before the first START_BET', () => {
    const proto = loadProtocol();
    proto.ingestBuffer(hallPacket([{ id: 'B01', type: 1, seqNo: 1017 }]), 'recv');
    const rows = 29;
    const history = new Uint8Array(16 + rows * 6);
    const historyView = new DataView(history.buffer);
    history.set(new TextEncoder().encode('B01'), 0);
    historyView.setUint32(4, 1000, true);
    historyView.setUint16(10, rows, true);
    for (let i = 0; i < rows; i += 1) history.set([1, 14, 13, 27, 0, 0], 16 + i * 6);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, history))[0]!)[0]).toEqual(
      expect.objectContaining({ tableId: 'B01', gameCount: 18, roundId: '1017' }),
    );
  });

  it('drops HISTORY rows past the live START_BET seq so a 29-row packet can still be 局 18', () => {
    const proto = loadProtocol();
    const start = new Uint8Array(24);
    const startView = new DataView(start.buffer);
    start.set(new TextEncoder().encode('B01'), 0);
    startView.setUint32(4, 1017, true);
    proto.ingestBuffer(packet(2, 6, 8, start), 'recv');
    const rows = 29;
    const history = new Uint8Array(16 + rows * 6);
    const historyView = new DataView(history.buffer);
    history.set(new TextEncoder().encode('B01'), 0);
    historyView.setUint32(4, 1000, true);
    historyView.setUint16(10, rows, true);
    for (let i = 0; i < rows; i += 1) history.set([1, 14, 13, 27, 0, 0], 16 + i * 6);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, history))[0]!)[0]).toEqual(
      expect.objectContaining({ tableId: 'B01', gameCount: 18, roundId: '1017' }),
    );
  });

  it('starts the HISTORY watch after a hall page and a game socket appear', () => {
    const timers: Array<() => void> = [];
    const proto = loadProtocol({
      setInterval: (fn: () => void) => { timers.push(fn); return 1; },
    });
    proto.ingestBuffer(hallPacket([{ id: 'A30', type: 1, state: 2, seqNo: 10 }]), 'recv');
    expect(proto.session.hallTableIds).toEqual(['A30']);
    expect(proto.session.watchTimer).toBe(1);
    const sent: ArrayBuffer[] = [];
    proto.session.gameSocket = { readyState: 1, send(data: ArrayBuffer) { sent.push(data); } };
    timers[0]!();
    expect(sent.length).toBe(1);
  });

  it('decodes history frames into a road count without treating them as a shuffle', () => {
    const proto = loadProtocol();
    const body = new Uint8Array(16 + 12);
    const view = new DataView(body.buffer);
    body.set(new TextEncoder().encode('C05'), 0);
    view.setUint32(4, 100, true);
    view.setUint16(10, 2, true);
    body.set([1, 14, 13, 27, 0, 0, 2, 15, 3, 28, 0, 0], 16);
    const snapshots = proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, body))[0]!);
    expect(snapshots).toEqual([
      expect.objectContaining({
        tableId: 'C05',
        roundId: '101',
        gameCount: 2,
        source: 'protocol',
        shoeReset: 'seq:100',
        historyHands: [
          { playerCards: ['KS', 'AS'], bankerCards: ['AC', 'AH'] },
          { playerCards: ['3S', '2S'], bankerCards: ['2C', '2H'] },
        ],
      }),
    ]);
    expect(snapshots[0]).not.toHaveProperty('shuffleEvent');
  });

  it('keeps historyHands on every HISTORY so a restarted parser can rebuild the shoe', () => {
    const proto = loadProtocol();
    const body = new Uint8Array(16 + 12);
    const view = new DataView(body.buffer);
    body.set(new TextEncoder().encode('C05'), 0);
    view.setUint32(4, 100, true);
    view.setUint16(10, 2, true);
    body.set([1, 14, 13, 27, 0, 0, 2, 15, 3, 28, 0, 0], 16);
    const first = proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, body))[0]!);
    expect(first[0]).toHaveProperty('historyHands');
    const second = proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, body))[0]!);
    expect(second[0]).toEqual(expect.objectContaining({
      tableId: 'C05',
      gameCount: 2,
      historyHands: first[0]?.historyHands,
    }));
  });

  it('does not treat hall PREPARING pages as a shuffle pulse', () => {
    const proto = loadProtocol();
    const first = proto.snapshotsFromPacket(proto.decodePackets(hallPacket([
      { id: 'B06', type: 1, state: 1, seqNo: 99 },
    ]))[0]!);
    expect(first).toEqual([
      expect.objectContaining({ tableId: 'B06', source: 'hall' }),
    ]);
    expect(first[0]).not.toHaveProperty('shuffleEvent');
    expect(first[0]).not.toHaveProperty('shoeReset');
  });

  it('decodes hall GAME_HISTORY the same as game HISTORY', () => {
    const proto = loadProtocol();
    const body = new Uint8Array(16 + 12);
    const view = new DataView(body.buffer);
    body.set(new TextEncoder().encode('C05'), 0);
    view.setUint32(4, 100, true);
    view.setUint16(10, 2, true);
    body.set([1, 14, 13, 27, 0, 0, 2, 15, 3, 28, 0, 0], 16);
    const snapshots = proto.snapshotsFromPacket(proto.decodePackets(packet(1, 16, 0, body))[0]!);
    expect(snapshots).toEqual([
      expect.objectContaining({ tableId: 'C05', gameCount: 2, source: 'protocol' }),
    ]);
  });

  it('emits a shuffle when history road wraps from a deep shoe to a new shoe', () => {
    const proto = loadProtocol();
    const deep = new Uint8Array(16 + 12 * 12);
    const deepView = new DataView(deep.buffer);
    deep.set(new TextEncoder().encode('A31'), 0);
    deepView.setUint32(4, 200, true);
    deepView.setUint16(10, 12, true);
    for (let i = 0; i < 12; i += 1) deep.set([1, 14, 13, 27, 0, 0], 16 + i * 6);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, deep))[0]!)[0]).toEqual(
      expect.objectContaining({ tableId: 'A31', gameCount: 12 }),
    );
    const fresh = new Uint8Array(16 + 6);
    const freshView = new DataView(fresh.buffer);
    fresh.set(new TextEncoder().encode('A31'), 0);
    freshView.setUint32(4, 213, true);
    freshView.setUint16(10, 1, true);
    fresh.set([1, 14, 13, 27, 0, 0], 16);
    expect(proto.snapshotsFromPacket(proto.decodePackets(packet(2, 3, 0, fresh))[0]!)).toEqual([
      expect.objectContaining({
        tableId: 'A31',
        gameCount: 1,
        shuffleEvent: true,
        shoeReset: 'seq:213',
      }),
    ]);
  });

  it('encodes a vendor REQUEST_RESULT watch frame', () => {
    const proto = loadProtocol();
    const buffer = proto.encodeRequestResult('B19', 0, 80);
    const packets = proto.decodePackets(buffer);
    expect(packets).toHaveLength(1);
    expect(packets[0]).toEqual(expect.objectContaining({ command: 2, action: 2, size: 16 }));
    const tableId = new TextDecoder().decode(new Uint8Array(packets[0]!.body.buffer, packets[0]!.body.byteOffset, 4)).replace(/\0/g, '').trim();
    expect(tableId.startsWith('B19')).toBe(true);
  });

  it('uses the vendor checksum expression', () => {
    const proto = loadProtocol();
    const expected = 4294967295 & Math.floor(12 + 3386 + 3 * 4 ^ ~(5 + (0x10000001 - 10 | 4 + 215 + 12 + 10 << 24) & 1367553510));
    expect(proto.betChecksum(5, 12, 4, 10, 0x10000001)).toBe(expected);
  });

  it('refuses to send a wager on a game socket that never carried BET_CMD', async () => {
    const proto = loadProtocol();
    const gameSocket = { readyState: 1, sent: [] as ArrayBuffer[], send(data: ArrayBuffer) { this.sent.push(data); } };
    proto.session.uid = 5;
    proto.session.token = 'token-token-token-token-token-12';
    proto.session.sockets = [gameSocket];
    await expect(proto.submit({ tableId: 'B06', market: 'banker', amount: 10, handId: '5063063' })).rejects.toThrow(/bg-socket-missing/);
    expect(gameSocket.sent).toEqual([]);
  });

  it('accepts a confirm even when userFlag does not match the outbound flag', async () => {
    const proto = loadProtocol();
    const socket = {
      readyState: 1,
      send(data: ArrayBuffer) {
        proto.ingestBuffer(data, 'send', socket);
        const body = new Uint8Array(16);
        const view = new DataView(body.buffer);
        view.setUint32(0, 1, true);
        view.setUint16(4, 99, true);
        view.setUint16(6, 0, true);
        proto.ingestBuffer(packet(4, 4, 0, body), 'recv', socket);
      },
    };
    proto.session.uid = 5;
    proto.session.token = 'token-token-token-token-token-12';
    proto.session.sockets = [socket];
    proto.session.betSocket = socket;
    await expect(proto.submit({ tableId: 'B06', market: 'banker', amount: 10, handId: '5063063' })).resolves.toEqual(
      expect.objectContaining({ status: 'ACCEPTED', userFlag: 99 }),
    );
  });

  it('rejects a confirm with a non-ok state', async () => {
    const proto = loadProtocol();
    const socket = {
      readyState: 1,
      send(data: ArrayBuffer) {
        proto.ingestBuffer(data, 'send', socket);
        const body = new Uint8Array(16);
        const view = new DataView(body.buffer);
        view.setUint32(0, 4, true);
        view.setUint16(4, 2, true);
        view.setUint16(6, 11, true);
        proto.ingestBuffer(packet(4, 4, 0, body), 'recv', socket);
      },
    };
    proto.session.uid = 5;
    proto.session.token = 'token-token-token-token-token-12';
    proto.session.sockets = [socket];
    proto.session.betSocket = socket;
    await expect(proto.submit({ tableId: 'B06', market: 'banker', amount: 10, handId: '5063063' })).resolves.toEqual(
      expect.objectContaining({ status: 'REJECTED', reason: 'bet-state:4:11' }),
    );
  });

  it('records seen bet packets when confirm times out', async () => {
    const proto = loadProtocol();
    proto.session.confirmWaitMs = 60;
    const socket = {
      readyState: 1,
      send(data: ArrayBuffer) {
        proto.ingestBuffer(data, 'send', socket);
      },
    };
    proto.session.uid = 5;
    proto.session.token = 'token-token-token-token-token-12';
    proto.session.sockets = [socket];
    proto.session.betSocket = socket;
    const result = await proto.submit({ tableId: 'B06', market: 'banker', amount: 10, handId: '5063063' });
    expect(result).toEqual(expect.objectContaining({ status: 'UNKNOWN', reason: 'bet-confirm-timeout' }));
    expect(result.seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ d: 'send', c: 4, a: 3 }),
    ]));
  });

  it('keeps baccarat hall tables and drops roulette/type-all', () => {
    const proto = loadProtocol();
    const snapshots = proto.snapshotsFromPacket(proto.decodePackets(hallPacket([
      { id: 'B06', type: 1 },
      { id: 'A09', type: 2 },
      { id: 'X01', type: 0 },
      { id: 'C05', type: 7 },
      { id: 'B100', type: 1 },
    ]))[0]!);
    expect(snapshots.map(table => table.tableId).sort()).toEqual(['B06', 'C05']);
    expect(snapshots.every(table => table.source === 'hall')).toBe(true);
  });

  it('keeps baccarat tables that sit past the first 64 hall rows', () => {
    const proto = loadProtocol();
    const rows = [];
    for (let i = 0; i < 64; i += 1) {
      rows.push({ id: 'A09', type: 2 });
    }
    rows.push({ id: 'G03', type: 1 });
    rows.push({ id: 'R16', type: 7 });
    const body = hallBody(rows);
    const snapshots = proto.snapshotsFromPacket({
      command: 1,
      action: 3,
      ext: 0,
      body: new DataView(body.buffer),
    });
    expect(snapshots.map(table => table.tableId).sort()).toEqual(['G03', 'R16']);
  });

  it('repairs a wrapped hall header so A31 is not dropped off the end of the list', () => {
    const proto = loadProtocol();
    const rows = [];
    for (let i = 0; i < 28; i += 1) rows.push({ id: 'A09', type: 2 });
    rows.push({ id: 'A31', type: 1 });
    const body = hallBody(rows);
    const size = 4 + body.length;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, proto.encodeHeader(1, 3, size, 0), true);
    bytes.set(body, 4);
    const packets = proto.decodePackets(bytes.buffer);
    expect(packets.length).toBeGreaterThan(0);
    expect(proto.snapshotsFromPacket(packets[0]!).map(table => table.tableId)).toEqual(['A31']);
  });

  it('decodes packed hall type 0x10000000 as baccarat', () => {
    const proto = loadProtocol();
    const snapshots = proto.snapshotsFromPacket(proto.decodePackets(hallPacket([
      { id: 'B15', type: 0x10000000 },
      { id: 'A09', type: 0x20000000 },
    ]))[0]!);
    expect(snapshots.map(table => table.tableId)).toEqual(['B15']);
  });

  it('drops GAME snapshots only for hall-known non-baccarat tables', () => {
    const proto = loadProtocol();
    proto.snapshotsFromPacket(proto.decodePackets(hallPacket([
      { id: 'C01', type: 1 },
      { id: 'A09', type: 2 },
    ]))[0]!);
    const roulette = proto.snapshotsFromPacket(proto.decodePackets(startBetPacket('A09'))[0]!);
    const unseenBaccarat = proto.snapshotsFromPacket(proto.decodePackets(startBetPacket('G03'))[0]!);
    const listed = proto.snapshotsFromPacket(proto.decodePackets(startBetPacket('C01'))[0]!);
    expect(roulette).toEqual([]);
    expect(unseenBaccarat).toEqual([
      expect.objectContaining({ tableId: 'G03', bettingOpen: true, source: 'protocol' }),
    ]);
    expect(listed).toEqual([
      expect.objectContaining({ tableId: 'C01', bettingOpen: true, source: 'protocol' }),
    ]);
  });
});
