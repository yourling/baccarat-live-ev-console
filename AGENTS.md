# AGENTS.md

- 本仓库为空仓库起步，第一阶段实现“百家乐实时 EV 中控台”核心。
- 不实现具体网站抓牌、登录、真实下注。
- 区域/包边界：contracts 为冻结契约；probability 纯函数；ledger-state 负责事件账本与投影；orchestrator 负责桌台 actor；risk-execution 负责全局风控与实际执行桥（当前只有影子/模拟）。
- 所有共享契约修改必须谨慎，合并前需同步测试夹具。
- 使用 gh 管理仓库操作（本阶段仓库为空，暂未初始化）。
