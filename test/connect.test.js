import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.js';
import { connectTargets, SERVER_NAME } from '../src/env/connect.js';
import { mcpConfigTargets, scanMcp } from '../src/env/mcp.js';

/**
 * connect 的契约：按 Agent 给出**能直接粘**的 MCP 配置片段。
 *
 * 这里锁的几件事，每一件都对应一次真实会发生的失败：
 *
 *   1. 片段本身对不对——把片段写进一个假配置文件，再用**我们自己的解析器**
 *      读回来。这是唯一能证明"粘进去它真的能看见"的办法；只断言字符串
 *      长得像，等于什么都没证明。
 *   2. Windows 路径在 TOML 里的反斜杠。不转义的话 `C:\Program Files\node.exe`
 *      里的 `\P` 是非法转义、`\n` 是换行，粘进去整个配置文件就解析不了。
 *   3. 默认只给装了的。把 20 家全列出来，用户还是得自己找。
 *   4. **一个字节都不写**。这是档案馆的硬边界：用户问"怎么配"，不是"替我配"。
 *      那些配置里还有他自己的 hooks、项目列表和明文凭证，改坏一次很难恢复。
 */

const SERVER_PATH = fileURLToPath(new URL('../src/mcp.js', import.meta.url));

/** 在假家目录里跑一次 connect。 */
async function connect(box, opts) {
  return box.run(() => connectTargets(opts));
}

/** 找某个 agent 的那一条。 */
function targetFor(r, agent) {
  return r.agents.find((a) => a.agent === agent);
}

/** JSON 片段解析：片段必须是合法 JSON，否则粘不进任何配置文件。 */
function parseJsonSnippet(snippet) {
  return JSON.parse(snippet);
}

