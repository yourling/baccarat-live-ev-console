# Baccarat Real Room Bridge 浏览器扩展

这是一个 Chrome/Edge Manifest V3 浏览器扩展骨架，用于：

1. 从真实游戏房间页面抽取房间/桌台数据；
2. 通过本地 WebSocket 桥接到 `@baccarat/browser-bridge`；
3. 执行 Dafabet/mstrom 页面下注请求的浏览器端实现。

**发布状态：仅限隔离、非资金的集成与长稳验证。** 扩展包含会调用页面下注方法的代码，工程侧执行链路已统一加固，但当前仍未获得真实资金发布审批或授权。

当前执行实现分为两条路径：

- `BetIntent`/单次下注路径仅支持 Dafabet/mstrom 的庄对/闲对。桌面端先经过 actor、reservation 和全局风控，再由 `background.js` 与 `mstrom-bet-runtime.js` 执行。
- `OperationalWager` 支持庄、闲、庄对、闲对，用于桌面端手动按钮和庄/闲保活调度。它同样经过 `TableActor`、reservation、全局风控、回执审计、结算和按桌/靴/局/市场/来源的重复保护。

`site-adapter.js` 和 `bet-executor.js` 未被当前 Manifest 加载，不能作为执行路径。其他平台仍需单独填写适配器。

- `matches`
- `roomSelector` / `tableSelector`
- `extractRooms(doc)`
- `extractTableEvent(doc, tableId)`

## 加载扩展

1. 打开 Chrome/Edge 扩展管理页：`chrome://extensions` 或 `edge://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展”，选择本目录 `apps/browser-extension`。
4. 点击扩展图标，或通过 `chrome.storage.local` 配置桥接地址。打包默认值是带固定 token 的 `ws://127.0.0.1:17890`；Manifest key 固定扩展 ID，桌面桥会同时校验 ID、token 和消息序号。`bridgeUrl` 仍是开发配置，不得指向不受信任或非隔离的端点。

## 启动本地桥接服务

在桌面控制台服务中调用：

```ts
const { port } = await service.startBrowserBridge();
console.log(port);
```

或者在 `packages/browser-bridge` 中直接：

```ts
const server = new BrowserBridgeServer({ port: 17890 });
await server.start();
```

## 数据流

```
真实游戏页面
  → content.js 抽取房间/桌台/牌局事件
  → background.js WebSocket
  → BrowserBridgeServer
  → BridgeTableExport / RoomMonitor
  → ledger-state / orchestrator
```

## 执行实现与安全状态

`background.js` 在收到执行请求后，会尝试验证当前扩展会话的 live gate，并要求浏览器中恰好存在一个 Dafabet 百家樂弹窗、其 iframe 中恰好一个匹配目标桌台的 mstrom BetStore。满足这些浏览器端检查后，才会把一次性执行函数注入该 iframe 的 `MAIN` world。

运行时 playType 映射为 `banker=1`、`player=2`、`bankerPair=4`、`playerPair=5`。`BetIntent` 会拒绝非对子市场；`OperationalWager` 接受全部四个市场。所有真实请求还必须由桌面端先建立 reservation，并通过实体牌靴、连接、下注窗口、未封靴、风控限额、重复保护和运行授权门禁。

当前实现包含桌面端每桌 live 批准、桥接会话 live gate 和扩展 storage 的 `liveBetEnabled` 开关。桥接只接受固定扩展 ID/token、恰好一个扩展连接和当前扩展会话内连续递增的消息序号。扩展默认仍为 shadow/simulated，不会因为加载扩展而下注；在发布未批准前不要使用下列命令进行资金验证：

```powershell
npx tsx scripts/bridge-command.ts liveOn
npx tsx scripts/bridge-command.ts liveOff
```

`liveOn` 只会尝试打开扩展连接的执行资格，本身不提交下注，也不代表环境已通过真实资金审批。平台返回拒绝或无资金时，执行器可返回 `REJECTED`；若 `confirmBet` 已开始而无法证明结果，可返回 `UNKNOWN`。`UNKNOWN` 对应的 reservation 保留敞口，桌面端会立即关闭保活、撤销当前运行授权并阻断后续执行，不会在下一调度周期再次尝试。

