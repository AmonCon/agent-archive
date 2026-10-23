#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listProjects, projectTimeline, groupByAgent, findSessions, readSessionContent } from './query.js';
import { cacheLocation } from './registry.js';
import { tildify, durationMs } from './model.js';
import { buildIndex, search, indexStats, indexPath } from './search.js';
import { timelineMarkdown, sessionMarkdown, bundleMarkdown } from './export.js';
import { auditCollection, detectGaps } from './doctor.js';
import { scanSecrets } from './secrets.js';
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  agent: '\x1b[36m',
  when: '\x1b[33m',
  title: '\x1b[0m',
  ok: '\x1b[32m',
  warn: '\x1b[35m',
  user: '\x1b[32m',
  assistant: '\x1b[36m',
  system: '\x1b[90m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? code + s + C.reset : s);

function fmtDate(d) {
  if (!d) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDur(ms) {
  if (!ms || ms < 1000) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = ms / 3600000;
  return h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

function usage() {
  console.log(`agent-archive — 跨 Agent 的项目级会话档案馆

用法:
  agent-archive projects                       列出本机所有有会话的项目
  agent-archive timeline <项目路径>            某个项目的会话时间线
  agent-archive agents <项目路径>              某个项目里各 Agent 的分布
  agent-archive stats                          扫描统计与缓存位置
  agent-archive doctor                         采集体检（覆盖率与缺口）
  agent-archive secrets                        扫描归档里的明文凭证
  agent-archive llm                            配置模型接入（查看/设置）
  agent-archive digest <项目>                  生成项目摘要（默认只估算）
  agent-archive refresh                        审计/刷新已过期的摘要
  agent-archive cat [会话]                     读一场会话的正文
  agent-archive index                          建/更新全文索引
  agent-archive search <词>                    全文搜索
  agent-archive export <项目>                  导出项目时间线 Markdown
  agent-archive export <项目> --bundle         导出该项目全部会话正文
  agent-archive export <id> --session          导出单场会话正文
  agent-archive serve                          起本地网页查看器
  agent-archive mcp                            打印 MCP 配置（接给别的 Agent）

cat 的会话参数:
  <id 前缀>                按会话 id 匹配，不必抄全
  省略                     配合 --project 取该项目最近一场
  多个匹配                 列出候选，再用全一点的 id 重试

选项:
  --json        输出 JSON
  --no-cache    忽略缓存，全量重扫
  --flat        时间线不按天分组
  --project <路径>        限制在某个项目内查找（cat）
  --agent <名字>          限制在某个 Agent 内查找（cat）
  --port <端口>           网页端口（serve，默认 7788）
  --limit <n>             搜索结果条数（search，默认 20）
  --force                 忽略增量判断，重建全部（index）
  --session               导出单场会话（export）
  --bundle                导出项目全部会话（export）
  --out <文件>            写入文件而不是 stdout（export / digest）
  --run                   真的执行模型调用（digest / refresh）
  --key <值>              设置 API Key（llm）
  --model <值>            设置模型名（llm）
  --base-url <值>         设置接口地址（llm）
  --provider <openai|anthropic>  请求形状（llm）
  --tools       正文里展开工具调用与输出（默认折叠）
  --reasoning   正文里显示推理摘要（默认隐藏）
  --system      正文里展开注入的系统内容（默认折叠）
  --no-color    关闭颜色

示例:
  agent-archive projects
  agent-archive timeline E:\\my-app
  agent-archive cat --project . 
  agent-archive cat 1d551b54 --tools
  agent-archive search 迁移
  agent-archive serve
`);
}

async function cmdProjects(opts) {
  const { projects, stats, totalSessions, unbound } = listProjects({
    noCache: opts.noCache,
    showAll: opts.showAll,
  });

  if (opts.json) {
    console.log(JSON.stringify({ projects, totalSessions, stats, unbound }, null, 2));
    return;
  }

  if (!projects.length && !unbound) {
    console.log('没有找到任何会话。');
    return;
  }

  console.log(
    c(C.bold, '项目') + c(C.dim, `  (${projects.length} 个, ${totalSessions} 个会话)`) + '\n'
  );

  const width = Math.min(60, Math.max(...projects.map((p) => tildify(p.display).length), 10));
  for (const p of projects) {
    const disp = tildify(p.display);
    const pad = disp.length < width ? ' '.repeat(width - disp.length) : '';
    const agents = p.agents.map((a) => c(C.agent, a)).join(c(C.dim, ','));
    console.log(
      `${c(C.bold, disp)}${pad}  ${c(C.dim, String(p.count).padStart(3) + ' 会话')}  ${agents}  ${c(
        C.dim,
        fmtDate(p.end)
      )}`
    );
  }

  // 不绑定项目的会话单独列出：Hermes 这类接聊天渠道的助手本来就没有
  // 工作目录，把它们藏起来等于假装这些对话没发生过。
  if (unbound) {
    console.log('');
    console.log(
      c(C.bold, '无项目归属') +
        c(C.dim, `  (${unbound.count} 个会话，这类 Agent 不绑定工作目录)`)
    );
    for (const a of unbound.agents) {
      console.log(
        `  ${c(C.agent, a.agent.padEnd(12))} ${c(C.dim, String(a.count).padStart(3) + ' 会话')}  ${c(
          C.dim,
          fmtDate(a.end)
        )}`
      );
    }
  }
}

async function cmdTimeline(target, opts) {
  if (!target) {
    console.error('需要项目路径。用 agent-archive projects 先看看有哪些。');
    process.exit(2);
  }

  // 不预先 stat 路径：会话里记的项目可能已经不在磁盘上（删了、移走了），
  // 档案馆要能回答"它曾经存在过"，而不是只对现存目录有效。
  const r = projectTimeline(target, { noCache: opts.noCache });

  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const { summary, sessions } = r;
  if (!sessions.length) {
    console.log(`项目 ${abs} 下没有找到会话。`);
    console.log(c(C.dim, `（扫描了 ${r.stats.files} 个文件，${r.orphanCount} 个会话未识别出项目路径）`));
    return;
  }

  console.log(c(C.bold, tildify(r.target)));
  console.log(
    c(
      C.dim,
      `${summary.count} 个会话 · ${summary.agents.join(' / ')} · ${fmtDate(summary.first)} → ${fmtDate(
        summary.last
      )} · 累计 ${fmtDur(summary.totalMs)}`
    )
  );

  if (opts.flat) {
    console.log('');
    for (const s of sessions) printSession(s, 0);
    return;
  }

  let currentDay = null;
  for (const s of sessions) {
    const day = s.start ? s.start.toISOString().slice(0, 10) : '(未知日期)';
    if (day !== currentDay) {
      currentDay = day;
      console.log('\n' + c(C.when, day));
    }
    printSession(s, 2);
  }
}

function printSession(s, indent) {
  const pad = ' '.repeat(indent);
  const agent = c(C.agent, s.agent.padEnd(12));
  const time = c(C.dim, fmtDate(s.start).slice(11) || '     ');
  const dur = c(C.dim, fmtDur(durationMs(s)).padStart(6));
  console.log(`${pad}${agent} ${time} ${dur}  ${s.title}`);
}

async function cmdAgents(target, opts) {
  if (!target) {
    console.error('需要项目路径。');
    process.exit(2);
  }
  const r = projectTimeline(target, { noCache: opts.noCache });
  const groups = groupByAgent(r.sessions);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { target: r.target, agents: groups.map(([a, ss]) => ({ agent: a, count: ss.length })) },
        null,
        2
      )
    );
    return;
  }

  console.log(c(C.bold, tildify(r.target)) + '\n');
  for (const [agent, ss] of groups) {
    const total = ss.reduce((n, s) => n + durationMs(s), 0);
    const first = ss.reduce((a, s) => (!a || (s.start && s.start < a) ? s.start : a), null);
    const last = ss.reduce((a, s) => (!a || (s.end && s.end > a) ? s.end : a), null);
    console.log(
      `${c(C.agent, agent.padEnd(14))} ${String(ss.length).padStart(3)} 会话  ${c(
        C.dim,
        fmtDur(total).padStart(7)
      )}  ${c(C.dim, fmtDate(first) + ' → ' + fmtDate(last))}`
    );
  }
}

