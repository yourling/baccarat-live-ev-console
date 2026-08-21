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
// 完整解码一帧(跳过帧头,protobuf)
function parseProto(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    try {
      const t = readVarint(buf, off); off = t.next;
      const f = Math.floor(t.value / 8), w = t.value % 8;
      if (w === 0) { const v = readVarint(buf, off); off = v.next; out.push({f, v: v.value}); }
      else if (w === 2) { const l = readVarint(buf, off); off = l.next; out.push({f, sub: buf.subarray(off, off + l.value)}); off += l.value; }
      else if (w === 1) { out.push({f, fixed64: buf.subarray(off, off + 8).toString('hex')}); off += 8; }
      else if (w === 5) { out.push({f, f32: buf.readFloatLE(off)}); off += 4; }
      else break;
    } catch (e) { break; }
  }
  return out;
}
function show(buf, depth) {
  const pad = '  '.repeat(depth);
  for (const item of parseProto(buf)) {
    if (item.sub) {
      const s = item.sub.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      const ratio = [...item.sub].filter(b => b >= 32 && b < 127).length / item.sub.length;
      console.log(pad + '字段' + item.f + ' (' + item.sub.length + 'B): ' + (ratio > 0.8 ? JSON.stringify(s.slice(0, 50)) : '(二进制)'));
      if (depth < 2 && item.sub.length > 4) show(item.sub, depth + 1);
    } else if (item.v !== undefined) console.log(pad + '字段' + item.f + ' = ' + item.v);
    else if (item.fixed64) console.log(pad + '字段' + item.f + ' (64位): ' + item.fixed64);
    else if (item.f32 !== undefined) console.log(pad + '字段' + item.f + ' (float): ' + item.f32);
  }
}

// 找大快照帧:含 road_data 的(之前确认过结构 字段1=桌台 字段2=计数 字段3=road)
let found = 0;
for (const l of lines.slice(-3000)) {
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
  if (buf.length < 150 || !buf.toString('latin1').includes('D06')) continue;
  // 跳过帧头(前 12 字节),从桌台键后的 protobuf 部分解码
  const head = buf.subarray(12, 24).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})/);
  if (!km) continue;
  const payload = buf.subarray(12 + km[0].length);
  console.log('\n===== 桌台', km[1], '| 帧长', buf.length, '=====');
  show(payload, 0);
  found += 1;
  if (found >= 2) break;
}
console.log('\n解剖帧数:', found);