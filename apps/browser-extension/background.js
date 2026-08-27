/**
 * Service Worker：维护到本机 EV 中控台桥接服务的 WebSocket 连接，
 * 转发 content script 与桥接服务之间的消息，并提供可选的可信输入保活
 * （chrome.debugger / CDP，由 storage.trustedKeepalive 控制）。
 */

const DEFAULT_BRIDGE_TOKEN = 'd63a1a9d927e268d5b3d0ac2450836c0fa90de2e55398ccb73ae888ecf35d97b';
const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:17890/?token=${DEFAULT_BRIDGE_TOKEN}`;
const CDP_MIN_INTERVAL_MS = 60 * 1000;
const EXTENSION_RELOAD_DELAY_MS = 1000;
const DAFABET_BACCARAT_POPUP_URL = 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-pa';
const GAME_TAB_URL_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:dafabet\.(?:net|com)|df888evo\.com|egcvi\.com|mstrom-uno\.com|673ing\.com)(?::\d+)?(?:[/?#]|$)/i;
const MSTROM_FRAME_HOST_PATTERN = /(^|\.)(?:mstrom-uno|673ing)\.com$/i;
const betRequests = new Map();
let liveBetSessionEnabled = false;
const BRIDGE_SESSION_ID = [
  'bridge',
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 12),
].join('-');
let bridgeMessageSeq = 0;

if (typeof importScripts === 'function') {
  importScripts('mstrom-bet-runtime.js');
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

async function loadFlags() {
  const stored = await chrome.storage.local.get({
    bridgeUrl: DEFAULT_BRIDGE_URL,
    autoKeeper: false,
    trustedKeepalive: false,
    cdpClickPoint: null,
  });
  autoKeeperEnabled = !!stored.autoKeeper;
  trustedKeepaliveEnabled = !!stored.trustedKeepalive;
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

function exactDafabetBaccaratPopup(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` === DAFABET_BACCARAT_POPUP_URL;
  } catch (_) {
    return false;
  }
}

function betErrorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message.slice(0, 500);
  }
  return String(error || 'unknown live bet error').slice(0, 500);
}

function unknownBetReceipt(request, requestId, reason) {
  const wager = request && request.wager ? request.wager : null;
  if (wager && typeof wager === 'object') {
    const tableId = typeof wager.tableId === 'string' ? wager.tableId : '';
    const handId = typeof wager.handId === 'string' ? wager.handId : '';
    return {
      receiptId: `mstrom-bridge-operational-unknown-${requestId}-${Date.now()}`,
      wagerId: typeof wager.wagerId === 'string' ? wager.wagerId : '',
      tableId,
      shoeId: typeof wager.shoeId === 'string' ? wager.shoeId : '',
      handId,
      market: wager.market,
      amount: wager.amount,
      source: wager.source,
      status: 'UNKNOWN',
      externalRef: `mstrom:${tableId}:${handId}`,
      createdAt: new Date().toISOString(),
      raw: {
        reason,
        commitPoint: 'confirmBet',
        commitStarted: true,
        tableId,
        handId,
      },
    };
  }
  const intent = request && request.intent ? request.intent : {};
  const tableId = typeof intent.tableId === 'string' ? intent.tableId : '';
  const handId = typeof intent.handId === 'string' ? intent.handId : '';
  return {
    receiptId: `mstrom-bridge-unknown-${requestId}-${Date.now()}`,
    intentId: String(intent.intentId || ''),
    reservationId: String(request && request.reservationId || ''),
    status: 'UNKNOWN',
    amount: intent.amount,
    market: intent.market,
    mode: 'live',
    externalRef: `mstrom:${tableId}:${handId}`,
    createdAt: new Date().toISOString(),
    raw: {
      reason,
      commitPoint: 'confirmBet',
      commitStarted: true,
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
    throw new Error('only live bet requests can enter the Dafabet executor');
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
  if (typeof tableId !== 'string' || !/^[A-Z]\d{3}$/.test(tableId)) {
    throw new Error('invalid Dafabet table id');
  }
  return { requestId: message.requestId, request, tableId };
}

async function executeUniqueMstromBet(message, generation) {
  const parsed = validateLiveBetMessage(message);
  assertLiveBetSession(generation);

  const tabs = await chrome.tabs.query({
    url: [`${DAFABET_BACCARAT_POPUP_URL}*`],
  });
  assertLiveBetSession(generation);
  const targets = tabs.filter(tab => tab.id && exactDafabetBaccaratPopup(tab.url));
  if (targets.length !== 1) {
    throw new Error(`expected exactly one Dafabet baccarat popup tab, found ${targets.length}`);
  }
  const tabId = targets[0].id;

  assertLiveBetSession(generation);
  const probes = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    args: [parsed.tableId],
    func: globalThis.probeMstromBetStore,
  });
  assertLiveBetSession(generation);
  const candidates = probes.filter(entry => {
    const result = entry && entry.result;
    return result
      && (result.status === 'ready' || result.ownsTargetStore === true)
      && result.tableId === parsed.tableId
      && MSTROM_FRAME_HOST_PATTERN.test(String(result.host || ''));
  });
  if (candidates.length !== 1 || !Number.isInteger(candidates[0].frameId)) {
    throw new Error(`expected exactly one matching frame for ${parsed.tableId}, found ${candidates.length}`);
  }

  const frameId = candidates[0].frameId;
  assertLiveBetSession(generation);
  let executions;
  try {
    executions = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      args: [parsed.request],
      func: globalThis.executeMstromBetOneShot,
    });
  } catch (error) {
    return unknownBetReceipt(
      parsed.request,
      parsed.requestId,
      `final-execute-failed:${betErrorMessage(error)}`,
    );
  }
  if (!isLiveBetSessionCurrent(generation)) {
    return unknownBetReceipt(
      parsed.request,
      parsed.requestId,
      'bridge-disconnected-after-final-execute',
    );
  }
  const receipt = executions.length === 1 ? executions[0].result : null;
  if (!receipt || typeof receipt !== 'object') {
    return unknownBetReceipt(
      parsed.request,
      parsed.requestId,
      'final-execute-returned-no-receipt',
    );
  }
  return receipt;
}