/**
 * 把整棵目录做成快照：相对路径 → size + mtime。
 *
 * 只比 size 不够（原地改内容可能大小不变），只比 mtime 也不够
 * （Windows 上有些写入不改 mtime）。两个一起，且新增/删除的路径也进集合。
 */
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        out.set(r + '/', 'dir');
        walk(full, r);
      } else {
        out.set(r, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(root, '');
  return out;
}

test('connect: 装了 Claude Code 就给顶层 mcpServers 的 JSON，configPath 指向沙箱的 ~/.claude.json', async () => {
  const box = sandbox();
  try {
    box.write('.claude.json', JSON.stringify({ mcpServers: {} }));

    const r = await connect(box);
    const claude = targetFor(r, 'claude-code');
    assert.ok(claude, '装了 Claude Code 就该出现');

    assert.equal(claude.display, 'Claude Code', 'display 走 inventory 的 DISPLAY 表');
    assert.equal(claude.installed, true);
    assert.equal(claude.format, 'json-mcpServers');
    // 展示用 ~ 缩写；原始绝对路径另给一份（脚本/网页要能用）
    assert.equal(claude.configPath, '~/.claude.json');
    assert.equal(claude.path, box.path('.claude.json'));
    assert.equal(claude.exists, true, '文件确实在');

    const j = parseJsonSnippet(claude.snippet);
    assert.ok(j.mcpServers, '顶层必须是 mcpServers');
    assert.ok(j.mcpServers[SERVER_NAME], '注册名是 agent-archive');
    assert.equal(j.mcpServers[SERVER_NAME].type, 'stdio');
  } finally {
    box.cleanup();
  }
});

test('connect: 装了 Codex 就给 TOML 段，Windows 反斜杠不能变成转义符', async () => {
  const box = sandbox();
  try {
    box.write('.codex/config.toml', 'model = "gpt-5"\n');

    const r = await connect(box);
    const codex = targetFor(r, 'codex');
    assert.ok(codex, '装了 Codex 就该出现');
    assert.equal(codex.format, 'toml-mcp_servers');
    assert.match(codex.snippet, /^\[mcp_servers\.agent-archive\]/m, '段名必须是 [mcp_servers.agent-archive]');

    // Windows 上 execPath 是反斜杠路径。TOML 基本字符串（双引号）里 `\` 是转义符：
    // 直接写 `C:\Program Files\node.exe` 会让 `\P` 成非法转义、`\n` 成换行，
    // 整个 config.toml 解析失败。所以值必须走**字面量字符串**（单引号，不转义）。
    assert.ok(
      codex.snippet.includes(`command = '${process.execPath}'`),
      `command 必须用不转义的字面量字符串：${codex.snippet}`
    );
    assert.ok(
      codex.snippet.includes(`args = ['${SERVER_PATH}']`),
      `args 必须用不转义的字面量字符串：${codex.snippet}`
    );
    // 反证：绝不能出现双引号包着裸反斜杠的路径
    assert.ok(
      !/"[^"\n]*\\[^"\n]*"/.test(codex.snippet),
      `双引号字符串里不能有裸反斜杠（会被当转义）：${codex.snippet}`
    );
  } finally {
    box.cleanup();
  }
});

test('connect: 片段写进配置文件后，我们自己的解析器必须能读回来', async () => {
  // 这是整个模块最重要的一条：不是"字符串长得像配置"，而是
  // "粘进去，档案馆自己认得出这个 server"。
  const box = sandbox();
  try {
    const all = await connect(box, { all: true });
    const pick = (a) => all.agents.find((x) => x.agent === a);

    // 每一种 format 各挑一家真实形状的落盘：
    //   JSON 顶层 / JSON 嵌套两层（ZCode）/ JSON 嵌套一层（OpenCode）
    //   TOML / YAML / DSH 的 loader 条目
    box.write('.claude.json', pick('claude-code').snippet);
    box.write('.zcode/cli/config.json', pick('zcode').snippet);
    box.write('.config/opencode/opencode.json', pick('opencode').snippet);
    // TOML 追加到已有配置后面（真实用法：文件里本来就有别的东西）
    box.write('.codex/config.toml', 'model = "gpt-5"\n\n' + pick('codex').snippet + '\n');
    box.write('.hermes/config.yaml', 'model: x\n' + pick('hermes').snippet + '\n');
    box.write('DeepSeekHarness/profiles/desktop/cordis.patch.yml', pick('dsh').snippet);

    const r = await box.run(() => scanMcp());
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.invalid.length, 0, `片段不该被解析器判成"配坏了"：${JSON.stringify(r.invalid)}`);

    for (const agent of ['claude-code', 'zcode', 'opencode', 'codex', 'hermes', 'dsh']) {
      const reg = r.registrations.find((x) => x.agent === agent && x.name === SERVER_NAME);
      assert.ok(reg, `${agent} 的片段粘进去后必须能被解析出来`);
      assert.equal(reg.transport, 'stdio', `${agent}: 必须是 stdio`);
      assert.equal(reg.command, process.execPath, `${agent}: command 要还原成原始路径`);
      assert.deepEqual(reg.args, [SERVER_PATH], `${agent}: args 要还原成原始路径`);
      assert.equal(reg.commandFound, true, `${agent}: 指向的 node 必须存在`);
      assert.equal(reg.problem, null, `${agent}: 不能是"配坏了"的条目`);
      assert.equal(reg.enabled, true, `${agent}: 不能一粘进去就是停用状态`);
    }
  } finally {
    box.cleanup();
  }
});

