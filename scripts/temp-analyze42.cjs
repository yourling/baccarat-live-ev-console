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

// ===== 第一部分:收集所有桌的路子追加记录(varint 解码)=====
const lastRoad = {};
const appendedAll = [];
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
  if (!pf) continue;
  const f3 = pf.fields.find(x => x.f === 3 && x.sub && x.sub.length >= 6);
  if (!f3) continue;
  const key = pf.table;
  const sig = f3.sub.toString('hex');
  if (lastRoad[key] === sig) continue;
  const prevHex = lastRoad[key];
  lastRoad[key] = sig;
  if (!prevHex) continue;
  const prev = Buffer.from(prevHex, 'hex');
  let common = 0;
  while (common < Math.min(prev.length, f3.sub.length) && prev[common] === f3.sub[common]) common++;
  const appended = f3.sub.subarray(common);
  if (appended.length < 1 || appended.length > 8) continue;
  // varint 解码追加部分
  const vals = [];
  let p = 0;
  try {
    while (p < appended.length) {
      const v = readVarint(appended, p);
      vals.push(v.value);
      p = v.next;
    }
  } catch (e) { continue; }
  appendedAll.push({ table: key, vals, hex: appended.toString('hex') });
}
console.log('=== 路子追加记录总数:', appendedAll.length, '===');
// 统计 varint 值模式
const patternCount = {};
for (const a of appendedAll) {
  const k = a.vals.join(',');
  patternCount[k] = (patternCount[k] || 0) + 1;
}
console.log('=== 追加记录的 varint 模式分布(前 25)===' );
for (const [k, c] of Object.entries(patternCount).sort((a,b)=>b[1]-a[1]).slice(0, 25)) console.log(' ', c, '× [' + k + ']');