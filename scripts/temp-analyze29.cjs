const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));

// 目标:当前四桌局号(截图地面真相)
const targets = ['GD065268211S0', 'GD057268211SQ', 'GD056268211SV', 'GD055268211SC'];
let found = [];
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
  const s = buf.toString('latin1');
  for (const rid of targets) {
    const idx = s.indexOf(rid);
    if (idx >= 0 && !found.some(f => f.rid === rid && f.buf.equals(buf))) {
      found.push({ rid, buf, idx });
    }
  }
}
console.log('命中当前局号的唯一帧:', found.length);
function dump(buf, label, maxBytes) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < Math.min(buf.length, maxBytes || buf.length); off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
for (const f of found.slice(0, 4)) {
  console.log('\n>>> 局号', f.rid, '@解码偏移', f.idx);
  dump(f.buf, '帧', 240);
}