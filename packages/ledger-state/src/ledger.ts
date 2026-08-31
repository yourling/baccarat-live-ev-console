import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertValidEventEnvelope,
  isValidContinuityProof,
  type BetReceipt,
  type BettingMarket,
  type DecisionSnapshot,
  type NormalizedEvent,
  type RiskExposureState,
  type RiskReservation,
  type ShoeStateProjection,
  sha256,
  stableStringify,
} from '@baccarat/contracts';
import { operationalReceiptCommitStarted, type OperationalWagerRecord } from './operational-wager.js';
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

type OperationalWagerRow = {
  id: number;
  wager_id: string;
  payload: string;
};

export interface AcceptedOperationalReservationRepair {
  readonly reservationId: string;
  readonly wagerId: string;
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly previousStatus: 'EXPIRED';
  readonly previousReason: string;
  readonly repairedAt: string;
}

type AcceptedOperationalReservationRepairAudit = {
  readonly repairs: readonly AcceptedOperationalReservationRepair[];
};

export interface PrecommitUnknownOperationalReservationRepair {
  readonly reservationId: string;
  readonly wagerId: string;
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly previousStatus: 'UNKNOWN';
  readonly previousReason: string;
  readonly repairedAt: string;
}

type PrecommitUnknownOperationalReservationRepairAudit = {
  readonly repairs: readonly PrecommitUnknownOperationalReservationRepair[];
};

const ACCEPTED_RESERVATION_REPAIR_AUDIT_KEY = 'ledger:accepted-reservation-repairs:v1';
const PRECOMMIT_UNKNOWN_REPAIR_AUDIT_KEY = 'ledger:precommit-unknown-repairs:v1';
const INVALID_ACCEPTED_EXPIRY_REASONS = new Set([
  'new-shoe-signal-received',
  'shoe-invalidated',
  'reconciled-on-startup',
]);


function semanticEventPayload(value: object): string {
  const semanticFields: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === 'timestamp' || key === 'sourceSeq') continue;
    semanticFields[key] = fieldValue;
  }
  return stableStringify(semanticFields);
}

function semanticStoredEventPayload(payload: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return semanticEventPayload(parsed);
  } catch {
    return undefined;
  }
}

function storedEventForReplay(event: NormalizedEvent): NormalizedEvent {
  if (
    event.type !== 'connectionRestored'
    || event.continuityProof === undefined
    || isValidContinuityProof(event.continuityProof)
  ) {
    return event;
  }
  // Legacy builds persisted descriptive strings here. Preserve the immutable
  // event for audit, but never let an unverified string restore continuity.
  return { ...event, continuityProof: undefined };
}

export interface MonitorSummaryRow {
  tableId: string;
  hands: number;
  bets: number;
  amount: number;
  expectedPnl: number;
  actualPnl: number;
}

export interface MonitorSummaryPoint {
  createdAt: string;
  expectedPnl: number;
  actualPnl: number;
}

export interface MonitorSummary {
  rows: MonitorSummaryRow[];
  incomePoints: MonitorSummaryPoint[];
}

export interface MonitorSummaryOptions {
  tableId?: string;
  tableIds?: readonly string[];
  fromTime?: string;
  toTime?: string;
}

export interface RecordPageOptions extends MonitorSummaryOptions {
  page: number;
  pageSize: number;
  market?: string;
  eventType?: string;
  search?: string;
}

export interface RecordPage<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type DecisionHandActualResult =
  | {
      readonly status: 'SETTLED';
      readonly outcomes: {
        readonly bankerPair: boolean;
        readonly playerPair: boolean;
      };
    }
  | { readonly status: 'UNKNOWN' }
  | { readonly status: 'PENDING' };

export interface DecisionHandRecord {
  readonly tableId: string;
  readonly shoeId: string;
  readonly handId: string;
  readonly markets: readonly BettingMarket[];
  readonly selectedMarkets: readonly BettingMarket[];
  readonly pMean: number;
  readonly pLower: number;
  readonly evMean: number;
  readonly evLower: number;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly createdAt: string;
  readonly actualResult: DecisionHandActualResult;
}

export interface DecisionHandPageOptions extends MonitorSummaryOptions {
  readonly page: number;
  readonly pageSize: number;
  readonly market?: string;
  readonly search?: string;
  readonly eligible?: boolean;
}

