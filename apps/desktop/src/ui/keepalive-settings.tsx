import { useEffect, useState } from 'react';
import type { DesktopConsoleSnapshot, DesktopKeepaliveState } from '../api-types';
import './keepalive-settings.css';

type KeepaliveDraft = {
  readonly intervalMinutes: string;
  readonly market: 'banker' | 'player';
  readonly amount: string;
};

export function KeepaliveSettings(props: {
  readonly state: DesktopKeepaliveState;
  readonly onSnapshot: (snapshot: DesktopConsoleSnapshot) => void;
  readonly onError: (error: string | null) => void;
}) {
  const [draft, setDraft] = useState<KeepaliveDraft>(() => draftFor(props.state));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setDraft(draftFor(props.state));
  }, [props.state, dirty]);

  async function save(): Promise<void> {
    const intervalMinutes = Number(draft.intervalMinutes);
    const amount = Number(draft.amount);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1_440) {
      props.onError('自动投注保活间隔必须是 1 到 1440 分钟的整数');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      props.onError('自动投注保活金额必须大于 0');
      return;
    }
    const desktop = window.desktop;
    if (desktop === undefined) {
      props.onError('桌面控制通道当前不可用');
      return;
    }
    setSaving(true);
    props.onError(null);
    try {
      props.onSnapshot(await desktop.updateKeepaliveSettings({
        intervalMinutes,
        market: draft.market,
        amount,
      }));
      setDirty(false);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ledger-settings keepalive-settings">
      <div className="record-heading">
        <h2>自动投注保活策略</h2>
        <span className="record-count">{keepaliveStatus(props.state)}</span>
      </div>
      <p className="muted">保存间隔和金额后，还须点顶部「开启自动投注」才会按开盘窗口下保活注。Pragmatic 牌桌走与手动下注相同的请求通道。</p>
      <div className="settings-fields keepalive-settings__fields">
        <label>
          <span>间隔（分钟）</span>
          <input
            type="number"
            min="1"
            max="1440"
            step="1"
            value={draft.intervalMinutes}
            disabled={saving}
            onChange={event => {
              setDraft(current => ({ ...current, intervalMinutes: event.target.value }));
              setDirty(true);
            }}
          />
        </label>
        <label>
          <span>下注方向</span>
          <select
            value={draft.market}
            disabled={saving}
            onChange={event => {
              setDraft(current => ({ ...current, market: event.target.value === 'player' ? 'player' : 'banker' }));
              setDirty(true);
            }}
          >
            <option value="banker">庄</option>
            <option value="player">闲</option>
          </select>
        </label>
        <label>
          <span>下注金额</span>
          <input
            type="number"
            min="0.01"
            step="1"
            value={draft.amount}
            disabled={saving}
            onChange={event => {
              setDraft(current => ({ ...current, amount: event.target.value }));
              setDirty(true);
            }}
          />
        </label>
        <button className="button button--small button--primary settings-save" type="button" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? '保存中' : '保存保活策略'}
        </button>
      </div>
      <div className="keepalive-settings__history" role="status">
        <span>上次尝试：{formatTimestamp(props.state.lastAttemptAt)}</span>
        <span>上次成功：{formatTimestamp(props.state.lastSuccessAt)}</span>
        <span>结果：{props.state.lastStatus ?? '-'}</span>
        <span>牌桌：{props.state.lastTableId ?? '-'}</span>
      </div>
    </section>
  );
}

function draftFor(state: DesktopKeepaliveState): KeepaliveDraft {
  return {
    intervalMinutes: String(state.intervalMinutes),
    market: state.market,
    amount: String(state.amount),
  };
}

function keepaliveStatus(state: DesktopKeepaliveState): string {
  if (state.running) return '执行中';
  return state.enabled ? '已开启' : '已保存，未开启';
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined) return '-';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false });
}
