const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => /^chunk-(2[0-5])\.log$/.test(f)).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));

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
function parseTop(buf) {
  const out = [];
  let off = 12 + 4; // 跳过帧头前段+桌台键长度待定,先粗略从12开始
  // 桌台键:偏移12起 [NPD]\d{2,4}
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})/);
  if (!km) return null;
  off = 12 + km[0].length;
  while (off < buf.length) {
    try {
      const tag = readVarint(buf, off);
      off = tag.next;
      const fieldNo = Math.floor(tag.value / 8);
      const wire = tag.value % 8;
      if (wire === 2) {
        const len = readVarint(buf, off);
        off = len.next;
        out.push({ field: fieldNo, value: buf.subarray(off, off + len.value) });
        off += len.value;
      } else if (wire === 0) {
        const v = readVarint(buf, off);
        off = v.next;
        out.push({ field: fieldNo, varint: v.value });
      } else break;
    } catch (e) { break; }
  }
  return { table: km[1], fields: out };
}

// 收集四桌的字段8 子消息,按时序排列
const targets = ['D065', 'D055', 'D057', 'D067'];
const series = {};
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
  const pf = parseTop(buf);
  if (!pf) continue;
  const f8 = pf.fields.find(f => f.field === 8 && f.value);
  if (!f8) continue;
  if (!targets.some(t => pf.table === t)) continue;
  (series[pf.table] = series[pf.table] || []).push(f8.value);
}

// 对齐打印:每桌取最后 8 个状态载荷,按字节位置对比
for (const t of targets) {
  const arr = series[t] || [];
  console.log('\n===', t, '字段8 状态载荷,样本:', arr.length, '===');
  for (const payload of arr.slice(-8)) {
    console.log('  ', payload.toString('hex').match(/../g).join(' '));
  }
}