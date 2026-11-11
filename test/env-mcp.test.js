import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { scanMcp, fingerprintOf, serviceKeyOf, installFormOf, describeTransport } from '../src/env/mcp.js';

/**
 * 环境层（MCP）的契约。
 *
 * 这一层此前零测试，而它有两处"手写解析器"（TOML / YAML）——别人家的配置
 * 写法千奇百怪，这是最可能在别人机器上静默出错的地方。所以用例的重点是
 * **畸形输入**和**身份归并**，不是复述解析逻辑。
 */

/** 在假家目录里跑一次扫描。 */
async function scan(box) {
  return box.run(() => scanMcp());
}

test('mcp: Codex TOML 的多行 args 必须完整读出来', async () => {
  const box = sandbox();
  try {
    box.write(
      '.codex/config.toml',
      `model = "gpt-5"

[mcp_servers.supabase]
command = "npx"
args = [
  "-y",
  "@acme/mcp-server-beta@latest",
  "--read-only",
]

[mcp_servers.supabase.env]
SUPABASE_ACCESS_TOKEN = "sbp_secret_value"
SOME_OTHER = "x"
`
    );

    const r = await scan(box);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.registrations.length, 1);

    const reg = r.registrations[0];
    assert.equal(reg.agent, 'codex');
    assert.equal(reg.command, 'npx');
    assert.deepEqual(reg.args, ['-y', '@acme/mcp-server-beta@latest', '--read-only']);
    // 只留键名，值一律不出现
    assert.deepEqual(reg.envKeys, ['SOME_OTHER', 'SUPABASE_ACCESS_TOKEN']);
    assert.ok(!JSON.stringify(reg).includes('sbp_secret_value'), '凭证值绝不能进结果');
  } finally {
    box.cleanup();
  }
});

test('mcp: Hermes YAML 的块状 args 列表（曾经读成空）', async () => {
  const box = sandbox();
  try {
    // 这是本轮补测试时发现的真实缺陷：只支持内联 args，块状列表读成空，
    // 于是所有 npx 服务指纹退化成 "command: npx"，被合并成同一个服务。
    box.write(
      '.hermes/config.yaml',
      `model: something
mcp_servers:
  github:
    command: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-github"
    env:
      GITHUB_TOKEN: ghp_secret
`
    );

    const r = await scan(box);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    const reg = r.registrations.find((x) => x.name === 'github');
    assert.ok(reg, 'YAML 里的服务要读出来');
    assert.equal(reg.command, 'npx');
    assert.deepEqual(reg.args, ['-y', '@modelcontextprotocol/server-github'], '块状列表必须读出来');
    assert.deepEqual(reg.envKeys, ['GITHUB_TOKEN']);
    assert.ok(!JSON.stringify(reg).includes('ghp_secret'), '凭证值绝不能进结果');
  } finally {
    box.cleanup();
  }
});

test('mcp: 内联 args 与块状列表等价', async () => {
  const box = sandbox();
  try {
    box.write(
      '.hermes/config.yaml',
      `mcp_servers:
  inline:
    command: npx
    args: ["-y", "pkg-a"]
  block:
    command: npx
    args:
      - "-y"
      - "pkg-a"
`
    );
    const r = await scan(box);
    const a = r.registrations.find((x) => x.name === 'inline');
    const b = r.registrations.find((x) => x.name === 'block');
    assert.deepEqual(a.args, b.args, '两种写法要得到同样的 args');
    assert.equal(a.service, b.service, '同一个包 → 同一个服务身份');
  } finally {
    box.cleanup();
  }
});

test('mcp: 同一服务在 npx 与本地安装下身份相同、形态不同', async () => {
  // 这是 README 里那个"我到底配了几份"的核心：按启动指纹认，不按名字认。
  const npx = describeTransport({ command: 'npx', args: ['-y', '@scope/srv@latest'] });
  const local = describeTransport({
    command: 'node',
    args: ['C:\\Users\\me\\proj\\node_modules\\@scope\\srv\\dist\\index.js'],
  });

  assert.equal(serviceKeyOf(fingerprintOf(npx)), serviceKeyOf(fingerprintOf(local)), '同一服务应共享 service');
  assert.notEqual(fingerprintOf(npx), fingerprintOf(local), '安装形态不同，指纹必须不同');
  assert.notEqual(installFormOf(fingerprintOf(npx)), installFormOf(fingerprintOf(local)));
});

test('mcp: 不同包不会被合并（指纹退化的后果）', async () => {
  const a = describeTransport({ command: 'npx', args: ['-y', '@a/one@latest'] });
  const b = describeTransport({ command: 'npx', args: ['-y', '@b/two@latest'] });
  assert.notEqual(serviceKeyOf(fingerprintOf(a)), serviceKeyOf(fingerprintOf(b)));
});

test('mcp: shell 包装层要剥掉（Windows 上极常见）', async () => {
  // 注意剥包装发生在**指纹**阶段（fingerprintOf），describeTransport 保留原样。
  const t = describeTransport({ command: 'cmd', args: ['/c', 'npx', '-y', '@scope/srv'] });
  assert.equal(t.command, 'cmd', '传输描述保留原样');
  assert.equal(
    fingerprintOf(t),
    'pkg:@scope/srv#npx',
    'cmd /c 要被剥掉，否则身份退化成 cmd——所有 cmd 包装的服务会被合并'
  );
});

