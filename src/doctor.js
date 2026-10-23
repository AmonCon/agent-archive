/**
 * 采集质量体检。
 *
 * 这个模块回答一个问题：**我们真的把本机的会话都读到了吗，读对了吗？**
 *
 * 现有的 stats 只说"扫了多少文件、识别出多少会话"，那是产量而不是质量。
 * 真正会悄悄坏掉的是这些：
 *
 *   - 时间戳缺失 → 时间线排序错乱，用户看不出问题但结论会错
 *   - 项目缺失   → 会话进不了任何项目，等于对用户隐身
 *   - 标题是注入内容 → 列表看起来全是垃圾
 *   - 同一 id 出现多次 → 时间线重复计数
 *   - 正文读不出来 → 能看见但打不开
 *
 * 每一项都可以量化成覆盖率，所以 doctor 输出的是数字，不是感觉。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll, scanners } from './registry.js';
import { readSessionContent } from './query.js';
import { projectKey, isProjectPath } from './model.js';
import { userDataCandidates, dataCandidates, candidatesWith } from './platform.js';

/** 各 Agent 的存储根目录是否存在于本机。 */
export function detectAgents() {
  return scanners.map((s) => {
    let files = 0;
    let present = false;
    try {
      const found = s.discover();
      files = found.length;
      present = found.length > 0;
    } catch {
      /* discover 失败就当不存在 */
    }
    return { agent: s.name, present, files };
  });
}

/**
 * 按 Agent 统计采集质量。
 *
 * 正文可读性只抽样验证：全量读一遍要 33 秒，体检不该那么重。
 * 抽样取每家的前若干个，够发现"完全读不出"这类系统性故障。
 */
