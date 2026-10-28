import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { statePath } from './paths.js';
import { scanners } from './registry.js';

/**
 * 用户自己的扫描器。
 *
 * ## 为什么需要这一层
 *
 * 内置的十一家是"我们碰巧知道"的。世界上的 Agent 远不止这些，而且新的一家
 * 随时会出现。如果支持某家必须改我们的代码、提 PR、等发版，那这个工具对
 * "用它但不在我们名单上的那家"就永远是残缺的。
 *
 * 所以开放一个目录：把自己写的扫描器文件放进去，下次运行就生效。
 * 不需要 fork、不需要发版，也不需要我们同意。
 *
 * ## 契约（与内置扫描器完全一样）
 *
 * ```
 * export const name = 'xxx';                 // 必需，唯一标识
 * export function discover() {}              // 必需，返回文件路径数组
 * export function parse(file) {}             // 二选一：一个文件一场会话，返回会话或 null
 * export function parseAll(file) {}          // 二选一：一个文件多场会话，返回数组
 * export function readMessages(session) {}   // 可选，读正文
 * export function extraFiles(file) {}        // 可选，参与缓存指纹的附属文件（如 -wal）
 * export function enrich(sessions) {}        // 可选，用旁路数据修正会话元数据
 * export function closeStore() {}            // 可选，用完关句柄
 * ```
 *
 * 会话对象用 `model.js` 的 `makeSession()` 造，字段是
 * `{agent, id, project, title, start, end, source, resume, kind, parent}`。
 *
 * ## 边界
 *
 * - **一个坏掉的用户扫描器不能拖垮整次扫描**：加载失败、契约不合格、
 *   discover 抛错，都只影响它自己，并在 doctor 里报出来。
 * - **不能覆盖内置的 name**：重名会让人分不清是哪份在跑。要替换内置的，
 *   等我们支持配置禁用（现在没有）。
 * - 用户扫描器是**代码**，跑在本进程里——这是明确的取舍：能做任何事，
 *   所以只该放自己信任的文件。README 里写明这一点，不假装它是沙箱。
 */

/** 用户扫描器目录。 */
export function userScannerDir() {
  return statePath('scanners');
}

/** 加载过程中积累的问题，供 doctor 展示。 */
export const loadIssues = [];

/**
 * 校验一个模块是否满足扫描器契约。
 *
 * @param {object} mod 模块导出
 * @param {Set<string>} takenNames 已占用的名字
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateScanner(mod, takenNames = new Set()) {
  const errors = [];
  if (!mod || typeof mod !== 'object') return { ok: false, errors: ['模块没有导出任何东西'] };

  const name = mod.name;
  if (!name || typeof name !== 'string') errors.push('缺少 name（字符串）');
  else if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) errors.push(`name 只能含字母数字下划线横线：${name}`);
  else if (takenNames.has(name)) errors.push(`name 与已有的扫描器重名：${name}`);

  if (typeof mod.discover !== 'function') errors.push('缺少 discover()');
  const hasParse = typeof mod.parse === 'function';
  const hasParseAll = typeof mod.parseAll === 'function';
  if (!hasParse && !hasParseAll) errors.push('缺少 parse() 或 parseAll()');

  // 可选导出只检查类型，避免"写了但写错签名"这种隐性坑
  for (const fn of ['readMessages', 'extraFiles', 'enrich', 'closeStore']) {
    if (mod[fn] !== undefined && typeof mod[fn] !== 'function') {
      errors.push(`${fn} 存在但不是函数`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 扫描用户扫描器目录并注册。
 *
 * 每个文件单独 try/catch：一个坏文件不能拦住其余文件，也不能拦住内置扫描器。
 * 加载完成后把问题写进 `loadIssues`，doctor 会展示。
 *
 * @param {string} [dir] 覆盖目录（测试用）
 * @returns {Promise<{loaded: string[], failed: Array<{file: string, error: string}>}>}
 */
export async function registerUserScanners(dir = userScannerDir()) {
  const result = { loaded: [], failed: [] };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result; // 目录不存在就是没有，正常
  }

  const taken = new Set(scanners.map((s) => s.name));
  const files = entries
    .filter((e) => e.isFile() && /\.(mjs|js)$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();

  for (const file of files) {
    const base = path.basename(file);
    try {
      const mod = await import(pathToFileURL(file).href);
      const check = validateScanner(mod, taken);
      if (!check.ok) {
        result.failed.push({ file: base, error: check.errors.join('；') });
        continue;
      }
      // 标记来源，供 doctor / scanner list 区分内置与用户
      const wrapped = { ...mod, __user: true, __file: base };
      scanners.push(wrapped);
      taken.add(mod.name);
      result.loaded.push(mod.name);
    } catch (e) {
      result.failed.push({ file: base, error: e && e.message ? e.message : String(e) });
    }
  }

  loadIssues.length = 0;
  for (const f of result.failed) loadIssues.push(`${f.file}: ${f.error}`);
  return result;
}

/** 列出当前所有扫描器及其来源（内置 / 用户）。 */
export function listScanners() {
  return scanners.map((s) => ({
    name: s.name,
    source: s.__user ? 'user' : 'builtin',
    file: s.__file || null,
    canReadBody: typeof s.readMessages === 'function',
  }));
}

/**
 * 生成一份扫描器骨架，降低"从零写"的门槛。
 *
 * 只看文档写适配器很容易漏掉返回结构，先给一个能跑通的空壳，
 * 改里面的 discover/parse 就行。
 */
export function scannerTemplate(name = 'myagent') {
  return `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ${name} 的扫描器。
 *
 * 契约见 CONTRIBUTING.md「给一家新 Agent 加支持」。
 * 这个骨架能跑通：discover() 返回空数组，所以不会报错也不会产生噪声。
 * 把下面的 TODO 换成真实的路径与解析即可。
 *
 * 注意：**不需要 import 这个项目的任何模块**。parse/parseAll 返回普通对象
 * 就行，缺省值由宿主补（agent 用 name、kind 用 main、时间接受 Date/ISO/毫秒）。
 */

export const name = '${name}';

/** 我会去哪些目录找数据。doctor 与反向发现都用它，别忘了写。 */
export function candidateRoots() {
  return [path.join(os.homedir(), '.${name}')];
}

/** TODO: 这家把会话存在哪？返回文件路径数组（可以是 0 个）。 */
export function discover() {
  const root = path.join(os.homedir(), '.${name}');
  // 示例：root 下所有 .jsonl
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(root, e.name));
  }
  return out;
}

/** TODO: 从文件里解出一场会话；不是会话就返回 null。 */
export function parse(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean);
  } catch {
    return null;
  }
  if (!lines.length) return null;

  let first = null;
  try {
    first = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  return {
    id: first.sessionId || path.basename(file, '.jsonl'),
    project: first.cwd || null,        // 拿不到就 null，不要猜
    title: first.title || null,
    start: first.createdAt || null,
    end: first.updatedAt || null,
    source: file,                       // readMessages 用它读正文
  };
}
`;
}
