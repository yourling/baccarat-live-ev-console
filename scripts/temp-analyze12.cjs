const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const hits = { PA: [], OH: [], OC: [] };
let order = 0;
for (const l of allLines) {
  order += 1;
  if (!l.includes('networkCapture')) continue;
  for (const rid of ['GD057268211PA', 'GD065268211OH', 'GD055268211OC']) {
    const idx = l.indexOf(rid);
    if (idx >= 0 && !hits[rid.split('11')[1] === undefined ? rid : rid]) { }
  }
  for (const [rid, key] of [['GD057268211PA', 'PA'], ['GD065268211OH', 'OH'], ['GD055268211OC', 'OC']]) {
    if (l.includes(rid)) hits[key].push({ order, line: l });
  }
}
function dumpAround(line, rid) {
  const i = line.indexOf(rid);
  // 打印该字符串前后的原始 base64 区段不好读;直接找包含它的帧并解码
}
console.log('PA(GD057268211PA) 出现:', hits.PA.length, '| OH:', hits.OH.length, '| OC:', hits.OC.length);

// 解码包含 PA 的帧
const seen = new Set();
for (const h of hits.PA.slice(-4)) {
  const l = h.line;
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
  const sig = buf.length + ':' + buf.subarray(4, 8).toString('hex');
  if (seen.has(sig)) continue;
  seen.add(sig);
  console.log('\n=== 含 PA 的帧 len', buf.length, '(到达序', h.order + ') ===');
  for (let off = 0; off < buf.length; off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}