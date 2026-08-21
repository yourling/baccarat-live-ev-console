const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => /^chunk-(2[0-6])\.log$/.test(f)).sort();
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
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})/);
  if (!km) return null;
  let off = 12 + km[0].length;
  const fields = [];
  while (off < buf.length) {
    try {
      const tag = readVarint(buf, off);
      off = tag.next;
      const fieldNo = Math.floor(tag.value / 8);
      const wire = tag.value % 8;
      if (wire === 2) {
        const len = readVarint(buf, off);
        off = len.next;
        fields.push({ field: fieldNo, value: buf.subarray(off, off + len.value) });
        off += len.value;
      } else if (wire === 0) {
        const v = readVarint(buf, off);
        off = v.next;
        fields.push({ field: fieldNo, varint: v.value });
      } else break;
    } catch (e) { break; }
  }
  return { table: km[1], fields };
}

// 对四桌的最新字段8 载荷:按 12 字节记录切分,输出 [市场键hex → 金额]
for (const t of ['D065', 'D055', 'D057', 'D067']) {
  let latest = null;
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
    if (!pf || pf.table !== t) continue;
    const f8 = pf.fields.find(f => f.field === 8 && f.value && f.value.length >= 12);
    if (f8) latest = f8.value;
  }
  console.log('\n===', t, '最新字段8 载荷(12字节记录切分)===' );
  if (!latest) { console.log('  (无)'); continue; }
  console.log('  载荷长度:', latest.length);
  for (let off = 0; off + 12 <= latest.length; off += 12) {
    const rec = latest.subarray(off, off + 12);
    const v = rec.readDoubleBE(4);
    console.log('  记录@' + off + ': 键=' + rec.subarray(0, 4).toString('hex') + ' → 金额=' + (Number.isFinite(v) ? Math.round(v * 100) / 100 : 'N/A'));
  }
  // 尾部剩余字节
  const tailStart = Math.floor(latest.length / 12) * 12;
  if (tailStart < latest.length) console.log('  尾部:', latest.subarray(tailStart).toString('hex'));
}