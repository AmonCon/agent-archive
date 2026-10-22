const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });

console.log('--- session: project_id / workspace_id / directory 分布 ---');
const rows = db.prepare(`
  select coalesce(project_id,'') as project_id,
         coalesce(workspace_id,'') as workspace_id,
         coalesce(directory,'') as directory,
         count(*) as n
  from session
  where coalesce(time_deleted,0)=0
  group by project_id, workspace_id, directory
  order by n desc
  limit 20
`).all();
for (const r of rows) {
  console.log(`${String(r.n).padStart(4)}  proj=${r.project_id.padEnd(28)} ws=${r.workspace_id.padEnd(10)} dir=${r.directory}`);
}

console.log('\n--- 本会话所在行 ---');
const cur = db.prepare(`select id, project_id, workspace_id, directory, path, title, time_created, time_updated from session where id = ?`)
  .get('session_a86a1a5ebc532b2c794603a236a40d79');
console.log(cur);

console.log('\n--- local_setting 里与会话/项目相关的键 ---');
for (const r of db.prepare(`select scope, scope_id, namespace, key, value from local_setting`).all()) {
  console.log(`${r.scope}/${r.scope_id || ''} ${r.namespace}/${r.key} = ${String(r.value).slice(0,120)}`);
}
