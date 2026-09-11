/**
 * 平台适配抽象：采集（数据采集）与执行（下注执行）层面向「平台」组织，
 * 中控（orchestrator / desktop）只面对 PlatformAdapterDescriptor 与注册表，
 * 不再硬编码任何具体厅台（Dafabet Pragmatic / BG / Winfinity）的细节。
 *
 * 新增一个游戏平台 = 在 browser-bridge 里实现一个 BridgePlatformAdapter
 * （含运行时解析器），并在这里注册一份 PlatformAdapterDescriptor。
 * 中控代码零改动。
 */

/** 平台标识。内置平台见 platform-catalog.ts；保持开放字符串以便扩展。 */
export type KnownPlatformId = 'pragmatic' | 'bg' | 'winfinity';

/**
 * 执行能力声明：
 * - full：具备真金下注执行通道（BetIntent / OperationalWager 均可执行）。
 * - monitor-only：只采集不下注，所有下注请求在桥层被统一拒绝。
 */
export type PlatformExecutionCapability = 'full' | 'monitor-only';

export interface PlatformAdapterDescriptor {
  /** 平台短标识，同时作为 NormalizedEvent.platformId 的盖戳值。 */
  readonly platformId: string;
  /** 大厅房间 ID（桥接扩展上报的 roomId）。 */
  readonly roomId: string;
  /** 大厅显示名。 */
  readonly roomDisplayName: string;
  /** 随包扩展的固定 Chrome 扩展 ID（manifest key 派生）。 */
  readonly extensionId: string;
  readonly executionCapability: PlatformExecutionCapability;
  /**
   * OperationalWager 回执的运行时版本族前缀；monitor-only 平台省略。
   * 版本不匹配时桥层抛 OperationalWagerRuntimeRevisionError。
   */
  readonly betRuntimeFamily?: string;
  readonly betRuntimeRevision?: string;
  /** 监控桌数据流过期阈值覆盖（毫秒）；省略时用桥的默认值。 */
  readonly tableStaleAfterMs?: number;
  /** networkCapture 来源前缀，如 'baccarat-bridge-pragmatic-'。 */
  readonly captureSourcePrefix: string;
  /** 运行时解析器产出事件的 source 标签。 */
  readonly eventSourceName: string;
  /** 事件 ID 前缀（运行时解析器用）。 */
  readonly eventIdPrefix: string;
  /** 靴 ID 前缀，如 'pragmatic' / 'bg' / 'wnf'。 */
  readonly shoeIdPrefix: string;
  /** 人工确认实体靴时合成 operator 靴 ID 的前缀。 */
  readonly operatorShoeIdPrefix: string;
  /** monitor-only 平台拒绝回执的 reason；full 平台省略。 */
  readonly monitorOnlyReason?: string;
  /** monitor-only 平台拒绝回执 ID 前缀；full 平台省略。 */
  readonly monitorOnlyReceiptPrefix?: string;
  /**
   * true 表示该平台的靴 ID 携带跨进程重启保持单调的代际号
   * （配合解析器的 seedShoeSequence 能力）。只有这类平台的事件
   * 才允许被中控用代际比较来推翻实体靴保持（hold）。
   */
  readonly shoeGenerationContinuity?: boolean;
}

/**
 * 平台注册表：桥与中控按 roomId / extensionId / platformId 查找平台，
 * 绝不维护平台字面量分支。
 */
export class PlatformRegistry {
  private readonly byPlatformId = new Map<string, PlatformAdapterDescriptor>();
  private readonly byRoomId = new Map<string, PlatformAdapterDescriptor>();
  private readonly byExtensionId = new Map<string, PlatformAdapterDescriptor>();

  constructor(descriptors: readonly PlatformAdapterDescriptor[] = []) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: PlatformAdapterDescriptor): void {
    if (this.byPlatformId.has(descriptor.platformId)) {
      throw new Error(`platform already registered: ${descriptor.platformId}`);
    }
    this.byPlatformId.set(descriptor.platformId, descriptor);
    this.byRoomId.set(descriptor.roomId, descriptor);
    this.byExtensionId.set(descriptor.extensionId, descriptor);
  }

  get(platformId: string): PlatformAdapterDescriptor | undefined {
    return this.byPlatformId.get(platformId);
  }

  getByRoomId(roomId: string): PlatformAdapterDescriptor | undefined {
    return this.byRoomId.get(roomId);
  }

  getByExtensionId(extensionId: string): PlatformAdapterDescriptor | undefined {
    return this.byExtensionId.get(extensionId);
  }

  getAll(): PlatformAdapterDescriptor[] {
    return [...this.byPlatformId.values()];
  }

  get roomIds(): string[] {
    return this.getAll().map(descriptor => descriptor.roomId);
  }

  get extensionIds(): string[] {
    return this.getAll().map(descriptor => descriptor.extensionId);
  }

  isLiveRoomId(roomId: string): boolean {
    return this.byRoomId.has(roomId);
  }
}

/** OperationalWager 回执运行时版本族校验（原 browser-bridge 内联逻辑上收）。 */
export function isCompatibleRuntimeRevision(
  revision: unknown,
  expectedFamilies: readonly string[],
): boolean {
  return expectedFamilies.some(
    family => typeof revision === 'string' && revision.startsWith(family),
  );
}
