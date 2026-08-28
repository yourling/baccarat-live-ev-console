import {
  isOperationalWagerMarket,
  type OperationalWagerMarket,
  type OperationalWagerSource,
} from '@baccarat/adapter-contract';
import type { AutoBetStatus, ConnectionStatus, ShoeBaseline, TableStatus } from '@baccarat/contracts';
import { SqliteLedger } from '@baccarat/ledger-state';
import type {
  ControlledOperationalWagerCommand,
  ControlledOperationalWagerResult,
} from '@baccarat/orchestrator';
import {
  tryKeepaliveInOrder,
  type KeepaliveWagerMarket,
} from './operational-wager.js';

const KEEPALIVE_CONFIG_KEY = 'desktop:operational-keepalive:v1';
const KEEPALIVE_TICK_MS = 15_000;

type OperationalWagerActor = {
  placeOperationalWager(
    command: ControlledOperationalWagerCommand,
  ): Promise<ControlledOperationalWagerResult>;
};

export type OperationalWagerTableState = {
  readonly tableId: string;
  readonly executionMode: 'shadow' | 'simulated' | 'live';
  readonly projection: {
    readonly shoeId: string;
    readonly shoeBaseline: ShoeBaseline;
    readonly status: TableStatus;
    readonly currentHandId: string | null;
    readonly autoBetStatus: AutoBetStatus;
    readonly connectionStatus: ConnectionStatus;
    readonly sealed: boolean;
  };
};

export interface KeepaliveStrategySettings {
  readonly intervalMinutes: number;
  readonly market: KeepaliveWagerMarket;
  readonly amount: number;
}

export interface KeepaliveSettings extends KeepaliveStrategySettings {
  readonly enabled: boolean;
}

export interface KeepaliveState extends KeepaliveSettings {
  readonly lastAttemptAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastStatus?: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  readonly lastTableId?: string;
  readonly lastReason?: string;
  readonly running: boolean;
}

type PersistedKeepaliveState = Omit<KeepaliveState, 'running'>;

export type OperationalWagerResult = ControlledOperationalWagerResult;

export interface OperationalWagerCoordinatorOptions {
  readonly ledger: SqliteLedger;
  readonly actor: (tableId: string) => OperationalWagerActor | undefined;
  readonly monitorTableIds: () => readonly string[];
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly runtimeBlockReason?: (
    tableId: string,
    source: OperationalWagerSource,
  ) => string | undefined;
  readonly onError?: (error: unknown) => void;
}

export class OperationalWagerCoordinator {
  private readonly options: OperationalWagerCoordinatorOptions;
  private state: PersistedKeepaliveState;
  private running = false;
  private readonly timer: NodeJS.Timeout;

  constructor(options: OperationalWagerCoordinatorOptions) {
    this.options = options;
    this.state = readKeepaliveState(options.ledger.getConfig<unknown>(KEEPALIVE_CONFIG_KEY)) ?? defaultKeepaliveState();
    options.ledger.setConfig(KEEPALIVE_CONFIG_KEY, this.state);
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.reportTickError(error));
    }, KEEPALIVE_TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    clearInterval(this.timer);
  }

  getKeepaliveState(): KeepaliveState {
    return { ...this.state, running: this.running };
  }

  disableKeepaliveImmediately(): void {
    if (!this.state.enabled) return;
    this.state = { ...this.state, enabled: false };
    this.persist();
  }

  async updateKeepalive(settings: KeepaliveSettings, now = new Date()): Promise<KeepaliveState> {
    assertKeepaliveSettings(settings);
    const newlyEnabled = settings.enabled && !this.state.enabled;
    this.state = newlyEnabled ? { ...settings } : { ...this.state, ...settings };
    this.persist();
    if (newlyEnabled) await this.tickInner(now);
    return this.getKeepaliveState();
  }

  async tick(now = new Date()): Promise<void> {
    await this.options.serialize(async () => {
      await this.tickInner(now);
    });
  }

  private async tickInner(now: Date): Promise<void> {
    if (!this.state.enabled || this.running || !keepaliveDue(this.state, now)) return;
    this.running = true;
    try {
      const result = await tryKeepaliveInOrder({
        tableIds: this.options.monitorTableIds(),
        market: this.state.market,
        amount: this.state.amount,
        requestWager: async (tableId, market, amount) => {
          const response = await this.execute({
            tableId,
            market,
            amount,
            source: 'keepalive',
          }, now);
          return {
            status: response.status,
            attempted: response.wager !== undefined,
            committed: receiptCommitStarted(response),
            ...(response.reason === undefined ? {} : { reason: response.reason }),
          };
        },
      });
      const shouldRecordAttempt = result.status !== 'REJECTED' || result.attempted;
      if (shouldRecordAttempt) {
        this.state = {
          ...this.state,
          ...(result.status === 'UNKNOWN' ? { enabled: false } : {}),
          lastAttemptAt: now.toISOString(),
          lastStatus: result.status,
          ...(result.tableId === null ? {} : { lastTableId: result.tableId }),
          ...(result.reason === undefined ? {} : { lastReason: result.reason }),
          ...(result.status === 'ACCEPTED' ? { lastSuccessAt: now.toISOString() } : {}),
        };
        this.persist();
      }
    } finally {
      this.running = false;
    }
  }

  async executeManual(input: {
    readonly tableId: string;
    readonly market: OperationalWagerMarket;
    readonly amount: number;
  }): Promise<OperationalWagerResult> {
    return await this.options.serialize(async () => {
      return await this.execute({ ...input, source: 'manual' }, new Date());
    });
  }

  private async execute(
    input: {
      readonly tableId: string;
      readonly market: OperationalWagerMarket;
      readonly amount: number;
      readonly source: OperationalWagerSource;
    },
    now: Date,
  ): Promise<OperationalWagerResult> {
    if (input.source === 'keepalive' && !this.state.enabled) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'global-automation-disabled' };
    }
    if (!isOperationalWagerMarket(input.market)) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'unsupported-market' };
    }
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'invalid-amount' };
    }
    if (!this.options.monitorTableIds().includes(input.tableId)) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'table-not-monitored' };
    }
    const runtimeBlockReason = this.options.runtimeBlockReason?.(input.tableId, input.source);
    if (runtimeBlockReason !== undefined) {
      return { status: 'REJECTED', tableId: input.tableId, reason: runtimeBlockReason };
    }
    const actor = this.options.actor(input.tableId);
    if (actor === undefined) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'table-unavailable' };
    }
    const result = await actor.placeOperationalWager({
      market: input.market,
      amount: input.amount,
      source: input.source,
      createdAt: now.toISOString(),
    });
    if (result.status === 'UNKNOWN') this.disableKeepaliveImmediately();
    return result;
  }

  private persist(): void {
    this.options.ledger.setConfig(KEEPALIVE_CONFIG_KEY, this.state);
  }

  private reportTickError(error: unknown): void {
    try {
      if (this.options.onError) {
        this.options.onError(error);
        return;
      }
      console.error('operational keepalive tick failed', error);
    } catch (reportingError) {
      console.error('operational keepalive error reporter failed', reportingError);
    }
  }
}

