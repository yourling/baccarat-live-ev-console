const fs = require('fs');
const stat = fs.statSync('.tmp-mstrom/app-console.log');
const start = Math.max(0, stat.size - 1200 * 1024);
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
function parseTop(buf) {
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})/);
  if (!km) return null;
  let off = 12 + km[0].length;
  const fields = [];
  while (off < buf.length) {
    try {
      const tag = readVarint(buf, off);
      off = tag.next;
      const f = Math.floor(tag.value / 8), w = tag.value % 8;
      if (w === 0) { const v = readVarint(buf, off); off = v.next; fields.push({f, v: v.value}); }
      else if (w === 2) { const l = readVarint(buf, off); off = l.next; fields.push({f, sub: buf.subarray(off, off + l.value)}); off += l.value; }
      else break;
    } catch (e) { break; }
  }
  return { table: km[1], fields };
}

// 收集 D055 全部字段3 载荷(去重,按时序)
const roads = [];
let lastSig = '';
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
  const pf = parseTop(buf);
  if (!pf || pf.table !== 'D055') continue;
  const f3 = pf.fields.find(x => x.f === 3 && x.sub);
  if (!f3) continue;
  const sig = f3.sub.toString('hex');
  if (sig === lastSig) continue;
  lastSig = sig;
  roads.push({ seq: buf.readUInt32BE(4), len: f3.sub.length, hex: sig });
}

// 差分:相邻路子的追加部分
console.log('D055 去重后路子快照:', roads.length);
for (const r of roads.slice(-20)) console.log('  seq', String(r.seq).padStart(4), 'len', String(r.len).padStart(3), ':', r.hex.slice(0, 80));
console.log('\n=== 相邻差分(追加的字节)===' );
for (let i = 1; i < roads.length; i++) {
  const prev = Buffer.from(roads[i-1].hex, 'hex');
  const cur = Buffer.from(roads[i].hex, 'hex');
  let common = 0;
  while (common < Math.min(prev.length, cur.length) && prev[common] === cur[common]) common++;
  const appended = cur.subarray(common);
  if (appended.length > 0 && appended.length <= 12) {
    console.log('  +' + appended.length + 'B:', appended.toString('hex'), '| 追加前长度', prev.length);
  }
}