# 百家乐实时 EV 中控台（第一阶段）

本机优先的模块化单体 + 事件溯源 + 每桌串行 Actor。目标是可作为实际软件运行：SQLite 文件持久化、严格追加事件账本、崩溃后重启恢复、全局风控状态落盘、桌面端 IPC 控制台。

当前阶段完成：
- 精确组合概率、烧牌后验、保守 EV（`packages/probability`）
- 契约与输入校验（`packages/contracts`，`EVENT_SCHEMA_VERSION=1`）
- SQLite（better-sqlite3 + WAL）事件账本、投影、重放（`packages/ledger-state`）
- 事件冲突检测：event_id 相同但 payload 不同 / sourceSeq 冲突均拒绝，绝不静默改写历史
- 每桌串行 Actor、决策与回执幂等、重启恢复（`packages/orchestrator`）
- 持久化全局风控：预留/释放/结算、日/桌/靴亏损、重启恢复（`packages/risk-execution`）
- 影子/模拟执行桥（`packages/adapter-contract`，当前不接真实网站）
- Electron + React 桌面控制台：IPC、arm/disarm、副数修正、事件/决策/回执审计（`apps/desktop`）

不包含任何具体网站抓牌、登录或真实下注逻辑。

## 目录

- `packages/contracts`：冻结契约、默认配置、哈希、校验。
- `packages/probability`：精确概率、EV、烧牌后验、保守下界。
- `packages/ledger-state`：事件账本、投影、重放。
- `packages/adapter-contract`：适配器接口、模拟适配器、归一化降级。
- `packages/simulator-fixtures`：确定性事件流构造器。
- `packages/orchestrator`：桌台串行 Actor、策略选择、幂等、持久化表配置。
- `packages/risk-execution`：全局风控、预留/释放/缩额/结算。
- `apps/desktop`：Electron + React 桌面壳层（主进程持久化服务 + IPC）。

## 命令

```bash
npm install
npm test                          # 53 个自动化测试
npm run build                     # 全仓 TypeScript 校验
npm run demo                      # 终端演示核心回放/影子/模拟执行
npm run smoke                     # Electron 持久化控制台服务冒烟测试（临时库，重启恢复）
npm run dev:web                   # 启动 Vite 渲染层 http://127.0.0.1:5173
npm run build:desktop -w @baccarat/desktop   # 构建渲染层 + 打包 Electron 主进程
npm run electron -w @baccarat/desktop         # 构建后启动持久化桌面应用
```

Electron 主进程默认加载 `apps/desktop/dist/index.html`；如需连接开发服务器，设置环境变量 `VITE_DEV_SERVER_URL=http://127.0.0.1:5173`。数据库位于 Electron `userData/console.sqlite`（WAL 模式）。

## 核心验证点

- 8 副新靴普通对子概率约 `7.4699%`；庄对/闲对对称。
- 同一事件流重放两次哈希一致；红牌当前局结算后才封存，红牌后不再开窗下注。
- 事件账本幂等：相同 `eventId` + 相同 payload 返回 `duplicate`；`eventId` 相同 payload 不同或 `sourceSeq` 冲突抛 `LedgerConflictError`。
- 手工副数修正会从全部已见牌重算剩余库存；默认必须重新武装。
- 断线自动 disarm 并进入 `RESYNCING`；恢复必须提供 continuity proof 才会离开。
- 同一桌同一牌局同一市场绝不重复下注；receipts/reservations 唯一键包含 `table_id`。
- 风控状态与 reservations 落盘，重启后恢复；结算后更新日/桌/靴盈亏。
- 影子模式不调用执行器；模拟模式保留 reservation 到 `handSettled` 按 `outcomes` 结算盈亏。
- 桌面演示使用带种子的伪随机牌靴模拟，每次点击会生成新会话；关闭重开不会丢历史。
