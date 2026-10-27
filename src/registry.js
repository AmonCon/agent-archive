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
 * 缓存目录放在用户目录而不是项目里：这是工具自己的运行态数据，
 * 不该污染被归档的项目。
 */
const CACHE_VERSION = 2;

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
 * 等附属文件。任一文件的 (mtime, size) 变化都算变化——WAL 被 checkpoint
 * 截断、或整个 wal 消失，都会让指纹改变，这正是我们要的。
 *
 * 附属文件不存在不算错误（非 WAL 模式、刚 checkpoint 完都正常），
 * 记成 null 即可；它从"有"变成"没有"本身就是一次变化。
 */
function stampOf(scanner, file) {
  const parts = [{ path: file, ...statOrNull(file) }];
  if (typeof scanner.extraFiles === 'function') {
    let extra = [];
    try {
      extra = scanner.extraFiles(file) || [];
    } catch {
      extra = [];
    }
    for (const p of extra) parts.push({ path: p, ...statOrNull(p) });
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

/** 两个指纹是否等价。附属文件列表长度或任一项不同都算变化。 */
function sameStamp(a, b) {
  if (!a || !b || !Array.isArray(a.files) || !Array.isArray(b.files)) return false;
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    if (a.files[i].mtimeMs !== b.files[i].mtimeMs) return false;
    if (a.files[i].size !== b.files[i].size) return false;
  }
  return true;
}

/**
 * 扫描所有已注册的 Agent。
 *
 * @param {object} opts
 * @param {boolean} opts.noCache 忽略缓存，全量重解析
 * @returns {{sessions: Array, stats: object}}
 */
export function scanAll({ noCache = false } = {}) {
  const cache = noCache ? {} : loadCache();
  const nextCache = {};
  const sessions = [];
  const stats = { files: 0, parsed: 0, cached: 0, failures: 0, byAgent: {} };

  for (const scanner of scanners) {
    let files;
    try {
      files = scanner.discover();
    } catch {
      files = [];
    }

    for (const file of files) {
      stats.files++;
      const stamp = stampOf(scanner, file);
      // 主文件本身不可读就跳过——附属文件缺失不影响
      if (stamp.files[0].mtimeMs === null) continue;

      const key = file;
      const prev = cache[key];
      const hit = prev && sameStamp(prev.stamp, stamp);

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
