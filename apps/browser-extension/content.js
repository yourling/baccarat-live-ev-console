/**
 * Content Script：从真实页面抽取房间/牌桌数据，转发网络诊断，
 * 执行会话保活与“会话已过期”自动恢复，并执行来自后台的真实下注请求。
 *
 * 保活分四层，全部通过 sessionAction/keepalive 消息上报到桥接服务以便观测：
 *  1. 合成 DOM 活动（mousemove/focus/scroll）——对 isTrusted 检测无效，但零成本；
 *  2. 同源网络信标（HEAD/GET）——真实 HTTP 请求，重置多数站点的服务端闲置计时；
 *  3. 对局记录按钮双击（点击一次放大、再点一次缩小，恢复原状）——触发站点真实点击处理器；
 *  4. background 可选 CDP 可信点击（storage.trustedKeepalive=true 时）。
 *
 * 过期恢复：检测到“会话已过期”文案后，先上报并标记牌桌断开，
 * 然后按 5s/15s/45s 退避自动 reload（每轮最多 3 次，sessionStorage 标记跨刷新计数）。
 * 一轮耗尽后上报 recovery-failed，并按 1m/5m/15m/30m（封顶）持续监督重试；
 * 恢复只上报 sessionAction:recovered，绝不伪造 tableRestored 或连续性证明。
 */
