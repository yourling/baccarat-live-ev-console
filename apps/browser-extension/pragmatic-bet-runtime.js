if (typeof chrome === 'undefined' || !chrome || !chrome.scripting) {
  // The page world intentionally receives no persistent bet runtime exports.
} else {
function probePragmaticBetTable(tableId, targetMarket) {
  const RUNTIME_REVISION = 'pragmatic-bet-runtime/2026-08-30.21';
  const MIN_REMAINING_SECONDS = 1;
  const MARKET_CODES = Object.freeze({ player: '0', banker: '1', playerPair: '3', bankerPair: '4' });

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function visible(element) {
    if (!element || element.disabled === true) return false;
    try {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return true;
    }
  }
  function referrerTableId() {
    try {
      return new URL(document.referrer).searchParams.get('table_id') || '';
    } catch (_) {
      return '';
    }
  }
  function sharedMarketControls() {
    const controls = {};
    for (const [market, code] of Object.entries(MARKET_CODES)) {
      const candidates = Array.from(document.querySelectorAll(`[data-betcode="${code}"]`))
        .filter(element => visible(element) && !element.closest?.('[id^="TileHeight-"]'));
      if (candidates.length === 1) controls[market] = candidates[0];
    }
    return controls;
  }
  function preparedLease(targetTableId) {
    const prepared = globalThis.__baccaratPragmaticPreparedTable;
    if (!(
      location.pathname === '/desktop/multibaccarat/'
      && prepared
      && prepared.tableId === targetTableId
      && Number.isFinite(prepared.preparedAt)
      && Date.now() - prepared.preparedAt <= 5000
      && typeof prepared.roundId === 'string'
      && Number.isFinite(prepared.countdown)
      && Number.isFinite(prepared.countdownAt)
    )) return null;
    const liveControls = sharedMarketControls();
    const storedConnected = prepared.marketControls
      && Object.values(prepared.marketControls).every(element => element && element.isConnected !== false);
    const marketControls = ['player', 'banker', 'playerPair', 'bankerPair'].every(market => liveControls[market])
      ? liveControls
      : storedConnected ? prepared.marketControls : null;
    return marketControls ? { ...prepared, marketControls } : null;
  }
  function tableRoots(targetTableId) {
    if (typeof targetTableId !== 'string' || !/^[a-z0-9]{8,32}$/i.test(targetTableId)) return null;
    if (location.pathname === '/desktop/baccarat/' && referrerTableId() === targetTableId) return [document];
    const roots = [];
    const exact = document.getElementById(`TileHeight-${targetTableId}`);
    if (exact) roots.push(exact);
    const selectors = [
      `[data-table-id="${targetTableId}"]`,
      `[data-tableid="${targetTableId}"]`,
      `[data-table="${targetTableId}"]`,
      `[data-game-table-id="${targetTableId}"]`,
      `[id*="${targetTableId}"]`,
    ];
    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        if (!roots.includes(candidate)) roots.push(candidate);
      }
    }
    const score = root => Number(root === exact) * 100
      + Number(!!root.querySelector('[data-betcode="0"], [data-betcode="1"]')) * 10
      + Number(!!root.querySelector('[data-testid^="timer-countdown-"]')) * 5
      + Number(visible(root));
    return roots.sort((left, right) => score(right) - score(left));
  }
  function tableRoot(targetTableId) {
    return tableRoots(targetTableId)?.[0] || null;
  }
  function roundId(root) {
    const header = root.querySelector([
      '[data-testid="game-header-game-id"]',
      '[data-testid*="game-id"]',
      '[data-testid*="round-id"]',
      '[data-game-id]',
      '[data-round-id]',
    ].join(', '));
    if (header) {
      const identity = [
        header.getAttribute?.('data-game-id'),
        header.getAttribute?.('data-round-id'),
        header.textContent,
      ].map(clean).join(' ');
      const headerMatch = identity.match(/(?:ID|局号|游戏编号|牌局)\s*[:：#]?\s*(\d{8,20})/i)
        || identity.match(/\b(\d{8,20})\b/);
      if (headerMatch) return headerMatch[1];
    }
    const text = clean(root.textContent);
    return (text.match(/(?:ID|局号|游戏编号|牌局)\s*[:：#]?\s*(\d{8,20})/i) || [])[1] || '';
  }
  function countdownTimer(root) {
    return root === document
      ? root.querySelector('[data-testid="round-timer"] [data-testid^="timer-countdown-"]')
      : root?.querySelector('[data-testid^="timer-countdown-"]');
  }
  function remainingSeconds(root, targetTableId) {
    const prepared = preparedLease(targetTableId);
    if (prepared) {
      return Math.floor(prepared.countdown - Math.max(0, Date.now() - prepared.countdownAt) / 1000);
    }
    return Number(clean(countdownTimer(root)?.textContent));
  }
  function isOpen(root, targetTableId) {
    const prepared = preparedLease(targetTableId);
    const remaining = remainingSeconds(root, targetTableId);
    const targetWasVisibleWhenPrepared = location.pathname === '/desktop/multibaccarat/' && !!prepared;
    return (targetWasVisibleWhenPrepared || visible(root))
      && Number.isFinite(remaining)
      && remaining >= MIN_REMAINING_SECONDS;
  }
  function marketTarget(root, market) {
    const prepared = preparedLease(tableId);
    if (location.pathname === '/desktop/multibaccarat/' && prepared) {
      const target = prepared.marketControls[market];
      return visible(target) ? target : null;
    }
    if (root !== document || location.pathname === '/desktop/multibaccarat/') {
      const code = MARKET_CODES[market];
      if (code === undefined) return null;
      return Array.from(root.querySelectorAll(`[data-betcode="${code}"]`)).find(visible) || null;
    }
    if (market === 'player') return document.getElementById('leftBetTextRoot');
    if (market === 'banker') return document.getElementById('rightBetTextRoot');
    const label = market === 'playerPair' ? '闲家对子' : market === 'bankerPair' ? '庄家对子' : '';
    if (!label) return null;
    return Array.from(document.querySelectorAll('*')).find(
      node => node.children.length === 0 && clean(node.textContent) === label,
    ) || null;
  }
  function chipAvailable(amount) {
    return Array.from(document.querySelectorAll(`[data-testid="chip-stack-value-${amount}"]`)).some(visible);
  }
  function describeElement(element) {
    if (!element) return null;
    let rect = null;
    let hit = null;
    try {
      const value = element.getBoundingClientRect();
      rect = {
        x: Math.round(value.x),
        y: Math.round(value.y),
        width: Math.round(value.width),
        height: Math.round(value.height),
      };
      if (typeof document.elementFromPoint === 'function' && value.width > 0 && value.height > 0) {
        const candidate = document.elementFromPoint(value.x + value.width / 2, value.y + value.height / 2);
        hit = candidate ? {
          tag: String(candidate.tagName || ''),
          id: String(candidate.id || '').slice(0, 100),
          testId: String(candidate.getAttribute?.('data-testid') || '').slice(0, 100),
          className: String(candidate.className || '').slice(0, 160),
          targetContainsHit: typeof element.contains === 'function' ? element.contains(candidate) : null,
        } : null;
      }
    } catch (_) {}
    let style = null;
    try {
      if (typeof getComputedStyle === 'function') {
        const computed = getComputedStyle(element);
        style = {
          display: computed.display,
          visibility: computed.visibility,
          pointerEvents: computed.pointerEvents,
          opacity: computed.opacity,
          cursor: computed.cursor,
        };
      }
    } catch (_) {}
    const ancestors = [];
    let ancestor = element;
    for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
      ancestors.push({
        tag: String(ancestor.tagName || ''),
        id: String(ancestor.id || '').slice(0, 100),
        testId: String(ancestor.getAttribute?.('data-testid') || '').slice(0, 100),
        role: String(ancestor.getAttribute?.('role') || '').slice(0, 40),
        ariaPressed: String(ancestor.getAttribute?.('aria-pressed') || '').slice(0, 20),
        className: String(ancestor.className || '').slice(0, 160),
      });
    }
    return {
      tag: String(element.tagName || ''),
      id: String(element.id || '').slice(0, 100),
      testId: String(element.getAttribute?.('data-testid') || '').slice(0, 100),
      role: String(element.getAttribute?.('role') || '').slice(0, 40),
      ariaLabel: String(element.getAttribute?.('aria-label') || '').slice(0, 100),
      ariaPressed: String(element.getAttribute?.('aria-pressed') || '').slice(0, 20),
      className: String(element.className || '').slice(0, 160),
      text: clean(element.textContent).slice(0, 120),
      rect,
      hit,
      style,
      ancestors,
    };
  }
  function walletControls() {
    return Array.from(document.querySelectorAll(
      '[data-testid*="wallet"], [data-testid*="total-bet"], [data-testid*="bet-slip"], [aria-label*="bet" i]',
    )).slice(0, 20).map(describeElement);
  }
  function rootControls(root) {
    if (!root || root === document || typeof root.querySelectorAll !== 'function') return [];
    return Array.from(root.querySelectorAll('button, [role="button"], [data-testid], [aria-label]'))
      .filter(element => !element.hasAttribute?.('data-betcode'))
      .slice(0, 24)
      .map(element => ({
        tag: String(element.tagName || ''),
        id: String(element.id || '').slice(0, 100),
        testId: String(element.getAttribute?.('data-testid') || '').slice(0, 100),
        role: String(element.getAttribute?.('role') || '').slice(0, 40),
        aria: String(element.getAttribute?.('aria-label') || '').slice(0, 100),
        className: String(element.className || '').slice(0, 120),
        text: clean(element.textContent).slice(0, 120),
      }));
  }
  function pageMarketControls() {
    return Array.from(document.querySelectorAll('[data-betcode]')).slice(0, 32).map(element => {
      let ancestor = element;
      let ancestorId = '';
      let ancestorClass = '';
      for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
        if (!ancestorId && ancestor.id) ancestorId = String(ancestor.id).slice(0, 120);
        if (!ancestorClass && ancestor.className) ancestorClass = String(ancestor.className).slice(0, 160);
      }
      return {
        code: String(element.getAttribute?.('data-betcode') || '').slice(0, 20),
        visible: visible(element),
        ancestorId,
        ancestorClass,
        text: clean(element.textContent).slice(0, 100),
      };
    });
  }
  function pageRoundTimers() {
    return Array.from(document.querySelectorAll(
      '[data-testid^="timer-countdown-"]',
    )).slice(0, 24).map(timer => {
      let ancestor = timer.parentElement;
      const ancestors = [];
      for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
        ancestors.push({
          id: String(ancestor.id || '').slice(0, 100),
          testId: String(ancestor.getAttribute?.('data-testid') || '').slice(0, 100),
          className: String(ancestor.className || '').slice(0, 120),
          marketCount: ancestor.querySelectorAll?.('[data-betcode]')?.length || 0,
          chipCount: ancestor.querySelectorAll?.('[data-testid^="chip-stack-value-"]')?.length || 0,
        });
      }
      let rect = null;
      try {
        const value = timer.getBoundingClientRect();
        rect = { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) };
      } catch (_) {}
      return {
        testId: String(timer.getAttribute?.('data-testid') || '').slice(0, 100),
        text: clean(timer.textContent).slice(0, 40),
        visible: visible(timer),
        rect,
        ancestors,
      };
    });
  }

  const roots = tableRoots(tableId) || [];
  const root = roots[0] || null;
  const prepared = preparedLease(tableId);
  const preparedLeaseActive = !!prepared;
  const multitableRouteReady = location.pathname !== '/desktop/multibaccarat/' || preparedLeaseActive;
  const bettingRoot = location.pathname === '/desktop/multibaccarat/' && preparedLeaseActive
    ? document
    : root;
  const dedicatedReferrerMatch = location.pathname === '/desktop/baccarat/'
    && referrerTableId() === tableId;
  const rootVisible = root ? visible(root) : false;
  const timer = root && !preparedLeaseActive ? countdownTimer(root) : null;
  const currentRoundId = root ? roundId(root) : '';
  const bettingOpen = root ? isOpen(root, tableId) : false;
  const requiredMarkets = typeof targetMarket === 'string' && MARKET_CODES[targetMarket]
    ? [targetMarket]
    : ['player', 'banker'];
  const executionReady = multitableRouteReady
    && bettingOpen
    && requiredMarkets.every(market => !!marketTarget(bettingRoot, market));
  const countdown = root ? remainingSeconds(root, tableId) : Number.NaN;
  const marketTargets = bettingRoot
    ? Object.fromEntries(Object.keys(MARKET_CODES).map(market => [
      market,
      describeElement(marketTarget(bettingRoot, market)),
    ]))
    : {};
  const chipControls = Array.from(document.querySelectorAll('[data-testid^="chip-stack-value-"]'))
    .slice(0, 24)
    .map(describeElement);
  return {
    status: root && executionReady ? 'ready' : root ? 'closed' : 'not-found',
    runtimeRevision: RUNTIME_REVISION,
    host: String(location.hostname || ''),
    framePath: String(location.pathname || ''),
    tableId: String(tableId || ''),
    routingAuthority: preparedLeaseActive && root
      ? 'prepared-multitable'
      : dedicatedReferrerMatch && root === document
        ? 'dedicated-referrer'
        : root
          ? 'table-root'
          : 'none',
    roundId: currentRoundId,
    rootCandidateCount: roots.length,
    rootId: root && root !== document ? String(root.id || '') : '',
    rootClass: root && root !== document ? String(root.className || '').slice(0, 160) : '',
    rootControls: rootControls(root),
    pageMarketControls: pageMarketControls(),
    pageRoundTimers: pageRoundTimers(),
    rootVisible,
    timerTestId: preparedLeaseActive
      ? 'prepared-target-tile-lease'
      : timer
        ? String(timer.getAttribute('data-testid') || '')
        : '',
    countdown: Number.isFinite(countdown) ? countdown : null,
    markets: bettingRoot ? Object.keys(MARKET_CODES).filter(market => !!marketTarget(bettingRoot, market)) : [],
    marketTargets,
    chipControls,
    walletControls: walletControls(),
    supportedChips: [10, 50, 250, 500, 1000, 2500, 5000, 10000].filter(chipAvailable),
  };
}

