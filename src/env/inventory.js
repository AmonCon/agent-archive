/**
 * 环境层总入口：这台机器上有哪些 Agent、各具备什么能力。
 *
 * 会话层回答"聊过什么"，环境层回答"会什么"。两层共用同一个注册表
 * 思路——没有标准接口，只能一家一个适配器，集中成注册表才可维护。
 *
 * 这个模块只做**汇总与体检**，真正的解析在 mcp.js / skills.js / memory.js。
 * 分开的理由：汇总要给三种消费者用（CLI、MCP 工具、网页），
 * 它们需要的粒度完全不同，混在解析里会让解析器越来越难改。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpSummary } from './mcp.js';
import { skillSummary } from './skills.js';
import { memorySummary } from './memory.js';

/**
 * 这台机器上"装了什么"的判断。
 *
 * 刻意分三级，因为三种状态对用户的意义完全不同：
 *
 *   config — 有配置文件，说明这个 Agent 至少被启动过、配过东西
 *   data   — 有会话/记忆数据，说明真的用过
 *   none   — 都没有
 *
 * 只按"目录存在"判断会高估：装了个 VS Code 扩展也会创建目录。
 * 只按"有会话"判断会低估：配好 MCP 但还没聊过的 Agent 是真实存在的状态。
 */
const AGENT_PRESENCE = [
  { agent: 'claude-code', config: ['.claude.json', '.claude/settings.json'], data: ['.claude/projects'] },
  { agent: 'codex', config: ['.codex/config.toml'], data: ['.codex/sessions', '.codex/memories'] },
  { agent: 'zcode', config: ['.zcode/cli/config.json'], data: ['.zcode/cli/db'] },
  { agent: 'qoder', config: ['.qoder/mcp.json', '.qoder/settings.json'], data: ['.qoder/cache/projects', '.qoder/projects', '.qoder-cn/projects', '.qoder/memory'] },
  { agent: 'dsh', config: ['DeepSeekHarness/cordis.patch.yml', '.dsh/config.yaml'], data: ['DeepSeekHarness/sessions', '.dsh/sessions'] },
  { agent: 'hermes', config: ['.hermes/config.yaml'], data: ['.hermes/sessions', '.hermes/memories'] },
  { agent: 'cursor', config: ['.cursor/mcp.json', '.cursor/cli-config.json'], data: ['.cursor/projects', '.cursor/chats'] },
  { agent: 'opencode', config: ['.config/opencode/opencode.json'], data: ['.local/share/opencode/opencode.db'] },
  { agent: 'gemini', config: ['.gemini/settings.json'], data: ['.gemini/antigravity', '.gemini/tmp'] },
  { agent: 'kiro', config: ['.kiro/argv.json'], data: ['.kiro/skills'] },
  { agent: 'antigravity', config: [], data: ['.gemini/antigravity/conversation_summaries.db'] },
  { agent: 'copilot', config: [], data: ['AppData/Roaming/Code/User/workspaceStorage'] },
];

const DISPLAY = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  zcode: 'ZCode',
  qoder: 'Qoder',
  dsh: 'DeepSeek Harness',
  hermes: 'Hermes',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  copilot: 'Copilot Chat',
  'shared-agents': '~/.agents（共享）',
};

function exists(rel) {
  const p = path.join(os.homedir(), ...rel.split('/'));
  try {
    fs.statSync(p);
    return p;
  } catch {
    return null;
  }
}

/**
 * 探测本机有哪些 Agent。
 *
 * 存在的每个都给 `level`：config / data / none。
 */
export function detectPresence() {
  return AGENT_PRESENCE.map((a) => {
    const configs = a.config.map(exists).filter(Boolean);
    const data = a.data.map(exists).filter(Boolean);
    const level = data.length ? 'data' : configs.length ? 'config' : 'none';
    return {
      agent: a.agent,
      display: DISPLAY[a.agent] || a.agent,
      level,
      hasConfig: configs.length > 0,
      hasData: data.length > 0,
    };
  });
}

