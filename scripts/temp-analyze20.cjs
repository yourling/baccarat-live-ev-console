const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));

// 完整 TLV 解析器(同 v19)
function parseFrame(buf) {
  const seq = buf.readUInt32BE(4);
  let keyEnd = -1, key = '';
  for (let start = 12; start <= Math.min(20, buf.length - 4); start++) {
    const m = buf.subarray(start).toString('latin1').match(/^([NPD]\d{2,4})/);
    if (m) { key = m[1]; keyEnd = start + m[1].length; break; }
  }
  if (keyEnd < 0) return null;
  const tlvs = [];
  let off = keyEnd;
  while (off + 2 <= buf.length) {
    const tag = buf[off];
    const len = buf[off + 1];
    if (off + 2 + len > buf.length) break;
    tlvs.push({ tag, len, value: buf.subarray(off + 2, off + 2 + len) });
    off += 2 + len;
  }
  return { seq, key, tlvs };
}

// 收集目标桌的 BAC 帧,按序号排序,列出每帧的全部 TLV(tag:len)
for (const table of ['D065', 'D067']) {
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
    if (buf.length < 20 || !buf.toString('latin1').includes(table)) continue;
    const pf = parseFrame(buf);
    if (!pf || pf.key !== table) continue;
    const bacTlv = pf.tlvs.find(t => t.len >= 3 && t.value && t.value.toString('latin1') === 'BAC');
    if (!bacTlv) continue;
    arr.push({ seq: pf.seq, tlvs: pf.tlvs });
  }
  arr.sort((a, b) => a.seq - b.seq);
  console.log('\n===', table, 'BAC 帧(按 seq 排序),帧数:', arr.length, '===');
  for (const f of arr.slice(0, 24)) {
    const sig = f.tlvs.map(t => t.tag.toString(16) + ':' + t.len).join(' ');
    console.log('  seq', String(f.seq).padStart(4), '|', sig);
  }
}