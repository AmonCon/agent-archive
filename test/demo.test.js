import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  materializeDemo,
  demoEnvPatch,
  demoEnv,
  runDemo,
  runDemoCommand,
  runDemoTour,
  DEMO_PROJECT,
  DEMO_TOUR,
} from '../src/demo.js';

/**
 * demo 的契约。
 *
 * demo 是这个产品唯一一处"不需要用户数据也能跑"的入口，所以它自己坏了
 * **不会有任何真实使用场景报警**——只有新用户第一次装完就看到一屏空白。
 * 这类 bug 靠人工发现，成本是"永远发现不了"。所以这里锁四条：
 *
 *   1. 样例能被**真实扫描器**读出来（不是"我们以为写了"，是"scanCached 读到了"）；
 *   2. 三家 Agent 真的轮流出现，换手和长期中断都有（否则 handoff/brief 页面是空的）；
 *   3. 样例文本里没有任何本机标识（否则 demo 会把开发者的机器名发到公开仓库）；
 *   4. 清理只删自己建的临时目录（这是整个模块唯一会删东西的地方）。
 *
 * ## 关于第 3 条为什么不写字面量
 *
 * 这个仓库有 `npm run privacy` 门禁，任何形如 `C:\Users\<名字>` 或真实机器名的
 * 字面量都会被拦下来（这正是它存在的意义）。所以这里**从运行时取本机标识**
 * 来做断言：`os.homedir()` / `os.userInfo().username` / `os.hostname()`。
 * 换一台机器跑，断言跟着换——比写死更严格，也不会让测试文件本身成为泄漏源。
 */

/* ------------------------------ 小工具 ------------------------------ */

/** 递归列出目录下所有文件。 */
function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 在 demo 的环境变量下跑一段同步代码，结束后还原。
 *
 * 与 `test/helpers.js` 的 `withEnv` 同一个取舍：**只改我们动过的那几个键**，
 * 不整体替换 `process.env`，否则会把 PATH 之类弄丢。
 *
 * 用 `demoEnvPatch()` 而不是在测试里再抄一遍变量名：抄一遍就迟早漂移，
 * 而漂移的表现是"测试通过、demo 其实读到了本机数据"。
 */
