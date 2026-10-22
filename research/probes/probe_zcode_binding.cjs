const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });

console.log('=== 所有含 project 的表 ===');
const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
for (const t of tables) {
  const cols = db.prepare(`pragma table_info("${t}")`).all().map((c) => c.name);
  const hit = cols.filter((c) => /project/i.test(c));
  if (hit.length) console.log(`  ${t}: ${hit.join(', ')}`);
}

console.log('\n=== session_entry 结构 ===');
for (const c of db.prepare('pragma table_info(session_entry)').all()) {
  console.log(`  ${c.name}  ${c.type}`);
}

console.log('\n=== session_entry 里的 type 分布 ===');
for (const r of db.prepare('select type, count(*) n from session_entry group by type order by n desc limit 15').all()) {
  console.log(`  ${String(r.n).padStart(5)}  ${r.type}`);
}

console.log('\n=== 本会话的 session_entry ===');
for (const r of db.prepare("select id, type, substr(data,1,200) as d from session_entry where session_id = ?").all('session_a86a1a5ebc532b2c794603a236a40d79')) {
  console.log(`  [${r.type}] ${r.d}`);
}

console.log('\n=== 是否有单独的项目表 ===');
for (const t of tables) {
  if (/project/i.test(t)) console.log('  table:', t);
}

console.log('\n=== session 行的 workspace_id 是否有非空的 ===');
const ws = db.prepare('select count(*) n from session where workspace_id is not null and coalesce(time_deleted,0)=0').get();
console.log('  workspace_id 非空:', ws.n);
