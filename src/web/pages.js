/**
 * 网页层的七个页面。
 *
 * 分工和 CLI 保持一致：页面只读数据、只做展示，不写任何东西。
 * 视图层（模型写的摘要）和事实层（会话、换手、用量）在版式上始终分开：
 * 摘要永远是带"视图层"标签的一张卡，事实永远是表格或时间线。
 */

import {
  listProjects,
  projectTimeline,
  groupByAgent,
  findSessions,
  readSessionContent,
} from '../query.js';
import { search, indexStats } from '../search.js';
import { latestProjectDigest, latestSessionSummary } from '../digest.js';
import { projectHandoffs, pickHandoffs } from '../handoff.js';
import { quickFreshness } from '../refresh.js';
import { durationMs, tildify } from '../model.js';
import { summarizeUsage } from '../usage.js';
import { fullInventory, auditEnvironment } from '../env/inventory.js';
import { skillUsageSummary } from '../env/usage.js';
import { usageSnapshot, projectMemoryInfo } from './data.js';
import {
  layout,
  pageHead,
  sectionHead,
  statGrid,
  card,
  table,
  tabsNav,
  badge,
  agentChip,
  agentStack,
  sparkline,
  sparkSvg,
  stackBar,
  callout,
  emptyState,
  commandLine,
  copyButton,
  apiBlock,
  lastSegment,
} from './ui.js';
import {
  esc,
  fmtDate,
  fmtDay,
  fmtRel,
  fmtTime,
  fmtDur,
  fmtTok,
  pct,
  oneLine,
  summarizeInput,
  highlight,
  looksLikeMarkdown,
  renderMarkdownLite,
  renderTextBlocks,
  seriesFromDays,
  activitySeries,
  agentColor,
} from './format.js';
import { icon } from './icons.js';

/* ------------------------------ 项目列表 ------------------------------ */

export async function pageProjects() {
  const { projects, totalSessions, subagentSessions, stats, unbound } = listProjects({});
  const agentCount = Object.keys(stats.byAgent || {}).length;

  const rows = projects.map((p) => {
    const href = `/p?path=${encodeURIComponent(p.display)}`;
    const series = activitySeries(
      p.sessions.map((s) => s.start).filter(Boolean),
      { days: 14 }
    );
    const names = p.agents.slice(0, 2).join(' · ');
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:9px;min-width:0">
          <span class="stat-icon" style="width:28px;height:28px;border-radius:7px">${icon('folder', 14)}</span>
          <div style="min-width:0">
            <a class="row-link strong" href="${esc(href)}">${esc(lastSegment(tildify(p.display)))}</a>
            <span class="sub mono truncate" title="${esc(tildify(p.display))}">${esc(tildify(p.display))}</span>
          </div>
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:10px;justify-content:flex-end">
          ${sparkSvg(series)}
          <span class="strong" style="min-width:28px;text-align:right">${p.count}</span>
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          ${agentStack(p.agents)}
          <span class="subtle small truncate" title="${esc(p.agents.join(', '))}">${esc(names)}${
            p.agents.length > 2 ? ` +${p.agents.length - 2}` : ''
          }</span>
        </div>
      </td>
      <td class="nowrap" title="${esc(fmtDate(p.end))}">${esc(fmtRel(p.end))}</td>
      <td class="row-hover-arrow">${icon('chevronRight', 14)}</td>
    </tr>`;
  });

  const unboundHtml = unbound
    ? `<section class="section">
        ${sectionHead({
          title: `无项目归属 · ${unbound.count} 场`,
          desc: '这类 Agent 不绑定工作目录（例如聊天渠道入口），进不了任何项目时间线，但不该在档案馆里消失。',
        })}
        <div class="table-wrap">
          ${table({
            wrap: false,
            head: ['Agent', { label: '会话', num: true }, '最近'],
            rows: unbound.agents.map(
              (a) => `<tr>
                <td>${agentChip(a.agent)}</td>
                <td class="num">${a.count}</td>
                <td class="nowrap" title="${esc(fmtDate(a.end))}">${esc(fmtRel(a.end))}</td>
              </tr>`
            ),
          })}
        </div>
      </section>`
    : '';

  const body = `<div class="page-head">
      <div>
        <div class="eyebrow">${icon('archive', 13)} 会话层</div>
        <h1 class="page-title">会话档案馆</h1>
        <p class="lead">${projects.length} 个项目 · ${totalSessions} 场主会话${
          subagentSessions ? ` · ${subagentSessions} 场子代理` : ''
        } · ${stats.files} 个文件 · ${agentCount} 家 Agent。数据来自本机真实会话。</p>
      </div>
      <div class="head-actions">
        <a class="btn outline" href="/usage">${icon('chart', 15)} 用量</a>
        <a class="btn outline" href="/env">${icon('layers', 15)} 能力面</a>
      </div>
    </div>
    ${statGrid([
      { label: '项目', value: String(projects.length), sub: '有归属的工作目录', icon: 'folder' },
      { label: '主会话', value: String(totalSessions), sub: '可作为时间线主线', icon: 'message' },
      {
        label: '子代理会话',
        value: String(subagentSessions || 0),
        sub: '父会话内部的步骤',
        icon: 'branch',
      },
      { label: 'Agent', value: String(agentCount), sub: '本机有数据来源', icon: 'users' },
      {
        label: '已扫描文件',
        value: String(stats.files),
        sub: stats.cached ? `${stats.cached} 命中缓存` : `${stats.parsed ?? stats.files} 本次解析`,
        icon: 'file',
      },
    ])}
    <section class="section" style="margin-top:0">
      ${sectionHead({
        title: '项目',
        desc: '按最近活跃排序。柱状图是最近 14 天的会话分布。',
      })}
      <div class="table-wrap">
        <div class="table-toolbar">
          <label class="filter">
            ${icon('search', 14)}
            <input type="search" data-filter="projects-table" placeholder="筛选项目或 Agent…" autocomplete="off">
          </label>
          <span class="filter-count" data-filter-count="projects-table"></span>
        </div>
        ${table({
          wrap: false,
          id: 'projects-table',
          className: 'projects',
          head: [
            '项目',
            { label: '会话 / 14 天', num: true },
            'Agent',
            '最近',
            { label: '', width: '28px' },
          ],
          rows: rows.length
            ? rows
            : [
                `<tr><td colspan="5" class="dim">还没有识别到项目。运行 <code>agent-archive projects</code> 看看扫描器读到了什么。</td></tr>`,
              ],
        })}
      </div>
    </section>
    ${unboundHtml}
    ${apiBlock([
      'GET /api/projects',
      'GET /api/timeline?path=',
      'GET /api/agents?path=',
      'GET /api/search?q=',
      'GET /api/session?agent=&id=',
      'GET /api/usage?by=',
    ])}`;

  return layout({ title: '项目', page: 'projects', crumb: [{ label: '项目' }], body });
}

/* ------------------------------ 项目详情 ------------------------------ */

export async function pageTimeline(target, openAll) {
  if (!target) return pageNotFound('缺少项目路径');

  const r = projectTimeline(target, {});
  const title = tildify(r.target);

  if (!r.sessions.length) {
    return layout({
      title,
      page: 'project',
      currentProject: r.target,
      crumb: [{ label: '项目', href: '/' }, { label: lastSegment(title) }],
      body: `${pageHead({
        eyebrow: '项目',
        eyebrowIcon: 'folder',
        title: esc(title),
        titleClass: 'mono',
        lead: '这个项目下没有找到会话。',
        actions: `<a class="btn outline" href="/">${icon('arrowLeft', 15)} 所有项目</a>`,
      })}
      ${emptyState({
        icon: 'inbox',
        title: '没有会话',
        desc: '路径可能拼错了，或者这个目录下确实还没有任何 Agent 写过东西。',
        action: `<a class="btn outline" href="/">回到项目列表</a>`,
      })}`,
    });
  }

  const groups = groupByAgent(r.sessions);
  const summary = r.summary;
  const spanDays = summary.first && summary.last ? Math.max(1, Math.round((summary.last - summary.first) / 86400000)) : 0;

  let h = null;
  try {
    h = projectHandoffs(r.target, {});
  } catch {
    h = null;
  }
  const mem = await projectMemoryInfo(r.target).catch(() => null);

  const dg = (() => {
    try {
      return latestProjectDigest(r.target);
    } catch {
      return null;
    }
  })();

  const usage = await projectUsageCard(r.sessions).catch(() => '');

  const LIMIT = 300;
  const all = r.sessions;
  const shown = all.length > LIMIT && !openAll ? all.slice(-LIMIT) : all;
  const hidden = all.length - shown.length;

  const series = seriesFromDays(summary.days, { count: 30 });
  const activityTotal = series.reduce((n, x) => n + x.n, 0);

  let timeline = '';
  const byDay = new Map();
  for (const s of shown) {
    const d = s.start ? fmtDay(s.start) : '未知日期';
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  for (const [d, list] of byDay) {
    timeline += `<div class="day-head"><b>${esc(weekdayLabel(d))}</b><span>${list.length} 场</span><span class="rule"></span></div>`;
    for (const s of list) {
      const href = `/s?agent=${encodeURIComponent(s.agent)}&id=${encodeURIComponent(s.id)}`;
      const kind = s.kind === 'subagent' ? ` ${badge('子代理', 'outline')}` : '';
      timeline += `<a class="srow" href="${esc(href)}">
        <time>${esc(s.start ? fmtTime(s.start) : '—')}</time>
        <span style="--agent:${agentColor(s.agent)}"><span class="agent-dot"></span></span>
        <span class="title" title="${esc(s.title)}">${esc(s.title)}${kind}</span>
        <span class="dur">${esc(fmtDur(durationMs(s)) || '—')}</span>
        ${agentChip(s.agent)}
        <span class="go">${icon('chevronRight', 14)}</span>
      </a>`;
    }
  }

  const agentBar = groups
    .map(([a, ss]) => agentChip(a, { count: ss.length }))
    .join('');

  const leadBits = [
    `${summary.count} 场主会话`,
    summary.subagentCount ? `${summary.subagentCount} 场子代理` : '',
    `${groups.length} 家 Agent`,
    `${fmtDate(summary.first)} → ${fmtDate(summary.last)}`,
    `累计 ${fmtDur(summary.totalMs) || '—'}`,
  ].filter(Boolean);

  const actions = `<a class="btn outline" href="/export?kind=timeline&path=${encodeURIComponent(
    r.target
  )}">${icon('download', 15)} 时间线 .md</a>
    <a class="btn outline" href="/export?kind=bundle&path=${encodeURIComponent(
      r.target
    )}">${icon('download', 15)} 全部会话 .md</a>`;

  const body = `${pageHead({
    eyebrow: '项目',
    eyebrowIcon: 'folder',
    title: esc(title),
    titleClass: 'mono',
    lead: leadBits.join(' · '),
    actions,
  })}
  <div class="chip-row">${agentBar}${copyButton(r.target, '复制项目路径')}</div>
  ${statGrid([
    { label: '主会话', value: String(summary.count), sub: '按开始时间排序', icon: 'message' },
    { label: '参与 Agent', value: String(groups.length), sub: '名字与场次见下方标签', icon: 'users' },
    { label: '跨度', value: spanDays ? `${spanDays} 天` : '—', sub: '首场到最后一场', icon: 'calendar' },
    { label: '累计时长', value: fmtDur(summary.totalMs) || '—', sub: '各会话时长之和', icon: 'clock' },
  ])}
  ${handoffCard(h, mem, r.target)}
  ${usage}
  ${dg ? digestCard({ dg, sessions: r.sessions, kind: 'project' }) : digestMissing(r.target)}
  <section class="card">
    <div class="card-head">
      <div>
        <h2 class="card-title">${icon('activity', 15)} 最近 30 天</h2>
        <p class="card-desc">${activityTotal} 场会话 · 每个柱子是一天</p>
      </div>
      ${badge(`共 ${summary.count} 场`, 'outline')}
    </div>
    <div class="card-body">
      ${sparkline(series, { big: true, label: '场' })}
      <div class="legend">
        <span>${esc(series[0] ? series[0].key.slice(5) : '')}</span>
        <span class="push" style="margin-left:auto">${esc(series[series.length - 1] ? series[series.length - 1].key.slice(5) : '')}</span>
      </div>
    </div>
  </section>
  <section class="section">
    ${sectionHead({
      title: '时间线',
      desc: '按天分组，同一行是一场会话；点开进入正文。',
      actions: hidden
        ? `<a class="btn outline sm" href="/p?path=${encodeURIComponent(r.target)}&all=1">显示全部 ${all.length} 场</a>`
        : '',
    })}
    ${
      hidden
        ? `<div class="callout info" style="margin-bottom:8px">${icon('info', 15)}<div>默认只渲染最近 ${LIMIT} 场，更早的 ${hidden} 场没有显示。需要全部请用右侧按钮，或直接读 <code>/api/timeline?path=</code>。</div></div>`
        : ''
    }
    <div class="timeline">${timeline}</div>
  </section>
  ${apiBlock([
    `GET /api/timeline?path=${encodeURIComponent(title)}`,
    `GET /api/handoff?path=${encodeURIComponent(title)}`,
    `GET /api/agents?path=${encodeURIComponent(title)}`,
    `GET /api/digest?path=${encodeURIComponent(title)}`,
  ])}`;

  return layout({ title, page: 'project', crumb: [{ label: '项目', href: '/' }, { label: lastSegment(title) }], currentProject: r.target, body });
}

