# 全项目代码审查报告

- 日期：2026-09-10
- 范围：`packages/*`（9 个包）、`apps/desktop`、`apps/browser-extension`、`apps/browser-extension-bg`、`apps/browser-extension-winfinity`
- 规模：约 5.8 万行源码 + 6.2 万行（含测试），59 个测试文件 / 795 个用例
- 方式：只读审查，未修改任何源码

---

## 零、先说结论

**当前 `npm run build` 是红的，`vitest` 也是红的，而且这个问题在 HEAD 上就已经存在**（不是本次未提交改动引入的）。没有 CI、没有 git hook，所以红构建被一路提交到了 `cae0354`。

对于一个操作真金下注的系统，这是最需要先修的东西——它意味着"改完能不能过"这件事目前无人把关。

| 检查项 | 结果 |
|---|---|
| `npm run build` | ❌ 3 个 TS 错误 |
| `npx vitest run` | ❌ 794 通过 / **1 失败** |
| `check:ext`（扩展语法） | ✅ 16 文件通过 |
| 版本一致性（1.0.10） | ✅ 三处一致 |
| CI / pre-commit hook | ❌ 均不存在 |

---

## 一、构建与测试（阻塞级）

### 1.1 三个 TS 错误，全部在 HEAD 已存在

```
apps/desktop/test/bg-monitor-room.test.ts(310,18)  TS2741
  类型 '{ tableId; gameCount }' 缺 TableDescriptor 必需的 profile 属性

apps/desktop/vite.config.ts(4,37)  TS7016
  无法为 './scripts/console-build-defines.mjs' 找到声明文件

packages/browser-bridge/src/server.ts(1482,7)  TS2322
  Winfinity 拒绝回执的 reservationId 是 string | undefined，
  但 BetReceipt 要求 string
```

第三个是我核对过的：`requestExecution` 的 intent 分支里 `request.reservationId` 是可选字段，
直接原样塞进 `BetReceipt`。修法是补默认值或把该字段在 `BridgeExecutionReceipt` 上放宽。
（`git show HEAD:...server.ts` 确认该代码与工作区一致，不是 Winfinity 改动引入的。）

### 1.2 一个失败的测试，根因是真实逻辑回归

```
apps/desktop/test/service.test.ts:770
arms pair EV after an approved physical shoe confirmation
期望 status=WAITING_CONFIRMATION / autoBetStatus=DISARMED
实际 status=TRACKING         / autoBetStatus=ARMED
```

根因在 `packages/orchestrator/src/table-actor.ts:390-398`：

```ts
autoConfirmNewShoe: incomingConfirm
  || event.baseline === 'physical-shoe'      // ← 问题在这里
  || this.profile.autoConfirmNewShoe,
```

`event.baseline === 'physical-shoe'` 无条件为真，导致桌配置里的 `autoConfirmNewShoe: false`
对**任何**实体靴都失效，靴一进来就直接 TRACKING + ARMED，等不到人工确认。

按 AGENTS.md 的原文，本意是"**协议洗牌开出的**实体靴自动进入跟踪"，而不是"所有实体靴"。
这个条件写宽了，把人工确认靴也一起吞了。于 c ommit `9bac505` 引入，测试未同步更新。

**这不只是测试问题**：桌配置里显式关掉自动确认的桌，现在会无声地自动 ARM 并开始评估对子 EV。

---

## 二、资金安全（高危）

### 2.1 对子窗口校验在时钟偏差时被彻底绕过 ★最严重

`packages/orchestrator/src/betting-window.ts:18`

```ts
return Math.abs(now - closesAtMs) > 60_000 ? closesAtMs - 10_000 : now;
```

当本地时钟与平台 `closesAt` 相差超过 60 秒时，函数返回 `closesAtMs - 10_000`，
于是 `bettingWindowRemainingMs` 恒等于 `10000`ms ≥ `PAIR_BET_MIN_WINDOW_MS(3000)`，
**`isPairBettingWindowReady` 永远返回 true**。

触发条件：本机时钟比平台快或慢 ≥60 秒（真人厅页面时钟 / 时区 / 系统时间漂移都可能造成）。

后果恰恰最坏——**正是时钟不可信、最需要这道校验的时候，校验被关掉了**。
窗口其实早已关闭，系统仍判定"还剩 10 秒"，于是照常发对子注
（`controlled-wager.ts:100`、`one-shot-bet.ts:84`、`table-actor.ts:587` 都依赖这个判定）。

建议：时钟偏差超限时应**保守拒绝**（返回 false 让 `remainingMs` 落到阈值以下），
而不是伪造一个"还剩 10 秒"。

### 2.2 手工下注与关闭流程竞态

`apps/desktop/electron-src/service.ts:2741` `executeOperationalWager`

