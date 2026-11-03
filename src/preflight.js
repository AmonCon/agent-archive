/**
 * 启动前的环境自检。
 *
 * ## 为什么需要
 *
 * 这个工具依赖三个**较新且仍在演进**的 Node 内建能力：
 *
 *   `node:sqlite` 的 DatabaseSync       Node 22.5 起（实验特性）
 *   `zlib.zstdDecompressSync`           Node 22.15 起
 *   SQLite 的 FTS5 全文检索扩展         Node 22.16 起（23.x 整条线没有）
 *
 * 最后一条是最容易漏的：`node:sqlite` 在 22.15 就能用，但它带的 SQLite
 * 没编译 FTS5，于是 `search` 和 `secrets` 会在建索引时抛
 * `no such module: fts5`——一个看不出「你的 Node 太旧」的错误。
 * 最低版本因此定在 22.16.0，而不是 `node:sqlite` 首次出现的 22.5。
 *
 * `package.json` 的 `engines` 只在 `npm install` 时提示一句，用户装完再跑
 * 照样会崩——而且崩的位置很深（某个 scanner 里一行 TypeError），
 * 看不出是"你的 Node 太旧"。
 *
 * 对开源项目来说这是最该先修的一类问题：第一个用户很可能就跑在老 Node 上，
 * 拿到的是一段看不懂的堆栈，然后放弃。
 *
 * 所以入口处显式检查，缺什么就直说缺什么、要升到哪个版本。
 */

import { createRequire } from 'node:module';

const MIN_NODE = '22.16.0';

/** 解析 "v22.15.1" / "v24.12.0" → 可比较的数字数组。 */
function versionParts(v) {
  return String(v)
    .replace(/^v/, '')
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
}

function lt(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

/**
 * 检查运行环境；不满足就打印一句能照着做的话并退出。
 *
 * 返回 `{ ok, problems }` 供测试断言，不直接 process.exit——这样用例可以
 * 在假环境里验证提示文案，而不必真的起一个老 Node。
 */
export function checkEnvironment({ nodeVersion = process.version, features } = {}) {
  const problems = [];

  if (lt(nodeVersion, MIN_NODE)) {
    problems.push(
      `Node 版本太低：当前 ${nodeVersion}，需要 ${MIN_NODE} 或更高。\n` +
        `   为什么：读取 .zst 压缩会话要用 zlib 的 zstd 支持（22.15 起），\n` +
        `   读取各家 SQLite 会话库要用 node:sqlite（22.5 起），\n` +
        `   全文搜索要用 node:sqlite 里的 FTS5 扩展（22.16 起）。`
    );
  }

  // 特性检查比版本号更可靠：某些发行版会裁剪内建模块，或者版本号对不上
  const f = features || detectFeatures();
  if (!f.zstd) {
    problems.push('当前 Node 没有 zlib.zstdDecompressSync：无法读取 .zst 压缩会话（Codex / DSH）。');
  }
  if (!f.sqlite) {
    problems.push('当前 Node 没有 node:sqlite 的 DatabaseSync：无法读取 Hermes / ZCode / OpenCode / Cursor 的会话库。');
  }
  // 单独查 FTS5：`node:sqlite` 存在不等于它带的 SQLite 编译了 FTS5 扩展。
  // 22.15 就是这种状态——模块能加载，建全文索引时才炸。
  // 只在 `node:sqlite` 本身存在时才报：缺模块的情况下再抱怨 fts5 只是噪音。
  if (f.sqlite && !f.fts5) {
    problems.push(
      '当前 Node 的 SQLite 没有 FTS5 全文检索扩展：全文搜索与凭证扫描用不了（`no such module: fts5`）。\n' +
        '   Node 22.16 起才有；23.x 整条线都没有，请用 22.16+ 或 24+。'
    );
  }

  return { ok: problems.length === 0, problems };
}

function detectFeatures() {
  // 用 createRequire 而不是静态 import：这里要的是"能不能加载"，
  // 加载失败要能捕获。静态 import 在老 Node 上是链接期错误，捕不到。
  let req;
  try {
    req = createRequire(import.meta.url);
  } catch {
    return { zstd: false, sqlite: false, fts5: false };
  }

  let zstd = false;
  let sqlite = false;
  let fts5 = false;
  try {
    zstd = typeof req('node:zlib').zstdDecompressSync === 'function';
  } catch {
    zstd = false;
  }
  try {
    sqlite = typeof req('node:sqlite').DatabaseSync === 'function';
  } catch {
    sqlite = false;
  }
  if (sqlite) {
    // 真的去建一张 fts5 虚拟表：这是「能不能搜」的唯一可靠判据。
    // 版本号查不出来——22.15 有 node:sqlite 却没有 FTS5。
    let db;
    try {
      const { DatabaseSync } = req('node:sqlite');
      db = new DatabaseSync(':memory:');
      db.exec('create virtual table probe using fts5(x)');
      fts5 = true;
    } catch {
      fts5 = false;
    } finally {
      try {
        db?.close();
      } catch {
        /* 已关闭 */
      }
    }
  }
  return { zstd, sqlite, fts5 };
}

/**
 * 入口调用：检查并通过则静默返回，否则打印并退出。
 *
 * 单独导出，CLI 和 MCP 都调它，保证两侧行为一致——MCP 被别的 Agent 拉起时
 * 如果静默崩掉，用户更难查。
 */
export function assertEnvironment() {
  const { ok, problems } = checkEnvironment();
  if (ok) return;
  process.stderr.write(
    'agent-archive 无法在当前 Node 上运行：\n' +
      problems.map((p) => `  · ${p}`).join('\n') +
      `\n\n升级到 Node ${MIN_NODE} 以上即可：https://nodejs.org/\n`
  );
  process.exit(1);
}
