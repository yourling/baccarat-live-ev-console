import {
  isOperationalWagerMarket,
  type OperationalWagerExecutionRequest,
  type OperationalWagerMarket,
  type OperationalWagerReceipt,
  type OperationalWagerSource,
} from '@baccarat/adapter-contract';
import { newId, type AutoBetStatus, type ConnectionStatus, type ShoeBaseline, type TableStatus } from '@baccarat/contracts';
import {
  SqliteLedger,
  type OperationalWagerRecord,
} from '@baccarat/ledger-state';
import {
  tryKeepaliveInOrder,
  type KeepaliveWagerMarket,
} from './operational-wager.js';

const KEEPALIVE_CONFIG_KEY = 'desktop:operational-keepalive:v1';
const KEEPALIVE_TICK_MS = 15_000;

type OperationalWagerBridge = {
  requestOperationalWager(request: OperationalWagerExecutionRequest): Promise<OperationalWagerReceipt | null>;
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

export type OperationalWagerResult = {
  readonly status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  readonly tableId: string;
  readonly reason?: string;
  readonly wager?: OperationalWagerRecord['wager'];
  readonly receipt?: OperationalWagerReceipt;
};

export interface OperationalWagerCoordinatorOptions {
  readonly ledger: SqliteLedger;
  readonly bridge: () => OperationalWagerBridge | undefined;
  readonly monitorTableIds: () => readonly string[];
  readonly tableState: (tableId: string) => OperationalWagerTableState | undefined;
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
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
      void this.tick().catch(options.onError ?? (error => console.error('operational keepalive tick failed', error)));
    }, KEEPALIVE_TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    clearInterval(this.timer);
  }

  getKeepaliveState(): KeepaliveState {
    return { ...this.state, running: this.running };
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
      const bridge = this.options.bridge();
      const result = bridge === undefined
        ? { status: 'REJECTED' as const, tableId: null, attempted: false, reason: 'browser-bridge-unavailable' }
        : await tryKeepaliveInOrder({
          tableIds: this.options.monitorTableIds(),
          market: this.state.market,
          amount: this.state.amount,
          requestWager: async (tableId, market, amount) => {
            const response = await this.execute({
              tableId,
              market,
              amount,
              source: 'keepalive',
            }, bridge, now);
            return {
              status: response.status,
              attempted: response.wager !== undefined,
              ...(response.reason === undefined ? {} : { reason: response.reason }),
            };
          },
        });
      const shouldRecordAttempt = result.status !== 'REJECTED' || result.attempted;
      if (shouldRecordAttempt) {
        this.state = {
          ...this.state,
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
      return await this.execute({ ...input, source: 'manual' }, this.options.bridge(), new Date());
    });
  }

  private async execute(
    input: {
      readonly tableId: string;
      readonly market: OperationalWagerMarket;
      readonly amount: number;
      readonly source: OperationalWagerSource;
    },
    bridge: OperationalWagerBridge | undefined,
    now: Date,
  ): Promise<OperationalWagerResult> {
    if (!isOperationalWagerMarket(input.market)) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'unsupported-market' };
    }
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'invalid-amount' };
    }
    if (!this.options.monitorTableIds().includes(input.tableId)) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'table-not-monitored' };
    }
    const table = this.options.tableState(input.tableId);
    if (table === undefined) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'table-unavailable' };
    }
    const gateReason = operationalWagerGateReason(table, input.source);
    if (gateReason !== null) {
      return { status: 'REJECTED', tableId: input.tableId, reason: gateReason };
    }
    const isManualTest = input.source === 'manual' && table.executionMode !== 'live';
    const currentHandId = table.projection.currentHandId;
    if (!isManualTest && (currentHandId === null || currentHandId.length === 0)) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'current-hand-required' };
    }
    const wagerId = newId('opw');
    const wager: OperationalWagerRecord['wager'] = {
      wagerId,
      tableId: input.tableId,
      shoeId: table.projection.shoeId,
      handId: currentHandId ?? `manual-test-${wagerId}`,
      market: input.market,
      amount: input.amount,
      source: input.source,
      createdAt: now.toISOString(),
    };
    if (table.executionMode !== 'live') {
      return this.saveResult(wager, 'ACCEPTED', `${table.executionMode}-simulated`);
    }
    if (bridge === undefined) {
      return { status: 'REJECTED', tableId: input.tableId, reason: 'browser-bridge-unavailable' };
    }
    const request: OperationalWagerExecutionRequest = { mode: 'live', wager };
    let receipt: OperationalWagerReceipt | null;
    try {
      receipt = await bridge.requestOperationalWager(request);
    } catch (error) {
      return this.saveResult(wager, 'UNKNOWN', 'bridge-request-error');
    }
    if (receipt === null) {
      return this.saveResult(wager, 'UNKNOWN', 'bridge-no-receipt');
    }
    if (!receiptMatchesWager(receipt, wager)) {
      return this.saveResult(wager, 'UNKNOWN', 'bridge-receipt-mismatch');
    }
    return this.saveResult(
      wager,
      receipt.status,
      undefined,
      receipt,
    );
  }

  private saveResult(
    wager: OperationalWagerRecord['wager'],
    status: OperationalWagerResult['status'],
    reason?: string,
    receipt?: OperationalWagerReceipt,
  ): OperationalWagerResult {
    this.options.ledger.saveOperationalWager({
      wager,
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(receipt === undefined ? {} : { receipt }),
    });
    return {
      status,
      tableId: wager.tableId,
      wager,
      ...(reason === undefined ? {} : { reason }),
      ...(receipt === undefined ? {} : { receipt }),
    };
  }

  private persist(): void {
    this.options.ledger.setConfig(KEEPALIVE_CONFIG_KEY, this.state);
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

function operationalWagerGateReason(
  table: OperationalWagerTableState,
  source: OperationalWagerSource,
): string | null {
  if (source === 'manual' && table.executionMode !== 'live') return null;
  if (source === 'keepalive' && table.executionMode !== 'live') return 'live-execution-required';
  if (table.projection.connectionStatus !== 'CONNECTED') return 'connected-required';
  if (table.projection.status !== 'BETTING_WINDOW') return 'betting-window-required';
  if (table.projection.sealed) return 'shoe-sealed';
  if (source !== 'keepalive' && table.projection.autoBetStatus === 'ARMED') return 'auto-bet-armed';
  return null;
}

function receiptMatchesWager(
  receipt: OperationalWagerReceipt,
  wager: OperationalWagerRecord['wager'],
): boolean {
  return receipt.wagerId === wager.wagerId
    && receipt.tableId === wager.tableId
    && receipt.shoeId === wager.shoeId
    && receipt.handId === wager.handId
    && receipt.market === wager.market
    && receipt.amount === wager.amount
    && receipt.source === wager.source;
}
