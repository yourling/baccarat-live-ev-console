const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const hits = { OI: [], OD: [], PC: [] };
let lineNo = 0;
for (const l of allLines) {
  lineNo += 1;
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
  for (const [rid, key] of [['GD065268211OI', 'OI'], ['GD055268211OD', 'OD'], ['GD057268211PC', 'PC']]) {
    if (s.includes(rid)) {
      hits[key].push({ lineNo, buf });
    }
  }
}
console.log('解码后命中: OI:', hits.OI.length, '| OD:', hits.OD.length, '| PC:', hits.PC.length);
function dump(buf, label, maxBytes) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < Math.min(buf.length, maxBytes || buf.length); off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
const seen = new Set();
for (const [key, arr] of Object.entries(hits)) {
  for (const h of arr.slice(-2)) {
    const sig = h.buf.length + ':' + h.buf.subarray(4, 10).toString('hex');
    if (seen.has(sig)) continue;
    seen.add(sig);
    dump(h.buf, key + ' 局号帧(行' + h.lineNo + ')', 220);
  }
}