import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, makeSqlite } from './helpers.js';

/**
 * `sqlite-read.js` 临时副本的生命周期。
 *
 * ## 这条为什么值得单独测
 *
 * 读 SQLite 时要把库复制到临时目录（只读打开 + 要读 `-wal`，直接开原库
 * 可能锁住或读到不一致快照）。副本用完得删，否则**每跑一次扫描就在系统
 * 临时目录里留一个目录**。
 *
 * 实测就是这个结果：`cleanupCopies()` 导出了、注释也写着"进程退出时清理"，
 * 但**没有任何地方调用它**。攒了 132 个 `agent-archive-sqlite-*` 目录。
 *
 * 这类 bug 的特征是：功能完全正常，只是把用户的磁盘慢慢填满。除了测试，
 * 没有别的办法发现它——所以下面两条分别盯"清理函数本身有效"和
 * "进程退出时真的会被调用"。
 */

const sqliteRead = await import('../src/sqlite-read.js');

test('sqlite-read: cleanupCopies 真的删掉临时副本目录', () => {
  const box = sandbox();
  try {
    const dbFile = box.path('state.db');
    makeSqlite(dbFile, (db) => {
      db.exec('create table t (x text)');
      db.prepare("insert into t values ('hello')").run();
    });

    // **必须造一个非空的 `-wal`**：`openReadOnly` 只在有 WAL 数据时才复制
    // （没有 WAL 时用 immutable 直读原库，零副作用，也不产生副本）。
    // 这条区分很重要——不造 WAL 的话测试会以为"没复制"是 bug。
    const wal = `${dbFile}-wal`;
    fs.writeFileSync(wal, Buffer.alloc(4096, 7));

    // 打开前先记下已有的同前缀目录，之后只认新增的
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const before = new Set(
      fs
        .readdirSync(tmpRoot)
        .filter((n) => n.startsWith('agent-archive-sqlite-'))
        .map((n) => path.join(tmpRoot, n))
    );

    const db = sqliteRead.openReadOnly(dbFile);
    assert.ok(db, '应该能打开');
    assert.ok(sqliteRead.copyCount() > 0, '有 WAL 时应该复制一份副本');

    // 必须先关掉句柄再清理：Windows 上打开的文件删不掉，`safeRm` 用
    // `force: true` 会把错误吞掉，表现为"清理了但目录还在"。
    db.close();

    // 找到**本次**产生的副本目录。
    //
    // 判定用"打开前不存在"这个集合差，而不是"临时目录里所有同前缀目录"：
    // 之前跑崩的进程可能留下残留，把别人的目录算进来会让断言时红时绿。
    // （实测踩过：一条历史残留让这条用例在干净机器上绿、在有残留的机器上红。）
    const allCopies = () =>
      fs
        .readdirSync(tmpRoot)
        .filter((n) => n.startsWith('agent-archive-sqlite-'))
        .map((n) => path.join(tmpRoot, n));
    const mine = allCopies().filter((d) => !before.has(d));
    assert.ok(mine.length > 0, '临时目录里应该有本次产生的副本');

    sqliteRead.cleanupCopies();
    assert.equal(sqliteRead.copyCount(), 0, '清理后缓存计数应归零');

    const stillThere = mine.filter((d) => fs.existsSync(d));
    assert.deepEqual(stillThere, [], `清理后不该还有副本目录：${stillThere.join(', ')}`);
  } finally {
    box.cleanup();
  }
});

test('sqlite-read: 进程退出时自动清理（不需要调用方记得调）', () => {
  // 这条是本轮 bug 的直接回归：`cleanupCopies()` 曾经导出了却没人调用。
  // 现在它在模块加载时自己挂 `process.exit` 钩子，所以只要子进程正常退出，
  // 副本就该没了。
  const box = sandbox();
  try {
    const dbFile = box.path('state.db');
    makeSqlite(dbFile, (db) => {
      db.exec('create table t (x text)');
      db.prepare("insert into t values ('x')").run();
    });

    const tmpRoot = fs.realpathSync(os.tmpdir());
    const listCopies = () =>
      new Set(
        fs.readdirSync(tmpRoot).filter((n) => n.startsWith('agent-archive-sqlite-'))
      );
    const before = listCopies();

    // 子进程：打开库、**故意不调 cleanupCopies**，然后正常退出
    const script = `
      import { openReadOnly } from ${JSON.stringify(
        new URL('../src/sqlite-read.js', import.meta.url).href
      )};
      const db = openReadOnly(${JSON.stringify(dbFile)});
      if (!db) { console.error('打不开'); process.exit(2); }
      console.log('opened');
    `;
    const scriptFile = box.path('child.mjs');
    fs.writeFileSync(scriptFile, script, 'utf8');

    const r = spawnSync(process.execPath, ['--no-warnings', scriptFile], {
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(r.status, 0, `子进程应该正常退出：${r.stderr || ''}`);

    const leaked = [...listCopies()].filter((n) => !before.has(n));
    assert.deepEqual(
      leaked,
      [],
      `进程退出后不该留下副本，实际留下：${leaked.join(', ')}`
    );
  } finally {
    box.cleanup();
  }
});
