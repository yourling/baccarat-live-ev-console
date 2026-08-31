/**
 * Service Worker：维护到本机 EV 中控台桥接服务的 WebSocket 连接，
 * 转发 content script 与桥接服务之间的消息，并提供可选的可信输入保活
 * （chrome.debugger / CDP，由 storage.trustedKeepalive 控制）。
 */

const DEFAULT_BRIDGE_TOKEN = 'd63a1a9d927e268d5b3d0ac2450836c0fa90de2e55398ccb73ae888ecf35d97b';
const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:17890/?token=${DEFAULT_BRIDGE_TOKEN}`;
const CDP_MIN_INTERVAL_MS = 60 * 1000;
const EXTENSION_RELOAD_DELAY_MS = 1000;
const BRIDGE_RECONNECT_ALARM = 'baccarat-bridge-reconnect';
const DAFABET_PRAGMATIC_POPUP_PATH = '/live-dealer/popup-launch/jeju-speed-baccarat';
const DAFABET_POPUP_QUERY = 'https://www.dafabet.net/*/live-dealer/popup-launch/jeju-speed-baccarat*';
const GAME_TAB_URL_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:dafabet\.net|vbgames88\.com|zavjcswh\.biz|pragmaticplaylive\.net)(?::\d+)?(?:[/?#]|$)/i;
const PRAGMATIC_FRAME_HOST_PATTERN = /(^|\.)client\.pragmaticplaylive\.net$/i;
const PRAGMATIC_TABLE_ID_PATTERN = /^[a-z0-9]{8,32}$/i;
const PRAGMATIC_BET_RUNTIME_REVISION = 'pragmatic-bet-runtime/2026-08-30.21';
const betRequests = new Map();
const pragmaticProtocolWindows = new Map();
let liveBetSessionEnabled = false;
const BRIDGE_SESSION_ID = [
  'bridge',
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 12),
].join('-');
let bridgeMessageSeq = 0;
let pragmaticBetInputBusy = false;

function notePragmaticOutboundSend(message) {
  if (
    !message
    || message.kind !== 'networkCapture'
    || message.direction !== 'send'
    || typeof message.source !== 'string'
    || !message.source.startsWith('baccarat-bridge-pragmatic-')
  ) return;
  const data = String(message.data || '');
  if (data.length < 8) return;
  if (!/bet|betcode|"bc"|stake|amount|amt/i.test(data)) return;
  if (/<lpbet[\s>]/i.test(data) || /\buId="/.test(data)) {
    const uId = (data.match(/\buId="([^"]+)"/) || [])[1];
    const gm = (data.match(/\bgm="([^"]+)"/) || [])[1];
    try {
      void chrome.storage.local.set({
        ...( /<lpbet[\s>]/i.test(data) ? { pragmaticLpBetTemplate: data.slice(0, 4000) } : {}),
        ...(uId ? { pragmaticLpBetUserId: uId } : {}),
        ...(gm ? { pragmaticLpBetGm: gm } : {}),
      });
    } catch (_) {}
  }
  send({
    kind: 'sessionAction',
    action: 'pragmatic-outbound-send',
    url: String(message.url || ''),
    frame: 'iframe',
    detail: `${message.source}:${data.slice(0, 800)}`,
    timestamp: new Date().toISOString(),
  });
}

function ingestPragmaticProtocolWindow(message) {
  if (
    !message
    || message.kind !== 'networkCapture'
    || message.source !== 'baccarat-bridge-pragmatic-ws'
    || message.encoding !== 'text'
    || message.direction === 'send'
    || typeof message.data !== 'string'
  ) return;
  let root;
  try {
    root = JSON.parse(message.data);
  } catch (_) {
    return;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return;
  const kinds = ['game', 'timer', 'betsopen', 'betsclosingsoon', 'betsclosed', 'startDealing', 'gameresult'];
  const kind = kinds.find(candidate => root[candidate] && typeof root[candidate] === 'object');
  if (!kind) return;
  const record = root[kind];
  const tableId = String(record.table || record.tableId || '').toLowerCase();
  if (!PRAGMATIC_TABLE_ID_PATTERN.test(tableId)) return;
  const seq = Number(record.seq);
  const previous = pragmaticProtocolWindows.get(tableId) || {
    tableId,
    lastSeq: -1,
  };
  const now = Date.now();
  const roundId = String(record.game || record.id || record.gameId || '');
  const isNewRound = Boolean(roundId) && roundId !== previous.roundId;
  const windowKind = kind === 'timer' || kind === 'betsopen';
  const staleSeq = Number.isFinite(seq) && seq <= previous.lastSeq;
  const allowLowerSeqWindow = windowKind
    && (isNewRound || (previous.bettingOpen !== false && (!roundId || roundId === previous.roundId)));
  if (staleSeq && !allowLowerSeqWindow) return;
  if (Number.isFinite(seq) && !staleSeq) previous.lastSeq = seq;
  if (isNewRound) {
    previous.roundId = roundId;
    previous.bettingOpen = undefined;
    previous.countdown = undefined;
    previous.countdownAt = undefined;
  }
  if (kind === 'timer') {
    const countdown = Number(record.value);
    if (Number.isFinite(countdown)) {
      previous.countdown = countdown;
      previous.countdownAt = now;
      if (countdown >= 1) previous.bettingOpen = true;
      if (countdown === 0) previous.bettingOpen = false;
    }
  } else if (kind === 'betsopen') {
    previous.bettingOpen = true;
  } else if (kind === 'betsclosed' || kind === 'startDealing' || kind === 'gameresult') {
    previous.bettingOpen = false;
  }
  previous.updatedAt = now;
  pragmaticProtocolWindows.set(tableId, previous);
}

function pragmaticProtocolWindow(tableId) {
  const state = pragmaticProtocolWindows.get(String(tableId || '').toLowerCase());
  if (
    !state
    || state.bettingOpen !== true
    || typeof state.roundId !== 'string'
    || !Number.isFinite(state.countdown)
    || !Number.isFinite(state.countdownAt)
    || Date.now() - state.countdownAt > 5000
  ) return null;
  const capturedAt = Date.now();
  const countdown = Math.floor(state.countdown - Math.max(0, capturedAt - state.countdownAt) / 1000);
  return countdown >= 3 ? { roundId: state.roundId, countdown, capturedAt } : null;
}

if (typeof importScripts === 'function') {
  importScripts('pragmatic-bet-runtime.js');
}

function isGameTabUrl(url) {
  return GAME_TAB_URL_PATTERN.test(String(url || ''));
}

function isTrustedGameSender(sender) {
  return !!sender
    && !!sender.tab
    && isGameTabUrl(sender.url || sender.tab.url);
}
let socket = null;
let socketGeneration = 0;
let activeSocketGeneration = 0;
let reconnectTimer = null;
let reconnectDelay = 1000;
let keeperTabId = null;
let keeperCreationPromise = null;

// storage 可控开关
let autoKeeperEnabled = false;      // storage.autoKeeper
let trustedKeepaliveEnabled = false; // storage.trustedKeepalive
let cdpClickPoint = null;           // storage.cdpClickPoint = { xp, yp }（相对游戏帧视口的比例）

// CDP 可信输入状态
let cdpBusy = false;
let lastCdpActivityAt = 0;
let cdpAttachedTabId = null;
let lastCdpUrl = '';
const pragmaticCdpTabs = new Set();
const pragmaticCdpSocketUrls = new Map();
const pragmaticCdpSeenResponses = new Set();
const pragmaticCdpResponseCandidates = new Map();
const pragmaticCdpStreams = new Map();

async function loadFlags() {
  const stored = await chrome.storage.local.get({
    bridgeUrl: DEFAULT_BRIDGE_URL,
    autoKeeper: false,
    trustedKeepalive: false,
    liveBetEnabled: false,
    cdpClickPoint: null,
  });
  autoKeeperEnabled = !!stored.autoKeeper;
  trustedKeepaliveEnabled = !!stored.trustedKeepalive;
  liveBetSessionEnabled = !!stored.liveBetEnabled;
  cdpClickPoint = stored.cdpClickPoint && typeof stored.cdpClickPoint.xp === 'number'
    ? { xp: stored.cdpClickPoint.xp, yp: stored.cdpClickPoint.yp }
    : null;
}

chrome.storage.onChanged.addListener((_changes, _area) => {
  void loadFlags();
});

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

async function connect() {
  const url = await getBridgeUrl();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

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
    });
    void replayRuntimeStateInGameFrames();
  });

  connection.addEventListener('message', event => {
    if (!isCurrentSocket(connection, generation)) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (!message) return;
    if (message.kind === 'betRequest') {
      void handleBetRequest(message, generation);
    }
    if (message.kind === 'command') {
      const tableIds = Array.isArray(message.tableIds)
        ? message.tableIds.filter(value => typeof value === 'string')
        : [];
      void handleRemoteCommand(String(message.name || ''), tableIds, generation);
    }
  });

  connection.addEventListener('close', () => {
    invalidateSocket(connection, generation);
  });

  connection.addEventListener('error', () => {
    if (!invalidateSocket(connection, generation)) return;
    try {
      connection.close();
    } catch (_) {
      // ignore
    }
  });
}

function isCurrentSocket(connection, generation) {
  return socket === connection && activeSocketGeneration === generation;
}

function invalidateSocket(connection, generation) {
  if (!isCurrentSocket(connection, generation)) return false;
  liveBetSessionEnabled = false;
  activeSocketGeneration = 0;
  socket = null;
  scheduleReconnect();
  return true;
}

function assertLiveBetSession(generation) {
  if (!liveBetSessionEnabled) {
    throw new Error('live betting is disabled in the browser extension');
  }
  if (!isLiveBetSessionCurrent(generation)) {
    throw new Error('live betting session is no longer active');
  }
}

function isLiveBetSessionCurrent(generation) {
  return liveBetSessionEnabled
    && activeSocketGeneration === generation
    && socket
    && socket.readyState === WebSocket.OPEN;
}
function exactDafabetPragmaticPopup(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname === 'www.dafabet.net'
      && parsed.pathname.replace(/^\/[a-z-]+/i, '').replace(/\/+$/, '') === DAFABET_PRAGMATIC_POPUP_PATH;
  } catch (_) {
    return false;
  }
}

function exactSupportedBaccaratPopup(url) {
  return exactDafabetPragmaticPopup(url);
}

function betErrorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message.slice(0, 500);
  }
  return String(error || 'unknown live bet error').slice(0, 500);
}

function unknownBetReceipt(request, requestId, reason, platform = 'pragmatic', rawDetails = {}) {
  const runtimeRevision = platform === 'pragmatic'
    ? PRAGMATIC_BET_RUNTIME_REVISION
    : PRAGMATIC_BET_RUNTIME_REVISION;
  const receiptPrefix = 'pragmatic-bridge';
  const wager = request && request.wager ? request.wager : null;
  if (wager && typeof wager === 'object') {
    const tableId = typeof wager.tableId === 'string' ? wager.tableId : '';
    const handId = typeof wager.handId === 'string' ? wager.handId : '';
    return {
      receiptId: `${receiptPrefix}-operational-unknown-${requestId}-${Date.now()}`,
      wagerId: typeof wager.wagerId === 'string' ? wager.wagerId : '',
      tableId,
      shoeId: typeof wager.shoeId === 'string' ? wager.shoeId : '',
      handId,
      market: wager.market,
      amount: wager.amount,
      source: wager.source,
      status: 'UNKNOWN',
      externalRef: `${platform}:${tableId}:${handId}`,
      createdAt: new Date().toISOString(),
      raw: {
        runtimeRevision,
        reason,
        commitPoint: 'confirmBet',
        commitStarted: true,
        tableId,
        handId,
        ...rawDetails,
      },
    };
  }
  const intent = request && request.intent ? request.intent : {};
  const tableId = typeof intent.tableId === 'string' ? intent.tableId : '';
  const handId = typeof intent.handId === 'string' ? intent.handId : '';
  return {
    receiptId: `${receiptPrefix}-unknown-${requestId}-${Date.now()}`,
    intentId: String(intent.intentId || ''),
    reservationId: String(request && request.reservationId || ''),
    status: 'UNKNOWN',
    amount: intent.amount,
    market: intent.market,
    mode: 'live',
    externalRef: `${platform}:${tableId}:${handId}`,
    createdAt: new Date().toISOString(),
    raw: {
      runtimeRevision,
      reason,
      commitPoint: 'confirmBet',
      commitStarted: true,
      tableId,
      handId,
      ...rawDetails,
    },
  };
}

function precommitRejectedBetReceipt(request, requestId, reason, platform = 'pragmatic') {
  const runtimeRevision = platform === 'pragmatic'
    ? PRAGMATIC_BET_RUNTIME_REVISION
    : PRAGMATIC_BET_RUNTIME_REVISION;
  const receiptPrefix = 'pragmatic-bridge';
  const wager = request && request.wager ? request.wager : null;
  if (wager && typeof wager === 'object') {
    const tableId = typeof wager.tableId === 'string' ? wager.tableId : '';
    const handId = typeof wager.handId === 'string' ? wager.handId : '';
    return {
      receiptId: `${receiptPrefix}-operational-rejected-${requestId}-${Date.now()}`,
      wagerId: typeof wager.wagerId === 'string' ? wager.wagerId : '',
      tableId,
      shoeId: typeof wager.shoeId === 'string' ? wager.shoeId : '',
      handId,
      market: wager.market,
      amount: wager.amount,
      source: wager.source,
      status: 'REJECTED',
      externalRef: `${platform}:${tableId}:${handId}`,
      createdAt: new Date().toISOString(),
      raw: {
        runtimeRevision,
        reason,
        commitPoint: 'preflight',
        commitStarted: false,
        tableId,
        handId,
      },
    };
  }
  const intent = request && request.intent ? request.intent : {};
  const tableId = typeof intent.tableId === 'string' ? intent.tableId : '';
  const handId = typeof intent.handId === 'string' ? intent.handId : '';
  return {
    receiptId: `${receiptPrefix}-rejected-${requestId}-${Date.now()}`,
    intentId: String(intent.intentId || ''),
    reservationId: String(request && request.reservationId || ''),
    status: 'REJECTED',
    amount: intent.amount,
    market: intent.market,
    mode: 'live',
    externalRef: `${platform}:${tableId}:${handId}`,
    createdAt: new Date().toISOString(),
    raw: {
      runtimeRevision,
      reason,
      commitPoint: 'preflight',
      commitStarted: false,
      tableId,
      handId,
    },
  };
}

function validateLiveBetMessage(message) {
  const request = message && message.request;
  if (!message || typeof message.requestId !== 'string' || !message.requestId) {
    throw new Error('invalid bet request id');
  }
  if (!request || request.mode !== 'live') {
    throw new Error('only live bet requests can enter the Pragmatic executor');
  }
  const intent = request.intent;
  const wager = request.wager;
  if (intent && wager) {
    throw new Error('bet request cannot contain both an EV intent and an operational wager');
  }
  const tableId = intent && intent.mode === 'live'
    ? intent.tableId
    : wager && typeof wager === 'object'
      ? wager.tableId
      : null;
  const platform = typeof tableId === 'string' && PRAGMATIC_TABLE_ID_PATTERN.test(tableId)
    ? 'pragmatic'
    : null;
  if (platform === null) {
    throw new Error('invalid Pragmatic table id');
  }
  return { requestId: message.requestId, request, tableId, platform };
}
async function preparePragmaticTable(tabId, tableId, market) {
  const protocolWindow = pragmaticProtocolWindow(tableId);
  return await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    args: [tableId, protocolWindow, market ?? null],
    func: async (targetTableId, protocolBettingWindow, targetMarket) => {
      const frameUrl = String(location.href || '');
      if (!/(^|\.)client\.pragmaticplaylive\.net$/i.test(location.hostname)) {
        return { status: 'skipped', frameUrl };
      }
      if (location.pathname !== '/desktop/multibaccarat/') {
        return { status: 'not-multitable', frameUrl };
      }
      delete globalThis.__baccaratPragmaticPreparedTable;
      const targetId = `TileHeight-${targetTableId}`;
      let root = document.getElementById(targetId);
      if (!root) {
        const scrollables = [document.scrollingElement, ...document.querySelectorAll('*')]
          .filter((element, index, values) => element
            && values.indexOf(element) === index
            && (
              Number(element.scrollHeight) > Number(element.clientHeight) + 80
              || Number(element.scrollWidth) > Number(element.clientWidth) + 80
            ))
          .sort((left, right) => {
            const leftRange = Math.max(
              Number(left.scrollHeight) - Number(left.clientHeight),
              Number(left.scrollWidth) - Number(left.clientWidth),
            );
            const rightRange = Math.max(
              Number(right.scrollHeight) - Number(right.clientHeight),
              Number(right.scrollWidth) - Number(right.clientWidth),
            );
            return rightRange - leftRange;
          })
          .slice(0, 8);
        let scanSteps = 0;
        for (const scrollable of scrollables) {
          const originalTop = Number(scrollable.scrollTop) || 0;
          const originalLeft = Number(scrollable.scrollLeft) || 0;
          const verticalMax = Math.max(0, Number(scrollable.scrollHeight) - Number(scrollable.clientHeight));
          const horizontalMax = Math.max(0, Number(scrollable.scrollWidth) - Number(scrollable.clientWidth));
          const verticalStep = Math.max(240, Math.floor(Number(scrollable.clientHeight) * 0.8));
          const horizontalStep = Math.max(240, Math.floor(Number(scrollable.clientWidth) * 0.8));
          const positions = [];
          for (let top = 0; top <= verticalMax && positions.length < 24; top += verticalStep) {
            positions.push([Math.min(top, verticalMax), originalLeft]);
          }
          for (let left = 0; left <= horizontalMax && positions.length < 32; left += horizontalStep) {
            positions.push([originalTop, Math.min(left, horizontalMax)]);
          }
          for (const [top, left] of positions) {
            try {
              if (typeof scrollable.scrollTo === 'function') scrollable.scrollTo({ top, left, behavior: 'instant' });
              else {
                scrollable.scrollTop = top;
                scrollable.scrollLeft = left;
              }
            } catch (_) {
              continue;
            }
            scanSteps += 1;
            await new Promise(resolve => setTimeout(resolve, 80));
            root = document.getElementById(targetId);
            if (root || scanSteps >= 64) break;
          }
          if (root || scanSteps >= 64) break;
          try {
            scrollable.scrollTop = originalTop;
            scrollable.scrollLeft = originalLeft;
          } catch (_) {}
        }
        if (!root) {
          const tableIds = Array.from(document.querySelectorAll('[id^="TileHeight-"]'))
            .map(element => String(element.id || '').slice('TileHeight-'.length))
            .filter(Boolean)
            .slice(0, 80);
          return { status: 'not-found-after-scroll', frameUrl, scanSteps, tableIds };
        }
      }
      try {
        root.scrollIntoView({ block: 'center', inline: 'center' });
      } catch (_) {
        return { status: 'scroll-failed', frameUrl };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const roundIdentity = clean(root.textContent);
      const roundId = (roundIdentity.match(/(?:ID|局号|游戏编号|牌局)\s*[:：#]?\s*(\d{8,20})/i) || [])[1] || '';
      const effectiveRoundId = roundId || String(protocolBettingWindow?.roundId || '');
      const timer = root.querySelector('[data-testid^="timer-countdown-"]');
      const domCountdown = Number(clean(timer?.textContent));
      const protocolCountdown = protocolBettingWindow
        && Number.isFinite(protocolBettingWindow.countdown)
        && Number.isFinite(protocolBettingWindow.capturedAt)
        ? Math.floor(
          protocolBettingWindow.countdown
          - Math.max(0, Date.now() - protocolBettingWindow.capturedAt) / 1000
        )
        : Number.NaN;
      const countdownCandidates = [
        timer && Number.isFinite(domCountdown) ? domCountdown : Number.NaN,
        protocolCountdown,
      ].filter(Number.isFinite);
      const countdown = countdownCandidates.length > 0 ? Math.min(...countdownCandidates) : Number.NaN;
      const countdownAt = Date.now();
      if (!Number.isFinite(countdown) || countdown < 1) {
        return { status: 'betting-window-closed', frameUrl, roundId: effectiveRoundId, domRoundId: roundId };
      }
      const videoIcon = root.querySelector('[data-testid="icon-Video"]');
      const activator = videoIcon?.closest?.('button, [role="button"], a') || videoIcon?.parentElement;
      if (!activator || activator.querySelector?.('[data-betcode]') || activator.hasAttribute?.('data-betcode')) {
        return { status: 'activation-control-missing', frameUrl };
      }
      try {
        activator.click();
      } catch (_) {
        return { status: 'activation-failed', frameUrl };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      const visible = element => {
        if (!element || element.disabled === true) return false;
        try {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        } catch (_) {
          return true;
        }
      };
      const marketCodes = { player: '0', banker: '1', playerPair: '3', bankerPair: '4' };
      const requiredMarkets = typeof targetMarket === 'string' && marketCodes[targetMarket]
        ? [targetMarket]
        : Object.keys(marketCodes);
      const marketControls = {};
      const marketCounts = {};
      for (const [market, code] of Object.entries(marketCodes)) {
        const candidates = Array.from(document.querySelectorAll(`[data-betcode="${code}"]`))
          .filter(element => visible(element) && !element.closest?.('[id^="TileHeight-"]'));
        marketCounts[market] = candidates.length;
        if (candidates.length === 1) marketControls[market] = candidates[0];
      }
      if (!requiredMarkets.every(market => marketControls[market])) {
        return { status: 'shared-market-controls-ambiguous', frameUrl, roundId: effectiveRoundId, domRoundId: roundId, marketCounts };
      }
      globalThis.__baccaratPragmaticPreparedTable = {
        tableId: targetTableId,
        roundId: effectiveRoundId,
        countdown,
        countdownAt,
        preparedAt: Date.now(),
        marketControls,
      };
      return { status: 'activated', frameUrl, roundId: effectiveRoundId, domRoundId: roundId, countdown };
    },
  });
}

function selectPragmaticReadyFrame(probes, tableId) {
  const ready = probes.filter(entry => {
    const result = entry && entry.result;
    return result
      && result.status === 'ready'
      && result.tableId === tableId
      && result.runtimeRevision === PRAGMATIC_BET_RUNTIME_REVISION
      && PRAGMATIC_FRAME_HOST_PATTERN.test(String(result.host || ''))
      && Number.isInteger(entry.frameId);
  });
  const candidates = probes.filter(entry => {
    const result = entry && entry.result;
    return result
      && result.tableId === tableId
      && result.status !== 'not-found'
      && result.routingAuthority !== 'none'
      && result.runtimeRevision === PRAGMATIC_BET_RUNTIME_REVISION
      && PRAGMATIC_FRAME_HOST_PATTERN.test(String(result.host || ''))
      && Number.isInteger(entry.frameId);
  });
  const authorityOrder = ['prepared-multitable', 'dedicated-referrer'];
  for (const authority of authorityOrder) {
    const authoritative = ready.filter(entry => entry.result.routingAuthority === authority);
    if (authoritative.length > 0) {
      return {
        ready,
        selected: authoritative.length === 1 ? authoritative[0] : null,
        authority,
        conflictCount: authoritative.length,
      };
    }
  }
  for (const authority of authorityOrder) {
    const authoritative = candidates.filter(entry => entry.result.routingAuthority === authority);
    if (authoritative.length > 0) {
      return {
        ready,
        selected: authoritative.length === 1 ? authoritative[0] : null,
        authority: `${authority}-fallback`,
        conflictCount: authoritative.length,
      };
    }
  }
  if (ready.length === 0 && candidates.length === 1) {
    return {
      ready,
      selected: candidates[0],
      authority: String(candidates[0].result.routingAuthority || 'unique-frame-fallback'),
      conflictCount: candidates.length,
    };
  }
  return {
    ready,
    selected: ready.length === 1 ? ready[0] : null,
    authority: ready.length === 1 ? String(ready[0].result.routingAuthority || 'unique-ready') : 'unique-ready',
    conflictCount: ready.length || candidates.length,
  };
}

function pragmaticPhaseReceipt(result) {
  return result
    && typeof result === 'object'
    && ['ACCEPTED', 'REJECTED', 'UNKNOWN'].includes(result.status)
    ? result
    : null;
}

function pragmaticPhaseReason(result, fallback) {
  const raw = result && typeof result === 'object' ? result.raw : null;
  return raw && typeof raw === 'object' && typeof raw.reason === 'string'
    ? raw.reason
    : fallback;
}

async function executePragmaticBetPhase(tabId, frameId, request, command) {
  const executions = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    args: [request, command],
    func: globalThis.executePragmaticBetOneShot,
  });
  return executions.length === 1 ? executions[0].result : null;
}

async function resolvePragmaticTopPoint(tabId, frameId, point) {
  if (
    !point
    || typeof point !== 'object'
    || ![point.x, point.y, point.width, point.height, point.viewportWidth, point.viewportHeight]
      .every(Number.isFinite)
  ) throw new Error('invalid trusted click point');
  if (frameId === 0) return point;
  const token = `bet-frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  let timeoutId;
  try {
    const translated = await Promise.race([
      chrome.tabs.sendMessage(tabId, { kind: 'resolveBetFrameRect', token, rect: point }, { frameId }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('trusted click frame coordinate timeout')), 3500);
      }),
    ]);
    if (
      !translated
      || typeof translated !== 'object'
      || ![translated.x, translated.y, translated.width, translated.height].every(Number.isFinite)
    ) throw new Error('trusted click frame coordinate unavailable');
    return translated;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function dispatchPragmaticTrustedClick(tabId, point) {
  if (cdpBusy) throw new Error('trusted input channel busy');
  cdpBusy = true;
  let pressed = false;
  try {
    if (!(await ensureCdpAttached(tabId))) throw new Error('browser debugger attach rejected');
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse',
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
    });
    pressed = true;
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
    });
    return { x, y };
  } catch (error) {
    const failure = new Error(betErrorMessage(error));
    failure.pressDispatched = pressed;
    throw failure;
  } finally {
    cdpBusy = false;
  }
}

