#!/usr/bin/env node
// 环境自检必须在最前：后面的模块会静态 import node:sqlite，
// 在过老的 Node 上那一步就直接崩，检查来不及跑。见 boot.js。
import './boot.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listProjects, projectTimeline, groupByAgent, findSessions, readSessionContent } from './query.js';
import { cacheLocation } from './registry.js';
import { tildify, durationMs, dayKey } from './model.js';
import { summarizeInput } from './messages.js';
import { buildIndex, search, indexStats, indexPath } from './search.js';
import { timelineMarkdown, sessionMarkdown, bundleMarkdown } from './export.js';
import { auditCollection, detectGaps } from './doctor.js';
import { scanSecrets } from './secrets.js';
import { registerUserScanners } from './scanner-loader.js';
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
  agent-archive handoff <项目路径>             跨 Agent 接力：谁在什么时候接手
  agent-archive agents <项目路径>              某个项目里各 Agent 的分布
  agent-archive stats                          扫描统计与缓存位置
  agent-archive doctor                         采集体检（覆盖率与缺口）
  agent-archive env                            本机各 Agent 具备什么能力
  agent-archive env mcp                        MCP 服务清单（跨 Agent 归并）
  agent-archive env cli                        CLI 产品、安装位置与各 Agent 的调用
  agent-archive env skills                     技能清单（按内容去重）
  agent-archive env usage                      技能使用率（哪些真用过）
  agent-archive env memory                     记忆与指令文件
  agent-archive env audit                      环境层体检
  agent-archive calls                          模型调用成本（按 Agent / 模型 / 会话）
  agent-archive calls --by session             调用挂到具体会话，报匹配率
  agent-archive usage                         各家 Agent 自己记的 token（不需要网关）
  agent-archive pricing                       价目表状态（models.dev）
  agent-archive pricing sync                  同步价目表（会联网一次）
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
  --all         展开全部（env skills 显示所有共享技能；
                timeline 列出全部会话，默认只给最近 100 场；
                handoff 列出全部换手，默认只给间隔最大的 12 次）
  --project <路径>        限制在某个项目内查找（cat）
  --agent <名字>          限制在某个 Agent 内查找（cat）
  --port <端口>           网页端口（serve，默认 7788）
  --limit <n>             搜索结果条数（search，默认 20）
  --min-gap <分钟>        handoff 只显示间隔超过这个值的换手
  --by <维度>             calls: agent / model / provider / session
                          usage: agent / model / project / session / day
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
  agent-archive timeline ~/code/my-app
  agent-archive handoff ~/code/my-app
  agent-archive cat --project .
  agent-archive cat 1d551b54 --tools
  agent-archive search 迁移
  agent-archive serve
