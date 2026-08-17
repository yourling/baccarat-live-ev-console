import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopConsoleService } from '../apps/desktop/electron-src/service.ts';

const db = join(tmpdir(), 'console-smoke-' + Date.now() + '.sqlite');
const svc = new DesktopConsoleService(db);
async function main() {
  const snap = await svc.runDemo(42);
console.log(JSON.stringify({
  seed: snap.seed,
  events: snap.events.length,
  tables: Object.keys(snap.snapshot.tables),
  receipts: snap.receipts.length,
  reservations: snap.reservations.length,
  dayLoss: snap.snapshot.riskState.dayLoss,
  isOpen: snap.isOpen,
}, null, 2));
  await svc.close();
  const svc2 = new DesktopConsoleService(db);
  const s2 = svc2.snapshot();
  console.log(JSON.stringify({ restoredTables: Object.keys(s2.snapshot.tables), events: s2.events.length, decisions: s2.decisions.length, receipts: s2.receipts.length }, null, 2));
  await svc2.close();
}

void main();
