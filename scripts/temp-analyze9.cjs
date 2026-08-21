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

// 1) 完整解剖 D065BAC 最新帧
const d65 = frames.filter(b => b.subarray(12, 16).toString('latin1') === 'D065' && b.subarray(16, 19).toString('latin1') === 'BAC');
console.log('D065BAC 帧数:', d65.length);
if (d65.length) dump(d65[d65.length - 1], 'D065BAC 最新帧', 160);

// 2) 多桌汇总帧 N027NN(34 帧恒定 164 字节)解剖
const n27 = frames.filter(b => b.length === 164 + 21 && b.subarray(12, 17).toString('latin1') === 'N027N');
console.log('\nN027NN 候选:', n27.length);
if (n27.length) dump(n27[0], 'N027NN 多桌汇总帧', 200);

// 3) 在全部帧中按多种编码搜索 2926/9984/10159/11043
const targets = [2926, 9984, 10159, 11043];
const encHits = {};
for (const b of frames) {
  for (let off = 0; off <= b.length - 4; off++) {
    const u32be = b.readUInt32BE(off);
    if (targets.includes(u32be)) { const k = 'u32be'; encHits[k] = (encHits[k]||0)+1; }
    const u32le = b.readUInt32LE(off);
    if (targets.includes(u32le)) { const k = 'u32le'; encHits[k] = (encHits[k]||0)+1; }
    if (off <= b.length - 4) {
      const f32be = b.readFloatBE(off);
      if (targets.some(t => Math.abs(f32be - t) < 1)) { const k = 'f32be'; encHits[k] = (encHits[k]||0)+1; }
    }
  }
}
console.log('\n目标金额编码命中:', JSON.stringify(encHits));