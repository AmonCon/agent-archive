import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { fullInventory, clearInventoryCache } from '../src/env/inventory.js';

/**
 * 能力快照（per-agent capabilities）的契约。
 *
 * 这里锁的不是"数对不对"，而是**状态词**：provided / empty / none / partial。
 * 一个 Agent 的 MCP 文件读坏了，能力面必须显示 partial，而不是 0。
 */

test('inventory: 每个 Agent 的能力带状态，坏了是 partial 不是 0', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude.json',
      JSON.stringify({
        mcpServers: { live: { command: 'node', args: ['server.js'] } },
      })
    );
    box.write(
      '.claude/skills/one/SKILL.md',
      `---
name: one
description: 一个技能
---
正文
`
    );
    // Qoder 配置文件存在但 JSON 坏了：能力面必须是 partial，不是"没有"
    box.write('.qoder/settings.json', '{ broken json');

    const inv = await box.run(() => {
      clearInventoryCache();
      return fullInventory({ fresh: true });
    });

    const claude = inv.agents.find((a) => a.agent === 'claude-code');
    assert.ok(claude, 'claude-code 应该是 present');
    assert.equal(claude.capabilities.mcp.state, 'provided');
    assert.equal(claude.capabilities.mcp.count, 1);
    assert.equal(claude.capabilities.skills.state, 'provided');
    assert.equal(claude.capabilities.status, 'ok');

    const qoder = inv.agents.find((a) => a.agent === 'qoder');
    assert.ok(qoder, 'qoder 配置存在就应该是 present');
    assert.equal(qoder.capabilities.mcp.state, 'partial', '解析失败是未知，不是零');
    assert.equal(qoder.capabilities.status, 'partial');
    assert.ok(inv.summary.agentsPartial >= 1);
  } finally {
    box.cleanup();
  }
});
