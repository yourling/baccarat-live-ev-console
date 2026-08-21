const fs = require('fs');
const files = fs.readdirSync('.tmp-mstrom').filter(f => f.endsWith('.log')).sort();
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
function dump(buf, label, maxBytes) {
  console.log('===', label, 'len', buf.length, '===');
  for (let off = 0; off < Math.min(buf.length, maxBytes); off += 32) {
    const chunk = buf.subarray(off, off + 32);
    console.log(String(off).padStart(4), chunk.toString('hex').match(/../g).join(' ').padEnd(95), chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  }
}

// 找恒定长度周期帧:按 长度+前8字节 分组
const groups = {};
for (const b of frames) {
  const k = b.length + ':' + b.subarray(0, 8).toString('hex');
  (groups[k] = groups[k] || []).push(b);
}
const periodic = Object.entries(groups).filter(([k, arr]) => arr.length >= 8);
console.log('=== 周期性恒定帧组 ===');
for (const [k, arr] of periodic) {
  const key = arr[0].subarray(12, 24).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  console.log(' ', k.slice(0, 20), 'len', arr[0].length, '帧数', arr.length);
}

// dump N027NN 与 N051 样本
const n27 = frames.filter(b => b.length === 185 && b.subarray(12, 17).toString('latin1') === 'N027N');
const n51 = frames.filter(b => b.subarray(12, 16).toString('latin1') === 'N051');
if (n27.length) dump(n27[0], 'N027NN', 185);
if (n51.length) dump(n51[0], 'N051', 172);

// 全帧搜索截图金额(多种编码)
const targets = [3240, 1096, 4446, 19900, 110, 2926, 9984];
const hitInfo = {};
for (const b of frames) {
  for (let off = 0; off <= b.length - 2; off++) {
    for (const [label, v] of Object.entries({ u16be: b.readUInt16BE(off), u16le: b.readUInt16LE(off) })) {
      if (targets.includes(v)) {
        const key = b.subarray(12, 20).toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 8) + '|' + label;
        hitInfo[key] = (hitInfo[key] || 0) + 1;
      }
    }
  }
}
console.log('\n=== 金额 u16 命中(按键)===' );
for (const [k, c] of Object.entries(hitInfo).sort((a,b)=>b[1]-a[1]).slice(0, 15)) console.log(' ', c, k);