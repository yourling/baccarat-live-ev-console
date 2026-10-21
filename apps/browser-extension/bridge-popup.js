/**
 * FIX(P0-1 残余风险): 把本扩展的 installId 显示给操作员做**带外比对**。
 *
 * 为什么需要它：桥侧的"批准"是 TOFU（trust on first use）—— 待批准列表里的
 * installId 是扩展自述的，桥无法校验真伪；而任何本机进程都能带公开 Origin +
 * 明文 token + 自选 installId 连上桥并进入待批准列表。若操作员只是"看到有待批准就点批准"，
 * 攻击者就能被授权，且"批准优先"会顺手把真扩展踢掉。
 *
 * 唯一能把"盲批"变成"可验证比对"的动作，就是让真扩展自己展示它的 installId：
 * 操作员拿这里的值去比对桌面端待批准列表的前 8 位。攻击者猜中 32 hex 不可行。
 */
async function loadInstallId() {
  const stored = await chrome.storage.local.get('bridgeInstallId');
  if (typeof stored.bridgeInstallId === 'string' && stored.bridgeInstallId.length > 0) {
    return stored.bridgeInstallId;
  }
  // 与 background.js 的 loadBridgeInstallId() 保持同一生成规则（16 字节 → 32 hex）。
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const installId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ bridgeInstallId: installId });
  return installId;
}

document.addEventListener('DOMContentLoaded', () => {
  const label = document.getElementById('install-id');
  const status = document.getElementById('status');
  const copy = document.getElementById('copy');
  if (!label || !status || !copy) return;

  void loadInstallId().then(installId => {
    // 只显示前 8 位：与桌面端待批准列表的展示口径一致，也避免整串被截屏带走。
    label.textContent = `${installId.slice(0, 8)}…`;
    label.title = installId;
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(installId).then(
        () => { status.textContent = '已复制完整 installId'; },
        () => { status.textContent = '复制失败，请手动选中复制'; },
      );
    });
  }).catch(() => {
    label.textContent = '读取失败';
  });
});
