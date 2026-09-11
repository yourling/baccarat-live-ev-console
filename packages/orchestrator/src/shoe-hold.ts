/**
 * 靴保持策略（Shoe Hold Policy）。
 *
 * 从 TableActor 提取的独立模块：当实体靴收到换靴信号、但按保守规则暂不切换时，
 * 该策略负责 hold 的判定、出口（路子回绕确认 / 超时）、一次性新靴信号的缓存
 * 与补投、以及 hold 期间被丢弃结算的按靴暂存。
 *
 * AGENTS.md 相关硬规则全部落在这里：
 * - 实体靴未打尽时不被 unknown attach 覆盖；
 * - hold 有 90 秒时效（否则库存冻结的系统会在与现实无关的模型上持续下注）；
 * - 路子回绕确认（isWrapShapedRoadCount）是超时之外的另一个出口；
 * - 新靴信号是一次性的，必须缓存等补投，不能丢弃。
 */
import type { NormalizedEvent, ShoeStateProjection } from '@baccarat/contracts';
import {
  isPrematurePhysicalShoeReset,
  isWrapShapedRoadCount,
} from '@baccarat/ledger-state';
import { BUNDLED_PLATFORM_DESCRIPTORS } from '@baccarat/adapter-contract';

const SHOE_HOLD_MAX_MS = 90_000;

/**
 * 靴代际比较只信任声明了 shoeGenerationContinuity 的平台（如 BG，其解析器
 * 通过 seedShoeSequence 保证代际跨进程重启单调）。其余平台的靴 ID 不携带
 * 可信代际，保持 undefined —— 行为与旧版仅识别 BG 靴 ID 形状时一致。
 */
const SHOE_GENERATION_CONTINUITY_PLATFORMS = new Set(
  BUNDLED_PLATFORM_DESCRIPTORS
    .filter(descriptor => descriptor.shoeGenerationContinuity === true)
    .map(descriptor => descriptor.platformId),
);

export function shoeGenerationOf(event: Pick<NormalizedEvent, 'platformId' | 'type'> & { shoeId?: string }): number | undefined {
  if (event.platformId === undefined || !SHOE_GENERATION_CONTINUITY_PLATFORMS.has(event.platformId)) {
    return undefined;
  }
  const shoeId = typeof event.shoeId === 'string' ? event.shoeId : '';
  const matched = /-([1-9]\d*)$/.exec(shoeId);
  if (!matched) return undefined;
  const generation = Number(matched[1]);
  return Number.isInteger(generation) && generation > 0 ? generation : undefined;
}

type NewShoeSignalEvent = Extract<NormalizedEvent, { type: 'newShoeSignal' }>;
type HandSettledEvent = Extract<NormalizedEvent, { type: 'handSettled' }>;

export class ShoeHoldPolicy {
  holdSince: number | undefined;
  deferredSignal: NewShoeSignalEvent | undefined;
  heldSettlements = new Map<string, NormalizedEvent[]>();

  constructor(
    private readonly tableId: string,
    /** 当前路子数（DOM 珠盘）；undefined 表示路子采集失效。 */
    private readonly observedGameCount: (tableId: string) => number | undefined,
  ) {}

  /**
   * 实体靴是否仍应按住（fail-closed）。出口只有两个：路子回绕确认、超时。
   * 注意超时出口不依赖 DOM 路子——路子采集失效时它是唯一的兜底。
   */
  shouldHold(current: ShoeStateProjection, now = Date.now()): boolean {
    if (!isPrematurePhysicalShoeReset(current)) return false;
    const road = this.observedGameCount(this.tableId);
    if (typeof road === 'number' && isWrapShapedRoadCount(current.handNumber, road)) return false;
    const heldSince = this.holdSince;
    if (heldSince !== undefined && now - heldSince >= SHOE_HOLD_MAX_MS) return false;
    return true;
  }

