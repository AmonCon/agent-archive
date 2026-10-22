const fs = require('node:fs');
const zlib = require('node:zlib');

function readMaybeZst(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.zst')) return zlib.zstdDecompressSync(buf).toString('utf8');
  return buf.toString('utf8');
}

const file = process.argv[2];
const text = readMaybeZst(file);
const lines = text.split('\n').filter(Boolean);
console.log('file:', file);
console.log('total lines:', lines.length);

const types = new Map();
let shown = 0;
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const t = o.type || 'unknown';
  types.set(t, (types.get(t) || 0) + 1);

  if (shown < 8) {
    console.log(`\n--- [${t}] keys=${Object.keys(o).join(',')}`);
    const payload = o.payload || {};
    console.log('  payload.type:', payload.type, '| payload keys:', Object.keys(payload).slice(0, 10).join(','));
    const preview = JSON.stringify(payload).slice(0, 260);
    console.log('  ', preview);
    if (o.timestamp) console.log('  ts:', o.timestamp);
    shown++;
  }
}

console.log('\n=== type counts ===');
for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  ${k}`);