/** "接手卡"：换 Agent 之前最要紧的三件事。 */
function handoffCard(h, mem, target) {
  if (!h || !h.sessions) return '';
  const lastRun = h.runList && h.runList.length ? h.runList[h.runList.length - 1] : null;
  const lastSession = lastRun && lastRun.lastSession;
  const median = h.summary.medianGapMs;
  const stale = h.summary.stale;
  const overlap = h.summary.overlap;

  const lastValue = h.singleAgent
    ? `${esc(h.agents[0] || '?')} 一家做完`
    : lastRun
      ? `${esc(lastRun.agent)} 手上`
      : '—';

  const breakValue = h.singleAgent ? '没有换手' : `${h.handoffCount} 次换手`;

  const breakSub = h.singleAgent
    ? '从第一场到最后一场都是同一家'
    : [
        stale ? `${stale} 次间隔超过一周` : '没有长期中断',
        median != null ? `中位间隔 ${fmtDur(median) || '0'}` : '',
        overlap ? `${overlap} 次并行` : '',
      ]
        .filter(Boolean)
        .join(' · ');

  const memValue = mem ? `${mem.locations} 处 · ${mem.entries} 条` : '没有项目级记忆';
  const memSub = mem
    ? `${esc(mem.agents.join('、'))} 写过 · <a href="/env?tab=memory">看记忆 →</a>`
    : `换 Agent 后旧结论不会自动跟过去 · <a href="/env?tab=memory">看全部记忆 →</a>`;

  return `<section class="handoff-grid" aria-label="接手概况">
    <div class="handoff-cell">
      <div class="handoff-k">${icon('gitPull', 13)} 最后停在</div>
      <div class="handoff-v">${lastValue}</div>
      <div class="handoff-sub">${
        lastSession
          ? `${lastRun.count} 场 · ${esc(fmtRel(lastSession.end))}结束<br>最后一场：<a href="/s?agent=${encodeURIComponent(
              lastSession.agent
            )}&id=${encodeURIComponent(lastSession.id)}">${esc(oneLine(lastSession.title, 42))}</a>`
          : '没有可用的会话时间戳'
      }</div>
    </div>
    <div class="handoff-cell">
      <div class="handoff-k">${icon('clock', 13)} 换手断点</div>
      <div class="handoff-v">${esc(breakValue)}</div>
      <div class="handoff-sub">${esc(breakSub)}${
        h.singleAgent ? '' : ` · <a href="/handoff?path=${encodeURIComponent(target)}">看接力详情 →</a>`
      }</div>
    </div>
    <div class="handoff-cell">
      <div class="handoff-k">${icon('book', 13)} 项目记忆</div>
      <div class="handoff-v">${esc(memValue)}</div>
      <div class="handoff-sub">${memSub}</div>
    </div>
  </section>`;
}

/** 项目页的用量卡：只统计本项目的会话，口径与 /usage 一致。 */
async function projectUsageCard(sessions) {
  if (!sessions.length) return '';
  let snap;
  try {
    snap = await usageSnapshot();
  } catch {
    return '';
  }
  const { r, catalog } = snap;
  if (!r.ready) return '';

  const keys = new Set(sessions.map((s) => `${s.agent}|${s.id}`));
  const rows = r.rows.filter((x) => x.session && keys.has(`${x.agent}|${x.session}`));
  if (!rows.length) return '';

  const groups = summarizeUsage({ rows, groupBy: 'agent', catalog });
  const known = groups.filter((g) => !g.semantics.includes('unknown'));
  const unknown = groups.filter((g) => g.semantics.includes('unknown'));
  const unknownRecords = unknown.reduce((a, g) => a + g.rows, 0);
  const unknownTokens = unknown.reduce((a, g) => a + g.fresh, 0);

  if (!known.length) {
    return card({
      title: `${icon('chart', 15)} 用量`,
      desc: '来自本项目会话的模型记账',
      body: callout(
        `${unknownRecords} 场会话共 ${fmtTok(unknownTokens)} token，但来源只给了会话级总量、看不出缓存口径，不做成本估算。`,
        { tone: 'info', icon: 'info' }
      ),
      foot: `<a href="/usage?by=project">看全部项目的用量 →</a>`,
    });
  }

  const t = known.reduce(
    (a, g) => {
      a.fresh += g.fresh;
      a.output += g.output;
      a.cacheRead += g.cacheRead;
      a.cost += g.cost || 0;
      a.costEst += g.costEst || 0;
      return a;
    },
    { fresh: 0, output: 0, cacheRead: 0, cost: 0, costEst: 0 }
  );
  const cost = t.cost > 0 ? `$${t.cost.toFixed(2)}` : t.costEst > 0 ? `~$${t.costEst.toFixed(2)}` : '—';
  const hit = t.fresh + t.cacheRead > 0 ? t.cacheRead / (t.fresh + t.cacheRead) : null;

  return `<section class="card">
    <div class="card-head">
      <div>
        <h2 class="card-title">${icon('chart', 15)} 用量</h2>
        <p class="card-desc">来自 ${rows.length} 条模型请求的记账${
          unknownRecords ? ` · 另有 ${unknownRecords} 场只有总量（${fmtTok(unknownTokens)}），未计入` : ''
        }</p>
      </div>
    </div>
    <div class="card-body">
      <div class="strip">
        <div><div class="k">未缓存输入</div><div class="v">${fmtTok(t.fresh)}</div></div>
        <div><div class="k">输出</div><div class="v">${fmtTok(t.output)}</div></div>
        <div><div class="k">缓存读</div><div class="v">${fmtTok(t.cacheRead)}</div></div>
        <div><div class="k">缓存命中</div><div class="v">${hit == null ? '—' : pct(hit)}</div></div>
        <div><div class="k">成本</div><div class="v">${cost}</div></div>
      </div>
    </div>
    <div class="card-foot">
      <span><code>~$</code> 是按价目表估算，不是账单。</span>
      <a class="push" href="/usage?by=project">看全部项目的用量 →</a>
    </div>
  </section>`;
}

/* ------------------------------ 摘要 ------------------------------ */

function digestCard({ dg, sessions, kind }) {
  const fresh = quickFreshness({
    kind: kind === 'session' ? 'session' : 'project',
    artifact: dg,
    projectSessions: sessions,
  });
  const stale = fresh && fresh.status === 'possibly-stale';

  const badges = [
    badge('视图层', 'outline'),
    badge(dg.model || '未知模型'),
    badge(`${fmtDate(dg.createdAt)} 生成`),
    stale ? badge('可能已过期', 'warn', 'alert') : '',
  ]
    .filter(Boolean)
    .join('');

  const staleDetail = stale
    ? callout(
        `<b>这份摘要可能已经不准了：</b><ul style="margin:6px 0 0;padding-left:18px">${fresh.issues
          .map((i) => `<li>${esc(i.detail)}</li>`)
          .join('')}</ul>${
          fresh.unchecked && fresh.unchecked.length
            ? `<div style="margin-top:6px">网页上只做了不花钱的检查。${esc(
                fresh.unchecked[0]
              )}查不了——要准确结论请运行 <code>agent-archive refresh</code>。</div>`
            : ''
        }`,
        { tone: 'warn', icon: 'alert' }
      )
    : '';

  return `<section class="card digest-card" style="margin-top:16px">
    <div class="digest-head">
      <div>
        <h2 class="card-title">${icon('sparkles', 15)} ${kind === 'session' ? '会话摘要' : '项目摘要'}</h2>
        <div class="digest-meta">${badges}</div>
      </div>
    </div>
    <div class="card-body">
      ${staleDetail}
      <div class="clamp" id="digest-clamp">
        <div class="markdown">${renderMarkdownLite(dg.text)}</div>
      </div>
    </div>
    <div class="card-foot">
      <span>模型生成的视图，不是原始事实。核对细节请点开下面的${kind === 'session' ? '原始对话' : '会话'}。</span>
      <button class="btn ghost sm push" type="button" data-expand="digest-clamp" hidden>展开摘要 ${icon('chevronDown', 12)}</button>
    </div>
  </section>`;
}

function digestMissing(target) {
  const cmd = `agent-archive digest "${target}"`;
  return `<div class="callout" style="margin-top:16px">
    ${icon('sparkles', 15)}
    <div><b>项目摘要</b> ${badge('视图层 · 可选', 'outline')} 还没有生成。运行 <code>${esc(
      cmd
    )}</code> 先看预估成本，确认后加 <code>--run</code>。
    <button class="copy-btn" type="button" data-copy="${esc(cmd)}" aria-label="复制摘要命令">${icon(
      'copy',
      14
    )}</button></div>
  </div>`;
}

/* ------------------------------ 会话 ------------------------------ */

export async function pageSession(agent, id) {
  if (!id) return pageNotFound('缺少会话 id');

  const { matches } = findSessions({ query: id, agent });
  if (!matches.length) return pageNotFound(`没有匹配 ${id} 的会话`);

  const session = matches[0];
  const crumb = [
    { label: '项目', href: '/' },
    session.project
      ? { label: lastSegment(tildify(session.project)), href: `/p?path=${encodeURIComponent(session.project)}` }
      : null,
    { label: '会话' },
  ].filter(Boolean);

  if (matches.length > 1) {
    return layout({
      title: '多场匹配',
      page: 'session',
      crumb,
      currentProject: session.project || '',
      body: `${pageHead({
        eyebrow: '会话',
        eyebrowIcon: 'message',
        title: `${esc(id)} 匹配 ${matches.length} 场`,
        lead: '同一个前缀命中了多场会话，请选一场。',
      })}
      <div class="table-wrap">
        ${table({
          wrap: false,
          head: ['Agent', '开始', '会话'],
          rows: matches.map(
            (s) => `<tr>
              <td>${agentChip(s.agent)}</td>
              <td class="nowrap">${esc(fmtDate(s.start))}</td>
              <td><a class="row-link" href="/s?agent=${encodeURIComponent(s.agent)}&id=${encodeURIComponent(
                s.id
              )}">${esc(s.title)}</a><span class="sub mono">${esc(s.id)}</span></td>
            </tr>`
          ),
        })}
      </div>`,
    });
  }

  let messages;
  try {
    messages = await readSessionContent(session);
  } catch (e) {
    return layout({
      title: '读不了',
      page: 'session',
      crumb,
      currentProject: session.project || '',
      body: `${pageHead({
        eyebrow: '会话',
        eyebrowIcon: 'message',
        title: '读不了这场会话',
        lead: esc(e && e.message ? e.message : String(e)),
      })}
      <a class="btn outline" href="/">${icon('arrowLeft', 15)} 回到项目列表</a>`,
    });
  }

  const exportHref = `/export?kind=session&agent=${encodeURIComponent(
    session.agent
  )}&id=${encodeURIComponent(session.id)}`;

  const ss = (() => {
    try {
      return latestSessionSummary(session);
    } catch {
      return null;
    }
  })();

  const digest = ss ? digestCard({ dg: ss, sessions: [], kind: 'session' }) : '';

  // 有些 Agent 的标题是「会话 id + 第一句」，id 已经在下面的元信息里，
  // 标题只留人话，免得一屏都是 uuid。
  const rawTitle = String(session.title || session.id);
  const displayTitle = rawTitle.startsWith(session.id) ? rawTitle.slice(session.id.length).trim() : rawTitle;
  const title = displayTitle || session.id;

  const body = `${pageHead({
    eyebrow: '会话',
    eyebrowIcon: 'message',
    title: esc(title),
    actions: `<a class="btn outline" href="${esc(exportHref)}">${icon('download', 15)} 导出 .md</a>`,
  })}
  <div class="chip-row">
    ${agentChip(session.agent)}
    ${badge(`${fmtDate(session.start)} → ${fmtDate(session.end)}`)}
    ${fmtDur(durationMs(session)) ? badge(`时长 ${fmtDur(durationMs(session))}`) : ''}
    ${badge(`${messages.length} 条消息`)}
    <span class="mono small subtle">${esc(session.id)}</span>
    ${copyButton(session.id, '复制会话 id')}
  </div>
  ${
    session.resume
      ? `<div class="cmd" style="margin:0 0 16px"><code>${esc(session.resume)}</code>${copyButton(
          session.resume,
          '复制恢复命令'
        )}</div>`
      : ''
  }
  ${digest}
  <section class="section" style="margin-top:${digest ? '18px' : '4px'}">
    ${sectionHead({
      title: '对话',
      desc: '工具入参与输出默认折叠，展开时才取全文；文字内容不改写。',
      actions: `<a class="btn ghost sm" href="#main">${icon('arrowUp', 13)} 顶部</a>`,
    })}
    <div class="msg-list" id="messages" data-agent="${esc(session.agent)}" data-session="${esc(session.id)}">
      ${messages.map((m, i) => renderMessageHtml(m, i)).join('') ||
        `<div class="empty"><h3>这场会话没有可显示的消息</h3></div>`}
    </div>
  </section>
  ${apiBlock([
    `GET /api/session?agent=${encodeURIComponent(session.agent)}&id=${encodeURIComponent(session.id)}`,
    `GET /api/session?...&message=N`,
    `GET /export?kind=session&agent=&id=`,
  ])}`;

  return layout({
    title,
    page: 'session',
    crumb,
    currentProject: session.project || '',
    body,
  });
}

/**
 * 消息渲染。
 *
 * 正文直接显示；工具调用和推理只给摘要，展开时才去 /api/session 取那一条。
 * 一场大对话的推理加工具输出常常几十万字，全量内联会把页面撑到几百 KB。
 */
function renderMessageHtml(m, index) {
  const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具' : '系统';
  const when = m.ts ? fmtTime(m.ts) : '';
  const meta = m.meta && m.meta.kind ? badge(m.meta.kind, 'outline') : '';

  if (m.role === 'system') {
    const chars = m.parts.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
    const first = m.parts.find((p) => p.kind === 'text');
    const peek = first ? oneLine(first.text, 180) : '';
    return `<details class="system">
      <summary>${esc(fmtTime(m.ts))} · ${chars} 字 ${meta}</summary>
      <div class="msg-inner">
        ${peek ? `<div class="prose">${esc(peek)}${chars > 180 ? '…' : ''}</div>` : ''}
        <p class="hint">完整内容见 <code>/api/session</code> 或 CLI 的 <code>cat --system</code>。</p>
      </div>
    </details>`;
  }

  const textHtml = m.parts
    .filter((p) => p.kind === 'text')
    .map((p) =>
      m.role === 'assistant' || (m.role === 'user' && looksLikeMarkdown(p.text))
        ? `<div class="markdown msg-markdown">${renderMarkdownLite(p.text)}</div>`
        : renderTextBlocks(p.text)
    )
    .join('');

  const folded = m.parts.filter((p) => p.kind === 'tool' || p.kind === 'reasoning');
  let foldedSummary = '';
  if (folded.length) {
    if (folded.length <= 3) {
      foldedSummary = folded
        .map((p) =>
          p.kind === 'tool'
            ? `<span class="tool-name">${esc(p.name || 'tool')}</span><span class="tool-args">${esc(
                summarizeInput(p.input)
              )}</span>`
            : `<span class="tool-name" style="color:var(--fg-subtle)">推理</span>`
        )
        .join('<span class="subtle">·</span>');
    } else {
      const tools = folded.filter((p) => p.kind === 'tool');
      const reasons = folded.length - tools.length;
      const names = [...new Set(tools.map((p) => p.name).filter(Boolean))].slice(0, 4);
      const bits = [
        tools.length ? `${tools.length} 个工具调用` : '',
        reasons ? `${reasons} 段推理` : '',
      ].filter(Boolean);
      foldedSummary = `<span class="subtle">${esc(bits.join(' · '))}</span>${names
        .map((n) => `<span class="tool-name">${esc(n)}</span>`)
        .join('')}`;
    }
  }
  const foldedHtml = folded.length
    ? `<details class="folded" data-idx="${index}">
         <summary>${foldedSummary}</summary>
         <div class="folded-body"><p class="hint" style="padding:0 11px 11px">展开时加载…</p></div>
       </details>`
    : '';

  if (!textHtml && !foldedHtml) return '';

  const roleClass = m.role === 'user' || m.role === 'assistant' || m.role === 'tool' ? m.role : 'tool';
  return `<article class="msg ${roleClass}" id="m${index}">
    <div class="msg-rail"></div>
    <div class="msg-inner">
      <header class="msg-head">
        <span class="msg-role">${esc(label)}</span>
        ${when ? `<span class="msg-time">${esc(when)}</span>` : ''}
        ${meta}
        <span class="subtle" style="margin-left:auto;font-size:10.5px">#${index}</span>
      </header>
      <div class="msg-parts">${textHtml}${foldedHtml}</div>
    </div>
  </article>`;
}

/* ------------------------------ 搜索 ------------------------------ */

export async function pageSearch(q, agent, limitParam) {
  const idx = indexStats();
  const form = `<form class="search-hero" action="/search" method="get" role="search">
    ${icon('search', 18)}
    <input type="search" name="q" value="${esc(q)}" placeholder="搜索所有会话的正文、标题、工具调用摘要…" ${
      q ? '' : 'autofocus'
    } autocomplete="off">
    <button class="btn" type="submit">搜索</button>
  </form>`;

  const head = pageHead({
    eyebrow: '会话层',
    eyebrowIcon: 'search',
    title: '搜索',
    lead: idx.exists
      ? `已索引 ${idx.docs} 场会话 · ${(idx.chars / 1e6).toFixed(1)} M 字${
          idx.builtAt ? ` · 建于 ${esc(fmtDate(idx.builtAt))}` : ''
        }。搜的是人说的话和工具调用摘要，不含完整工具输出。`
      : '全文索引还没有建。搜索需要先跑一次 index；建完之后的查询是即时的。',
  });

  if (!idx.exists) {
    return layout({
      title: '搜索',
      page: 'search',
      crumb: [{ label: '搜索' }],
      body: `${head}
      ${form}
      <div style="margin-top:16px">
        ${emptyState({
          icon: 'database',
          title: '还没有全文索引',
          desc: '在终端里运行一次即可。全量建一次约一分多钟，之后只处理变过的会话。',
          action: commandLine('agent-archive index', '复制建索引命令'),
        })}
      </div>`,
    });
  }

  if (!q.trim()) {
    return layout({
      title: '搜索',
      page: 'search',
      crumb: [{ label: '搜索' }],
      body: `${head}
      ${form}
      <div class="section" style="margin-top:20px">
        ${emptyState({
          icon: 'search',
          title: '输入关键词开始搜索',
          desc: '中文按二字组切开，英文按词。搜索范围包括标题、正文和工具调用的一行摘要。',
        })}
      </div>`,
    });
  }

  const LIMIT = limitParam === '50' ? 50 : 20;
  const r = search(q, { limit: LIMIT + 1, agent: agent || undefined });
  const hits = r.hits.slice(0, LIMIT);
  const more = r.hits.length > LIMIT;

  if (!r.ready) {
    return layout({
      title: '搜索',
      page: 'search',
      crumb: [{ label: '搜索' }],
      body: `${head}${form}<p class="hint">${esc(r.message || '')}</p>`,
    });
  }

  const items = hits
    .map((h) => {
      const href = `/s?agent=${encodeURIComponent(h.agent)}&id=${encodeURIComponent(h.id)}`;
      let snip = String(h.snippet || '');
      const t = String(h.title || '').trim();
      if (t && snip.trim().startsWith(t)) {
        const rest = snip.trim().slice(t.length);
        // 只有标题后面确实是分隔（空格/中文标点）才去掉，避免把
        // "[... image]" 截成 "] ..." 这种半个词
        if (t.length >= 10 && (/^[\s，。；：、!?！？,.;:]/.test(rest) || rest === '')) {
          snip = rest.replace(/^[\s，。；：、!?！？,.;:]+/, '');
        }
      }
      return `<article class="hit">
        <div class="hit-title">
          <a href="${esc(href)}">${esc(h.title)}</a>
          ${h.kind === 'subagent' ? badge('子代理', 'outline') : ''}
        </div>
        <div class="hit-meta">
          ${agentChip(h.agent)}
          <span class="dot-sep">·</span>
          <span>${esc(fmtDate(h.start))}</span>
          ${
            h.project
              ? `<span class="dot-sep">·</span><a href="/p?path=${encodeURIComponent(
                  h.project
                )}">${esc(tildify(h.project))}</a>`
              : ''
          }
          <span class="dot-sep">·</span>
          <span class="mono">${esc(h.id.slice(0, 12))}</span>
        </div>
        ${snip ? `<div class="hit-snip">${highlight(snip, q)}</div>` : ''}
      </article>`;
    })
    .join('');

  const moreHref = `/search?q=${encodeURIComponent(q)}${agent ? `&agent=${encodeURIComponent(agent)}` : ''}&limit=50`;

  const body = `${pageHead({
    eyebrow: '会话层',
    eyebrowIcon: 'search',
    title: `搜索「${esc(q)}」`,
    lead: `显示 ${hits.length} 场命中${more ? '，还有更多' : ''} · 索引覆盖 ${idx.docs} 场会话。`,
  })}
  ${form}
  <div class="section" style="margin-top:18px">
    ${
      hits.length
        ? `<div class="hits">${items}</div>${
            more && LIMIT < 50
              ? `<div style="margin-top:14px"><a class="btn outline" href="${esc(
                  moreHref
                )}">显示到 50 场 ${icon('chevronRight', 14)}</a></div>`
              : more
                ? `<p class="hint">只显示前 50 场。更多结果请用 <code>/api/search?q=${esc(
                    q
                  )}&amp;limit=</code>。</p>`
                : ''
          }`
        : emptyState({
            icon: 'search',
            title: '没有找到',
            desc: '换个词试试。索引只覆盖已有会话；新会话需要重新跑一次 index。',
            action: commandLine('agent-archive index', '复制更新索引命令'),
          })
    }
  </div>
  ${apiBlock([`GET /api/search?q=${encodeURIComponent(q)}&limit=20`, 'GET /api/session?agent=&id='])}`;

  return layout({ title: `搜索 ${q}`, page: 'search', crumb: [{ label: '搜索' }], body });
}

