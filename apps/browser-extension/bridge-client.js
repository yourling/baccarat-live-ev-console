/**
 * 三扩展共享的桥接客户端 WS 管线（连接/重连退避/心跳/序号/发件箱/租约）。
 *
 * 宿主 background.js 的约定（经典脚本，importScripts('bridge-client.js') 注入，
 * 所有函数与状态进入同一全局作用域，调用点零改动）：
 *
 * 宿主必须提前定义的常量：
 * - DEFAULT_BRIDGE_TOKEN / DEFAULT_BRIDGE_URL   回环桥地址与令牌（token 只做噪声过滤）
 * - BRIDGE_HEARTBEAT_INTERVAL_MS                心跳间隔
 *
 * 宿主必须定义的钩子（运行期才被调用，函数声明放在 importScripts 之后即可）：
 * - loadFlags()                                  读取本扩展存储标志
 * - bridgeOnSocketMessage(message, generation)   处理 betRequest / command
 * - isProtocolNetworkCapture(message)            networkCapture 转发过滤
 *
 * 可选钩子：
 * - bridgeOnSocketOpen()        连接建立后的平台附加动作（如 hello 后的状态上报）
 * - bridgeOnSocketClose()       连接断开时的平台附加清理（如重置 live 会话）
 * - bridgeHeartbeatExtras()     心跳附加字段
 * - loadBridgeInstallId()       从存储读取/生成持久 installId（宿主实现，见下）
 *
 * P0-1（扩展身份）：本文件在连接 URL 上带 `?installId=<持久 id>`。id 必须**跨重连、
 * 跨 SW 重启稳定**，由宿主的 `loadBridgeInstallId()` 从 chrome.storage.local 读写；
 * 桥只有在该 id 被操作员批准后才会授予 extension 角色。
 *
 * P1-8a（outbox 溢出）：序号是"每会话"的。以前 BRIDGE_SESSION_ID 是模块级常量、
 * bridgeSeq 跨重连不清零，一旦 outbox（500 条）裁剪掉最早几条，服务端的严格 +1 校验
 * 就永远对不上，扩展只能等 SW 被回收才能重连。现在：
 *  - 每次 connect() 生成新的 bridgeSessionId（新会话 = 服务端重置序号基准）；
 *  - outbox 溢出时不静默丢最早消息，而是整体清空 + 标记 outboxOverflowed，并立刻主动
 *    断开当前 WS → 重连会开启新会话，服务端重新接受序号；新会话的 hello 带
 *    `seqReset: true`，运维/诊断能看出发生过一次重置。
 *
 * 本文件不包含任何平台细节；平台差异全部留在宿主 background.js。
 */

/** 当前连接的会话 id：**每次 connect() 重新生成**（P1-8a）。 */
var BRIDGE_SESSION_ID = '';

/** 扩展持久身份（P0-1）；由 loadBridgeInstallId() 填充，连接 URL 使用。 */
var bridgeInstallId = '';

var bridgeMessageSeq = 0;
var executorProfileId = '';
var executorLease = null; // { leaseId, profileId, secret }
var socket = null;
var socketGeneration = 0;
var activeSocketGeneration = 0;
var reconnectTimer = null;
var heartbeatTimer = null;
var reconnectDelay = 1000;
var OUTBOX_LIMIT = 500;
var outbox = [];
/** 本会话是否发生过 outbox 溢出（溢出即重置会话，见文件头 P1-8a）。 */
var outboxOverflowed = false;
var outboxOverflowReconnects = 0;

function newBridgeSessionId() {
  return [
    'bridge',
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 12),
    Math.random().toString(36).slice(2, 6),
  ].join('-');
}

function isCurrentSocket(connection, generation) {
  return socket === connection && activeSocketGeneration === generation;
}

/**
 * P0-1: 读取（必要时生成）扩展持久 installId。
 *
 * 宿主 background.js 优先提供 `loadBridgeInstallId()`（写 chrome.storage.local），
 * 没提供时退化为"每个 SW 生命周期一个随机 id" —— 这会让桥每次 SW 重启都要求重新批准，
 * 所以三个随包扩展都必须实现它。
 */
async function resolveBridgeInstallId() {
  try {
    if (typeof loadBridgeInstallId === 'function') {
      const loaded = await loadBridgeInstallId();
      if (typeof loaded === 'string' && /^[a-zA-Z0-9._-]{8,128}$/.test(loaded)) {
        bridgeInstallId = loaded;
        return;
      }
    }
  } catch (_) {
    // 存储不可用时退化为临时 id：宁可每次重连都需要批准，也不要用空 id 冒充。
  }
  if (bridgeInstallId) return;
  var random = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(random);
  } else {
    for (var index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }
  var hex = '';
  for (var i = 0; i < random.length; i += 1) {
    hex += random[i].toString(16).padStart(2, '0');
  }
  bridgeInstallId = hex;
}

