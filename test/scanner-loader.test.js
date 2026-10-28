import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.js';
import {
  registerUserScanners,
  validateScanner,
  listScanners,
  userScannerDir,
  scannerTemplate,
} from '../src/scanner-loader.js';
import { scanners } from '../src/registry.js';

/**
 * 用户扫描器的契约。
 *
 * 这一层是"这个工具能不能被别人扩展"的分界线：支持一家新 Agent 不该需要
 * 改我们的代码、提 PR、等发版。所以测试重点有两块——
 *   1. 合格的扫描器真的能加载并产出会话
 *   2. **一个坏文件不能拖垮整次扫描**（这是开放扩展必须付的代价：
 *      别人的代码跑在我们的进程里，至少要保证隔离在文件级别）
 */

const modelUrl = pathToFileURL(path.join(process.cwd(), 'src', 'model.js')).href;

/** 造一个满足契约的最小扫描器源码。 */
function scannerSource(name, { withReadMessages = false } = {}) {
  return `import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeSession } from ${JSON.stringify(modelUrl)};

export const name = ${JSON.stringify(name)};

export function discover() {
  const dir = path.join(os.homedir(), '.${name}', 'sessions');
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return es.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
}

export function parse(file) {
  let first;
  try { first = JSON.parse(fs.readFileSync(file, 'utf8').split('\\n')[0]); } catch { return null; }
  if (!first || !first.id) return null;
  return makeSession({
    agent: name,
    id: first.id,
    project: first.cwd || null,
    title: first.title || null,
    start: first.start || null,
    end: first.end || null,
    source: file,
  });
}
${
  withReadMessages
    ? `
export function readMessages() {
  return [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: null, meta: null }];
}
`
    : ''
}`;
}

/** 装一个用户扫描器目录，跑完恢复 scanners 数组。 */
async function withUserScanners(box, files, fn) {
  const dir = box.mkdir('scanners');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  const before = scanners.length;
  try {
    const r = await registerUserScanners(dir);
    return await fn(r);
  } finally {
    // 清掉这次加的，免得污染其它用例
    scanners.splice(before, scanners.length - before);
  }
}

test('scanner: 合格的用户扫描器被加载并能产出会话', async () => {
  const box = sandbox();
  try {
    box.write('.needle/sessions/a.jsonl', JSON.stringify({ id: 'n1', cwd: 'E:/proj', title: '第三方会话' }) + '\n');

    // 必须在沙盒环境里跑：用户扫描器读 os.homedir()，不隔离就会去扫真实家目录
    await box.run(async () => {
      await withUserScanners(box, { 'needle.js': scannerSource('needle') }, async (r) => {
        assert.deepEqual(r.loaded, ['needle']);
        assert.deepEqual(r.failed, []);

        const mod = scanners.find((s) => s.name === 'needle');
        assert.ok(mod, '应注册进 scanners');

        const files = mod.discover();
        assert.equal(files.length, 1);
        const s = mod.parse(files[0]);
        assert.equal(s.id, 'n1');
        assert.equal(s.agent, 'needle');
        assert.equal(s.project, 'E:/proj');
      });
    });
  } finally {
    box.cleanup();
  }
});

test('scanner: 缺 discover 的文件被拒绝，且说明原因', async () => {
  const box = sandbox();
  try {
    const bad = `export const name = 'badone';\nexport function parse() { return null; }\n`;
    await withUserScanners(box, { 'bad.js': bad }, async (r) => {
      assert.deepEqual(r.loaded, []);
      assert.equal(r.failed.length, 1);
      assert.match(r.failed[0].error, /discover/);
    });
  } finally {
    box.cleanup();
  }
});

test('scanner: 与内置重名的被拒绝（否则分不清哪份在跑）', async () => {
  const box = sandbox();
  try {
    const dup = scannerSource('codex');
    await withUserScanners(box, { 'codex.js': dup }, async (r) => {
      assert.deepEqual(r.loaded, []);
      assert.equal(r.failed.length, 1);
      assert.match(r.failed[0].error, /重名/);
    });
  } finally {
    box.cleanup();
  }
});

