/**
 * Demo 演示流切片：从 DesktopConsoleService 拆出的模拟数据注入器。
 * 通过 DemoConsoleHost 回访宿主（账本 / 编排器 / 执行器切换 / 快照）。
 */
import {
  EVENT_SCHEMA_VERSION,
  newId,
  type NormalizedEvent,
  type TableProfile,
} from '@baccarat/contracts';
import { SimulatedAdapter, type BrowserAdapter } from '@baccarat/adapter-contract';
import { ShadowRoomMonitor, type TableExport } from '@baccarat/room-monitor';
import type { SqliteLedger } from '@baccarat/ledger-state';
import type { Orchestrator } from '@baccarat/orchestrator';
import { buildRandomDemo } from '../src/core-demo.js';
import type { DesktopConsoleSnapshot } from './service.js';

const DEMO_EVENT_INTERVAL_MS = 300;
const DEMO_PAUSE_MS = 800;

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export interface DemoConsoleHost {
  readonly ledger: SqliteLedger;
  readonly orchestrator: Orchestrator;
  /** 最近一次错误（demo 与监控共用同一展示面）。 */
  demoError?: string;
  currentExecutor: Pick<BrowserAdapter, 'requestBet'> | null;
  snapshot(): DesktopConsoleSnapshot;
  nextMonitorSourceSeq(tableId: string): number;
  setOrchestratorExecutor(executor: Pick<BrowserAdapter, 'requestBet'> | null): void;
  lastFeedDisconnectReason: Map<string, string>;
}

export class DemoConsole {
  demoRunning = false;
  demoSpeed = 1;
  demoStopRequested = false;
  demoTask: Promise<void> | null = null;
  lastSeed?: number;

  constructor(private readonly host: DemoConsoleHost) {}

  async runDemo(seed?: number): Promise<DesktopConsoleSnapshot> {
    if (this.demoRunning) throw new Error('demo stream is already running');
    this.demoRunning = true;
    this.demoStopRequested = false;
    try {
      return await this.runDemoInner(seed);
    } finally {
      this.demoRunning = false;
    }
  }

  async startDemo(seed?: number): Promise<DesktopConsoleSnapshot> {
    if (this.demoRunning) return this.host.snapshot();
    this.demoRunning = true;
    this.demoStopRequested = false;
    this.demoTask = this.runContinuousDemo(seed)
      .catch(error => {
        this.host.demoError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.demoRunning = false;
        this.demoTask = null;
      });
    return this.host.snapshot();
  }

  async stopDemo(): Promise<DesktopConsoleSnapshot> {
    this.demoStopRequested = true;
    if (this.demoTask) await this.demoTask;
    return this.host.snapshot();
  }

  setDemoSpeed(speed: number): DesktopConsoleSnapshot {
    if (!Number.isInteger(speed) || speed < 1 || speed > 10) {
      throw new RangeError('demo speed must be an integer from 1 to 10');
    }
    this.demoSpeed = speed;
    return this.host.snapshot();
  }

  private async runContinuousDemo(seed?: number): Promise<void> {
    let nextSeed = seed;
    while (!this.demoStopRequested) {
      await this.runDemoInner(nextSeed, true);
      nextSeed = undefined;
      if (!this.demoStopRequested) await wait(DEMO_PAUSE_MS / this.demoSpeed);
    }
  }

