const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => /^chunk-(1[4-9]|2[01])\.log$/.test(f)).sort();
let allLines = [];
for (const f of files) allLines.push(...fs.readFileSync('.tmp-mstrom/' + f, 'utf8').split('\n'));
const frames = [];
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
  if (buf.length >= 14) frames.push(buf);
}
console.log('帧总数:', frames.length);

// 目标金额:D57(庄1257 闲2383) D55(庄15286 闲49633 和180)
const targets = [1257, 2383, 15286, 49633, 180];
const hitsBy = {};
for (const b of frames) {
  const key = b.subarray(12, 20).toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 10);
  for (let off = 0; off <= b.length - 2; off++) {
    const checks = [
      ['u16be', b.readUInt16BE ? b.readUInt16BE(off) : null],
      ['u16le', b.readUInt16LE(off)],
    ];
    for (const [label, v] of checks) {
      if (targets.includes(v)) {
        const k = key + '|' + label + '@' + off;
        hitsBy[k] = (hitsBy[k] || 0) + 1;
      }
    }
    if (off <= b.length - 4) {
      const f32 = b.readFloatBE(off);
      if (targets.some(t => Math.abs(f32 - t) < 0.5)) {
        const k = key + '|f32be@' + off;
        hitsBy[k] = (hitsBy[k] || 0) + 1;
      }
      const u32 = b.readUInt32BE(off);
      if (targets.includes(u32)) { const k = key + '|u32be@' + off; hitsBy[k] = (hitsBy[k] || 0) + 1; }
    }
    if (off <= b.length - 8) {
      const f64 = b.readDoubleBE(off);
      if (targets.some(t => Math.abs(f64 - t) < 0.5)) {
        const k = key + '|f64be@' + off;
        hitsBy[k] = (hitsBy[k] || 0) + 1;
      }
    }
  }
}
console.log('=== 目标金额命中(按帧键+编码+偏移)===' );
for (const [k, c] of Object.entries(hitsBy).sort((a,b)=>b[1]-a[1]).slice(0, 20)) console.log(' ', c, k);