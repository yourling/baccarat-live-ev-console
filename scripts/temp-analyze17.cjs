const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => /^chunk-(19|2[0-2])\.log$/.test(f)).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const targets = { GD065268211OJ: 'D65-OJ', GD055268211OE: 'D55-OE', GD057268211PC: 'D57-PC', GD067268211NC: 'D67-NC' };
let hits = 0;
const hitSamples = [];
const gstrs = new Set();
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
  for (const [rid, label] of Object.entries(targets)) {
    if (s.includes(rid)) {
      hits += 1;
      const idx = s.indexOf(rid);
      if (hitSamples.length < 4) hitSamples.push(label + ': ' + JSON.stringify(s.slice(Math.max(0, idx - 30), idx + 50)));
    }
  }
  const re = /G[NPD]\d{3}26821[\x21-\x7e]+/g; let m;
  while ((m = re.exec(s)) !== null) gstrs.add(m[0]);
}
console.log('新局号命中:', hits);
for (const s of hitSamples) console.log('  ', s);
console.log('G 串唯一数:', gstrs.size);
for (const t of ['D065', 'D055', 'D057', 'D067']) {
  const mine = [...gstrs].filter(g => g.startsWith('G' + t)).sort();
  console.log(' ', t, '最新:', mine.slice(-3).join(', ') || '(无)');
}