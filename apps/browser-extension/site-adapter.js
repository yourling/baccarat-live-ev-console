/**
 * 真实游戏平台站点适配器。
 *
 * 拿到目标域名后，在这里填写：
 * - matches：匹配的目标页面
 * - extractRooms：从 DOM 抽取房间/桌台列表
 * - extractTableEvent：从 DOM 抽取一条牌桌事件（必须返回 NormalizedEvent 或 null）
 * - executeBet：执行真实下注，返回 BetReceipt 或 null
 *
 * 当前是占位实现，不绑定任何具体网站。
 */
(function () {
  const adapter = {
    id: 'placeholder',
    matches: ['https://example.com/*'],

    // TODO(platform): 填写目标站点的选择器
    roomSelector: '.room',
    tableSelector: '.table',

    extractRooms(doc) {
      // TODO(platform): 返回 [{ roomId, displayName?, tables: [{ tableId, profile?, monitorUrl? }] }]
      return [];
    },

    // TODO(platform): 返回保活时要点击的元素（如右下角“对局记录表”按钮，
    // 点击一次放大、再点一次缩小，content script 会自动双击恢复原状）。
    // 返回 null/undefined 时 content script 使用右下角启发式兜底。
    getKeepAliveTargets(doc) {
      return null;
    },

    extractTableEvent(doc, tableId) {
      // TODO(platform): 返回 contracts.NormalizedEvent 形状，或 null
      return null;
    },

    executeBet(doc, request) {
      // TODO(platform): 根据 BetExecutionRequest 点击/调用真实下注并返回 BetReceipt
      return null;
    },
  };

  globalThis.BaccaratSiteAdapter = adapter;
})();