/**
 * 读一场会话的正文。
 *
 * 终端里读长会话，噪声比信息多：一场两小时的对话可能有几千行工具输出。
 * 所以默认只显示谁说了什么，工具调用压成一行、推理默认隐藏，
 * 用 --tools / --reasoning 才展开。这是"能读"和"读得下去"的区别。
 */
async function cmdCat(idArg, opts) {
  const { matches, total } = findSessions({ query: idArg, agent: opts.agent, project: opts.project });

  if (!matches.length) {
    console.error(idArg ? `没有匹配 ${idArg} 的会话。` : '没有可读的会话，试试加上 --project 或给会话 id。');
    process.exit(2);
  }

  if (matches.length > 1 && !idArg) {
    // 没给 id 时，列候选比替你挑一个更诚实
    console.log(c(C.bold, `匹配 ${total} 场会话，最近的 ${matches.length} 场：`) + '\n');
    for (const s of matches) {
      console.log(
        `  ${c(C.agent, s.agent.padEnd(12))} ${c(C.dim, fmtDate(s.start))}  ${c(C.dim, s.id.slice(0, 12))}  ${s.title}`
      );
    }
    console.log('\n' + c(C.dim, '用 agent-archive cat <id 前缀> 读其中一场。'));
    return;
  }

  if (matches.length > 1 && idArg) {
    console.log(c(C.bold, `${total} 场会话匹配 ${idArg}，请用更长的 id 前缀：`) + '\n');
    for (const s of matches) {
      console.log(`  ${c(C.agent, s.agent.padEnd(12))} ${c(C.dim, s.id)}  ${s.title}`);
    }
    return;
  }

  const session = matches[0];
  let messages;
  try {
    messages = await readSessionContent(session);
  } catch (e) {
    console.error(c(C.warn, '读不了这场会话: ') + (e && e.message ? e.message : e));
    process.exit(1);
  }

  if (opts.json) {
    // 这个输出可能被其他 Agent 直接消费，路径统一缩成 ~ 形式，
    // 不把用户名和完整盘符路径当成接口的一部分。
    console.log(
      JSON.stringify(
        {
          session: {
            ...session,
            project: session.project ? tildify(session.project) : null,
            source: session.source ? tildify(session.source) : null,
          },
          messages,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(c(C.bold, session.title));
  console.log(
    c(
      C.dim,
      `${session.agent} · ${session.id} · ${fmtDate(session.start)} → ${fmtDate(session.end)} · ${fmtDur(
        durationMs(session)
      )}`
    )
  );
  if (session.project) console.log(c(C.dim, tildify(session.project)));
  console.log('');

  let pendingSystem = 0;
  const showTools = opts.tools;
  const showReasoning = opts.reasoning;
  const showSystem = opts.system;

  for (const m of messages) {
    if (m.role === 'system' && !showSystem) {
      // 相邻的折叠提示合并成一条：Claude Code 开场连着六条斜杠命令，
      // 逐条打印占的版面比命令本身还多
      pendingSystem += m.parts.reduce((k, p) => k + (p.kind === 'text' ? p.text.length : 0), 0);
      continue;
    }
    if (pendingSystem) {
      console.log(c(C.system, `   · 系统注入（${pendingSystem} 字，--system 展开）`) + '\n');
      pendingSystem = 0;
    }
    renderMessage(m, { showTools, showReasoning, showSystem });
  }
  if (pendingSystem) {
    console.log(c(C.system, `   · 系统注入（${pendingSystem} 字，--system 展开）`));
  }
}

function renderMessage(m, { showTools, showReasoning, showSystem }) {
  const label =
    m.role === 'user' ? c(C.user, '› 用户') :
    m.role === 'assistant' ? c(C.assistant, '‹ 助手') :
    m.role === 'tool' ? c(C.dim, '· 工具输出') :
    c(C.system, '· 系统');

  const time = m.ts ? c(C.dim, fmtDate(m.ts).slice(11)) : '';
  const head = `${label}${time ? ' ' + time : ''}`;

  const shown = [];
  for (const p of m.parts) {
    if (p.kind === 'text') shown.push(indent(p.text));
    else if (p.kind === 'reasoning') {
      if (!showReasoning) continue;
      shown.push(c(C.system, indent('[推理] ' + firstLine(p.text, 200))));
    } else if (p.kind === 'tool') {
      shown.push(c(C.dim, indent(oneLineTool(p))));
      if (!showTools) continue;
      if (p.input) shown.push(c(C.dim, indent(indent(truncate(pretty(p.input), 1200)))));
      if (p.output) shown.push(c(C.dim, indent(indent(truncate(p.output, 2000)))));
    }
  }

  // 整条都被折叠掉时不打空标题：一场会话里这类"只有工具调用"的消息很多，
  // 每条留个空壳会把正文撑成噪点。
  if (!shown.length) return;
  console.log(head);
  console.log(shown.join('\n'));
  console.log('');
}

function oneLineTool(p) {
  const name = p.name || 'tool';
  const detail = summarizeInput(p.input);
  const mark = p.status === 'error' ? ' ✗' : '';
  return `[${name}${detail ? ' ' + detail : ''}]${mark}`;
}

/** 把工具入参压成一行摘要，认几种常见形状，其余退化成 JSON 前 80 字。 */
function summarizeInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return clip(input, 80);
  if (typeof input === 'object') {
    // Codex 的 shell 调用是 {command:["powershell.exe","-NoProfile",...]}，
    // 整串数组没信息量，最后一项才是真正的命令
    if (Array.isArray(input.command)) {
      const cmd = input.command;
      const takesArg = (s) => typeof s === 'string' && /^-(NoProfile|Command|c|EncodedCommand)$/i.test(s);
      for (let i = cmd.length - 1; i >= 0; i--) {
        if (typeof cmd[i] === 'string' && cmd[i].length > 3 && !takesArg(cmd[i])) return clip(cmd[i], 100);
      }
      return clip(cmd.join(' '), 100);
    }
    for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'prompt']) {
      if (typeof input[k] === 'string' && input[k]) return clip(input[k], 100);
    }
    return clip(pretty(input), 80);
  }
  return String(input);
}

function indent(s, pad = '   ') {
  return String(s)
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function truncate(s, n) {
  const t = String(s);
  if (t.length <= n) return t;
  return t.slice(0, n) + `\n…（已截断，原 ${t.length} 字）`;
}

function firstLine(s, n) {
  return clip(String(s).split('\n')[0], n);
}

function pretty(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * 起本地只读查看器。
 *
 * 只监听 127.0.0.1：这是给"我现在就想看看"用的，不是部署服务。
 * 页面和 JSON 接口由同一个进程提供，所以浏览器里看到的和 Agent
 * 读到的永远是同一份数据。
 */
async function cmdServe(opts) {
  const { startServer } = await import('./server.js');

  const port = opts.port ? Number(opts.port) : 7788;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`端口不合法: ${opts.port}`);
    process.exit(2);
  }

  let started;
  try {
    started = await startServer({ port });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用，换一个：agent-archive serve --port ${port + 1}`);
      process.exit(2);
    }
    throw e;
  }

  console.log(c(C.bold, '会话档案馆'));
  console.log(`  ${started.url}`);
  console.log(c(C.dim, '  Ctrl+C 停止。只监听本机，只读。'));
  console.log('');
  if (opts.json) {
    console.log(JSON.stringify({ url: started.url, port }));
  }
}

/**
 * 建全文索引。
 *
 * 全量重建一次约一分多钟，之后只处理源文件变了的会话，通常几百毫秒。
 */
async function cmdIndex(opts) {
  const force = opts.flags.has('--force');
  // 进度只在交互式终端里显示。重定向到文件时每次写 stderr 都是一次真实 I/O，
  // 几百次刷新会把建索引的时间拖长好几倍（实测 56s → 一两分钟以上）。
  const showProgress = process.stderr.isTTY;
  if (showProgress) process.stderr.write('扫描并建索引…\n');

  let last = 0;
  const t0 = Date.now();
  const r = await buildIndex({
    force,
    onProgress: showProgress
      ? ({ phase, i, total, rebuilt }) => {
          if (Date.now() - last < 500) return;
          last = Date.now();
          const label = phase === 'index' ? '建倒排索引' : '读正文';
          process.stderr.write(`\r  ${label} ${i}/${total}，已重建 ${rebuilt} 场  `);
        }
      : undefined,
  });
  if (showProgress) process.stderr.write(' '.repeat(48) + '\r');

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (opts.json) {
    console.log(JSON.stringify({ ...r, seconds: Number(secs) }, null, 2));
    return;
  }
  console.log(c(C.bold, '索引已更新') + c(C.dim, `  (${secs}s)`));
  console.log(`  会话总数  ${r.total}`);
  console.log(`  复用      ${r.reused}`);
  console.log(`  重建      ${r.rebuilt}`);
  console.log(`  清理      ${r.removed}`);
  if (r.failed) {
    console.log(`  读不出    ${r.failed}`);
    console.log(
      c(
        C.dim,
        '            这些会话的数据格式读不了解（如 Antigravity 的加密 .pb），' +
          '元数据仍在时间线里，只是进不了全文索引。'
      )
    );
  }
  console.log('');
  const s = indexStats();
  console.log(c(C.dim, `索引: ${tildify(indexPath())}  ${(s.bytes / 1e6).toFixed(0)} MB`));
}

/**
 * 全文搜索。
 *
 * 搜的是"人说的话 + 工具调用摘要"，不含完整工具输出——
 * 后者多是日志和源码，会把真正的对话淹掉。
 */
/**
 * 只重建倒排索引，不重读任何会话。
 *
 * 换分词策略、或者索引写坏了之后用它，比全量重建快得多。
 */
async function cmdReindex(opts) {
  const { rebuildFts, openIndex } = await import('./search.js');
  const db = openIndex({ create: false });
  if (!db) {
    console.error('还没有索引。先运行：agent-archive index');
    process.exit(2);
  }
  const t0 = Date.now();
  rebuildFts(db);
  const docs = indexStats().docs;
  db.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (opts.json) {
    console.log(JSON.stringify({ docs, seconds: Number(secs) }, null, 2));
    return;
  }
  console.log(c(C.bold, '倒排索引已重建') + c(C.dim, `  ${docs} 场，${secs}s`));
}

async function cmdSearch(query, opts) {
  if (!query) {
    console.error('需要搜索词。例：agent-archive search 迁移');
    process.exit(2);
  }

  const r = search(query, {
    limit: opts.limit ? Number(opts.limit) : 20,
    agent: opts.agent,
    project: opts.project,
  });

  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!r.ready) {
    console.error(r.message);
    process.exit(2);
  }

  if (!r.hits.length) {
    console.log(`没有找到包含「${query}」的会话。`);
    return;
  }

  console.log(c(C.bold, `「${query}」`) + c(C.dim, `  ${r.total} 场会话`) + '\n');
  for (const h of r.hits) {
    console.log(
      `${c(C.agent, h.agent.padEnd(12))} ${c(C.dim, fmtDate(h.start))}  ${c(C.dim, h.id.slice(0, 12))}`
    );
    console.log(`  ${c(C.bold, h.title)}`);
    if (h.project) console.log(c(C.dim, `  ${tildify(h.project)}`));
    if (h.snippet) console.log(c(C.dim, '  ' + indent(h.snippet, '  ').trim()));
    console.log('');
  }
  console.log(c(C.dim, `读某一场：agent-archive cat <id>   ·   索引：${tildify(indexPath())}`));
}

/**
 * 导出 Markdown。
 *
 * 三种粒度，用 --session / --bundle 切换，默认是项目时间线：
 *   export <项目>              时间线清单
 *   export <项目> --bundle     该项目所有会话正文合成一份
 *   export <id> --session      单场会话正文
 *
 * 不给 --out 就写 stdout，方便重定向；给了就写文件并报路径。
 */
async function cmdExport(target, opts) {
  const mode = opts.flags.has('--bundle') ? 'bundle' : opts.flags.has('--session') ? 'session' : 'timeline';

  if (!target) {
    console.error(
      '需要目标。例：agent-archive export E:\\my-app\n' +
        '            agent-archive export 01a11a93 --session'
    );
    process.exit(2);
  }

  let md;
  try {
    if (mode === 'session') {
      const { matches, total } = findSessions({ query: target, agent: opts.agent });
      if (!matches.length) {
        console.error(`没有匹配 ${target} 的会话。`);
        process.exit(2);
      }
      if (matches.length > 1) {
        console.error(`${total} 场会话匹配 ${target}，请用更长的 id 前缀。`);
        for (const s of matches.slice(0, 5)) {
          console.error(`  ${s.agent.padEnd(12)} ${s.id}  ${s.title}`);
        }
        process.exit(2);
      }
      md = await sessionMarkdown(matches[0], {
        tools: opts.tools,
        reasoning: opts.reasoning,
        system: opts.system,
      });
    } else if (mode === 'bundle') {
      const showProgress = process.stderr.isTTY;
      md = await bundleMarkdown(target, {
        limit: opts.limit ? Number(opts.limit) : 0,
        onProgress: showProgress
          ? ({ i, total }) => {
              if (i % 20 === 0) process.stderr.write(`\r  导出 ${i}/${total}  `);
            }
          : undefined,
      });
      if (showProgress) process.stderr.write(' '.repeat(30) + '\r');
    } else {
      md = timelineMarkdown(target);
    }
  } catch (e) {
    console.error(c(C.warn, '导出失败: ') + (e && e.message ? e.message : e));
    process.exit(1);
  }

  const out = opts.out;
  if (out) {
    fs.writeFileSync(out, md, 'utf8');
    console.log(c(C.ok, '已导出 ') + out + c(C.dim, `  ${(md.length / 1024).toFixed(1)} KB`));
  } else {
    process.stdout.write(md);
  }
}

/**
 * 采集质量体检。
 *
 * 回答的不是"扫到了多少"，而是"读到了多少、读对了吗"。
 * 三根支柱——时间、项目、标题——任何一根出问题，downstream 的
 * 时间线、搜索、导出都会静默失真，所以按覆盖率报出来。
 */
async function cmdDoctor(opts) {
  const gaps = detectGaps();
  const r = await auditCollection({ noCache: opts.noCache });

  if (opts.json) {
    console.log(JSON.stringify({ ...r, gaps }, null, 2));
    return;
  }

  console.log(c(C.bold, '采集体检'));
  console.log(
    c(
      C.dim,
      `  ${r.files} 个文件 · ${r.total} 场会话 · 解析失败 ${r.failures} · 重复 id ${r.duplicates} 组`
    )
  );
  console.log('');

  // 覆盖率三根支柱
  console.log(c(C.bold, '覆盖率'));
  const bar = (v) => {
    const n = Math.round(v * 20);
    const filled = '█'.repeat(n) + '░'.repeat(20 - n);
    const pct = (v * 100).toFixed(1).padStart(5);
    return `${filled} ${pct}%`;
  };
  const line = (label, v, note) => {
    const mark = v >= 0.99 ? c(C.ok, '✓') : v >= 0.9 ? c(C.when, '!') : c(C.warn, '✗');
    console.log(`  ${mark} ${label.padEnd(8)} ${bar(v)}  ${c(C.dim, note)}`);
  };
  line('时间', r.coverage.time, '有开始与结束时间');
  line('项目', r.coverage.project, '有路径的会话里能归到真实项目');
  line('标题', r.coverage.cleanTitle, '不是占位符或注入标签');
  console.log(
    c(
      C.dim,
      `  · 无真人输入  ${((1 - r.coverage.withoutUserInput) * 100).toFixed(1)}%` +
        '  桌面端自动触发/定时任务，标题退化为来源名，属正常'
    )
  );
  console.log('');

  // 按 Agent 细看
  console.log(c(C.bold, '各 Agent'));
  const head = ['Agent', '会话', '无时间', '无项目', '临时路径', '占位标题', '正文抽样'];
  const widths = [13, 6, 7, 7, 9, 9, 10];
  console.log(c(C.dim, '  ' + head.map((h, i) => h.padEnd(widths[i])).join('')));
  for (const a of r.agents) {
    const cells = [
      a.agent,
      String(a.total),
      a.noStart || a.noEnd ? String(a.noStart + a.noEnd) : '—',
      a.noProject ? String(a.noProject) : '—',
      a.tempProject ? String(a.tempProject) : '—',
      a.placeholderTitle ? String(a.placeholderTitle) : '—',
      `${a.bodyOk}/${a.bodyTried}`,
    ];
    const colored = cells.map((v, i) => {
      if (i >= 2 && i <= 5 && v !== '—') return c(C.when, v.padEnd(widths[i]));
      if (i === 6 && a.bodyOk < a.bodyTried) return c(C.warn, v.padEnd(widths[i]));
      return i === 0 ? c(C.agent, v.padEnd(widths[i])) : c(C.dim, v.padEnd(widths[i]));
    });
    console.log('  ' + colored.join(''));
    for (const e of a.bodyErrors.slice(0, 2)) {
      console.log(c(C.dim, `      读不出: ${e}`));
    }
  }
  console.log(
    c(
      C.dim,
      '  无项目 = 该 Agent 不记录工作目录；临时路径 = 有路径但属于 Agent 的临时落脚点。'
    )
  );
  console.log('');

  // 采集缺口：有目录但没有 scanner。
  // 分成两类——"还没做"要行动，"已确认读不了"是结论，不该继续挂在待办里。
  const missing = gaps.filter((g) => g.present && !g.supported && !g.blocked);
  const blocked = gaps.filter((g) => g.present && !g.supported && g.blocked);
  const unused = gaps.filter((g) => g.present && g.supported);

  console.log(c(C.bold, '存储位置'));
  if (missing.length) {
    console.log(c(C.warn, `  ✗ ${missing.length} 个 Agent 有数据但还没接入：`));
    for (const g of missing) {
      console.log(`     ${g.name.padEnd(14)} ${c(C.dim, g.hits[0].path)}`);
    }
  }
  if (blocked.length) {
    console.log(c(C.dim, `  · 已调研、确认读不了 ${blocked.length} 个：`));
    for (const g of blocked) {
      console.log(c(C.dim, `     ${g.name.padEnd(14)} ${g.blocked}`));
    }
  }
  if (unused.length) {
    console.log(c(C.dim, `  · 已接入：${unused.map((g) => g.name).join('、')}`));
  }
  const absent = gaps.filter((g) => !g.present);
  if (absent.length) {
    console.log(c(C.dim, `  · 本机没有：${absent.map((g) => g.name).join('、')}`));
  }
  console.log('');

  // 结论一句话。只有"真的该修"的才进待办——
  // 临时路径和占位标题都是设计如此，不该长期挂着当未完成项。
  const problems = [];
  if (r.coverage.time < 0.99) problems.push('时间缺失');
  if (r.coverage.cleanTitle < 0.9) problems.push('标题');
  if (r.duplicates) problems.push('重复 id');
  if (missing.length) problems.push(`${missing.length} 个 Agent 未接入`);

  if (!problems.length) {
    console.log(c(C.ok, '采集正常') + c(C.dim, '：所有支持范围内的会话都读到了、读对了。'));
    if (r.coverage.project < 0.9) {
      console.log(
        c(C.dim, `  项目覆盖率 ${(r.coverage.project * 100).toFixed(1)}%，差额来自临时工作区（设计如此）。`)
      );
    }
  } else {
    console.log(c(C.when, '待办：') + problems.join('、'));
    if (r.coverage.project < 0.9) {
      console.log(
        c(C.dim, `  项目覆盖率 ${(r.coverage.project * 100).toFixed(1)}%，差额来自临时工作区（设计如此）。`)
      );
    }
  }
}

/**
 * MCP server 的配置说明与直接启动。
 *
 * 这个命令面向"我要让别的 Agent 读这个档案"的场景：打印出可以
 * 直接粘进各家 Agent 配置文件的 JSON，或者直接起服务（stdio）。
 */
async function cmdMcp(opts) {
  const serverPath = fileURLToPath(new URL('./mcp.js', import.meta.url));

  // 起服务模式：显式 --serve 才进 stdio 循环。
  // 不能靠 isTTY 判断——重定向输出时 isTTY 也是 false，
  // 那样 `mcp > config.json` 会误入服务模式，看起来像卡住。
  if (opts.flags.has('--serve') || opts.flags.has('--stdio')) {
    await import('./mcp.js');
    return;
  }

  const node = process.execPath;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            'agent-archive': { type: 'stdio', command: node, args: [serverPath] },
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log(c(C.bold, '把档案馆接到你自己的 Agent 上'));
  console.log('');
  console.log('这个 server 只读，提供 6 个工具：');
  console.log(c(C.dim, '  list_projects     有哪些项目'));
  console.log(c(C.dim, '  project_timeline  某项目的会话清单'));
  console.log(c(C.dim, '  search_sessions   全文搜索'));
  console.log(c(C.dim, '  read_session      读正文（分段，默认 8000 字）'));
  console.log(c(C.dim, '  session_stats     采集统计'));
  console.log(c(C.dim, '  export_timeline   导出 Markdown'));
  console.log('');
  console.log(c(C.bold, '配置（粘进对应 Agent 的 MCP 配置）'));
  console.log('');
  const conf = {
    mcpServers: {
      'agent-archive': {
        type: 'stdio',
        command: node,
        args: [serverPath],
      },
    },
  };
  console.log(JSON.stringify(conf, null, 2));
  console.log('');
  console.log(c(C.dim, '配置文件位置：'));
  console.log(c(C.dim, '  Claude Code   ~/.claude.json 或项目 .mcp.json'));
  console.log(c(C.dim, '  Codex         ~/.codex/config.toml（[mcp_servers] 段）'));
  console.log(c(C.dim, '  Cursor        ~/.cursor/mcp.json'));
  console.log(c(C.dim, '  其他          ZCode / OpenCode / Kiro 等均支持 mcpServers 格式'));
  console.log('');
  console.log(c(C.dim, '先建索引再搜：node src/cli.js index'));
}

/**
 * 扫描归档里的凭证泄漏。
 *
 * 这类东西用户自己看不见——它们埋在几万条消息里：AK 粘进对话、
 * 工具输出回显、部署脚本硬编码。档案馆有全文，扫一遍就能找出来。
 *
 * 只读。所有输出都掩码，避免这个工具自己变成泄漏渠道。
 */
async function cmdSecrets(opts) {
  const r = scanSecrets({
    agent: opts.agent,
    severity: opts.positionals[0],
  });

  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!r.ready) {
    console.error(r.message);
    process.exit(2);
  }

  if (!r.findings.length) {
    console.log(c(C.ok, '没发现明文凭证') + c(C.dim, `  （扫了 ${r.scanned} 场会话）`));
    return;
  }

  const rank = { critical: '严重', high: '高危', medium: '中危', low: '低危' };
  console.log(
    c(C.bold, '凭证泄漏扫描') +
      c(C.dim, `  ${r.scanned} 场会话，命中 ${r.findings.length} 条`) +
      '\n'
  );

  for (const f of r.findings) {
    const tag = f.severity === 'critical' ? c(C.warn, `[${rank[f.severity]}]`) : c(C.when, `[${rank[f.severity]}]`);
    console.log(`${tag} ${c(C.bold, f.label)}  ${c(C.dim, `×${f.occurrences}`)}`);
    console.log(`  ${c(C.agent, f.agent)}  ${String(f.title).slice(0, 50)}`);
    if (f.project) console.log(c(C.dim, `  ${tildify(f.project)}`));
    console.log(c(C.dim, `  …${f.context.slice(0, 120)}`));
    console.log('');
  }

  console.log(
    c(
      C.dim,
      '输出已掩码。真正的处置是去对应平台停用/轮换这些凭证，' +
        '而不是只删聊天记录——记录里删了，备份和索引里还在。'
    )
  );
}

/**
 * 配置模型接入。
 *
 * 密钥写到 ~/.agent-archive/llm.json（权限 600），**不进项目目录**——
 * 这个目录会进 git，密钥一旦进了历史就洗不掉。
 */
async function cmdLlm(opts) {
  const { loadConfig, saveConfig, maskKey, configPath } = await import('./llm.js');

  const patch = {};
  if (opts.key !== undefined) patch.apiKey = opts.key;
  if (opts.model !== undefined) patch.model = opts.model;
  if (opts.baseUrl !== undefined) patch.baseUrl = opts.baseUrl;
  if (opts.provider !== undefined) patch.provider = opts.provider;
  if (opts.priceIn !== undefined) patch.inputPricePerM = Number(opts.priceIn);
  if (opts.priceOut !== undefined) patch.outputPricePerM = Number(opts.priceOut);

  if (opts.flags.has('--clear-key')) patch.apiKey = '';

  if (Object.keys(patch).length) {
    saveConfig(patch);
    console.log(c(C.ok, '已写入 ') + tildify(configPath()));
    console.log('');
  }

  const cfg = loadConfig();
  console.log(c(C.bold, '模型配置'));
  console.log(`  请求形状    ${cfg.provider}${cfg.provider === 'anthropic' ? '（/v1/messages）' : '（/v1/chat/completions）'}`);
  console.log(`  地址        ${cfg.baseUrl}`);
  console.log(`  模型        ${cfg.model || c(C.when, '(未设置)')}`);
  console.log(`  API Key     ${maskKey(cfg.apiKey)}`);
  if (cfg.inputPricePerM != null || cfg.outputPricePerM != null) {
    console.log(`  单价        ${cfg.inputPricePerM ?? '?'} / ${cfg.outputPricePerM ?? '?'} 每百万 token`);
  } else {
    console.log(c(C.dim, '  单价        未设置，估值只报 token 不报钱'));
  }
  console.log('');
  console.log(c(C.dim, `配置：${tildify(configPath())}`));
  console.log(c(C.dim, '环境变量优先于配置文件：AGENT_ARCHIVE_LLM_API_KEY / _MODEL / _BASE_URL / _PROVIDER'));
  if (!cfg.apiKey || !cfg.model) {
    console.log('');
    console.log(c(C.when, '还差配置才能用：'));
    console.log(c(C.dim, '  agent-archive llm --key sk-xxx --model deepseek-chat --base-url https://api.deepseek.com'));
  }
}

/**
 * 生成摘要。
 *
 * 默认**只估算不执行**：模型调用要花钱，用户得先看到量级再决定。
 * 加 --run 才真的跑。这是故意的默认值。
 */
async function cmdDigest(target, opts) {
  const { digestProject, estimateProject } = await import('./digest.js');
  const { loadConfig } = await import('./llm.js');

  if (!target) {
    console.error('需要项目路径。例：agent-archive digest E:\\my-app');
    process.exit(2);
  }

  const cfg = loadConfig();
  const limit = opts.limit ? Number(opts.limit) : 60;
  const force = opts.flags.has('--force');
  const run = opts.flags.has('--run');

  // 估算只数 token、不调 API，所以不需要凭证——先让人看到量级，
  // 再决定要不要配模型。只有真执行（--run）才要求配置完整。
  if (run && (!cfg.apiKey || !cfg.model)) {
    console.error(c(C.warn, '要执行需要先配置模型。'));
    console.error(c(C.dim, '  agent-archive llm --key <key> --model <model> --base-url <url>'));
    process.exit(2);
  }

  const est = await estimateProject(target, { limit });

  if (opts.json && !run) {
    console.log(JSON.stringify({ dryRun: true, ...est }, null, 2));
    return;
  }

  if (!run) {
    console.log(c(C.bold, '预计成本'));
    console.log(`  项目        ${est.target}`);
    console.log(`  会话        ${est.sessions} 场（项目共 ${est.totalSessions} 场）`);
    console.log(`  已缓存      ${est.cachedSessions} 场` + c(C.dim, '（这部分不花钱）'));
    console.log(`  输入        约 ${fmtNum(est.estTokensIn)} token`);
    console.log(`  输出        约 ${fmtNum(est.estTokensOut)} token`);
    if (est.estCost != null) {
      console.log(`  参考费用    约 ${est.estCost.toFixed(4)}（按你配置的单价）`);
    } else {
      console.log(c(C.dim, '  参考费用    未配置单价，只报 token'));
    }
    console.log('');
    console.log(c(C.dim, `模型 ${est.model || '(未配置)'} · 提示词版本 ${est.promptVersions.session}/${est.promptVersions.project}`));
    console.log('');
    console.log(c(C.when, '这是估算，一次 API 都没调。') + '确认后加 ' + c(C.bold, '--run') + ' 执行：');
    console.log(c(C.dim, `  agent-archive digest "${target}"${opts.limit ? ' --limit ' + opts.limit : ''} --run`));
    return;
  }

  const t0 = Date.now();
  let last = 0;
  const showProgress = process.stderr.isTTY;

  const r = await digestProject(target, { limit, force });

  if (!r.ready) {
    console.error(c(C.warn, r.message || '生成失败'));
    if (r.failures && r.failures.length) {
      for (const f of r.failures.slice(0, 3)) console.error(c(C.dim, `  ${f.id.slice(0, 12)}: ${f.error}`));
    }
    process.exit(1);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (opts.json) {
    console.log(JSON.stringify({ ...r, seconds: Number(secs) }, null, 2));
    return;
  }

  const md = `# ${est.target} · 项目摘要\n\n` + r.text + '\n';
  if (opts.out) {
    fs.writeFileSync(opts.out, md, 'utf8');
    console.log(c(C.ok, '已写入 ') + opts.out);
  } else {
    console.log('');
    console.log(r.text);
    console.log('');
  }

  console.log(
    c(C.dim, `\n${r.sessions} 场会话 → ${r.cached ? '命中缓存' : '新生成'}（重算 ${r.cacheMiss} 场）· `) +
      c(C.dim, `${fmtNum(r.tokensIn)} in / ${fmtNum(r.tokensOut)} out · ${secs}s`)
  );
  if (r.failures && r.failures.length) {
    console.log(c(C.when, `${r.failures.length} 场会话摘要失败`));
    for (const f of r.failures.slice(0, 3)) console.log(c(C.dim, `  ${f.id.slice(0, 12)}: ${f.error}`));
  }
}

function fmtNum(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
}

/**
 * 增量刷新已有的派生数据。
 *
 * 默认只审计：哪些过期了、为什么、大概要花多少。加 --run 才真的重算。
 *
 * 一个刻意的边界：**只刷新已经存在的摘要，不给没有摘要的项目新建**。
 * 否则一条 refresh 命令可能悄悄花掉一大笔，而用户以为只是"更新一下"。
 */
async function cmdRefresh(opts) {
  const { auditDerived } = await import('./refresh.js');
  const { summarizeSession, digestProject } = await import('./digest.js');
  const { scanAll } = await import('./registry.js');
  const { loadConfig } = await import('./llm.js');

  const cfg = loadConfig();
  const project = opts.project;
  const limit = opts.limit ? Number(opts.limit) : 60;

  const audit = await auditDerived({ project, limit });

  if (opts.json && !opts.flags.has('--run')) {
    console.log(JSON.stringify({ dryRun: true, ...audit }, null, 2));
    return;
  }

  const staleSessions = audit.sessions.filter((r) => r.status !== 'current');
  const staleProjects = audit.projects.filter((r) => r.status !== 'current');

  if (!opts.flags.has('--run')) {
    console.log(c(C.bold, '派生数据审计'));
    console.log(
      c(
        C.dim,
        `  模型 ${audit.model} · 提示词 ${audit.promptVersions.session}/${audit.promptVersions.project}`
      )
    );
    console.log('');
    console.log(
      `  会话摘要  ${audit.summary.sessions.current}/${audit.summary.sessions.total} 最新` +
        (staleSessions.length ? c(C.when, `，${staleSessions.length} 份过期`) : '')
    );
    console.log(
      `  项目摘要  ${audit.summary.projects.current}/${audit.summary.projects.total} 最新` +
        (staleProjects.length ? c(C.when, `，${staleProjects.length} 份过期`) : '')
    );

    // 按原因汇总，处置方式不同，所以要分开列
    const byReason = new Map();
    for (const r of [...staleSessions, ...staleProjects]) {
      byReason.set(r.status, (byReason.get(r.status) || 0) + 1);
    }
    if (byReason.size) {
      console.log('');
      console.log(c(C.bold, '过期原因'));
      for (const [st, n] of byReason) {
        console.log(`  ${reasonLabel(st).padEnd(16)} ${n}`);
      }
    }

    if (!staleSessions.length && !staleProjects.length) {
      console.log('');
      console.log(c(C.ok, '全部是最新的') + c(C.dim, '，不需要重算。'));
      return;
    }

    console.log('');
    console.log(
      c(C.dim, `预估输入约 ${fmtNum(audit.summary.estTokensIn)} token · 输出约 ${fmtNum(audit.summary.estTokensOut)} token`)
    );
    console.log('');
    console.log(c(C.when, '这是审计，没有调用任何模型。') + '确认后加 ' + c(C.bold, '--run') + '：');
    console.log(c(C.dim, '  agent-archive refresh --run' + (project ? ` --project "${project}"` : '')));
    return;
  }

  if (!cfg.apiKey || !cfg.model) {
    console.error(c(C.warn, '重算需要先配置模型。'));
    process.exit(2);
  }

  if (!staleSessions.length && !staleProjects.length) {
    console.log(c(C.ok, '全部是最新的') + c(C.dim, '，没有需要重算的。'));
    return;
  }

  // 有项目摘要要重算的项目，其会话摘要会被 digestProject 一并处理，不必重复做
  const covered = new Set(staleProjects.map((p) => p.project));
  const sessionsByKey = new Map();
  for (const s of scanAll({}).sessions) sessionsByKey.set(`${s.agent}|${s.id}`, s);

  let doneSessions = 0;
  let doneProjects = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const failures = [];

  const showProgress = process.stderr.isTTY;
  let idx = 0;
  const total = staleSessions.length + staleProjects.length;

  for (const row of staleSessions) {
    idx++;
    const key = projectKeyForRow(row);
    if (key && covered.has(key)) continue; // 交给项目摘要那一轮

    const s = sessionsByKey.get(`${row.agent}|${row.id}`);
    if (!s) continue;
    try {
      const r = await summarizeSession(s, { force: true });
      tokensIn += r.tokensIn;
      tokensOut += r.tokensOut;
      doneSessions++;
    } catch (e) {
      failures.push(`${row.agent}|${row.id.slice(0, 12)}: ${e && e.message ? e.message : e}`);
    }
    if (showProgress) process.stderr.write(`\r  重算 ${idx}/${total}  `);
  }

  for (const p of staleProjects) {
    idx++;
    try {
      const r = await digestProject(p.project, { limit, force: true, forceSessions: false });
      tokensIn += r.tokensIn || 0;
      tokensOut += r.tokensOut || 0;
      doneProjects++;
      for (const f of r.failures || []) failures.push(`${f.id.slice(0, 12)}: ${f.error}`);
    } catch (e) {
      failures.push(`${p.project}: ${e && e.message ? e.message : e}`);
    }
    if (showProgress) process.stderr.write(`\r  重算 ${idx}/${total}  `);
  }
  if (showProgress) process.stderr.write(' '.repeat(24) + '\r');

  if (opts.json) {
    console.log(JSON.stringify({ refreshed: { sessions: doneSessions, projects: doneProjects }, tokensIn, tokensOut, failures }, null, 2));
    return;
  }

  console.log(c(C.ok, '刷新完成'));
  console.log(`  会话摘要  ${doneSessions} 份`);
  console.log(`  项目摘要  ${doneProjects} 份`);
  console.log(c(C.dim, `  ${fmtNum(tokensIn)} in / ${fmtNum(tokensOut)} out`));
  if (failures.length) {
    console.log(c(C.when, `  ${failures.length} 项失败`));
    for (const f of failures.slice(0, 5)) console.log(c(C.dim, `    ${f}`));
  }
}

/** 从审计行里取项目键（会话行里存的是原始路径）。 */
function projectKeyForRow(row) {
  if (!row.project) return null;
  return String(row.project).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

function reasonLabel(status) {
  switch (status) {
    case 'source-changed':
      return '内容变了';
    case 'model-changed':
      return '模型换了';
    case 'prompt-changed':
      return '提示词改过';
    case 'dependency-stale':
      return '依赖的摘要过期';
    case 'missing-dependency':
      return '缺会话摘要';
    case 'orphan':
      return '源数据已不在';
    case 'unreadable':
      return '正文读不出';
    default:
      return status;
  }
}

async function cmdStats(opts) {
  const { projects, stats, totalSessions } = listProjects({ noCache: opts.noCache });
  if (opts.json) {
    console.log(JSON.stringify({ stats, totalSessions, projects: projects.length }, null, 2));
    return;
  }
  console.log(c(C.bold, '扫描统计'));
  console.log(`  扫描文件      ${stats.files}`);
  console.log(`  新解析        ${stats.parsed}`);
  console.log(`  命中缓存      ${stats.cached}`);
  console.log(`  失败          ${stats.failures}`);
  console.log(`  会话总数      ${totalSessions}`);
  console.log(`  识别出项目    ${projects.length}`);
  console.log('');
  console.log(c(C.bold, '各 Agent 会话数'));
  for (const [a, n] of Object.entries(stats.byAgent).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${a.padEnd(14)} ${n}`);
  }
  console.log('');
  const idx = indexStats();
  console.log(c(C.bold, '全文索引'));
  if (!idx.exists) {
    console.log(c(C.dim, '  还没建。运行：agent-archive index'));
  } else {
    console.log(`  已索引        ${idx.docs} 场`);
    console.log(`  正文字数      ${(idx.chars / 1e6).toFixed(1)} M`);
    console.log(`  占用          ${(idx.bytes / 1e6).toFixed(0)} MB`);
    if (idx.builtAt) console.log(`  更新时间      ${fmtDate(idx.builtAt)}`);
  }
  console.log('');
  console.log(c(C.dim, `缓存: ${tildify(cacheLocation())}`));
}

/**
 * 参数解析只有一个入口。
 *
 * 命令函数只接收已经分好类的选项对象，不直接碰 process.argv——
 * 这样"哪些值会被当成路径"这件事就集中在 optsFor() 一处，看得见、
 * 改得动，也免得每条命令各写一遍 argv.find 又各漏一遍校验。
 */
function parseArgs(argv) {
  const VALUE_FLAGS = new Set([
    '--project',
    '--agent',
    '--port',
    '--limit',
    '--out',
    '--key',
    '--model',
    '--base-url',
    '--provider',
    '--price-in',
    '--price-out',
  ]);

  const flags = new Set();
  const values = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        values[a.slice(2)] = v;
        i++;
      }
      continue;
    }
    if (a.startsWith('-')) {
      flags.add(a);
      continue;
    }
    positionals.push(a);
  }

  return {
    flags,
    json: flags.has('--json'),
    noCache: flags.has('--no-cache'),
    flat: flags.has('--flat'),
    showAll: flags.has('--all'),
    tools: flags.has('--tools'),
    reasoning: flags.has('--reasoning'),
    system: flags.has('--system'),
    project: values.project,
    agent: values.agent,
    port: values.port,
    limit: values.limit,
    out: values.out,
    key: values.key,
    model: values.model,
    baseUrl: values['base-url'],
    provider: values.provider,
    priceIn: values['price-in'],
    priceOut: values['price-out'],
    positionals,
  };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage();
    return;
  }

  const opts = parseArgs(rest);
  const first = opts.positionals[0];

  switch (cmd) {
    case 'projects':
    case 'ls':
      return cmdProjects(opts);
    case 'timeline':
    case 'tl':
      return cmdTimeline(first, opts);
    case 'agents':
      return cmdAgents(first, opts);
    case 'stats':
      return cmdStats(opts);
    case 'doctor':
    case 'check':
      return cmdDoctor(opts);
    case 'mcp':
      return cmdMcp(opts);
    case 'secrets':
    case 'leaks':
      return cmdSecrets(opts);
    case 'llm':
      return cmdLlm(opts);
    case 'digest':
    case 'summarize':
      return cmdDigest(first, opts);
    case 'refresh':
      return cmdRefresh(opts);
    case 'serve':
    case 'web':
      return cmdServe(opts);
    case 'cat':
    case 'show':
      return cmdCat(first, opts);
    case 'index':
      return cmdIndex(opts);
    case 'reindex':
      return cmdReindex(opts);
    case 'search':
    case 'find':
    case 'grep':
      return cmdSearch(opts.positionals.join(' '), opts);
    case 'export':
    case 'md':
      return cmdExport(first, opts);
    default:
      console.error(`未知命令: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(c(C.warn, '出错: ') + (e && e.stack ? e.stack : e));
  process.exit(1);
});
