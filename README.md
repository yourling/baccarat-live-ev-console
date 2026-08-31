# 百家乐实时 EV 中控台（第一阶段）

本机优先的模块化单体 + 事件溯源 + 每桌串行 Actor。目标是可作为实际软件运行：SQLite 文件持久化、严格追加事件账本、崩溃后重启恢复、全局风控状态落盘、桌面端 IPC 控制台。

## 当前状态与资金安全

**截至 2026-08-27，代码层已经形成采集、对子 EV、受控执行、保活、结算和收益统计的完整链路，但真实资金发布仍未批准。** 当前只允许隔离、非资金的集成与长稳验证；不要把 `live`、`liveOn`、页面执行器或无人值守恢复能力视为资金使用许可。

- 对子 EV 策略与庄对/闲对单次 `BetIntent` 经过 `TableActor`、`RiskManager`、reservation、桥接回执、结算，以及按桌/靴/局/市场的重复保护。
- 四市场 `OperationalWager` 支持 `banker`、`player`、`bankerPair` 和 `playerPair`，用于手动操作与庄/闲保活。它也统一进入同一 actor/风控/reservation/结算链路，并按桌/靴/局/市场/来源防重。
- 所有可到达平台的请求都要求 `physical-shoe`、已连接投影、当前下注窗口、未封靴和可用桥接。`UNKNOWN` 会保留风险敞口、关闭保活并阻断所有后续执行；新一局出现上一局未结算 reservation 时同样失败关闭。
- 桌面运行监督器持久化每桌 live 批准和事故记录；默认裁剪到 200 条，但仍在生效的阻断事故绝不因历史上限被淘汰。进程重启后先降为 `shadow` 并写入 `process-restarted` 断线事件，只有当前进程重新观察到新鲜数据、实体牌靴和恢复后的连续投影，且没有 `UNKNOWN` 或结算缺口时，才恢复无人值守授权。
- 本机桥固定校验打包扩展 ID 和共享 loopback token，要求恰好一个扩展连接，并校验扩展会话内单调消息序号。连续性证明必须是 `cursor-v1:<64 lowercase hex>`，且由上一游标与下一条连续事件或实体新靴重置生成。
- 页面诊断只发送长度、数量等元数据；桥接日志移除正文/HTML/网络载荷预览，并去除 URL 查询参数和 fragment。事故消息还会脱敏 URL、token、authorization、cookie 和 session 值。

剩余边界不是已知的代码旁路，而是外部发布条件：打包程序仍需在真实站点完成独立、非资金的长稳验收，覆盖断线、过期、重启和结算连续性；之后还需产品/安全发布审批、适用法律与平台条款确认，以及单独的真实资金授权。

当前阶段完成：
- 精确组合概率、烧牌后验、保守 EV（`packages/probability`）
- 契约与输入校验（`packages/contracts`，`EVENT_SCHEMA_VERSION=1`）
- SQLite（better-sqlite3 + WAL）事件账本、投影、重放（`packages/ledger-state`）
- 事件冲突检测：event_id 相同但 payload 不同 / sourceSeq 冲突均拒绝，绝不静默改写历史
- 每桌串行 Actor、决策与回执幂等、重启恢复（`packages/orchestrator`）
- 持久化全局风控：预留/释放/结算、日/桌/靴亏损、重启恢复（`packages/risk-execution`）
- 影子/模拟执行桥；Pragmatic Play 的庄对/闲对 `BetIntent` 与四市场受控 `OperationalWager` 执行实现（`packages/adapter-contract`、`packages/browser-bridge`、`apps/browser-extension`）
- 房间级牌桌数据导出监控层：房间发现、逐桌导出、游标/批量/健康、断点续传（`packages/room-monitor`）
- 浏览器扩展 + 本地 WebSocket 桥：从 Pragmatic Play 真实游戏页面采集房间/牌桌数据，并提供真实下注执行通道（`packages/browser-bridge` + `apps/browser-extension`）。Dafabet 只作为 Jeju Speed Baccarat 弹窗启动器（`dafabet-pragmatic`）
- Electron + React 桌面控制台：IPC、arm/disarm、副数修正、事件/决策/回执审计、运行事故与后台生命周期（`apps/desktop`）

## Pragmatic Play 集成边界

自动对子 EV 策略和 `BetIntent`/单次下注仅接受 `bankerPair`（庄对）和 `playerPair`（闲对）。`OperationalWager` 接受 `banker`（庄）、`player`（闲）、`bankerPair` 和 `playerPair`，其中全局定时保活只选择庄或闲。两者都由桌台 actor 串行执行并接入统一风控、预留、回执审计和牌局结算。

浏览器端还会检查唯一 Dafabet Pragmatic 弹窗（`/live-dealer/popup-launch/jeju-speed-baccarat`）、唯一匹配桌台的 `client.pragmaticplaylive.net` iframe、会话 live gate、平台状态、限额、余额和未确认筹码。仓库已删除 mstrom / Evolution / 旧 live-baccarat 适配器。当前标准结算条款按庄赢净利 `0.95`、闲赢净利 `1`、和局退回本金处理；对子使用桌台配置赔率。最终收益由对应 reservation 的 `realizedPnl` 汇总，而不是仅按平台接受回执推算。

## 目录

