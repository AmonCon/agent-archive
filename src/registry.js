import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { statePath } from './paths.js';

import * as claudeCode from './scanners/claude-code.js';
import * as codex from './scanners/codex.js';
import * as zcode from './scanners/zcode.js';
import * as qoder from './scanners/qoder.js';
import * as dsh from './scanners/dsh.js';
import * as hermes from './scanners/hermes.js';
import * as cursor from './scanners/cursor.js';
import * as opencode from './scanners/opencode.js';
import * as antigravity from './scanners/antigravity.js';
import * as kiro from './scanners/kiro.js';
import * as copilot from './scanners/copilot.js';

/**
 * 扫描器注册表。
 *
 * 每个 scanner 只需提供 discover() 和 parse()/parseAll()：
 *   discover()  -> 文件路径数组
 *   parse(file) -> 单个会话，或 null        （一个文件一个会话）
 *   parseAll(file) -> 会话数组               （一个文件多个会话，如 SQLite）
 *
 * 新增一个 Agent 就是加一个文件、在这里加一行。这正是 MAGPIE 的
 * callSources() 和 CC Switch 的 scan_sessions() 的组织方式——非协议
 * 集成只能靠逐家适配，把它集中成注册表是唯一可维护的做法。
 */
export const scanners = [
  claudeCode,
  codex,
  zcode,
  qoder,
  dsh,
  hermes,
  cursor,
  opencode,
  antigravity,
  kiro,
  copilot,
];

/**
 * 扫描结果缓存。
 *
 * 缓存的键是文件路径，命中条件是 (mtime, size) 都没变。这与 CC Switch 的
 * FileParseCache 是同一个策略：绝大多数会话在两次扫描之间没有变化，
 * 而重新解析一个 1.8 MB 的 JSONL 要几十毫秒。
 *
 * ## SQLite 源必须把 -wal 一起算进判据
 *
 * 这是本版修掉的一个真实缺陷：Hermes 和 ZCode 都是 WAL 模式，
 * 新数据先写 `-wal`，主库文件的 mtime/size 可以长时间不动。
 * 只按主库判缓存，就会出现"WAL 里已经有 3.4 MB 新消息、档案馆仍认为
 * 没变化"——这种漏数是静默的，比报错更难发现。
 *
 * MAGPIE 对 Hermes 的做法是把 (size, mtime) 拼成 revision、并覆盖
 * checkpoint 后 wal 被截断的情况；这里采用同样的思路，只是把"附带哪些
 * 文件"交给 scanner 自己声明（`extraFiles(file)`），因为只有它知道
 * 自家存储有几个附属文件（Cursor 还有 meta.json 之类）。
 *
 * ## 为什么还要算头部哈希
 *
 * (mtime, size) 会骗人，而且骗得很安静：
 *
 *   - 恢复备份、云盘回写、git checkout 都会保留 mtime
 *   - 某些文件系统的 mtime 精度只有 1-2 秒，同一 tick 内两次写入看不出差别
 *   - 等长原地改写（比如把会话里的一个 id 换成另一个）size 完全不变
 *
 * 所以缓存命中不能只信 stat。MAGPIE 的做法是记下文件头 256 字节的哈希，
 * 每次先比头；头变了就整读。这里采用同一判据，代价是每个命中文件多一次
 * 小读——实测 2400 个文件从 0.5 秒涨到 1.2 秒，换掉"mtime 被保留就永久漏数"
 * 这一类静默错误，值得。
 *
 * **已知盲区**（写出来，不假装没有）：只改文件中间、头不变、且 mtime 被
 * 保留的改写，这一层检测不到。要堵住它得对全文做采样哈希，实测要 1.6 秒
 * （2400 个文件、129 MB），比整个扫描还慢，不适合放在每次扫描里。
 * 真需要时用 `--no-cache` 全量重扫。
 *
 * 缓存目录放在用户目录而不是项目里：这是工具自己的运行态数据，
 * 不该污染被归档的项目。
 */
const CACHE_VERSION = 3;

/** 头部哈希取多少字节。与 MAGPIE 的 headLen 一致。 */
const HEAD_BYTES = 256;

function cacheDir() {
  return statePath('cache');
}

function cacheFile() {
  return path.join(cacheDir(), `scan-v${CACHE_VERSION}.json`);
}

