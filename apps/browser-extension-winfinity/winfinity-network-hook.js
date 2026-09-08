/**
 * Passive Winfinity transport observer (MAIN world).
 * Mirrors JSON game WebSocket text frames. No bet send path.
 */
(function () {
  function hostnameEndsWith(host, suffix) {
    const name = String(host || '').toLowerCase();
    const needle = String(suffix || '').toLowerCase();
    return name === needle || name.endsWith('.' + needle);
  }

  function isSentryHost(host) {
    return hostnameEndsWith(host, 'skt.youngpoisson.xyz');
  }

  function isWinfinityPage() {
    try {
      const host = String(location.hostname || '');
      const path = String(location.pathname || '');
      if (isSentryHost(host)) return false;
      if (hostnameEndsWith(host, 'youngpoisson.xyz')) return true;
      if (hostnameEndsWith(host, 'dafabet.net')) {
        const normalized = path.replace(/^\/[a-z-]+/i, '').replace(/\/+$/, '');
        return normalized === '/live-dealer/popup-launch/tao-yuan-baccarat';
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  if (!isWinfinityPage()) return;
  if (globalThis.__baccaratWinfinityNetworkHookInstalled === true) return;
  globalThis.__baccaratWinfinityNetworkHookInstalled = true;

  const MAX_PENDING = 64;
  const pending = [];
  let contentReady = false;

  function isIgnoredSocket(url) {
    const href = String(url || '');
    if (/video|webrtc|mediaserver|hls|mpegts|dash|\.m3u8/i.test(href)) return true;
    try {
      const host = new URL(href, location.href).hostname;
      if (isSentryHost(host)) return true;
    } catch (_) {}
    return false;
  }

  function post(message) {
    if (!contentReady) {
      if (pending.length >= MAX_PENDING) pending.shift();
      pending.push(message);
      return;
    }
    try { window.postMessage(message, '*'); } catch (_) {}
  }

  function captureRecv(data) {
    if (typeof data !== 'string' || !data) return;
    const isGameFrame = typeof globalThis.isWinfinityGameFrame === 'function'
      ? globalThis.isWinfinityGameFrame(data)
      : false;
    if (!isGameFrame) return;
    post({
      kind: 'networkCapture',
      source: 'baccarat-bridge-winfinity-ws',
      url: location.href,
      direction: 'recv',
      encoding: 'text',
      data,
    });
  }

  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket !== 'function') return;

  function WrappedWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new OriginalWebSocket(url)
      : new OriginalWebSocket(url, protocols);
    if (isIgnoredSocket(url)) return socket;
    try {
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        captureRecv(event.data);
      });
    } catch (_) {}
    return socket;
  }
  WrappedWebSocket.prototype = OriginalWebSocket.prototype;
  try { Object.setPrototypeOf(WrappedWebSocket, OriginalWebSocket); } catch (_) {}
  WrappedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  WrappedWebSocket.OPEN = OriginalWebSocket.OPEN;
  WrappedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  WrappedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  globalThis.WebSocket = WrappedWebSocket;

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data && event.data.kind === 'baccarat-winfinity-content-ready') {
      contentReady = true;
      while (pending.length > 0) post(pending.shift());
    }
  });
})();
