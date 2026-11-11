import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extraRoots } from '../config.js';
import { envOverrides, pathKey } from '../platform.js';
import { isDirEntry, isFileEntry, isDirPath } from '../fsentry.js';
import { assertUnderAny } from '../messages.js';
import * as workbuddy from './workbuddy.js';

/**
 * CodeBuddy 会话扫描。
 *
 * ## 存储
 *
 *   <config>/projects/<工作区转义>/<session-id>.jsonl
 *   <config>/projects/<工作区转义>/<session-id>/subagents/agent-*.jsonl
 *
 * `<config>` = `CODEBUDDY_CONFIG_DIR`，否则 `~/.codebuddy`。
 *
 * **与 WorkBuddy 完全同构**（MAGPIE 的 `calls_workbuddy.go` 里两家共用
 * `buddyFiles()`）。所以解析逻辑直接复用 `workbuddy.js` 的 `parse` /
 * `readMessages`——那些坑全都一样，不必再抄一份：
 *
 *   - 真人那句话在 `<user_query>` 里，前面裹着几 KB 的 system-reminder；
 *   - `timestamp` 是**毫秒**，当秒读会掉到 1970；
 *   - `function_call.id` 是消息 id，**`callId` 才是工具 id**；
 *   - 编辑重发留旧版 user message + `resend-fork-notice` 指回它；
 *   - `providerData.error` 的失败回复不是模型说的话；
 *   - 子代理在 `<id>/subagents/` 下，要标 kind/parent。
 *
 * 包装时只改两处：把 `agent` 从 `workbuddy` 改成 `codebuddy`，并在
 * `readMessages` 前按 `ctx.roots` 做越界校验（workbuddy 自己没有这层）。
 * **不改 workbuddy.js**。
 *
 * 本机 `~/.codebuddy` 存在，但扫描器只读、不写，测试一律用合成样本。
 *
 * ## 对 P0 零依赖
 *
 * `structureSpec` 纯数据、`discoverWithin` 纯函数（只 readdir/stat），
 * 不 import structure.js / source.js / kit.js。
 */

export const name = 'codebuddy';

/** 本机默认候选根（应用根那一层）。 */
function localRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!out.includes(abs)) out.push(abs);
  };
  for (const p of extraRoots(name)) add(p);
  for (const p of envOverrides(['CODEBUDDY_CONFIG_DIR'])) add(p);
  add(path.join(os.homedir(), '.codebuddy'));
  return out;
}

/** 声明「我会去哪些目录」。 */
export function candidateRoots() {
  return localRoots();
}

/**
 * 声明式结构（相对应用根 = `.codebuddy` 那一层）。
 *
 * `projects/<ws>/<id>.jsonl` 与 claude-code / workbuddy / qoder 同构，
 * **dirHints 必须写 `.codebuddy`**，宿主靠它消歧，歧义时报 ambiguous 不猜。
 */
export const structureSpec = {
  agent: name,
  probes: [
    { glob: 'projects/*/*.jsonl', kind: 'file', weight: 4 },
    { path: 'projects', kind: 'dir', weight: 1 },
  ],
  rootAnchor: { from: 'projects', up: 1, allowSelf: true },
  dataPaths: ['projects'],
  format: 'codebuddy-workbuddy-jsonl',
  minScore: 3,
  dirHints: ['.codebuddy'],
};

/** 契约 A：`discover()` 无参，一行封装。 */
export function discover() {
  return discoverWithin(localRoots(), {});
}

/**
 * 契约 B：纯函数。root 就是应用根，按 dataPaths（projects）下钻，
 * 复刻 workbuddy 的发现形状（主会话 + 子代理，排除回滚记录）。
 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const key = pathKey(p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const root of roots || []) {
    for (const sub of structureSpec.dataPaths) {
      const projects = path.join(root, sub);
      if (!isDirPath(projects)) continue;
      let workspaces;
      try {
        workspaces = fs.readdirSync(projects, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const w of workspaces) {
        const wsDir = path.join(projects, w.name);
        if (!isDirEntry(w, wsDir)) continue;
        let entries;
        try {
          entries = fs.readdirSync(wsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const p = path.join(wsDir, e.name);
          if (isFileEntry(e, p) && isSessionFile(e.name)) {
            push(p);
            continue;
          }
          if (!isDirEntry(e, p)) continue;
          // 会话目录：<id>/subagents/agent-*.jsonl
          const subs = path.join(p, 'subagents');
          if (!isDirPath(subs)) continue;
          let subEntries;
          try {
            subEntries = fs.readdirSync(subs, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const s of subEntries) {
            const sp = path.join(subs, s.name);
            if (isFileEntry(s, sp) && /\.jsonl$/i.test(s.name)) push(sp);
          }
        }
      }
    }
  }
  return out.sort();
}

/** `<id>.jsonl` 才算会话；`*.file-rollback.ndjson` / `*.meta.json` 不算。 */
function isSessionFile(name) {
  if (!/\.jsonl$/i.test(name)) return false;
  if (name.includes('.file-rollback')) return false;
  return name.length > '.jsonl'.length;
}

/** 复用 workbuddy 的解析，只把 agent 名改成自己。 */
export function parse(file) {
  const s = workbuddy.parse(file);
  return s ? { ...s, agent: name } : null;
}

/**
 * 复用 workbuddy 的正文读取，先按 `ctx.roots`（显式数据源）或本机根做
 * 越界校验，保证外部备份里的文件不被 assertUnderAny 误杀。
 */
export function readMessages(session, ctx = {}) {
  const roots = ctx && Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : localRoots();
  const file = assertUnderAny(roots, session.source);
  return workbuddy.readMessages({ ...session, source: file });
}
