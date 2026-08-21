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
  if (buf.length < 14) continue;
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})([A-Z]{0,3})/);
  if (!km) continue;
  frames.push({ table: km[1], kind: km[2] || '', buf });
}
// 目标桌台的 BAC 帧
const targets = ['D065', 'D055', 'D057', 'D067'];
for (const t of targets) {
  const arr = frames.filter(f => f.table === t && f.kind === 'BAC');
  console.log('===', t + 'BAC', '帧数:', arr.length, '===');
  if (!arr.length) continue;
  const b = arr[arr.length - 1];
  // 扫描全部 8 字节窗口中的 IEEE754 double,列出 50~200000 范围的值(疑似金额)
  const found = [];
  for (let off = 20; off <= b.length - 8; off++) {
    const v = b.readDoubleBE(off);
    if (v >= 30 && v <= 200000 && Number.isFinite(v)) {
      const frac = v - Math.floor(v);
      if (frac === 0 || frac > 0.001) found.push({ off, v });
    }
  }
  // 去重相邻重叠窗口,只保留间隔 >=4 的
  const dedup = [];
  for (const f2 of found) { if (!dedup.length || f2.off - dedup[dedup.length-1].off >= 4) dedup.push(f2); }
  console.log('  疑似金额(double):', dedup.map(d => '@' + d.off + '=' + Math.round(d.v * 100) / 100).join(', '));
}