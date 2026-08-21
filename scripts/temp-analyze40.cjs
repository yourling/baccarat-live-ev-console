const fs = require('fs');
const stat = fs.statSync('.tmp-mstrom/app-console.log');
const start = Math.max(0, stat.size - 1200 * 1024);
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

// 四桌时间线:字段2计数 / 局号串 / 字段3路子长度 / 字段8长度
for (const t of ['D065', 'D055', 'D056', 'D057', 'D067']) {
  console.log('\n===', t, '===');
  let count = 0;
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
    if (!pf || pf.table !== t) continue;
    count += 1;
    if (count % 3 !== 0 && count > 3) continue; // 抽样打印
    const parts = [];
    for (const item of pf.fields) {
      if (item.f === 2 && item.sub) parts.push('局号=' + JSON.stringify(item.sub.toString('latin1').slice(9)));
      else if (item.f === 2 && item.v !== undefined) parts.push('计数=' + item.v);
      else if (item.f === 3 && item.sub) parts.push('路子B=' + item.sub.length);
      else if (item.f === 8 && item.sub) parts.push('状态B=' + item.sub.length);
      else if (item.v !== undefined && !parts.some(p => p.startsWith('阶段'))) parts.push('阶段=' + item.v);
    }
    console.log('  ', parts.join(' | '));
    if (count > 60) break;
  }
}