test('scanner: 语法错误的文件不影响同目录其它文件', async () => {
  const box = sandbox();
  try {
    box.write('.good/sessions/a.jsonl', JSON.stringify({ id: 'g1', cwd: 'E:/p' }) + '\n');
    await withUserScanners(
      box,
      {
        'broken.js': 'export const name = ; // 语法错误\n',
        'good.js': scannerSource('good'),
      },
      async (r) => {
        assert.deepEqual(r.loaded, ['good'], '好的那个要照常加载');
        assert.equal(r.failed.length, 1);
        assert.match(r.failed[0].file, /broken\.js/);
      }
    );
  } finally {
    box.cleanup();
  }
});

test('scanner: validateScanner 覆盖各种契约缺口', () => {
  const taken = new Set(['codex']);
  const cases = [
    [{}, /name/],
    [{ name: 'x' }, /discover/],
    [{ name: 'x', discover() {} }, /parse/],
    [{ name: 'codex', discover() {}, parse() {} }, /重名/],
    [{ name: 'x', discover: 'no', parse() {} }, /discover/],
    [{ name: 'x', discover() {}, parse() {}, readMessages: 5 }, /readMessages/],
  ];
  for (const [mod, re] of cases) {
    const r = validateScanner(mod, taken);
    assert.equal(r.ok, false, JSON.stringify(mod));
    assert.match(r.errors.join(' '), re);
  }

  const ok = validateScanner({ name: 'x', discover() {}, parse() {} }, taken);
  assert.equal(ok.ok, true);
});

test('scanner: listScanners 区分内置与用户', async () => {
  const box = sandbox();
  try {
    await withUserScanners(box, { 'needle.js': scannerSource('needle', { withReadMessages: true }) }, async () => {
      const all = listScanners();
      const builtin = all.find((s) => s.name === 'codex');
      const user = all.find((s) => s.name === 'needle');
      assert.equal(builtin.source, 'builtin');
      assert.equal(user.source, 'user');
      assert.equal(user.file, 'needle.js');
      assert.equal(user.canReadBody, true);
    });
  } finally {
    box.cleanup();
  }
});

test('scanner: 目录不存在时静默返回（没装用户扫描器是正常状态）', async () => {
  const r = await registerUserScanners(path.join(userScannerDir(), '__nope__'));
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.failed, []);
});

test('scanner: 生成的骨架本身满足契约', async () => {
  // 骨架要能直接跑通，否则"照抄模板"的人第一步就卡住
  const box = sandbox();
  try {
    const file = box.write('scanners/tpl.js', scannerTemplate('tpl'));
    const mod = await import(pathToFileURL(file).href);
    const r = validateScanner(mod, new Set());
    assert.equal(r.ok, true, r.errors.join('；'));
  } finally {
    box.cleanup();
  }
});

test('scanner: check 子命令不把文件自己算成重名', async () => {
  // 这个 bug 真出现过：CLI 启动时已经把用户扫描器加载进 scanners，
  // 于是 check 拿全量名单比对，把自己判成"与已有扫描器重名"。
  const box = sandbox();
  try {
    const dir = box.mkdir('state/scanners');
    const file = path.join(dir, 'solo.js');
    fs.writeFileSync(file, scannerTemplate('solo'), 'utf8');

    const env = {
      ...process.env,
      USERPROFILE: box.home,
      HOME: box.home,
      AGENT_ARCHIVE_HOME: box.path('state'),
    };
    const { execFileSync } = await import('node:child_process');
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, ['--no-warnings', 'src/cli.js', 'scanner', 'check', file], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
      });
    } catch (e) {
      code = e.status || 1;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    assert.equal(code, 0, `check 应该通过，实际输出：${out}`);
    assert.match(out, /契约合格/);
  } finally {
    box.cleanup();
  }
});
