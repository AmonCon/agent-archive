import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, withEnv } from './helpers.js';
import { scanCommands, commandSummary } from '../src/env/commands.js';

/**
 * 环境层（斜杠命令）的契约。
 *
 * 这一层有两条硬约束，用例重点锁它们：
 *
 *   1. **prompt 正文绝不出模块** —— 命令正文可能几十 KB 且含私有内容，
 *      输出里只允许有 promptLength 和 hash。测试用哨兵字符串直接扫 JSON。
 *   2. **同名同内容合并、同名不同内容冲突** —— 与技能层同一套身份模型：
 *      按内容 hash 认，不按目录认；同名不同内容必须是两条且标 conflict，
 *      不能静默挑一个。
 *
 * 另外锁三态：没有安装的目录是 missing（正常），不是错误也不是 0；
 * 坏 TOML / 非法文件名 / 超大文件要进 errors，不能静默消失。
 */

/** sandbox 只清了部分环境变量；这里把 commands 会读的其余覆盖变量也清掉。 */
const CLEAN_ENV = {
  OPENCODE_CONFIG_DIR: null,
  PI_CONFIG_DIR: null,
  pi_config_dir: null,
  PI_CODING_AGENT_DIR: null,
  GEMINI_CONFIG_DIR: null,
  gemini_config_dir: null,
  GEMINI_CLI_HOME: null,
  QWEN_HOME: null,
  QWEN_CONFIG_DIR: null,
  FACTORY_HOME_OVERRIDE: null,
};

async function scan(box, extra = {}) {
  return box.run(() => withEnv({ ...CLEAN_ENV, ...extra }, () => scanCommands()));
}

async function summary(box, extra = {}) {
  return box.run(() => withEnv({ ...CLEAN_ENV, ...extra }, () => commandSummary()));
}

const md = (description, prompt) => `---\ndescription: ${description}\n---\n${prompt}\n`;

test('commands: 六家格式都能读出来，prompt 正文不进结果', async () => {
  const box = sandbox();
  try {
    box.write('.claude/commands/review.md', md('Review the current diff', 'SECRET_CLAUDE_PROMPT $ARGUMENTS'));
    box.write('.config/opencode/commands/explain.md', md('Explain code', 'SECRET_OPENCODE_PROMPT'));
    // OpenCode 还会读 command/（config.ts 两个目录都 glob）
    box.write('.config/opencode/command/legacy-dir.md', md('Old folder', 'SECRET_OPENCODE_LEGACY'));
    box.write('.pi/agent/prompts/summarize.md', md('Summarize text', 'SECRET_PI_PROMPT'));
    box.write(
      '.gemini/commands/translate.toml',
      `description = "Translate text"\nprompt = """\nSECRET_GEMINI_PROMPT {{args}}\n"""\n`
    );
    box.write('.qwen/commands/test.md', md('Run tests', 'SECRET_QWEN_MD_PROMPT'));
    box.write('.qwen/commands/refactor.toml', `description = 'Refactor code'\nprompt = 'SECRET_QWEN_TOML_PROMPT {{args}}'\n`);
    box.write('.factory/commands/build.md', md('Build project', 'SECRET_DROID_PROMPT'));

    const r = await scan(box);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));

    const byName = new Map(r.items.map((i) => [i.name, i]));
    for (const name of ['review', 'explain', 'legacy-dir', 'summarize', 'translate', 'test', 'refactor', 'build']) {
      assert.ok(byName.has(name), `缺少命令 ${name}`);
    }

    assert.deepEqual(byName.get('review').agents, ['claude-code']);
    assert.deepEqual(byName.get('explain').agents, ['opencode']);
    assert.deepEqual(byName.get('legacy-dir').agents, ['opencode'], 'command/ 目录也要读');
    assert.deepEqual(byName.get('summarize').agents, ['pi']);
    assert.deepEqual(byName.get('translate').agents, ['gemini']);
    assert.deepEqual(byName.get('test').agents, ['qwen']);
    assert.deepEqual(byName.get('refactor').agents, ['qwen'], 'Qwen 的 .toml 也要读');
    assert.deepEqual(byName.get('build').agents, ['droid']);

    // promptLength 是 UTF-8 字节数；正文哨兵绝不能出现在任何输出里
    assert.equal(byName.get('review').promptLength, Buffer.byteLength('SECRET_CLAUDE_PROMPT $ARGUMENTS', 'utf8'));
    const raw = JSON.stringify(r);
    for (const secret of [
      'SECRET_CLAUDE_PROMPT',
      'SECRET_OPENCODE_PROMPT',
      'SECRET_OPENCODE_LEGACY',
      'SECRET_PI_PROMPT',
      'SECRET_GEMINI_PROMPT',
      'SECRET_QWEN_MD_PROMPT',
      'SECRET_QWEN_TOML_PROMPT',
      'SECRET_DROID_PROMPT',
    ]) {
      assert.ok(!raw.includes(secret), `prompt 正文泄漏了：${secret}`);
    }

    // 读到的根是 ok；同一个 Agent 的其它候选根（不存在）是 missing，不算错误
    for (const dir of [
      '.claude/commands',
      '.config/opencode/commands',
      '.config/opencode/command',
      '.pi/agent/prompts',
      '.gemini/commands',
      '.qwen/commands',
      '.factory/commands',
    ]) {
      const root = r.roots.find((x) => x.path === path.join(box.home, ...dir.split('/')));
      assert.ok(root, `缺少根 ${dir}`);
      assert.equal(root.status, 'ok', `${dir} 应该是 ok`);
    }
  } finally {
    box.cleanup();
  }
});