/* ------------------------------ 用量 ------------------------------ */

const USAGE_TABS = [
  ['agent', 'Agent'],
  ['model', '模型'],
  ['project', '项目'],
  ['day', '日期'],
];

export async function pageUsage(by) {
  const active = USAGE_TABS.some(([k]) => k === by) ? by : 'agent';
  const { r, catalog, catalogInfo } = await usageSnapshot();

  const nav = tabsNav(USAGE_TABS, active, (k) => `/usage?by=${k}`);

  if (!r.ready) {
    return layout({
      title: '用量',
      page: 'usage',
      crumb: [{ label: '用量' }],
      body: `${pageHead({
        eyebrow: '分析',
        eyebrowIcon: 'chart',
        title: '用量',
        lead: '各家 Agent 的库里都没有找到 token 记录。',
      })}
      ${nav}
      ${emptyState({
        icon: 'database',
        title: '没有可读的用量账本',
        desc: r.reports
          .filter((x) => x.reason)
          .map((x) => `${esc(x.display)}：${esc(x.reason)}`)
          .join('<br>'),
      })}`,
    });
  }

  let sessionIndex = [];
  if (active === 'project') {
    const { scanCached } = await import('../registry.js');
    sessionIndex = scanCached({}).sessions.map((s) => ({
      agent: s.agent,
      id: s.id,
      project: s.project,
    }));
  }

  const groups = summarizeUsage({ rows: r.rows, groupBy: active, sessionIndex, catalog });
  const known = groups.filter((g) => !g.semantics.includes('unknown'));
  const unknown = groups.filter((g) => g.semantics.includes('unknown'));

  const tot = known.reduce(
    (a, g) => {
      a.fresh += g.fresh;
      a.output += g.output;
      a.cacheRead += g.cacheRead;
      a.cost += g.cost || 0;
      a.costEst += g.costEst || 0;
      a.costKnown += g.costKnown || 0;
      a.unpriced += g.unpricedRecords || 0;
      a.calls += g.calls || 0;
      return a;
    },
    { fresh: 0, output: 0, cacheRead: 0, cost: 0, costEst: 0, costKnown: 0, unpriced: 0, calls: 0 }
  );
  const unknownRecords = unknown.reduce((a, g) => a + g.rows, 0);
  const unknownTokens = unknown.reduce((a, g) => a + g.fresh, 0);
  const hit = tot.fresh + tot.cacheRead > 0 ? tot.cacheRead / (tot.fresh + tot.cacheRead) : null;

  const maxTokens = Math.max(1, ...known.map((g) => (g.fresh || 0) + (g.output || 0)));

  const headLabel = { agent: 'Agent', model: '模型', project: '项目', day: '日期' }[active];

  const rows = known.map((g) => {
    const tokens = (g.fresh || 0) + (g.output || 0);
    const cost = g.cost != null ? `$${g.cost.toFixed(2)}${g.costUnknown ? '+' : ''}` : g.costEst != null ? `~$${g.costEst.toFixed(2)}` : '—';
    const label = g.key.length > 44 ? g.key.slice(0, 42) + '…' : g.key;
    return `<tr>
      <td class="strong nowrap" title="${esc(g.key)}">${esc(label)}</td>
      <td class="num">${g.rows}</td>
      <td>
        <div style="display:flex;align-items:center;gap:10px;min-width:150px">
          <div class="bar-track" style="flex:1"><div class="bar-fill" style="width:${Math.max(
            2,
            Math.round((tokens / maxTokens) * 100)
          )}%"></div></div>
          <span class="bar-value">${fmtTok(tokens)}</span>
        </div>
      </td>
      <td class="num">${fmtTok(g.fresh)}</td>
      <td class="num">${fmtTok(g.output)}</td>
      <td class="num">${fmtTok(g.cacheRead)}</td>
      <td class="num">${g.cacheHit == null ? '—' : pct(g.cacheHit)}</td>
      <td class="num strong">${cost}</td>
    </tr>`;
  });

  const span = r.range
    ? `${esc(fmtDate(new Date(r.range.start)))} → ${esc(fmtDate(new Date(r.range.end)))}`
    : '—';

  const pricingLine = catalog
    ? `价目表 models.dev · ${catalog.count.toLocaleString('en-US')} 个模型 · 抓取于 ${esc(
        catalog.fetchedAt ? fmtDate(new Date(catalog.fetchedAt)) : '未知'
      )}`
    : `没有价目表：${esc(catalogInfo.reason || '未同步')} · 在终端跑 <code>agent-archive pricing sync</code>`;

  const unknownHtml = unknown.length
    ? card({
        title: `${icon('alert', 15)} 口径未知`,
        desc: '这些来源只给了会话级总量，看不出是否含缓存。它们不参与命中率，也不该和上表比较，更不该加进页头合计。',
        body: `<div class="table-wrap" style="border:0;box-shadow:none">
          ${table({
            wrap: false,
            head: [headLabel, { label: '记录', num: true }, { label: '总量', num: true }],
            rows: unknown.map(
              (g) => `<tr><td class="strong">${esc(g.key)}</td><td class="num">${g.rows}</td><td class="num">${fmtTok(
                g.fresh
              )}</td></tr>`
            ),
          })}
        </div>`,
      })
    : '';

  const sources = r.reports
    .map(
      (x) =>
        `<span class="badge ${x.ready ? 'success' : 'outline'}">${
          x.ready ? icon('check', 11) : ''
        }${esc(x.display)} ${x.ready ? `${x.rows} 条` : esc(x.reason || '没有数据')}</span>`
    )
    .join('');

  const noteHtml = `<details class="api-block" style="margin-top:18px;border:0;padding-top:0">
    <summary>口径说明</summary>
    <ul style="margin:8px 0 0;padding-left:18px;line-height:1.75">
      <li>输入已统一成「不含缓存」。各家的原始字段口径不同，这里先归一。</li>
      <li><code>~$</code> 是按价目表估算，不是账单；<code>+</code> 表示该组只有一部分记录带自报成本。</li>
      <li>合计只算能按请求拆开的部分。口径未知的来源单独一张表，避免一个累计值把整体拉歪。</li>
      ${tot.unpriced ? `<li>另有 ${tot.unpriced} 条既没自报、价目表里也没有价。</li>` : ''}
      ${
        unknownRecords
          ? `<li>另有 ${unknownRecords} 条口径未知的记录（共 ${fmtTok(unknownTokens)}），未计入上面的合计。</li>`
          : ''
      }
    </ul>
    <p class="hint">${pricingLine}</p>
  </details>`;

  const chartTotal = (tot.fresh || 0) + (tot.output || 0) + (tot.cacheRead || 0) || 1;
  const share = (n) => {
    if (!n) return '0%';
    const p = ((n || 0) / chartTotal) * 100;
    return p < 1 ? '<1%' : `${Math.round(p)}%`;
  };

  const body = `${pageHead({
    eyebrow: '分析',
    eyebrowIcon: 'chart',
    title: '用量',
    lead: `${r.rows.length} 条记录 · ${span} · 来自各家 Agent 自己的账本。`,
  })}
  ${nav}
  ${statGrid([
    { label: '未缓存输入', value: fmtTok(tot.fresh), sub: `${fmtTok(tot.calls)} 次调用`, icon: 'arrowUpRight', tone: 'accent' },
    { label: '输出', value: fmtTok(tot.output), sub: '模型写出的 token', icon: 'message', tone: 'info' },
    { label: '缓存读', value: fmtTok(tot.cacheRead), sub: '命中部分', icon: 'database' },
    { label: '缓存命中率', value: hit == null ? '—' : pct(hit), sub: '缓存读 ÷ 总输入', icon: 'target', tone: 'success' },
    {
      label: '估算成本',
      value: tot.costEst > 0 ? `~$${tot.costEst.toFixed(2)}` : '—',
      sub: catalog ? '按价目表估算' : '没有价目表',
      icon: 'chart',
      small: true,
    },
    {
      label: 'Agent 自报',
      value: tot.costKnown > 0 ? `$${tot.cost.toFixed(2)}` : '—',
      sub: tot.costKnown > 0 ? '仅部分 Agent 有' : '没有 Agent 自报',
      icon: 'file',
      small: true,
    },
  ])}
  <section class="card">
    <div class="card-head">
      <div>
        <h2 class="card-title">Token 构成</h2>
        <p class="card-desc">三项不相加成一个"总 token"——缓存读和未缓存输入的计价完全不同。</p>
      </div>
    </div>
    <div class="card-body">
      ${stackBar([
        {
          label: '未缓存输入',
          value: tot.fresh,
          color: 'var(--accent)',
          display: `${fmtTok(tot.fresh)} · ${share(tot.fresh)}`,
        },
        {
          label: '输出',
          value: tot.output,
          color: 'var(--info)',
          display: `${fmtTok(tot.output)} · ${share(tot.output)}`,
        },
        {
          label: '缓存读',
          value: tot.cacheRead,
          color: 'var(--success)',
          display: `${fmtTok(tot.cacheRead)} · ${share(tot.cacheRead)}`,
        },
      ])}
    </div>
  </section>
  <section class="section">
    ${sectionHead({
      title: `按 ${headLabel}`,
      desc: '按未缓存输入加输出排序。条内灰条表示这一组占最大组的比例。',
    })}
    ${
      rows.length
        ? `<div class="table-wrap">${table({
            wrap: false,
            head: [
              headLabel,
              { label: '记录', num: true },
              'Token 量',
              { label: '未缓存输入', num: true },
              { label: '输出', num: true },
              { label: '缓存读', num: true },
              { label: '命中', num: true },
              { label: '成本', num: true },
            ],
            rows,
          })}</div>`
        : emptyState({ icon: 'chart', title: '这一维度没有可比的组', desc: '换一个维度看看。' })
    }
  </section>
  ${unknownHtml}
  <section class="card" style="margin-top:16px">
    <div class="card-head">
      <div>
        <h2 class="card-title">数据来源</h2>
        <p class="card-desc">读的是各家的本地库；只读，不上传。</p>
      </div>
    </div>
    <div class="card-body" style="display:flex;flex-wrap:wrap;gap:6px">${sources}</div>
  </section>
  ${noteHtml}
  ${apiBlock(['GET /api/usage?by=agent|model|project|day'])}`;

  return layout({ title: '用量', page: 'usage', crumb: [{ label: '用量' }], body });
}

