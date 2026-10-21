# 百家乐实时 EV 中控台（第一阶段）

本机优先的模块化单体 + 事件溯源 + 每桌串行 Actor。目标是可作为实际软件运行：SQLite 文件持久化、严格追加事件账本、崩溃后重启恢复、全局风控状态落盘、桌面端 IPC 控制台。

## 当前状态与资金安全

**截至 2026-09-01，代码层已经形成采集、对子 EV、受控执行、保活、结算和收益统计的完整链路，但真实资金发布仍未批准。** 当前只允许隔离、非资金的集成与长稳验证；不要把 `live`、`liveOn`、页面执行器或无人值守恢复能力视为资金使用许可。

- 对子 EV 策略与庄对/闲对单次 `BetIntent` 经过 `TableActor`、`RiskManager`、reservation、桥接回执、结算，以及按桌/靴/局/市场的重复保护。自动对子只在有效 `physical-shoe`（protocol-shuffle / road-wrap / 人工确认）上评估；已打过的靴空窗约 6 分钟后恢复也按漏掉的洗牌开新靴。第一次见到 shoeReset、待牌靴或 `unknown-monitor-session` 时不下对子，避免假 EV 和 `UNKNOWN` 回执。路子 #55 配剩余 407 张这种入桌数字不得当成 8 副新靴。
- 四市场 `OperationalWager` 支持 `banker`、`player`、`bankerPair` 和 `playerPair`，用于手动操作与庄/闲保活。它也统一进入同一 actor/风控/reservation/结算链路，并按桌/靴/局/市场/来源防重。当前受控路径要求 `executionMode === 'live'`。
- 页头「开启保活」与「开启自动投注」互相独立：保活只打庄/闲，对子策略只打庄对/闲对。保活不再扫完整监控列表，只在刚开盘的那一桌尝试；窗口剩余不足 5 秒或没有 `closesAt` 则跳过，并进入约 10 秒冷却后再试下一窗，不因此更新间隔计时。
- 所有可到达平台的请求都要求 `physical-shoe`、已连接投影、当前下注窗口、未封靴和可用桥接。对子自动/one-shot/手动对子还要求窗口剩余至少 3 秒（`closesAt` 缺失则不评估）；窗口未就绪且未提交（`commitStarted===false`）的预提交拒绝可在同一局重试，已提交则标 UNKNOWN。`UNKNOWN` 会保留风险敞口并阻断当事桌后续执行，不把单桌未知敞口当成全局保活开关关闭；**本桌存在其他手未结算的 reservation 时，自动对子同样失败关闭该桌**（记 `eligible=false` 决策，reason 含 `settlement-gap`）。
- 桌面运行监督器持久化每桌 live 批准和事故记录；默认裁剪到 200 条，但仍在生效的阻断事故绝不因历史上限被淘汰。进程重启会写入 `process-restarted` 断线事件、关掉执行器与无人值守授权，牌桌仍为 `live`，不会先降成 `shadow`；**重启时还会把上一进程遗留的所有 `RESERVED` 敞口统一升级为 `UNKNOWN(restored-unsettled-exposure)`**，让它们进入可勾销队列（修复前这类敞口既不升级、换靴也不清、操作员也无法处置，会永久占用全局敞口与并发额度）。只有当前进程重新观察到新鲜数据、实体牌靴和恢复后的连续投影，且没有 `UNKNOWN` 或结算缺口时，才恢复无人值守授权。
- **本机桥的身份边界是「扩展 installId + 操作员批准」，不是扩展 ID 或 token**：固定扩展 ID 可由 manifest 公钥推导、token 是源码明文，二者都不构成密钥；缺 `installId` 的连接一律只拿到 `pending` 角色（不占扩展槽、不拿 executor lease、不 ingest 任何牌桌事件、收不到 `betRequest`），只有桌面端点批准后它才升级为 `extension` 角色。三个扩展的工具栏 popup 会显示本扩展 installId 前 8 位，供操作员与桌面待批准列表做**带外比对**。桥仍要求恰好一个扩展连接，并校验扩展会话内单调消息序号；连续性证明必须是 `cursor-v1:<64 lowercase hex>`，且由**已校验的上一游标 payload hash** 与下一条连续事件或实体新靴重置生成（不再由任意 shaped 字符串自证）。
- `/command` 只暴露只读诊断命令（`probeBetReadiness` / `replayRuntimeState` / `probeExtensionManifest`）。可改变真实下注状态的 `liveOn` / `liveOff` / `reloadExtension` 等**只能由桌面端通过桥内部广播触发**，不再接受任意本机 WS 客户端下发。
- 页面诊断只发送长度、数量等元数据；桥接日志移除正文/HTML/网络载荷预览，并去除 URL 查询参数和 fragment。事故消息还会脱敏 URL、token、authorization、cookie 和 session 值。
- 关闭桌面窗口即退出应用，并关闭监控、桥接、保活调度和账本服务。再次启动是新进程，不会沿用旧连接。