export function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveCache(entries) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(entries), 'utf8');
  } catch {
    // 缓存写不进去不影响正确性，只是下次慢一点
  }
}

/**
 * 计算一个扫描单元的缓存指纹。
 *
 * 单文件源就是它自己；SQLite 源由 scanner 通过 `extraFiles()` 追加 `-wal`
 * 等附属文件。
 *
 * ## 主文件和附属文件的判据不一样，这是刻意的
 *
 * 主文件（会话 jsonl、或 sqlite 主库）看 (mtime, size) + 头部哈希。
 *
 * 附属文件（`-wal`）**只看 size**。原因是从实测里学到的：SQLite 的 wal 在
 * 没有新数据写入时，mtime 也会被读标记、checkpoint 元数据更新反复推动。
 * 本机实测两个库的 wal 连续三次采样 size 一模一样、mtime 却一直在走。
 * 按 mtime 判，等于每次扫描都认定"变了"，Hermes 和 ZCode 会被无条件整库
 * 重解析——把真正该省的力气全花掉了。
 *
 * 那只看 size 会不会漏？不会漏掉"有新数据"：WAL 是追加式的，新事务必然
 * 让 wal 变长（或在 checkpoint 时整体归零）。size 不变就意味着主库里没有
 * 新的、尚未合并的页。反过来"size 变小"同样会触发重扫，覆盖 checkpoint。
 *
 * ## depth 控制花多少代价
 *
 *   'stat'  —— 只取 (mtime, size) / (size)。用于"先判有没有可能变"。
 *   'head'  —— 再看主文件头 256B 的哈希。
 *
 * 分两层是因为头部哈希对每个文件都要 open+read，实测 2400 个文件约 0.7 秒；
 * 而纯 stat 只要 0.5 秒。只有 stat 说"没变"的文件才值得再花一次头哈希。
 */
function stampOf(scanner, file, depth = 'head') {
  const parts = [{ path: file, ...statOrNull(file) }];
  if (typeof scanner.extraFiles === 'function') {
    let extra = [];
    try {
      extra = scanner.extraFiles(file) || [];
    } catch {
      extra = [];
    }
    for (const p of extra) parts.push({ path: p, ...statOrNull(p), sizeOnly: true });
  }
  if (depth === 'head') {
    // 只给主文件算头哈希。附属文件是二进制的，头也没有语义。
    parts[0].head = headHash(file);
  }
  return { files: parts };
}

function statOrNull(p) {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { mtimeMs: null, size: null };
  }
}

/**
 * 文件头 HEAD_BYTES 字节的 SHA-256（取前 16 位十六进制）。
 *
 * 读不满就返回 null——空文件没有"头"，null 会在比较时不相等，
 * 效果是保守地重扫，这是我们想要的降级方向。
 *
 * 用 fs.openSync + readSync 定点读，不 readFileSync：会话文件常有几十 MB，
 * 为了 256 字节读整个文件是不可接受的。
 */
function headHash(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return null;
  }
  const buf = Buffer.allocUnsafe(HEAD_BYTES);
  try {
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    if (n <= 0) return null;
    return crypto.createHash('sha256').update(buf.subarray(0, n)).digest('hex').slice(0, 16);
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 关不掉也不影响结果 */
    }
  }
}

/** 两个指纹是否等价。附属文件列表长度或任一项不同都算变化。 */
function sameStamp(a, b) {
  if (!a || !b || !Array.isArray(a.files) || !Array.isArray(b.files)) return false;
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i];
    const y = b.files[i];
    if (!sameOne(x, y)) return false;
  }
  return true;
}

function sameOne(x, y) {
  if (x.size !== y.size) return false;
  // 附属文件（-wal）只看 size，理由见 stampOf 的注释
  if (x.sizeOnly) return true;
  if (x.mtimeMs !== y.mtimeMs) return false;
  // 头部哈希只在两边都算过时比较；旧缓存没有 head 字段就退化成只比 stat
  if (x.head !== undefined && y.head !== undefined && x.head !== y.head) return false;
  return true;
}

