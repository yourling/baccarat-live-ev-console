import { WebSocket } from 'ws';

/**
 * FIX(P0-2): `/command` 白名单已收窄到只读/诊断命令。
 *
 * 会改变扩展安全姿态的命令（liveOn / liveOff / reloadExtension / trustedOn /
 * trustedOff / calibrate / calibrateClear / startPragmaticNetworkCapture /
 * stopPragmaticNetworkCapture）**只能由桌面端进程内调用**（`setLiveBetEnabled()`
 * 等走 `broadcastToSockets`，不经过本白名单），不再从本机 WS 暴露。
 */
const ALLOWED_COMMAND_NAMES = ['probeBetReadiness', 'replayRuntimeState', 'probeExtensionManifest'] as const;

const [name = '', ...tableIds] = process.argv.slice(2);
if (!name || !(ALLOWED_COMMAND_NAMES as readonly string[]).includes(name)) {
  console.error(
    '用法: tsx scripts/bridge-command.ts <'
    + ALLOWED_COMMAND_NAMES.join('|')
    + '> [tableId...]',
  );
  if (name) console.error('拒绝: ' + name + ' 不在 /command 白名单内（liveOn/liveOff/reloadExtension 等已收归桌面端内部调用）');
  process.exit(1);
}
const port = Number(process.env.BRIDGE_PORT ?? 17890);
const ws = new WebSocket('ws://127.0.0.1:' + port + '/command', { origin: 'http://localhost' });
ws.on('open', () => {
  ws.send(JSON.stringify({
    kind: 'command',
    name,
    ...(tableIds.length === 0 ? {} : { tableIds }),
  }));
  console.log('[bridge-command] 已发送: ' + name);
});
ws.on('message', data => {
  const text = String(data);
  if (text.includes('sessionAction')) console.log('[bridge-command] 确认: ' + text.slice(0, 200));
});
ws.on('error', error => console.error('[bridge-command] 失败: ' + error.message));
setTimeout(() => process.exit(0), 3000);
