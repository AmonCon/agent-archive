import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
import { scanUnknownStores, anchorsFromSources } from '../src/unknown.js';

/**
 * 反向发现的契约。
 *
 * 这个功能是给"装了我们不认识的 Agent"的用户用的：他说不出该报什么，
 * 我们也不该沉默。所以它的正确性有两个方面——
 *   1. **该报的要报**：真的像会话存储的目录不能漏
 *   2. **不该报的别报**：已适配的应用、包管理器缓存、空目录不能混进来
 *
 * 第 2 点比第 1 点更重要：一个充满误报的列表，用户第二次就不会看了。
 */

test('unknown: 认出含 sessions 子目录的未知应用', () => {
  const box = sandbox();
  try {
    // 一个我们没适配的 Agent：~/NeedleAgent/sessions/*.jsonl
    box.write('NeedleAgent/sessions/a.jsonl', '{"x":1}\n');
    box.write('NeedleAgent/sessions/b.jsonl', '{"x":2}\n');

    const r = scanUnknownStores({ home: box.home, platform: 'linux', env: {}, knownPaths: new Set() });
    const hit = r.find((x) => x.name === 'NeedleAgent');
    assert.ok(hit, '含 sessions 子目录的未知目录必须被报出来');
    assert.match(hit.hint, /sessions 类子目录/);
  } finally {
    box.cleanup();
  }
});

test('unknown: 会话形态的文件本身不足以入选（避免包管理器缓存误报）', () => {
  const box = sandbox();
  try {
    // 本机真实误报案例：pnpm-cache 有 251 个 .jsonl，但跟 Agent 无关。
    // 所以入选条件要求"有 sessions 类子目录"或"目录名像会话存储"。
    box.write('.cache-tool/blobs/a.jsonl', '{}\n');
    box.write('.cache-tool/blobs/b.jsonl', '{}\n');

    const r = scanUnknownStores({ home: box.home, platform: 'linux', env: {}, knownPaths: new Set() });
    assert.equal(r.find((x) => x.name === '.cache-tool'), undefined, '光有 .jsonl 不该入选');
  } finally {
    box.cleanup();
  }
});

test('unknown: 目录名像会话存储时，即使没有 sessions 子目录也报', () => {
  const box = sandbox();
  try {
    // 例：~/codearts-agent 这种直接以 agent 命名、内部只有 vscdb 的布局
    box.write('.someagent/history.db', 'x');
    const r = scanUnknownStores({ home: box.home, platform: 'linux', env: {}, knownPaths: new Set() });
    assert.ok(r.find((x) => x.name === '.someagent'), '名字含 agent 且有库文件，应入选');
  } finally {
    box.cleanup();
  }
});

test('unknown: 空目录不报（只有骨架没有数据）', () => {
  const box = sandbox();
  try {
    box.mkdir('EmptyAgent/sessions');
    const r = scanUnknownStores({ home: box.home, platform: 'linux', env: {}, knownPaths: new Set() });
    assert.equal(r.find((x) => x.name === 'EmptyAgent'), undefined);
  } finally {
    box.cleanup();
  }
});

test('unknown: 已知路径下的目录不报（已适配的应用不该出现）', () => {
  const box = sandbox();
  try {
    box.write('.knownagent/sessions/a.jsonl', '{}\n');
    const known = new Set([box.path('.knownagent')]);
    const r = scanUnknownStores({ home: box.home, platform: 'linux', env: {}, knownPaths: known });
    assert.equal(r.find((x) => x.name === '.knownagent'), undefined);
  } finally {
    box.cleanup();
  }
});

test('unknown: 排除项生效（本工具自己的状态目录不能自报）', () => {
  const box = sandbox();
  try {
    box.write('.agent-archive/index/x.sqlite', 'x');
    const r = scanUnknownStores({
      home: box.home,
      platform: 'linux',
      env: {},
      knownPaths: new Set(),
      exclude: new Set([box.path('.agent-archive')]),
    });
    assert.equal(r.find((x) => x.name === '.agent-archive'), undefined);
  } finally {
    box.cleanup();
  }
});

test('unknown: 应用数据根按平台走（macOS Application Support / Windows AppData）', () => {
  const box = sandbox();
  try {
    // macOS：应用数据在 ~/Library/Application Support/<App>
    box.write('Library/Application Support/NeedleMac/sessions/a.jsonl', '{}\n');
    const darwin = scanUnknownStores({
      home: box.home,
      platform: 'darwin',
      env: {},
      knownPaths: new Set(),
    });
    assert.ok(
      darwin.find((x) => x.path.includes('Library/Application Support/NeedleMac')),
      'macOS 的 Application Support 必须被扫到'
    );

    // Windows：应用数据在 %APPDATA%/<App>
    const appdata = box.path('Roaming');
    box.write('Roaming/NeedleWin/sessions/a.jsonl', '{}\n');
    const win = scanUnknownStores({
      home: box.home,
      platform: 'win32',
      env: { APPDATA: appdata, LOCALAPPDATA: box.path('Local') },
      knownPaths: new Set(),
    });
    assert.ok(
      win.find((x) => x.path.includes('NeedleWin')),
      'Windows 的 APPDATA 必须被扫到'
    );
  } finally {
    box.cleanup();
  }
});

test('unknown: anchorsFromSources 从已发现文件推出应用锚点', () => {
  const box = sandbox();
  try {
    // 锚点推导只看"已存在的扫描根"，所以 fixture 要真的建出来——
    // 这也顺带验证了"扫描根不存在时会安全地什么都不返回"。
    box.mkdir('.codex/sessions/2026');
    box.mkdir('Library/Application Support/Cursor/User');
    box.mkdir('Desktop');

    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    const file = box.path('.codex', 'sessions', '2026', 'a.jsonl');

    // 点目录：锚点是点目录本身
    const a1 = anchorsFromSources([file], { home: box.home, platform: 'linux', env: {} });
    assert.ok(
      [...a1].some((p) => norm(p) === norm(box.path('.codex'))),
      '点目录应成为锚点'
    );

    // 应用数据根（macOS）：锚点是第一段
    const macFile = box.path('Library', 'Application Support', 'Cursor', 'User', 'x.vscdb');
    const a2 = anchorsFromSources([macFile], { home: box.home, platform: 'darwin', env: {} });
    assert.ok(
      [...a2].some((p) => norm(p) === norm(box.path('Library', 'Application Support', 'Cursor'))),
      'Application Support 下应按应用名下锚'
    );

    // 家目录里的普通用户目录不该成为锚点
    const deskFile = box.path('Desktop', 'foo', 'a.jsonl');
    const a3 = anchorsFromSources([deskFile], { home: box.home, platform: 'linux', env: {} });
    assert.equal(
      [...a3].some((p) => norm(p) === norm(box.path('Desktop'))),
      false,
      'Desktop 里放什么都不算应用'
    );
  } finally {
    box.cleanup();
  }
});
