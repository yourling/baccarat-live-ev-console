/**
 * Dafabet/mstrom adapter boundary.
 *
 * The adapter never enables real execution by itself. A caller must:
 *   1. use BetExecutionRequest.mode = "live";
 *   2. set chrome.storage.local.liveBetEnabled = true;
 *
 * Pair play types are taken from the site's public runtime constants:
 *   bankerPair = 4, playerPair = 5.
 */
(function () {
  const PLAY_TYPES = Object.freeze({ bankerPair: 4, playerPair: 5 });
  const POLL_INTERVAL_MS = 100;
  const REQUEST_TIMEOUT_MS = 5000;

  function playTypeForMarket(market) {
    return market === 'bankerPair' ? PLAY_TYPES.bankerPair
      : market === 'playerPair' ? PLAY_TYPES.playerPair
      : null;
  }

  function getAmount(pool, playType) {
    try {
      return pool && typeof pool.getAmount === 'function'
        ? Number(pool.getAmount(playType)) || 0
        : 0;
    } catch (_) {
      return 0;
    }
  }

  function getStakeStatus(pool, playType) {
    try {
      if (!pool || typeof pool.getAllStakeData !== 'function') return null;
      const rows = pool.getAllStakeData();
      if (!Array.isArray(rows)) return null;
      return rows.find(row => row && row.playType === playType) || null;
    } catch (_) {
      return null;
    }
  }

  function getBetStore(tableId) {
    try {
      const videoGameCore = globalThis.VideoGameCore;
      const linkFactory = videoGameCore
        && videoGameCore.LinkStoreFactory
        && videoGameCore.LinkStoreFactory.instance;
      if (linkFactory && typeof linkFactory.getBetTableStore === 'function') {
        const store = linkFactory.getBetTableStore(tableId);
        if (store) return store;
      }

      const gameBac = globalThis.GameBac;
      const betStore = gameBac && gameBac.BetStore;
      return betStore && betStore.instance ? betStore.instance : betStore;
    } catch (_) {
      return null;
    }
  }

  async function liveBetEnabled() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
      const stored = await chrome.storage.local.get({ liveBetEnabled: false });
      return stored.liveBetEnabled === true;
    } catch (_) {
      return false;
    }
  }

  function receipt(request, status, playType, raw) {
    return {
      receiptId: `mstrom-${request.intent.intentId}-${Date.now()}`,
      intentId: request.intent.intentId,
      reservationId: request.reservationId || '',
      status,
      amount: request.intent.amount,
      market: request.intent.market,
      mode: 'live',
      externalRef: `playType:${playType}`,
      createdAt: new Date().toISOString(),
      raw,
    };
  }

  async function executeMstromBet(request) {
    if (!request || request.mode !== 'live') return null;
    if (!(await liveBetEnabled())) return null;

    const intent = request.intent;
    const playType = playTypeForMarket(intent.market);
    if (playType === null || !Number.isFinite(intent.amount) || intent.amount <= 0) return null;

    const store = getBetStore(intent.tableId);
    const stakePool = store && store.stakePool;
    if (!store || !stakePool || typeof stakePool.setAmount !== 'function' || typeof store.confirmBet !== 'function') {
      return null;
    }

    const beforeStake = getAmount(stakePool, playType);
    const beforeDone = getAmount(store.donePool, playType);
    const targetStake = beforeStake + intent.amount;
    try {
      stakePool.setAmount(playType, targetStake);
      store.confirmBet();
    } catch (error) {
      return receipt(request, 'REJECTED', playType, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const doneAmount = getAmount(store.donePool, playType);
      const response = getStakeStatus(store.diffPool, playType);
      if (doneAmount >= beforeDone + intent.amount) {
        return receipt(request, 'ACCEPTED', playType, { beforeDone, doneAmount });
      }
      if (response && response.pending === false && response.success === false) {
        return receipt(request, 'REJECTED', playType, { beforeDone, response });
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // The request may have reached the platform but its ack was not observable.
    // UNKNOWN deliberately keeps the reservation alive for later reconciliation.
    return receipt(request, 'UNKNOWN', playType, { beforeDone, targetStake });
  }

  const adapter = {
    id: 'dafabet-mstrom',
    matches: ['https://www.dafabet.net/*', 'https://gci.agad.mstrom-uno.com/*', 'https://*.673ing.com/*'],
    roomSelector: '.room',
    tableSelector: '.table',
    extractRooms() {
      return [];
    },
    getKeepAliveTargets() {
      return null;
    },
    extractTableEvent() {
      return null;
    },
    executeBet(_doc, request) {
      return executeMstromBet(request);
    },
  };

  globalThis.BaccaratSiteAdapter = adapter;
})();
