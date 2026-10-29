import http from 'node:http';
import { listProjects, projectTimeline, groupByAgent, findSessions, readSessionContent } from './query.js';
import { search, indexStats } from './search.js';
import { timelineMarkdown, sessionMarkdown, bundleMarkdown } from './export.js';
import { latestProjectDigest, latestSessionSummary } from './digest.js';
import { projectHandoffs } from './handoff.js';
import { quickFreshness } from './refresh.js';
import { projectKey, durationMs, tildify } from './model.js';

/**
 * 本地只读查看器。
 *
 * 同一个进程同时提供两种东西：
 *   - 给人看的 HTML 页面
 *   - 给其他 Agent 读的 JSON 接口（/api/*）
 *
 * 三个约束，都是硬性的：
 *   1. 只监听 127.0.0.1，不对外开放。
 *   2. 只处理 GET/HEAD，没有写操作。
 *   3. 会话正文是外部内容（别的 Agent 写的），一律 HTML 转义。
 *
 * 另外校验 Host 头：否则一个恶意网页可以用 DNS rebinding 把
 * evil.com 指到这里，再跨域读走本机的会话存档。
 */

const DEFAULT_PORT = 7788;

export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      send(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, `内部错误: ${e && e.message ? e.message : e}`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, url: `http://${host}:${addr.port}` });
    });
  });
}

async function handle(req, res) {
  // 只认本机 Host，挡 DNS rebinding
  if (!isLocalHost(req.headers.host)) {
    return send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, '只接受本机访问');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { allow: 'GET, HEAD' }, '只读服务');
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/') return sendHtml(res, pageProjects());
    if (path === '/p') {
      return sendHtml(
        res,
        await pageTimeline(url.searchParams.get('path') || '', url.searchParams.get('all') === '1')
      );
    }
    if (path === '/usage') {
      return sendHtml(res, await pageUsage(url.searchParams.get('by') || 'agent'));
    }
    if (path === '/search') {
      return sendHtml(res, pageSearch(url.searchParams.get('q') || '', url.searchParams.get('agent') || ''));
    }
    if (path === '/handoff') {
      return sendHtml(res, pageHandoff(url.searchParams.get('path') || ''));
    }
    if (path === '/s') {
      return sendHtml(res, await pageSession(url.searchParams.get('agent') || '', url.searchParams.get('id') || ''));
    }
    if (path === '/env') {
      return sendHtml(res, await pageEnv(url.searchParams.get('tab') || 'overview'));
    }

    if (path === '/api/projects') {
      const { projects, stats, totalSessions, subagentSessions, unbound } = listProjects({});
      return sendJson(res, {
        totalSessions,
        subagentSessions,
        stats,
        unbound,
        projects: projects.map((p) => ({
          key: p.key,
          display: tildify(p.display),
          count: p.count,
          agents: p.agents,
          start: p.start,
          end: p.end,
        })),
      });
    }

    if (path === '/api/timeline') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, { error: '缺少 path 参数' }, 400);
      const r = projectTimeline(target, {});
      return sendJson(res, {
        target: tildify(r.target),
        summary: r.summary,
        orphanCount: r.orphanCount,
        sessions: r.sessions.map(publicSession),
      });
    }

    if (path === '/api/handoff') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, { error: '缺少 path 参数' }, 400);
      const h = projectHandoffs(target, {});
      return sendJson(res, {
        target: tildify(h.project),
        sessions: h.sessions,
        runs: h.runs,
        agents: h.agents,
        singleAgent: h.singleAgent,
        summary: h.summary,
        handoffs: h.handoffs.map((x) => ({
          from: x.from,
          to: x.to,
          kind: x.kind,
          gapMinutes: x.gapMinutes,
          stale: x.stale,
          fromLast: x.fromLastSession && { id: x.fromLastSession.id, title: x.fromLastSession.title },
          toFirst: x.toFirstSession && { id: x.toFirstSession.id, title: x.toFirstSession.title },
        })),
      });
    }

    if (path === '/api/usage') {
      const { summarizeUsage } = await import('./usage.js');
      const by = url.searchParams.get('by') || 'agent';
      const active = USAGE_TABS.some(([k]) => k === by) ? by : 'agent';
      const { r, catalog, catalogInfo } = await usageSnapshot();
      if (!r.ready) {
        return sendJson(res, { ready: false, reports: r.reports }, 200);
      }
      let sessionIndex = [];
      if (active === 'project') {
        const { scanCached } = await import('./registry.js');
        sessionIndex = scanCached({}).sessions.map((s) => ({
          agent: s.agent,
          id: s.id,
          project: s.project,
        }));
      }
      const rows = summarizeUsage({ rows: r.rows, groupBy: active, sessionIndex, catalog });
      return sendJson(res, {
        ready: true,
        groupBy: active,
        records: r.rows.length,
        range: r.range,
        pricing: catalog
          ? { source: catalog.source, fetchedAt: catalog.fetchedAt, models: catalog.count }
          : { ready: false, reason: catalogInfo.reason },
        sources: r.reports,
        rows: rows.map((g) => ({
          key: g.key,
          records: g.rows,
          calls: g.calls,
          uncachedInput: g.fresh,
          output: g.output,
          cacheRead: g.cacheRead,
          cacheWrite: g.cacheWrite,
          cacheHit: g.cacheHit == null ? null : Number(g.cacheHit.toFixed(3)),
          cost: g.cost == null ? null : Number(g.cost.toFixed(4)),
          estimatedCost: g.costEst == null ? null : Number(g.costEst.toFixed(4)),
          unpricedRecords: g.unpricedRecords,
          semantics: g.semantics,
        })),
      });
    }

    if (path === '/api/agents') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, { error: '缺少 path 参数' }, 400);
      const r = projectTimeline(target, {});
      return sendJson(res, {
        target: tildify(r.target),
        agents: groupByAgent(r.sessions).map(([agent, ss]) => ({
          agent,
          count: ss.length,
          totalMs: ss.reduce((n, s) => n + durationMs(s), 0),
        })),
      });
    }

    if (path === '/api/search') {
      const q = url.searchParams.get('q') || '';
      if (!q) return sendJson(res, { error: '缺少 q 参数' }, 400);
      const r = search(q, {
        limit: Number(url.searchParams.get('limit')) || 20,
        agent: url.searchParams.get('agent') || undefined,
        project: url.searchParams.get('project') || undefined,
      });
      return sendJson(res, {
        query: q,
        ready: r.ready,
        total: r.total,
        message: r.message,
        hits: r.hits.map((h) => ({
          ...h,
          project: h.project ? tildify(h.project) : null,
        })),
      });
    }

    // 导出：直接返回 text/markdown，浏览器会当附件下载
    if (path === '/export') {
      const kind = url.searchParams.get('kind') || 'timeline';
      const target = url.searchParams.get('path') || '';
      const id = url.searchParams.get('id') || '';
      const agent = url.searchParams.get('agent') || undefined;

      let md;
      let filename;

      if (kind === 'session') {
        if (!id) return sendJson(res, { error: '缺少 id 参数' }, 400);
        const { matches } = findSessions({ query: id, agent });
        if (!matches.length) return sendJson(res, { error: '没有匹配的会话' }, 404);
        md = await sessionMarkdown(matches[0], { tools: true });
        filename = `${safeName(matches[0].agent)}-${safeName(matches[0].id)}.md`;
      } else if (kind === 'bundle') {
        if (!target) return sendJson(res, { error: '缺少 path 参数' }, 400);
        md = await bundleMarkdown(target, {});
        filename = `${safeName(lastSegment(target))}-archive.md`;
      } else {
        if (!target) return sendJson(res, { error: '缺少 path 参数' }, 400);
        md = timelineMarkdown(target);
        filename = `${safeName(lastSegment(target))}-timeline.md`;
      }

      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'no-store',
      });
      return res.end(md);
    }

    if (path === '/api/digest') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, { error: '缺少 path 参数' }, 400);
      const d = latestProjectDigest(target);
      if (!d) {
        return sendJson(res, {
          exists: false,
          project: tildify(target),
          hint: '还没有项目摘要。在终端运行：agent-archive digest <项目> --run',
        });
      }
      return sendJson(res, {
        exists: true,
        project: tildify(target),
        generatedAt: d.createdAt,
        model: d.model,
        promptVersion: d.promptVersion,
        tokensIn: d.tokensIn,
        tokensOut: d.tokensOut,
        digest: d.text,
        // 快速新鲜度：只查模型/提示词/新增会话，读不了正文内容的变化。
        // 调用方要准确结论就去跑 refresh。
        freshness: (() => {
          const f = quickFreshness({
            kind: 'project',
            artifact: d,
            projectSessions: projectTimeline(target, {}).sessions,
          });
          return {
            status: f.status,
            issues: f.issues,
            unchecked: f.unchecked,
          };
        })(),
      });
    }

    if (path === '/api/session') {
      const agent = url.searchParams.get('agent') || undefined;
      const id = url.searchParams.get('id');
      if (!id) return sendJson(res, { error: '缺少 id 参数' }, 400);

      const { matches } = findSessions({ query: id, agent });
      if (!matches.length) return sendJson(res, { error: '没有匹配的会话' }, 404);

      // 前缀可能命中多场，取最近一场并在响应里说明，方便调用方判断
      const session = matches[0];
      const messages = await readSessionContent(session);

      // 只取某一条消息的完整正文：页面上的折叠块展开时用这个，
      // 避免为了看一段工具输出重新拉整场会话
      const only = url.searchParams.get('message');
      if (only !== null) {
        const i = Number(only);
        if (!Number.isInteger(i) || i < 0 || i >= messages.length) {
          return sendJson(res, { error: 'message 序号越界', count: messages.length }, 400);
        }
        return sendJson(res, { session: publicSession(session), index: i, message: messages[i] });
      }

      return sendJson(res, {
        ambiguous: matches.length > 1,
        matchCount: matches.length,
        session: publicSession(session),
        messages,
      });
    }

    if (path === '/api/env') {
      const { fullInventory, auditEnvironment } = await import('./env/inventory.js');
      const tab = url.searchParams.get('tab') || 'overview';

      if (tab === 'audit') return sendJson(res, auditEnvironment());
      if (tab === 'usage') {
        const { skillUsageSummary } = await import('./env/usage.js');
        return sendJson(res, await skillUsageSummary({}));
      }

      const inv = fullInventory();
      if (tab === 'mcp') return sendJson(res, inv.mcp);
      if (tab === 'skills') return sendJson(res, inv.skills);
      if (tab === 'memory') return sendJson(res, inv.memory);
      return sendJson(res, inv);
    }

    return sendHtml(res, pageNotFound(), 404);
  } catch (e) {
    return send(
      res,
      500,
      { 'content-type': 'text/plain; charset=utf-8' },
      `出错了: ${e && e.message ? e.message : e}`
    );
  }
}

