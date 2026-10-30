import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listProjects, projectTimeline, groupByAgent, findSessions, readSessionContent } from './query.js';
import { search } from './search.js';
import { timelineMarkdown, sessionMarkdown, bundleMarkdown } from './export.js';
import { latestProjectDigest } from './digest.js';
import { projectHandoffs } from './handoff.js';
import { quickFreshness } from './refresh.js';
import { projectKey, durationMs, tildify } from './model.js';
import { buildTurns } from './turns.js';
import { usageSnapshot } from './web/data.js';
import * as pages from './web/pages.js';

/**
 * 本地只读查看器。
 *
 * 同一个进程同时提供三种东西：
 *   - 给人看的 HTML 页面（src/web/pages.js）
 *   - 给其他 Agent 读的 JSON 接口（/api/*）
 *   - 页面自己的静态资源（/assets/*，本地文件，不引 CDN）
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

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

const ASSETS = {
  '/assets/theme.css': { file: 'theme.css', type: 'text/css; charset=utf-8' },
  '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

/**
 * 内容安全策略。
 *
 * 页面不执行任何内联脚本（交互全在 /assets/app.js），所以 script-src 只留 'self'。
 * 内联 style 仍然允许：图表宽度是服务端算出来的百分比，写在 style 属性上。
 * 默认 default-src 'none'：图片、字体、连接都只能是本机。
 */
const CSP =
  "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
  "img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
  "connect-src 'self'; font-src 'self'";

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const USAGE_TABS = [
  ['agent', 'Agent'],
  ['model', '模型'],
  ['project', '项目'],
  ['day', '日期'],
];

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
  const pathname = url.pathname;

  try {
    if (ASSETS[pathname]) return sendAsset(req, res, ASSETS[pathname]);

    if (pathname === '/') return sendHtml(res, await pages.pageProjects());
    if (pathname === '/p') {
      return sendHtml(
        res,
        await pages.pageTimeline(
          url.searchParams.get('path') || '',
          url.searchParams.get('all') === '1'
        )
      );
    }
    if (pathname === '/usage') {
      return sendHtml(res, await pages.pageUsage(url.searchParams.get('by') || 'agent'));
    }
    if (pathname === '/search') {
      return sendHtml(
        res,
        await pages.pageSearch(
          url.searchParams.get('q') || '',
          url.searchParams.get('agent') || '',
          url.searchParams.get('limit') || ''
        )
      );
    }
    if (pathname === '/handoff') {
      return sendHtml(
        res,
        await pages.pageHandoff(
          url.searchParams.get('path') || '',
          url.searchParams.get('all') === '1'
        )
      );
    }
    if (pathname === '/s') {
      return sendHtml(
        res,
        await pages.pageSession(
          url.searchParams.get('agent') || '',
          url.searchParams.get('id') || '',
          // 禁用 JS 时的兜底：一次渲染完整会话
          url.searchParams.get('all') === '1'
        )
      );
    }
    if (pathname === '/env') {
      return sendHtml(res, await pages.pageEnv(url.searchParams.get('tab') || 'overview'));
    }

    if (pathname === '/api/projects') {
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

    if (pathname === '/api/timeline') {
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

    if (pathname === '/api/handoff') {
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

    if (pathname === '/api/usage') {
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

    if (pathname === '/api/agents') {
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

    if (pathname === '/api/search') {
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
    if (pathname === '/export') {
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
        'x-content-type-options': 'nosniff',
      });
      return res.end(md);
    }

    if (pathname === '/api/digest') {
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

    // 会话页的分块追加。返回服务端渲染好的消息 HTML，
    // 页面脚本直接插到 #messages 末尾，不在浏览器里重排一遍。
    if (pathname === '/api/session/html') {
      const agent = url.searchParams.get('agent') || undefined;
      const id = url.searchParams.get('id');
      if (!id) return sendJson(res, { error: '缺少 id 参数' }, 400);

      const rawOffset = url.searchParams.get('offset');
      if (rawOffset !== null && !/^\d+$/.test(rawOffset)) {
        return sendJson(res, { error: 'offset 必须是非负整数' }, 400);
      }

      const { matches } = findSessions({ query: id, agent });
      if (!matches.length) return sendJson(res, { error: '没有匹配的会话' }, 404);

      const rawLimit = Number(url.searchParams.get('limit'));
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : pages.SESSION_CHUNK;

      const session = matches[0];
      const messages = await readSessionContent(session);
      const range = pages.sessionChunkRange(messages.length, rawOffset === null ? 0 : Number(rawOffset), limit);

      return sendJson(res, {
        // 和 /api/session 一致：前缀命中多场时取最近一场，并在这里说明
        ambiguous: matches.length > 1,
        matchCount: matches.length,
        session: publicSession(session),
        html: pages.renderMessagesHtml(messages.slice(range.offset, range.end), range.offset),
        offset: range.offset,
        nextOffset: range.nextOffset,
        total: range.total,
        hasMore: range.hasMore,
      });
    }

    if (pathname === '/api/session') {
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

      // 默认只给前 200 条。一场大会话常有十几万字（约 5 万 token），
      // 直出整场会让任何调这个接口的 Agent 一次烧掉大量上下文；网页的
      // 折叠块走的是 `?message=N`，不受影响。需要更多就显式翻页。
      const rawLimit = Number(url.searchParams.get('limit'));
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200;
      const rawOffset = Number(url.searchParams.get('offset'));
      const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
      const page = messages.slice(offset, offset + limit);
      const hasMore = offset + page.length < messages.length;

      return sendJson(res, {
        ambiguous: matches.length > 1,
        matchCount: matches.length,
        session: publicSession(session),
        messages: page,
        // 目录按完整会话算，不受分页影响：调用方按 offset 翻页时也能定位轮次
        turns: buildTurns(messages),
        total: messages.length,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + page.length : null,
      });
    }

    if (pathname === '/api/env') {
      const { fullInventory, auditEnvironment } = await import('./env/inventory.js');
      const tab = url.searchParams.get('tab') || 'overview';

      if (tab === 'audit') return sendJson(res, auditEnvironment());
      if (tab === 'usage') {
        const { skillUsageSummary } = await import('./env/usage.js');
        return sendJson(res, await skillUsageSummary({}));
      }

      const inv = fullInventory();
      if (tab === 'mcp') return sendJson(res, inv.mcp);
      if (tab === 'cli') return sendJson(res, inv.cli);
      if (tab === 'skills') return sendJson(res, inv.skills);
      if (tab === 'memory') return sendJson(res, inv.memory);
      return sendJson(res, inv);
    }

    return sendHtml(res, await pages.pageNotFound(), 404);
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
  send(
    res,
    code,
    {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
    },
    html
  );
}

function send(res, code, headers, body) {
  res.writeHead(code, {
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}

/**
 * 静态资源。
 *
 * 只认白名单里的两个文件（没有目录穿越的可能），从磁盘读、带 ETag。
 * 用 no-cache 而不是 no-store：刷新页面时能拿到 304，改完 CSS 重启也不用清缓存。
 */
function sendAsset(req, res, asset) {
  const file = path.join(WEB_DIR, asset.file);
  let buf;
  let stat;
  try {
    stat = fs.statSync(file);
    buf = fs.readFileSync(file);
  } catch {
    return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, '资源不存在');
  }

  const etag = `W/"${buf.length}-${Math.round(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    return res.end();
  }

  res.writeHead(200, {
    'content-type': asset.type,
    'cache-control': 'no-cache',
    etag,
    ...SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export { projectKey };