test('commands: 同名同内容跨 Agent 合并成一条', async () => {
  const box = sandbox();
  try {
    const same = md('同一个命令', 'Do exactly the same thing');
    box.write('.claude/commands/same.md', same);
    box.write('.config/opencode/commands/same.md', same);
    box.write('.pi/agent/prompts/same.md', same);
    box.write('.qwen/commands/same.md', same);

    const r = await scan(box);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    const hits = r.items.filter((i) => i.name === 'same');
    assert.equal(hits.length, 1, '同名同内容必须合并成一条');
    assert.deepEqual(hits[0].agents, ['claude-code', 'opencode', 'pi', 'qwen']);
    assert.equal(hits[0].sources.length, 4);
    assert.equal(hits[0].conflict, false);
    assert.equal(hits[0].hash.length, 16);
    assert.equal(new Set(hits[0].sources.map((s) => s.hash)).size, 1, '各来源的命令 hash 应一致');
  } finally {
    box.cleanup();
  }
});

test('commands: 同名不同内容是两条且都标 conflict', async () => {
  const box = sandbox();
  try {
    box.write('.claude/commands/deploy.md', md('Deploy', 'Deploy to prod'));
    box.write('.factory/commands/deploy.md', md('Deploy', 'Deploy to staging'));

    const r = await scan(box);
    const hits = r.items.filter((i) => i.name === 'deploy');
    assert.equal(hits.length, 2, '同名不同内容必须各一条，不能合并');
    assert.ok(hits.every((h) => h.conflict === true), '两条都要标 conflict');
    assert.notEqual(hits[0].hash, hits[1].hash);
    assert.deepEqual(hits.map((h) => h.agents[0]).sort(), ['claude-code', 'droid']);

    const s = await summary(box);
    assert.equal(s.commands, 2);
    assert.equal(s.conflicts, 2, 'conflict 按条目数算');
    assert.equal(s.conflictNames, 1, '但重名只有一个');
  } finally {
    box.cleanup();
  }
});

test('commands: 非法文件名进 errors，不生成条目', async () => {
  const box = sandbox();
  try {
    box.write('.claude/commands/Bad-Name.md', md('bad', 'x'));
    box.write('.claude/commands/UPPER.md', md('bad', 'x'));
    box.write('.claude/commands/-leading.md', md('bad', 'x'));
    box.write(`.claude/commands/${'a'.repeat(65)}.md`, md('bad', 'x'));
    box.write('.claude/commands/ok_1.md', md('good', 'x'));

    const r = await scan(box);
    const bad = r.errors.filter((e) => e.code === 'invalid-name');
    assert.equal(bad.length, 4, JSON.stringify(r.errors));
    assert.equal(r.items.filter((i) => i.name === 'ok_1').length, 1, '合法名字不能被误伤');
    assert.equal(r.items.length, 1);
  } finally {
    box.cleanup();
  }
});

test('commands: 超过 1 MB 的文件进 errors，不读正文', async () => {
  const box = sandbox();
  try {
    box.write('.claude/commands/huge.md', 'x'.repeat(1024 * 1024 + 1));

    const r = await scan(box);
    const err = r.errors.find((e) => e.code === 'too-large');
    assert.ok(err, JSON.stringify(r.errors));
    assert.match(err.message, /1 MB/);
    assert.equal(r.items.find((i) => i.name === 'huge'), undefined);
  } finally {
    box.cleanup();
  }
});

test('commands: 坏 TOML 是 unparsable，不是空命令', async () => {
  const box = sandbox();
  try {
    box.write('.gemini/commands/broken.toml', 'description = "broken\nprompt = "never closed\n');
    box.write('.gemini/commands/fine.toml', 'description = "fine"\nprompt = "ok prompt"\n');

    const r = await scan(box);
    const err = r.errors.find((e) => e.code === 'unparsable' && e.path.endsWith('broken.toml'));
    assert.ok(err, JSON.stringify(r.errors));
    assert.equal(r.items.find((i) => i.name === 'broken'), undefined, '坏文件不能变成空命令');
    assert.equal(r.items.find((i) => i.name === 'fine').description, 'fine');
  } finally {
    box.cleanup();
  }
});

