/**
 * 技能使用率：把"装了哪些技能"和"实际用了哪些"接起来。
 *
 * 这是本工具独有的数据。别家工具只能报"你有 290 个技能"，
 * 但答不了"哪 250 个你一次都没用过"——那需要同时知道技能清单
 * 和会话里的工具调用记录，只有档案馆两边都有。
 *
 * ## 覆盖范围的诚实说明
 *
 * 只统计**显式调用 Skill 工具**的记录。实测各家的做法不一样：
 *
 *   ZCode / Claude Code  调 `Skill` 工具，input.skill 给出技能名 ✅
 *   Codex                没有 Skill 工具，直接 Read 那个 SKILL.md ❌
 *   Hermes               走自己的 skill 机制，形态未统一 ❌
 *
 * 所以这个数字是**下限**，不是全貌。Codex 那 269 场提到 "Skill" 的会话
 * 里绝大多数只是在正文里聊到这个词（讨论技能、贴 URL），并不是调用。
 * 与其猜"读 SKILL.md 就算用了"，不如明确说只覆盖显式调用——
 * 猜错会让"从没用过"这个结论失去意义。
 *
 * 数据来源是已建的全文索引，不重新读会话：全量读一遍要 33 秒，
 * 而索引里已经有工具调用摘要了。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { statePath } from '../paths.js';

const CACHE_VERSION = 1;

function cacheFile() {
  return statePath('cache', `skill-usage-v${CACHE_VERSION}.json`);
}

function indexFile() {
  return statePath('index', 'fulltext-v1.sqlite');
}

/**
 * 从索引正文里抽技能调用。
 *
 * 索引把工具调用压成 `[Skill {"skill":"github:commit","args":"..."}]`
 * 这种一行摘要（见 search.js 的 messagesToText/summarize）。
 * 所以这里用正则从 body 里抠，而不是重新解析会话——
 * 代价是依赖那个摘要格式，但它就在同一个仓库里、改动会一起被发现。
 */
function extractSkillCalls(body) {
  const out = [];
  // [Skill {...}] 或 [skill {...}]，允许中间有空格
  const re = /\[(Skill|skill)\s+(\{[^}]*\})\]/g;
  let m;
  while ((m = re.exec(body))) {
    try {
      const input = JSON.parse(m[2]);
      const name = input.skill || input.name;
      if (name) out.push({ skill: String(name), args: input.args ? String(input.args).slice(0, 200) : null });
    } catch {
      /* 摘要被截断过，JSON 不完整就跳过 */
    }
  }
  return out;
}

/**
 * 扫索引，统计每个技能的调用次数。
 *
 * 结果按 (index mtime, size) 缓存：索引没重建就不用重扫。
 */
export function scanSkillUsage({ fresh = false } = {}) {
  const idx = indexFile();
  let st;
  try {
    st = fs.statSync(idx);
  } catch {
    return { ready: false, message: '索引还没建，先运行：agent-archive index', calls: [], bySkill: new Map() };
  }

  const cachePath = cacheFile();
  if (!fresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.indexMtimeMs === st.mtimeMs && cached.indexSize === st.size) {
        return {
          ready: true,
          calls: cached.calls,
          bySkill: new Map(Object.entries(cached.bySkill)),
          sessions: cached.sessions,
          cached: true,
        };
      }
    } catch {
      /* 没缓存或坏了，重扫 */
    }
  }

  let db;
  try {
    db = new DatabaseSync(idx, { readOnly: true });
  } catch {
    return { ready: false, message: '索引打不开', calls: [], bySkill: new Map() };
  }

  const calls = [];
  const bySkill = new Map();
  const sessionSet = new Set();

  try {
    // 只取含 Skill 的行，避免把 980 场正文全读进内存
    const rows = db
      .prepare(
        "select agent, id, project, title, start, body from doc where body like '%[Skill %' or body like '%[skill %'"
      )
      .all();

    for (const r of rows) {
      const found = extractSkillCalls(r.body || '');
      for (const c of found) {
        const key = normalizeSkillName(c.skill);
        calls.push({
          skill: key,
          raw: c.skill,
          agent: r.agent,
          session: r.id,
          project: r.project,
          title: r.title,
          start: r.start,
          args: c.args,
        });
        bySkill.set(key, (bySkill.get(key) || 0) + 1);
        sessionSet.add(`${r.agent}|${r.id}`);
      }
    }
  } catch {
    /* 表结构不对就当没有 */
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }

  const payload = {
    indexMtimeMs: st.mtimeMs,
    indexSize: st.size,
    calls,
    bySkill: Object.fromEntries(bySkill),
    sessions: sessionSet.size,
  };

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload), 'utf8');
  } catch {
    /* 缓存写不进去不影响正确性 */
  }

  return { ready: true, calls, bySkill, sessions: sessionSet.size, cached: false };
}

/**
 * 技能名归一。
 *
 * `github:commit` 和 `commit` 可能是同一个技能（前者带插件前缀）。
 * 但也不能一律砍掉前缀——`documents:docx` 和 `pdf:pdf` 是不同的。
 * 这里保留原名，只把 `插件:技能` 的**后半段**也记下来做别名匹配，
 * 让 join 时两种写法都能对上。
 */