async function probeMstromBetReadiness(tableIds, generation) {
  const requestedTableIds = Array.from(new Set(
    (Array.isArray(tableIds) ? tableIds : [])
      .filter(tableId => typeof tableId === 'string' && /^[A-Z]\d{3}$/.test(tableId)),
  ));
  if (requestedTableIds.length === 0) {
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

  const tabs = await chrome.tabs.query({
    url: [`${DAFABET_BACCARAT_POPUP_URL}*`],
  });
  if (generation !== activeSocketGeneration) return;
  const targets = tabs.filter(tab => tab.id && exactDafabetBaccaratPopup(tab.url));
  if (targets.length !== 1) {
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: 'allFrames',
      detail: `probeBetReadiness:popup-count=${targets.length}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  for (const tableId of requestedTableIds) {
    let probes;
    try {
      probes = await chrome.scripting.executeScript({
        target: { tabId: targets[0].id, allFrames: true },
        world: 'MAIN',
        args: [tableId],
        func: globalThis.probeMstromBetStore,
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
        && (result.status === 'ready' || result.ownsTargetStore === true)
        && result.tableId === tableId
        && MSTROM_FRAME_HOST_PATTERN.test(String(result.host || ''));
    });
    const result = candidates.length === 1 ? candidates[0].result : null;
    send({
      kind: 'sessionAction',
      action: 'command-executed',
      url: '',
      frame: 'allFrames',
      detail: [
        `probeBetReadiness:${tableId}`,
        `candidates=${candidates.length}`,
        `betEnabled=${result && result.betEnabled === true}`,
        `gmcode=${result && typeof result.gmcode === 'string' ? result.gmcode : ''}`,
        `addChip=${result && result.hasAddChip === true}`,
        `confirm=${result && result.hasConfirm === true}`,
        `calculateDiff=${result && result.hasCalculateDiff === true}`,
      ].join(':'),
      timestamp: new Date().toISOString(),
    });
  }
}

function handleBetRequest(message, generation) {
  const requestId = message && typeof message.requestId === 'string'
    ? message.requestId
    : '';
  if (requestId && betRequests.has(requestId)) return betRequests.get(requestId);

  const operation = executeUniqueMstromBet(message, generation)
    .then(receipt => {
      if (
        receipt
        && typeof receipt === 'object'
        && receipt.status !== 'UNKNOWN'
        && receipt.raw
        && receipt.raw.commitPoint === 'confirmBet'
        && !isLiveBetSessionCurrent(generation)
      ) {
        receipt = unknownBetReceipt(
          message.request,
          requestId,
          'bridge-disconnected-after-commit-point',
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
    const injected = await injectRuntimeProbe(tab.id);
    if (!injected) {
      failureCount += 1;
      sendRuntimeProbe(tab.id, null, {
        frameUrl: String(tab.url || ''),
        hook: 'injection-failed',
        replay: 'not-called',
      }, tab.url);
      continue;
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: () => {
          const frameUrl = String(location.href || '');
          const host = String(location.hostname || '');
          const replay = globalThis.__baccaratRuntimeStateHookReplay;
          const diagnostic = globalThis.__baccaratRuntimeStateHookDiagnostics;
          let replayState = 'not-called';
          let error = '';
          let diagnostics = null;
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
          if (typeof diagnostic === 'function') {
            try {
              diagnostics = diagnostic();
            } catch (caught) {
              error = error || (caught && typeof caught === 'object' && typeof caught.message === 'string'
                ? caught.message.slice(0, 300)
                : String(caught || '').slice(0, 300));
            }
          }
          return {
            frameUrl,
            host,
            hook: typeof replay === 'function' ? 'present' : 'missing',
            replay: replayState,
            ...(error ? { error } : {}),
            ...(diagnostics === null ? {} : { diagnostics }),
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
  if (name === 'openMultiView') {
    await openActiveGameTabInMultiplay(tableIds);
    return;
  }
  if (name === 'probeBetReadiness') {
    await probeMstromBetReadiness(tableIds, generation);
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
 * 在当前活动游戏标签的 mstrom iframe 内调用客户端自己的“多台”导航入口。
 * 这是一次性的显式远程命令；不会触发下注，也不会写入任何下注开关。
 */
async function openActiveGameTabInMultiplay(tableIds = []) {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    const tab = tabs.find(candidate => {
      const url = String(candidate && candidate.url ? candidate.url : '');
      return /popup-launch\/live-baccarat/i.test(url);
    }) || tabs.find(candidate => isGameTabUrl(candidate && candidate.url));
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
        if (!/(^|\.)(?:mstrom-uno|673ing)\.com$/i.test(location.hostname)) {
          return { status: 'skipped', frameUrl };
        }
        try {
          const page = globalThis;
          const sdk = page.MicroSDK;
          const plaza = page.Plaza || (sdk && sdk.Plaza);
          const createInstance = sdk && sdk.Utils && sdk.Utils.createInstance;
          const MultiplayStore = plaza && plaza.MultiplayStore;
          const configuredTableIds = Array.isArray(requestedTableIds)
            ? requestedTableIds
              .filter(value => typeof value === 'string' && /^[A-Z]\d{3}$/.test(value))
              .slice(0, 4)
            : [];
          const videoGameCore = page.VideoGameCore;
          const gameLinkStore = videoGameCore
            && videoGameCore.GameLinkStore
            && videoGameCore.GameLinkStore.instance;
          const plazaSdk = sdk && sdk.Plaza;
          const rootPageStore = plazaSdk && typeof plazaSdk.getRootPageStore === 'function'
            ? plazaSdk.getRootPageStore()
            : plazaSdk && plazaSdk.RootPageStore && plazaSdk.RootPageStore.instance;
          const gameLink = videoGameCore && videoGameCore.GAME_LINK;
          if (
            configuredTableIds.length > 1
            && gameLinkStore
            && typeof gameLinkStore.changeTable === 'function'
          ) {
            configuredTableIds.forEach((tableId, index) => gameLinkStore.changeTable(tableId, index));
            if (typeof gameLinkStore.connectSocket === 'function') {
              gameLinkStore.connectSocket();
              if (rootPageStore && typeof rootPageStore.changeGame === 'function' && typeof gameLink === 'string' && gameLink) {
                rootPageStore.changeGame(gameLink);
              }
              return {
                status: 'opened',
                frameUrl,
                state: 'configured-game-link',
                configuredCount: configuredTableIds.length,
              };
            }
          }
          if (typeof createInstance === 'function' && MultiplayStore) {
            const store = createInstance(MultiplayStore);
            if (store && typeof store.openMultiplayPage === 'function') {
              store.openMultiplayPage({ fromEntry: 'MultiTab' });
              return { status: 'opened', frameUrl, state: 'store' };
            }
          }

          // PC builds expose the left-side “多台” path as a RootPageStore module transition.
          // GAME_LINK is the casino's own multi-table module; this only changes the displayed game mode.
          if (rootPageStore && typeof rootPageStore.changeGame === 'function' && typeof gameLink === 'string' && gameLink) {
            rootPageStore.changeGame(gameLink);
            return { status: 'opened', frameUrl, state: 'root-change-game' };
          }

          // PageNavigator retains the live GameBac page even when its module-private Plaza symbol
          // is not exported to window. Calling its explicitly named multitable handler is equivalent
          // to one click on the page's “多台” button and cannot execute a bet.
          const navigator = page.Core && page.Core.pageNavigator;
          const topPage = navigator && typeof navigator.getTopPage === 'function'
            ? navigator.getTopPage()
            : null;
          const topPageClass = topPage && page.egret && typeof page.egret.getQualifiedClassName === 'function'
            ? page.egret.getQualifiedClassName(topPage)
            : '';
          if (/^GameBac\./.test(topPageClass) && typeof topPage.onMultiplayButtonTap === 'function') {
            topPage.onMultiplayButtonTap();
            return { status: 'opened', frameUrl, state: 'navigator-handler' };
          }

          // 某些站点版本把 Plaza.MultiplayStore 保留在 GameBac 的模块闭包中，
          // 不再暴露为 window 属性；此时只调用舞台上真实“多台”按钮的同一处理器。
          // 处理器源码必须明确包含 openMultiplayPage，避免误触任何下注控件。
          const stage = page.egret && page.egret.MainContext && page.egret.MainContext.instance
            ? page.egret.MainContext.instance.stage
            : null;
          const queue = stage ? [stage] : [];
          const visited = new Set();
          let handlerOwner = null;
          while (queue.length > 0 && visited.size < 4000) {
            const node = queue.shift();
            if (!node || visited.has(node)) continue;
            visited.add(node);
            // `multiplayButton` is the exact named UI component wired by GameBac to the “多台” action.
            // The handler is invoked once, never coordinates or generic pointer input.
            if (node.multiplayButton && typeof node.onMultiplayButtonTap === 'function') {
              handlerOwner = node;
              break;
            }
            try {
              const childNodes = ['$_children', '$children', 'children', '_children']
                .flatMap(key => Array.isArray(node[key]) ? node[key] : []);
              if (childNodes.length > 0) {
                for (const child of childNodes) queue.push(child);
                continue;
              }
              const childCount = Number(node.numChildren);
              if (Number.isInteger(childCount) && childCount > 0 && typeof node.getChildAt === 'function') {
                for (let index = 0; index < childCount; index += 1) queue.push(node.getChildAt(index));
              }
            } catch (_) {
              // A transient Egret display child must not prevent a later frame from being inspected.
            }
          }
          if (handlerOwner) {
            handlerOwner.onMultiplayButtonTap();
            return { status: 'opened', frameUrl, state: 'stage-handler' };
          }
          return {
            status: 'not-ready',
            frameUrl,
            state: `sdk=${!!sdk};plaza=${!!plaza};store=${!!MultiplayStore};factory=${typeof createInstance};stage=${!!stage}`,
          };
        } catch (_) {
          return { status: 'failed', frameUrl };
        }
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
    url: ['https://www.dafabet.net/*', 'https://evoad.df888evo.com/*'],
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
  if (!url || !/dafabet\.net|evoad\.df888evo\.com|frontend\/evo|evolution|evo/i.test(url)) return;
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

async function injectRuntimeProbe(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['runtime-state-hook.js'],
      world: 'MAIN',
    });
    return true;
  } catch (_) {
    // Chrome 内部页、已关闭标签或未授予 scripting 权限时忽略。
    return false;
  }
}

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
  void loadFlags();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  void loadFlags();
  connect();
});

void loadFlags();
void reloadPendingGameTabs();
connect();
