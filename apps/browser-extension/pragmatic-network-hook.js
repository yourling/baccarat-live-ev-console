/**
 * Passive Pragmatic Play transport observer (MAIN world).
 *
 * This hook mirrors received *game protocol* WebSocket frames to the isolated
 * content script and, when a previous real bet send has been observed, can
 * replay a mutated copy of that send for request-path betting.
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
        rememberSocket(socket, url);
        if (!isGameProtocolSocket(url)) return socket;
        socket.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
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
