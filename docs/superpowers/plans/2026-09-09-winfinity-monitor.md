# Winfinity 桃园厅监控采集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用第三条独立扩展把 Dafabet 桃园厅（Winfinity 多桌）接入中控台，只做发现/跟靴/开窗/发牌/结算，不下注，不改 Pragmatic/BG 钩子。

**Architecture:** 扩展只认 `tao-yuan-baccarat` 与 `*.youngpoisson.xyz`，把 JSON 文本 WS 帧标成 `baccarat-bridge-winfinity-ws`，大厅短号映射走 `baccarat-bridge-winfinity-state`。桥用 `WinfinityRuntimeParser` 收成现有 `NormalizedEvent`，房间固定 `dafabet-winfinity`。本机桥仍只接受一条扩展连接。

**Tech Stack:** TypeScript、Vitest、Chrome MV3 扩展（extraResources，非 workspace）、`@baccarat/browser-bridge`、`@baccarat/contracts`。

**Spec:** `docs/superpowers/specs/2026-09-09-winfinity-monitor-design.md`

## Global Constraints

- 第一期监控 + 采集，不做 Winfinity 真金下注；下注返回 `REJECTED`，`raw.reason` 含 `winfinity-monitor-only`，`commitStarted: false`。
- 运行时与 Pragmatic/BG 互斥：一条扩展连接、一个 executor lease。
- 房间 id 固定 `dafabet-winfinity`，显示名「Dafabet Winfinity」。
- 控制台 `tableId` 用 `streamId`（如 `tyn-bac8`）或 `wnf-<24hex>`；禁止裸 24 位 hex（会撞 Pragmatic 车道）。
- 第一次见到协议 `shoeId` 只记 token（`attach`），不升实体靴；token 再次变化才 `protocol-shuffle`。
- 不修改 `apps/browser-extension/**`、`apps/browser-extension-bg/**` 钩子，不改 `packages/contracts` 事件形状。
- 代码 2 空格缩进。合入实现时 `CONSOLE_VERSION` 与根/`apps/desktop` `package.json` patch +1。
- 每个生产行为先写失败测试，用 `npx vitest run --config vitest.config.ts <file>` 跑。

## File map

| 文件 | 职责 |
|---|---|
| `packages/browser-bridge/src/winfinity-runtime.ts` | 桌号、别名锁定、WS JSON → `NormalizedEvent` |
| `packages/browser-bridge/src/identity.ts` | 第三扩展 ID、房间常量 |
| `packages/browser-bridge/src/server.ts` | capture source、房间、拒绝下注、`roomIdForTable` |
| `apps/browser-extension-winfinity/*` | 桃园弹窗采集扩展，无 bet-runtime |
| `apps/desktop/src/ui/monitor-table-selection.ts` | 监控房间白名单 |
| `apps/desktop/electron-src/service.ts` | 桌号校验、待加入、晋升 |
| `scripts/check-extension-syntax.mjs` | 语法检查扫新扩展 |
| `apps/desktop/package.json` | extraResources 打包扩展 |

---

### Task 1: 桌号规则与别名锁定

**Files:**
- Create: `packages/browser-bridge/src/winfinity-runtime.ts`
- Test: `packages/browser-bridge/test/winfinity-runtime.test.ts`
- Modify: `packages/browser-bridge/src/index.ts`（增加 `export * from './winfinity-runtime.js'`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `WINFINITY_STREAM_ID_PATTERN: RegExp` = `/^[a-z0-9]+-bac\d+$/i`
  - `WINFINITY_FALLBACK_TABLE_ID_PATTERN: RegExp` = `/^wnf-[a-f0-9]{24}$/i`
  - `WINFINITY_VENDOR_TABLE_ID_PATTERN: RegExp` = `/^[a-f0-9]{24}$/i`
  - `publicWinfinityTableId(input: { streamId?: string; vendorTableId?: string }): string | undefined`
  - `normalizeWinfinityTableId(tableId: string): string | undefined`
  - `class WinfinityRuntimeParser` with `registerAlias(vendorTableId: string, streamId: string): void` and `resolveTableId(vendorTableId: string): string | undefined`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  WinfinityRuntimeParser,
  normalizeWinfinityTableId,
  publicWinfinityTableId,
} from '../src/winfinity-runtime.js';

