const fs = require('fs');
// 只读日志文件最后 2MB(最近的流量)
const stat = fs.statSync('.tmp-mstrom/app-console.log');
const start = Math.max(0, stat.size - 2 * 1024 * 1024);
const fd = fs.openSync('.tmp-mstrom/app-console.log', 'r');
const bufFile = Buffer.alloc(stat.size - start);
fs.readSync(fd, bufFile, 0, bufFile.length, start);
fs.closeSync(fd);
const lines = bufFile.toString('utf8').split('\n');
console.log('读取行数:', lines.length);

const targets = ['GD057268211U1', 'GD065268211TM', 'GD055268211TV', 'GD057268211U2', 'GD057268211PC'];
let foundCount = {};
for (const t of targets) foundCount[t] = 0;
const samples = [];
for (const l of lines) {
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
    if (s.includes(rid)) {
      foundCount[rid] += 1;
      if (foundCount[rid] <= 2 && samples.length < 8) {
        samples.push({ rid, buf });
      }
    }
  }
}
console.log('命中统计:', JSON.stringify(foundCount));

function dump(buf, label, maxBytes) {
  console.log('\n===', label, 'len', buf.length, '===');
  for (let off = 0; off < Math.min(buf.length, maxBytes || buf.length); off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
const seen = new Set();
for (const s of samples) {
  const sig = s.buf.length + ':' + s.buf.toString('hex').slice(0, 30);
  if (seen.has(sig)) continue;
  seen.add(sig);
  dump(s.buf, s.rid);
}