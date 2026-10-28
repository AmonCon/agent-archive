import fs from 'node:fs';
import { statePath } from './paths.js';

/**
 * 用户配置文件。
 *
 * ## 为什么需要它（而不是只靠环境变量）
 *
 * 十一家 Agent 的数据目录大部分可以用环境变量覆盖（`CODEX_HOME`、
 * `CLAUDE_CONFIG_DIR`、`HERMES_HOME`…）。这些变量在终端里很好用，但在两种
 * 真实场景下很别扭：
 *
 *   1. **GUI 拉起的 MCP server**：Claude Desktop / Cursor 之类启动子进程时
 *      不一定继承你 shell 里设的变量，用户改了半天"没生效"，也不知道为什么。
 *   2. **一台机器上有多份数据**：`CODEX_HOME` 只能指一个，用户想同时看
 *      本机盘和外置盘上的两份，环境变量表达不了。
 *
 * 配置文件两个问题都能解决，而且**和环境变量不冲突**：配置文件里的根排在
 * 前面（用户显式写的优先），环境变量与平台默认继续作为后备候选。
 *
 * ## 文件形态
 *
 * `~/.agent-archive/config.json`：
 *
 * ```json
 * {
 *   "roots": {
 *     "codex": ["D:/archive/.codex"],
 *     "claude-code": ["/Volumes/work/.claude"]
 *   },
 *   "disabled": ["kiro"]
 * }
 * ```
 *
 * `roots.<agent>` 里的每一项，含义与该 Agent 的**家目录**相同
 * （也就是 `~/.codex`、`~/.claude` 那一层）。扫描器自己知道往下怎么拼
 * ——Codex 是 `sessions/`，Hermes 是 `state.db`，不需要用户懂这些。
 *
 * `disabled` 里的 Agent 不会被扫描。用于"这家我不用/它坏了/扫描太慢"。
 *
 * ## 读不到就静默降级
 *
 * 文件不存在是正常状态（默认配置）。内容坏了也只是这一层失效，
 * 不能让整个工具起不来——配置是让事情变方便，不是新的单点故障。
 */

let cached = null;
let cacheStamp = null;

/** 配置文件路径。 */
export function configPath() {
  return statePath('config.json');
}

/**
 * 读配置。按 (mtime, size) 缓存——它很小，但可能在长驻进程里被改。
 *
 * @returns {{roots: object, disabled: string[], error: string|null}}
 */
export function loadUserConfig() {
  const file = configPath();
  let stamp = 'none';
  try {
    const st = fs.statSync(file);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    // 没有配置文件：返回空配置，且记住这个状态
    if (cacheStamp === stamp && cached) return cached;
    cached = { roots: {}, disabled: [], error: null };
    cacheStamp = stamp;
    return cached;
  }

  if (cacheStamp === stamp && cached) return cached;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const roots = {};
    if (raw && typeof raw.roots === 'object' && raw.roots) {
      for (const [agent, list] of Object.entries(raw.roots)) {
        if (!Array.isArray(list)) continue;
        const clean = list.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
        if (clean.length) roots[agent] = clean;
      }
    }
    const disabled = Array.isArray(raw && raw.disabled)
      ? raw.disabled.filter((x) => typeof x === 'string')
      : [];
    cached = { roots, disabled, error: null };
  } catch (e) {
    // 配置写坏了：当作空配置，但把原因带出来给 doctor 显示
    cached = { roots: {}, disabled: [], error: e && e.message ? e.message : String(e) };
  }
  cacheStamp = stamp;
  return cached;
}

/**
 * 某个 Agent 的额外家目录。
 *
 * 返回的是"用户显式配置的"，扫描器负责把它们排在自己的候选项前面。
 * 顺序有意义：用户在配置里写的第一项优先。
 */
export function extraRoots(agentName) {
  const cfg = loadUserConfig();
  const list = cfg.roots[agentName];
  return Array.isArray(list) ? list : [];
}

/** 被禁用的 Agent 名字集合。 */
export function disabledAgents() {
  return new Set(loadUserConfig().disabled);
}

/** 清缓存（测试用）。 */
export function clearConfigCache() {
  cached = null;
  cacheStamp = null;
}
