import path from 'node:path';
import os from 'node:os';

/**
 * 统一会话模型。
 *
 * 各家 Agent 的存储格式差异很大，但"一个项目里发生过哪些对话"需要的字段
 * 只有这些。所有 scanner 都产出这个形状，下游（时间线、检索、导出）就
 * 不必知道来源是谁。
 */
export function makeSession({ agent, id, project, title, start, end, source, resume }) {
  return {
    agent,
    id: String(id),
    project: project ? normalizeProject(project) : null,
    title: cleanTitle(title) || '(untitled)',
    start: toDate(start),
    end: toDate(end),
    source: source || null,
    resume: resume || null,
  };
}

/**
 * 项目路径归一化。
 *
 * Windows 上同一个项目会出现 e:\softpi-shop、E:\softpi-shop、
 * E:/softpi-shop 三种写法，来自不同 Agent。归集时必须认成同一个，
 * 但展示时保留原始写法更易读，所以 key 用小写、值保留原样。
 */
export function normalizeProject(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  // 统一分隔符，去掉尾部分隔符（根目录除外）
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:$/.test(s)) s += '/';
  return s;
}

/** 用于比较的规范化键：大小写不敏感。 */
export function projectKey(p) {
  const n = normalizeProject(p);
  return n ? n.toLowerCase() : null;
}

/** 判断某个会话是否属于给定项目（含子目录项目）。 */
export function belongsTo(sessionProject, targetKey) {
  const k = projectKey(sessionProject);
  if (!k || !targetKey) return false;
  if (k === targetKey || k.startsWith(targetKey + '/')) return true;
  // 反过来也成立：会话只记了项目名（Qoder 的目录名只有 "softpi-shop"，
  // 没有盘符），而目标给了完整路径 "e:/softpi-shop"。
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

  // WSL 网络路径、UNC 路径：不是本机项目
  if (n.startsWith('//')) return false;

  const home = os.homedir().replace(/\\/g, '/').toLowerCase();
  const low = n.toLowerCase();

  // 家目录本身
  if (low === home) return false;

  // 家目录下这些是"临时落脚点"，不是项目
  const transient = [
    'desktop',
    'documents',
    'downloads',
    'onedrive',
    'appdata',
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

function cleanTitle(t) {
  if (!t) return '';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 会话时长，供排序和展示。 */
export function durationMs(s) {
  if (!s.start || !s.end) return 0;
  return Math.max(0, s.end - s.start);
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