`);
}

async function cmdProjects(opts) {
  const { projects, stats, totalSessions, subagentSessions, unbound } = listProjects({
    noCache: opts.noCache,
    showAll: opts.showAll,
  });

  if (opts.json) {
    console.log(
      JSON.stringify({ projects, totalSessions, subagentSessions, stats, unbound }, null, 2)
    );
    return;
  }

  if (!projects.length && !unbound) {
    console.log('没有找到任何会话。');
    return;
  }

  // 子代理会话单列：它们被采集了，但不是"一场对话"，不该混进会话数
  const subNote = subagentSessions ? c(C.dim, `，另有 ${subagentSessions} 场子代理会话`) : '';
  console.log(
    c(C.bold, '项目') +
      c(C.dim, `  (${projects.length} 个, ${totalSessions} 个会话${subNote})`) +
      '\n'
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
    console.log(`项目 ${target} 下没有找到会话。`);
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

  // 真实项目上时间线可以很长（本机一个项目 924 场会话、1423 行输出）。
  // 默认只给最近的一段并明确说明——时间线本身该是完整的，所以这是**显示窗口**，
  // 不是裁剪数据：--all 拿到的仍是全部，上面那行 summary 也始终描述整个项目。
  const shown = opts.showAll ? sessions : sessions.slice(-TIMELINE_WINDOW);
  const hidden = sessions.length - shown.length;

  if (opts.flat) {
    console.log('');
    for (const s of shown) printSession(s, 0);
    if (hidden > 0) printTimelineWindowNote(sessions.length, shown.length);
    return;
  }

  let currentDay = null;
  for (const s of shown) {
    const day = s.start ? dayKey(s.start) : '(未知日期)';
    if (day !== currentDay) {
      currentDay = day;
      console.log('\n' + c(C.when, day));
    }
    printSession(s, 2);
  }
  if (hidden > 0) printTimelineWindowNote(sessions.length, shown.length);
}

/**
 * 时间线默认显示多少场。
 *
 * 100 场大约两百行——一屏能滚完，又够看清最近在做什么。
 * 更早的历史用 `--all`；也可以先用 projects / agents 缩小范围。
 */
const TIMELINE_WINDOW = 100;

function printTimelineWindowNote(total, shownCount) {
  console.log('');
  console.log(c(C.dim, `  共 ${total} 场，上面是最近 ${shownCount} 场。看全部：--all`));
}

function printSession(s, indent) {
  const pad = ' '.repeat(indent);
  const agent = c(C.agent, s.agent.padEnd(12));
  const time = c(C.dim, fmtDate(s.start).slice(11) || '     ');
  const dur = c(C.dim, fmtDur(durationMs(s)).padStart(6));
  console.log(`${pad}${agent} ${time} ${dur}  ${s.title}`);
}

/**
 * 跨 Agent 接力视图。
 *
 * 时间线是按会话列，一个项目几百场就没人看得完。这里把连续同一 Agent
 * 的会话压成一段 run，人只需要看换手点——那才是上下文最容易丢的地方。
 */
async function cmdHandoff(target, opts) {
  if (!target) {
    console.error('需要项目路径。用 agent-archive projects 先看看有哪些。');
    process.exit(2);
  }

  const { projectHandoffs, handoffLabel } = await import('./handoff.js');
  const r = projectHandoffs(target, {
    minGapMinutes: opts.minGap ? Number(opts.minGap) : 0,
    noCache: opts.noCache,
  });

  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!r.sessions) {
    console.log(`项目 ${target} 下没有找到会话。`);
    return;
  }

  console.log(c(C.bold, tildify(r.project)));
  console.log(
    c(
      C.dim,
      `${r.sessions} 场会话压成 ${r.runs} 段 · ${r.agentCount} 家 Agent · ` +
        `${fmtDate(r.first)} → ${fmtDate(r.last)}`
    )
  );

  // 单 Agent 的项目要说清楚，否则"0 次换手"看起来像没算出来
  if (r.singleAgent) {
    console.log('');
    console.log(c(C.dim, `  这个项目从头到尾只有 ${r.agents[0] || '一家'} 在用，没有换手。`));
    return;
  }

  const s = r.summary;
  console.log('');
  console.log(c(C.bold, '换手概况'));
  const parts = [
    `${s.sequential} 次接续`,
    s.overlap ? `${s.overlap} 次并行` : null,
    s.stale ? `${s.stale} 次长期中断` : null,
  ].filter(Boolean);
  console.log(`  ${parts.join(' · ')}`);
  if (s.medianGapMs != null) {
    console.log(c(C.dim, `  接续间隔中位数 ${fmtDur(s.medianGapMs)}`));
  }
  if (s.topPairs.length) {
    console.log(
      c(C.dim, `  最常走的接力线：${s.topPairs.map((p) => `${p.pair}(${p.count})`).join('  ')}`)
    );
  }

  console.log('');
  console.log(c(C.bold, '换手点'));
  console.log(
    c(C.dim, '  「并行」= 上一段还没结束下一段就开始了，不是真正的交接；「长期中断」= 隔了一周以上')
  );
  console.log('');

  // 按间隔从大到小、默认只列前 12 条：间隔越大越该先看，
  // 而真实项目上动辄两三百次换手，全打出来第一屏会被淹没。见 handoff.js。
  const { pickHandoffs } = await import('./handoff.js');
  const { shown, total, rest } = pickHandoffs(r.handoffs, { all: opts.showAll });

  for (const h of shown) {
    // 间隔的展示分三种：接续是"+Nmin"，并行是"重叠N"，未知是"—"。
    // 并行不能显示成负数分钟——那个负号是时间轴重叠，不是"提前了"。
    let gap;
    if (h.gapMinutes == null) {
      gap = c(C.dim, '       —');
    } else if (h.kind === 'overlap') {
      gap = c(C.when, `重叠${fmtDur(-h.gapMs)}`.padStart(10));
    } else {
      gap = c(h.stale ? C.warn : C.dim, `+${fmtDur(h.gapMs)}`.padStart(10));
    }
    const tag = c(
      h.kind === 'overlap' ? C.when : h.stale ? C.warn : C.dim,
      handoffLabel(h).padEnd(6)
    );
    console.log(
      `${c(C.agent, h.from.padEnd(11))} → ${c(C.agent, h.to.padEnd(11))} ${gap} ${tag}`
    );
    // 先截断再着色：长标题一旦进了颜色包装，终端宽度计算会失准
    if (h.fromLastSession) {
      console.log(c(C.dim, `    离开: ${truncate(h.fromLastSession.title, 64)}`));
    }
    if (h.toFirstSession) {
      console.log(c(C.dim, `    接手: ${truncate(h.toFirstSession.title, 64)}`));
    }
  }

  if (rest > 0) {
    console.log('');
    console.log(c(C.dim, `  共 ${total} 次换手，上面按间隔从大到小列了前 ${shown.length} 次。`));
    console.log(c(C.dim, '  看全部：--all　　只看隔了一天以上的：--min-gap 1440'));
  }

  console.log('');
  console.log(
    c(C.dim, '接续间隔越长，新 Agent 越不知道前面发生了什么。看某一场：agent-archive cat <id>')
  );
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
  const detail = summarizeInput(p.input, { limit: 100 });
  const mark = p.status === 'error' ? ' ✗' : '';
  return `[${name}${detail ? ' ' + detail : ''}]${mark}`;
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
  // 这里要写库（重建倒排），不能走 openIndex 的只读分支：
  // 只读连接上执行 rebuild 会直接报 readonly database。
  if (!fs.existsSync(indexPath())) {
    console.error('还没有索引。先运行：agent-archive index');
    process.exit(2);
  }
  const db = openIndex({ create: true });
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
    // 子代理会话必须显式标出来：用户读到一段细节，得知道那是子代理查到的，
    // 不是主对话说过的
    const tag = h.kind === 'subagent' ? c(C.dim, ' [子代理]') : '';
    console.log(
      `${c(C.agent, h.agent.padEnd(12))} ${c(C.dim, fmtDate(h.start))}  ${c(C.dim, h.id.slice(0, 12))}${tag}`
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
      '需要目标。例：agent-archive export ~/code/my-app\n' +
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
  // 反向发现的候选：本机有没有"像会话存储但我们读不懂"的地方。
  // 它单独跑（要扫家目录），所以放在体检之后，失败也不影响上面的结论。
  const { discoverUnknownStores } = await import('./doctor.js');
  const unknown = discoverUnknownStores();

  if (opts.json) {
    console.log(JSON.stringify({ ...r, gaps, unknown }, null, 2));
    return;
  }

  console.log(c(C.bold, '采集体检'));
  const subNote = r.subagent.total
    ? ` · 另有 ${r.subagent.total} 场子代理会话`
    : '';
  // 保留旧结果的场次数单独报：这些文件的解析这次没成功，档案馆留着上一次
  // 读到的内容。不报出来的话，用户看到的"会话数没变"可能掩盖了一场正在
  // 被写坏的会话——这正是这个项目一贯要避免的那种沉默。
  const keptNote = r.stats && r.stats.keptStale
    ? c(C.when, ` · ${r.stats.emptied || 0} 个文件解析为空，已保留上次结果 ${r.stats.keptStale} 场`)
    : '';
  console.log(c(C.dim, `  ${r.files} 个文件 · ${r.total} 场会话${subNote} · 解析失败 ${r.failures} · 重复 id ${r.duplicates} 组`) + keptNote);
  console.log('');

  // 零会话时不要再报覆盖率。
  //
  // 这是在一台干净的 Mac 上发现的：一场会话都没有时，"时间覆盖率 0.0%"
  // 会被判成 ✗ 并进"待办"，首屏全是红叉——新用户会以为工具坏了。
  // 零会话不是缺陷，只是"这台机器上还没有我们认识的数据"。这时候该说的是
  // 下一步能做什么，而不是三条 0% 的进度条。
  if (!r.total) {
    console.log(c(C.warn, '  这台机器上还没有找到任何已接入 Agent 的会话。'));
    console.log(c(C.dim, '  可能还没装，也可能装在下面没适配的位置——先看「存储位置」和「未适配的会话存储」。'));
    console.log('');
  } else {
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
  } // ← if (r.total) 结束

  // 子代理归属：子会话被采集之后，唯一会坏的就是"挂不到父会话"
  if (r.subagent.total) {
    const sa = r.subagent;
    console.log(c(C.bold, '子代理会话'));
    console.log(
      c(
        C.dim,
        `  ${sa.total} 场 · 归属 ${sa.attached} · 孤儿 ${sa.orphan} · 无父id ${sa.noParent}` +
          ` · 归属率 ${(sa.attachRate * 100).toFixed(1)}%`
      )
    );
    for (const a of sa.byAgent) {
      const notes = [];
      if (a.orphan) notes.push(`孤儿 ${a.orphan}`);
      if (a.noParent) notes.push(`无父id ${a.noParent}`);
      const flag = a.orphan || a.noParent ? c(C.when, '!') : c(C.ok, '✓');
      console.log(
        `  ${flag} ${c(C.agent, a.agent.padEnd(13))} ${c(C.dim, String(a.total).padStart(5) + ' 场')}` +
          (notes.length ? c(C.dim, '  ' + notes.join(' · ')) : '')
      );
    }
    console.log(
      c(
        C.dim,
        '  孤儿 = 有父 id 但父会话不在归档里（被删或跨项目）；无父id = 扫描器没取到父会话标识。'
      )
    );
    console.log('');
  }

  // 复制 / 分叉：没有也要报 0，不能省略——否则"没检测到"和"没检测"分不清
  const cp = r.copies || { copy: 0, branch: 0 };
  console.log(c(C.bold, 'Claude 复制 / 分叉'));
  console.log(c(C.dim, `  复制 ${cp.copy} 场 · 分叉 ${cp.branch} 场`));
  console.log(
    c(C.dim, '  复制 = 历史完全相同，默认视图不显示；分叉 = 之后有新内容，仍留在时间线上。')
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
    // "目录存在"和"真的有会话"是两件事：装过 Codex CLI 但没聊过，
    // ~/.codex 也会在。混成一个"已接入"会让用户以为有数据可看。
    const hasSessions = new Set((r.agents || []).filter((a) => a.total > 0).map((a) => a.agent));
    const withData = unused.filter((g) => hasSessions.has(g.agent));
    const emptyOnly = unused.filter((g) => !hasSessions.has(g.agent));

    if (withData.length) {
      console.log(c(C.dim, `  · 已接入：${withData.map((g) => g.name).join('、')}`));
    }
    if (emptyOnly.length) {
      console.log(
        c(C.warn, `  · 有目录但没有会话：${emptyOnly.map((g) => g.name).join('、')}`) +
          c(C.dim, '（装过，可能没用它聊过）')
      );
    }
  }
  const absent = gaps.filter((g) => !g.present);
  if (absent.length) {
    console.log(c(C.dim, `  · 本机没有：${absent.map((g) => g.name).join('、')}`));
  }

  // 用户自己写的扫描器：加载成功要看见（否则用户以为没生效），
  // 加载失败更要看见（否则他会以为是我们不支持他家 Agent）。
  try {
    const { listScanners, loadIssues, userScannerDir } = await import('./scanner-loader.js');
    const mine = listScanners().filter((s) => s.source === 'user');
    if (mine.length) {
      console.log(
        c(C.dim, `  · 用户扫描器 ${mine.length} 个：${mine.map((s) => s.name).join('、')}`)
      );
    }
    if (loadIssues.length) {
      console.log(c(C.warn, `  · 用户扫描器加载失败 ${loadIssues.length} 个：`));
      for (const i of loadIssues) console.log(c(C.dim, `     ${i}`));
      console.log(c(C.dim, `     目录：${userScannerDir()}`));
    }
  } catch {
    /* 辅助信息，读不到不影响体检结论 */
  }
  console.log('');

  // 反向发现：不在已知名单里、但看起来像会话存储的地方。
  // 这是给"装了别家 Agent"的用户看的——不说的话他会以为工具不支持他。
  if (unknown && unknown.length) {
    console.log(c(C.bold, '未适配的会话存储（启发式猜测）'));
    console.log(
      c(C.dim, '  这些目录不在已接入范围内，但内容看起来像会话记录。')
    );
    console.log(c(C.dim, '  只是"看到什么"，不下结论——是不是、要不要支持，需要人判断。'));
    for (const u of unknown) {
      const size = u.bytes >= 1048576 ? `${(u.bytes / 1048576).toFixed(1)}MB` : `${Math.round(u.bytes / 1024)}KB`;
      console.log(`  ${c(C.when, '?')} ${u.path.padEnd(44)} ${size.padStart(7)}  ${c(C.dim, u.hint)}`);
    }
    console.log(
      c(C.dim, '  自己就能接：agent-archive scanner init <名字>  会生成一份可运行的骨架；')
    );
    console.log(
      c(C.dim, '  写完放进同一个目录即生效，不必等我们发版。路径见 agent-archive scanner path')
    );
    console.log('');
  }

  // 结论一句话。只有"真的该修"的才进待办——
  // 临时路径和占位标题都是设计如此，不该长期挂着当未完成项。
  //
  // 零会话时覆盖率全是 0%，据此算出来的"时间缺失/标题"是假警报：没有数据
  // 不等于数据坏了。所以这一整段只在有会话时给结论。
  const problems = [];
  if (r.total) {
    if (r.coverage.time < 0.99) problems.push('时间缺失');
    if (r.coverage.cleanTitle < 0.9) problems.push('标题');
    if (r.duplicates) problems.push('重复 id');
  }
  if (missing.length) problems.push(`${missing.length} 个 Agent 未接入`);

  if (!problems.length) {
    console.log(
      c(C.ok, r.total ? '采集正常' : '没有可体检的数据') +
        c(C.dim, r.total ? '：所有支持范围内的会话都读到了、读对了。' : '：先让至少一家 Agent 产生会话，再回来体检。')
    );
    if (r.total && r.coverage.project < 0.9) {
      console.log(
        c(C.dim, `  项目覆盖率 ${(r.coverage.project * 100).toFixed(1)}%，差额来自临时工作区（设计如此）。`)
      );
    }
  } else {
    console.log(c(C.when, '待办：') + problems.join('、'));
    if (r.total && r.coverage.project < 0.9) {
      console.log(
        c(C.dim, `  项目覆盖率 ${(r.coverage.project * 100).toFixed(1)}%，差额来自临时工作区（设计如此）。`)
      );
    }
  }

  // 这个命令只管会话采集。能力面（MCP/技能/记忆）是另一层，
  // 混进来会让"体检"这个词失去边界，所以只指个路。
  console.log(c(C.dim, '  能力面（MCP / 技能 / 记忆）另看：agent-archive env audit'));
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
  // 工具清单从 server 的注册表里取，不在这里再抄一份：
  // 抄一份的下场就是加了三层新工具、这里还写着"提供 6 个"。
  const { TOOLS } = await import('./mcp.js');
  console.log(`这个 server 只读，提供 ${TOOLS.length} 个工具：`);
  for (const t of TOOLS) {
    console.log(c(C.dim, `  ${t.name.padEnd(21)}${t.title}`));
  }
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
    console.error('需要项目路径。例：agent-archive digest ~/code/my-app');
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

/**
 * 环境层：本机各 Agent 具备什么能力。
 *
 * 与会话层的分工：`projects` / `timeline` 回答"聊过什么"，
 * `env` 回答"会什么、配了什么、记得什么"。
 *
 * 子命令按层分开，因为三类数据的消费方式完全不同：
 *   env            总览（每个 Agent 一行）
 *   env mcp        服务清单，按启动指纹归并
 *   env cli        CLI 产品、安装位置与各 Agent 的调用
 *   env skills     技能清单，按内容哈希归并
 *   env memory     记忆与指令文件
 *   env audit      体检
 */
async function cmdEnv(sub, opts) {
  const { fullInventory, auditEnvironment } = await import('./env/inventory.js');

  const which = sub || 'overview';

  if (which === 'audit') {
    const r = auditEnvironment();
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    printEnvAudit(r);
    return;
  }

  const inv = fullInventory();

  if (which === 'mcp') {
    if (opts.json) {
      console.log(JSON.stringify(inv.mcp, null, 2));
      return;
    }
    printMcpDetail(inv.mcp);
    return;
  }

  if (which === 'cli') {
    if (opts.json) {
      console.log(JSON.stringify(inv.cli, null, 2));
      return;
    }
    printCli(inv.cli, opts);
    return;
  }

  if (which === 'skills') {
    if (opts.json) {
      console.log(JSON.stringify(inv.skills, null, 2));
      return;
    }
    printSkills(inv.skills, opts);
    return;
  }

  if (which === 'usage') {
    const { skillUsageSummary } = await import('./env/usage.js');
    const r = await skillUsageSummary({ fresh: opts.noCache });
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    printSkillUsage(r, opts);
    return;
  }

  if (which === 'memory') {
    if (opts.json) {
      console.log(JSON.stringify(inv.memory, null, 2));
      return;
    }
    printMemory(inv.memory);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(inv, null, 2));
    return;
  }
  printEnvOverview(inv);
}

function printEnvOverview(inv) {
  const s = inv.summary;

  console.log(c(C.bold, '本机 Agent 能力面'));
  console.log(
    c(
      C.dim,
      `  ${s.agentsWithData} 个 Agent 有数据 · MCP ${s.mcpServices} 个服务（${s.mcpRegistrations} 条注册） · ` +
        `CLI ${s.cliProducts} 个（${s.cliDetected} 个有安装） · ` +
        `技能 ${s.skills} 个（${s.skillInstalls} 处安装） · 记忆 ${s.memoryLocations} 处`
    )
  );
  console.log('');

  const head = ['Agent', 'MCP', '技能', 'CLI', '记忆'];
  const widths = [18, 6, 6, 6, 8];
  console.log(c(C.dim, '  ' + head.map((h, i) => h.padEnd(widths[i])).join('')));

  for (const a of inv.agents) {
    const cells = [a.display, String(a.mcp.length), String(a.skills), String(a.cli.visible), String(a.memory)];
    const colored = cells.map((v, i) => {
      if (i === 0) return c(C.agent, v.padEnd(widths[i]));
      // 0 不刺眼地留白，有值才高亮
      if (v === '0') return c(C.dim, v.padEnd(widths[i]));
      return v.padEnd(widths[i]);
    });
    console.log('  ' + colored.join(''));
  }
  console.log('');

  // MCP 服务按跨 Agent 覆盖度排，这个排序本身就有信息量：
  // 排在前面的是"全家都在用"的，排在后面的是"只在某一家配过"的
  console.log(c(C.bold, 'MCP 服务'));
  for (const m of inv.mcp.list) {
    const who = m.agents.join(',');
    const mark = m.agents.length > 1 ? c(C.ok, '●') : c(C.dim, '○');
    const alias = m.aliases ? c(C.dim, ` (别名 ${m.aliases.join('/')})`) : '';
    console.log(`  ${mark} ${m.service.padEnd(22)} ${String(m.agents.length)} 家  ${c(C.dim, who)}${alias}`);
  }
  console.log(c(C.dim, '  ● 多家共用   ○ 只在一家'));
  console.log('');

  console.log(c(C.dim, '细看：env mcp / env cli / env skills / env memory / env audit'));
}

function printCli(cli, opts) {
  const s = cli.summary;
  console.log(c(C.bold, 'CLI 产品'));
  console.log(
    c(
      C.dim,
      `  ${s.detected} 个已识别 / ${s.products} 个有记录 · 系统可见 ${s.systemVisible} · ` +
        `仅私有 ${s.privateOnly} · 调用记录 ${s.calls}`
    )
  );
  console.log('');

  const all = cli.products;
  const shown = opts.showAll ? all : all.slice(0, 30);
  for (const p of shown) {
    const scope =
      p.scope === 'system'
        ? `全部(${p.agents.length})`
        : p.scope === 'agent'
          ? p.privateOwners.join('/')
          : '未知';
    const used = p.usedBy.map((u) => `${u.agent}:${u.calls}`).join(', ') || '—';
    const cat = cli.categories[p.category] || p.category;
    console.log(
      `  ${p.display.padEnd(24)} ${c(C.dim, cat.padEnd(10))} ${scope.padEnd(12)} ${String(p.calls).padEnd(6)} ${c(
        C.dim,
        used
      )}`
    );
    if (p.installs[0]) console.log(c(C.dim, `      ${p.installs[0].displayPath}`));
  }
  if (!opts.showAll && all.length > shown.length) {
    console.log(c(C.dim, `  …共 ${all.length} 个，加 --all 看全部`));
  }
  console.log('');

  if (cli.privateOnly.length) {
    console.log(c(C.when, '只装在单个 Agent 私有目录'));
    for (const p of cli.privateOnly) {
      console.log(`  ${p.display}  ${c(C.dim, p.privateOwners.join('、'))}`);
      if (p.installs[0]) console.log(c(C.dim, `    ${p.installs[0].displayPath}`));
    }
    console.log('');
  }

  if (cli.usedOnly.length) {
    console.log(c(C.when, '有调用记录但没找到可执行文件'));
    for (const p of cli.usedOnly) {
      console.log(
        `  ${p.display.padEnd(24)} ${String(p.calls).padStart(6)}  ${c(C.dim, p.usedBy.map((u) => u.agent).join(','))}`
      );
    }
    console.log('');
  }

  console.log(c(C.dim, cli.note));
}

function printMcpDetail(mcp) {
  console.log(c(C.bold, 'MCP 服务'));
  console.log(c(C.dim, `  ${mcp.services} 个服务，${mcp.registrations} 条注册，来自 ${mcp.files} 个配置文件`));
  console.log('');

  for (const s of mcp.list) {
    const mark = s.agents.length > 1 ? c(C.ok, '●') : c(C.dim, '○');
    console.log(`${mark} ${c(C.bold, s.service)}  ${c(C.dim, `${s.registrations} 条注册 / ${s.agents.length} 家`)}`);
    console.log(`    Agents  ${s.agents.join(', ')}`);
    if (s.aliases) console.log(`    别名    ${s.aliases.join(' / ')}`);
    console.log(`    启动    ${s.forms.join(' / ')}`);
    if (s.envKeys && s.envKeys.length) {
      // 只列键名。值在这里永远不会出现——这条线不能越过。
      console.log(`    环境变量键  ${s.envKeys.join(', ')}`);
    }
    console.log('');
  }

  if (mcp.mixedForms.length) {
    console.log(c(C.when, '安装形态不一致'));
    for (const m of mcp.mixedForms) {
      console.log(`  ${m.service}: ${m.forms.join(' / ')}`);
      console.log(c(C.dim, `    分布在 ${m.agents.join(', ')}。npx 每次拉最新，本地安装钉版本，行为可能不同。`));
    }
    console.log('');
  }

  console.log(c(C.dim, '环境变量的值一律不读取、不传输，只报键名。要看值请自己打开配置文件。'));
}

function printSkills(sk, opts) {
  console.log(c(C.bold, '技能'));
  console.log(
    c(C.dim, `  ${sk.skills} 个独立技能 · ${sk.installs} 处安装 · ${sk.shared} 个跨 Agent 共享 · ${sk.single} 个只在一处`)
  );
  console.log('');

  console.log(c(C.dim, '  按 Agent 的安装处数'));
  for (const [a, n] of Object.entries(sk.byAgent).sort((x, y) => y[1] - x[1])) {
    console.log(`    ${a.padEnd(16)} ${String(n).padStart(4)}`);
  }
  console.log('');

  console.log(c(C.bold, '跨 Agent 共享的技能'));
  const shared = sk.list.filter((s) => s.agents.length > 1);
  if (!shared.length) {
    console.log(c(C.dim, '  没有。每个技能只在一处安装。'));
  } else {
    for (const s of shared.slice(0, opts.showAll ? shared.length : 20)) {
      console.log(`  ${s.name.padEnd(34)} ${String(s.agents.length)} 家  ${c(C.dim, s.agents.join(','))}`);
      if (s.aliases) console.log(c(C.dim, `     别名 ${s.aliases.join(', ')}`));
    }
    if (!opts.showAll && shared.length > 20) {
      console.log(c(C.dim, `  …共 ${shared.length} 个，加 --all 看全部`));
    }
  }
  console.log('');

  const multiVersion = sk.list.filter((s) => s.versions);
  if (multiVersion.length) {
    console.log(c(C.when, '多版本并存'));
    for (const s of multiVersion) console.log(`  ${s.name}: ${s.versions.join(' / ')}`);
    console.log('');
  }

  console.log(c(C.dim, '按 SKILL.md 内容哈希归并：同一份技能装在几处算一个。加 --json 取完整清单。'));
}

function printMemory(mem) {
  console.log(c(C.bold, '记忆与指令'));
  console.log(
    c(
      C.dim,
      `  ${mem.instructions} 份指令 · ${mem.memories} 处记忆 · ${mem.entries} 条条目 · ${mem.projectScoped} 处项目级`
    )
  );
  console.log('');

  // 指令和记忆分开摆：前者是"现在要求你怎么做"，后者是"过去学到过什么"。
  // 混在一起看会让人以为它们是一回事。
  const instructions = mem.list.filter((m) => m.kind === 'instruction');
  const memories = mem.list.filter((m) => m.kind === 'memory');

  console.log(c(C.bold, '指令（每轮注入的行为约定）'));
  for (const m of instructions) {
    const size = m.bytes ? `${Math.round(m.bytes / 1024)}KB` : '空';
    console.log(`  ${m.agent.padEnd(14)} ${size.padEnd(7)} ${c(C.dim, m.preview ? m.preview.slice(0, 60) : '')}`);
  }
  console.log('');

  console.log(c(C.bold, '记忆'));
  const global = memories.filter((m) => m.scope === 'global');
  const scoped = memories.filter((m) => m.scope === 'project');

  for (const m of global) {
    const size = `${Math.round(m.bytes / 1024)}KB`;
    const count = m.entries != null ? `${m.entries} 条` : '';
    console.log(`  ${m.agent.padEnd(14)} ${m.format.padEnd(8)} ${size.padStart(6)} ${count.padStart(7)}`);
  }

  if (scoped.length) {
    console.log('');
    console.log(c(C.bold, '  项目级（只在对应项目里生效）'));
    for (const m of scoped) {
      // 认不出项目的，明确标出来——不能显示成 "?" 让人以为是解析失败
      const label = m.project || c(C.dim, '(未绑定项目的临时目录)');
      console.log(`  ${label.padEnd(24)} ${String(m.entries ?? 0).padStart(3)} 条  ${c(C.dim, m.agent)}`);
    }
  }

  console.log('');
  console.log(
    c(C.when, '这些记忆彼此独立，不做合并。')
  );
  console.log(
    c(
      C.dim,
      '  不同 Agent 的记忆可能互相矛盾（同一件事的偏好写得相反）。合并成"你的记忆"会说谎，' +
        '所以这里只报出处。换 Agent 后旧记忆不会自动跟过去。'
    )
  );
}

function printEnvAudit(r) {
  console.log(c(C.bold, '环境层体检'));
  const s = r.summary;
  console.log(
    c(
      C.dim,
      `  ${s.agentsPresent} 个 Agent · MCP ${s.mcpServices} 个服务 · CLI ${s.cliProducts} 个 · ` +
        `技能 ${s.skills} 个 · 记忆 ${s.memoryEntries} 条`
    )
  );
  console.log('');

  if (!r.findings.length) {
    console.log(c(C.ok, '没有发现问题。'));
    return;
  }

  for (const f of r.findings) {
    const mark = f.level === 'warn' ? c(C.when, '!') : c(C.dim, '·');
    console.log(`${mark} ${f.title}`);
    console.log(c(C.dim, `  ${f.detail}`));
    console.log('');
  }
}

function printSkillUsage(r, opts) {
  if (!r.ready) {
    console.log(c(C.when, r.message));
    return;
  }

  console.log(c(C.bold, '技能使用率'));
  console.log(
    c(
      C.dim,
      `  装了 ${r.installed} 个 · 用过 ${r.usedCount} 个 · 从没用过 ${r.unusedCount} 个 · ` +
        `共 ${r.calls} 次调用，涉及 ${r.sessionsWithSkill} 场会话`
    )
  );
  console.log('');

  // 一句话结论。这个数字本身比列表更有用——
  // 它回答的是"我这堆技能到底有没有在干活"。
  const rate = r.installed ? (r.usedCount / r.installed) * 100 : 0;
  const mark = rate >= 30 ? c(C.ok, '✓') : c(C.when, '!');
  console.log(`${mark} 使用率 ${rate.toFixed(1)}%（${r.usedCount}/${r.installed}）`);
  console.log('');

  console.log(c(C.bold, '最常调用'));
  for (const s of r.top.slice(0, opts.showAll ? r.top.length : 15)) {
    const same = s.sameNameCount ? c(C.dim, `  [同名 ${s.sameNameCount} 份实现]`) : '';
    const as = s.calledAs ? c(C.dim, `  调作 ${s.calledAs.join(' / ')}`) : '';
    console.log(`  ${String(s.calls).padStart(3)} 次  ${s.name.padEnd(30)} ${c(C.dim, s.agents.join(','))}${same}${as}`);
  }
  console.log('');

  if (r.unknownCount) {
    console.log(c(C.bold, '用了但清单里没有'));
    console.log(c(C.dim, '  这些调用找不到对应技能，可能是已删的、或在别的位置：'));
    for (const u of r.unknown.slice(0, opts.showAll ? r.unknown.length : 10)) {
      console.log(`  ${String(u.calls).padStart(3)} 次  ${u.skill}`);
    }
    console.log('');
  }

  console.log(c(C.bold, '从没用过'));
  const never = r.neverUsed;
  for (const s of never.slice(0, opts.showAll ? never.length : 12)) {
    console.log(`  ${s.name.padEnd(34)} ${c(C.dim, s.agents.join(','))}`);
  }
  if (!opts.showAll && never.length > 12) {
    console.log(c(C.dim, `  …共 ${never.length} 个，加 --all 看全部`));
  }
  console.log('');

  console.log(
    c(
      C.dim,
      '数据来源：会话里的 Skill 工具调用，只统计已建索引的会话。' +
        (r.cached ? '（本次命中缓存，加 --no-cache 重扫）' : '')
    )
  );

  // 覆盖范围必须说清楚，否则"从没用过 265 个"会被当成完整结论。
  // 实测 Codex 没有 Skill 工具（直接 Read 那个 SKILL.md），
  // 所以它用过的技能不会出现在这里。
  if (r.coverage) {
    console.log('');
    console.log(c(C.dim, `  只覆盖显式调用 Skill 工具的 Agent：${r.coverage.agentsWithSkillTool.join('、') || '（无）'}`));
    console.log(c(C.dim, '  Codex 等直接读 SKILL.md 的用法不计入，所以"用过"是下限、"没用过"是上限。'));
  }
}

/**
 * 扫描器管理：列出、看目录、生成骨架、校验。
 *
 * 这一组命令是为了让"支持一家新 Agent"不需要改我们的代码——用户自己写一个
 * 文件放进目录就生效。见 scanner-loader.js 的契约说明。
 */
/**
 * 配置管理。
 *
 * 存在的理由很具体：环境变量在终端里好用，但 GUI 拉起的 MCP server 不一定
 * 继承它们，而且一个环境变量只能指一个位置。配置文件两个问题都能解决。
 */
async function cmdConfig(opts) {
  const { configPath, loadUserConfig, extraRoots, disabledAgents } = await import('./config.js');
  const sub = (opts.positionals[0] || 'show').toLowerCase();

  if (sub === 'path') {
    console.log(configPath());
    return;
  }

  if (sub === 'init') {
    const file = configPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        console.error(`已经存在：${file}`);
        process.exit(2);
      }
      const tpl = {
        _comment: [
          'roots.<agent> 里每一项的含义 = 该 Agent 的“家目录”',
          '（也就是 ~/.codex、~/.claude 那一层）。扫描器自己知道往下怎么拼。',
          '这里写的路径排在环境变量和平台默认之前。',
          'disabled 里的 Agent 不会被扫描。',
        ],
        roots: {},
        disabled: [],
      };
      fs.writeFileSync(file, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
      console.log(`已生成 ${file}`);
      console.log(c(C.dim, '在 roots 里加路径，例如 {"codex": ["D:/archive/.codex"]}'));
    } catch (e) {
      console.error(`写不了 ${file}：${e.message}`);
      process.exit(2);
    }
    return;
  }

  // show（默认）
  const cfg = loadUserConfig();
  const agents = Object.keys(cfg.roots);
  const disabled = [...disabledAgents()];

  if (opts.json) {
    console.log(
      JSON.stringify({ path: configPath(), roots: cfg.roots, disabled, error: cfg.error }, null, 2)
    );
    return;
  }

  console.log(c(C.bold, '配置'));
  console.log(c(C.dim, `  文件 ${configPath()}`));
  if (cfg.error) {
    console.log(c(C.warn, `  ✗ 读不出来：${cfg.error}（当作空配置处理）`));
  }
  if (!agents.length && !disabled.length) {
    console.log(c(C.dim, '  还没有配置任何东西（默认配置）。用 agent-archive config init 生成一份。'));
  }
  for (const a of agents) {
    console.log(`  ${c(C.agent, a.padEnd(14))} ${cfg.roots[a].length} 个额外根`);
    for (const r of cfg.roots[a]) console.log(c(C.dim, `     ${tildify(r)}`));
  }
  if (disabled.length) {
    console.log(c(C.dim, `  已禁用：${disabled.join('、')}`));
  }
  console.log('');
  console.log(
    c(C.dim, '  提示：这里的路径排在 环境变量（如 CODEX_HOME）与平台默认之前。')
  );
}

async function cmdScanner(opts) {
  const { listScanners, userScannerDir, scannerTemplate, validateScanner, loadIssues } = await import(
    './scanner-loader.js'
  );
  const sub = (opts.positionals[0] || 'list').toLowerCase();

  if (sub === 'list') {
    const all = listScanners();
    if (opts.json) {
      console.log(JSON.stringify({ dir: userScannerDir(), scanners: all, issues: loadIssues }, null, 2));
      return;
    }
    console.log(c(C.bold, '扫描器'));
    for (const s of all) {
      const tag = s.source === 'user' ? c(C.when, '用户') : c(C.dim, '内置');
      const body = s.canReadBody ? '' : c(C.dim, '（只能列清单，读不了正文）');
      console.log(`  ${tag} ${c(C.agent, s.name.padEnd(14))} ${c(C.dim, s.file || '')} ${body}`);
    }
    console.log('');
    console.log(c(C.dim, `用户扫描器目录：${userScannerDir()}`));
    if (loadIssues.length) {
      console.log(c(C.warn, `  ${loadIssues.length} 个文件没加载成功：`));
      for (const i of loadIssues) console.log(c(C.dim, `     ${i}`));
    }
    return;
  }

  if (sub === 'path') {
    console.log(userScannerDir());
    return;
  }

  if (sub === 'init') {
    const name = (opts.positionals[1] || 'myagent').toLowerCase();
    const dir = userScannerDir();
    const file = path.join(dir, `${name}.js`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file)) {
        console.error(`已经存在：${file}`);
        process.exit(2);
      }
      fs.writeFileSync(file, scannerTemplate(name), 'utf8');
      console.log(`已生成 ${file}`);
      console.log(c(C.dim, '改里面的 discover() 和 parse()，下次运行就会生效。'));
      console.log(c(C.dim, '检查契约：agent-archive scanner check ' + file));
    } catch (e) {
      console.error(`写不了 ${file}：${e.message}`);
      process.exit(2);
    }
    return;
  }

  if (sub === 'check') {
    const target = opts.positionals[1];
    if (!target) {
      console.error('用法：agent-archive scanner check <文件>');
      process.exit(2);
    }
    const abs = path.resolve(target);
    try {
      const mod = await import(pathToFileURL(abs).href);
      // 排除**正在校验的这个文件自己**：CLI 启动时已经把用户扫描器加载进来了，
      // 拿全量名单去比会把它自己算成重名（第一次写这功能时就踩了）。
      const self = path.basename(abs);
      const taken = new Set(
        listScanners()
          .filter((s) => s.file !== self)
          .map((s) => s.name)
      );
      const r = validateScanner(mod, taken);
      if (r.ok) {
        console.log(`✓ ${path.basename(abs)} 契约合格（name=${mod.name}）`);
      } else {
        console.error(`✗ ${path.basename(abs)} 不合格：`);
        for (const e of r.errors) console.error(`   ${e}`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`✗ 加载失败：${e && e.message ? e.message : e}`);
      process.exit(1);
    }
    return;
  }

  console.error(`未知子命令：${sub}（可用 list / path / init / check）`);
  process.exit(2);
}

async function cmdStats(opts) {
  const { projects, stats, totalSessions, subagentSessions } = listProjects({
    noCache: opts.noCache,
  });
  if (opts.json) {
    console.log(
      JSON.stringify({ stats, totalSessions, subagentSessions, projects: projects.length }, null, 2)
    );
    return;
  }
  console.log(c(C.bold, '扫描统计'));
  console.log(`  扫描文件      ${stats.files}`);
  console.log(`  新解析        ${stats.parsed}`);
  console.log(`  命中缓存      ${stats.cached}`);
  console.log(`  失败          ${stats.failures}`);
  console.log(`  主会话        ${totalSessions}`);
  console.log(`  子代理会话    ${subagentSessions}`);
  console.log(`  识别出项目    ${projects.length}`);
  console.log('');
  // stats.byAgent 是扫描器产出的**全部**会话数（含子代理），
  // 与上面的"主会话"口径不同，所以标题要写明
  console.log(c(C.bold, '各 Agent 会话数') + c(C.dim, '  (含子代理)'));
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
 * 调用层：一次模型请求花了多少。
 *
 * 与会话层的分工：会话回答"聊过什么"，这里回答"为它付了多少"。
 * 默认不加参数就是按 Agent 汇总；--by model / --by session 换维度。
 *
 * 两个数字必须一起出现：匹配上多少场会话、日志里总共有多少场。
 * 只报前者会让人以为覆盖率是 100%。
 */
async function cmdCalls(opts) {
  const { readCalls, summarizeCalls, attachToSessions, callsHint } = await import('./calls.js');

  const r = readCalls();

  if (!r.ready) {
    if (opts.json) {
      console.log(JSON.stringify({ ready: false, message: r.message }, null, 2));
      return;
    }
    console.log(c(C.when, '调用层不可用'));
    console.log(c(C.dim, '  ' + r.message));
    console.log(c(C.dim, '  ' + callsHint()));
    return;
  }

  const by = (opts.by || 'agent').toLowerCase();
  const rows = summarizeCalls({ calls: r.calls, groupBy: by });

  // 会话匹配率只有在需要时才去扫归档——按 agent 汇总不需要
  let link = null;
  if (by === 'session' || opts.flags.has('--link')) {
    const { scanAll } = await import('./registry.js');
    const { sessions } = scanAll({ noCache: opts.noCache });
    link = attachToSessions(r.calls, sessions);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ready: true,
          sources: r.sources,
          range: r.range,
          groupBy: by,
          rows,
          link: link
            ? {
                matchedSessions: link.sessions,
                matchedCalls: link.matched.length,
                totalCalls: link.totalCalls,
                withoutSession: link.withoutSession,
              }
            : null,
        },
        null,
        2
      )
    );
    return;
  }

  const span = r.range
    ? `${fmtDate(r.range.start)} → ${fmtDate(r.range.end)}`
    : '—';
  console.log(c(C.bold, '模型调用') + c(C.dim, `   ${r.calls.length} 次 · ${span}`));
  console.log(c(C.dim, `  来源 ${r.sources.map((s) => s.display).join('、')}`));
  console.log('');

  const label = { agent: 'Agent', model: '模型', provider: '供应商', session: '会话' }[by] || '分组';
  // 列名不能写"费用"：网关日志里的 credits 是**供应商自报的额度消耗**，
  // 单位由各家自己定（次数/积分/美元都有），我们不换算、也不当钱看。
  // 写"费用"会让人拿它去做预算决策，那是错的。
  console.log(
    c(
      C.dim,
      `  ${label.padEnd(18)}${'调用'.padStart(7)}${'输入'.padStart(12)}${'输出'.padStart(11)}${'缓存命中'.padStart(9)}${'credits'.padStart(10)}`
    )
  );
  console.log(
    c(C.dim, '  credits = 供应商自报的额度消耗，单位由各家自定，不是货币金额')
  );

  const top = opts.showAll ? rows : rows.slice(0, 15);
  for (const g of top) {
    const name = g.key.length > 17 ? g.key.slice(0, 16) + '…' : g.key;
    const cost = g.creditsKnown ? g.credits.toFixed(1) : '—';
    const hit = g.cacheHit == null ? '—' : `${Math.round(g.cacheHit * 100)}%`;
    // 失败数和本地拒绝分开标：拒绝不是"这个模型坏了"，是网关没让它出去
    const fail = g.failed ? c(C.when, ` ✗${g.failed}`) : '';
    const rej = g.rejected ? c(C.dim, ` ⊘${g.rejected}`) : '';
    console.log(
      '  ' +
        c(C.agent, name.padEnd(18)) +
        c(C.dim, String(g.calls).padStart(7)) +
        fmtNum(g.input).padStart(12) +
        fmtNum(g.out).padStart(11) +
        hit.padStart(9) +
        cost.padStart(10) +
        fail +
        rej
    );
  }
  if (rows.length > top.length) {
    console.log(c(C.dim, `  …还有 ${rows.length - top.length} 组（--all 展开）`));
  }
  console.log('');
  console.log(
    c(
      C.dim,
      '  输入 = 未缓存 + 缓存读 + 缓存写；缓存命中 = 缓存读 /（缓存读 + 未缓存输入）。'
    )
  );
  if (r.skipped.malformed) {
    console.log(c(C.dim, `  ${r.skipped.malformed} 行日志解析失败（多为正在写入的末行），已跳过。`));
  }

  if (link) {
    const pct = r.calls.length ? Math.round((link.matched.length / r.calls.length) * 100) : 0;
    console.log(
      c(C.bold, '\n  与会话层的关联') +
        c(
          C.dim,
          `   ${link.sessions} 场会话可对上 · ${link.matched.length}/${link.totalCalls} 次调用（${pct}%）`
        )
    );
    if (link.withoutSession) {
      console.log(
        c(
          C.dim,
          `  ${link.withoutSession} 次调用本身没有会话 id——不走网关的 Agent 就没有这个字段，`
        )
      );
      console.log(c(C.dim, '  所以这是"已观测到的成本"，不是全部成本。'));
    }
  } else {
    console.log(c(C.dim, '\n  想看调用挂到具体会话：agent-archive calls --by session'));
  }
}

/** token 数量级从几千到几十亿，用中文单位比补一串零好认。 */
function fmtTok(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v);
  if (abs < 10000) return String(v);
  if (abs < 1e8) return (v / 1e4).toFixed(1) + '万';
  return (v / 1e8).toFixed(2) + '亿';
}

/**
 * 用量层：各家 Agent 自己记的 token。
 *
 * 和 `calls` 的区别不是数据新旧，是**能不能看见**：
 * `calls` 只看得见经过本地网关的请求，没装网关就是空的；
 * 这里直接读 Agent 自己的账本，装没装网关都有数，代价是粒度参差。
 *
 * 三个数必须一起给：总量、覆盖了哪些 Agent、有多少条没有成本。
 * 少给一个，读者就会把"没算"当成"没花钱"。
 */
async function cmdUsage(opts) {
  const { readUsage, summarizeUsage } = await import('./usage.js');
  const { loadCatalog } = await import('./pricing.js');
  const r = await readUsage();
  // 价目表是可选的：没有它只报 token 和 Agent 自报的费用
  const catalog = loadCatalog();

  if (!r.ready) {
    const msg = '各家 Agent 的库里都没有找到 token 记录。';
    if (opts.json) {
      console.log(JSON.stringify({ ready: false, message: msg, reports: r.reports }, null, 2));
      return;
    }
    console.log(c(C.when, '用量层不可用'));
    console.log(c(C.dim, '  ' + msg));
    for (const rep of r.reports) {
      if (rep.reason) console.log(c(C.dim, `  ${rep.display}: ${rep.reason}`));
    }
    return;
  }

  const by = (opts.by || 'agent').toLowerCase();

  // 项目维度要先把会话挂到项目上；这一步需要扫归档，按 agent 汇总时不做
  let sessionIndex = [];
  if (by === 'project' || by === 'session') {
    const { listProjects } = await import('./query.js');
    const lp = listProjects({ noCache: opts.noCache, includeSubagents: true, showAll: true });
    for (const p of lp.projects) {
      for (const s of p.sessions) sessionIndex.push({ agent: s.agent, id: s.id, project: p.display });
    }
  }

  const rows = summarizeUsage({ rows: r.rows, groupBy: by, sessionIndex, catalog: catalog.ready ? catalog : null });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ready: true,
          groupBy: by,
          range: r.range,
          reports: r.reports,
          pricing: catalog.ready
            ? { source: catalog.source, fetchedAt: catalog.fetchedAt, models: catalog.count }
            : { ready: false, reason: catalog.reason },
          rows,
        },
        null,
        2
      )
    );
    return;
  }

  const span = r.range ? `${fmtDate(new Date(r.range.start))} → ${fmtDate(new Date(r.range.end))}` : '—';
  console.log(c(C.bold, '已观测 token') + c(C.dim, `   ${r.rows.length} 条记录 · ${span}`));
  console.log('');

  const label = { agent: 'Agent', model: '模型', project: '项目', session: '会话', day: '日期' }[by] || '分组';
  console.log(
    c(
      C.dim,
      `  ${label.padEnd(20)}${'记录'.padStart(7)}${'未缓存输入'.padStart(12)}${'输出'.padStart(11)}${'缓存读'.padStart(11)}${'命中'.padStart(7)}${'成本'.padStart(11)}`
    )
  );

  // 口径未知的来源（目前只有 Codex 的会话总量）单独列：
  // 它和按请求记的数放同一张表里排名，读者会以为它真的比别人贵几百倍。
  const known = rows.filter((g) => !g.semantics.includes('unknown'));
  const unknownOnly = rows.filter((g) => g.semantics.includes('unknown'));

  const printRows = (list) => {
    const top = opts.showAll ? list : list.slice(0, 15);
    for (const g of top) {
      const name = g.key.length > 19 ? g.key.slice(0, 18) + '…' : g.key;
      const hit = g.cacheHit == null ? '—' : `${Math.round(g.cacheHit * 100)}%`;
      const hitMark = g.cacheHit != null && g.cacheHitExcluded ? hit + '*' : hit;
      // 成本：自报优先（$），没有自报就用价目表估（~$）；只覆盖了一部分就加 +
      let cost = '—';
      if (g.cost != null) {
        const partial = g.costUnknown > 0 ? '+' : '';
        cost = (g.cost > 0 ? '$' + g.cost.toFixed(3) : '0') + partial;
      } else if (g.costEst != null) {
        cost = '~$' + g.costEst.toFixed(3);
      }
      console.log(
        '  ' +
          c(C.agent, name.padEnd(20)) +
          c(C.dim, String(g.rows).padStart(7)) +
          fmtTok(g.fresh).padStart(12) +
          fmtTok(g.output).padStart(11) +
          fmtTok(g.cacheRead).padStart(11) +
          c(C.dim, hitMark.padStart(7)) +
          c(g.cost == null ? C.when : C.dim, cost.padStart(11))
      );
    }
    if (list.length > top.length) {
      console.log(c(C.dim, `  …还有 ${list.length - top.length} 组（--all 展开）`));
    }
  };

  printRows(known);

  if (unknownOnly.length) {
    console.log('');
    console.log(c(C.bold, '  口径未知（只有会话级总量，不能和上面直接比较）'));
    const topU = opts.showAll ? unknownOnly : unknownOnly.slice(0, 8);
    for (const g of topU) {
      const name = g.key.length > 19 ? g.key.slice(0, 18) + '…' : g.key;
      console.log(
        '  ' +
          c(C.agent, name.padEnd(20)) +
          c(C.dim, String(g.rows).padStart(7)) +
          fmtTok(g.fresh).padStart(12)
      );
    }
    if (unknownOnly.length > topU.length) {
      console.log(c(C.dim, `  …还有 ${unknownOnly.length - topU.length} 组（--all 展开）`));
    }
  }

  console.log('');
  console.log(c(C.dim, '  输入已统一成"不含缓存"：ZCode 的 input 含缓存读，读的时候减掉了。'));
  console.log(c(C.dim, '  * = 该组里混有口径未知的记录，命中率只按能判断的那部分算。'));
  console.log(c(C.dim, '  $ = Agent 自报；~$ = 按价目表估算，不是账单；+ = 该组只覆盖了一部分记录。'));

  console.log('');
  console.log(c(C.bold, '  数据来源'));
  for (const rep of r.reports) {
    const mark = rep.ready ? c(C.ok, '✓') : c(C.when, '·');
    const what = rep.fidelity ? `按${{ request: '请求', 'session-model': '会话×模型', 'session-total': '会话总量' }[rep.fidelity] || rep.fidelity}记` : '';
    const tail = rep.ready ? c(C.dim, `${rep.rows} 条 · ${what}`) : c(C.dim, rep.reason || '没有数据');
    console.log(`  ${mark} ${rep.display.padEnd(14)}${tail}`);
  }

  const noCost = r.rows.filter((x) => x.cost == null).length;
  const estRecords = rows.reduce((a, g) => a + (g.costEstRecords || 0), 0);
  const untagged = rows.reduce((a, g) => a + (g.unpricedRecords || 0), 0);
  const totalActual = rows.reduce((a, g) => a + (g.cost || 0), 0);
  const totalEst = rows.reduce((a, g) => a + (g.costEst || 0), 0);

  console.log('');
  console.log(c(C.bold, '  成本'));
  console.log(
    c(C.dim, `  $ 自报       ${r.rows.length - noCost} 条 · $${totalActual.toFixed(3)}`)
  );
  if (catalog.ready) {
    console.log(c(C.dim, `  ~$ 估算      ${estRecords} 条 · ~$${totalEst.toFixed(3)}`));
    console.log(
      c(
        C.dim,
        `  价目表 models.dev · ${catalog.count} 个模型 · 抓取于 ${
          catalog.fetchedAt ? fmtDate(new Date(catalog.fetchedAt)) : '未知'
        }`
      )
    );
  } else {
    console.log(c(C.dim, `  没有价目表：${catalog.reason}`));
    console.log(c(C.dim, '  同步一次：agent-archive pricing sync（会联网，只拉目录，不传任何使用数据）'));
  }
  if (untagged) {
    console.log(c(C.dim, `  ${untagged} 条既没自报、价目表里也查不到——"算不出来"不等于 0 元。`));
  }
}

/**
 * 价目表：外部参考价，单独一层。
 *
 * 它和用量层的边界是"谁是事实"：token 是 Agent 记的账，价格是我们从
 * models.dev 拉来的参考。所以即使价目表过期，也不要让它去改历史 token；
 * 反过来，估算出来的钱永远带 ~ 前缀，不和自报的费用混在一起。
 *
 * 同步只下载目录，不上传任何东西。
 */
async function cmdPricing(opts) {
  const { loadCatalog, syncCatalog } = await import('./pricing.js');
  const sub = (opts.positionals[0] || '').toLowerCase();

  if (sub === 'sync') {
    console.log(c(C.dim, '从 models.dev 拉价目表…'));
    try {
      const r = await syncCatalog();
      console.log(c(C.ok, `✓ ${r.count.toLocaleString('en-US')} 个模型`));
      console.log(c(C.dim, `  写入 ${r.file}`));
      console.log(c(C.dim, `  抓取时间 ${fmtDate(new Date(r.fetchedAt))}`));
    } catch (e) {
      console.log(c(C.warn, `✗ 同步失败：${e.message}`));
      console.log(c(C.dim, '  价目表是可选的：没有它用量层照常报 token，只是没有钱。'));
    }
    return;
  }

  const cat = loadCatalog();

  if (opts.json) {
    console.log(
      JSON.stringify(
        cat.ready
          ? {
              ready: true,
              source: cat.source,
              fetchedAt: cat.fetchedAt,
              models: cat.count,
              file: cat.file,
            }
          : { ready: false, reason: cat.reason, file: cat.file },
        null,
        2
      )
    );
    return;
  }

  if (!cat.ready) {
    console.log(c(C.when, '没有价目表'));
    console.log(c(C.dim, `  ${cat.reason}`));
    console.log('');
    console.log(c(C.dim, '  同步一次：agent-archive pricing sync'));
    console.log(c(C.dim, '  只有这一步会联网，读报告时不会。'));
    return;
  }

  console.log(c(C.bold, '价目表') + c(C.dim, `   ${cat.count.toLocaleString('en-US')} 个模型`));
  console.log(c(C.dim, `  来源 ${cat.source} · 抓取于 ${fmtDate(new Date(cat.fetchedAt))}`));
  console.log(c(C.dim, `  文件 ${cat.file}`));
  console.log('');
  console.log(c(C.dim, '  单位是美元 / 百万 token。这是外部参考价，和 Agent 自报的费用是两回事：'));
  console.log(c(C.dim, '  自报的是"它认为花了多少"，估算的是"按今天的公开价应该花多少"。'));
  console.log(c(C.dim, '  同一个模型在不同供应商下价不同，这里优先用厂商自己的目录，'));
  console.log(c(C.dim, '  中转站的报价只作为兜底。'));
  console.log('');
  console.log(c(C.dim, '  刷新：agent-archive pricing sync'));
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
    '--by',
    '--min-gap',
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
    minGap: values['min-gap'],
    key: values.key,
    model: values.model,
    baseUrl: values['base-url'],
    provider: values.provider,
    priceIn: values['price-in'],
    priceOut: values['price-out'],
    by: values.by,
    positionals,
  };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage();
    return;
  }

  // 用户自己写的扫描器要在任何扫描之前注册好。
  // 放在这里而不是 registry 里：动态 import 是异步的，而 scanAll 是同步的，
  // 让扫描入口保持同步比把整条链路改成 async 划算得多。
  await registerUserScanners();

  const opts = parseArgs(rest);
  const first = opts.positionals[0];

  switch (cmd) {
    case 'projects':
    case 'ls':
      return cmdProjects(opts);
    case 'timeline':
    case 'tl':
      return cmdTimeline(first, opts);
    case 'handoff':
    case 'relay':
      return cmdHandoff(first, opts);
    case 'agents':
      return cmdAgents(first, opts);
    case 'stats':
      return cmdStats(opts);
    case 'scanner':
    case 'scanners':
      return cmdScanner(opts);
    case 'config':
      return cmdConfig(opts);
    case 'doctor':
    case 'check':
      return cmdDoctor(opts);
    case 'env':
    case 'inventory':
      return cmdEnv(opts.positionals[0], opts);
    case 'calls':
      return cmdCalls(opts);
    case 'usage':
    case 'tokens':
      return cmdUsage(opts);
    case 'pricing':
    case 'price':
      return cmdPricing(opts);
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