- 没有走 `enqueueExecutionStateOperation`（`setAutoBet` / `setExecutionMode` 都走了）
- 没有检查 `this.closing`
- 只在开头读一次 `const bridge = this.browserBridge`，之后 `await this.operationalWagers.executeManual(input)`（内部经桥下真金注）

`close()`（service.ts:3202）会置 `this.closing = true` 并把 bridge 拆成 `undefined`，
但因为手工下注没进队列，`close()` 不会等它。

触发条件：下注进行中关闭窗口（AGENTS.md 明确"关闭桌面窗口即退出进程"）。
后果：下注在桥被拆的过程中发出，或 `finally` 里的 `bridge.setLiveBetEnabled(false)`
作用在已关闭的桥上，live gate 状态残留。

### 2.3 RESERVED 预留泄漏，会逐步堵死全局限额

`packages/risk-execution/src/risk.ts:542-548`

```ts
const matches = this.snapshot().filter(
  r => r.status === 'RESERVED'
    && r.tableId === tableId
    && r.shoeId === shoeId
    && r.receiptId === undefined,      // ← 有回执的永不过期
);
```

已拿到 ACCEPTED 回执、但 `handSettled` 事件丢失的 reservation，会永远停在 RESERVED。
`reconcileTable`（:581）只在 shoeId 不符时才过期，也救不了。

后果：`reservedExposure` 与 `pendingExecutions` 被永久占用 → 全局 exposure cap
与 `maxConcurrentExecutions` 逐步打满 → 该桌乃至全局再也下不了注，且没有任何自动告警。

缓解：操作员可以用 `settleReservedManually`（:388）手工勾销。但这是事后人工介入。
建议增加"已提交但超时未结算"的自动对账/过期路径。

### 2.4 BG 真金下注缺回合一致性校验与注额校验

- `apps/browser-extension-bg/bg-protocol.js:686-736`：`submit` 把 `Number(handId)`
  直接当 `seqNo` 发出，**不校验它是否等于当前开盘回合**的 `session.seqNoByTable[tableId]`。
  `bg-bet-runtime.js:228-279` 的 `precommitReason` 只查 uid/token/socket/倒计时/betInFlight。

  对比：Pragmatic 侧有 `round-not-current` / `round-id-unreadable` 双重校验，BG 缺这一关。
  传入过期 handId 会把真金下到错误或已关闭的回合。

- `bg-bet-runtime.js:238-240` 只校验 `amount <= 0`，**缺桌台 min/max 注额预校验**
  （minBet 只在 DOM 采集侧读取，没进下注前置校验）。AGENTS.md 明确要求"缺 session/socket/
  开盘倒计时则预提交拒绝"，注额同样是应有项。

---

## 三、中等风险

### 3.1 桥接暂停态队列无界增长（OOM）

`packages/browser-bridge/src/server.ts:849`（`ingestEvent` push）+ `:942-943`（drain 在 paused 时 return）

export 因陈旧被置 `paused=true` 但 `stopped=false` 时：`ingestEvent` 仍在 push，
`drain` 在 `this.paused && !(await this.restoreFromPending())` 直接 return 不消费。
叠加 `handleRestored` 的 `await restored` 无超时 → `pending` 无限增长。
触发：已选中桌进入 stale 但仍在收事件。长时间运行会 OOM。

### 3.2 Winfinity WS 缓冲区无界增长

`server.ts:2198-2209` `bufferWinfinityWsFrame`：达到
`WINFINITY_WS_ALIAS_BUFFER_LIMIT` 后若 `publicId === undefined` 就直接 return，
**既不 flush 也不裁剪**。此后每一帧都会再次走这条路径继续 push → 永久增长。

### 3.3 降级桌的采集连接泄漏

`apps/desktop/electron-src/service.ts:770` `demoteAnomalousMonitorTable`：
把桌移出 `monitorTableIds` 并持久化，但**没有** `stopLiveFeed` / `failCloseLiveExecution`。
而 `scheduleDisconnectedMonitorRemoval`（:1790）第一行就是
`if (!this.monitorTableIds.includes(tableId)) return;` —— 已被移出列表的桌不会再排清理定时器。

结果：因缺牌异常被降级、但连接仍健康的桌，其 WebSocket/导出 feed 一直开着，
持续占用桥资源直到进程退出。

### 3.4 退出路径上服务可被重建

`apps/desktop/electron-src/main.ts:37-42` `getService()` 在 `service` 为 null 时无条件重建
（重开 `console.sqlite`、重建 bridge/monitor）。`appQuitting` 标志在 :31 声明、:202 赋值，
但**从未被 `getService()` 或任何 IPC handler 检查**。

`before-quit` 里 `service = null` 先执行、`app.quit()` 后执行，这个窗口期内任何 IPC
都能把整套下注链路重新拉起来。

### 3.5 安全：WS 无消息大小上限 / 硬编码 token

