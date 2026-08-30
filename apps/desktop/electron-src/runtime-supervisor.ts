import type { ConnectionStatus, ShoeBaseline } from '@baccarat/contracts';
import type { MonitorConnectionState } from '@baccarat/room-monitor';

export const LIVE_APPROVAL_CONFIG_KEY = 'desktop:live-approval:v1';
export const RUNTIME_INCIDENT_CONFIG_KEY = 'desktop:runtime-incidents:v1';

export type RuntimeIncidentCode =
  | 'bridge-auth-failed'
  | 'bridge-disconnected'
  | 'continuity-invalidated'
  | 'table-feed-stale'
  | 'session-recovery-exhausted'
  | 'unknown-execution'
  | 'settlement-gap'
  | 'scheduler-failure'
  | 'monitor-failure';

export type RuntimeIncidentSeverity = 'degraded' | 'blocked';

export interface RuntimeIncident {
  readonly incidentId: string;
  readonly code: RuntimeIncidentCode;
  readonly severity: RuntimeIncidentSeverity;
  readonly message: string;
  readonly tableId?: string;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly occurrences: number;
  readonly active: boolean;
  readonly acknowledgedAt?: string;
  readonly resolvedAt?: string;
}

export interface RuntimeConfigStore {
  getConfig<T>(key: string): T | null;
  setConfig<T>(key: string, value: T): void;
}

export interface RuntimeIncidentStoreOptions {
  readonly maxIncidents?: number;
  readonly now?: () => Date;
}

export interface RuntimeIncidentInput {
  readonly code: RuntimeIncidentCode;
  readonly severity: RuntimeIncidentSeverity;
  readonly message: string;
  readonly tableId?: string;
}

type PersistedRuntimeIncidents = {
  readonly incidents: readonly RuntimeIncident[];
};

const DEFAULT_MAX_INCIDENTS = 200;
const MAX_INCIDENT_MESSAGE_LENGTH = 300;

export class RuntimeIncidentStore {
  private incidents: RuntimeIncident[];
  private readonly maxIncidents: number;
  private readonly now: () => Date;

  constructor(
    private readonly storage: RuntimeConfigStore,
    options: RuntimeIncidentStoreOptions = {},
  ) {
    this.maxIncidents = Math.max(1, Math.trunc(options.maxIncidents ?? DEFAULT_MAX_INCIDENTS));
    this.now = options.now ?? (() => new Date());
    this.incidents = readPersistedIncidents(storage.getConfig<unknown>(RUNTIME_INCIDENT_CONFIG_KEY));
    this.trimAndPersist();
  }

  record(input: RuntimeIncidentInput): RuntimeIncident {
    const occurredAt = this.now().toISOString();
    const message = sanitizeIncidentMessage(input.message);
    const existingIndex = this.incidents.findIndex(incident =>
      incident.active
      && incident.code === input.code
      && incident.tableId === input.tableId);
    if (existingIndex >= 0) {
      const existing = this.incidents[existingIndex]!;
      const updated: RuntimeIncident = {
        ...existing,
        severity: input.severity,
        message,
        lastOccurredAt: occurredAt,
        occurrences: existing.occurrences + 1,
      };
      Reflect.deleteProperty(updated, 'acknowledgedAt');
      this.incidents.splice(existingIndex, 1);
      this.incidents.push(updated);
      this.trimAndPersist();
      return structuredClone(updated);
    }

    const created: RuntimeIncident = {
      incidentId: runtimeIncidentId(input.code, input.tableId, occurredAt),
      code: input.code,
      severity: input.severity,
      message,
      ...(input.tableId === undefined ? {} : { tableId: input.tableId }),
      firstOccurredAt: occurredAt,
      lastOccurredAt: occurredAt,
      occurrences: 1,
      active: true,
    };
    this.incidents.push(created);
    this.trimAndPersist();
    return structuredClone(created);
  }

  resolve(code: RuntimeIncidentCode, tableId?: string): void {
    const resolvedAt = this.now().toISOString();
    let changed = false;
    this.incidents = this.incidents.map(incident => {
      if (!incident.active || incident.code !== code || incident.tableId !== tableId) return incident;
      changed = true;
      return {
        ...incident,
        active: false,
        resolvedAt,
      };
    });
    if (changed) this.persist();
  }

