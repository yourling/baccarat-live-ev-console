/**
 * Pragmatic Play baccarat DOM adapter (isolated world).
 *
 * The client exposes stable semantic attributes for round timers and table
 * IDs. This hook only reads those attributes and never interacts with a bet
 * control. The sole click is the exact session-timeout reconnect button.
 */
(function () {
  if (!/(^|\.)client\.pragmaticplaylive\.net$/i.test(location.hostname)) return;
  const isSingle = location.pathname === '/desktop/baccarat/';
  const isMulti = location.pathname === '/desktop/multibaccarat/';
  const isStateFrame = isSingle || isMulti;

  const SCAN_INTERVAL_MS = 500;
  const HEARTBEAT_INTERVAL_MS = 5000;
  const CONTINUE_RETRY_INTERVAL_MS = 5000;
  const TABLE_PREFIX = 'TileHeight-';
  const SUITS = Object.freeze({ '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' });
  let lastSnapshotHash = '';
  let lastDiscoveryHash = '';
  let lastSentAt = 0;
  let timeoutReported = false;
  let continueClickedAt = 0;
  let continuePending = false;
  let conflictReported = false;
  const lastGameCountByTable = new Map();
  const pendingGameCountByTable = new Map();

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (_) {
      // The extension may be reloading while the game frame remains alive.
    }
  }

  function observedAt() {
    return new Date().toISOString();
  }

  function visible(element) {
    if (!element || element.disabled === true) return false;
    try {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0;
    } catch (_) {
      return false;
    }
  }

  function collectClickables(root, output, depth) {
    try {
      for (const element of root.querySelectorAll('button, [role="button"]')) output.push(element);
      if (depth <= 0) return;
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collectClickables(element.shadowRoot, output, depth - 1);
      }
    } catch (_) {
      // A changing game tree is retried on the next scan.
    }
  }

  function continueGameButton() {
    const clickables = [];
    collectClickables(document, clickables, 4);
    return clickables.find(element => {
      const text = clean(element.textContent);
      return /^(?:继续游戏|continue\s+game)$/i.test(text) && visible(element);
    }) || null;
  }

  function sessionConflictText(text) {
    return /在其他地方启动了(?:对话|会话)|其他地方.*(?:对话|会话)|(?:对话|会话)已在其他|joined from another (?:device|location|place|window|tab)|(?:conversation|session) (?:has been |was )?started (?:elsewhere|in another)|(?:game|session) already open in another/i.test(text);
  }

  function continueNativeIdleSession(now) {
    const bodyText = clean(document.body?.innerText || document.body?.textContent);
    const button = continueGameButton();
    const dialogText = clean(button?.closest?.('[role="dialog"],[role="alertdialog"]')?.textContent || '');
    if (sessionConflictText(bodyText) || sessionConflictText(dialogText)) {
      if (!conflictReported) {
        conflictReported = true;
        send({
          kind: 'sessionAction', action: 'session-conflict-dialog', url: location.href,
          frame: 'iframe',
          detail: (dialogText || bodyText).replace(/\s+/g, ' ').trim().slice(0, 80),
          timestamp: observedAt(),
        });
      }
      return;
    }
    conflictReported = false;
    if (!button) {
      if (continuePending) {
        continuePending = false;
        send({
          kind: 'sessionAction', action: 'native-idle-continue-cleared', url: location.href,
          frame: 'iframe', detail: 'pragmatic-continue-game', timestamp: observedAt(),
        });
      }
      return;
    }
    if (now - continueClickedAt < CONTINUE_RETRY_INTERVAL_MS) return;
    continueClickedAt = now;
    try {
      button.click();
    } catch (_) {
      return;
    }
    continuePending = true;
    send({
      kind: 'sessionAction', action: 'native-idle-continue-click', url: location.href,
      frame: 'iframe', detail: clean(button.textContent).slice(0, 40), timestamp: observedAt(),
    });
  }

  function readTableIdParam(raw) {
    try {
      const tableId = new URL(raw, location.href).searchParams.get('table_id');
      return typeof tableId === 'string' && /^[a-z0-9]{8,32}$/i.test(tableId) ? tableId : '';
    } catch (_) {
      return '';
    }
  }

  function parseSingleTableId() {
    return readTableIdParam(location.href) || readTableIdParam(document.referrer);
  }

  function countdownValue(timer) {
    if (!timer) return undefined;
    const value = Number(clean(timer.textContent));
    return Number.isFinite(value) ? value : undefined;
  }

  function bettingOpenFromTimer(timer) {
    const countdown = countdownValue(timer);
    return countdown !== undefined && countdown >= 1;
  }

  function parseRoundId(root) {
    const text = clean(root.querySelector('[data-testid="game-header-game-id"]')?.textContent)
      || clean(root.textContent);
    return (text.match(/ID:\s*([0-9]+|—)/) || [])[1] || '';
  }

  function parseGameCountText(raw) {
    const match = /#[\s\u00a0]*([1-9]\d{0,2})\b/.exec(clean(raw));
    if (!match) return undefined;
    const value = Number(match[1]);
    return value >= 1 && value <= 150 ? value : undefined;
  }

  function classText(node) {
    return String(node.getAttribute && node.getAttribute('class') || '');
  }

  function isGameCountLabel(value) {
    const text = String(value || '');
    if (/countdown|timer/i.test(text)) return false;
    return String(text).split(/[\s]+/).some(token => {
      const base = token.split('_')[0];
      return /^(?:game-count|gameCount)$/i.test(base);
    });
  }

  function nodeText(node) {
    if (!node) return '';
    if (typeof node.innerText === 'string') return node.innerText;
    return node.textContent || '';
  }

  function isGameCountCandidate(node) {
    if (!node || !node.getAttribute) return false;
    if (node.classList && node.classList.contains('game-count')) return true;
    const testid = node.getAttribute('data-testid') || '';
    return isGameCountLabel(classText(node)) || isGameCountLabel(testid);
  }

  function findGameCountNode(root) {
    if (!root || !root.querySelectorAll) return null;
    const nodes = root.querySelectorAll('.game-count, [class], [data-testid]');
    let fallback = null;
    for (const node of nodes) {
      if (!isGameCountCandidate(node)) continue;
      if (visible(node)) return node;
      if (fallback === null) fallback = node;
    }
    return fallback;
  }

  function parseGameCount(root) {
    if (!root) return undefined;
    const header = root.getAttribute && root.getAttribute('data-testid') === 'game-header'
      ? root
      : root.querySelector && root.querySelector('[data-testid="game-header"]');
    if (header) {
      const headerLabeled = findGameCountNode(header);
      const headerValue = headerLabeled
        ? parseGameCountText(nodeText(headerLabeled))
        : parseGameCountText(nodeText(header));
      if (headerValue !== undefined) return headerValue;
    }
    const labeled = findGameCountNode(root);
    if (labeled && visible(labeled)) {
      return parseGameCountText(nodeText(labeled));
    }
    if (labeled) return parseGameCountText(nodeText(labeled));
    return undefined;
  }

  function isSequentialGameCount(previous, next) {
    return next === previous || (next > previous && next - previous <= 2);
  }

  function isRoadWrapGameCount(previous, next) {
    return previous >= 10 && next >= 1 && next <= 20 && previous - next >= 8;
  }

  function isConfirmedCatchUpGameCount(previous, next) {
    return next > previous && next - previous <= 5;
  }

  function isConfirmedEarlyShoeCorrection(previous, next) {
    return previous <= 8 && next >= 1 && next < previous;
  }

  function stableGameCount(tableId, root) {
    const parsed = parseGameCount(root);
    const previous = lastGameCountByTable.get(tableId);
    if (parsed === undefined) return previous;
    if (previous === undefined || isSequentialGameCount(previous, parsed)) {
      pendingGameCountByTable.delete(tableId);
      lastGameCountByTable.set(tableId, parsed);
      return parsed;
    }
    if (isRoadWrapGameCount(previous, parsed)) {
      pendingGameCountByTable.delete(tableId);
      lastGameCountByTable.set(tableId, parsed);
      return parsed;
    }
    const pending = pendingGameCountByTable.get(tableId);
    if (
      pending === parsed
      && (
        isConfirmedCatchUpGameCount(previous, parsed)
        || isConfirmedEarlyShoeCorrection(previous, parsed)
      )
    ) {
      pendingGameCountByTable.delete(tableId);
      lastGameCountByTable.set(tableId, parsed);
      return parsed;
    }
    pendingGameCountByTable.set(tableId, parsed);
    return previous;
  }

  function parseMinimum(root) {
    const match = clean(root.textContent).match(/[¥￥]\s*([\d,.]+)(?:\s|ID:)/);
    if (!match) return undefined;
    const value = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(value) ? value : undefined;
  }

  function normalizedCardFromSvg(svg) {
    const parts = Array.from(svg.querySelectorAll('text')).map(node => clean(node.textContent));
    const rank = parts.find(value => /^(?:A|[2-9]|10|J|Q|K)$/i.test(value));
    const suitSymbol = parts.find(value => Object.prototype.hasOwnProperty.call(SUITS, value));
    return rank && suitSymbol ? rank.toUpperCase() + SUITS[suitSymbol] : null;
  }

  function cardsIn(root) {
    const cards = [];
    for (const svg of root ? root.querySelectorAll('svg') : []) {
      const card = normalizedCardFromSvg(svg);
      if (card) cards.push(card);
    }
    return cards;
  }

  function singleSnapshot() {
    const tableId = parseSingleTableId();
    if (!tableId) return [];
    const timer = document.querySelector('[data-testid="round-timer"] [data-testid^="timer-countdown-"]');
    const countdown = countdownValue(timer);
    const header = document.querySelector('[data-testid="game-header"]');
    const title = clean(header?.querySelector('button')?.textContent)
      || clean(header?.textContent).replace(/\s*[••].*$/, '');
    const gameCount = stableGameCount(tableId, header || document);
    return [{
      tableId,
      ...(title ? { displayName: title } : {}),
      roundId: parseRoundId(document),
      ...(gameCount === undefined ? {} : { gameCount }),
      bettingOpen: bettingOpenFromTimer(timer),
      ...(countdown === undefined ? {} : { countdown }),
      playerCards: cardsIn(document.getElementById('leftBetTextRoot')),
      bankerCards: cardsIn(document.getElementById('rightBetTextRoot')),
      visible: true,
      source: 'dom',
      ...(parseMinimum(document.querySelector('[data-testid="game-header"]') || document) === undefined
        ? {}
        : { minBet: parseMinimum(document.querySelector('[data-testid="game-header"]') || document) }),
    }];
  }

  function cardFromUse(use) {
    const match = /^#card-(a|[2-9]|10|j|q|k)-(spades|hearts|diamonds|clubs)$/i.exec(
      use.getAttribute('href') || use.getAttribute('xlink:href') || '',
    );
    if (!match) return null;
    const suit = { spades: 'S', hearts: 'H', diamonds: 'D', clubs: 'C' }[match[2].toLowerCase()];
    return match[1].toUpperCase() + suit;
  }

  function multitableCards(tile) {
    function cardsForMarket(code) {
      const target = tile.querySelector(`[data-betcode="${code}"]`);
      const market = target && target.parentElement;
      if (!market) return [];
      return Array.from(market.querySelectorAll('use'))
        .map(cardFromUse)
        .filter(Boolean);
    }
    return {
      playerCards: cardsForMarket('0'),
      bankerCards: cardsForMarket('1'),
    };
  }

  function tableName(tile) {
    for (const node of tile.querySelectorAll('span')) {
      const text = clean(node.textContent);
      if (/百家乐|baccarat/i.test(text)) return text;
    }
    return '';
  }

  function multiSnapshot() {
    return Array.from(document.querySelectorAll(`[id^="${TABLE_PREFIX}"]`)).map(tile => {
      const tableId = tile.id.slice(TABLE_PREFIX.length);
      const style = getComputedStyle(tile);
      const timer = tile.querySelector('[data-testid^="timer-countdown-"]');
      const countdown = countdownValue(timer);
      const hasOpenMarkets = !!tile.querySelector('[data-betcode="0"]')
        && !!tile.querySelector('[data-betcode="1"]');
      const hasCard = !!tile.querySelector('use[href^="#card-"], use[xlink\\:href^="#card-"]');
      const hasDetail = hasOpenMarkets || !!timer || hasCard;
      const visible = hasDetail
        && style.display !== 'none'
        && tile.getBoundingClientRect().width > 0;
      const cards = visible ? multitableCards(tile) : undefined;
      const gameCount = style.display !== 'none' && tile.getBoundingClientRect().width > 0
        ? stableGameCount(tableId, tile)
        : undefined;
      const minBet = parseMinimum(tile);
      return {
        tableId,
        ...(tableName(tile) ? { displayName: tableName(tile) } : {}),
        roundId: parseRoundId(tile),
        ...(gameCount === undefined ? {} : { gameCount }),
        ...(visible ? { bettingOpen: bettingOpenFromTimer(timer) } : {}),
        ...(countdown === undefined ? {} : { countdown }),
        ...(cards === undefined ? {} : {
          playerCards: cards.playerCards,
          bankerCards: cards.bankerCards,
        }),
        visible,
        source: 'dom',
        ...(minBet === undefined ? {} : { minBet }),
      };
    }).filter(table => table.tableId.length > 0);
  }

  function recoverExpiredSession() {
    const bodyText = clean(document.body?.innerText || document.body?.textContent);
    if (sessionConflictText(bodyText)) return;
    const expired = /您的会话已超时|session\s+(?:has\s+)?timed\s*out/i.test(bodyText);
    if (!expired) {
      if (timeoutReported) {
        timeoutReported = false;
        send({
          kind: 'sessionAction', action: 'recovered', url: location.href,
          frame: 'iframe', detail: 'pragmatic-keepalive', timestamp: observedAt(),
        });
      }
      return;
    }
    if (timeoutReported) return;
    timeoutReported = true;
    send({
      kind: 'sessionExpired', url: location.href, frame: 'iframe',
      textLength: bodyText.length, timestamp: observedAt(), recovering: false,
    });
  }

  function scan(force) {
    const now = Date.now();
    continueNativeIdleSession(now);
    recoverExpiredSession();
    if (!isStateFrame) return;
    const tables = isSingle ? singleSnapshot() : multiSnapshot();
    if (tables.length === 0) return;

    const discovery = tables.map(table => ({
      tableId: table.tableId,
      ...(table.displayName ? { displayName: table.displayName } : {}),
      ...(table.roundId && table.roundId !== '—' ? { roundId: table.roundId } : {}),
      ...(table.gameCount === undefined ? {} : { gameCount: table.gameCount }),
    }));
    const discoveryHash = JSON.stringify(discovery);
    if (discoveryHash !== lastDiscoveryHash) {
      lastDiscoveryHash = discoveryHash;
      send({
        kind: 'roomDiscovered',
        room: { roomId: 'dafabet-pragmatic', displayName: 'Dafabet Pragmatic Play', tables: discovery },
      });
    }

    const snapshot = { version: 1, view: isSingle ? 'single' : 'multi', observedAt: observedAt(), tables };
    const stateHash = JSON.stringify({
      version: snapshot.version,
      view: snapshot.view,
      tables: snapshot.tables.map(table => {
        const { countdown, ...rest } = table;
        return rest;
      }),
    });
    if (!force && stateHash === lastSnapshotHash && now - lastSentAt < HEARTBEAT_INTERVAL_MS) return;
    lastSnapshotHash = stateHash;
    lastSentAt = now;
    send({
      kind: 'networkCapture',
      source: 'baccarat-bridge-pragmatic-state',
      url: location.origin + location.pathname,
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify(snapshot),
    });
  }

  globalThis.__baccaratPragmaticReplay = () => scan(true);
  send({
    kind: 'sessionAction', action: 'native-idle-keepalive-armed', url: location.href,
    frame: 'iframe', detail: location.pathname, timestamp: observedAt(),
  });
  scan(true);
  setInterval(() => scan(false), SCAN_INTERVAL_MS);
})();