- `server.ts:1102` `WebSocketServer` 未设 `maxPayload`（ws 默认 100MB），
  `:1149-1152` 任意大小 `JSON.parse`。roomDiscovered / tableEvent / hello / diagnostic
  都不受 65KB 网关限制。本机 DoS / OOM。
- `packages/browser-bridge/src/identity.ts:18` 共享 token 明文硬编码入库。
  有 chrome-extension origin + 白名单 ID 兜底，属纵深防御削弱而非直接可利用，
  但建议改为安装期生成。
- `server.ts:1823-1831` loopback command 路径不校验命令名白名单，
  任意 127.0.0.1 客户端可广播任意命令（含 liveOn/liveOff）给扩展。

### 3.6 其他

| 位置 | 问题 |
|---|---|
| `server.ts:2552` | `rejectPendingBets` 用 `pending.ownerSocket !== sourceSocket` 判断，非 live 下注 `ownerSocket=undefined`，断连时被跳过、不即时 reject（有 betTimeoutMs 兜底） |
| `server.ts:1446-1448` | 所有 Pragmatic 桌强制串行到单一 lane，跨桌互相阻塞 |
| `browser-extension-bg/background.js:382-404` | `betRequests` Map 只 set 不 delete；同 `requestId` 直接复用旧回执，UNKNOWN 重试会拿到过期结果 |
| `bg-network-hook.js:148-163` | 收包捕获依赖原型 `onmessage` 是访问器，页面用 `addEventListener` 或补丁前已赋值则漏采（fail-closed，安全但数据缺失） |
| `pragmatic-runtime.ts:71-81` | Pragmatic gameCount 不封顶 80（BG/Winfinity 已封顶），长靴不触发新靴 |
| `operational-wager-coordinator.ts:89` | 15s interval 调 `tick()` 不传 tableId，`tickInner` 在 `tableId===undefined` 直接 return → 实质空转死代码 |
| `server.ts:2348/2355` | `noteProtocolObservation` / `noteRuntimeStateObservation` 定义后从未被调用 → runtime-state 新鲜度监控完全不生效 |

---

## 四、工程卫生

### 4.1 根目录被临时脚本淹没

```
tmp-*.py        375 个
.tmp-*          131 个（含 1MB tmp-electron-hang.dmp、多张大厅截图）
_patch*.py / _q_*.py   38 个   ← 未被 .gitignore 覆盖
```

`.gitignore` 里只有 `/tmp-*` 和 `/.tmp-*`，**没有覆盖 `_patch*` / `_q_*`**，
所以有 66 个文件一直是 `??` 未跟踪状态，混在 `git status` 里。
建议：清理 + 补 `.gitignore`（或统一挪到 `.scratch/` 并忽略）。

### 4.2 测试覆盖严重不均

| 包 | 测试文件数 | 说明 |
|---|---|---|
| browser-bridge | 20 | 充足 |
| ledger-state | 3 | |
| orchestrator | 2 | 核心下注编排 |
| **risk-execution** | **1** | **风控，485 行** |
| **contracts** | **1** | **冻结契约** |
| probability | 1 | |
| room-monitor | 1 | |
| adapter-contract | 1 | |

`risk-execution` 只有一个测试文件，而 2.3 的预留泄漏正是发生在这里。
契约包、概率包同理。资金关键路径的测试密度偏低。

### 4.3 其他

- `apps/lord-god-space/`（~1450 行，已 gitignore）是无关注册旁支应用，仍占工作区。
- 无 CI、无 pre-commit hook —— 这是 1.1/1.2 能进 HEAD 的直接原因。
- 无 TODO/FIXME 残留，无 `console.log` 污染（仅桥接 5 处带前缀的诊断输出，且已做脱敏）。

---

## 五、建议修复顺序

**第一批（阻塞，先让构建和测试变绿）**
1. 修 3 个 TS 错误（server.ts:1482 补 reservationId、vite.config.ts 加 .d.ts、测试补 profile）
2. 修 `table-actor.ts:390` 的 `autoConfirmNewShoe` 条件 → 让 service.test.ts:770 变绿
3. 加 pre-commit hook 或 CI：至少跑 `npm run build` + `vitest run`

**第二批（资金安全）**
4. `betting-window.ts:18` 时钟回退改为保守拒绝 ★
5. `executeOperationalWager` 入执行队列 + 校验 `closing` ★
6. BG `submit` 加回合一致性校验 + 注额上下限预校验 ★
7. RESERVED 预留加超时对账路径

**第三批（稳定性）**
8. 桥接 paused 队列与 winfinityWsBuffer 加上限与丢弃策略
9. 降级桌停止 liveFeed
10. `getService()` 检查 `appQuitting`；`close()` 加超时
11. WS `maxPayload`；loopback command 加白名单

**第四批（卫生）**
12. 清理根目录临时文件 + 补 `.gitignore`
13. 补 risk-execution / contracts / probability 的测试
14. token 改为运行期生成
