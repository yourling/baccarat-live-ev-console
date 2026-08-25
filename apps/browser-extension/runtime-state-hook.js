/**
 * mstrom 运行时牌面探针（非视觉）。
 *
 * 站点自己的 GameBac/Cube.Game 运行时会把解码后的牌写入：
 *   GameStore.gameSnapshot.pcard / bcard
 * 随后 PokerStoreBase.onStatusChange 才据此刷新 UI。
 * 本探针只读这些已经解码的状态，不截屏、不 OCR、不发送游戏协议消息。
 */
(function () {
  if (window.__baccaratRuntimeStateHookInstalled) return;
  window.__baccaratRuntimeStateHookInstalled = true;
  if (!/mstrom-uno\.com|673ing\.com/i.test(location.hostname)) return;

  const POLL_INTERVAL_MS = 40;
  const MAX_TRACKED_TABLES = 256;
  const lastSignatureByTable = new Map();
  let lastSelectionSignature = null;

  function normalizedCardBytes(value) {
    if (!Array.isArray(value) || value.length > 3) return null;
    const cards = [];
    for (const rawCard of value) {
      const card = typeof rawCard === 'number'
        ? rawCard
        : rawCard && typeof rawCard.card === 'number' ? rawCard.card : Number(rawCard);
      const rank = card & 0x0f;
      if (!Number.isInteger(card) || card < 0 || card > 0xff || (card & 0xc0) !== 0 || rank < 1 || rank > 13) {
        return null;
      }
      cards.push(card);
    }
    return cards;
  }

  function postSelection(tableIds) {
    const uniqueTableIds = Array.from(new Set(tableIds.filter(Boolean))).sort();
    const signature = uniqueTableIds.join('|');
    if (signature === lastSelectionSignature) return;
    lastSelectionSignature = signature;
    lastSignatureByTable.clear();
    if (typeof setTimeout !== 'function') return;
    try {
      window.postMessage({
        source: 'baccarat-bridge-runtime-selection',
        url: location.href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds: uniqueTableIds, capturedAt: new Date().toISOString() }),
      }, '*');
    } catch (_) {
      // 页面卸载时忽略选择集通知。
    }
  }

  function tableIdOf(store, tableKey) {
    return String(store && (store.vid || store.tableId) || tableKey || '');
  }

  function visibleTableIdSet(videoGameCore) {
    const gameLinkStore = videoGameCore
      && videoGameCore.GameLinkStore
      && videoGameCore.GameLinkStore.instance;
    const visibleVids = gameLinkStore && gameLinkStore.visibleVids;
    if (!Array.isArray(visibleVids)) return null;
    const tableIds = new Set(visibleVids.filter(value => typeof value === 'string' && value.length > 0));
    return tableIds;
  }

  function isVisibleTable(tableId, visibleTableIds) {
    return visibleTableIds === null || visibleTableIds.has(tableId);
  }

  function postSnapshot(store, snapshot) {
    const tableId = String(store && (store.vid || store.tableId) || snapshot && snapshot.vid || '');
    const roundId = String(snapshot && (snapshot.gmcode || snapshot.gameCode) || '');
    if (!tableId || !roundId) return;

    const gmstatus = Number.isFinite(Number(snapshot.gmstatus)) ? Number(snapshot.gmstatus) : null;
    if (gmstatus === -1) return;

    // 站点明确把 gmstatus=11 定义为洗牌。该状态可上报，但绝不携带隐藏牌面。
    const hiddenForShuffle = gmstatus === 11;
    const playerCards = hiddenForShuffle ? [] : normalizedCardBytes(snapshot.pcard);
    const bankerCards = hiddenForShuffle ? [] : normalizedCardBytes(snapshot.bcard);
    if (playerCards === null || bankerCards === null) return;
    if (!hiddenForShuffle && playerCards.length === 0 && bankerCards.length === 0) return;

    const payload = {
      tableId,
      roundId,
      gameType: String(snapshot.gmtype || 'BAC'),
      gmstatus,
      playerScore: hiddenForShuffle ? null : Number.isFinite(Number(snapshot.pval)) ? Number(snapshot.pval) : null,
      bankerScore: hiddenForShuffle ? null : Number.isFinite(Number(snapshot.bval)) ? Number(snapshot.bval) : null,
      playerCards,
      bankerCards,
      capturedAt: new Date().toISOString(),
    };
    const signature = JSON.stringify(payload, (key, value) => key === 'capturedAt' ? undefined : value);
    if (lastSignatureByTable.get(tableId) === signature) return;
    lastSignatureByTable.set(tableId, signature);
    if (lastSignatureByTable.size > MAX_TRACKED_TABLES) {
      const oldest = lastSignatureByTable.keys().next().value;
      if (oldest !== undefined) lastSignatureByTable.delete(oldest);
    }

    try {
      window.postMessage({
        source: 'baccarat-bridge-runtime-state',
        url: location.href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify(payload),
      }, '*');
    } catch (_) {
      // 页面卸载或扩展被移除时停止本轮上报。
    }
  }

  function readPokerSnapshot(pokerStore, tableKey) {
    const gameStore = pokerStore && pokerStore.gameStore;
    const snapshot = (gameStore && gameStore.gameSnapshot) || (pokerStore && pokerStore.snapshot);
    if (snapshot) {
      postSnapshot(gameStore || pokerStore || { vid: tableKey }, snapshot);
      return;
    }

    const playerCards = pokerStore && (pokerStore.playerPoker || pokerStore.pDataQue || []);
    const bankerCards = pokerStore && (pokerStore.bankerPoker || pokerStore.bDataQue || []);
    const roundId = pokerStore && (pokerStore.gmcode || pokerStore.gameCode)
      || gameStore && gameStore.gmcode;
    if (!roundId) return;
    postSnapshot(pokerStore || { vid: tableKey }, {
      gmtype: 'BAC',
      gmcode: String(roundId),
      gmstatus: Number.isFinite(Number(pokerStore && (pokerStore.gameStatus ?? pokerStore.gmstatus)))
        ? Number(pokerStore.gameStatus ?? pokerStore.gmstatus) : null,
      pval: Number.isFinite(Number(pokerStore && (pokerStore.playerScore ?? pokerStore.pScore)))
        ? Number(pokerStore.playerScore ?? pokerStore.pScore) : null,
      bval: Number.isFinite(Number(pokerStore && (pokerStore.bankerScore ?? pokerStore.bScore)))
        ? Number(pokerStore.bankerScore ?? pokerStore.bScore) : null,
      pcard: playerCards,
      bcard: bankerCards,
    });
  }

  function scanHashMap(map, selectedTableIds, visibleTableIds) {
    if (!map) return;
    const visit = (pokerStore, tableKey) => {
      const tableId = tableIdOf(pokerStore, tableKey);
      if (!tableId || !isVisibleTable(tableId, visibleTableIds)) return;
      selectedTableIds.add(tableId);
      readPokerSnapshot(pokerStore, tableKey);
    };
    if (Array.isArray(map.keys) && typeof map.get === 'function') {
      for (const tableKey of map.keys.slice()) visit(map.get(tableKey), tableKey);
    } else if (typeof map.forEach === 'function') {
      map.forEach(visit);
    }
  }

  function scanGameStoreMap(map, selectedTableIds, visibleTableIds) {
    if (!map) return;
    const visit = (gameStore, tableKey) => {
      const tableId = tableIdOf(gameStore, tableKey);
      if (!tableId || !isVisibleTable(tableId, visibleTableIds)) return;
      selectedTableIds.add(tableId);
      const snapshot = gameStore && gameStore.gameSnapshot;
      if (snapshot) postSnapshot(gameStore, snapshot);
    };
    if (Array.isArray(map.keys) && typeof map.get === 'function') {
      for (const tableKey of map.keys.slice()) visit(map.get(tableKey), tableKey);
    } else if (typeof map.forEach === 'function') {
      map.forEach(visit);
    }
  }

  function scanStores() {
    try {
      const selectedTableIds = new Set();
      // 大厅多桌牌面实际保存在 RoadStoreFactory 的 pokerStoreMap 中。
      // 每个 pokerStore 都持有对应 gameStore.gameSnapshot，PC 大厅无需进入单桌也会更新。
      const videoGameCore = globalThis.VideoGameCore;
      const visibleTableIds = visibleTableIdSet(videoGameCore);
      if (visibleTableIds !== null) postSelection(Array.from(visibleTableIds));
      const roadStoreMap = videoGameCore
        && videoGameCore.RoadStoreFactory
        && videoGameCore.RoadStoreFactory.instance
        && videoGameCore.RoadStoreFactory.instance.pokerStoreMap;
      // 站点使用 Core.HashMap：键保存在 keys 数组中，不提供原生 Map.size。
      scanHashMap(roadStoreMap, selectedTableIds, visibleTableIds);

      // 多桌 Live/GameLink 页面使用另一套 StoreFactory，优先扫描它以覆盖同时监控的多桌。
      const liveFactory = videoGameCore
        && videoGameCore.Live
        && videoGameCore.Live.StoreFactory
        && videoGameCore.Live.StoreFactory.instance;
      scanHashMap(liveFactory && liveFactory.pokerStoreMap, selectedTableIds, visibleTableIds);

      // GameLink 多桌模式使用 LinkStoreFactory 保存四桌的 socket/gameStore。
      const linkFactory = videoGameCore
        && videoGameCore.LinkStoreFactory
        && videoGameCore.LinkStoreFactory.instance;
      scanHashMap(linkFactory && linkFactory.pokerStoreMap, selectedTableIds, visibleTableIds);
      scanGameStoreMap(linkFactory && linkFactory.singleSocketGameStoreMap, selectedTableIds, visibleTableIds);

      // 进入单桌后的 GameBac store 继续作为补充来源。
      const gameBac = globalThis.GameBac;
      const stores = gameBac && gameBac.GameStore && Array.isArray(gameBac.GameStore.list)
        ? gameBac.GameStore.list
        : [];
      for (const store of stores) {
        const tableId = tableIdOf(store, '');
        if (!tableId || !isVisibleTable(tableId, visibleTableIds)) continue;
        selectedTableIds.add(tableId);
        const snapshot = store && store.gameSnapshot;
        if (snapshot) postSnapshot(store, snapshot);
      }

      // 单桌/当前索引兜底。部分版本不公开完整 GameStore.list，
      // 但 PokerStore.instance 始终持有当前 gameStore 与 snapshot。
      const pokerStore = gameBac && gameBac.PokerStore && gameBac.PokerStore.instance;
      const activeStore = pokerStore && pokerStore.gameStore;
      const activeTableId = tableIdOf(activeStore, pokerStore && pokerStore.vid);
      const activeSnapshot = pokerStore && pokerStore.snapshot;
      if (activeTableId && isVisibleTable(activeTableId, visibleTableIds)) {
        selectedTableIds.add(activeTableId);
        if (activeStore && activeSnapshot) postSnapshot(activeStore, activeSnapshot);
      }
      postSelection(visibleTableIds === null ? Array.from(selectedTableIds) : Array.from(visibleTableIds));
    } catch (_) {
      // 运行时尚未加载完成或正在切桌；下一轮继续探测。
    }
  }

  function replayCurrentRuntimeState() {
    lastSelectionSignature = null;
    lastSignatureByTable.clear();
    scanStores();
  }

  function runtimeDiagnostics() {
    const videoGameCore = globalThis.VideoGameCore;
    const factory = videoGameCore && videoGameCore.RoadStoreFactory && videoGameCore.RoadStoreFactory.instance;
    const roadStoreMap = factory && factory.pokerStoreMap;
    const liveFactory = videoGameCore
      && videoGameCore.Live
      && videoGameCore.Live.StoreFactory
      && videoGameCore.Live.StoreFactory.instance;
    const linkFactory = videoGameCore
      && videoGameCore.LinkStoreFactory
      && videoGameCore.LinkStoreFactory.instance;
    const gameLinkStore = videoGameCore
      && videoGameCore.GameLinkStore
      && videoGameCore.GameLinkStore.instance;
    const gameBac = globalThis.GameBac;
    return {
      videoGameCore: typeof videoGameCore,
      roadStoreFactory: Boolean(factory),
      roadStoreMap: roadStoreMap && roadStoreMap.constructor ? roadStoreMap.constructor.name : typeof roadStoreMap,
      roadStoreCount: roadStoreMap && Array.isArray(roadStoreMap.keys)
        ? roadStoreMap.keys.length
        : roadStoreMap && Number.isFinite(Number(roadStoreMap.size)) ? Number(roadStoreMap.size) : null,
      roadStoreKeys: roadStoreMap && Array.isArray(roadStoreMap.keys) ? roadStoreMap.keys.slice(0, 20) : [],
      liveStoreFactory: Boolean(videoGameCore && videoGameCore.Live && videoGameCore.Live.StoreFactory && videoGameCore.Live.StoreFactory.instance),
      liveStoreKeys: liveFactory && liveFactory.pokerStoreMap && Array.isArray(liveFactory.pokerStoreMap.keys)
        ? liveFactory.pokerStoreMap.keys.slice(0, 20) : [],
      linkStoreFactory: Boolean(videoGameCore && videoGameCore.LinkStoreFactory && videoGameCore.LinkStoreFactory.instance),
      linkPokerStoreKeys: linkFactory && linkFactory.pokerStoreMap && Array.isArray(linkFactory.pokerStoreMap.keys)
        ? linkFactory.pokerStoreMap.keys.slice(0, 20) : [],
      linkGameStoreKeys: linkFactory && linkFactory.singleSocketGameStoreMap && Array.isArray(linkFactory.singleSocketGameStoreMap.keys)
        ? linkFactory.singleSocketGameStoreMap.keys.slice(0, 20) : [],
      gameLinkVisibleVids: gameLinkStore && Array.isArray(gameLinkStore.visibleVids)
        ? gameLinkStore.visibleVids.slice(0, 20) : [],
      liveStoreVids: videoGameCore && videoGameCore.Live && videoGameCore.Live.LiveStore && videoGameCore.Live.LiveStore.instance
        ? videoGameCore.Live.LiveStore.instance.vids || [] : [],
      gameBac: typeof gameBac,
      gameStoreList: gameBac && gameBac.GameStore && Array.isArray(gameBac.GameStore.list)
        ? gameBac.GameStore.list.length
        : null,
    };
  }

  function postRuntimeDiagnostics() {
    window.postMessage({
      source: 'baccarat-bridge-runtime-diagnostic',
      url: location.href,
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify(runtimeDiagnostics()),
    }, '*');
  }

  try {
    window.__baccaratRuntimeStateHookReplay = replayCurrentRuntimeState;
    window.__baccaratRuntimeStateHookDiagnostics = runtimeDiagnostics;
  } catch (_) {
    // 页面冻结或卸载时忽略桥接重放请求。
  }

  setInterval(scanStores, POLL_INTERVAL_MS);
  scanStores();

  // 一次性只读自检：若站点版本调整了 store 结构，桥端能直接看到实际运行时形态。
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      try {
        postRuntimeDiagnostics();
      } catch (_) {
        // 自检不影响实时采集。
      }
    }, 5000);
  }
})();