  resolveAll(code: RuntimeIncidentCode): void {
    const resolvedAt = this.now().toISOString();
    let changed = false;
    this.incidents = this.incidents.map(incident => {
      if (!incident.active || incident.code !== code) return incident;
      changed = true;
      return {
        ...incident,
        active: false,
        resolvedAt,
      };
    });
    if (changed) this.persist();
  }

  acknowledge(incidentId: string): boolean {
    const acknowledgedAt = this.now().toISOString();
    let changed = false;
    this.incidents = this.incidents.map(incident => {
      if (incident.incidentId !== incidentId || incident.acknowledgedAt !== undefined) return incident;
      changed = true;
      return { ...incident, acknowledgedAt };
    });
    if (changed) this.persist();
    return changed;
  }

  acknowledgeAllActive(): number {
    const acknowledgedAt = this.now().toISOString();
    let changed = 0;
    this.incidents = this.incidents.map(incident => {
      if (!incident.active || incident.acknowledgedAt !== undefined) return incident;
      changed += 1;
      return { ...incident, acknowledgedAt };
    });
    if (changed > 0) this.persist();
    return changed;
  }

  hasActive(code: RuntimeIncidentCode, tableId?: string): boolean {
    return this.incidents.some(incident =>
      incident.active
      && incident.code === code
      && (tableId === undefined || incident.tableId === tableId));
  }

  list(): RuntimeIncident[] {
    return [...this.incidents]
      .sort((left, right) => right.lastOccurredAt.localeCompare(left.lastOccurredAt))
      .map(incident => structuredClone(incident));
  }

  private trimAndPersist(): void {
    let overflow = this.incidents.length - this.maxIncidents;
    if (overflow > 0) {
      this.incidents = this.incidents.filter(incident => {
        if (overflow > 0 && !incident.active) {
          overflow -= 1;
          return false;
        }
        return true;
      });
    }
    this.persist();
  }

  private persist(): void {
    this.storage.setConfig<PersistedRuntimeIncidents>(RUNTIME_INCIDENT_CONFIG_KEY, {
      incidents: this.incidents,
    });
  }
}

export interface PersistedLiveApproval {
  readonly tableIds: readonly string[];
  readonly updatedAt: string;
}

export class LiveApprovalStore {
  private tableIds: string[];

  constructor(
    private readonly storage: RuntimeConfigStore,
    fallbackTableIds: readonly string[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    const persisted = readApprovedLiveTableIds(storage.getConfig<unknown>(LIVE_APPROVAL_CONFIG_KEY));
    this.tableIds = persisted ?? normalizeTableIds(fallbackTableIds);
    this.persist();
  }

  list(): string[] {
    return [...this.tableIds];
  }

  has(tableId: string): boolean {
    return this.tableIds.includes(tableId);
  }

  approve(tableId: string): void {
    if (this.tableIds.includes(tableId)) return;
    this.tableIds.push(tableId);
    this.persist();
  }

  revoke(tableId: string): void {
    const next = this.tableIds.filter(candidate => candidate !== tableId);
    if (next.length === this.tableIds.length) return;
    this.tableIds = next;
    this.persist();
  }

  retain(tableIds: readonly string[]): void {
    const allowed = new Set(tableIds);
    const next = this.tableIds.filter(tableId => allowed.has(tableId));
    if (next.length === this.tableIds.length) return;
    this.tableIds = next;
    this.persist();
  }

  private persist(): void {
    this.storage.setConfig<PersistedLiveApproval>(LIVE_APPROVAL_CONFIG_KEY, {
      tableIds: this.tableIds,
      updatedAt: this.now().toISOString(),
    });
  }
}

export type LiveExecutionBlockReason =
  | 'live-not-approved'
  | 'bridge-not-running'
  | 'bridge-not-authenticated'
  | 'table-feed-missing'
  | 'table-feed-disconnected'
  | 'table-feed-stale'
  | 'physical-shoe-baseline-unknown'
  | 'table-connection-not-restored'
  | 'shoe-sealed'
  | 'unknown-execution-pending'
  | 'settlement-gap';

export interface RuntimeBridgeStatus {
  readonly running: boolean;
  readonly connectionCount: number;
  readonly authenticated: boolean;
  readonly lastSeenAt?: string;
}

export interface LiveExecutionReadinessInput {
  readonly approved: boolean;
  readonly bridge: RuntimeBridgeStatus;
  readonly feed?: {
    readonly state: MonitorConnectionState;
    readonly stalenessMs?: number;
  };
  readonly maxFeedStalenessMs: number;
  readonly projection: {
    readonly shoeBaseline: ShoeBaseline;
    readonly connectionStatus: ConnectionStatus;
    readonly sealed: boolean;
  };
  readonly hasUnknownExecution: boolean;
  readonly hasSettlementGap: boolean;
}

export function evaluateLiveExecutionReadiness(
  input: LiveExecutionReadinessInput,
): LiveExecutionBlockReason[] {
  const reasons: LiveExecutionBlockReason[] = [];
  if (!input.bridge.running) {
    reasons.push('bridge-not-running');
  } else if (!input.bridge.authenticated || input.bridge.connectionCount !== 1) {
    reasons.push('bridge-not-authenticated');
  }
  if (input.feed === undefined) {
    reasons.push('table-feed-missing');
  } else {
    if (input.feed.state !== 'CONNECTED') reasons.push('table-feed-disconnected');
    if (
      input.feed.stalenessMs === undefined
      || !Number.isFinite(input.feed.stalenessMs)
      || input.feed.stalenessMs > input.maxFeedStalenessMs
    ) {
      reasons.push('table-feed-stale');
    }
  }
  if (input.projection.shoeBaseline !== 'physical-shoe') {
    reasons.push('physical-shoe-baseline-unknown');
  }
  if (input.projection.connectionStatus !== 'CONNECTED') {
    reasons.push('table-connection-not-restored');
  }
  if (input.projection.sealed) reasons.push('shoe-sealed');
  if (input.hasSettlementGap) reasons.push('settlement-gap');
  return reasons;
}

export function sanitizeIncidentMessage(message: string): string {
  const withoutUrlSecrets = String(message).replace(
    /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi,
    raw => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        return '[redacted-url]';
      }
    },
  );
  return withoutUrlSecrets
    .replace(/\b(token|authorization|cookie|session)\s*=\s*[^\s,;]+/gi, '$1=<redacted>')
    .slice(0, MAX_INCIDENT_MESSAGE_LENGTH);
}

