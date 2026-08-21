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

// 提取四桌的字段8 载荷中的全部 double(按位置),按时序排列
for (const t of ['D065', 'D057', 'D067']) {
  const arr = [];
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
    const f8 = pf.fields.find(f => f.field === 8 && f.value);
    if (!f8 || f8.value.length < 20) continue;
    // 提取全部 IEEE754 BE double(8字节对齐扫描)
    const doubles = [];
    for (let off = 0; off <= f8.value.length - 8; off++) {
      const v = f8.value.readDoubleBE(off);
      if (v >= 20 && v <= 500000 && Number.isFinite(v)) {
        if (!doubles.some(d => Math.abs(d.v - v) < 0.01 && Math.abs(d.off - off) < 4)) doubles.push({ off, v });
      }
    }
    arr.push({ doubles });
  }
  console.log('\n===', t, '字段8 中的 double 值时序(最后 8 个样本)===' );
  for (const s of arr.slice(-8)) {
    console.log('  ', s.doubles.map(d => '@' + d.off + '=' + Math.round(d.v)).join(' | ') || '(无)');
  }
}