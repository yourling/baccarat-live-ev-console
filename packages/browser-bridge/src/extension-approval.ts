/**
 * 扩展身份批准名单（P0-1 修复）。
 *
 * 背景：扩展 ID 由 manifest 里的**公钥**推导，token 是三个 background.js 里的明文常量，
 * 因此「固定扩展 ID + 共享 token」只是命名约定，不是认证边界 —— 任意本机进程手写
 * `Origin: chrome-extension://<推导 ID>` + 明文 token 就能占住唯一扩展槽并接管真金通道。
 *
 * 现在真正的边界是 **installId + 操作员批准**：
 *  1. 三个扩展首次运行时生成随机 installId（32 hex），存 `chrome.storage.local.bridgeInstallId`，
 *     每次连接通过 `?installId=` 上报；
 *  2. 桥只把「操作员批准过的 installId」提升为 extension 角色，其余一律停在
 *     `extension-pending`（不占唯一扩展槽、不拿 lease、不 ingest 任何事件）；
 *  3. 批准动作由桌面端调用 `BrowserBridgeServer.approveExtension(installId)` 完成。
 *
 * 注意：installId 不是密钥（它同样落在扩展本地存储里），它的作用是让「谁可以接管
 * 真金通道」变成一个**人工审批**的显式动作，而不是任何拿到仓库/扩展包的人默认拥有。
 */

/** installId 形状：扩展生成 32 hex（uuid 去掉连字符），这里放宽到常见 id 形状。 */
export const EXTENSION_INSTALL_ID_PATTERN = /^[a-zA-Z0-9._-]{8,128}$/;

export interface BridgeExtensionPendingEntry {
  readonly installId: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * 操作员批准名单存储。桌面端负责落盘（SQLite / 配置文件），桥只依赖这个接口。
 *
 * 不传 store 时桥退化为「允许未批准但带 installId 的扩展」（见 server.ts 注释），
 * 生产路径必须由桌面端注入真实 store。
 */
export interface BridgeExtensionApprovalStore {
  isApproved(installId: string): boolean;
  approve(installId: string, meta?: { note?: string }): void;
  revoke(installId: string): void;
  listApproved(): string[];
  listPending(): BridgeExtensionPendingEntry[];
  forgetPending(installId: string): void;
}

/** 严格的 installId 归一化：只接受有长度约束的 id 字符集，其余一律 undefined。 */
export function normalizeExtensionInstallId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return EXTENSION_INSTALL_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** 从桥连接 URL 的 query 里取 installId（缺省/畸形都返回 undefined）。 */
export function extensionInstallIdFromRequestUrl(requestUrl: string | undefined): string | undefined {
  try {
    const url = new URL(requestUrl ?? '/', 'ws://localhost');
    return normalizeExtensionInstallId(url.searchParams.get('installId'));
  } catch {
    return undefined;
  }
}

/**
 * 内存版批准名单：单测/demo 用；桌面端应换成落盘实现（进程重启后批准关系必须保留，
 * 否则每次启动都要重新点一遍批准）。
 */
export class MemoryExtensionApprovalStore implements BridgeExtensionApprovalStore {
  private readonly approved = new Set<string>();
  private readonly pending = new Map<string, { firstSeenAt: string; lastSeenAt: string }>();

  constructor(initialApproved: Iterable<string> = []) {
    for (const installId of initialApproved) {
      const normalized = normalizeExtensionInstallId(installId);
      if (normalized !== undefined) this.approved.add(normalized);
    }
  }

  isApproved(installId: string): boolean {
    const normalized = normalizeExtensionInstallId(installId);
    return normalized !== undefined && this.approved.has(normalized);
  }

  approve(installId: string, _meta?: { note?: string }): void {
    const normalized = normalizeExtensionInstallId(installId);
    if (normalized === undefined) throw new Error('invalid extension install id');
    this.approved.add(normalized);
    this.pending.delete(normalized);
  }

  revoke(installId: string): void {
    const normalized = normalizeExtensionInstallId(installId);
    if (normalized === undefined) return;
    this.approved.delete(normalized);
  }

  listApproved(): string[] {
    return [...this.approved];
  }

  recordPending(installId: string): void {
    const normalized = normalizeExtensionInstallId(installId);
    if (normalized === undefined) return;
    const now = new Date().toISOString();
    const previous = this.pending.get(normalized);
    this.pending.set(normalized, {
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
  }

  listPending(): BridgeExtensionPendingEntry[] {
    return [...this.pending.entries()]
      .map(([installId, entry]) => ({ installId, ...entry }))
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  forgetPending(installId: string): void {
    const normalized = normalizeExtensionInstallId(installId);
    if (normalized === undefined) return;
    this.pending.delete(normalized);
  }
}
