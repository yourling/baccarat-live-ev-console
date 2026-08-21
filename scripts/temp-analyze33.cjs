const fs = require('fs');
// 读整个持久日志
const content = fs.readFileSync('.tmp-mstrom/app-console.log', 'utf8');
const lines = content.split('\n');
console.log('日志总行数:', lines.length);

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
function parseProto(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    try {
      const t = readVarint(buf, off); off = t.next;
      const f = Math.floor(t.value / 8), w = t.value % 8;
      if (w === 0) { const v = readVarint(buf, off); off = v.next; out.push({f, v: v.value}); }
      else if (w === 2) { const l = readVarint(buf, off); off = l.next; out.push({f, sub: buf.subarray(off, off + l.value)}); off += l.value; }
      else break;
    } catch (e) { break; }
  }
  return out;
}

// 已知牌面的局号(地面真相)
const known = {
  GD055268211TV: 'D55 闲1(7♦4♥) 庄8(2♠6♦)',
  GD065268211OJ: 'D65 闲6(J♥6♠?) 庄1(K♥A♦?)',
  GD057268211U1: 'D57 闲?(Q♣9♠?) 庄5(10♣5♠)',
};

// 全日志搜索这些局号的帧并解码
for (const rid of Object.keys(known)) {
  let found = 0;
  console.log('\n===== 局号', rid, '|', known[rid], '=====');
  for (const l of lines) {
    if (!l.includes('networkCapture')) continue;
    if (!l.includes(rid)) continue;
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
    const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
    const km = head.match(/^([NPD]\d{2,4})/);
    if (!km) continue;
    const payload = buf.subarray(12 + km[0].length);
    const fields = parseProto(payload);
    // 提取关键字段:1(类型) 2(局号) 4(庄分) 5(闲分)
    const summary = {};
    for (const item of fields) {
      if (item.f === 2 && item.sub) summary.roundId = item.sub.toString('latin1');
      if (item.f === 1 && item.sub) summary.type = item.sub.toString('latin1');
      if ((item.f === 4 || item.f === 5) && item.v !== undefined) summary['字段' + item.f] = item.v;
    }
    if (summary.roundId === rid) {
      found += 1;
      console.log('  帧 len', buf.length, ':', JSON.stringify(summary));
      if (found >= 2) break;
    }
  }
  if (found === 0) console.log('  (日志中未找到该局号的帧——可能已滚出缓冲)');
}