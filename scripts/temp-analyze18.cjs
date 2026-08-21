const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const frames = [];
let dropped = 0;
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
  if (buf.length < 8) continue;
  const head = buf.subarray(12, Math.min(26, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})([A-Z]{1,3})/);
  if (km) frames.push({ table: km[1], kind: km[2], buf });
  else { dropped += 1; frames.push({ table: '(无键)', kind: head.slice(0, 8).replace(/[^\x20-\x7e]/g, '?'), buf }); }
}
console.log('有键帧:', frames.length - dropped, '| 无键/异形帧:', dropped);

// 无键帧分类细看(可能是牌局消息!)
const nokey = frames.filter(f => f.table === '(无键)');
const byKind = {};
for (const f of nokey) { const k = f.kind + ':' + f.buf.length; byKind[k] = (byKind[k] || 0) + 1; }
console.log('=== 无键帧分类(键样:长度)===' );
for (const [k, c] of Object.entries(byKind).sort((a,b)=>b[1]-a[1]).slice(0, 15)) console.log(' ', c, k);

// 四桌的全部帧类型(含长度变体)
for (const t of ['D065', 'D055', 'D057', 'D067']) {
  const mine = frames.filter(f => f.table === t);
  const kinds = {};
  for (const f of mine) { const k = f.kind + ':' + f.buf.length; kinds[k] = (kinds[k] || 0) + 1; }
  console.log(t, '=>', JSON.stringify(kinds));
}

// dump 无键帧的样本(前 3 种)
function dump(buf, label, maxBytes) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < Math.min(buf.length, maxBytes || buf.length); off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
const kindsSeen = new Set();
for (const f of nokey) {
  const k = f.kind + ':' + f.buf.length;
  if (kindsSeen.has(k)) continue;
  kindsSeen.add(k);
  dump(f.buf, '无键帧 ' + k, 128);
  if (kindsSeen.size >= 3) break;
}