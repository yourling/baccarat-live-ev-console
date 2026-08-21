const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const frames = [];
let order = 0;
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
  // 键提取:从偏移 12 起匹配 [NPD]\d{2,4} 开头的 ASCII 键
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})([A-Z]{0,3})/);
  if (!km) continue;
  frames.push({ order: order++, table: km[1], kind: km[2] || '', buf, keyLen: km[0].length });
}
console.log('带键帧:', frames.length);

// ROU 帧按桌分组,按到达排序,做载荷差分(找追加记录)
const rouByTable = {};
for (const f of frames) {
  if (f.kind !== 'ROU') continue;
  const payload = f.buf.subarray(12 + f.keyLen);
  (rouByTable[f.table] = rouByTable[f.table] || []).push({ order: f.order, seq: f.buf.readUInt32BE(4), payload });
}
console.log('=== ROU 载荷差分(每桌)===' );
for (const [table, arr] of Object.entries(rouByTable)) {
  if (arr.length < 3) continue;
  arr.sort((a, b) => a.order - b.order);
  console.log('桌', table, '帧数', arr.length);
  for (let i = 1; i < arr.length; i++) {
    const prev = arr[i-1].payload, cur = arr[i].payload;
    // 找公共前缀长度
    let common = 0;
    while (common < Math.min(prev.length, cur.length) && prev[common] === cur[common]) common++;
    const appended = cur.subarray(common);
    const removed = prev.length - common;
    if (appended.length > 0 || removed > 0) {
      console.log('   seq', arr[i].seq, '公共前缀', common, '| 追加', appended.length, '字节:', appended.toString('hex').slice(0, 60), '| 尾部移除', removed);
    }
  }
}