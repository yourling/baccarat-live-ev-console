/**
 * BG extension service worker: loopback bridge, unique live-baccarat-bg popup,
 * sequenced captures, and signed one-shot OperationalWager execution.
 */
const DEFAULT_BRIDGE_TOKEN = 'd63a1a9d927e268d5b3d0ac2450836c0fa90de2e55398ccb73ae888ecf35d97b';
const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:17890/?token=${DEFAULT_BRIDGE_TOKEN}`;
const BRIDGE_RECONNECT_ALARM = 'baccarat-bg-bridge-reconnect';
const BRIDGE_HEARTBEAT_INTERVAL_MS = 5000;
const EXTENSION_RELOAD_DELAY_MS = 1000;
const DAFABET_BG_POPUP_PATH = '/live-dealer/popup-launch/live-baccarat-bg';
const DAFABET_POPUP_QUERY = 'https://www.dafabet.net/*/live-dealer/popup-launch/live-baccarat-bg*';
const GAME_TAB_URL_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:dafabet\.net|vbgames88\.com|jbz029\.com)(?::\d+)?(?:[/?#]|$)/i;
const BG_TABLE_ID_PATTERN = /^[A-Za-z]\d{2}$/;
const BG_BET_RUNTIME_REVISION = 'bg-bet-runtime/2026-09-05.1';
const PROTOCOL_CAPTURE_SOURCES = new Set([
  'baccarat-bridge-bg-ws',
  'baccarat-bridge-bg-state',
]);
const betRequests = new Map();
let liveBetSessionEnabled = false;

// 共享 WS 管线：连接/重连/心跳/序号/发件箱/租约（定义 socket、send、connect 等）。
importScripts('bridge-client.js');

function exactDafabetBgPopup(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname === 'www.dafabet.net'
      && parsed.pathname.replace(/^\/[a-z-]+/i, '').replace(/\/+$/, '') === DAFABET_BG_POPUP_PATH;
  } catch (_) {
    return false;
  }
}

function isGameTabUrl(url) {
  return GAME_TAB_URL_PATTERN.test(String(url || '')) || /\/h5V01\//i.test(String(url || ''));
}

function isTrustedGameSender(sender) {
  const url = sender && (sender.url || (sender.tab && sender.tab.url));
  return Boolean(url && (exactDafabetBgPopup(url) || isGameTabUrl(url) || /\/h5V01\//i.test(url)));
}

function normalizeTableId(value) {
  const trimmed = String(value || '').trim();
  if (!BG_TABLE_ID_PATTERN.test(trimmed)) return '';
  return trimmed.toUpperCase();
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

async function hmacSha256Hex(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(payload || '')));
  return Array.from(new Uint8Array(signature)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function assertSignedExecutorBet(message) {
  if (!executorLease || !executorLease.leaseId || !executorLease.secret) {
    throw new Error('executor lease not granted; refusing bet');
  }
  const leaseId = message && typeof message.leaseId === 'string' ? message.leaseId : '';
  const requestId = message && typeof message.requestId === 'string' ? message.requestId : '';
  const signature = message && typeof message.signature === 'string' ? message.signature : '';
  if (!leaseId || !requestId || !signature) throw new Error('bet request missing lease signature');
  if (leaseId !== executorLease.leaseId) throw new Error('bet request lease_id mismatch');
  const expected = await hmacSha256Hex(executorLease.secret, `betRequest:${leaseId}:${requestId}`);
  if (expected !== signature) throw new Error('bet request lease signature invalid');
}

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

// -- 共享管线钩子（平台差异） -------------------------------------------------

function bridgeOnSocketOpen() {
  send({
    kind: 'sessionAction',
    action: 'command-executed',
    url: '',
    frame: '',
    detail: 'bg-sw-connected',
    timestamp: new Date().toISOString(),
  });
}

function bridgeOnSocketMessage(message, generation) {
  if (message.kind === 'betRequest') void handleBetRequest(message, generation);
  if (message.kind === 'command') void handleCommand(message, generation);
}

function isProtocolNetworkCapture(message) {
  if (!message || message.kind !== 'networkCapture') return false;
  if (message.encoding === 'base64') return false;
  if (typeof message.data === 'string' && message.data.length > 65536) return false;
  return PROTOCOL_CAPTURE_SOURCES.has(message.source);
}

function betErrorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message.slice(0, 500);
  return String(error || 'unknown live bet error').slice(0, 500);
}

function isLiveBetSessionCurrent(generation) {
  return liveBetSessionEnabled && activeSocketGeneration === generation && socket && socket.readyState === WebSocket.OPEN;
}

function rejectedReceipt(request, requestId, reason) {
  const wager = request && request.wager;
  const intent = request && request.intent;
  const tableId = normalizeTableId(wager && wager.tableId || intent && intent.tableId);
  const handId = String(wager && wager.handId || intent && intent.handId || '');
  const now = new Date().toISOString();
  const raw = { runtimeRevision: BG_BET_RUNTIME_REVISION, commitStarted: false, reason };
  if (wager) {
    return {
      receiptId: `bg-bridge-operational-rejected-${requestId}-${Date.now()}`,
      wagerId: wager.wagerId || '',
      tableId,
      shoeId: wager.shoeId || '',
      handId,
      market: wager.market,
      amount: wager.amount,
      source: wager.source,
      status: 'REJECTED',
      externalRef: `bg:${tableId}:${handId}`,
      createdAt: now,
      raw,
    };
  }
  return {
    receiptId: `bg-bridge-rejected-${requestId}-${Date.now()}`,
    intentId: intent && intent.intentId || '',
    reservationId: request && request.reservationId || '',
    status: 'REJECTED',
    amount: intent && intent.amount,
    market: intent && intent.market,
    mode: 'live',
    externalRef: `bg:${tableId}:${handId}`,
    createdAt: now,
    raw,
  };
}

function pickReadyBgFrame(ready) {
  if (!Array.isArray(ready) || ready.length === 0) return null;
  if (ready.length === 1) return ready[0];
  const scored = ready.map(entry => {
    const diagnostics = entry.result && entry.result.diagnostics ? entry.result.diagnostics : {};
    let score = 0;
    if (diagnostics.hasBetSocket) score += 8;
    if (diagnostics.tableMatched) score += 8;
    if (entry.frameId > 0) score += 2;
    return { entry, score };
  });
  scored.sort((left, right) => right.score - left.score || left.entry.frameId - right.entry.frameId);
  if (scored[0].score > scored[1].score) return scored[0].entry;
  return null;
}

async function uniqueBgPopupTab() {
  const tabs = await chrome.tabs.query({ url: [DAFABET_POPUP_QUERY] });
  const targets = tabs.filter(tab => tab.id && exactDafabetBgPopup(tab.url));
  if (targets.length !== 1) {
    throw new Error(`expected exactly one Dafabet BG popup tab, found ${targets.length}`);
  }
  return targets[0];
}

async function executeUniqueBgBet(message, generation) {
  const request = message.request;
  const requestId = message.requestId;
  if (!liveBetSessionEnabled) {
    return rejectedReceipt(request, requestId, 'live-bet-disabled');
  }
  const tableId = normalizeTableId(
    request && request.wager && request.wager.tableId
    || request && request.intent && request.intent.tableId,
  );
  if (!tableId) return rejectedReceipt(request, requestId, 'invalid-table-id');
  const tab = await uniqueBgPopupTab();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: 'MAIN',
    files: ['bg-bet-runtime.js'],
  });
  const probes = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: 'MAIN',
    func: table => (typeof globalThis.probeBgBetTable === 'function'
      ? globalThis.probeBgBetTable(table)
      : { status: 'not-ready', runtimeRevision: '', host: location.hostname, tableId: table, diagnostics: { reason: 'runtime-missing' } }),
    args: [tableId],
  });
  const ready = (probes || []).filter(entry =>
    entry && entry.result && entry.result.status === 'ready'
    && entry.result.runtimeRevision === BG_BET_RUNTIME_REVISION
    && Number.isInteger(entry.frameId),
  );
  const chosen = pickReadyBgFrame(ready);
  if (!chosen) {
    return rejectedReceipt(request, requestId, `expected one ready BG frame, found ${ready.length}`);
  }
  const [executed] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [chosen.frameId] },
    world: 'MAIN',
    func: payload => globalThis.executeBgBetOneShot(payload),
    args: [request],
  });
  const receipt = executed && executed.result ? executed.result : rejectedReceipt(request, requestId, 'empty-runtime-result');
  if (
    receipt
    && receipt.status !== 'UNKNOWN'
    && receipt.raw
    && receipt.raw.commitStarted === true
    && !isLiveBetSessionCurrent(generation)
  ) {
    receipt.status = 'UNKNOWN';
    receipt.raw = { ...(receipt.raw || {}), reason: 'bridge-disconnected-after-commit-point' };
  }
  return receipt;
}

function handleBetRequest(message, generation) {
  const requestId = message && typeof message.requestId === 'string' ? message.requestId : '';
  if (requestId && betRequests.has(requestId)) return betRequests.get(requestId);
  const operation = Promise.resolve()
    .then(() => assertSignedExecutorBet(message))
    .then(() => executeUniqueBgBet(message, generation))
    .then(receipt => {
      sendBetResult({ kind: 'betResult', requestId, receipt }, generation);
      return receipt;
    })
    .catch(error => {
      const reason = betErrorMessage(error);
      const receipt = /expected exactly one Dafabet BG popup/.test(reason)
        ? rejectedReceipt(message.request, requestId, reason)
        : null;
      sendBetResult({
        kind: 'betResult',
        requestId,
        receipt,
        ...(receipt ? {} : { error: reason }),
      }, generation);
      return receipt;
    });
  if (requestId) betRequests.set(requestId, operation);
  return operation;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + '-timeout')), ms)),
  ]);
}

async function handleCommand(message, generation) {

  const name = message && message.name;
  const tableIds = message && message.tableIds;
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
    void scheduleExtensionReload('bridge-command');
    return;
  }
  if (name === 'probeBetReadiness') {
    const requested = Array.from(new Set((Array.isArray(tableIds) ? tableIds : []).map(normalizeTableId).filter(Boolean)));
    if (requested.length === 0) {
      send({
        kind: 'sessionAction',
        action: 'command-executed',
        url: '',
        frame: 'allFrames',
        detail: 'probeBetReadiness:no-valid-table',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    try {
      const tabIds = await collectBgReloadTabIds();
      const all = [];
      for (const tabId of tabIds) {
        let probes = [];
        try {
        probes = await withTimeout(chrome.scripting.executeScript({
          target: { tabId: tabId, allFrames: true },
          world: 'MAIN',
          func: table => {
            const proto = globalThis.BaccaratBgProtocol;
            const session = proto && proto.session ? proto.session : {};
            const startBets = session.debug && Array.isArray(session.debug.startBets) ? session.debug.startBets : [];
            const shoes = session.debug && Array.isArray(session.debug.shoes) ? session.debug.shoes : [];
            const histories = session.debug && Array.isArray(session.debug.histories) ? session.debug.histories : [];
            const seqTables = session.seqNoByTable ? Object.keys(session.seqNoByTable) : [];
            const historyTables = session.historyCountByTable ? Object.keys(session.historyCountByTable) : [];
            return {
              host: location.hostname,
              href: String(location.href || '').slice(0, 180),
              tableId: table,
              hasToken: Boolean(session.token),
              hasUid: Boolean(session.uid),
              hook: session.hook ? 1 : 0,
              socketCount: Array.isArray(session.sockets) ? session.sockets.filter(item => item && item.readyState === 1).length : 0,
              seqNo: session.seqNoByTable && session.seqNoByTable[table],
              seqTables: seqTables.slice(0, 80),
              hallCount: Array.isArray(session.hallTableIds) ? session.hallTableIds.length : 0,
              hallIds: Array.isArray(session.hallTableIds) ? session.hallTableIds.slice(0, 80) : [],
              historyTables: historyTables.slice(0, 40),
              dropped: Array.isArray(session.nonBaccaratTableIds) ? session.nonBaccaratTableIds.slice(0, 40) : [],
              startBetCount: startBets.length,
              shoeCount: shoes.length,
              historyCount: histories.length,
              debug: session.debug || null,
            };
          },
          args: [requested[0]],
        }), 4000, 'probe-frames');
        for (const entry of probes || []) {
          if (entry && entry.result) all.push(entry.result);
        }
        } catch (_) {}
      }
      const score = item => {
        const href = String(item.href || '');
        const host = String(item.host || '');
        let value = (item.hallCount || 0) * 10 + (item.socketCount || 0) * 8 + (item.hasToken ? 20 : 0) + (item.seqTables ? item.seqTables.length : 0) + (item.shoeCount || 0) * 5 + (item.startBetCount || 0) + (item.historyCount || 0);
        if (/h5V01/i.test(href) || /jbz029/i.test(host)) value += 50;
        return value;
      };
      all.sort((a, b) => score(b) - score(a));
      const sample = all[0] || {};
      const debug = sample.debug || {};
      send({
        kind: 'sessionAction',
        action: 'command-executed',
        url: sample.href || '',
        frame: sample.host || 'allFrames',
        detail: JSON.stringify({
          probe: 'probeBetReadiness',
          frames: all.length,
          frameHosts: all.map(item => ({
            host: item.host || '',
            token: item.hasToken ? 1 : 0,
            hook: item.hook || 0,
            sockets: item.socketCount || 0,
            hall: item.hallCount || 0,
            hist: (item.historyTables || []).length,
          })).slice(0, 8),
          host: sample.host || '',
          token: sample.hasToken ? 1 : 0,
          uid: sample.hasUid ? 1 : 0,
          sockets: sample.socketCount || 0,
          seq: sample.seqNo || 0,
          seqTables: sample.seqTables || [],
          hallCount: sample.hallCount || 0,
          hallIds: sample.hallIds || [],
          historyTables: sample.historyTables || [],
          dropped: sample.dropped || [],
          hallMeta: debug.hallMeta || null,
          startBets: (debug.startBets || []).slice(-8),
          shoes: debug.shoes || [],
          histories: (debug.histories || []).slice(-8),
        }).slice(0, 4000),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      send({
        kind: 'sessionAction',
        action: 'command-executed',
        url: '',
        frame: 'allFrames',
        detail: `probeBetReadiness:${betErrorMessage(error)}`,
        timestamp: new Date().toISOString(),
      });
    }
  }
}


async function collectBgPopupTabIds() {
  try {
    const tabs = await chrome.tabs.query({ url: [DAFABET_POPUP_QUERY] });
    return tabs.filter(tab => tab.id && exactDafabetBgPopup(tab.url)).map(tab => tab.id);
  } catch (_) {
    return [];
  }
}

function isBgGameTabUrl(url) {
  const href = String(url || '');
  if (!href) return false;
  if (exactDafabetBgPopup(href)) return true;
  if (/\/h5V01\//i.test(href) || /(?:^|\.)jbz029\.com/i.test(href)) return true;
  if (/vbgames88\.com/i.test(href) && /bg~~|\/portals\/bg/i.test(href)) return true;
  return false;
}

async function collectBgReloadTabIds() {
  const ids = new Set(await collectBgPopupTabIds());
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && isBgGameTabUrl(tab.url)) ids.add(tab.id);
    }
  } catch (_) {}
  return [...ids];
}

async function scheduleExtensionReload(reason) {
  const ids = await collectBgReloadTabIds();
  try {
    await chrome.storage.local.set({
      pendingBgPopupReloadIds: ids,
      pendingBgPopupReloadReason: String(reason || 'manual'),
    });
  } catch (_) {}
  send({
    kind: 'sessionAction',
    action: 'command-executed',
    url: '',
    frame: '',
    detail: `reloadExtension-scheduled:${reason || 'manual'}:tabs=${ids.length}`,
    timestamp: new Date().toISOString(),
  });
  try { if (socket) socket.close(); } catch (_) {}
  socket = null;
  setTimeout(() => chrome.runtime.reload(), EXTENSION_RELOAD_DELAY_MS);
}

async function flushPendingBgPopupReload() {
  let stored = { pendingBgPopupReloadIds: [], pendingBgPopupReloadReason: '' };
  try {
    stored = await chrome.storage.local.get({ pendingBgPopupReloadIds: [], pendingBgPopupReloadReason: '' });
    await chrome.storage.local.remove(['pendingBgPopupReloadIds', 'pendingBgPopupReloadReason']);
  } catch (_) {}
  if (!stored.pendingBgPopupReloadReason && !(Array.isArray(stored.pendingBgPopupReloadIds) && stored.pendingBgPopupReloadIds.length)) {
    return;
  }
  send({
    kind: 'sessionAction',
    action: 'command-executed',
    url: '',
    frame: '',
    detail: 'reloadExtension-flushed:manual-popup-refresh-required',
    timestamp: new Date().toISOString(),
  });
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    void scheduleExtensionReload('action-click');
  });
}
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(command => {
    if (command === 'reload-extension') void scheduleExtensionReload('keyboard-command');
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
    tables.push(Object.assign({}, table, { tableId: tableId }));
  }
  return Object.assign({}, message, { room: Object.assign({}, room, { tables: tables }) });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.kind !== 'string' || !isTrustedGameSender(sender)) return;
  if (!socket || socket.readyState > WebSocket.OPEN) void connect();
  send(sanitizeForwardedMessage(message));
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !(isGameTabUrl(tab.url) || exactDafabetBgPopup(tab.url))) return;
  void connect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureBridgeReconnectAlarm();
  void loadFlags();
  void connect();
  setTimeout(() => { void flushPendingBgPopupReload(); }, 800);
});
chrome.runtime.onStartup.addListener(() => {
  ensureBridgeReconnectAlarm();
  void loadFlags();
  void connect();
});
void loadFlags();
ensureBridgeReconnectAlarm();
void connect();
