import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type {
  AutoBetStatus,
  BetTier,
  BettingMarket,
  Card,
  CardRank,
  ConnectionStatus,
  DecisionSnapshot,
  ExecutionMarket,
  NormalizedEvent,
  RiskLimits,
  RiskReservation,
  ShoeStateProjection,
  TableStatus,
} from '@baccarat/contracts';
import type { DecisionHandRecord, OperationalWagerRecord } from '@baccarat/ledger-state';
import type {
  DesktopConsoleSnapshot,
  DesktopKeepaliveState,
  DesktopRecordPage,
  DesktopRecordQuery,
  DesktopRuntimeIncident,
  DesktopShoeEvidence,
  LedgerPageRow,
  MonitorTableCandidate,
  ReceiptRow,
  TableActorSnapshot,
} from '../api-types';
import {
  planExecutionModeChange,
  type ExecutionMode,
} from './execution-mode';
import { useConfirmationDialog } from './confirmation-dialog';
import {
  OperationalWagerControls,
  bettingPhaseLabel,
  useNow,
} from './operational-wager-controls';
import { KeepaliveSettings } from './keepalive-settings';
import { resolveVisibleHandCards } from './hand-cards';
import { selectPragmaticMonitorTableIds } from './monitor-table-selection';
import { evaluateProjectionPairMarket } from './pair-evaluation';
import { decisionHandExplanation, planRecordViewChange, recordKindForView, recordTabCount, type ConsoleView } from './record-view';
import './styles.css';

type View = ConsoleView;
type FilterValue = 'all';
type MarketFilter = FilterValue | BettingMarket;
type DecisionFilter = FilterValue | 'eligible' | 'ineligible';
type EventFilter = FilterValue | NormalizedEvent['type'];
type MonitorDropTarget = {
  readonly tableId: string;
  readonly placement: 'before' | 'after';
};
type SnapshotRequestToken = {
  readonly sequence: number;
  readonly monitorMutationSequence: number;
};
type MarketEvaluation = { pMean: number; pLower: number; evMean: number; evLower: number };

interface OverviewTableRow {
  tableId: string;
  hands: number;
  bets: number;
  amount: number;
  expectedPnl: number;
  actualPnl: number;
}

interface OverviewStats {
  hands: number;
  bets: number;
  amount: number;
  expectedPnl: number;
  actualPnl: number;
}

interface IncomePoint {
  createdAt: string;
  expectedPnl: number;
  actualPnl: number;
}

interface BetLedgerRow {
  reservation: RiskReservation;
  decision?: DecisionSnapshot;
  receipt?: ReceiptRow;
  operationalWager?: OperationalWagerRecord;
  createdAt: string;
  resultLabel: string;
  resultTone: 'good' | 'danger' | 'warning' | 'neutral';
  realizedPnl?: number;
  expectedPnl?: number;
}

interface UnifiedBetSettingsDraft {
  minEV: string;
  defaultBetAmount: string;
  tiers: { minEV: string; amount: string }[];
}

interface RecordQueryFilters {
  tableId: string;
  market: MarketFilter;
  decision: DecisionFilter;
  event: EventFilter;
  search: string;
  startTime: string;
  endTime: string;
}

interface RiskSettingsDraft {
  perTableLossLimit: string;
  perShoeLossLimit: string;
  perDayLossLimit: string;
  betSizingMode: 'fixed' | 'capitalPercent';
  bankroll: string;
  bankrollPercent: string;
  maxPerBet: string;
}

const CARD_RANKS: CardRank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const MARKET_LABELS: Record<ExecutionMarket, string> = {
  banker: '庄',
  player: '闲',
  bankerPair: '庄对',
  playerPair: '闲对',
};

const STATUS_LABELS: Record<TableStatus, string> = {
  WAITING_NEW_SHOE: '等待新牌靴',
  WAITING_CONFIRMATION: '等待确认',
  TRACKING: '跟踪中',
  BETTING_WINDOW: '下注窗口',
  PENDING_SETTLEMENT: '等待结算',
  RED_CARD_WIND_DOWN: '红牌收尾',
  RESYNCING: '重新同步',
  INVALIDATED: '已作废',
};

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  CONNECTED: '已连接',
  RESYNCING: '同步中',
  DISCONNECTED: '已断开',
  EXPIRED: '已过期',
};

const AUTO_BET_LABELS: Record<AutoBetStatus, string> = {
  DISARMED: '自动下注已暂停',
  ARMED: '自动下注已开启',
  NEEDS_MANUAL_RECOVERY: '需要人工恢复',
};

const EVENT_LABELS: Record<NormalizedEvent['type'], string> = {
  newShoeSignal: '新牌靴',
  shoeConfirmation: '牌靴确认',
  cardObserved: '识别牌面',
  bettingWindowOpened: '开放下注',
  bettingWindowClosed: '关闭下注',
  handSettled: '牌局结算',
  redCardSeen: '发现红牌',
  burnModelUpdated: '烧牌模型更新',
  connectionLost: '连接断开',
  connectionRestored: '连接恢复',
  betReceipt: '下注回执',
  shoeInvalidated: '牌靴作废',
  manualCorrection: '人工修正',
  autoArmChanged: '自动下注已开启',
  autoDisarmChanged: '自动下注已暂停',
};