function isLocalHost(host) {
  if (!host) return false;
  const name = String(host).toLowerCase().replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

/** 取路径最后一段，用作下载文件名。 */
function lastSegment(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || 'archive';
}

/** 文件名里去掉会出问题的字符。 */
function safeName(s) {
  return String(s).replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').slice(0, 80) || 'archive';
}

function publicSession(s) {
  return {
    agent: s.agent,
    id: s.id,
    project: s.project ? tildify(s.project) : null,
    title: s.title,
    start: s.start,
    end: s.end,
    resume: s.resume,
  };
}

function sendJson(res, body, code = 200) {
  send(res, code, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(body, null, 2));
}

function sendHtml(res, html, code = 200) {
  send(res, code, { 'content-type': 'text/html; charset=utf-8' }, html);
}

function send(res, code, headers, body) {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

/* ------------------------------ 页面 ------------------------------ */

function pageProjects() {
  const { projects, totalSessions, subagentSessions, stats, unbound } = listProjects({});

  const rows = projects
    .map((p) => {
      const href = `/p?path=${encodeURIComponent(p.display)}`;
      return `<tr>
        <td class="proj"><a href="${esc(href)}">${esc(tildify(p.display))}</a></td>
        <td class="num">${p.count}</td>
        <td>${p.agents.map((a) => `<span class="tag">${esc(a)}</span>`).join('')}</td>
        <td class="dim">${esc(fmtDate(p.end))}</td>
      </tr>`;
    })
    .join('');

  // 不绑定项目的会话（Hermes 这类聊天渠道助手）单独一段，
  // 它们进不了任何项目时间线，但不该在网页上消失
  const unboundHtml = unbound
    ? `<h2 class="day">无项目归属</h2>
       <p class="sub">${unbound.count} 个会话。这类 Agent 不绑定工作目录，所以没有项目可以归。</p>
       <table>
         <thead><tr><th>Agent</th><th class="num">会话</th><th>最近</th></tr></thead>
         <tbody>${unbound.agents
           .map(
             (a) => `<tr>
               <td class="proj">${esc(a.agent)}</td>
               <td class="num">${a.count}</td>
               <td class="dim">${esc(fmtDate(a.end))}</td>
             </tr>`
           )
           .join('')}</tbody>
       </table>`
    : '';

  return layout(
    '项目',
    `<h1>会话档案馆</h1>
     <p class="sub">${projects.length} 个项目 · ${totalSessions} 场会话${subagentSessions ? ` · 另有 ${subagentSessions} 场子代理会话` : ''} · ${stats.files} 个文件
       · <a href="/env">看能力面 →</a></p>
     <table>
       <thead><tr><th>项目</th><th class="num">会话</th><th>Agent</th><th>最近</th></tr></thead>
       <tbody>${rows}</tbody>
     </table>
     ${unboundHtml}
     <p class="foot">JSON 接口：<code>/api/projects</code> · <code>/api/timeline?path=</code> ·
     <code>/api/agents?path=</code> · <code>/api/search?q=</code> · <code>/api/session?agent=&amp;id=</code></p>`
  );
}

/**
 * 环境层页面。
 *
 * 和会话页的分工：`/` 回答"聊过什么"，`/env` 回答"会什么"。
 *
 * 用 tab 而不是一个长页：技能清单有 290 行、记忆有 21 处，
 * 全堆在一页会让人找不到重点。默认落在总览——那才是第一眼该看的。
 *
 * 这里有个和 CLI 一致的硬约束：**不回传凭证值**。
 * 页面上出现的只有环境变量的键名，值在 env/mcp.js 的 normalize()
 * 里就被丢掉了，这一层拿不到。
 */
async function pageEnv(tab) {
  const { fullInventory, auditEnvironment } = await import('./env/inventory.js');

  const TABS = [
    ['overview', '总览'],
    ['mcp', 'MCP'],
    ['skills', '技能'],
    ['usage', '使用率'],
    ['memory', '记忆'],
    ['audit', '体检'],
  ];

  // tab 只认白名单里的值，别的一律回落到 overview——
  // 免得把用户输入原样拼进页面
  const active = TABS.some(([k]) => k === tab) ? tab : 'overview';

  const nav = `<nav class="tabs">${TABS.map(
    ([k, label]) =>
      `<a href="/env?tab=${k}" class="${k === active ? 'on' : ''}">${esc(label)}</a>`
  ).join('')}</nav>`;

  const inv = fullInventory();
  let body = '';

  if (active === 'overview') {
    body = envOverview(inv);
  } else if (active === 'mcp') {
    body = envMcp(inv.mcp);
  } else if (active === 'skills') {
    body = envSkills(inv.skills);
  } else if (active === 'usage') {
    const { skillUsageSummary } = await import('./env/usage.js');
    body = envUsage(await skillUsageSummary({}));
  } else if (active === 'memory') {
    body = envMemory(inv.memory);
  } else {
    body = envAudit(auditEnvironment());
  }

  return layout('能力面', `<h1>能力面</h1>
    <p class="sub">这台机器上各 Agent 配了什么、装了什么、记得什么。与会话层并列的另一半。
    <a href="/">← 会话档案馆</a></p>
    ${nav}
    ${body}
    <p class="foot">JSON 接口：<code>/api/env</code> · <code>/api/env?tab=mcp</code> ·
    <code>/api/env?tab=skills</code> · <code>/api/env?tab=usage</code> ·
    <code>/api/env?tab=memory</code> · <code>/api/env?tab=audit</code><br>
    环境变量的值不读取、不传输，这里只有键名。</p>`);
}

function envOverview(inv) {
  const s = inv.summary;

  const cards = `<div class="cards">
    <div class="card"><b>${s.agentsWithData}</b><span>Agent 有数据</span></div>
    <div class="card"><b>${s.mcpServices}</b><span>MCP 服务</span></div>
    <div class="card"><b>${s.skills}</b><span>技能</span></div>
    <div class="card"><b>${s.memoryEntries}</b><span>记忆条目</span></div>
  </div>`;

  const agentRows = inv.agents
    .map(
      (a) => `<tr>
        <td class="proj">${esc(a.display)}</td>
        <td class="num">${a.mcp.length}</td>
        <td class="num">${a.skills}</td>
        <td class="num">${a.memory}</td>
        <td class="dim">${a.mcp.map((m) => `<span class="tag">${esc(m)}</span>`).join('')}</td>
      </tr>`
    )
    .join('');

  // MCP 服务按覆盖度排：多家共用的排前面，这本身就是信息
  const mcpRows = inv.mcp.list
    .map(
      (m) => `<tr>
        <td class="proj">${esc(m.service)}${
          m.aliases ? `<span class="dim" style="font-weight:400"> · 别名 ${esc(m.aliases.join(' / '))}</span>` : ''
        }</td>
        <td class="num">${m.agents.length}</td>
        <td class="dim">${esc(m.agents.join(', '))}</td>
        <td class="dim">${esc(m.forms.join(' / '))}</td>
      </tr>`
    )
    .join('');

  return `${cards}
    <h2 class="day">各 Agent 的能力面</h2>
    <table>
      <thead><tr><th>Agent</th><th class="num">MCP</th><th class="num">技能</th><th class="num">记忆</th><th>配了哪些 MCP</th></tr></thead>
      <tbody>${agentRows}</tbody>
    </table>
    <h2 class="day">MCP 服务</h2>
    <table>
      <thead><tr><th>服务</th><th class="num">家数</th><th>分布</th><th>安装形态</th></tr></thead>
      <tbody>${mcpRows}</tbody>
    </table>`;
}

function envMcp(mcp) {
  const rows = mcp.list
    .map(
      (s) => `<tr>
        <td class="proj">${esc(s.service)}</td>
        <td class="num">${s.registrations}</td>
        <td class="dim">${esc(s.agents.join(', '))}</td>
        <td class="dim">${esc(s.forms.join(' / '))}</td>
        <td class="dim mono" style="font-size:12px">${
          s.envKeys.length ? esc(s.envKeys.join(', ')) : '—'
        }</td>
      </tr>`
    )
    .join('');

  // 安装形态不一致是最值得人看的一条：npx 每次拉最新、本地钉版本
  const mixed = mcp.mixedForms.length
    ? `<h2 class="day">安装形态不一致</h2>
       ${mcp.mixedForms
         .map(
           (m) => `<p class="warn-line"><b>${esc(m.service)}</b>：${esc(m.forms.join(' / '))}
            <span class="dim">分布在 ${esc(m.agents.join(', '))}。npx 每次拉最新，本地安装钉版本，两边行为可能不同。</span></p>`
         )
         .join('')}`
    : '';

  return `<p class="sub">${mcp.services} 个服务，${mcp.registrations} 条注册。
    同一个服务在多家的注册已按启动指纹归并（不是按名字——那样 supabase 和 adbsupabase 会被算成两个）。</p>
    <table>
      <thead><tr><th>服务</th><th class="num">注册</th><th>分布</th><th>形态</th><th>环境变量（仅键名）</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${mixed}
    <p class="foot">环境变量的值不读取、不传输。要看值请自己打开配置文件。</p>`;
}

function envSkills(sk) {
  const byAgent = Object.entries(sk.byAgent)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `<tr><td class="proj">${esc(a)}</td><td class="num">${n}</td></tr>`)
    .join('');

  const shared = sk.list.filter((s) => s.agents.length > 1);
  const sharedRows = shared
    .map(
      (s) => `<tr>
        <td class="proj">${esc(s.name)}</td>
        <td class="num">${s.agents.length}</td>
        <td class="dim">${esc(s.agents.join(', '))}</td>
      </tr>`
    )
    .join('');

  return `<p class="sub">${sk.skills} 个独立技能，${sk.installs} 处安装。
    按 SKILL.md 内容哈希归并：同一份技能装在几处算一个。插件缓存里的旧版本已排除。</p>
    <div class="two-col">
      <div>
        <h2 class="day">按 Agent 的安装处数</h2>
        <table><tbody>${byAgent}</tbody></table>
      </div>
      <div>
        <h2 class="day">跨 Agent 共享（${shared.length} 个）</h2>
        <table><tbody>${sharedRows}</tbody></table>
      </div>
    </div>`;
}

function envUsage(r) {
  if (!r || !r.ready) {
    return `<p class="sub">${esc((r && r.message) || '还没有索引')}</p>`;
  }

  const rate = r.installed ? (r.usedCount / r.installed) * 100 : 0;

  const topRows = r.top
    .map((s) => {
      const marks = [];
      if (s.sameNameCount) marks.push(`同名 ${s.sameNameCount} 份实现`);
      if (s.calledAs) marks.push(`调作 ${s.calledAs.join(' / ')}`);
      return `<tr>
        <td class="num">${s.calls}</td>
        <td class="proj">${esc(s.name)}</td>
        <td class="dim">${esc(s.agents.join(', '))}</td>
        <td class="dim" style="font-size:12px">${esc(marks.join(' · '))}</td>
      </tr>`;
    })
    .join('');

  const neverRows = r.neverUsed
    .map((s) => `<tr><td class="proj">${esc(s.name)}</td><td class="dim">${esc(s.agents.join(', '))}</td></tr>`)
    .join('');

  const unknown = r.unknownCount
    ? `<h2 class="day">用了但清单里没有（${r.unknownCount}）</h2>
       <table><tbody>${r.unknown
         .map((u) => `<tr><td class="num">${u.calls}</td><td class="proj">${esc(u.skill)}</td></tr>`)
         .join('')}</tbody></table>`
    : '';

  return `<div class="cards">
      <div class="card"><b>${rate.toFixed(1)}%</b><span>使用率</span></div>
      <div class="card"><b>${r.usedCount}</b><span>用过</span></div>
      <div class="card"><b>${r.unusedCount}</b><span>从没用过</span></div>
      <div class="card"><b>${r.calls}</b><span>调用次数</span></div>
    </div>
    <h2 class="day">最常调用</h2>
    <table>
      <thead><tr><th class="num">次数</th><th>技能</th><th>装在哪</th><th>备注</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table>
    ${unknown}
    <h2 class="day">从没用过（${r.unusedCount} 个）</h2>
    <table><tbody>${neverRows}</tbody></table>
    <p class="foot">只统计显式调用 Skill 工具的记录（本次覆盖：${
      r.coverage ? esc(r.coverage.agentsWithSkillTool.join('、') || '无') : '—'
    }）。
    Codex 等直接读 SKILL.md 的用法不计入，所以"用过"是下限、"没用过"是上限。</p>`;
}

function envMemory(mem) {
  const instructions = mem.list.filter((m) => m.kind === 'instruction');
  const memories = mem.list.filter((m) => m.kind === 'memory');

  const insRows = instructions
    .map(
      (m) => `<tr>
        <td class="proj">${esc(m.agent)}</td>
        <td class="num">${m.bytes ? Math.round(m.bytes / 1024) + ' KB' : '空'}</td>
        <td class="dim">${esc(clip(m.preview || '', 90))}</td>
      </tr>`
    )
    .join('');

  const memRows = memories
    .map(
      (m) => `<tr>
        <td class="proj">${esc(m.agent)}</td>
        <td class="dim">${esc(m.format)}</td>
        <td class="dim">${esc(m.scope === 'project' ? m.project || '未绑定项目' : '全局')}</td>
        <td class="num">${Math.round(m.bytes / 1024)} KB</td>
        <td class="num">${m.entries != null ? m.entries : '—'}</td>
      </tr>`
    )
    .join('');

  return `<p class="sub">${mem.instructions} 份指令 · ${mem.memories} 处记忆 · ${mem.entries} 条条目 ·
    ${mem.projectScoped} 处项目级。只报出处，不合并内容。</p>
    <h2 class="day">指令（每轮注入的行为约定）</h2>
    <table><thead><tr><th>Agent</th><th class="num">大小</th><th>开头</th></tr></thead>
      <tbody>${insRows}</tbody></table>
    <h2 class="day">记忆</h2>
    <table><thead><tr><th>Agent</th><th>格式</th><th>范围</th><th class="num">大小</th><th class="num">条目</th></tr></thead>
      <tbody>${memRows}</tbody></table>
    <p class="foot">不同 Agent 的记忆可能互相矛盾（同一件事的偏好写得相反）。
    合并成"你的记忆"会说谎，所以这里只报出处。</p>`;
}

function envAudit(r) {
  const rows = r.findings
    .map((f) => {
      const mark = f.level === 'warn' ? '<span class="badge-warn">!</span>' : '<span class="dim">·</span>';
      return `<div class="finding">${mark} <b>${esc(f.title)}</b>
        <p class="dim">${esc(f.detail)}</p></div>`;
    })
    .join('');

  return `<p class="sub">${r.summary.agentsPresent} 个 Agent · ${r.summary.mcpServices} 个 MCP 服务 ·
    ${r.summary.skills} 个技能 · ${r.summary.memoryEntries} 条记忆</p>
    ${rows || '<p class="sub">没有发现问题。</p>'}`;
}

function pageSearch(q, agent) {
  const idx = indexStats();

  const form = `<form class="search" action="/search" method="get">
      <input type="search" name="q" value="${esc(q)}" placeholder="搜索所有会话的正文…" autofocus>
      <button type="submit">搜索</button>
    </form>`;

  if (!idx.exists) {
    return layout(
      '搜索',
      `<p><a href="/">← 所有项目</a></p>
       <h1>搜索</h1>
       ${form}
       <p class="sub">索引还没建。在终端里运行一次：</p>
       <pre>node src/cli.js index</pre>`
    );
  }

  if (!q.trim()) {
    return layout(
      '搜索',
      `<p><a href="/">← 所有项目</a></p>
       <h1>搜索</h1>
       ${form}
       <p class="sub">已索引 ${idx.docs} 场会话、${(idx.chars / 1e6).toFixed(0)} M 字。
       搜的是人说的话和工具调用摘要，不含完整工具输出。</p>`
    );
  }

  const r = search(q, { limit: 50, agent: agent || undefined });

  if (!r.ready) {
    return layout('搜索', `<p><a href="/">← 所有项目</a></p><h1>搜索</h1>${form}
      <p class="sub">${esc(r.message || '')}</p>`);
  }

  if (!r.hits.length) {
    return layout(
      '搜索',
      `<p><a href="/">← 所有项目</a></p><h1>搜索「${esc(q)}」</h1>${form}
       <p class="sub">没有找到。换个词试试，或者先把索引补上（<code>node src/cli.js index</code>）。</p>`
    );
  }

  const items = r.hits
    .map(
      (h) => `<div class="hit">
        <div class="hit-head">
          <a href="/s?agent=${encodeURIComponent(h.agent)}&amp;id=${encodeURIComponent(h.id)}">${esc(h.title)}</a>
        </div>
        <div class="hit-meta">
          <span class="tag">${esc(h.agent)}</span>
          <span class="dim">${esc(fmtDate(h.start))}</span>
          ${h.project ? `<span class="dim">${esc(tildify(h.project))}</span>` : ''}
          <span class="dim">${esc(h.id.slice(0, 12))}</span>
        </div>
        ${h.snippet ? `<div class="hit-snip">${highlight(h.snippet, q)}</div>` : ''}
      </div>`
    )
    .join('');

  return layout(
    `搜索 ${q}`,
    `<p><a href="/">← 所有项目</a></p>
     <h1>搜索「${esc(q)}」</h1>
     ${form}
     <p class="sub">${r.total} 场会话命中</p>
     <div class="hits">${items}</div>`
  );
}

/** 把摘录里的关键词包成 <mark>，其余照常转义。 */
function highlight(snippet, query) {
  const text = String(snippet || '');
  const q = String(query || '').trim();
  if (!q) return esc(text);

  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts = [];
  let i = 0;
  let found = 0;

  while (found < 8) {
    const at = lower.indexOf(ql, i);
    if (at === -1) break;
    parts.push(esc(text.slice(i, at)));
    parts.push(`<mark>${esc(text.slice(at, at + q.length))}</mark>`);
    i = at + q.length;
    found++;
  }
  parts.push(esc(text.slice(i)));
  return parts.join('');
}

/**
 * 极简 Markdown 渲染。
 *
 * 只处理摘要里实际会出现的几种结构：标题、有序/无序列表、加粗、段落。
 * 先整体转义再套标签，所以正文里即使有 HTML 也不会执行。
 * 不引第三方库——为了这几十行引入一个 markdown 解析器不值得。
 */
function renderMarkdownLite(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;

  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList();
      const level = Math.min(h[1].length + 1, 5); // 页面已有 h1，降一级
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      if (!list || list.tag !== 'ol') {
        flushList();
        list = { tag: 'ol', items: [] };
      }
      list.items.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (!list || list.tag !== 'ul') {
        flushList();
        list = { tag: 'ul', items: [] };
      }
      list.items.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return out.join('\n');
}

/** 行内：先转义，再把 **粗体** 和 `代码` 换成标签。 */
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * 项目摘要块。
 *
 * 除内容外还带一个「新鲜度」提示。这是必要的：摘要一旦生成就一直显示，
 * 但会话还在变、模型也会换。不提示的话，用户会把一份半年前的摘要
 * 当成现在的事实。
 */
function renderProjectDigest(dg, sessions, target) {
  const fresh = quickFreshness({ kind: 'project', artifact: dg, projectSessions: sessions });
  const badge = renderFreshness(fresh, target);

  return `<details class="digest">
    <summary>项目摘要 <span class="dim">· ${esc(dg.model)} · ${esc(fmtDate(dg.createdAt))} 生成</span>${badge}</summary>
    <div class="digest-body">${renderMarkdownLite(dg.text)}</div>
    <p class="hint">模型生成的视图，不是原始事实。核对细节请点开下面的会话。</p>
    ${renderFreshnessDetail(fresh, target)}
  </details>`;
}

function digestMissingHint(target) {
  return `<p class="hint">还没有项目摘要。在终端运行
    <code>agent-archive digest "${esc(target)}"</code> 先看预估成本，
    确认后加 <code>--run</code> 生成。</p>`;
}

/** 摘要标题上的小徽标：只有确定有问题时才出现，否则保持安静。 */
function renderFreshness(fresh, target) {
  if (!fresh || fresh.status === 'none') return '';
  if (fresh.status === 'possibly-stale') {
    return ` <span class="stale-badge">可能已过期</span>`;
  }
  return '';
}

/** 展开后的详细说明。包括"我查不了什么"，这比假装确定更诚实。 */
function renderFreshnessDetail(fresh, target) {
  if (!fresh || fresh.status === 'none') return '';

  const rows = [];
  if (fresh.status === 'possibly-stale') {
    rows.push(`<p class="stale-head">这份摘要可能已经不准了：</p>`);
    rows.push(
      `<ul class="stale-list">${fresh.issues
        .map((i) => `<li>${esc(i.detail)}</li>`)
        .join('')}</ul>`
    );
  } else {
    rows.push(`<p class="dim">按目前能查到的信息看，这份摘要是新的。</p>`);
  }

  // 明确说出没查的那一项，并给出准确的检查方式
  if (fresh.unchecked && fresh.unchecked.length) {
    rows.push(
      `<p class="hint">网页上只做了不花钱的检查（模型、提示词版本、生成后有没有新会话）。` +
        `${esc(fresh.unchecked[0])}这一项查不了——需要准确结果请运行 ` +
        `<code>agent-archive refresh --project "${esc(target)}"</code>。</p>`
    );
  }

  return rows.join('');
}

/**
 * 用量快照。
 *
 * 读一次要扫 5 个库、上万行，页面每次请求都重读会让点击变得很迟钝。
 * 缓存 60 秒：Agent 还在写库，缓存太久会让用户以为统计不更新；
 * 缓存太短又等于没缓存。一分钟是"刷新一下能看到变化"的量级。
 */
let usageMemo = null;

async function usageSnapshot() {
  const now = Date.now();
  if (usageMemo && now - usageMemo.at < 60_000) return usageMemo.value;

  const { readUsage } = await import('./usage.js');
  const { loadCatalog } = await import('./pricing.js');
  const r = await readUsage();
  const catalogInfo = loadCatalog();
  const value = { r, catalog: catalogInfo.ready ? catalogInfo : null, catalogInfo };
  usageMemo = { at: now, value };
  return value;
}

/** token 数量级跨度大，用中文单位比一排零好读。 */
function fmtTok(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v);
  if (abs < 10000) return String(v);
  if (abs < 1e8) return (v / 1e4).toFixed(1) + '万';
  return (v / 1e8).toFixed(2) + '亿';
}