function runtimeIncidentId(code: RuntimeIncidentCode, tableId: string | undefined, occurredAt: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${code}:${tableId ?? 'global'}:${occurredAt}:${suffix}`;
}

function readPersistedIncidents(value: unknown): RuntimeIncident[] {
  if (!isRecord(value)) return [];
  const incidents = Reflect.get(value, 'incidents');
  if (!Array.isArray(incidents)) return [];
  return incidents.flatMap(incident => isRuntimeIncident(incident) ? [incident] : []);
}

function isRuntimeIncident(value: unknown): value is RuntimeIncident {
  if (!isRecord(value)) return false;
  const code = Reflect.get(value, 'code');
  const severity = Reflect.get(value, 'severity');
  const tableId = Reflect.get(value, 'tableId');
  const acknowledgedAt = Reflect.get(value, 'acknowledgedAt');
  return isRuntimeIncidentCode(code)
    && (severity === 'degraded' || severity === 'blocked')
    && typeof Reflect.get(value, 'incidentId') === 'string'
    && typeof Reflect.get(value, 'message') === 'string'
    && (tableId === undefined || typeof tableId === 'string')
    && typeof Reflect.get(value, 'firstOccurredAt') === 'string'
    && typeof Reflect.get(value, 'lastOccurredAt') === 'string'
    && Number.isInteger(Reflect.get(value, 'occurrences'))
    && typeof Reflect.get(value, 'active') === 'boolean'
    && (acknowledgedAt === undefined || typeof acknowledgedAt === 'string');
}

function isRuntimeIncidentCode(value: unknown): value is RuntimeIncidentCode {
  return value === 'bridge-auth-failed'
    || value === 'bridge-disconnected'
    || value === 'continuity-invalidated'
    || value === 'table-feed-stale'
    || value === 'session-recovery-exhausted'
    || value === 'unknown-execution'
    || value === 'settlement-gap'
    || value === 'scheduler-failure'
    || value === 'monitor-failure';
}

function readApprovedLiveTableIds(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const tableIds = Reflect.get(value, 'tableIds');
  if (!Array.isArray(tableIds) || !tableIds.every(tableId => typeof tableId === 'string')) return null;
  return normalizeTableIds(tableIds);
}

function normalizeTableIds(tableIds: readonly string[]): string[] {
  return [...new Set(tableIds.map(tableId => tableId.trim()).filter(tableId => tableId.length > 0))];
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