/* ------------------------------ 接力 ------------------------------ */

export async function pageHandoff(target, openAll = false) {
  if (!target) return pageHandoffIndex();

  const h = (() => {
    try {
      return projectHandoffs(target, {});
    } catch {
      return null;
    }
  })();

  if (!h || !h.sessions) {
    return layout({
      title: '没有会话',
      page: 'handoff',
      body: `${pageHead({
        eyebrow: '分析',
        eyebrowIcon: 'gitPull',
        title: '跨 Agent 接力',
        lead: '这个项目下没有找到会话。',
        actions: `<a class="btn outline" href="/handoff">${icon('arrowLeft', 15)} 所有项目</a>`,
      })}
      ${emptyState({ icon: 'inbox', title: '没有可统计的会话' })}`,
    });
  }

  const title = tildify(h.project);
  const back = `<a class="btn outline" href="/p?path=${encodeURIComponent(h.project)}">${icon(
    'arrowLeft',
    15
  )} 回项目</a>`;

  if (h.singleAgent) {
    return layout({
      title: `${title} · 接力`,
      page: 'handoff',
      currentProject: h.project,
      crumb: [{ label: '接力', href: '/handoff' }, { label: lastSegment(title) }],
      body: `${pageHead({
        eyebrow: '分析',
        eyebrowIcon: 'gitPull',
        title: '跨 Agent 接力',
        lead: `${title} · ${h.sessions} 场会话`,
        actions: back,
      })}
      ${emptyState({
        icon: 'gitPull',
        title: `全部由 ${h.agents[0] || '同一家'} 完成`,
        desc: '没有换手，也就没有上下文丢失的断点。这不是问题，是一句事实。',
        action: `<a class="btn outline" href="/p?path=${encodeURIComponent(h.project)}">看项目时间线</a>`,
      })}`,
    });
  }

  const s = h.summary;
  const pairs = s.topPairs.length
    ? s.topPairs
        .map((p) => badge(`${p.pair} × ${p.count}`, 'outline'))
        .join('')
    : '';

  const { shown, total, rest } = pickHandoffs(h.handoffs, { all: openAll });
  const rows = shown.map((x, i) => {
    const gap =
      x.gapMs == null
        ? '—'
        : x.kind === 'overlap'
          ? `重叠 ${fmtDur(-x.gapMs) || '0'}`
          : `+${fmtDur(x.gapMs) || '0'}`;
    const gapBadge =
      x.kind === 'overlap'
        ? badge(gap, 'info')
        : x.stale
          ? badge(gap, 'warn')
          : x.kind === 'unknown'
            ? badge(gap, 'outline')
            : badge(gap);
    return `<tr>
      <td class="num subtle">${i + 1}</td>
      <td class="nowrap">${agentChip(x.from)} <span class="subtle">→</span> ${agentChip(x.to)}</td>
      <td>${gapBadge}</td>
      <td>${
        x.fromLastSession
          ? `<a class="row-link" href="/s?agent=${encodeURIComponent(x.from)}&id=${encodeURIComponent(
              x.fromLastSession.id
            )}">${esc(oneLine(x.fromLastSession.title, 56))}</a><span class="sub">${esc(
              fmtDate(x.fromLastSession.end)
            )} · ${x.fromSessions} 场</span>`
          : '—'
      }</td>
      <td>${
        x.toFirstSession
          ? `<a class="row-link" href="/s?agent=${encodeURIComponent(x.to)}&id=${encodeURIComponent(
              x.toFirstSession.id
            )}">${esc(oneLine(x.toFirstSession.title, 56))}</a><span class="sub">${esc(
              fmtDate(x.toFirstSession.start)
            )} · ${x.toSessions} 场</span>`
          : '—'
      }</td>
    </tr>`;
  });

  const body = `${pageHead({
    eyebrow: '分析',
    eyebrowIcon: 'gitPull',
    title: '跨 Agent 接力',
    lead: `${esc(title)} · ${h.sessions} 场会话压成 ${h.runs} 段 · ${h.agentCount} 家 Agent · ${esc(
      fmtDate(h.first)
    )} → ${esc(fmtDate(h.last))}`,
    actions: back,
  })}
  ${statGrid([
    { label: '接续', value: String(s.sequential), sub: '上一段结束后下一段开始', icon: 'gitPull' },
    { label: '并行', value: String(s.overlap), sub: '上一段没结束就开始了', icon: 'users', tone: 'info' },
    { label: '长期中断', value: String(s.stale), sub: '间隔一周以上', icon: 'alert', tone: 'warn' },
    { label: '中位间隔', value: fmtDur(s.medianGapMs) || '—', sub: `最长 ${fmtDur(s.maxGapMs) || '—'}`, icon: 'clock' },
  ])}
  ${swimlane(h)}
  ${
    pairs
      ? `<div class="chip-row" style="margin-top:14px"><span class="subtle small">最常走的接力线</span>${pairs}</div>`
      : ''
  }
  ${callout(
    '「并行」= 上一段还没结束下一段就开始了，不是真正的交接；「长期中断」= 隔了一周以上。间隔越长，新 Agent 越不知道前面发生了什么。',
    { tone: 'info', icon: 'info' }
  )}
  <section class="section">
    ${sectionHead({
      title: `换手点 · ${total} 次`,
      desc: openAll ? '按间隔从大到小排。' : '按间隔从大到小排，默认只列最大的 12 次。',
      actions:
        rest && !openAll
          ? `<a class="btn outline sm" href="/handoff?path=${encodeURIComponent(h.project)}&all=1">显示全部 ${total} 次</a>`
          : openAll
            ? `<a class="btn ghost sm" href="/handoff?path=${encodeURIComponent(h.project)}">只看前 12 次</a>`
            : '',
    })}
    <div class="table-wrap">
      ${table({
        wrap: false,
        className: 'handoff-table',
        head: ['#', '从 → 到', '间隔', '离开时最后一场', '接手时第一场'],
        rows,
      })}
    </div>
  </section>
  ${apiBlock([`GET /api/handoff?path=${encodeURIComponent(title)}`])}`;

  return layout({
    title: `${title} · 接力`,
    page: 'handoff',
    currentProject: h.project,
    crumb: [{ label: '接力', href: '/handoff' }, { label: lastSegment(title) }],
    body,
  });
}