剩余边界不是已知的代码旁路，而是外部发布条件：打包程序仍需在真实站点完成独立、非资金的长稳验收，覆盖断线、过期、重启和结算连续性；之后还需产品/安全发布审批、适用法律与平台条款确认，以及单独的真实资金授权。

当前阶段完成：
- 精确组合概率、烧牌后验、保守 EV，以及从剩余库存直接评估（`packages/probability`）
- 契约与输入校验（`packages/contracts`，`EVENT_SCHEMA_VERSION=1`）
- SQLite（better-sqlite3 + WAL）事件账本、投影、重放（`packages/ledger-state`，账本 schema `5`）
- 牌面热路径留内存：`cardObserved` 不落 SQLite，当前靴牌面全留内存；SQLite 持久化新靴/结算/回执/决策和少量窗口事件。进程重启不清这些审计行，只丢内存牌面并让实盘跟靴待牌靴从头跟
- 事件冲突检测：event_id 相同但 payload 不同 / sourceSeq 冲突均拒绝，绝不静默改写历史
- 每桌串行 Actor、决策与回执幂等、重启恢复（`packages/orchestrator`）；Actor 重放默认 `latestShoeOnly`。进程重启会给实盘跟靴打上一进程水位，历史牌局/决策仍可复查，但不会把上一进程库存接着拿来算 EV
- 持久化全局风控：预留/释放/结算、日/桌/靴亏损、重启恢复（`packages/risk-execution`）
- 影子/模拟执行桥仍用于演示与测试；桌面实盘监控默认强制 `live`。Pragmatic Play 的庄对/闲对 `BetIntent` 与四市场受控 `OperationalWager` 执行实现（`packages/adapter-contract`、`packages/browser-bridge`、`apps/browser-extension`）
- 房间级牌桌数据导出监控层：房间发现、逐桌导出、游标/批量/健康、断点续传（`packages/room-monitor`）
- 浏览器扩展 + 本地 WebSocket 桥：Pragmatic、BG 与桃园 Winfinity 各有独立扩展。只抓游戏协议 WebSocket。不发送 `autoBet`、不点视频入座。三个扩展互斥，本机桥只接受一条连接。Winfinity 第一期只采集、拒绝下注
- Electron + React 桌面控制台：IPC、arm/disarm、副数修正、事件/决策/回执审计、运行事故与生命周期（`apps/desktop`）

## Pragmatic Play 集成边界

自动对子 EV 策略和 `BetIntent`/单次下注仅接受 `bankerPair`（庄对）和 `playerPair`（闲对）。`OperationalWager` 接受 `banker`（庄）、`player`（闲）、`bankerPair` 和 `playerPair`，其中全局定时保活只选择庄或闲。两者都由桌台 actor 串行执行并接入统一风控、预留、回执审计和牌局结算。

浏览器端还会检查唯一 Dafabet 弹窗：Pragmatic 为 `/live-dealer/popup-launch/jeju-speed-baccarat`，BG 为 `/live-dealer/popup-launch/live-baccarat-bg`，桃园 Winfinity 为 `/live-dealer/popup-launch/tao-yuan-baccarat`。仓库已删除 mstrom / Evolution / 旧 live-baccarat-pa 适配器。BG 真金提交走页面 MAIN world 的 `BaccaratBgProtocol.submit`；缺会话、socket 或开盘倒计时则预提交拒绝。`__baccaratBgBetAdapter` 仅测试覆盖。当前标准结算条款按庄赢净利 `0.95`、闲赢净利 `1`、和局退回本金处理；对子使用桌台配置赔率（默认净利 `11`）。最终收益由对应 reservation 的 `realizedPnl` 汇总，而不是仅按平台接受回执推算。

