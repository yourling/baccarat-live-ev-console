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
  if (buf.length >= 12) frames.push(buf);
}

// TLV 遍历 P001BAC:从桌台码后开始,尝试 [tag][len][value] 与定长两种解释
const bac = frames.filter(b => b.toString('latin1').includes('P001BAC'));
const f = bac[bac.length - 1];
console.log('=== P001BAC 最后帧 TLV 遍历 ===');
let off = 12 + 7 + 2; // 跳过头+桌台码+00 00
while (off + 2 <= f.length) {
  const tag = f[off];
  const len = f[off + 1];
  if (off + 2 + len > f.length) { console.log('  越界 @', off, 'tag', tag.toString(16)); break; }
  const val = f.subarray(off + 2, off + 2 + len);
  let desc = val.toString('hex').slice(0, 32);
  if (len === 8 && val[0] === 0x40) desc += ' | double=' + val.readDoubleBE(0);
  if (len <= 4) desc += ' | u32=' + (len === 4 ? val.readUInt32BE(0) : len === 2 ? val.readUInt16BE(0) : val[0]);
  console.log('  tag 0x' + tag.toString(16).padStart(2,'0'), 'len', len, ':', desc);
  off += 2 + len;
}

// G 串全量:数字部分与尾缀分离,看数字是否随时间递增
const gstrs = [];
for (const b of frames) {
  const s = b.toString('latin1');
  const re = /G[NPD]\d{3}2682\d[\x20-\x7e]*/g; let m;
  while ((m = re.exec(s)) !== null) gstrs.push(m[0].split('"')[0]);
}
const uniq = [...new Set(gstrs)];
console.log('\n=== G 串去重总数:', uniq.length, '===');
const byNum = {};
for (const g of uniq) { const num = (g.match(/2682(\d)/) || [])[1] || '?'; (byNum[num] = byNum[num] || []).push(g); }
for (const k of Object.keys(byNum)) console.log('  尾数字 ' + k + ':', byNum[k].length, '条, 例:', byNum[k].slice(0, 3).join(', '));

// 尾缀字符频率分析(结果编码猜解)
const suffixCount = {};
for (const g of uniq) {
  const m = g.match(/2682\d(.*)$/);
  const suffix = m ? m[1] : '';
  suffixCount[suffix] = (suffixCount[suffix] || 0) + 1;
}
console.log('\n=== 尾缀分布(前 20)===' );
for (const [s, c] of Object.entries(suffixCount).sort((a,b)=>b[1]-a[1]).slice(0, 20)) console.log('  "' + s + '":', c);