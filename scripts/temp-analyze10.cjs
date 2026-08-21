const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const frames = [];
for (const l of allLines) {
  if (!l.includes('networkCapture')) continue;
  let data = '';
  const i = l.indexOf('"data":"');
  if (i >= 0) {
    let j = i + 8;
    while (j < l.length) {
      if (l[j] === '\\') { j += 2; continue; }
      if (l[j] === '"') break;
      j += 1;
    }
    data = l.slice(i + 8, j);
  }
  const buf = Buffer.from(data, 'base64');
  if (buf.length < 14) continue;
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})([A-Z]{1,3})/);
  if (!km) continue;
  frames.push({ table: km[1], kind: km[2], buf });
}

// 目标四桌的全部消息类型清单
const targets = ['D065', 'D055', 'D057', 'D067'];
for (const t of targets) {
  const kinds = {};
  for (const f of frames) if (f.table === t) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  console.log(t, '消息类型:', JSON.stringify(kinds));
}

// dump 目标桌的 D 帧(发牌数据嫌疑)
function dump(buf, label) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < buf.length; off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
for (const t of targets) {
  const dfs = frames.filter(f => f.table === t && f.kind === 'D');
  console.log('\n' + t + 'D 帧:', dfs.length);
  for (const d of dfs.slice(-3)) dump(d.buf, t + 'D');
}