async function withDemoEnv(box, fn) {
  const patch = demoEnvPatch(box.home, box.state);
  const saved = new Map();
  try {
    for (const [k, v] of Object.entries(patch)) {
      saved.set(k, process.env[k]);
      if (v === null) delete process.env[k];
      else process.env[k] = String(v);
    }
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** tmpdir 里当前有哪些 demo 临时目录。 */
function demoTempDirs() {
  try {
    return fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith('aa-demo-'))
      .map((n) => path.join(os.tmpdir(), n));
  } catch {
    return [];
  }
}

/* ------------------------------ 1. 物化 ------------------------------ */

test('demo: 三家 Agent 的样例文件都按真实存储布局写出来了', () => {
  const box = materializeDemo();
  try {
    const files = walkFiles(box.home).map((f) => path.relative(box.home, f).replace(/\\/g, '/'));

    assert.ok(
      files.some((f) => /^\.claude\/projects\/E--demo-project\/[0-9a-f-]{36}\.jsonl$/.test(f)),
      `Claude Code 的样例位置不对：${files.join(', ')}`
    );
    assert.ok(
      files.some((f) => /^\.codex\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.+\.jsonl$/.test(f)),
      `Codex 的样例位置不对：${files.join(', ')}`
    );
    assert.ok(
      files.some((f) => /^\.workbuddy\/projects\/e-demo-project\/[0-9a-f-]{36}\.jsonl$/.test(f)),
      `WorkBuddy 的样例位置不对：${files.join(', ')}`
    );

    // 状态目录必须和家目录分开：demo 的扫描缓存要落进临时目录，
    // 否则每跑一次就往用户真实的 ~/.agent-archive 里塞一份假数据。
    assert.ok(box.state.startsWith(box.dir), 'state 要在临时目录里');
    assert.ok(!box.home.startsWith(box.state), 'home 与 state 不能互相包含');
  } finally {
    box.cleanup();
  }
});

test('demo: 样例是中文、可读的对话，不是占位符', () => {
  const box = materializeDemo();
  try {
    const all = walkFiles(box.home)
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    // 每一场会话的标题都来自第一句真人输入，必须是中文而不是注入模板
    assert.match(all, /窄屏/, '样例里应该讲窄屏这个具体问题');
    assert.match(all, /CHANGELOG/, '样例应该覆盖到写 CHANGELOG 这一步');
    assert.ok((all.match(/[\u4e00-\u9fa5]/g) || []).length > 200, '样例主体应该是中文');
    // 反面：不能出现测试资产的影子（那些是英文的格式边角料）
    assert.doesNotMatch(all, /lorem ipsum/i);
    assert.doesNotMatch(all, /TODO: fill me/i);
  } finally {
    box.cleanup();
  }
});

/* ------------------------------ 2. 扫得出来 ------------------------------ */

test('demo: scanCached 能读出 ≥3 场会话，全部归到 E:/demo-project，三家都在', async () => {
  const box = materializeDemo();
  try {
    await withDemoEnv(box, async () => {
      const { scanCached } = await import('../src/registry.js');
      // noCache：这个用例要看的是"文件本身能不能被解析"，
      // 而进程内 memo 可能带着上一个用例的结果。
      const { sessions } = scanCached({ noCache: true });

      assert.ok(sessions.length >= 3, `至少要 3 场会话，实际 ${sessions.length}`);
      for (const s of sessions) {
        assert.equal(s.project, DEMO_PROJECT, `${s.agent}/${s.id} 的项目应该是 ${DEMO_PROJECT}`);
        assert.ok(s.start && s.end, `${s.agent}/${s.id} 要有起止时间`);
        assert.ok(s.start <= s.end, '开始时间不能晚于结束时间');
        assert.doesNotMatch(String(s.title), /^\(.*\)$/, '标题不能是占位符');
      }

      const agents = new Set(sessions.map((s) => s.agent));
      for (const name of ['claude-code', 'codex', 'workbuddy']) {
        assert.ok(agents.has(name), `三家 Agent 都要有样例，缺 ${name}（实际 ${[...agents].join(',')}）`);
      }

      // 扫描本身不能报失败：样例是我们自己写的，解析不了就是 demo 的 bug
      const r = scanCached({ noCache: true });
      assert.equal(r.stats.failures, 0, `样例解析失败：${JSON.stringify(r.stats.problems)}`);
    });
  } finally {
    box.cleanup();
  }
});

test('demo: 项目清单里只有一个项目，会话数对得上', async () => {
  const box = materializeDemo();
  try {
    await withDemoEnv(box, async () => {
      const { listProjects } = await import('../src/query.js');
      const r = listProjects({ noCache: true });
      assert.equal(r.projects.length, 1, '样例只应该产出 E:/demo-project 一个项目');
      assert.equal(r.projects[0].display, DEMO_PROJECT);
      assert.ok(r.projects[0].count >= 3);
      assert.deepEqual(r.projects[0].agents, ['claude-code', 'codex', 'workbuddy']);
      assert.equal(r.unbound, null, '样例不该有"无项目归属"的会话');
    });
  } finally {
    box.cleanup();
  }
});

/* ------------------------------ 3. 换手与交接单 ------------------------------ */

test('demo: 换手 ≥2 次，且至少一次隔了一天以上（长期中断）', async () => {
  const box = materializeDemo();
  try {
    await withDemoEnv(box, async () => {
      const { projectHandoffs } = await import('../src/handoff.js');
      const h = projectHandoffs(DEMO_PROJECT, { noCache: true });

      assert.ok(h.sessions >= 4, `至少要 4 场会话，实际 ${h.sessions}`);
      assert.ok(h.handoffCount >= 3, `至少要 3 次换手，实际 ${h.handoffCount}`);
      assert.equal(h.agentCount, 3, '三家 Agent 都要参与接力');
      assert.equal(h.singleAgent, false);

      // handoff 页面最想展示的两样东西：正常接续 + 长期中断
      const stale = h.handoffs.filter((x) => x.stale);
      assert.ok(stale.length >= 1, '至少要一次"长期中断"，否则 handoff 的重点视图是空的');
      assert.ok(stale[0].gapMinutes > 24 * 60, `长期中断要超过一天，实际 ${stale[0].gapMinutes} 分钟`);

      const seq = h.handoffs.filter((x) => x.kind === 'sequential');
      assert.ok(seq.length >= 2, '至少两次正常接续');
      // 样例是精心排的时间，不该出现"上一段还没结束下一段就开始了"
      assert.equal(h.summary.overlap, 0, '样例里不该有并行重叠');
      assert.equal(h.summary.unknown, 0, '样例里每个换手都该算得出间隔');
    });
  } finally {
    box.cleanup();
  }
});

test('demo: 交接单有内容——动过的文件、留下的任务、最后一句用户话', async () => {
  const box = materializeDemo();
  try {
    await withDemoEnv(box, async () => {
      const { projectBrief, briefMarkdown } = await import('../src/brief.js');
      const b = await projectBrief(DEMO_PROJECT, { noCache: true });

      assert.equal(b.deterministic, true, '交接单必须标确定性产物');
      assert.equal(b.sessions, 6, `样例应该正好 6 场会话，实际 ${b.sessions}`);
      assert.equal(b.readErrors.length, 0, `正文不该读不出来：${JSON.stringify(b.readErrors)}`);

      assert.ok(b.lastRun, '最后一段工作要有内容');
      assert.equal(b.lastRun.agent, 'claude-code');
      assert.match(b.lastRun.lastUserText, /CI/, '最后一句用户话应该是"接进 CI"');

      const files = b.files.map((f) => f.path);
      assert.ok(files.some((p) => p.endsWith('CHANGELOG.md')), `要抽到 CHANGELOG.md，实际 ${files}`);
      assert.ok(files.some((p) => p.endsWith('ci.yml')), `要抽到 ci.yml，实际 ${files}`);
      assert.ok(b.files.every((f) => f.inProject), '样例里动过的文件都该在项目内');

      assert.ok(b.tasks.length >= 1, '要抽到 TodoWrite 留下的任务');
      assert.ok(
        b.tasks.some((t) => t.status === 'done'),
        '样例里的任务应该有已完成状态，否则看不出"进度"'
      );

      assert.ok(b.previous, '要能报出"更早的一次换手"');
      assert.equal(b.previous.from, 'codex');
      assert.equal(b.previous.to, 'claude-code');

      // 渲染出来的 Markdown 六个小节都在（网页复制按钮、CLI、MCP 共用这一份）
      const md = briefMarkdown(b);
      for (const head of ['## 一、', '## 二、', '## 三、', '## 四、', '## 五、', '## 六、']) {
        assert.ok(md.includes(head), `交接单缺小节 ${head}`);
      }
      assert.match(md, /^# 交接单 · E:\/demo-project/m);
    });
  } finally {
    box.cleanup();
  }
});

test('demo: 正文读得出真话（WorkBuddy 的注入上下文没被当成标题）', async () => {
  const box = materializeDemo();
  try {
    await withDemoEnv(box, async () => {
      const { scanCached } = await import('../src/registry.js');
      const { readSessionContent } = await import('../src/query.js');
      const { sessions } = scanCached({ noCache: true });
      const wb = sessions.find((s) => s.agent === 'workbuddy');
      assert.ok(wb, '要有 WorkBuddy 的样例');

      // 标题取的是 <user_query> 里那句，不是 system-reminder 的模板文本
      assert.doesNotMatch(String(wb.title), /system-reminder|user_info|OS:/);

      const messages = await readSessionContent(wb);
      assert.ok(messages.length > 0, 'WorkBuddy 的正文要读得出来');
      const firstUser = messages.find((m) => m.role === 'user');
      assert.ok(firstUser, '要有一条用户消息');
      const text = firstUser.parts.map((p) => p.text || '').join('');
      assert.match(text, /1024/, '用户说的应该是 1024 宽这件事');
      assert.doesNotMatch(text, /system-reminder/, '注入上下文要被剥掉');

      // 工具调用和结果都要配得上：配不上说明 demo 写错了字段（callId）
      const tools = messages.flatMap((m) => m.parts).filter((p) => p.kind === 'tool');
      assert.ok(tools.length >= 2, '样例里要有工具调用');
      assert.ok(
        tools.some((p) => p.output),
        '至少有一个工具调用配到了输出（配不上通常是 callId 写错）'
      );
    });
  } finally {
    box.cleanup();
  }
});

/* ------------------------------ 4. 脱敏 ------------------------------ */

test('demo: 样例文本里没有任何本机标识（用户名 / 机器名 / 真实家目录）', () => {
  const box = materializeDemo();
  try {
    // 从运行时取，不写字面量：换一台机器跑，断言跟着换。
    const home = os.homedir();
    const user = (() => {
      try {
        return os.userInfo().username;
      } catch {
        return '';
      }
    })();
    const host = os.hostname();
    const homeName = path.basename(home); // Windows 上是 "用户名.机器名"，两个都覆盖到

    const files = walkFiles(box.home);
    assert.ok(files.length >= 3, '应该写出了样例文件');

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const where = path.relative(box.home, file);

      assert.ok(!text.includes(home), `${where} 出现了真实家目录`);
      assert.ok(!text.includes(homeName), `${where} 出现了真实家目录名`);
      if (user) {
        // 用户名（大小写不敏感：Windows 上同一个名字有多种写法）
        assert.ok(
          !text.toLowerCase().includes(user.toLowerCase()),
          `${where} 出现了真实用户名`
        );
      }
      if (host) {
        assert.ok(!text.toLowerCase().includes(host.toLowerCase()), `${where} 出现了真实机器名`);
      }
      // 任何盘符下的 Users 目录写法都不许出现（含转义后的 JSON 形式）
      assert.doesNotMatch(text, /[A-Za-z]:[\\/]Users[\\/]/i, `${where} 出现了用户目录路径`);
      // 常见的"真实环境残留"
      assert.doesNotMatch(text, /AppData/i, `${where} 出现了 AppData`);
    }
  } finally {
    box.cleanup();
  }
});

test('demo: 样例项目路径是一眼可辨的示例，不是真实项目名', () => {
  assert.equal(DEMO_PROJECT, 'E:/demo-project');
  assert.match(DEMO_PROJECT, /demo/);
});

/* ------------------------------ 5. 清理 ------------------------------ */

test('demo: cleanup 只删自己建的临时目录，旁边的哨兵文件不动', () => {
  // 哨兵放在**同一个父目录**（系统临时目录）里，且名字故意和我们的前缀相似：
  // 如果 cleanup 的实现是"删掉父目录"或"按前缀匹配删掉一批"，它会跟着消失。
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-demo-sentinel-'));
  const sentinel = path.join(sentinelDir, 'do-not-delete.txt');
  fs.writeFileSync(sentinel, '哨兵：这个文件不该被 demo 的清理逻辑删掉\n', 'utf8');

  const box = materializeDemo();
  try {
    assert.ok(fs.existsSync(box.dir), '物化之后目录应该存在');
    assert.ok(fs.existsSync(box.home), '假家目录应该存在');

    const removed = box.cleanup();
    assert.equal(removed, true, '第一次清理应该真的删掉了东西');
    assert.equal(fs.existsSync(box.dir), false, 'demo 自己的临时目录应该被删掉');

    // 关键断言：哨兵还在
    assert.ok(fs.existsSync(sentinel), '哨兵文件被误删了——cleanup 删了不该删的东西');
    assert.ok(fs.existsSync(sentinelDir), '哨兵目录被误删了');
    assert.equal(fs.readFileSync(sentinel, 'utf8').includes('哨兵'), true);
  } finally {
    fs.rmSync(sentinelDir, { recursive: true, force: true });
    box.cleanup();
  }
});

test('demo: cleanup 是幂等的，第二次返回 false 且不抛错', () => {
  const box = materializeDemo();
  assert.equal(box.cleanup(), true);
  // 清理路径上抛错会掩盖真正的错误，所以第二次必须是安静的 false
  assert.equal(box.cleanup(), false);
  assert.equal(fs.existsSync(box.dir), false);
});

test('demo: runDemo 默认不留下临时目录', async () => {
  const before = new Set(demoTempDirs());
  let out = '';
  const code = await runDemo(['projects'], {
    onOutput: (t) => {
      out += t;
    },
  });
  const after = demoTempDirs().filter((d) => !before.has(d));

  assert.equal(code, 0, `demo 应该跑通，输出：${out}`);
  assert.deepEqual(after, [], `跑完不该留下临时目录：${after.join(', ')}`);
});

/* ------------------------------ 6. 子进程隔离 ------------------------------ */

test('demo: 子进程能跑通，输出里有样例项目和三家 Agent', async () => {
  let out = '';
  const code = await runDemo(['projects'], {
    onOutput: (t) => {
      out += t;
    },
  });
  assert.equal(code, 0);
  assert.match(out, /E:\/demo-project/);
  assert.match(out, /claude-code/);
  assert.match(out, /codex/);
  assert.match(out, /workbuddy/);
});

test('demo: 清空覆盖变量——CODEX_HOME 指向别处也漏不进 demo', async () => {
  // 毒丸：在**父进程**里把 CODEX_HOME 指向一份"真实"会话，项目名带标记。
  // 子进程的环境变量由 demoEnv() 重建，必须把 CODEX_HOME 删掉；
  // 漏删的话，demo 就会去读这份数据，标记会出现在输出里。
  //
  // 这条用例盯的是真实用户的处境：把数据放外置盘的人，CODEX_HOME 是设着的，
  // 而它**优先于**家目录默认值。只改家目录不删这个变量，demo 就会读到真实会话。
  const poison = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-demo-poison-'));
  const sessionFile = path.join(poison, 'sessions', '2026', '02', '02', 'rollout-poison.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      timestamp: '2026-02-02T09:00:00Z',
      type: 'session_meta',
      payload: { id: 'poison-1', session_id: 'poison-1', cwd: 'E:/POISON-PROJECT' },
    }) +
      '\n' +
      JSON.stringify({
        timestamp: '2026-02-02T09:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '这条不该出现在 demo 里' }],
        },
      }) +
      '\n',
    'utf8'
  );

  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = poison;
  let out = '';
  try {
    const code = await runDemo(['projects'], {
      onOutput: (t) => {
        out += t;
      },
    });
    assert.equal(code, 0, out);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    fs.rmSync(poison, { recursive: true, force: true });
  }

  assert.match(out, /E:\/demo-project/, '正常样例应该在');
  assert.doesNotMatch(out, /POISON-PROJECT/, 'CODEX_HOME 没清掉，demo 读到了本机数据');
});

