import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertValidEventEnvelope,
  type BetReceipt,
  type DecisionSnapshot,
  type NormalizedEvent,
  type RiskExposureState,
  type RiskReservation,
  type ShoeStateProjection,
  sha256,
  stableStringify,
} from '@baccarat/contracts';
import { replayEvents } from './projection.js';

type EventRow = {
  id: number;
  event_id: string;
  table_id: string;
  seq: number;
  type: string;
  payload: string;
  payload_hash: string;
  created_at: string;
};

type ReceiptRow = EventRow & {
  intent_id: string;
  shoe_id: string;
  hand_id: string;
  market: string;
  receipt_id: string;
};

type ReservationRow = {
  reservation_id: string;
  intent_id: string;
  table_id: string;
  shoe_id: string;
  hand_id: string;
  market: string;
  status: string;
  payload: string;
  created_at: string;
};

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

export type AppendEventResult = 'appended' | 'duplicate';

const SCHEMA_VERSION = '1';

export class SqliteLedger {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      if (!dbPath) throw new Error('dbPath must be :memory: or a file path');
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        table_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(table_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_table_seq ON events(table_id, seq);
      CREATE TABLE IF NOT EXISTS decisions (
        snapshot_id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL,
        shoe_id TEXT NOT NULL,
        hand_id TEXT NOT NULL,
        market TEXT NOT NULL,
        model_revision TEXT NOT NULL,
        event_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_decisions_window
        ON decisions(table_id, shoe_id, hand_id, market, event_id);
      CREATE TABLE IF NOT EXISTS receipts (
        receipt_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL UNIQUE,
        table_id TEXT NOT NULL,
        shoe_id TEXT NOT NULL,
        hand_id TEXT NOT NULL,
        market TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(table_id, shoe_id, hand_id, market)
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_table ON receipts(table_id, created_at);
      CREATE TABLE IF NOT EXISTS reservations (
        reservation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        shoe_id TEXT NOT NULL,
        hand_id TEXT NOT NULL,
        market TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(table_id, shoe_id, hand_id, market)
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(table_id, status);
      CREATE TABLE IF NOT EXISTS risk_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const row = this.db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (row && row.value !== SCHEMA_VERSION) {
      throw new Error(`Unsupported ledger schema version: ${row.value} (expected ${SCHEMA_VERSION})`);
    }
    this.db.prepare('INSERT OR IGNORE INTO ledger_meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    const existing = this.db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (existing && existing.value !== SCHEMA_VERSION) {
      throw new Error(`ledger schema version mismatch: db=${existing.value}, code=${SCHEMA_VERSION}; refusing to open`);
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  appendEvent(event: NormalizedEvent): AppendEventResult {
    assertValidEventEnvelope(event);
    const payload = stableStringify(event);
    const hash = sha256(payload);
    const existing = this.db.prepare('SELECT payload_hash FROM events WHERE event_id = ?').get(event.eventId) as { payload_hash: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== hash) {
        throw new LedgerConflictError(`event_id ${event.eventId} already exists with a different payload; append rejected`);
      }
      return 'duplicate';
    }
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO events (event_id, table_id, seq, type, payload, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(event.eventId, event.tableId, event.sourceSeq, event.type, payload, hash, event.timestamp);
    if (result.changes === 0) {
      const conflict = this.db.prepare('SELECT event_id FROM events WHERE table_id = ? AND seq = ?').get(event.tableId, event.sourceSeq) as { event_id: string } | undefined;
      if (conflict) {
        throw new LedgerConflictError(`sourceSeq ${event.sourceSeq} for table ${event.tableId} already used by ${conflict.event_id}`);
      }
      throw new LedgerConflictError(`could not append event ${event.eventId}`);
    }
    return 'appended';
  }

  nextSourceSeq(tableId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM events WHERE table_id = ?').get(tableId) as { next_seq: number };
    return row.next_seq;
  }

  countEvents(tableId?: string): number {
    const row = tableId
      ? (this.db.prepare('SELECT COUNT(*) AS c FROM events WHERE table_id = ?').get(tableId) as { c: number })
      : (this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number });
    return row.c;
  }

  listEvents(tableId?: string): NormalizedEvent[] {
    const sql = tableId
      ? 'SELECT payload FROM events WHERE table_id = ? ORDER BY seq ASC, id ASC'
      : 'SELECT payload FROM events ORDER BY seq ASC, id ASC';
    const params = tableId ? [tableId] : [];
    const rows = this.db.prepare(sql).all(...params) as unknown as { payload: string }[];
    return rows.map(r => JSON.parse(r.payload) as NormalizedEvent);
  }

  replay(tableId?: string): { state: Map<string, ShoeStateProjection>; hash: string } {
    const events = this.listEvents(tableId);
    const state = replayEvents(events);
    return { state, hash: sha256(stableStringify(events)) };
  }

  saveDecision(decision: DecisionSnapshot): boolean {
    const payload = stableStringify(decision);
    const existing = this.db.prepare('SELECT payload FROM decisions WHERE snapshot_id = ?').get(decision.snapshotId) as { payload: string } | undefined;
    if (existing) {
      if (existing.payload !== payload) {
        throw new LedgerConflictError(`decision snapshot ${decision.snapshotId} already exists with a different payload`);
      }
      return false;
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO decisions
        (snapshot_id, table_id, shoe_id, hand_id, market, model_revision, event_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.snapshotId,
      decision.tableId,
      decision.shoeId,
      decision.handId,
      decision.market,
      decision.modelRevision,
      decision.eventId ?? null,
      payload,
      decision.createdAt,
    );
    return result.changes > 0;
  }

  listDecisions(tableId?: string): DecisionSnapshot[] {
    const sql = tableId
      ? 'SELECT payload FROM decisions WHERE table_id = ? ORDER BY created_at ASC, snapshot_id ASC'
      : 'SELECT payload FROM decisions ORDER BY created_at ASC, snapshot_id ASC';
    const params = tableId ? [tableId] : [];
    const rows = this.db.prepare(sql).all(...params) as unknown as { payload: string }[];
    return rows.map(r => JSON.parse(r.payload) as DecisionSnapshot);
  }

  hasDecision(tableId: string, shoeId: string, handId: string, market: string, eventId?: string): boolean {
    if (eventId) {
      return Boolean(this.db.prepare(
        'SELECT 1 FROM decisions WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ? AND event_id = ?'
      ).get(tableId, shoeId, handId, market, eventId));
    }
    return Boolean(this.db.prepare(
      'SELECT 1 FROM decisions WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ?'
    ).get(tableId, shoeId, handId, market));
  }

  saveReceipt(receipt: BetReceipt, tableId: string, shoeId: string, handId: string, market: string): boolean {
    const existing = this.db.prepare(
      'SELECT receipt_id FROM receipts WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ?'
    ).get(tableId, shoeId, handId, market) as { receipt_id: string } | undefined;
    if (existing) {
      if (existing.receipt_id === receipt.receiptId) return false;
      throw new LedgerConflictError(`receipt already exists for ${tableId}/${shoeId}/${handId}/${market}`);
    }
    const result = this.db.prepare(`
      INSERT INTO receipts (receipt_id, intent_id, table_id, shoe_id, hand_id, market, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.receiptId,
      receipt.intentId,
      tableId,
      shoeId,
      handId,
      market,
      stableStringify(receipt),
      receipt.createdAt,
    );
    return result.changes > 0;
  }

  hasReceipt(tableId: string, shoeId: string, handId: string, market: string): boolean {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM receipts WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ?'
    ).get(tableId, shoeId, handId, market));
  }

  listReceipts(tableId?: string): { receipt: BetReceipt; tableId: string; shoeId: string; handId: string; market: string }[] {
    const sql = tableId
      ? 'SELECT * FROM receipts WHERE table_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM receipts ORDER BY created_at ASC';
    const params = tableId ? [tableId] : [];
    const rows = this.db.prepare(sql).all(...params) as unknown as ReceiptRow[];
    return rows.map(r => ({
      receipt: JSON.parse(r.payload) as BetReceipt,
      tableId: r.table_id,
      shoeId: r.shoe_id,
      handId: r.hand_id,
      market: r.market,
    }));
  }

  saveReservation(reservation: RiskReservation): boolean {
    const existing = this.db.prepare(
      'SELECT reservation_id FROM reservations WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ?'
    ).get(reservation.tableId, reservation.shoeId, reservation.handId, reservation.market) as { reservation_id: string } | undefined;
    if (existing) {
      if (existing.reservation_id === reservation.reservationId) return false;
      throw new LedgerConflictError(`reservation already exists for ${reservation.tableId}/${reservation.shoeId}/${reservation.handId}/${reservation.market}`);
    }
    const result = this.db.prepare(`
      INSERT INTO reservations
        (reservation_id, intent_id, table_id, shoe_id, hand_id, market, status, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reservation.reservationId,
      reservation.intentId,
      reservation.tableId,
      reservation.shoeId,
      reservation.handId,
      reservation.market,
      reservation.status,
      stableStringify(reservation),
      reservation.createdAt,
    );
    return result.changes > 0;
  }

  updateReservation(reservation: RiskReservation): void {
    const result = this.db.prepare(`
      UPDATE reservations SET status = ?, payload = ? WHERE reservation_id = ?
    `).run(reservation.status, stableStringify(reservation), reservation.reservationId);
    if (result.changes !== 1) throw new LedgerConflictError(`reservation ${reservation.reservationId} not found for update`);
  }

  listReservations(tableId?: string): RiskReservation[] {
    const sql = tableId
      ? 'SELECT payload FROM reservations WHERE table_id = ? ORDER BY created_at ASC, reservation_id ASC'
      : 'SELECT payload FROM reservations ORDER BY created_at ASC, reservation_id ASC';
    const params = tableId ? [tableId] : [];
    const rows = this.db.prepare(sql).all(...params) as unknown as { payload: string }[];
    return rows.map(r => JSON.parse(r.payload) as RiskReservation);
  }

  getRiskState(): RiskExposureState | null {
    const row = this.db.prepare('SELECT payload FROM risk_state WHERE id = 1').get() as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RiskExposureState) : null;
  }

  saveRiskState(state: RiskExposureState): void {
    this.db.prepare(`
      INSERT INTO risk_state (id, payload, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(stableStringify(state), new Date().toISOString());
  }

  getConfig<T>(key: string): T | null {
    const row = this.db.prepare('SELECT payload FROM config WHERE key = ?').get(key) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : null;
  }

  setConfig<T>(key: string, value: T): void {
    this.db.prepare(`
      INSERT INTO config (key, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(key, stableStringify(value), new Date().toISOString());
  }

  isOpen(): boolean {
    return this.db.open;
  }
}
