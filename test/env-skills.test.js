import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, withEnv } from './helpers.js';
import {
  scanSkills,
  groupByHash,
  parseFrontmatter,
  clearSkillCache,
} from '../src/env/skills.js';

/**
 * 环境层（技能）的契约。
 *
 * 这一层的身份用 **SKILL.md 的内容哈希**，不是名字——因为同一个技能在不同
 * Agent 里会被装成不同名字，同名也可能是两代不同实现。两个真实坑：
 *
 *   1. 符号链接：Qoder / Kiro 的技能目录是指向 `~/.agents/skills/<名>` 的
 *      链接，用 `Dirent.isDirectory()` 判断会**静默漏掉整批**（实测
 *      Qoder 漏 3 个、Kiro 漏 28 个，显示"0 个技能"而不报错）。
 *   2. 插件缓存的历史版本：升级后旧版本不删，`docx` 在实测有 8 份
 *      （0.1.0 → 0.2.1）。那不是"装了 8 个技能"。
 */

const skillMd = (name, body) => `---
name: ${name}
description: test skill ${name}
---

${body}
`;

/**
 * 技能根的环境变量覆盖。sandbox() 只清了会话扫描器的那些；这里补上
 * skills.js 新增的根，否则跑测试那台机器上的真实目录会漏进来。
 */
const CLEARED_SKILL_ENVS = {
  WORKBUDDY_CONFIG_DIR: null,
  PI_CODING_AGENT_DIR: null,
  PI_CONFIG_DIR: null,
  DSH_HOME: null,
  KIMI_CODE_HOME: null,
  MINIMAX_DATA_DIR: null,
  MAVIS_DATA_DIR: null,
  COPILOT_HOME: null,
  GROK_HOME: null,
  OMP_DATA_DIR: null,
};

/** 在隔离环境里跑，并清掉技能根的环境变量覆盖。 */
async function inBox(box, fn) {
  return box.run(() => withEnv(CLEARED_SKILL_ENVS, fn));
}

/** scanSkills() 返回 {installs, roots, errors}，这里统一取 installs。 */
async function installsIn(box, fn) {
  return inBox(box, () => {
    clearSkillCache();
    return fn(scanSkills().installs);
  });
}

test('skills: 相同内容在不同 Agent 下合成一个技能', async () => {
  const box = sandbox();
  try {
    const content = skillMd('alpha', '同一份实现');
    box.write('.claude/skills/alpha/SKILL.md', content);
    box.write('.codex/skills/alpha-copy/SKILL.md', content);

    await installsIn(box, (installs) => {
      const groups = groupByHash(installs);
      const hit = groups.find((g) => g.agents.includes('claude-code') && g.agents.includes('codex'));
      assert.ok(hit, '同一内容应合成一条');
      assert.equal(hit.installs, 2);
      assert.deepEqual(hit.agents.slice().sort(), ['claude-code', 'codex']);
      assert.deepEqual(hit.aliases, ['alpha-copy'], '另一个名字应记为别名');
    });
  } finally {
    box.cleanup();
  }
});

test('skills: 同名但内容不同是两条（两代实现）', async () => {
  const box = sandbox();
  try {
    box.write('.claude/skills/same/SKILL.md', skillMd('same', '第一代'));
    box.write('.qoder/skills/same/SKILL.md', skillMd('same', '第二代'));

    await installsIn(box, (installs) => {
      const groups = groupByHash(installs).filter((g) => g.name === 'same');
      assert.equal(groups.length, 2, '同名不同内容必须是两条，不能按名字合并');
      assert.notEqual(groups[0].hash, groups[1].hash);
    });
  } finally {
    box.cleanup();
  }
});

test('skills: 符号链接的技能目录必须跟随（曾经整批漏掉）', async () => {
  const box = sandbox();
  try {
    // 共享目录放真货，Agent 目录里放链接——这就是 Qoder / Kiro 的布局
    const real = box.mkdir('.agents/skills/linked');
    fs.writeFileSync(path.join(real, 'SKILL.md'), skillMd('linked', '通过链接安装'), 'utf8');

    const link = box.path('.claude/skills/linked');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 没权限建链接：由 macOS / Linux 的 CI 覆盖
    }

    await installsIn(box, (installs) => {
      const viaLink = installs.find((s) => s.name === 'linked' && s.agent === 'claude-code');
      assert.ok(viaLink, '链接目录里的技能必须被扫到（这正是当初静默漏掉的那批）');
      assert.equal(viaLink.viaSymlink, true, '要标出它是链接来的');
    });
  } finally {
    box.cleanup();
  }
});