test('demo: demoEnv 只打补丁，不整体替换环境变量', () => {
  const box = materializeDemo();
  try {
    const env = demoEnv(box.home, box.state);
    // PATH 之类必须留着：整体替换会让 Windows 上的 spawn 都不可靠。
    // 注意 Windows 上这个变量的实际键名常是 `Path`（不是全大写），
    // 所以按大小写不敏感去找，别假设键名。
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
    if (pathKey) assert.equal(env[pathKey], process.env[pathKey], `${pathKey} 不该被改`);

    assert.equal(env.USERPROFILE, box.home);
    assert.equal(env.HOME, box.home);
    assert.equal(env.AGENT_ARCHIVE_HOME, box.state);
    for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'DSH_HOME']) {
      assert.equal(Object.prototype.hasOwnProperty.call(env, k), false, `${k} 必须被删掉`);
    }
    // 平台默认根也要改，否则 Cursor/Kiro/Copilot 会去读真实机器
    assert.ok(env.APPDATA.startsWith(box.dir), 'APPDATA 要指到临时目录');
    assert.ok(env.LOCALAPPDATA.startsWith(box.dir), 'LOCALAPPDATA 要指到临时目录');
    assert.ok(env.XDG_DATA_HOME.startsWith(box.dir), 'XDG_DATA_HOME 要指到临时目录');
  } finally {
    box.cleanup();
  }
});