test('mcp: Claude 的 JSON 配置能读，未知字段不影响', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude.json',
      JSON.stringify({
        mcpServers: {
          fs: { command: 'node', args: ['server.js'], env: { TOKEN: 'secret' } },
          remote: { type: 'http', url: 'https://example.com/mcp' },
        },
        projects: { '/some/path': { allowedTools: [] } },
      })
    );
    const r = await scan(box);
    const fs = r.registrations.find((x) => x.name === 'fs');
    const remote = r.registrations.find((x) => x.name === 'remote');
    assert.equal(fs.transport, 'stdio');
    assert.deepEqual(fs.envKeys, ['TOKEN']);
    assert.equal(remote.transport, 'remote', 'http/sse/remote 统一归成 remote');
    assert.equal(remote.url, 'https://example.com/mcp');
  } finally {
    box.cleanup();
  }
});

test('mcp: OpenCode 的 command 是数组', async () => {
  const box = sandbox();
  try {
    box.write(
      '.config/opencode/opencode.json',
      JSON.stringify({ mcp: { srv: { type: 'local', command: ['node', 'srv.js'], enabled: true } } })
    );
    const r = await scan(box);
    const reg = r.registrations.find((x) => x.name === 'srv');
    assert.ok(reg, 'command 是数组时也要认出来');
    assert.deepEqual(reg.args, ['srv.js']);
  } finally {
    box.cleanup();
  }
});

test('mcp: 某一家配置坏了不影响其他家', async () => {
  const box = sandbox();
  try {
    box.write('.claude.json', '{ this is not json');
    box.write(
      '.cursor/mcp.json',
      JSON.stringify({ mcpServers: { ok: { command: 'node', args: ['a.js'] } } })
    );

    const r = await scan(box);
    // 坏文件要如实记进 errors，而不是静默跳过
    assert.ok(r.errors.some((e) => e.agent === 'claude-code'), '坏 JSON 要有 error 记录');
    // 好文件照常解析
    assert.ok(r.registrations.some((x) => x.name === 'ok'), '其他家的配置不能被连累');
  } finally {
    box.cleanup();
  }
});

test('mcp: 一个配置都没有时返回空，不报错', async () => {
  const box = sandbox();
  try {
    const r = await scan(box);
    assert.deepEqual(r.registrations, []);
    assert.deepEqual(r.errors, []);
  } finally {
    box.cleanup();
  }
});

test('mcp: DSH 的 MCP 在 profile patch 里，不是 mcpServers', async () => {
  const box = sandbox();
  try {
    // 这是真实形状：同一个文件里还装着一堆 UI 插件，只有 name 是
    // @deepseek-ai/dsh-mcp-client 的条目才是 MCP server。
    box.write(
      'DeepSeekHarness/profiles/desktop/cordis.patch.yml',
      `- id: ui-context-menu
  config:
    resolutionTimeoutMs: 3000
- insert:
    - id: magpie-mcp-magpie-image
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "magpie-image"
        transport: "stdio"
        command: "C:\\Program Files\\magpie\\magpie.exe"
        args: [ "mcp", "image" ]
    - id: dsh-context
      name: dsh-context
`
    );

    const r = await scan(box);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.registrations.length, 1);
    const reg = r.registrations[0];
    assert.equal(reg.agent, 'dsh');
    assert.equal(reg.name, 'magpie-image');
    assert.deepEqual(reg.args, ['mcp', 'image']);
    assert.equal(reg.transport, 'stdio');
  } finally {
    box.cleanup();
  }
});

test('mcp: 缺 command/url 的条目算"配坏了"，不静默跳过', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude/settings.json',
      JSON.stringify({
        mcpServers: {
          broken: { type: 'stdio', args: ['x'] },
          ok: { command: 'node', args: ['server.js'] },
        },
      })
    );

    const r = await scan(box);
    assert.equal(r.registrations.length, 1, '坏条目不能算成服务');
    assert.equal(r.invalid.length, 1);
    assert.match(r.invalid[0].problem, /缺少 command/);
    assert.equal(r.files.find((f) => f.agent === 'claude-code').invalid, 1);
  } finally {
    box.cleanup();
  }
});

test('mcp: stdio 命令不在 PATH 上会被标出来（静态检查，不执行）', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude/settings.json',
      JSON.stringify({
        mcpServers: {
          ghost: { command: 'definitely-not-a-real-command-xyz', args: [] },
        },
      })
    );
    const r = await scan(box);
    assert.equal(r.registrations.length, 1);
    assert.equal(r.registrations[0].commandFound, false);
  } finally {
    box.cleanup();
  }
});

test('mcp: 被客户端停用的条目仍列出，但不算可用能力', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude.json',
      JSON.stringify({
        mcpServers: {
          offByList: { command: 'node', args: ['a.js'] },
          offByField: { command: 'node', args: ['b.js'], enabled: false },
          live: { command: 'node', args: ['c.js'] },
        },
        disabledMcpServers: ['offByList'],
      })
    );
    const r = await scan(box);
    assert.equal(r.registrations.length, 3, '停用的也要列出来');
    assert.equal(r.registrations.filter((x) => x.enabled === false).length, 2);
    const { mcpSummary } = await import('../src/env/mcp.js');
    const s = await box.run(() => mcpSummary());
    assert.equal(s.disabled, 2);
    assert.equal(s.list.filter((x) => x.disabled).length, 2, '两个停用条目各自成一个服务');
    assert.equal(s.list.filter((x) => !x.disabled).length, 1, 'live 是唯一可用的');
  } finally {
    box.cleanup();
  }
});
