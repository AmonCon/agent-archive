/**
 * 网页层的数据快照。
 *
 * 这里只做一件事：把"读一次要扫几千个文件/几个数据库"的结果缓存几十秒，
 * 让翻页不至于每次都从头读。缓存时间取短：Agent 还在写库，
 * 用户点刷新时应该看到变化，而不是一份五分钟前的账。
 */

import { listProjects } from '../query.js';
import { memorySummary } from '../env/memory.js';
import { sameProject } from '../model.js';

const TTL_MS = 60_000;

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

/** 侧栏的"最近项目"。和页面共用同一个扫描缓存，冷启动只多花一次。 */
export const recentProjects = memo(async () => {
  const { projects } = listProjects({});
  return projects.slice(0, 10).map((p) => ({
    display: p.display,
    key: p.key,
    count: p.count,
    agents: p.agents,
    end: p.end,
  }));
});

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
