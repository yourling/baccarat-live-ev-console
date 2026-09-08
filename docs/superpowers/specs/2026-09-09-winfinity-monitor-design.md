# Winfinity 桃园厅监控采集设计

日期：2026-09-09  
状态：已通过对话确认，待实现计划  
范围：第一期只做监控与采集，不做下注

## 背景

Dafabet 启动器 `https://www.dafabet.net/sc/live-dealer/popup-launch/tao-yuan-baccarat` 打开的是 **Winfinity** 多桌百家乐大厅（Tao Yuan / Shangrila），不是 Pragmatic，也不是 BG。

2026-09-09 在已登录弹窗上核实：

- 大厅 iframe：`https://lobby.youngpoisson.xyz/`
- 多桌游戏 iframe：`https://baccarat-multitable.youngpoisson.xyz/`
- 一屏约 11 桌（Tao Yuan 与 Shangrila 百家乐）
- 实时通道：**一条 JSON WebSocket**，按 `meta.tableId` 多路复用
- 构建产物含 `webpackChunkwinfinity_lobby`

现有 Pragmatic / BG 钩子不匹配 `*.youngpoisson.xyz`，因此可以加第三条采集链路而不改现有钩子文件。

## 目标

在不影响 Pragmatic / BG 采集代码的前提下，把 Winfinity 多桌大厅接入中控台：发现桌、跟靴、开窗、发牌、结算。

成功标准：

1. 只加载 Winfinity 扩展并打开桃园弹窗时，待加入出现短号桌（如 `tyn-bac8`）。
2. 同一桌 `shoeId` 第二次变化后可晋升监控，开窗 / 发牌 / 结算出现在监控行。
3. 现有 Pragmatic / BG 测试全绿；新摄入不创建 `dafabet-pragmatic` / `dafabet-bg` 房间。
4. 第一期任何下注请求被拒绝，不调用 Winfinity gateway，不点页面。

## 已确认决策

| 决策 | 选择 |
|---|---|
| 运行时并存 | **A**：与现有厅互斥。本机桥仍只接受一条扩展连接、一个 executor lease。用桃园厅时停用 Pragmatic 与 BG 扩展。 |
| 第一期范围 | 监控 + 采集。不下注。 |
| 隔离方式 | 第三条独立扩展，对标 BG，不把钩子塞进现有扩展。 |
| 房间 | 固定 `dafabet-winfinity`，显示名「Dafabet Winfinity」。 |
| 桌号 | 控制台 `tableId` 用稳定短号（`streamId`，如 `tyn-bac8`）。供应商 24 位 hex 只留在适配器内部。 |

## 非目标（第一期）

- 与 Pragmatic / BG **同时**采集（需要拆采集连接与 executor lease，另开设计）。
- Winfinity 真金下注、保活、对子自动策略打到这个厅。
- 采集 `WINNERS_LIST`、余额、玩家名单、聊天。
- 修改 `packages/contracts` 事件形状。
- 修改 Pragmatic / BG 的 DOM / 网络钩子文件。
- 用 `lastGameResults` 旧珠盘回填实体库存。
- 扩展重载后自动 `tabs.reload` 游戏弹窗。

## 架构

```
桃园启动器 (dafabet.net/.../tao-yuan-baccarat)
  → lobby.youngpoisson.xyz
  → baccarat-multitable.youngpoisson.xyz
       → JSON WebSocket（多桌复用）
            → 新扩展 MAIN world 网络钩子
            → content.js
            → 本机桥 networkCapture
            → winfinity-runtime.ts
            → NormalizedEvent
            → BridgeRoomMonitor / 待加入 / TableActor
```

| 层 | 职责 |
|---|---|
| `apps/browser-extension-winfinity` | 只认桃园弹窗与 `*.youngpoisson.xyz`。镜像游戏 JSON 文本 WS。发现桌并转发桥消息。无 bet-runtime。 |
| `packages/browser-bridge` `winfinity-runtime.ts` | 把 WS JSON 收成现有 `NormalizedEvent`。维护 objectId ↔ streamId、shoe token、牌面去重。 |
| 桥 `server.ts` | 新 capture source；房间白名单加上 `dafabet-winfinity`；下注请求拒绝。不放宽单连接。 |
| 桌面 | `isLiveMonitorRoomId` / 待加入过滤接受该房间。实体靴、64 桌、缺牌移出等规则复用。 |
| contracts / probability / orchestrator / risk | 不改契约，不新增下注入口。 |

