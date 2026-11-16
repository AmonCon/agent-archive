import path from 'node:path';
import os from 'node:os';

/**
 * 统一会话模型。
 *
 * 各家 Agent 的存储格式差异很大，但"一个项目里发生过哪些对话"需要的字段
 * 只有这些。所有 scanner 都产出这个形状，下游（时间线、检索、导出）就
 * 不必知道来源是谁。
 *
 * ## kind / parent：为什么子代理会话也要留下来
 *
 * 早期版本把子代理会话整条丢掉，理由是它们的 `session_id` 指向父会话，
 * 按它归并会让几十个子代理挤成一条。这个理由只对了一半——**该修的是标识，
 * 不是把它们扔了**。
 *
 * 主会话只记"我让子代理去查一下 X"，具体查了什么、看到了什么全在子代理
 * 会话里。扔掉等于档案馆只存了一半事实。实测仅 Hermes / ZCode /
 * OpenCode 三家就有 202 场被丢。
 *
 * 所以现在的约定：
 *   kind: 'main'      正常会话（默认，缺省即 main）
 *   kind: 'subagent'  子代理会话，parent 指向父会话 id
 *
 * 下游的默认行为是按 `kind === 'main'` 过滤——时间线、项目列表、搜索都以
 * 主会话为单位。子代理会话仍然被完整采集、可被单独读取、可被统计，
 * 只是不冒充一场独立对话。
 */
export function makeSession({
  agent,
  id,
  project,
  title,
  start,
  end,
  source,
  resume,
  kind,
  parent,
  copyOf,
  branchOf,
}) {
  return {
    agent,
    id: String(id),
    project: project ? normalizeProject(project) : null,
    title: cleanTitle(title) || '(untitled)',
    start: toDate(start),
    end: toDate(end),
    source: source || null,
    resume: resume || null,
    // 缺省 main：老会话（没有这两个字段的缓存）按主会话对待，
    // 这样升级缓存版本之前的数据不会被误判成子代理
    kind: kind === 'subagent' ? 'subagent' : 'main',
    parent: parent ? String(parent) : null,
    // Claude Code 的 --fork-session / /branch 会把历史整段复制进新文件。
    // copyOf  指向被完全复制的原会话：内容一模一样，不冒充一场独立对话。
    // branchOf 指向分叉来源：它复制了旧历史，但之后有自己的新内容，仍留在时间线上。
    // 两者都是缺省 null——老缓存没有这两个字段，按"不是复制/分叉"对待。
    copyOf: copyOf ? String(copyOf) : null,
    branchOf: branchOf ? String(branchOf) : null,
  };
}

/**
 * 项目路径归一化。
 *
 * Windows 上同一个项目会出现 e:\my-app、E:\my-app、
 * E:/my-app 三种写法，来自不同 Agent。归集时必须认成同一个，
 * 但展示时保留原始写法更易读，所以 key 用小写、值保留原样。
 */
export function normalizeProject(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  // 统一分隔符，去掉尾部分隔符（根目录除外）
  const wasRoot = /^[\\/]+$/.test(s); // "/" 或 "\"：文件系统根
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  // 根目录本身：去掉尾斜杠会变成空串，那样它就不再是"一个项目路径"了
  if (wasRoot && !s) return '/';
  if (/^[a-zA-Z]:$/.test(s)) s += '/';
  return s;
}

/** 用于比较的规范化键：大小写不敏感。 */
export function projectKey(p) {
  const n = normalizeProject(p);
  return n ? n.toLowerCase() : null;
}

/**
 * 把用户给的路径文本归一成"项目身份"用的绝对路径。
 *
 * **不能直接 `path.resolve(cwd, p)`**：归档里记的路径来自别的机器，可能和
 * 当前平台不是一回事。实测三个平台都会踩：
 *
 *   - Linux 上查 `E:/my-app`（Windows 备份里记的）→ `path.resolve` 给出
 *     `/home/me/E:/my-app`，和记录的 `e:/my-app` 永远匹配不上，表现为
 *     "这个项目一场会话都没有"。
 *   - Windows 上查 `/home/me/proj`（macOS/Linux 备份里记的）→ `C:\home\me\proj`。
 *   - demo 在 Linux/macOS 上跑 `timeline E:/demo-project` → 同样落空。
 *
 * 所以：**认出别的平台的绝对路径就原样保留**，只有真正的相对路径才拼 cwd。
 * 这比"按当前平台猜"可靠——归档的意义就是能读别处来的数据。
 */
export function absProjectPath(p, { cwd = process.cwd() } = {}) {
  if (!p) return null;
  const s = String(p).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;

  // Windows 盘符路径：E:/x、E:\x、E:（光杆盘符）
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(s)) return s;
  // UNC：\\server\share、//server/share
  if (/^\\\\/.test(s) || /^\/\//.test(s)) return s;
  // POSIX 绝对路径：/home/me/x（在 Windows 上也不该被拼上盘符）
  if (s.startsWith('/')) return s;

  return path.resolve(cwd, s);
}

/** 判断某个会话是否属于给定项目（含子目录项目）。 */
export function belongsTo(sessionProject, targetKey) {
  const k = projectKey(sessionProject);
  if (!k || !targetKey) return false;
  if (k === targetKey || k.startsWith(targetKey + '/')) return true;
  // 反过来也成立：会话只记了项目名（Qoder 的目录名只有 "my-app"，
  // 没有盘符），而目标给了完整路径 "e:/my-app"。
  // 此时按末段匹配，避免同一个项目在列表里裂成两行。
  return k.indexOf('/') === -1 && targetKey.endsWith('/' + k);
}

