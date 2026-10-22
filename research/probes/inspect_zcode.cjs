const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
console.log('DB', dbPath, (fs.statSync(dbPath).size / 1e6).toFixed(1) + ' MB');
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name);
console.log('tables:', tables.join(', '));

for (const t of tables) {
  try {
    const c = db.prepare(`select count(*) as c from "${t}"`).get().c;
    const cols = db.prepare(`pragma table_info("${t}")`).all().map((r) => r.name).join(',');
    console.log(`\n[${t}] rows=${c}\n  cols: ${cols}`);
  } catch (e) {
    console.log(`\n[${t}] err ${e.message}`);
  }
}

console.log('\n--- 5 newest sessions ---');
const rows = db.prepare('select id, title, directory, time_created, time_updated from session order by time_updated desc limit 5').all();
for (const r of rows) console.log(new Date(Number(r.time_updated)).toISOString(), '|', r.directory, '|', String(r.title).slice(0, 40));

console.log('\n--- one message sample ---');
const m = db.prepare('select * from message limit 1').all();
console.log(JSON.stringify(m).slice(0, 1200));
