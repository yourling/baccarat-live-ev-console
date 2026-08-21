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
  if (buf.length >= 14) frames.push(buf);
}

// 1) 大快照帧:找载荷 >400 字节的帧并去重(按 seq+长度),dump 一个
const bigs = frames.filter(b => b.length > 480);
console.log('大帧数量:', bigs.length);
function dump(buf, label, maxBytes) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < Math.min(buf.length, maxBytes); off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
if (bigs.length) dump(bigs[0], '最大快照帧样例', 320);

// 2) 全帧搜索类牌面字节串:连续 >=4 字节都在 1..52 且互不相同
let hits = 0;
const hitSamples = [];
for (const b of frames) {
  let runStart = -1, runLen = 0;
  const seen = new Set();
  for (let off = 20; off < b.length; off++) {
    const v = b[off];
    if (v >= 1 && v <= 52 && !seen.has(v)) {
      if (runStart < 0) { runStart = off; runLen = 0; seen.clear(); }
      seen.add(v); runLen++;
      if (runLen >= 5) {
        if (hitSamples.length < 6) hitSamples.push({ table: b.subarray(12, 19).toString('latin1').replace(/[^\x20-\x7e]/g,''), off: runStart, vals: [...b.subarray(runStart, off + 1)] });
        hits++;
        runStart = -1; runLen = 0; seen.clear();
      }
    } else if (runStart >= 0) { runStart = -1; runLen = 0; seen.clear(); }
  }
}
console.log('\n类牌面字节串命中:', hits);
for (const h of hitSamples) console.log('  桌', JSON.stringify(h.table), '@', h.off, '值序列:', h.vals.join(','));