import fs from 'node:fs';
import * as hermes from './scanners/hermes.js';

/**
 * 会话正文缓存（进程内，LRU）。
 *
 * ## 为什么需要
 *
 * 读一场大会话很贵：本机实测 Codex 的 89 MB `.zst` 读一次要 **1.1 秒**
 * （整文件解压 + 逐行 JSON 解析），而**读第二次仍然要 1 秒**——没有任何缓存。
 *
 * 这不是"偶尔慢一下"：网页每刷新一次读一次、`cat` 一次读一次、
 * `export --bundle` 把所有会话读一遍。用户在会话页上按 F5 就要等一秒。
 *
 * 索引那层本来就有缓存（按文件 mtime/size 复用解析结果），但那只服务
 * `index` 命令；`cat` / 网页 / 导出 / 摘要全都走 `readSessionContent`，
 * 每次重读。
 *
 * ## 做法与来源
 *
 * cc-switch 的 `TranscriptCache` 是同一个设计：按 (provider, sourcePath) 缓存，
 * 指纹用 (mtime, size)，LRU 同时按**条数**和**字节**双限。
 * 这里的差别只有指纹的取法——我们的 source 有四种形态
 * （单文件 / 多段 `a|b` / `path#id` / `db:id`），所以要一个能处理全部形态的
 * 取指纹函数。
 *
 * ## 边界
 *
 * - **只缓存"已解析好的消息数组"，不缓存原始字节**：多存一份原始文本没有意义，
 *   读取的瓶颈是解析。
 * - **共享引用，不深拷贝**：消息数组可能有几万个 part，克隆一次就抵消了缓存的
 *   意义。所以调用方**不得修改**返回的数组——现有调用方（export / digest /
 *   server / mcp / search）都只读。
 * - 指纹取不到（文件刚被删、stat 失败）就**不缓存**：宁可重读，也不能把
 *   过期内容当成新的。
 */

/** 最多缓存几场会话。8 场 × 最大几十 MB，内存可控。 */
const MAX_ENTRIES = 8;
/** 估算字节上限（按正文文本长度算，不含对象开销）。 */
const MAX_CHARS = 96 * 1024 * 1024;

/** key -> { chars, value }，Map 的插入顺序当 LRU 用。 */
const cache = new Map();
let totalChars = 0;

/**
 * 从 session.source 推出缓存指纹。
 *
 * 四种 source 形态都要处理：
 *   `/path/a.jsonl`               单文件
 *   `/path/a|/path/b`             Codex 续接会话的多段
 *   `/path/db.sqlite#session_x`   SQLite 源，'#' 之前是库
 *   `db:<session-id>`             Hermes 只记会话 id
 *
 * 指纹 = 所有相关文件的 (mtime, size)。任一变就视为不同内容。
 * 取不到就返回 null（不缓存）。
 */
export function stampOf(source) {
  if (!source) return null;
  const src = String(source);

  if (src.startsWith('db:')) {
    // Hermes：只能靠库文件本身。库一被写就会变，缓存命中率不高，
    // 但总比每次都整库重查好；而且它 250 MB，重查一次不便宜。
    const dbPath = hermesDbPath();
    if (!dbPath) return null;
    return fileStamp([dbPath, `${dbPath}-wal`]);
  }

  const files = src
    .split('|')
    .map((one) => one.split('#')[0])
    .filter(Boolean);
  if (!files.length) return null;
  return fileStamp(files);
}

function fileStamp(files) {
  const parts = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      parts.push(`${st.size}:${st.mtimeMs}`);
    } catch {
      // 附属文件（-wal）不存在很正常，记成 '-' 而不是失败
      if (f.endsWith('-wal')) {
        parts.push('-');
        continue;
      }
      return null; // 主文件都读不到，就别缓存了
    }
  }
  return parts.join('|');
}

/** 与 scanners/hermes.js 的 hermesDir() 保持同一套候选顺序。 */
function hermesDbPath() {
  // 复用扫描器自己的 discover()：它已经处理了 HERMES_HOME、
  // ~/.hermes、%LOCALAPPDATA%\hermes 三套候选。抄第二份必然漂。
  try {
    const found = hermes.discover();
    return found && found.length ? found[0] : null;
  } catch {
    return null;
  }
}

/** 估算一场会话占多少字符（只看文本 part，不深拷贝）。 */
function estimateChars(messages) {
  let n = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'text' || p.kind === 'reasoning') n += p.text ? p.text.length : 0;
      else if (p.kind === 'tool') n += p.output ? p.output.length : 0;
    }
  }
  return n;
}

/**
 * 取缓存；没有就调用 loader 并存入。
 *
 * @param {string} key 通常是 `agent|id`
 * @param {() => Promise<any>|any} loader 真正的读取函数
 * @param {object} session 用来算指纹（需要 source 字段）
 */
export async function getOrLoad(key, session, loader) {
  const stamp = stampOf(session && session.source);
  if (!stamp) {
    // 指纹都算不出来就别缓存——宁可慢，也不能把过期内容当新的
    return loader();
  }

  const fullKey = `${key}@${stamp}`;
  const hit = cache.get(fullKey);
  if (hit) {
    // 命中后移到队尾，表示"最近用过"
    cache.delete(fullKey);
    cache.set(fullKey, hit);
    return hit.value;
  }

  const value = await loader();
  const chars = estimateChars(value);

  // 单场就超过上限的直接不缓存（否则会把整个缓存挤空，还顶不住）
  if (chars <= MAX_CHARS) {
    cache.set(fullKey, { chars, value });
    totalChars += chars;
    evict();
  }
  return value;
}

function evict() {
  while (cache.size > MAX_ENTRIES || totalChars > MAX_CHARS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const rec = cache.get(oldest.value);
    totalChars -= rec.chars;
    cache.delete(oldest.value);
  }
}

/** 清空（测试用）。 */
export function clearTranscriptCache() {
  cache.clear();
  totalChars = 0;
}

/** 供测试断言。 */
export function cacheStats() {
  return { entries: cache.size, chars: totalChars };
}
