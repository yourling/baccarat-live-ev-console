/**
 * dom-probe.js — 牌面 DOM 结构探针(隔离世界,只读观测,零注入)
 *
 * 回答一个问题:页面里的扑克牌到底是怎么渲染的?
 *  - 若是 <img src="...">:抓全量 URL(文件名可能直接编码 rank/suit,即数据通道本身);
 *  - 若是 canvas / 背景图:记录容器 class 链与背景样式,供逆向绘制来源。
 *
 * 输出:{kind:'networkCapture', source:'baccarat-bridge-dom', ...} 经后台原样转发到桥。
 * 限频:每秒最多上报 2 条,每条最多 40 个样本,避免刷爆通道。
 */
(function () {
  const CARD_SRC = /(card|poke|\/pai|[shdc](?:[1-9]|1[0-3]|a|j|q|k)\.(png|jpe?g|webp|svg)|\/cards?\/)/i;
  const CARD_CLASS = /(\bcard|poker|poke|playing|fapai|hapai)/i;
  const MAX_PER_REPORT = 40;
  let lastSentAt = 0;
  let pending = new Map(); // src -> {count, cls}

  function frameKind() { return window.top === window ? 'top' : 'iframe'; }

  function flush() {
    const now = Date.now();
    if (pending.size === 0 || now - lastSentAt < 500) return;
    lastSentAt = now;
    const items = [];
    for (const [src, info] of pending) {
      items.push({ src: src.slice(0, 400), cls: info.cls, n: info.n });
      if (items.length >= MAX_PER_REPORT) break;
    }
    for (const [k] of pending) { /* 清空 */ }
    pending = new Map();
    try {
      chrome.runtime.sendMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-dom',
        url: location.href,
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ kind: 'domCards', frame: frameKind(), items }),
      });
    } catch (_) {
      // ignore
    }
  }

  function inspectElement(el) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag === 'IMG') {
      const src = el.currentSrc || el.src || '';
      if (src && CARD_SRC.test(src)) {
        const cls = String(el.className || '').slice(0, 120);
        const cur = pending.get(src) || { cls, n: 0 };
        cur.n += 1; pending.set(src, cur);
        return;
      }
    }
    // 背景 图/非 img 结构
    const cls = String(el.className && typeof el.className === 'string' ? el.className : '');
    if (cls && CARD_CLASS.test(cls)) {
      const bg = '';
      const key = 'BG:' + tag + ':' + cls;
      const cur = pending.get(key) || { cls: (bg + ' ' + cls).trim().slice(0, 200), n: 0 };
      cur.n += 1; pending.set(key, cur);
    }
  }

  function scanRoot(root) {
    try {
      if (root.querySelectorAll) {
        root.querySelectorAll('img').forEach(inspectElement);
      }
      inspectElement(root);
    } catch (_) {}
  }

  function start() {
    scanRoot(document);
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'childList') {
          m.addedNodes.forEach(scanRoot);
          for (const n of m.addedNodes) { if (n.nodeType === 1 && n.tagName === 'IMG') inspectElement(n); }
        } else if (m.type === 'attributes' && m.target) {
          if (m.attributeName === 'src' && m.target.tagName === 'IMG') inspectElement(m.target);
        }
      }
      flush();
    });
    mo.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
    setInterval(flush, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