/**
 * 汇总结果缓存。
 *
 * MCP server 是常驻进程，同一个会话里 `inventory` 可能被调好几次
 * （先看 overview，再 topic 细看）。每次重新扫 375 个技能目录没有意义——
 * 用户不会在两秒内改完 SKILL.md。
 *
 * 缓存的失效靠 TTL 而不是文件监听：环境层没有"刚刚变了"的强信号，
 * 而 TTL 的代价只是"最多晚 N 秒看到变化"，比每次全量扫便宜得多。
 * CLI 每次是独立进程，所以这个缓存只对 MCP 常驻进程有意义。
 */
const INVENTORY_TTL_MS = 30_000;
let cached = null;
let cachedAt = 0;

/** 测试用：丢掉汇总缓存。 */
export function clearInventoryCache() {
  cached = null;
  cachedAt = 0;
}

/**
 * 完整清单。
 *
 * 三层各取摘要，再用 presence 把它们接起来——
 * "某 Agent 存在但一个技能都没装"这种状态，只有汇总才能看出来。
 */
export function fullInventory({ includeDetails = false, fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < INVENTORY_TTL_MS) {
    // 返回深拷贝，不是同一引用。
    //
    // 这不是洁癖：MCP 工具会拿 summary.list 去 filter/map，网页会往里
    // 塞展示字段。一旦某个调用方改到了缓存里的对象，后面所有调用都读到
    // 被污染的数据——而症状是"技能数莫名多了一个"，极难查。
    // 结构是纯 JSON，深拷贝一份约 1ms，比 debug 便宜得多。
    return structuredClone(cached);
  }

  const presence = detectPresence();
  const mcp = mcpSummary();
  const skills = skillSummary({ includeLocations: includeDetails });
  const memory = memorySummary();

  // 以真实存在的 Agent 为准（不是三家全集的并集）
  const present = presence.filter((p) => p.level !== 'none');

  const agents = present.map((p) => {
    const a = p.agent;
    return {
      agent: a,
      display: p.display,
      level: p.level,
      // 这个 Agent 配了哪些 MCP 服务（按服务身份，不是按注册名）
      mcp: mcp.list.filter((s) => s.agents.includes(a)).map((s) => s.service),
      // 这个 Agent 能用的技能数。注意 shared-agents 是共享目录，
      // 这里如实分开算——Kiro 的 28 个是符号链接到共享目录的，
      // 算在 Kiro 名下但也算在共享名下，这是事实，不该去重掉
      skills: skills.byAgent[a] || 0,
      memory: memory.byAgent[a] ? memory.byAgent[a].entries || memory.byAgent[a].files : 0,
      memoryLocations: memory.byAgent[a] ? memory.byAgent[a].files : 0,
    };
  });

  const result = {
    platform: process.platform,
    agents,
    summary: {
      agentsPresent: present.length,
      agentsWithData: present.filter((p) => p.level === 'data').length,
      mcpServices: mcp.services,
      mcpRegistrations: mcp.registrations,
      skills: skills.skills,
      skillInstalls: skills.installs,
      memoryLocations: memory.locations,
      memoryEntries: memory.entries,
    },
    mcp,
    skills,
    memory,
  };

  // 只缓存不含逐条位置信息的版本：includeDetails 是少数派，
  // 且它返回的内容大，缓存起来不值得。
  // 存进去的是自己的副本，不是调用方拿到的那个对象。
  if (!includeDetails) {
    cached = structuredClone(result);
    cachedAt = Date.now();
  }

  return result;
}

/**
 * 环境层体检。
 *
 * 与会话层的 doctor 同一个思路：报数字，不报感觉。检查的都是
 * "看起来正常、实际会让人做错判断"的东西。
 */
