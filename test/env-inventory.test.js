import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { fullInventory, clearInventoryCache, AGENT_PRESENCE, DISPLAY } from '../src/env/inventory.js';
import { scanners } from '../src/registry.js';

/**
 * 能力快照（per-agent capabilities）的契约。
 *
 * 这里锁的不是"数对不对"，而是**状态词**：provided / empty / none / partial。
 * 一个 Agent 的 MCP 文件读坏了，能力面必须显示 partial，而不是 0。
 */

test('inventory: 会话层支持的每家 Agent 都要有 presence 和显示名', () => {
  // 「名字只有一张表」：registry 认得 21 家，能力面不能再漏掉其中任何一家。
  // 这是 cc-switch ToolSpec 的教训——两侧各维护一份清单，漂移是必然的。
  const declared = new Set(AGENT_PRESENCE.map((a) => a.agent));
  for (const s of scanners) {
    if (!s.name) continue;
    assert.ok(declared.has(s.name), `扫描器 ${s.name} 没有在 AGENT_PRESENCE 里声明`);
    assert.ok(DISPLAY[s.name], `扫描器 ${s.name} 没有显示名`);
  }
});

test('inventory: WorkBuddy 有会话数据时出现在能力面', async () => {
  const box = sandbox();
  try {
    box.write('.workbuddy/projects/p/s.jsonl', '{}\n');
    const inv = await box.run(() => {
      clearInventoryCache();
      return fullInventory({ fresh: true });
    });
    const wb = inv.agents.find((a) => a.agent === 'workbuddy');
    assert.ok(wb, 'WorkBuddy 有 projects 目录就应出现在能力面');
    assert.equal(wb.level, 'data');
  } finally {
    box.cleanup();
  }
});

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
