export * from './normalizer.js';
import type {
  BetIntent,
  BetReceipt,
  NormalizedEvent,
  RawObservation,
} from '@baccarat/contracts';

export type { RawObservation, EvidenceLevel } from '@baccarat/contracts';

export interface AdapterEventCallback {
  (event: NormalizedEvent): void;
}

export interface KeepAliveResult {
  ok: boolean;
  latencyMs?: number;
  raw?: unknown;
}

export interface BetExecutionRequest {
  intent: BetIntent;
  mode: 'simulated' | 'shadow' | 'live';
  reservationId?: string;
}

export interface TableEventSource {
  readonly tableId: string;
  start(callback: AdapterEventCallback): Promise<void>;
  stop(): Promise<void>;
  keepAlive(): Promise<KeepAliveResult>;
}

export interface BrowserAdapter extends TableEventSource {
  readonly displayName: string;
  requestBet(req: BetExecutionRequest): Promise<BetReceipt | null>;
}

export interface SimulatedAdapterOptions {
  events: NormalizedEvent[];
  simulateLatencyMs?: number;
}

export class SimulatedAdapter implements BrowserAdapter {
  readonly tableId: string;
  readonly displayName = 'SimulatedAdapter';
  private started = false;

  constructor(private readonly options: SimulatedAdapterOptions) {
    this.tableId = options.events[0]?.tableId ?? 'sim-table';
  }

  async start(callback: AdapterEventCallback): Promise<void> {
    this.started = true;
    for (const event of this.options.events) {
      callback(event);
      if (this.options.simulateLatencyMs && this.options.simulateLatencyMs > 0) {
        await delay(this.options.simulateLatencyMs);
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async keepAlive(): Promise<KeepAliveResult> {
    return { ok: this.started, latencyMs: 1 };
  }

  async requestBet(req: BetExecutionRequest): Promise<BetReceipt | null> {
    if (req.mode !== 'simulated') return null;
    if (this.options.simulateLatencyMs && this.options.simulateLatencyMs > 0) {
      await delay(this.options.simulateLatencyMs);
    }
    const now = new Date().toISOString();
    return {
      receiptId: `sim_receipt_${req.intent.intentId}`,
      intentId: req.intent.intentId,
      reservationId: req.reservationId ?? 'sim_reservation',
      status: 'SIMULATED',
      amount: req.intent.amount,
      market: req.intent.market,
      mode: 'simulated',
      externalRef: 'simulated',
      createdAt: now,
      raw: { simulated: true },
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
