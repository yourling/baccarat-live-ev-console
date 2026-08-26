import { useState } from 'react';
import type { OperationalWagerMarket } from '@baccarat/adapter-contract';
import type { TableActorSnapshot } from '../api-types';
import { useConfirmationDialog } from './confirmation-dialog';
import './operational-wager-controls.css';

const MARKET_LABELS: Record<OperationalWagerMarket, string> = {
  banker: '庄',
  player: '闲',
  bankerPair: '庄对',
  playerPair: '闲对',
};

const MARKETS: readonly OperationalWagerMarket[] = ['banker', 'player', 'bankerPair', 'playerPair'];

type OperationalWagerStatus = 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';

export function OperationalWagerControls(props: {
  readonly actor: TableActorSnapshot;
  readonly onSnapshot: (snapshot: Awaited<ReturnType<NonNullable<Window['desktop']>['snapshot']>>) => void;
}) {
  const [amount, setAmount] = useState('20');
  const [submitting, setSubmitting] = useState<OperationalWagerMarket | null>(null);
  const [status, setStatus] = useState<OperationalWagerStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmationDialog();
  const parsedAmount = Number(amount);
  const amountIsValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const gateReason = operationalWagerGateReason(props.actor);
  const blockedReason = gateReason ?? (amountIsValid ? null : '金额必须是大于 0 的数字');

  async function submit(market: OperationalWagerMarket): Promise<void> {
    const desktop = window.desktop;
    if (desktop === undefined || blockedReason !== null) {
      setMessage(blockedReason ?? '桌面下注通道当前不可用');
      return;
    }
    const isLive = props.actor.executionMode === 'live';
    const executionModeLabel = isLive
      ? '真实资金'
      : props.actor.executionMode === 'shadow'
        ? '影子'
        : '模拟';
    const confirmed = await confirm({
      title: isLive ? '确认真实下注' : `确认${executionModeLabel}下注测试`,
      description: isLive
        ? '此操作会通过浏览器扩展尝试使用真实资金提交下注，请再次核对下注信息。'
        : `本次只记录${executionModeLabel}测试，不会向浏览器发送下注。`,
      details: [
        { label: '牌桌', value: props.actor.tableId },
        { label: '执行模式', value: executionModeLabel },
        { label: '玩法', value: MARKET_LABELS[market] },
        { label: '金额', value: formatAmount(parsedAmount) },
      ],
      confirmLabel: isLive ? '确认真实下注' : '确认记录',
      tone: isLive ? 'danger' : 'primary',
    });
    if (!confirmed) return;

    setSubmitting(market);
    setStatus(null);
    setMessage(null);
    try {
      const result = await desktop.executeOperationalWager({
        tableId: props.actor.tableId,
        market,
        amount: parsedAmount,
      });
      props.onSnapshot(result.snapshot);
      setStatus(result.status);
      setMessage(result.reason === 'shadow-simulated'
        ? '影子测试已记录，未向浏览器发送下注'
        : result.reason === 'simulated-simulated'
          ? '模拟测试已记录，未向浏览器发送下注'
          : result.reason ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section
      className="operational-wager-controls"
      aria-label={`${props.actor.tableId} 手动测试下注`}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <label className="operational-wager-controls__amount">
        <span>测试金额</span>
        <input
          type="number"
          min="0.01"
          step="1"
          value={amount}
          onChange={event => setAmount(event.target.value)}
          disabled={submitting !== null}
        />
      </label>
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
        {status === null ? (blockedReason ?? '准备就绪') : statusLabel(status)}
        {message === null ? null : <span>{message}</span>}
      </div>
      {dialog}
    </section>
  );
}

function operationalWagerGateReason(actor: TableActorSnapshot): string | null {
  if (actor.executionMode !== 'live') return null;
  const projection = actor.projection;
  if (projection.connectionStatus !== 'CONNECTED') return '牌桌连接未就绪';
  if (projection.status !== 'BETTING_WINDOW') return '当前不在下注窗口';
  if (projection.currentHandId === null || projection.currentHandId.length === 0) return '当前没有可下注局号';
  if (projection.sealed) return '当前牌靴已封存';
  if (projection.autoBetStatus === 'ARMED') return '请先停止自动下注';
  return null;
}

function statusLabel(status: OperationalWagerStatus): string {
  switch (status) {
    case 'ACCEPTED':
      return '已接受';
    case 'REJECTED':
      return '已拒绝';
    case 'UNKNOWN':
      return '结果未知';
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported operational wager status: ${String(value)}`);
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}