(function () {
  const SCAN_INTERVAL_MS = 2000;
  const KEEPALIVE_INTERVAL_MS = 30 * 1000;
  const MAX_RECOVERY_ATTEMPTS = 3;
  const RECOVERY_DELAYS_MS = [5 * 1000, 15 * 1000, 45 * 1000];
  const SUPERVISORY_RECOVERY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
  const RECOVERY_CHECK_DELAY_MS = 8 * 1000;
  const RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;
  const RECOVERY_FLAG_KEY = 'baccarat-bridge-recovering';
  const RECOVERY_SUPERVISOR_KEY = 'baccarat-bridge-recovery-supervisor';
  const CLICK_REPORT_INTERVAL_MS = 5 * 60 * 1000;

  // 只在游戏相关页面上工作:其他页面(控制台/搜索引擎/追踪器)不采集、不保活、不发心跳。
  const PRAGMATIC_PAGE = /(?:^|\.)(?:pragmaticplaylive\.net|vbgames88\.com|zavjcswh\.biz)$/i.test(location.hostname);
  const GAME_PAGE = /(?:^|\.)(?:pragmaticplaylive\.net|vbgames88\.com|zavjcswh\.biz|dafabet\.net)$/i.test(location.hostname);

  const knownRooms = new Map();
  let diagnosticSent = false;
  let sessionExpiredSent = false;
  let beaconFailedSent = false;
  let recoveryAttempts = 0;
  let recoveryTimer = null;
  let recoveryCheckTimer = null;
  let inlineCheckTimer = null;
  let supervisoryRecoveryTimer = null;
  let supervisoryRecoveryAttempts = 0;
  let triedInlineRecovery = false;
  let lastHealthyAt = Date.now();
  let lastClickReportAt = 0;
  let betInFlight = 0;
  const betFrameRectResponses = new Map();
  const betFrameRectChildren = new Map();

  function frameKind() {
    return window.top === window ? 'top' : 'iframe';
  }

  function isHttpPage() {
    return /^https?:$/.test(location.protocol);
  }

  function sendToBackground(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (_) {
      // 扩展被卸载或后台不可用时忽略。
    }
  }

  function sendSessionAction(action, detail) {
    sendToBackground({
      kind: 'sessionAction',
      action,
      url: location.href,
      frame: frameKind(),
      timestamp: new Date().toISOString(),
      ...(detail ? { detail: String(detail).slice(0, 120) } : {}),
    });
  }

  function sendDiagnostic() {
    const bodyText = document.body ? document.body.innerText : '';
    const htmlLength = document.documentElement
      ? document.documentElement.outerHTML.length
      : 0;
    sendToBackground({
      kind: 'diagnostic',
      url: location.href,
      frame: frameKind(),
      readyState: document.readyState,
      titleLength: String(document.title || '').length,
      bodyTextLength: bodyText.length,
      htmlLength,
      candidateCount: document.querySelectorAll(
        '[class*="room"],[id*="room"],[class*="table"],[id*="table"],[class*="game"],[id*="game"]'
      ).length,
      canvasCount: document.querySelectorAll('canvas').length,
      videoCount: document.querySelectorAll('video').length,
      iframeCount: document.querySelectorAll('iframe').length,
    });
  }

  // ---- 保活层 1：合成 DOM 活动 + 通知 MAIN world 重放 WS 心跳 ----

  function jitterDomActivity() {
    const x = Math.floor(Math.random() * 400) + 80;
    const y = Math.floor(Math.random() * 300) + 80;
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: x,
      clientY: y,
    }));
    window.dispatchEvent(new Event('focus'));
    window.scrollBy(0, 1);
    window.scrollBy(0, -1);
    // 通知 MAIN world 的 pragmatic-network-hook 重放已捕获的心跳消息。
    window.postMessage({ source: 'baccarat-bridge-keepalive' }, '*');
  }

  // ---- 保活层 2：同源网络信标（真实 HTTP 请求） ----

  function sendBeaconRequest() {
    if (!isHttpPage() || typeof fetch !== 'function') return;
    fetch(location.origin + '/', { method: 'HEAD', credentials: 'include', cache: 'no-store', redirect: 'follow' })
      .then(response => {
        if (!response.ok) {
          return fetch(location.origin + '/', { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow' });
        }
        return response;
      })
      .catch(() => {
        if (beaconFailedSent) return;
        beaconFailedSent = true;
        sendSessionAction('beacon-failed', 'fetch to ' + location.origin + '/ failed');
      });
  }

  // ---- 保活层 3：对局记录按钮双击（点击一次放大、再点一次缩小） ----

  function isVisibleElement(el) {
    if (!el || !el.getBoundingClientRect || !window.getComputedStyle) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
  }

  /**
   * 平台适配器可提供精确选择器（getKeepAliveTargets）；未提供时用右下角启发式兜底：
   * 找窗口右下区域、尺寸像图标、文案/类名像“对局记录”的可点击元素。
   */
  function guessRecordButton(doc) {
    const vw = (doc.documentElement && doc.documentElement.clientWidth) || window.innerWidth || 1280;
    const vh = (doc.documentElement && doc.documentElement.clientHeight) || window.innerHeight || 720;
    const scored = [];
    const candidates = doc.querySelectorAll('button, a, [role="button"], div, span, svg, i');
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.width > 160 || rect.height > 160) continue;
      if (rect.left < vw * 0.55 || rect.top < vh * 0.4) continue;
      const text = String(el.textContent || el.innerText || '').slice(0, 40);
      const className = typeof el.className === 'string' ? el.className : '';
      const label = text + ' ' + className + ' ' + String(el.id || '');
      let score = 0;
      if (/记录|战绩|报表|路单|回放|开奖|历史|history|record|road|bead|result|report|chart|stats/i.test(label)) score += 3;
      if (/button|btn|click|toggle|icon/i.test(label)) score += 1;
      if (/菜单|退出|下注|投注|bet|menu|logout|help|客服|设置|setting/i.test(label)) score -= 5;
      scored.push({ el, score, corner: (vw - rect.right) + (vh - rect.bottom) });
    }
    scored.sort((a, b) => b.score - a.score || a.corner - b.corner);
    const best = scored[0];
    return best && best.score >= 2 ? [best.el] : [];
  }

  function firstKeepAliveTarget(doc) {
    const adapter = globalThis.BaccaratSiteAdapter;
    if (adapter && typeof adapter.getKeepAliveTargets === 'function') {
      try {
        const targets = adapter.getKeepAliveTargets(doc);
        if (targets && targets.length) return targets[0];
      } catch (_) {
        // 适配器异常时走启发式兜底。
      }
    }
    return guessRecordButton(doc)[0] || null;
  }

  function clickKeepAliveTarget(doc) {
    try {
      const el = firstKeepAliveTarget(doc);
      if (!el || !isVisibleElement(el)) return;
      // 双击恢复原状：该按钮点击一次放大、再点一次缩小。
      el.click();
      setTimeout(() => {
        try {
          if (el.isConnected && isVisibleElement(el)) el.click();
        } catch (_) {
          // ignore
        }
      }, 300);
      const now = Date.now();
      if (now - lastClickReportAt > CLICK_REPORT_INTERVAL_MS) {
        lastClickReportAt = now;
        sendSessionAction(
          'keepalive-click',
          (String(el.innerText || el.textContent || '').slice(0, 20) || String(el.tagName)) + ' @ ' + rectText(el)
        );
      }
    } catch (_) {
      // ignore
    }
  }

  function rectText(el) {
    try {
      const r = el.getBoundingClientRect();
      return Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
    } catch (_) {
      return '';
    }
  }

  function keepAliveTick() {
    try {
      if (isPragmaticGameContainer()) return;
      jitterDomActivity();
      sendBeaconRequest();
      clickKeepAliveTarget(document);
      const el = firstKeepAliveTarget(document);
      sendToBackground({
        kind: 'keepalive',
        url: location.href,
        frame: frameKind(),
        timestamp: new Date().toISOString(),
        // 所有帧上报自身视口尺寸,供后台按“校准点”合成可信点击坐标。
        ...(isHttpPage() ? { vw: window.innerWidth || 0, vh: window.innerHeight || 0 } : {}),
        ...(el && isVisibleElement(el) ? { target: targetRect(el) } : {}),
      });
    } catch (_) {
      // 页面卸载或异常时忽略。
    }
  }

  function targetRect(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function startKeepAlive() {
    setInterval(keepAliveTick, KEEPALIVE_INTERVAL_MS);
  }

  // ---- 闲置警告弹窗自动处理（预过期提醒，如“长时间未操作，是否继续”） ----

  function isIdleWarningText(text) {
    return /长时间未操作|您已离开|即将退出|即将过期|会话即将|超时提示|inactiv|still\s+there|about\s+to\s+expire|session\s+is\s+about/i.test(text);
  }

  function isInsideDialog(el) {
    try {
      return !!el.closest(
        '[role="dialog"],[role="alertdialog"],[class*="dialog"],[class*="modal"],[class*="popup"],[class*="layer"],[class*="mask"],[class*="overlay"],[class*="toast"],[class*="notice"],[class*="alert"],[class*="tip"]'
      );
    } catch (_) {
      return false;
    }
  }

  function dismissIdleDialog() {
    if (betInFlight > 0) return;
    const strong = [];
    const fallback = [];
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const text = String(el.innerText || el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      if (/退出|注销|登出|切换账号|下注|投注|确认下注|log\s*out|sign\s*out|exit|place\s*\w*\s*bet/i.test(text)) continue;
      if (/继续游戏|仍要继续|保持登录|保持在线|我还在|stay|continue|resume|keep\s*me\s*logged|i'?m\s*still/i.test(text)) {
        strong.push(el);
      } else if (isInsideDialog(el) && /继续|确定|好的|知道了|ok|confirm/i.test(text)) {
        fallback.push(el);
      }
    }
    for (const el of strong.concat(fallback)) {
      if (!isVisibleElement(el)) continue;
      try {
        el.click();
      } catch (_) {
        continue;
      }
      sendSessionAction('idle-dialog-dismissed', String(el.innerText || el.textContent || '').trim().slice(0, 40));
      return;
    }
  }

  // ---- 会话过期检测与自动恢复 ----

  function isSessionExpiredText(text) {
    return /会话已过期|会话已经过期|再次登录|重新登录|session\s+(has\s+|may\s+be\s+|is\s+)?expired|authentication\s+failed/i.test(text);
  }

  /** 收集按钮,穿透开放 Shadow Root（客户端可能用 shadow DOM 渲染弹窗）。 */
  function collectClickables(root, out, depth) {
    try {
      for (const el of root.querySelectorAll('button, a, [role="button"]')) out.push(el);
      if (depth <= 0) return;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collectClickables(el.shadowRoot, out, depth - 1);
      }
    } catch (_) {
      // ignore
    }
  }

  /** 点击 EV.7 弹窗里的 “Try again / 重试” 按钮:原地重新认证,比重载页面更轻。 */
  function clickTryAgain() {
    if (betInFlight > 0) return false;
    const all = [];
    collectClickables(document, all, 6);
    const candidates = [];
    for (const el of all) {
      const text = String(el.innerText || el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      if (/try\s+again|retry|reconnect|重试|重新尝试|再次尝试|重新连接|重新加载/i.test(text)) {
        candidates.push(el);
      }
    }
    for (const el of candidates) {
      if (!isVisibleElement(el)) continue;
      try {
        el.click();
      } catch (_) {
        continue;
      }
      sendSessionAction('inline-recovery-click', String(el.innerText || el.textContent || '').trim().slice(0, 40));
      return true;
    }
    return false;
  }

  function notifyTablesDisconnected(reason) {
    for (const room of knownRooms.values()) {
      for (const table of room.tables || []) {
        if (!table || !table.tableId) continue;
        sendToBackground({
          kind: 'tableDisconnected',
          roomId: room.roomId,
          tableId: table.tableId,
          reason,
        });
      }
    }
  }

  function checkSessionExpired(bodyText) {
    if (!isSessionExpiredText(bodyText)) {
      lastHealthyAt = Date.now();
      return;
    }
    if (!sessionExpiredSent) {
      sessionExpiredSent = true;
      sendToBackground({
        kind: 'sessionExpired',
        url: location.href,
        frame: frameKind(),
        textLength: bodyText.length,
        recovering: recoveryAttempts > 0,
        timestamp: new Date().toISOString(),
      });
      notifyTablesDisconnected('game-session-expired');
    }
    maybeRecoverSession();
  }

  /** 调度一次整页 reload(退避 + 跨刷新计数),不经过原地重试判断。 */
  function scheduleRecoveryReload() {
    if (recoveryTimer) return;
    // 页面健康超过冷却期后又过期，视为新一轮过期，重新计数。
    if (Date.now() - lastHealthyAt > RECOVERY_COOLDOWN_MS) recoveryAttempts = 0;
    if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      scheduleSupervisoryRecovery();
      return;
    }
    const delay = RECOVERY_DELAYS_MS[Math.min(recoveryAttempts, RECOVERY_DELAYS_MS.length - 1)];
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      recoveryAttempts += 1;
      try {
        sessionStorage.setItem(RECOVERY_FLAG_KEY, String(recoveryAttempts));
      } catch (_) {
        // sessionStorage 不可用时仍尝试恢复，只是计数不跨刷新。
      }
      sendToBackground({
        kind: 'sessionAction',
        action: 'reload-scheduled',
        attempt: recoveryAttempts,
        url: location.href,
        frame: frameKind(),
        timestamp: new Date().toISOString(),
      });
      if (window.top === window) {
        location.reload();
      }
      // iframe 帧:不自行 reload(会把游戏框跳去 entry 页),
      // 后台收到 reload-scheduled(frame!==top)后刷新整个标签页。
    }, delay);
  }

  function isPragmaticGameContainer() {
    if (/(^|\.)client\.pragmaticplaylive\.net$/i.test(location.hostname)) return true;
    if (/\/live-dealer\/popup-launch\/jeju-speed-baccarat(?:[/?#]|$)/i.test(location.pathname)) return true;
    try {
      return Array.from(document.querySelectorAll('iframe[src]')).some(frame =>
        /(?:^|\.)pragmaticplaylive\.net$/i.test(new URL(frame.src, location.href).hostname));
    } catch (_) {
      return false;
    }
  }

  function clearSupervisoryRecovery() {
    if (supervisoryRecoveryTimer) {
      clearTimeout(supervisoryRecoveryTimer);
      supervisoryRecoveryTimer = null;
    }
    supervisoryRecoveryAttempts = 0;
    try {
      sessionStorage.removeItem(RECOVERY_SUPERVISOR_KEY);
    } catch (_) {
      // ignore
    }
  }

  function scheduleSupervisoryRecovery() {
    if (supervisoryRecoveryTimer) return;
    const delay = SUPERVISORY_RECOVERY_DELAYS_MS[
      Math.min(supervisoryRecoveryAttempts, SUPERVISORY_RECOVERY_DELAYS_MS.length - 1)
    ];
    supervisoryRecoveryAttempts += 1;
    try {
      sessionStorage.setItem(RECOVERY_SUPERVISOR_KEY, String(supervisoryRecoveryAttempts));
    } catch (_) {
      // sessionStorage 不可用时仍在当前页面继续监督重试。
    }
    supervisoryRecoveryTimer = setTimeout(() => {
      supervisoryRecoveryTimer = null;
      recoveryAttempts = 0;
      triedInlineRecovery = true;
      scheduleRecoveryReload();
    }, delay);
  }

  /** 原地重试点击 6 秒后判定:已恢复则复位上报,仍过期则升级为 reload。 */
  function scheduleInlineCheck() {
    inlineCheckTimer = setTimeout(() => {
      inlineCheckTimer = null;
      const bodyText = document.body ? document.body.innerText : '';
      if (!isSessionExpiredText(bodyText)) {
        recoveryAttempts = 0;
        triedInlineRecovery = false;
        sessionExpiredSent = false;
        clearSupervisoryRecovery();
        sendSessionAction('recovered', 'inline try-again');
        return;
      }
      scheduleRecoveryReload();
    }, 6000);
  }

  function maybeRecoverSession() {
    // 刚 reload 完的页面先等 finishRecoveryCheck 判定，避免双重调度。
    if (recoveryCheckTimer || recoveryTimer || inlineCheckTimer) return;
    if (betInFlight > 0) {
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        maybeRecoverSession();
      }, 10 * 1000);
      return;
    }
    // 优先原地重试(EV.7 的 “Try again” 按钮会重新认证,无需整页刷新)。
    if (!triedInlineRecovery && clickTryAgain()) {
      triedInlineRecovery = true;
      scheduleInlineCheck();
      return;
    }
    triedInlineRecovery = true;
    scheduleRecoveryReload();
  }

  /** reload 后 8 秒判定恢复结果:仍过期则先试原地重试按钮,再升级下一轮 reload。 */
  function finishRecoveryCheck() {
    recoveryCheckTimer = null;
    try {
      sessionStorage.removeItem(RECOVERY_FLAG_KEY);
    } catch (_) {
      // ignore
    }
    const bodyText = document.body ? document.body.innerText : '';
    if (!isSessionExpiredText(bodyText)) {
      recoveryAttempts = 0;
      triedInlineRecovery = false;
      sessionExpiredSent = false;
      clearSupervisoryRecovery();
      sendSessionAction('recovered');
      return;
    }
    if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      sendSessionAction('recovery-failed', 'still expired after ' + recoveryAttempts + ' reload attempts');
      scheduleSupervisoryRecovery();
      return;
    }
    if (!triedInlineRecovery && clickTryAgain()) {
      triedInlineRecovery = true;
      scheduleInlineCheck();
      return;
    }
    triedInlineRecovery = true;
    scheduleRecoveryReload();
  }

  // ---- 扫描主循环 ----

  function scan() {
    const bodyText = document.body ? document.body.innerText : '';
    checkSessionExpired(bodyText);
    if (isIdleWarningText(bodyText)) dismissIdleDialog();

    if (!diagnosticSent) {
      diagnosticSent = true;
      sendDiagnostic();
      setTimeout(sendDiagnostic, 3000);
      setTimeout(sendDiagnostic, 8000);
    }

    const adapter = globalThis.BaccaratSiteAdapter;
    if (!adapter || typeof adapter.extractRooms !== 'function') return;

    const rooms = adapter.extractRooms(document) || [];
    for (const room of rooms) {
      if (!room || !room.roomId) continue;
      knownRooms.set(room.roomId, room);
      sendToBackground({
        kind: 'roomDiscovered',
        room,
      });

      for (const table of room.tables || []) {
        if (!table || !table.tableId) continue;
        const event = adapter.extractTableEvent(document, table.tableId);
        if (event) {
          sendToBackground({
            kind: 'tableEvent',
            roomId: room.roomId,
            tableId: table.tableId,
            event,
          });
        }
      }
    }

    sendToBackground({ kind: 'heartbeat', timestamp: new Date().toISOString() });
  }

  // 接收 MAIN world pragmatic-network-hook 发来的网络数据。
  window.addEventListener('message', event => {
    if (!GAME_PAGE || event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data.source !== 'string' || !data.source.startsWith('baccarat-bridge-')) return;
    const url = String(data.url || '');
    const isGameProtocol = data.source === 'baccarat-bridge-pragmatic-ws'
      || data.source === 'baccarat-bridge-pragmatic-state'
      || /pragmaticplaylive\.net\/game/i.test(url);
    if (!isGameProtocol) return;
    if (data.encoding === 'base64') return;
    const text = String(data.data || '');
    if (!text || text.length > 16_384) return;
    sendToBackground({
      kind: 'networkCapture',
      source: data.source,
      url,
      direction: data.direction || 'recv',
      encoding: 'text',
      data: text,
    });
  });

  if (PRAGMATIC_PAGE) {
    window.postMessage({ source: 'baccarat-bridge-pragmatic-network-ready' }, '*');
    try {
      void chrome.storage.local.get(
        ['pragmaticLpBetTemplate', 'pragmaticLpBetUserId', 'pragmaticLpBetGm'],
        items => {
          window.postMessage({
            source: 'baccarat-bridge-pragmatic-restore-bet-template',
            template: items && items.pragmaticLpBetTemplate,
            uId: items && items.pragmaticLpBetUserId,
            gm: items && items.pragmaticLpBetGm,
          }, '*');
        },
      );
    } catch (_) {}
  }

  // MAIN world 上报的 WebSocket 断开:静默掉线的可观测信号。
  window.addEventListener('message', event => {
    if (!GAME_PAGE || event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'baccarat-bridge-ws-closed') return;
    sendSessionAction('socket-closed', String(data.url || '').split('?')[0].slice(0, 100));
  });

  // 后台下发的校准武装指令:立即开始捕获下一次真实点击。
  chrome.runtime.onMessage.addListener(message => {
    if (message && message.kind === 'armCalibration') {
      armCalibrationCapture();
    }
  });

  function validBetFrameRect(value) {
    return value
      && typeof value === 'object'
      && [value.x, value.y, value.width, value.height, value.viewportWidth, value.viewportHeight]
        .every(Number.isFinite)
      && value.width > 0
      && value.height > 0
      && value.viewportWidth > 0
      && value.viewportHeight > 0;
  }

  function relayBetFrameRect(token, value) {
    if (window.top === window) return false;
    window.parent.postMessage({
      source: 'baccarat-bridge-bet-frame-rect',
      kind: 'request',
      token,
      rect: value,
    }, '*');
    return true;
  }

  // CDP receives coordinates in the top-level viewport. Relay a target frame's
  // local point through every iframe owner so nested, cross-origin games remain exact.
  window.addEventListener('message', event => {
    const data = event.data;
    if (
      !data
      || data.source !== 'baccarat-bridge-bet-frame-rect'
      || typeof data.token !== 'string'
      || !/^[a-z0-9-]{12,100}$/i.test(data.token)
    ) return;
    if (data.kind === 'response') {
      const child = betFrameRectChildren.get(data.token);
      if (child) {
        betFrameRectChildren.delete(data.token);
        child.postMessage(data, '*');
        return;
      }
      const sendResponse = betFrameRectResponses.get(data.token);
      if (!sendResponse) return;
      betFrameRectResponses.delete(data.token);
      sendResponse(data.rect || null);
      return;
    }
    if (data.kind !== 'request' || !validBetFrameRect(data.rect)) return;
    const owner = Array.from(document.querySelectorAll('iframe')).find(
      frame => frame.contentWindow === event.source,
    );
    if (!owner) return;
    const ownerRect = owner.getBoundingClientRect();
    const ownerScaleX = owner.offsetWidth > 0 ? ownerRect.width / owner.offsetWidth : 1;
    const ownerScaleY = owner.offsetHeight > 0 ? ownerRect.height / owner.offsetHeight : 1;
    const contentLeft = ownerRect.left + Number(owner.clientLeft || 0) * ownerScaleX;
    const contentTop = ownerRect.top + Number(owner.clientTop || 0) * ownerScaleY;
    const contentWidth = Math.max(1, Number(owner.clientWidth || ownerRect.width) * ownerScaleX);
    const contentHeight = Math.max(1, Number(owner.clientHeight || ownerRect.height) * ownerScaleY);
    const childScaleX = contentWidth / data.rect.viewportWidth;
    const childScaleY = contentHeight / data.rect.viewportHeight;
    const translated = {
      ...data.rect,
      x: contentLeft + data.rect.x * childScaleX,
      y: contentTop + data.rect.y * childScaleY,
      width: data.rect.width * childScaleX,
      height: data.rect.height * childScaleY,
      viewportWidth: window.innerWidth || document.documentElement.clientWidth || contentWidth,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight || contentHeight,
    };
    betFrameRectChildren.set(data.token, event.source);
    setTimeout(() => betFrameRectChildren.delete(data.token), 5000);
    if (window.top === window) {
      event.source.postMessage({
        source: 'baccarat-bridge-bet-frame-rect',
        kind: 'response',
        token: data.token,
        rect: translated,
      }, '*');
      betFrameRectChildren.delete(data.token);
      return;
    }
    relayBetFrameRect(data.token, translated);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.kind !== 'resolveBetFrameRect') return;
    if (typeof message.token !== 'string' || !validBetFrameRect(message.rect)) {
      sendResponse(null);
      return;
    }
    if (window.top === window) {
      sendResponse(message.rect);
      return;
    }
    betFrameRectResponses.set(message.token, sendResponse);
    setTimeout(() => {
      const pending = betFrameRectResponses.get(message.token);
      if (!pending) return;
      betFrameRectResponses.delete(message.token);
      pending(null);
    }, 5000);
    relayBetFrameRect(message.token, message.rect);
    return true;
  });

  // 后台询问游戏 iframe 在顶层页面里的位置(用于合成 CDP 可信点击的绝对坐标)。
  // 只有顶层帧应答;iframe 帧不应答,避免竞态。
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.kind !== 'getIframeRect') return;
    if (window.top !== window) return;
    let rect = null;
    let bestArea = 0;
    for (const frame of document.querySelectorAll('iframe')) {
      let src = '';
      try {
        src = String(frame.src || '');
      } catch (_) {
        src = '';
      }
      if (!/pragmaticplaylive\.net|vbgames88\.com|zavjcswh\.biz/i.test(src)) continue;
      const r = frame.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) continue;
      const area = r.width * r.height;
      if (area <= bestArea) continue;
      bestArea = area;
      rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    sendResponse(rect);
    return true;
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.kind !== 'executeBet') return;
    const executor = globalThis.BaccaratBetExecutor;
    if (!executor || typeof executor.execute !== 'function') {
      sendResponse({
        kind: 'betResult',
        requestId: message.requestId,
        receipt: null,
        error: 'no bet executor available',
      });
      return;
    }

    betInFlight += 1;
    executor.execute(message.request)
      .then(receipt => {
        sendResponse({
          kind: 'betResult',
          requestId: message.requestId,
          receipt,
        });
      })
      .catch(error => {
        sendResponse({
          kind: 'betResult',
          requestId: message.requestId,
          receipt: null,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        betInFlight -= 1;
      });
    return true;
  });

  // 校准模式:捕获用户下一次“真实点击”的位置(相对所在帧视口的比例),
  // 作为以后 CDP 可信点击的固定目标点。一次性,点完即存即关。
  // 可通过远程指令 armCalibration 随时武装,不必重载页面。
  let calibrationArmed = false;
  let calibrationBanner = null;
  function showCalibrationBanner() {
    if (calibrationBanner || window.top !== window) return; // 横幅只在顶层显示,避免遮挡游戏内嵌框
    calibrationBanner = document.createElement('div');
    calibrationBanner.textContent = '校准模式:请点击一次「游戏历史记录」按钮';
    calibrationBanner.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#c62828;color:#fff;padding:6px 16px;font-size:14px;border-radius:0 0 8px 8px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4);';
    (document.body || document.documentElement).appendChild(calibrationBanner);
  }
  function hideCalibrationBanner() {
    if (calibrationBanner && calibrationBanner.isConnected) calibrationBanner.remove();
    calibrationBanner = null;
  }
  function armCalibrationCapture() {
    if (calibrationArmed) return;
    calibrationArmed = true;
    sendToBackground({
      kind: 'sessionAction',
      action: 'command-executed',
      url: location.href,
      frame: frameKind(),
      detail: 'calibrate-armed:' + frameKind(),
      timestamp: new Date().toISOString(),
    });
    showCalibrationBanner();
    const onClick = event => {
      if (!event.isTrusted) return;
      document.removeEventListener('click', onClick, true);
      hideCalibrationBanner();
      void chrome.storage.local.remove('cdpCalibrate');
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      sendToBackground({
        kind: 'calibratePoint',
        xp: Number((event.clientX / vw).toFixed(4)),
        yp: Number((event.clientY / vh).toFixed(4)),
        url: location.href,
        frame: frameKind(),
        timestamp: new Date().toISOString(),
      });
    };
    document.addEventListener('click', onClick, true);
  }

  void (async () => {
    try {
      const stored = await chrome.storage.local.get({ cdpCalibrate: false });
      if (stored.cdpCalibrate) armCalibrationCapture();
    } catch (_) {
      // ignore
    }
  })();

  // reload 恢复判定：带恢复标记加载的页面，加载 8 秒后判定是否真正恢复。
  let pendingFlag = null;
  let pendingSupervisorAttempts = null;
  try {
    pendingFlag = sessionStorage.getItem(RECOVERY_FLAG_KEY);
    pendingSupervisorAttempts = sessionStorage.getItem(RECOVERY_SUPERVISOR_KEY);
  } catch (_) {
    pendingFlag = null;
    pendingSupervisorAttempts = null;
  }
  supervisoryRecoveryAttempts = Math.max(0, Number(pendingSupervisorAttempts) || 0);
  if (pendingFlag) {
    recoveryAttempts = Math.max(1, Number(pendingFlag) || 1);
    sessionExpiredSent = true; // 恢复检查期间抑制重复的 sessionExpired 上报
    recoveryCheckTimer = setTimeout(finishRecoveryCheck, RECOVERY_CHECK_DELAY_MS);
  }

  function suppressMedia() {
    if (!PRAGMATIC_PAGE) return;
    try {
      for (const video of document.querySelectorAll('video')) {
        video.muted = true;
        if (!video.paused) video.pause();
      }
    } catch (_) {}
  }

  if (!GAME_PAGE) return; // 非游戏页面:内容脚本保持惰性

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scan();
      suppressMedia();
      startKeepAlive();
      setInterval(scan, SCAN_INTERVAL_MS);
      setInterval(suppressMedia, SCAN_INTERVAL_MS);
    });
  } else {
    scan();
    suppressMedia();
    startKeepAlive();
    setInterval(scan, SCAN_INTERVAL_MS);
    setInterval(suppressMedia, SCAN_INTERVAL_MS);
  }
})();