扩展以 extraResources 打包，不是 npm workspace。生成独立 Manifest `key`，得到稳定扩展 ID，写入 `identity.ts` 的允许列表。loopback token 与现有两条扩展共用 `BUNDLED_BROWSER_EXTENSION_TOKEN`。

## 桌号规则

现场 `meta.tableId` 是 24 位 hex（例如 `638f56dc65729f90d0636fb0`）。它匹配现有 `PRAGMATIC_TABLE_ID_PATTERN`（`/^[a-z0-9]{8,32}$/i`）。若直接当控制台 `tableId`，执行车道会把它当成 Pragmatic 桌。

控制台 `tableId` 必须带连字符或 `wnf-` 前缀，避免进入 Pragmatic 车道：

1. 优先使用大厅稳定 `streamId`，小写保留连字符，例如 `tyn-bac8`。
2. 展示名用磁贴文案，例如 `Tao Yuan Baccarat 8`。
3. 拿不到 `streamId` 时使用 `wnf-<objectId>`。
4. 供应商 objectId 只存在适配器映射表，不作为 actor 键。

`streamId` 来源（按可用性，不编造）：

- 多桌 iframe URL 的 `streamId` / `tableId` 查询参数
- 大厅磁贴文案与数据属性
- 若出现 `TABLES_LIST` 且含短号，用它校正映射

Shangrila 短号以现场为准（同类 `*-bacN`），实现时从大厅读取，不在代码里写死桌清单。

只发现百家乐桌。轮盘 / 骰宝 / 其它 Winfinity 品类丢弃。

## 采集边界

扩展 `host_permissions` / content_scripts：

- `https://*.dafabet.net/*`（只为识别桃园启动器）
- `https://*.youngpoisson.xyz/*`

弹窗路径唯一：`/live-dealer/popup-launch/tao-yuan-baccarat`。拒绝 Jeju Speed 与 `live-baccarat-bg`。

网络钩子：

- 只包 `lobby.youngpoisson.xyz` 与 `baccarat-multitable.youngpoisson.xyz` 上的 `WebSocket`。
- 只转发 **文本** JSON 帧。二进制 ping/pong 不转发。
- **不**按冻结的 WS 主机名过滤游戏通道（主机可能轮换）。识别方式：载荷能解析为对象且 `type` 属于已知游戏事件。
- 明确忽略 Sentry / 分析通道（现场见过 `skt.youngpoisson.xyz/api/*/envelope/`，那是上报不是牌局）。
- 不镜像视频、不点「重新连接」、不创建 keeper 页、不 `tabs.reload` 游戏弹窗。

Capture source 名称：

- `baccarat-bridge-winfinity-ws`：原始文本帧
- `baccarat-bridge-winfinity-state`：可选的版本化桌快照（发现名、短号映射、珠盘局号）。第一期可以先只靠 WS + 大厅 DOM 映射，但 source 名要预留并加入 `LIVE_PROTOCOL_CAPTURE_SOURCES`。

## 事件映射

现场事件（已在弹窗上抓到）→ 现有契约。未知 `type` 丢弃，不断开整桥。

### 开窗 / 关窗

`GAME_STATE_CHANGED.state` 是对象：

| `state.state` | 动作 |
|---|---|
| `BETS_OPEN` | 对 `bankerPair` 与 `playerPair` 各发一条 `bettingWindowOpened`。`state.bettingTime` 为大于 0 的 Unix 毫秒才写 `closesAt`（ISO）。现场常见 `"0"`，则 **省略** `closesAt`。现有规则：没有关闭时间则不对子评估、保活也跳过。 |
| `BETS_CLOSING` | 若 `bettingTime` 有效，只更新 `closesAt`，不当新开窗。现场 `bettingTimeDuration` 约 `5000`。 |
| `BETS_CLOSED` | `bettingWindowClosed`（两个对子市场）。 |
| `GAME_STARTED` | 视为主窗口已关，发 `bettingWindowClosed`（若尚未关闭）。此时 `allowedSideBets` 含 PPAIR/BPAIR 是局中边注，**不当**主开窗。 |

`shoeId` = `meta.round.shoeId`（UUID）。`handId` = `meta.round.id`。

### 发牌

`CARDS_TAKEN.cards`：