test('connect: 没装的默认不出现，all:true 才出现', async () => {
  const box = sandbox();
  try {
    // 沙箱里什么都没有：一个都不该出现
    const empty = await connect(box);
    assert.deepEqual(empty.agents, [], '空机器上默认不该列任何 Agent');

    // all:true 才给全量
    const all = await connect(box, { all: true });
    const ids = all.agents.map((a) => a.agent);
    assert.ok(ids.includes('codex'), 'all:true 要包含没装的');
    assert.ok(ids.includes('claude-code'));
    assert.ok(ids.includes('opencode'));
    assert.ok(all.agents.length >= 20, `all:true 要给全部已知目标，实际 ${all.agents.length}`);

    // 没装的要如实标 installed: false，exists: false
    for (const a of all.agents) {
      if (a.agent === 'codex') {
        assert.equal(a.installed, false);
        assert.equal(a.exists, false);
        // 路径仍然要给——用户就是要知道该往哪写
        assert.equal(a.configPath, '~/.codex/config.toml');
      }
    }

    // 装了一家：只出这一家
    box.write('.codex/config.toml', '');
    const onlyCodex = await connect(box);
    assert.deepEqual(
      onlyCodex.agents.map((a) => a.agent),
      ['codex'],
      '装了哪家就只给哪家'
    );
  } finally {
    box.cleanup();
  }
});

