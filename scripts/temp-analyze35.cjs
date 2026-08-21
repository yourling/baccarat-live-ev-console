const fs = require('fs');
const content = fs.readFileSync('.tmp-mstrom/app-console.log', 'utf8');
const lines = content.split('\n');

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

// 统计:多少帧能成功 protobuf 解析 / 多少含 D057 键 / U2 帧的解析结果
let parsedOk = 0, d057 = 0, u2Found = [];
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
  if (!km) continue;
  const payload = buf.subarray(12 + km[0].length);
  // 尝试 protobuf 解析并检查是否含局号字段
  let off = 0, ok = true;
  const fields = [];
  while (off < payload.length) {
    try {
      const t = readVarint(payload, off); off = t.next;
      const f = Math.floor(t.value / 8), w = t.value % 8;
      if (w === 0) { const v = readVarint(payload, off); off = v.next; fields.push({f, v: v.value}); }
      else if (w === 2) { const l2 = readVarint(payload, off); off = l2.next; fields.push({f, sub: payload.subarray(off, off + l2.value)}); off += l2.value; }
      else break;
    } catch (e) { ok = false; break; }
  }
  if (!ok || fields.length === 0) continue;
  parsedOk += 1;
  if (km[1] === 'D057') {
    d057 += 1;
    const rid = fields.find(x => x.f === 2 && x.sub);
    if (rid && rid.sub.toString('latin1').includes('U2')) {
      u2Found.push({ len: buf.length, fields });
    }
  }
}
console.log('protobuf 解析成功帧:', parsedOk, '| D057 帧:', d057, '| 含 U2 局号的帧:', u2Found.length);
console.log('\n=== U2 帧的字段结构 ===');
for (const u of u2Found.slice(-2)) {
  console.log('帧长', u.len, ':');
  for (const item of u.fields) {
    if (item.sub !== undefined) console.log('  字段', item.f, '(字符串):', JSON.stringify(item.sub.toString('latin1').slice(0, 30)));
    else console.log('  字段', item.f, '=', item.v);
  }
}