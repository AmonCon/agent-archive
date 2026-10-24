import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 跨平台路径。
 *
 * 各 Agent 的存储位置在不同系统上遵循不同约定：
 *
 *   Windows   %APPDATA%\<App>            （VS Code 系）
 *   macOS     ~/Library/Application Support/<App>
 *   Linux     ~/.config/<App>            （XDG）
 *
 * 另外 `~/.local/share/<app>` 是 XDG 的数据目录，Windows 对应
 * `%LOCALAPPDATA%`，macOS 多数程序会退回 Application Support。
 *
 * 这里的做法是**给出候选列表、按顺序挑第一个真实存在的**，而不是
 * 用 process.platform 硬分支。理由有两个：
 *   1. 用户可能把别的平台的目录整份拷过来（换机、WSL、备份恢复）
 *   2. 某些应用在 macOS 上仍写 ~/.config，在 Linux 上仍写 ~/.local
 * 硬分支会在这些情况下静默失败，而候选列表只是多 stat 几次。
 */

/**
 * 环境变量覆盖：各 Agent 官方支持的"换个地方存"。
 *
 * 这是跨平台最可靠的一层，原因很实际：**每个 OS 的默认路径都可能不同，
 * 但环境变量是各家自己定义的、跨平台语义一致的**。用户把 CLAUDE_CONFIG_DIR
 * 指到外置盘、把 HERMES_HOME 指到 D 盘，在哪个系统上都应该找到。
 *
 * 尤其重要的一点：**很多工具在 macOS 上会自己跳出默认位置**——
 *   Gemini CLI 在 `sandbox-exec` 下把运行时目录改到 ~/.cache/.gemini
 *   OpenCode 在 macOS 上仍用 ~/.local/share（不是 Application Support）
 *   Hermes 在 Windows 上官方是 %LOCALAPPDATA%/hermes，mac/Linux 是 ~/.hermes
 * 只按 platform 硬编码路径，这些都会静默落空。
 *
 * 支持逗号分隔多值：`CLAUDE_CONFIG_DIR=/a,/b` 是社区工具的常见约定，
 * 用户同时装了主副两套时能都读到。
 *
 * @param {string[]} names 环境变量名，按优先级
 * @returns {string[]} 存在的目录/文件路径（可能为空）
 */
export function envOverrides(names) {
  const out = [];

  for (const n of names) {
    const raw = process.env[n];
    if (!raw || !String(raw).trim()) continue;

    for (const part of String(raw).split(',')) {
      const p = part.trim();
      if (!p) continue;
      // ~ 展开：环境变量里写 ~/xxx 很常见
      const full = p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p;
      const abs = path.resolve(full);
      if (!out.some((x) => samePathNorm(x, abs))) out.push(abs);
    }
  }

  return out;
}

/**
 * 把"环境变量覆盖 + 默认候选"合成一条探测链。
 *
 * 覆盖优先，默认兜底。存在的排在前面，但**不因为前面的存在就丢掉后面的**——
 * 有些用户确实有两份数据（主目录一份、外置盘一份）。
 */
export function withOverrides(overrideNames, defaults) {
  const out = [];
  const add = (p) => {
    if (!p) return;
    if (!out.some((x) => samePathNorm(x, p))) out.push(p);
  };

  for (const p of envOverrides(overrideNames)) add(p);
  for (const p of defaults) add(p);
  return out;
}

/** 大小写跟随文件系统，用来去重。 */
function samePathNorm(a, b) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const na = String(a).replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = String(b).replace(/\\/g, '/').replace(/\/+$/, '');
  return ci ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 某个桌面应用的用户数据目录候选（按当前平台优先排序）。 */
export function userDataCandidates(appName) {
  const home = os.homedir();
  const out = [];
  const add = makeAdder(out);

  if (process.platform === 'darwin') add(path.join(home, 'Library', 'Application Support', appName));
  if (process.platform === 'win32') add(path.join(appDataRoaming(home), appName));

  // Linux / XDG
  add(path.join(home, '.config', appName));

  // 兜底：其它平台的约定，换机或跨平台拷贝时可能命中
  add(path.join(home, 'Library', 'Application Support', appName));
  add(path.join(appDataRoaming(home), appName));
  add(path.join(home, '.config', appName.toLowerCase()));

  return out;
}

/** XDG 风格的数据目录候选（用于 opencode 这类存 db 的应用）。 */
export function dataCandidates(appName) {
  const home = os.homedir();
  const out = [];
  const add = makeAdder(out);

  add(path.join(home, '.local', 'share', appName));
  if (process.platform === 'win32') {
    add(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), appName));
  }
  if (process.platform === 'darwin') {
    add(path.join(home, 'Library', 'Application Support', appName));
  }
  add(path.join(home, '.config', appName));

  return out;
}

/**
 * 去重追加。
 *
 * Windows 和 macOS 的文件系统默认大小写不敏感，`~/.config/Cursor` 和
 * `~/.config/cursor` 是同一个地方；按原样去重会把同一个目录列两遍，
 * 白白多 stat 一次。Linux 区分大小写，保持原样。
 */
function makeAdder(out) {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const seen = new Set();
  return (p) => {
    if (!p) return;
    const key = caseInsensitive ? p.toLowerCase() : p;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
}

/**
 * VS Code 系编辑器的应用数据目录候选。
 *
 * 与通用 userDataCandidates 的区别：这类编辑器有多条产品线
 * （Code / Code - Insiders / VSCodium / Cursor / Trae…），
 * 每条在 macOS 上的目录名都不一样，用户可能装的是任意一条。
 *
 * @param {string[]} appNames 产品名，按优先级
 */
export function editorDataCandidates(appNames) {
  const out = [];
  for (const name of appNames) {
    for (const p of userDataCandidates(name)) {
      if (!out.some((x) => samePath(x, p))) out.push(p);
    }
  }
  return out;
}

/** 比较两个路径是否指向同一位置（跟随平台的大小写敏感性）。 */
function samePath(a, b) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function appDataRoaming(home) {
  return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
}

/**
 * 在候选根目录下找第一个含指定相对路径的完整路径。
 *
 * @param {string[]} roots 候选根目录
 * @param {string} rel 相对路径，用 / 分隔（内部会转成当前平台的写法）
 * @returns {string|null}
 */
export function findUnder(roots, rel) {
  const parts = String(rel).split('/').filter(Boolean);
  for (const root of roots) {
    const full = path.join(root, ...parts);
    try {
      fs.accessSync(full, fs.constants.R_OK);
      return full;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 找第一个存在的候选根目录本身（不检查子路径）。
 * 用于 doctor 那种"目录在不在、里面有没有东西"的判断。
 */
export function findExistingDir(roots) {
  for (const root of roots) {
    try {
      if (fs.statSync(root).isDirectory()) return root;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/**
 * 找一个文件的所有候选完整路径。
 *
 * 与 findUnder 的区别：不要求存在，只是把每个候选拼出来。
 * doctor 要报告"这些位置都在哪、有没有"，需要完整清单。
 */
export function candidatesWith(roots, rel) {
  const parts = String(rel).split('/').filter(Boolean);
  const out = [];
  for (const root of roots) {
    const full = path.join(root, ...parts);
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

/** 便于诊断：当前平台与家目录。 */
export function platformInfo() {
  return {
    platform: process.platform,
    home: os.homedir(),
    appData: process.env.APPDATA || null,
    localAppData: process.env.LOCALAPPDATA || null,
  };
}
