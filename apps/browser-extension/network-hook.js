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