const EVENT_TYPE_OPTIONS = Object.entries(EVENT_LABELS) as Array<[NormalizedEvent['type'], string]>;
const RECEIPT_STATUS_LABELS: Record<string, string> = {
  SIMULATED: '模拟已执行',
  ACCEPTED: '已接受',
  REJECTED: '已拒绝',
  UNKNOWN: '状态未知',
};
export function App() {
  const { confirm, dialog } = useConfirmationDialog();
  const [snapshot, setSnapshot] = useState<DesktopConsoleSnapshot | null>(null);
  const [recordPage, setRecordPage] = useState<DesktopRecordPage | null>(null);
  const [recordLoading, setRecordLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [keepaliveSaving, setKeepaliveSaving] = useState(false);
  const [demoSpeed, setDemoSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [deckInputs, setDeckInputs] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>('overview');
  const [tableFilter, setTableFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('all');
  const [statusFilter, setStatusFilter] = useState<TableStatus | FilterValue>('all');
  const [connectionFilter, setConnectionFilter] = useState<ConnectionStatus | FilterValue>('all');
  const [autoBetFilter, setAutoBetFilter] = useState<AutoBetStatus | FilterValue>('all');
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all');
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [recordQueryRevision, setRecordQueryRevision] = useState(0);
  const [activeRecordFilters, setActiveRecordFilters] = useState<RecordQueryFilters>({
    tableId: 'all',
    market: 'all',
    decision: 'all',
    event: 'all',
    search: '',
    startTime: '',
    endTime: '',
  });
  const [draggedTableId, setDraggedTableId] = useState<string | null>(null);
  const [monitorDropTarget, setMonitorDropTarget] = useState<MonitorDropTarget | null>(null);
  const [monitorTableSaving, setMonitorTableSaving] = useState(false);
  const [reconcilingReservationId, setReconcilingReservationId] = useState<string | null>(null);
  const [selectedMonitorTableId, setSelectedMonitorTableId] = useState<string | null>(null);
  const [pendingLiveExecutionTableId, setPendingLiveExecutionTableId] = useState<string | null>(null);
  const [alertCenterOpen, setAlertCenterOpen] = useState(false);
  const [acknowledgingIncidentId, setAcknowledgingIncidentId] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const recordRequestSequenceRef = useRef(0);
  const snapshotSequenceRef = useRef(0);
  const monitorMutationSequenceRef = useRef(0);
  const pendingMonitorMutationsRef = useRef(0);
  const desktopReady = typeof window !== 'undefined' && Boolean(window.desktop);

  const beginSnapshotRequest = useCallback((): SnapshotRequestToken => ({
    sequence: ++snapshotSequenceRef.current,
    monitorMutationSequence: monitorMutationSequenceRef.current,
  }), []);

  const beginMonitorTableMutation = useCallback((): SnapshotRequestToken => {
    pendingMonitorMutationsRef.current += 1;
    const monitorMutationSequence = ++monitorMutationSequenceRef.current;
    return {
      sequence: ++snapshotSequenceRef.current,
      monitorMutationSequence,
    };
  }, []);

  const canApplySnapshot = useCallback((token: SnapshotRequestToken): boolean => (
    token.sequence === snapshotSequenceRef.current
      && token.monitorMutationSequence === monitorMutationSequenceRef.current
      && pendingMonitorMutationsRef.current === 0
  ), []);

  const finishMonitorTableMutation = useCallback((token: SnapshotRequestToken, nextSnapshot?: DesktopConsoleSnapshot): boolean => {
    pendingMonitorMutationsRef.current = Math.max(0, pendingMonitorMutationsRef.current - 1);
    const isCurrentMutation = token.monitorMutationSequence === monitorMutationSequenceRef.current;
    if (isCurrentMutation && nextSnapshot !== undefined) {
      // A refresh that started while this mutation was in flight is now stale.
      snapshotSequenceRef.current += 1;
      setSnapshot(nextSnapshot);
    }
    return isCurrentMutation;
  }, []);

  const refreshBusyRef = useRef(false);
  const refresh = useCallback(async () => {
    if (!window.desktop || refreshBusyRef.current) return;
    const request = beginSnapshotRequest();
    refreshBusyRef.current = true;
    try {
      const nextSnapshot = await window.desktop.snapshot({
        includeHistory: false,
        includeRecordCounts: view !== 'monitor' && view !== 'settings',
        includeSummary: view === 'overview',
        tableId: tableFilter === 'all' ? undefined : tableFilter,
        fromTime: startTime || undefined,
        toTime: endTime || undefined,
      });
      if (!canApplySnapshot(request)) return;
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (e) {
      if (!canApplySnapshot(request)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      refreshBusyRef.current = false;
    }
  }, [beginSnapshotRequest, canApplySnapshot, view, tableFilter, startTime, endTime]);

  const toggleDemo = useCallback(async () => {
    if (!window.desktop) return;
    const running = snapshot?.demoRunning ?? false;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(running ? await window.desktop.stopDemo() : await window.desktop.startDemo());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [snapshot?.demoRunning]);

  const changeDemoSpeed = useCallback(async (speed: number) => {
    const nextSpeed = Math.max(1, Math.min(10, Math.round(speed)));
    setDemoSpeed(nextSpeed);
    if (!window.desktop) return;
    try {
      setSnapshot(await window.desktop.setDemoSpeed(nextSpeed));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const clearRecords = useCallback(async () => {
    if (!window.desktop) return;
    const initialConfirmed = await confirm({
      title: '清除监控记录',
      description: '将清除全部事件、决策和下注账本记录，并重置当前监控状态。',
      details: [
        { label: '将被清除', value: '事件、决策、下注账本' },
        { label: '仍会保留', value: '牌桌与下注设置' },
      ],
      confirmLabel: '继续',
      tone: 'danger',
    });
    if (!initialConfirmed) return;
    const finalConfirmed = await confirm({
      title: '再次确认永久清除',
      description: '此操作不可恢复，并会回收本地记录占用的空间。',
      confirmLabel: '永久清除',
      tone: 'danger',
    });
    if (!finalConfirmed) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await window.desktop.clearMonitorData());
      setRecordPage(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [confirm]);

  useEffect(() => {
    void refresh();
    const intervalMs = view === 'monitor' ? 1_000 : 2_000;
    timerRef.current = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [refresh, view]);

  useEffect(() => {
    if (snapshot) setDemoSpeed(snapshot.demoSpeed);
  }, [snapshot?.demoSpeed]);

  const recordFilters = useMemo<RecordQueryFilters>(() => ({
    tableId: tableFilter,
    market: marketFilter,
    decision: decisionFilter,
    event: eventFilter,
    search: query,
    startTime,
    endTime,
  }), [tableFilter, marketFilter, decisionFilter, eventFilter, query, startTime, endTime]);

  const loadRecords = useCallback(async () => {
    if (!window.desktop) return;
    const requestSequence = ++recordRequestSequenceRef.current;
    const kind = recordKindForView(view);
    if (!kind) {
      setRecordPage(null);
      setRecordLoading(false);
      return;
    }
    setRecordLoading(true);
    const recordQuery: DesktopRecordQuery = {
      kind,
      page,
      pageSize,
      tableId: activeRecordFilters.tableId === 'all' ? undefined : activeRecordFilters.tableId,
      market: activeRecordFilters.market === 'all' ? undefined : activeRecordFilters.market,
      eventType: kind === 'events' && activeRecordFilters.event !== 'all' ? activeRecordFilters.event : undefined,
      eligible: kind === 'decisions' && activeRecordFilters.decision !== 'all' ? activeRecordFilters.decision === 'eligible' : undefined,
      search: activeRecordFilters.search,
      fromTime: activeRecordFilters.startTime || undefined,
      toTime: activeRecordFilters.endTime || undefined,
    };
    try {
      const nextPage = await window.desktop.queryRecords(recordQuery);
      if (requestSequence !== recordRequestSequenceRef.current) return;
      setRecordPage(nextPage);
    } catch (error) {
      if (requestSequence !== recordRequestSequenceRef.current) return;
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestSequence === recordRequestSequenceRef.current) setRecordLoading(false);
    }
  }, [view, page, pageSize, activeRecordFilters]);

  const loadRecordsRef = useRef(loadRecords);

  useEffect(() => {
    loadRecordsRef.current = loadRecords;
  }, [loadRecords]);

  useEffect(() => {
    if (recordQueryRevision === 0) return;
    void loadRecordsRef.current();
  }, [recordQueryRevision]);

  useEffect(() => {
    if (recordKindForView(view)) return;
    setPage(1);
  }, [view, tableFilter, query, marketFilter, statusFilter, connectionFilter, autoBetFilter, decisionFilter, eventFilter, startTime, endTime, pageSize]);

  const tables = useMemo(() => {
    if (!snapshot) return [];
    const monitorOrder = new Map(snapshot.monitorTableIds.map((tableId, index) => [tableId, index]));
    return Object.values(snapshot.snapshot.tables).sort((left, right) => {
      const leftOrder = monitorOrder.get(left.tableId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = monitorOrder.get(right.tableId) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.tableId.localeCompare(right.tableId, undefined, { numeric: true });
    });
  }, [snapshot]);
  const tableMap = useMemo(() => new Map(tables.map(table => [table.tableId, table])), [tables]);
  const monitorMetadata = useMemo(() => new Map(
    (snapshot?.tableMetadata ?? snapshot?.monitorCandidates ?? []).map(candidate => [candidate.tableId, candidate]),
  ), [snapshot?.tableMetadata, snapshot?.monitorCandidates]);
  const tableLabel = useCallback(
    (tableId: string) => monitorMetadata.get(tableId)?.displayName ?? tableName(tableId),
    [monitorMetadata],
  );
  const monitoredTableIds = new Set(snapshot?.monitorTableIds ?? []);
  const monitorCandidates = (snapshot?.monitorCandidates ?? []).filter(candidate => !monitoredTableIds.has(candidate.tableId));
  const selectedMonitorTable = selectedMonitorTableId === null ? undefined : tableMap.get(selectedMonitorTableId);
  const automationEnabled = snapshot?.automation.enabled ?? false;
  const keepaliveEnabled = snapshot?.keepalive.enabled ?? false;
  const monitorNow = useNow(1_000);
  const visibleTables = useMemo(() => {
    if (view === 'monitor') return tables;
    return tables.filter(table => {
      const projection = table.projection;
      const queryMatch = !query || [table.tableId, tableLabel(table.tableId), projection.shoeId, projection.currentHandId ?? '']
        .some(value => value.toLowerCase().includes(query.toLowerCase()));
      return (tableFilter === 'all' || table.tableId === tableFilter)
        && (statusFilter === 'all' || projection.status === statusFilter)
        && (connectionFilter === 'all' || projection.connectionStatus === connectionFilter)
        && (autoBetFilter === 'all' || projection.autoBetStatus === autoBetFilter)
        && queryMatch;
    });
  }, [tables, view, tableFilter, query, statusFilter, connectionFilter, autoBetFilter, tableLabel]);

  const persistMonitorTableIds = useCallback(async (tableIds: readonly string[]): Promise<DesktopConsoleSnapshot | null> => {
    if (!window.desktop) return null;
    const request = beginMonitorTableMutation();
    setMonitorTableSaving(true);
    setError(null);
    try {
      const nextSnapshot = await window.desktop.updateMonitorTableIds(tableIds);
      const isCurrentMutation = finishMonitorTableMutation(request, nextSnapshot);
      if (!isCurrentMutation) return null;
      setError(null);
      return nextSnapshot;
    } catch (error) {
      const isCurrentMutation = finishMonitorTableMutation(request);
      if (!isCurrentMutation) return null;
      setError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (request.monitorMutationSequence === monitorMutationSequenceRef.current) setMonitorTableSaving(false);
    }
  }, [beginMonitorTableMutation, finishMonitorTableMutation]);

  const reorderMonitorTables = useCallback((sourceTableId: string, targetTableId: string, placement: MonitorDropTarget['placement']) => {
    const currentTableIds = snapshot?.monitorTableIds ?? tables.map(table => table.tableId);
    if (sourceTableId === targetTableId) return;
    const sourceIndex = currentTableIds.indexOf(sourceTableId);
    if (sourceIndex < 0 || !currentTableIds.includes(targetTableId)) return;
    const withoutSource = currentTableIds.filter(tableId => tableId !== sourceTableId);
    const targetIndexAfterRemoval = withoutSource.indexOf(targetTableId);
    const insertionIndex = placement === 'after' ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
    const nextTableIds = [
      ...withoutSource.slice(0, insertionIndex),
      sourceTableId,
      ...withoutSource.slice(insertionIndex),
    ];
    void persistMonitorTableIds(nextTableIds);
  }, [persistMonitorTableIds, snapshot?.monitorTableIds, tables]);

  const handleMonitorDragStart = useCallback((event: DragEvent<HTMLElement>, tableId: string) => {
    if (monitorTableSaving) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tableId);
    setDraggedTableId(tableId);
    setMonitorDropTarget(null);
  }, [monitorTableSaving]);

  const handleMonitorDragOver = useCallback((event: DragEvent<HTMLElement>, tableId: string) => {
    if (draggedTableId === null || draggedTableId === tableId || monitorTableSaving) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement: MonitorDropTarget['placement'] = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    setMonitorDropTarget({ tableId, placement });
  }, [draggedTableId, monitorTableSaving]);

  const handleMonitorDrop = useCallback((event: DragEvent<HTMLElement>, tableId: string) => {
    event.preventDefault();
    const sourceTableId = draggedTableId;
    const target = monitorDropTarget?.tableId === tableId ? monitorDropTarget : null;
    setDraggedTableId(null);
    setMonitorDropTarget(null);
    if (sourceTableId === null || sourceTableId === tableId || target === null) return;
    reorderMonitorTables(sourceTableId, tableId, target.placement);
  }, [draggedTableId, monitorDropTarget, reorderMonitorTables]);

  const handleMonitorDragEnd = useCallback(() => {
    setDraggedTableId(null);
    setMonitorDropTarget(null);
  }, []);

  const visibleEvents = useMemo(() => (snapshot?.events ?? [])
    .filter(event => {
      const eventMarket = eventMarketOf(event);
      const queryMatch = !query || [event.tableId, eventShoeId(event), eventHandId(event)]
        .some(value => value.toLowerCase().includes(query.toLowerCase()));
      return (tableFilter === 'all' || event.tableId === tableFilter)
        && (marketFilter === 'all' || eventMarket === marketFilter)
        && (eventFilter === 'all' || event.type === eventFilter)
        && timeInRange(event.timestamp, startTime, endTime)
        && queryMatch;
    })
    .slice()
    .reverse(), [snapshot, tableFilter, query, marketFilter, eventFilter, startTime, endTime]);

  const overview = useMemo(() => snapshot?.summary
    ? { rows: snapshot.summary.rows, stats: summarizeOverview(snapshot.summary.rows), incomePoints: snapshot.summary.incomePoints }
    : buildOverview(snapshot, startTime, endTime, tableFilter), [snapshot, startTime, endTime, tableFilter]);
  const visibleOverviewRows = overview.rows;
  const overviewTotals = useMemo(() => summarizeOverview(visibleOverviewRows), [visibleOverviewRows]);

  const ledgerRows = useMemo(() => buildBetLedgerRows(snapshot), [snapshot]);
  const visibleLedgerRows = useMemo(() => ledgerRows
    .filter(row => {
      const tableId = row.reservation.tableId;
      const queryMatch = !query || [tableId, row.reservation.shoeId, row.reservation.handId]
        .some(value => value.toLowerCase().includes(query.toLowerCase()));
      return (tableFilter === 'all' || tableId === tableFilter)
        && (marketFilter === 'all' || row.reservation.market === marketFilter)
        && timeInRange(row.createdAt, startTime, endTime)
        && queryMatch;
    })
    .slice()
    .reverse(), [ledgerRows, tableFilter, query, marketFilter, startTime, endTime]);

  const pagedTables = useMemo(() => paginate(visibleTables, page, pageSize), [visibleTables, page, pageSize]);
  const pagedOverviewRows = useMemo(() => paginate(visibleOverviewRows, page, pageSize), [visibleOverviewRows, page, pageSize]);
  const pagedEvents = useMemo(() => paginate(visibleEvents, page, pageSize), [visibleEvents, page, pageSize]);
  const pagedLedgerRows = useMemo(() => paginate(visibleLedgerRows, page, pageSize), [visibleLedgerRows, page, pageSize]);
  const recordKind = recordKindForView(view);
  const recordTotal = recordPage?.kind === recordKind ? recordPage.total : 0;
  const recordDecisions = recordPage?.kind === 'decisions' ? (recordPage.decisions ?? []) : [];
  const recordEvents = recordPage?.kind === 'events' ? (recordPage.events ?? []) : [];
  const recordLedgerRows = recordPage?.kind === 'ledger' ? ledgerPageRowsToView(recordPage.ledger ?? []) : [];
  const activeTotal = view === 'monitor' ? visibleTables.length : view === 'overview' ? visibleOverviewRows.length : recordKind ? recordTotal : 0;
  const activePageCount = Math.max(1, Math.ceil(activeTotal / pageSize));

  useEffect(() => {
    if (page > activePageCount) setPage(activePageCount);
  }, [page, activePageCount]);

  const risk = snapshot?.snapshot.riskState;
  const alertCount = snapshot?.runtime.incidents.filter(incident =>
    incident.active && incident.acknowledgedAt === undefined).length ?? 0;
  const eligibleCount = new Set(
    (snapshot?.decisions ?? [])
      .filter(isCurrentlyEligible)
      .map(decision => `${decision.tableId}|${decision.shoeId}|${decision.handId}`),
  ).size;

  function clearFilters() {
    setTableFilter('all');
    setQuery('');
    setMarketFilter('all');
    setStatusFilter('all');
    setConnectionFilter('all');
    setAutoBetFilter('all');
    setDecisionFilter('all');
    setEventFilter('all');
    setStartTime('');
    setEndTime('');
    setPage(1);
  }

  function runRecordQuery() {
    setActiveRecordFilters(recordFilters);
    setPage(1);
    setRecordQueryRevision(previous => previous + 1);
  }

  const reconcileUnknownOperationalWager = useCallback(async (row: BetLedgerRow) => {
    if (!window.desktop || !row.operationalWager || !canReconcileOperationalWager(row)) return;
    const accepted = await confirm({
      title: '确认平台已成交',
      description: '此操作只核对本地账本，不会再次下注，也不会自动恢复无人值守执行。',
      details: [
        { label: '牌桌 / 牌局', value: `${row.reservation.tableId} / ${row.reservation.handId}` },
        { label: '下注', value: `${MARKET_LABELS[row.reservation.market]} ${formatAmount(row.reservation.amount)}` },
      ],
      confirmLabel: '确认平台已成交',
      tone: 'danger',
    });
    if (!accepted) return;
    setReconcilingReservationId(row.reservation.reservationId);
    setError(null);
    try {
      const nextSnapshot = await window.desktop.reconcileUnknownOperationalWager({
        reservationId: row.reservation.reservationId,
        wagerId: row.operationalWager.wager.wagerId,
      });
      setSnapshot(nextSnapshot);
      setRecordQueryRevision(previous => previous + 1);
    } catch (reconciliationError) {
      setError(reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError));
    } finally {
      setReconcilingReservationId(null);
    }
  }, [confirm]);

  const settlePendingOperationalWager = useCallback(async (
    row: BetLedgerRow,
    outcome: 'WIN' | 'LOSS' | 'PUSH',
  ) => {
    if (!window.desktop || !row.operationalWager || !canSettlePendingOperationalWager(row)) return;
    const outcomeLabel = outcome === 'WIN' ? '赢' : outcome === 'LOSS' ? '输' : '和';
    const realizedPnl = outcome === 'WIN'
      ? row.reservation.maxProfit
      : outcome === 'LOSS'
        ? -row.reservation.maxLoss
        : 0;
    const accepted = await confirm({
      title: `确认人工结算为${outcomeLabel}`,
      description: '此操作只闭合本地账本，不会下注，也不会改变自动投注或无人值守开关。',
      details: [
        { label: '牌桌 / 牌局', value: `${row.reservation.tableId} / ${row.reservation.handId}` },
        { label: '下注', value: `${MARKET_LABELS[row.reservation.market]} ${formatAmount(row.reservation.amount)}` },
        { label: '净盈亏', value: formatSignedAmount(realizedPnl) },
      ],
      confirmLabel: `确认${outcomeLabel}`,
      tone: 'danger',
    });
    if (!accepted) return;
    setReconcilingReservationId(row.reservation.reservationId);
    setError(null);
    try {
      const nextSnapshot = await window.desktop.settlePendingOperationalWager({
        reservationId: row.reservation.reservationId,
        wagerId: row.operationalWager.wager.wagerId,
        outcome,
      });
      setSnapshot(nextSnapshot);
      setRecordQueryRevision(previous => previous + 1);
    } catch (settlementError) {
      setError(settlementError instanceof Error ? settlementError.message : String(settlementError));
    } finally {
      setReconcilingReservationId(null);
    }
  }, [confirm]);

  function changeRecordPage(nextPage: number) {
    setPage(nextPage);
    setRecordQueryRevision(previous => previous + 1);
  }

  function changeRecordPageSize(nextPageSize: number) {
    setPageSize(nextPageSize);
    setPage(1);
    setRecordQueryRevision(previous => previous + 1);
  }

  function changeView(nextView: View) {
    const next = planRecordViewChange(view, nextView);
    setView(next.view);
    if (!next.shouldLoadRecords) return;
    setActiveRecordFilters(recordFilters);
    setPage(1);
    setRecordQueryRevision(previous => previous + 1);
  }

  async function setAutoBet(tableId: string, armed: boolean, shoeId?: string) {
    if (!window.desktop) return;
    setError(null);
    try {
      setSnapshot(await window.desktop.setAutoBet(tableId, armed, shoeId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleKeepalive() {
    if (!window.desktop) return;
    const enabled = !(snapshot?.keepalive.enabled ?? false);
    setKeepaliveSaving(true);
    setError(null);
    try {
      setSnapshot(await window.desktop.setKeepaliveEnabled(enabled));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setKeepaliveSaving(false);
    }
  }

  async function toggleAutomation() {
    if (!window.desktop) return;
    const enabled = !(snapshot?.automation.enabled ?? false);
    const liveTableIds = snapshot?.runtime.approvedLiveTableIds ?? [];
    if (enabled && liveTableIds.length > 0) {
      const confirmed = await confirm({
        title: '开启实盘自动投注',
        description: '当前存在实盘牌桌。开启后，对子策略会按已保存设置自动执行，不影响保活。',
        details: [
          { label: '实盘牌桌', value: liveTableIds.join('、') },
        ],
        confirmLabel: '开启自动投注',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    setAutomationSaving(true);
    setError(null);
    try {
      setSnapshot(await window.desktop.setAutomationEnabled(enabled));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationSaving(false);
    }
  }

  async function setExecutionMode(tableId: string, mode: ExecutionMode) {
    if (!window.desktop) return;
    setError(null);
    try {
      setSnapshot(await window.desktop.setExecutionMode(tableId, mode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function acknowledgeRuntimeIncident(incidentId: string) {
    if (!window.desktop) return;
    setAcknowledgingIncidentId(incidentId);
    setError(null);
    try {
      setSnapshot(await window.desktop.acknowledgeRuntimeIncident(incidentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAcknowledgingIncidentId(null);
    }
  }

  async function acknowledgeAllRuntimeIncidents() {
    if (!window.desktop) return;
    setAcknowledgingIncidentId('all');
    setError(null);
    try {
      setSnapshot(await window.desktop.acknowledgeAllRuntimeIncidents());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAcknowledgingIncidentId(null);
    }
  }

  function requestExecutionModeChange(tableId: string, mode: ExecutionMode) {
    switch (planExecutionModeChange(mode).kind) {
      case 'apply-shadow':
        setPendingLiveExecutionTableId(null);
        void setExecutionMode(tableId, 'shadow');
        return;
      case 'confirm-live':
        setPendingLiveExecutionTableId(tableId);
        return;
    }
  }

  async function addMonitorCandidate(tableId: string) {
    if (!snapshot?.monitorTableIds.includes(tableId)) {
      await persistMonitorTableIds([...(snapshot?.monitorTableIds ?? []), tableId]);
    }
  }

  async function removeMonitorTable(tableId: string) {
    setSelectedMonitorTableId(null);
    await persistMonitorTableIds((snapshot?.monitorTableIds ?? []).filter(id => id !== tableId));
  }

  async function confirmPhysicalShoe(tableId: string) {
    if (!window.desktop) return;
    const confirmed = await confirm({
      title: '人工重置牌靴',
      description: '仅在平台未自动识别新牌靴时使用。正常监控流程无需人工确认。',
      details: [
        { label: '牌桌', value: tableId },
      ],
      confirmLabel: '确认重置',
      tone: 'danger',
    });
    if (!confirmed) return;
    setError(null);
    try {
      setSnapshot(await window.desktop.confirmPhysicalShoe(tableId));
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
      setError('副数必须是 1 到 20 的整数');
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
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>百家乐实时监控</h1>
        </div>
        <div className="header-actions">
          <button
            className={cx('button', keepaliveEnabled ? 'button--danger-ghost' : 'button--primary')}
            onClick={() => void toggleKeepalive()}
            disabled={!desktopReady || keepaliveSaving}
          >
            {keepaliveSaving ? (keepaliveEnabled ? '正在停止保活' : '正在开启保活') : (keepaliveEnabled ? '停止保活' : '开启保活')}
          </button>
          <button
            className={cx('button', automationEnabled ? 'button--danger-ghost' : 'button--primary')}
            onClick={() => void toggleAutomation()}
            disabled={!desktopReady || automationSaving}
          >
            {automationSaving ? (automationEnabled ? '正在停止自动投注' : '正在开启自动投注') : (automationEnabled ? '停止自动投注' : '开启自动投注')}
          </button>
          <button className="button button--primary" onClick={() => void toggleDemo()} disabled={busy || !desktopReady}>
            <span aria-hidden="true">{snapshot?.demoRunning ? '■' : '▶'}</span>
            {busy ? (snapshot?.demoRunning ? '正在停止模拟' : '正在启动模拟') : (snapshot?.demoRunning ? '停止持续模拟' : '开始持续模拟')}
          </button>
          <button className="button button--secondary" onClick={() => void refresh()} disabled={!desktopReady}>
            刷新
          </button>
        </div>
      </header>

      {!desktopReady && (
        <div className="notice notice--warning">
          桌面服务未连接
        </div>
      )}
      {error && <div className="notice notice--danger">{error}</div>}
      {snapshot?.demoError && <div className="notice notice--danger">运行提示：{snapshot.demoError}</div>}
      {snapshot && snapshot.runtime.status !== 'healthy' && (
        <div className={cx('notice', snapshot.runtime.status === 'blocked' ? 'notice--danger' : 'notice--warning')}>
          {snapshot.runtime.status === 'blocked' ? '无人值守执行已阻断' : '无人值守运行已降级'}
          {snapshot.runtime.reasons.length > 0 ? `：${snapshot.runtime.reasons.map(runtimeReasonLabel).join('、')}` : ''}
        </div>
      )}

      <section className="summary-bar" aria-label="运行摘要">
        <SummaryItem label="监控牌桌" value={String(tables.length)} />
        <SummaryItem label="可下注判断" value={String(eligibleCount)} tone={eligibleCount > 0 ? 'good' : undefined} />
        <SummaryItem
          label="告警"
          value={String(alertCount)}
          tone={alertCount > 0 ? 'warning' : 'good'}
          onClick={() => setAlertCenterOpen(true)}
        />
        <SummaryItem label="预留敞口" value={risk ? formatAmount(risk.reservedExposure) : '-'} />
        <SummaryItem label="全局当日净盈亏" value={risk ? formatSignedAmount(-risk.dayLoss) : '-'} tone={risk && risk.dayLoss > 0 ? 'danger' : undefined} />
        <span className={cx('summary-connection', snapshot?.isOpen ? 'summary-connection--good' : 'summary-connection--muted')}>
          <span className="status-dot" aria-hidden="true" />{snapshot?.isOpen ? '账本已连接' : '账本未连接'}
        </span>
      </section>

      {alertCenterOpen && snapshot && (
        <AlertCenter
          incidents={snapshot.runtime.incidents}
          acknowledgingIncidentId={acknowledgingIncidentId}
          onAcknowledge={incidentId => void acknowledgeRuntimeIncident(incidentId)}
          onAcknowledgeAll={() => void acknowledgeAllRuntimeIncidents()}
          onClose={() => setAlertCenterOpen(false)}
        />
      )}

      <nav className="view-tabs" aria-label="数据视图">
        <TabButton active={view === 'overview'} onClick={() => changeView('overview')} label="总览" count={overview.rows.length} />
        <TabButton active={view === 'monitor'} onClick={() => changeView('monitor')} label="监控" count={visibleTables.length} />
        <TabButton active={view === 'decisions'} onClick={() => changeView('decisions')} label="决策" count={recordTabCount({ currentView: view, targetKind: 'decisions', snapshotCount: snapshot?.recordCounts.decisions ?? 0, recordPage })} />
        <TabButton active={view === 'events'} onClick={() => changeView('events')} label="事件" count={recordTabCount({ currentView: view, targetKind: 'events', snapshotCount: snapshot?.recordCounts.events ?? 0, recordPage })} />
        <TabButton active={view === 'ledger'} onClick={() => changeView('ledger')} label="账本" count={recordTabCount({ currentView: view, targetKind: 'ledger', snapshotCount: snapshot?.recordCounts.ledger ?? 0, recordPage })} />
        <TabButton active={view === 'settings'} onClick={() => changeView('settings')} label="设置" />
      </nav>

      {view !== 'monitor' && view !== 'settings' && (
      <section className="filters" aria-label="筛选条件">
        <div className="filter-grid">
          <FilterControl label="牌桌">
            <select value={tableFilter} onChange={event => setTableFilter(event.target.value)}>
              <option value="all">全部牌桌</option>
              {tables.map(table => <option value={table.tableId} key={table.tableId}>{tableLabel(table.tableId)}</option>)}
            </select>
          </FilterControl>
          <FilterControl label="牌靴 / 牌局">
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="输入编号筛选" />
          </FilterControl>
          <FilterControl label="市场">
            <select value={marketFilter} onChange={event => setMarketFilter(event.target.value as MarketFilter)}>
              <option value="all">庄对与闲对</option>
              <option value="bankerPair">庄对</option>
              <option value="playerPair">闲对</option>
            </select>
          </FilterControl>
          <>
            <FilterControl label="开始时间"><input type="datetime-local" value={startTime} onChange={event => setStartTime(event.target.value)} /></FilterControl>
            <FilterControl label="结束时间"><input type="datetime-local" value={endTime} onChange={event => setEndTime(event.target.value)} /></FilterControl>
          </>
          {view === 'decisions' && <FilterControl label="资格">
            <select value={decisionFilter} onChange={event => setDecisionFilter(event.target.value as DecisionFilter)}>
              <option value="all">全部判断</option>
              <option value="eligible">达到下注条件</option>
              <option value="ineligible">未达到条件</option>
            </select>
          </FilterControl>}
          {view === 'events' && <FilterControl label="事件类型">
            <select value={eventFilter} onChange={event => setEventFilter(event.target.value as EventFilter)}>
              <option value="all">全部事件</option>
              {EVENT_TYPE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </FilterControl>}
          <button className="clear-filter" onClick={clearFilters}>清除筛选</button>
          {recordKind && (
            <div className="record-filter-actions">
              <button className="button button--small button--primary" onClick={runRecordQuery} disabled={!desktopReady || recordLoading}>查询</button>
              <button className="button button--small button--danger-ghost" onClick={() => void clearRecords()} disabled={!desktopReady || busy}>清除记录</button>
            </div>
          )}
        </div>
      </section>

      )}

      {recordLoading && recordKind && <div className="notice notice--info">正在从账本加载当前页…</div>}

      {view === 'overview' && <><OverviewPanel stats={overviewTotals} rows={pagedOverviewRows} incomePoints={overview.incomePoints} tableLabel={tableLabel} /><Pagination page={page} pageSize={pageSize} totalItems={visibleOverviewRows.length} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} /></>}

      {view === 'monitor' && (
        <main>
          {visibleTables.length > 0 ? (
            <section className="record-section monitor-section">
              <div className="table-scroll">
                <table className="record-table monitor-table">
                  <thead>
                    <tr>
                      <th>牌桌</th>
                      <th>状态</th>
                      <th>局号</th>
                      <th>开盘</th>
                      <th>连接</th>
                      <th>自动</th>
                      <th>剩余</th>
                      <th>对子 EV</th>
                      <th>闲</th>
                      <th>庄</th>
                      <th>下注</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTables.map(table => (
                      <TableMonitorRow
                        key={table.tableId}
                        actor={table}
                        metadata={monitorMetadata.get(table.tableId)}
                        runtime={snapshot?.runtime.tables[table.tableId]}
                        evidence={snapshot?.shoeEvidence?.[table.tableId]}
                        events={snapshot?.events ?? []}
                        onSnapshot={setSnapshot}
                        onOpenSettings={() => setSelectedMonitorTableId(table.tableId)}
                        onRemove={() => void removeMonitorTable(table.tableId)}
                        dragging={draggedTableId === table.tableId}
                        dropPlacement={monitorDropTarget?.tableId === table.tableId ? monitorDropTarget.placement : undefined}
                        dragDisabled={monitorTableSaving}
                        onDragStart={event => handleMonitorDragStart(event, table.tableId)}
                        onDragOver={event => handleMonitorDragOver(event, table.tableId)}
                        onDrop={event => handleMonitorDrop(event, table.tableId)}
                        onDragEnd={handleMonitorDragEnd}
                        now={monitorNow}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <EmptyState title="没有符合条件的牌桌" detail={tables.length === 0 ? '点击“开始持续模拟”创建可查看的模拟牌桌。' : '请调整筛选条件。'} />
          )}
        </main>
      )}

      {view === 'monitor' && monitorCandidates.length > 0 && (
        <section className="monitor-candidates" aria-labelledby="monitor-candidates-title">
          <div className="section-heading">
            <span id="monitor-candidates-title">待加入牌桌</span>
          </div>
          <div className="monitor-candidates__list">
            {monitorCandidates.map(candidate => (
              <div className="monitor-candidate" key={candidate.roomId + ':' + candidate.tableId}>
                <div>
                  <strong>{candidate.displayName ?? candidate.tableId}</strong>
                  <span>{candidate.displayName ? candidate.tableId : candidate.roomName ?? candidate.roomId}</span>
                  <span className="muted">#{candidate.gameCount ?? '?'} · 等待洗牌证据</span>
                </div>
                <button className="button button--small button--primary" onClick={() => void addMonitorCandidate(candidate.tableId)}>加入监控</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {selectedMonitorTable && (
        <MonitorTableSettingsDialog
          actor={selectedMonitorTable}
          evidence={snapshot?.shoeEvidence?.[selectedMonitorTable.tableId]}
          liveApproved={snapshot?.runtime.approvedLiveTableIds.includes(selectedMonitorTable.tableId) ?? false}
          riskLimits={snapshot?.snapshot.riskLimits}
          liveModeConfirmationOpen={pendingLiveExecutionTableId === selectedMonitorTable.tableId}
          onClose={() => {
            setPendingLiveExecutionTableId(null);
            setSelectedMonitorTableId(null);
          }}
          onArm={() => void setAutoBet(selectedMonitorTable.tableId, true, selectedMonitorTable.projection.shoeId || undefined)}
          onDisarm={() => void setAutoBet(selectedMonitorTable.tableId, false, selectedMonitorTable.projection.shoeId || undefined)}
          onExecutionModeChange={mode => requestExecutionModeChange(selectedMonitorTable.tableId, mode)}
          onConfirmLiveMode={() => {
            setPendingLiveExecutionTableId(null);
            void setExecutionMode(selectedMonitorTable.tableId, 'live');
          }}
          onCancelLiveMode={() => setPendingLiveExecutionTableId(null)}
          onConfirmShoe={() => void confirmPhysicalShoe(selectedMonitorTable.tableId)}
          deckInput={deckInputs[selectedMonitorTable.tableId] ?? ''}
          onDeckInputChange={value => setDeckInputs(previous => ({ ...previous, [selectedMonitorTable.tableId]: value }))}
          onCorrectDecks={() => void correctDecks(selectedMonitorTable.tableId)}
          onRemove={() => void removeMonitorTable(selectedMonitorTable.tableId)}
          tableLabel={tableLabel}
        />
      )}

      {view === 'decisions' && recordPage?.kind === 'decisions' && (
        <><DecisionTable decisions={recordDecisions} totalCount={recordTotal} tables={tableMap} tableLabel={tableLabel} /><Pagination page={page} pageSize={pageSize} totalItems={recordTotal} onPageChange={changeRecordPage} onPageSizeChange={changeRecordPageSize} /></>
      )}

      {view === 'events' && recordPage?.kind === 'events' && <><EventTable events={recordEvents} totalCount={recordTotal} tableLabel={tableLabel} /><Pagination page={page} pageSize={pageSize} totalItems={recordTotal} onPageChange={changeRecordPage} onPageSizeChange={changeRecordPageSize} /></>}

      {view === 'ledger' && recordPage?.kind === 'ledger' && <><BetLedgerView rows={recordLedgerRows} totalCount={recordTotal} reconcilingReservationId={reconcilingReservationId} tableLabel={tableLabel} onReconcile={reconcileUnknownOperationalWager} onSettle={settlePendingOperationalWager} /><Pagination page={page} pageSize={pageSize} totalItems={recordTotal} onPageChange={changeRecordPage} onPageSizeChange={changeRecordPageSize} /></>}

      {view === 'settings' && (
        <SystemSettingsView
          demoSpeed={demoSpeed}
          onSpeedChange={changeDemoSpeed}
          tables={tables}
          monitorTableIds={snapshot?.monitorTableIds ?? []}
          monitorCandidates={snapshot?.monitorCandidates ?? []}
          keepalive={snapshot?.keepalive}
          riskLimits={snapshot?.snapshot.riskLimits}
          onSnapshot={setSnapshot}
          onSaveMonitorTables={persistMonitorTableIds}
          onError={setError}
        />
      )}
      {dialog}
    </div>
  );
}

function TableMonitorRow(props: {
  actor: TableActorSnapshot;
  metadata?: MonitorTableCandidate;
  evidence?: DesktopShoeEvidence;
  runtime?: DesktopConsoleSnapshot['runtime']['tables'][string];
  events: readonly NormalizedEvent[];
  onSnapshot: (snapshot: DesktopConsoleSnapshot) => void;
  onOpenSettings: () => void;
  onRemove: () => void;
  dragging: boolean;
  dropPlacement?: MonitorDropTarget['placement'];
  dragDisabled: boolean;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  now: number;
}) {
  const { actor } = props;
  const projection = actor.projection;
  const physicalShoeKnown = isDisplayedPhysicalShoe(projection, props.evidence);
  const bankerPair = physicalShoeKnown
    ? safeEvaluate(projection.profileSnapshot, 'bankerPair', projection.seenCards, projection.remainingCounts)
    : null;
  const playerPair = physicalShoeKnown
    ? safeEvaluate(projection.profileSnapshot, 'playerPair', projection.seenCards, projection.remainingCounts)
    : null;
  const alerts = tableAlerts(actor);
  const displayName = props.metadata?.displayName ?? tableName(actor.tableId);
  const displayedRoundId = projection.currentHandId ?? props.metadata?.roundId;
  const displayedGameCount = props.metadata?.gameCount;
  const bettingPhase = bettingPhaseLabel(actor, props.now);
  const windowOpen = bettingPhase.open;
  const handCards = resolveVisibleHandCards(
    props.events,
    actor.tableId,
    projection.shoeId || null,
    displayedRoundId ?? projection.currentHandId ?? null,
  );
  const bettingLabel = bettingPhase.text;

  return (
    <tr
      className={cx(
        'monitor-table__row',
        windowOpen && 'monitor-table__row--open',
        alerts.length > 0 && 'monitor-table__row--alert',
        props.dragging && 'monitor-table__row--dragging',
        props.dropPlacement && `monitor-table__row--drop-${props.dropPlacement}`,
      )}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onClick={props.onOpenSettings}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onOpenSettings(); } }}
      tabIndex={0}
    >
      <td data-label="牌桌">
        <div className="monitor-table__identity">
          <span
            className="monitor-row__drag-handle"
            draggable={!props.dragDisabled}
            onClick={event => event.stopPropagation()}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            title={props.dragDisabled ? '正在保存牌桌顺序' : '按住并拖动以调整牌桌顺序'}
            aria-label="拖动调整牌桌顺序"
          >::</span>
          <div className="monitor-table__identity-text">
            <strong className="monitor-table__name" title={displayName}>{displayName}</strong>
            {alerts.length > 0 && <span className="alert-label">{alerts.join(' · ')}</span>}
          </div>
        </div>
      </td>
      <td data-label="状态"><Badge label={STATUS_LABELS[projection.status]} tone={statusTone(projection.status)} /></td>
      <td data-label="局号">
        <div className="monitor-table__round" title={displayedRoundId ?? '等待局号'}>
          <strong>{displayedRoundId ?? '等待局号'}</strong>
          <span className="muted">#{displayedGameCount ?? '?'}</span>
        </div>
      </td>
      <td data-label="开盘">
        <strong className={windowOpen ? 'text--good' : undefined}>{bettingLabel}</strong>
      </td>
      <td data-label="连接">
        <strong className={projection.connectionStatus === 'CONNECTED' ? undefined : 'text--danger'}>
          {CONNECTION_LABELS[projection.connectionStatus]}
        </strong>
      </td>
      <td data-label="自动"><strong>{shortAutoBetLabel(projection.autoBetStatus)}</strong></td>
      <td data-label="剩余"><strong>{physicalShoeKnown ? `${projection.remainingTotal} 张` : '未知'}</strong><br /><span className="muted">{physicalShoeKnown ? '实体新靴' : '待牌靴'}{props.evidence ? ` · ${props.evidence.label}` : ''}</span></td>
      <td data-label="对子 EV">
        {bankerPair && playerPair
          ? <span className="monitor-pair-ev">
            <strong className={evTone(bankerPair.evMean)}>庄对 {formatSignedPercent(bankerPair.evMean)}</strong>
            <span className="muted">闲对 {formatSignedPercent(playerPair.evMean)}</span>
          </span>
          : <span className="muted" title="等待物理牌靴">待牌靴</span>}
      </td>
      <td data-label="闲"><MonitorHandCards cards={handCards.player} previous={handCards.source === 'previous-settled'} /></td>
      <td data-label="庄"><MonitorHandCards cards={handCards.banker} previous={handCards.source === 'previous-settled'} /></td>
      <td data-label="下注">
        <OperationalWagerControls
          actor={actor}
          metadata={props.metadata}
          runtimeBlockedReason={manualOperationalRuntimeBlockReason(props.runtime)}
          onSnapshot={props.onSnapshot}
          compact
          now={props.now}
        />
      </td>
      <td data-label="操作">
        <button
          className="button button--small button--danger-ghost"
          type="button"
          onClick={event => { event.stopPropagation(); props.onRemove(); }}
        >移除</button>
      </td>
    </tr>
  );
}

function MonitorTableSettingsDialog(props: {
  actor: TableActorSnapshot;
  evidence?: DesktopShoeEvidence;
  liveApproved: boolean;
  riskLimits?: RiskLimits;
  liveModeConfirmationOpen: boolean;
  onClose: () => void;
  onArm: () => void;
  onDisarm: () => void;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  onConfirmLiveMode: () => void;
  onCancelLiveMode: () => void;
  onConfirmShoe: () => void;
  deckInput: string;
  onDeckInputChange: (value: string) => void;
  onCorrectDecks: () => void;
  onRemove: () => void;
  tableLabel: (tableId: string) => string;
}) {
  const { actor } = props;
  const physicalShoeKnown = isDisplayedPhysicalShoe(actor.projection, props.evidence);

  return (
    <div className="monitor-settings-overlay" role="presentation" onClick={props.onClose}>
      <section className="monitor-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="monitor-settings-title" onClick={event => event.stopPropagation()}>
        <header className="monitor-settings-dialog__header">
          <h2 id="monitor-settings-title">{props.tableLabel(actor.tableId)}</h2>
          <button className="button button--small button--ghost" onClick={props.onClose}>关闭</button>
        </header>
        <section className="monitor-settings-dialog__autobet">
          <div>
            <span>自动下注</span>
            <strong>{AUTO_BET_LABELS[actor.projection.autoBetStatus]}</strong>
            {props.evidence ? <span className="muted">{physicalShoeKnown ? '实体新靴' : '待牌靴'} · {props.evidence.label}</span> : null}
          </div>
          <div className="monitor-settings-dialog__actions">
            {!physicalShoeKnown && <button className="button button--small button--secondary" onClick={props.onConfirmShoe}>人工重置牌靴</button>}
            <button className="button button--small button--secondary" onClick={props.onArm} disabled={!physicalShoeKnown} title={physicalShoeKnown ? undefined : '物理牌靴基线未知，无法人工恢复对子策略'}>人工恢复对子策略</button>
            <button className="button button--small button--secondary" onClick={props.onDisarm}>暂停本桌对子策略</button>
            <button className="button button--small button--danger-ghost" onClick={props.onRemove}>删除监控</button>
          </div>
        </section>
        <section className="risk-settings">
          <div className="settings-fields settings-fields--risk">
            <label>
              <span>执行模式</span>
              <strong>真实下注</strong>
            </label>
          </div>
          {props.liveModeConfirmationOpen && (
            <div className="notice notice--warning" role="status">
              <span>确认启用持续实盘；自动下注保持暂停。</span>
              <div className="monitor-settings-dialog__actions">
                <button className="button button--small button--ghost" onClick={props.onCancelLiveMode}>取消</button>
                <button className="button button--small button--primary" onClick={props.onConfirmLiveMode}>确认启用</button>
              </div>
            </div>
          )}
        </section>
        <section className="risk-settings">
          <div className="settings-fields">
            <label>
              <span>副数修正</span>
              <input
                aria-label="副数修正"
                value={props.deckInput}
                inputMode="numeric"
                min="1"
                max="20"
                onChange={event => props.onDeckInputChange(event.target.value)}
              />
            </label>
            <button className="button button--small button--ghost settings-save" onClick={props.onCorrectDecks}>保存修正</button>
          </div>
        </section>
      </section>
    </div>
  );
}

function combinePairEvaluations(first: MarketEvaluation | null, second: MarketEvaluation | null): MarketEvaluation | null {
  if (first === null) return second;
  if (second === null) return first;
  return {
    pMean: (first.pMean + second.pMean) / 2,
    pLower: (first.pLower + second.pLower) / 2,
    evMean: (first.evMean + second.evMean) / 2,
    evLower: (first.evLower + second.evLower) / 2,
  };
}

function MonitorHandCards({ cards, previous }: { cards: readonly Card[]; previous: boolean }) {
  if (cards.length === 0) return <span className="muted">—</span>;
  return (
    <div className={cx('hand-cards__list', previous && 'monitor-hand--previous')} title={previous ? '上一局' : undefined}>
      {cards.map((card, index) => {
        const suit = normalizeSuit(card.suit);
        return (
          <span className={cx('card-chip', `card-chip--${suit.tone}`)} key={`${card.rank}${card.suit ?? ''}:${index}`}>
            {card.rank}{suit.glyph}
          </span>
        );
      })}
    </div>
  );
}

function PairProbability(props: { evaluation: MarketEvaluation | null; profile: ShoeStateProjection['profileSnapshot'] }) {
  const odds = props.profile.odds.bankerPair;
  const breakEven = odds.loss / (odds.netWin + odds.loss);
  return (
    <div className="pair-probability">
      <div className="pair-probability__header"><strong>对子概率与 EV</strong><span>庄对 / 闲对共用同一套计算</span></div>
      {props.evaluation ? <div className="pair-probability__metrics">
        <div><span>概率均值</span><strong>{formatPercent(props.evaluation.pMean)}</strong></div>
        <div><span>概率下界</span><strong>{formatPercent(props.evaluation.pLower)}</strong></div>
        <div><span>平均 EV</span><strong className={evTone(props.evaluation.evMean)}>{formatSignedPercent(props.evaluation.evMean)}</strong></div>
        <div><span>保本概率</span><strong>{formatPercent(breakEven)}</strong></div>
      </div> : <div className="muted">等待可信物理新牌靴后计算</div>}
    </div>
  );
}

function CompactMarket({ label, evaluation }: { label: string; evaluation: MarketEvaluation | null }) {
  return (
    <div className="compact-market">
      <div className="compact-market__label">{label}</div>
      {evaluation ? <>
        <strong>{formatPercent(evaluation.pMean)}</strong>
        <span>EV {formatSignedPercent(evaluation.evMean)}</span>
      </> : <span className="muted">暂无</span>}
    </div>
  );
}

function MarketProbability(props: {
  label: string;
  market: BettingMarket;
  evaluation: MarketEvaluation | null;
  profile: ShoeStateProjection['profileSnapshot'];
}) {
  const odds = props.profile.odds[props.market];
  const breakEven = odds.loss / (odds.netWin + odds.loss);
  if (!props.evaluation) return <div className="market-probability"><span className="muted">暂无概率数据</span></div>;
  return (
    <div className="market-probability">
      <div className="market-probability__title"><strong>{props.label}</strong><span>保本 {formatPercent(breakEven)}</span></div>
      <div className="market-probability__row"><span>概率均值</span><strong>{formatPercent(props.evaluation.pMean)}</strong></div>
      <div className="market-probability__row"><span>概率下界</span><strong>{formatPercent(props.evaluation.pLower)}</strong></div>
      <div className="market-probability__ev">
        <span>平均 EV <b className={evTone(props.evaluation.evMean)}>{formatSignedPercent(props.evaluation.evMean)}</b></span>
      </div>
    </div>
  );
}

function RemainingInventory({ projection }: { projection: ShoeStateProjection }) {
  return (
    <div className="inventory-grid">
      {CARD_RANKS.map(rank => {
        const count = projection.remainingCounts[rank];
        return <div className={cx('inventory-cell', count === 0 && 'inventory-cell--empty', count > 0 && count <= 2 && 'inventory-cell--low')} key={rank}>
          <span>{rank}</span><strong>{count}</strong>
        </div>;
      })}
    </div>
  );
}

function DecisionTable({ decisions, totalCount, tableLabel }: { decisions: DecisionHandRecord[]; totalCount: number; tables: Map<string, TableActorSnapshot>; tableLabel: (tableId: string) => string }) {
  if (decisions.length === 0) return <EmptyState title="暂无决策记录" detail="" />;
  return (
    <section className="record-section">
      <div className="record-heading"><h2>决策</h2><span className="record-count">共 {totalCount} 局</span></div>
      <div className="table-scroll">
        <table className="record-table record-table--decisions">
          <thead><tr><th>时间</th><th>牌桌 / 牌靴 / 牌局</th><th>策略选择</th><th>概率均值</th><th>概率下界</th><th>平均 EV</th><th>资格</th><th>实际结果</th><th>原因</th></tr></thead>
          <tbody>{decisions.map(decision => {
            return <tr key={`${decision.tableId}|${decision.shoeId}|${decision.handId}`}>
              <td data-label="时间">{formatTime(decision.createdAt)}</td>
              <td data-label="牌桌 / 牌局"><strong>{tableLabel(decision.tableId)}</strong><br /><span className="muted" title={`${decision.shoeId} / ${decision.handId}`}>{shortId(decision.shoeId)} / {shortId(decision.handId)}</span></td>
              <td data-label="策略">{decisionChoiceLabel(decision)}</td>
              <td data-label="概率均值">{formatPercent(decision.pMean)}</td>
              <td data-label="概率下界">{formatPercent(decision.pLower)}</td>
              <td data-label="平均 EV" className={evTone(decision.evMean)}>{formatSignedPercent(decision.evMean)}</td>
              <td data-label="资格"><Badge label={decision.eligible ? '达到条件' : '未达到'} tone={decision.eligible ? 'good' : 'neutral'} /></td>
              <td data-label="实际结果"><DecisionActualResult result={decision.actualResult} /></td>
              <td data-label="原因">{decisionHandExplanation(decision)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

function EventTable({ events, totalCount, tableLabel }: { events: NormalizedEvent[]; totalCount: number; tableLabel: (tableId: string) => string }) {
  if (events.length === 0) return <EmptyState title="暂无事件记录" detail="" />;
  return (
    <section className="record-section">
      <div className="record-heading"><h2>事件</h2><span className="record-count">共 {totalCount} 条</span></div>
      <div className="table-scroll">
        <table className="record-table record-table--events">
          <thead><tr><th>时间</th><th>牌桌</th><th>牌靴 / 牌局</th><th>事件</th><th>详情</th></tr></thead>
          <tbody>{events.map(event => <tr key={event.eventId}>
            <td data-label="时间">{formatTime(event.timestamp)}</td>
            <td data-label="牌桌">{tableLabel(event.tableId)}</td>
            <td data-label="牌靴 / 牌局"><span title={eventShoeId(event)}>{shortId(eventShoeId(event))}</span><br /><span className="muted">{shortId(eventHandId(event))}</span></td>
            <td data-label="事件"><Badge label={EVENT_LABELS[event.type]} tone={event.type === 'connectionLost' || event.type === 'shoeInvalidated' ? 'danger' : 'neutral'} /></td>
            <td data-label="详情">{eventDescription(event)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}



function OverviewPanel({ stats, rows, incomePoints, tableLabel }: { stats: OverviewStats; rows: OverviewTableRow[]; incomePoints: IncomePoint[]; tableLabel: (tableId: string) => string }) {
  return (
    <section className="overview-section">
      <div className="record-heading"><h2>总览</h2></div>
      <div className="overview-metrics">
        <OverviewMetric label="监控局数" value={String(stats.hands)} />
        <OverviewMetric label="已下注次数" value={String(stats.bets)} />
        <OverviewMetric label="下注金额" value={formatAmount(stats.amount)} />
        <OverviewMetric label="期望盈利" value={formatSignedAmount(stats.expectedPnl)} tone={stats.expectedPnl >= 0 ? 'good' : 'danger'} />
        <OverviewMetric label="实际盈利" value={formatSignedAmount(stats.actualPnl)} tone={stats.actualPnl >= 0 ? 'good' : 'danger'} />
      </div>
      <IncomeChart points={incomePoints} />
      {rows.length > 0 && <div className="table-scroll">
        <table className="record-table overview-table record-table--overview">
          <thead><tr><th>牌桌</th><th>监控局数</th><th>下注次数</th><th>下注金额</th><th>期望盈利</th><th>实际盈利</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.tableId}>
            <td data-label="牌桌"><strong>{tableLabel(row.tableId)}</strong></td>
            <td data-label="监控局数">{row.hands}</td>
            <td data-label="下注次数">{row.bets}</td>
            <td data-label="下注金额">{formatAmount(row.amount)}</td>
            <td data-label="期望盈利" className={evTone(row.expectedPnl)}>{formatSignedAmount(row.expectedPnl)}</td>
            <td data-label="实际盈利" className={evTone(row.actualPnl)}>{formatSignedAmount(row.actualPnl)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  );
}


function IncomeChart({ points }: { points: IncomePoint[] }) {
  if (points.length === 0) return <div className="income-chart income-chart--empty"><strong>暂无收益曲线</strong></div>;
  const width = 840;
  const height = 280;
  const left = 56;
  const right = 18;
  const top = 22;
  const bottom = 34;
  const values = points.flatMap(point => [point.expectedPnl, point.actualPnl, 0]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = Math.max(1, maxValue - minValue);
  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * (width - left - right);
  const y = (value: number) => top + ((maxValue - value) / range) * (height - top - bottom);
  const expectedLine = points.map((point, index) => x(index).toFixed(2) + ',' + y(point.expectedPnl).toFixed(2)).join(' ');
  const actualLine = points.map((point, index) => x(index).toFixed(2) + ',' + y(point.actualPnl).toFixed(2)).join(' ');
  const zeroY = y(0);
  return (
    <div className="income-chart">
      <div className="income-chart__head">
        <strong>累计收益曲线</strong>
        <div className="income-chart__legend"><span><i className="chart-swatch chart-swatch--expected" />期望盈利</span><span><i className="chart-swatch chart-swatch--actual" />实际盈利</span></div>
      </div>
      <svg viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label="累计期望盈利和实际盈利曲线">
        <line x1={left} y1={zeroY} x2={width - right} y2={zeroY} className="income-chart__zero" />
        <line x1={left} y1={top} x2={left} y2={height - bottom} className="income-chart__axis" />
        <polyline points={expectedLine} className="income-chart__line income-chart__line--expected" />
        <polyline points={actualLine} className="income-chart__line income-chart__line--actual" />
        <text x="6" y={top + 4} className="income-chart__label">{formatAxisAmount(maxValue)}</text>
        <text x="6" y={height - bottom + 4} className="income-chart__label">{formatAxisAmount(minValue)}</text>
        <text x={left} y={height - 8} className="income-chart__label">{formatTime(points[0].createdAt)}</text>
        <text x={width - right} y={height - 8} textAnchor="end" className="income-chart__label">{formatTime(points[points.length - 1].createdAt)}</text>
      </svg>
    </div>
  );
}

function formatAxisAmount(value: number): string {
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'k';
  return value.toFixed(0);
}

function OverviewMetric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'danger' }) {
  return <div className="overview-metric"><span>{label}</span><strong className={tone ? 'text--' + tone : undefined}>{value}</strong></div>;
}

function buildOverview(snapshot: DesktopConsoleSnapshot | null, startTime = '', endTime = '', tableFilter = 'all'): { rows: OverviewTableRow[]; stats: OverviewStats; incomePoints: IncomePoint[] } {
  if (!snapshot) return { rows: [], stats: { hands: 0, bets: 0, amount: 0, expectedPnl: 0, actualPnl: 0 }, incomePoints: [] };
  const handsByTable = new Map<string, Set<string>>();
  for (const event of snapshot.events) {
    if (event.type !== 'handSettled' || (tableFilter !== 'all' && event.tableId !== tableFilter) || !timeInRange(event.timestamp, startTime, endTime)) continue;
    const hands = handsByTable.get(event.tableId) ?? new Set<string>();
    hands.add(event.shoeId + '|' + event.handId);
    handsByTable.set(event.tableId, hands);
  }
  const rowsByTable = new Map<string, OverviewTableRow>();
  for (const [tableId, hands] of handsByTable) rowsByTable.set(tableId, { tableId, hands: hands.size, bets: 0, amount: 0, expectedPnl: 0, actualPnl: 0 });
  for (const row of buildBetLedgerRows(snapshot)) {
    if ((tableFilter !== 'all' && row.reservation.tableId !== tableFilter) || !timeInRange(row.createdAt, startTime, endTime) || !isExecutedLedgerRow(row)) continue;
    const current = rowsByTable.get(row.reservation.tableId) ?? { tableId: row.reservation.tableId, hands: 0, bets: 0, amount: 0, expectedPnl: 0, actualPnl: 0 };
    current.bets += 1;
    current.amount += row.reservation.amount;
    current.expectedPnl += row.expectedPnl ?? 0;
    current.actualPnl += row.realizedPnl ?? 0;
    rowsByTable.set(row.reservation.tableId, current);
  }
  const rows = [...rowsByTable.values()].sort((a, b) => a.tableId.localeCompare(b.tableId, undefined, { numeric: true }));
  const incomeRows = buildBetLedgerRows(snapshot)
    .filter(row => (tableFilter === 'all' || row.reservation.tableId === tableFilter) && timeInRange(row.createdAt, startTime, endTime) && isExecutedLedgerRow(row))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let expectedPnl = 0;
  let actualPnl = 0;
  const incomePoints = incomeRows.map(row => {
    expectedPnl += row.expectedPnl ?? 0;
    actualPnl += row.realizedPnl ?? 0;
    return { createdAt: row.createdAt, expectedPnl, actualPnl };
  });
  return { rows, stats: summarizeOverview(rows), incomePoints };
}

function summarizeOverview(rows: OverviewTableRow[]): OverviewStats {
  return rows.reduce((total, row) => ({
    hands: total.hands + row.hands,
    bets: total.bets + row.bets,
    amount: total.amount + row.amount,
    expectedPnl: total.expectedPnl + row.expectedPnl,
    actualPnl: total.actualPnl + row.actualPnl,
  }), { hands: 0, bets: 0, amount: 0, expectedPnl: 0, actualPnl: 0 });
}

function isExecutedLedgerRow(row: BetLedgerRow): boolean {
  if (row.operationalWager?.reconciliation?.status === 'ACCEPTED') return true;
  if (row.receipt) return row.receipt.receipt.status !== 'REJECTED';
  return row.operationalWager?.status === 'ACCEPTED';
}

function canReconcileOperationalWager(row: BetLedgerRow): boolean {
  const operationalWager = row.operationalWager;
  const raw = operationalWager?.receipt?.raw;
  const statusPairMatches = row.reservation.status === 'UNKNOWN'
    ? operationalWager?.status === 'UNKNOWN'
      && operationalWager.receipt !== undefined
    : row.reservation.status === 'RELEASED'
      && operationalWager?.status === 'REJECTED'
      && operationalWager.receipt?.status === 'REJECTED';
  return statusPairMatches
    && operationalWager?.reservationId === row.reservation.reservationId
    && typeof raw === 'object'
    && raw !== null
    && Reflect.get(raw, 'commitStarted') === true;
}

function canSettlePendingOperationalWager(row: BetLedgerRow): boolean {
  return row.reservation.status === 'RESERVED'
    && row.operationalWager?.status === 'ACCEPTED'
    && row.operationalWager.receipt?.status === 'ACCEPTED'
    && row.operationalWager.reservationId === row.reservation.reservationId
    && row.operationalWager.settlement === undefined;
}

function pendingSettlementOutcomes(row: BetLedgerRow): readonly ('WIN' | 'LOSS' | 'PUSH')[] {
  return row.reservation.market === 'bankerPair' || row.reservation.market === 'playerPair'
    ? ['WIN', 'LOSS']
    : ['WIN', 'LOSS', 'PUSH'];
}

function BetLedgerView(props: {
  rows: BetLedgerRow[];
  totalCount: number;
  reconcilingReservationId: string | null;
  tableLabel: (tableId: string) => string;
  onReconcile: (row: BetLedgerRow) => Promise<void>;
  onSettle: (row: BetLedgerRow, outcome: 'WIN' | 'LOSS' | 'PUSH') => Promise<void>;
}) {
  return (
    <>
      {props.rows.length === 0 ? <EmptyState title="暂无下注记录" detail="" /> : (
        <section className="record-section">
          <div className="record-heading">
            <h2>账本</h2>
            <span className="record-count">共 {props.totalCount} 条</span>
          </div>
          <div className="table-scroll">
            <table className="record-table ledger-table record-table--ledger">
              <thead><tr><th>时间</th><th>牌桌 / 牌局</th><th>下注对象</th><th>下注时 EV</th><th>下注金额</th><th>期望盈利</th><th>回执</th><th>实际结果</th><th>净盈亏</th></tr></thead>
              <tbody>{props.rows.map(row => (
                <tr key={row.reservation.reservationId}>
                  <td data-label="时间">{formatTime(row.createdAt)}</td>
                  <td data-label="牌桌 / 牌局"><strong>{props.tableLabel(row.reservation.tableId)}</strong><br /><span className="muted" title={row.reservation.handId}>{shortId(row.reservation.handId)}</span></td>
                  <td data-label="下注对象">{MARKET_LABELS[row.reservation.market]}</td>
                  <td data-label="下注时 EV" className={row.decision ? evTone(row.decision.evMean) : 'text--muted'}>{row.decision ? formatSignedPercent(row.decision.evMean) : '-'}</td>
                  <td data-label="下注金额">{formatAmount(row.reservation.amount)}</td>
                  <td data-label="期望盈利" className={typeof row.expectedPnl === 'number' ? evTone(row.expectedPnl) : 'text--muted'}>{typeof row.expectedPnl === 'number' ? formatSignedAmount(row.expectedPnl) : '-'}</td>
                  <td data-label="回执">
                    {row.operationalWager?.status === 'UNKNOWN' && row.operationalWager.reconciliation === undefined
                      ? receiptStatusLabel('UNKNOWN')
                      : row.receipt
                      ? receiptStatusLabel(row.receipt.receipt.status)
                      : row.operationalWager
                        ? receiptStatusLabel(row.operationalWager.reconciliation?.status ?? row.operationalWager.receipt?.status ?? row.operationalWager.status)
                        : reservationStatusLabel(row.reservation.status)}
                    {canReconcileOperationalWager(row) && (
                      <button
                        type="button"
                        className="button button--small button--danger-ghost ledger-reconcile"
                        disabled={props.reconcilingReservationId !== null}
                        onClick={() => void props.onReconcile(row)}
                      >
                        {props.reconcilingReservationId === row.reservation.reservationId ? '核对中...' : '确认平台已成交'}
                      </button>
                    )}
                  </td>
                  <td data-label="实际结果">
                    <span className={'ledger-result ledger-result--' + row.resultTone}>{row.resultLabel}</span>
                    {canSettlePendingOperationalWager(row) && (
                      <div className="ledger-settlement-actions">
                        {pendingSettlementOutcomes(row).map(outcome => (
                          <button
                            type="button"
                            className="button button--small button--ghost"
                            disabled={props.reconcilingReservationId !== null}
                            key={outcome}
                            onClick={() => void props.onSettle(row, outcome)}
                          >
                            {outcome === 'WIN' ? '赢' : outcome === 'LOSS' ? '输' : '和'}
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                  <td data-label="净盈亏" className={typeof row.realizedPnl === 'number' ? evTone(row.realizedPnl) : 'text--muted'}>{typeof row.realizedPnl === 'number' ? formatSignedAmount(row.realizedPnl) : '-'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function SystemSettingsView(props: {
  demoSpeed: number;
  onSpeedChange: (speed: number) => Promise<void>;
  tables: TableActorSnapshot[];
  monitorTableIds: readonly string[];
  monitorCandidates: readonly MonitorTableCandidate[];
  keepalive?: DesktopKeepaliveState;
  riskLimits?: RiskLimits;
  onSnapshot: (snapshot: DesktopConsoleSnapshot) => void;
  onSaveMonitorTables: (tableIds: readonly string[]) => Promise<DesktopConsoleSnapshot | null>;
  onError: (error: string | null) => void;
}) {
  return (
    <section className="system-settings">
      <div className="system-settings__header">
        <h2>设置</h2>
        <div className="system-settings__actions">
          <label className="speed-control" htmlFor="system-demo-speed">
            <span>模拟速度</span>
            <input id="system-demo-speed" type="range" min="1" max="10" step="1" value={props.demoSpeed} onChange={event => void props.onSpeedChange(Number(event.target.value))} aria-label="模拟速度" />
            <output>{props.demoSpeed}x</output>
          </label>
        </div>
      </div>
      <MonitorTableSettings tableIds={props.monitorTableIds} candidates={props.monitorCandidates} onSave={props.onSaveMonitorTables} onError={props.onError} />
      {props.keepalive && <KeepaliveSettings state={props.keepalive} onSnapshot={props.onSnapshot} onError={props.onError} />}
      <UnifiedBetSettings tableIds={props.monitorTableIds} tables={props.tables} riskLimits={props.riskLimits} onSnapshot={props.onSnapshot} onError={props.onError} />
    </section>
  );
}

function MonitorTableSettings(props: {
  tableIds: readonly string[];
  candidates: readonly MonitorTableCandidate[];
  onSave: (tableIds: readonly string[]) => Promise<DesktopConsoleSnapshot | null>;
  onError: (error: string | null) => void;
}) {
  const [draft, setDraft] = useState(props.tableIds.join(', '));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const pragmaticTableIds = selectPragmaticMonitorTableIds(props.candidates);

  useEffect(() => {
    if (!dirty) setDraft(props.tableIds.join(', '));
  }, [dirty, props.tableIds]);

  async function saveMonitorTables() {
    if (!window.desktop) return;
    const requestedTableIds = draft
      .split(/[,，\s]+/)
      .map(tableId => {
        const trimmed = tableId.trim();
        return /^[A-Z]{1,4}\d{2,6}$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed.toLowerCase();
      })
      .filter(tableId => tableId.length > 0);
    const invalidTableId = requestedTableIds.find(
      tableId => !/^[A-Z]{1,4}\d{2,6}$/.test(tableId) && !/^[a-z0-9]{8,32}$/.test(tableId),
    );
    if (invalidTableId !== undefined) {
      props.onError(`牌桌号格式无效：${invalidTableId}。例如 D055 或 bc281koreanch281。`);
      return;
    }
    setSaving(true);
    props.onError(null);
    try {
      const updated = await props.onSave(requestedTableIds);
      if (updated === null) return;
      setDraft(updated.monitorTableIds.join(', '));
      setDirty(false);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function loadPragmaticTables() {
    if (pragmaticTableIds.length === 0) return;
    setSaving(true);
    props.onError(null);
    try {
      const updated = await props.onSave([...new Set([...props.tableIds, ...pragmaticTableIds])]);
      if (updated === null) return;
      setDraft(updated.monitorTableIds.join(', '));
      setDirty(false);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="monitor-table-config" aria-labelledby="monitor-table-config-title">
      <div className="record-heading">
        <h2 id="monitor-table-config-title">监控牌桌</h2>
        <span className="record-count">已发现 {props.candidates.filter(candidate => candidate.roomId === 'dafabet-pragmatic').length} · 已监控 {props.tableIds.length}</span>
      </div>
      <div className="monitor-table-config__batch-actions">
        <button
          className="button button--small button--ghost"
          onClick={() => void loadPragmaticTables()}
          disabled={saving || pragmaticTableIds.length === 0}
        >
          加入全部已发现桌（{pragmaticTableIds.length}）
        </button>
      </div>
      <div className="monitor-table-config__fields">
        <label htmlFor="monitor-table-ids">
          <span>监控牌桌号</span>
          <input
            id="monitor-table-ids"
            type="text"
            value={draft}
            onChange={event => { setDraft(event.target.value); setDirty(true); }}
            placeholder="D055, bc281koreanch281"
            disabled={saving}
          />
        </label>
        <button className="button button--small button--primary settings-save" onClick={() => void saveMonitorTables()} disabled={saving || !dirty}>
          {saving ? '保存中' : '保存监控桌号'}
        </button>
      </div>
      <div className="monitor-table-config__saved" aria-label="已保存的监控桌号顺序">
        {props.tableIds.length > 0 ? props.tableIds.map((tableId, index) => <code key={tableId}>{index + 1}. {tableId}</code>) : <em>尚未配置</em>}
      </div>
    </section>
  );
}

function UnifiedBetSettings(props: {
  tableIds: readonly string[];
  tables: TableActorSnapshot[];
  riskLimits?: RiskLimits;
  onSnapshot: (snapshot: DesktopConsoleSnapshot) => void;
  onError: (error: string | null) => void;
}) {
  const monitoredTables = useMemo(
    () => props.tables.filter(table => props.tableIds.includes(table.tableId)),
    [props.tables, props.tableIds],
  );
  const referenceTable = monitoredTables[0];
  const [draft, setDraft] = useState<UnifiedBetSettingsDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [riskDraft, setRiskDraft] = useState<RiskSettingsDraft | null>(null);
  const [riskDirty, setRiskDirty] = useState(false);
  const [savingRisk, setSavingRisk] = useState(false);

  useEffect(() => {
    if (referenceTable === undefined) {
      setDraft(null);
      return;
    }
    if (!dirty) setDraft(unifiedBetSettingsDraft(referenceTable));
  }, [dirty, referenceTable]);

  useEffect(() => {
    if (props.riskLimits && !riskDirty) setRiskDraft(riskSettingsDraft(props.riskLimits));
  }, [props.riskLimits, riskDirty]);

  function updateDraft(update: (current: UnifiedBetSettingsDraft) => UnifiedBetSettingsDraft) {
    setDirty(true);
    setDraft(current => current === null ? current : update(current));
  }

  async function saveUnifiedSettings() {
    if (!window.desktop || draft === null) return;
    const minEV = Number(draft.minEV) / 100;
    const defaultBetAmount = Number(draft.defaultBetAmount);
    const betTiers: BetTier[] = draft.tiers
      .map(tier => ({ minEV: Number(tier.minEV) / 100, amount: Number(tier.amount) }))
      .sort((left, right) => left.minEV - right.minEV);
    const tierStarts = betTiers.map(tier => tier.minEV);
    const hasDuplicateTier = new Set(tierStarts).size !== tierStarts.length;
    if (
      !Number.isFinite(minEV)
      || minEV < 0
      || !Number.isFinite(defaultBetAmount)
      || defaultBetAmount <= 0
      || hasDuplicateTier
      || betTiers.some(tier => !Number.isFinite(tier.minEV) || tier.minEV < 0 || tier.minEV > 0.5 || !Number.isFinite(tier.amount) || tier.amount <= 0)
    ) {
      props.onError('最低 EV、基础金额和分档金额必须有效');
      return;
    }
    setSaving(true);
    props.onError(null);
    try {
      props.onSnapshot(await window.desktop.updateAllTableSettings({ minEV, betTiers, defaultBetAmount }));
      setDirty(false);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveRisk() {
    if (!window.desktop || !props.riskLimits || !riskDraft) return;
    const sizing = riskDraft.betSizingMode === 'capitalPercent'
      ? {
          mode: 'capitalPercent' as const,
          bankroll: Number(riskDraft.bankroll),
          percent: Number(riskDraft.bankrollPercent) / 100,
          maxPerBet: riskDraft.maxPerBet.trim() === '' ? undefined : Number(riskDraft.maxPerBet),
        }
      : { mode: 'fixed' as const };
    const nextLimits: RiskLimits = {
      ...props.riskLimits,
      perTableLossLimit: Number(riskDraft.perTableLossLimit),
      perShoeLossLimit: Number(riskDraft.perShoeLossLimit),
      perDayLossLimit: Number(riskDraft.perDayLossLimit),
      betSizing: sizing,
    };
    const sizingValues = sizing.mode === 'capitalPercent'
      ? [sizing.bankroll, sizing.percent, sizing.maxPerBet ?? 1]
      : [];
    if (
      ![nextLimits.perTableLossLimit, nextLimits.perShoeLossLimit, nextLimits.perDayLossLimit, ...sizingValues]
        .every(value => Number.isFinite(value) && value >= 0)
      || (sizing.mode === 'capitalPercent' && (sizing.bankroll <= 0 || sizing.percent <= 0 || sizing.percent > 1))
    ) {
      props.onError('风险上限必须是有效数字');
      return;
    }
    setSavingRisk(true);
    props.onError(null);
    try {
      props.onSnapshot(await window.desktop.updateRiskLimits(nextLimits));
      setRiskDirty(false);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingRisk(false);
    }
  }

  return (
    <section className="ledger-settings">
      <div className="record-heading">
        <h2>统一下注策略</h2>
        <span className="record-count">{monitoredTables.length} 桌</span>
      </div>
      {draft === null ? (
        <span className="muted">暂无监控牌桌</span>
      ) : (
        <>
          <div className="settings-fields unified-settings-fields">
            <label><span>最低 EV（%）</span><input type="number" min="0" step="0.1" value={draft.minEV} onChange={event => updateDraft(current => ({ ...current, minEV: event.target.value }))} /></label>
            <label><span>基础金额</span><input type="number" min="0.01" step="1" value={draft.defaultBetAmount} onChange={event => updateDraft(current => ({ ...current, defaultBetAmount: event.target.value }))} /></label>
            <button className="button button--small button--primary settings-save" onClick={() => void saveUnifiedSettings()} disabled={saving || !dirty}>{saving ? '保存中' : '保存策略'}</button>
          </div>
          <div className="tier-settings">
            <div className="tier-settings__heading"><span>EV 分档</span></div>
            <div className="unified-tier-grid">
              {draft.tiers.map((tier, index) => (
                <div className="tier-row" key={index}>
                  <label><span>EV ≥（%）</span><input type="number" min="0" max="50" step="0.1" value={tier.minEV} onChange={event => updateDraft(current => ({ ...current, tiers: current.tiers.map((item, itemIndex) => itemIndex === index ? { ...item, minEV: event.target.value } : item) }))} /></label>
                  <label><span>下注金额</span><input type="number" min="0.01" step="1" value={tier.amount} onChange={event => updateDraft(current => ({ ...current, tiers: current.tiers.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item) }))} /></label>
                  <button className="icon-button" title="删除 EV 分档" aria-label="删除 EV 分档" onClick={() => updateDraft(current => ({ ...current, tiers: current.tiers.filter((_, itemIndex) => itemIndex !== index) }))}>×</button>
                </div>
              ))}
            </div>
            <button className="button button--small button--ghost" onClick={() => updateDraft(current => ({ ...current, tiers: [...current.tiers, { minEV: nextUnifiedTierStart(current.tiers), amount: current.defaultBetAmount }] }))}>添加分档</button>
          </div>
        </>
      )}
      {props.riskLimits && riskDraft && (
        <div className="risk-settings">
          <div className="tier-settings__heading"><span>风险上限</span></div>
          <div className="settings-fields settings-fields--risk">
            <label><span>下注策略</span><select value={riskDraft.betSizingMode} onChange={event => { setRiskDirty(true); setRiskDraft(current => current ? { ...current, betSizingMode: event.target.value as RiskSettingsDraft['betSizingMode'] } : current); }}><option value="fixed">固定金额 / EV 分档</option><option value="capitalPercent">总资金固定比例</option></select></label>
            <label><span>单桌亏损上限</span><input type="number" min="0" step="1" value={riskDraft.perTableLossLimit} onChange={event => { setRiskDirty(true); setRiskDraft(current => current ? { ...current, perTableLossLimit: event.target.value } : current); }} /></label>
            <label><span>单靴亏损上限</span><input type="number" min="0" step="1" value={riskDraft.perShoeLossLimit} onChange={event => { setRiskDirty(true); setRiskDraft(current => current ? { ...current, perShoeLossLimit: event.target.value } : current); }} /></label>
            <label><span>当日亏损上限</span><input type="number" min="0" step="1" value={riskDraft.perDayLossLimit} onChange={event => { setRiskDirty(true); setRiskDraft(current => current ? { ...current, perDayLossLimit: event.target.value } : current); }} /></label>
            {riskDraft.betSizingMode === 'capitalPercent' && <>
              <label><span>当前总资金</span><input type="number" min="0.01" step="1" value={riskDraft.bankroll} onChange={event => { setRiskDirty(true); setRiskDraft(current => current ? { ...current, bankroll: event.target.value } : current); }} /></label>
              <label><span>每手资金比例（%）</span><input type="number" min="0.01" max="100" step="0.01" value={riskDraft.bankrollPercent} onChange={event => { setRiskDirty(true); setRiskDraft(current => current ? { ...current, bankrollPercent: event.target.value } : current); }} /></label>
              <label><span>单手金额上限</span><input type="number" min="0.01" step="1" value={riskDraft.maxPerBet} onChange={event => { setRiskDirty(true); setRiskDraft(current => current ? { ...current, maxPerBet: event.target.value } : current); }} /></label>
            </>}
            <button className="button button--small button--primary settings-save" onClick={() => void saveRisk()} disabled={savingRisk}>{savingRisk ? '保存中' : '保存风险'}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function unifiedBetSettingsDraft(table: TableActorSnapshot): UnifiedBetSettingsDraft {
  return {
    minEV: (table.profile.minEV * 100).toFixed(2),
    defaultBetAmount: String(table.defaultBetAmount),
    tiers: (table.profile.betTiers ?? []).map(tier => ({
      minEV: String(Math.min(50, Math.max(0, Math.round(tier.minEV * 10000) / 100))),
      amount: String(tier.amount),
    })),
  };
}

function nextUnifiedTierStart(tiers: readonly { minEV: string; amount: string }[]): string {
  const used = new Set(
    tiers
      .map(tier => Number(tier.minEV))
      .filter(value => Number.isFinite(value) && value >= 0 && value <= 50)
      .map(value => String(value)),
  );
  return Array.from({ length: 51 }, (_, index) => String(index)).find(value => !used.has(value)) ?? '50';
}

function riskSettingsDraft(limits: RiskLimits): RiskSettingsDraft {
  const sizing = limits.betSizing;
  return {
    perTableLossLimit: String(limits.perTableLossLimit),
    perShoeLossLimit: String(limits.perShoeLossLimit),
    perDayLossLimit: String(limits.perDayLossLimit),
    betSizingMode: sizing?.mode ?? 'fixed',
    bankroll: String(sizing?.bankroll ?? ''),
    bankrollPercent: sizing?.percent === undefined ? '0.25' : String(sizing.percent * 100),
    maxPerBet: sizing?.maxPerBet === undefined ? '' : String(sizing.maxPerBet),
  };
}

function buildBetLedgerRows(snapshot: DesktopConsoleSnapshot | null): BetLedgerRow[] {
  if (!snapshot) return [];
  const decisions = new Map(snapshot.decisions.map(decision => [ledgerKey(decision.tableId, decision.shoeId, decision.handId, decision.market), decision]));
  const receipts = new Map(snapshot.receipts.map(row => [ledgerKey(row.tableId, row.shoeId, row.handId, row.market), row]));
  const operationalWagers = new Map(snapshot.operationalWagers.flatMap(record =>
    record.reservationId === undefined ? [] : [[record.reservationId, record] as const]));
  return snapshot.reservations.map(reservation => {
    const key = ledgerKey(reservation.tableId, reservation.shoeId, reservation.handId, reservation.market);
    const decision = decisions.get(key);
    const receipt = receipts.get(key);
    const operationalWager = operationalWagers.get(reservation.reservationId);
    const result = ledgerResult(reservation, receipt, snapshot.events, undefined, operationalWager);
    return { reservation, decision, receipt, operationalWager, createdAt: decision?.createdAt ?? operationalWager?.wager.createdAt ?? reservation.createdAt, resultLabel: result.label, resultTone: result.tone, realizedPnl: reservation.realizedPnl, expectedPnl: decision ? reservation.amount * decision.evMean : undefined };
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function ledgerPageRowsToView(rows: LedgerPageRow[]): BetLedgerRow[] {
  return rows.map(row => {
    const result = ledgerResult(row.reservation, row.receipt, [], row.outcome, row.operationalWager);
    return {
      reservation: row.reservation,
      decision: row.decision,
      receipt: row.receipt,
      operationalWager: row.operationalWager,
      createdAt: row.decision?.createdAt ?? row.reservation.createdAt,
      resultLabel: result.label,
      resultTone: result.tone,
      realizedPnl: row.reservation.realizedPnl,
      expectedPnl: row.decision ? row.reservation.amount * row.decision.evMean : undefined,
    };
  });
}

function ledgerResult(
  reservation: RiskReservation,
  receipt: ReceiptRow | undefined,
  events: NormalizedEvent[],
  outcomeOverride?: boolean,
  operationalWager?: OperationalWagerRecord,
): { label: string; tone: BetLedgerRow['resultTone'] } {
  if (typeof reservation.realizedPnl === 'number') {
    return reservation.realizedPnl > 0 ? { label: '命中', tone: 'good' } : reservation.realizedPnl < 0 ? { label: '未中', tone: 'danger' } : { label: '持平', tone: 'neutral' };
  }
  if (operationalWager?.status === 'UNKNOWN' || reservation.status === 'UNKNOWN') {
    return { label: '结果未知', tone: 'warning' };
  }
  if (receipt?.receipt.status === 'REJECTED') return { label: '下注被拒', tone: 'danger' };
  if (reservation.status === 'RELEASED' || reservation.status === 'EXPIRED') return { label: '未执行', tone: 'neutral' };
  const outcome = outcomeOverride ?? (
    reservation.market === 'bankerPair' || reservation.market === 'playerPair'
      ? settledOutcome(events, reservation.tableId, reservation.shoeId, reservation.handId, reservation.market)
      : undefined
  );
  if (outcome === true) return { label: '命中待结算', tone: 'good' };
  if (outcome === false) return { label: '未中待结算', tone: 'danger' };
  return { label: '待结算', tone: 'warning' };
}

function settledOutcome(events: NormalizedEvent[], tableId: string, shoeId: string, handId: string, market: BettingMarket): boolean | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'handSettled' && event.tableId === tableId && event.shoeId === shoeId && event.handId === handId) return event.outcomes?.[market];
  }
  return undefined;
}

function ledgerKey(tableId: string, shoeId: string, handId: string, market: string): string {
  return tableId + '|' + shoeId + '|' + handId + '|' + market;
}

function receiptStatusLabel(status: string): string {
  return RECEIPT_STATUS_LABELS[status] ?? status;
}

function reservationStatusLabel(status: string): string {
  const labels: Record<string, string> = { RESERVED: '已预留', RELEASED: '已释放', SETTLED: '已结算', EXPIRED: '已过期', UNKNOWN: '未知' };
  return labels[status] ?? status;
}


function timeInRange(value: string, startTime: string, endTime: string): boolean {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const start = startTime ? new Date(startTime).getTime() : Number.NEGATIVE_INFINITY;
  const end = endTime ? new Date(endTime).getTime() : Number.POSITIVE_INFINITY;
  return timestamp >= start && timestamp <= end;
}

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = Math.max(0, (page - 1) * pageSize);
  return items.slice(start, start + pageSize);
}

function Pagination(props: { page: number; pageSize: number; totalItems: number; onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void }) {
  if (props.totalItems === 0) return null;
  const totalPages = Math.max(1, Math.ceil(props.totalItems / props.pageSize));
  return <div className="pagination">
    <span>共 {props.totalItems} 条 · 第 {props.page} / {totalPages} 页</span>
    <button className="button button--small button--ghost" disabled={props.page <= 1} onClick={() => props.onPageChange(Math.max(1, props.page - 1))}>上一页</button>
    <button className="button button--small button--ghost" disabled={props.page >= totalPages} onClick={() => props.onPageChange(Math.min(totalPages, props.page + 1))}>下一页</button>
    <label><span>每页</span><select value={props.pageSize} onChange={event => props.onPageSizeChange(Number(event.target.value))}><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label>
  </div>;
}

function AlertCenter(props: {
  incidents: readonly DesktopRuntimeIncident[];
  acknowledgingIncidentId: string | null;
  onAcknowledge: (incidentId: string) => void;
  onAcknowledgeAll: () => void;
  onClose: () => void;
}) {
  const pendingCount = props.incidents.filter(incident =>
    incident.active && incident.acknowledgedAt === undefined).length;
  return (
    <div className="alert-center-overlay" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <section className="alert-center" role="dialog" aria-modal="true" aria-labelledby="alert-center-title">
        <header className="alert-center__header">
          <div>
            <h2 id="alert-center-title">告警事件</h2>
            <span>{pendingCount} 条未确认 · {props.incidents.length} 条记录</span>
          </div>
          <div className="alert-center__actions">
            <button
              className="button button--small button--secondary"
              type="button"
              disabled={pendingCount === 0 || props.acknowledgingIncidentId !== null}
              onClick={props.onAcknowledgeAll}
            >消除全部提示</button>
            <button className="button button--small button--ghost" type="button" onClick={props.onClose}>关闭</button>
          </div>
        </header>
        <div className="alert-center__list">
          {props.incidents.length === 0 && <div className="empty-state">暂无告警事件</div>}
          {props.incidents.map(incident => {
            const pending = incident.active && incident.acknowledgedAt === undefined;
            return (
              <article className={cx('alert-event', pending && 'alert-event--pending')} key={incident.incidentId}>
                <div className="alert-event__heading">
                  <strong>{runtimeIncidentCodeLabel(incident.code)}</strong>
                  <Badge label={incident.severity === 'blocked' ? '阻断' : '降级'} tone={incident.severity === 'blocked' ? 'danger' : 'warning'} />
                  <Badge
                    label={pending ? '未确认' : incident.active ? '已确认' : '已恢复'}
                    tone={pending ? 'warning' : incident.active ? 'neutral' : 'good'}
                  />
                </div>
                <p>{incident.message}</p>
                <div className="alert-event__meta">
                  <span>牌桌 {incident.tableId ?? '全局'}</span>
                  <span>首次 {formatDateTime(incident.firstOccurredAt)}</span>
                  <span>最近 {formatDateTime(incident.lastOccurredAt)}</span>
                  <span>{incident.occurrences} 次</span>
                </div>
                {pending && (
                  <button
                    className="button button--small button--secondary alert-event__dismiss"
                    type="button"
                    disabled={props.acknowledgingIncidentId !== null}
                    onClick={() => props.onAcknowledge(incident.incidentId)}
                  >消除提示</button>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SummaryItem(props: {
  label: string;
  value: string;
  tone?: 'good' | 'warning' | 'danger';
  onClick?: () => void;
}) {
  const content = <><span>{props.label}</span><strong className={props.tone ? 'text--' + props.tone : undefined}>{props.value}</strong></>;
  return props.onClick
    ? <button className="summary-item summary-item--action" type="button" onClick={props.onClick} aria-label={`查看${props.label}`}>{content}</button>
    : <div className="summary-item">{content}</div>;
}

function FilterControl({ label, children }: { label: string; children: ReactNode }) {
  return <label className="filter-control"><span>{label}</span>{children}</label>;
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return <button className={cx('view-tab', active && 'view-tab--active')} onClick={onClick} aria-current={active ? 'page' : undefined}>{label}{count === undefined ? null : <span>{count}</span>}</button>;
}

function Badge({ label, tone = 'neutral' }: { label: string; tone?: string }) {
  return <span className={'badge badge--' + tone}>{label}</span>;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return <div className="meta-row"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}

function safeEvaluate(
  profile: ShoeStateProjection['profileSnapshot'],
  market: BettingMarket,
  seenCards: ShoeStateProjection['seenCards'],
  remainingCounts?: ShoeStateProjection['remainingCounts'],
): MarketEvaluation | null {
  try {
    return evaluateProjectionPairMarket(profile, market, seenCards, remainingCounts);
  } catch {
    return null;
  }
}

function isVerifiedPhysicalShoeReason(reason: string | undefined): boolean {
  return reason === 'protocol-shuffle' || reason === 'road-wrap' || reason === 'manual-confirm';
}

function isDisplayedPhysicalShoe(
  projection: ShoeStateProjection,
  evidence?: DesktopShoeEvidence,
): boolean {
  return projection.shoeId.length > 0
    && projection.shoeBaseline === 'physical-shoe'
    && (evidence === undefined || isVerifiedPhysicalShoeReason(evidence.reason));
}

function tableAlerts(actor: TableActorSnapshot): string[] {
  const alerts: string[] = [];
  const projection = actor.projection;
  if (projection.redCardSeen) alerts.push('红牌');
  if (projection.shoeBaseline === 'unknown-monitor-session') alerts.push('物理牌靴未知');
  if (projection.connectionStatus !== 'CONNECTED') alerts.push(CONNECTION_LABELS[projection.connectionStatus]);
  if (projection.autoBetStatus === 'NEEDS_MANUAL_RECOVERY') alerts.push('需要人工恢复');
  if (projection.status === 'INVALIDATED') alerts.push('牌靴作废');
  return alerts;
}

function operationalRuntimeBlockReason(
  runtime: DesktopConsoleSnapshot['runtime']['tables'][string] | undefined,
): string | undefined {
  if (runtime === undefined) return '运行状态未就绪';
  if (!runtime.active) return runtime.reasons.length > 0
    ? `实盘执行未就绪：${runtime.reasons.map(runtimeReasonLabel).join('、')}`
    : '实盘执行未激活';
  return runtime.reasons.length > 0
    ? `实盘执行已阻断：${runtime.reasons.map(runtimeReasonLabel).join('、')}`
    : undefined;
}

function manualOperationalRuntimeBlockReason(
  runtime: DesktopConsoleSnapshot['runtime']['tables'][string] | undefined,
): string | undefined {
  if (runtime === undefined) return '运行状态未就绪';
  const reasons = runtime.reasons.filter(reason =>
    reason !== 'physical-shoe-baseline-unknown'
    && reason !== 'unknown-execution-pending'
    && reason !== 'settlement-gap');
  return reasons.length > 0
    ? `手动下注未就绪：${reasons.map(runtimeReasonLabel).join('、')}`
    : undefined;
}

function runtimeReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    'live-not-approved': '未批准实盘',
    'bridge-not-running': '浏览器桥未运行',
    'bridge-not-authenticated': '浏览器扩展身份未认证',
    'table-feed-missing': '牌桌数据流未连接',
    'table-feed-disconnected': '牌桌数据流已断开',
    'table-feed-stale': '牌桌数据已过期',
    'physical-shoe-baseline-unknown': '实体牌靴基线未知',
    'table-connection-not-restored': '牌桌连续性未恢复',
    'shoe-sealed': '当前牌靴已封存',
    'unknown-execution-pending': '存在结果未知的资金敞口',
    'settlement-gap': '存在跨局未结算预留',
  };
  return labels[reason] ?? reason;
}

function runtimeIncidentCodeLabel(code: DesktopRuntimeIncident['code']): string {
  const labels: Record<DesktopRuntimeIncident['code'], string> = {
    'bridge-auth-failed': '浏览器桥认证失败',
    'bridge-disconnected': '浏览器桥断开',
    'continuity-invalidated': '牌桌连续性失效',
    'table-feed-stale': '牌桌数据过期',
    'session-recovery-exhausted': '会话恢复失败',
    'unknown-execution': '下注结果未知',
    'settlement-gap': '结算缺口',
    'scheduler-failure': '调度失败',
    'monitor-failure': '监控失败',
  };
  return labels[code];
}

function decisionChoiceLabel(decision: DecisionHandRecord): string {
  if (decision.selectedMarkets.length === 0) return decision.eligible ? '达到条件，未执行' : '不下注';
  return decision.selectedMarkets.map(market => MARKET_LABELS[market]).join(' + ');
}

function DecisionActualResult({ result }: { result: DecisionHandRecord['actualResult'] }) {
  if (result.status === 'PENDING') return <Badge label="待结算" tone="warning" />;
  if (result.status === 'UNKNOWN') return <Badge label="结果未知" tone="neutral" />;
  return (
    <span className="decision-result">
      <Badge label={`庄对${result.outcomes.bankerPair ? '命中' : '未中'}`} tone={result.outcomes.bankerPair ? 'good' : 'neutral'} />
      <Badge label={`闲对${result.outcomes.playerPair ? '命中' : '未中'}`} tone={result.outcomes.playerPair ? 'good' : 'neutral'} />
    </span>
  );
}

function eventDescription(event: NormalizedEvent): string {
  switch (event.type) {
    case 'cardObserved': return (event.position ? positionLabel(event.position) + '：' : '') + cardLabel(event.card);
    case 'handSettled': return '闲 ' + formatCardList(event.playerCards) + ' · 庄 ' + formatCardList(event.bankerCards);
    case 'bettingWindowOpened': return MARKET_LABELS[event.market] + '开放';
    case 'bettingWindowClosed': return MARKET_LABELS[event.market] + '关闭';
    case 'betReceipt': return MARKET_LABELS[event.market] + ' · ' + (RECEIPT_STATUS_LABELS[event.receipt.status] ?? event.receipt.status);
    case 'newShoeSignal': return event.baseline === 'unknown-monitor-session'
      ? '监控会话 ' + event.shoeId + ' 开始（物理牌靴未知）'
      : '牌靴 ' + event.shoeId + ' 开始';
    case 'shoeConfirmation': return event.approved ? '已确认' : '未确认';
    case 'redCardSeen': return '本靴进入收尾';
    case 'connectionLost': return event.reason ?? '连接中断';
    case 'connectionRestored': return event.continuityProof ? '连续性已确认' : '等待连续性证明';
    case 'burnModelUpdated': return burnModelLabel(event.burnModel.kind);
    case 'shoeInvalidated': return event.reason;
    case 'manualCorrection': return event.correction.kind === 'numberOfDecks' ? '副数修正为 ' + event.correction.numberOfDecks : '烧牌模型已修正';
    case 'autoArmChanged': return event.armed ? '自动下注已开启' : '自动下注已暂停';
    case 'autoDisarmChanged': return event.reason === 'manual-disarm' ? '手动暂停自动下注' : event.reason;
  }
}

function eventMarketOf(event: NormalizedEvent): BettingMarket | null {
  return 'market' in event ? event.market : null;
}

function eventShoeId(event: NormalizedEvent): string {
  return 'shoeId' in event && typeof event.shoeId === 'string' ? event.shoeId : '-';
}

function eventHandId(event: NormalizedEvent): string {
  return 'handId' in event && typeof event.handId === 'string' ? event.handId : '-';
}

function isCurrentlyEligible(decision: DecisionSnapshot): boolean {
  return decision.eligible && decision.evLower >= 0;
}

function positionLabel(position: string): string {
  const value = position.toLowerCase();
  if (value.startsWith('player')) return '闲' + position.slice(6);
  if (value.startsWith('banker')) return '庄' + position.slice(6);
  return position;
}

function formatCardList(cards: Card[]): string {
  return cards.length > 0 ? cards.map(cardLabel).join(' ') : '未识别';
}

function cardLabel(card: Card): string {
  const suit = normalizeSuit(card.suit);
  return card.rank + suit.glyph;
}

function normalizeSuit(value?: string): { glyph: string; tone: 'red' | 'black' | 'unknown'; label: string } {
  const suit = (value ?? '').toLowerCase();
  if (suit === '♥' || suit === 'hearts' || suit === 'heart' || suit === 'h' || suit === '红桃') return { glyph: '♥', tone: 'red', label: '红桃' };
  if (suit === '♦' || suit === 'diamonds' || suit === 'diamond' || suit === 'd' || suit === '方块') return { glyph: '♦', tone: 'red', label: '方块' };
  if (suit === '♠' || suit === 'spades' || suit === 'spade' || suit === 's' || suit === '黑桃') return { glyph: '♠', tone: 'black', label: '黑桃' };
  if (suit === '♣' || suit === 'clubs' || suit === 'club' || suit === 'c' || suit === '梅花') return { glyph: '♣', tone: 'black', label: '梅花' };
  return { glyph: '?', tone: 'unknown', label: '花色未知' };
}

function burnModelLabel(kind: string): string {
  if (kind === 'unknown') return '烧牌数量未知';
  if (kind === 'countKnown') return '已知烧牌数量';
  if (kind === 'partialKnown') return '部分烧牌已知';
  return '烧牌牌面已知';
}

function statusTone(value: string): string {
  if (value === 'TRACKING' || value === 'BETTING_WINDOW' || value === 'CONNECTED' || value === 'ARMED') return 'good';
  if (value === 'RED_CARD_WIND_DOWN' || value === 'WAITING_CONFIRMATION' || value === 'RESYNCING' || value === 'NEEDS_MANUAL_RECOVERY') return 'warning';
  if (value === 'INVALIDATED' || value === 'DISCONNECTED' || value === 'EXPIRED') return 'danger';
  return 'neutral';
}

function shortAutoBetLabel(status: AutoBetStatus): string {
  switch (status) {
    case 'ARMED':
      return '已开启';
    case 'DISARMED':
      return '已暂停';
    case 'NEEDS_MANUAL_RECOVERY':
      return '待恢复';
  }
}

function evTone(value: number): string {
  return value > 0 ? 'text--good' : value < 0 ? 'text--danger' : 'text--muted';
}

function tableName(tableId: string): string {
  const match = tableId.match(/(?:table|牌桌)[-_ ]?(\d+)/i);
  return match ? '牌桌 ' + match[1] : tableId;
}

function shortId(value: string, limit = 24): string {
  if (!value || value === '-') return value || '-';
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

function formatPercent(value: number): string {
  return (value * 100).toFixed(2) + '%';
}

function formatSignedPercent(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return sign + Math.abs(value * 100).toFixed(2) + '%';
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

function formatSignedAmount(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return sign + Math.abs(value).toFixed(2);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