function swimlane(h) {
  const first = h.first ? h.first.getTime() : null;
  const last = h.last ? h.last.getTime() : null;
  if (!first || !last || last <= first) return '';
  const span = last - first;
  const agents = [...new Set(h.runList.map((r) => r.agent))];

  const lanes = agents
    .map((a) => {
      const segs = h.runList
        .filter((r) => r.agent === a)
        .map((r) => {
          const start = (r.start || r.firstSession.start || h.first).getTime();
          const end = (r.end || r.lastSession.end || r.start || h.last).getTime();
          const left = Math.max(0, Math.min(100, ((start - first) / span) * 100));
          const width = Math.max(0.35, Math.min(100 - left, ((end - start) / span) * 100));
          const tip = `${a} · ${fmtDate(new Date(start))} → ${fmtDate(new Date(end))} · ${r.count} 场`;
          return `<span class="lane-seg" style="--agent:${agentColor(a)};left:${left.toFixed(
            2
          )}%;width:${width.toFixed(2)}%" title="${esc(tip)}"></span>`;
        })
        .join('');
      return `<div class="lane">
        <span class="lane-label">${agentChip(a)}</span>
        <span class="lane-track">${segs}</span>
      </div>`;
    })
    .join('');

  return `<section class="card" style="margin-bottom:16px">
    <div class="card-head">
      <div>
        <h2 class="card-title">${icon('activity', 15)} 谁在什么时候接手</h2>
        <p class="card-desc">一段 = 连续同一 Agent 的会话。空白是没人做，或时间戳缺失。</p>
      </div>
    </div>
    <div class="card-body lanes">
      ${lanes}
      <div class="lane-axis"><span>${esc(fmtDate(h.first))}</span><span>${esc(fmtDate(h.last))}</span></div>
    </div>
  </section>`;
}

