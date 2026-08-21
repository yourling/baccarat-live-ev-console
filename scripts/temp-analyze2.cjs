const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const frames = [];
for (const l of allLines) {
  if (!l.includes('networkCapture')) continue;
  const url = (l.match(/"url":"([^"]*)"/) || [])[1] || '';
  const dir = (l.match(/"direction":"([^"]*)"/) || [])[1] || '';
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
  if (buf.length < 12) continue;
  // 头部解析: u16 ver | u16 ? | u32 seq | u32 ? | 7字节桌台码 | 载荷
  const ver = buf.readUInt16BE(0);
  const h2 = buf.readUInt16BE(2);
  const seq = buf.readUInt32BE(4);
  const flag = buf.readUInt32BE(8);
  const code = buf.subarray(12, Math.min(19, buf.length)).toString('latin1');
  const payload = buf.subarray(19);
  frames.push({ url, dir, ver, h2, seq, flag, code, payload, len: buf.length });
}
console.log('解析帧:', frames.length);

// 按桌台码分组统计
const byCode = {};
for (const f of frames) { const k = f.code.replace(/[^A-Z0-9]/g, ''); byCode[k] = byCode[k] || []; byCode[k].push(f); }
console.log('=== 桌台码分组 ===');
for (const k of Object.keys(byCode).sort()) {
  const arr = byCode[k];
  const seqs = arr.map(f => f.seq);
  console.log(' ', k || '(空)', '帧数', arr.length, '| 方向', arr[0].dir, '| seq范围', Math.min(...seqs), '-', Math.max(...seqs), '| 载荷长度 min/max', Math.min(...arr.map(f=>f.payload.length)), '/', Math.max(...arr.map(f=>f.payload.length)));
}

// ASCII 字符串扫描:所有 >=4 字符的可读串(去重取前 40 个)
const strings = new Set();
for (const f of frames) {
  const s = (f.code + f.payload.toString('latin1'));
  const re = /[\x20-\x7e]{4,}/g; let m;
  while ((m = re.exec(s)) !== null && strings.size < 200) strings.add(m[0]);
}
console.log('=== 协议内可见字符串(前 40)===' );
console.log([...strings].slice(0, 40).join(' | '));
