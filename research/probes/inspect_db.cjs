const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
console.log('DB:', dbPath, fs.statSync(dbPath).size);
const db = new DatabaseSync(dbPath, { readOnly: true });
const objs = db.prepare("select type,name,sql from sqlite_master where type in ('table','view','index') order by type,name").all();
for (const o of objs) {
  console.log('\n===', o.type, o.name);
  if (o.sql) console.log(o.sql.slice(0, 900));
  if (o.type === 'table') {
    try {
      const c = db.prepare(`select count(*) as c from "${o.name}"`).get();
      console.log('rows =', c.c);
    } catch (e) { console.log('count err', e.message); }
  }
}