function defaultKeepaliveState(): PersistedKeepaliveState {
  return {
    enabled: false,
    intervalMinutes: 10,
    market: 'banker',
    amount: 20,
  };
}

function readKeepaliveState(value: unknown): PersistedKeepaliveState | null {
  if (!isRecord(value)) return null;
  const enabled = Reflect.get(value, 'enabled');
  const intervalMinutes = Reflect.get(value, 'intervalMinutes');
  const market = Reflect.get(value, 'market');
  const amount = Reflect.get(value, 'amount');
  if (
    typeof enabled !== 'boolean'
    || typeof intervalMinutes !== 'number'
    || typeof market !== 'string'
    || typeof amount !== 'number'
    || !isKeepaliveWagerMarket(market)
  ) {
    return null;
  }
  const candidate: KeepaliveSettings = { enabled, intervalMinutes, market, amount };
  try {
    assertKeepaliveSettings(candidate);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return {
    ...candidate,
    ...readOptionalString(value, 'lastAttemptAt'),
    ...readOptionalString(value, 'lastSuccessAt'),
    ...readOptionalStatus(value, 'lastStatus'),
    ...readOptionalString(value, 'lastTableId'),
    ...readOptionalString(value, 'lastReason'),
  };
}

function readOptionalString(value: object, field: string): Record<string, string> {
  const raw = Reflect.get(value, field);
  return typeof raw === 'string' && raw.length > 0 ? { [field]: raw } : {};
}

function readOptionalStatus(value: object, field: string): Record<string, OperationalWagerResult['status']> {
  const raw = Reflect.get(value, field);
  return raw === 'ACCEPTED' || raw === 'REJECTED' || raw === 'UNKNOWN' ? { [field]: raw } : {};
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function receiptCommitStarted(result: OperationalWagerResult): boolean {
  const raw = result.receipt?.raw;
  return isRecord(raw) && Reflect.get(raw, 'commitStarted') === true;
}

function isKeepaliveWagerMarket(value: string): value is KeepaliveWagerMarket {
  return value === 'banker' || value === 'player';
}

function assertKeepaliveSettings(settings: KeepaliveSettings): void {
  if (!Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 1 || settings.intervalMinutes > 1_440) {
    throw new RangeError('keepalive interval must be an integer from 1 to 1440 minutes');
  }
  if (!Number.isFinite(settings.amount) || settings.amount <= 0) {
    throw new RangeError('keepalive amount must be a positive finite number');
  }
}

function keepaliveDue(state: PersistedKeepaliveState, now: Date): boolean {
  if (state.lastAttemptAt === undefined) return true;
  const lastAttemptAt = Date.parse(state.lastAttemptAt);
  if (Number.isNaN(lastAttemptAt)) return true;
  return now.valueOf() - lastAttemptAt >= state.intervalMinutes * 60_000;
}
