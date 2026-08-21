/**
 * Service Worker：维护到本机 EV 中控台桥接服务的 WebSocket 连接，
 * 转发 content script 与桥接服务之间的消息，并提供可选的可信输入保活
 * （chrome.debugger / CDP，由 storage.trustedKeepalive 控制）。
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:17890';
const CDP_MIN_INTERVAL_MS = 60 * 1000;
let socket = null;
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
  return stored.bridgeUrl || DEFAULT_BRIDGE_URL;
}

async function connect() {
  const url = await getBridgeUrl();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    reconnectDelay = 1000;
    flushOutbox();
    send({
      kind: 'hello',
      extensionVersion: chrome.runtime.getManifest().version,
      browser: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });
  });

  socket.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (!message) return;
    if (message.kind === 'betRequest') {
      broadcastToTabs({
        kind: 'executeBet',
        requestId: message.requestId,
        request: message.request,
      });
    }
    if (message.kind === 'command') {
      void handleRemoteCommand(String(message.name || ''));
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch (_) {
      // ignore
    }
  });
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

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return;
  }
  // 断线/重连窗口内排队,重连后按序补发,避免牌局消息被静默丢弃。
  if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
  outbox.push(message);
}

function flushOutbox() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (outbox.length > 0) {
    const message = outbox.shift();
    try {
      socket.send(JSON.stringify(message));
    } catch (_) {
      outbox.unshift(message);
      break;
    }
  }
}

/** 远程指令:由桥接服务/观察者经 WebSocket 下发,免去打开 SW 控制台。 */
async function handleRemoteCommand(name) {
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
  if (!message || typeof message.kind !== 'string') return;
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

chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === keeperTabId) {
    keeperTabId = null;
    void chrome.storage.local.remove('keeperTabId');
  }
  if (tabId === cdpAttachedTabId) {
    cdpAttachedTabId = null;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void loadFlags();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  void loadFlags();
  connect();
});

void loadFlags();
connect();
