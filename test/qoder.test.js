import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

/**
 * Qoder 扫描器的格式契约。
 *
 * 这里锁的是**在真实存储上验证过的坑**，不是"代码当前怎么写"。每条对应
 * 一种会静默少数据或把项目/标题弄错的形状：
 *
 *   1. 两套存储并存：旧格式 `cache/projects/<项目>/conversation-history/<id>/<id>.jsonl`
 *      没有时间戳和 cwd；新格式 `projects/<工作区>/<uuid>.jsonl` 是现在的主存储
 *      （实机 291 场 vs 旧格式 19 场）。只读旧格式会漏掉九成以上。
 *   2. 国际版 `.qoder` 和中国版 `.qoder-cn` 是两套独立安装，各有一份
 *      （实机 7 场 vs 12 场）。只读一个会漏一半。
 *   3. 工作区目录下还有别的 jsonl（配置、导出）。新格式只认 UUID 文件名，
 *      逐个试读会把配置变成假会话。
 *   4. 旧项目目录名末尾是 8 位 hex 哈希（`my-app-5e450c46`），要剥掉
 *      才对得上真实项目；但不是 8 位 hex 的名字不能误剥。
 *   5. 旧格式没有时间戳，只能取文件 mtime——不能编一个"看起来合理"的时间。
 *   6. 新格式首行不一定是 workspace-directories：抽查的 201 个文件里有
 *      2 个首行是 runtime-config。只认首行类型会把它误判成旧格式。
 *   7. Qoder 把工具调用包装成 `# Input / Tool: ...` 的 user 消息，那不是
 *      人话；整场只有这种的"纯工具会话"不该进时间线。
 *   8. 浏览器标注/附件消息的真话在 `<user_comment>` / `<user_query>` 里，
 *      外面裹着整块 DOM 证据和文件夹内容，直接取全文标题会变成一大段 HTML。
 *   9. 正文越界校验必须对**所有**根逐个试：中国版会话不能因为 `.qoder`
 *      排在前面就被拒。
 *  10. tool_result 出现在 user 行里，但语义是工具输出；attachment /
 *      active-leaf / file-history-snapshot 是运行时记录，不是对话。
 *  11. `isSidechain` 行属于子代理那棵树，混进父会话会让标题/时间/正文全错。
 *
 * 全部跑在假家目录里，不依赖、也不触碰本机真实数据。
 */

const scanner = await import('../src/scanners/qoder.js');

/** 一行 JSON。 */
function line(obj) {
  return JSON.stringify(obj) + '\n';
}

/** 多行 JSONL。 */
function jsonl(...objs) {
  return objs.map(line).join('');
}

/** 生成一个形状合法的会话 UUID。 */
function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** 旧格式的一条消息（实机 content 是数组）。 */
function legacyMessage(role, text) {
  return { role, message: { content: [{ type: 'text', text }] } };
}

/** 写一场旧格式会话：cache/projects/<项目>/conversation-history/<id>/<id>.jsonl */
function writeLegacy(box, { root = '.qoder', project = 'my-app-5e450c46', id = 'b776ed66', messages }) {
  return box.write(
    `${root}/cache/projects/${project}/conversation-history/${id}/${id}.jsonl`,
    jsonl(...messages)
  );
}

/** 写一场新格式会话：projects/<工作区>/<uuid>.jsonl */
function writeProject(box, { root = '.qoder', ws = 'E--my-app', id, events }) {
  return box.write(`${root}/projects/${ws}/${id}.jsonl`, jsonl(...events));
}

/** 新格式首行：workspace-directories，给出真实工作区路径。 */
function workspaceDirs(id, dirs, timestamp = Date.UTC(2026, 0, 1)) {
  return { type: 'workspace-directories', sessionId: id, directories: dirs, cwd: dirs[0], timestamp };
}

