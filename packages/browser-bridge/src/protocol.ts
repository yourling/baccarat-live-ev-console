import type {
  BetExecutionRequest,
  OperationalWagerExecutionRequest,
  OperationalWagerReceipt,
} from '@baccarat/adapter-contract';
import type { BetReceipt, NormalizedEvent, TableProfile } from '@baccarat/contracts';

export type BridgeExecutionRequest = BetExecutionRequest | OperationalWagerExecutionRequest;
export type BridgeExecutionReceipt = BetReceipt | OperationalWagerReceipt;

export interface BridgeTableDescriptor {
  tableId: string;
  displayName?: string;
  roundId?: string;
  gameCount?: number;
  profile?: Partial<TableProfile>;
  monitorUrl?: string;
}

export interface BridgeRoomDescriptor {
  roomId: string;
  displayName?: string;
  /** 可选平台标识，由平台适配器下发，透传给中控。 */
  platformId?: string;
  tables: BridgeTableDescriptor[];
}

export type BridgeClientMessage = (
  | {
    kind: 'hello';
    extensionVersion: string;
    browser: string;
    timestamp: string;
    executorProfileId?: string;
    /** 扩展发件箱溢出后开启的新会话：序号基准已重置（P1-8a，信息性字段）。 */
    seqReset?: boolean;
  }
  /**
   * P0-1：安装在等待操作员批准的扩展回执。pending socket 只接受这一条与心跳，
   * 其它消息一律丢弃；批准后由桥下发 `pairingApproved` 完成提升。
   */
  | { kind: 'pairingAck'; installId?: string; timestamp: string }
  | { kind: 'roomDiscovered'; room: BridgeRoomDescriptor }
  | { kind: 'roomUpdated'; room: BridgeRoomDescriptor }
  | { kind: 'tableEvent'; roomId: string; tableId: string; event: NormalizedEvent }
  | { kind: 'tableDisconnected'; roomId: string; tableId: string; reason?: string }
  | { kind: 'tableRestored'; roomId: string; tableId: string; proof: string }
  | { kind: 'betResult'; requestId: string; receipt: BridgeExecutionReceipt | null; error?: string }
  | { kind: 'diagnostic'; url: string; frame: string; readyState: string; titleLength?: number; bodyTextLength?: number; htmlLength?: number; title?: string; bodyTextPreview?: string; htmlPreview?: string; candidateCount: number; canvasCount: number; videoCount: number; iframeCount: number }
  | { kind: 'networkCapture'; source: string; url: string; data: string; encoding?: string; direction?: string }
  | { kind: 'keepalive'; url: string; frame: string; timestamp: string; vw?: number; vh?: number; target?: { x: number; y: number; width: number; height: number } }
  | { kind: 'sessionExpired'; url: string; frame: string; textLength?: number; textPreview?: string; timestamp: string; recovering?: boolean }
  | { kind: 'sessionAction'; action: 'keepalive-click' | 'trusted-activity' | 'idle-dialog-dismissed' | 'inline-recovery-click' | 'reload-scheduled' | 'recovered' | 'recovery-failed' | 'beacon-failed' | 'socket-closed' | 'calibrated' | 'command-executed' | 'dual-game-session' | 'session-conflict-dialog' | 'session-conflict-cleared' | 'pragmatic-outbound-send' | 'native-idle-keepalive-armed' | 'native-idle-continue-cleared' | 'native-idle-continue-click'; url: string; frame: string; detail?: string; attempt?: number; timestamp: string }
  | { kind: 'heartbeat'; timestamp: string }
  | { kind: 'command'; name: string; tableIds?: readonly string[] }
) & {
  /** Monotonic sequence scoped to one extension service-worker lifetime. */
  bridgeSessionId?: string;
  bridgeSeq?: number;
};

export type BridgeServerMessage =
  | { kind: 'welcome'; serverVersion: string; timestamp: string }
  | { kind: 'betRequest'; requestId: string; request: BridgeExecutionRequest; leaseId?: string; signature?: string }
  | { kind: 'executorLeaseGranted'; leaseId: string; profileId: string; secret: string; reacquired: boolean; timestamp: string }
  | { kind: 'executorLeaseRejected'; reason: string; activeLeaseId?: string; timestamp: string }
  | { kind: 'ping'; timestamp: string }
  | { kind: 'observe'; message: BridgeClientMessage }
  | { kind: 'command'; name: string; tableIds?: readonly string[] }
  /**
   * P0-1：连接带 chrome-extension origin 且 token 通过，但 installId 缺失/未获批准。
   * 该 socket 不占唯一扩展槽、不拿 executor lease、不 ingest 任何事件。
   */
  | { kind: 'pairingRequired'; installId?: string; serverVersion: string; timestamp: string }
  /** P0-1：操作员批准后桥主动把 pending socket 提升为 extension 角色。 */
  | { kind: 'pairingApproved'; installId: string; timestamp: string };