const USAGE_TABS = [
  ['agent', 'Agent'],
  ['model', '模型'],
  ['project', '项目'],
  ['day', '日期'],
];

/**
 * 用量页。
 *
 * 和 `calls` 的区别要写在页面上，否则读者会把"没装网关时的空表"当成"没花钱"。
 * 成本永远带前缀：`$` 是 Agent 自报，`~$` 是按价目表估算，两个数不加在一起。
 */
async function pageUsage(by) {
  const { summarizeUsage } = await import('./usage.js');
  const active = USAGE_TABS.some(([k]) => k === by) ? by : 'agent';
  const { r, catalog, catalogInfo } = await usageSnapshot();

  const nav = `<nav class="tabs">${USAGE_TABS.map(
    ([k, label]) => `<a href="/usage?by=${k}" class="${k === active ? 'on' : ''}">${esc(label)}</a>`
  ).join('')}</nav>`;

  if (!r.ready) {
    return layout(
      '用量',
      `<p><a href="/">← 所有项目</a></p><h1>用量</h1>
       <p class="sub">各家 Agent 的库里都没有找到 token 记录。</p>
       ${r.reports
         .filter((x) => x.reason)
         .map((x) => `<p class="hint">${esc(x.display)}：${esc(x.reason)}</p>`)
         .join('')}`
    );
  }

  let sessionIndex = [];
  if (active === 'project') {
    const { scanCached } = await import('./registry.js');
    sessionIndex = scanCached({}).sessions.map((s) => ({
      agent: s.agent,
      id: s.id,
      project: s.project,
    }));
  }

  const groups = summarizeUsage({ rows: r.rows, groupBy: active, sessionIndex, catalog });

  const tot = groups.reduce(
    (a, g) => {
      a.fresh += g.fresh;
      a.output += g.output;
      a.cacheRead += g.cacheRead;
      a.cost += g.cost || 0;
      a.costEst += g.costEst || 0;
      a.unpriced += g.unpricedRecords || 0;
      return a;
    },
    { fresh: 0, output: 0, cacheRead: 0, cost: 0, costEst: 0, unpriced: 0 }
  );

  const costCell = (g) => {
    if (g.cost != null) return `$${g.cost.toFixed(2)}${g.costUnknown ? '+' : ''}`;
    if (g.costEst != null) return `~$${g.costEst.toFixed(2)}`;
    return '—';
  };

  const rowHtml = (g) => `<tr>
      <td class="proj">${esc(g.key.length > 42 ? g.key.slice(0, 40) + '…' : g.key)}</td>
      <td class="num">${g.rows}</td>
      <td class="num">${fmtTok(g.fresh)}</td>
      <td class="num">${fmtTok(g.output)}</td>
      <td class="num">${fmtTok(g.cacheRead)}</td>
      <td class="num">${g.cacheHit == null ? '—' : Math.round(g.cacheHit * 100) + '%'}</td>
      <td class="num">${costCell(g)}</td>
    </tr>`;

  const head = `<thead><tr><th>${
    { agent: 'Agent', model: '模型', project: '项目', day: '日期' }[active]
  }</th><th class="num">记录</th><th class="num">未缓存输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num">命中</th><th class="num">成本</th></tr></thead>`;

  // 口径未知的组（目前是 Codex 的会话总量）单独一张表：
  // 和按请求记的数排在一起，会让人以为它真的贵几百倍
  const known = groups.filter((g) => !g.semantics.includes('unknown'));
  const unknown = groups.filter((g) => g.semantics.includes('unknown'));

  const span = r.range
    ? `${esc(fmtDate(new Date(r.range.start)))} → ${esc(fmtDate(new Date(r.range.end)))}`
    : '—';

  const pricingLine = catalog
    ? `价目表 models.dev · ${catalog.count.toLocaleString('en-US')} 个模型 · 抓取于 ${esc(
        catalog.fetchedAt ? fmtDate(new Date(catalog.fetchedAt)) : '未知'
      )}`
    : `没有价目表：${esc(catalogInfo.reason || '未同步')} · 在终端跑 <code>agent-archive pricing sync</code>`;

  const unknownHtml = unknown.length
    ? `<h2 class="day">口径未知</h2>
       <p class="sub">这些来源只给了会话级总量，看不出是否含缓存，不参与命中率，也不该和上表比较。</p>
       <table><thead><tr><th>${
         { agent: 'Agent', model: '模型', project: '项目', day: '日期' }[active]
       }</th><th class="num">记录</th><th class="num">总量</th></tr></thead><tbody>${unknown
         .map(
           (g) =>
             `<tr><td class="proj">${esc(g.key)}</td><td class="num">${g.rows}</td><td class="num">${fmtTok(
               g.fresh
             )}</td></tr>`
         )
         .join('')}</tbody></table>`
    : '';

  return layout(
    '用量',
    `<p><a href="/">← 所有项目</a> · <a href="/env">能力面</a></p>
     <h1>用量</h1>
     <p class="sub">${r.rows.length} 条记录 · ${span} · 数据来自各家 Agent 自己的账本（不需要网关）</p>
     ${nav}
     <div class="cards">
       <div class="card"><b>${fmtTok(tot.fresh)}</b><span>未缓存输入</span></div>
       <div class="card"><b>${fmtTok(tot.output)}</b><span>输出</span></div>
       <div class="card"><b>${fmtTok(tot.cacheRead)}</b><span>缓存读</span></div>
       <div class="card"><b>~$${tot.costEst.toFixed(2)}</b><span>估算成本</span></div>
       <div class="card"><b>$${tot.cost.toFixed(2)}</b><span>Agent 自报</span></div>
     </div>
     <table>${head}<tbody>${known.map(rowHtml).join('')}</tbody></table>
     ${unknownHtml}
     <p class="hint">输入已统一成"不含缓存"。<code>~$</code> 是按价目表估算，不是账单；
     <code>+</code> 表示该组只有一部分记录带自报成本。${
       tot.unpriced ? `另有 ${tot.unpriced} 条既没自报、价目表里也没有价。` : ''
     }</p>
     <p class="hint">${pricingLine}</p>
     <h2 class="day">数据来源</h2>
     <p class="sub">${r.reports
       .map(
         (x) =>
           `${x.ready ? '✓' : '·'} ${esc(x.display)} ${
             x.ready ? `${x.rows} 条` : esc(x.reason || '没有数据')
           }`
       )
       .join(' · ')}</p>`
  );
}

