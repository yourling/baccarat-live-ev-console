import { SimulatedAdapter } from '@baccarat/adapter-contract';
import {
  defaultRiskLimits,
  type ManualCorrection,
  type NormalizedEvent,
  type RiskLimits,
  type TableProfile,
} from '@baccarat/contracts';
import { SqliteLedger } from '@baccarat/ledger-state';
import { Orchestrator, type OrchestratorSnapshot } from '@baccarat/orchestrator';
import { buildRandomDemo } from '../src/core-demo.js';

export interface DesktopConsoleSnapshot {
  dbPath: string;
  isOpen: boolean;
  seed?: number;
  snapshot: OrchestratorSnapshot;
  events: NormalizedEvent[];
  decisions: ReturnType<SqliteLedger['listDecisions']>;
  receipts: ReturnType<SqliteLedger['listReceipts']>;
  reservations: ReturnType<Orchestrator['getReservations']>;
}

function defaultConsoleLimits(): RiskLimits {
  return {
    ...defaultRiskLimits,
    defaultExposureCap: 100_000,
    perTableLossLimit: 100_000,
    perShoeLossLimit: 100_000,
    perDayLossLimit: 1_000_000,
    maxConcurrentExecutions: 4,
    insufficientBehavior: 'skip',
  };
}

export class DesktopConsoleService {
  private readonly ledger: SqliteLedger;
  private readonly orchestrator: Orchestrator;
  private lastSeed?: number;
  private demoRunning = false;

  constructor(readonly dbPath: string) {
    this.ledger = new SqliteLedger(dbPath);
    this.orchestrator = new Orchestrator({
      ledger: this.ledger,
      riskLimits: defaultConsoleLimits(),
      executor: new SimulatedAdapter({ events: [] }),
    });
  }

  isOpen(): boolean {
    return this.ledger.isOpen();
  }

  snapshot(): DesktopConsoleSnapshot {
    return {
      dbPath: this.dbPath,
      isOpen: this.ledger.isOpen(),
      seed: this.lastSeed,
      snapshot: this.orchestrator.snapshot(),
      events: this.ledger.listEvents(),
      decisions: this.ledger.listDecisions(),
      receipts: this.ledger.listReceipts(),
      reservations: this.orchestrator.getReservations(),
    };
  }

  async runDemo(seed?: number): Promise<DesktopConsoleSnapshot> {
    if (this.demoRunning) throw new Error('demo stream is already running');
    this.demoRunning = true;
    try {
      return await this.runDemoInner(seed);
    } finally {
      this.demoRunning = false;
    }
  }

  private async runDemoInner(seed?: number): Promise<DesktopConsoleSnapshot> {
      const demo = buildRandomDemo(seed);
      this.lastSeed = demo.seed;
      const amounts = { [demo.profiles[0].tableId]: 100, [demo.profiles[1].tableId]: 80 } as const;
      for (const profile of demo.profiles) {
        this.orchestrator.registerTable(profile, 'simulated', amounts[profile.tableId as keyof typeof amounts] ?? 100);
      }
      const promises: Promise<void>[] = [];
      for (const profile of demo.profiles) {
        for (const event of demo.streams[profile.tableId]) {
          promises.push(this.orchestrator.enqueue(profile.tableId, event));
        }
      }
      await Promise.all(promises);
      await this.orchestrator.flush();
      return this.snapshot();
    }

  async registerTable(
    profile: TableProfile,
    executionMode: 'shadow' | 'simulated',
    defaultBetAmount: number,
  ): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.registerTable(profile, executionMode, defaultBetAmount);
    return this.snapshot();
  }

  async injectEvent(event: NormalizedEvent): Promise<DesktopConsoleSnapshot> {
    await this.orchestrator.enqueue(event.tableId, event);
    return this.snapshot();
  }

  async setAutoBet(tableId: string, armed: boolean, shoeId?: string): Promise<DesktopConsoleSnapshot> {
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) throw new Error(`unknown table ${tableId}`);
    await actor.setAutoBet(armed, shoeId);
    return this.snapshot();
  }

  async applyManualCorrection(
    tableId: string,
    correction: ManualCorrection,
    shoeId?: string,
  ): Promise<DesktopConsoleSnapshot> {
    const actor = this.orchestrator.getActor(tableId);
    if (!actor) throw new Error(`unknown table ${tableId}`);
    await actor.applyManualCorrection(correction, shoeId);
    return this.snapshot();
  }

  async updateRiskLimits(limits: RiskLimits): Promise<DesktopConsoleSnapshot> {
    this.orchestrator.updateRiskLimits(limits);
    return this.snapshot();
  }

  async close(): Promise<void> {
    await this.orchestrator.close();
  }
}
