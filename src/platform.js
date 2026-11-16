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

/**
 * 去重用的路径键：大小写跟随文件系统。
 *
 * 导出它是因为扫描器也要去重（同一个目录可能通过两个候选根都被看到），
 * 而且必须用**和这里一致的规则**——两处各写一遍迟早会不一致。
 */
export function pathKey(p) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  return ci ? String(p).toLowerCase() : String(p);
}

/** 大小写跟随文件系统，用来去重。 */
function samePathNorm(a, b) {
  return pathKey(a) === pathKey(b);
}

/**
 * 按目标平台拼路径。
 *
 * **不能用 `path.join`**：它是当前进程平台的分隔符。在 Windows 上跑
 * `userDataCandidates('Claude', { platform: 'darwin' })` 会得到
 * `\Users\alice\Library\Application Support\Claude`——反斜杠 + POSIX 家目录，
 * 一个在任何平台上都不存在的路径。而这条路径正是测试里用来断言
 * "macOS 上会去哪找"的，于是**测试看起来在验证跨平台，实际验证的是错误的东西**。
 *
 * 所以按目标平台选分隔符：win32 用 `\`，其余用 `/`。这与上游的做法一致——
 * magpie 的 `desktopdir.Find(goos, home, getenv)` 和 CC Switch 的
 * `#[cfg(target_os = "macos")]` 都是"平台是参数，不是全局状态"。
 */
function joinFor(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/';
  // 先统一成 '/' 再按目标平台换回：输入可能来自任何地方（配置文件、
  // 环境变量、别家写的数据），混着两种分隔符是常态。
  const cleaned = parts
    .filter((p) => p !== undefined && p !== null && String(p) !== '')
    .map((p) => String(p).replace(/\\/g, '/').replace(/\/+$/, ''))
    // 去掉除第一段以外的开头分隔符
    .map((p, i) => (i === 0 ? p : p.replace(/^\/+/, '')))
    .filter((p, i) => i === 0 || p !== '');
  if (!cleaned.length) return '';

  const out = cleaned.join('/');
  return platform === 'win32' ? out.replace(/\//g, sep) : out;
}

/**
 * 某个桌面应用的用户数据目录候选（按当前平台优先排序）。
 *
 * `opts` 只为测试与跨平台推断存在：默认取真实平台/家目录/环境变量，传了就按传的算。
 * 这样能在实测断言"在 macOS 上会得到什么"——否则跨平台路径假设只能靠
 * 真机验证，而这个项目在 macOS/Linux 上一直没跑过（见 README 的验证状态）。
 *
 * 三平台的规则（与 MAGPIE `internal/desktopdir`、CC Switch
 * `claude_desktop_config.rs` 交叉核对过）：
 *
 *   Windows  %APPDATA%\<App>                     （Roaming）
 *   macOS    ~/Library/Application Support/<App>
 *   Linux    $XDG_CONFIG_HOME/<App>（默认 ~/.config/<App>）
 *
 * @param {string} appName
 * @param {{platform?: string, home?: string, env?: object}} [opts]
 */
export function userDataCandidates(appName, opts = {}) {
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const out = [];
  const add = makeAdder(out, platform);
  const join = (...p) => joinFor(platform, ...p);

  if (platform === 'darwin') add(join(home, 'Library', 'Application Support', appName));
  if (platform === 'win32') add(join(appDataRoaming(home, env, platform), appName));

  // Linux / XDG：**XDG_CONFIG_HOME 优先**，不是硬编码 ~/.config。
  // 上游两家都认这个变量（magpie 的 `env("XDG_CONFIG_HOME", ...)`、
  // CC Switch 的 `config_dir`）。只写 ~/.config 会漏掉改过 XDG 的用户。
  const xdgConfig = env.XDG_CONFIG_HOME && String(env.XDG_CONFIG_HOME).trim();
  add(join(xdgConfig || join(home, '.config'), appName));

  // 兜底：其它平台的约定，换机或跨平台拷贝时可能命中
  add(join(home, 'Library', 'Application Support', appName));
  add(join(appDataRoaming(home, env, platform), appName));
  add(join(xdgConfig || join(home, '.config'), appName.toLowerCase()));

  return out;
}

/**
 * XDG 风格的数据目录候选（用于 opencode 这类存 db 的应用）。
 *
 * 注意 OpenCode 在 macOS 上**不用** Application Support：它源码里写死
 * `XDG_DATA_HOME || ~/.local/share`，没有 darwin 分支。所以这里
 * `~/.local/share` 排第一，Application Support 只在 darwin 时作为附加候选。
 *
 * @param {string} appName
 * @param {{platform?: string, home?: string, env?: object}} [opts]
 */
export function dataCandidates(appName, opts = {}) {
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const out = [];
  const add = makeAdder(out, platform);
  const join = (...p) => joinFor(platform, ...p);

  // XDG_DATA_HOME 优先：OpenCode 源码写死 `XDG_DATA_HOME || ~/.local/share`，
  // 两个平台都没有 darwin 分支。
  const xdgData = env.XDG_DATA_HOME && String(env.XDG_DATA_HOME).trim();
  add(join(xdgData || join(home, '.local', 'share'), appName));
  if (platform === 'win32') {
    add(join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), appName));
  }
  if (platform === 'darwin') {
    add(join(home, 'Library', 'Application Support', appName));
  }
  const xdgConfig = env.XDG_CONFIG_HOME && String(env.XDG_CONFIG_HOME).trim();
  add(join(xdgConfig || join(home, '.config'), appName));

  return out;
}

/**
 * 去重追加。
 *
 * Windows 和 macOS 的文件系统默认大小写不敏感，`~/.config/Cursor` 和
 * `~/.config/cursor` 是同一个地方；按原样去重会把同一个目录列两遍，
 * 白白多 stat 一次。Linux 区分大小写，保持原样。
 */
function makeAdder(out, platform = process.platform) {
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
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
export function editorDataCandidates(appNames, opts = {}) {
  const out = [];
  for (const name of appNames) {
    // 必须把 opts 传下去：否则"模拟 macOS"时仍用真实平台/家目录，
    // 断言的是跑测试那台机器，不是 macOS。这个 bug 曾经存在过。
    for (const p of userDataCandidates(name, opts)) {
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

/**
 * %APPDATA% 的兜底值。
 *
 * 用 `joinFor('win32', ...)` 而不是 `path.join`：这个函数只在 win32 分支被调用，
 * 但**测试会用别的 platform 调进来**（比如断言"在 Windows 上会去哪找"），
 * 那时进程可能是 Linux，`path.join` 会拼出 `/`，断言就失去意义。
 */
function appDataRoaming(home, env = process.env, platform = 'win32') {
  if (env.APPDATA) return env.APPDATA;
  return joinFor(platform, home, 'AppData', 'Roaming');
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