非资金集成核对见 [Dafabet/mstrom 集成核对指南](../../docs/dafabet-mstrom-acceptance.md)。

## 信任、恢复与日志边界

- `content.js` 与 MAIN world 运行时钩子工作在受限站点域名内；真实站点页面仍是上游数据源，因此需要通过独立非资金长稳验收验证站点版本与解析稳定性。
- 打包 Manifest key 固定扩展 ID，本机桥同时校验扩展 ID、共享 loopback token、单一连接、扩展会话 ID 和单调消息序号。扩展会话重启或序号缺口会立即使连续性失效并关闭执行。
- 连续性恢复只接受 `cursor-v1:<64 lowercase hex>`。桥接根据上一游标、下一条严格连续事件及其 payload hash 生成证明；失去传输连续性时，只有明确的 `physical-shoe` 新靴重置可建立新基线。内容脚本的页面恢复通知绝不发送或伪造 `tableRestored`。
- 页面诊断只发送 title/body/HTML 长度和 DOM 数量，不发送正文或 HTML 预览。桥接调试日志去除 URL 查询参数/fragment，只记录网络载荷长度；运行事故还会脱敏 URL 和常见凭据字段。

## 会话保活与“会话已过期”自动恢复

长时间挂在游戏房间会触发站点侧的“会话已过期”。合成 DOM 事件（`isTrusted=false`）
对多数站点无效，因此 `content.js` 每 30 秒执行四层保活，全部动作都会以
`sessionAction` 消息上报到桥接服务日志（`[session-action]`），便于观测哪一层真正生效：

1. **合成 DOM 活动**：mousemove / focus / 滚动抖动，并通知 MAIN world 的
   `network-hook.js` 重放已捕获的 WebSocket 心跳消息。
2. **同源网络信标**：对页面 origin 发起真实 `HEAD`（失败退回 `GET`）请求，
   携带会话 cookie，重置服务端闲置计时。
3. **对局记录按钮双击**：点击右下角“对局记录表”按钮（点击一次放大、再点一次缩小），
   双击恢复原状，触发站点真实的点击处理器。站点适配器就绪后可用
   `getKeepAliveTargets(doc)` 提供精确选择器，否则使用右下角启发式兜底。
4. **CDP 可信输入（可选）**：`chrome.debugger` 派发 `isTrusted=true` 的真实
   鼠标移动与点击，对校验事件可信度的站点有效。

过期兜底：检测到“会话已过期”文案后，先上报 `sessionExpired` 并标记牌桌断开
（桥接服务会暂停导出并失败关闭执行），然后按 5s / 15s / 45s 退避自动 reload。
三次仍失败会上报 `recovery-failed`，持久事故进入阻断状态；扩展随后按
1m / 5m / 15m / 30m（封顶）继续监督并启动新的三次快速恢复轮次。

页面不再显示过期文案时只上报 `sessionAction: recovered`。该事件本身不会生成
`tableRestored` 或恢复执行；桌面端必须重新收到当前进程的新鲜牌桌事件，并由桥接验证
严格游标连续性或实体新靴重置后，才可能重新获得无人值守授权。

### 可选开关（`chrome.storage.local`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | 带固定 token 的 `ws://127.0.0.1:17890` | 可变的开发桥接地址；桌面桥仍校验固定扩展 ID/token，不得指向不受信任或非隔离端点。 |
| `trustedKeepalive` | `false` | 启用 CDP 可信输入保活。需要 `debugger` 权限；首次启用时浏览器显示“正在调试”提示条，点 × 关闭会拒绝调试，自动降级为普通保活。 |
| `autoKeeper` | `false` | 自动创建固定后台标签页防会话页被浏览器丢弃。注意：部分站点不允许同一账号开两个房间页，若开启后主页面反而掉线，请关闭。 |
| `liveBetEnabled` | `false` | 页面执行开发开关；默认关闭，不构成真实资金审批或风控。 |

### 观测方式

运行 `npm run bridge:observe`（或桌面控制台日志）查看
`[session-action]`、`[session-expired]`、`[bridge-diagnostic]` 输出，
确认保活动作与恢复流程按预期触发。`[bridge-diagnostic]` 只包含脱敏 URL、
页面长度和 DOM 数量；`[bridge-network]` 只包含载荷长度，不输出原始网络数据。
