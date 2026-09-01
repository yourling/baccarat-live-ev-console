/**
 * Passive Pragmatic Play transport observer (MAIN world).
 *
 * This hook mirrors received *game protocol* WebSocket frames to the isolated
 * content script and, when a previous real bet send has been observed, can
 * replay a mutated copy of that send for request-path betting.
 * It never sends <autoBet>. Multiplay already lets lpbet target any visible
 * tile. Same-frame reconnects must wait for the new game socket to receive
 * before retiring the old one. The official client can keep a dedicated table
 * and multibaccarat open together; do not treat that as a conflict.
 * It does not observe fetch/XHR/Worker/MessageChannel/video sockets.
 */
(function () {
  if (!/(^|\.)(?:pragmaticplaylive\.net|vbgames88\.com|zavjcswh\.biz)$/i.test(location.hostname)) return;
  if (globalThis.__baccaratPragmaticNetworkHookInstalled === true) return;
  globalThis.__baccaratPragmaticNetworkHookInstalled = true;

  const MAX_PENDING_MESSAGES = 64;
  const pending = [];
  let contentReady = false;

  function isGameProtocolSocket(url) {
    const href = String(url || '');
    if (/video|webrtc|mediaserver|mdvuz|hls|mpegts|dash|\.m3u8/i.test(href)) return false;
    return /pragmaticplaylive\.net\/game/i.test(href);
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
  const seenTableIds = new Set();
  let lastBetTemplate = '';
  let lastUid = '';
  let lastGm = 'mtb_desktop';
  let sessionReleased = false;

  function pruneDeadSockets() {
    for (let index = liveSockets.length - 1; index >= 0; index -= 1) {
      const socket = liveSockets[index] && liveSockets[index].socket;
      if (!socket || socket.readyState > 1) liveSockets.splice(index, 1);
    }
  }

  function rememberSocket(socket, url) {
    if (!socket) return;
    pruneDeadSockets();
    const href = String(url || '');
    for (const entry of liveSockets) {
      if (entry.socket === socket) {
        if (href && !entry.url) entry.url = href;
        return;
      }
    }
    liveSockets.push({ socket, url: href });
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('close', pruneDeadSockets);
      socket.addEventListener('error', pruneDeadSockets);
    }
  }

  // Close previous same-frame game sockets only after the new one is actually
  // receiving. Closing on construct kills the live feed; leaving two live
  // sockets in this same multi frame makes that page reconnect by itself.
  function adoptGameSocket(socket, url) {
    if (sessionReleased || !isGameProtocolSocket(url)) return;
    let newest = null;
    for (let index = liveSockets.length - 1; index >= 0; index -= 1) {
      const entry = liveSockets[index];
      if (entry && isGameProtocolSocket(entry.url)) {
        newest = entry;
        break;
      }
    }
    if (!newest || newest.socket !== socket) return;
    for (let index = liveSockets.length - 1; index >= 0; index -= 1) {
      const entry = liveSockets[index];
      if (!entry || entry.socket === socket || !isGameProtocolSocket(entry.url)) continue;
      if (entry.socket && entry.socket.readyState < 2) {
        try { entry.socket.close(); } catch (_) {}
      }
      liveSockets.splice(index, 1);
    }
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

  function isBettableTableId(tableId) {
    return typeof tableId === 'string' && /^[a-z0-9]{8,32}$/i.test(tableId);
  }

  function rememberTableId(value) {
    let tableId = String(value || '').trim();
    if (/^table-/i.test(tableId)) tableId = tableId.slice('table-'.length);
    if (isBettableTableId(tableId)) seenTableIds.add(tableId.toLowerCase());
  }

  function rememberTablesFromJson(value, depth) {
    if (!value || typeof value !== 'object' || depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value) rememberTablesFromJson(item, depth + 1);
      return;
    }
    for (const key of ['table', 'tableId', 'table_id', 'channel']) {
      const raw = value[key];
      if (typeof raw === 'string') rememberTableId(raw);
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') rememberTablesFromJson(nested, depth + 1);
    }
  }

  function rememberTablesFromText(text) {
    if (!text) return;
    for (const match of String(text).matchAll(/\b(?:channel|table|tableId|table_id)="([^"]+)"/gi)) {
      rememberTableId(match[1]);
    }
    try {
      rememberTablesFromJson(JSON.parse(text), 0);
    } catch (_) {}
  }

  function dedicatedBoundTableId() {
    try {
      if (String(location.pathname || '') !== '/desktop/baccarat/') return '';
      const tableId = new URL(document.referrer).searchParams.get('table_id') || '';
      return isBettableTableId(tableId) ? tableId.toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function knownTableIds() {
    const tableIds = new Set(seenTableIds);
    const bound = dedicatedBoundTableId();
    if (bound) tableIds.add(bound);
    return [...tableIds];
  }

  function rememberSession(data) {
    const text = sendText(data);
    if (!text) return;
    rememberTablesFromText(text);
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

  function releaseGameSession() {
    sessionReleased = true;
    for (const entry of liveSockets.slice()) {
      try {
        if (entry && entry.socket && entry.socket.readyState < 2) entry.socket.close();
      } catch (_) {}
    }
    liveSockets.length = 0;
    lastUid = '';
    lastBetTemplate = '';
    return { ok: true };
  }

  function placePragmaticBet(command) {
    if (sessionReleased) return { ok: false, reason: 'session-released' };
    if (!isBettableTableId(command && command.tableId)) {
      return { ok: false, reason: 'invalid-table-id' };
    }
    const tableId = String(command.tableId).toLowerCase();
    const bound = dedicatedBoundTableId();
    if (bound && bound !== tableId) {
      return { ok: false, reason: 'table-not-in-current-session' };
    }
    if (!knownTableIds().includes(tableId)) {
      return { ok: false, reason: 'table-not-in-current-session' };
    }
    const payload = mutateBetTemplate(command);
    if (!payload) return { ok: false, reason: 'bet-template-missing' };
    const socket = pickGameSocket();
    if (!socket) return { ok: false, reason: 'bet-socket-not-open' };
    try {
      socket.send(payload);
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'bet-socket-send-failed' };
    }
  }

  globalThis.__baccaratPragmaticBetChannel = {
    placeBet: placePragmaticBet,
    releaseSession: releaseGameSession,
    hasTemplate() { return lastBetTemplate.length > 0 || lastUid.length > 0; },
    status() {
      const boundTableId = dedicatedBoundTableId();
      return {
        hasUser: Boolean(lastUid || xmlAttr(lastBetTemplate, 'uId')),
        hasSocket: !sessionReleased && Boolean(pickGameSocket()),
        framePath: String(location.pathname || ''),
        gm: lastGm || 'mtb_desktop',
        tableIds: knownTableIds(),
        released: sessionReleased,
        ...(boundTableId ? { boundTableId } : {}),
      };
    },
    templatePreview() { return lastBetTemplate.slice(0, 400); },
  };

  function captureGameSocket(url, value, direction) {
    if (typeof value !== 'string' || !value || value.length > 16_384) return;
    post({
      source: 'baccarat-bridge-pragmatic-ws',
      url: String(url || ''),
      direction: direction === 'send' ? 'send' : 'recv',
      encoding: 'text',
      data: value,
    });
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
    if (sessionReleased) return;
    if (event.data.uId) lastUid = String(event.data.uId);
    if (event.data.gm) lastGm = String(event.data.gm);
    rememberSession(event.data.template);
  });

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    function PragmaticObservedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      try {
        if (sessionReleased && isGameProtocolSocket(url)) {
          try { socket.close(); } catch (_) {}
          return socket;
        }
        rememberSocket(socket, url);
        if (!isGameProtocolSocket(url)) return socket;
        socket.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          adoptGameSocket(socket, url);
          captureGameSocket(url, event.data);
          rememberSession(event.data);
        });
        const originalSend = socket.send.bind(socket);
        socket.send = function (data) {
          if (typeof data === 'string') {
            captureGameSocket(url, data, 'send');
            rememberSession(data);
          }
          rememberSocket(socket, url);
          return originalSend(data);
        };
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
})();
