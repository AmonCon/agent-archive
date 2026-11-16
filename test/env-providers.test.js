import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { scanProviders, channelKeyOf, sanitizeUrl, groupByChannel } from '../src/env/providers.js';

/**
 * 渠道层的契约。
 *
 * 重点不是"把配置读出来"，而是三件事：
 *   1. **同一 base_url 的多家配置算一个渠道**（跨 Agent 归一）
 *   2. **凭证值绝不出模块**（只报形态与变量名）
 *   3. **读不到 ≠ 没有**（解析失败要计数，不能变成"0 个渠道"）
 */

async function scan(box) {
  return box.run(() => scanProviders());
}

test('providers: 三家配同一个中转站，归并成一个渠道', async () => {
  const box = sandbox();
  try {
    const base = 'https://relay.example.net/v1';
    box.write(
      '.claude/settings.json',
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_AUTH_TOKEN: 'sk-should-never-appear',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5',
        },
      })
    );
    box.write(
      '.qoder/settings.json',
      JSON.stringify({
        model: { name: 'relay/gpt-6' },
        providers: {
          relay: {
            baseUrl: base,
            apiKey: 'qoder-secret-value',
            displayName: 'relay',
            protocol: 'openai',
            models: ['gpt-6', 'gpt-6-mini'],
          },
        },
      })
    );
    box.write(
      '.hermes/config.yaml',
      `providers:
  relay:
    name: relay
    base_url: ${base}
    api_key: hermes-secret-value
    models:
      gpt-6: {}
`
    );

    const r = await scan(box);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.channels.length, 1, '同一个 base_url 必须归并成一个渠道');
    const c = r.channels[0];
    assert.equal(c.host, 'relay.example.net');
    assert.deepEqual(c.agents.sort(), ['claude-code', 'hermes', 'qoder']);
    assert.equal(c.registrations.length, 3);
    assert.ok(!JSON.stringify(r).includes('sk-should-never-appear'), '凭证值绝不能进结果');
    assert.ok(!JSON.stringify(r).includes('qoder-secret-value'), '凭证值绝不能进结果');
    assert.ok(!JSON.stringify(r).includes('hermes-secret-value'), '凭证值绝不能进结果');
    // 只报形态和环境变量名
    assert.ok(c.auth.includes('inline'));
    assert.deepEqual(c.apiKeyEnvs, ['ANTHROPIC_AUTH_TOKEN']);
  } finally {
    box.cleanup();
  }
});

test('providers: URL 里的 query token 会被剥掉，不跟着 baseUrl 公开', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude/settings.json',
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://relay.example.net/v1?key=super-secret' },
      })
    );
    const r = await scan(box);
    assert.equal(r.channels.length, 1);
    assert.equal(r.channels[0].baseUrl, 'https://relay.example.net/v1');
    assert.ok(!JSON.stringify(r).includes('super-secret'));
  } finally {
    box.cleanup();
  }
});

test('providers: Codex 的 [model_providers.*] 能读，env_key 只留名字', async () => {
  const box = sandbox();
  try {
    box.write(
      '.codex/config.toml',
      `model = "gpt-6"
model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example.net/v1"
env_key = "RELAY_API_KEY"
wire_api = "responses"
`
    );
    const r = await scan(box);
    assert.equal(r.errors.length, 0);
    assert.equal(r.channels.length, 1);
    const c = r.channels[0];
    assert.equal(c.display, 'Relay');
    assert.deepEqual(c.models, ['gpt-6']);
    assert.deepEqual(c.apiKeyEnvs, ['RELAY_API_KEY']);
    assert.deepEqual(c.defaults, ['codex']);
  } finally {
    box.cleanup();
  }
});

test('providers: DSH 的 providers 段缩进在根下，也能读', async () => {
  const box = sandbox();
  try {
    // 真实 DSH settings.yaml：providers 不是顶层，而是缩进在根配置下
    box.write(
      'DeepSeekHarness/settings.yaml',
      `llm-pi-ai:
  providers:
    Magpie:
      displayName: Magpie
      apiKeyEnv: MAGPIE_GATEWAY_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:3425/v1
      models:
        - name: auto/glm-5.3
          contextWindow: 200000
        - name: auto/kimi-k3
          contextWindow: 128000
`
    );
    const r = await scan(box);
    assert.equal(r.errors.length, 0);
    assert.equal(r.channels.length, 1);
    const c = r.channels[0];
    assert.equal(c.display, 'Magpie');
    assert.equal(c.local, true);
    assert.deepEqual(c.models.sort(), ['auto/glm-5.3', 'auto/kimi-k3'], '不能把 contextWindow 当成模型名');
    assert.deepEqual(c.apiKeyEnvs, ['MAGPIE_GATEWAY_KEY']);
  } finally {
    box.cleanup();
  }
});

test('providers: 配置解析失败算"未知"，不算"没有渠道"', async () => {
  const box = sandbox();
  try {
    box.write('.qoder/settings.json', '{ this is not json');
    const r = await scan(box);
    assert.equal(r.channels.length, 0);
    assert.equal(r.files.filter((f) => f.status === 'unparsable').length, 1);
  } finally {
    box.cleanup();
  }
});

test('providers: 本地渠道按 host 全等判断，localhost.example.com 不算本机', () => {
  // channel 是 scanProviders 里算好的渠道身份；这里直接给，只测折叠逻辑。
  const channels = groupByChannel([
    { agent: 'a', name: 'local', channel: 'c1', baseUrl: 'http://localhost:3425/v1' },
    { agent: 'b', name: 'lookalike', channel: 'c2', baseUrl: 'http://localhost.example.com/v1' },
    { agent: 'c', name: 'lookalike2', channel: 'c3', baseUrl: 'http://127.0.0.1.evil.com/v1' },
  ]);
  const byName = Object.fromEntries(channels.map((c) => [c.display, c]));
  assert.equal(byName.local.local, true);
  assert.equal(byName.lookalike.local, false, 'localhost.example.com 不是本机');
  assert.equal(byName.lookalike2.local, false, '127.0.0.1.evil.com 不是本机');
});

test('providers: 渠道身份函数本身', () => {
  assert.equal(channelKeyOf('https://A.example.net/v1/'), 'https://a.example.net/v1');
  assert.equal(sanitizeUrl('https://user:p@ss@a.example.net/v1?token=x'), 'https://a.example.net/v1');
  assert.equal(channelKeyOf(null), 'unknown');
});
