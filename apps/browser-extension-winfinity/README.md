# Baccarat Winfinity Room Bridge

独立 Chrome 扩展，对接 Dafabet 桃园厅 `tao-yuan-baccarat`（Winfinity 多桌）。**不要**与 Pragmatic 或 BG 扩展同时启用：本机桥只接受一条扩展连接、一个 executor lease。

第一期只采集，不下注。所有到达扩展的 `betRequest` 立即返回 `REJECTED`，`raw.reason` 为 `winfinity-monitor-only`，`commitStarted: false`。

## 加载

1. 打开 `chrome://extensions`，开启开发者模式。
2. 「加载已解压的扩展」选择本目录。
3. 停用 `apps/browser-extension`（Pragmatic）和 `apps/browser-extension-bg`（BG）。
4. 打开唯一弹窗 `https://www.dafabet.net/sc/live-dealer/popup-launch/tao-yuan-baccarat`。

打包默认桥接 `ws://127.0.0.1:17890`，token 与桌面桥共享。`liveBetEnabled` 默认关闭，即使打开也不会下注。

## 行为

- 只匹配桃园弹窗与 `*.youngpoisson.xyz`（忽略 Sentry 主机 `skt.youngpoisson.xyz`）。
- 只镜像游戏 JSON 文本 WebSocket（`baccarat-bridge-winfinity-ws`）。大厅短号映射走 `baccarat-bridge-winfinity-state`。
- 房间 id 固定 `dafabet-winfinity`。控制台桌号优先 `streamId`（如 `tyn-bac8`），拿不到时用 `wnf-<24hex>`。
- 无 bet-runtime，无 `scripting` 权限，不注入页面下注函数，不发送 autoBet，不视频入座，不点「重新连接」。
- 页面保活：只在 `baccarat-multitable` 游戏 iframe 做合成活动 + 对 `origin/` 的 HEAD/GET。不 `GET` 带 `masterSessionId` 的游戏 URL，避免被当成第二台设备入桌。不创建 keeper 页。

改扩展文件后必须在 `chrome://extensions` 点重新加载，然后**人工刷新**桃园弹窗，钩子才能重新包住 WebSocket。扩展不会刷新游戏弹窗。

## 重载

扩展改完后用下面任一方式重载扩展自身（`chrome.runtime.reload()`，不刷新游戏弹窗）：

- 点击工具栏扩展图标
- `Alt+Shift+R`
- `npm run bridge:reload-extension`

重载扩展后必须**人工刷新** `tao-yuan-baccarat` 弹窗，MAIN world 才能重新包住 WS。