async function executeUniquePragmaticBet(message, generation) {
  const parsed = validateLiveBetMessage(message);
  const expectedHandId = String(parsed.request.intent?.handId || parsed.request.wager?.handId || '');
  let tabId;
  let frameId;
  let requestResult = null;
  try {
    assertLiveBetSession(generation);
    const tabs = await chrome.tabs.query({
      url: [DAFABET_POPUP_QUERY],
    });
    assertLiveBetSession(generation);
    const targets = tabs.filter(tab => tab.id && exactDafabetPragmaticPopup(tab.url));
    if (targets.length !== 1) {
      throw new Error(`expected exactly one Dafabet Pragmatic popup tab, found ${targets.length}`);
    }
    tabId = targets[0].id;
    const requestedMarket = parsed.request.intent?.market || parsed.request.wager?.market || '';
    const channelStatus = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        const channel = globalThis.__baccaratPragmaticBetChannel;
        return channel && typeof channel.status === 'function'
          ? channel.status()
          : { hasUser: false, hasSocket: false };
      },
    });
    const readyChannel = channelStatus.find(entry =>
      entry && entry.result && entry.result.hasSocket === true && entry.result.hasUser === true)
      || channelStatus.find(entry => entry && entry.result && entry.result.hasSocket === true);
    const requestHits = readyChannel && Number.isInteger(readyChannel.frameId)
      ? await chrome.scripting.executeScript({
        target: { tabId, frameIds: [readyChannel.frameId] },
        world: 'MAIN',
        args: [parsed.request, { phase: 'request', expectedRoundId: expectedHandId }],
        func: globalThis.executePragmaticBetOneShot,
      })
      : [];
    const requestHit = requestHits.find(entry =>
      entry && entry.result && (
        entry.result.phase === 'requested' || entry.result.status === 'ACCEPTED'
      ));
    if (requestHit) {
      frameId = requestHit.frameId;
      requestResult = requestHit.result;
    } else {
      const requestMiss = requestHits.find(entry =>
        entry && entry.result && entry.result.phase === 'request-unavailable'
        && entry.result.reason !== 'bet-request-channel-unavailable');
      if (requestMiss) {
        frameId = requestMiss.frameId;
        requestResult = requestMiss.result;
      } else {
    const preparations = await preparePragmaticTable(tabId, parsed.tableId, requestedMarket);
    const multitableResults = preparations.filter(entry =>
      String(entry?.result?.frameUrl || '').includes('/desktop/multibaccarat/'));
    if (multitableResults.length > 0) {
      const activated = multitableResults.filter(entry =>
        entry?.result?.status === 'activated');
      if (activated.length !== 1) {
        const statuses = multitableResults.map(entry => String(entry?.result?.status || 'missing')).join(',');
        const rounds = multitableResults.map(entry => String(entry?.result?.roundId || '')).join(',');
        throw new Error(`Pragmatic target table preparation failed: ${statuses}; rounds=${rounds}; requestHand=${expectedHandId}`);
      }
    }
    assertLiveBetSession(generation);
    const probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [parsed.tableId, requestedMarket],
      func: globalThis.probePragmaticBetTable,
    });
    assertLiveBetSession(generation);
    const selection = selectPragmaticReadyFrame(probes, parsed.tableId);
    if (!selection.selected) {
      throw new Error(
        `expected one authoritative ready Pragmatic frame for ${parsed.tableId}, `
        + `found ${selection.ready.length} ready and ${selection.conflictCount} at ${selection.authority}`,
      );
    }
    frameId = selection.selected.frameId;
      }
    }
  } catch (error) {
    return precommitRejectedBetReceipt(
      parsed.request,
      parsed.requestId,
      `precommit-routing-failed:${betErrorMessage(error)}`,
      'pragmatic',
    );
  }

  if (pragmaticBetInputBusy) {
    return precommitRejectedBetReceipt(
      parsed.request,
      parsed.requestId,
      'trusted-input-channel-busy',
      'pragmatic',
    );
  }
  pragmaticBetInputBusy = true;
  let commitStarted = false;
  let committedAmount = 0;
  const selectedChips = [];
  const unknownAfterCommit = (reason, details = {}) => unknownBetReceipt(
    parsed.request,
    parsed.requestId,
    reason,
    'pragmatic',
    {
      commitPoint: 'market-click',
      committedAmount,
      selectedChips: [...selectedChips],
      trustedInput: true,
      ...details,
    },
  );
  try {
    assertLiveBetSession(generation);
    const requestSent = requestResult && (
      requestResult.phase === 'requested'
      || requestResult.raw?.reason === 'lpbet-sent'
      || requestResult.raw?.requestSent === true
    );
    if (requestSent) {
      commitStarted = true;
      committedAmount = Number(parsed.request.wager?.amount || parsed.request.intent?.amount || 0);
      selectedChips.push('default');
      const beforeTotal = Number(
        requestResult.beforeTotal ?? (requestResult.raw && requestResult.raw.beforeTotal),
      );
      const observed = await executePragmaticBetPhase(tabId, frameId, parsed.request, {
        phase: 'observe',
        beforeTotal,
        beforeTotalObserved: requestResult.beforeTotalObserved === true
          || Boolean(requestResult.raw && requestResult.raw.beforeTotalObserved === true),
        expectedTotal: beforeTotal + committedAmount,
        expectedRoundId: expectedHandId,
        selectedChips,
        final: true,
      });
      const observedReceipt = pragmaticPhaseReceipt(observed);
      if (observedReceipt) {
        return observedReceipt.status === 'REJECTED'
          ? unknownAfterCommit(`post-submit-rejected:${pragmaticPhaseReason(observedReceipt, 'unexpected-rejection')}`)
          : observedReceipt;
      }
      if (
        !observed
        || observed.phase !== 'observed'
        || observed.runtimeRevision !== PRAGMATIC_BET_RUNTIME_REVISION
      ) return unknownAfterCommit('platform-acknowledgement-invalid');
      return unknownAfterCommit('platform-acknowledgement-missing-final-receipt');
    }
    if (requestResult && requestResult.phase === 'request-unavailable') {
      return precommitRejectedBetReceipt(
        parsed.request,
        parsed.requestId,
        `request-unavailable:${String(requestResult.reason || 'bet-request-channel-unavailable')}`,
        'pragmatic',
      );
    }
    const prepared = await executePragmaticBetPhase(tabId, frameId, parsed.request, { phase: 'prepare' });
    const preparedReceipt = pragmaticPhaseReceipt(prepared);
    if (preparedReceipt) return preparedReceipt;
    if (
      !prepared
      || prepared.phase !== 'prepared'
      || prepared.runtimeRevision !== PRAGMATIC_BET_RUNTIME_REVISION
    ) {
      throw new Error('trusted bet preflight returned an invalid plan');
    }
    const beforeTotal = Number(prepared.beforeTotal);
    const expectedRoundId = String(prepared.currentRoundId || '');
    const committedStake = Number(prepared.amount);
    if (!Number.isFinite(committedStake) || committedStake <= 0) {
      throw new Error('trusted bet preflight returned an invalid amount');
    }
    assertLiveBetSession(generation);
    const marketTarget = await executePragmaticBetPhase(tabId, frameId, parsed.request, {
      phase: 'target',
      action: 'market',
      expectedRoundId,
    });
    const marketReceipt = pragmaticPhaseReceipt(marketTarget);
    if (marketReceipt) return marketReceipt;
    if (!marketTarget || marketTarget.phase !== 'target' || marketTarget.action !== 'market') {
      throw new Error('trusted market target unavailable');
    }
    const marketPoint = await resolvePragmaticTopPoint(tabId, frameId, marketTarget.point);
    try {
      await dispatchPragmaticTrustedClick(tabId, marketPoint);
      commitStarted = true;
      committedAmount = committedStake;
      selectedChips.push('default');
    } catch (error) {
      if (error && typeof error === 'object' && error.pressDispatched === true) {
        commitStarted = true;
        return unknownAfterCommit(`trusted-market-click-failed:${betErrorMessage(error)}`, {
          marketPressDispatched: true,
        });
      }
      throw error;
    }
    if (!isLiveBetSessionCurrent(generation)) {
      return unknownAfterCommit('bridge-disconnected-after-market-click');
    }
    const observed = await executePragmaticBetPhase(tabId, frameId, parsed.request, {
      phase: 'observe',
      beforeTotal,
      beforeTotalObserved: prepared.beforeTotalObserved === true,
      expectedTotal: beforeTotal + committedAmount,
      expectedRoundId,
      selectedChips,
      final: true,
    });
    const observedReceipt = pragmaticPhaseReceipt(observed);
    if (observedReceipt) {
      return observedReceipt.status === 'REJECTED'
        ? unknownAfterCommit(`post-submit-rejected:${pragmaticPhaseReason(observedReceipt, 'unexpected-rejection')}`)
        : observedReceipt;
    }
    if (
      !observed
      || observed.phase !== 'observed'
      || observed.runtimeRevision !== PRAGMATIC_BET_RUNTIME_REVISION
    ) return unknownAfterCommit('platform-acknowledgement-invalid');
    return unknownAfterCommit('platform-acknowledgement-missing-final-receipt');
  } catch (error) {
    return commitStarted
      ? unknownAfterCommit(`trusted-submit-failed:${betErrorMessage(error)}`)
      : precommitRejectedBetReceipt(
        parsed.request,
        parsed.requestId,
        `trusted-precommit-failed:${betErrorMessage(error)}`,
        'pragmatic',
      );
  } finally {
    pragmaticBetInputBusy = false;
  }
}

