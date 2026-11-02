import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, dispatch } from '../src/mcp.js';

/**
 * MCP 工具面是「别的 Agent 来读档案馆」的唯一入口，所以它的声明必须能被证伪。
 *
 * 这里锁三样东西：
 *   1. 工具集合 = 下面这张手写期望表。加一个工具就该有人在这里加一行，
 *      而不是让它悄悄出现在 `tools/list` 里。
 *   2. 每个工具都带 title / description / inputSchema / annotations——
 *      模型只能靠这些决定该调哪个、传什么，缺一样它就只能猜。
 *   3. **只读声明不会静默变质。** `tools/list` 里那句 readOnlyHint 是
 *      一刀切写给全部工具的（对，因为这 12 个确实都只读）。将来有人加一个
 *      会写盘的工具，这句话就变成了假声明——客户端可能据此自动放行一个写操作。
 *      第三个用例就是那道闸：mcp.js 里一旦出现写盘/子进程 API，测试先红，
 *      逼着改的人把注解变成按工具声明，而不是让 blanket 继续撒谎。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 手写期望表：工具名 → 语义档位。改动这里才是「有意变更加工具」。 */
const EXPECTED = {
  list_projects: 'read',
  project_timeline: 'read',
  search_sessions: 'read',
  read_session: 'read',
  project_handoffs: 'read',
  read_digest: 'read',
  read_session_summary: 'read',
  session_stats: 'read',
  export_timeline: 'read',
  inventory: 'read',
  model_calls: 'read',
  token_usage: 'read',
};

/** 真正的「只读」在代码层的判据：出现任何一个，说明有工具可能写东西了。 */
const WRITE_APIS = [
  'writeFileSync',
  'writeFile(',
  'appendFileSync',
  'appendFile(',
  'mkdirSync',
  'rmSync',
  'unlinkSync',
  'renameSync',
  'execFileSync',
  'execSync',
  'spawnSync',
  "child_process'",
];

test('契约：工具面与手写期望表一致', () => {
  const actual = TOOLS.map((t) => t.name).sort();
  const expected = Object.keys(EXPECTED).sort();
  assert.deepEqual(
    actual,
    expected,
    '工具集合变了：新增/删除工具时请同步 test/mcp-annotations.test.js 的 EXPECTED 表'
  );
});

test('契约：tools/list 给每个工具带齐模型需要的四样', async () => {
  const res = await dispatch({ method: 'tools/list', params: {} });
  assert.ok(Array.isArray(res.tools), 'tools/list 必须返回 tools 数组');
  assert.equal(res.tools.length, TOOLS.length);

  for (const tool of res.tools) {
    const where = `工具 ${tool.name}`;
    assert.ok(tool.title && tool.title.length > 0, `${where} 缺 title，模型在列表里分不清它是什么`);
    // description 是模型唯一能读到的「什么时候该用它」，短到一句话以下就等于没写
    assert.equal(typeof tool.description, 'string', `${where} 缺 description`);
    assert.ok(tool.description.length >= 40, `${where} 的 description 太短（${tool.description.length} 字），说不清何时该用`);
    assert.equal(tool.inputSchema?.type, 'object', `${where} 的 inputSchema 必须是 object`);
    assert.ok(tool.annotations, `${where} 缺 annotations`);
  }
});

test('契约：只读声明与代码一致，不会静默变质', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'mcp.js'), 'utf8');
  const writes = WRITE_APIS.filter((api) => src.includes(api));

  assert.deepEqual(
    writes,
    [],
    `src/mcp.js 里出现了写盘/子进程 API（${writes.join(', ')}），` +
      '但 tools/list 仍给所有工具声明 readOnlyHint: true。' +
      '请改成按工具声明注解，并把 EXPECTED 表里对应工具的档位改成 write'
  );

  // 声明也确实存在，而不是「没有写操作所以不声明」
  assert.match(
    src,
    /annotations:\s*\{[^}]*readOnlyHint:\s*true[^}]*\}/,
    'tools/list 必须显式声明 annotations，让客户端知道这些都是只读的本地读取'
  );
});