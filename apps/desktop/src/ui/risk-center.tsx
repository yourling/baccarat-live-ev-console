import { useEffect, useState } from 'react';
import type { RiskLimits, RiskExposureState, RiskReservation } from '@baccarat/contracts';
import type { DesktopPerformanceReport } from '../api-types';

/**
 * 风控中心（拍板决策 #4 / 清单 §6）：
 * 全局限额占用、单桌/单靴限额、UNKNOWN 敞口聚合、分桌占用 TopN、断连排行。
 * 只读视图；勾销操作仍在资金账本页进行（语义：不宣称输赢）。
 */
export function RiskCenter({ riskState, riskLimits, reservations }: {
  readonly riskState: RiskExposureState | undefined;
  readonly riskLimits: RiskLimits | undefined;
  readonly reservations: readonly RiskReservation[];
}) {
  const [report, setReport] = useState<DesktopPerformanceReport | null>(null);
  const [reportError, setReportError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.desktop?.performanceReport()
      .then(result => { if (!cancelled) setReport(result); })
      .catch(err => { if (!cancelled) setReportError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  const dayLoss = riskState?.dayLoss ?? 0;
  const perDayLossLimit = riskLimits?.perDayLossLimit ?? 0;
  const dayOccupancy = perDayLossLimit > 0 ? Math.min(100, (dayLoss / perDayLossLimit) * 100) : 0;
  const unknown = reservations.filter(reservation => reservation.status === 'UNKNOWN');
  const unknownExposure = unknown.reduce((sum, reservation) => sum + reservation.maxLoss, 0);
  const active = reservations.filter(reservation => reservation.status === 'RESERVED' || reservation.status === 'UNKNOWN');
  const byTable = new Map<string, { tableId: string; exposure: number; count: number }>();
  for (const reservation of active) {
    const entry = byTable.get(reservation.tableId)
      ?? { tableId: reservation.tableId, exposure: 0, count: 0 };
    entry.exposure += reservation.status === 'UNKNOWN' ? reservation.maxLoss : reservation.amount;
    entry.count += 1;
    byTable.set(reservation.tableId, entry);
  }
  const topTables = [...byTable.values()].sort((left, right) => right.exposure - left.exposure).slice(0, 8);

  return (
    <section className="record-section risk-center">
      <div className="record-heading"><h2>风控中心</h2></div>

      <div className="risk-center__grid">
        <div className="risk-card">
          <h3>全局日限额占用</h3>
          <div className="risk-card__value">
            {formatSignedAmount(-dayLoss)}
            <span className="risk-card__cap"> / {perDayLossLimit > 0 ? formatAmount(perDayLossLimit) : '未设限'}</span>
          </div>
          <div className="risk-bar" role="progressbar" aria-valuenow={Math.round(dayOccupancy)} aria-valuemin={0} aria-valuemax={100}>
            <span className={cxRiskBar(dayOccupancy)} style={{ width: `${dayOccupancy}%` }} />
          </div>
          <p className="risk-card__note">亏损口径 perDayLossLimit，占用 {dayOccupancy.toFixed(1)}%</p>
        </div>

        <div className="risk-card">
          <h3>单桌 / 单靴亏损限额</h3>
          <div className="risk-card__value">
            {riskLimits ? formatAmount(riskLimits.perTableLossLimit) : '-'}
            <span className="risk-card__cap"> / {riskLimits ? formatAmount(riskLimits.perShoeLossLimit) : '-'}</span>
          </div>
          <p className="risk-card__note">按桌（perTableLossLimit）/ 按靴（perShoeLossLimit），不随日切重置</p>
        </div>

        <div className="risk-card risk-card--unknown">
          <h3>UNKNOWN 敞口</h3>
          <div className="risk-card__value">
            {unknown.length} 笔
            <span className="risk-card__cap"> / {formatAmount(unknownExposure)}</span>
          </div>
          <p className="risk-card__note">占用限额直到勾销或确权结算；勾销在「资金账本」页操作，不宣称输赢</p>
        </div>

        <div className="risk-card">
          <h3>执行并发上限</h3>
          <div className="risk-card__value">{riskLimits?.maxConcurrentExecutions ?? '-'}</div>
          <p className="risk-card__note">本机为唯一 executor（active_executor_count == 1）</p>
        </div>
      </div>

      <div className="risk-center__columns">
        <div className="risk-card">
          <h3>分桌占用 TopN</h3>
          {topTables.length === 0
            ? <p className="risk-card__note">当前无在途敞口。</p>
            : (
              <table className="record-table risk-card__table">
                <thead><tr><th>牌桌</th><th>笔数</th><th>占用敞口</th></tr></thead>
                <tbody>
                  {topTables.map(row => (
                    <tr key={row.tableId}>
                      <td>{row.tableId}</td>
                      <td>{row.count}</td>
                      <td>{formatAmount(row.exposure)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        <div className="risk-card">
          <h3>断连排行（5 分钟窗口）</h3>
          {reportError ? <p className="risk-card__note">{reportError}</p>
            : report === null ? <p className="risk-card__note">加载中…</p>
              : report.disconnectRanking.length === 0
                ? <p className="risk-card__note">近期无断连记录。</p>
                : (
                  <table className="record-table risk-card__table">
                    <thead><tr><th>牌桌</th><th>断连次数</th><th>最近断连</th></tr></thead>
                    <tbody>
                      {report.disconnectRanking.map(row => (
                        <tr key={row.tableId}>
                          <td>{row.tableId}</td>
                          <td>{row.disconnects}</td>
                          <td>{new Date(row.lastDisconnectAt).toLocaleTimeString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
        </div>
      </div>
    </section>
  );
}

function cxRiskBar(occupancy: number): string {
  if (occupancy >= 80) return 'risk-bar__fill risk-bar__fill--danger';
  if (occupancy >= 50) return 'risk-bar__fill risk-bar__fill--warn';
  return 'risk-bar__fill risk-bar__fill--ok';
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

function formatSignedAmount(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return sign + Math.abs(value).toFixed(2);
}
