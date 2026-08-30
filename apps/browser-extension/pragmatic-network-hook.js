/**
 * Passive Pragmatic Play transport observer (MAIN world).
 *
 * This hook mirrors received transport messages to the isolated content script
 * and, when a previous real bet send has been observed, can replay a mutated
 * copy of that send for request-path betting.
 */
(function () {
  if (!/(^|\.)(?:pragmaticplaylive\.net|vbgames88\.com|zavjcswh\.biz)$/i.test(location.hostname)) return;
  if (globalThis.__baccaratPragmaticNetworkHookInstalled === true) return;
  globalThis.__baccaratPragmaticNetworkHookInstalled = true;

  const MAX_PENDING_MESSAGES = 64;
  const pending = [];
  const observedMessageTargets = new WeakSet();
  let contentReady = false;

  function bufferToBase64(buffer, byteOffset, byteLength) {
    const bytes = new Uint8Array(
      buffer,
      Number.isInteger(byteOffset) ? byteOffset : 0,
      Number.isInteger(byteLength) ? byteLength : buffer.byteLength,
    );
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function post(message) {
    if (!contentReady) {
      if (pending.length >= MAX_PENDING_MESSAGES) pending.shift();
      pending.push(message);
      return;
    }
    try {
      window.postMessage(message, '*');
    } catch (_) {
      // The frame may be navigating. The next document installs a fresh hook.
    }
  }

  const liveSockets = [];
  let lastBetTemplate = '';
  let lastUid = '';
  let lastGm = 'mtb_desktop';

  function rememberSocket(socket, url) {
    if (!socket) return;
    const href = String(url || '');
    for (const entry of liveSockets) {
      if (entry.socket === socket) {
        if (href && !entry.url) entry.url = href;
        return;
      }
    }
    liveSockets.push({ socket, url: href });
  }

  function sendText(data) {
    if (typeof data === 'string') return data;
    try {
      if (typeof TextDecoder === 'function') {
        if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
        if (ArrayBuffer.isView(data)) {
          return new TextDecoder().decode(data.buffer, data.byteOffset, data.byteLength);
        }
      }
    } catch (_) {}
    return '';
  }

  function looksLikeBetPayload(text) {
    if (!text || text.length < 8) return false;
    return /bet|betcode|"bc"|stake|amount|amt/i.test(text)
      && /table|game|round|playtype|playType|market/i.test(text);
  }

  function rememberSession(data) {
    const text = sendText(data);
    if (!text) return;
    const uId = xmlAttr(text, 'uId');
    if (uId) lastUid = uId;
    const gm = xmlAttr(text, 'gm');
    if (gm) lastGm = gm;
    if (text.length < 8 || text.length > 8000) return;
    if (!looksLikeBetPayload(text) && !/<lpbet[\s>]/i.test(text)) return;
    lastBetTemplate = text;
  }

  function assignExisting(record, keys, value) {
    if (!record || value === undefined || value === null || value === '') return;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key)) record[key] = value;
    }
  }

  function xmlAttr(text, name) {
    const match = String(text || '').match(new RegExp('\\b' + name + '="([^"]*)"'));
    return match ? match[1] : '';
  }

  function mutateLpBetXml(command) {
    const uId = xmlAttr(lastBetTemplate, 'uId') || lastUid;
    const gm = xmlAttr(lastBetTemplate, 'gm') || lastGm || 'mtb_desktop';
    const tableId = command && command.tableId;
    const gId = command && command.roundId;
    const amount = command && command.amount;
    const code = command && command.code;
    if (!uId || !tableId || !gId || !Number.isFinite(Number(amount)) || code === undefined || code === '') {
      return null;
    }
    const ck = String(Date.now());
    return '<command channel="table-' + tableId + '"><lpbet gm="' + gm
      + '" gId="' + gId + '" uId="' + uId + '" ck="' + ck
      + '" ><bet amt="' + amount + '" bc="' + code + '" ck="' + ck + '"/></lpbet></command>';
  }

  function mutateBetTemplate(command) {
    const xml = mutateLpBetXml(command);
    if (xml) return xml;
    if (!lastBetTemplate) return null;
    let parsed;
    try {
      parsed = JSON.parse(lastBetTemplate);
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const kind = Object.keys(parsed).find(key => /bet|wager/i.test(key));
    if (!kind) return null;
    const record = { ...parsed[kind] };
    if (!record || typeof record !== 'object') return null;
    assignExisting(record, ['table', 'tableId', 'table_id'], command && command.tableId);
    assignExisting(record, ['game', 'gameId', 'id', 'roundId'], command && command.roundId);
    assignExisting(record, ['amount', 'amt', 'value', 'stake'], command && command.amount);
    assignExisting(record, ['bc', 'betcode', 'code', 'betCode'], command && command.code);
    if (Array.isArray(record.bets) && record.bets[0] && typeof record.bets[0] === 'object') {
      const first = { ...record.bets[0] };
      assignExisting(first, ['amount', 'amt', 'value', 'stake'], command && command.amount);
      assignExisting(first, ['bc', 'betcode', 'code', 'betCode'], command && command.code);
      record.bets = [first, ...record.bets.slice(1)];
    }
    return JSON.stringify({ ...parsed, [kind]: record });
  }

  function pickGameSocket() {
    let fallback = null;
    for (let index = liveSockets.length - 1; index >= 0; index -= 1) {
      const entry = liveSockets[index];
      const socket = entry && entry.socket;
      if (!socket || socket.readyState > 1) {
        liveSockets.splice(index, 1);
        continue;
      }
      if (socket.readyState !== 1) continue;
      if (/pragmaticplaylive\.net\/game/i.test(String(entry.url || ''))) return socket;
      if (!fallback) fallback = socket;
    }
    return fallback;
  }

  function placePragmaticBet(command) {
    const payload = mutateBetTemplate(command);
    if (!payload) return { ok: false, reason: 'bet-template-missing' };
    const socket = pickGameSocket();
    if (!socket) return { ok: false, reason: 'bet-socket-not-open' };
    try {
      if (/<lpbet[\s>]/i.test(payload) && command && command.tableId) {
        socket.send('<command channel="table-' + command.tableId + '"><autoBet></autoBet></command>');
      }
      socket.send(payload);
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'bet-socket-send-failed' };
    }
  }

  globalThis.__baccaratPragmaticBetChannel = {
    placeBet: placePragmaticBet,
    hasTemplate() { return lastBetTemplate.length > 0 || lastUid.length > 0; },
    status() {
      return {
        hasUser: Boolean(lastUid || xmlAttr(lastBetTemplate, 'uId')),
        hasSocket: Boolean(pickGameSocket()),
      };
    },
    templatePreview() { return lastBetTemplate.slice(0, 400); },
  };

  function capture(source, url, value, direction) {
    const base = {
      source,
      url: String(url || ''),
      direction: direction === 'send' ? 'send' : 'recv',
    };
    if (typeof value === 'string') {
      if (!value) return;
      post({ ...base, encoding: 'text', data: value });
      return;
    }
    if (value instanceof ArrayBuffer) {
      post({ ...base, encoding: 'base64', data: bufferToBase64(value) });
      return;
    }
    if (ArrayBuffer.isView(value)) {
      post({
        ...base,
        encoding: 'base64',
        data: bufferToBase64(value.buffer, value.byteOffset, value.byteLength),
      });
      return;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob && typeof value.arrayBuffer === 'function') {
      value.arrayBuffer().then(buffer => capture(source, url, buffer)).catch(() => {});
      return;
    }
    if (typeof value === 'object' && value !== null) {
      try {
        const data = JSON.stringify(value);
        if (data && data !== '{}') post({ ...base, encoding: 'text', data });
      } catch (_) {
        // Cyclic structured-clone values are not useful to the JSON parser.
      }
    }
  }

  function observeMessageTarget(target, source, url) {
    if (!target || typeof target.addEventListener !== 'function') return;
    if (observedMessageTargets.has(target)) return;
    observedMessageTargets.add(target);
    try {
      target.addEventListener('message', event => capture(source, url, event.data));
      if (typeof target.start === 'function') target.start();
    } catch (_) {
      // A closing port is no longer a useful state source.
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (!event.data || event.data.source !== 'baccarat-bridge-pragmatic-network-ready') return;
    contentReady = true;
    for (const message of pending.splice(0)) window.postMessage(message, '*');
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (!event.data || event.data.source !== 'baccarat-bridge-pragmatic-restore-bet-template') return;
    if (event.data.uId) lastUid = String(event.data.uId);
    if (event.data.gm) lastGm = String(event.data.gm);
    rememberSession(event.data.template);
  });
  window.addEventListener('message', event => {
    if (event.source === window && event.data && typeof event.data === 'object') {
      const source = event.data.source;
      if (typeof source === 'string' && source.startsWith('baccarat-bridge-')) return;
    }
    for (const port of Array.from(event.ports || [])) {
      observeMessageTarget(port, 'baccarat-bridge-pragmatic-message-port', location.href);
    }
    capture('baccarat-bridge-pragmatic-window', location.href, event.data);
  });

  const OriginalMessageChannel = window.MessageChannel;
  if (typeof OriginalMessageChannel === 'function') {
    function PragmaticObservedMessageChannel() {
      const channel = new OriginalMessageChannel();
      observeMessageTarget(channel.port1, 'baccarat-bridge-pragmatic-message-port', location.href);
      observeMessageTarget(channel.port2, 'baccarat-bridge-pragmatic-message-port', location.href);
      return channel;
    }
    PragmaticObservedMessageChannel.prototype = OriginalMessageChannel.prototype;
    try { Object.setPrototypeOf(PragmaticObservedMessageChannel, OriginalMessageChannel); } catch (_) {}
    window.MessageChannel = PragmaticObservedMessageChannel;
  }

  try {
    observeMessageTarget(
      navigator && navigator.serviceWorker,
      'baccarat-bridge-pragmatic-service-worker',
      location.href,
    );
  } catch (_) {
    // Service workers are unavailable in some embedded contexts.
  }

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    function PragmaticObservedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      try {
        socket.addEventListener('message', event => {
          capture('baccarat-bridge-pragmatic-ws', url, event.data);
          rememberSession(event.data);
        });
        const originalSend = socket.send.bind(socket);
        socket.send = function (data) {
          capture('baccarat-bridge-pragmatic-ws', url, data, 'send');
          rememberSession(data);
          rememberSocket(socket, url);
          return originalSend(data);
        };
        rememberSocket(socket, url);
      } catch (_) {
        // A native socket implementation may reject listener replacement.
      }
      return socket;
    }
    PragmaticObservedWebSocket.prototype = OriginalWebSocket.prototype;
    try { Object.setPrototypeOf(PragmaticObservedWebSocket, OriginalWebSocket); } catch (_) {}
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { PragmaticObservedWebSocket[key] = OriginalWebSocket[key]; } catch (_) {}
    }
    window.WebSocket = PragmaticObservedWebSocket;
  }

  const OriginalWorker = window.Worker;
  if (typeof OriginalWorker === 'function') {
    function PragmaticObservedWorker(url, options) {
      const worker = options === undefined
        ? new OriginalWorker(url)
        : new OriginalWorker(url, options);
      try {
        worker.addEventListener('message', event => {
          capture('baccarat-bridge-pragmatic-worker', url, event.data);
        });
      } catch (_) {
        // A terminating Worker is retried by the next page instance.
      }
      return worker;
    }
    PragmaticObservedWorker.prototype = OriginalWorker.prototype;
    try { Object.setPrototypeOf(PragmaticObservedWorker, OriginalWorker); } catch (_) {}
    window.Worker = PragmaticObservedWorker;
  }

  const OriginalSharedWorker = window.SharedWorker;
  if (typeof OriginalSharedWorker === 'function') {
    function PragmaticObservedSharedWorker(url, options) {
      const worker = options === undefined
        ? new OriginalSharedWorker(url)
        : new OriginalSharedWorker(url, options);
      observeMessageTarget(worker.port, 'baccarat-bridge-pragmatic-shared-worker', url);
      return worker;
    }
    PragmaticObservedSharedWorker.prototype = OriginalSharedWorker.prototype;
    try { Object.setPrototypeOf(PragmaticObservedSharedWorker, OriginalSharedWorker); } catch (_) {}
    window.SharedWorker = PragmaticObservedSharedWorker;
  }

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    function PragmaticObservedEventSource(url, options) {
      const source = options === undefined
        ? new OriginalEventSource(url)
        : new OriginalEventSource(url, options);
      observeMessageTarget(source, 'baccarat-bridge-pragmatic-sse', url);
      return source;
    }
    PragmaticObservedEventSource.prototype = OriginalEventSource.prototype;
    try { Object.setPrototypeOf(PragmaticObservedEventSource, OriginalEventSource); } catch (_) {}
    window.EventSource = PragmaticObservedEventSource;
  }

  const OriginalBroadcastChannel = window.BroadcastChannel;
  if (typeof OriginalBroadcastChannel === 'function') {
    function PragmaticObservedBroadcastChannel(name) {
      const channel = new OriginalBroadcastChannel(name);
      observeMessageTarget(channel, 'baccarat-bridge-pragmatic-broadcast', `broadcast:${String(name)}`);
      return channel;
    }
    PragmaticObservedBroadcastChannel.prototype = OriginalBroadcastChannel.prototype;
    try { Object.setPrototypeOf(PragmaticObservedBroadcastChannel, OriginalBroadcastChannel); } catch (_) {}
    window.BroadcastChannel = PragmaticObservedBroadcastChannel;
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const input = args[0];
      const init = args[1];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const body = init && init.body;
        capture('baccarat-bridge-pragmatic-http', url, body || '', 'send');
        rememberSession(body);
      }
      const promise = originalFetch.apply(this, args);
      promise.then(response => {
        try {
          response.clone().text().then(text => {
            if (text) capture('baccarat-bridge-pragmatic-http', url, text);
          }).catch(() => {});
        } catch (_) {}
      }).catch(() => {});
      return promise;
    };
  }

  const OriginalXhr = window.XMLHttpRequest;
  if (typeof OriginalXhr === 'function') {
    function PragmaticObservedXhr() {
      const xhr = new OriginalXhr();
      const originalOpen = xhr.open;
      xhr.open = function (method, url, ...rest) {
        this.__baccaratPragmaticUrl = String(url || '');
        this.__baccaratPragmaticMethod = String(method || 'GET').toUpperCase();
        return originalOpen.call(this, method, url, ...rest);
      };
      const originalSend = xhr.send;
      xhr.send = function (body) {
        if (this.__baccaratPragmaticMethod === 'POST' || this.__baccaratPragmaticMethod === 'PUT' || this.__baccaratPragmaticMethod === 'PATCH') {
          capture('baccarat-bridge-pragmatic-http', this.__baccaratPragmaticUrl, body || '', 'send');
          rememberSession(body);
        }
        return originalSend.call(this, body);
      };
      xhr.addEventListener('load', function () {
        try {
          if (typeof this.responseText === 'string' && this.responseText) {
            capture('baccarat-bridge-pragmatic-http', this.__baccaratPragmaticUrl, this.responseText);
          }
        } catch (_) {}
      });
      return xhr;
    }
    PragmaticObservedXhr.prototype = OriginalXhr.prototype;
    window.XMLHttpRequest = PragmaticObservedXhr;
  }
})();
