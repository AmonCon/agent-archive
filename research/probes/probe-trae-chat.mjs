import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const base = path.join(process.env.APPDATA, 'Trae', 'ModularData');

for (const sub of ['ai-chat', 'ai-agent']) {
  const file = path.join(base, sub, 'database.db');
  if (!fs.existsSync(file)) {
    console.log(`\n=== ${sub}: 不存在`);
    continue;
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${sub}  ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("select name from sqlite_master where type='table'")
      .all()
      .map((r) => r.name);
    console.log('表:', tables.join(', '));

    for (const t of tables) {
      const cnt = db.prepare(`select count(*) c from "${t}"`).get().c;
      const cols = db
        .prepare(`pragma table_info("${t}")`)
        .all()
        .map((c) => `${c.name}:${c.type}`);
      console.log(`\n  ${t}: ${cnt} 行`);
      console.log(`    ${cols.join(', ')}`);

      if (cnt > 0) {
        const row = db.prepare(`select * from "${t}" limit 1`).get();
        const brief = Object.entries(row).map(([k, v]) => {
          if (v == null) return `${k}=null`;
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${s.length > 80 ? s.slice(0, 80) + '…' : s}`;
        });
        console.log(`    样本: ${brief.join(' | ').slice(0, 500)}`);
      }
    }
  } finally {
    db.close();
  }
}
