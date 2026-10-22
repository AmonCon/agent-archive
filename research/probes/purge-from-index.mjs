import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/**
 * 从全文索引里剔除含指定字符串的会话。
 *
 * 只动索引，不碰任何 Agent 的原始数据——那些是用户的历史记录，
 * 删掉就不可恢复，而且旧 key 已经失效，留着也只是垃圾文本。
 *
 * 用法: node purge-from-index.mjs <要剔除的字符串> [--dry-run]
 */

const needle = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!needle || needle.length < 8) {
  console.error('用法: node purge-from-index.mjs <字符串> [--dry-run]');
  process.exit(2);
}

const file = path.join(os.homedir(), '.agent-archive', 'index', 'fulltext-v1.sqlite');
if (!fs.existsSync(file)) {
  console.error('索引不存在:', file);
  process.exit(2);
}

const db = new DatabaseSync(file);
db.prepare('pragma busy_timeout = 5000').run();

// 找命中
const hits = db
  .prepare('select key, agent, title, chars from doc where instr(body, ?) > 0')
  .all(needle);

console.log(`索引里含该字符串的会话: ${hits.length} 场\n`);
for (const h of hits) {
  console.log(`  [${h.agent}] ${String(h.title || '').slice(0, 60)}`);
  console.log(`    ${h.key}  (${h.chars} 字)`);
}

if (!hits.length) {
  console.log('\n无需处理');
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log('\n[预演] 未做任何修改');
  db.close();
  process.exit(0);
}

// 从索引中剔除：把正文摘要成一段说明，保留会话条目（时间线仍能看到它）
const stamp = new Date().toISOString();
const note =
  `[已剔除] 这场会话的正文含敏感凭证，${stamp} 时从全文索引移除。` +
  '原始记录仍在对应 Agent 的存储里，可用 agent-archive cat 查看。';

const begin = db.prepare('begin');
const commit = db.prepare('commit');
const upd = db.prepare('update doc set body = ?, fts_text = ?, chars = ? where key = ?');

begin.run();
let n = 0;
for (const h of hits) {
  upd.run(note, note, note.length, h.key);
  n++;
}
commit.run();

// FTS 是挂在 doc 上的外部内容表，改完 doc 要重建倒排
db.prepare("insert into doc_fts(doc_fts) values('rebuild')").run();

db.close();
console.log(`\n已剔除 ${n} 场会话的正文（条目保留，时间线仍可见）`);
console.log('倒排索引已重建');
