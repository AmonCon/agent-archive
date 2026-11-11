/**
 * 只读探针：旧 11 家「指定数据源」契约验证（解耦 P1）。
 *
 *   node research/probes/legacy-spec-probe.mjs
 *
 * 只在系统临时目录造合成样本，不碰本机真实数据、不改仓库里的任何文件。
 * 三组验证：
 *   ① 11 家各造一个最小应用根，传「父目录」给 scoreStructure/anchorOf，
 *      断言 score >= minScore、anchor 上溯到应用根、dirHintMatch=true，
 *      再调 discoverWithin(应用根) 断言显式源下真能扫出会话文件；
 *   ② 造一个 .claude 目录，先用「只有 codebuddy spec」复现改造前的抢走，
 *      再四家 spec 同场，断言唯一绑定 claude-code、ambiguous=0；
 *   ③ 造一个不在本机默认位置的假 zcode SQLite 库，断言
 *      parseAll(fakeFile, {}) 读出的是假库里的会话、不是本机库。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

import { scoreStructure, anchorOf } from '../../src/structure.js';
import { identify } from '../../src/source.js';
import * as claudeCode from '../../src/scanners/claude-code.js';
import * as workbuddy from '../../src/scanners/workbuddy.js';
import * as qoder from '../../src/scanners/qoder.js';
import * as zcode from '../../src/scanners/zcode.js';
import * as dsh from '../../src/scanners/dsh.js';
import * as hermes from '../../src/scanners/hermes.js';
import * as cursor from '../../src/scanners/cursor.js';
import * as opencode from '../../src/scanners/opencode.js';
import * as antigravity from '../../src/scanners/antigravity.js';
import * as kiro from '../../src/scanners/kiro.js';
import * as copilot from '../../src/scanners/copilot.js';
import * as codebuddy from '../../src/scanners/codebuddy.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-legacy-probe-'));
let passed = 0;
const ok = (label) => {
  passed++;
  console.log('  PASS ' + label);
};

function makeCase(tag, appRoot, files) {
  const caseDir = path.join(TMP, tag);
  const appDir = path.join(caseDir, appRoot);
  fs.mkdirSync(appDir, { recursive: true });
  for (const rel of files) {
    const full = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return { caseDir, appDir };
}

// appRoot = 应用根相对「父目录」的路径；files = 相对应用根的真实形状文件。
const CASES = [
  { name: 'claude-code', mod: claudeCode, appRoot: '.claude', files: ['projects/E--demo/aaaa.jsonl'] },
  { name: 'workbuddy', mod: workbuddy, appRoot: '.workbuddy', files: ['projects/ws/bbbb.jsonl'] },
  {
    name: 'qoder', mod: qoder, appRoot: '.qoder',
    files: [
      'projects/ws/11111111-1111-1111-1111-111111111111.jsonl',
      'cache/projects/proj-5e450c46/conversation-history/dddd/dddd.jsonl',
    ],
  },
  { name: 'zcode', mod: zcode, appRoot: '.zcode', files: ['cli/db/db.sqlite'] },
  { name: 'dsh', mod: dsh, appRoot: '.dsh', files: ['sessions/E--demo/sess/session.v4.jsonl'] },
  { name: 'hermes', mod: hermes, appRoot: '.hermes', files: ['state.db'] },
  { name: 'cursor', mod: cursor, appRoot: 'Cursor', files: ['User/globalStorage/state.vscdb'] },
  { name: 'opencode', mod: opencode, appRoot: 'opencode', files: ['opencode.db'] },
  {
    name: 'antigravity', mod: antigravity, appRoot: '.gemini/antigravity',
    files: ['conversation_summaries.db', 'brain/c1/.system_generated/logs/transcript_full.jsonl'],
  },
  {
    name: 'kiro', mod: kiro, appRoot: 'Kiro',
    files: [
      'User/globalStorage/kiro.kiroagent/sessions/eeee.json',
      'User/globalStorage/kiro.kiroagent/workspace-sessions/WS/sess1.json',
    ],
  },
  { name: 'copilot', mod: copilot, appRoot: 'Code', files: ['User/workspaceStorage/hash1/chatSessions/sess.json'] },
];

try {
  console.log('== ① 11 家 structureSpec 命中 / rootAnchor 上溯 / discoverWithin(应用根) ==');
  for (const c of CASES) {
    const spec = c.mod.structureSpec;
    assert.ok(spec && spec.agent === c.name, `${c.name} 缺 structureSpec 或 agent 名不对`);
    assert.equal(typeof c.mod.discoverWithin, 'function', `${c.name} 缺 discoverWithin`);
    const { caseDir, appDir } = makeCase('case-' + c.name, c.appRoot, c.files);

    // 传父目录：anchorOf 必须按 rootAnchor.up 上溯回应用根那一层
    const a = anchorOf(caseDir, spec);
    assert.equal(a, appDir, `${c.name} anchorOf 上溯错：${a}`);

    const r = scoreStructure(spec, caseDir);
    assert.ok(r.score >= spec.minScore, `${c.name} score ${r.score} < minScore ${spec.minScore}`);
    assert.equal(r.anchor, appDir, `${c.name} scoreStructure.anchor 错：${r.anchor}`);
    assert.equal(r.dirHintMatch, true, `${c.name} dirHintMatch 应为 true`);

    // 显式数据源：把识别出的应用根直接喂给 discoverWithin，必须扫出会话文件
    const files = c.mod.discoverWithin([appDir], {});
    assert.ok(Array.isArray(files) && files.length >= 1, `${c.name} discoverWithin(应用根) 没扫出文件`);

    ok(`${c.name.padEnd(12)} score=${r.score}/${spec.minScore}  anchor=${path.basename(appDir)}  dirHit=true  discoverWithin=${files.length} 个`);
  }

  console.log('== ② .claude 同构消歧（claude-code / codebuddy / workbuddy / qoder） ==');
  const dis = makeCase('disambig', '.claude', ['projects/E--demo/aaaa.jsonl']);
  // 对照：改造前注册表里只有 codebuddy 有 spec → .claude 会被它抢走
  const before = identify([dis.appDir], { specs: [codebuddy.structureSpec] });
  assert.equal(before.bindings.length, 1, '对照实验应有 1 个绑定');
  assert.equal(before.bindings[0].agent, 'codebuddy', '改造前 .claude 应被 codebuddy 抢走');
  ok('对照：仅 codebuddy spec 时 .claude → codebuddy（复现原 bug）');

  const after = identify([dis.appDir], {
    specs: [claudeCode.structureSpec, codebuddy.structureSpec, workbuddy.structureSpec, qoder.structureSpec],
  });
  assert.equal(after.bindings.length, 1, `.claude 应唯一命中，实际 ${after.bindings.length} 个`);
  assert.equal(after.bindings[0].agent, 'claude-code', '应绑定 claude-code');
  assert.equal(after.ambiguous.length, 0, 'dirHints 消歧后不应报 ambiguous');
  ok('四家 spec 同场 → 唯一绑定 claude-code，ambiguous=0（dirHints 生效）');

  // 真实注册表（21 家 structureSpec 全在）下也要唯一绑定，不能被别家抢或报歧义
  const real = identify([dis.appDir]);
  assert.equal(real.bindings.length, 1, `真实注册表下 .claude 应唯一命中，实际 ${real.bindings.length}`);
  assert.equal(real.bindings[0].agent, 'claude-code', '真实注册表下应绑定 claude-code');
  assert.equal(real.ambiguous.length, 0, '真实注册表下不应报 ambiguous');
  ok('真实注册表（21 家 spec）下 .claude → claude-code，ambiguous=0');

  console.log('== ③ 假 zcode 备份库：parseAll(file, ctx) 用传入 file 开连接 ==');
  const backupRoot = path.join(TMP, 'backup', '.zcode');
  const fakeFile = path.join(backupRoot, 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(fakeFile), { recursive: true });
  const db = new DatabaseSync(fakeFile);
  db.exec(`create table session (
    id text primary key, directory text, title text, title_source text,
    time_created integer, time_updated integer, parent_id text, time_deleted integer)`);
  // readMessages 会查 message/part 两表，造空表即可（不抛错、返回空正文）
  db.exec(`create table message (
    id integer primary key autoincrement, session_id text, sequence integer, data text)`);
  db.exec(`create table part (message_id integer, sequence integer, data text)`);
  db.prepare('insert into session values (?,?,?,?,?,?,?,?)').run(
    'FAKE-FROM-BACKUP', 'e:/backup-proj', '假库里的会话', 'user',
    1700000000000, 1700000060000, null, 0
  );
  db.close();

  const listed = zcode.discoverWithin([backupRoot], {});
  assert.deepEqual(listed, [fakeFile], 'discoverWithin(外部 .zcode) 应列出假库');
  ok('discoverWithin(外部应用根) → 假库路径');

  const sessions = zcode.parseAll(fakeFile, {});
  assert.equal(sessions.length, 1, `parseAll 应读出 1 场，实际 ${sessions.length}`);
  assert.equal(sessions[0].id, 'FAKE-FROM-BACKUP', 'parseAll 必须读假库，不是本机库');
  assert.equal(sessions[0].title, '假库里的会话');
  ok('parseAll(fakeFile, {}) → 读出假库会话 FAKE-FROM-BACKUP（没退回本机 dbPath）');

  const msgs = zcode.readMessages(sessions[0], {});
  assert.ok(Array.isArray(msgs), 'readMessages 应能按 source 里的库路径打开假库');
  ok('readMessages(session, {}) 按 source 的库路径打开，不抛错');

  console.log(`\n全部通过：${passed} 组断言`);
} finally {
  try { zcode.closeStore(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
