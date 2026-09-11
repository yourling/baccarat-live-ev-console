import { useState } from 'react';
import type { DesktopPerformanceReport } from '../api-types';

const STATUS_LABELS: Record<string, string> = {
  RESERVED: '已预留',
  ACCEPTED: '已受理',
  SETTLED: '已结算',
  RELEASED: '已释放',
  UNKNOWN: '未知敞口',
};

const pnlClassName = (pnl: number): string =>
  pnl > 0 ? 'perf-card__pnl perf-card__pnl--win' : pnl < 0 ? 'perf-card__pnl perf-card__pnl--loss' : 'perf-card__pnl';

/**
 * 总览页的聚合复盘卡片：按需加载（点开才拉取），展示结算/盈亏汇总、
 * UNKNOWN 敞口、断连排行。只读，不影响任何执行路径。
 */
export function PerformanceCard() {
  const [report, setReport] = useState<DesktopPerformanceReport | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = (): void => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (report !== null || loading) return;
    setLoading(true);
    void window.desktop?.performanceReport()
      .then(setReport)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  return (
    <section className="record-section perf-card">
      <div className="section-heading">
        <span>聚合复盘</span>
        <button className="button button--small" type="button" onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      {expanded && (
        loading ? <div className="notice notice--info">正在汇总账本…</div>
          : error ? <div className="notice notice--warn">{error}</div>
            : report === null ? null
              : (
                  <div className="perf-card__body">
                    <div className="perf-card__totals">
                      <span>预留总数 {report.totals.reservations}</span>
                      <span className={pnlClassName(report.totals.realizedPnl)}>
                        实现盈亏 {report.totals.realizedPnl >= 0 ? '+' : ''}{report.totals.realizedPnl.toFixed(2)}
                      </span>
                      <span>未知敞口 {report.totals.unknownCount} 笔 / {report.totals.unknownExposure}</span>
                    </div>
                    {report.byShoe.length > 0 && (
                      <div className="table-scroll">
                        <table className="record-table perf-card__table">
                          <thead>
                            <tr>
                              <th>牌桌</th><th>靴</th><th>手数</th><th>投入</th><th>实现盈亏</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.byShoe.map(row => (
                              <tr key={`${row.tableId}|${row.shoeId}`}>
                                <td>{row.tableId}</td>
                                <td>{row.shoeId}</td>
                                <td>{row.hands}</td>
                                <td>{row.stake}</td>
                                <td className={pnlClassName(row.realizedPnl)}>
                                  {row.realizedPnl >= 0 ? '+' : ''}{row.realizedPnl.toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="perf-card__meta">
                      <span>
                        预留状态：
                        {Object.entries(report.reservationsByStatus)
                          .map(([status, count]) => `${STATUS_LABELS[status] ?? status} ${count}`)
                          .join(' · ') || '无'}
                      </span>
                      {report.disconnectRanking.length > 0 && (
                        <span>
                          断连排行：
                          {report.disconnectRanking
                            .map(row => `${row.tableId} ×${row.disconnects}`)
                            .join(' · ')}
                        </span>
                      )}
                    </div>
                  </div>
                )
      )}
    </section>
  );
}
