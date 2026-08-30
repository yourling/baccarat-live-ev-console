import { WebSocket } from 'ws';
import { BrowserBridgeServer } from '@baccarat/browser-bridge';

const PORT = Number(process.env.BRIDGE_PORT ?? process.argv[2] ?? 17890);

function printObserved(raw: unknown): void {
  const message = raw as { kind?: string; timestamp?: string };
  const time = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--';
  console.log('[observe ' + time + ']', JSON.stringify(message));
}

/** 端口空闲：自己起一个桥接服务（等同桌面控制台已停用时的用法）。 */
async function runServer(): Promise<void> {
  const server = new BrowserBridgeServer({ port: PORT });
  await server.start();
  console.log('[bridge-observe] 自建桥接服务 ws://127.0.0.1:' + server.getPort());
  console.log('[bridge-observe] 扩展 bridgeUrl 应指向该地址；按 Ctrl+C 退出。');
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  await new Promise<void>(() => {});
}

/** 端口被占（桌面控制台正在运行桥接服务）：作为观察者客户端接入。 */
function runObserver(): void {
  const url = 'ws://127.0.0.1:' + PORT + '/observe';
  let delay = 1000;
  let hintPrinted = false;

  const connect = () => {
    const ws = new WebSocket(url, { origin: 'http://localhost' });
    ws.on('open', () => {
      delay = 1000;
      console.log('[bridge-observe] 已作为观察者接入 ' + url + ' —— 等待扩展事件…');
    });
    ws.on('message', data => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      const message = parsed as { kind?: string; message?: unknown };
      if (message.kind === 'observe' && message.message) {
        printObserved(message.message);
        return;
      }
      if (message.kind === 'welcome') {
        console.log('[bridge-observe] 服务端欢迎:', JSON.stringify(message));
        return;
      }
      console.log('[bridge-observe] 服务端消息:', JSON.stringify(message));
    });
    ws.on('close', () => {
      console.error('[bridge-observe] 与 ' + url + ' 断开,' + Math.round(delay / 1000) + 's 后重试');
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    });
    ws.on('error', error => {
      console.error('[bridge-observe] 连接 ' + url + ' 失败: ' + error.message);
      if (!hintPrinted) {
        hintPrinted = true;
        console.error(
          '[bridge-observe] 提示: 若持续失败,端口可能被残留进程占用 —— ' +
          '先运行 \'netstat -ano | findstr :' + PORT + '\' 找到 PID,再 \'taskkill /PID <pid> /F\';' +
          '或直接关闭正在运行桥接服务的桌面控制台。'
        );
      }
    });
  };

  console.log('[bridge-observe] 端口 ' + PORT + ' 已被占用(桌面控制台或其他桥接服务正在运行),切换为观察者模式');
  connect();
  process.on('SIGINT', () => process.exit(0));
}

async function main(): Promise<void> {
  try {
    await runServer();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EADDRINUSE') {
      runObserver();
      return;
    }
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
