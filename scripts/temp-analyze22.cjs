const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const seen = new Set();
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
  const sig = buf.length + ':' + buf.subarray(12, 20).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  frames.push(buf);
}
// 找含 D065 且长度 180-190 的帧(路子快照候选)
function dump(buf, label, maxBytes) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < Math.min(buf.length, maxBytes || buf.length); off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
const snap = frames.filter(b => b.toString('latin1').includes('D065') && b.length >= 175 && b.length <= 195);
console.log('D065 路子快照候选:', snap.length);
if (snap.length) dump(snap[snap.length - 1], 'D065 快照帧', 200);