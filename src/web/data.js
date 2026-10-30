/**
 * 网页层的数据快照。
 *
 * 这里只做一件事：把"读一次要扫几千个文件/几个数据库"的结果缓存几十秒，
 * 让翻页不至于每次都从头读。缓存时间取短：Agent 还在写库，
 * 用户点刷新时应该看到变化，而不是一份五分钟前的账。
 */

import fs from 'node:fs';
import path from 'node:path';
import { listProjects } from '../query.js';
import { memorySummary } from '../env/memory.js';
import { sameProject } from '../model.js';
import { statePath } from '../paths.js';

// 页面数据快照。与扫描缓存同量级：5 分钟内翻页不再重扫，
// 用户点刷新/重新打开页面仍然会读到最近一次快照。
const TTL_MS = 300_000;

function memo(fn, ttl = TTL_MS) {
  let at = 0;
  let value;
  let pending = null;
  return async function get() {
    if (value !== undefined && Date.now() - at < ttl) return value;
    if (pending) return pending;
    pending = (async () => {
      try {
        value = await fn();
        at = Date.now();
        return value;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}

/** 用量快照：读 5 个库、上万行，缓存 60 秒。 */
export const usageSnapshot = memo(async () => {
  const [{ readUsage }, { loadCatalog }] = await Promise.all([
    import('../usage.js'),
    import('../pricing.js'),
  ]);
  const r = await readUsage();
  const catalogInfo = loadCatalog();
  return { r, catalog: catalogInfo.ready ? catalogInfo : null, catalogInfo };
});

/**
 * 侧栏的"最近项目"。
 *
 * 每个页面都要它，而 listProjects() 会触发一次全量 stat（本机 2585 个文件
 * 约 1 秒）。这是所有页面首访的共同固定成本——包括根本不需要会话正文的
 * `/env` 和 `/usage`。
 *
 * 所以这一份额外落盘：新进程启动后先读 JSON（几十毫秒），TTL 内不再扫。
 * 过期后照常重算并覆盖，行为和原来的 5 分钟内存缓存一致。
 */
const RECENT_VERSION = 1;
let recentValue = null;
let recentAt = 0;

function recentCacheFile() {
  return statePath('cache', `recent-projects-v${RECENT_VERSION}.json`);
}

function readRecentDisk() {
  try {
    const o = JSON.parse(fs.readFileSync(recentCacheFile(), 'utf8'));
    if (o && Array.isArray(o.value) && Date.now() - Number(o.at) < TTL_MS) {
      return { at: Number(o.at), value: o.value };
    }
  } catch {
    /* 没有或坏了，重算 */
  }
  return null;
}

function writeRecentDisk(value) {
  const file = recentCacheFile();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), value }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 写不进去只影响下次启动速度，不影响正确性 */
  }
}

export async function recentProjects({ diskOnly = false } = {}) {
  if (recentValue && Date.now() - recentAt < TTL_MS) return recentValue;

  const disk = readRecentDisk();
  if (disk) {
    recentValue = disk.value;
    recentAt = disk.at;
    return recentValue;
  }

  // 启动预热只读磁盘：缓存不在就先空着，别为了侧栏在 listen 之前扫一遍。
  if (diskOnly) return [];

  const { projects } = listProjects({});
  const value = projects.slice(0, 10).map((p) => ({
    display: p.display,
    key: p.key,
    count: p.count,
    agents: p.agents,
    end: p.end,
  }));
  recentValue = value;
  recentAt = Date.now();
  writeRecentDisk(value);
  return value;
}

/** 测试用：丢掉进程内缓存（磁盘缓存保留，正好用来测跨进程命中）。 */
export function clearRecentProjectsCache() {
  recentValue = null;
  recentAt = 0;
}

/**
 * 这个项目有没有项目级记忆。
 *
 * 只走 memorySummary()，不走 fullInventory()——后者会去扫几百个技能目录，
 * 对"项目页要不要显示一张小卡"来说太贵。任何异常都退回"不知道"，
 * 不能让环境层的问题把项目页拖垮。
 */
export const projectMemory = memo(async () => {
  try {
    const mem = memorySummary();
    const items = mem.list.filter((m) => m.scope === 'project' && m.project);
    return { items, summary: mem };
  } catch {
    return { items: [], summary: null };
  }
});

/** 按项目路径过滤上面的结果。 */
export async function projectMemoryInfo(target) {
  const { items } = await projectMemory();
  if (!items.length) return null;
  const hit = items.filter((m) => sameProject(m.project, target));
  if (!hit.length) return null;
  return {
    locations: hit.length,
    entries: hit.reduce((n, m) => n + (m.entries || 0), 0),
    agents: [...new Set(hit.map((m) => m.agent))],
  };
}
