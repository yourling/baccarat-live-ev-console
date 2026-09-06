# Baccarat BG Room Bridge

独立 Chrome 扩展，对接 Dafabet `live-baccarat-bg`（Big Gaming）。**不要**与 Pragmatic 扩展同时启用：本机桥只接受一条扩展连接、一个 executor lease。

## 加载

1. 打开 `chrome://extensions`，开启开发者模式。
2. 「加载已解压的扩展」选择本目录。
3. 停用 `apps/browser-extension`（Pragmatic）。
4. 打开唯一弹窗 `https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-bg`。

打包默认桥接 `ws://127.0.0.1:17890`，token 与桌面桥共享。`liveBetEnabled` 默认关闭。

## 行为

- 只匹配 BG 弹窗、`vbgames88` 的 `bg~~` / `/portals/bg` 门户、以及 `/h5V01/` 游戏页。
- 只镜像非视频 WebSocket 文本帧（`baccarat-bridge-bg-ws`）。版本化快照走 `baccarat-bridge-bg-state`。
- 房间 id 固定 `dafabet-bg`，桌号保留平台短号并大写（`B06`，字母+两位数字）。大厅只收录百家乐类型（1/7/9/10/11/16/17），轮盘/骰宝等不进入发现与监控。
- 下注经唯一弹窗 + lease 签名 + 单次 `executeBgBetOneShot`。BG 真金走 MAIN world `BaccaratBgProtocol.submit`；`__baccaratBgBetAdapter` 仅测试覆盖。不发送 autoBet，不视频入座，不点「重新连接」。
- 页面保活：合成活动 + 同源 beacon。默认不开 CDP。
- 缺 uid/token/socket、该桌无有效倒计时、剩余窗口非有限或 ≤0 时预提交拒绝，不发包。对子额外要求剩余 ≥3 秒。

## 现场协议

BG 游戏通道是 `wss://<host>/data` 的小端二进制包，不是 JSON。`bg-protocol.js` 解码：

- `GAME_CMD`：开窗 / 关窗 / 发牌 / `NEXT_SHOES` 洗牌
- `HALL_CMD USER_INFO`：大厅百家乐桌列表
- `BET_CMD BET_ACT`：按桌号远程提交庄/闲/庄对/闲对（同一弹窗，不为每桌开视频页）

改扩展文件后必须在 `chrome://extensions` 点重新加载，然后**人工刷新** `live-baccarat-bg` 弹窗，钩子才能重新包住 WebSocket。扩展不会 `tabs.reload` 游戏弹窗。

## 重载

扩展改完后用下面任一方式重载扩展自身（`chrome.runtime.reload()`，不刷新游戏弹窗）：

- 点击工具栏扩展图标
- `Alt+Shift+R`
- `npm run bridge:reload-extension`

重载扩展后必须**人工刷新** `live-baccarat-bg` 弹窗，MAIN world 才能重新包住 WS。