async function executePragmaticBetOneShot(request, command) {
  const RUNTIME_REVISION = 'pragmatic-bet-runtime/2026-08-30.21';
  const MIN_REMAINING_SECONDS = 1;
  const MARKET_CODES = Object.freeze({ player: '0', banker: '1', playerPair: '3', bankerPair: '4' });
  const RECEIPT_TIMEOUT_MS = 5000;

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function visible(element) {
    if (!element || element.disabled === true) return false;
    try {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return true;
    }
  }
  function referrerTableId() {
    try {
      return new URL(document.referrer).searchParams.get('table_id') || '';
    } catch (_) {
      return '';
    }
  }
  function sharedMarketControls() {
    const controls = {};
    for (const [market, code] of Object.entries(MARKET_CODES)) {
      const candidates = Array.from(document.querySelectorAll(`[data-betcode="${code}"]`))
        .filter(element => visible(element) && !element.closest?.('[id^="TileHeight-"]'));
      if (candidates.length === 1) controls[market] = candidates[0];
    }
    return controls;
  }
  function preparedLease(targetTableId) {
    const prepared = globalThis.__baccaratPragmaticPreparedTable;
    if (!(
      location.pathname === '/desktop/multibaccarat/'
      && prepared
      && prepared.tableId === targetTableId
      && Number.isFinite(prepared.preparedAt)
      && Date.now() - prepared.preparedAt <= 5000
      && typeof prepared.roundId === 'string'
      && Number.isFinite(prepared.countdown)
      && Number.isFinite(prepared.countdownAt)
    )) return null;
    const liveControls = sharedMarketControls();
    const storedConnected = prepared.marketControls
      && Object.values(prepared.marketControls).every(element => element && element.isConnected !== false);
    const marketControls = ['player', 'banker', 'playerPair', 'bankerPair'].every(market => liveControls[market])
      ? liveControls
      : storedConnected ? prepared.marketControls : null;
    return marketControls ? { ...prepared, marketControls } : null;
  }
  function tableRoots(tableId) {
    if (typeof tableId !== 'string' || !/^[a-z0-9]{8,32}$/i.test(tableId)) return null;
    if (location.pathname === '/desktop/baccarat/' && referrerTableId() === tableId) return [document];
    const roots = [];
    const exact = document.getElementById(`TileHeight-${tableId}`);
    if (exact) roots.push(exact);
    const selectors = [
      `[data-table-id="${tableId}"]`,
      `[data-tableid="${tableId}"]`,
      `[data-table="${tableId}"]`,
      `[data-game-table-id="${tableId}"]`,
      `[id*="${tableId}"]`,
    ];
    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        if (!roots.includes(candidate)) roots.push(candidate);
      }
    }
    const score = root => Number(root === exact) * 100
      + Number(!!root.querySelector('[data-betcode="0"], [data-betcode="1"]')) * 10
      + Number(!!root.querySelector('[data-testid^="timer-countdown-"]')) * 5
      + Number(visible(root));
    return roots.sort((left, right) => score(right) - score(left));
  }
  function tableRoot(tableId) {
    return tableRoots(tableId)?.[0] || null;
  }
  function roundId(root) {
    const header = root.querySelector([
      '[data-testid="game-header-game-id"]',
      '[data-testid*="game-id"]',
      '[data-testid*="round-id"]',
      '[data-game-id]',
      '[data-round-id]',
    ].join(', '));
    if (header) {
      const identity = [
        header.getAttribute?.('data-game-id'),
        header.getAttribute?.('data-round-id'),
        header.textContent,
      ].map(clean).join(' ');
      const headerMatch = identity.match(/(?:ID|局号|游戏编号|牌局)\s*[:：#]?\s*(\d{8,20})/i)
        || identity.match(/\b(\d{8,20})\b/);
      if (headerMatch) return headerMatch[1];
    }
    const text = clean(root.textContent);
    return (text.match(/(?:ID|局号|游戏编号|牌局)\s*[:：#]?\s*(\d{8,20})/i) || [])[1] || '';
  }
  function countdownTimer(root) {
    return root === document
      ? root.querySelector('[data-testid="round-timer"] [data-testid^="timer-countdown-"]')
      : root?.querySelector('[data-testid^="timer-countdown-"]');
  }
  function remainingSeconds(root, targetTableId) {
    const prepared = preparedLease(targetTableId);
    if (prepared) {
      return Math.floor(prepared.countdown - Math.max(0, Date.now() - prepared.countdownAt) / 1000);
    }
    return Number(clean(countdownTimer(root)?.textContent));
  }
  function isOpen(root, targetTableId) {
    const prepared = preparedLease(targetTableId);
    const remaining = remainingSeconds(root, targetTableId);
    const targetWasVisibleWhenPrepared = location.pathname === '/desktop/multibaccarat/' && !!prepared;
    return (targetWasVisibleWhenPrepared || visible(root))
      && Number.isFinite(remaining)
      && remaining >= MIN_REMAINING_SECONDS;
  }
  function payload() {
    const value = request && request.intent ? request.intent : request && request.wager;
    if (!value || typeof value !== 'object') return null;
    return {
      id: request.intent ? value.intentId : value.wagerId,
      kind: request.intent ? 'intent' : 'wager',
      reservationId: request.reservationId || '',
      tableId: value.tableId,
      shoeId: value.shoeId,
      handId: value.handId,
      market: value.market,
      amount: Number(value.amount),
      source: value.source,
    };
  }
  function targetFor(root, market) {
    const prepared = preparedLease(value?.tableId);
    if (location.pathname === '/desktop/multibaccarat/' && prepared) {
      const target = prepared.marketControls[market];
      return visible(target) ? target : null;
    }
    const code = MARKET_CODES[market];
    if (code !== undefined) {
      const scope = root && root !== document ? root : document;
      const matches = Array.from(scope.querySelectorAll(`[data-betcode="${code}"]`)).filter(visible);
      const shared = matches.filter(outsideTableTile);
      if (shared.length === 1) return shared[0];
      if (matches.length === 1) return matches[0];
      if (root !== document || location.pathname === '/desktop/multibaccarat/') {
        return matches.find(visible) || null;
      }
    }
    if (market === 'player') return document.getElementById('leftBetTextRoot');
    if (market === 'banker') return document.getElementById('rightBetTextRoot');
    const label = market === 'playerPair' ? '闲家对子' : market === 'bankerPair' ? '庄家对子' : '';
    if (!label) return null;
    return Array.from(document.querySelectorAll('*')).find(
      node => node.children.length === 0 && clean(node.textContent) === label,
    ) || null;
  }
  function outsideTableTile(element) {
    return !element?.closest?.('[id^="TileHeight-"]');
  }
  function chipStackRoot(element) {
    if (!element) return null;
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const testId = String(current.getAttribute?.('data-testid') || '');
      if (/^chip-stack(?!-value)/.test(testId)) return current;
      const tag = String(current.tagName || '').toLowerCase();
      if (tag === 'button' || current.getAttribute?.('role') === 'button') return current;
      current = current.parentElement || current.parentNode || null;
    }
    return element;
  }
  function chipFor(amount) {
    if (!Number.isInteger(amount) || amount <= 0) return null;
    const matches = Array.from(document.querySelectorAll(`[data-testid="chip-stack-value-${amount}"]`))
      .filter(visible);
    const shared = matches.filter(outsideTableTile);
    return shared[0] || matches[0] || null;
  }
  function chipPlanFor(amount) {
    if (!Number.isInteger(amount) || amount <= 0) return null;
    const denominations = [10000, 5000, 2500, 1000, 500, 250, 100, 50, 25, 10, 5, 1];
    const chips = new Map();
    for (const denomination of denominations) {
      const chip = chipFor(denomination);
      if (chip) chips.set(denomination, chip);
    }
    const plan = [];
    let remaining = amount;
    for (const denomination of denominations) {
      const chip = chips.get(denomination);
      if (!chip) continue;
      while (remaining >= denomination) {
        plan.push({ denomination, chip });
        remaining -= denomination;
      }
    }
    return remaining === 0 && plan.length > 0 ? plan : null;
  }
  function totalBetObservation() {
    const selectors = [
      '[data-testid="wallet-mobile-total-bet"]',
      '[data-testid*="total-bet"]',
      '[data-testid*="totalBet"]',
    ];
    const candidates = [];
    for (const selector of selectors) {
      const matches = typeof document.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll(selector))
        : [];
      if (matches.length === 0 && typeof document.querySelector === 'function') {
        const single = document.querySelector(selector);
        if (single) matches.push(single);
      }
      for (const candidate of matches) {
        if (!candidates.includes(candidate) && visible(candidate)) candidates.push(candidate);
      }
    }
    for (const candidate of candidates) {
      const text = clean(candidate.textContent);
      const values = text.match(/[\d,.]+/g) || [];
      const parsed = Number(String(values[values.length - 1] || '').replace(/,/g, ''));
      if (Number.isFinite(parsed)) {
        return {
          observed: true,
          value: parsed,
          testId: String(candidate.getAttribute?.('data-testid') || '').slice(0, 100),
          text: text.slice(0, 120),
        };
      }
    }
    return { observed: false, value: 0, testId: '', text: '' };
  }
  function betCodeOf(element) {
    if (!element) return '';
    const own = String(element.getAttribute?.('data-betcode') || '');
    if (own) return own;
    const id = String(element.id || '');
    if (id === 'leftBetTextRoot') return '0';
    if (id === 'rightBetTextRoot') return '1';
    return '';
  }
  function betCodesIn(element) {
    const codes = new Set();
    const own = betCodeOf(element);
    if (own) codes.add(own);
    const matches = typeof element.querySelectorAll === 'function'
      ? Array.from(element.querySelectorAll('[data-betcode]'))
      : [];
    for (const node of matches) {
      const code = String(node.getAttribute?.('data-betcode') || '');
      if (code) codes.add(code);
    }
    return [...codes];
  }
  function containsForeignMarket(parent, target) {
    if (!parent || !target) return false;
    const left = typeof document.getElementById === 'function'
      ? document.getElementById('leftBetTextRoot')
      : null;
    const right = typeof document.getElementById === 'function'
      ? document.getElementById('rightBetTextRoot')
      : null;
    if (left && left !== target && !target.contains?.(left) && parent.contains?.(left)) return true;
    if (right && right !== target && !target.contains?.(right) && parent.contains?.(right)) return true;
    const targetCode = betCodeOf(target);
    const codes = typeof parent.querySelectorAll === 'function'
      ? Array.from(parent.querySelectorAll('[data-betcode]'))
      : [];
    for (const node of codes) {
      const code = String(node.getAttribute?.('data-betcode') || '');
      if (code && code !== targetCode && !target.contains?.(node)) return true;
    }
    return betCodesIn(parent).some(code => targetCode && code !== targetCode);
  }
  function marketSpotRoot(element) {
    if (!element) return null;
    let current = element;
    let best = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const testId = String(current.getAttribute?.('data-testid') || '');
      if (/bet-spot|betting-spot|market-spot|betspot/i.test(testId)) return current;
      const tag = String(current.tagName || '').toLowerCase();
      if (tag === 'button' || current.getAttribute?.('role') === 'button') return current;
      const parent = current.parentElement || current.parentNode || null;
      if (!parent || parent === document || parent === document.body || parent === document.documentElement) {
        break;
      }
      if (String(parent.id || '').startsWith('TileHeight-')) break;
      if (containsForeignMarket(parent, element)) break;
      let parentArea = Number.NaN;
      let bestArea = Number.NaN;
      try {
        const parentRect = parent.getBoundingClientRect();
        const bestRect = best.getBoundingClientRect();
        parentArea = Number(parentRect.width) * Number(parentRect.height);
        bestArea = Number(bestRect.width) * Number(bestRect.height);
      } catch (_) {}
      if (current !== element && Number.isFinite(parentArea) && Number.isFinite(bestArea)
        && bestArea > 0 && parentArea > bestArea * 10) {
        break;
      }
      best = parent;
      current = parent;
    }
    return best;
  }
  function pointerEventsOf(node) {
    try {
      if (typeof getComputedStyle === 'function') return String(getComputedStyle(node).pointerEvents || '');
    } catch (_) {}
    return '';
  }
  function hitRelated(target, candidate) {
    if (!candidate || !target) return false;
    if (candidate === target || target.contains?.(candidate) || candidate.contains?.(target)) return true;
    const targetStack = chipStackRoot(target);
    const hitStack = chipStackRoot(candidate);
    if (targetStack && hitStack && targetStack === hitStack) return true;
    const targetSpot = marketSpotRoot(target);
    return Boolean(targetSpot && (targetSpot === candidate || targetSpot.contains?.(candidate)));
  }
  function clickPoint(element, kind) {
    const target = kind === 'chip'
      ? (chipStackRoot(element) || element)
      : (marketSpotRoot(element) || element);
    if (!visible(target)) return null;
    let rect;
    try {
      rect = target.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    const left = Number(rect.left ?? rect.x ?? 0);
    const top = Number(rect.top ?? rect.y ?? 0);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![left, top, width, height].every(Number.isFinite) || width <= 4 || height <= 4) return null;
    const samples = [
      [0.5, 0.5],
      [0.35, 0.5],
      [0.65, 0.5],
      [0.5, 0.35],
      [0.5, 0.65],
      [0.2, 0.5],
      [0.8, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
      [0.3, 0.4],
      [0.7, 0.6],
    ];
    let selected = null;
    let hit = null;
    for (const [xp, yp] of samples) {
      const x = left + width * xp;
      const y = top + height * yp;
      const stack = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(x, y)
        : [typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : target];
      const live = (stack || []).filter(node => pointerEventsOf(node) !== 'none');
      const candidate = live[0] || (stack || [])[0] || null;
      if (hitRelated(target, candidate)) {
        selected = { x, y };
        hit = candidate;
        break;
      }
    }
    if (!selected) return null;
    return {
      x: selected.x,
      y: selected.y,
      width,
      height,
      viewportWidth: Number(globalThis.innerWidth || document.documentElement?.clientWidth || 0),
      viewportHeight: Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0),
      targetTag: String(target.tagName || '').slice(0, 40),
      targetId: String(target.id || '').slice(0, 100),
      targetTestId: String(target.getAttribute?.('data-testid') || '').slice(0, 100),
      hitTag: String(hit?.tagName || '').slice(0, 40),
      hitId: String(hit?.id || '').slice(0, 100),
      hitTestId: String(hit?.getAttribute?.('data-testid') || '').slice(0, 100),
    };
  }
  function makeReceipt(status, reason, commitStarted, extra) {
    const value = payload() || {};
    const common = {
      tableId: value.tableId || '',
      shoeId: value.shoeId || '',
      handId: value.handId || '',
      market: value.market,
      amount: value.amount,
      status,
      externalRef: `pragmatic:${value.tableId || ''}:${value.handId || ''}`,
      createdAt: new Date().toISOString(),
      raw: {
        runtimeRevision: RUNTIME_REVISION,
        reason,
        commitPoint: commitStarted ? 'market-click' : 'preflight',
        commitStarted,
        ...(extra || {}),
      },
    };
    if (value.kind === 'wager') {
      return {
        receiptId: `pragmatic-operational-${status.toLowerCase()}-${value.id}-${Date.now()}`,
        wagerId: value.id || '',
        source: value.source,
        ...common,
      };
    }
    return {
      receiptId: `pragmatic-${status.toLowerCase()}-${value.id}-${Date.now()}`,
      intentId: value.id || '',
      reservationId: value.reservationId || '',
      mode: 'live',
      ...common,
    };
  }

  const value = payload();
  if (!request || request.mode !== 'live' || !value) {
    return makeReceipt('REJECTED', 'invalid-live-request', false);
  }
  const phase = command && typeof command.phase === 'string' ? command.phase : '';
  if (phase === 'request') {
    const channel = globalThis.__baccaratPragmaticBetChannel;
    const gId = String(value.handId || '');
    if (!channel || typeof channel.placeBet !== 'function') {
      return {
        phase: 'request-unavailable',
        runtimeRevision: RUNTIME_REVISION,
        reason: 'bet-request-channel-unavailable',
        currentRoundId: gId,
      };
    }
    let result;
    try {
      result = channel.placeBet({
        tableId: value.tableId,
        market: value.market,
        amount: value.amount,
        roundId: gId,
        code: MARKET_CODES[value.market],
      });
    } catch (_) {
      result = { ok: false, reason: 'bet-request-threw' };
    }
    if (!result || result.ok !== true) {
      return {
        phase: 'request-unavailable',
        runtimeRevision: RUNTIME_REVISION,
        reason: String(result && result.reason || 'bet-request-failed'),
        currentRoundId: gId,
      };
    }
    const before = totalBetObservation();
    return {
      phase: 'requested',
      runtimeRevision: RUNTIME_REVISION,
      tableId: value.tableId,
      handId: value.handId,
      market: value.market,
      amount: value.amount,
      currentRoundId: gId,
      beforeTotal: before.value,
      beforeTotalObserved: before.observed,
      requestSent: true,
    };
  }
  const root = tableRoot(value.tableId);
  if (!root) return makeReceipt('REJECTED', 'target-table-not-found', false);
  const prepared = preparedLease(value.tableId);
  const bettingRoot = location.pathname === '/desktop/multibaccarat/' && prepared ? document : root;
  const currentRoundId = roundId(root);
  const currentCountdown = remainingSeconds(root, value.tableId);
  if (!isOpen(root, value.tableId)) {
    return makeReceipt('REJECTED', 'betting-window-closed', false, { currentRoundId, currentCountdown });
  }
  const target = targetFor(bettingRoot, value.market);
  if (!target) return makeReceipt('REJECTED', 'unsupported-market', false, { currentRoundId, currentCountdown });
  if (phase === 'prepare') {
    const before = totalBetObservation();
    return {
      phase: 'prepared',
      runtimeRevision: RUNTIME_REVISION,
      tableId: value.tableId,
      handId: value.handId,
      market: value.market,
      amount: value.amount,
      currentRoundId,
      currentCountdown,
      beforeTotal: before.value,
      beforeTotalObserved: before.observed,
      beforeTotalTestId: before.testId,
      skipChipSelection: true,
      denominations: [],
    };
  }
  if (phase === 'target') {
    const expectedRoundId = String(command.expectedRoundId || '');
    if (expectedRoundId && currentRoundId && expectedRoundId !== currentRoundId) {
      return makeReceipt('REJECTED', 'round-changed-before-trusted-click', false, {
        expectedRoundId,
        currentRoundId,
        currentCountdown,
      });
    }
    const action = command.action === 'market' ? 'market' : command.action === 'chip' ? 'chip' : '';
    if (action !== 'market') {
      return makeReceipt('REJECTED', 'chip-selection-disabled', false, {
        currentRoundId,
        currentCountdown,
      });
    }
    const point = clickPoint(target, action);
    if (!point) {
      const spot = action === 'market' ? marketSpotRoot(target) : target;
      let spotRect = null;
      try {
        const value = (spot || target).getBoundingClientRect();
        spotRect = {
          x: Math.round(Number(value.x ?? value.left ?? 0)),
          y: Math.round(Number(value.y ?? value.top ?? 0)),
          width: Math.round(Number(value.width)),
          height: Math.round(Number(value.height)),
        };
      } catch (_) {}
      return makeReceipt('REJECTED', `${action}-target-not-hittable`, false, {
        currentRoundId,
        currentCountdown,
        targetTag: String(target.tagName || '').slice(0, 40),
        targetId: String(target.id || '').slice(0, 100),
        targetTestId: String(target.getAttribute?.('data-testid') || '').slice(0, 100),
        spotTag: String(spot?.tagName || '').slice(0, 40),
        spotRect,
      });
    }
    return {
      phase: 'target',
      runtimeRevision: RUNTIME_REVISION,
      action,
      currentRoundId,
      currentCountdown,
      point,
    };
  }
  if (phase === 'observe') {
    const beforeTotal = Number(command.beforeTotal);
    const expectedTotal = Number(command.expectedTotal);
    const selectedChips = Array.isArray(command.selectedChips)
      ? command.selectedChips.filter(Number.isFinite)
      : [];
    const expectedRoundId = String(command.expectedRoundId || currentRoundId || '');
    const final = command.final === true;
    const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
    let after = totalBetObservation();
    while (Date.now() < deadline) {
      after = totalBetObservation();
      if (after.observed && Number.isFinite(expectedTotal) && after.value >= expectedTotal) {
        if (!final) {
          return {
            phase: 'observed',
            runtimeRevision: RUNTIME_REVISION,
            afterTotal: after.value,
            afterTotalObserved: true,
            selectedChips,
            currentRoundId: expectedRoundId,
          };
        }
        return makeReceipt('ACCEPTED', 'wallet-total-bet-increased', true, {
          beforeTotal,
          afterTotal: after.value,
          beforeTotalObserved: command.beforeTotalObserved === true,
          afterTotalObserved: true,
          selectedChips,
          currentRoundId: expectedRoundId,
          trustedInput: true,
        });
      }
      const observedRoundId = roundId(root);
      if (expectedRoundId && observedRoundId && observedRoundId !== expectedRoundId) {
        return makeReceipt('UNKNOWN', 'round-advanced-before-ack', true, {
          beforeTotal,
          afterTotal: after.value,
          beforeTotalObserved: command.beforeTotalObserved === true,
          afterTotalObserved: after.observed,
          selectedChips,
          currentCountdown,
          currentRoundId: expectedRoundId,
          observedRoundId,
          trustedInput: true,
        });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return makeReceipt('UNKNOWN', 'platform-ack-not-observed', true, {
      beforeTotal,
      afterTotal: after.value,
      beforeTotalObserved: command.beforeTotalObserved === true,
      afterTotalObserved: after.observed,
      selectedChips,
      currentRoundId: expectedRoundId,
      currentCountdown,
      trustedInput: true,
    });
  }
  return makeReceipt('REJECTED', 'trusted-input-required', false, { currentRoundId, currentCountdown });
}

globalThis.probePragmaticBetTable = probePragmaticBetTable;
globalThis.executePragmaticBetOneShot = executePragmaticBetOneShot;
globalThis.PRAGMATIC_BET_RUNTIME_REVISION = 'pragmatic-bet-runtime/2026-08-30.21';
}
