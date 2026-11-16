/**
 * 把档案馆接到别的 Agent 上：按 Agent 生成**可直接粘贴**的配置片段。
 *
 * 存在的理由是一次很具体的失败体验：`agent-archive mcp` 只打印一份通用
 * JSON 加四行"配置文件位置"，Codex 用户还得自己知道要换成 TOML、知道
 * 段名是 `[mcp_servers]`、知道 Windows 路径在 TOML 里要转义。这是这个
 * 产品最核心的一步（不接上，档案馆对别的 Agent 就不存在），却最像开发者文档。
 *
 * 所以这里做的事只有一件：**按用户机器上真实装了的 Agent，各给一段能直接
 * 粘进去的片段**，附上那个文件到底在哪、在不在。
 *
 * ## 硬边界：只读，绝不写
 *
 * 这个模块从头到尾没有一次写操作。用户问的是"怎么配"，不是"替我配"——
 * 悄悄改别人的 Agent 配置，是档案馆这种只读工具最不该做的事：那些文件里
 * 还有用户自己的 hooks、项目列表、明文凭证，改坏一次就很难恢复。
 * `test/connect.test.js` 里有一条用例专门比对调用前后整个目录的快照。
 *
 * ## 路径表只有一张
 *
 * 该往哪个文件里粘，答案来自 `mcp.js` 的 SOURCES 表（`mcpConfigTargets()`），
 * 这里**不另抄一份路径**。抄一份的下场是解析器认的位置和打印给你的位置
 * 慢慢变成两个，而症状是"照你说的贴了，它还是看不见"。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectPresence, DISPLAY } from './inventory.js';
import { mcpConfigTargets } from './mcp.js';
import { tildify } from '../model.js';

/** 注册名。各家配置里都用这个名字，换名字会让同一个 server 看起来是两份。 */
export const SERVER_NAME = 'agent-archive';

/**
 * 启动这个 MCP server 的方式：当前这个 node + 本仓库里的 mcp.js 绝对路径。
 *
 * 刻意不用 `npx agent-archive-mcp`：用户装的可能是本地 checkout，
 * 走 registry 会拉到另一个版本；而 `node <绝对路径>` 是确定的——
 * 用户看到的就是他现在跑的这一份。
 */
const COMMAND = process.execPath;
const SERVER_PATH = fileURLToPath(new URL('../mcp.js', import.meta.url));

/**
 * 排序：先把最常见的三家放前面。
 *
 * 用户扫一眼就能找到自己那家，比严格按字母排有用得多。
 */
const PRIORITY = ['claude-code', 'codex', 'cursor'];

/** ZCode / OpenCode 的层级：同样是 JSON，但 server 不是放在顶层 mcpServers。 */
const NESTED_LAYER = {
  zcode: ['mcp', 'servers'],
  opencode: ['mcp'],
};

/* --------------------------- 片段的生成 --------------------------- */

/** JSON 片段：统一 2 空格缩进，和用户手写的配置看起来一样。 */
function jsonSnippet(obj) {
  return JSON.stringify(obj, null, 2);
}

/**
 * TOML 的字符串值。**默认用字面量字符串（单引号）**。
 *
 * 这里有个真实的坑：Windows 路径全是反斜杠，而 TOML 的**基本**字符串
 * （双引号）里 `\` 是转义符。直接拼 `command = "C:\Program Files\node.exe"`
 * 的话，`\P` 是非法转义、`\n` 是换行——粘进去整个 config.toml 都解析不了，
 * 而用户只会看到 Codex 起不来，不知道为什么。
 *
 * 两种合法写法里选字面量字符串，理由是它**不需要转义**：
 *   - 字面量字符串（单引号）不处理任何转义，Windows 路径原样写进去就是对的；
 *   - 而且它和档案馆自己的 TOML 解析器（mcp.js 的 parseTomlMcpServers）
 *     读回来的是同一个字符串——"我让你粘的东西，我自己也认得出来"。
 *     走双引号的话得指望每个读它的实现都正确反转义，我们自己的解析器就不做。
 *
 * 路径里真的带单引号时（极少见）退回基本字符串，那时才需要转义。
 */