function pageTimeline(target, openAll) {
  return pageTimelineAsync(target, openAll);
}

/**
 * 项目页的用量卡。
 *
 * 只统计"这个项目的会话 id"对应的记录，按 agent|id 匹配——
 * 和 calls 层同一个理由：只看 id 会跨家错挂。
 *
 * 没有缓存价目表时只给 token 和自报成本，并说明为什么没有钱。
 */
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

  const { summarizeUsage } = await import('./usage.js');
  const groups = summarizeUsage({ rows, groupBy: 'agent', catalog });
  const t = groups.reduce(
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

  return `<div class="cards">
      <div class="card"><b>${fmtTok(t.fresh)}</b><span>未缓存输入</span></div>
      <div class="card"><b>${fmtTok(t.output)}</b><span>输出</span></div>
      <div class="card"><b>${fmtTok(t.cacheRead)}</b><span>缓存读</span></div>
      <div class="card"><b>${cost}</b><span>成本</span></div>
    </div>
    <p class="hint">来自 ${rows.length} 条模型请求的记账 · <a href="/usage?by=project">看全部项目的用量 →</a></p>`;
}

async function pageTimelineAsync(target, openAll) {
  if (!target) return pageNotFound('缺少项目路径');

  const r = projectTimeline(target, {});

  if (!r.sessions.length) {
    return layout(
      '没有会话',
      `<p><a href="/">← 所有项目</a></p>
       <h1>${esc(tildify(r.target))}</h1>
       <p class="sub">这个项目下没有找到会话。</p>`
    );
  }

  const groups = groupByAgent(r.sessions);
  const summary = `${r.summary.count} 场会话 · ${r.summary.agents.join(' / ')} ·
    ${fmtDate(r.summary.first)} → ${fmtDate(r.summary.last)} · 累计 ${fmtDur(r.summary.totalMs)}`;

  const agentBar = groups
    .map(([a, ss]) => `<span class="tag">${esc(a)} <b>${ss.length}</b></span>`)
    .join('');

  // 大项目一次渲染两千条会拖慢页面，默认只给最近 300 场；
  // 要全量就看 ?all=1，或者直接走 /api/timeline。
  const LIMIT = 300;
  const all = r.sessions;
  const shown = all.length > LIMIT && !openAll ? all.slice(-LIMIT) : all;
  const hidden = all.length - shown.length;

  let body = '';
  let day = null;
  for (const s of shown) {
    const d = s.start ? s.start.toISOString().slice(0, 10) : '未知日期';
    if (d !== day) {
      day = d;
      body += `<h2 class="day">${esc(d)}</h2>`;
    }
    body += `<a class="sess" href="/s?agent=${encodeURIComponent(s.agent)}&amp;id=${encodeURIComponent(s.id)}">
      <span class="agent">${esc(s.agent)}</span>
      <span class="time">${esc(fmtTime(s.start))}</span>
      <span class="dur">${esc(fmtDur(durationMs(s)))}</span>
      <span class="title">${esc(s.title)}</span>
    </a>`;
  }

  const more = hidden
    ? `<p class="hint">还有 ${hidden} 场更早的会话没显示。
       <a href="/p?path=${encodeURIComponent(r.target)}&amp;all=1">显示全部</a>
       （或直接用 <code>/api/timeline?path=</code>）</p>`
    : '';

  // 项目摘要：有就展示，没有就给一句怎么生成。
  // 这是视图层（模型写的），和下面的时间线（事实）分开摆，视觉上也要分开。
  const dg = latestProjectDigest(r.target);
  const digestHtml = dg ? renderProjectDigest(dg, r.sessions, r.target) : digestMissingHint(r.target);

  // 交接概况只给一行入口：详情在 /handoff 页。
  // 项目页已经很长，再塞一张换手表会把它压垮。
  const handoffLine = handoffSummaryLine(r.target);

  return layout(
    tildify(r.target),
    `<p><a href="/">← 所有项目</a></p>
     <h1>${esc(tildify(r.target))}</h1>
     <p class="sub">${esc(summary)}</p>
     <p class="tags">${agentBar}</p>
     ${handoffLine}
     <p class="actions">
       <a href="/export?kind=timeline&amp;path=${encodeURIComponent(r.target)}">导出时间线 .md</a>
       <a href="/export?kind=bundle&amp;path=${encodeURIComponent(r.target)}">导出全部会话 .md</a>
     </p>
     ${digestHtml}
     ${more}
     <div class="timeline">${body}</div>`
  );
}

