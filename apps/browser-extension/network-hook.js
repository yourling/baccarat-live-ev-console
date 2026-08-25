/**
 * MAIN world hook：拦截 Evolution / Dafabet 页面里的 WebSocket、fetch、XHR、EventSource，
 * 把网络数据（含二进制消息）通过 window.postMessage 发给 content script。
 */
(function () {
  const ORIGINAL_WEBSOCKET = window.WebSocket;
  const sockets = new Set();
  // 每个 socket 的发送历史:内容 -> 次数。用于自学习式心跳重放。
  const sendHistory = new WeakMap();
  const MAX_HISTORY_ENTRIES = 24;
  // 观察到过 PING/PONG 心跳协议的 socket:只有这些才注入新鲜 PING。
  const liveSockets = new WeakSet();
  let lastFreshPingAt = 0;

  function recordSend(ws, raw) {
    let history = sendHistory.get(ws);
    if (!history) {
      history = new Map();
      sendHistory.set(ws, history);
    }
    if (!history.has(raw) && history.size >= MAX_HISTORY_ENTRIES) {
      // 淘汰次数最少的旧条目,避免无限增长。
      let lowestKey = null;
      let lowestCount = Infinity;
      for (const [key, count] of history) {
        if (count < lowestCount) {
          lowestKey = key;
          lowestCount = count;
        }
      }
      if (lowestKey !== null) history.delete(lowestKey);
    }
    history.set(raw, (history.get(raw) || 0) + 1);
  }

  /**
   * 挑选要重放的帧:
   * 1. 显式心跳类消息(ping/pong/keepalive/heartbeat 字样);
   * 2. 同一内容重复发送 >= 3 次的小帧(周期性心跳的特征),
   *    并排除任何疑似下注/操作的帧,绝不重放下注指令。
   */
  function pickReplayFrame(ws) {
    const history = sendHistory.get(ws);
    if (!history || history.size === 0) return undefined;
    for (const [raw] of history) {
      if (/ping|pong|keepalive|heartbeat/i.test(raw)) return raw;
    }
    let best = undefined;
    let bestCount = 0;
    for (const [raw, count] of history) {
      if (raw.length > 512) continue;
      if (/bet|wager|place|chip|amount|stake|withdraw|deposit/i.test(raw)) continue;
      if (count > bestCount) {
        best = raw;
        bestCount = count;
      }
    }
    return bestCount >= 3 ? best : undefined;
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function describeData(data) {
    if (typeof data === 'string') {
      return { encoding: 'text', raw: data };
    }
    if (data instanceof ArrayBuffer) {
      return { encoding: 'base64', raw: bufferToBase64(data) };
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return { encoding: 'blob', raw: '[blob]' };
    }
    return { encoding: 'unknown', raw: '' };
  }

  function wrapWebSocket() {
    if (!ORIGINAL_WEBSOCKET) return;
    function PatchedWebSocket(url, protocols) {
      const ws = protocols === undefined
        ? new ORIGINAL_WEBSOCKET(url)
        : new ORIGINAL_WEBSOCKET(url, protocols);
      const socketUrl = String(url);
      try {
        ws.__bridgeUrl = socketUrl;
        sockets.add(ws);
        ws.addEventListener('close', () => {
          sockets.delete(ws);
          // 上报断开,让 content script/桥接服务感知“静默掉线”。
          try {
            window.postMessage({ source: 'baccarat-bridge-ws-closed', url: socketUrl }, '*');
          } catch (_) {
            // ignore
          }
        });
      } catch (_) {
        // ignore
      }

      try {
        ws.addEventListener('message', event => {
          const described = describeData(event.data);
          if (!described.raw) return;
          if (described.encoding === 'text' && described.raw.indexOf('eventType') !== -1) {
            liveSockets.add(ws);
          }
          window.postMessage({
            source: 'baccarat-bridge-ws',
            url: socketUrl,
            direction: 'recv',
            encoding: described.encoding,
            data: described.raw,
          }, '*');
          if (described.encoding === 'blob' && event.data && typeof event.data.arrayBuffer === 'function') {
            event.data.arrayBuffer().then(buffer => {
              window.postMessage({
                source: 'baccarat-bridge-ws',
                url: socketUrl,
                direction: 'recv',
                encoding: 'base64',
                data: bufferToBase64(buffer),
              }, '*');
            }).catch(() => {});
          }
        });
      } catch (_) {
        // ignore
      }

      return ws;
    }
    PatchedWebSocket.prototype = ORIGINAL_WEBSOCKET.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try {
        PatchedWebSocket[key] = ORIGINAL_WEBSOCKET[key];
      } catch (_) {
        // ignore
      }
    }

    // 在 prototype 上捕获所有 send，更可靠（实例赋值在部分浏览器不可写）。
    if (ORIGINAL_WEBSOCKET.prototype && typeof ORIGINAL_WEBSOCKET.prototype.send === 'function') {
      const originalProtoSend = ORIGINAL_WEBSOCKET.prototype.send;
      ORIGINAL_WEBSOCKET.prototype.send = function (data) {
        const described = describeData(data);
        if (described.raw) {
          window.postMessage({
            source: 'baccarat-bridge-ws',
            url: this.__bridgeUrl || '',
            direction: 'send',
            encoding: described.encoding,
            data: described.raw,
          }, '*');
          try {
            recordSend(this, described.raw);
          } catch (_) {
            // ignore
          }
        }
        return originalProtoSend.call(this, data);
      };
    }

    // ⚠️ 已停用:向游戏 socket 重放心跳/注入 PING 均被服务端判定异常。
    // 本监听器仅保留观测用途,绝不向游戏 socket 发送任何消息。
    window.addEventListener('message', event => {
      if (!event.data || event.data.source !== 'baccarat-bridge-keepalive') return;
    });

    window.WebSocket = PatchedWebSocket;
  }

  function wrapFetch() {
    const originalFetch = window.fetch;
    if (!originalFetch) return;
    window.fetch = async function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        const text = await clone.text();
        if (text && /evoad\.df888evo\.com|evolution|evo/i.test(String(url))) {
          window.postMessage({
            source: 'baccarat-bridge-fetch',
            url: String(url),
            direction: 'recv',
            encoding: 'text',
            data: text,
          }, '*');
        }
      } catch (_) {
        // ignore
      }
      return response;
    };
  }

  function wrapXhr() {
    const OriginalXHR = window.XMLHttpRequest;
    if (!OriginalXHR) return;
    function PatchedXHR() {
      const xhr = new OriginalXHR();
      const originalOpen = xhr.open;
      const originalSend = xhr.send;
      xhr.open = function (method, url, ...rest) {
        this.__bridgeUrl = url;
        return originalOpen.call(this, method, url, ...rest);
      };
      xhr.send = function (...args) {
        this.addEventListener('load', function () {
          try {
            const url = String(this.__bridgeUrl || '');
            const text = this.responseText || '';
            if (text && /evoad\.df888evo\.com|evolution|evo/i.test(url)) {
              window.postMessage({
                source: 'baccarat-bridge-xhr',
                url,
                direction: 'recv',
                encoding: 'text',
                data: text,
              }, '*');
            }
          } catch (_) {
            // ignore
          }
        });
        return originalSend.apply(this, args);
      };
      return xhr;
    }
    PatchedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
  }

  function wrapEventSource() {
    const OriginalEventSource = window.EventSource;
    if (!OriginalEventSource) return;
    window.EventSource = function (url, options) {
      const es = new OriginalEventSource(url, options);
      try {
        es.addEventListener('message', event => {
          const data = event.data;
          if (typeof data === 'string' && data) {
            window.postMessage({
              source: 'baccarat-bridge-sse',
              url: String(url),
              direction: 'recv',
              encoding: 'text',
              data,
            }, '*');
          }
        });
      } catch (_) {
        // ignore
      }
      return es;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  function wrapCryptoDecrypt() {
    if (!window.crypto || !window.crypto.subtle) return;
    const subtle = window.crypto.subtle;
    const proto = Object.getPrototypeOf(subtle);
    if (!proto || typeof proto.decrypt !== 'function') return;

    const originalDecrypt = proto.decrypt;
    proto.decrypt = async function (...args) {
      const result = await originalDecrypt.apply(this, args);
      try {
        const text = new TextDecoder().decode(result);
        if (text) {
          window.postMessage({
            source: 'baccarat-bridge-decrypt',
            url: 'crypto.subtle.decrypt',
            direction: 'recv',
            encoding: 'text',
            data: text,
          }, '*');
        }
      } catch (_) {
        // ignore
      }
      return result;
    };
  }

  function wrapJsonParse() {
    const originalParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const value = originalParse.call(this, text, reviver);
      try {
        if (
          typeof text === 'string'
          && /card|hand|result|baccarat|player|banker|shoe|bet|game/i.test(text)
          && text.length < 200000
        ) {
          window.postMessage({
            source: 'baccarat-bridge-jsonparse',
            url: 'json.parse',
            direction: 'recv',
            encoding: 'text',
            data: text,
          }, '*');
        }
      } catch (_) {
        // ignore
      }
      return value;
    };
  }

  /**
   * ⚠️ 已停用(函数保留仅供复盘):注入合成 PING 被服务端判定异常并注销会话。
   * 向确认过 PING/PONG 协议的游戏 socket 注入全新鲜的 PING。
   * EVO 客户端的心跳定时器可能与用户活动挂钩:长时间不操作就停止 PING,
   * 服务端随即判会话过期(EV.7)。我们用独立定时器持续发新鲜 PING 补位:
   * requestId 每次重新生成(陈旧 PING 会被服务端忽略),纯保活、不下注。
   */
  function sendFreshPings() {
    const now = Date.now();
    if (now - lastFreshPingAt < 20 * 1000) return;
    lastFreshPingAt = now;
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // 游戏数据通道直接注入(客户端可能早已停发 PING,不能等观察到再学);
      // 其他 socket 需先观察到 PING/PONG 协议才注入。
      const sockUrl = String(ws.__bridgeUrl || '');
      if (sockUrl.indexOf('/player/game/') === -1 && !liveSockets.has(ws)) continue;
      const ping = JSON.stringify({
        eventType: 'PING',
        requestId: Math.floor(Math.random() * 9e15) + Math.pow(10, 14),
        requestTimestamp: now,
      });
      try {
        ws.send(ping);
      } catch (_) {
        // ignore
      }
    }
  }

  // ⚠️ 已停用:向游戏 socket 注入合成 PING 的实验被服务端判定为异常
  // (触发「你已注销」+ 收银台内部错误)。不要再启用任何协议消息注入。
  wrapWebSocket();
  wrapFetch();
  wrapXhr();
  wrapEventSource();
  wrapCryptoDecrypt();
  wrapJsonParse();
})();