- `cards`：本帧增量
- `allCards`：本局已见全部，只作核对

只把增量 `cards` 收成 `cardObserved`。用卡 `id` 按桌去重，重复忽略。

牌面：

| 现场 | 契约 |
|---|---|
| `card.rank` `ACE` `TWO` … `TEN` `JACK` `QUEEN` `KING` | `A` `2` … `10` `J` `Q` `K` |
| `card.suit` `SPADE` `HEART` `DIAMOND` `CLUB` | 可选花色字符串 |
| `position.area` `PLAYER` / `BANKER` | 闲 / 庄 |
| `position.order` `ORDER_LEFT` `ORDER_RIGHT` `ORDER_EXTRA` | `cardObserved.position` 写成 `player:left` / `banker:extra` 这类 |

无法映射的 rank 丢弃该张牌，记诊断，不编造。

### 结算

`GAME_RESULTS.gameResults.roundResult`：

- `pPair` / `bPair` → `handSettled.outcomes.playerPair` / `bankerPair`
- `won`：`PLAYER` / `BANKER` / `TIE`，只作核对，不写入契约新字段
- `playerCards` / `bankerCards`：本局已观测牌；缺牌不补

同一 `tableId + shoeId + handId` 重复结算忽略。

### 丢弃

`WINNERS_LIST`、`BALANCE_CHANGED`、以及第一期用不到的 `BETS_ARE_MADE` / `BETS_ACCEPTED` / `BETTING_GRID_STATS` / 聊天。

## 牌靴与待加入

沿用 `AGENTS.md` 实体靴硬规则，Winfinity 的洗牌 token 就是协议 `meta.round.shoeId`（UUID）。

1. 大厅发现的百家乐桌先入 **待加入**，不一次灌进监控。
2. 入桌默认 `unknown-monitor-session`。
3. 第一次见到某桌的 `shoeId` 只记 token，不升 `physical-shoe`，不自动晋升。
4. 同一桌 token **再次变化** → protocol-shuffle。协议洗牌开出的实体靴自动确认，桌配置 `autoConfirmNewShoe=false` 不得压回。
5. 珠盘局号（磁贴 `#48`）只作路子回绕、满 80 手、缺牌备份。禁止用滞后 DOM 局号把刚洗完的实体靴降级。
6. 8 副牌。满 80 手仍无洗牌证据则待牌靴。
7. 禁止把 `lastGameResults` 或超过 21 行的旧路回填进实体库存。
8. 人工确认重置仍可用，走现有 `confirmPhysicalShoe` 分支（Winfinity prefix，例如 `wnf-${tableId}-operator`）。

`TableProfile.numberOfDecks = 8`。新晋升桌继承统一 EV / 注额，不使用 factory `minEV=0`。

## 多桌过期

一条 WS 活着不等于每桌都在更新。

- **单桌过期**：按该桌最后一条已识别游戏事件计时。邻桌发牌不能刷新本桌。
- **整房断开**：WS 关闭或扩展断桥 → 该房间已选桌 `connectionLost`。
- 断开超过 15 秒的监控桌移除等现有监督规则继续适用；启动 60 秒内、洗牌 hold、未 flap 的闪断例外不在第一期改写。

## 下注（第一期）

扩展不包含 bet-runtime，不注入 `BaccaratBgProtocol` / `lpbet` 同类页面函数。

桥若收到针对 Winfinity 桌的 `requestBet` / `requestOperationalWager`：返回 `REJECTED` 回执，理由标明第一期无执行通道，不发到页面。`liveBetEnabled` 默认关闭。

本机桥仍然：一条扩展连接、`active_executor_count==1`。Winfinity 扩展连上即占用这条连接，因此必须停用另外两个扩展。

## 失败策略

- 坏 JSON、未知 `type`：丢弃该帧。
- 重复 `card.id`、重复结算键：忽略。
- 没有 `streamId`：`wnf-<objectId>`，不得用裸 24 位 hex。
- 映射校正（objectId → streamId）一旦获得短号，后续事件用短号；不得把已晋升桌改成另一个 `tableId` 而不走现有换键规则。第一期：短号必须在该桌 **第一次待加入出现之前** 就绪；若只有 objectId，就一直用 `wnf-<objectId>`，本进程内不中途改键。
- 扩展重载：`chrome.runtime.reload()`，不刷新游戏弹窗。钩子要重新包住 WS，需操作者手动刷新桃园弹窗（与 BG 相同）。