/** 项目页上的一行交接入口。没有换手就什么都不显示。 */
function handoffSummaryLine(target) {
  let h;
  try {
    h = projectHandoffs(target, {});
  } catch {
    return '';
  }
  if (!h.sessions || h.singleAgent || !h.handoffCount) return '';
  const parts = [`${h.handoffCount} 次换手`];
  if (h.summary.overlap) parts.push(`${h.summary.overlap} 次并行`);
  if (h.summary.stale) parts.push(`${h.summary.stale} 次长期中断`);
  return `<p class="hint">这个项目被 ${h.agentCount} 家 Agent 轮流做过 · ${esc(parts.join(' · '))}
    · <a href="/handoff?path=${encodeURIComponent(target)}">看接力详情 →</a></p>`;
}

/**
 * 交接页。
 *
 * 只列换手点，不列会话——会话在项目页已经有了。这里要回答的是
 * "谁在什么时候接手、中间隔了多久"，那是项目页给不了的角度。
 */
function pageHandoff(target) {
  if (!target) return pageNotFound('缺少项目路径');
  const h = projectHandoffs(target, {});

  if (!h.sessions) {
    return layout(
      '没有会话',
      `<p><a href="/">← 所有项目</a></p><h1>${esc(tildify(h.project))}</h1>
       <p class="sub">这个项目下没有找到会话。</p>`
    );
  }

  if (h.singleAgent) {
    return layout(
      tildify(h.project),
      `<p><a href="/p?path=${encodeURIComponent(h.project)}">← ${esc(tildify(h.project))}</a></p>
       <h1>跨 Agent 接力</h1>
       <p class="sub">${h.sessions} 场会话，全部由 <b>${esc(h.agents[0] || '?')}</b> 一家完成，没有换手。</p>`
    );
  }

  const s = h.summary;
  const stat = [
    ['接续', s.sequential],
    ['并行', s.overlap],
    ['长期中断', s.stale],
    ['中位间隔', s.medianGapMs == null ? '—' : fmtDur(s.medianGapMs)],
  ]
    .map(
      ([k, v]) => `<div class="card"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`
    )
    .join('');

  const pairs = s.topPairs.length
    ? `<p class="hint">最常走的接力线：${s.topPairs
        .map((p) => `<span class="tag">${esc(p.pair)} <b>${p.count}</b></span>`)
        .join(' ')}</p>`
    : '';

  const rows = h.handoffs
    .map((x) => {
      // 并行的负间隔显示成"重叠 X"：负号容易被读成"提前了"
      const gap =
        x.gapMs == null
          ? '—'
          : x.kind === 'overlap'
            ? `重叠 ${fmtDur(-x.gapMs)}`
            : `+${fmtDur(x.gapMs)}`;
      const cls = x.kind === 'overlap' ? 'warn' : x.stale ? 'warn' : '';
      const fromLink = x.fromLastSession
        ? `<a href="/s?agent=${encodeURIComponent(x.from)}&amp;id=${encodeURIComponent(x.fromLastSession.id)}">${esc(x.fromLastSession.title)}</a>`
        : '—';
      const toLink = x.toFirstSession
        ? `<a href="/s?agent=${encodeURIComponent(x.to)}&amp;id=${encodeURIComponent(x.toFirstSession.id)}">${esc(x.toFirstSession.title)}</a>`
        : '—';
      return `<tr class="${cls}">
        <td class="agent">${esc(x.from)}</td>
        <td class="agent">${esc(x.to)}</td>
        <td class="num">${esc(gap)}</td>
        <td>${fromLink}</td>
        <td>${toLink}</td>
      </tr>`;
    })
    .join('');

  return layout(
    `${tildify(h.project)} · 接力`,
    `<p><a href="/p?path=${encodeURIComponent(h.project)}">← ${esc(tildify(h.project))}</a></p>
     <h1>跨 Agent 接力</h1>
     <p class="sub">${h.sessions} 场会话压成 ${h.runs} 段 · ${h.agentCount} 家 Agent ·
       ${fmtDate(h.first)} → ${fmtDate(h.last)}</p>
     <div class="cards">${stat}</div>
     ${pairs}
     <p class="hint">「并行」= 上一段还没结束下一段就开始了，不是真正的交接；
       「长期中断」= 隔了一周以上。间隔越长，新 Agent 越不知道前面发生了什么。</p>
     <table class="handoff">
       <thead><tr><th>从</th><th>到</th><th>间隔</th><th>离开时最后一场</th><th>接手时第一场</th></tr></thead>
       <tbody>${rows}</tbody>
     </table>`
  );
}

