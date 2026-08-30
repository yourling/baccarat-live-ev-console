# AGENTS.md

* 本仓库为模块化单体起步，第一阶段实现“百家乐实时 EV 中控台”核心。
* 浏览器扩展与本地桥已实现真实房间/牌桌数据采集。Dafabet/mstrom 的 `BetIntent`/单次下注支持庄对/闲对，`OperationalWager` 支持庄、闲、庄对、闲对；两者都必须经 `TableActor`、`RiskManager`、reservation、全局限额、回执审计、结算和按桌/靴/局/市场/来源的重复保护。
* 区域/包边界：contracts 为冻结契约；probability 纯函数；ledger-state 负责事件账本、投影、配置和执行审计；orchestrator 负责桌台 actor 与所有受控下注入口；risk-execution 负责全局风控、reservation 和结算；room-monitor 负责游戏房间/牌桌发现、牌桌数据导出、游标/批量/健康与断点续传；browser-bridge 负责固定身份的本机 WebSocket 桥、BridgeRoomMonitor 与实际下注请求通道；browser-extension 负责真实页面 DOM/网络采集、会话恢复监督和下注执行适配器。
* 所有共享契约修改必须谨慎，合并前需同步测试夹具。
* 使用 gh 管理仓库操作。
