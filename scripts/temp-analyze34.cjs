const fs = require('fs');
const content = fs.readFileSync('.tmp-mstrom/app-console.log', 'utf8');
const lines = content.split('\n');

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

const catalogByRound = {};
const seenRounds = {};
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
  const head = buf.subarray(12, Math.min(24, buf.length)).toString('latin1');
  const km = head.match(/^([NPD]\d{2,4})/);
  if (!km) continue;
  const payload = buf.subarray(12 + km[0].length);
  const fields = parseProto(payload);
  const rec = { table: km[1], f: {} };
  let hasRound = false;
  for (const item of fields) {
    if (item.f === 2 && item.sub) { rec.roundId = item.sub.toString('latin1'); hasRound = true; }
    else if (item.f === 1 && item.sub) rec.type = item.sub.toString('latin1');
    else if (item.v !== undefined) rec.f[item.field] = item.v;
    else if (item.sub) rec.f[item.field] = item.sub.toString('hex');
  }
  if (!hasRound) continue;
  const rid = rec.roundId;
  seenRounds[rid] = (seenRounds[rid] || 0) + 1;
  const fieldCount = Object.keys(rec.f).length;
  if (!catalogByRound[rid] || fieldCount > Object.keys(catalogByRound[rid].f || {}).length) {
    catalogByRound[rid] = { table: rec.table, type: rec.type || '', f: rec.f };
  }
}

const rids = Object.keys(catalogByRound);
console.log('局号总数:', rids.length);
const withScores = rids.filter(r => catalogByRound[r].f['4'] !== undefined);
console.log('含庄分/闲分字段的局:', withScores.length);
for (const rid of withScores.slice(-10)) {
  const c = catalogByRound[rid];
  console.log(' ', rid, '| 庄分:', c.f['4'], '| 闲分:', c.f['5'], '| 全字段:', JSON.stringify(c.f).slice(0, 160));
}
const noScores = rids.filter(r => catalogByRound[r].f['4'] === undefined);
if (noScores.length) {
  console.log('\n无分数样本(下注阶段局):');
  for (const rid of noScores.slice(-3)) {
    console.log(' ', rid, ':', JSON.stringify(catalogByRound[rid].f).slice(0, 160));
  }
}
fs.writeFileSync('.tmp-mstrom/round-catalog.json', JSON.stringify(catalogByRound, null, 1));
console.log('\n目录已保存: .tmp-mstrom/round-catalog.json');