test('commands: Codex 的 ~/.codex/prompts 只列出（legacy），不解析', async () => {
  const box = sandbox();
  try {
    box.write('.codex/prompts/old-review.md', md('Old review', 'SECRET_CODEX_LEGACY_PROMPT'));

    const r = await scan(box);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    const item = r.items.find((i) => i.name === 'old-review');
    assert.ok(item, 'Codex 的旧 prompt 要列出来');
    assert.equal(item.legacy, true);
    assert.equal(item.hash, null);
    assert.equal(item.promptLength, null, 'legacy 不解析：未知不是 0');
    assert.deepEqual(item.agents, ['codex']);
    assert.ok(!JSON.stringify(r).includes('SECRET_CODEX_LEGACY_PROMPT'), 'legacy 也不能返回正文');

    const root = r.roots.find((x) => x.agent === 'codex' && x.path.endsWith(path.join('.codex', 'prompts')));
    assert.equal(root.status, 'ok');
  } finally {
    box.cleanup();
  }
});

test('commands: 本机没有的目录是 missing（正常），不是错误', async () => {
  const box = sandbox();
  try {
    const r = await scan(box);
    assert.equal(r.errors.length, 0, '空机器上不应有任何错误');
    assert.ok(r.items.length === 0);
    assert.ok(r.roots.length >= 8, `应列出所有候选根，实得 ${r.roots.length}`);
    assert.ok(r.roots.every((x) => x.status === 'missing'), JSON.stringify(r.roots));

    const s = await summary(box);
    assert.equal(s.rootsUnknown, 0, 'missing 不算 unknown');
    assert.ok(s.rootsMissing >= 8);
    assert.equal(s.commands, 0);
  } finally {
    box.cleanup();
  }
});

test('commands: description 折叠空白并按 rune 截断到 1000', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude/commands/folded.md',
      `---\ndescription: >\n  first line\n  second line\n---\nprompt body\n`
    );
    box.write('.claude/commands/long.md', `---\ndescription: ${'x'.repeat(1100)}\n---\nprompt body\n`);

    const r = await scan(box);
    const folded = r.items.find((i) => i.name === 'folded');
    assert.equal(folded.description, 'first line second line');

    const long = r.items.find((i) => i.name === 'long');
    assert.equal([...long.description].length, 1000, 'description 必须截到 1000 rune');
    assert.equal(long.descLength, 1000);
    assert.ok(long.description.endsWith('…'));
  } finally {
    box.cleanup();
  }
});

test('commands: prompt 首尾空白归一，hash 只看内容', async () => {
  const box = sandbox();
  try {
    // 同一内容：一个结尾多空行、一个 CRLF —— 归一后必须合并
    box.write('.claude/commands/normalized.md', '---\ndescription: same\n---\nhello\n\n\n');
    box.write('.pi/agent/prompts/normalized.md', '---\r\ndescription: same\r\n---\r\nhello\r\n');

    const r = await scan(box);
    const hits = r.items.filter((i) => i.name === 'normalized');
    assert.equal(hits.length, 1, '首尾空白不同不应算两个命令');
    assert.equal(hits[0].agents.length, 2);
    assert.equal(hits[0].promptLength, Buffer.byteLength('hello', 'utf8'));
  } finally {
    box.cleanup();
  }
});

test('commands: 环境变量优先于默认位置', async () => {
  const box = sandbox();
  try {
    const alt = box.mkdir('alt-claude');
    fs.mkdirSync(path.join(alt, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(alt, 'commands', 'from-env.md'), md('From env', 'env prompt'), 'utf8');

    const r = await scan(box, { CLAUDE_CONFIG_DIR: alt });
    const item = r.items.find((i) => i.name === 'from-env');
    assert.ok(item, 'CLAUDE_CONFIG_DIR 指向的目录必须被读到');
    const root = r.roots.find((x) => x.agent === 'claude-code' && x.path === path.join(alt, 'commands'));
    assert.ok(root);
    assert.equal(root.status, 'ok');
  } finally {
    box.cleanup();
  }
});

test('commands: commandSummary 给出总数/文件数/按 Agent 计数', async () => {
  const box = sandbox();
  try {
    const same = md('Shared', 'Shared prompt');
    box.write('.claude/commands/shared.md', same);
    box.write('.pi/agent/prompts/shared.md', same);
    box.write('.gemini/commands/only-gemini.toml', 'description = "Only"\nprompt = "Gemini prompt"\n');
    box.write('.codex/prompts/legacy-one.md', md('Legacy', 'legacy'));

    const s = await summary(box);
    assert.equal(s.commands, 3, 'shared 合并后 1 + gemini 1 + codex legacy 1');
    assert.equal(s.files, 4);
    assert.equal(s.shared, 1);
    assert.equal(s.conflicts, 0);
    assert.equal(s.legacy, 1);
    assert.equal(s.byAgent['claude-code'], 1);
    assert.equal(s.byAgent.pi, 1);
    assert.equal(s.byAgent.gemini, 1);
    assert.equal(s.byAgent.codex, 1);
    assert.equal(s.rootsUnknown, 0);
    assert.deepEqual(s.agents, ['claude-code', 'pi', 'gemini', 'codex']);
  } finally {
    box.cleanup();
  }
});