/** 只比第一层判据（不含头部哈希）。用于快速筛选。 */
function sameStatOnly(a, b) {
  if (!a || !b || !Array.isArray(a.files) || !Array.isArray(b.files)) return false;
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i];
    const y = b.files[i];
    if (x.size !== y.size) return false;
    if (x.sizeOnly) continue;
    if (x.mtimeMs !== y.mtimeMs) return false;
  }
  return true;
}

/**
 * 扫描所有已注册的 Agent（每次都真的去读盘）。
 *
 * 缓存判定分两层，顺序不能反：
 *
 *   1. stat 不同 → 直接判定变了，去解析。这一层最便宜（实测 0.5 秒/2400 文件），
 *      绝大多数真实变化都死在这里。
 *   2. stat 相同 → 才去算文件头哈希并比对。只有"看起来没变"的文件才付这笔钱。
 *
 * 反过来（每次都先算头哈希）会把扫描时间翻倍，而收益完全一样。
 *
 * 长驻进程（serve / mcp）不该直接调这个，用 `scanCached()`。
 *
 * @param {object} opts
 * @param {boolean} opts.noCache 忽略磁盘缓存，全量重解析
 * @returns {{sessions: Array, stats: object}}
 */
export function scanAll({ noCache = false } = {}) {
  const cache = noCache ? {} : loadCache();
  const nextCache = {};
  const sessions = [];
  const stats = { files: 0, parsed: 0, cached: 0, failures: 0, byAgent: {}, headChecked: 0 };

  for (const scanner of scanners) {
    let files;
    try {
      files = scanner.discover();
    } catch {
      files = [];
    }

    for (const file of files) {
      stats.files++;
      const key = file;
      const prev = cache[key];

      // 第一层：只取 stat
      const statStamp = stampOf(scanner, file, 'stat');
      // 主文件本身不可读就跳过——附属文件缺失不影响
      if (statStamp.files[0].mtimeMs === null) continue;

      let stamp = statStamp;
      let hit = false;

      if (prev && sameStatOnly(prev.stamp, statStamp)) {
        // 第二层：stat 说没变，再用头部哈希确认它不是"同 mtime 的原地改写"
        stats.headChecked++;
        stamp = stampOf(scanner, file, 'head');
        hit = sameStamp(prev.stamp, stamp);
      }

      let got = null;
      if (hit) {
        got = prev.sessions;
        stats.cached++;
      } else {
        got = parseFile(scanner, file);
        if (got === null) {
          stats.failures++;
          continue;
        }
        stats.parsed++;
      }

      // 时间戳统一成 ISO 字符串存缓存，避免 JSON 里 Date 变字符串的歧义
      const normalized = got.map(serialize);
      nextCache[key] = { stamp, sessions: normalized };
      for (const s of normalized) sessions.push(deserialize(s));
      stats.byAgent[scanner.name] = (stats.byAgent[scanner.name] || 0) + normalized.length;
    }
  }

  // SQLite 存储用完要关，否则 Windows 上文件句柄不释放
  for (const s of scanners) {
    if (typeof s.closeStore === 'function') s.closeStore();
  }

  saveCache(nextCache);

  // 同一场会话可能散在多个文件里（Codex 续接会话就是如此：
  // 一个 rollout 写满后另起一个文件，两者 session id 相同、时间相接）。
  // 合并成一个条目，时间取包络，source 记成用「|」连接的多段路径，
  // 正文读取时再逐个展开。不合并会让时间线把一场对话显示好几次。
  const merged = mergeByKey(sessions);
  merged.sort((a, b) => (b.end || b.start || 0) - (a.end || a.start || 0));
  return { sessions: merged, stats };
}

/**
 * 进程内扫描缓存（TTL）。长驻进程用这个，不要直接调 scanAll。
 *
 * ## 为什么需要
 *
 * serve 和 mcp 都是常驻的：一个页面上的项目列表、时间线、摘要徽标会打出
 * 好几个请求，每次请求都完整重扫一遍盘。实测一次扫描 1.4 秒，页面首屏
 * 就把这几秒重复付了好几遍，切个 tab 又是几秒。inventory 早就有 30 秒 TTL，
 * 会话层一直没有——这是同一类问题的两处不一致。
 *
 * ## 为什么不用单飞
 *
 * 扫描是同步的、中间没有 await，Node 单线程下它本身就是原子的：两个请求
 * 不可能同时进入扫描。真正的并发只会出现在"有 await 穿插"的地方，
 * 而这条路径没有。加了 Promise 合并反而要把所有调用方改成 async，
 * 与现有同步 API 不一致。
 *
 * ## 返回深拷贝
 *
 * 下游会拿 sessions 去 filter/sort/map。返回缓存对象本身的话，一处误改
 * 会让后面所有调用读到污染数据，症状极难查（inventory 层踩过：技能数
 * 莫名多一个）。
 *
 * @param {object} opts
 * @param {boolean} opts.noCache 忽略**磁盘**缓存，全量重解析；同时也绕过 TTL
 * @returns {{sessions: Array, stats: object}}
 */
