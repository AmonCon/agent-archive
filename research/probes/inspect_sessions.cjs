const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const db = new DatabaseSync(path.join(os.homedir(), '.cc-switch', 'cc-switch.db'), { readOnly: true });
const rows = db.prepare('select file_path, cast(last_modified as text) as lm, cast(last_synced_at as text) as ls from session_log_sync').all();
console.log('total', rows.length);

const KNOWN = ['.claude','.codex','.gemini','.zcode','.cursor','.trae','.trae-cn','.qoder','.qoder-cn','.qwen-agent','.workbuddy','.codebuddy','.copilot','.hermes','.pi','.mcode','.grok','.opencode','.commandcode','.devin','.kiro','.cline','.augment','.qoderwork','.qoderworkcn','.qwenworkcn','.dws','.marvis','.doubao','.cascade','.antigravity','.local'];
function keyOf(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  for (let i = 0; i < parts.length; i++) {
    if (KNOWN.includes(parts[i])) return parts.slice(i, i + 2).join('/');
  }
  return parts.slice(0, 2).join('/');
}
const counts = new Map();
for (const r of rows) counts.set(keyOf(r.file_path), (counts.get(keyOf(r.file_path)) || 0) + 1);
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);

const ts = (s) => new Date(Number(BigInt(s) / 1000000n)).toISOString();
console.log('\n--- newest 10 ---');
const sorted = rows.slice().sort((a, b) => Number(BigInt(b.ls) - BigInt(a.ls)));
for (const r of sorted.slice(0, 10)) console.log(ts(r.ls), r.file_path);
