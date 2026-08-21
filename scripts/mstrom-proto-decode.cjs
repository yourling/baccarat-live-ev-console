// mstrom 平台 Protobuf 解码器
// 用法: node scripts/mstrom-proto-decode.cjs <chunk文件路径> [只看含此桌台的帧]
const fs = require('fs');

function readVarint(buf, off) {
  let result = 0, shift = 0, pos = off;
  while (pos < buf.length) {
    const b = buf[pos];
    result += (b & 0x7f) * Math.pow(2, shift);
    pos += 1;
    if ((b & 0x80) === 0) return { value: result, next: pos };
    shift += 7;
  }
  throw new Error('varint 越界');
}

function parseProto(buf, depth) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    try {
      const tag = readVarint(buf, off);
      off = tag.next;
      const fieldNo = Math.floor(tag.value / 8);
      const wire = tag.value % 8;
      if (wire === 0) {
        const v = readVarint(buf, off);
        off = v.next;
        out.push({ field: fieldNo, wire, value: v.value });
      } else if (wire === 1) {
        out.push({ field: fieldNo, wire, hex: buf.subarray(off, off + 8).toString('hex') });
        off += 8;
      } else if (wire === 2) {
        const len = readVarint(buf, off);
        off = len.next;
        out.push({ field: fieldNo, wire, value: buf.subarray(off, off + len.value), len: len.value });
        off += len.value;
      } else if (wire === 5) {
        out.push({ field: fieldNo, wire, float: buf.readFloatLE(off) });
        off += 4;
      } else { break; }
    } catch (e) { break; }
  }
  return out;
}

function pretty(buf, depth) {
  const pad = '  '.repeat(depth);
  let result = '';
  const fields = parseProto(buf, depth);
  for (const f of fields) {
    if (f.wire === 2) {
      const text = f.value.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      const ratio = [...f.value].filter(b => b >= 32 && b < 127).length / (f.len || 1);
      if (ratio > 0.85 && f.len <= 48) {
        result += pad + '字段' + f.field + ' (字符串): "' + text.slice(0, 56) + '"\n';
      } else if (depth < 3) {
        result += pad + '字段' + f.field + ' (子消息 ' + f.len + 'B):\n' + pretty(f.value, depth + 1);
      } else {
        result += pad + '字段' + f.field + ' (数据 ' + f.len + 'B): ' + f.value.toString('hex').slice(0, 60) + '\n';
      }
    } else if (f.hex !== undefined) {
      result += pad + '字段' + f.field + ' (64位): ' + f.hex + '\n';
    } else if (f.float !== undefined) {
      result += pad + '字段' + f.field + ' (float): ' + f.float + '\n';
    } else {
      result += pad + '字段' + f.field + ' = ' + f.value + '\n';
    }
  }
  return result;
}

// 解析单帧:跳过 12 字节头 + 桌台键,载荷按 protobuf 解
function decodeFrame(buf) {
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})/);
  const seq = buf.readUInt32BE(4);
  if (!km) return null;
  const keyLen = km[0].length;
  const payload = buf.subarray(12 + keyLen);
  return { seq, table: km[1], extra: head.slice(km[0].length), payload };
}

const arg = process.argv[2] || '';
const filterTable = process.argv[3] || '';
let bufs = [];
if (arg.endsWith('.log')) {
  const lines = fs.readFileSync(arg, 'utf8').split('\n');
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
    bufs.push(Buffer.from(data, 'base64'));
  }
} else {
  bufs.push(Buffer.from(arg, 'base64'));
}
console.log('帧数:', bufs.length);
let shown = 0;
for (const b of bufs.slice(-40)) {
  const d = decodeFrame(b);
  if (!d) continue;
  if (filterTable && !d.table.startsWith(filterTable)) continue;
  shown += 1;
  console.log('\n=== 桌台', d.table, '| seq', d.seq, '===' );
  console.log(pretty(d.payload, 0));
  if (shown >= 6) break;
}