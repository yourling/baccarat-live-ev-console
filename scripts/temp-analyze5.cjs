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
  if (buf.length >= 12) frames.push(buf);
}
function dump(buf, label) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < buf.length; off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
const pp = frames.filter(b => b.toString('latin1').includes('P001P'));
console.log('P001P 帧数:', pp.length);
for (const p of pp.slice(0, 2)) dump(p, 'P001P');

// P001BAC 全部帧的关键字段对比:定时器与 0x41 字段
const bac = frames.filter(b => b.toString('latin1').includes('P001BAC'));
console.log('\nP001BAC 帧数:', bac.length, '(按到达顺序)');
for (const b of bac.slice(0, 23)) {
  const t1 = b[21], t2 = b[23], t3 = b[25];
  const h41 = b.subarray(33, 41).toString('hex');
  console.log('  定时器:', t1, t2, t3, '| 0x41字段:', h41);
}