export function auditEnvironment() {
  const inv = fullInventory();
  const findings = [];

  // 1. 同一服务在不同 Agent 里安装形态不一致。
  //    最实际的后果：一边钉住版本、一边每次拉最新，两边跑的可能不是同一个东西。
  for (const m of inv.mcp.mixedForms) {
    findings.push({
      level: 'warn',
      area: 'mcp',
      title: `MCP 服务「${m.service}」有多种安装形态`,
      detail: `分布在 ${m.agents.join('、')}，形态：${m.forms.join(' / ')}。` +
        `npx 每次拉最新，本地安装钉住版本，两边行为可能不同。`,
    });
  }

  // 2. 同一服务在不同 Agent 里名字不同。不是错误，但会让人以为配了两份。
  for (const a of inv.mcp.aliased) {
    findings.push({
      level: 'info',
      area: 'mcp',
      title: `MCP 服务「${a.service}」在各家叫不同名字`,
      detail: `别名：${a.aliases.join(' / ')}。按启动指纹认出是同一个服务。`,
    });
  }

  // 3. 明文凭证：这一层最该提醒的地方。
  //    只说键名，不说值——这个工具自己不能变成泄漏渠道。
  for (const c of inv.mcp.withCredentials) {
    const secretish = c.envKeys.filter((k) => /SECRET|KEY|TOKEN|PASSWORD/i.test(k));
    if (!secretish.length) continue;
    findings.push({
      level: 'warn',
      area: 'credentials',
      title: `MCP 服务「${c.service}」的配置里有明文凭证`,
      detail: `环境变量键：${secretish.join('、')}。值未读取、未传输。` +
        `这类值会被每个读到该配置的 Agent 拿到，建议改用凭证注入或最小权限账号。`,
    });
  }

  // 4. 记忆格式分散：同一种"记忆"在 5 个地方、3 种格式里。
  //    不是要合并（会撒谎），而是要让人知道"换 Agent 后旧记忆不会跟过去"。
  const memFormats = [...new Set(inv.memory.list.map((m) => m.format))];
  if (memFormats.length > 1) {
    findings.push({
      level: 'info',
      area: 'memory',
      title: `记忆分散在 ${memFormats.length} 种格式里`,
      detail: `格式：${memFormats.join(' / ')}。` +
        `这些记忆彼此独立，换 Agent 不会自动继承——需要在那个 Agent 里重新建立，` +
        `或者由它自己通过本工具的 MCP 读取后自行决定怎么用。`,
    });
  }

  // 5. 有 Agent 存在但完全没有任何能力数据（没 MCP、没技能、没记忆）。
  const empty = inv.agents.filter((a) => !a.mcp.length && !a.skills && !a.memory);
  for (const a of empty) {
    findings.push({
      level: 'info',
      area: 'agent',
      title: `${a.display} 只有数据、没有配置层能力`,
      detail: '没识别到 MCP、技能或记忆。可能是还没配过，也可能是这家把配置放在本工具还没适配的位置。',
    });
  }

  // 6. 技能只在共享目录里出现一次、没有链接到任何 Agent。
  //    这类技能装了等于没装——Agent 根本读不到。
  const orphanSkills = inv.skills.list.filter(
    (s) => s.agents.length === 1 && s.agents[0] === 'shared-agents'
  );
  if (orphanSkills.length) {
    findings.push({
      level: 'info',
      area: 'skills',
      title: `${orphanSkills.length} 个技能只在共享目录里，没有链接到任何 Agent`,
      detail: `例如：${orphanSkills.slice(0, 5).map((s) => s.name).join('、')}。` +
        `共享目录本身不生效，要有 Agent 目录里的链接或副本才读得到。`,
    });
  }

  return {
    summary: inv.summary,
    // 高优先级的排前面
    findings: findings.sort((a, b) => rank(a.level) - rank(b.level)),
    agents: inv.agents,
  };
}

function rank(level) {
  if (level === 'warn') return 0;
  if (level === 'info') return 1;
  return 2;
}

export { DISPLAY };
