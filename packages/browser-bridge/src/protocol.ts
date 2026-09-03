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
  tables: BridgeTableDescriptor[];
}

export type BridgeClientMessage = (
  | { kind: 'hello'; extensionVersion: string; browser: string; timestamp: string }
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
  | { kind: 'sessionAction'; action: 'keepalive-click' | 'trusted-activity' | 'idle-dialog-dismissed' | 'inline-recovery-click' | 'reload-scheduled' | 'recovered' | 'recovery-failed' | 'beacon-failed' | 'socket-closed' | 'calibrated' | 'command-executed' | 'dual-game-session' | 'session-conflict-dialog' | 'pragmatic-outbound-send' | 'native-idle-keepalive-armed' | 'native-idle-continue-cleared' | 'native-idle-continue-click'; url: string; frame: string; detail?: string; attempt?: number; timestamp: string }
  | { kind: 'heartbeat'; timestamp: string }
  | { kind: 'command'; name: string; tableIds?: readonly string[] }
) & {
  /** Monotonic sequence scoped to one extension service-worker lifetime. */
  bridgeSessionId?: string;
  bridgeSeq?: number;
};

export type BridgeServerMessage =
  | { kind: 'welcome'; serverVersion: string; timestamp: string }
  | { kind: 'betRequest'; requestId: string; request: BridgeExecutionRequest }
  | { kind: 'ping'; timestamp: string }
  | { kind: 'observe'; message: BridgeClientMessage }
  | { kind: 'command'; name: string; tableIds?: readonly string[] };