// ---- 通道清查探针(2026-08-22 追加;纯只读观测,零注入)----
// 目标:回答「渲染牌面的数据从哪个通道来」。清查:Worker、WebRTC、
// 全量 HTTP 元数据(含图片资源)、crypto.subtle 全家桶。不改变任何原有行为。
(function () {
  function post(source, payload) {
    try {
      window.postMessage({
        source,
        url: location.href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify(payload).slice(0, 12000),
      }, '*');
    } catch (_) {
      // ignore
    }
  }

  // 1) Worker / SharedWorker:MAIN world 的 WS 钩子管不到 Worker 内部。
  //    不注入 Worker、不发送消息；仅被动观察 Worker 返回给页面的已解码消息。
  function workerBytesToBase64(bytes) {
    let binary = '';
    const limit = Math.min(bytes.length, 4096);
    for (let index = 0; index < limit; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(limit, index + 0x8000)));
    }
    return btoa(binary);
  }

  function workerPayloadSummary(value) {
    if (typeof value === 'string') {
      const relevant = /card|poke|round|hand|game|result|road|shoe|player|banker|table|vid|gmcode|bac/i.test(value);
      return relevant
        ? { kind: 'text', text: value.slice(0, 7000), truncated: value.length > 7000, relevant: true }
        : { kind: 'text', length: value.length, relevant: false };
    }
    if (value instanceof ArrayBuffer) {
      const bytes = new Uint8Array(value);
      return { kind: 'binary', byteLength: bytes.length, base64: workerBytesToBase64(bytes), truncated: bytes.length > 4096, relevant: true };
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { kind: 'binary', byteLength: bytes.length, base64: workerBytesToBase64(bytes), truncated: bytes.length > 4096, relevant: true };
    }
    if (!value || typeof value !== 'object') return { kind: typeof value, value: String(value), relevant: false };

    const keys = Object.keys(value).slice(0, 40);
    const typeHint = [value.type, value.event, value.action, value.kind].filter(Boolean).join('|');
    const relevant = /card|poke|round|hand|game|result|road|shoe|player|banker|table|vid|gmcode|bac/i.test(keys.join('|') + '|' + typeHint);
    if (!relevant) return { kind: 'object', keys, relevant: false };

    try {
      const seen = new WeakSet();
      const json = JSON.stringify(value, (key, nested) => {
        if (/^(key|secret|token|authorization|password|cookie)$/i.test(key)) return '[redacted]';
        if (nested instanceof ArrayBuffer) {
          const bytes = new Uint8Array(nested);
          return { kind: 'binary', byteLength: bytes.length, base64: workerBytesToBase64(bytes), truncated: bytes.length > 4096 };
        }
        if (ArrayBuffer.isView(nested)) {
          const bytes = new Uint8Array(nested.buffer, nested.byteOffset, nested.byteLength);
          return { kind: 'binary', byteLength: bytes.length, base64: workerBytesToBase64(bytes), truncated: bytes.length > 4096 };
        }
        if (typeof nested === 'bigint') return String(nested);
        if (nested && typeof nested === 'object') {
          if (seen.has(nested)) return '[circular]';
          seen.add(nested);
        }
        return nested;
      });
      return { kind: 'json', keys, json: String(json || '').slice(0, 7000), truncated: String(json || '').length > 7000, relevant: true };
    } catch (_) {
      return { kind: 'object', keys, serialization: 'failed', relevant: true };
    }
  }

  function observeWorkerMessages(worker, url, kind) {
    const observedShapes = new Set();
    const capture = (direction, value) => {
      const payload = workerPayloadSummary(value);
      // Blob Workers use frequent check:<timestamp> heartbeats. They are neither
      // state nor protocol data and would otherwise drown out actual cards.
      if (payload.kind === 'text' && payload.relevant === false) return;
      // Outbound binary data can contain transport/auth material; only inspect
      // Worker-to-page binary responses, never Worker input frames.
      if (direction === 'send' && payload.kind === 'binary') return;
      const shape = payload.relevant === false
        ? [direction, payload.kind, Array.isArray(payload.keys) ? payload.keys.join('|') : ''].join(':')
        : '';
      if (shape) {
        if (observedShapes.has(shape)) return;
        observedShapes.add(shape);
      }
      post('baccarat-bridge-worker-message', {
        kind,
        direction,
        url: String(url).slice(0, 300),
        payload,
      });
    };
    try {
      worker.addEventListener('message', event => capture('recv', event.data));
      if (typeof worker.postMessage === 'function') {
        const originalPostMessage = worker.postMessage;
        worker.postMessage = function (data, ...args) {
          capture('send', data);
          return originalPostMessage.call(this, data, ...args);
        };
      }
    } catch (_) {
      // Worker may be terminating while the page navigates.
    }
  }

  try {
    const OW = window.Worker;
    if (typeof OW === 'function') {
      function PatchedWorker(url, opts) {
        post('baccarat-bridge-worker', { kind: 'worker', url: String(url).slice(0, 300) });
        const worker = opts === undefined ? new OW(url) : new OW(url, opts);
        observeWorkerMessages(worker, url, 'worker');
        return worker;
      }
      PatchedWorker.prototype = OW.prototype;
      window.Worker = PatchedWorker;
    }
  } catch (_) {}
  try {
    const OSW = window.SharedWorker;
    if (typeof OSW === 'function') {
      function PatchedSharedWorker(url, opts) {
        post('baccarat-bridge-worker', { kind: 'sharedworker', url: String(url).slice(0, 300) });
        const worker = opts === undefined ? new OSW(url) : new OSW(url, opts);
        if (worker.port) observeWorkerMessages(worker.port, url, 'sharedworker');
        return worker;
      }
      PatchedSharedWorker.prototype = OSW.prototype;
      window.SharedWorker = PatchedSharedWorker;
    }
  } catch (_) {}

  // 2) WebRTC:直播视频常走 WebRTC;数据通道也可能夹带游戏状态。
  try {
    const ORTC = window.RTCPeerConnection;
    if (typeof ORTC === 'function') {
      function PatchedRTC(cfg, cfg2) {
        const pc = new ORTC(cfg, cfg2);
        post('baccarat-bridge-rtc', { kind: 'peerconnection' });
        try {
          if (typeof pc.createDataChannel === 'function') {
            const oc = pc.createDataChannel.bind(pc);
            pc.createDataChannel = function (label, o) {
              post('baccarat-bridge-rtc', { kind: 'datachannel', label: String(label) });
              return oc(label, o);
            };
          }
          ['createOffer', 'createAnswer'].forEach(k => {
            const om = pc[k] && pc[k].bind(pc);
            if (om) pc[k] = function (...a) { post('baccarat-bridge-rtc', { kind: k }); return om(...a); };
          });
        } catch (_) {}
        return pc;
      }
      PatchedRTC.prototype = ORTC.prototype;
      window.RTCPeerConnection = PatchedRTC;
    }
  } catch (_) {}

  // 3) 全量 HTTP 元数据:原 fetch/XHR 钩子只转发 evo 域,这里补齐所有端点的
  //    url+大小;URL 或响应体命中牌类关键字的,附带响应体(截断)。
  //    牌面贴图的 URL 文件名本身就是候选「数据通道」。
  try {
    const ofetch = window.fetch;
    if (typeof ofetch === 'function') {
      window.fetch = async function (...args) {
        const res = await ofetch.apply(this, args);
        try {
          const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          if (u && !/^data:/i.test(u) && !/\.(png|jpg|jpeg|webp|gif|svg|woff2?)(\?|$)/i.test(u)) {
            const hit = /card|poke|\/pai|road|bead|history|round|result|deal|shoe/i.test(u);
            let body;
            if (hit) {
              try { const t = await res.clone().text(); if (t && t.length < 40000) body = t; } catch (_) {}
            }
            post('baccarat-bridge-httpmeta', { u: String(u).slice(0, 400), len: Number(res.headers.get('content-length') || 0), st: res.status, body });
          }
        } catch (_) {}
        return res;
      };
    }
  } catch (_) {}

  // 4) 资源时间线兜底:每 5s 上报新增资源 URL(含图片,fetch 钩子看不到的也能看到)。
  try {
    let seen = new Set();
    setInterval(() => {
      try {
        const entries = performance.getEntriesByType('resource');
        const fresh = [];
        for (const e of entries) {
          if (seen.has(e.name)) continue;
          seen.add(e.name);
          if (/card|poke|\/pai|road|bead|\.png|\.webp|\.jpg/i.test(e.name)) fresh.push({ u: e.name.slice(0, 300), len: e.transferSize });
        }
        if (seen.size > 20000) seen = new Set();
        if (fresh.length) post('baccarat-bridge-perfmeta', { items: fresh.slice(0, 40) });
      } catch (_) {}
    }, 5000);
  } catch (_) {}

  // 5) crypto.subtle 扩展:decrypt 二进制输出转 base64(原钩子只收文本)、
  //    importKey/deriveBits 只记录算法元数据(绝不记录密钥材料)。
  try {
    if (window.crypto && window.crypto.subtle) {
      const subtle = window.crypto.subtle;
      const proto = Object.getPrototypeOf(subtle);
      const od = proto.decrypt;
      if (typeof od === 'function') {
        proto.decrypt = async function (...a) {
          const out = await od.apply(this, a);
          try {
            if (out instanceof ArrayBuffer) {
              const bytes = new Uint8Array(out);
              let printable = bytes.length > 0 && bytes.length < 8192;
              for (let i = 0; i < Math.min(bytes.length, 64); i++) { const c = bytes[i]; if (c !== 9 && c !== 10 && c !== 13 && (c < 32 || c > 126)) { printable = false; break; } }
              if (printable) post('baccarat-bridge-decrypt2', { algo: a[0] && a[0].name, text: new TextDecoder().decode(out) });
              else if (bytes.length > 0) {
                let bin = ''; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                post('baccarat-bridge-decrypt2', { algo: a[0] && a[0].name, b64: btoa(bin).slice(0, 8000), n: bytes.length });
              }
            }
          } catch (_) {}
          return out;
        };
      }
      const oi = proto.importKey;
      if (typeof oi === 'function') {
        proto.importKey = function (fmt, key, algo, ...rest) { post('baccarat-bridge-keymeta', { fmt: String(fmt), algo: algo && algo.name }); return oi.call(this, fmt, key, algo, ...rest); };
      }
    }
  } catch (_) {}
})();
