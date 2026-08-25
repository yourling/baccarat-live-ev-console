# Baccarat Real Room Bridge 浏览器扩展

这是一个 Chrome/Edge Manifest V3 浏览器扩展骨架，用于：

1. 从真实游戏房间页面抽取房间/桌台数据；
2. 通过本地 WebSocket 桥接到 `@baccarat/browser-bridge`；
3. 受控执行 Dafabet/mstrom 的真实下注请求。

当前真实执行路径是 `background.js` + `mstrom-bet-runtime.js`：只支持 Dafabet/mstrom 的庄对/闲对。`site-adapter.js` 和 `bet-executor.js` 未被当前 Manifest 加载，不能作为真实执行路径。其他平台仍需单独填写适配器。

- `matches`
- `roomSelector` / `tableSelector`
- `extractRooms(doc)`
- `extractTableEvent(doc, tableId)`

## 加载扩展

1. 打开 Chrome/Edge 扩展管理页：`chrome://extensions` 或 `edge://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展”，选择本目录 `apps/browser-extension`。
4. 点击扩展图标，或通过 `chrome.storage.local` 配置桥接地址（默认 `ws://127.0.0.1:17890`）。

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

## 真实下注

`background.js` 收到 `betRequest` 后会先验证本次扩展会话的 live gate，再要求浏览器中恰好存在一个 Dafabet 百家樂弹窗，并在其所有 iframe 中找到恰好一个匹配目标桌台的 mstrom BetStore。只有这些条件成立，才会将一次性执行函数注入该 iframe 的 `MAIN` world。mstrom 使用运行时 BetStore 的 playType：`bankerPair=4`、`playerPair=5`。

真实下注有两道显式开关：

1. 桌台执行模式必须为 `live`，或桌面端正在执行一笔单次实盘验证；
2. 当前 WebSocket 会话必须由本机桥显式打开 live gate；
3. 扩展 storage 中的 `liveBetEnabled` 必须为 `true`；
4. 目标页面、桌台、局号、下注窗口、平台限额和未确认筹码状态都必须通过检查。

默认仍为 shadow/simulated，不会因为加载扩展而下注。桥接命令可切换扩展开关：

```powershell
npx tsx scripts/bridge-command.ts liveOn
npx tsx scripts/bridge-command.ts liveOff
```

`liveOn` 只应在已确认账号余额、桌台和金额限制后使用。它只会开启本次扩展连接的执行资格，本身不会提交下注。平台返回拒绝或无资金时，执行器返回 `REJECTED`；如果 `confirmBet` 已开始但无法证明结果，则返回 `UNKNOWN`，不会伪造成功或自动重试。

受控验收步骤见 [Dafabet/mstrom 真实下注验收指南](../../docs/dafabet-mstrom-acceptance.md)。

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
（桥接服务会暂停导出，控制台显示“连接断开”），然后按 5s / 15s / 45s 退避自动
reload（最多 3 次，`sessionStorage` 标记跨刷新计数）。恢复后自动上报
`sessionAction: recovered` 与 `tableRestored`，控制台回到“连接恢复”；
3 次仍失败则上报 `recovery-failed` 并停止（需要人工重新登录）。

### 可选开关（`chrome.storage.local`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | `ws://127.0.0.1:17890` | 桥接服务地址 |
| `trustedKeepalive` | `false` | 启用 CDP 可信输入保活。需要 `debugger` 权限；首次启用时浏览器显示“正在调试”提示条，点 × 关闭会拒绝调试，自动降级为普通保活。 |
| `autoKeeper` | `false` | 自动创建固定后台标签页防会话页被浏览器丢弃。注意：部分站点不允许同一账号开两个房间页，若开启后主页面反而掉线，请关闭。 |
| `liveBetEnabled` | `false` | mstrom 真实下注总开关；默认关闭。 |

### 观测方式

运行 `npm run bridge:observe`（或桌面控制台日志）查看
`[session-action]`、`[session-expired]`、`[bridge-diagnostic]` 输出，
确认保活动作与恢复流程按预期触发。
