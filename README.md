# 百家乐实时 EV 中控台（第一阶段）

本机优先的模块化单体 + 事件溯源 + 每桌串行 Actor。目标是可作为实际软件运行：SQLite 文件持久化、严格追加事件账本、崩溃后重启恢复、全局风控状态落盘、桌面端 IPC 控制台。

当前阶段完成：
- 精确组合概率、烧牌后验、保守 EV（`packages/probability`）
- 契约与输入校验（`packages/contracts`，`EVENT_SCHEMA_VERSION=1`）
- SQLite（better-sqlite3 + WAL）事件账本、投影、重放（`packages/ledger-state`）
- 事件冲突检测：event_id 相同但 payload 不同 / sourceSeq 冲突均拒绝，绝不静默改写历史
- 每桌串行 Actor、决策与回执幂等、重启恢复（`packages/orchestrator`）
- 持久化全局风控：预留/释放/结算、日/桌/靴亏损、重启恢复（`packages/risk-execution`）
- 影子/模拟执行桥，以及 Dafabet/mstrom 庄对/闲对的受控真实执行链路（`packages/adapter-contract`、`packages/browser-bridge`、`apps/browser-extension`）
- 房间级牌桌数据导出监控层：房间发现、逐桌导出、游标/批量/健康、断点续传（`packages/room-monitor`）
- 浏览器扩展 + 本地 WebSocket 桥：从真实游戏页面采集房间/牌桌数据，并提供 Dafabet/mstrom 真实下注执行通道（`packages/browser-bridge` + `apps/browser-extension`）
- Electron + React 桌面控制台：IPC、arm/disarm、副数修正、事件/决策/回执审计（`apps/desktop`）

当前已绑定 Dafabet/mstrom：支持 `bankerPair`（庄对）和 `playerPair`（闲对）。真实执行仅由 `background.js` 的受控路径发起：必须存在唯一 Dafabet 百家樂弹窗、唯一匹配桌台的游戏 iframe，且在本次桥接会话中显式开启 live gate。其他平台仍需单独实现适配器。真实下注执行需要用户自行确认平台条款与合规责任。

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
3. 扩展默认连接 `ws://127.0.0.1:17890`，可通过 `chrome.storage.local` 的 `bridgeUrl` 修改。
4. Dafabet/mstrom 通过网络与运行时状态采集上报房间/牌桌事件；其他平台仍需填写对应适配器。
5. 桥接层收到事件后，经 `BridgeRoomMonitor`/`TableExport` 导出给 orchestrator/ledger。真实下注仅会路由到唯一匹配的 Dafabet 百家樂弹窗和游戏 iframe；切换到 `live` 本身不会下注，仍需单独武装自动下注或提交单次实盘验证。

## 核心验证点

- 8 副新靴普通对子概率约 `7.4699%`；庄对/闲对对称。
- 同一事件流重放两次哈希一致；红牌当前局结算后才封存，红牌后不再开窗下注。
- 事件账本幂等：相同 `eventId` + 相同 payload 返回 `duplicate`；`eventId` 相同 payload 不同或 `sourceSeq` 冲突抛 `LedgerConflictError`。
- 手工副数修正会从全部已见牌重算剩余库存；默认必须重新武装。
- 断线自动 disarm 并进入 `RESYNCING`；恢复必须提供 continuity proof 才会离开。
- 同一桌同一牌局同一市场绝不重复下注；receipts/reservations 唯一键包含 `table_id`。
- 风控状态与 reservations 落盘，重启后恢复；结算后更新日/桌/靴盈亏。
- 影子模式不调用执行器；模拟模式保留 reservation 到 `handSettled` 按 `outcomes` 结算盈亏。
- 桌面演示使用带种子的伪随机牌靴模拟；点击“开始持续模拟”后按局间隔生成牌面，点击“停止持续模拟”结束；关闭重开不会丢历史。
- 监控层按桌导出时检测 sourceSeq 缺口、以消费方 ack 推进游标、支持从游标续传；影子源支持断线/自动恢复故障注入与 continuity proof 回调。
- 浏览器桥支持房间发现、实时 tableEvent、断线/恢复通知，以及通过 WebSocket 往返真实下注请求。

## Dafabet/mstrom 验收

完整的受控验收步骤、预期回执和异常处理见 [真实下注验收指南](docs/dafabet-mstrom-acceptance.md)。文档区分不下注的环境验收与由操作者自行发起的最小金额真实验证。