async function executeUniqueLiveBet(message, generation) {
  return executeUniquePragmaticBet(message, generation);
}
async function probePragmaticBetReadiness(tableIds, generation) {
  const requestedTableIds = Array.from(new Set(
    (Array.isArray(tableIds) ? tableIds : [])
      .filter(tableId => typeof tableId === 'string' && PRAGMATIC_TABLE_ID_PATTERN.test(tableId))
      .map(tableId => tableId.toLowerCase()),
  ));
  if (requestedTableIds.length === 0) return;

  const tabs = await chrome.tabs.query({ url: [DAFABET_POPUP_QUERY] });
  if (generation !== activeSocketGeneration) return;
  const targets = tabs.filter(tab => tab.id && exactDafabetPragmaticPopup(tab.url));
  if (targets.length !== 1) {
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: 'allFrames',
      detail: `probeBetReadiness:pragmatic-popup-count=${targets.length}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  for (const tableId of requestedTableIds) {
    let probes;
    let preparationSummary = '';
    try {
      const preparations = await preparePragmaticTable(targets[0].id, tableId);
      preparationSummary = preparations
        .filter(entry => entry && entry.result && entry.result.status !== 'skipped')
        .map(entry => [
          `id=${Number.isInteger(entry.frameId) ? entry.frameId : ''}`,
          `status=${String(entry.result.status || '')}`,
          `round=${String(entry.result.roundId || '')}`,
          `countdown=${Number.isFinite(entry.result.countdown) ? entry.result.countdown : ''}`,
          `tables=${Array.isArray(entry.result.tableIds) ? entry.result.tableIds.join(',') : ''}`,
        ].join(','))
        .join('|');
      if (generation !== activeSocketGeneration) return;
      probes = await chrome.scripting.executeScript({
        target: { tabId: targets[0].id, allFrames: true },
        world: 'MAIN',
        args: [tableId],
        func: globalThis.probePragmaticBetTable,
      });
    } catch (error) {
      send({
        kind: 'sessionAction',
        action: 'command-executed',
        url: '',
        frame: 'allFrames',
        detail: `probeBetReadiness:${tableId}:probe-failed=${betErrorMessage(error)}`,
        timestamp: new Date().toISOString(),
      });
      continue;
    }
    if (generation !== activeSocketGeneration) return;
    const candidates = probes.filter(entry => {
      const result = entry && entry.result;
      return result
        && result.status !== 'not-found'
        && result.tableId === tableId
        && result.runtimeRevision === PRAGMATIC_BET_RUNTIME_REVISION
        && PRAGMATIC_FRAME_HOST_PATTERN.test(String(result.host || ''));
    });
    const selection = selectPragmaticReadyFrame(probes, tableId);
    const result = selection.selected
      ? selection.selected.result
      : candidates.length === 1
        ? candidates[0].result
        : null;
    const markets = result && Array.isArray(result.markets) ? result.markets.join(',') : '';
    const chips = result && Array.isArray(result.supportedChips) ? result.supportedChips.join(',') : '';
    const frameDiagnostics = probes.filter(entry => {
      const frameResult = entry && entry.result;
      return frameResult && (
        PRAGMATIC_FRAME_HOST_PATTERN.test(String(frameResult.host || ''))
        || String(frameResult.runtimeRevision || '').startsWith('pragmatic-bet-runtime/')
      );
    }).map(entry => {
      const frameResult = entry.result || {};
      return [
        `id=${Number.isInteger(entry.frameId) ? entry.frameId : ''}`,
        `status=${String(frameResult.status || '')}`,
        `revision=${String(frameResult.runtimeRevision || '')}`,
        `table=${String(frameResult.tableId || '')}`,
        `authority=${String(frameResult.routingAuthority || '')}`,
        `path=${String(frameResult.framePath || '')}`,
        `round=${String(frameResult.roundId || '')}`,
        `countdown=${Number.isFinite(frameResult.countdown) ? frameResult.countdown : ''}`,
      ].join(',');
    }).join('|');
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: 'allFrames',
      detail: [
        `probeBetReadiness:${tableId}`,
        `candidates=${candidates.length}`,
        `status=${result && typeof result.status === 'string' ? result.status : ''}`,
        `readyCandidates=${selection.ready.length}`,
        `authority=${selection.authority}`,
        `roundId=${result && typeof result.roundId === 'string' ? result.roundId : ''}`,
        `roots=${result && Number.isInteger(result.rootCandidateCount) ? result.rootCandidateCount : ''}`,
        `rootId=${result && typeof result.rootId === 'string' ? result.rootId : ''}`,
        `rootClass=${result && typeof result.rootClass === 'string' ? result.rootClass : ''}`,
        `controls=${result && Array.isArray(result.rootControls)
          ? encodeURIComponent(JSON.stringify(result.rootControls)).slice(0, 2500)
          : ''}`,
        `pageMarkets=${result && Array.isArray(result.pageMarketControls)
          ? encodeURIComponent(JSON.stringify(result.pageMarketControls)).slice(0, 3500)
          : ''}`,
        `pageTimers=${result && Array.isArray(result.pageRoundTimers)
          ? encodeURIComponent(JSON.stringify(result.pageRoundTimers)).slice(0, 9000)
          : ''}`,
        `rootVisible=${result && result.rootVisible === true}`,
        `timer=${result && typeof result.timerTestId === 'string' ? result.timerTestId : ''}`,
        `countdown=${result && Number.isFinite(result.countdown) ? result.countdown : ''}`,
        `markets=${markets}`,
        `chips=${chips}`,
        `marketTargets=${result && result.marketTargets
          ? encodeURIComponent(JSON.stringify(result.marketTargets)).slice(0, 12000)
          : ''}`,
        `chipControls=${result && Array.isArray(result.chipControls)
          ? encodeURIComponent(JSON.stringify(result.chipControls)).slice(0, 10000)
          : ''}`,
        `walletControls=${result && Array.isArray(result.walletControls)
          ? encodeURIComponent(JSON.stringify(result.walletControls)).slice(0, 8000)
          : ''}`,
        `prepare=${preparationSummary}`,
        `frames=${frameDiagnostics}`,
      ].join(':'),
      timestamp: new Date().toISOString(),
    });
  }
}

async function probeLiveBetReadiness(tableIds, generation) {
  const requestedTableIds = Array.isArray(tableIds) ? tableIds : [];
  const pragmaticTableIds = requestedTableIds.filter(
    tableId => typeof tableId === 'string' && PRAGMATIC_TABLE_ID_PATTERN.test(tableId),
  );
  if (pragmaticTableIds.length === 0) {
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
  await probePragmaticBetReadiness(pragmaticTableIds, generation);
}

function handleBetRequest(message, generation) {
  const requestId = message && typeof message.requestId === 'string'
    ? message.requestId
    : '';
  if (requestId && betRequests.has(requestId)) return betRequests.get(requestId);

  const operation = Promise.resolve()
    .then(() => executeUniqueLiveBet(message, generation))
    .then(receipt => {
      if (
        receipt
        && typeof receipt === 'object'
        && receipt.status !== 'UNKNOWN'
        && receipt.raw
        && receipt.raw.commitStarted === true
        && !isLiveBetSessionCurrent(generation)
      ) {
        const receiptTableId = message.request && message.request.intent
          ? message.request.intent.tableId
          : message.request && message.request.wager
            ? message.request.wager.tableId
            : '';
        const platform = 'pragmatic';
        receipt = unknownBetReceipt(
          message.request,
          requestId,
          'bridge-disconnected-after-commit-point',
          platform,
        );
      }
      sendBetResult({ kind: 'betResult', requestId, receipt }, generation);
      return receipt;
    })
    .catch(error => {
      sendBetResult({
        kind: 'betResult',
        requestId,
        receipt: null,
        error: betErrorMessage(error),
      }, generation);
      return null;
  });
  if (requestId) {
    betRequests.set(requestId, operation);
  }
  return operation;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function ensureBridgeReconnectAlarm() {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(BRIDGE_RECONNECT_ALARM, { periodInMinutes: 0.5 });
}

chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm?.name === BRIDGE_RECONNECT_ALARM) void connect();
});

const OUTBOX_LIMIT = 500;
const outbox = [];

function sendBetResult(message, generation) {
  if (
    !socket
    || !isCurrentSocket(socket, generation)
    || socket.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  try {
    socket.send(JSON.stringify(withBridgeSequence(message)));
    return true;
  } catch (_) {
    return false;
  }
}

function send(message) {
  if (message && message.kind === 'betResult') return;
  const sequenced = withBridgeSequence(message);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(sequenced));
    return;
  }
  // 断线/重连窗口内排队,重连后按序补发,避免牌局消息被静默丢弃。
  if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
  outbox.push(sequenced);
}

function withBridgeSequence(message) {
  return {
    ...message,
    bridgeSessionId: BRIDGE_SESSION_ID,
    bridgeSeq: ++bridgeMessageSeq,
  };
}

function flushOutbox() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (outbox.length > 0) {
    const message = outbox.shift();
    if (message && message.kind === 'betResult') continue;
    try {
      socket.send(JSON.stringify(message));
    } catch (_) {
      outbox.unshift(message);
      break;
    }
  }
}

/** 本机桥重连后，要求每个游戏 frame 重放当前已解码的运行时牌面和可见桌台选择。 */
function runtimeProbeError(error) {
  try {
    if (error && typeof error === 'object' && typeof error.message === 'string') {
      return error.message.slice(0, 300);
    }
    return String(error || '').slice(0, 300);
  } catch (_) {
    return 'unknown-error';
  }
}

function sendRuntimeProbe(tabId, frameId, result, fallbackUrl) {
  const frameUrl = result && typeof result.frameUrl === 'string' && result.frameUrl
    ? result.frameUrl
    : String(fallbackUrl || '');
  const payload = {
    tabId,
    frameId: Number.isInteger(frameId) ? frameId : null,
    ...(result && typeof result === 'object' ? result : { hook: 'unknown', replay: 'not-called' }),
  };
  send({
    kind: 'networkCapture',
    source: 'baccarat-bridge-runtime-probe',
    url: frameUrl,
    direction: 'recv',
    encoding: 'text',
    data: JSON.stringify(payload).slice(0, 8000),
  });
}

async function replayRuntimeStateInGameFrames() {
  const tabs = await chrome.tabs.query({});
  let tabCount = 0;
  let frameCount = 0;
  let failureCount = 0;
  for (const tab of tabs) {
    if (!tab.id || !isGameTabUrl(tab.url)) continue;
    tabCount += 1;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: () => {
          const frameUrl = String(location.href || '');
          const host = String(location.hostname || '');
          const replay = globalThis.__baccaratPragmaticReplay;
          let replayState = 'not-called';
          let error = '';
          if (typeof replay === 'function') {
            try {
              replay();
              replayState = 'called';
            } catch (caught) {
              replayState = 'failed';
              error = caught && typeof caught === 'object' && typeof caught.message === 'string'
                ? caught.message.slice(0, 300)
                : String(caught || '').slice(0, 300);
            }
          }
          return {
            frameUrl,
            host,
            hook: typeof replay === 'function' ? 'present' : 'missing',
            replay: replayState,
            pragmaticNetworkHook: globalThis.__baccaratPragmaticNetworkHookInstalled === true,
            webSocketName: typeof globalThis.WebSocket === 'function'
              ? String(globalThis.WebSocket.name || '').slice(0, 80)
              : '',
            ...(error ? { error } : {}),
          };
        },
      });
      for (const entry of results) {
        frameCount += 1;
        sendRuntimeProbe(tab.id, entry.frameId, entry.result, tab.url);
      }
    } catch (error) {
      failureCount += 1;
      sendRuntimeProbe(tab.id, null, {
        frameUrl: String(tab.url || ''),
        hook: 'probe-failed',
        replay: 'not-called',
        error: runtimeProbeError(error),
      }, tab.url);
    }
  }
  return { tabCount, frameCount, failureCount };
}
/** 远程指令:由桥接服务/观察者经 WebSocket 下发,免去打开 SW 控制台。 */
async function handleRemoteCommand(name, tableIds = [], generation) {
  if (generation !== activeSocketGeneration) return;
  if (name === 'startPragmaticNetworkCapture') {
    const tabs = await chrome.tabs.query({ url: [DAFABET_POPUP_QUERY] });
    const targets = tabs.filter(tab => tab.id && exactDafabetPragmaticPopup(tab.url));
    let enabled = false;
    if (targets.length === 1 && await ensureCdpAttached(targets[0].id)) {
      await chrome.debugger.sendCommand({ tabId: targets[0].id }, 'Network.enable', {
        maxTotalBufferSize: 10_000_000,
        maxResourceBufferSize: 2_000_000,
        maxPostDataSize: 0,
      });
      await chrome.debugger.sendCommand({ tabId: targets[0].id }, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [
          { type: 'iframe', exclude: false },
          { type: 'worker', exclude: false },
          { type: 'shared_worker', exclude: false },
          { type: 'service_worker', exclude: false },
        ],
      });
      pragmaticCdpTabs.add(targets[0].id);
      enabled = true;
    }
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: `startPragmaticNetworkCapture:enabled=${enabled}:targets=${targets.length}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (name === 'stopPragmaticNetworkCapture') {
    for (const tabId of pragmaticCdpTabs) {
      pragmaticCdpTabs.delete(tabId);
      for (const key of pragmaticCdpSocketUrls.keys()) {
        if (key.startsWith(`${tabId}:`)) pragmaticCdpSocketUrls.delete(key);
      }
      for (const key of pragmaticCdpSeenResponses) {
        if (key.startsWith(`${tabId}:`)) pragmaticCdpSeenResponses.delete(key);
      }
      for (const key of pragmaticCdpResponseCandidates.keys()) {
        if (key.startsWith(`${tabId}:`)) pragmaticCdpResponseCandidates.delete(key);
      }
      for (const key of pragmaticCdpStreams.keys()) {
        if (key.startsWith(`${tabId}:`)) pragmaticCdpStreams.delete(key);
      }
      try {
        if (cdpAttachedTabId === tabId) {
          await chrome.debugger.detach({ tabId });
          cdpAttachedTabId = null;
        }
      } catch (_) {}
    }
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: 'stopPragmaticNetworkCapture:disabled',
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (name === 'probeExtensionManifest') {
    const manifest = chrome.runtime.getManifest();
    const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
    const pragmaticNetworkRegistered = contentScripts.some(entry =>
      Array.isArray(entry.js) && entry.js.includes('pragmatic-network-hook.js'));
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: `probeExtensionManifest:pragmaticNetwork=${pragmaticNetworkRegistered}:scripts=${contentScripts.length}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }
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
    await chrome.storage.local.set({ reloadGameTabsAfterExtensionReload: true });
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: 'reloadExtension-scheduled',
      timestamp: new Date().toISOString(),
    });
    // 给确认消息留出发送时间，再由扩展自己重载；不依赖 chrome://extensions 页面。
    setTimeout(() => chrome.runtime.reload(), EXTENSION_RELOAD_DELAY_MS);
    return;
  }
  if (name === 'reloadGameTabs') {
    // A frozen feed is a fail-closed boundary. Revoke the execution gate before
    // reloading so a stale page cannot retain authorization across recovery.
    liveBetSessionEnabled = false;
    await chrome.storage.local.set({ liveBetEnabled: false });
    const tabs = await chrome.tabs.query({ url: [DAFABET_POPUP_QUERY] });
    if (generation !== activeSocketGeneration) return;
    let reloaded = 0;
    for (const tab of tabs) {
      if (!tab.id || !exactSupportedBaccaratPopup(tab.url)) continue;
      try {
        await chrome.tabs.reload(tab.id, { bypassCache: true });
        reloaded += 1;
      } catch (_) {
        // A tab may close while recovery is being scheduled.
      }
    }
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: 'allFrames',
      detail: `reloadGameTabs:reloaded=${reloaded}:tables=${tableIds.length}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (name === 'openMultiView') {
    await openActiveGameTabInMultiplay(tableIds);
    return;
  }
  if (name === 'probeBetReadiness') {
    await probeLiveBetReadiness(tableIds, generation);
    return;
  }
  if (name === 'replayRuntimeState') {
    const outcome = await replayRuntimeStateInGameFrames();
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: `replayRuntimeState:tabs=${outcome.tabCount}:frames=${outcome.frameCount}:failures=${outcome.failureCount}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (name === 'calibrate') {
    await chrome.storage.local.set({ cdpCalibrate: true });
    await broadcastToTabs({ kind: 'armCalibration' });
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: 'calibrate-armed',
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (name === 'trustedOn' || name === 'trustedOff') {
    await chrome.storage.local.set({ trustedKeepalive: name === 'trustedOn' });
    await loadFlags();
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: name,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (name === 'calibrateClear') {
    await chrome.storage.local.remove('cdpClickPoint');
    await loadFlags();
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: 'calibrateClear',
      timestamp: new Date().toISOString(),
    });
    return;
  }
}

/**
 * 在当前 Dafabet Pragmatic 弹窗的游戏 iframe 内打开 Pragmatic 多桌路由。
 * 这是一次性的显式远程命令；不会触发下注，也不会写入任何下注开关。
 */
async function openActiveGameTabInMultiplay(tableIds = []) {
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(candidate => candidate.active && exactDafabetPragmaticPopup(candidate.url))
      || tabs.find(candidate => exactDafabetPragmaticPopup(candidate.url))
      || tabs.find(candidate => isGameTabUrl(candidate && candidate.url));
    if (!tab || !tab.id) {
      send({
        kind: 'sessionAction',
        action: 'command-executed',
        url: '',
        frame: '',
        detail: 'openMultiView:no-active-game-tab',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      args: [tableIds],
      func: requestedTableIds => {
        const frameUrl = String(location.href || '');
        if (/(^|\.)client\.pragmaticplaylive\.net$/i.test(location.hostname)) {
          if (location.pathname === '/desktop/multibaccarat/') {
            return { status: 'opened', frameUrl, state: 'pragmatic-already-open' };
          }
          if (location.pathname === '/desktop/baccarat/') {
            // This is Pragmatic's own sibling route. Changing only pathname keeps
            // the authenticated launch query and never touches a betting control.
            location.pathname = '/desktop/multibaccarat/';
            return { status: 'opened', frameUrl, state: 'pragmatic-direct-route' };
          }
          const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
          const roots = [document];
          const controls = [];
          for (let rootIndex = 0; rootIndex < roots.length && rootIndex < 200; rootIndex += 1) {
            const root = roots[rootIndex];
            try {
              controls.push(...root.querySelectorAll('a[href], button, [role="button"]'));
              for (const element of root.querySelectorAll('*')) {
                if (element.shadowRoot) roots.push(element.shadowRoot);
              }
            } catch (_) {}
          }
          const control = controls.find(element => {
            const href = String(element.getAttribute && element.getAttribute('href') || '');
            const text = clean(element.textContent || element.getAttribute?.('aria-label'));
            const exactTarget = /\/desktop\/multibaccarat\//i.test(href)
              || /^(?:多桌|多台|多桌百家乐|multi\s*(?:table|baccarat|play))$/i.test(text);
            if (!exactTarget || element.disabled === true) return false;
            try {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            } catch (_) {
              return true;
            }
          });
          if (control && typeof control.click === 'function') {
            control.click();
            return { status: 'opened', frameUrl, state: 'pragmatic-native-control' };
          }
          return { status: 'not-ready', frameUrl, state: `pragmatic-control-missing:${location.pathname}` };
        }
        return { status: 'skipped', frameUrl };
      },
    });
    const opened = results.filter(result => result && result.result && result.result.status === 'opened').length;
    const states = results
      .map(result => result && result.result && result.result.state ? String(result.result.state) : '')
      .filter(Boolean)
      .join('|')
      .slice(0, 80);
    const detail = opened > 0 ? `openMultiView:opened:${opened}` : `openMultiView:not-ready${states ? `:${states}` : ''}`;
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: 'allFrames',
      detail,
      timestamp: new Date().toISOString(),
    });
  } catch (_) {
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: '',
      detail: 'openMultiView:failed',
      timestamp: new Date().toISOString(),
    });
  }
}
/** 一次性只读诊断当前游戏 frame 的页面导航对象；不读取牌面、不触发输入。 */
async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (_) {
      // 页面未注入 content script 时忽略。
    }
  }
}

// ---- 可选：chrome.debugger 可信输入保活 ----
// 合成 DOM 事件 isTrusted=false，对校验事件可信度的站点无效；
// CDP Input.dispatchMouseEvent 产生 isTrusted=true 的真实输入。
// 需要 manifest 的 "debugger" 权限；首次 attach 时浏览器会显示
// “正在调试”提示条，关闭该提示条会拒绝 attach，此时自动降级为普通保活。

async function ensureCdpAttached(tabId) {
  if (cdpAttachedTabId === tabId) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    cdpAttachedTabId = tabId;
    return true;
  } catch (_) {
    cdpAttachedTabId = null;
    return false;
  }
}

chrome.debugger.onEvent?.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (!Number.isInteger(tabId) || !pragmaticCdpTabs.has(tabId)) return;
  if (method === 'Target.attachedToTarget') {
    const sessionId = params && typeof params.sessionId === 'string' ? params.sessionId : '';
    if (!sessionId) return;
    void chrome.debugger.sendCommand({ tabId, sessionId }, 'Network.enable', {
      maxTotalBufferSize: 10_000_000,
      maxResourceBufferSize: 2_000_000,
      maxPostDataSize: 0,
    }).catch(() => {});
    return;
  }
  const requestId = params && typeof params.requestId === 'string' ? params.requestId : '';
  const sessionId = source && typeof source.sessionId === 'string' ? source.sessionId : 'root';
  const key = `${tabId}:${sessionId}:${requestId}`;
  const debuggee = sessionId === 'root' ? { tabId } : { tabId, sessionId };
  if (method === 'Network.webSocketCreated') {
    const url = params && typeof params.url === 'string' ? params.url : '';
    if (requestId && url) pragmaticCdpSocketUrls.set(key, url);
    send({
      kind: 'networkCapture',
      source: 'baccarat-bridge-pragmatic-cdp-socket',
      url,
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ event: 'created', requestIdLength: requestId.length, childSession: sessionId !== 'root' }),
    });
    return;
  }
  if (method === 'Network.webSocketClosed') {
    const url = pragmaticCdpSocketUrls.get(key) || '';
    pragmaticCdpSocketUrls.delete(key);
    send({
      kind: 'networkCapture',
      source: 'baccarat-bridge-pragmatic-cdp-socket',
      url,
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({ event: 'closed' }),
    });
    return;
  }
  if (method === 'Network.webSocketFrameReceived') {
    const response = params && params.response;
    const payload = response && typeof response.payloadData === 'string' ? response.payloadData : '';
    if (!payload) return;
    send({
      kind: 'networkCapture',
      source: 'baccarat-bridge-pragmatic-cdp-ws',
      url: pragmaticCdpSocketUrls.get(key) || '',
      direction: 'recv',
      encoding: response.opcode === 2 ? 'base64' : 'text',
      data: payload.slice(0, 120000),
    });
    return;
  }
  if (method === 'Network.responseReceived') {
    const response = params && params.response;
    const type = params && typeof params.type === 'string' ? params.type : '';
    if (['Image', 'Media', 'Font', 'Stylesheet', 'Script'].includes(type)) return;
    const url = response && typeof response.url === 'string' ? response.url : '';
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
    const responseKey = `${tabId}:${sessionId}:${type}:${url.split('?')[0]}`;
    if (pragmaticCdpSeenResponses.has(responseKey)) return;
    pragmaticCdpSeenResponses.add(responseKey);
    send({
      kind: 'networkCapture',
      source: 'baccarat-bridge-pragmatic-cdp-response',
      url,
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        type,
        mimeType: response && typeof response.mimeType === 'string' ? response.mimeType.slice(0, 80) : '',
        status: response && Number.isFinite(response.status) ? response.status : 0,
        childSession: sessionId !== 'root',
      }),
    });
    const candidate = ['XHR', 'Fetch', 'EventSource', 'Other'].includes(type)
      && /pragmaticplaylive|vbgames88|zavjcswh\.biz|\.ecs\.[a-z0-9-]+\.on\.aws/i.test(url);
    if (candidate && requestId) {
      pragmaticCdpResponseCandidates.set(key, { url, type });
      void chrome.debugger.sendCommand(debuggee, 'Network.streamResourceContent', { requestId })
        .then(result => {
          pragmaticCdpStreams.set(key, { url, type });
          const buffered = result && typeof result.bufferedData === 'string' ? result.bufferedData : '';
          if (buffered) sendPragmaticCdpBody(url, buffered, true, type, 'buffered');
        })
        .catch(() => {});
    }
    return;
  }
  if (method === 'Network.dataReceived') {
    const stream = pragmaticCdpStreams.get(key);
    const data = params && typeof params.data === 'string' ? params.data : '';
    if (stream && data) sendPragmaticCdpBody(stream.url, data, true, stream.type, 'stream');
    return;
  }
  if (method === 'Network.loadingFinished') {
    const candidate = pragmaticCdpResponseCandidates.get(key);
    pragmaticCdpResponseCandidates.delete(key);
    pragmaticCdpStreams.delete(key);
    if (!candidate || !requestId) return;
    void chrome.debugger.sendCommand(debuggee, 'Network.getResponseBody', { requestId })
      .then(result => {
        const body = result && typeof result.body === 'string' ? result.body : '';
        if (body) sendPragmaticCdpBody(candidate.url, body, result.base64Encoded === true, candidate.type, 'complete');
      })
      .catch(() => {});
    return;
  }
  if (method === 'Network.loadingFailed') {
    pragmaticCdpResponseCandidates.delete(key);
    pragmaticCdpStreams.delete(key);
    return;
  }
  if (method === 'Network.eventSourceMessageReceived') {
    const data = params && typeof params.data === 'string' ? params.data : '';
    if (!data) return;
    send({
      kind: 'networkCapture',
      source: 'baccarat-bridge-pragmatic-cdp-sse',
      url: '',
      direction: 'recv',
      encoding: 'text',
      data: data.slice(0, 120000),
    });
  }
});

function sendPragmaticCdpBody(url, payload, base64Encoded, resourceType, phase) {
  let encoding = base64Encoded ? 'base64' : 'text';
  let data = payload;
  if (base64Encoded) {
    try {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      const sample = text.slice(0, 4000);
      const printable = sample.length > 0
        && Array.from(sample).filter(character => character === '\n'
          || character === '\r'
          || character === '\t'
          || character.charCodeAt(0) >= 32).length / sample.length > 0.9;
      if (printable) {
        encoding = 'text';
        data = text;
      }
    } catch (_) {}
  }
  send({
    kind: 'networkCapture',
    source: 'baccarat-bridge-pragmatic-cdp-body',
    url,
    direction: 'recv',
    encoding,
    data: String(data || '').slice(0, 120000),
    resourceType,
    phase,
  });
}

chrome.debugger.onDetach?.addListener(source => {
  const tabId = source && source.tabId;
  if (!Number.isInteger(tabId)) return;
  pragmaticCdpTabs.delete(tabId);
  if (cdpAttachedTabId === tabId) cdpAttachedTabId = null;
  for (const key of pragmaticCdpSocketUrls.keys()) {
    if (key.startsWith(`${tabId}:`)) pragmaticCdpSocketUrls.delete(key);
  }
  for (const key of pragmaticCdpSeenResponses) {
    if (key.startsWith(`${tabId}:`)) pragmaticCdpSeenResponses.delete(key);
  }
  for (const key of pragmaticCdpResponseCandidates.keys()) {
    if (key.startsWith(`${tabId}:`)) pragmaticCdpResponseCandidates.delete(key);
  }
  for (const key of pragmaticCdpStreams.keys()) {
    if (key.startsWith(`${tabId}:`)) pragmaticCdpStreams.delete(key);
  }
});

/** 向顶层内容脚本询问游戏 iframe 的视口位置(CDP 点击需要页面绝对坐标)。 */
function getIframeRectFromTopFrame(tabId) {
  return new Promise(resolve => {
    let settled = false;
    try {
      chrome.tabs.sendMessage(tabId, { kind: 'getIframeRect' }, response => {
        settled = true;
        void chrome.runtime.lastError; // 无接收者时忽略
        resolve(response && typeof response === 'object' ? response : null);
      });
    } catch (_) {
      resolve(null);
    }
    setTimeout(() => {
      if (!settled) resolve(null);
    }, 1500);
  });
}

async function maybeTrustedActivity(tabId, frameKind, targetInFrame, url, vw, vh) {
  const now = Date.now();
  if (now - lastCdpActivityAt < CDP_MIN_INTERVAL_MS || cdpBusy) return;
  let target = targetInFrame || null;
  if (!target && cdpClickPoint && vw > 50 && vh > 50) {
    // 校准点模式:把用户校准的相对位置换算成当前视口内的点击框。
    target = {
      x: Math.round(cdpClickPoint.xp * vw) - 24,
      y: Math.round(cdpClickPoint.yp * vh) - 24,
      width: 48,
      height: 48,
    };
  }
  if (target && frameKind === 'iframe') {
    // iframe 内元素坐标是相对 iframe 视口的,需叠加 iframe 在顶层页面里的位置。
    const offset = await getIframeRectFromTopFrame(tabId);
    if (!offset) return;
    target = {
      x: offset.x + targetInFrame.x,
      y: offset.y + targetInFrame.y,
      width: targetInFrame.width,
      height: targetInFrame.height,
    };
  }
  cdpBusy = true;
  try {
    if (!(await ensureCdpAttached(tabId))) return;
    const evaluated = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })',
      returnByValue: true,
    });
    const view = JSON.parse(evaluated.result && evaluated.result.value ? evaluated.result.value : '{}');
    const jitterX = Math.max(10, Math.floor((view.w || 800) * 0.5));
    const jitterY = Math.max(10, Math.floor((view.h || 600) * 0.5));
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: jitterX, y: jitterY, button: 'none', pointerType: 'mouse',
    });

    let clicked = false;
    if (target && target.width > 4 && target.height > 4) {
      const cx = Math.round(target.x + target.width / 2);
      const cy = Math.round(target.y + target.height / 2);
      // 该按钮点击一次放大、再点一次缩小，双击恢复原状。
      for (let i = 0; i < 2; i += 1) {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: cx, y: cy, button: 'none', pointerType: 'mouse',
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse',
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse',
        });
        await sleep(400);
      }
      clicked = true;
    }

    lastCdpActivityAt = now;
    lastCdpUrl = url || '';
    send({
      kind: 'sessionAction',
      action: 'trusted-activity',
      url: lastCdpUrl,
      frame: 'top',
      detail: clicked ? 'cdp-double-click' : 'cdp-mousemove',
      timestamp: new Date().toISOString(),
    });
  } catch (_) {
    // debugger 被拒、页面关闭等失败时静默降级，下轮重试。
    try {
      if (cdpAttachedTabId === tabId) {
        await chrome.debugger.detach({ tabId });
        cdpAttachedTabId = null;
      }
    } catch (_e) {
      // ignore
    }
  } finally {
    cdpBusy = false;
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// ---- 保活页（keeper tab）：防浏览器把会话页丢弃 ----

async function getExistingKeeperTab() {
  if (keeperTabId) {
    try {
      const tab = await chrome.tabs.get(keeperTabId);
      if (tab) return tab;
    } catch (_) {
      keeperTabId = null;
    }
  }

  const stored = await chrome.storage.local.get({ keeperTabId: null });
  if (stored.keeperTabId) {
    try {
      const tab = await chrome.tabs.get(stored.keeperTabId);
      if (tab) {
        keeperTabId = tab.id;
        return tab;
      }
    } catch (_) {
      // stored tab no longer exists
    }
  }

  const candidates = await chrome.tabs.query({
    url: ['https://www.dafabet.net/*'],
  });
  const existing = candidates.find(tab => tab.id && tab.pinned && !tab.active)
    || candidates.find(tab => tab.id && !tab.active)
    || candidates[0];
  if (existing?.id) {
    keeperTabId = existing.id;
    await chrome.storage.local.set({ keeperTabId: existing.id });
  }
  return existing || null;
}

async function ensureKeeperTab(url) {
  if (!url || !/dafabet\.net|pragmaticplaylive\.net|vbgames88\.com|zavjcswh\.biz/i.test(url)) return;
  if (keeperCreationPromise) return keeperCreationPromise;

  keeperCreationPromise = (async () => {
    const existing = await getExistingKeeperTab();
    if (existing?.id) {
      try {
        await chrome.tabs.update(existing.id, { autoDiscardable: false, active: false });
      } catch (_) {
        // 部分 Chrome 版本不支持 autoDiscardable 时忽略。
      }
      if (existing.discarded) {
        try {
          await chrome.tabs.reload(existing.id);
        } catch (_) {
          // ignore
        }
      }
      return;
    }

    try {
      const tab = await chrome.tabs.create({ url, active: false, pinned: true });
      keeperTabId = tab.id;
      await chrome.storage.local.set({ keeperTabId: tab.id });
      try {
        await chrome.tabs.update(tab.id, { autoDiscardable: false });
      } catch (_) {
        // 部分 Chrome 版本不支持时忽略。
      }
    } catch (_) {
      // 打不开保活页时忽略。
    }
  })().finally(() => {
    keeperCreationPromise = null;
  });

  return keeperCreationPromise;
}

let lastTabReloadAt = 0;

chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  if (!message || typeof message.kind !== 'string' || !isTrustedGameSender(sender)) return;
  if (!socket || socket.readyState > WebSocket.OPEN) void connect();
  ingestPragmaticProtocolWindow(message);
  notePragmaticOutboundSend(message);
  send(message);
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  if (message.kind === 'keepalive') {
    if (autoKeeperEnabled && message.frame === 'top') {
      void ensureKeeperTab(message.url || '');
    }
    // CDP 可信点击:顶层帧直接用其坐标;iframe 帧的目标坐标由 maybeTrustedActivity 合成。
    if (trustedKeepaliveEnabled && senderTabId && (message.target || cdpClickPoint)) {
      void maybeTrustedActivity(
        senderTabId,
        message.frame === 'iframe' ? 'iframe' : 'top',
        message.target || null,
        message.url || '',
        message.vw || 0,
        message.vh || 0
      );
    }
  }
  if (message.kind === 'calibratePoint' && senderTabId) {
    cdpClickPoint = {
      xp: Math.min(1, Math.max(0, Number(message.xp) || 0)),
      yp: Math.min(1, Math.max(0, Number(message.yp) || 0)),
    };
    void chrome.storage.local.set({ cdpClickPoint });
    send({
      kind: 'sessionAction',
      action: 'calibrated',
      url: message.url || '',
      frame: message.frame || 'iframe',
      detail: 'xp=' + cdpClickPoint.xp + ' yp=' + cdpClickPoint.yp,
      timestamp: new Date().toISOString(),
    });
  }
  if (
    message.kind === 'sessionAction'
    && message.action === 'reload-scheduled'
    && message.frame !== 'top'
    && senderTabId
    && Date.now() - lastTabReloadAt > 20000
  ) {
    // 游戏 iframe 内的自动恢复不自行刷新(会跳去 entry 页),改为刷新整个标签页重新进房。
    lastTabReloadAt = Date.now();
    try {
      void chrome.tabs.reload(senderTabId);
    } catch (_) {
      // ignore
    }
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !isGameTabUrl(tab.url)) return;
  void connect();
  // document_start 的 hook 可能早于 document_idle relay 发出首个状态；
  // load complete 后强制 replay 会清除其去重缓存并重新发出当前四桌快照。
  void replayRuntimeStateInGameFrames();
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === keeperTabId) {
    keeperTabId = null;
    void chrome.storage.local.remove('keeperTabId');
  }
  if (tabId === cdpAttachedTabId) {
    cdpAttachedTabId = null;
  }
});
async function reloadPendingGameTabs() {
  const stored = await chrome.storage.local.get({ reloadGameTabsAfterExtensionReload: false });
  if (!stored.reloadGameTabsAfterExtensionReload) return;

  // 先清标记，防止页面重载或 Service Worker 重启形成循环。
  await chrome.storage.local.remove('reloadGameTabsAfterExtensionReload');
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !isGameTabUrl(tab.url)) continue;
    try {
      await chrome.tabs.reload(tab.id);
      setTimeout(() => { void replayRuntimeStateInGameFrames(); }, 3000);
    } catch (_) {
      // 某个标签页关闭不影响其他游戏页刷新。
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureBridgeReconnectAlarm();
  void loadFlags();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureBridgeReconnectAlarm();
  void loadFlags();
  connect();
});

void loadFlags();
void reloadPendingGameTabs();
ensureBridgeReconnectAlarm();
connect();