async function pageSession(agent, id) {
  if (!id) return pageNotFound('缺少会话 id');

  const { matches } = findSessions({ query: id, agent });
  if (!matches.length) return pageNotFound(`没有匹配 ${id} 的会话`);

  const session = matches[0];

  if (matches.length > 1) {
    const list = matches
      .map(
        (s) => `<a class="sess" href="/s?agent=${encodeURIComponent(s.agent)}&amp;id=${encodeURIComponent(s.id)}">
          <span class="agent">${esc(s.agent)}</span>
          <span class="time">${esc(fmtTime(s.start))}</span>
          <span class="title">${esc(s.id)} · ${esc(s.title)}</span>
        </a>`
      )
      .join('');
    return layout(
      '多场匹配',
      `<p><a href="/">← 所有项目</a></p><h1>${esc(id)} 匹配 ${matches.length} 场</h1>
       <p class="sub">请选一场：</p><div class="timeline">${list}</div>`
    );
  }

  let messages;
  try {
    messages = await readSessionContent(session);
  } catch (e) {
    return layout(
      '读不了',
      `<p><a href="/">← 所有项目</a></p><h1>读不了这场会话</h1>
       <p class="sub">${esc(e && e.message ? e.message : String(e))}</p>`
    );
  }

  const body = messages.map((m, i) => renderMessageHtml(m, i)).join('');
  const back = session.project
    ? `<a href="/p?path=${encodeURIComponent(session.project)}">← ${esc(tildify(session.project))}</a>`
    : `<a href="/">← 所有项目</a>`;

  const exportHref = `/export?kind=session&amp;agent=${encodeURIComponent(session.agent)}&amp;id=${encodeURIComponent(session.id)}`;

  // 会话级摘要：有就折起来放最上面，方便先扫一眼再决定读不读全文
  const ss = latestSessionSummary(session);
  const digestHtml = ss
    ? (() => {
        // 会话摘要的新鲜度只看模型和提示词——单场会话新增内容的判断
        // 需要重读正文，那是 refresh 的事
        const fresh = quickFreshness({ kind: 'session', artifact: ss });
        return `<details class="digest" open>
          <summary>会话摘要 <span class="dim">· ${esc(ss.model)} · ${esc(fmtDate(ss.createdAt))} 生成</span>${renderFreshness(fresh)}</summary>
          <div class="digest-body">${renderMarkdownLite(ss.text)}</div>
          <p class="hint">模型生成的视图。下面是原始对话，核对细节用下面的。</p>
          ${renderFreshnessDetail(fresh, session.project || '')}
        </details>`;
      })()
    : '';

  return layout(
    session.title,
    `${back}
     <h1>${esc(session.title)}</h1>
     <p class="sub">${esc(session.agent)} · ${esc(session.id)} · ${esc(fmtDate(session.start))} →
       ${esc(fmtDate(session.end))} · ${esc(fmtDur(durationMs(session)))}</p>
     ${session.resume ? `<p class="sub mono">恢复：${esc(session.resume)}</p>` : ''}
     <p class="actions"><a href="${exportHref}">导出 .md</a></p>
     ${digestHtml}
     <div class="messages">${body}</div>
     <script>
     // 折叠块展开时才去取全文。页面因此保持在几十 KB，
     // 而不是把整场会话的推理和工具输出一次性塞进 HTML。
     (function () {
       var agent = ${jsonForScript(session.agent)};
       var id = ${jsonForScript(session.id)};
       document.querySelectorAll('details.folded').forEach(function (d) {
         d.addEventListener('toggle', function () {
           if (!d.open || d.dataset.loaded) return;
           d.dataset.loaded = '1';
           var box = d.querySelector('.folded-body');
           box.textContent = '加载中…';
           fetch('/api/session?agent=' + encodeURIComponent(agent) + '&id=' + encodeURIComponent(id) +
                 '&message=' + encodeURIComponent(d.dataset.idx))
             .then(function (r) { return r.json(); })
             .then(function (j) {
               var parts = (j.message && j.message.parts) || [];
               box.innerHTML = '';
               parts.forEach(function (p) {
                 if (p.kind === 'text' || p.kind === 'reasoning') box.appendChild(pre(p.text));
                 else if (p.kind === 'tool') {
                   if (p.input) box.appendChild(labelled('入参', JSON.stringify(p.input, null, 2)));
                   if (p.output) box.appendChild(labelled('输出', p.output));
                 }
               });
               if (!box.childNodes.length) box.textContent = '（没有内容）';
             })
             .catch(function (e) { box.textContent = '加载失败：' + e; });
         });
       });
       function pre(t) { var e = document.createElement('pre'); e.textContent = t || ''; return e; }
       function labelled(t, v) {
         var f = document.createElement('div');
         var h = document.createElement('h4'); h.textContent = t; f.appendChild(h);
         f.appendChild(pre(v)); return f;
       }
     })();
     </script>`
  );
}