实盘最多监控 64 张桌。新会话默认不监控任何桌；只有环境变量 BACCARAT_LIVE_TABLES 才会预填桌号。大厅里尚未入监控的 Dafabet Pragmatic / BG / Winfinity 桌显示为「待加入」，仅本进程见过的协议 shoeReset token 变化、路子明显回绕或人工确认后才标实体新靴并晋升；第一次见到 shoeReset 或路子 #55 配满靴库存仍为待牌靴。刚洗完的实体靴即使 DOM 路子仍停在高位，也不得被降级。监控桌缺未观测牌超过 10 张会移出监控回到待加入，同一靴不会自动加回。断开超过 15 秒的监控桌会被移除；启动 60 秒内、洗牌 hold、以及未 flap 升级的 stale/闪断/重启不断开删除。

## 目录

- `packages/contracts`：冻结契约、默认配置、哈希、校验。
- `packages/probability`：精确概率、烧牌后验、保守 EV、剩余库存评估。
- `packages/ledger-state`：事件账本、投影、重放、执行审计；牌面事件为内存热路径。
- `packages/adapter-contract`：适配器接口、模拟适配器、归一化降级、`OperationalWager` 契约。
- `packages/room-monitor`：游戏房间/牌桌发现、逐桌导出、游标/批量/健康与断点续传。
- `packages/browser-bridge`：浏览器扩展 ↔ 本机控制台的 WebSocket 桥、BridgeRoomMonitor、真实下注请求通道、Pragmatic / BG / Winfinity 运行时归一化。
- `apps/browser-extension-bg`：Dafabet BG 独立扩展（extraResources，非 workspace）。
- `apps/browser-extension-winfinity`：Dafabet 桃园 Winfinity 独立扩展（extraResources，非 workspace；第一期只采集不下注）。
- `packages/simulator-fixtures`：确定性事件流构造器。
- `packages/orchestrator`：桌台串行 Actor、策略选择、幂等、持久化表配置、受控下注。
- `packages/risk-execution`：全局风控、预留/释放/缩额/结算。
- `apps/desktop`：Electron + React 桌面壳层（主进程持久化服务 + IPC）。npm workspace 仅包含 `packages/*` 与该应用。
- `apps/browser-extension`：Chrome/Edge Manifest V3 扩展，打包进桌面 extraResources；不是 npm workspace。
- `apps/lord-god-space`：本地无关实验应用，已被 `.gitignore` 排除，不属于本中控台。

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
npm run package:desktop:win:installer         # 生成 Windows NSIS 安装包
npm run bridge:observe                        # 观测桥接会话/诊断日志
npm run bridge:reload-extension               # 请求扩展重载
```

Electron 主进程默认加载 `apps/desktop/dist/index.html`；如需连接开发服务器，设置环境变量 `VITE_DEV_SERVER_URL=http://127.0.0.1:5173`。数据库位于 Electron `userData/console.sqlite`（WAL 模式，`wal_autocheckpoint=1000`）。

## 浏览器扩展接入

1. 在桌面控制台服务中启动本地桥：
   ```ts
   await service.startBrowserBridge(17890);
   ```
2. Chrome/Edge 扩展管理页加载 `apps/browser-extension`（开发者模式 → 加载已解压的扩展）。
3. 打包扩展默认连接带固定 token 的 `ws://127.0.0.1:17890`，Manifest key 保证扩展 ID 稳定。`bridgeUrl` 仍可通过 `chrome.storage.local` 修改，但桌面桥只信任固定 ID/token；不要改为不受信任或非隔离的端点。
4. Pragmatic Play 通过 `pragmatic-network-hook` / `pragmatic-dom-hook` 上报房间/牌桌事件。扩展只镜像游戏协议 WebSocket，不再镜像 fetch / Worker / 页面 IPC。游戏 iframe 在 `pragmaticplaylive.net`（以及 `vbgames88.com` / `zavjcswh.biz` 镜像）；Dafabet 弹窗只负责启动该 iframe。
5. 桥接层收到事件后，经 `BridgeRoomMonitor`/`TableExport` 导出给 orchestrator/ledger。下注请求走 `lpbet`；多台页不发送 `autoBet`，也不再点视频入座。

## 核心验证点

