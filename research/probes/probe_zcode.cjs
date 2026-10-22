const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const db = new DatabaseSync(
  path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
  { readOnly: true }
);

const sid = process.argv[2];
if (!sid) {
  console.log('usage: node probe_zcode.cjs <session_id>');
  process.exit(1);
}

console.log('--- session row ---');
const s = db.prepare('select * from session where id = ?').get(sid);
console.log(JSON.stringify(s, null, 2).slice(0, 1500));

console.log('\n--- first 6 messages with parts ---');
const msgs = db
  .prepare('select id, sequence, data from message where session_id = ? order by sequence asc limit 6')
  .all(sid);
for (const m of msgs) {
  const d = JSON.parse(m.data);
  console.log(`\n[msg seq=${m.sequence}] id=${m.id}`);
  console.log('  role:', d.role, '| model:', JSON.stringify(d.model), '| agent:', d.agent);
  console.log('  time.created:', d.time && d.time.created, d.time && d.time.created ? new Date(d.time.created).toISOString() : '');
  const parts = db
    .prepare('select id, sequence, data from part where message_id = ? order by sequence asc limit 4')
    .all(m.id);
  for (const p of parts) {
    const pd = JSON.parse(p.data);
    console.log('    part type:', pd.type, '| text:', String(pd.text || '').slice(0, 90).replace(/\n/g, ' '));
  }
}

console.log('\n--- distinct roles ---');
const roles = db
  .prepare("select json_extract(data,'$.role') as role, count(*) c from message where session_id = ? group by role")
  .all(sid);
console.log(roles);

console.log('\n--- part types ---');
const ptypes = db
  .prepare(
    "select json_extract(p.data,'$.type') as t, count(*) c from part p join message m on m.id=p.message_id where m.session_id=? group by t order by c desc"
  )
  .all(sid);
console.log(ptypes);