test('connect: 跑完沙箱里一个文件都没被创建或修改（只读硬边界）', async () => {
  const box = sandbox();
  try {
    // 造一点真实形状：已装的两家 + 一份已有配置内容
    box.write('.claude.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    box.write('.codex/config.toml', 'model = "gpt-5"\n');

    const before = snapshotTree(box.dir);
    // 最坏情况：all:true 会把每一家的路径函数都求值一遍（含读 profiles 目录）
    const r = await box.run(() => {
      connectTargets();
      connectTargets({ all: true });
      connectTargets({ agent: 'codex' });
      return connectTargets({ all: true, agent: 'claude-code' });
    });
    const after = snapshotTree(box.dir);

    assert.ok(r.agents.length >= 1, '功能要真的跑过（不是提前 return 的空转）');

    // 新增的路径
    const added = [...after.keys()].filter((k) => !before.has(k));
    assert.deepEqual(added, [], `connect 不能创建任何文件：${added.join(', ')}`);

    // 消失的路径
    const removed = [...before.keys()].filter((k) => !after.has(k));
    assert.deepEqual(removed, [], `connect 不能删除任何文件：${removed.join(', ')}`);

    // 内容/时间变了
    const changed = [...before.entries()]
      .filter(([k, v]) => after.get(k) !== v)
      .map(([k]) => k);
    assert.deepEqual(changed, [], `connect 不能修改任何文件：${changed.join(', ')}`);

    // 已有配置的内容一个字都不能动
    assert.equal(
      fs.readFileSync(box.path('.claude.json'), 'utf8'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      '原有配置必须原封不动'
    );
    assert.equal(fs.readFileSync(box.path('.codex', 'config.toml'), 'utf8'), 'model = "gpt-5"\n');
  } finally {
    box.cleanup();
  }
});

test('connect: 每段片段的 command 是当前 node、args[0] 指向存在的 mcp.js', async () => {
  const box = sandbox();
  try {
    const r = await connect(box, { all: true });

    assert.equal(r.servers.name, SERVER_NAME);
    assert.equal(r.servers.command, process.execPath, 'command 必须是当前这个 node');
    assert.equal(r.servers.args[0], SERVER_PATH, 'args[0] 必须是本仓库的 mcp.js 绝对路径');
    assert.ok(fs.existsSync(SERVER_PATH), 'args[0] 指向的文件必须真的存在');
    assert.ok(path.isAbsolute(SERVER_PATH), '必须是绝对路径，否则别的 Agent 用不同 cwd 起不来');

    // 每一段片段都得带上同样的启动信息——片段是给人粘的，
    // 少一处就是"按你给的贴了，跑不起来"。
    for (const a of r.agents) {
      assert.ok(a.snippet, `${a.agent} 应该有片段`);
      assert.ok(a.snippet.includes(SERVER_NAME), `${a.agent}: 片段里要有注册名`);
      assert.ok(
        a.snippet.includes(process.execPath) ||
          a.snippet.includes(process.execPath.replace(/\\/g, '\\\\')),
        `${a.agent}: 片段里要有当前 node 路径`
      );
      assert.ok(
        a.snippet.includes(SERVER_PATH) || a.snippet.includes(SERVER_PATH.replace(/\\/g, '\\\\')),
        `${a.agent}: 片段里要有 mcp.js 路径`
      );
    }
  } finally {
    box.cleanup();
  }
});

test('connect: json-nested 的层级按各家真实形状生成，note 说明放哪', async () => {
  const box = sandbox();
  try {
    const r = await connect(box, { all: true });

    // ZCode：{ mcp: { servers: { name: ... } } }
    const zcode = targetFor(r, 'zcode');
    assert.equal(zcode.format, 'json-nested');
    const z = parseJsonSnippet(zcode.snippet);
    assert.ok(z.mcp && z.mcp.servers && z.mcp.servers[SERVER_NAME], 'ZCode 的层级是 mcp.servers');
    assert.match(zcode.note, /mcp\.servers/, 'note 要说明层级');

    // OpenCode：{ mcp: { name: { type: 'local', command: [...] } } }
    const oc = targetFor(r, 'opencode');
    assert.equal(oc.format, 'json-nested');
    const o = parseJsonSnippet(oc.snippet);
    assert.ok(o.mcp && o.mcp[SERVER_NAME], 'OpenCode 的层级是 mcp');
    assert.equal(o.mcp[SERVER_NAME].type, 'local', 'OpenCode 的 stdio 写 type: local');
    assert.deepEqual(o.mcp[SERVER_NAME].command, [process.execPath, SERVER_PATH], 'OpenCode 的 command 是数组');
    assert.match(oc.note, /mcp/, 'note 要说明层级');
  } finally {
    box.cleanup();
  }
});

test('connect: Claude Code 的两个位置里，主路径是最常用的那个，另一个作为备选', async () => {
  const box = sandbox();
  try {
    const r = await connect(box, { agent: 'claude-code' });
    const claude = r.agents[0];

    // 主路径必须是 ~/.claude.json：那是 Claude Code 自己的主配置。
    // 写进 .claude/settings.json 是另一回事（用户/项目设置），不能当主路径推荐。
    assert.equal(claude.configPath, '~/.claude.json');
    assert.deepEqual(claude.altPaths, ['~/.claude/settings.json'], '另一个位置要作为备选给出');
    assert.match(claude.note, /\.claude\/settings\.json/, 'note 要提到备选位置');
  } finally {
    box.cleanup();
  }
});

test('connect: 别的平台的约定路径不出现在"该往哪写"里', async () => {
  // userDataCandidates() 会连别的平台的约定一起返回（跨机拷贝备份时有用）。
  // 一个 Windows 用户的 OpenCode 备选里不该冒出 ~/Library/Application Support——
  // 那是 macOS 的位置，告诉他"也可以放这里"就是在制造一条会失败的建议。
  const box = sandbox();
  try {
    const r = await connect(box, { all: true });
    for (const a of r.agents) {
      for (const p of [a.configPath, ...a.altPaths]) {
        if (!p) continue;
        if (process.platform !== 'win32') {
          assert.ok(!/\/AppData\/(Roaming|Local)\//i.test(p), `${a.agent} 不该给 Windows 路径：${p}`);
        }
        if (process.platform !== 'darwin') {
          assert.ok(!/\/Library\/Application Support\//i.test(p), `${a.agent} 不该给 macOS 路径：${p}`);
        }
      }
    }

    // 主路径永远是第一个"讲得通"的候选
    const oc = targetFor(r, 'opencode');
    assert.equal(oc.configPath, '~/.config/opencode/opencode.json');
  } finally {
    box.cleanup();
  }
});

test('connect: note 不重复说同一件事', async () => {
  // Claude Code 的来源备注是「顶层 mcpServers」，而 format 层级那句已经说了
  // "放在文件顶层的 mcpServers 下"。两句都留着读起来像两个不同的要求，
  // 用户会去找区别——所以重复的那条要丢掉。
  const box = sandbox();
  try {
    const r = await connect(box, { all: true });
    const claude = targetFor(r, 'claude-code');
    const count = (s, needle) => s.split(needle).length - 1;
    assert.equal(count(claude.note, 'mcpServers'), 1, `mcpServers 只该提一次：${claude.note}`);
    assert.equal(count(claude.note, '顶层'), 1, `「顶层」只该提一次：${claude.note}`);

    // 有备选位置时，那条信息不能丢
    assert.match(claude.note, /\.claude\/settings\.json/);

    // 每家的 note 都不为空（格式各异的层级说明是必需信息）
    for (const a of r.agents) {
      assert.ok(a.note && a.note.length > 0, `${a.agent} 必须有 note 说明放哪`);
    }
  } finally {
    box.cleanup();
  }
});

test('connect: 排序把 Claude Code / Codex / Cursor 放前面', async () => {
  const box = sandbox();
  try {
    const r = await connect(box, { all: true });
    const ids = r.agents.map((a) => a.agent);
    assert.deepEqual(ids.slice(0, 3), ['claude-code', 'codex', 'cursor'], `前三家要固定，实际 ${ids.slice(0, 3)}`);

    // 其余按 display 排
    const rest = r.agents.slice(3);
    const displays = rest.map((a) => a.display);
    const sorted = [...displays].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(displays, sorted, '其余按显示名排序');
  } finally {
    box.cleanup();
  }
});

test('connect: agent 过滤只给一家，且不需要 all', async () => {
  const box = sandbox();
  try {
    // 没装也要能查——用户可能想先看看该往哪写
    const r = await connect(box, { agent: 'codex' });
    assert.equal(r.agents.length, 1);
    assert.equal(r.agents[0].agent, 'codex');
    assert.equal(r.agents[0].installed, false);
    assert.equal(r.agents[0].configPath, '~/.codex/config.toml');

    // 不认识的名字：空数组，不报错
    const none = await connect(box, { agent: 'no-such-agent' });
    assert.deepEqual(none.agents, []);
    assert.equal(none.servers.name, SERVER_NAME, 'servers 始终给');
  } finally {
    box.cleanup();
  }
});

test('connect: 路径表只有一张——目标和 mcp.js 的 SOURCES 投影一致', async () => {
  const box = sandbox();
  try {
    const fromMcp = await box.run(() => mcpConfigTargets());
    const fromConnect = await connect(box, { all: true });

    assert.ok(fromMcp.length >= 20, '投影要覆盖整张 SOURCES 表');

    // 每一条 SOURCES 记录的 agent 都要在 connect 结果里出现（按 agent 归并后）
    const agentsInTargets = new Set(fromMcp.map((t) => t.agent));
    const agentsInConnect = new Set(fromConnect.agents.map((a) => a.agent));
    assert.deepEqual([...agentsInConnect].sort(), [...agentsInTargets].sort(), '不能漏、也不能多');

    // 主路径取该 agent 的第一个候选，且与 SOURCES 求值结果一致
    for (const a of fromConnect.agents) {
      const first = fromMcp.find((t) => t.agent === a.agent && t.paths.length);
      if (!first) {
        assert.equal(a.configPath, null, `${a.agent} 没有候选路径时 configPath 是 null`);
        continue;
      }
      assert.equal(a.path, first.paths[0], `${a.agent} 的主路径必须来自 SOURCES，不能另抄一份`);
    }

    // 投影本身不读内容、不写：paths 是字符串数组
    for (const t of fromMcp) {
      assert.equal(typeof t.agent, 'string');
      assert.equal(typeof t.format, 'string');
      assert.ok(Array.isArray(t.paths));
      for (const p of t.paths) assert.equal(typeof p, 'string');
    }
  } finally {
    box.cleanup();
  }
});
