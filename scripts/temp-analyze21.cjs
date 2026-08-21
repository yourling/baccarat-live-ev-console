const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const d065 = [];
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
  if (buf.toString('latin1').includes('D065') && buf.length > 50) d065.push(buf);
}
console.log('含 D065 且 >50 字节的帧:', d065.length);
// 按长度分组统计
const byLen = {};
for (const b of d065) byLen[b.length] = (byLen[b.length] || 0) + 1;
console.log('长度分布:', JSON.stringify(byLen));

function dump(buf, label) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < buf.length; off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
// dump 一个 99+ 字节的样本
const big = d065.find(b => b.length >= 99);
if (big) dump(big, 'D065 长帧样例');