/**
 * 消息渲染。
 *
 * 折叠块只在展开时才需要全文，所以默认不给：一场会话的推理加工具输出
 * 常常几十万字，全量内联会把每个页面撑到几百 KB。折叠块里只放摘要，
 * 想读全文就点"展开全文"，它去 /api/session 取这一段。
 */
function renderMessageHtml(m, index) {
  const isSystem = m.role === 'system';
  const label =
    m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具' : '系统';
  const kind = m.meta && m.meta.kind ? ` · ${esc(m.meta.kind)}` : '';
  const when = m.ts ? ' · ' + esc(fmtTime(m.ts)) : '';

  if (isSystem) {
    const chars = m.parts.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
    const first = m.parts.find((p) => p.kind === 'text');
    const peek = first ? oneLine(first.text, 140) : '';
    return `<details class="msg system">
      <summary>${esc(label)}${kind}${when} · ${chars} 字</summary>
      <div class="parts"><p class="text dim">${esc(peek)}${chars > 140 ? '…' : ''}</p>
      <p class="hint">完整内容见 <code>/api/session</code> 或 CLI 的 <code>cat --system</code>。</p></div>
    </details>`;
  }

  // 正文（人说的话）直接显示，这是页面的主体
  const textHtml = m.parts.filter((p) => p.kind === 'text').map(renderPart).join('');

  // 折叠现场：只给一行摘要，正文按需取
  const folded = m.parts.filter((p) => p.kind === 'tool' || p.kind === 'reasoning');
  const foldedHtml = folded.length
    ? `<details class="folded" data-idx="${index}">
         <summary>${folded
           .map((p) =>
             p.kind === 'tool'
               ? `<span class="tname">${esc(p.name)}</span> ${esc(summarizeInput(p.input))}`
               : '<span class="tname">推理</span>'
           )
           .join(' · ')}</summary>
         <div class="folded-body"><p class="hint">展开时加载…</p></div>
       </details>`
    : '';

  if (!textHtml && !foldedHtml) return '';

  const open = m.role === 'user' || m.role === 'assistant' ? ' open' : '';
  return `<details class="msg ${esc(m.role)}"${open}>
    <summary>${esc(label)}${when}</summary>
    <div class="parts">${textHtml}${foldedHtml}</div>
  </details>`;
}

function renderPart(p) {
  if (p.kind === 'text') return `<p class="text">${esc(p.text)}</p>`;
  if (p.kind === 'reasoning') {
    return `<details class="reasoning"><summary>推理</summary><p class="text">${esc(p.text)}</p></details>`;
  }
  if (p.kind === 'tool') {
    const detail = summarizeInput(p.input);
    const status = p.status && p.status !== 'completed' ? ` · ${esc(p.status)}` : '';
    const input = p.input ? `<h4>入参</h4><pre>${esc(clip(p.input, 4000))}</pre>` : '';
    // 工具输出动辄几万字，整页塞满就没人看得下去了。截断的完整原文
    // 仍然可以用 CLI 的 cat --tools 或 /api/session 拿到。
    const output = p.output ? `<h4>输出</h4><pre>${esc(clip(p.output, 4000))}</pre>` : '';
    return `<details class="tool"><summary><span class="tname">${esc(p.name)}</span>${
      detail ? ' ' + esc(detail) : ''
    }${status}</summary>${input}${output}</details>`;
  }
  return '';
}

/* ------------------------------ 基础设施 ------------------------------ */

function layout(title, body) {
  // 每个页面都带一个搜索入口：档案馆最常用的动作就是"找那场对话"
  const bar = `<form class="search topbar" action="/search" method="get">
      <input type="search" name="q" placeholder="搜索会话…">
    </form>`;
  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — agent-archive</title>
<style>
:root {
  --fg: #1a1a1a; --dim: #6b6b6b; --line: #e4e4e4; --bg: #fff; --soft: #f7f7f7;
  --user: #2f6f43; --assistant: #2a5f8f; --sys: #8a6d3b; --tool: #6b4f8a;
}
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e6e6; --dim: #9a9a9a; --line: #333; --bg: #17181a; --soft: #1f2124;
           --user: #7fc79a; --assistant: #7fb4e0; --sys: #d0b276; --tool: #b39ddb; }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 32px 20px 80px; max-width: 920px; background: var(--bg); color: var(--fg);
  font: 15px/1.65 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
h1 { font-size: 20px; margin: 18px 0 6px; font-weight: 600; }
h2.day { font-size: 13px; color: var(--dim); font-weight: 500; margin: 26px 0 8px;
         letter-spacing: .04em; text-transform: none; }
a { color: inherit; }
a:hover { text-decoration: none; }
.sub { color: var(--dim); font-size: 13px; margin: 0 0 16px; }
.foot { color: var(--dim); font-size: 12px; margin-top: 36px; border-top: 1px solid var(--line); padding-top: 14px; }
code, .mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { font-size: 12px; background: var(--soft); padding: 1px 5px; border-radius: 4px; }
.tag { display: inline-block; font-size: 12px; color: var(--dim); border: 1px solid var(--line);
       border-radius: 999px; padding: 1px 9px; margin-right: 6px; }
.tag b { color: var(--fg); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 500; font-size: 12px; color: var(--dim);
     border-bottom: 1px solid var(--line); padding: 8px 10px 8px 0; }
td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
td.proj { font-weight: 500; }
td.num { color: var(--dim); font-variant-numeric: tabular-nums; width: 60px; }
td.dim, .dim { color: var(--dim); }
.sess { display: flex; gap: 12px; align-items: baseline; padding: 8px 10px; margin-left: -10px;
        border-radius: 6px; text-decoration: none; }
.sess:hover { background: var(--soft); }
.sess .agent { font-size: 12px; color: var(--dim); width: 82px; flex: none;
               font-family: ui-monospace, monospace; }
.sess .time { font-size: 12px; color: var(--dim); width: 46px; flex: none; font-variant-numeric: tabular-nums; }
.sess .dur { font-size: 12px; color: var(--dim); width: 44px; flex: none; text-align: right; }
.sess .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.messages { margin-top: 26px; }
.msg { border-top: 1px solid var(--line); padding: 10px 0 12px; }
.msg > summary { cursor: pointer; font-size: 12px; color: var(--dim); list-style: none;
                 user-select: none; display: flex; gap: 8px; align-items: baseline; }
.msg > summary::-webkit-details-marker { display: none; }
.msg > summary::before { content: "▸"; font-size: 9px; color: var(--dim); }
.msg[open] > summary::before { content: "▾"; }
.msg.user > summary { color: var(--user); }
.msg.assistant > summary { color: var(--assistant); }
.msg.system > summary { color: var(--sys); }
.msg .time { color: var(--dim); font-variant-numeric: tabular-nums; }
.parts { margin-top: 8px; }
.text { white-space: pre-wrap; word-wrap: break-word; margin: 0 0 10px; }
.text:last-child { margin-bottom: 0; }
.tool, .reasoning { margin: 8px 0; border-left: 2px solid var(--line); padding-left: 12px; }
.tool > summary, .reasoning > summary { cursor: pointer; font-size: 13px; color: var(--tool);
                                        font-family: ui-monospace, monospace; }
.reasoning > summary { color: var(--dim); }
.tool .tname { font-weight: 600; }
.folded { margin: 8px 0; border-left: 2px solid var(--line); padding-left: 12px; }
.folded > summary { cursor: pointer; font-size: 12px; color: var(--dim);
                    font-family: ui-monospace, monospace; }
.folded > summary .tname { color: var(--tool); font-weight: 600; }
.folded-body { margin-top: 8px; }
.hint { font-size: 12px; color: var(--dim); margin: 4px 0; }

/* 环境层 */
.tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 0 0 22px;
        border-bottom: 1px solid var(--line); }
