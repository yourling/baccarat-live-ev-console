/**
 * One-shot BG bet runtime (MAIN world). Fixture-driven via
 * globalThis.__baccaratBgBetAdapter.submit. Never sends autoBet, never
 * clicks video or 重新连接.
 */
(function () {
  const RUNTIME_REVISION = 'bg-bet-runtime/2026-09-05.1';
  const TABLE_ID = /^[A-Za-z]\d{2}$/;
  const MARKETS = { banker: 1, player: 2, bankerPair: 4, playerPair: 5 };

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
      if (/\/h5V01\//i.test(path)) return true;
      if (/[?&#]table=([A-Za-z]\d{2})/i.test(href)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function normalizeTableId(value) {
    const trimmed = String(value || '').trim();
    if (!TABLE_ID.test(trimmed)) return '';
    return trimmed.toUpperCase();
  }

  function adapter() {
    const custom = globalThis.__baccaratBgBetAdapter;
    if (custom && typeof custom.submit === 'function') return custom;
    const proto = globalThis.BaccaratBgProtocol;
    if (proto && proto.session && proto.session.token && typeof proto.submit === 'function') {
      const tableId = normalizeTableId(location.search && (location.search.match(/table=([A-Za-z]\d{2})/i) || [])[1]);
      const started = tableId && proto.session.countdownAtByTable
        ? proto.session.countdownAtByTable[tableId]
        : 0;
      const countdown = tableId && proto.session.countdownByTable
        ? proto.session.countdownByTable[tableId]
        : 0;
      const remaining = started && countdown
        ? countdown - (Date.now() - started) / 1000
        : 30;
      return {
        submit: request => proto.submit(request),
        tableId,
        bettingOpen: true,
        remainingWindowSec: remaining,
      };
    }
    return null;
  }

  function channelStatus(tableId) {
    const readyAdapter = adapter();
    const normalized = normalizeTableId(tableId);
    const adapterTable = readyAdapter && typeof readyAdapter.tableId === 'string'
      ? normalizeTableId(readyAdapter.tableId)
      : '';
    const tableIds = [];
    if (normalized) tableIds.push(normalized);
    if (adapterTable && !tableIds.includes(adapterTable)) tableIds.push(adapterTable);
    return {
      hasUser: true,
      hasSocket: Boolean(readyAdapter && typeof readyAdapter.submit === 'function'),
      tableIds,
      host: location.hostname,
      tableId: adapterTable || normalized,
      runtimeRevision: RUNTIME_REVISION,
    };
  }

  globalThis.__baccaratBgBetChannel = channelStatus('');

  globalThis.probeBgBetTable = function probeBgBetTable(tableId) {
    if (!isBgPage()) {
      return { status: 'not-ready', runtimeRevision: RUNTIME_REVISION, host: location.hostname, tableId: '', diagnostics: { reason: 'not-bg-page' } };
    }
    const normalized = normalizeTableId(tableId);
    const status = channelStatus(normalized);
    globalThis.__baccaratBgBetChannel = status;
    const ready = status.hasSocket && (!normalized || status.tableIds.includes(normalized) || status.tableId === '' || status.tableId === normalized);
    return {
      status: ready ? 'ready' : 'not-ready',
      runtimeRevision: RUNTIME_REVISION,
      host: location.hostname,
      tableId: normalized || status.tableId,
      diagnostics: { hasSocket: status.hasSocket, tableIds: status.tableIds },
    };
  };

  function requestTableId(request) {
    if (request && request.wager && typeof request.wager.tableId === 'string') return request.wager.tableId;
    if (request && request.intent && typeof request.intent.tableId === 'string') return request.intent.tableId;
    return '';
  }
  function requestMarket(request) {
    if (request && request.wager) return request.wager.market;
    if (request && request.intent) return request.intent.market;
    return '';
  }
  function requestAmount(request) {
    if (request && request.wager) return request.wager.amount;
    if (request && request.intent) return request.intent.amount;
    return 0;
  }
  function requestHandId(request) {
    if (request && request.wager && typeof request.wager.handId === 'string') return request.wager.handId;
    if (request && request.intent && typeof request.intent.handId === 'string') return request.intent.handId;
    return '';
  }

  function receipt(request, status, extra) {
    const wager = request && request.wager;
    const intent = request && request.intent;
    const tableId = normalizeTableId(requestTableId(request));
    const handId = requestHandId(request);
    const market = requestMarket(request);
    const amount = requestAmount(request);
    const playType = Object.prototype.hasOwnProperty.call(MARKETS, market) ? MARKETS[market] : 0;
    const now = new Date().toISOString();
    if (wager) {
      return {
        receiptId: `bg-bridge-operational-${wager.wagerId || 'wager'}-${Date.now()}`,
        wagerId: wager.wagerId || '',
        tableId,
        shoeId: wager.shoeId || '',
        handId,
        market,
        amount,
        source: wager.source,
        status,
        externalRef: `bg:${tableId}:${handId}:playType:${playType}`,
        createdAt: now,
        raw: { runtimeRevision: RUNTIME_REVISION, commitStarted: false, ...extra },
      };
    }
    return {
      receiptId: `bg-bridge-${intent && intent.intentId ? intent.intentId : 'intent'}-${Date.now()}`,
      intentId: intent && intent.intentId ? intent.intentId : '',
      reservationId: request && request.reservationId ? request.reservationId : '',
      status,
      amount,
      market,
      mode: 'live',
      externalRef: `bg:${tableId}:${handId}:playType:${playType}`,
      createdAt: now,
      raw: { runtimeRevision: RUNTIME_REVISION, commitStarted: false, ...extra },
    };
  }

  globalThis.executeBgBetOneShot = async function executeBgBetOneShot(request) {
    if (!isBgPage()) return receipt(request, 'REJECTED', { reason: 'not-bg-page' });
    const tableId = normalizeTableId(requestTableId(request));
    const market = requestMarket(request);
    const amount = Number(requestAmount(request));
    const handId = requestHandId(request);
    if (!tableId) return receipt(request, 'REJECTED', { reason: 'invalid-table-id' });
    if (!Object.prototype.hasOwnProperty.call(MARKETS, market)) {
      return receipt(request, 'REJECTED', { reason: 'invalid-market' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return receipt(request, 'REJECTED', { reason: 'invalid-amount' });
    }
    const ready = adapter();
    if (!ready || typeof ready.submit !== 'function') {
      return receipt(request, 'REJECTED', { reason: 'bg-adapter-missing' });
    }
    if (typeof ready.remainingWindowSec === 'number' && ready.remainingWindowSec < 3) {
      return receipt(request, 'REJECTED', { reason: 'window-too-short' });
    }
    if (ready.bettingOpen === false) {
      return receipt(request, 'REJECTED', { reason: 'betting-closed' });
    }
    if (typeof ready.handId === 'string' && ready.handId && ready.handId !== handId) {
      return receipt(request, 'REJECTED', { reason: 'hand-mismatch' });
    }
    let commitStarted = false;
    try {
      commitStarted = true;
      const result = await ready.submit({
        tableId,
        market,
        amount,
        handId,
        source: request && request.wager ? request.wager.source : 'one-shot',
      });
      const status = result && result.status === 'ACCEPTED'
        ? 'ACCEPTED'
        : result && result.status === 'UNKNOWN'
          ? 'UNKNOWN'
          : 'REJECTED';
      const built = receipt(request, status, {
        commitStarted: true,
        reason: result && result.reason,
        expectedFlag: result && result.expectedFlag,
        seen: result && result.seen,
        state: result && result.state,
        userFlag: result && result.userFlag,
      });
      built.raw.commitStarted = true;
      return built;
    } catch (error) {
      const built = receipt(request, 'UNKNOWN', {
        commitStarted: true,
        reason: error && error.message ? String(error.message).slice(0, 200) : 'submit-threw',
      });
      built.raw.commitStarted = true;
      return built;
    }
  };
})();