test('skills: 插件缓存只保留最高版本（历史版本不算多个技能）', async () => {
  const box = sandbox();
  try {
    const mk = (ver) =>
      box.write(
        `.zcode/cli/plugins/cache/marketplace/plug/${ver}/skills/docx/SKILL.md`,
        skillMd('docx', `版本 ${ver}`)
      );
    mk('0.1.0');
    mk('0.2.1');
    mk('0.1.5');

    await installsIn(box, (installs) => {
      const docx = installs.filter((s) => s.name === 'docx');
      assert.equal(docx.length, 1, '同一个技能的多个版本只能算一处安装');
      assert.match(String(docx[0].path), /0\.2\.1/, '要保留版本最高的那份');
    });
  } finally {
    box.cleanup();
  }
});

test('skills: frontmatter 解析（带引号、缺字段都认）', () => {
  const fm = parseFrontmatter(`---
name: "quoted-name"
description: 'single quoted'
version: 1.2.3
unknown_field: should be ignored
---

正文`);
  assert.equal(fm.name, 'quoted-name');
  assert.equal(fm.description, 'single quoted');
  assert.equal(fm.version, '1.2.3');

  // 没有 frontmatter：不能抛错
  const none = parseFrontmatter('# 纯文本\n\n没有元数据');
  assert.ok(none && typeof none === 'object');
  assert.equal(none.name, undefined);
});

test('skills: 没有 SKILL.md 的目录不算技能', async () => {
  const box = sandbox();
  try {
    box.mkdir('.claude/skills/no-manifest');
    box.write('.claude/skills/no-manifest/README.md', '不是技能');

    await installsIn(box, (installs) => {
      assert.equal(installs.filter((s) => s.name === 'no-manifest').length, 0);
    });
  } finally {
    box.cleanup();
  }
});

test('skills: disable-model-invocation 标成手动技能，不算模型能力', async () => {
  const box = sandbox();
  try {
    box.write(
      '.claude/skills/manual-one/SKILL.md',
      `---
name: manual-one
description: 只能用户自己敲命令调起
disable-model-invocation: true
---
正文
`
    );
    box.write(
      '.claude/skills/auto-one/SKILL.md',
      `---
name: auto-one
description: 模型可以主动选
---
正文
`
    );
    const { skillSummary } = await import('../src/env/skills.js');
    const s = await inBox(box, () => skillSummary());
    assert.equal(s.skills, 2);
    assert.equal(s.manualOnly, 1);
    const manual = s.list.find((x) => x.name === 'manual-one');
    assert.equal(manual.manual, true);
    const auto = s.list.find((x) => x.name === 'auto-one');
    assert.equal(auto.manual, undefined);
  } finally {
    box.cleanup();
  }
});

test('skills: 同 SKILL.md 但脚本不同，是两份技能不是一份', async () => {
  const box = sandbox();
  try {
    const skill = (name) => `---
name: ${name}
description: 同名同描述
---
正文
`;
    box.write('.claude/skills/alpha/SKILL.md', skill('shared-name'));
    box.write('.claude/skills/alpha/run.sh', 'echo alpha');
    box.write('.claude/skills/beta/SKILL.md', skill('shared-name'));
    box.write('.claude/skills/beta/run.sh', 'echo beta');

    const { skillSummary } = await import('../src/env/skills.js');
    const s = await inBox(box, () => skillSummary());
    assert.equal(s.skills, 2, '脚本不同必须分成两份能力');
    assert.ok(s.list.every((x) => x.treeHash), '同 SKILL.md 的分组要带整树哈希');
  } finally {
    box.cleanup();
  }
});

test('skills: WorkBuddy 技能根——4 个真实技能，migration json 不算技能', async () => {
  const box = sandbox();
  try {
    // 本机实测形状：~/.workbuddy/skills 下 4 个技能目录 + 4 个 migration json
    const names = ['blocked-content-mirror-routing', 'ego-browser', 'footer-curtain-reveal', 'verify-before-fix'];
    for (const name of names) {
      box.write(`.workbuddy/skills/${name}/SKILL.md`, skillMd(name, 'WorkBuddy 技能'));
    }
    for (const json of [
      '.disable_to_model_invocation_migration.json',
      '.model_invocation_to_override_migration.json',
      '.user_invocable_only_to_off_migration.json',
      '_bm_skillid_migration.json',
    ]) {
      box.write(`.workbuddy/skills/${json}`, '{"version":1}');
    }

    await installsIn(box, (installs) => {
      const wb = installs.filter((s) => s.agent === 'workbuddy');
      assert.equal(wb.length, 4, '必须能看到 4 个真实技能');
      assert.deepEqual(wb.map((s) => s.name).sort(), names.slice().sort());
      assert.ok(!wb.some((s) => /migration/i.test(s.name)), 'migration json 不是技能目录');
    });
  } finally {
    box.cleanup();
  }
});

