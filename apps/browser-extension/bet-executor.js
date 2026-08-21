/**
 * 真实下注执行入口。
 * 当前委托给站点适配器；没有站点适配器时返回 null（视为未执行）。
 */
(function () {
  globalThis.BaccaratBetExecutor = {
    async execute(request) {
      const adapter = globalThis.BaccaratSiteAdapter;
      if (!adapter || typeof adapter.executeBet !== 'function') {
        return null;
      }
      try {
        return await adapter.executeBet(document, request);
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  };
})();