## 文件边界

新建：

- `apps/browser-extension-winfinity/manifest.json`
- `apps/browser-extension-winfinity/background.js`
- `apps/browser-extension-winfinity/content.js`
- `apps/browser-extension-winfinity/winfinity-network-hook.js`
- `apps/browser-extension-winfinity/winfinity-protocol.js`（扩展侧只做游戏帧识别与 objectId↔streamId 映射；`NormalizedEvent` 只在桥 `winfinity-runtime.ts` 生成）
- `apps/browser-extension-winfinity/winfinity-dom-hook.js`（大厅短号与珠盘局号）
- `apps/browser-extension-winfinity/README.md`
- `packages/browser-bridge/src/winfinity-runtime.ts`
- `packages/browser-bridge/test/winfinity-runtime.test.ts`
- `packages/browser-bridge/test/winfinity-extension-routing.test.ts`
- `packages/browser-bridge/test/winfinity-bridge-integration.test.ts`
- `packages/browser-bridge/test/fixtures/winfinity-*.json`（脱敏）
- `apps/desktop/test/winfinity-monitor-room.test.ts`

修改（白名单 / 打包 / 文档，不改现有钩子逻辑）：

- `packages/browser-bridge/src/identity.ts`：新扩展 ID、`DAFABET_WINFINITY_ROOM_ID`、`isLiveBridgeRoomId`
- `packages/browser-bridge/src/server.ts`：capture source、房间、`confirmPhysicalShoe` prefix、拒绝 Winfinity 下注
- `packages/browser-bridge/test/identity.test.ts`
- `apps/desktop/src/ui/monitor-table-selection.ts`
- `apps/desktop/electron-src/service.ts` 房间过滤
- `apps/desktop/package.json` extraResources
- `scripts/check-extension-syntax.mjs`
- `AGENTS.md`、`README.md`

合入实现时：`CONSOLE_VERSION` 与根 / `apps/desktop` `package.json` patch +1。本文档合入不改版本号。

**禁止修改：**

- `apps/browser-extension/**` 钩子（Pragmatic）
- `apps/browser-extension-bg/**` 钩子（BG）
- `packages/contracts` 事件形状

## 测试

CI 只用脱敏夹具，不上真站。

夹具保留：`type`、`state`、`cards`（增量与 `allCards`）、`roundResult`、`meta.tableId`、`meta.round.shoeId` / `id`、时间戳。删除：赢家名单、余额、token、`masterSessionId`、玩家昵称可换成占位。

必须锁住：

1. `BETS_OPEN` 且 `bettingTime=0` → 开窗但无 `closesAt`。
2. `BETS_CLOSING` 带毫秒截止 → 只更新 `closesAt`。
3. `GAME_STARTED` 不当新开窗。
4. 增量 `CARDS_TAKEN` 按卡 `id` 去重；`allCards` 不重复记账。
5. `GAME_RESULTS` 写出 `pPair` / `bPair`。
6. 第一次 `shoeId` 不升实体靴；第二次变化才 protocol-shuffle。
7. `tyn-bac8` 进入 `dafabet-winfinity`；裸 24 位 hex 不得进入 Pragmatic 房。
8. 扩展只认 `tao-yuan-baccarat`；拒绝 Jeju / BG 弹窗。
9. 桥摄入不创建 pragmatic / bg 房间。
10. 针对 Winfinity 桌的下注被拒绝。
11. 现有 Pragmatic / BG 测试保持全绿。
12. `check:ext` 扫到新扩展 JS。

现场验收（实现后，非 CI）：

1. 停用另外两个扩展，加载 Winfinity 扩展，打开桃园弹窗，必要时手动刷新弹窗以包住 WS。
2. 待加入出现短号。
3. 等一次洗牌 token 变化后可晋升；监控行能看到开窗、牌面、结算。
4. 控制台不出现 Pragmatic / BG 房间因本扩展而新建的桌。

## 实现顺序

1. 运行时解析器 + 夹具测试（桌号、开窗、牌、结算、鞋 token）。
2. 独立扩展骨架（manifest、弹窗路由、WS 镜像、大厅短号映射）。
3. 桥接入 capture source 与房间，拒绝下注。
4. 桌面待加入 / 监控白名单。
5. 打包 extraResources、语法检查、文档、版本 patch。

每步都要有失败测试先写再实现。