/**
 * 两个项目键是否指向同一个项目。
 *
 * 用来把"只有项目名"的条目并到"完整路径"的条目上：同一个项目
 * 在不同 Agent 里的记录粒度不同，展示时应当合并，而不是并排两行。
 */
export function sameProject(a, b) {
  const ka = projectKey(a);
  const kb = projectKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // 一个带路径、一个只有名字：名字等于路径末段就算同一个
  if (ka.indexOf('/') === -1) return kb === ka || kb.endsWith('/' + ka);
  if (kb.indexOf('/') === -1) return ka === kb || ka.endsWith('/' + kb);
  return false;
}

/**
 * 判断一个路径是否值得当作"项目"列出来。
 *
 * Codex 会把家目录、桌面、临时目录当成 cwd 记录，这些不是项目，
 * 混进项目清单会让列表变得没意义。这里做保守过滤：只要看起来像
 * 项目工作目录就保留，宁可留下几个奇怪的，也不误杀真项目。
 */
export function isProjectPath(p) {
  const n = normalizeProject(p);
  if (!n) return false;

  // WSL 网络路径、UNC 路径：不是实测项目
  if (n.startsWith('//')) return false;

  const home = os.homedir().replace(/\\/g, '/').toLowerCase();
  const low = n.toLowerCase();

  // 家目录本身
  if (low === home) return false;

  // 家目录下这些是"临时落脚点"，不是项目。
  // 名单同时涵盖 Windows 和 macOS 的系统目录——不认识的那些在别的平台
  // 上匹配不到，留着无害。
  const transient = [
    // Windows
    'desktop',
    'documents',
    'downloads',
    'onedrive',
    'appdata',
    // macOS：~/Library 里存的是应用数据（含 Application Support），不是项目
    'library',
    'applications',
    'movies',
    'music',
    'pictures',
    'public',
    // Linux 桌面
    'snap',
    // 各 Agent 的临时工作区
    '.codex/worktrees',
    '.zcode/workspace',
    'documents/codex',
  ];
  const rel = low.startsWith(home + '/') ? low.slice(home.length + 1) : null;
  if (rel !== null) {
    for (const t of transient) {
      if (rel === t || rel.startsWith(t + '/')) {
        // ~/.zcode/workspace 下每个会话一个目录，不属于用户项目
        return false;
      }
    }
  }

  // 系统盘根目录
  if (/^[a-z]:\/?$/.test(low)) return false;

  return true;
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    // 各家时间戳精度不一：ZCode 用毫秒，Hermes 用秒。
    // 1e11 毫秒 ≈ 1973 年，秒级时间戳到 2286 年才会到这个量级。
    return new Date(v > 1e11 ? v : v * 1000);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 会话所属的「日」。
 *
 * 必须按本地时区算，不能 `toISOString().slice(0,10)`——那是 UTC 日。
 * 东八区 00:00–08:00 发生的会话会落到前一天，终端时间线与网页同一天的
 * 分组会不一致。所有按天分组、导出的地方都走这一个函数。
 */
export function dayKey(v) {
  const d = toDate(v);
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cleanTitle(t) {
  if (!t) return '';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 会话时长，供排序和展示。 */
export function durationMs(s) {
  if (!s.start || !s.end) return 0;
  return Math.max(0, s.end - s.start);
}

/** 是不是子代理会话。缺省字段按主会话对待（兼容老缓存）。 */
export function isSubagent(s) {
  return !!s && s.kind === 'subagent';
}

/**
 * 只看主会话。时间线、项目列表、搜索默认都走这个。
 *
 * 复制品（copyOf）也排除：它和原会话内容完全相同，列出来只会让会话数虚高。
 * 分叉（branchOf）保留——它有自己的新内容，只是带个来源标记。
 */
export function mainOnly(sessions) {
  return sessions.filter((s) => !isSubagent(s) && !s.copyOf);
}

/**
 * 把子代理会话按**根会话**分组，返回 Map<根会话 id, 子会话数组>。
 *
 * 注意是"根"不是"直接父"：Codex 支持多级委派（子代理还能再派子代理），
 * 实测 1543 场子代理里有 181 场的直接父是另一个子代理。只按直接父
 * 分组，这些孙子会话会挂在一个时间线上根本不显示的节点下面，等于看不见。
 * 所以沿 parent 链上溯到根，全部归到根名下，并保留 `depth` 说明层级。
 *
 * 只挂能上溯到根（main）的：链断了的（父会话被删、跨项目）不放进索引，
 * 由调用方单独处理——不要静默吞掉。
 */
export function indexChildren(sessions) {
  const byKey = new Map(sessions.map((s) => [`${s.agent}|${s.id}`, s]));
  const byRoot = new Map();

  for (const s of sessions) {
    if (!isSubagent(s) || !s.parent) continue;

    // 沿链上溯，找最近的 main 祖先，同时记录深度
    let cur = s;
    let depth = 1;
    let root = null;
    for (let i = 0; i < 64; i++) {
      const p = byKey.get(`${cur.agent}|${cur.parent}`);
      if (!p) break;
      if (!isSubagent(p)) {
        root = p;
        break;
      }
      cur = p;
      depth++;
    }
    if (!root) continue;

    const list = byRoot.get(root.id) || [];
    list.push({ ...s, depth });
    byRoot.set(root.id, list);
  }

  for (const list of byRoot.values()) {
    list.sort((a, b) => (a.start || 0) - (b.start || 0));
  }
  return byRoot;
}

/** 把 home 目录缩写成 ~，让输出更短。 */
export function tildify(p) {
  if (!p) return p;
  const home = os.homedir().replace(/\\/g, '/');
  const n = p.replace(/\\/g, '/');
  return n.toLowerCase().startsWith(home.toLowerCase()) ? '~' + n.slice(home.length) : n;
}

export function resolveHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
