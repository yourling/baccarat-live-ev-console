/**
 * Winfinity extension service worker: loopback bridge, unique tao-yuan popup,
 * sequenced captures. First phase is monitor-only; every betRequest is rejected.
 */
const DEFAULT_BRIDGE_TOKEN = 'd63a1a9d927e268d5b3d0ac2450836c0fa90de2e55398ccb73ae888ecf35d97b';
const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:17890/?token=${DEFAULT_BRIDGE_TOKEN}`;
const BRIDGE_RECONNECT_ALARM = 'baccarat-winfinity-bridge-reconnect';
const BRIDGE_HEARTBEAT_INTERVAL_MS = 5000;
const EXTENSION_RELOAD_DELAY_MS = 1000;
const DAFABET_WINFINITY_POPUP_PATH = '/live-dealer/popup-launch/tao-yuan-baccarat';
const STREAM_ID_PATTERN = /^[a-z0-9]+-bac\d+$/i;
const FALLBACK_TABLE_ID_PATTERN = /^wnf-[a-f0-9]{24}$/i;
const PROTOCOL_CAPTURE_SOURCES = new Set([
  'baccarat-bridge-winfinity-ws',
  'baccarat-bridge-winfinity-state',
]);

let liveBetSessionEnabled = false;

// 共享 WS 管线：连接/重连/心跳/序号/发件箱/租约（定义 socket、send、connect 等）。
importScripts('bridge-client.js');

function isSentryHost(host) {
  return /(^|\.)skt\.youngpoisson\.xyz$/i.test(String(host || ''));
}

function exactDafabetWinfinityPopup(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname === 'www.dafabet.net'
      && parsed.pathname.replace(/^\/[a-z-]+/i, '').replace(/\/+$/, '') === DAFABET_WINFINITY_POPUP_PATH;
  } catch (_) {
    return false;
  }
}

function isGameTabUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (isSentryHost(parsed.hostname)) return false;
    if (/(^|\.)youngpoisson\.xyz$/i.test(parsed.hostname)) return true;
    return exactDafabetWinfinityPopup(url);
  } catch (_) {
    return false;
  }
}

function isTrustedGameSender(sender) {
  const url = sender && (sender.url || (sender.tab && sender.tab.url));
  return Boolean(url && isGameTabUrl(url));
}

function normalizeTableId(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  if (STREAM_ID_PATTERN.test(trimmed) || FALLBACK_TABLE_ID_PATTERN.test(trimmed)) return trimmed;
  return '';
}

async function loadFlags() {
  const stored = await chrome.storage.local.get({
    bridgeUrl: DEFAULT_BRIDGE_URL,
    liveBetEnabled: false,
    executorProfileId: '',
  });
  liveBetSessionEnabled = stored.liveBetEnabled === true;
  if (typeof stored.executorProfileId === 'string' && /^[a-zA-Z0-9._-]{8,128}$/.test(stored.executorProfileId)) {
    executorProfileId = stored.executorProfileId;
  } else if (!executorProfileId) {
    executorProfileId = ['profile', Date.now().toString(36), Math.random().toString(36).slice(2, 12)].join('-');
    try { await chrome.storage.local.set({ executorProfileId }); } catch (_) {}
  }
}

chrome.storage.onChanged.addListener(() => { void loadFlags(); });

async function getBridgeUrl() {
  const stored = await chrome.storage.local.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
  const raw = stored.bridgeUrl || DEFAULT_BRIDGE_URL;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('token')) url.searchParams.set('token', DEFAULT_BRIDGE_TOKEN);
    return url.toString();
  } catch (_) {
    return DEFAULT_BRIDGE_URL;
  }
}

function isProtocolNetworkCapture(message) {
  if (!message || message.kind !== 'networkCapture') return false;
  if (message.encoding === 'base64') return false;
  if (typeof message.data === 'string' && message.data.length > 65536) return false;
  return PROTOCOL_CAPTURE_SOURCES.has(message.source);
}

// -- 共享管线钩子（平台差异） -------------------------------------------------

function bridgeOnSocketOpen() {
  send({
    kind: 'sessionAction',
    action: 'command-executed',
    url: '',
    frame: '',
    detail: 'winfinity-sw-connected',
    timestamp: new Date().toISOString(),
  });
}

function bridgeOnSocketMessage(message, generation) {
  if (message.kind === 'betRequest') handleBetRequest(message, generation);
  if (message.kind === 'command') void handleCommand(message);
}

function rejectedReceipt(request, requestId) {
  const wager = request && request.wager;
  const intent = request && request.intent;
  const tableId = normalizeTableId(wager && wager.tableId || intent && intent.tableId);
  const handId = String(wager && wager.handId || intent && intent.handId || '');
  const now = new Date().toISOString();
  const raw = { commitStarted: false, reason: 'winfinity-monitor-only' };
  if (wager) {
    return {
      receiptId: `wnf-bridge-operational-rejected-${requestId}-${Date.now()}`,
      wagerId: wager.wagerId || '',
      tableId,
      shoeId: wager.shoeId || '',
      handId,
      market: wager.market,
      amount: wager.amount,
      source: wager.source,
      status: 'REJECTED',
      createdAt: now,
      raw,
    };
  }
  return {
    receiptId: `wnf-bridge-rejected-${requestId}-${Date.now()}`,
    intentId: intent && intent.intentId || '',
    reservationId: request && request.reservationId || '',
    status: 'REJECTED',
    amount: intent && intent.amount,
    market: intent && intent.market,
    mode: 'live',
    createdAt: now,
    raw,
  };
}

function handleBetRequest(message, generation) {
  const requestId = message && typeof message.requestId === 'string' ? message.requestId : '';
  const receipt = rejectedReceipt(message && message.request, requestId);
  sendBetResult({ kind: 'betResult', requestId, receipt }, generation);
}

async function handleCommand(message) {
  const name = message && message.name;
  if (name === 'liveOn' || name === 'liveOff') {
    const enabled = name === 'liveOn';
    liveBetSessionEnabled = enabled;
    await chrome.storage.local.set({ liveBetEnabled: enabled });
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: enabled ? 'liveBetEnabled' : 'liveBetDisabled',
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (name === 'reloadExtension') {
    scheduleExtensionReload('bridge-command');
  }
}

function scheduleExtensionReload(reason) {
  send({
    kind: 'sessionAction',
    action: 'command-executed',
    url: '',
    frame: '',
    detail: `reloadExtension-scheduled:${reason || 'manual'}`,
    timestamp: new Date().toISOString(),
  });
  try { if (socket) socket.close(); } catch (_) {}
  socket = null;
  setTimeout(() => chrome.runtime.reload(), EXTENSION_RELOAD_DELAY_MS);
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    scheduleExtensionReload('action-click');
  });
}
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(command => {
    if (command === 'reload-extension') scheduleExtensionReload('keyboard-command');
  });
}

function ensureBridgeReconnectAlarm() {
  if (!chrome.alarms || !chrome.alarms.create) return;
  chrome.alarms.create(BRIDGE_RECONNECT_ALARM, { periodInMinutes: 0.5 });
}

chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm && alarm.name === BRIDGE_RECONNECT_ALARM) {
    void connect();
    sendBridgeHeartbeat();
  }
});

function sanitizeForwardedMessage(message) {
  if (!message || (message.kind !== 'roomDiscovered' && message.kind !== 'roomUpdated')) return message;
  const room = message.room;
  if (!room || !Array.isArray(room.tables)) return message;
  const tables = [];
  for (let i = 0; i < room.tables.length; i += 1) {
    const table = room.tables[i];
    const tableId = normalizeTableId(table && table.tableId);
    if (!tableId) continue;
    tables.push(Object.assign({}, table, { tableId }));
  }
  return Object.assign({}, message, { room: Object.assign({}, room, { tables }) });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.kind !== 'string' || !isTrustedGameSender(sender)) return;
  if (!socket || socket.readyState > WebSocket.OPEN) void connect();
  send(sanitizeForwardedMessage(message));
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !isGameTabUrl(tab.url)) return;
  void connect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureBridgeReconnectAlarm();
  void loadFlags();
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  ensureBridgeReconnectAlarm();
  void loadFlags();
  void connect();
});
void loadFlags();
ensureBridgeReconnectAlarm();
void connect();
