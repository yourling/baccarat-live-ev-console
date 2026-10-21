/**
 * P1-11 回归：`cursor.payloadHash` 是真实 payload hash，并且恢复要自证。
 *
 * 修复前（review/scripts/ledger/b8b）：
 *  - `cursor.payloadHash = event.eventId`（不是 hash），且没有任何代码校验它；
 *  - 新 session 发任意一条消息就 `markBridgeTransportContinuous()`，之后任意一条数据事件
 *    就能让 `restoreFromPending()` 用"桥自己的 cursor + 自己刚收到的事件"生成 cursor-v1 proof
 *    并恢复 —— 所谓"严格 continuity proof 才能恢复"完全自证。
 *
 * 修复后：
 *  - cursor.payloadHash = sha256(stableStringify(event))；
 *  - handleRestored 只接受 restoreFromPending() 刚生成的那一份 proof；
 *  - 恢复前校验上一游标与桥独立记录的真实 hash 一致，不一致则不恢复并记事故。
 */
import { describe, expect, it } from 'vitest';
import { sha256, stableStringify, type NormalizedEvent } from '@baccarat/contracts';
import { cursorContinuityProof } from '@baccarat/room-monitor';
import { BrowserBridgeServer, type BrowserBridgeRuntimeEvent } from '../src/index.js';

function event(overrides: Partial<NormalizedEvent> & { eventId: string; sourceSeq: number }): NormalizedEvent {
  return {
    type: 'newShoeSignal',
    tableId: 't1',
    timestamp: '2025-01-01T00:00:00.000Z',
    shoeId: 's1',
    baseline: 'unknown',
    profile: {
      tableId: 't1',
      numberOfDecks: 8,
      pairRule: { kind: 'standard' },
      odds: {
        bankerPair: { netWin: 11, loss: 1 },
        playerPair: { netWin: 11, loss: 1 },
      },
      burnModel: { kind: 'unknown' },
      minEV: 0,
      limits: { minBet: 1, maxBet: 1000 },
      autoConfirmNewShoe: true,
      betStrategy: { type: 'both' },
    },
    ...overrides,
  } as NormalizedEvent;
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 40));
}

describe('P1-11 payload hash and continuity self-proof', () => {
  it('writes a real sha256 payload hash into the export cursor', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const batches: Array<{ cursor: { payloadHash: string; eventId: string; sourceSeq: number } }> = [];
    await feed.start({ onBatch: batch => { batches.push(batch); } });
    try {
      const first = event({ eventId: 'e-hash-1', sourceSeq: 1 });
      server.ingestClientMessage({ kind: 'tableEvent', roomId: 'r1', tableId: 't1', event: first });
      await feed.flush();

      expect(batches).toHaveLength(1);
      const cursor = batches[0]!.cursor;
      // 关键断言：payloadHash 是真实 hash，**不等于** eventId。
      expect(cursor.payloadHash).toBe(sha256(stableStringify(first)));
      expect(cursor.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(cursor.payloadHash).not.toBe('e-hash-1');
      expect(cursor.eventId).toBe('e-hash-1');
    } finally {
      await server.close();
    }
  });

  it('rejects an unverified restore proof and keeps the export DISCONNECTED', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({ onRuntimeEvent: runtimeEvent => events.push(runtimeEvent) });
    const feed = server.openTable('r1', 't1');
    const restores: string[] = [];
    await feed.start({
      onBatch: () => {},
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    try {
      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: event({ eventId: 'e-proof-1', sourceSeq: 1 }),
      });
      await feed.flush();
      server.ingestClientMessage({
        kind: 'tableDisconnected',
        roomId: 'r1',
        tableId: 't1',
        reason: 'page hidden',
      });
      expect(feed.health().state).toBe('DISCONNECTED');

      // 伪造一条形状合法的 proof（旧实现只校验形状就会接受）。
      const forgedProof = cursorContinuityProof({ forged: true });
      const handleRestored = Reflect.get(feed, 'handleRestored') as (proof: string) => Promise<void>;
      await handleRestored.call(feed, forgedProof);
      await settle();

      expect(restores).toEqual([]);
      expect(feed.health().state).toBe('DISCONNECTED');
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'continuity-invalidated',
        reason: 'restore-proof-rejected:t1',
      }));
    } finally {
      await server.close();
    }
  });

  it('rejects a restore when the recorded cursor payload hash does not match the bridge hash', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({ onRuntimeEvent: runtimeEvent => events.push(runtimeEvent) });
    const feed = server.openTable('r1', 't1');
    const restores: string[] = [];
    await feed.start({
      onBatch: () => {},
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    try {
      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: event({ eventId: 'e-cursor-1', sourceSeq: 1 }),
      });
      await feed.flush();
      server.ingestClientMessage({
        kind: 'tableDisconnected',
        roomId: 'r1',
        tableId: 't1',
        reason: 'page hidden',
      });

      // 篡改游标里的 payloadHash：模拟"游标被外部/旧实现写坏"。
      const cursor = Reflect.get(feed, 'cursor') as { payloadHash: string };
      cursor.payloadHash = 'f'.repeat(64);

      // 下一条连续事件仍然存在，但游标自洽校验必须失败 → 不恢复。
      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: event({ eventId: 'e-cursor-2', sourceSeq: 2 }),
      });
      // rejectContinuity() 会把错误记进 this.error（fail-closed），flush() 因此会抛；
      // 这里只关心"没有恢复 + 有事故"，所以吞掉这个预期内的错误。
      await feed.flush().catch(() => undefined);
      await settle();

      expect(restores).toEqual([]);
      expect(feed.health().state).toBe('DISCONNECTED');
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'continuity-invalidated',
        reason: 'restore-cursor-mismatch:t1',
      }));
    } finally {
      await server.close();
    }
  });

  it('still restores from a genuine next continuous event (and only then)', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const restores: string[] = [];
    await feed.start({
      onBatch: () => {},
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    try {
      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: event({ eventId: 'e-ok-1', sourceSeq: 1 }),
      });
      await feed.flush();
      server.ingestClientMessage({
        kind: 'tableDisconnected',
        roomId: 'r1',
        tableId: 't1',
        reason: 'page hidden',
      });
      expect(feed.health().state).toBe('DISCONNECTED');

      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: event({ eventId: 'e-ok-2', sourceSeq: 2 }),
      });
      await feed.flush();

      expect(restores).toHaveLength(1);
      expect(restores[0]).toMatch(/^cursor-v1:[a-f0-9]{64}$/);
      expect(feed.health().state).toBe('CONNECTED');
      expect(feed.health().reconnectCount).toBe(1);
    } finally {
      await server.close();
    }
  });
});
