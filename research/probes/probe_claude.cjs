const fs = require('node:fs');

const file = process.argv[2];
const limit = Number(process.argv[3] || 400);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
console.log('total lines:', lines.length);

const types = new Map();
let shown = 0;
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const t = o.type || (o.message && o.message.role) || 'unknown';
  types.set(t, (types.get(t) || 0) + 1);

  // Show first real user text and first assistant text
  const role = o.message && o.message.role;
  if (!role) continue;
  const c = o.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
  }
  if (!text) continue;
  if (text.startsWith('<local-command') || text.startsWith('<command-')) continue;
  if (o.isMeta) continue;
  if (shown >= limit) continue;

  const keys = Object.keys(o).join(',');
  console.log(`\n--- [${t}] ${role} keys=${keys}`);
  console.log('  text:', text.slice(0, 200).replace(/\n/g, ' ⏎ '));
  console.log('  ts:', o.timestamp, ' cwd:', o.cwd || '(none)', ' sidechain:', o.isSidechain);
  shown++;
  if (shown >= 6) break;
}

console.log('\n=== type counts ===');
for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  ${k}`);
