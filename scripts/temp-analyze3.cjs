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

// 1) 找包含 G 结算串的帧,打印整帧 hex+ascii
function dump(buf, label) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < buf.length; off += 32) {
    const chunk = buf.subarray(off, off + 32);
    const hex = chunk.toString('hex').match(/../g).join(' ');
    const asc = chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    console.log(String(off).padStart(4), hex.padEnd(95), asc);
  }
}
const gFrames = frames.filter(b => b.toString('latin1').includes('GP0') || b.toString('latin1').includes('GN0') || b.toString('latin1').includes('GD0'));
console.log('含 G 结算串的帧:', gFrames.length);
if (gFrames.length) dump(gFrames[0], 'G结结算帧样例');

// 2) 提取全部 G 串并按桌台分组排序(看结果序列)
const gstrs = [];
for (const b of frames) {
  const s = b.toString('latin1');
  const re = /G[NPD]\d+[A-Z0-9]*/g; let m;
  while ((m = re.exec(s)) !== null) gstrs.push(m[0]);
}
console.log('\n=== G 结算串样本(按出现顺序,去重前 30)===' );
const seen = new Set();
for (const g of gstrs) { if (seen.has(g)) continue; seen.add(g); console.log(' ', g); if (seen.size >= 30) break; }

// 3) 同一桌台连续 BAC 帧差分:P001BAC 为例
const bac = frames.filter(b => b.toString('latin1').includes('P001BAC'));
console.log('\nP001BAC 帧数:', bac.length);
if (bac.length >= 2) {
  dump(bac[0], 'P001BAC 第一帧');
  dump(bac[bac.length-1], 'P001BAC 最后一帧');
}