  private async runDemoInner(seed?: number, paced = false): Promise<DesktopConsoleSnapshot> {
    const sessionStartedAt = new Date();
    const demo = buildRandomDemo(seed, newId('demo'));
    const shoeIds = buildShoeIdMap(demo, this.host.ledger, sessionStartedAt);
    this.lastSeed = demo.seed;
    const amounts = { [demo.profiles[0].tableId]: 100, [demo.profiles[1].tableId]: 80 } as const;
    const configuredProfiles = new Map<string, TableProfile>();
    const demoTableIds = demo.profiles.map(profile => profile.tableId);
    for (const profile of demo.profiles) {
      const existingActor = this.host.orchestrator.getActor(profile.tableId);
      const existingProfile = existingActor?.getProfile();
      const effectiveProfile: TableProfile = {
        ...profile,
        minEV: existingProfile?.minEV ?? profile.minEV,
        betTiers: existingProfile?.betTiers ?? profile.betTiers,
        monitorUrl: existingProfile?.monitorUrl ?? profile.monitorUrl,
      };
      const defaultBetAmount = existingActor?.snapshot().defaultBetAmount
        ?? amounts[profile.tableId as keyof typeof amounts]
        ?? 100;
      configuredProfiles.set(profile.tableId, effectiveProfile);
      this.host.orchestrator.registerTable(effectiveProfile, 'simulated', defaultBetAmount);
    }

    // 监控层使用“源内局部序号”做游标/缺口检测；账本 sourceSeq 由消费方在导出时按账本水位分配。
    const streams = new Map<string, NormalizedEvent[]>();
    for (const profile of demo.profiles) {
      const tableId = profile.tableId;
      const effectiveProfile = configuredProfiles.get(tableId)!;
      const stream = demo.streams[tableId].map(event => {
        const remappedEvent = remapDemoEvent(event, tableId, shoeIds, sessionStartedAt);
        return remappedEvent.type === 'newShoeSignal'
          ? { ...remappedEvent, profile: effectiveProfile }
          : remappedEvent;
      });
      streams.set(tableId, stream);
    }

    const room = {
      roomId: 'demo-room',
      displayName: 'Demo Room',
      tables: [...configuredProfiles].map(([tableId, profile]) => ({
        tableId,
        profile,
        events: streams.get(tableId)!,
        monitorUrl: profile.monitorUrl,
        maxBatchSize: paced ? 1 : 20,
        latencyMs: paced ? DEMO_EVENT_INTERVAL_MS / this.demoSpeed : 0,
      })),
    };
    const monitor = new ShadowRoomMonitor({ rooms: [room] });
    const feeds: TableExport[] = [];
    try {
      const rooms = await monitor.discoverRooms();
      for (const table of rooms[0].tables) {
        let feed: TableExport;
        feed = monitor.openTable(room.roomId, table.tableId);
        await feed.start({
          onBatch: async batch => {
            if (this.demoStopRequested) {
              feed.stop();
              return;
            }
            for (const event of batch.events) {
              const sourceSeq = this.host.nextMonitorSourceSeq(event.tableId);
              await this.host.orchestrator.enqueue(event.tableId, { ...event, sourceSeq });
            }
          },
          onDisconnect: (tableId, reason) => {
            this.host.lastFeedDisconnectReason.set(tableId, reason ?? '');
            const sourceSeq = this.host.nextMonitorSourceSeq(tableId);
            void this.host.orchestrator.enqueue(tableId, {
              type: 'connectionLost',
              eventId: newId('evt'),
              tableId,
              timestamp: new Date().toISOString(),
              sourceSeq,
              source: 'room-monitor',
              schemaVersion: EVENT_SCHEMA_VERSION,
              ...(reason ? { reason } : {}),
            });
          },
          onRestored: async (tableId, proof) => {
            const sourceSeq = this.host.nextMonitorSourceSeq(tableId);
            await this.host.orchestrator.enqueue(tableId, {
              type: 'connectionRestored',
              eventId: newId('evt'),
              tableId,
              timestamp: new Date().toISOString(),
              sourceSeq,
              source: 'room-monitor',
              schemaVersion: EVENT_SCHEMA_VERSION,
              continuityProof: proof,
            });
          },
        });
        feeds.push(feed);
      }
      await Promise.all(feeds.map(feed => feed.flush()));
      await this.host.orchestrator.flush();
    } finally {
      await monitor.close();
      // FIX(D-P1-5): 只还原 **demo 专用 actor** 的 executor，绝不碰全局 executor。
      for (const tableId of demoTableIds) {
        this.host.orchestrator.getActor(tableId)?.setExecutor(null);
      }
    }
    return this.host.snapshot();
  }
}

function buildShoeIdMap(
  demo: ReturnType<typeof buildRandomDemo>,
  ledger: SqliteLedger,
  startedAt: Date,
): Map<string, string> {
  const minute = formatShoeMinute(startedAt);
  const result = new Map<string, string>();
  for (const profile of demo.profiles) {
    let nextSequence = 1;
    const existing = ledger.listEvents(profile.tableId);
    for (const event of existing) {
      if (event.type !== 'newShoeSignal') continue;
      const match = event.shoeId.match(new RegExp('^' + minute + '-([0-9]{3})$'));
      if (match) nextSequence = Math.max(nextSequence, Number(match[1]) + 1);
    }
    for (const event of demo.streams[profile.tableId]) {
      if (event.type !== 'newShoeSignal') continue;
      const key = profile.tableId + '|' + event.shoeId;
      result.set(key, minute + '-' + String(nextSequence).padStart(3, '0'));
      nextSequence += 1;
    }
  }
  return result;
}

function remapDemoEvent(
  event: NormalizedEvent,
  tableId: string,
  shoeIds: Map<string, string>,
  startedAt: Date,
): NormalizedEvent {
  const timestamp = new Date(startedAt.getTime() + Math.max(0, event.sourceSeq - 1) * 1000).toISOString();
  const next = { ...event, timestamp } as NormalizedEvent;
  if ('closesAt' in event && typeof event.closesAt === 'string') {
    const originalTs = Date.parse(event.timestamp);
    const remappedTs = Date.parse(timestamp);
    const originalClose = Date.parse(event.closesAt);
    if (Number.isFinite(originalTs) && Number.isFinite(remappedTs) && Number.isFinite(originalClose)) {
      (next as { closesAt: string }).closesAt = new Date(remappedTs + (originalClose - originalTs)).toISOString();
    }
  }
  const oldShoeId = 'shoeId' in event && typeof event.shoeId === 'string' ? event.shoeId : undefined;
  const newShoeId = oldShoeId ? shoeIds.get(tableId + '|' + oldShoeId) : undefined;
  if (newShoeId && 'shoeId' in next && typeof next.shoeId === 'string') {
    (next as { shoeId: string }).shoeId = newShoeId;
  }
  if (oldShoeId && newShoeId && 'handId' in next && typeof next.handId === 'string' && next.handId.startsWith(oldShoeId)) {
    (next as { handId: string }).handId = newShoeId + next.handId.slice(oldShoeId.length);
  }
  return next;
}

function formatShoeMinute(value: Date): string {
  const pad2 = (number: number) => String(number).padStart(2, '0');
  return String(value.getFullYear()) + pad2(value.getMonth() + 1) + pad2(value.getDate())
    + pad2(value.getHours()) + pad2(value.getMinutes());
}
