const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));

// 完整 TLV 解析器
function parseFrame(buf) {
  const type = buf.readUInt16BE(0);
  const seq = buf.readUInt32BE(4);
  // 从偏移 12 起扫描:先找桌台键([NPD]\d{2,4} 开头的 ASCII),然后 TLV 链
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
    if (off + 2 + len > buf.length) { tlvs.push({ tag, len, truncated: true, value: buf.subarray(off + 2) }); break; }
    tlvs.push({ tag, len, value: buf.subarray(off + 2, off + 2 + len) });
    off += 2 + len;
  }
  return { type, seq, key, tlvs };
}

// 枚举所有帧的所有 TLV 标签,记录 标签->出现次数、典型值
const tagStats = {};
let parsed = 0;
const bacByTable = {};
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
  const pf = parseFrame(buf);
  if (!pf) continue;
  parsed += 1;
  const hasTypeBAC = pf.tlvs.some(t => t.len >= 3 && t.value && t.value.toString('latin1') === 'BAC');
  for (const t of pf.tlvs) {
    const k = '0x' + t.tag.toString(16).padStart(2, '0');
    tagStats[k] = tagStats[k] || { count: 0, lens: new Set(), samples: [] };
    tagStats[k].count += 1;
    tagStats[k].lens.add(t.len);
    if (tagStats[k].samples.length < 2 && t.len > 0 && t.len <= 40) tagStats[k].samples.push(t.value.toString('latin1').replace(/[^\x20-\x7e]/g, '.') || '(二进制)');
  }
  if (hasTypeBAC) {
    (bacByTable[pf.key] = bacByTable[pf.key] || []).push(pf);
  }
}
console.log('成功解析帧:', parsed);
console.log('\n=== 全部 TLV 标签枚举 ===');
for (const [k, v] of Object.entries(tagStats).sort((a,b)=>parseInt(a[0])-parseInt(b[0]))) {
  console.log(' ', k, '×', v.count, '| 长度:', [...v.lens].slice(0, 6).join(','), '| 样本:', v.samples.join(' / ').slice(0, 60));
}
console.log('\n带 BAC 类型 TLV 的桌台数:', Object.keys(bacByTable).length);