import path from 'node:path';
import os from 'node:os';
import { assertUnderAny } from '../messages.js';
import { extraRoots } from '../config.js';
import { envOverrides, pathKey } from '../platform.js';
import {
  walkPiFiles,
  parsePiFile,
  readPiFile,
  makeDialect,
} from './pi.js';

/**
 * Oh My Pi（omp）会话扫描——**完整复用 pi.js 的解析器**。
 *
 * CC Switch 用 `Dialect`（pi.rs:56-76；omp.rs 只定义 4 个行为位）让 Pi 与
 * Oh My Pi 共用整份解析器；这里同构：`walkPiFiles` / `parsePiFile` /
 * `readPiFile` 全部从 pi.js import，本文件只负责
 *   ① 自己的本地根  ② 自己的 structureSpec  ③ 自己的 Dialect 行为位。
 * 没有复制第二份会话树投影或消息映射。
 *
 * ## 与 Pi 的格式差异（都在共享解析器里按形状兼容，不另写一份）
 *
 *   - 首行可能是 `{"type":"title"}` 标题槽（或 header.title / `title_change`），
 *     → Dialect.titleSlotFirst = true：标题优先取显式标题槽。
 *   - `model_change` 用单串 `provider/id`（Pi 是 `{provider,modelId}` 对象）；
 *     还可能有 `model_usage` entries（Pi 是 `usage`）。这些是运行时记录，
 *     只参与树的连通、不产出对话消息，所以两种写法天然兼容。
 *   - 会话树 / 活动分支投影 / 三个上限 / 环检测与 Pi 完全一致。
 *
 * ## 路径（MAGPIE omp.go + CC Switch omp_config.rs:45-53,117-157）
 *
 *   `PI_CODING_AGENT_SESSION_DIR`（绝对才收）否则 `<omp_data_dir>/sessions`；
 *   `OMP_PROFILE` / `PI_PROFILE` / `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` /
 *   `XDG_DATA_HOME`（linux/macos 才有 XDG/profile 分支，Windows 直接 agent），
 *   默认 `~/.omp/agent`。
 *
 *   ⚠️ 上游调研自标「omp 的 native_agent_dir() 完整分支未逐行核」，profile
 *   子目录的具体拼法没有权威证据。这里把这些环境变量指向的目录当作**候选根**
 *   （命中就用、不命中不影响），不臆造某个固定的 profile 目录结构；显式数据源
 *   `--source` 走标准 `agent/sessions` 路径，不受这部分影响。
 *
 * ## 同构消歧
 *
 * probes 与 Pi 完全同形，宿主 `identify()` 在 >1 命中时靠**唯一 dirHintMatch**
 * 消歧：`.omp` 目录只命中 omp、`.pi` 目录只命中 pi；仍有歧义就报 ambiguous，
 * 绝不按分数猜。所以 dirHints 必须写死 `['.omp']`。
 *
 * 对 P0 零依赖：structureSpec 纯数据、discoverWithin 纯函数。
 */

export const name = 'omp';

/** Dialect 行为位：显式标题槽优先；恢复命令带 env 前缀、拿不准就留 null。 */
const OMP_DIALECT = makeDialect({ titleSlotFirst: true, resume: null });

function rawEnv(k) {
  const v = process.env[k];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function expandHome(p) {
  const s = String(p == null ? '' : p).trim();
  if (s === '~') return os.homedir();
  if (/^~[\\/]/.test(s)) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 本机默认候选根（config > 环境变量 > 平台默认）。 */
function localRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p));
    if (!out.some((x) => pathKey(x) === pathKey(abs))) out.push(abs);
  };

  for (const p of extraRoots(name)) add(expandHome(p));

  // 显式 sessionDir：绝对才收（相对不可全局枚举）
  const sd = rawEnv('PI_CODING_AGENT_SESSION_DIR');
  if (sd) {
    const expanded = expandHome(sd);
    if (path.isAbsolute(expanded)) add(expanded);
  }

  // 上游点名的环境变量：值本身作候选根
  for (const p of envOverrides(['PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_DATA_DIR'])) add(p);

  // XDG 分支（非 Windows）
  const xdg = rawEnv('XDG_DATA_HOME');
  if (xdg && process.platform !== 'win32') {
    const base = expandHome(xdg);
    add(path.join(base, 'omp'));
    add(path.join(base, 'omp', 'agent'));
  }

  const dataDir = path.join(os.homedir(), '.omp', 'agent');
  // profile 分支：保守候选（上游未逐行核，见文件头）
  const profile = rawEnv('OMP_PROFILE') || rawEnv('PI_PROFILE');
  if (profile) {
    add(path.join(dataDir, 'profiles', profile));
    add(path.join(dataDir, profile));
  }

  // 默认应用根（.omp 层）与 agent 目录
  add(path.join(os.homedir(), '.omp'));
  add(dataDir);
  return out;
}

/** 声明「我会去哪些目录」。 */
export function candidateRoots() {
  return localRoots();
}

/** 声明式结构：相对应用根 `.omp`，与 pi 同形、靠 dirHints 消歧。 */
export const structureSpec = {
  agent: name,
  probes: [
    { glob: 'agent/sessions/**/*.jsonl', kind: 'file', weight: 4 },
    { path: 'agent/sessions', kind: 'dir', weight: 1 },
  ],
  rootAnchor: { from: 'agent', up: 1, allowSelf: true },
  dataPaths: ['agent/sessions'],
  format: 'omp-pi-session-tree-jsonl',
  minScore: 4,
  dirHints: ['.omp'],
};

/** 契约 A：discover() 无参，一行封装。 */
export function discover() {
  return discoverWithin(localRoots(), {});
}

/** 契约 B：纯函数，复用 pi.js 的遍历核心。 */
export function discoverWithin(roots, ctx = {}) {
  return walkPiFiles(roots, structureSpec.dataPaths);
}

/** 一个文件一场会话：复用 pi.js 的树投影解析核心，传 omp 的 Dialect。 */
export function parse(file) {
  return parsePiFile(file, { agent: name, dialect: OMP_DIALECT });
}

/** 读正文：越界校验 ctx.roots 优先，解析复用 pi.js。 */
export function readMessages(session, ctx = {}) {
  const roots = ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
  const file = assertUnderAny(roots, session.source);
  return readPiFile(file, { agent: name, dialect: OMP_DIALECT });
}