function tomlString(s) {
  const t = String(s);
  if (!t.includes("'")) return "'" + t + "'";
  return '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * YAML 的字符串字面量：用单引号。
 *
 * YAML 的单引号标量**不处理反斜杠**，Windows 路径可以原样写进去；
 * 双引号反而要转义。所以这里选单引号，只需要把内部的单引号翻倍。
 */
function yamlString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 把 server 条目按层级包起来：['mcp','servers'] → {mcp:{servers:{name:entry}}}。 */
function nest(layer, entry) {
  const out = {};
  let cur = out;
  for (const key of layer.slice(0, -1)) {
    cur[key] = {};
    cur = cur[key];
  }
  cur[layer[layer.length - 1]] = { [SERVER_NAME]: entry };
  return out;
}

/**
 * 生成某个 format 的片段。
 *
 * 返回值可以是 null（这家没有可自动生成的片段），调用方要把 null 如实报出来，
 * 而不是打一段看起来能用的东西让用户去猜。
 */
function snippetFor(format, agent) {
  const stdioEntry = { type: 'stdio', command: COMMAND, args: [SERVER_PATH] };

  switch (format) {
    case 'json-mcpServers':
      return jsonSnippet({ mcpServers: { [SERVER_NAME]: stdioEntry } });

    case 'json-nested': {
      const layer = NESTED_LAYER[agent];
      if (!layer) {
        // 不认识的 json-nested：给通用形状，让 note 去说明层级
        return jsonSnippet({ mcpServers: { [SERVER_NAME]: stdioEntry } });
      }
      // OpenCode 的 stdio 不是 command/args，而是 type: local + command 数组。
      // 用通用形状粘进去它读不出来——这正是"看起来对、其实跑不起来"那类错误。
      const entry =
        agent === 'opencode'
          ? { type: 'local', command: [COMMAND, SERVER_PATH], enabled: true }
          : stdioEntry;
      return jsonSnippet(nest(layer, entry));
    }

    case 'toml-mcp_servers':
      return (
        `[mcp_servers.${SERVER_NAME}]\n` +
        `command = ${tomlString(COMMAND)}\n` +
        `args = [${tomlString(SERVER_PATH)}]`
      );

    case 'yaml-mcp_servers':
      return (
        `mcp_servers:\n` +
        `  ${SERVER_NAME}:\n` +
        `    command: ${yamlString(COMMAND)}\n` +
        `    args:\n` +
        `      - ${yamlString(SERVER_PATH)}`
      );

    case 'yaml-dsh-patch':
      // DSH 把 MCP 声明成 profile 的 loader 条目，不是 mcpServers 映射。
      // 形状照 mcp.js 的 parseDshPatch 能读回来的那个来（同一条契约）。
      return (
        `- insert:\n` +
        `    - id: ${SERVER_NAME}\n` +
        `      name: "@deepseek-ai/dsh-mcp-client"\n` +
        `      config:\n` +
        `        serverName: "${SERVER_NAME}"\n` +
        `        transport: "stdio"\n` +
        `        command: ${yamlString(COMMAND)}\n` +
        `        args: [ ${yamlString(SERVER_PATH)} ]`
      );

    default:
      return null;
  }
}

/**
 * 说明"这段该放哪"。
 *
 * 三层拼起来，少一层用户就得回去翻文档：
 *   1. format 决定的大层级（顶层 mcpServers / [mcp_servers] 段 / …）
 *   2. 这家自己在 SOURCES 表里记的位置备注
 *   3. 还有别的备选文件时，明确说"也可以放这几个"
 */
function noteFor(format, agent, srcNote, altPaths) {
  let layer = null;

  switch (format) {
    case 'json-mcpServers':
      layer = '放在文件顶层的 mcpServers 下';
      break;
    case 'json-nested':
      if (agent === 'zcode') layer = '层级是 mcp.servers（片段已按该层级生成，整段粘进文件即可）';
      else if (agent === 'opencode') layer = '层级是 mcp，且 stdio 要写 type: local + command 数组（片段已按该形状生成）';
      else layer = '这家不是顶层 mcpServers，层级见客户端文档';
      break;
    case 'toml-mcp_servers':
      layer = '追加到 [mcp_servers] 段（文件末尾即可）';
      break;
    case 'yaml-mcp_servers':
      // 片段自带顶层 `mcp_servers:` 键，所以能整段追加到文件末尾；
      // 但如果用户已经有一个 mcp_servers 段，追加就会造出两个同名键
      // （YAML 里后者覆盖前者，前面配的服务会静默消失）。必须说清楚。
      layer = '片段自带顶层 mcp_servers:，可直接追加到文件末尾；若文件里已有 mcp_servers: 段，只把下面 agent-archive 那两层并进去';
      break;
    case 'yaml-dsh-patch':
      layer = 'DSH 的 MCP 是 profile 的 loader 条目（不是 mcpServers），按 insert 形状粘';
      break;
    default:
      layer = null;
  }

  const parts = [layer].filter(Boolean);

  // 来源表里的备注常常和 format 层级说的是同一件事（Claude Code 那条就是
  // 「顶层 mcpServers」，而层级那句已经说了"放在文件顶层的 mcpServers 下"）。
  // 重复的说明读起来像两个不同的要求，用户会去找区别——所以按词判重：
  // 备注里的每个词都已经被层级那句覆盖，就整条丢掉。
  //
  // 中文按**单字**切：这里判的是"这句还有没有新信息"，不是分词，
  // 单字足够——「顶层」两个字都能在层级句里找到，就说明没新东西。
  if (srcNote) {
    const words = (s) =>
      String(s)
        .toLowerCase()
        .match(/[a-z0-9_./*@-]+|[\u4e00-\u9fa5]/g) || [];
    const have = new Set(words(parts.join(' ')));
    const need = words(srcNote);
    const covered = need.length > 0 && need.every((w) => have.has(w));
    if (!covered) parts.push(srcNote);
  }

  if (altPaths && altPaths.length) parts.push(`也可以放：${altPaths.join('、')}`);
  return parts.join('；') || null;
}

/* --------------------------- 探测与组装 --------------------------- */

/** 文件在不在。只 stat，不读内容、不创建。 */
function fileExists(p) {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 这个候选路径在当前平台上讲不讲得通。
 *
 * `userDataCandidates()` 会连**别的平台**的约定一起返回（跨机拷贝备份时有用），
 * 于是一个 Windows 用户的 OpenCode 备选里会冒出
 * `~/Library/Application Support/opencode`。那是 macOS 的位置——
 * 把它当"也可以放"告诉用户，就是在制造一条会失败的建议。
 *
 * 判据只有一条：这条路径属于某个别的平台、且在这台机器上并不存在。
 * 存在的就保留（跨平台备份目录真的在磁盘上时，它是有效位置）。
 */
function plausibleOnThisPlatform(p) {
  if (!p) return false;
  if (fileExists(p)) return true;
  const n = String(p).replace(/\\/g, '/');
  if (process.platform !== 'win32' && /\/AppData\/(Roaming|Local)\//.test(n)) return false;
  if (process.platform !== 'darwin' && /\/Library\/Application Support\//.test(n)) return false;
  return true;
}

function rank(agent) {
  const i = PRIORITY.indexOf(agent);
  return i >= 0 ? i : PRIORITY.length;
}

function compareTargets(a, b) {
  const d = rank(a.agent) - rank(b.agent);
  if (d !== 0) return d;
  return String(a.display).localeCompare(String(b.display));
}

/**
 * 按 Agent 组装 MCP 配置片段。
 *
 * @param {{all?: boolean, agent?: string|null}} [opts]
 *   all   默认只给这台机器上真的装了的（装了才需要配）；true 给全部已知目标
 *   agent 只看某一家（名字用内部 id，如 codex）
 * @returns {{
 *   servers: {name: string, command: string, args: string[]},
 *   agents: Array<{
 *     agent: string, display: string, installed: boolean,
 *     configPath: string|null, path: string|null, altPaths: string[],
 *     exists: boolean, format: string, snippet: string|null, note: string|null
 *   }>
 * }}
 */
export function connectTargets({ all = false, agent = null } = {}) {
  const presence = new Map(detectPresence().map((p) => [p.agent, p]));
  const wanted = agent ? String(agent).trim().toLowerCase() : null;

  // 一个 Agent 可能在 SOURCES 里有多条（Claude Code 就有两个位置），
  // 按 Agent 归并：**第一条的第一个路径**当主配置路径，其余都是备选位置。
  //
  // 主路径必须是"最常用的那个"，不能是随便哪个：用户照着写的时候，
  // 写进 ~/.claude.json 和写进 .claude/settings.json 的效果不一样
  // （后者是项目/用户设置，前者是 Claude Code 自己的主配置）。
  // 所以这里保持 SOURCES 里的顺序，第一条就是主路径。
  const grouped = new Map();
  for (const t of mcpConfigTargets()) {
    if (wanted && t.agent !== wanted) continue;
    let g = grouped.get(t.agent);
    if (!g) {
      // primaryNote 只取第一条来源的：同一个 Agent 的多条来源是同一种格式的
      // 几个位置，位置备注已经由 altPaths 表达了，不需要再把第二条的备注也堆上来。
      g = { agent: t.agent, format: t.format, paths: [], primaryNote: t.note || null };
      grouped.set(t.agent, g);
    }
    for (const p of t.paths) {
      if (!g.paths.includes(p)) g.paths.push(p);
    }
  }

  const agents = [];
  for (const g of grouped.values()) {
    const p = presence.get(g.agent) || null;
    // 只留这台机器上讲得通的位置：别的平台的约定路径不该出现在"该往哪写"里
    const paths = g.paths.filter(plausibleOnThisPlatform);
    const primary = paths[0] || g.paths[0] || null;
    const exists = fileExists(primary);

    // "装没装"以 detectPresence 为准（它认的是会话/配置/数据三层证据）。
    // 但 SOURCES 里有几家（Droid / Devin / Claude 桌面版等）不在 presence 名单里，
    // 对它们退回"配置文件在不在"——这本来就是 detectPresence 自己的判据之一，
    // 而不是猜。
    const installed = p ? p.level !== 'none' : exists;

    // 默认只给真的装了的：装了才需要配，把 20 家全列出来用户还得自己找。
    // 但显式点了名（--agent codex）就照给——那是在问"这家该往哪写"，
    // 哪怕这台机器上还没装，答案也是他要的。
    if (!all && !wanted && !installed) continue;

    agents.push({
      agent: g.agent,
      display: DISPLAY[g.agent] || g.agent,
      installed,
      // 展示用 ~ 缩写：不把用户名和完整盘符当成输出的一部分
      configPath: primary ? tildify(primary) : null,
      // 原始绝对路径：--json 的消费方（脚本/网页）要能直接用
      path: primary,
      // 备选位置（同一种格式、另一份文件）。给出来是必要的：
      // 用户可能已经在用 .claude/settings.json 而不是 .claude.json。
      altPaths: paths.slice(1).map(tildify),
      exists,
      format: g.format,
      snippet: snippetFor(g.format, g.agent),
      note: noteFor(g.format, g.agent, g.primaryNote, paths.slice(1).map(tildify)),
    });
  }

  agents.sort(compareTargets);

  return {
    servers: { name: SERVER_NAME, command: COMMAND, args: [SERVER_PATH] },
    agents,
  };
}
