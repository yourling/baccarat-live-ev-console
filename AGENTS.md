# AGENTS.md

* 本仓库为模块化单体起步，第一阶段实现“百家乐实时 EV 中控台”核心。
* 浏览器扩展与本地桥已实现真实房间/牌桌数据的采集通道；Dafabet/mstrom 已实现庄对/闲对的受控真实下注适配器。其他平台仍只有通用通道，尚未填写执行适配器。
* 区域/包边界：contracts 为冻结契约；probability 纯函数；ledger-state 负责事件账本与投影；orchestrator 负责桌台 actor；risk-execution 负责全局风控与实际执行桥（当前只有影子/模拟）；room-monitor 负责游戏房间/牌桌发现、牌桌数据导出、游标/批量/健康与断点续传；browser-bridge 负责浏览器扩展与本机控制台的 WebSocket 桥、BridgeRoomMonitor 与真实下注请求通道；browser-extension 负责真实页面 DOM/网络采集与下注执行适配器。
* 所有共享契约修改必须谨慎，合并前需同步测试夹具。
* 使用 gh 管理仓库操作。