- `packages/contracts`：冻结契约、默认配置、哈希、校验。
- `packages/probability`：精确概率、EV、烧牌后验、保守下界。
- `packages/ledger-state`：事件账本、投影、重放。
- `packages/adapter-contract`：适配器接口、模拟适配器、归一化降级。
- `packages/room-monitor`：游戏房间/牌桌发现、逐桌导出、游标/批量/健康与断点续传。
- `packages/browser-bridge`：浏览器扩展 ↔ 本机控制台的 WebSocket 桥、BridgeRoomMonitor、真实下注请求通道。
- `packages/simulator-fixtures`：确定性事件流构造器。
- `packages/orchestrator`：桌台串行 Actor、策略选择、幂等、持久化表配置。
- `packages/risk-execution`：全局风控、预留/释放/缩额/结算。
- `apps/desktop`：Electron + React 桌面壳层（主进程持久化服务 + IPC）。
- `apps/browser-extension`：Chrome/Edge Manifest V3 扩展，content script 采集 + 下注执行适配器。

## 命令

```bash
npm install
npm test                          # 全量自动化测试
npm run build                     # 全仓 TypeScript 校验
npm run demo                      # 终端演示核心回放/影子/模拟执行
npm run smoke                     # Electron 持久化控制台服务冒烟测试（临时库，重启恢复）
npm run dev:web                   # 启动 Vite 渲染层 http://127.0.0.1:5173
npm run build:desktop -w @baccarat/desktop   # 构建渲染层 + 打包 Electron 主进程
npm run electron -w @baccarat/desktop         # 构建后启动持久化桌面应用
npm run package:desktop:win                   # 生成 Windows portable 验收包
```

Electron 主进程默认加载 `apps/desktop/dist/index.html`；如需连接开发服务器，设置环境变量 `VITE_DEV_SERVER_URL=http://127.0.0.1:5173`。数据库位于 Electron `userData/console.sqlite`（WAL 模式）。

## 浏览器扩展接入

1. 在桌面控制台服务中启动本地桥：
   ```ts
   await service.startBrowserBridge(17890);
   ```
2. Chrome/Edge 扩展管理页加载 `apps/browser-extension`（开发者模式 → 加载已解压的扩展）。
3. 打包扩展默认连接带固定 token 的 `ws://127.0.0.1:17890`，Manifest key 保证扩展 ID 稳定。`bridgeUrl` 仍可通过 `chrome.storage.local` 修改，但桌面桥只信任固定 ID/token；不要改为不受信任或非隔离的端点。
4. Pragmatic Play 通过 `pragmatic-network-hook` / `pragmatic-dom-hook` 上报房间/牌桌事件。游戏 iframe 在 `pragmaticplaylive.net`（以及 `vbgames88.com` / `zavjcswh.biz` 镜像）；Dafabet 弹窗只负责启动该 iframe。
5. 桥接层收到事件后，经 `BridgeRoomMonitor`/`TableExport` 导出给 orchestrator/ledger。`BetIntent` 与 `OperationalWager` 都可能请求唯一匹配的 Dafabet Pragmatic 弹窗和游戏 iframe。

## 核心验证点

- 8 副新靴普通对子概率约 `7.4699%`；庄对/闲对对称。
- 同一事件流重放两次哈希一致；红牌当前局结算后才封存，红牌后不再开窗下注。
- 事件账本幂等：相同 `eventId` + 相同 payload 返回 `duplicate`；`eventId` 相同 payload 不同或 `sourceSeq` 冲突抛 `LedgerConflictError`。
- 手工副数修正会从全部已见牌重算剩余库存；默认必须重新武装。
- 断线会进入 `RESYNCING`；只有严格的 `cursor-v1` 证明和连续下一事件，或明确的 `physical-shoe` 新靴重置，才能恢复导出。扩展页面恢复事件本身不会伪造 `tableRestored`。
- `BetIntent` 按桌/靴/局/市场防重；`OperationalWager` 按桌/靴/局/市场/来源防重。所有真实请求都先建立持久 reservation。
- 风控状态与 reservations 会落盘并在重启后恢复；庄、闲、庄对、闲对均在 `handSettled` 后更新日/桌/靴盈亏，和局按 push 结算。
- 影子模式不调用执行器；模拟模式保留 reservation 到 `handSettled` 按 `outcomes` 结算盈亏。
- 桌面演示使用带种子的伪随机牌靴模拟；点击“开始持续模拟”后按局间隔生成牌面，点击“停止持续模拟”结束；关闭重开不会丢历史。
- 监控层按桌导出时检测 sourceSeq 缺口、以消费方 ack 推进游标、支持从游标续传；影子源支持断线/自动恢复故障注入与 continuity proof 回调。
- 浏览器桥支持房间发现、实时 tableEvent、断线/恢复通知和执行请求；桌面运行时要求固定扩展身份/token、恰好一个连接、连续扩展会话序号和 45 秒内的新鲜牌桌观测。
- 监控附着失败按 2s / 5s / 15s / 30s（封顶）持续重试；扩展三次快速恢复失败后按 1m / 5m / 15m / 30m（封顶）继续监督。
- 关闭桌面窗口只会隐藏窗口，监控、桥接、保活调度和账本继续运行；真正退出应用时才关闭服务。
- 页面诊断只传长度/数量元数据，桥接调试日志只保留脱敏 URL 和载荷长度，不记录正文、HTML 或原始网络载荷预览。

## Pragmatic Play 集成核对

当前没有获批的最小金额真实验证流程。不要把代码中的 `live` 开关视为资金使用许可。
