import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
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
 *      链接，用 `Dirent.isDirectory()` 判断会**静默漏掉整批**（本机实测
 *      Qoder 漏 3 个、Kiro 漏 28 个，显示"0 个技能"而不报错）。
 *   2. 插件缓存的历史版本：升级后旧版本不删，`docx` 在本机有 8 份
 *      （0.1.0 → 0.2.1）。那不是"装了 8 个技能"。
 */

const skillMd = (name, body) => `---
name: ${name}
description: test skill ${name}
---

${body}
`;

/** scanSkills() 返回 {installs, roots, errors}，这里统一取 installs。 */
async function installsIn(box, fn) {
  return box.run(() => {
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