test('skills: WorkBuddy 的 .workbuddy-ai 变体也扫描', async () => {
  const box = sandbox();
  try {
    box.write('.workbuddy-ai/skills/ai-only/SKILL.md', skillMd('ai-only', 'WorkBuddy AI 变体'));

    await installsIn(box, (installs) => {
      const hit = installs.find((s) => s.agent === 'workbuddy' && s.name === 'ai-only');
      assert.ok(hit, '.workbuddy-ai/skills 下的技能必须算到 WorkBuddy');
    });
  } finally {
    box.cleanup();
  }
});

test('skills: 技能根优先环境变量（WorkBuddy / Pi / DSH / Kimi / Mcode / Copilot / GrokBuild）', async () => {
  const box = sandbox();
  try {
    const cases = [
      ['WORKBUDDY_CONFIG_DIR', 'custom-workbuddy', 'workbuddy', 'wb-env'],
      ['PI_CODING_AGENT_DIR', 'custom-pi', 'pi', 'pi-env'],
      ['DSH_HOME', 'custom-dsh', 'dsh', 'dsh-env'],
      ['KIMI_CODE_HOME', 'custom-kimi', 'kimi', 'kimi-env'],
      ['MINIMAX_DATA_DIR', 'custom-minimax', 'mcode', 'mcode-env'],
      ['COPILOT_HOME', 'custom-copilot', 'copilot', 'copilot-env'],
      ['GROK_HOME', 'custom-grok', 'grokbuild', 'grok-env'],
    ];
    const env = {};
    for (const [varName, dir, , skill] of cases) {
      env[varName] = box.path(dir);
      box.write(`${dir}/skills/${skill}/SKILL.md`, skillMd(skill, `环境变量覆盖 ${varName}`));
    }

    const installs = await inBox(box, () =>
      withEnv(env, () => {
        clearSkillCache();
        return scanSkills().installs;
      })
    );

    for (const [, , agent, skill] of cases) {
      const hit = installs.find((s) => s.agent === agent && s.name === skill);
      assert.ok(hit, `${agent} 应从 ${agent} 的环境变量目录读到技能`);
    }
  } finally {
    box.cleanup();
  }
});

test('skills: Pi 的 27 个 junction 全部算安装（指向 ~/.agents/skills）', async () => {
  const box = sandbox();
  try {
    const names = [];
    for (let i = 0; i < 27; i++) {
      const name = `pi-skill-${String(i).padStart(2, '0')}`;
      names.push(name);
      const real = box.mkdir(`.agents/skills/${name}`);
      fs.writeFileSync(path.join(real, 'SKILL.md'), skillMd(name, '通过 junction 安装'), 'utf8');

      const link = box.path(`.pi/agent/skills/${name}`);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try {
        fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return; // 没权限建链接：由 macOS / Linux 的 CI 覆盖
      }
    }

    await installsIn(box, (installs) => {
      const pi = installs.filter((s) => s.agent === 'pi');
      assert.equal(pi.length, 27, '27 个 junction 必须全部算安装');
      assert.deepEqual(pi.map((s) => s.name).sort(), names.slice().sort());
      assert.ok(pi.every((s) => s.viaSymlink), 'junction 要标成链接安装');
    });
  } finally {
    box.cleanup();
  }
});

test('skills: Gemini 是 ~/.gemini/skills，Antigravity 是 ~/.gemini/config/skills', async () => {
  const box = sandbox();
  try {
    box.write('.gemini/skills/gem-only/SKILL.md', skillMd('gem-only', 'Gemini CLI'));
    box.write('.gemini/config/skills/agy-only/SKILL.md', skillMd('agy-only', 'Antigravity'));

    await installsIn(box, (installs) => {
      const gem = installs.find((s) => s.name === 'gem-only');
      const agy = installs.find((s) => s.name === 'agy-only');
      assert.equal(gem && gem.agent, 'gemini');
      assert.equal(agy && agy.agent, 'antigravity');
    });
  } finally {
    box.cleanup();
  }
});

