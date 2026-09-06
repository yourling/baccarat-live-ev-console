import { useEffect, useState } from 'react';
import type { OperationalWagerMarket } from '@baccarat/adapter-contract';
import type { MonitorTableCandidate, TableActorSnapshot } from '../api-types';
import { useConfirmationDialog } from './confirmation-dialog';
import './operational-wager-controls.css';

const MARKET_LABELS: Record<OperationalWagerMarket, string> = {
  banker: '庄',
  player: '闲',
  bankerPair: '庄对',
  playerPair: '闲对',
};

const MARKETS: readonly OperationalWagerMarket[] = ['banker', 'player', 'bankerPair', 'playerPair'];
const DEFAULT_PAGE_CHIP_AMOUNT = 20;

type OperationalWagerStatus = 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';

export function OperationalWagerControls(props: {
  readonly actor: TableActorSnapshot;
  readonly metadata?: MonitorTableCandidate;
  readonly runtimeBlockedReason?: string;
  readonly onSnapshot: (snapshot: Awaited<ReturnType<NonNullable<Window['desktop']>['snapshot']>>) => void;
  readonly compact?: boolean;
  readonly now?: number;
}) {
  const localNow = useNow(props.now === undefined ? 250 : 0);
  const now = props.now ?? localNow;
  const [submitting, setSubmitting] = useState<OperationalWagerMarket | null>(null);
  const [status, setStatus] = useState<OperationalWagerStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmationDialog();
  const blockedReason = props.runtimeBlockedReason ?? operationalWagerGateReason(props.actor, props.metadata, now);
  const currentHandId = currentWagerHandId(props.actor, props.metadata);

  async function submit(market: OperationalWagerMarket): Promise<void> {
    const desktop = window.desktop;
    if (desktop === undefined || blockedReason !== null) {
      setMessage(blockedReason ?? '桌面下注通道当前不可用');
      return;
    }
    const confirmed = await confirm({
      title: '确认真实下注',
      description: '此操作会通过浏览器扩展尝试提交真实下注，使用页面当前默认筹码，不再点选筹码。',
      details: [
        { label: '牌桌', value: props.actor.tableId },
        { label: '局号', value: currentHandId ?? '无' },
        { label: '玩法', value: MARKET_LABELS[market] },
        { label: '金额', value: `${formatAmount(DEFAULT_PAGE_CHIP_AMOUNT)}（页面默认筹码）` },
      ],
      confirmLabel: '确认真实下注',
      tone: 'danger',
    });
    if (!confirmed) return;

    setSubmitting(market);
    setStatus(null);
    setMessage(null);
    try {
      const result = await desktop.executeOperationalWager({
        tableId: props.actor.tableId,
        market,
        amount: DEFAULT_PAGE_CHIP_AMOUNT,
        ...(currentHandId === undefined ? {} : { handId: currentHandId }),
      });
      props.onSnapshot(result.snapshot);
      setStatus(result.status);
      setMessage(result.reason === undefined ? null : operationalWagerReasonLabel(result.reason));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section
      className={props.compact ? 'operational-wager-controls operational-wager-controls--compact' : 'operational-wager-controls'}
      aria-label={`${props.actor.tableId} 手动真实下注`}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="operational-wager-controls__amount">
        <span>默认筹码</span>
        <strong>{formatAmount(DEFAULT_PAGE_CHIP_AMOUNT)}</strong>
      </div>
      <div className="operational-wager-controls__buttons">
        {MARKETS.map(market => (
          <button
            className="button button--small button--primary"
            type="button"
            key={market}
            disabled={submitting !== null || blockedReason !== null}
            title={blockedReason ?? undefined}
            onClick={() => void submit(market)}
          >
            {submitting === market ? '提交中' : MARKET_LABELS[market]}
          </button>
        ))}
      </div>
      <div className="operational-wager-controls__result" role="status" aria-live="polite">
        {status === null ? idleWagerStatus(blockedReason, props.compact === true) : statusLabel(status)}
        {message === null ? null : <span>{message}</span>}
      </div>
      {dialog}
    </section>
  );
}

const MIN_MANUAL_WINDOW_SECONDS = 2;

export function currentWagerHandId(
  actor: TableActorSnapshot,
  metadata?: MonitorTableCandidate,
): string | undefined {
  const projectionHand = actor.projection.currentHandId?.trim();
  if (actor.projection.status === 'BETTING_WINDOW' && projectionHand) return projectionHand;
  const roundId = metadata?.roundId?.trim();
  if (roundId && roundId !== '—') return roundId;
  return projectionHand && projectionHand.length > 0 ? projectionHand : undefined;
}

export function remainingBettingWindowSeconds(actor: TableActorSnapshot, now = Date.now()): number | null {
  if (actor.projection.status !== 'BETTING_WINDOW') return null;
  const closesAt = actor.projection.bettingWindowClosesAt;
  if (typeof closesAt !== 'string' || closesAt.length === 0) return null;
  const remaining = Math.floor((Date.parse(closesAt) - now) / 1000);
  return Number.isFinite(remaining) ? remaining : null;
}

export function bettingWindowIsOpen(actor: TableActorSnapshot, now = Date.now()): boolean {
  if (actor.projection.status !== 'BETTING_WINDOW') return false;
  const remaining = remainingBettingWindowSeconds(actor, now);
  return remaining === null || remaining > 0;
}

export function bettingPhaseLabel(actor: TableActorSnapshot, now = Date.now()): {
  readonly text: string;
  readonly open: boolean;
} {
  const projection = actor.projection;
  if (projection.status === 'BETTING_WINDOW') {
    const remaining = remainingBettingWindowSeconds(actor, now);
    if (remaining !== null && remaining > 0) return { text: `可下注 ${remaining}s`, open: true };
    return { text: '可下注', open: true };
  }
  if (projection.status === 'PENDING_SETTLEMENT') return { text: '结算中', open: false };
  if (projection.status === 'TRACKING' && projection.currentHandHasCards) return { text: '发牌中', open: false };
  if (projection.status === 'WAITING_NEW_SHOE' || projection.status === 'WAITING_CONFIRMATION') {
    return { text: '洗牌', open: false };
  }
  return { text: '停注', open: false };
}

export function operationalWagerGateReason(
  actor: TableActorSnapshot,
  metadata?: MonitorTableCandidate,
  now = Date.now(),
): string | null {
  const projection = actor.projection;
  if (projection.connectionStatus !== 'CONNECTED') return '牌桌连接未就绪';
  if (projection.shoeBaseline !== 'physical-shoe') return '待牌靴，不可下注';
  if (!bettingWindowIsOpen(actor, now)) return '当前不在下注窗口';
  const remaining = remainingBettingWindowSeconds(actor, now);
  if (remaining !== null && remaining < MIN_MANUAL_WINDOW_SECONDS) return '下注窗口即将关闭';
  if (currentWagerHandId(actor, metadata) === undefined) return '当前没有可下注局号';
  if (projection.sealed) return '当前牌靴已封存';
  return null;
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function idleWagerStatus(blockedReason: string | null, compact: boolean): string {
  if (blockedReason === null) return '准备就绪';
  if (compact && blockedReason === '当前不在下注窗口') return '等待开盘';
  return blockedReason;
}

function statusLabel(status: OperationalWagerStatus): string {
  switch (status) {
    case 'ACCEPTED':
      return '已接受';
    case 'REJECTED':
      return '已拒绝';
    case 'UNKNOWN':
      return '已提交待确认';
    default:
      return assertNever(status);
  }
}

function operationalWagerReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    'betting-window-required': '当前不在下注窗口',
    'betting-window-closed': '页面下注窗口已关闭',
    'chip-target-not-hittable': '筹码按钮无法点击',
    'market-target-not-hittable': '下注区域无法点击，请保持多桌页在前台且目标桌可见',
    'bet-template-missing': '请求下注未绑定账号，请先在游戏页手点一注10',
    'bet-request-channel-unavailable': '请求下注通道未就绪，请刷新扩展和游戏页',
    'bet-socket-not-open': '游戏连接未就绪，请保持多桌页打开',
    'bet-socket-send-failed': '请求下注发送失败',
    'chip-selection-disabled': '已改为使用页面默认筹码，不再点选筹码',
    'receipt-rejected': '平台拒绝了这次下注',
    'current-hand-required': '当前没有可下注局号',
    'connected-required': '牌桌连接未就绪',
    'shoe-sealed': '当前牌靴已封存',
    'table-not-monitored': '该牌桌未加入监控',
    'table-unavailable': '牌桌当前不可用',
    'duplicate': '本局该玩法已经下过注',
    'live-execution-required': '当前不是真实下注模式',
    'browser-bridge-unavailable': '浏览器桥未就绪',
    'exact-chip-denomination-unavailable': '页面没有刚好匹配金额的筹码',
    'chip-combination-unavailable': '页面可见筹码无法组合这个金额',
    'target-table-not-found': '浏览器页面找不到目标牌桌',
    'multitable-route-not-prepared': '多桌下注路由未准备好',
    'unsupported-market': '页面找不到对应下注区域',
    'round-mismatch': '页面当前局号与中控局号不一致',
    'prepared-round-mismatch': '准备下注后页面局号已变化',
    'wallet-total-bet-increased': '页面总投注已增加',
    'lpbet-sent': '已通过请求提交下注',
    'platform-ack-not-observed': '已真实点击下注区，等待平台确认',
  };
  if (labels[reason] !== undefined) return labels[reason];
  if (reason.startsWith('request-unavailable:')) {
    return operationalWagerReasonLabel(reason.slice('request-unavailable:'.length));
  }
  if (reason.startsWith('precommit-routing-failed:')) {
    const detail = reason.slice('precommit-routing-failed:'.length);
    if (detail.includes('Pragmatic target table preparation failed')) {
      return '多桌下注准备失败：' + detail.replace(/^Pragmatic target table preparation failed:\s*/, '');
    }
    if (detail.includes('expected one authoritative ready Pragmatic frame')) {
      return '找不到可下注的 Pragmatic 游戏帧，请保持多桌页在前台后重试';
    }
    return '下注前路由失败：' + detail;
  }
  if (reason.startsWith('chip-selection-failed:')) {
    return '选择筹码失败：' + reason.slice('chip-selection-failed:'.length);
  }
  if (reason.startsWith('market-click-threw:')) {
    return '点击下注区域异常：' + reason.slice('market-click-threw:'.length);
  }
  if (
    reason === 'browser-extension-bet-runtime-outdated'
    || reason === 'bridge-request-error:browser extension bet runtime revision mismatch'
  ) {
    return '浏览器扩展下注运行时版本不兼容，请手动刷新扩展后重试';
  }
  if (reason.startsWith('bridge-request-error:')) return '浏览器扩展下注请求失败：' + reason.slice('bridge-request-error:'.length);
  if (reason === 'bridge-request-error') return '浏览器扩展下注请求失败';
  return reason;
}

function assertNever(value: never): never {
  throw new Error(`unsupported operational wager status: ${String(value)}`);
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}