export async function auditCollection({ samplePerAgent = 3, noCache = false } = {}) {
  const { sessions, stats } = scanAll({ noCache });

  const byAgent = new Map();
  for (const s of sessions) {
    let e = byAgent.get(s.agent);
    if (!e) {
      e = {
        agent: s.agent,
        total: 0,
        noStart: 0,
        noEnd: 0,
        noProject: 0,
        tempProject: 0,
        neverHadProject: false,
        placeholderTitle: 0,
        injectedTitle: 0,
        zeroDuration: 0,
        chars: 0,
      };
      byAgent.set(s.agent, e);
    }
    e.total++;
    if (!s.start) e.noStart++;
    if (!s.end) e.noEnd++;
    if (!s.project) {
      e.noProject++;
      e.neverHadProject = true;
    } else if (!isProjectPath(s.project)) {
      // 有路径但被过滤：通常是 Agent 的临时工作区（.zcode/workspace/<uuid>、
      // Documents/Codex/<日期>/<名字>），不是采集缺陷，单独计数
      e.tempProject++;
    }
    if (/^\(.*\)$/.test(String(s.title || ''))) e.placeholderTitle++;
    if (/^<[a-z][\w-]*[\s>]/i.test(String(s.title || ''))) e.injectedTitle++;
    if (s.start && s.end && s.end.getTime() === s.start.getTime()) e.zeroDuration++;  }

  // 重复 id
  const seen = new Map();
  for (const s of sessions) {
    const k = `${s.agent}|${s.id}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const duplicates = [...seen.values()].filter((n) => n > 1).length;

  // 抽样验证正文可读性。随机取而不是取前 N 个——
  // Antigravity 那种"只有一部分会话有明文转录"的 Agent，
  // 取前几个会恰好抽到能读的，掩盖掉大面积的读不出。
  const readable = new Map();
  for (const [agent, e] of byAgent) {
    const all = sessions.filter((s) => s.agent === agent);
    const sample = pickSpread(all, samplePerAgent);
    let ok = 0;
    let msgs = 0;
    const errors = [];
    for (const s of sample) {
      try {
        const m = await readSessionContent(s);
        msgs += m.length;
        ok++;
      } catch (err) {
        errors.push(`${s.id.slice(0, 12)}: ${err && err.message ? err.message : err}`);
      }
    }
    readable.set(agent, { tried: sample.length, ok, msgs, errors });
  }

  const agents = [...byAgent.values()].map((e) => ({
    ...e,
    bodyOk: readable.get(e.agent) ? readable.get(e.agent).ok : 0,
    bodyTried: readable.get(e.agent) ? readable.get(e.agent).tried : 0,
    bodyMsgs: readable.get(e.agent) ? readable.get(e.agent).msgs : 0,
    bodyErrors: readable.get(e.agent) ? readable.get(e.agent).errors : [],
  }));

  return {
    total: sessions.length,
    files: stats.files,
    failures: stats.failures,
    duplicates,
    agents,
    coverage: {
      // 时间、项目、标题是三根支柱，缺哪根都会让结论失真。
      //
      // 项目覆盖率的分母要排掉"本来就没有项目"的会话：Hermes 是接飞书
      // 渠道的助手，不绑定工作目录，让它拉低覆盖率是错的指标。
      time: ratio(sessions, (s) => s.start && s.end),
      project: projectRatio(sessions, agents),
      cleanTitle: ratio(sessions, (s) => {
        const t = String(s.title || '');
        return t && t !== '(untitled)' && !/^\(.*\)$/.test(t) && !/^<[a-z][\w-]*[\s>]/i.test(t);
      }),
      // 没有真人输入的会话（桌面端自动触发、定时任务）单独算一个比例。
      // 它们用 "(Codex Desktop)" 这类来源做标题是合理降级，不算缺陷，
      // 但数量多说明这类自动化会话占比高，值得知道。
      withoutUserInput: ratio(sessions, (s) => !/^\(.*\)$/.test(String(s.title || ''))),
    },
  };
}

/**
 * 项目归属覆盖率。
 *
 * 分母是"真的给了路径"的会话，排除三类本来就不该有项目的：
 *
 *   1. 该 Agent 从不记录工作目录（Hermes 接飞书渠道，没有 cwd 概念）
 *   2. 完全没有 project 字段的（同上，数据里就没有）
 *
 * 分子是"能归到真实项目"的。Agent 的临时落脚点（.zcode/workspace/<uuid>、
 * Documents/Codex/<日期>、桌面）有路径但不是项目，被 isProjectPath 过滤——
 * 这些算在分母里但不算分子，因为它们确实是"没能归到项目"。
 *
 * 这样这个数字才回答得了"我该不该去看一眼"：低于 90% 说明有一批会话
 * 挂在某个非项目路径上，可能是适配时字段取错了。
 */
function projectRatio(sessions, agents) {
  const neverHasProject = new Set(
    agents.filter((a) => a.total > 0 && a.noProject === a.total).map((a) => a.agent)
  );
  const withPath = sessions.filter((s) => !neverHasProject.has(s.agent) && s.project);
  return ratio(withPath, (s) => isProjectPath(s.project));
}

function ratio(list, pred) {
  if (!list.length) return 0;
  let n = 0;
  for (const x of list) if (pred(x)) n++;
  return n / list.length;
}

/**
 * 从列表里均匀取 n 个，而不是取前 n 个。
 *
 * 会话列表是按时间倒序的，"前几个"就是"最近几个"，不具代表性。
 * 均匀取样能把"只有早期会话可读"这类问题暴露出来。
 */
function pickSpread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  const step = (list.length - 1) / (n - 1 || 1);
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * step)]);
  return out;
}

/**
 * 找出「本机装了但读不到会话」的 Agent 目录。
 *
 * 这是 doctor 最有用的部分：它不依赖我们写过的 scanner，
 * 而是去看一堆已知的存储位置在不在、里面有没有像会话的东西。
 * 有目录却没有对应 scanner，就是明确的采集缺口。
 */
export function detectGaps() {
  const home = os.homedir();

  // 两个路径来源：应用数据目录（VS Code 系，各平台不同）用候选列表探，
  // 家目录点文件（~/.claude 之类）在各平台一致，直接用。
  const appPaths = (appName, rel) => candidatesWith(userDataCandidates(appName), rel);
  const dataPaths = (appName, rel) => candidatesWith(dataCandidates(appName), rel);
  const homePath = (rel) => path.join(home, ...rel.split('/'));

  const candidates = [
    {
      name: 'Cursor',
      agent: 'cursor',
      paths: appPaths('Cursor', 'User/globalStorage/state.vscdb').map((p) => ({ p, kind: 'vscdb' })),
    },
    {
      name: 'Windsurf',
      agent: 'windsurf',
      paths: [{ p: homePath('.codeium/windsurf/cascade'), kind: 'dir' }],
      // 实测 2026-10：cascade/*.pb 熵 7.998 bits/byte，无 protobuf 可读结构，
      // 是加密或压缩后的不透明格式。database/ 是空目录。
      blocked: '会话文件是加密的 .pb（熵 7.998）',
    },
    {
      name: 'Trae',
      agent: 'trae',
      paths: [
        ...appPaths('Trae', 'User/globalStorage/state.vscdb').map((p) => ({ p, kind: 'vscdb' })),
        // Trae 另把会话存在 ModularData 下（加密库），只用来判断"有没有"
        ...userDataCandidates('Trae').map((root) => ({
          p: path.join(root, 'ModularData', 'ai-chat', 'database.db'),
          kind: 'sqlite',
        })),
      ],
      // state.vscdb 里只有 localAgentData（自定义 Agent 的提示词配置），
      // 真正的会话在 ModularData/ai-chat/database.db，实测熵 7.999、
      // 无 "SQLite format 3" 头——是 SQLCipher 或类似加密。
      blocked: '会话库是加密的（熵 7.999，非明文 SQLite）',
    },
    {
      name: 'Kiro',
      agent: 'kiro',
      paths: appPaths('Kiro', 'User/globalStorage/kiro.kiroagent').map((p) => ({ p, kind: 'dir' })),
    },
    {
      name: 'Copilot Chat',
      agent: 'copilot',
      paths: appPaths('Code', 'User/workspaceStorage').map((p) => ({ p, kind: 'dir' })),
    },
    {
      name: 'Cline',
      agent: 'cline',
      paths: [{ p: homePath('.cline/data/db/sessions.db'), kind: 'sqlite' }],
      // 实测 2026-10：所有库 0 行，-wal 的几十 KB 全是建表 schema 页，
      // 扩展本身也没装。不是"没找到"，是确实没有对话数据。
      blocked: '本机无数据（库全空，扩展未安装）',
    },
    {
      name: 'OpenCode',
      agent: 'opencode',
      paths: dataPaths('opencode', 'opencode.db').map((p) => ({ p, kind: 'sqlite' })),
    },
    {
      name: 'Antigravity',
      agent: 'antigravity',
      paths: [{ p: homePath('.gemini/antigravity/conversation_summaries.db'), kind: 'sqlite' }],
    },
    {
      name: 'Qoder',
      agent: 'qoder',
      paths: [{ p: homePath('.qoder/cache/projects'), kind: 'dir' }],
    },
    {
      name: 'Hermes',
      agent: 'hermes',
      paths: [{ p: homePath('.hermes/sessions'), kind: 'dir' }],
    },
    {
      name: 'Claude Code',
      agent: 'claude-code',
      paths: [{ p: homePath('.claude/projects'), kind: 'dir' }],
    },
    {
      name: 'Codex',
      agent: 'codex',
      paths: [{ p: homePath('.codex/sessions'), kind: 'dir' }],
    },
    {
      name: 'ZCode',
      agent: 'zcode',
      paths: [{ p: homePath('.zcode/cli/db'), kind: 'dir' }],
    },
  ];

  const known = new Set(scanners.map((s) => s.name));
  const out = [];

  for (const c of candidates) {
    const hits = [];
    for (const t of c.paths) {
      if (!t.p) continue;
      try {
        const st = fs.statSync(t.p);
        const size = st.isDirectory() ? null : st.size;
        hits.push({ path: t.p, kind: t.kind, size });
      } catch {
        /* 不存在 */
      }
    }
    out.push({
      name: c.name,
      agent: c.agent,
      present: hits.length > 0,
      supported: known.has(c.agent),
      // 已调研过、确认读不了的（加密格式），与"还没做"要分开报，
      // 否则待办里永远挂着几个做不了的项目
      blocked: c.blocked || null,
      hits,
    });
  }

  return out;
}

export { projectKey };
