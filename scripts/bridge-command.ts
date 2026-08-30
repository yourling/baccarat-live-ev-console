import { WebSocket } from 'ws';

const [name = '', ...tableIds] = process.argv.slice(2);
if (!name) {
  console.error('用法: tsx scripts/bridge-command.ts <reloadExtension|reloadGameTabs|openMultiView|probeBetReadiness|replayRuntimeState|liveOn|liveOff|calibrate|trustedOn|trustedOff|calibrateClear> [tableId...]');
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
