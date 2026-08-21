const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
let gstrs = [];
const rouFrames = [];
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
  const s = buf.toString('latin1');
  const re = /G[NPD]\d{3}26821[\x21-\x7e]{0,6}/g; let m;
  while ((m = re.exec(s)) !== null) gstrs.push({ str: m[0], len: buf.length });
  if (/ROU/.test(s)) rouFrames.push(buf);
}
console.log('G 串总数(含重复):', gstrs.length);
const uniq = [...new Set(gstrs.map(g => g.str))].sort();
console.log('去重:', uniq.length);
// 目标四桌的局号是否出现
for (const rid of ['GD065268211OH', 'GD055268211OC', 'GD057268211PA', 'GD067268211NB']) {
  const found = uniq.filter(u => u.startsWith(rid.slice(0, 10)));
  console.log(rid, '=>', found.length ? found.join(', ') : '(未出现)');
}
console.log('\n=== 全部唯一 G 串(按桌台分组,每桌前 5)===' );
const byTable = {};
for (const g of uniq) { const t = g.match(/G([NPD]\d{3})/)[1]; (byTable[t] = byTable[t] || []).push(g); }
for (const t of Object.keys(byTable).sort()) console.log(' ', t, ':', byTable[t].slice(0, 5).join(' | '));