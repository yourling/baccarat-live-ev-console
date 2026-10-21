/**
 * 随包内置平台的身份数据（唯一事实来源）。
 *
 * browser-bridge 的 identity.ts、扩展 background.js 的 DEFAULT_BRIDGE_TOKEN、
 * 以及桌面中控 UI 都从这里取值，不得各自硬编码。
 *
 * P0-1（审查修复）后的安全语义，请勿再按旧说法描述：
 * - extensionId 由 manifest key（**公钥**）固定，任何人拿到扩展包都能构建出同一 ID，
 *   所以 extensionId 只是**平台归属标识**，不是身份边界；
 * - bridgeToken 扩展静态打包、构建期必须写死，同样不是密钥 —— 它只做**噪声过滤**
 *   （挡住误连/扫端口的普通客户端），不构成安全边界；
 * - 真正的身份边界是「扩展首次运行生成的 installId + 操作员批准名单」，
 *   由 browser-bridge 的 BridgeExtensionApprovalStore 强制：未批准的 installId
 *   只能停在 pairingRequired，拿不到 extension 角色 / executor lease / 任何事件。
 */
import type { PlatformAdapterDescriptor } from './platform.js';

export const BUNDLED_BRIDGE_TOKEN =
  'd63a1a9d927e268d5b3d0ac2450836c0fa90de2e55398ccb73ae888ecf35d97b';

export const PRAGMATIC_PLATFORM_ID = 'pragmatic';
export const BG_PLATFORM_ID = 'bg';
export const WINFINITY_PLATFORM_ID = 'winfinity';

export const DAFABET_PRAGMATIC_ROOM_ID = 'dafabet-pragmatic';
export const DAFABET_BG_ROOM_ID = 'dafabet-bg';
export const DAFABET_WINFINITY_ROOM_ID = 'dafabet-winfinity';

export const BUNDLED_PRAGMATIC_EXTENSION_ID = 'igjpillacopnacpepahjfaokiopahmee';
export const BUNDLED_BG_EXTENSION_ID = 'ckiomamppnakpgobcemidpojdiemfdlm';
export const BUNDLED_WINFINITY_EXTENSION_ID = 'ebfnknenblmegkhhpfphcjebmpapbcjk';

export const PRAGMATIC_BET_RUNTIME_FAMILY = 'pragmatic-bet-runtime/';
export const PRAGMATIC_BET_RUNTIME_REVISION = 'pragmatic-bet-runtime/2026-08-30.14';
export const BG_BET_RUNTIME_FAMILY = 'bg-bet-runtime/';
export const BG_BET_RUNTIME_REVISION = 'bg-bet-runtime/2026-09-05.1';

/** BG 厅慢速珠盘：数据流过期阈值放宽到 5 分钟。 */
export const BG_TABLE_STALE_AFTER_MS = 300_000;

export const BUNDLED_PLATFORM_DESCRIPTORS: readonly PlatformAdapterDescriptor[] = [
  {
    platformId: PRAGMATIC_PLATFORM_ID,
    roomId: DAFABET_PRAGMATIC_ROOM_ID,
    roomDisplayName: 'Dafabet Pragmatic Play',
    extensionId: BUNDLED_PRAGMATIC_EXTENSION_ID,
    executionCapability: 'full',
    betRuntimeFamily: PRAGMATIC_BET_RUNTIME_FAMILY,
    betRuntimeRevision: PRAGMATIC_BET_RUNTIME_REVISION,
    captureSourcePrefix: 'baccarat-bridge-pragmatic-',
    eventSourceName: 'pragmatic-runtime',
    eventIdPrefix: 'pragmatic',
    shoeIdPrefix: 'pragmatic',
    operatorShoeIdPrefix: 'pragmatic',
  },
  {
    platformId: BG_PLATFORM_ID,
    roomId: DAFABET_BG_ROOM_ID,
    roomDisplayName: 'Dafabet BG Live',
    extensionId: BUNDLED_BG_EXTENSION_ID,
    executionCapability: 'full',
    betRuntimeFamily: BG_BET_RUNTIME_FAMILY,
    betRuntimeRevision: BG_BET_RUNTIME_REVISION,
    tableStaleAfterMs: BG_TABLE_STALE_AFTER_MS,
    captureSourcePrefix: 'baccarat-bridge-bg-',
    eventSourceName: 'bg-runtime',
    eventIdPrefix: 'bg',
    shoeIdPrefix: 'bg',
    operatorShoeIdPrefix: 'bg',
    shoeGenerationContinuity: true,
  },
  {
    platformId: WINFINITY_PLATFORM_ID,
    roomId: DAFABET_WINFINITY_ROOM_ID,
    roomDisplayName: 'Dafabet Winfinity',
    extensionId: BUNDLED_WINFINITY_EXTENSION_ID,
    executionCapability: 'monitor-only',
    monitorOnlyReason: 'winfinity-monitor-only',
    monitorOnlyReceiptPrefix: 'wnf',
    captureSourcePrefix: 'baccarat-bridge-winfinity-',
    eventSourceName: 'winfinity-runtime',
    eventIdPrefix: 'wnf',
    shoeIdPrefix: 'wnf',
    operatorShoeIdPrefix: 'wnf',
  },
];
