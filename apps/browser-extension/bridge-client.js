/**
 * 三扩展共享的桥接客户端 WS 管线（连接/重连退避/心跳/序号/发件箱/租约）。
 *
 * 宿主 background.js 的约定（经典脚本，importScripts('bridge-client.js') 注入，
 * 所有函数与状态进入同一全局作用域，调用点零改动）：
 *
 * 宿主必须提前定义的常量：
 * - DEFAULT_BRIDGE_TOKEN / DEFAULT_BRIDGE_URL   回环桥地址与令牌
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
 *
 * 本文件不包含任何平台细节；平台差异全部留在宿主 background.js。
 */

var BRIDGE_SESSION_ID = [
  'bridge',
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 12),
].join('-');

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

function isCurrentSocket(connection, generation) {
  return socket === connection && activeSocketGeneration === generation;
}

async function connect() {
  await loadFlags();
  const url = await getBridgeUrl();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
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
    });
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

function send(message) {
  if (message && message.kind === 'betResult') return;
  if (message && message.kind === 'networkCapture' && !isProtocolNetworkCapture(message)) return;
  const sequenced = withBridgeSequence(message);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(sequenced));
    return;
  }
  // 断线/重连窗口内排队,重连后按序补发,避免牌局消息被静默丢弃。
  if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
  outbox.push(sequenced);
}

function flushOutbox() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (outbox.length > 0) {
    const message = outbox.shift();
    if (message && message.kind === 'betResult') continue;
    if (message && message.kind === 'networkCapture' && !isProtocolNetworkCapture(message)) continue;
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
