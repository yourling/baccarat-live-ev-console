# AGENTS.md

* 本仓库为模块化单体起步，第一阶段实现“百家乐实时 EV 中控台”核心。npm workspaces 只有 `packages/*` 和 `apps/desktop`；浏览器扩展以 extraResources 打包，不是 workspace。
* 浏览器扩展与本地桥只对接 Pragmatic Play 真人厅。`BetIntent`/单次下注支持庄对/闲对，`OperationalWager` 支持庄、闲、庄对、闲对；两者都必须经 `TableActor`、`RiskManager`、reservation、全局限额、回执审计、结算和按桌/靴/局/市场/来源的重复保护。
* 对子自动策略与庄/闲保活互相独立。对子只在有效 `physical-shoe` 且 `betsopen`、窗口剩余不少于 3 秒时评估；待牌靴时绝不下对子。保活只打刚开窗的那一桌，不扫完整监控列表。受控 `OperationalWager` 要求 `live`。
* 实体牌靴硬规则：入桌默认 `unknown-monitor-session`。第一次见到 `shoeReset` 只记 token，不升 physical。只有 token 再次变化（protocol-shuffle）、本进程见过 previous≥10 且下降≥8 到 ≤8（road-wrap），或人工确认才是 `physical-shoe`。禁止用滞后 DOM 路子号降级刚洗完的实体靴。运行时降级只改有效基线，开盘中不换 shoeId。进程重启后若路子已深且 seenCards<8，按待牌靴处理。
* 实盘最多 64 张监控桌。大厅发现的 Dafabet Pragmatic 桌先进入待加入，只在上述三条洗牌证据后自动晋升。断开超过 15 秒的监控桌会移除。
* Dafabet 仅作为 Pragmatic 启动器保留：`www.dafabet.net/.../live-dealer/popup-launch/jeju-speed-baccarat` 与房间 id `dafabet-pragmatic`。mstrom / Evolution / 旧 Dafabet live-baccarat 适配器已删除。
* 区域/包边界：contracts 为冻结契约；probability 纯函数（含剩余库存评估）；ledger-state 负责事件账本、投影、配置和执行审计，`cardObserved` 走内存热路径不落 SQLite；orchestrator 负责桌台 actor 与所有受控下注入口；risk-execution 负责全局风控、reservation 和结算；room-monitor 负责游戏房间/牌桌发现、牌桌数据导出、游标/批量/健康与断点续传；browser-bridge 负责固定身份的本机 WebSocket 桥、BridgeRoomMonitor、Pragmatic 运行时归一化与实际下注请求通道；browser-extension 负责 Pragmatic 页面 DOM/游戏协议 WebSocket 采集、会话恢复监督和 `lpbet` 执行适配器（不发送 `autoBet`、不点视频入座）。
* 关闭桌面窗口即退出进程，并关闭监控、桥接、保活和账本。不要再假设后台保活窗口。
* 所有共享契约修改必须谨慎，合并前需同步测试夹具。
* 使用 gh 管理仓库操作。
