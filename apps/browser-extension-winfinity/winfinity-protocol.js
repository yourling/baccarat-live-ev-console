(function (root) {
  const GAME_TYPES = {
    GAME_STATE_CHANGED: true,
    CARDS_TAKEN: true,
    GAME_RESULTS: true,
    TABLES_LIST: true,
    TABLE_SETTINGS_CHANGED: true,
    CURRENT_STATE: true,
  };
  function isWinfinityGameFrame(raw) {
    try {
      const parsed = JSON.parse(String(raw || ''));
      return Boolean(parsed && typeof parsed === 'object' && GAME_TYPES[parsed.type] === true);
    } catch (_) {
      return false;
    }
  }
  function extractStreamId(href) {
    try {
      const value = new URL(String(href || ''), 'https://lobby.youngpoisson.xyz/').searchParams.get('streamId');
      if (!value) return undefined;
      const normalized = String(value).trim().toLowerCase();
      return /^[a-z0-9]+-bac\d+$/.test(normalized) ? normalized : undefined;
    } catch (_) {
      return undefined;
    }
  }
  root.isWinfinityGameFrame = isWinfinityGameFrame;
  root.extractStreamId = extractStreamId;
})(typeof globalThis !== 'undefined' ? globalThis : this);