.tabs a { font-size: 13px; color: var(--dim); text-decoration: none; padding: 7px 12px 8px;
          border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs a:hover { color: var(--fg); }
.tabs a.on { color: var(--fg); border-bottom-color: var(--assistant); font-weight: 500; }
.cards { display: flex; gap: 10px; flex-wrap: wrap; margin: 4px 0 22px; }
.card { flex: 1 1 120px; border: 1px solid var(--line); border-radius: 8px;
        padding: 12px 14px; background: var(--soft); }
.card b { display: block; font-size: 22px; font-weight: 600; line-height: 1.2;
          font-variant-numeric: tabular-nums; }
.card span { font-size: 12px; color: var(--dim); }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
@media (max-width: 680px) { .two-col { grid-template-columns: 1fr; gap: 0; } }
/* 交接表：从/到两列是 Agent 名，间隔列右对齐便于纵向比较 */
table.handoff { width: 100%; border-collapse: collapse; font-size: 13px; }
table.handoff th { text-align: left; font-weight: 500; color: var(--dim); font-size: 12px;
                   padding: 6px 8px; border-bottom: 1px solid var(--line); }
table.handoff td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.handoff td.agent { white-space: nowrap; color: var(--agent); }
table.handoff td.num { white-space: nowrap; text-align: right;
                       font-variant-numeric: tabular-nums; color: var(--dim); }
table.handoff tr.warn td.num { color: var(--warn); }
table.handoff td a { color: var(--fg); text-decoration: none; }
table.handoff td a:hover { text-decoration: underline; }
@media (max-width: 680px) {
  table.handoff th:nth-child(4), table.handoff td:nth-child(4) { display: none; }
}
.finding { border-top: 1px solid var(--line); padding: 12px 0; }
.finding b { font-weight: 500; font-size: 14px; }
.finding p { margin: 5px 0 0; font-size: 13px; line-height: 1.7; }
.badge-warn { display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center;
              font-size: 11px; font-weight: 600; color: #8a5a00; background: rgba(255,190,0,.18);
              border: 1px solid rgba(255,190,0,.42); border-radius: 50%; }
@media (prefers-color-scheme: dark) {
  .badge-warn { color: #e0b463; background: rgba(255,190,0,.12); border-color: rgba(255,190,0,.3); }
}
.warn-line { font-size: 13px; margin: 6px 0; line-height: 1.7; }

/* 导出等操作链接 */
.actions { margin: 14px 0 4px; display: flex; gap: 10px; flex-wrap: wrap; }
.actions a {
  font-size: 12px; color: var(--dim); text-decoration: none;
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px;
}
.actions a:hover { color: var(--fg); border-color: var(--dim); }

/* 项目摘要（视图层，与事实层视觉上分开） */
.digest { margin: 18px 0 22px; border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px;
          background: var(--soft); }
.digest > summary { cursor: pointer; font-size: 13px; font-weight: 500; color: var(--fg); }
.digest-body { margin-top: 12px; font-size: 14px; line-height: 1.75; }
.digest-body h2, .digest-body h3, .digest-body h4, .digest-body h5 {
  font-size: 14px; margin: 16px 0 6px; font-weight: 600;
}
.digest-body h2:first-child, .digest-body h3:first-child { margin-top: 0; }
.digest-body p { margin: 0 0 8px; }
.digest-body ul, .digest-body ol { margin: 6px 0 10px; padding-left: 22px; }
.digest-body li { margin: 3px 0; }
.stale-badge { display: inline-block; font-size: 11px; color: #8a5a00; background: rgba(255,190,0,.16);
               border: 1px solid rgba(255,190,0,.4); border-radius: 999px; padding: 0 8px;
               margin-left: 6px; font-weight: 500; }
@media (prefers-color-scheme: dark) {
  .stale-badge { color: #e0b463; background: rgba(255,190,0,.12); border-color: rgba(255,190,0,.3); }
}
.stale-head { margin: 8px 0 4px; font-size: 13px; color: var(--fg); font-weight: 500; }
.stale-list { margin: 0 0 10px; padding-left: 20px; font-size: 13px; color: var(--dim); }

/* 搜索 */
.search { display: flex; gap: 8px; margin: 0 0 18px; }
.search input {
  flex: 1; font: inherit; font-size: 14px; color: var(--fg); background: var(--soft);
  border: 1px solid var(--line); border-radius: 7px; padding: 8px 12px; outline: none;
}
.search input:focus { border-color: var(--assistant); }
.search button {
  font: inherit; font-size: 13px; color: var(--fg); background: var(--soft);
  border: 1px solid var(--line); border-radius: 7px; padding: 8px 16px; cursor: pointer;
}
.search button:hover { border-color: var(--dim); }
.search.topbar { max-width: 320px; margin: 0 0 26px; }
.search.topbar input { font-size: 13px; padding: 6px 10px; }
.search.topbar button { display: none; }
.hits { margin-top: 8px; }
.hit { border-top: 1px solid var(--line); padding: 14px 0; }
.hit-head { font-size: 15px; font-weight: 500; margin-bottom: 6px; }
.hit-head a { text-decoration: none; }
.hit-head a:hover { text-decoration: underline; }
.hit-meta { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
            font-size: 12px; color: var(--dim); margin-bottom: 8px; }
.hit-snip { font-size: 13px; color: var(--dim); line-height: 1.7; word-wrap: break-word; }
mark { background: rgba(255, 200, 0, .28); color: inherit; border-radius: 2px; padding: 0 1px; }
@media (prefers-color-scheme: dark) { mark { background: rgba(255, 200, 0, .22); } }
.tool h4 { font-size: 11px; color: var(--dim); font-weight: 500; margin: 10px 0 4px;
           text-transform: uppercase; letter-spacing: .05em; }
pre { background: var(--soft); border-radius: 6px; padding: 10px 12px; overflow-x: auto;
      font-size: 12px; line-height: 1.5; margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
</style>
</head><body>${bar}${body}</body></html>`;
}

function pageNotFound(msg = '页面不存在') {
  return layout(
    '未找到',
    `<p><a href="/">← 所有项目</a></p><h1>${esc(msg)}</h1>
     <p class="sub">可以回到 <a href="/">项目列表</a> 重新找。</p>`
  );
}

/* ------------------------------ 格式化 ------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 往 <script> 里塞 JSON 时不能直接用 JSON.stringify：
 * 字符串里的 "</script>" 会提前结束脚本块。转义尖括号就安全了，
 * 而 JSON 语义不受影响。
 */
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function clip(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + `\n…（已截断，原 ${s.length} 字）` : s;
}

function summarizeInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input, 90);
  if (typeof input === 'object') {
    if (Array.isArray(input.command)) return oneLine(input.command.join(' '), 90);
    for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'prompt']) {
      if (typeof input[k] === 'string' && input[k]) return oneLine(input[k], 90);
    }
    return oneLine(JSON.stringify(input), 70);
  }
  return String(input);
}

function oneLine(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(d) {
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(d) {
  if (!d) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDur(ms) {
  if (!ms || ms < 1000) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = ms / 3600000;
  return h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

export { projectKey };