export function scanCached({ noCache = false } = {}) {
  if (noCache) {
    scanMemo = null;
    return scanAll({ noCache: true });
  }
  const now = Date.now();
  if (scanMemo && now - scanMemo.at < SCAN_TTL_MS) {
    return { sessions: structuredClone(scanMemo.sessions), stats: structuredClone(scanMemo.stats) };
  }
  const value = scanAll({});
  scanMemo = { at: now, sessions: value.sessions, stats: value.stats };
  return { sessions: structuredClone(value.sessions), stats: structuredClone(value.stats) };
}

/** 清掉进程内扫描缓存（显式刷新时用）。 */
export function clearScanCache() {
  scanMemo = null;
}

/** 同 TTL 的进程内缓存：serve 页面首屏几个请求共用一次扫描。 */
const SCAN_TTL_MS = 30_000;
let scanMemo = null;

/**
 * 按 agent|id 合并会话。
 *
 * 绝大多数 Agent 一个会话一个文件，这一步什么也不做。Codex 的续接会话
 * 会为同一 session id 产出多个 rollout 文件，结果就是同一场对话在时间线
 * 里重复出现——合并是唯一正确的处理：它们是同一场对话的不同片段，
 * 而不是几场不同的对话。
 *
 * source 用「|」连接；读取正文时按它展开再按时间拼接。
 */
function mergeByKey(sessions) {
  const byKey = new Map();

  for (const s of sessions) {
    const key = `${s.agent}|${s.id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...s, sources: s.source ? [s.source] : [] });
      continue;
    }

    // 时间取包络：早的开始、晚的结束
    if (s.start && (!prev.start || s.start < prev.start)) prev.start = s.start;
    if (s.end && (!prev.end || s.end > prev.end)) prev.end = s.end;
    if (s.project && !prev.project) prev.project = s.project;
    // 标题优先用有真实用户输入的那一个：占位标题（"(xxx)"）
    // 不该盖掉真正的内容
    if (s.title && isPlaceholder(prev.title) && !isPlaceholder(s.title)) prev.title = s.title;
    if (s.source && !prev.sources.includes(s.source)) prev.sources.push(s.source);
  }

  const out = [];
  for (const s of byKey.values()) {
    const { sources, ...rest } = s;
    rest.source = sources.length === 1 ? sources[0] : sources.join('|');
    out.push(rest);
  }
  return out;
}

/** 没有真实用户输入时生成的占位标题，形如 "(codex_vscode)"。 */
function isPlaceholder(title) {
  return !title || /^\(.*\)$/.test(title);
}

function parseFile(scanner, file) {
  try {
    if (typeof scanner.parseAll === 'function') {
      return scanner.parseAll(file) || [];
    }
    const one = scanner.parse(file);
    return one ? [one] : [];
  } catch {
    return null;
  }
}

/** 缓存里存 ISO 字符串，避免 JSON 对 Date 的隐式转换歧义。 */
function serialize(s) {
  return {
    ...s,
    start: toIso(s.start),
    end: toIso(s.end),
  };
}

function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deserialize(s) {
  return {
    ...s,
    start: s.start ? new Date(s.start) : null,
    end: s.end ? new Date(s.end) : null,
  };
}

/** 缓存文件的位置，供 --stats 展示。 */
export function cacheLocation() {
  return cacheFile();
}

/** 稳定的短标识，仅用于展示和去重，不做任何安全用途。 */
export function hashOf(s) {
  return crypto.createHash('sha256').update(`${s.agent}|${s.id}`).digest('hex').slice(0, 12);
}