test('demo: demoEnv 的派生目录都落在临时目录里，不会跑到系统临时根上', () => {
  const box = materializeDemo();
  try {
    const patch = demoEnvPatch(box.home, box.state);
    // 所有派生路径必须在 box.dir 之下：写错父目录的话，appdata 会变成
    // 系统临时目录里一个跟别人共用名字的目录（污染 + 串数据）。
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
      assert.ok(patch[key].startsWith(box.dir), `${key} 不在 demo 临时目录里：${patch[key]}`);
    }

    // 形状不对的入参（home/state 不是兄弟）也不能让路径逃出 home
    const odd = demoEnvPatch(path.join(box.dir, 'only-home'), path.join(box.dir, 'only-home', 'st'));
    for (const key of ['APPDATA', 'XDG_DATA_HOME']) {
      assert.ok(
        odd[key].startsWith(path.join(box.dir, 'only-home')),
        `退化入参下 ${key} 应该收进 home，实际 ${odd[key]}`
      );
    }
  } finally {
    box.cleanup();
  }
});

test('demo: runDemoCommand 复用同一个假机器，第二条命令命中缓存', async () => {
  const box = materializeDemo();
  try {
    let first = '';
    const code1 = await runDemoCommand(box, ['projects'], {
      onOutput: (t) => {
        first += t;
      },
    });
    assert.equal(code1, 0, first);

    // 第二次跑：缓存文件已经落在 box.state 里了，说明两条命令共用一台"假机器"
    const cacheDir = path.join(box.state, 'cache');
    assert.ok(fs.existsSync(cacheDir), `扫描缓存应该落在临时 state 里，实际没找到 ${cacheDir}`);
    assert.ok(
      fs.readdirSync(cacheDir).some((n) => n.endsWith('.json')),
      '扫描缓存文件应该在临时 state 里'
    );

    let second = '';
    const code2 = await runDemoCommand(box, ['timeline', DEMO_PROJECT], {
      onOutput: (t) => {
        second += t;
      },
    });
    assert.equal(code2, 0, second);
    assert.match(second, /E:\/demo-project/);
  } finally {
    box.cleanup();
  }
});

test('demo: 巡览四步都跑通，输出覆盖时间线 / 换手 / 交接单', async () => {
  let out = '';
  const codes = await runDemoTour({
    onOutput: (t) => {
      out += t;
    },
  });

  assert.deepEqual(codes, [0, 0, 0, 0], `四步都该退出 0，实际 ${JSON.stringify(codes)}；输出：${out}`);
  assert.equal(DEMO_TOUR.length, 4);

  assert.match(out, /合成样例/, '开头要说清这是合成数据');
  assert.match(out, /E:\/demo-project/);
  assert.match(out, /换手概况/, 'handoff 那一步要有概况');
  assert.match(out, /长期中断/, 'handoff 那一步要能看到长期中断');
  assert.match(out, /# 交接单/, 'brief 那一步要有交接单');
  assert.match(out, /这一段动过的文件/);
});

test('demo: 巡览默认不留下临时目录', async () => {
  const before = new Set(demoTempDirs());
  const codes = await runDemoTour({ onOutput: () => {} });
  const after = demoTempDirs().filter((d) => !before.has(d));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  assert.deepEqual(after, [], `巡览跑完不该留下临时目录：${after.join(', ')}`);
});
