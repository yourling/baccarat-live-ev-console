/**
 * Passive Big Gaming transport observer (MAIN world).
 * Mirrors decoded game/hall/bet protocol from binary /data sockets.
 */
(function () {
  function isBgPage() {
    try {
      const host = String(location.hostname || '');
      const path = String(location.pathname || '');
      const href = String(location.href || '');
      if (/(^|\.)pragmaticplaylive\.net$/i.test(host)) return false;
      if (/(^|\.)dafabet\.net$/i.test(host)) {
        const normalized = path.replace(/^\/[a-z-]+/i, '').replace(/\/+$/, '');
        if (normalized === '/live-dealer/popup-launch/live-baccarat-bg') return true;
      }
      if (/(^|\.)vbgames88\.com$/i.test(host) && /bg~~|\/portals\/bg/i.test(href)) return true;
      if (/(^|\.)jbz029\.com$/i.test(host)) return true;
      if (/\/h5V01\//i.test(path)) return true;
      if (/[?&#]table=([A-Za-z]\d{2})/i.test(href)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  if (!isBgPage()) return;
  if (globalThis.__baccaratBgNetworkHookInstalled === true) return;
  globalThis.__baccaratBgNetworkHookInstalled = true;

  const MAX_PENDING = 64;
  const pending = [];
  let contentReady = false;

  function isVideoSocket(url) {
    return /video|webrtc|mediaserver|hls|mpegts|dash|\.m3u8/i.test(String(url || ''));
  }

  function markHook() {
    try {
      const session = globalThis.BaccaratBgProtocol && globalThis.BaccaratBgProtocol.session;
      if (session) session.hook = 1;
    } catch (_) {}
  }
  markHook();

  function post(message) {
    if (!contentReady) {
      if (pending.length >= MAX_PENDING) pending.shift();
      pending.push(message);
      return;
    }
    try { window.postMessage(message, '*'); } catch (_) {}
  }

  function emitTables(url, tables) {
    if (!tables || tables.length === 0) return;
    const observedAt = new Date().toISOString();
    const href = String(url || location.href);
    const MAX = 60000;
    const postBatch = batch => {
      if (batch.length === 0) return;
      post({
        kind: 'networkCapture',
        source: 'baccarat-bridge-bg-state',
        url: href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({
          version: 1,
          view: batch.length > 1 ? 'multi' : 'single',
          observedAt: observedAt,
          tables: batch,
        }),
      });
    };
    let batch = [];
    const flush = () => {
      postBatch(batch);
      batch = [];
    };
    const keepTogether = tables.some(table => table && table.source === 'hall');
    for (let i = 0; i < tables.length; i += 1) {
      const table = tables[i];
      const shuffle = Boolean(table && table.shuffleEvent);
      if (shuffle && batch.length > 0) flush();
      batch.push(table);
      const encoded = JSON.stringify(batch);
      if (!keepTogether && !shuffle && encoded.length > MAX && batch.length > 1) {
        batch.pop();
        flush();
        batch.push(table);
      }
      if (shuffle) flush();
    }
    flush();
  }

  function toBuffer(data) {
    if (!data) return null;
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return null;
  }

  function ingest(socket, url, data, direction) {
    const proto = globalThis.BaccaratBgProtocol;
    if (!proto || !data) return;
    const run = buffer => {
      if (!buffer) return;
      try {
        markHook();
        const tables = proto.ingestBuffer(buffer, direction, socket);
        if (direction === 'recv') emitTables(url, tables);
      } catch (_) {}
    };
    const buffer = toBuffer(data);
    if (buffer) {
      run(buffer);
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then(run).catch(() => {});
    }
  }

  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket !== 'function') return;

  function WrappedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
    if (!isVideoSocket(url)) {
      try { socket.binaryType = 'arraybuffer'; } catch (_) {}
    }
    return socket;
  }
  WrappedWebSocket.prototype = OriginalWebSocket.prototype;
  WrappedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  WrappedWebSocket.OPEN = OriginalWebSocket.OPEN;
  WrappedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  WrappedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  const originalSend = OriginalWebSocket.prototype.send;
  OriginalWebSocket.prototype.send = function send(data) {
    if (!isVideoSocket(this && this.url)) ingest(this, this && this.url, data, 'send');
    return originalSend.call(this, data);
  };

  const onmessageDesc = Object.getOwnPropertyDescriptor(OriginalWebSocket.prototype, 'onmessage');
  if (onmessageDesc && onmessageDesc.set && onmessageDesc.get) {
    Object.defineProperty(OriginalWebSocket.prototype, 'onmessage', {
      configurable: true,
      enumerable: onmessageDesc.enumerable !== false,
      get: onmessageDesc.get,
      set: function setOnMessage(fn) {
        const socket = this;
        const href = String(socket && socket.url || '');
        onmessageDesc.set.call(socket, function onBgMessage(event) {
          if (!isVideoSocket(href)) ingest(socket, href, event && event.data, 'recv');
          if (typeof fn === 'function') return fn.call(socket, event);
        });
      },
    });
  }

  globalThis.WebSocket = WrappedWebSocket;

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data && event.data.kind === 'baccarat-bg-content-ready') {
      contentReady = true;
      while (pending.length > 0) post(pending.shift());
    }
  });
})();