describe('Winfinity table ids', () => {
  it('uses lowercase stream id when present', () => {
    expect(publicWinfinityTableId({
      streamId: 'TYN-BAC8',
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('tyn-bac8');
  });

  it('falls back to wnf- prefix and never emits a bare 24-hex id', () => {
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(publicWinfinityTableId({
      vendorTableId: '638f56dc65729f90d0636fb0',
    })).not.toMatch(/^[a-f0-9]{24}$/i);
  });

  it('rejects pragmatic-shaped and bg-shaped ids', () => {
    expect(publicWinfinityTableId({ streamId: 'pragmatictable01' })).toBeUndefined();
    expect(publicWinfinityTableId({ vendorTableId: 'B06' })).toBeUndefined();
    expect(normalizeWinfinityTableId('tyn-bac8')).toBe('tyn-bac8');
    expect(normalizeWinfinityTableId('wnf-638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
    expect(normalizeWinfinityTableId('638f56dc65729f90d0636fb0')).toBeUndefined();
  });

  it('locks the first public id for a vendor table and ignores later aliases', () => {
    const parser = new WinfinityRuntimeParser();
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
    parser.registerAlias('638f56dc65729f90d0636fb0', 'tyn-bac8');
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('wnf-638f56dc65729f90d0636fb0');
  });

  it('uses stream id when the alias is registered before first resolve', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias('638f56dc65729f90d0636fb0', 'TYN-BAC8');
    expect(parser.resolveTableId('638f56dc65729f90d0636fb0')).toBe('tyn-bac8');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts`
Expected: FAIL，模块不存在或导出缺失。

- [ ] **Step 3: Write minimal implementation**

`packages/browser-bridge/src/winfinity-runtime.ts`：

```ts
export const WINFINITY_STREAM_ID_PATTERN = /^[a-z0-9]+-bac\d+$/i;
export const WINFINITY_FALLBACK_TABLE_ID_PATTERN = /^wnf-[a-f0-9]{24}$/i;
export const WINFINITY_VENDOR_TABLE_ID_PATTERN = /^[a-f0-9]{24}$/i;

export function publicWinfinityTableId(input: {
  readonly streamId?: string;
  readonly vendorTableId?: string;
}): string | undefined {
  const streamId = input.streamId?.trim().toLowerCase();
  if (streamId && WINFINITY_STREAM_ID_PATTERN.test(streamId)) return streamId;
  const vendor = input.vendorTableId?.trim().toLowerCase();
  if (vendor && WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return `wnf-${vendor}`;
  return undefined;
}

export function normalizeWinfinityTableId(tableId: string): string | undefined {
  const trimmed = tableId.trim().toLowerCase();
  if (WINFINITY_STREAM_ID_PATTERN.test(trimmed)) return trimmed;
  if (WINFINITY_FALLBACK_TABLE_ID_PATTERN.test(trimmed)) return trimmed;
  return undefined;
}

export class WinfinityRuntimeParser {
  private readonly lockedByVendor = new Map<string, string>();

  registerAlias(vendorTableId: string, streamId: string): void {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return;
    if (this.lockedByVendor.has(vendor)) return;
    const publicId = publicWinfinityTableId({ streamId, vendorTableId: vendor });
    if (publicId === undefined) return;
    this.lockedByVendor.set(vendor, publicId);
  }

  resolveTableId(vendorTableId: string): string | undefined {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return undefined;
    const locked = this.lockedByVendor.get(vendor);
    if (locked !== undefined) return locked;
    const publicId = publicWinfinityTableId({ vendorTableId: vendor });
    if (publicId === undefined) return undefined;
    this.lockedByVendor.set(vendor, publicId);
    return publicId;
  }
}
```

`packages/browser-bridge/src/index.ts` 增加一行：`export * from './winfinity-runtime.js';`

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/winfinity-runtime.ts packages/browser-bridge/src/index.ts packages/browser-bridge/test/winfinity-runtime.test.ts
git commit -m "feat: Winfinity 桌号短号与别名锁定"
```

---

### Task 2: 开窗 / 关窗映射

**Files:**
- Modify: `packages/browser-bridge/src/winfinity-runtime.ts`
- Test: `packages/browser-bridge/test/winfinity-runtime.test.ts`

**Interfaces:**
- Consumes: `WinfinityRuntimeParser.resolveTableId`, `registerAlias`
- Produces: `WinfinityRuntimeParser.parseFrame(raw: string): NormalizedEvent[]`
  - `BETS_OPEN` → 两条 `bettingWindowOpened`（`bankerPair`、`playerPair`）
  - `bettingTime === "0"` 或缺失 → 事件无 `closesAt`
  - `BETS_CLOSING` 且 `bettingTime` 为 Unix 毫秒 → 再发带 `closesAt` 的 `bettingWindowOpened`（不当新 hand；同一 `handId`）
  - `BETS_CLOSED` / `GAME_STARTED` → 两条 `bettingWindowClosed`；`GAME_STARTED` 不得只开窗不开关

测试夹具（后续任务复用，写在测试文件顶部）：

```ts
const VENDOR = '638f56dc65729f90d0636fb0';
const SHOE_A = 'a6b0945d-1111-4111-8111-aaaaaaaaaaaa';
const SHOE_B = 'b8d70a5b-2222-4222-8222-bbbbbbbbbbbb';
const HAND_1 = '01a08226-087c-72ff-8e0e-a5cd185abc0e';

function wsFrame(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt-1',
    timestamp: '1788889925756',
    type,
    meta: {
      tableId: VENDOR,
      dealerNickName: 'x',
      round: { id: HAND_1, startedAt: '1788889925756', shoeId: SHOE_A },
    },
    ...extra,
  });
}
```

- [ ] **Step 1: Write the failing test**

```ts
describe('Winfinity betting windows', () => {
  it('opens pair windows without closesAt when bettingTime is 0', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const opened = events.filter(event => event.type === 'bettingWindowOpened');
    expect(opened).toHaveLength(2);
    expect(opened.map(event => event.market).sort()).toEqual(['bankerPair', 'playerPair']);
    expect(opened.every(event => event.tableId === 'tyn-bac8')).toBe(true);
    expect(opened.every(event => event.handId === HAND_1)).toBe(true);
    expect(opened.every(event => event.shoeId === SHOE_A)).toBe(true);
    expect(opened.every(event => !('closesAt' in event) || event.closesAt === undefined)).toBe(true);
  });

  it('updates closesAt on BETS_CLOSING without treating it as a new hand', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: {
        state: 'BETS_CLOSING',
        bettingTime: '1788889930756',
        bettingTimeDuration: '5000',
        allowedSideBets: [],
      },
    }));
    const opened = events.filter(event => event.type === 'bettingWindowOpened');
    expect(opened).toHaveLength(2);
    expect(opened.every(event => event.closesAt === new Date(1788889930756).toISOString())).toBe(true);
    expect(opened.every(event => event.handId === HAND_1)).toBe(true);
  });

  it('closes windows on GAME_STARTED and does not open a new pair window', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const events = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: {
        state: 'GAME_STARTED',
        bettingTime: '0',
        bettingTimeDuration: '0',
        allowedSideBets: ['PPAIR', 'BPAIR', 'SMALL', 'BIG', 'LUCKY6'],
      },
    }));
    expect(events.filter(event => event.type === 'bettingWindowOpened')).toHaveLength(0);
    expect(events.filter(event => event.type === 'bettingWindowClosed')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts -t "Winfinity betting windows"`
Expected: FAIL，`parseFrame` 未定义。

- [ ] **Step 3: Write minimal implementation**

在 `WinfinityRuntimeParser` 增加：

- `parseFrame(raw: string): NormalizedEvent[]`：坏 JSON / 未知 `type` 返回 `[]`。
- 从 `meta.tableId` `resolveTableId`；无 public id 则返回 `[]`。
- `timestamp`：`Number(frame.timestamp)` 若 `> 1e12` 则 `new Date(n).toISOString()`。
- `source: 'winfinity-runtime'`，`schemaVersion: EVENT_SCHEMA_VERSION`，`eventId` 形如 `wnf:${tableId}:${type}:${stableKey}:${sourceSeq}`。
- `GAME_STATE_CHANGED`：
  - `BETS_OPEN`：若该 `tableId:handId:market` 尚未开过，push 两条 opened。`closesAt` 仅当 `Number(bettingTime) > 1e12`。
  - `BETS_CLOSING`：若截止有效，push 两条带 `closesAt` 的 opened（同一 hand）。
  - `BETS_CLOSED` 或 `GAME_STARTED`：若已开未关，push 两条 closed。
- 开/关集合用 `Set<string>`，key = `${tableId}:${handId}:${market}`。

`bettingWindowOpened` / `Closed` 必须带 `shoeId`、`handId`、`market`。从 `meta.round` 读取。

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts`
Expected: PASS（含 Task 1）

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/winfinity-runtime.ts packages/browser-bridge/test/winfinity-runtime.test.ts
git commit -m "feat: Winfinity 开窗关窗映射"
```

---

### Task 3: 发牌去重与牌面映射

**Files:**
- Modify: `packages/browser-bridge/src/winfinity-runtime.ts`
- Test: `packages/browser-bridge/test/winfinity-runtime.test.ts`

**Interfaces:**
- Consumes: `parseFrame`
- Produces: `CARDS_TAKEN` → `cardObserved`；rank 映射；按卡 `id` 去重；忽略 `allCards` 重复

Rank 映射（写死在 runtime，测试锁住）：

```ts
const RANK: Record<string, 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'> = {
  ACE: 'A', TWO: '2', THREE: '3', FOUR: '4', FIVE: '5', SIX: '6', SEVEN: '7',
  EIGHT: '8', NINE: '9', TEN: '10', JACK: 'J', QUEEN: 'Q', KING: 'K',
};
```

- [ ] **Step 1: Write the failing test**

```ts
describe('Winfinity cards', () => {
  it('emits only incremental cards and maps rank/position', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const first = parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
        allCards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
      },
    }));
    expect(first.filter(event => event.type === 'cardObserved')).toEqual([
      expect.objectContaining({
        type: 'cardObserved',
        tableId: 'tyn-bac8',
        shoeId: SHOE_A,
        handId: HAND_1,
        card: expect.objectContaining({ rank: 'Q', suit: 'DIAMOND' }),
        position: 'player:left',
      }),
    ]);
    const second = parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
        allCards: [{
          id: 'card-1',
          card: { rank: 'QUEEN', suit: 'DIAMOND' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }, {
          id: 'card-2',
          card: { rank: 'ACE', suit: 'SPADE' },
          position: { area: 'BANKER', order: 'ORDER_EXTRA' },
        }],
      },
    }));
    expect(second.filter(event => event.type === 'cardObserved')).toHaveLength(0);
  });

  it('drops unknown ranks instead of inventing cards', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const events = parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [{
          id: 'card-x',
          card: { rank: 'JOKER', suit: 'SPADE' },
          position: { area: 'PLAYER', order: 'ORDER_LEFT' },
        }],
        allCards: [],
      },
    }));
    expect(events.filter(event => event.type === 'cardObserved')).toHaveLength(0);
  });
});
```

第二帧故意只把新牌放在 `allCards`：实现必须 **只读 `cards.cards`**，因此 `card-2` 不应发出。这锁住「不用 allCards 记账」。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts -t "Winfinity cards"`
Expected: FAIL，没有 `cardObserved`。

- [ ] **Step 3: Write minimal implementation**

- 解析 `CARDS_TAKEN.cards.cards` 数组。
- 每张牌需要 `id`。已见 `Set` key = `${tableId}:${cardId}`，重复跳过。
- rank 不在映射表 → 跳过该张。
- `position.area` `PLAYER`→`player`，`BANKER`→`banker`；`ORDER_LEFT`→`left`，`ORDER_RIGHT`→`right`，`ORDER_EXTRA`→`extra`；拼 `player:left`。
- `card.suit` 原样可选字符串。
- 同时把牌记入 `${tableId}:${handId}` 的闲/庄数组，供 Task 4 结算（本任务测试不读结算）。

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/winfinity-runtime.ts packages/browser-bridge/test/winfinity-runtime.test.ts
git commit -m "feat: Winfinity 增量发牌与牌面映射"
```

---

### Task 4: 结算、鞋 token、丢弃未知帧

**Files:**
- Modify: `packages/browser-bridge/src/winfinity-runtime.ts`
- Create: `packages/browser-bridge/test/fixtures/winfinity-game-results.json`（脱敏单帧，可选；测试也可内联）
- Test: `packages/browser-bridge/test/winfinity-runtime.test.ts`

**Interfaces:**
- Consumes: `parseFrame`、卡记忆
- Produces:
  - `GAME_RESULTS` → `handSettled`，`outcomes.playerPair/bankerPair` 来自 `pPair/bPair`
  - `shoeEvidence(tableId)`：第一次 UUID → `{ reason: 'attach' }`；再次变化 → `{ reason: 'protocol-shuffle' }` 且发出 `newShoeSignal` `baseline: 'physical-shoe'`
  - `openPhysicalShoe(tableId, timestamp)` → `newShoeSignal` + `{ reason: 'manual-confirm' }`
  - 未知 type / 坏 JSON → `[]`
  - 重复 `handId` 结算忽略

- [ ] **Step 1: Write the failing test**

```ts
describe('Winfinity settlement and shoes', () => {
  it('settles pairs from roundResult and ignores duplicates and winners lists', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    parser.parseFrame(wsFrame('CARDS_TAKEN', {
      cards: {
        cards: [
          { id: 'p1', card: { rank: 'FIVE', suit: 'SPADE' }, position: { area: 'PLAYER', order: 'ORDER_LEFT' } },
          { id: 'p2', card: { rank: 'ACE', suit: 'HEART' }, position: { area: 'PLAYER', order: 'ORDER_RIGHT' } },
          { id: 'b1', card: { rank: 'NINE', suit: 'CLUB' }, position: { area: 'BANKER', order: 'ORDER_LEFT' } },
          { id: 'b2', card: { rank: 'EIGHT', suit: 'DIAMOND' }, position: { area: 'BANKER', order: 'ORDER_RIGHT' } },
        ],
        allCards: [],
      },
    }));
    const settled = parser.parseFrame(wsFrame('GAME_RESULTS', {
      gameResults: {
        roundResult: {
          roundId: HAND_1,
          won: 'PLAYER',
          pPair: false,
          bPair: true,
          score: 6,
        },
      },
    }));
    expect(settled.filter(event => event.type === 'handSettled')).toEqual([
      expect.objectContaining({
        tableId: 'tyn-bac8',
        shoeId: SHOE_A,
        handId: HAND_1,
        outcomes: { playerPair: false, bankerPair: true },
        playerCards: [expect.objectContaining({ rank: '5' }), expect.objectContaining({ rank: 'A' })],
        bankerCards: [expect.objectContaining({ rank: '9' }), expect.objectContaining({ rank: '8' })],
      }),
    ]);
    const dup = parser.parseFrame(wsFrame('GAME_RESULTS', {
      gameResults: { roundResult: { roundId: HAND_1, won: 'PLAYER', pPair: true, bPair: true } },
    }));
    expect(dup.filter(event => event.type === 'handSettled')).toHaveLength(0);
    expect(parser.parseFrame(wsFrame('WINNERS_LIST', { winners: [{ name: 'secret' }] }))).toEqual([]);
    expect(parser.parseFrame('not-json')).toEqual([]);
  });

  it('records the first shoe token as attach and the second as protocol-shuffle', () => {
    const parser = new WinfinityRuntimeParser();
    parser.registerAlias(VENDOR, 'tyn-bac8');
    const first = parser.parseFrame(wsFrame('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
    expect(first.some(event => event.type === 'newShoeSignal' && event.baseline === 'physical-shoe')).toBe(false);
    const second = parser.parseFrame(JSON.stringify({
      id: 'evt-2',
      timestamp: '1788889999999',
      type: 'GAME_STATE_CHANGED',
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-2', startedAt: '1788889999999', shoeId: SHOE_B },
      },
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    expect(parser.shoeEvidence('tyn-bac8')).toEqual({ reason: 'protocol-shuffle' });
    expect(second).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'newShoeSignal',
        shoeId: SHOE_B,
        baseline: 'physical-shoe',
        tableId: 'tyn-bac8',
      }),
    ]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts -t "Winfinity settlement"`
Expected: FAIL，没有 `handSettled` / `shoeEvidence`。

- [ ] **Step 3: Write minimal implementation**

- 每桌记 `lastShoeToken`。首次非空 UUID：`ensureShoe` 发 `newShoeSignal` `baseline: 'unknown-monitor-session'`，`shoeId` 用该 UUID，`evidence = { reason: 'attach' }`。
- 再次不同 UUID：`beginNewShoe` 发 `newShoeSignal` `baseline: 'physical-shoe'`，`evidence = { reason: 'protocol-shuffle' }`，清空该桌手牌/窗口/已见卡（保留已结算 hand 键以免旧 roundId 回放）。
- `GAME_RESULTS.gameResults.roundResult`：组 `handSettled`。缺牌用已记忆数组，不编造。`pPair/bPair` 缺省当 `false`。结算键 `${tableId}:${shoeId}:${handId}`。
- `WINNERS_LIST` 及未识别 type 返回空。
- `openPhysicalShoe`：`evidence = { reason: 'manual-confirm' }`，`shoeId = \`wnf-${tableId}-operator\``。
- `newShoeSignal.profile`：`{ ...defaultProfile(tableId), numberOfDecks: 8, autoConfirmNewShoe: true }`。

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/winfinity-runtime.ts packages/browser-bridge/test/winfinity-runtime.test.ts packages/browser-bridge/test/fixtures
git commit -m "feat: Winfinity 结算与协议洗牌 token"
```

---

### Task 5: 扩展身份与房间常量

**Files:**
- Modify: `packages/browser-bridge/src/identity.ts`
- Modify: `packages/browser-bridge/test/identity.test.ts`
- Create: `apps/browser-extension-winfinity/manifest.json`（先放 `key`，其余字段 Task 6 补全）

**Interfaces:**
- Consumes: 无
- Produces:
  - `BUNDLED_WINFINITY_BROWSER_EXTENSION_ID: string`（32 位 a-p）
  - `BUNDLED_BROWSER_EXTENSION_IDS` 含三条
  - `DAFABET_WINFINITY_ROOM_ID = 'dafabet-winfinity'`
  - `isLiveBridgeRoomId` 接受 pragmatic / bg / winfinity
  - token 仍是现有 `BUNDLED_BROWSER_EXTENSION_TOKEN`

- [ ] **Step 1: Write the failing test**

在 `identity.test.ts` 增加：

```ts
it('keeps the Winfinity manifest key, extension ID, and background token synchronized', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../../../apps/browser-extension-winfinity/manifest.json', import.meta.url),
    'utf8',
  )) as { readonly key?: string };
  if (manifest.key === undefined) throw new Error('Winfinity browser extension manifest key missing');
  expect(extensionIdFromManifestKey(manifest.key)).toBe(BUNDLED_WINFINITY_BROWSER_EXTENSION_ID);
  expect(BUNDLED_BROWSER_EXTENSION_IDS).toEqual([
    BUNDLED_BROWSER_EXTENSION_ID,
    BUNDLED_BG_BROWSER_EXTENSION_ID,
    BUNDLED_WINFINITY_BROWSER_EXTENSION_ID,
  ]);
  expect(isLiveBridgeRoomId('dafabet-winfinity')).toBe(true);
  expect(DAFABET_WINFINITY_ROOM_ID).toBe('dafabet-winfinity');
});
```

从 `../src/index.js` 增加导入 `BUNDLED_WINFINITY_BROWSER_EXTENSION_ID`、`DAFABET_WINFINITY_ROOM_ID`、`isLiveBridgeRoomId`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/identity.test.ts`
Expected: FAIL，常量或 manifest 不存在。

- [ ] **Step 3: Write minimal implementation**

生成独立 RSA 公钥（不要复用 Pragmatic/BG key）。在仓库根执行：

```js
import { generateKeyPairSync, createHash } from 'node:crypto';
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const key = der.toString('base64');
const id = [...createHash('sha256').update(der).digest().subarray(0, 16)]
  .map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
  .join('');
console.log(key);
console.log(id);
```

`identity.ts`：

```ts
export const BUNDLED_WINFINITY_BROWSER_EXTENSION_ID = '<generated-id>';
export const BUNDLED_BROWSER_EXTENSION_IDS = [
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BG_BROWSER_EXTENSION_ID,
  BUNDLED_WINFINITY_BROWSER_EXTENSION_ID,
] as const;
export const DAFABET_WINFINITY_ROOM_ID = 'dafabet-winfinity';
export function isLiveBridgeRoomId(roomId: string): boolean {
  return roomId === DAFABET_PRAGMATIC_ROOM_ID
    || roomId === DAFABET_BG_ROOM_ID
    || roomId === DAFABET_WINFINITY_ROOM_ID;
}
```

`apps/browser-extension-winfinity/manifest.json` 至少含 `"key": "<generated-key>"`。完整 manifest 可在本步一次写好（见 Task 6 字段），避免两次改文件。

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/identity.test.ts`
Expected: PASS。现有两条扩展的 identity 用例也必须绿。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/identity.ts packages/browser-bridge/test/identity.test.ts apps/browser-extension-winfinity/manifest.json
git commit -m "feat: Winfinity 扩展身份与房间 id"
```

---

### Task 6: 独立扩展骨架（无下注 runtime）

**Files:**
- Create: `apps/browser-extension-winfinity/background.js`
- Create: `apps/browser-extension-winfinity/content.js`
- Create: `apps/browser-extension-winfinity/winfinity-network-hook.js`
- Create: `apps/browser-extension-winfinity/winfinity-protocol.js`
- Create: `apps/browser-extension-winfinity/winfinity-dom-hook.js`
- Create: `apps/browser-extension-winfinity/README.md`
- Modify: `apps/browser-extension-winfinity/manifest.json`
- Test: `packages/browser-bridge/test/winfinity-extension-routing.test.ts`
- Test: `packages/browser-bridge/test/winfinity-wire.test.ts`

**Interfaces:**
- Consumes: `BUNDLED_BROWSER_EXTENSION_TOKEN`（background 内嵌同一 token 字符串）、`DAFABET_WINFINITY_ROOM_ID`
- Produces: 扩展只匹配桃园弹窗；转发 `baccarat-bridge-winfinity-ws` / `baccarat-bridge-winfinity-state`；所有 `betRequest` 回 `REJECTED`；无 `chrome.tabs.reload`；无 bet-runtime 文件

`manifest.json` 完整字段：

```json
{
  "manifest_version": 3,
  "name": "Baccarat Winfinity Room Bridge",
  "version": "0.1.0",
  "key": "<task-5-key>",
  "description": "把 Dafabet 桃园厅 Winfinity 多桌数据桥接到本机 EV 中控台。第一期只采集，不下注。",
  "permissions": ["storage", "tabs", "alarms"],
  "host_permissions": [
    "https://*.dafabet.net/*",
    "https://*.youngpoisson.xyz/*"
  ],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["https://*.dafabet.net/*", "https://*.youngpoisson.xyz/*"],
      "js": ["winfinity-protocol.js", "winfinity-network-hook.js"],
      "run_at": "document_start",
      "all_frames": true,
      "world": "MAIN"
    },
    {
      "matches": ["https://*.dafabet.net/*", "https://*.youngpoisson.xyz/*"],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    },
    {
      "matches": ["https://*.dafabet.net/*", "https://*.youngpoisson.xyz/*"],
      "js": ["winfinity-dom-hook.js"],
      "run_at": "document_idle",
      "all_frames": true
    }
  ],
  "action": { "default_title": "点击重载 Winfinity 桥接扩展" },
  "commands": {
    "reload-extension": {
      "suggested_key": { "default": "Alt+Shift+R" },
      "description": "重新加载 Winfinity 桥接扩展（不刷新游戏弹窗）"
    }
  }
}
```

注意：不要 `debugger` 权限；不要 `scripting` 权限（第一期不注入下注）。

- [ ] **Step 1: Write the failing tests**

`winfinity-extension-routing.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backgroundSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/background.js', import.meta.url),
  'utf8',
);
const networkHookSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/winfinity-network-hook.js', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(readFileSync(
  new URL('../../../apps/browser-extension-winfinity/manifest.json', import.meta.url),
  'utf8',
)) as { content_scripts?: Array<{ js?: string[] }>; permissions?: string[] };

describe('Winfinity extension routing', () => {
  it('matches only the tao-yuan popup and does not ship a bet runtime', () => {
    const scripts = (manifest.content_scripts ?? []).flatMap(entry => entry.js ?? []);
    expect(scripts).toContain('winfinity-network-hook.js');
    expect(scripts).not.toContain('bg-bet-runtime.js');
    expect(scripts).not.toContain('pragmatic-bet-runtime.js');
    expect(manifest.permissions ?? []).not.toContain('scripting');
    expect(backgroundSource).toContain('/live-dealer/popup-launch/tao-yuan-baccarat');
    expect(backgroundSource).not.toContain('jeju-speed-baccarat');
    expect(backgroundSource).not.toContain('live-baccarat-bg');
    expect(backgroundSource).not.toContain('autoBet');
    expect(backgroundSource).not.toMatch(/chrome\.tabs\.reload\s*\(/);
    expect(backgroundSource).toContain('winfinity-monitor-only');
    expect(networkHookSource).toContain('baccarat-bridge-winfinity-ws');
    expect(networkHookSource).toContain('youngpoisson.xyz');
    expect(networkHookSource).not.toContain('autoBet');
  });
});
```

`winfinity-wire.test.ts` 用 `vm` 加载 `winfinity-protocol.js`：

```ts
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const protocolSource = readFileSync(
  new URL('../../../apps/browser-extension-winfinity/winfinity-protocol.js', import.meta.url),
  'utf8',
);

function loadProtocol() {
  const context = vm.createContext({ console, JSON, Set, URL });
  vm.runInContext(`${protocolSource}\nthis.isWinfinityGameFrame = isWinfinityGameFrame;\nthis.extractStreamId = extractStreamId;`, context);
  return context as unknown as {
    isWinfinityGameFrame: (raw: string) => boolean;
    extractStreamId: (href: string) => string | undefined;
  };
}

describe('Winfinity wire protocol helpers', () => {
  it('accepts game JSON and rejects sentry envelopes', () => {
    const proto = loadProtocol();
    expect(proto.isWinfinityGameFrame(JSON.stringify({
      type: 'GAME_STATE_CHANGED',
      meta: { tableId: '638f56dc65729f90d0636fb0' },
    }))).toBe(true);
    expect(proto.isWinfinityGameFrame(JSON.stringify({ type: 'WINNERS_LIST' }))).toBe(false);
    expect(proto.isWinfinityGameFrame('{"ok":true}')).toBe(false);
    expect(proto.extractStreamId('https://baccarat-multitable.youngpoisson.xyz/?streamId=tyn-bac8&tableId=638f56dc65729f90d0636fb0')).toBe('tyn-bac8');
  });
});
```

若 `vm.runInContext` 因 IIFE 拿不到函数：`winfinity-protocol.js` 必须把 `isWinfinityGameFrame` / `extractStreamId` 挂到 `globalThis`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-extension-routing.test.ts packages/browser-bridge/test/winfinity-wire.test.ts`
Expected: FAIL，文件缺失。

- [ ] **Step 3: Write minimal implementation**

`winfinity-protocol.js`（MAIN world，无构建）：

```js
(function (root) {
  const GAME_TYPES = {
    GAME_STATE_CHANGED: true,
    CARDS_TAKEN: true,
    GAME_RESULTS: true,
    TABLES_LIST: true,
    TABLE_SETTINGS_CHANGED: true,
    CURRENT_STATE: true,
  };
  function isWinfinityGameFrame(raw) {
    try {
      const parsed = JSON.parse(String(raw || ''));
      return Boolean(parsed && typeof parsed === 'object' && GAME_TYPES[parsed.type] === true);
    } catch (_) {
      return false;
    }
  }
  function extractStreamId(href) {
    try {
      const value = new URL(String(href || ''), 'https://lobby.youngpoisson.xyz/').searchParams.get('streamId');
      if (!value) return undefined;
      const normalized = String(value).trim().toLowerCase();
      return /^[a-z0-9]+-bac\d+$/.test(normalized) ? normalized : undefined;
    } catch (_) {
      return undefined;
    }
  }
  root.isWinfinityGameFrame = isWinfinityGameFrame;
  root.extractStreamId = extractStreamId;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

`winfinity-network-hook.js`：仅当 hostname 匹配 `youngpoisson.xyz` 或桃园 popup path。包装 `WebSocket`，`onmessage` 若 `typeof data === 'string'` 且 `isWinfinityGameFrame(data)`，`postMessage({ kind: 'networkCapture', source: 'baccarat-bridge-winfinity-ws', url: location.href, direction: 'recv', encoding: 'text', data }, '*')`。忽略 `skt.youngpoisson.xyz`。不包装二进制帧。

`winfinity-dom-hook.js`：在 lobby / 多桌页扫描 `iframe[src*="streamId="]` 与含 `Baccarat` 的磁贴文本，组装：

```js
{
  version: 1,
  observedAt: new Date().toISOString(),
  tables: [{ tableId: 'tyn-bac8', vendorTableId: '638f...', displayName: 'Tao Yuan Baccarat 8', streamId: 'tyn-bac8', gameCount: 48, source: 'hall' }]
}
```

`gameCount` 仅当文本匹配 `/#(\d+)/`。`source: 'baccarat-bridge-winfinity-state'`。不要写死桌清单。

`content.js`：监听 `message`，若 `source` 以 `baccarat-bridge-winfinity-` 开头则 `chrome.runtime.sendMessage`。匹配桃园 popup 或 `youngpoisson.xyz`。不 `tabs.reload`。

`background.js` 关键行为（对标 BG，删除执行器注入）：

- `DEFAULT_BRIDGE_TOKEN` 与 identity token 相同。
- `DAFABET_WINFINITY_POPUP_PATH = '/live-dealer/popup-launch/tao-yuan-baccarat'`。
- 连接 `ws://127.0.0.1:17890/?token=...`，hello，心跳，序号。
- 转发 protocol capture。
- 收到 `betRequest`：立刻 `betResult`，`status: 'REJECTED'`，`raw: { commitStarted: false, reason: 'winfinity-monitor-only' }`。
- `reloadExtension`：`chrome.runtime.reload()`，**禁止** `chrome.tabs.reload`。
- 不包含 `autoBet`、`lpbet`、`executeScript`。

README：说明停用另外两个扩展、打开桃园弹窗、改完扩展后手动刷新弹窗。

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-extension-routing.test.ts packages/browser-bridge/test/winfinity-wire.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/browser-extension-winfinity packages/browser-bridge/test/winfinity-extension-routing.test.ts packages/browser-bridge/test/winfinity-wire.test.ts
git commit -m "feat: Winfinity 独立采集扩展（无下注）"
```

---

### Task 7: 桥接入采集并拒绝下注

**Files:**
- Modify: `packages/browser-bridge/src/server.ts`
- Test: `packages/browser-bridge/test/winfinity-bridge-integration.test.ts`

**Interfaces:**
- Consumes: `WinfinityRuntimeParser`、`DAFABET_WINFINITY_ROOM_ID`、`normalizeWinfinityTableId`
- Produces: `networkCapture` source `baccarat-bridge-winfinity-ws` / `baccarat-bridge-winfinity-state` 摄入 `dafabet-winfinity`；不创建 pragmatic/bg 房间；Winfinity 桌 `requestOperationalWager` / `requestBet` 返回 REJECTED；`roomIdForTable('tyn-bac8') === 'dafabet-winfinity'`；`beginMonitorSession` 清 Winfinity 解析器与房间；`confirmPhysicalShoe` 走 winfinity parser

`LIVE_PROTOCOL_CAPTURE_SOURCES` 增加：

- `'baccarat-bridge-winfinity-ws'`
- `'baccarat-bridge-winfinity-state'`

`OBSERVABLE_NETWORK_PATTERN` 增加 `youngpoisson\\.xyz|baccarat-bridge-winfinity`。

`roomIdForTable` 顺序：discovered winfinity → discovered bg → `normalizeWinfinityTableId` → `normalizeBgTableId` → pragmatic。裸 24 hex 不得因为像 pragmatic 而回落 pragmatic **当它已在 winfinity 发现表里**；未发现的 24 hex 仍可能被 pragmatic pattern 吃掉，所以发现必须先 `ensureRoomForTable(..., DAFABET_WINFINITY_ROOM_ID)`。

`dispatchExecution` 在发到扩展前：

```ts
if (this.roomIdForTable(tableId) === DAFABET_WINFINITY_ROOM_ID) {
  const now = new Date().toISOString();
  if ('wager' in request) {
    return {
      receiptId: `wnf-rejected-${now}`,
      wagerId: request.wager.wagerId,
      tableId,
      shoeId: request.wager.shoeId,
      handId: request.wager.handId,
      market: request.wager.market,
      amount: request.wager.amount,
      source: request.wager.source,
      status: 'REJECTED',
      createdAt: now,
      raw: { commitStarted: false, reason: 'winfinity-monitor-only' },
    };
  }
  return {
    receiptId: `wnf-rejected-${now}`,
    intentId: request.intent.intentId,
    reservationId: request.reservationId,
    status: 'REJECTED',
    amount: request.intent.amount,
    market: request.intent.market,
    mode: request.mode,
    createdAt: now,
    raw: { commitStarted: false, reason: 'winfinity-monitor-only' },
  };
}
```

`networkCapture` 分支（在 bg 分支旁）：

- `baccarat-bridge-winfinity-state`：解析 `tables[]`，`registerAlias(vendorTableId, streamId)`，`upsertBridgeRoom` `dafabet-winfinity`，`parseFrame` 不必处理 state；把 `gameCount` 记到 discovered table。
- `baccarat-bridge-winfinity-ws` 且 `encoding === 'text'` 且 `direction !== 'send'`：`parseFrame`，对事件里每个 `tableId` `ensureRoomForTable(id, DAFABET_WINFINITY_ROOM_ID)`，`ingestParsedEvents(..., DAFABET_WINFINITY_ROOM_ID)`。未选中桌仍要 `parseFrame`（证据），`ingestParsedEvents` 内部已跳过未选中事件。为让 pending 桌积累 `shoeEvidence`，parse 必须在 ingest 过滤之前更新 parser 状态——`parseFrame` 本来就会更新，即使随后 ingest 丢掉事件。**但** `ingestParsedEvents` 对未选中桌直接 `continue`，`shoeEvidence` 仍在 parser 上，桌面读 `browserBridge.shoeEvidence(tableId)` 即可。因此要对未选中桌也 `ensureRoomForTable` 进 discovered。在 ws 分支对 `parser.resolveTableId(meta.tableId)` 得到的 public id 一律 `ensureRoomForTable`；若 `isTableSelected(publicId)` 再 `noteTableObservation(publicId)`（只刷新本帧出现的桌，邻桌静默不能续命）。

`beginMonitorSession`：`this.winfinityParser = new WinfinityRuntimeParser()`；删除 `dafabet-winfinity` rooms/exports。

`shoeEvidence`：`winfinityParser.shoeEvidence(tableId) ?? bg ?? pragmatic`。

`openPhysicalShoe` / `recordShoeEvidence` / `confirmPhysicalShoe` prefix：`roomId === DAFABET_WINFINITY_ROOM_ID` → winfinity，`prefix = 'wnf'`。

`ensureRoomForTable`：winfinity 显示名「Dafabet Winfinity」；若 `normalizeWinfinityTableId(tableId) === undefined` 且 room 是 winfinity 则 return。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  BrowserBridgeServer,
  DAFABET_BG_ROOM_ID,
  DAFABET_PRAGMATIC_ROOM_ID,
  DAFABET_WINFINITY_ROOM_ID,
} from '../src/index.js';

const VENDOR = '638f56dc65729f90d0636fb0';

function wnfState() {
  return {
    kind: 'networkCapture' as const,
    source: 'baccarat-bridge-winfinity-state',
    url: 'https://lobby.youngpoisson.xyz/',
    direction: 'recv' as const,
    encoding: 'text' as const,
    data: JSON.stringify({
      version: 1,
      observedAt: '2026-09-09T12:00:00.000Z',
      tables: [{
        tableId: 'tyn-bac8',
        vendorTableId: VENDOR,
        streamId: 'tyn-bac8',
        displayName: 'Tao Yuan Baccarat 8',
        gameCount: 12,
        source: 'hall',
      }],
    }),
  };
}

function wnfWs(type: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'networkCapture' as const,
    source: 'baccarat-bridge-winfinity-ws',
    url: 'https://baccarat-multitable.youngpoisson.xyz/',
    direction: 'recv' as const,
    encoding: 'text' as const,
    data: JSON.stringify({
      id: 'e1',
      timestamp: '1788889925756',
      type,
      meta: {
        tableId: VENDOR,
        round: { id: 'hand-1', startedAt: '1788889925756', shoeId: 'shoe-a' },
      },
      ...extra,
    }),
  };
}

describe('Winfinity bridge integration', () => {
  it('ingests Winfinity frames into dafabet-winfinity without creating pragmatic or bg rooms', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    server.ingestClientMessage(wnfWs('GAME_STATE_CHANGED', {
      state: { state: 'BETS_OPEN', bettingTime: '0', bettingTimeDuration: '0', allowedSideBets: [] },
    }));
    const rooms = server.getDiscoveredRooms();
    expect(rooms.map(room => room.roomId)).toEqual([DAFABET_WINFINITY_ROOM_ID]);
    expect(rooms[0]?.tables.map(table => table.tableId)).toEqual(['tyn-bac8']);
    expect(server.getRooms().find(room => room.roomId === DAFABET_PRAGMATIC_ROOM_ID)).toBeUndefined();
    expect(server.getRooms().find(room => room.roomId === DAFABET_BG_ROOM_ID)).toBeUndefined();
    expect(server.shoeEvidence('tyn-bac8')).toEqual({ reason: 'attach' });
  });

  it('does not treat a bare vendor hex as a pragmatic table when aliased', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    expect(server.getDiscoveredRooms()[0]?.tables.map(table => table.tableId)).not.toContain(VENDOR);
  });

  it('rejects Winfinity operational wagers before sending them to the page', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['tyn-bac8'] });
    server.ingestClientMessage(wnfState());
    const receipt = await server.requestOperationalWager({
      mode: 'live',
      wager: {
        wagerId: 'w1',
        tableId: 'tyn-bac8',
        shoeId: 'shoe-a',
        handId: 'hand-1',
        market: 'banker',
        amount: 20,
        source: 'manual',
        createdAt: '2026-09-09T12:00:00.000Z',
      },
    });
    expect(receipt).toEqual(expect.objectContaining({
      status: 'REJECTED',
      tableId: 'tyn-bac8',
      raw: expect.objectContaining({ commitStarted: false, reason: 'winfinity-monitor-only' }),
    }));
  });
});
```

`requestOperationalWager` 在无扩展连接时，现有代码会先因 lease 抛错。实现必须 **在 lease 检查之前** 因房间是 winfinity 而返回 REJECTED，这样无扩展也能单测。把 Winfinity 拒绝放在 `dispatchExecution` 最前面（claimHost 之前）。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-bridge-integration.test.ts`
Expected: FAIL，房间仍不是 winfinity 或下注抛「no extension」。

- [ ] **Step 3: Write minimal implementation**

按上面接口改 `server.ts`。构造函数里 `this.winfinityParser = new WinfinityRuntimeParser()`。不要改 pragmatic/bg 钩子文件。

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```
npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-bridge-integration.test.ts packages/browser-bridge/test/bg-bridge-integration.test.ts packages/browser-bridge/test/identity.test.ts
```

Expected: PASS，BG 集成不被破坏。

- [ ] **Step 5: Commit**

```bash
git add packages/browser-bridge/src/server.ts packages/browser-bridge/test/winfinity-bridge-integration.test.ts
git commit -m "feat: 桥接入 Winfinity 采集并拒绝下注"
```

---

### Task 8: 桌面待加入与桌号校验

**Files:**
- Modify: `apps/desktop/src/ui/monitor-table-selection.ts`
- Modify: `apps/desktop/test/monitor-table-selection.test.ts`
- Modify: `apps/desktop/electron-src/service.ts`
- Create: `apps/desktop/test/winfinity-monitor-room.test.ts`

**Interfaces:**
- Consumes: `dafabet-winfinity` 房间、`tyn-bac8` / `wnf-<24hex>` 桌号
- Produces: `isLiveMonitorRoomId` 含 winfinity；`normalizeMonitorTableIds` 接受这两种桌号并转小写；待加入与自动晋升扫描 winfinity 房间

桌号正则（`service.ts` 与 runtime 保持一致）：

```ts
const WINFINITY_MONITOR_TABLE_ID_PATTERN = /^[a-z0-9]+-bac\d+$/i;
const WINFINITY_FALLBACK_MONITOR_TABLE_ID_PATTERN = /^wnf-[a-f0-9]{24}$/i;
```

`normalizeMonitorTableIds`：若匹配这两条，用 `toLowerCase()`，不要 `toUpperCase()`（那是 BG 短号）。

`pendingJoinTableIds` / `promotePendingTablesFromRooms` 的 room 判断改为与 `isLiveMonitorRoomId` 相同的三房间。不要复制两处字符串；在 `service.ts` 用：

```ts
function isLiveDesktopRoomId(roomId: string): boolean {
  return roomId === 'dafabet-pragmatic' || roomId === 'dafabet-bg' || roomId === 'dafabet-winfinity';
}
```

UI：

```ts
export function isLiveMonitorRoomId(roomId: string): boolean {
  return roomId === 'dafabet-pragmatic' || roomId === 'dafabet-bg' || roomId === 'dafabet-winfinity';
}
```

- [ ] **Step 1: Write the failing tests**

`monitor-table-selection.test.ts` 追加：

```ts
it('selects Winfinity tables with BG and Pragmatic and ignores other rooms', () => {
  const selected = selectLiveMonitorTableIds([
    { roomId: 'dafabet-winfinity', tableId: 'tyn-bac8' },
    { roomId: 'dafabet-bg', tableId: 'B06' },
    { roomId: 'other', tableId: 'nope' },
  ]);
  expect(selected).toEqual(['tyn-bac8', 'B06']);
});
```

`winfinity-monitor-room.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { BrowserBridgeServer } from '@baccarat/browser-bridge';
import { DesktopConsoleService } from '../electron-src/service';

describe('desktop Winfinity monitor room', () => {
  it('treats dafabet-winfinity tyn-bac8 as a live pending-join candidate', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'roomDiscovered',
        room: {
          roomId: 'dafabet-winfinity',
          displayName: 'Dafabet Winfinity',
          tables: [{ tableId: 'tyn-bac8', gameCount: 12 }],
        },
      });
      const pending = service['pendingJoinTableIds']() as string[];
      expect(pending).toContain('tyn-bac8');
    } finally {
      await service.close();
    }
  });

  it('does not auto-monitor a Winfinity table until protocol-shuffle evidence', async () => {
    const service = new DesktopConsoleService(':memory:');
    const bridge = new BrowserBridgeServer();
    try {
      service['browserBridge'] = bridge;
      service['liveMonitorActivated'] = true;
      bridge.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-winfinity-state',
        url: 'https://lobby.youngpoisson.xyz/',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          observedAt: '2026-09-09T12:00:00.000Z',
          tables: [{
            tableId: 'tyn-bac8',
            vendorTableId: '638f56dc65729f90d0636fb0',
            streamId: 'tyn-bac8',
            source: 'hall',
          }],
        }),
      });
      service['promotePendingTablesFromRooms'](bridge.getDiscoveredRooms());
      expect(service['monitorTableIds']).not.toContain('tyn-bac8');
      expect(service['pendingJoinTableIds']()).toContain('tyn-bac8');
    } finally {
      await service.close();
    }
  });
});
```

另加（同一文件），走已有公开方法 `updateMonitorTableIds`：

```ts
it('accepts hyphenated Winfinity table ids', async () => {
  const service = new DesktopConsoleService(':memory:');
  try {
    await service.updateMonitorTableIds(['tyn-bac8', 'wnf-638f56dc65729f90d0636fb0']);
    expect(service['monitorTableIds']).toEqual(['tyn-bac8', 'wnf-638f56dc65729f90d0636fb0']);
  } finally {
    await service.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts apps/desktop/test/winfinity-monitor-room.test.ts apps/desktop/test/monitor-table-selection.test.ts`
Expected: FAIL，`tyn-bac8` 被当成非法桌号或进不了 pending。

- [ ] **Step 3: Write minimal implementation**

改 `monitor-table-selection.ts`、`service.ts` 房间过滤与 `normalizeMonitorTableIds`。不要改保活调度逻辑。

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```
npx vitest run --config vitest.config.ts apps/desktop/test/winfinity-monitor-room.test.ts apps/desktop/test/monitor-table-selection.test.ts apps/desktop/test/bg-monitor-room.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/ui/monitor-table-selection.ts apps/desktop/test/monitor-table-selection.test.ts apps/desktop/electron-src/service.ts apps/desktop/test/winfinity-monitor-room.test.ts
git commit -m "feat: 桌面待加入接受 Winfinity 桌"
```

---

### Task 9: 打包、语法检查、文档与版本

**Files:**
- Modify: `scripts/check-extension-syntax.mjs`
- Modify: `apps/desktop/package.json` extraResources
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `apps/desktop/src/console-build-info.ts`（`CONSOLE_VERSION` 1.0.1 → 1.0.2）
- Modify: 根 `package.json`、`apps/desktop/package.json` version
- Modify: `DESIGN.md` 中监控桌号说明（若仍写「仅 Pragmatic 小写 id / 遗留短号」则补上 `tyn-bac8`）
- Create: 若 Task 6 README 已写则只核对

**Interfaces:**
- Consumes: 新扩展目录
- Produces: `npm run check:ext` 统计含 Winfinity js；安装包带上扩展；文档写明第三条扩展互斥

- [ ] **Step 1: Write the failing test**

`check-extension-syntax.mjs` 的 `dirs` 加上 `apps/browser-extension-winfinity`。先写一个小测试或直接跑命令：当前脚本若未包含该目录，`npm run check:ext` 仍会绿但扫不到新文件——所以先加断言文件：

在 `packages/browser-bridge/test/winfinity-extension-routing.test.ts` 追加：

```ts
it('is included in extension syntax check dirs', () => {
  const checker = readFileSync(
    new URL('../../../scripts/check-extension-syntax.mjs', import.meta.url),
    'utf8',
  );
  expect(checker).toContain('browser-extension-winfinity');
});
```

桌面 extraResources 同样在该测试里读 `apps/desktop/package.json`：

```ts
it('is packaged as an extraResource', () => {
  const desktopPackage = JSON.parse(readFileSync(
    new URL('../../../apps/desktop/package.json', import.meta.url),
    'utf8',
  )) as { build?: { extraResources?: Array<{ from?: string }> } };
  expect(desktopPackage.build?.extraResources?.some(entry => entry.from === '../browser-extension-winfinity')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-extension-routing.test.ts`
Expected: FAIL，检查脚本/打包尚未包含目录。

- [ ] **Step 3: Write minimal implementation**

`check-extension-syntax.mjs`：

```js
const dirs = [
  join(root, 'apps', 'browser-extension'),
  join(root, 'apps', 'browser-extension-bg'),
  join(root, 'apps', 'browser-extension-winfinity'),
];
```

`apps/desktop/package.json` extraResources 增加与 BG 相同结构、`from: "../browser-extension-winfinity"`。

`AGENTS.md`：启动器增加桃园 `tao-yuan-baccarat` / 房间 `dafabet-winfinity` / 扩展 `apps/browser-extension-winfinity`。写明用该厅时停用另外两个扩展。第一期无下注。桥允许三个扩展 ID，仍一条连接。

`README.md`：包列表增加该扩展。

版本：`1.0.1` → `1.0.2`（`apps/desktop/src/console-build-info.ts`、根 `package.json`、`apps/desktop/package.json`）。

- [ ] **Step 4: Run the tests and make sure they pass**

Run:

```
npm run check:ext
npx vitest run --config vitest.config.ts packages/browser-bridge/test/winfinity-runtime.test.ts packages/browser-bridge/test/winfinity-bridge-integration.test.ts packages/browser-bridge/test/winfinity-extension-routing.test.ts packages/browser-bridge/test/winfinity-wire.test.ts packages/browser-bridge/test/identity.test.ts packages/browser-bridge/test/bg-bridge-integration.test.ts apps/desktop/test/winfinity-monitor-room.test.ts apps/desktop/test/bg-monitor-room.test.ts apps/desktop/test/monitor-table-selection.test.ts
```

Expected: `extension syntax ok` 且上述测试全绿。

现场验收（非 CI，做完后人工）：停用 Pragmatic/BG 扩展 → 加载 Winfinity 扩展 → 打开桃园弹窗 → 必要时刷新弹窗 → 待加入出现短号 → 第二次 `shoeId` 变化后可晋升。

- [ ] **Step 5: Commit**

```bash
git add scripts/check-extension-syntax.mjs apps/desktop/package.json AGENTS.md README.md DESIGN.md apps/desktop/src/console-build-info.ts package.json packages/browser-bridge/test/winfinity-extension-routing.test.ts
git commit -m "chore: 打包 Winfinity 扩展并记录互斥采集"
```

---

## Spec coverage

| Spec 要求 | Task |
|---|---|
| 独立扩展、不改 PP/BG 钩子 | 6 |
| 房间 `dafabet-winfinity` | 5、7、8 |
| `streamId` / `wnf-` 桌号，禁止裸 hex | 1、7、8 |
| 别名锁定不中途改键 | 1 |
| `BETS_OPEN` 无 closesAt | 2 |
| `BETS_CLOSING` 更新 closesAt | 2 |
| `GAME_STARTED` 不当新开窗 | 2 |
| 增量牌、去重、rank 映射 | 3 |
| `GAME_RESULTS` pPair/bPair | 4 |
| 首次 attach / 二次 protocol-shuffle | 4 |
| 丢弃 WINNERS_LIST | 4、6 |
| 拒绝下注 | 6、7 |
| 单连接 / 三 ID 白名单 | 5、7 |
| 待加入 + 洗牌后晋升 | 8 |
| extraResources / check:ext / 文档 / 版本 | 9 |
| 8 副牌 profile | 4 |
| 不 tabs.reload | 6 |
| 人工确认 `wnf-${tableId}-operator` | 4、7 |

## 执行注意

- Task 7 的下注拒绝必须在 `dispatchExecution` **最前**，否则单测会被「无扩展连接」挡住。
- Task 8 用已有 `DesktopConsoleService.updateMonitorTableIds` 测桌号校验。
- 不要把 Winfinity 钩子加进 `apps/browser-extension` 或 `apps/browser-extension-bg`。
- 不要为了绿测试放宽 `PRAGMATIC_TABLE_ID_PATTERN` 去接受带连字符的 id。