/** 新格式的一条用户消息。 */
function userMessage(id, text, timestamp) {
  return {
    type: 'user',
    sessionId: id,
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/** 新格式的一条助手消息。 */
function assistantMessage(id, text, timestamp) {
  return {
    type: 'assistant',
    sessionId: id,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

test('qoder: 新旧两套存储、国际版与中国版都要发现', async () => {
  const box = sandbox();
  try {
    // 这条锁的是两件叠加起来的漏数据：只读旧格式会漏九成（实机 291 vs 19），
    // 只读 .qoder 会漏掉中国版（实机 7 vs 12）。两套存储 × 两套安装都要覆盖。
    const oldFile = writeLegacy(box, {
      root: '.qoder',
      project: 'my-app-5e450c46',
      id: 'b776ed66',
      messages: [legacyMessage('user', '旧格式里的话'), legacyMessage('assistant', '旧格式的回答')],
    });

    const newId = uuid(1);
    const newFile = writeProject(box, {
      root: '.qoder-cn',
      ws: 'E--my-app',
      id: newId,
      events: [
        workspaceDirs(newId, ['E:\\my-app']),
        userMessage(newId, '新格式里的话', '2026-01-01T00:01:00Z'),
        assistantMessage(newId, '新格式的回答', '2026-01-01T00:02:00Z'),
      ],
    });

    await box.run(() => {
      const files = scanner.discover();
      assert.equal(files.length, 2, '两套存储各一场，不能只看一处');
      assert.ok(files.includes(oldFile), '旧格式（cache）必须被发现');
      assert.ok(files.includes(newFile), '新格式（projects）必须被发现');

      const oldSession = scanner.parse(oldFile);
      assert.equal(oldSession.project, 'my-app', '旧格式靠目录名反推项目');
      assert.equal(oldSession.title, '旧格式里的话');

      const newSession = scanner.parse(newFile);
      assert.equal(newSession.id, newId);
      assert.equal(newSession.project, 'E:/my-app', '新格式用行内 directories，不靠目录名');
      assert.equal(newSession.title, '新格式里的话');
      // 首行 workspace-directories 也带 timestamp（会话创建时刻），
      // start 取所有行的包络，所以是 00:00 而不是第一条用户消息的 00:01。
      assert.equal(newSession.start.toISOString(), '2026-01-01T00:00:00.000Z');
      assert.equal(newSession.end.toISOString(), '2026-01-01T00:02:00.000Z');
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 新格式只认 UUID 文件名的 jsonl，工作区里的配置/导出不是会话', async () => {
  const box = sandbox();
  try {
    // 这条锁的是"把工作区里所有 jsonl 都当会话"的坑。工作区目录里同时
    // 放着 settings.jsonl、mcp.jsonl、导出文件；逐个试读会凭空多出几场
    // 假会话（旧格式解析器对任何 JSON 行都会计数），标题还是配置项。
    const ws = 'E--p';
    const id = uuid(2);
    writeProject(box, {
      ws,
      id,
      events: [
        workspaceDirs(id, ['E:\\p']),
        userMessage(id, '真正的会话', '2026-01-01T00:01:00Z'),
      ],
    });
    box.write(`.qoder/projects/${ws}/settings.jsonl`, '{"theme":"dark"}\n');
    box.write(`.qoder/projects/${ws}/mcp.jsonl`, '{"mcpServers":{"x":{}}}\n');
    box.write(
      `.qoder/projects/${ws}/export-2026.jsonl`,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '导出的假会话' }] } }) + '\n'
    );

    await box.run(() => {
      const files = scanner.discover();
      assert.deepEqual(
        files.filter((f) => /settings|mcp|export/.test(path.basename(f))),
        [],
        '非 UUID 文件名的 jsonl 不能进会话列表'
      );
      assert.ok(
        files.some((f) => path.basename(f) === `${id}.jsonl`),
        'UUID 文件名的会话必须保留'
      );
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 旧项目名剥掉末尾 8 位 hex 哈希，但不是 8 位 hex 不能误剥', async () => {
  const box = sandbox();
  try {
    // 这条锁的是项目归集。目录名 "my-app-5e450c46" 末尾是 8 位哈希，
    // 不剥掉的话同一项目会和 "my-app" 在列表里裂成两行；
    // 反过来，把 "my-project-2" 或 9 位的东西当哈希剥掉就是改名事故。
    const cases = [
      ['my-app-5e450c46', 'my-app'],
      ['demo-proj-4c5c93dc', 'demo-proj'],
      ['build-tool-abcdef12', 'build-tool'],
      ['build-tool-abcdef123', 'build-tool-abcdef123'],
      ['my-project-2', 'my-project-2'],
    ];
    const files = cases.map(([project], i) =>
      writeLegacy(box, { project, id: `task-${i}`, messages: [legacyMessage('user', `项目 ${project}`)] })
    );

    await box.run(() => {
      files.forEach((file, i) => {
        const s = scanner.parse(file);
        assert.equal(s.project, cases[i][1], `目录名 ${cases[i][0]} 应还原成 ${cases[i][1]}`);
      });
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 旧格式没有时间戳，start/end 取 mtime；id 是目录名', async () => {
  const box = sandbox();
  try {
    // 这条锁的是旧格式的时间来源。半年前的会话基本都在旧格式里，
    // 它们没有 timestamp 字段：留 null 会让排序/时长崩，编一个"合理"
    // 的时间就是伪造事实，所以只能如实取 mtime。id 也不是 UUID，
    // 可能是 task-xxx，不能按 UUID 校验后丢掉。
    const mtime = new Date('2026-02-03T04:05:06.789Z');
    const file = writeLegacy(box, {
      id: 'task-08b',
      messages: [legacyMessage('user', '旧格式里的话'), legacyMessage('assistant', '回答')],
    });
    fs.utimesSync(file, mtime, mtime);

    await box.run(() => {
      const s = scanner.parse(file);
      assert.ok(s, 'task-xxx 的会话也要留下');
      assert.equal(s.id, 'task-08b');
      assert.equal(s.title, '旧格式里的话');
      assert.equal(s.start.toISOString(), mtime.toISOString(), 'start 用 mtime');
      assert.equal(s.end.toISOString(), mtime.toISOString(), 'end 用 mtime');
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 新格式首行是 runtime-config 时也要认，不靠 workspace-directories', async () => {
  const box = sandbox();
  try {
    // 这条锁的是格式判定。实机 201 个新格式文件里 2 个首行是 runtime-config
    // 而不是 workspace-directories。只认后者会把它误判成旧格式：项目变成
    // 转义目录名（E--runtime），时间退回 mtime，时间戳和 cwd 全白读。
    const id = uuid(3);
    const file = writeProject(box, {
      ws: 'E--runtime',
      id,
      events: [
        {
          type: 'runtime-config',
          sessionId: id,
          cwd: 'E:\\runtime-proj',
          timestamp: Date.UTC(2026, 0, 1, 0, 0, 0),
        },
        userMessage(id, '首行不是 workspace-directories', '2026-01-01T00:01:00Z'),
        assistantMessage(id, '照样要解析', Date.UTC(2026, 0, 1, 0, 2, 0)),
      ],
    });

    await box.run(() => {
      const s = scanner.parse(file);
      assert.ok(s, '有 sessionId 的 runtime-config 首行也是新格式');
      assert.equal(s.id, id);
      assert.equal(s.project, 'E:/runtime-proj', '项目取行内 cwd，不是目录名');
      assert.equal(s.start.toISOString(), '2026-01-01T00:00:00.000Z');
      assert.equal(s.end.toISOString(), '2026-01-01T00:02:00.000Z');
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 纯工具会话不进时间线，真人有话说时标题取人话', async () => {
  const box = sandbox();
  try {
    // 这条锁的是 `# Input / Tool: ...` 包装。Qoder 把工具调用写成 user
    // 消息，实机有整场只有这种消息的"纯工具会话"。不识别的话它会进时间线，
    // 标题变成 "# Input Tool: \"Bash\" ..."，而且人话被它挤到后面。
    const toolOnlyId = uuid(4);
    const toolOnly = writeProject(box, {
      ws: 'E--tools',
      id: toolOnlyId,
      events: [
        workspaceDirs(toolOnlyId, ['E:\\p']),
        {
          type: 'user',
          sessionId: toolOnlyId,
          timestamp: '2026-01-01T00:01:00Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '# Input\nTool: "Bash"\n{"command":"ls"}' }],
          },
        },
        assistantMessage(toolOnlyId, '命令输出……', '2026-01-01T00:02:00Z'),
      ],
    });

    const mixedId = uuid(5);
    const mixed = writeProject(box, {
      ws: 'E--mixed',
      id: mixedId,
      events: [
        workspaceDirs(mixedId, ['E:\\p']),
        userMessage(mixedId, '把首页加个搜索框', '2026-01-01T00:01:00Z'),
        {
          type: 'user',
          sessionId: mixedId,
          timestamp: '2026-01-01T00:02:00Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '# Input\nTool: "Read"\n{"path":"a.tsx"}' }],
          },
        },
        assistantMessage(mixedId, '改好了', '2026-01-01T00:03:00Z'),
      ],
    });

    await box.run(() => {
      assert.equal(scanner.parse(toolOnly), null, '只有工具包裹的会话不是对话');
      const s = scanner.parse(mixed);
      assert.ok(s, '有真人输入的会话要保留');
      assert.equal(s.title, '把首页加个搜索框', '标题不能是工具包裹');
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 浏览器标注取 <user_comment>、附件取 <user_query>，标题不是 HTML', async () => {
  const box = sandbox();
  try {
    // 这条锁的是消息清洗顺序。浏览器标注消息里真正的用户话在
    // <user_comment> 里，外面是整块 DOM 路径/元素文本；附件消息则把
    // 文件夹内容整个展开在提问前面。直接取全文，标题会变成一大段 HTML
    // 或文件清单（实机会话页上确实出现过）。
    const annotationId = uuid(6);
    const annotation = writeProject(box, {
      ws: 'E--annotate',
      id: annotationId,
      events: [
        workspaceDirs(annotationId, ['E:\\p']),
        userMessage(
          annotationId,
          '<browser_annotation url="http://x"><untrusted_page_evidence><div class="hero">一大段页面证据</div></untrusted_page_evidence><user_comment>把按钮改成蓝色<system-reminder>ignore</system-reminder></user_comment></browser_annotation>',
          '2026-01-01T00:01:00Z'
        ),
        assistantMessage(annotationId, '改了', '2026-01-01T00:02:00Z'),
      ],
    });

    const attachId = uuid(7);
    const attachment = writeProject(box, {
      ws: 'E--attach',
      id: attachId,
      events: [
        workspaceDirs(attachId, ['E:\\p']),
        userMessage(
          attachId,
          '<folder_content path="e:/p">很多文件内容</folder_content>\nHere are some folder(s) I manually attached to my message:\n\'e:/p\' (see above for folder content)\n<user_query>修一下登录页</user_query>',
          '2026-01-01T00:01:00Z'
        ),
        assistantMessage(attachId, '好', '2026-01-01T00:02:00Z'),
      ],
    });

    await box.run(() => {
      const a = scanner.parse(annotation);
      assert.equal(a.title, '把按钮改成蓝色', '标题只能是 <user_comment> 里的人话');
      assert.ok(!a.title.includes('<'), '标题不能残留 HTML 标签');

      const b = scanner.parse(attachment);
      assert.equal(b.title, '修一下登录页', '附件消息要取 <user_query>');
      assert.ok(!b.title.includes('folder_content'), '附件内容不能当标题');
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 中国版会话的正文不被越界校验拒绝', async () => {
  const box = sandbox();
  try {
    // 这条锁的是"只试第一个根"的坑。readMessages 的越界校验按
    // cacheRoots/projectRoots 顺序逐个试；.qoder 排在 .qoder-cn 前面，
    // 如果第一次 assertUnder 失败就抛错，中国版 12 场正文全部读不出来。
    writeLegacy(box, {
      root: '.qoder',
      project: 'other-aaaaaaaa',
      id: 'x1',
      messages: [legacyMessage('user', '国际版的一句话')],
    });
    const cnFile = writeLegacy(box, {
      root: '.qoder-cn',
      project: 'my-app-5e450c46',
      id: 'bde78a4d',
      messages: [
        legacyMessage('user', '中国版的用户话'),
        legacyMessage('assistant', '中国版的回答'),
      ],
    });

    await box.run(() => {
      const s = scanner.parse(cnFile);
      assert.equal(s.project, 'my-app');
      const msgs = scanner.readMessages(s);
      assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
      assert.equal(msgs[0].parts[0].text, '中国版的用户话');
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: 新格式正文里 tool_use/tool_result 配对，运行时事件不进正文', async () => {
  const box = sandbox();
  try {
    // 这条锁两件事：
    //   1. tool_result 放在 user 行的 message.content 里，但语义是工具输出，
    //      要单独成 tool 消息并按 tool_use_id 找回工具名/入参；
    //   2. attachment（技能清单）、active-leaf（对话树指针）、
    //      file-history-snapshot（文件备份）、progress 都是运行时记录，
    //      读进正文会多出无意义条目。
    const id = uuid(8);
    const file = writeProject(box, {
      ws: 'E--body',
      id,
      events: [
        workspaceDirs(id, ['E:\\p']),
        userMessage(id, '看看目录', '2026-01-01T00:01:00Z'),
        {
          type: 'assistant',
          sessionId: id,
          timestamp: '2026-01-01T00:02:00Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '我来看看' },
              { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
        {
          type: 'user',
          sessionId: id,
          timestamp: '2026-01-01T00:03:00Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt\nExit code 0' }],
          },
        },
        { type: 'attachment', sessionId: id, timestamp: '2026-01-01T00:03:10Z', attachment: { type: 'skill' } },
        { type: 'active-leaf', sessionId: id, timestamp: '2026-01-01T00:03:20Z', leafUuid: id },
        { type: 'file-history-snapshot', sessionId: id, timestamp: '2026-01-01T00:03:30Z', snapshot: {} },
        { type: 'progress', sessionId: id, timestamp: '2026-01-01T00:03:40Z' },
        { type: 'runtime-config', sessionId: id, timestamp: '2026-01-01T00:03:50Z' },
      ],
    });

    await box.run(() => {
      const s = scanner.parse(file);
      const msgs = scanner.readMessages(s);

      assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool'], '运行时事件不能变成消息');

      const tool = msgs[2].parts[0];
      assert.equal(tool.kind, 'tool');
      assert.equal(tool.name, 'Bash', '工具名要从 tool_use 配对回来');
      assert.deepEqual(tool.input, { command: 'ls' });
      assert.equal(tool.callId, 'tu1');
      assert.equal(tool.output, 'a.txt\nExit code 0', '工具结果正文不能丢');
    });
  } finally {
    box.cleanup();
  }
});

test('qoder: isSidechain 行属于子代理那棵树，不能混进父会话', async () => {
  const box = sandbox();
  try {
    // 这条锁的是同构 Claude Code 格式的侧链。子代理的消息和主线程写在
    // 同一个文件里（isSidechain=true），属于另一棵树。不跳过的话：
    // 标题可能被子代理的问题抢走、时间被拉早、正文出现两套对话。
    const id = uuid(9);
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    const sideUser = {
      type: 'user',
      isSidechain: true,
      sessionId: id,
      timestamp: t0 - 60 * 60 * 1000,
      message: { role: 'user', content: [{ type: 'text', text: '子代理收到的问题' }] },
    };
    const sideAssistant = {
      type: 'assistant',
      isSidechain: true,
      sessionId: id,
      timestamp: t0 - 30 * 60 * 1000,
      message: { role: 'assistant', content: [{ type: 'text', text: '子代理的回答' }] },
    };
    const file = writeProject(box, {
      ws: 'E--side',
      id,
      events: [
        workspaceDirs(id, ['E:\\p'], t0),
        sideUser,
        sideAssistant,
        userMessage(id, '父会话的问题', '2026-01-01T00:10:00Z'),
        assistantMessage(id, '父会话的回答', '2026-01-01T00:20:00Z'),
      ],
    });

    await box.run(() => {
      const s = scanner.parse(file);
      assert.equal(s.title, '父会话的问题', '标题不能被子代理的输入抢走');
      assert.equal(s.start.toISOString(), '2026-01-01T00:00:00.000Z', '侧链时间不能拉早 start');
      assert.equal(s.end.toISOString(), '2026-01-01T00:20:00.000Z');

      const msgs = scanner.readMessages(s);
      assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
      const texts = msgs.map((m) => m.parts[0].text);
      assert.deepEqual(texts, ['父会话的问题', '父会话的回答'], '侧链内容不能进正文');
    });
  } finally {
    box.cleanup();
  }
});

/**
 * 这条曾经是 skip：Qoder 新格式的子代理转录不在主文件里，而在
 *   projects/<工作区>/<主会话 uuid>/subagents/agent-<类型>-<hash>.jsonl
 * 首行字段是 `sessionId`（指向**主**会话）、`agentId`（自己的 id）、
 * `isSidechain: true`——没有 `parent_id`，父归属就是 sessionId。
 *
 * 修之前两处叠加把它完全丢掉：discover 只收工作区顶层 `<uuid>.jsonl`；
 * 即使手动 parse，也会因为跳过所有 isSidechain 行而返回 null。
 * 本机实测 78 个这样的文件一个都没采到。
 * 2026-10-28 修好后转绿。
 */
test(
  'qoder: subagents/agent-*.jsonl 是子代理会话，要标 kind/parent',
  async () => {
    const box = sandbox();
    try {
      const mainId = uuid(11);
      const dir = `.qoder/projects/E--my-app/${mainId}`;
      const subFile = box.write(
        `${dir}/subagents/agent-aExplore-abc123.jsonl`,
        jsonl(
          {
            type: 'user',
            uuid: 'u-1',
            isSidechain: true,
            sessionId: mainId,
            agentId: 'aExplore-abc123',
            cwd: 'E:\\my-app',
            timestamp: '2026-01-01T00:01:00Z',
            message: { role: 'user', content: [{ type: 'text', text: '子代理收到的问题' }] },
          },
          {
            type: 'assistant',
            uuid: 'a-1',
            isSidechain: true,
            sessionId: mainId,
            agentId: 'aExplore-abc123',
            cwd: 'E:\\my-app',
            timestamp: '2026-01-01T00:02:00Z',
            message: { role: 'assistant', content: [{ type: 'text', text: '子代理查到的结果' }] },
          }
        )
      );
      box.write(
        `${dir}/subagents/agent-aExplore-abc123.meta.json`,
        JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu-1', description: '定位依赖' })
      );

      await box.run(() => {
        const files = scanner.discover();
        assert.ok(files.includes(subFile), '子代理转录文件要被发现');

        const s = scanner.parse(subFile);
        assert.ok(s, '子代理文件不能返回 null');
        assert.equal(s.kind, 'subagent');
        assert.equal(s.parent, mainId, 'parent 指向 subagents 所在的主会话');
        assert.equal(s.project, 'E:/my-app');
      });
    } finally {
      box.cleanup();
    }
  }
);
