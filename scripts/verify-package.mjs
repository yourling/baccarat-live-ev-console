#!/usr/bin/env node
/**
 * FIX(D-P1-12): 打包验证。
 *
 * 审查结论（review 脚本 b10 / d-desktop P1-12）：`npm run package:win` 只跑
 * `build:web + build:electron`，**不跑** `npm run build`（类型检查）、**不跑**
 * `npm test`，CI 也从不打包 —— 打包链路从未被验证。b10 实测 main.cjs 里
 * `require("@baccarat/...")` 残留为 0（esbuild 已内联），但这条保证没有守卫。
 *
 * 本脚本做最小但真实的三件事：
 *  1. 断言 `apps/desktop/electron-dist/main.cjs` 里 `require("@baccarat/` = 0
 *     —— 一旦有人把某处改成 tsc/未 bundle 输出，安装机上会直接 require 不到包；
 *  2. 用 stub electron（`Module._load` 拦截）加载 main.cjs，断言能加载（不抛）
 *     且注册了 ≥ 20 个 IPC handler；
 *  3. 真实 `require('better-sqlite3')` 并 `new Database(':memory:')`，
 *     断言 asarUnpack 后的原生模块在当前 Node ABI 下可用。
 *
 * 用法：
 *   node scripts/verify-package.mjs           # 需要先 npm run build -w @baccarat/desktop
 *   node scripts/verify-package.mjs --build   # 先构建再验证
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const mainBundle = join(desktopDir, 'electron-dist', 'main.cjs');
const MIN_IPC_HANDLERS = 20;

const failures = [];
function fail(message) {
  failures.push(message);
  console.error(`✗ ${message}`);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

if (process.argv.includes('--build')) {
  console.log('▸ 先构建 desktop（build:web + build:electron）…');
  execFileSync('npm', ['run', 'build:desktop', '-w', '@baccarat/desktop'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

// ---------------------------------------------------------------------------
// 1. bundle 里不能残留 workspace require
// ---------------------------------------------------------------------------
if (!existsSync(mainBundle)) {
  fail(`找不到 ${mainBundle}；先跑 npm run build -w @baccarat/desktop`);
  summarize();
}

const mainSource = readFileSync(mainBundle, 'utf8');
const workspaceRequires = [...mainSource.matchAll(/require\("(@baccarat\/[^"]+)"\)/g)].map(match => match[1]);
if (workspaceRequires.length === 0) {
  ok('main.cjs 里 require("@baccarat/*") 残留 = 0（workspace 源码已被 esbuild 内联）');
} else {
  fail(`main.cjs 残留 ${workspaceRequires.length} 处 workspace require：${JSON.stringify([...new Set(workspaceRequires)])}`);
}

// 只允许 electron / better-sqlite3 / node 内建 作为外部依赖。
// 例外：ws 的可选原生加速模块（bufferutil / utf-8-validate）。仓库未安装它们，
// ws 内部用 try/catch 兜底 —— 不会导致启动失败（review 脚本 b10 已确认）。
const KNOWN_OPTIONAL_REQUIRES = new Set(['bufferutil', 'utf-8-validate']);
const allRequires = [...new Set([...mainSource.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]))];
const unexpected = allRequires.filter(name =>
  !name.startsWith('node:')
  && !name.startsWith('.')
  && name !== 'electron'
  && name !== 'better-sqlite3'
  && !KNOWN_OPTIONAL_REQUIRES.has(name)
  && !['assert', 'buffer', 'child_process', 'crypto', 'electron', 'events', 'fs', 'http', 'https',
    'net', 'os', 'path', 'process', 'stream', 'timers', 'tls', 'url', 'util', 'worker_threads', 'zlib']
    .includes(name));
if (unexpected.length === 0) {
  ok('main.cjs 的外部依赖只有 electron / better-sqlite3 / node 内建（+ ws 可选加速模块）');
} else {
  fail(`main.cjs 出现未声明的第三方 require：${JSON.stringify(unexpected)}`);
}

// ---------------------------------------------------------------------------
// 2. 用 stub electron 加载 bundle，断言能加载 + IPC handler 数量
// ---------------------------------------------------------------------------
const workDir = join(tmpdir(), `verify-package-${process.pid}`);
const appDir = join(workDir, 'app');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(join(appDir, 'node_modules'), { recursive: true });
mkdirSync(join(appDir, 'electron-dist'), { recursive: true });
writeFileSync(join(appDir, 'electron-dist', 'main.cjs'), mainSource);

const electronStub = `
const handlers = new Map();
const listeners = new Map();
const app = {
  commandLine: { appendSwitch() {} },
  getPath: () => process.env.VERIFY_PACKAGE_USERDATA || process.cwd(),
  getVersion: () => '43.4.0',
  getName: () => 'baccarat-ev-console',
  whenReady: () => Promise.resolve(),
  on(name, fn) { (listeners.get(name) || listeners.set(name, []).get(name)).push(fn); },
  once(name, fn) { this.on(name, fn); },
  quit() {},
  exit() {},
  isReady: () => true,
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock() {},
  setAppUserModelId() {},
};
class BrowserWindow {
  constructor() {
    this.webContents = new Proxy({}, {
      get: (target, prop) => (prop === 'on' || prop === 'once' || prop === 'setWindowOpenHandler')
        ? () => undefined
        : (prop in target ? target[prop] : () => undefined),
      set: (target, prop, value) => { target[prop] = value; return true; },
    });
  }
  static getAllWindows() { return []; }
  static fromWebContents() { return undefined; }
  once() {}
  on() {}
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  isDestroyed() { return false; }
  isVisible() { return true; }
  isMinimized() { return false; }
  show() {}
  focus() {}
  hide() {}
  close() {}
  restore() {}
  setTitle() {}
  hookWindowMessage() {}
  removeHookWindowMessage() {}
}
const ipcMain = {
  handle(name, fn) { if (handlers.has(name)) throw new Error('duplicate handler ' + name); handlers.set(name, fn); },
  on() {},
  removeHandler() {},
};
module.exports = { app, BrowserWindow, ipcMain, contextBridge: {}, ipcRenderer: {}, shell: {}, dialog: {} };
module.exports.__getHandlerNames = () => [...handlers.keys()];
`;
mkdirSync(join(appDir, 'node_modules', 'electron'), { recursive: true });
writeFileSync(join(appDir, 'node_modules', 'electron', 'index.js'), electronStub);
writeFileSync(
  join(appDir, 'node_modules', 'electron', 'package.json'),
  JSON.stringify({ name: 'electron', version: '43.4.0', main: 'index.js' }),
);

// 模拟 asarUnpack 后的布局：把真实 better-sqlite3 链接进隔离目录。
const sqliteSource = join(repoRoot, 'node_modules', 'better-sqlite3');
const sqliteTarget = join(appDir, 'node_modules', 'better-sqlite3');
let sqliteLinked = false;
try {
  symlinkSync(sqliteSource, sqliteTarget, 'junction');
  sqliteLinked = true;
} catch (error) {
  console.warn(`! better-sqlite3 链接失败（回退 NODE_PATH）：${String(error)}`);
}

const userData = join(workDir, 'userData');
mkdirSync(userData, { recursive: true });
process.env.VERIFY_PACKAGE_USERDATA = userData;

const require_ = createRequire(join(appDir, 'electron-dist', 'main.cjs'));
let electronStubModule;
try {
  electronStubModule = require_(join(appDir, 'node_modules', 'electron', 'index.js'));
  require_(join(appDir, 'electron-dist', 'main.cjs'));
  ok('main.cjs 在 stub electron 下加载成功（未抛错）');
} catch (error) {
  fail(`main.cjs 加载失败：${error instanceof Error ? (error.stack ?? error.message).split('\n').slice(0, 6).join('\n') : String(error)}`);
}

if (electronStubModule?.__getHandlerNames) {
  const names = electronStubModule.__getHandlerNames();
  if (names.length >= MIN_IPC_HANDLERS) {
    ok(`注册了 ${names.length} 个 IPC handler（≥ ${MIN_IPC_HANDLERS}）`);
  } else {
    fail(`只注册了 ${names.length} 个 IPC handler（期望 ≥ ${MIN_IPC_HANDLERS}）：${JSON.stringify(names)}`);
  }
  // 安全基线改动（P2-13）必须仍在打包产物里。
  const requiredChannels = [
    'console:snapshot',
    'console:execute-operational-wager',
    'console:set-execution-mode',
    'console:update-table-settings',
    'console:approve-extension',
  ];
  const missing = requiredChannels.filter(channel => !names.includes(channel));
  if (missing.length === 0) {
    ok('关键 IPC 通道齐全（snapshot / operational-wager / execution-mode / settings / approve-extension）');
  } else {
    fail(`打包产物缺少关键 IPC 通道：${JSON.stringify(missing)}`);
  }
} else {
  fail('无法读取 stub electron 注册的 IPC handler 列表');
}

// ---------------------------------------------------------------------------
// 3. better-sqlite3 真实可用（asarUnpack 后的原生模块）
// ---------------------------------------------------------------------------
try {
  const Database = require_('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO probe (value) VALUES (?)').run('ok');
  const row = db.prepare('SELECT value FROM probe WHERE id = 1').get();
  db.close();
  if (row?.value === 'ok') {
    ok('better-sqlite3 可 require 且能真实建库（:memory:）');
  } else {
    fail('better-sqlite3 建库后读回失败');
  }
} catch (error) {
  fail(`better-sqlite3 不可用：${error instanceof Error ? error.message : String(error)}`);
  if (sqliteLinked) console.error('  （已链接真实 better-sqlite3 目录，失败说明原生模块与当前 Node ABI 不匹配）');
}

// ---------------------------------------------------------------------------
// 4. 渲染侧产物存在（窗口 loadFile dist/index.html）
// ---------------------------------------------------------------------------
const rendererIndex = join(desktopDir, 'dist', 'index.html');
if (existsSync(rendererIndex)) {
  ok('渲染层产物 apps/desktop/dist/index.html 存在');
} else {
  fail(`缺少渲染层产物 ${rendererIndex}；先跑 npm run build:web -w @baccarat/desktop`);
}

rmSync(workDir, { recursive: true, force: true });
summarize();

function summarize() {
  console.log('');
  if (failures.length === 0) {
    console.log('verify-package: OK（打包产物可加载、无未内联 workspace 依赖、better-sqlite3 可用）');
    process.exit(0);
  }
  console.error(`verify-package: FAILED（${failures.length} 项）`);
  process.exit(1);
}