/** 在宿主给的地址上补 token 与 installId（P0-1）。 */
function withBridgeIdentity(url) {
  try {
    const parsed = new URL(url);
    if (bridgeInstallId) parsed.searchParams.set('installId', bridgeInstallId);
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

async function connect() {
  await loadFlags();
  await resolveBridgeInstallId();
  const url = withBridgeIdentity(await getBridgeUrl());
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  // P1-8a: 每次连接开启新会话，服务端按 sessionId 重置序号基准。
  BRIDGE_SESSION_ID = newBridgeSessionId();
  bridgeMessageSeq = 0;
  const generation = ++socketGeneration;
  const connection = new WebSocket(url);
  socket = connection;
  activeSocketGeneration = generation;
  connection.addEventListener('open', () => {
    if (!isCurrentSocket(connection, generation)) return;
    reconnectDelay = 1000;
    flushOutbox();
    send({
      kind: 'hello',
      extensionVersion: chrome.runtime.getManifest().version,
      browser: navigator.userAgent,
      timestamp: new Date().toISOString(),
      ...(executorProfileId ? { executorProfileId } : {}),
      ...(outboxOverflowed ? { seqReset: true } : {}),
    });
    outboxOverflowed = false;
    if (typeof bridgeOnSocketOpen === 'function') bridgeOnSocketOpen();
    scheduleBridgeHeartbeat();
  });
  connection.addEventListener('message', event => {
    if (!isCurrentSocket(connection, generation)) return;
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message) return;
    if (message.kind === 'executorLeaseGranted') {
      if (typeof message.leaseId === 'string' && typeof message.secret === 'string' && typeof message.profileId === 'string') {
        executorLease = { leaseId: message.leaseId, profileId: message.profileId, secret: message.secret };
      }
      return;
    }
    if (message.kind === 'executorLeaseRejected') {
      executorLease = null;
      return;
    }
    bridgeOnSocketMessage(message, generation);
  });
  connection.addEventListener('close', () => {
    if (!isCurrentSocket(connection, generation)) return;
    if (typeof bridgeOnSocketClose === 'function') bridgeOnSocketClose();
    stopBridgeHeartbeat();
    scheduleReconnect();
  });
  connection.addEventListener('error', () => {
    if (!isCurrentSocket(connection, generation)) return;
    // 与旧实现一致：error 直接走失效+重连，不依赖 close 事件异步到达。
    if (typeof bridgeOnSocketClose === 'function') bridgeOnSocketClose();
    stopBridgeHeartbeat();
    scheduleReconnect();
    try { connection.close(); } catch (_) {}
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.round(reconnectDelay * (0.7 + Math.random() * 0.6));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function sendBridgeHeartbeat() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  send({
    kind: 'heartbeat',
    timestamp: new Date().toISOString(),
    ...(typeof bridgeHeartbeatExtras === 'function' ? bridgeHeartbeatExtras() : {}),
  });
  return true;
}

function scheduleBridgeHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = null;
    if (sendBridgeHeartbeat()) scheduleBridgeHeartbeat();
  }, BRIDGE_HEARTBEAT_INTERVAL_MS);
}

function stopBridgeHeartbeat() {
  if (!heartbeatTimer) return;
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

function withBridgeSequence(message) {
  return { ...message, bridgeSessionId: BRIDGE_SESSION_ID, bridgeSeq: ++bridgeMessageSeq };
}

/**
 * P1-8a: outbox 溢出。
 *
 * 旧实现 `outbox.shift()` 静默丢最早一条，导致 bridgeSeq 出现永久跳号 →
 * 服务端 1008 踢连接 → 每次重连都是同一个跳号 → 必须重启 SW 才能恢复。
 * 现在的做法：整体清空（这些消息已经过时，重发没有意义）+ 立即主动断开，
 * 让下一次 connect() 用**新 session** 从 seq=1 重新开始。
 */
function resetBridgeOutbox(reason) {
  const dropped = outbox.length;
  outbox = [];
  outboxOverflowed = true;
  outboxOverflowReconnects += 1;
  console.warn('[bridge-client] outbox overflow, resetting bridge session', reason, 'dropped=' + dropped);
  const stale = socket;
  if (stale) {
    try { stale.close(); } catch (_) {}
  }
}

function send(message) {
  if (message && message.kind === 'betResult') return;
  if (message && message.kind === 'networkCapture' && !isProtocolNetworkCapture(message)) return;
  // P1-8a: 溢出后本会话已作废 —— 再排队只会产生"旧会话序号"的垃圾消息
  // （重连时会被 flushOutbox 的会话过滤丢掉），直接丢弃更诚实。
  if (outboxOverflowed) return;
  const sequenced = withBridgeSequence(message);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(sequenced));
    return;
  }
  // 断线/重连窗口内排队,重连后按序补发,避免牌局消息被静默丢弃。
  if (outbox.length >= OUTBOX_LIMIT) {
    resetBridgeOutbox('outbox-limit:' + OUTBOX_LIMIT);
    return;
  }
  outbox.push(sequenced);
}

function flushOutbox() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (outbox.length > 0) {
    const message = outbox.shift();
    if (message && message.kind === 'betResult') continue;
    if (message && message.kind === 'networkCapture' && !isProtocolNetworkCapture(message)) continue;
    // P1-8a: 只补发**属于当前会话**的消息。溢出重置后遗留的旧会话消息序号基准已经不同，
    // 补发会立刻被服务端判定为跳号（1008），必须丢弃。
    if (message && message.bridgeSessionId !== BRIDGE_SESSION_ID) continue;
    try { socket.send(JSON.stringify(message)); }
    catch (_) { outbox.unshift(message); break; }
  }
}

function sendBetResult(message, generation) {
  if (!socket || !isCurrentSocket(socket, generation) || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(withBridgeSequence(message)));
    return true;
  } catch (_) {
    return false;
  }
}
