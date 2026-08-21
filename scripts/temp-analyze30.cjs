const fs = require('fs');
const content = fs.readFileSync('.tmp-mstrom/app-console.log', 'utf8');
const lines = content.split('\n');
// 只取文件后半部分(最近的流量)
const recent = lines.slice(Math.floor(lines.length * 0.7));
const gstrs = [];
let frameCount = 0;
for (const l of recent) {
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
  const re = /G[NPD]\d{3}26821[\x21-\x7e]+/g; let m;
  while ((m = re.exec(s)) !== null) gstrs.push(m[0]);
}
const uniq = [...new Set(gstrs)].sort();
console.log('近期 G 串唯一数:', uniq.length);
for (const t of ['GD065', 'GD055', 'GD056', 'GD057']) {
  const mine = uniq.filter(g => g.startsWith(t));
  console.log(' ', t, ':', mine.length ? mine.slice(-4).join(', ') : '(无)');
}