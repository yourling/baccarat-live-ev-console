const fs = require('fs');
const stat = fs.statSync('.tmp-mstrom/app-console.log');
const start = Math.max(0, stat.size - 1500 * 1024);
const fd = fs.openSync('.tmp-mstrom/app-console.log', 'r');
const bufFile = Buffer.alloc(stat.size - start);
fs.readSync(fd, bufFile, 0, bufFile.length, start);
fs.closeSync(fd);
const lines = bufFile.toString('utf8').split('\n');
console.log('读取行数:', lines.length);

function readVarint(buf, off) {
  let result = 0, shift = 0, pos = off;
  while (pos < buf.length) {
    const b = buf[pos];
    result += (b & 0x7f) * Math.pow(2, shift);
    pos += 1;
    if ((b & 0x80) === 0) return { value: result, next: pos };
    shift += 7;
  }
  return null;
}
// 解析帧:提取 D055 的字段结构变化时间线
let prevRoadLen = null, prevFieldLens = null;
const timeline = [];
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
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})/);
  if (!km || km[1] !== 'D055') continue;
  const payload = buf.subarray(12 + km[0].length);
  // 解析 protobuf 字段
  let off = 0, ok = true;
  const fields = [];
  while (off < payload.length) {
    try {
      const t = readVarint(payload, off); off = t.next;
      const f = Math.floor(t.value / 8), w = t.value % 8;
      if (w === 0) { const v = readVarint(payload, off); off = v.next; fields.push({f, v: v.value}); }
      else if (w === 2) { const l2 = readVarint(payload, off); off = l2.next; fields.push({f, sub: payload.subarray(off, off + l2.value)}); off += l2.value; }
      else { ok = false; break; }
    } catch (e) { ok = false; break; }
  }
  if (!ok) continue;
  const summary = {};
  for (const item of fields) {
    if (item.v !== undefined) summary['f' + item.f] = item.v;
    else summary['f' + item.f + 'B'] = item.sub.length;
  }
  timeline.push(summary);
}
console.log('D055 帧时间线(最后 25 帧,字段摘要):');
for (const s of timeline.slice(-25)) console.log(' ', JSON.stringify(s));