async function pageHandoffIndex() {
  const { projects } = listProjects({});
  const multi = projects.filter((p) => p.agents.length > 1);

  const ranked = multi
    .map((p) => {
      try {
        const h = projectHandoffs(p.display, {});
        return { p, h };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.h.summary.stale - a.h.summary.stale || b.h.handoffCount - a.h.handoffCount);

  const rankedRows = ranked.map(({ p, h }) => {
    return `<tr>
      <td>
        <a class="row-link strong" href="/handoff?path=${encodeURIComponent(p.display)}">${esc(
          lastSegment(tildify(p.display))
        )}</a>
        <span class="sub mono">${esc(tildify(p.display))}</span>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          ${agentStack(p.agents)}
          <span class="subtle small truncate">${esc(p.agents.slice(0, 2).join(' · '))}${
            p.agents.length > 2 ? ` +${p.agents.length - 2}` : ''
          }</span>
        </div>
      </td>
      <td class="num">${p.count}</td>
      <td class="num">${h.handoffCount}</td>
      <td class="num">${h.summary.stale ? `<span class="badge warn">${h.summary.stale}</span>` : '0'}</td>
      <td class="nowrap" title="${esc(fmtDate(p.end))}">${esc(fmtRel(p.end))}</td>
      <td class="row-hover-arrow">${icon('chevronRight', 14)}</td>
    </tr>`;
  });

  const totals = ranked.reduce(
    (a, { p, h }) => {
      a.sessions += p.count;
      a.handoffs += h.handoffCount;
      a.stale += h.summary.stale;
      return a;
    },
    { sessions: 0, handoffs: 0, stale: 0 }
  );

  const body = `${pageHead({
    eyebrow: '分析',
    eyebrowIcon: 'gitPull',
    title: '跨 Agent 接力',
    lead: `${ranked.length} 个项目被两家以上 Agent 做过。选一个看换手点、间隔和最后一棒停在谁手上。`,
  })}
  ${statGrid([
    { label: '跨 Agent 项目', value: String(multi.length), sub: '两家以上参与', icon: 'gitPull' },
    { label: '会话', value: String(totals.sessions), sub: '这些项目的主会话', icon: 'message' },
    { label: '换手', value: String(totals.handoffs), sub: '连续同一家算一段', icon: 'branch' },
    { label: '长期中断', value: String(totals.stale), sub: '间隔超过一周', icon: 'alert', tone: 'warn' },
  ])}
  ${
    ranked.length
      ? `<div class="table-wrap">${table({
          wrap: false,
          head: ['项目', 'Agent', { label: '会话', num: true }, { label: '换手', num: true }, { label: '长期中断', num: true }, '最近', ''],
          rows: rankedRows,
        })}</div>`
      : emptyState({
          icon: 'gitPull',
          title: '没有跨 Agent 的项目',
          desc: '所有项目都是同一家 Agent 从头做到尾，因此没有接力可以看。',
        })
  }
  ${apiBlock(['GET /projects → /api/projects', 'GET /api/handoff?path='])}`;

  return layout({ title: '跨 Agent 接力', page: 'handoff', crumb: [{ label: '接力' }], body });
}

/* ------------------------------ 能力面 ------------------------------ */

const ENV_TABS = [
  ['overview', '总览'],
  ['mcp', 'MCP'],
  ['skills', '技能'],
  ['usage', '使用率'],
  ['memory', '记忆'],
  ['audit', '体检'],
];

export async function pageEnv(tab) {
  const active = ENV_TABS.some(([k]) => k === tab) ? tab : 'overview';
  const inv = fullInventory();
  const s = inv.summary;

  let body = '';
  if (active === 'overview') body = envOverview(inv);
  else if (active === 'mcp') body = envMcp(inv.mcp);
  else if (active === 'skills') body = envSkills(inv.skills);
  else if (active === 'usage') body = envUsage(await skillUsageSummary({}));
  else if (active === 'memory') body = envMemory(inv.memory);
  else body = envAudit(auditEnvironment());

  const nav = tabsNav(ENV_TABS, active, (k) => `/env?tab=${k}`);

  const page = `${pageHead({
    eyebrow: '环境层',
    eyebrowIcon: 'layers',
    title: '能力面',
    lead: `${s.agentsWithData} 家 Agent 有数据 · ${s.mcpServices} 个 MCP 服务 · ${s.skills} 个技能 · ${s.memoryEntries} 条记忆。只报出处，不替你决定。`,  })}
  ${nav}
  ${body}
  ${apiBlock([
    'GET /api/env',
    'GET /api/env?tab=mcp',
    'GET /api/env?tab=skills',
    'GET /api/env?tab=usage',
    'GET /api/env?tab=memory',
    'GET /api/env?tab=audit',
  ])}
  <p class="hint">环境变量的值不读取、不传输，这里只有键名。</p>`;

  return layout({
    title: '能力面',
    page: active === 'audit' ? 'audit' : 'env',
    crumb: [{ label: '能力面' }],
    body: page,
  });
}

function envOverview(inv) {
  const s = inv.summary;

  const agentRows = inv.agents.map(
    (a) => `<tr>
      <td><span class="strong">${esc(a.display)}</span><span class="sub mono">${esc(a.agent)}</span></td>
      <td class="num">${a.mcp.length}</td>
      <td class="num">${a.skills}</td>
      <td class="num">${a.memory}</td>
      <td>${a.mcp.length ? a.mcp.slice(0, 5).map((m) => badge(m, 'outline')).join('') : '<span class="subtle">—</span>'}${
        a.mcp.length > 5 ? ` <span class="subtle small">+${a.mcp.length - 5}</span>` : ''
      }</td>
    </tr>`
  );

  const mcpRows = inv.mcp.list.map(
    (m) => `<tr>
      <td><span class="strong">${esc(m.service)}</span>${
        m.aliases ? `<span class="sub">别名 ${esc(m.aliases.join(' / '))}</span>` : ''
      }</td>
      <td class="num">${m.agents.length}</td>
      <td>${m.agents.map((a) => agentChip(a)).join(' ')}</td>
      <td>${m.forms.map((f) => badge(f, 'outline')).join(' ')}</td>
    </tr>`
  );

  return `${statGrid([
    { label: 'Agent 有数据', value: String(s.agentsWithData), sub: `识别到 ${s.agentsPresent} 家`, icon: 'users' },
    { label: 'MCP 服务', value: String(s.mcpServices), sub: `${s.mcpRegistrations} 条注册`, icon: 'cpu' },
    { label: '技能', value: String(s.skills), sub: `${s.skillInstalls} 处安装`, icon: 'sparkles' },
    { label: '记忆条目', value: String(s.memoryEntries), sub: `${s.memoryLocations} 处记忆`, icon: 'book' },
  ])}
  <section class="section" style="margin-top:0">
    ${sectionHead({ title: '各 Agent 的能力面', desc: 'MCP 按服务身份归并，技能按内容哈希归并。' })}
    <div class="table-wrap">${table({
      wrap: false,
      head: ['Agent', { label: 'MCP', num: true }, { label: '技能', num: true }, { label: '记忆', num: true }, '配了哪些 MCP'],
      rows: agentRows,
    })}</div>
  </section>
  <section class="section">
    ${sectionHead({ title: 'MCP 服务覆盖', desc: '一家以上配置的服务排前面；分布本身就是信息。' })}
    <div class="table-wrap">${table({
      wrap: false,
      head: ['服务', { label: '家数', num: true }, '分布', '安装形态'],
      rows: mcpRows,
    })}</div>
  </section>`;
}

function envMcp(mcp) {
  const rows = mcp.list.map(
    (s) => `<tr>
      <td><span class="strong">${esc(s.service)}</span>${s.aliases ? `<span class="sub">别名 ${esc(s.aliases.join(' / '))}</span>` : ''}</td>
      <td class="num">${s.registrations}</td>
      <td>${s.agents.map((a) => agentChip(a)).join(' ')}</td>
      <td>${s.forms.map((f) => badge(f, 'outline')).join(' ')}</td>
      <td>${s.envKeys.length ? s.envKeys.map((k) => `<code>${esc(k)}</code>`).join(' ') : '<span class="subtle">—</span>'}</td>
    </tr>`
  );

  const mixed = mcp.mixedForms.length
    ? mcp.mixedForms
        .map(
          (m) => callout(
            `<b>${esc(m.service)}</b>：${esc(m.forms.join(' / '))}。分布在 ${esc(
              m.agents.join('、')
            )}。npx 每次拉最新、本地安装钉版本，两边行为可能不同。`,
            { tone: 'warn', icon: 'alert' }
          )
        )
        .join('')
    : '';

  return `<p class="lead" style="margin-bottom:14px">${mcp.services} 个服务，${mcp.registrations} 条注册。同一个服务在多家的注册按启动指纹归并——不是按名字，否则 <code>supabase</code> 和 <code>adbsupabase</code> 会被算成两个。</p>
  <div class="table-wrap">${table({
    wrap: false,
    head: ['服务', { label: '注册', num: true }, '分布', '形态', '环境变量（仅键名）'],
    rows,
  })}</div>
  ${mixed ? `<div class="section">${mixed}</div>` : ''}`;
}

function envSkills(sk) {
  const byAgent = Object.entries(sk.byAgent)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([a, n]) => `<tr><td>${agentChip(a)}</td><td class="num">${n}</td></tr>`
    );

  const shared = sk.list.filter((s) => s.agents.length > 1);
  const sharedRows = shared.map(
    (s) => `<tr>
      <td class="strong">${esc(s.name)}</td>
      <td class="num">${s.agents.length}</td>
      <td>${s.agents.map((a) => agentChip(a)).join(' ')}</td>
    </tr>`
  );

  const allRows = sk.list.map(
    (s) => `<tr data-skill-row>
      <td class="strong">${esc(s.name)}${s.aliases ? `<span class="sub">别名 ${esc(s.aliases.join(' / '))}</span>` : ''}</td>
      <td class="num">${s.installs || 1}</td>
      <td>${s.agents.map((a) => agentChip(a)).join(' ')}</td>
      <td class="dim" style="font-size:12px">${esc(oneLine(s.description || '', 120))}</td>
    </tr>`
  );

  return `${statGrid([
    { label: '独立技能', value: String(sk.skills), sub: '按 SKILL.md 内容哈希归并', icon: 'sparkles' },
    { label: '安装处', value: String(sk.installs), sub: '同一份装在几处算几处', icon: 'layers' },
    { label: '跨 Agent 共享', value: String(shared.length), sub: '一家以上能看到', icon: 'users' },
    { label: 'Agent 数', value: String(Object.keys(sk.byAgent).length), sub: '有技能目录的', icon: 'cpu' },
  ])}
  <section class="section" style="margin-top:0">
    <div class="two-col">
      <div class="card">
        <div class="card-head"><div><h2 class="card-title">按 Agent 的安装处数</h2></div></div>
        <div class="card-body">
          <div class="table-wrap" style="border:0;box-shadow:none">
            ${table({ wrap: false, head: ['Agent', { label: '技能', num: true }], rows: byAgent })}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2 class="card-title">跨 Agent 共享 · ${shared.length}</h2><p class="card-desc">同一份技能被多家看到。</p></div></div>
        <div class="card-body">
          <div class="table-wrap" style="border:0;box-shadow:none;max-height:320px;overflow:auto">
            ${table({ wrap: false, head: ['技能', { label: '家数', num: true }, '分布'], rows: sharedRows })}
          </div>
        </div>
      </div>
    </div>
  </section>
  <section class="section">
    ${sectionHead({ title: `全部技能 · ${sk.skills}`, desc: '插件缓存里的旧版本已排除；描述来自 SKILL.md。' })}
    <div class="table-wrap" style="max-height:560px;overflow:auto">
      <div class="table-toolbar">
        <label class="filter">${icon('search', 14)}<input type="search" data-filter="skills-table" placeholder="筛选技能名、Agent 或描述…"></label>
        <span class="filter-count" data-filter-count="skills-table"></span>
      </div>
      ${table({
        wrap: false,
        id: 'skills-table',
        className: 'compact',
        head: ['技能', { label: '安装', num: true }, '装在哪', '描述'],
        rows: allRows,
      })}
    </div>
  </section>`;
}

function envUsage(r) {
  if (!r || !r.ready) {
    return `${emptyState({
      icon: 'database',
      title: '还算不出来',
      desc: esc((r && r.message) || '还没有索引。'),
      action: commandLine('agent-archive index', '复制建索引命令'),
    })}`;
  }

  const rate = r.installed ? (r.usedCount / r.installed) * 100 : 0;
  const max = Math.max(1, ...r.top.map((s) => s.calls));

  const topRows = r.top.map((s) => {
    const marks = [];
    if (s.sameNameCount) marks.push(`同名 ${s.sameNameCount} 份实现`);
    if (s.calledAs) marks.push(`调作 ${s.calledAs.join(' / ')}`);
    return `<tr>
      <td class="strong">${esc(s.name)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:10px;min-width:160px">
          <div class="bar-track" style="flex:1"><div class="bar-fill" style="width:${Math.max(
            2,
            Math.round((s.calls / max) * 100)
          )}%"></div></div>
          <span class="bar-value">${s.calls}</span>
        </div>
      </td>
      <td>${s.agents.map((a) => agentChip(a)).join(' ')}</td>
      <td class="dim" style="font-size:12px">${esc(marks.join(' · '))}</td>
    </tr>`;
  });

  const neverRows = r.neverUsed.map(
    (s) => `<tr><td class="strong">${esc(s.name)}</td><td>${s.agents.map((a) => agentChip(a)).join(' ')}</td></tr>`
  );

  const unknown = r.unknownCount
    ? `<section class="section">
        ${sectionHead({ title: `用了但清单里没有 · ${r.unknownCount}`, desc: '索引里出现过调用，但技能目录里找不到——可能是插件卸载后留下的记录。' })}
        <div class="table-wrap">${table({
          wrap: false,
          head: ['技能', { label: '调用', num: true }],
          rows: r.unknown.map((u) => `<tr><td class="strong">${esc(u.skill)}</td><td class="num">${u.calls}</td></tr>`),
        })}</div>
      </section>`
    : '';

  return `${statGrid([
    { label: '使用率', value: `${rate.toFixed(1)}%`, sub: `${r.usedCount} / ${r.installed} 个技能`, icon: 'target', tone: 'accent' },
    { label: '用过', value: String(r.usedCount), sub: '至少被显式调用一次', icon: 'check', tone: 'success' },
    { label: '从没用过', value: String(r.unusedCount), sub: '清单里有、调用记录里没有', icon: 'inbox' },
    { label: '调用次数', value: String(r.calls), sub: `${r.sessionsWithSkill} 场会话里出现`, icon: 'sparkles' },
  ])}
  ${callout(
    `只统计显式调用 Skill 工具的记录（覆盖：${esc(
      r.coverage ? r.coverage.agentsWithSkillTool.join('、') || '无' : '—'
    )}）。Codex 等直接读 SKILL.md 的用法不计入，所以「用过」是下限、「没用过」是上限。`,
    { tone: 'info', icon: 'info' }
  )}
  <section class="section">
    ${sectionHead({ title: '最常调用', desc: '按显式调用次数排序，最多 20 个。' })}
    <div class="table-wrap">${table({
      wrap: false,
      head: ['技能', '调用', '装在哪', '备注'],
      rows: topRows,
    })}</div>
  </section>
  ${unknown}
  <section class="section">
    ${sectionHead({ title: `从没用过 · ${r.unusedCount}`, desc: '不是说没用，只是没有调用记录。' })}
    <div class="table-wrap" style="max-height:420px;overflow:auto">${table({
      wrap: false,
      className: 'compact',
      head: ['技能', '装在哪'],
      rows: neverRows,
    })}</div>
  </section>`;
}

function envMemory(mem) {
  const instructions = mem.list.filter((m) => m.kind === 'instruction');
  const memories = mem.list.filter((m) => m.kind === 'memory');

  const insRows = instructions.map(
    (m) => `<tr>
      <td>${agentChip(m.agent)}</td>
      <td class="num">${m.bytes ? Math.round(m.bytes / 1024) + ' KB' : '空'}</td>
      <td class="dim" style="font-size:12px">${esc(oneLine(m.preview || '', 100))}</td>
    </tr>`
  );

  const memRows = memories.map(
    (m) => `<tr>
      <td>${agentChip(m.agent)}</td>
      <td>${badge(m.format, 'outline')}</td>
      <td class="dim">${esc(m.scope === 'project' ? tildify(m.project || '未绑定项目') : '全局')}</td>
      <td class="num">${Math.round(m.bytes / 1024)} KB</td>
      <td class="num">${m.entries != null ? m.entries : '—'}</td>
    </tr>`
  );

  return `${statGrid([
    { label: '指令', value: String(mem.instructions), sub: '每轮注入的行为约定', icon: 'file' },
    { label: '记忆位置', value: String(mem.locations), sub: `${mem.memories} 份文件`, icon: 'book' },
    { label: '条目', value: String(mem.entries), sub: '跨所有格式', icon: 'layers' },
    { label: '项目级', value: String(mem.projectScoped), sub: '绑在某个项目上', icon: 'folder' },
  ])}
  ${callout(
    '不同 Agent 的记忆可能互相矛盾（同一件事的偏好写得相反）。合并成「你的记忆」会说谎，所以这里只报出处，不合并内容。',
    { tone: 'info', icon: 'info' }
  )}
  <section class="section">
    ${sectionHead({ title: '指令', desc: '每个 Agent 每轮都会读的行为约定。' })}
    <div class="table-wrap">${table({
      wrap: false,
      head: ['Agent', { label: '大小', num: true }, '开头'],
      rows: insRows,
    })}</div>
  </section>
  <section class="section">
    ${sectionHead({ title: '记忆', desc: '格式、范围、大小；内容不在这里合并。' })}
    <div class="table-wrap" style="max-height:520px;overflow:auto">${table({
      wrap: false,
      className: 'compact',
      head: ['Agent', '格式', '范围', { label: '大小', num: true }, { label: '条目', num: true }],
      rows: memRows,
    })}</div>
  </section>`;
}

function envAudit(r) {
  const findings = r.findings.map((f) => {
    const warn = f.level === 'warn';
    return `<div class="finding ${warn ? '' : 'info'}">
      <span class="finding-icon">${icon(warn ? 'alert' : 'info', 15)}</span>
      <div class="finding-body">
        <div class="finding-title">${esc(f.title)} ${badge(f.area, 'outline')}</div>
        <p class="finding-detail">${esc(f.detail)}</p>
      </div>
    </div>`;
  });

  return `${statGrid([
    { label: 'Agent', value: String(r.summary.agentsPresent), sub: `${r.summary.agentsWithData} 家有数据`, icon: 'users' },
    { label: 'MCP 服务', value: String(r.summary.mcpServices), sub: `${r.summary.mcpRegistrations} 条注册`, icon: 'cpu' },
    { label: '技能', value: String(r.summary.skills), sub: `${r.summary.skillInstalls} 处安装`, icon: 'sparkles' },
    { label: '记忆条目', value: String(r.summary.memoryEntries), sub: `${r.summary.memoryLocations} 处`, icon: 'book' },
  ])}
  <section class="section" style="margin-top:0">
    ${sectionHead({
      title: '发现',
      desc: '只报"看起来正常、实际会让人做错判断"的东西；warn 排在 info 前面。',
    })}
    ${
      findings.length
        ? findings.join('')
        : emptyState({ icon: 'shield', title: '没有发现问题', desc: '当前这套环境里没有需要提醒的配置。' })
    }
  </section>`;
}

/* ------------------------------ 404 ------------------------------ */

export async function pageNotFound(msg = '页面不存在') {
  return layout({
    title: '未找到',
    page: 'projects',
    crumb: [{ label: '未找到' }],
    body: `${pageHead({
      eyebrow: '404',
      eyebrowIcon: 'search',
      title: esc(msg),
      lead: '地址可能拼错了，或者这个项目已经不在扫描范围里。',
      actions: `<a class="btn outline" href="/">${icon('arrowLeft', 15)} 所有项目</a>`,
    })}
    ${emptyState({
      icon: 'inbox',
      title: '没有这个页面',
      desc: '回到项目列表重新找，或者用搜索。',
      action: `<a class="btn" href="/">回到项目列表</a>`,
    })}`,
  });
}

/* ------------------------------ 小工具 ------------------------------ */

function weekdayLabel(day) {
  if (day === '未知日期') return day;
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${day} ${week}`;
}