export interface DecisionHandRecordPage {
  readonly rows: DecisionHandRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

type DecisionHandGroupRow = {
  table_id: string;
  shoe_id: string;
  hand_id: string;
  created_at: string;
  latest_created_at: string;
};

type DecisionHandDecisionRow = {
  snapshot_id: string;
  table_id: string;
  shoe_id: string;
  hand_id: string;
  market: BettingMarket;
  payload: string;
  created_at: string;
};

type DecisionHandSettlementRow = {
  id: number;
  table_id: string;
  payload: string;
};

const DECISION_MARKET_ORDER: readonly BettingMarket[] = ['bankerPair', 'playerPair'];

function decisionMarketOrder(market: BettingMarket): number {
  const index = DECISION_MARKET_ORDER.indexOf(market);
  return index >= 0 ? index : DECISION_MARKET_ORDER.length;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function decisionHandKey(tableId: string, shoeId: string, handId: string): string {
  return JSON.stringify([tableId, shoeId, handId]);
}

function decisionHandIdentity(tableId: string, handId: string): string {
  return JSON.stringify([tableId, handId]);
}

function settlementActualResult(
  settlement: Extract<NormalizedEvent, { type: 'handSettled' }>,
): DecisionHandActualResult {
  const outcomes = settlement.outcomes;
  if (
    outcomes
    && typeof outcomes.bankerPair === 'boolean'
    && typeof outcomes.playerPair === 'boolean'
  ) {
    return {
      status: 'SETTLED',
      outcomes: {
        bankerPair: outcomes.bankerPair,
        playerPair: outcomes.playerPair,
      },
    };
  }
  return { status: 'UNKNOWN' };
}

function decisionHandScope(options: DecisionHandPageOptions): {
  readonly where: string;
  readonly params: string[];
  readonly having: string;
  readonly havingParams: number[];
} {
  const clauses = ['1 = 1'];
  const params: string[] = [];
  if (options.tableId) {
    clauses.push('table_id = ?');
    params.push(options.tableId);
  }
  if (options.tableIds !== undefined) {
    const tableIds = [...new Set(options.tableIds.filter(tableId => tableId.length > 0))];
    if (tableIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push('table_id IN (' + tableIds.map(() => '?').join(', ') + ')');
      params.push(...tableIds);
    }
  }
  if (options.market) {
    clauses.push('market = ?');
    params.push(options.market);
  }
  if (options.fromTime) {
    clauses.push('created_at >= ?');
    params.push(toIsoTime(options.fromTime));
  }
  if (options.toTime) {
    clauses.push('created_at <= ?');
    params.push(toIsoTime(options.toTime));
  }
  if (options.search) {
    const term = '%' + options.search + '%';
    clauses.push('(table_id LIKE ? OR payload LIKE ?)');
    params.push(term, term);
  }
  return {
    where: clauses.join(' AND '),
    params,
    having: options.eligible === undefined
      ? ''
      : "HAVING MAX(CASE WHEN json_extract(payload, '$.eligible') = 1 THEN 1 ELSE 0 END) = ?",
    havingParams: options.eligible === undefined ? [] : [options.eligible ? 1 : 0],
  };
}

function decisionHandPredicates(groups: readonly DecisionHandGroupRow[]): {
  readonly sql: string;
  readonly params: string[];
} {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const group of groups) {
    clauses.push('(table_id = ? AND shoe_id = ? AND hand_id = ?)');
    params.push(group.table_id, group.shoe_id, group.hand_id);
  }
  return { sql: clauses.join(' OR '), params };
}

function summaryScope(alias: string, options: MonitorSummaryOptions): { where: string; params: string[] } {
  const clauses = ['1 = 1'];
  const params: string[] = [];
  if (options.tableId) {
    clauses.push(alias + '.table_id = ?');
    params.push(options.tableId);
  }
  if (options.tableIds !== undefined) {
    const tableIds = [...new Set(options.tableIds.filter((tableId): tableId is string => typeof tableId === 'string' && tableId.length > 0))];
    if (tableIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(alias + '.table_id IN (' + tableIds.map(() => '?').join(', ') + ')');
      params.push(...tableIds);
    }
  }
  if (options.fromTime) {
    clauses.push(alias + '.created_at >= ?');
    params.push(toIsoTime(options.fromTime));
  }
  if (options.toTime) {
    clauses.push(alias + '.created_at <= ?');
    params.push(toIsoTime(options.toTime));
  }
  return { where: clauses.join(' AND '), params };
}

function toIsoTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function recordScope(alias: string, options: RecordPageOptions, includeEventType = false): { where: string; params: string[] } {
  const clauses = ['1 = 1'];
  const params: string[] = [];
  if (options.tableId) {
    clauses.push(alias + '.table_id = ?');
    params.push(options.tableId);
  }
  if (options.tableIds !== undefined) {
    const tableIds = [...new Set(options.tableIds.filter((tableId): tableId is string => typeof tableId === 'string' && tableId.length > 0))];
    if (tableIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(alias + '.table_id IN (' + tableIds.map(() => '?').join(', ') + ')');
      params.push(...tableIds);
    }
  }
  if (options.market) {
    clauses.push(alias === 'e' ? "json_extract(e.payload, '$.market') = ?" : alias + '.market = ?');
    params.push(options.market);
  }
  if (includeEventType && options.eventType) {
    clauses.push(alias + '.type = ?');
    params.push(options.eventType);
  }
  if (options.fromTime) {
    clauses.push(alias + '.created_at >= ?');
    params.push(toIsoTime(options.fromTime));
  }
  if (options.toTime) {
    clauses.push(alias + '.created_at <= ?');
    params.push(toIsoTime(options.toTime));
  }
  if (options.search) {
    const term = '%' + options.search + '%';
    clauses.push('(' + alias + '.table_id LIKE ? OR ' + alias + '.payload LIKE ?)');
    params.push(term, term);
  }
  return { where: clauses.join(' AND '), params };
}

function pageValues(options: { page: number; pageSize: number }): { page: number; pageSize: number; offset: number } {
  const page = Number.isInteger(options.page) && options.page > 0 ? options.page : 1;
  const pageSize = Number.isInteger(options.pageSize) && options.pageSize > 0 ? Math.min(options.pageSize, 100) : 20;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

export type AppendEventResult = 'appended' | 'duplicate';

const SCHEMA_VERSION = '5';
const MONITOR_HISTORY_HANDS_PER_TABLE = 12;
const MONITOR_WINDOW_EVENT_TYPES = "('bettingWindowOpened','bettingWindowClosed')";
const MONITOR_TRANSIENT_EVENT_TYPES = "('connectionLost','connectionRestored','autoArmChanged','autoDisarmChanged')";

// allow: SIZE_OK — SQLite schema, atomic persistence, and read projections share one transaction boundary.
export class SqliteLedger {
  private db: Database.Database;
  private readonly allocatedSourceSeqByTable = new Map<string, number>();

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
      CREATE INDEX IF NOT EXISTS idx_events_table_created ON events(table_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
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
      CREATE INDEX IF NOT EXISTS idx_decisions_table_created ON decisions(table_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_table_type ON events(table_id, type);
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
      CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts(created_at);
      CREATE TABLE IF NOT EXISTS reservations (
        reservation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        shoe_id TEXT NOT NULL,
        hand_id TEXT NOT NULL,
        market TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS operational_wagers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wager_id TEXT NOT NULL UNIQUE,
        table_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operational_wagers_table_created
        ON operational_wagers(table_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_operational_wagers_created
        ON operational_wagers(created_at);
    `);
    const row = this.db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO ledger_meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    } else if (row.value === SCHEMA_VERSION) {
      // 当前版本,无需迁移
    } else if (row.value === '1' || row.value === '2' || row.value === '3' || row.value === '4') {
      if (row.value === '1') this.rebuildReservationsTable();
      this.db.prepare('UPDATE ledger_meta SET value = ? WHERE key = ?').run(SCHEMA_VERSION, 'schema_version');
    } else {
      throw new Error(`ledger schema version mismatch: db=${row.value}, code=${SCHEMA_VERSION}; refusing to open`);
    }
    // 兜底:极早期未写版本号的库也可能带旧的全局唯一约束;该函数幂等,非旧形态时为空操作。
    this.rebuildReservationsTable();
    this.rebuildDecisionWindowIndex();
    this.db.exec(`
      DROP INDEX IF EXISTS uq_reservations_active;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_active
        ON reservations(
          table_id,
          shoe_id,
          hand_id,
          market,
          COALESCE(json_extract(payload, '$.executionSource'), 'strategy')
        ) WHERE status IN ('RESERVED', 'UNKNOWN');
      CREATE INDEX IF NOT EXISTS idx_reservations_window
        ON reservations(table_id, shoe_id, hand_id, market);
      CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(table_id, status);
      CREATE INDEX IF NOT EXISTS idx_reservations_table_created ON reservations(table_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reservations_created ON reservations(created_at);
    `);
  }

  private rebuildDecisionWindowIndex(): void {
    this.db.exec(`
      DELETE FROM decisions
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM decisions GROUP BY table_id, shoe_id, hand_id, market
      );
      DROP INDEX IF EXISTS uq_decisions_window;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_decisions_hand_market
        ON decisions(table_id, shoe_id, hand_id, market);
    `);
  }

  /**
   * v1 → v2:旧 reservations 表带 UNIQUE(table_id, shoe_id, hand_id, market) 全历史约束,
   * RELEASED/SETTLED 行会永久占用键位(墓碑),导致同键再预留必然冲突。
   * 重建为无内联唯一约束的表,活跃键唯一性由部分唯一索引(WHERE status='RESERVED')承担。
   */
  private rebuildReservationsTable(): void {
    const tableSql = (this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reservations'",
    ).get() as { sql?: string } | undefined)?.sql ?? '';
    if (!/UNIQUE\s*\(\s*table_id\s*,/i.test(tableSql)) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE reservations_v2 (
          reservation_id TEXT PRIMARY KEY,
          intent_id TEXT NOT NULL,
          table_id TEXT NOT NULL,
          shoe_id TEXT NOT NULL,
          hand_id TEXT NOT NULL,
          market TEXT NOT NULL,
          status TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO reservations_v2
          SELECT reservation_id, intent_id, table_id, shoe_id, hand_id, market, status, payload, created_at
          FROM reservations;
        DROP TABLE reservations;
        ALTER TABLE reservations_v2 RENAME TO reservations;
      `);
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  clearMonitorData(): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events').run();
      this.db.prepare('DELETE FROM decisions').run();
      this.db.prepare('DELETE FROM receipts').run();
      this.db.prepare('DELETE FROM reservations').run();
      this.db.prepare('DELETE FROM operational_wagers').run();
      this.db.prepare('DELETE FROM risk_state').run();
    });
    this.db.exec('VACUUM');
  }


  listEventsTail(limit = 500): NormalizedEvent[] {
    // sourceSeq is scoped to tableId, so only the SQLite insertion id is globally chronological.
    const rows = this.db.prepare('SELECT payload FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as { payload: string }[];
    return rows.reverse().map(row => JSON.parse(row.payload) as NormalizedEvent);
  }

  listDecisionsTail(limit = 200): DecisionSnapshot[] {
    const rows = this.db.prepare('SELECT payload FROM decisions ORDER BY created_at DESC, snapshot_id DESC LIMIT ?').all(limit) as unknown as { payload: string }[];
    return rows.reverse().map(row => JSON.parse(row.payload) as DecisionSnapshot);
  }

  listReceiptsTail(limit = 200): { receipt: BetReceipt; tableId: string; shoeId: string; handId: string; market: string }[] {
    const rows = this.db.prepare('SELECT * FROM receipts ORDER BY created_at DESC, receipt_id DESC LIMIT ?').all(limit) as unknown as ReceiptRow[];
    return rows.reverse().map(row => ({
      receipt: JSON.parse(row.payload) as BetReceipt,
      tableId: row.table_id,
      shoeId: row.shoe_id,
      handId: row.hand_id,
      market: row.market,
    }));
  }

  saveOperationalWager(record: OperationalWagerRecord): boolean {
    const payload = stableStringify(record);
    const existing = this.db.prepare('SELECT payload FROM operational_wagers WHERE wager_id = ?')
      .get(record.wager.wagerId) as { payload: string } | undefined;
    if (existing) {
      if (existing.payload !== payload) {
        throw new LedgerConflictError(`operational wager ${record.wager.wagerId} already exists with a different payload`);
      }
      return false;
    }
    this.db.prepare(`
      INSERT INTO operational_wagers (wager_id, table_id, source, status, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.wager.wagerId,
      record.wager.tableId,
      record.wager.source,
      record.status,
      payload,
      record.wager.createdAt,
    );
    return true;
  }

  listOperationalWagersTail(limit = 100): OperationalWagerRecord[] {
    const rows = this.db.prepare(`
      SELECT id, wager_id, payload
      FROM operational_wagers
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as OperationalWagerRow[];
    return rows.reverse().map(row => JSON.parse(row.payload) as OperationalWagerRecord);
  }

  getOperationalWager(wagerId: string): OperationalWagerRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM operational_wagers WHERE wager_id = ?')
      .get(wagerId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as OperationalWagerRecord : undefined;
  }

  restoreInvalidlyExpiredAcceptedOperationalReservations(
    repairedAt = new Date().toISOString(),
  ): AcceptedOperationalReservationRepair[] {
    const rows = this.db.prepare(`
      SELECT r.payload AS reservation_payload, o.payload AS wager_payload
      FROM reservations r
      INNER JOIN operational_wagers o
        ON o.wager_id = r.intent_id
       AND json_extract(o.payload, '$.reservationId') = r.reservation_id
      WHERE r.status = 'EXPIRED'
        AND json_extract(o.payload, '$.status') = 'ACCEPTED'
        AND json_extract(o.payload, '$.receipt.status') = 'ACCEPTED'
    `).all() as { reservation_payload: string; wager_payload: string }[];
    const repairs: AcceptedOperationalReservationRepair[] = [];

    this.transaction(() => {
      for (const row of rows) {
        const reservation = JSON.parse(row.reservation_payload) as RiskReservation;
        const record = JSON.parse(row.wager_payload) as OperationalWagerRecord;
        const receipt = record.receipt;
        const previousReason = reservation.releaseReason;
        if (
          reservation.status !== 'EXPIRED'
          || previousReason === undefined
          || !INVALID_ACCEPTED_EXPIRY_REASONS.has(previousReason)
          || record.status !== 'ACCEPTED'
          || receipt?.status !== 'ACCEPTED'
          || record.reservationId !== reservation.reservationId
          || record.wager.wagerId !== reservation.intentId
          || record.wager.tableId !== reservation.tableId
          || record.wager.shoeId !== reservation.shoeId
          || record.wager.handId !== reservation.handId
          || record.wager.market !== reservation.market
          || record.wager.amount !== reservation.amount
          || record.wager.source !== reservation.executionSource
          || receipt.receiptId !== reservation.receiptId
          || receipt.wagerId !== record.wager.wagerId
          || receipt.tableId !== record.wager.tableId
          || receipt.shoeId !== record.wager.shoeId
          || receipt.handId !== record.wager.handId
          || receipt.market !== record.wager.market
          || receipt.amount !== record.wager.amount
          || receipt.source !== record.wager.source
        ) {
          continue;
        }

        const { releasedAt: _releasedAt, releaseReason: _releaseReason, ...restored } = reservation;
        this.updateReservation({ ...restored, status: 'RESERVED' });
        repairs.push({
          reservationId: reservation.reservationId,
          wagerId: record.wager.wagerId,
          tableId: reservation.tableId,
          shoeId: reservation.shoeId,
          handId: reservation.handId,
          previousStatus: 'EXPIRED',
          previousReason,
          repairedAt,
        });
      }

      if (repairs.length > 0) {
        const existing = this.getConfig<AcceptedOperationalReservationRepairAudit>(
          ACCEPTED_RESERVATION_REPAIR_AUDIT_KEY,
        );
        const existingIds = new Set((existing?.repairs ?? []).map(repair => repair.reservationId));
        this.setConfig<AcceptedOperationalReservationRepairAudit>(ACCEPTED_RESERVATION_REPAIR_AUDIT_KEY, {
          repairs: [
            ...(existing?.repairs ?? []),
            ...repairs.filter(repair => !existingIds.has(repair.reservationId)),
          ],
        });
      }
    });

    return repairs;
  }

  repairPrecommitUnknownOperationalReservations(
    repairedAt = new Date().toISOString(),
  ): PrecommitUnknownOperationalReservationRepair[] {
    const rows = this.db.prepare(`
      SELECT r.payload AS reservation_payload, o.payload AS wager_payload
      FROM reservations r
      INNER JOIN operational_wagers o
        ON o.wager_id = r.intent_id
       AND json_extract(o.payload, '$.reservationId') = r.reservation_id
      WHERE r.status = 'UNKNOWN'
        AND json_extract(o.payload, '$.status') = 'UNKNOWN'
        AND json_type(o.payload, '$.receipt') IS NULL
    `).all() as { reservation_payload: string; wager_payload: string }[];
    const repairs: PrecommitUnknownOperationalReservationRepair[] = [];

    this.transaction(() => {
      for (const row of rows) {
        const reservation = JSON.parse(row.reservation_payload) as RiskReservation;
        const record = JSON.parse(row.wager_payload) as OperationalWagerRecord;
        const reason = record.reason;
        if (typeof reason !== 'string') continue;
        const routingFailure = /^bridge-request-error:expected exactly one matching frame for ([A-Z]\d{3}), found \d+$/.exec(reason);
        if (
          reservation.status !== 'UNKNOWN'
          || reservation.receiptId !== undefined
          || routingFailure?.[1] !== reservation.tableId
          || reservation.releaseReason !== reason
          || record.status !== 'UNKNOWN'
          || record.receipt !== undefined
          || record.reservationId !== reservation.reservationId
          || record.wager.wagerId !== reservation.intentId
          || record.wager.tableId !== reservation.tableId
          || record.wager.shoeId !== reservation.shoeId
          || record.wager.handId !== reservation.handId
          || record.wager.market !== reservation.market
          || record.wager.amount !== reservation.amount
          || record.wager.source !== reservation.executionSource
        ) {
          continue;
        }

        const released: RiskReservation = {
          ...reservation,
          status: 'RELEASED',
          releasedAt: repairedAt,
          releaseReason: reason,
        };
        const rejected: OperationalWagerRecord = {
          ...record,
          status: 'REJECTED',
        };
        this.updateReservation(released);
        const result = this.db.prepare(`
          UPDATE operational_wagers SET status = ?, payload = ? WHERE wager_id = ?
        `).run('REJECTED', stableStringify(rejected), record.wager.wagerId);
        if (result.changes !== 1) {
          throw new LedgerConflictError(`operational wager ${record.wager.wagerId} was not repaired`);
        }
        repairs.push({
          reservationId: reservation.reservationId,
          wagerId: record.wager.wagerId,
          tableId: reservation.tableId,
          shoeId: reservation.shoeId,
          handId: reservation.handId,
          previousStatus: 'UNKNOWN',
          previousReason: reason,
          repairedAt,
        });
      }

      if (repairs.length > 0) {
        const existing = this.getConfig<PrecommitUnknownOperationalReservationRepairAudit>(
          PRECOMMIT_UNKNOWN_REPAIR_AUDIT_KEY,
        );
        const existingIds = new Set((existing?.repairs ?? []).map(repair => repair.reservationId));
        this.setConfig<PrecommitUnknownOperationalReservationRepairAudit>(
          PRECOMMIT_UNKNOWN_REPAIR_AUDIT_KEY,
          {
            repairs: [
              ...(existing?.repairs ?? []),
              ...repairs.filter(repair => !existingIds.has(repair.reservationId)),
            ],
          },
        );
      }
    });

    return repairs;
  }

  reconcileOperationalWager(
    wagerId: string,
    reconciliation: NonNullable<OperationalWagerRecord['reconciliation']>,
  ): OperationalWagerRecord {
    const existing = this.getOperationalWager(wagerId);
    if (!existing) throw new LedgerConflictError(`operational wager ${wagerId} not found`);
    if (existing.reconciliation) {
      if (stableStringify(existing.reconciliation) !== stableStringify(reconciliation)) {
        throw new LedgerConflictError(`operational wager ${wagerId} already has a different reconciliation`);
      }
      return existing;
    }
    const committedExecution = (existing.status === 'UNKNOWN'
      || (existing.status === 'REJECTED' && existing.receipt?.status === 'REJECTED'))
      && existing.receipt !== undefined
      && typeof existing.receipt.raw === 'object'
      && existing.receipt.raw !== null
      && operationalReceiptCommitStarted(existing.receipt.raw);
    const unknownReceipt = existing.status === 'UNKNOWN' && existing.receipt?.status === 'UNKNOWN';
    if (!unknownReceipt && !committedExecution) {
      throw new LedgerConflictError(`operational wager ${wagerId} is not a reconcilable committed execution`);
    }
    const updated: OperationalWagerRecord = { ...existing, reconciliation };
    const result = this.db.prepare(`
      UPDATE operational_wagers SET payload = ? WHERE wager_id = ?
    `).run(stableStringify(updated), wagerId);
    if (result.changes !== 1) {
      throw new LedgerConflictError(`operational wager ${wagerId} was not updated`);
    }
    return updated;
  }

  settleOperationalWager(
    wagerId: string,
    settlement: NonNullable<OperationalWagerRecord['settlement']>,
  ): OperationalWagerRecord {
    const existing = this.getOperationalWager(wagerId);
    if (!existing) throw new LedgerConflictError(`operational wager ${wagerId} not found`);
    if (existing.settlement) {
      if (stableStringify(existing.settlement) !== stableStringify(settlement)) {
        throw new LedgerConflictError(`operational wager ${wagerId} already has a different settlement`);
      }
      return existing;
    }
    if (existing.status !== 'ACCEPTED' || existing.receipt?.status !== 'ACCEPTED') {
      throw new LedgerConflictError(`operational wager ${wagerId} is not an accepted pending settlement`);
    }
    const updated: OperationalWagerRecord = { ...existing, settlement };
    const result = this.db.prepare(`
      UPDATE operational_wagers SET payload = ? WHERE wager_id = ?
    `).run(stableStringify(updated), wagerId);
    if (result.changes !== 1) {
      throw new LedgerConflictError(`operational wager ${wagerId} settlement was not updated`);
    }
    return updated;
  }

  getHandSettlement(
    tableId: string,
    shoeId: string,
    handId: string,
  ): Extract<NormalizedEvent, { type: 'handSettled' }> | undefined {
    const exact = this.db.prepare(`
      SELECT payload FROM events
      WHERE table_id = ?
        AND type = 'handSettled'
        AND json_extract(payload, '$.shoeId') = ?
        AND json_extract(payload, '$.handId') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(tableId, shoeId, handId) as { payload: string } | undefined;
    if (exact) {
      return JSON.parse(exact.payload) as Extract<NormalizedEvent, { type: 'handSettled' }>;
    }
    const fallback = this.db.prepare(`
      SELECT payload FROM events
      WHERE table_id = ?
        AND type = 'handSettled'
        AND json_extract(payload, '$.handId') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(tableId, handId) as { payload: string } | undefined;
    return fallback
      ? JSON.parse(fallback.payload) as Extract<NormalizedEvent, { type: 'handSettled' }>
      : undefined;
  }

  hasOperationalWager(
    tableId: string,
    shoeId: string,
    handId: string,
    market: string,
    source: string,
  ): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM operational_wagers
      WHERE table_id = ?
        AND json_extract(payload, '$.wager.shoeId') = ?
        AND json_extract(payload, '$.wager.handId') = ?
        AND json_extract(payload, '$.wager.market') = ?
        AND json_extract(payload, '$.wager.source') = ?
      LIMIT 1
    `).get(tableId, shoeId, handId, market, source));
  }

  getMonitorSummary(options: MonitorSummaryOptions = {}): MonitorSummary {
    const eventScope = summaryScope('e', options);
    const receiptScope = summaryScope('r', options);
    const operationalScope = summaryScope('o', options);
    const reservationScope = summaryScope('r', options);
    const rowsByTable = new Map<string, MonitorSummaryRow>();
    const ensureRow = (tableId: string): MonitorSummaryRow => {
      const existing = rowsByTable.get(tableId);
      if (existing) return existing;
      const created = { tableId, hands: 0, bets: 0, amount: 0, expectedPnl: 0, actualPnl: 0 };
      rowsByTable.set(tableId, created);
      return created;
    };

    const handRows = this.db.prepare(
      'SELECT e.table_id AS tableId, COUNT(*) AS hands FROM events e WHERE e.type = \'handSettled\' AND ' + eventScope.where + ' GROUP BY e.table_id'
    ).all(...eventScope.params) as { tableId: string; hands: number }[];
    for (const row of handRows) ensureRow(row.tableId).hands = Number(row.hands);

    const receiptRows = this.db.prepare(
      'SELECT r.table_id AS tableId, COUNT(*) AS bets, COALESCE(SUM(CAST(json_extract(r.payload, \'$.amount\') AS REAL)), 0) AS amount FROM receipts r WHERE json_extract(r.payload, \'$.status\') IN (\'ACCEPTED\', \'SIMULATED\') AND ' + receiptScope.where + ' GROUP BY r.table_id'
    ).all(...receiptScope.params) as { tableId: string; bets: number; amount: number }[];
    for (const row of receiptRows) {
      const target = ensureRow(row.tableId);
      target.bets = Number(row.bets);
      target.amount = Number(row.amount);
    }

    const operationalRows = this.db.prepare(
      'SELECT o.table_id AS tableId, COUNT(*) AS bets, COALESCE(SUM(CAST(json_extract(o.payload, \'$.wager.amount\') AS REAL)), 0) AS amount FROM operational_wagers o WHERE (json_extract(o.payload, \'$.status\') = \'ACCEPTED\' OR json_extract(o.payload, \'$.reconciliation.status\') = \'ACCEPTED\') AND json_type(o.payload, \'$.receipt\') IS NOT NULL AND ' + operationalScope.where + ' GROUP BY o.table_id'
    ).all(...operationalScope.params) as { tableId: string; bets: number; amount: number }[];
    for (const row of operationalRows) {
      const target = ensureRow(row.tableId);
      target.bets += Number(row.bets);
      target.amount += Number(row.amount);
    }

    const expectedRows = this.db.prepare(
      'SELECT r.table_id AS tableId, COALESCE(SUM(CAST(json_extract(r.payload, \'$.amount\') AS REAL) * COALESCE(CAST(json_extract(d.payload, \'$.evMean\') AS REAL), 0)), 0) AS expectedPnl FROM receipts r LEFT JOIN decisions d ON d.table_id = r.table_id AND d.shoe_id = r.shoe_id AND d.hand_id = r.hand_id AND d.market = r.market WHERE json_extract(r.payload, \'$.status\') IN (\'ACCEPTED\', \'SIMULATED\') AND ' + receiptScope.where + ' GROUP BY r.table_id'
    ).all(...receiptScope.params) as { tableId: string; expectedPnl: number }[];
    for (const row of expectedRows) ensureRow(row.tableId).expectedPnl = Number(row.expectedPnl);

    const actualRows = this.db.prepare(
      'SELECT r.table_id AS tableId, COALESCE(SUM(CASE WHEN json_extract(r.payload, \'$.realizedPnl\') IS NULL THEN 0 ELSE CAST(json_extract(r.payload, \'$.realizedPnl\') AS REAL) END), 0) AS actualPnl FROM reservations r WHERE ' + reservationScope.where + ' GROUP BY r.table_id'
    ).all(...reservationScope.params) as { tableId: string; actualPnl: number }[];
    for (const row of actualRows) ensureRow(row.tableId).actualPnl = Number(row.actualPnl);

    const pointRows = this.db.prepare(`
      SELECT createdAt, expectedPnl, actualPnl
      FROM (
        SELECT
          r.created_at AS createdAt,
          CAST(json_extract(r.payload, '$.amount') AS REAL)
            * COALESCE(CAST(json_extract(d.payload, '$.evMean') AS REAL), 0) AS expectedPnl,
          COALESCE(CAST(json_extract(res.payload, '$.realizedPnl') AS REAL), 0) AS actualPnl,
          r.receipt_id AS stableId
        FROM receipts r
        LEFT JOIN decisions d
          ON d.table_id = r.table_id
          AND d.shoe_id = r.shoe_id
          AND d.hand_id = r.hand_id
          AND d.market = r.market
        LEFT JOIN reservations res ON res.intent_id = r.intent_id
        WHERE json_extract(r.payload, '$.status') IN ('ACCEPTED', 'SIMULATED')
          AND ${receiptScope.where}
        UNION ALL
        SELECT
          o.created_at AS createdAt,
          0 AS expectedPnl,
          COALESCE(CAST(json_extract(res.payload, '$.realizedPnl') AS REAL), 0) AS actualPnl,
          o.wager_id AS stableId
        FROM operational_wagers o
        LEFT JOIN reservations res
          ON res.reservation_id = json_extract(o.payload, '$.reservationId')
        WHERE (json_extract(o.payload, '$.status') = 'ACCEPTED'
          OR json_extract(o.payload, '$.reconciliation.status') = 'ACCEPTED')
          AND json_type(o.payload, '$.receipt') IS NOT NULL
          AND ${operationalScope.where}
      )
      ORDER BY createdAt ASC, stableId ASC
    `).all(
      ...receiptScope.params,
      ...operationalScope.params,
    ) as { createdAt: string; expectedPnl: number; actualPnl: number }[];
    let expected = 0;
    let actual = 0;
    const allPoints = pointRows.map(row => {
      expected += Number(row.expectedPnl) || 0;
      actual += Number(row.actualPnl) || 0;
      return { createdAt: row.createdAt, expectedPnl: expected, actualPnl: actual };
    });
    const stride = Math.max(1, Math.ceil(allPoints.length / 1000));
    const incomePoints = allPoints.filter((_, index) => index % stride === 0 || index === allPoints.length - 1);
    return { rows: [...rowsByTable.values()].sort((a, b) => a.tableId.localeCompare(b.tableId, undefined, { numeric: true })), incomePoints };
  }

  appendEvent(event: NormalizedEvent): AppendEventResult {
    assertValidEventEnvelope(event);
    const payload = stableStringify(event);
    const hash = sha256(payload);
    const semanticPayload = semanticEventPayload(event);
    const existing = this.db.prepare('SELECT payload_hash, payload FROM events WHERE event_id = ?').get(event.eventId) as { payload_hash: string; payload: string } | undefined;
    if (existing) {
      const existingSemanticPayload = semanticStoredEventPayload(existing.payload);
      if (existing.payload_hash !== hash && existingSemanticPayload !== semanticPayload) {
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

  allocateSourceSeq(tableId: string, minimum = 0): number {
    const persistedNext = this.nextSourceSeq(tableId);
    const allocatedNext = this.allocatedSourceSeqByTable.get(tableId) ?? persistedNext;
    const next = Math.max(persistedNext, allocatedNext, minimum);
    this.allocatedSourceSeqByTable.set(tableId, next + 1);
    return next;
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

  listEventsPage(options: RecordPageOptions): RecordPage<NormalizedEvent> {
    const scope = recordScope('e', options, true);
    const page = pageValues(options);
    const totalRow = this.db.prepare('SELECT COUNT(*) AS total FROM events e WHERE ' + scope.where).get(...scope.params) as { total: number };
    const rows = this.db.prepare('SELECT e.payload FROM events e WHERE ' + scope.where + ' ORDER BY e.id DESC LIMIT ? OFFSET ?').all(...scope.params, page.pageSize, page.offset) as { payload: string }[];
    return { rows: rows.map(row => JSON.parse(row.payload) as NormalizedEvent), total: Number(totalRow.total), page: page.page, pageSize: page.pageSize };
  }

  listDecisionsPage(options: RecordPageOptions): RecordPage<DecisionSnapshot> {
    const scope = recordScope('d', options);
    const page = pageValues(options);
    const totalRow = this.db.prepare('SELECT COUNT(*) AS total FROM decisions d WHERE ' + scope.where).get(...scope.params) as { total: number };
    const rows = this.db.prepare('SELECT d.payload FROM decisions d WHERE ' + scope.where + ' ORDER BY d.created_at DESC, d.snapshot_id DESC LIMIT ? OFFSET ?').all(...scope.params, page.pageSize, page.offset) as { payload: string }[];
    return { rows: rows.map(row => JSON.parse(row.payload) as DecisionSnapshot), total: Number(totalRow.total), page: page.page, pageSize: page.pageSize };
  }

  listDecisionHandsPage(options: DecisionHandPageOptions): DecisionHandRecordPage {
    const page = pageValues(options);
    const scope = decisionHandScope(options);
    const groupedFrom = `
      FROM decisions
      WHERE ${scope.where}
      GROUP BY table_id, shoe_id, hand_id
      ${scope.having}
    `;
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT table_id, shoe_id, hand_id
        ${groupedFrom}
      ) AS decision_hands
    `).get(...scope.params, ...scope.havingParams) as { total: number };
    const groups = this.db.prepare(`
      SELECT
        table_id,
        shoe_id,
        hand_id,
        MIN(created_at) AS created_at,
        MAX(created_at) AS latest_created_at
      ${groupedFrom}
      ORDER BY latest_created_at DESC, table_id ASC, shoe_id ASC, hand_id ASC
      LIMIT ? OFFSET ?
    `).all(...scope.params, ...scope.havingParams, page.pageSize, page.offset) as DecisionHandGroupRow[];

    if (groups.length === 0) {
      return {
        rows: [],
        total: Number(totalRow.total),
        page: page.page,
        pageSize: page.pageSize,
      };
    }

    const groupPredicates = decisionHandPredicates(groups);
    const decisionRows = this.db.prepare(`
      SELECT snapshot_id, table_id, shoe_id, hand_id, market, payload, created_at
      FROM decisions
      WHERE (${groupPredicates.sql}) AND ${scope.where}
      ORDER BY created_at ASC, snapshot_id ASC
    `).all(...groupPredicates.params, ...scope.params) as DecisionHandDecisionRow[];

    const settlementTableIds = [...new Set(groups.map(group => group.table_id))];
    const settlementRows = this.db.prepare(`
      SELECT
        id,
        table_id,
        payload
      FROM events
      WHERE type = 'handSettled'
        AND table_id IN (${settlementTableIds.map(() => '?').join(', ')})
      ORDER BY id DESC
    `).all(...settlementTableIds) as DecisionHandSettlementRow[];
    const latestDecisionRows = this.db.prepare(`
      SELECT table_id, MAX(created_at) AS latest_created_at
      FROM decisions
      WHERE table_id IN (${settlementTableIds.map(() => '?').join(', ')})
      GROUP BY table_id
    `).all(...settlementTableIds) as { table_id: string; latest_created_at: string }[];
    const latestDecisionAtByTable = new Map(
      latestDecisionRows.map(row => [row.table_id, row.latest_created_at]),
    );

    const decisionsByKey = new Map<string, DecisionSnapshot[]>();
    for (const row of decisionRows) {
      const key = decisionHandKey(row.table_id, row.shoe_id, row.hand_id);
      const decisions = decisionsByKey.get(key) ?? [];
      decisions.push(JSON.parse(row.payload) as DecisionSnapshot);
      decisionsByKey.set(key, decisions);
    }

    const actualResultByKey = new Map<string, DecisionHandActualResult>();
    const decisionKeysByHand = new Map<string, string[]>();
    for (const key of decisionsByKey.keys()) {
      const [tableId, , handId] = JSON.parse(key) as [string, string, string];
      const handKey = decisionHandIdentity(tableId, handId);
      const keys = decisionKeysByHand.get(handKey) ?? [];
      keys.push(key);
      decisionKeysByHand.set(handKey, keys);
    }
    for (const row of settlementRows) {
      const settlement = JSON.parse(row.payload) as Extract<NormalizedEvent, { type: 'handSettled' }>;
      const result = settlementActualResult(settlement);
      const exactKey = decisionHandKey(row.table_id, settlement.shoeId, settlement.handId);
      if (decisionsByKey.has(exactKey) && !actualResultByKey.has(exactKey)) {
        actualResultByKey.set(exactKey, result);
      }
      const handKeys = decisionKeysByHand.get(decisionHandIdentity(row.table_id, settlement.handId)) ?? [];
      if (handKeys.length === 1) {
        const onlyKey = handKeys[0]!;
        if (!actualResultByKey.has(onlyKey)) actualResultByKey.set(onlyKey, result);
      }
    }

    const rows = groups.map(group => {
      const key = decisionHandKey(group.table_id, group.shoe_id, group.hand_id);
      const decisions = decisionsByKey.get(key) ?? [];
      if (decisions.length === 0) {
        throw new LedgerConflictError(`decision hand group ${key} has no decision rows`);
      }
      const markets = [...new Set(decisions.map(decision => decision.market))]
        .sort((left, right) => decisionMarketOrder(left) - decisionMarketOrder(right));
      const selectedMarkets = [...new Set(
        decisions.flatMap(decision => decision.strategyChoice ?? []),
      )].sort((left, right) => decisionMarketOrder(left) - decisionMarketOrder(right));
      const reasons = [...new Set(decisions.map(decision => decision.reason))];
      const latestDecisionAt = latestDecisionAtByTable.get(group.table_id);
      const actualResult: DecisionHandActualResult = actualResultByKey.get(key)
        ?? (latestDecisionAt !== undefined && group.latest_created_at < latestDecisionAt
          ? { status: 'UNKNOWN' }
          : { status: 'PENDING' });

      return {
        tableId: group.table_id,
        shoeId: group.shoe_id,
        handId: group.hand_id,
        markets,
        selectedMarkets,
        pMean: average(decisions.map(decision => decision.pMean)),
        pLower: average(decisions.map(decision => decision.pLower)),
        evMean: average(decisions.map(decision => decision.evMean)),
        evLower: average(decisions.map(decision => decision.evLower)),
        eligible: decisions.some(decision => decision.eligible),
        reasons,
        createdAt: group.created_at,
        actualResult,
      };
    });

    return {
      rows,
      total: Number(totalRow.total),
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  listReservationsPage(options: RecordPageOptions): RecordPage<RiskReservation> {
    const scope = recordScope('r', options);
    const page = pageValues(options);
    const totalRow = this.db.prepare('SELECT COUNT(*) AS total FROM reservations r WHERE ' + scope.where).get(...scope.params) as { total: number };
    const rows = this.db.prepare('SELECT r.payload FROM reservations r WHERE ' + scope.where + ' ORDER BY r.created_at DESC, r.reservation_id DESC LIMIT ? OFFSET ?').all(...scope.params, page.pageSize, page.offset) as { payload: string }[];
    return { rows: rows.map(row => JSON.parse(row.payload) as RiskReservation), total: Number(totalRow.total), page: page.page, pageSize: page.pageSize };
  }

  getDecision(tableId: string, shoeId: string, handId: string, market: string): DecisionSnapshot | undefined {
    const row = this.db.prepare('SELECT payload FROM decisions WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ? ORDER BY created_at DESC, snapshot_id DESC LIMIT 1').get(tableId, shoeId, handId, market) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as DecisionSnapshot : undefined;
  }

  getReceipt(tableId: string, shoeId: string, handId: string, market: string): { receipt: BetReceipt; tableId: string; shoeId: string; handId: string; market: string } | undefined {
    const row = this.db.prepare('SELECT * FROM receipts WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ? ORDER BY created_at DESC, receipt_id DESC LIMIT 1').get(tableId, shoeId, handId, market) as ReceiptRow | undefined;
    return row ? { receipt: JSON.parse(row.payload) as BetReceipt, tableId: row.table_id, shoeId: row.shoe_id, handId: row.hand_id, market: row.market } : undefined;
  }

  getSettledOutcome(tableId: string, shoeId: string, handId: string, market: string): boolean | undefined {
    const settlement = this.getHandSettlement(tableId, shoeId, handId);
    if (!settlement) return undefined;
    const outcomes = settlement.outcomes;
    if (
      !outcomes
      || typeof outcomes.bankerPair !== 'boolean'
      || typeof outcomes.playerPair !== 'boolean'
    ) {
      return undefined;
    }
    if (market === 'bankerPair') return outcomes.bankerPair;
    if (market === 'playerPair') return outcomes.playerPair;
    return undefined;
  }

  replay(tableId?: string): { state: Map<string, ShoeStateProjection>; hash: string } {
    const events = this.listEvents(tableId);
    const state = replayEvents(events.map(storedEventForReplay));
    return { state, hash: sha256(stableStringify(events)) };
  }

  saveDecision(decision: DecisionSnapshot): boolean {
    const payload = stableStringify(decision);
    const existing = this.db.prepare(
      'SELECT snapshot_id, payload FROM decisions WHERE table_id = ? AND shoe_id = ? AND hand_id = ? AND market = ?',
    ).get(decision.tableId, decision.shoeId, decision.handId, decision.market) as
      | { snapshot_id: string; payload: string }
      | undefined;
    if (existing) {
      if (existing.payload === payload) return false;
      this.db.prepare(`
        UPDATE decisions
        SET snapshot_id = ?, model_revision = ?, event_id = ?, payload = ?, created_at = ?
        WHERE snapshot_id = ?
      `).run(
        decision.snapshotId,
        decision.modelRevision,
        decision.eventId ?? null,
        payload,
        decision.createdAt,
        existing.snapshot_id,
      );
      return true;
    }
    const result = this.db.prepare(`
      INSERT INTO decisions
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

  listHandCards(tableId: string, handId: string): {
    playerCards: Array<{ rank: string }>;
    bankerCards: Array<{ rank: string }>;
  } {
    const rows = this.db.prepare(`
      SELECT payload FROM events
      WHERE table_id = ? AND type = 'cardObserved' AND json_extract(payload, '$.handId') = ?
      ORDER BY id ASC
    `).all(tableId, handId) as { payload: string }[];
    const playerCards: Array<{ rank: string }> = [];
    const bankerCards: Array<{ rank: string }> = [];
    for (const row of rows) {
      const event = JSON.parse(row.payload) as Extract<NormalizedEvent, { type: 'cardObserved' }>;
      if (event.position === 'player' && playerCards.length < 3) playerCards.push(event.card);
      if (event.position === 'banker' && bankerCards.length < 3) bankerCards.push(event.card);
    }
    return { playerCards, bankerCards };
  }

  pruneMonitorHistory(
    keepHandsPerTable = MONITOR_HISTORY_HANDS_PER_TABLE,
    tableId?: string,
  ): void {
    const keepCount = Math.max(1, Math.trunc(keepHandsPerTable));
    const tableRows = tableId === undefined
      ? this.db.prepare('SELECT DISTINCT table_id AS tableId FROM events').all() as Array<{ tableId: string }>
      : [{ tableId }];
    const reservedRows = this.db.prepare(
      "SELECT table_id AS tableId, hand_id AS handId FROM reservations WHERE status IN ('RESERVED', 'UNKNOWN')",
    ).all() as Array<{ tableId: string; handId: string }>;
    const reservedByTable = new Map<string, Set<string>>();
    for (const row of reservedRows) {
      const hands = reservedByTable.get(row.tableId) ?? new Set<string>();
      hands.add(row.handId);
      reservedByTable.set(row.tableId, hands);
    }

    const pruneTable = this.db.transaction((tableId: string) => {
      const hands = this.db.prepare(`
        SELECT json_extract(payload, '$.handId') AS handId, MAX(id) AS lastId
        FROM events
        WHERE table_id = ? AND json_extract(payload, '$.handId') IS NOT NULL
        GROUP BY handId
        ORDER BY lastId DESC
      `).all(tableId) as Array<{ handId: string; lastId: number }>;
      const keep = new Set<string>();
      for (const hand of hands.slice(0, keepCount)) {
        if (typeof hand.handId === 'string' && hand.handId.length > 0) keep.add(hand.handId);
      }
      for (const handId of reservedByTable.get(tableId) ?? []) keep.add(handId);
      const latestShoe = this.db.prepare(`
        SELECT json_extract(payload, '$.shoeId') AS shoeId
        FROM events
        WHERE table_id = ? AND type = 'newShoeSignal'
        ORDER BY id DESC
        LIMIT 1
      `).get(tableId) as { shoeId: string | null } | undefined;

      if (keep.size > 0) {
        const placeholders = [...keep].map(() => '?').join(',');
        this.db.prepare(`
          DELETE FROM events
          WHERE table_id = ?
            AND type IN ${MONITOR_WINDOW_EVENT_TYPES}
            AND (
              json_extract(payload, '$.handId') IS NULL
              OR json_extract(payload, '$.handId') NOT IN (${placeholders})
            )
        `).run(tableId, ...keep);
        this.db.prepare(`
          DELETE FROM decisions
          WHERE table_id = ?
            AND hand_id NOT IN (${placeholders})
        `).run(tableId, ...keep);
      }

      if (typeof latestShoe?.shoeId === 'string' && latestShoe.shoeId.length > 0) {
        if (keep.size > 0) {
          const placeholders = [...keep].map(() => '?').join(',');
          this.db.prepare(`
            DELETE FROM events
            WHERE table_id = ?
              AND type != 'newShoeSignal'
              AND json_extract(payload, '$.shoeId') IS NOT NULL
              AND json_extract(payload, '$.shoeId') != ?
              AND NOT (
                type = 'handSettled'
                AND json_extract(payload, '$.handId') IN (${placeholders})
              )
          `).run(tableId, latestShoe.shoeId, ...keep);
        } else {
          this.db.prepare(`
            DELETE FROM events
            WHERE table_id = ?
              AND type != 'newShoeSignal'
              AND json_extract(payload, '$.shoeId') IS NOT NULL
              AND json_extract(payload, '$.shoeId') != ?
          `).run(tableId, latestShoe.shoeId);
        }
      }

      this.db.prepare(`
        DELETE FROM events
        WHERE table_id = ?
          AND type = 'newShoeSignal'
          AND id NOT IN (
            SELECT MAX(id) FROM events WHERE table_id = ? AND type = 'newShoeSignal'
          )
      `).run(tableId, tableId);

      this.db.prepare(`
        DELETE FROM events
        WHERE table_id = ?
          AND type IN ${MONITOR_TRANSIENT_EVENT_TYPES}
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM events
              WHERE table_id = ? AND type IN ${MONITOR_TRANSIENT_EVENT_TYPES}
              ORDER BY id DESC
              LIMIT 8
            )
          )
      `).run(tableId, tableId);
    });

    for (const row of tableRows) pruneTable(row.tableId);
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

  /**
   * RESERVED and UNKNOWN both hold exposure. The execution source is part of
   * the key so strategy/manual/keepalive attempts remain independently auditable.
   */
  saveReservation(reservation: RiskReservation): boolean {
    const active = this.db.prepare(
      `SELECT reservation_id
       FROM reservations
       WHERE table_id = ?
         AND shoe_id = ?
         AND hand_id = ?
         AND market = ?
         AND COALESCE(json_extract(payload, '$.executionSource'), 'strategy') = ?
         AND status IN ('RESERVED', 'UNKNOWN')
       LIMIT 1`
    ).get(
      reservation.tableId,
      reservation.shoeId,
      reservation.handId,
      reservation.market,
      reservation.executionSource ?? 'strategy',
    ) as { reservation_id: string } | undefined;
    if (active) {
      if (active.reservation_id === reservation.reservationId) return false;
      throw new LedgerConflictError(`active reservation already exists for ${reservation.tableId}/${reservation.shoeId}/${reservation.handId}/${reservation.market}`);
    }
    try {
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
    } catch (error) {
      // 并发/多连接下绕过前置探测时,由部分唯一索引 uq_reservations_active 兜底
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new LedgerConflictError(`active reservation already exists for ${reservation.tableId}/${reservation.shoeId}/${reservation.handId}/${reservation.market}`);
      }
      throw error;
    }
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
