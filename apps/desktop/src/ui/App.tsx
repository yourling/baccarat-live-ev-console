import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { NormalizedEvent } from '@baccarat/contracts';
import type { DesktopConsoleSnapshot, TableActorSnapshot } from '../api-types';

export function App() {
  const [snapshot, setSnapshot] = useState<DesktopConsoleSnapshot | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [deckInputs, setDeckInputs] = useState<Record<string, string>>({});
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!window.desktop) return;
    try {
      setSnapshot(await window.desktop.snapshot());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runDemo = useCallback(async () => {
    if (!window.desktop) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await window.desktop.runDemo());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = window.setInterval(() => void refresh(), 2_000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [refresh]);

  const tables = snapshot ? Object.values(snapshot.snapshot.tables) : [];
  const risk = snapshot?.snapshot.riskState;
  const recentEvents = snapshot?.events.slice(-40) ?? [];
  const recentDecisions = snapshot?.decisions.slice(-12) ?? [];

  async function setAutoBet(tableId: string, armed: boolean, shoeId?: string) {
    if (!window.desktop) return;
    setError(null);
    try {
      setSnapshot(await window.desktop.setAutoBet(tableId, armed, shoeId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function correctDecks(tableId: string) {
    if (!window.desktop) return;
    const raw = deckInputs[tableId];
    if (!raw) return;
    const decks = Number(raw);
    if (!Number.isInteger(decks) || decks < 1 || decks > 20) {
      setError('副数必须是 1..20 的整数');
      return;
    }
    setError(null);
    try {
      setSnapshot(await window.desktop.applyManualCorrection(
        tableId,
        { kind: 'numberOfDecks', numberOfDecks: decks },
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>🃏 百家乐实时 EV 中控台</h1>
          <p style={styles.subtitle}>事件溯源账本 · 持久化风控 · 影子/模拟执行 · 重启可恢复</p>
        </div>
        <div style={styles.actions}>
          <button style={styles.primary} onClick={() => void runDemo()} disabled={busy || !window.desktop}>
            {busy ? '运行中…' : '▶ 注入演示牌流'}
          </button>
          <button style={styles.button} onClick={() => void refresh()} disabled={!window.desktop}>刷新</button>
        </div>
      </header>

      {!window.desktop && (
        <div style={styles.error}>
          当前不是 Electron 桌面环境。请运行 <code>npm run electron</code> 启动持久化桌面中控台；
          纯浏览器壳层不包含 Node 原生账本（better-sqlite3）。
        </div>
      )}
      {error && <div style={styles.error}>⚠ {error}</div>}

      <div style={styles.stats}>
        <Stat label="表 / 会话" value={`${tables.length}`} />
        <Stat label="事件数" value={snapshot ? String(snapshot.events.length) : '-'} />
        <Stat label="决策快照" value={snapshot ? String(snapshot.decisions.length) : '-'} />
        <Stat label="模拟回执" value={snapshot ? String(snapshot.receipts.length) : '-'} />
        <Stat label="预留敞口" value={risk ? risk.reservedExposure.toFixed(2) : '-'} />
        <Stat label="当日已执行" value={risk ? risk.executedToday.toFixed(2) : '-'} />
        <Stat label="当日净盈亏" value={risk ? formatPnl(-risk.dayLoss) : '-'} />
        <Stat label="DB" value={snapshot?.isOpen ? '✓ 持久化已连接' : '✗ 已关闭'} />
      </div>

      {snapshot && (
        <pre style={styles.meta}>
          {snapshot.dbPath}   ·   最近演示种子: {snapshot.seed ?? '-'}   ·   风控上限: {snapshot.snapshot.riskLimits.defaultExposureCap}
        </pre>
      )}

      {tables.length > 0 ? (
        <div style={styles.tableGrid}>
          {tables.map(t => (
            <TableCard
              key={t.tableId}
              actor={t}
              deckInput={deckInputs[t.tableId] ?? ''}
              onDeckInputChange={value => setDeckInputs(prev => ({ ...prev, [t.tableId]: value }))}
              onCorrectDecks={() => void correctDecks(t.tableId)}
              onArm={() => void setAutoBet(t.tableId, true, t.projection.shoeId || undefined)}
              onDisarm={() => void setAutoBet(t.tableId, false, t.projection.shoeId || undefined)}
            />
          ))}
        </div>
      ) : (
        <div style={styles.empty}>尚未注册牌桌。点击“注入演示牌流”或通过适配器推送真实归一化事件。</div>
      )}
      <div style={styles.section}>
        <h2>最近事件（尾部 {recentEvents.length} 条）</h2>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>seq</th><th style={styles.th}>类型</th><th style={styles.th}>牌桌</th><th style={styles.th}>牌靴 / 牌局</th><th style={styles.th}>时间</th>
            </tr>
          </thead>
          <tbody>
            {recentEvents.map(e => (
              <tr key={`${e.tableId}:${e.eventId}`}>
                <td style={styles.td}>{e.sourceSeq}</td>
                <td style={styles.td}>{e.type}</td>
                <td style={styles.td}>{e.tableId}</td>
                <td style={styles.td}>{shoeAndHand(e)}</td>
                <td style={styles.td}>{e.timestamp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={styles.section}>
        <h2>最近决策快照</h2>
        {recentDecisions.length === 0 ? <p>暂无决策</p> : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>牌桌</th><th style={styles.th}>牌局</th><th style={styles.th}>市场</th>
                <th style={styles.th}>pMean</th><th style={styles.th}>pLower</th><th style={styles.th}>evLower</th>
                <th style={styles.th}>资格</th><th style={styles.th}>原因</th>
              </tr>
            </thead>
            <tbody>
              {recentDecisions.map(d => (
                <tr key={d.snapshotId}>
                  <td style={styles.td}>{d.tableId}</td>
                  <td style={styles.td}>{d.handId}</td>
                  <td style={styles.td}>{d.market}</td>
                  <td style={styles.td}>{d.pMean.toFixed(6)}</td>
                  <td style={styles.td}>{d.pLower.toFixed(6)}</td>
                  <td style={styles.td}>{d.evLower.toFixed(6)}</td>
                  <td style={styles.td}>{d.eligible ? '✅' : '❌'}</td>
                  <td style={{ ...styles.td, fontSize: 12 }}>{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={styles.section}>
        <h2>风控预留 / 回执审计</h2>
        <div style={styles.auditGrid}>
          <div>
            <h3>Reservations</h3>
            {snapshot?.reservations.slice(-10).map(r => (
              <div key={r.reservationId} style={styles.auditRow}>
                <code>{r.tableId}/{r.shoeId}/{r.handId}/{r.market}</code>
                <span>{r.status} @ {r.amount}</span>
                <span>{r.realizedPnl === undefined ? '' : `pnl=${r.realizedPnl.toFixed(2)}`}</span>
              </div>
            ))}
          </div>
          <div>
            <h3>Receipts</h3>
            {snapshot?.receipts.slice(-10).map(row => (
              <div key={row.receipt.receiptId} style={styles.auditRow}>
                <code>{row.tableId}/{row.handId}/{row.market}</code>
                <span>{row.receipt.status} @ {row.receipt.amount}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
function TableCard(props: {
  actor: TableActorSnapshot;
  deckInput: string;
  onDeckInputChange: (value: string) => void;
  onCorrectDecks: () => void;
  onArm: () => void;
  onDisarm: () => void;
}) {
  const { actor } = props;
  const p = actor.projection;
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <strong>{actor.tableId}</strong>
        <span style={styles.badge}>{p.status}</span>
      </div>
      <div style={styles.cardBody}>
        <Row label="牌靴" value={p.shoeId || '-'} />
        <Row label="自动下注" value={p.autoBetStatus} />
        <Row label="连接" value={p.connectionStatus} />
        <Row label="剩余牌数" value={`${p.remainingTotal} / 已见 ${p.seenCards.length}`} />
        <Row label="模型版本" value={p.modelRevision} />
        <Row label="红牌 / 封存" value={`${p.redCardSeen ? '是' : '否'} / ${p.sealed ? '是' : '否'}`} />
        <Row label="执行模式" value={`${actor.executionMode} @ ${actor.defaultBetAmount}`} />
      </div>
      <div style={styles.cardControls}>
        <button style={styles.smallPrimary} onClick={props.onArm}>武装</button>
        <button style={styles.smallButton} onClick={props.onDisarm}>解除武装</button>
        <input
          style={styles.input}
          value={props.deckInput}
          placeholder="副数 1..20"
          onChange={e => props.onDeckInputChange(e.target.value)}
        />
        <button style={styles.smallButton} onClick={props.onCorrectDecks}>修正副数</button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function shoeAndHand(event: NormalizedEvent): string {
  const e = event as unknown as Record<string, unknown>;
  const shoe = typeof e.shoeId === 'string' ? e.shoeId : '-';
  const hand = typeof e.handId === 'string' ? e.handId : '-';
  return `${shoe} / ${hand}`;
}

function formatPnl(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}`;
}
const styles: Record<string, CSSProperties> = {
  page: { padding: 24, maxWidth: 1280, margin: '0 auto', color: '#e2e8f0' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 26 },
  subtitle: { margin: '6px 0 0', color: '#94a3b8', fontSize: 13 },
  actions: { display: 'flex', gap: 8 },
  primary: { background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 14, cursor: 'pointer' },
  button: { background: '#334155', color: 'white', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 14, cursor: 'pointer' },
  smallPrimary: { background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' },
  smallButton: { background: '#334155', color: 'white', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' },
  input: { background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 86 },
  error: { background: '#450a0a', border: '1px solid #ef4444', borderRadius: 8, padding: 12, margin: '12px 0', fontSize: 13 },
  meta: { fontFamily: 'monospace', background: '#1e293b', padding: 10, borderRadius: 8, overflowX: 'auto', fontSize: 12, margin: '12px 0' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, margin: '16px 0' },
  stat: { background: '#1e293b', borderRadius: 12, padding: '12px 14px' },
  statLabel: { fontSize: 12, color: '#94a3b8' },
  statValue: { fontSize: 22, fontWeight: 700, marginTop: 4, overflowWrap: 'anywhere' },
  tableGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 },
  card: { background: '#1e293b', borderRadius: 12, padding: 16 },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 17, marginBottom: 10 },
  badge: { background: '#0f172a', borderRadius: 999, padding: '3px 10px', fontSize: 12, color: '#94a3b8' },
  cardBody: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 12px', fontSize: 13, marginBottom: 12 },
  row: { display: 'contents' },
  rowLabel: { color: '#94a3b8' },
  cardControls: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  empty: { background: '#1e293b', borderRadius: 12, padding: 18, marginTop: 12, color: '#94a3b8' },
  section: { marginTop: 26 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 12, marginTop: 8, background: '#0f172a', borderRadius: 8 },
  th: { textAlign: 'left', padding: '8px', borderBottom: '1px solid #334155', color: '#94a3b8', whiteSpace: 'nowrap' },
  td: { padding: '6px 8px', borderBottom: '1px solid #1e293b', verticalAlign: 'top' },
  auditGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  auditRow: { display: 'flex', justifyContent: 'space-between', gap: 10, background: '#1e293b', borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontSize: 12, flexWrap: 'wrap' },
};
