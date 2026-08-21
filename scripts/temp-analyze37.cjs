const fs = require('fs');
const stat = fs.statSync('.tmp-mstrom/app-console.log');
const start = Math.max(0, stat.size - 1500 * 1024);
const fd = fs.openSync('.tmp-mstrom/app-console.log', 'r');
const bufFile = Buffer.alloc(stat.size - start);
fs.readSync(fd, bufFile, 0, bufFile.length, start);
fs.closeSync(fd);
const lines = bufFile.toString('utf8').split('\n');

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

// 找特殊帧:f1 长度 4 且 f2 ≈ 5575 的 D055 帧
function dump(buf, label) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < buf.length; off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}
let found = 0;
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
  // 解析 protobuf 并检查签名:f1 len 4 + 存在 f2 varint
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
  const f1 = fields.find(x => x.f === 1 && x.sub && x.sub.length === 4);
  const f2 = fields.find(x => x.f === 2 && x.v !== undefined);
  const f3 = fields.find(x => x.f === 3 && x.sub);
  if (f1 && f2 && f2.v > 1000 && f3 && f3.sub.length > 20) {
    found += 1;
    console.log('\n##### 特殊帧 #', found, '(f2 =', f2.v, ') #####');
    console.log('f1 内容:', JSON.stringify(f1.sub.toString('latin1')));
    dump(buf, '完整帧');
    // f3 子消息单独解码
    dump(f3.sub, 'f3 子消息(' + f3.sub.length + 'B)');
    if (found >= 2) break;
  }
}