test('skills: SKILL.md 读失败（EACCES）要带 path/code/message 进 errors，不是消失', async () => {
  const box = sandbox();
  try {
    box.write('.claude/skills/good/SKILL.md', skillMd('good', '正常'));
    const badFile = box.write('.claude/skills/bad/SKILL.md', skillMd('bad', '读不到'));

    const { skillSummary } = await import('../src/env/skills.js');
    const s = await inBox(box, () => {
      clearSkillCache();
      const orig = fs.readFileSync;
      fs.readFileSync = function (p, ...args) {
        if (String(p) === badFile) {
          const err = new Error(`EACCES: permission denied, open '${p}'`);
          err.code = 'EACCES';
          throw err;
        }
        return orig.call(this, p, ...args);
      };
      try {
        return skillSummary();
      } finally {
        fs.readFileSync = orig;
      }
    });

    assert.equal(s.installs, 1, '读不到的那个不能假装存在');
    assert.ok(!s.list.some((x) => x.name === 'bad'));
    assert.equal(s.filesUnknown, 1, '读失败的文件要计入 filesUnknown');
    assert.equal(s.rootsUnknown, 0);
    const err = s.errors.find((e) => String(e.path) === badFile);
    assert.ok(err, '错误必须带 path，不能静默吞掉');
    assert.equal(err.code, 'EACCES');
    assert.match(err.message, /permission denied|EACCES/i, 'OS 原因要进 message');
    assert.equal(err.kind, 'file');
  } finally {
    box.cleanup();
  }
});

test('skills: 根目录 readdir 失败（EACCES）算 rootsUnknown，不是 0 个技能', async () => {
  const box = sandbox();
  try {
    box.write('.qoder/skills/hidden/SKILL.md', skillMd('hidden', '读不到'));
    const rootDir = box.path('.qoder/skills');

    const { skillSummary } = await import('../src/env/skills.js');
    const s = await inBox(box, () => {
      clearSkillCache();
      const orig = fs.readdirSync;
      fs.readdirSync = function (p, ...args) {
        if (String(p) === rootDir) {
          const err = new Error(`EACCES: permission denied, scandir '${p}'`);
          err.code = 'EACCES';
          throw err;
        }
        return orig.call(this, p, ...args);
      };
      try {
        return skillSummary();
      } finally {
        fs.readdirSync = orig;
      }
    });

    assert.equal(s.rootsUnknown, 1, '整家读不到要算 rootsUnknown');
    assert.equal(s.filesUnknown, 0);
    const err = s.errors.find((e) => String(e.path) === rootDir);
    assert.ok(err, '根级错误也要有身份');
    assert.equal(err.code, 'EACCES');
    assert.equal(err.kind, 'root');
    const entry = s.roots.find((r) => String(r.root) === rootDir);
    assert.ok(entry, 'unreadable 的根不能从摘要里消失');
    assert.equal(entry.status, 'unreadable');
  } finally {
    box.cleanup();
  }
});

test('skills: 根目录 stat 失败（EACCES）rootsUnknown + 错误身份', async () => {
  const box = sandbox();
  try {
    box.mkdir('.hermes/skills');
    const rootDir = box.path('.hermes/skills');

    const { skillSummary } = await import('../src/env/skills.js');
    const s = await inBox(box, () => {
      clearSkillCache();
      const orig = fs.statSync;
      fs.statSync = function (p, ...args) {
        if (String(p) === rootDir) {
          const err = new Error(`EACCES: permission denied, stat '${p}'`);
          err.code = 'EACCES';
          throw err;
        }
        return orig.call(this, p, ...args);
      };
      try {
        return skillSummary();
      } finally {
        fs.statSync = orig;
      }
    });

    assert.equal(s.rootsUnknown, 1);
    const err = s.errors.find((e) => String(e.path) === rootDir);
    assert.ok(err);
    assert.equal(err.code, 'EACCES');
    assert.equal(err.kind, 'root');
  } finally {
    box.cleanup();
  }
});

test('skills: 技能缓存原子写（tmp+fsync+rename，不留下临时文件）', async () => {
  const box = sandbox();
  try {
    box.write('.claude/skills/cache-me/SKILL.md', skillMd('cache-me', '缓存'));

    await inBox(box, () => {
      clearSkillCache();
      scanSkills();
    });

    const cacheDir = path.join(box.state, 'cache');
    const files = fs.readdirSync(cacheDir);
    assert.ok(files.includes('skills-v1.json'), '缓存文件应存在');
    assert.ok(!files.some((f) => /\.tmp-/.test(f)), '原子写不能留下临时文件');
    const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, 'skills-v1.json'), 'utf8'));
    assert.ok(
      Object.keys(parsed).some((k) => k.endsWith('SKILL.md')),
      '缓存内容必须是完整可解析的 JSON'
    );
  } finally {
    box.cleanup();
  }
});