  /**
   * 事件进入投影前的靴绑定决策：返回事件本身放行，返回 null 表示被 hold 拦下。
   */
  bind(event: NormalizedEvent, current: ShoeStateProjection, now = Date.now()): NormalizedEvent | null {
    if (event.type === 'newShoeSignal') {
      if (current.shoeId && event.shoeId === current.shoeId) return null;
      const incomingBaseline = event.baseline ?? 'unknown-monitor-session';
      if (
        current.shoeId
        && current.shoeBaseline === 'physical-shoe'
        && current.seenCards.length > 0
        && incomingBaseline !== 'physical-shoe'
      ) {
        // Restart attach must not wipe a live physical shoe. An exhausted or
        // 80-hand-capped shoe must still be allowed to fail closed.
        if (!current.sealed && current.remainingTotal >= 26 && current.handNumber < 80) {
          return null;
        }
      }
      if (
        incomingBaseline === 'physical-shoe'
        && this.shouldHold(current, now)
      ) {
        const incomingGen = shoeGenerationOf(event);
        const currentGen = shoeGenerationOf({ platformId: event.platformId, type: event.type, shoeId: current.shoeId });
        if (incomingGen === undefined || currentGen === undefined || incomingGen <= currentGen) {
          this.deferSignal(event);
          return null;
        }
      }
      this.clear();
      return event;
    }
    if (!('shoeId' in event) || typeof event.shoeId !== 'string' || !current.shoeId) return event;
    if (event.shoeId === current.shoeId) return event;
    const incomingGen = shoeGenerationOf(event);
    const currentGen = shoeGenerationOf({ platformId: event.platformId, type: event.type, shoeId: current.shoeId });
    if (incomingGen !== undefined && currentGen !== undefined && incomingGen > currentGen) {
      if (this.shouldHold(current, now)) {
        this.noteDeferred();
        if (event.type === 'handSettled') this.holdSettlement(event);
        return null;
      }
      this.clear();
      return event;
    }
    if (current.shoeBaseline === 'physical-shoe' && current.seenCards.length > 0) {
      // 这里也要带超时判断：否则新靴的牌会被永远丢弃（remainingTotal 在
      // hold 期间是冻结的，`< 26` 永远不会成立）。
      if (current.sealed || current.remainingTotal < 26 || !this.shouldHold(current, now)) {
        this.clear();
        return event;
      }
      this.noteDeferred();
      if (event.type === 'handSettled') this.holdSettlement(event);
      return null;
    }
    return event;
  }

  /**
   * hold 解除检查：返回需要补投的一次性新靴信号与其 hold 期间被丢弃的结算。
   * 解除判据与 bind 的 hold 判据**同源**（路子回绕确认或超时），调用方
   * （TableActor.handleEvent）必须在处理当前事件之前执行补投。
   */
  drain(current: ShoeStateProjection, now = Date.now()): {
    signal?: NewShoeSignalEvent;
    settlements: NormalizedEvent[];
  } {
    const deferred = this.deferredSignal;
    if (deferred === undefined || this.shouldHold(current, now)) {
      return { settlements: [] };
    }
    this.deferredSignal = undefined;
    const dropped = this.heldSettlements.get(deferred.shoeId);
    this.heldSettlements.delete(deferred.shoeId);
    return { signal: deferred, settlements: dropped ?? [] };
  }

  /** 该桌是否处于"靴状态不确定"窗口（下注 fail-closed）。 */
  isPending(now = Date.now()): boolean {
    const heldSince = this.holdSince;
    return heldSince !== undefined && now - heldSince < SHOE_HOLD_MAX_MS;
  }

  /** 清除 hold 与缓存信号（不清结算暂存，结算按靴独立过期）。 */
  clear(): void {
    this.holdSince = undefined;
    this.deferredSignal = undefined;
  }

  /** 投影整体重置时使用：连结算暂存一起清空。 */
  reset(): void {
    this.clear();
    this.heldSettlements.clear();
  }

  /**
   * 记录"我们收到了换靴信号、但按规则先按住旧靴"。
   * 只记第一次：在已有 hold 期间不断刷新会让超时永远不到。
   */
  noteDeferred(): void {
    if (this.holdSince === undefined) this.holdSince = Date.now();
  }

  /**
   * 缓存被 hold 掉的新靴信号。信号是一次性的，被丢弃就再也没有了；
   * 留最新：第二个信号意味着平台又切了一靴。
   */
  deferSignal(event: NewShoeSignalEvent): void {
    this.deferredSignal = event;
    this.noteDeferred();
  }

  /** hold 期间被丢弃的新靴结算，按靴分组（上界保护，异常洪泛时丢最旧的）。 */
  holdSettlement(event: HandSettledEvent): void {
    const list = this.heldSettlements.get(event.shoeId) ?? [];
    if (list.length >= 30) list.shift();
    list.push(event);
    this.heldSettlements.set(event.shoeId, list);
  }
}
