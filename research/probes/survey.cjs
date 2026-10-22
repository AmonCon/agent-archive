const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const home = os.homedir();
const targets = {
  'Claude Code (.claude/projects)': path.join(home, '.claude', 'projects'),
  'Codex (.codex/sessions+archived)': path.join(home, '.codex', 'sessions'),
  'Codex archived': path.join(home, '.codex', 'archived_sessions'),
  'ZCode (.zcode/cli/db)': path.join(home, '.zcode', 'cli', 'db'),
  'Qoder CN (.qoder-cn/projects)': path.join(home, '.qoder-cn', 'projects'),
  'Qoder (.qoder)': path.join(home, '.qoder'),
  'OpenCode (.local/share/opencode)': path.join(home, '.local', 'share', 'opencode'),
  'Hermes (.hermes)': path.join(home, '.hermes'),
  'DeepSeekHarness': path.join(home, 'DeepSeekHarness', 'sessions'),
  'Trae CN (.trae-cn)': path.join(home, '.trae-cn'),
  'WorkBuddy (.workbuddy)': path.join(home, '.workbuddy'),
  'CodeBuddy (.codebuddy)': path.join(home, '.codebuddy'),
  'Cline (.cline)': path.join(home, '.cline'),
  'Cursor (.cursor)': path.join(home, '.cursor'),
  'Grok (.grok)': path.join(home, '.grok'),
};

function walk(p, st) {
  let out = { files: 0, bytes: 0 };
  if (!fs.existsSync(p)) return out;
  let stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          const s = fs.statSync(full);
          out.files++;
          out.bytes += s.size;
          if (/\.(jsonl|json|db|sqlite|zst|zstd)$/i.test(e.name)) {
            st.count++;
          }
        }
      } catch {}
    }
  }
  return out;
}

const rows = [];
for (const [name, p] of Object.entries(targets)) {
  const st = { count: 0 };
  const r = walk(p, st);
  rows.push({ name, exists: fs.existsSync(p), files: r.files, mb: (r.bytes / 1048576).toFixed(1), sessionFiles: st.count });
}
rows.sort((a, b) => parseFloat(b.mb) - parseFloat(a.mb));
for (const r of rows) {
  console.log(`${String(r.mb).padStart(8)} MB  ${String(r.files).padStart(6)} files  ${String(r.sessionFiles).padStart(5)}  ${r.exists ? '' : '[MISSING] '}${r.name}`);
}