- 8 副新靴普通对子概率约 `7.4699%`；庄对/闲对对称。监控行分别显示庄对 EV 与闲对 EV；无物理牌靴时显示「待牌靴」，剩余张数为「未知」。
- **真实均衡洗牌下对子概率并不随剩余张数上升**：均匀分布时剩 26 张的 p 只有约 4.00%。正 EV 只来自「某些点数剩余异常集中」这种稀疏形态（实测 4809 手里约 1.71%）。`PHYSICAL_SHOE_BETTABLE_REMAINING = 26` 的停注下限刻意牺牲约 64% 的理论 edge，换取避开切牌不确定性 —— 这是有意的保守，不要当成 bug 或"越到尾越该打"。
- 同一事件流重放两次哈希一致；红牌当前局结算后才封存，红牌后不再开窗下注。
- 事件账本幂等：相同 `eventId` + 相同 payload 返回 `duplicate`；`eventId` 相同 payload 不同或 `sourceSeq` 冲突抛 `LedgerConflictError`。`cardObserved` 只在内存热路径，进程退出后不从 SQLite 重放逐张牌面。
- 手工副数修正会从全部已见牌重算剩余库存；若已见某点超过新副数容量则拒绝修正、桌状态不变。默认必须重新武装。人工确认牌靴只在平台未自动识别新靴时使用。
- 断线会进入 `RESYNCING`；只有严格的 `cursor-v1` 证明和连续下一事件，或明确的 `physical-shoe` 新靴重置，才能恢复导出。扩展页面恢复事件本身不会伪造 `tableRestored`。
- 对子自动下注只在 `betsopen` 窗口评估；窗口剩余不足 3 秒则跳过。预提交因窗口未就绪被拒后，同一局可以重试。换靴后仍保留近期 `handSettled`，以便决策行继续显示实际结果。
- `BetIntent` 按桌/靴/局/市场防重；`OperationalWager` 按桌/靴/局/市场防重（**不按来源**）—— 保活、手动、自动对子在同一手同一市场共用同一个唯一性键，跨来源重复下注会被拒（`executionSource` 只作审计字段）。所有真实请求都先建立持久 reservation。
- 风控状态与 reservations 会落盘并在重启后恢复；庄、闲、庄对、闲对均在 `handSettled` 后更新日/桌/靴盈亏，和局按 push 结算。跨靴的 `UNKNOWN` **不会**被下一靴同 `handId` 的结算自动确权，必须由操作员核对。
- 影子模式不调用执行器；模拟模式保留 reservation 到 `handSettled` 按 `outcomes` 结算盈亏。桌面实盘监控桌会被强制为 `live`；`OperationalWager` 拒绝非 live 模式。**执行模式不支持从 live 降级**：`setExecutionMode(..., 'shadow')` 会直接报错，不会假装降级却仍在真金执行。
- 桌面演示使用带种子的伪随机牌靴模拟；点击「开始持续模拟」后按局间隔生成牌面，点击「停止持续模拟」结束；关闭重开不会丢历史。演示表不参与自动下注与执行门控，也不会替换全局执行器（修复前演示期间会把真金桌的自动策略记成假 `UNKNOWN`）。
- 监控层按桌导出时检测 sourceSeq 缺口、以消费方 ack 推进游标、支持从游标续传；影子源支持断线/自动恢复故障注入与 continuity proof 回调。导出缓冲溢出不丢事件上限：溢出后保留最近一段，并在**实体新靴重置**到达时自动恢复（修复前溢出会让该桌永久静默）。
- 浏览器桥支持房间发现、实时 tableEvent、断线/恢复通知和执行请求；桌面运行时要求**已批准的扩展 installId**、恰好一个连接、连续扩展会话序号和 45 秒内的新鲜牌桌观测。
- 「清除记录」只清事件/决策/回执/预留等审计数据并 `VACUUM`，**不会**重置日/桌/靴风控计数（修复前会 `DELETE FROM risk_state`，等于清账绕过止损）。
- 烧牌模型默认为 `unknown`（无信息先验）：`pMean` 是**正确**的（精确后验边际化，与烧牌数无关），只有保守下界 `pLower` 偏乐观。三个 runtime 目前都不采集烧牌张数；实测把默认值改成 `countKnown(13)` 会让开火从 1.27 手/靴降到 0.001 手/靴（等于关掉策略），所以**不要改默认值**，正确修法是在采集侧补 `burnModelUpdated`。
- 监控附着失败按 2s / 5s / 15s / 30s（封顶）持续重试。牌桌数据流停滞或会话过期时断开导出，不再整页重载 Pragmatic 弹窗。
- 关闭桌面窗口会退出应用并关闭监控、桥接、保活调度和账本服务。
- 页面诊断只传长度/数量元数据，桥接调试日志只保留脱敏 URL 和载荷长度，不记录正文、HTML 或原始网络载荷预览。

## Pragmatic Play 集成核对

当前没有获批的最小金额真实验证流程。不要把代码中的 `live` 开关视为资金使用许可。