function normalizeSkillName(raw) {
  const s = String(raw).trim();
  // 去掉参数里可能带的引号
  return s.replace(/^["']|["']$/g, '');
}

/** `github:commit` → ['github:commit', 'commit'] */
export function skillAliases(name) {
  const out = [name];
  const idx = name.indexOf(':');
  if (idx > 0) out.push(name.slice(idx + 1));
  return out;
}

/**
 * 把使用记录 join 到技能清单上。
 *
 * 匹配规则按优先级：
 *   1. 完全同名
 *   2. 技能名等于 `插件:技能` 的后半段（`github:commit` → `commit`）
 *   3. 清单里的技能名带前缀而记录是裸名（反过来）
 *
 * ⚠️ 一个技能可能匹配到**多条**使用记录（`documents:xlsx`、`spreadsheets:xlsx`
 * 都指向同一个 xlsx 技能）。这些记录要合并成一条，不能各占一行——
 * 第一版就是没合并，结果列表里 xlsx 出现三次、computer-use 出现两次，
 * 看起来像"装了三个 xlsx"。
 *
 * 匹配不上的是"用了但本机没装"——可能是已删的技能、或别处的技能，
 * 单独报出来，因为它说明清单有缺口。
 */
export function joinUsage(skills, usage) {
  const usageList = [...usage.bySkill.entries()].map(([skill, count]) => ({
    skill,
    count,
    aliases: skillAliases(skill),
  }));

  const matched = new Set();
  const byName = new Map(); // 技能名 → { calls, rawNames:Set }

  for (const s of skills) {
    const hits = [];
    for (const u of usageList) {
      if (u.skill === s.name || u.aliases.includes(s.name)) {
        hits.push(u);
      } else if (s.aliases && s.aliases.some((a) => u.skill === a || u.aliases.includes(a))) {
        hits.push(u);
      }
    }
    if (!hits.length) continue;

    for (const h of hits) matched.add(h.skill);
    byName.set(s.name, {
      calls: hits.reduce((n, h) => n + h.count, 0),
      // 记下原始写法，让用户知道"它是以 github:commit 这种名字被调的"
      rawNames: [...new Set(hits.map((h) => h.skill))],
    });
  }

  const used = skills
    .filter((s) => byName.has(s.name))
    .map((s) => ({
      ...s,
      calls: byName.get(s.name).calls,
      calledAs: byName.get(s.name).rawNames,
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const unused = skills.filter((s) => !byName.has(s.name));

  // 用了但清单里没有的
  const unknown = usageList
    .filter((u) => !matched.has(u.skill))
    .map((u) => ({ skill: u.skill, calls: u.count }))
    .sort((a, b) => b.calls - a.calls);

  // 同名不同内容的技能：本机 xlsx 有 3 份（zcode 两个版本 + hermes 一份），
  // 哈希不同就是不同的文件。它们各自匹配到同一批使用记录——
  // 这不是 join 的 bug，是"同名技能确实有多个实现"。
  // 但要标出来，否则列表里三个 xlsx 看着像重复行。
  const nameCount = new Map();
  for (const s of skills) nameCount.set(s.name, (nameCount.get(s.name) || 0) + 1);
  for (const u of used) {
    if (nameCount.get(u.name) > 1) u.sameNameCount = nameCount.get(u.name);
  }

  return { used, unused, unknown };
}

/**
 * 使用率摘要，给 CLI / MCP / 网页用。
 */
export function skillUsageSummary({ fresh = false } = {}) {
  // 延迟 import：skills.js 会扫磁盘，CLI 的其它命令不需要付这个成本
  return import('./skills.js').then(({ scanSkills, groupByHash }) => {
    const usage = scanSkillUsage({ fresh });
    if (!usage.ready) {
      return { ready: false, message: usage.message };
    }

    const { installs } = scanSkills();
    const groups = groupByHash(installs);
    const { used, unused, unknown } = joinUsage(groups, usage);

    const totalCalls = used.reduce((n, s) => n + s.calls, 0);

    return {
      ready: true,
      // 会话侧的数字
      calls: totalCalls,
      sessionsWithSkill: usage.sessions,
      // 清单侧的数字
      installed: groups.length,
      usedCount: used.length,
      unusedCount: unused.length,
      // 用了但清单里没有：说明清单有缺口，值得单独看
      unknownCount: unknown.length,
      // 这个数字只覆盖显式调用 Skill 工具的 Agent（见文件头说明），
      // 是下限而非全貌。调用方需要知道这一点再下结论。
      coverage: {
        agentsWithSkillTool: [...new Set(usage.calls.map((c) => c.agent))].sort(),
        note: '只统计显式调用 Skill 工具的记录。Codex 等直接读 SKILL.md 的用法不在内，所以这是下限。',
      },
      top: used.slice(0, 20).map((s) => ({
        name: s.name,
        calls: s.calls,
        agents: s.agents,
        // 它是以什么名字被调用的（github:commit vs commit）
        calledAs: s.calledAs.length > 1 || s.calledAs[0] !== s.name ? s.calledAs : undefined,
        // 同名技能有几份不同实现（内容哈希不同）
        sameNameCount: s.sameNameCount,
      })),
      neverUsed: unused.slice(0, 40).map((s) => ({ name: s.name, agents: s.agents })),
      unknown: unknown.slice(0, 20),
      cached: usage.cached,
    };
  });
}
