import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 共享 fixture：**一份数据，多个入口**。
 *
 * ## 为什么要有这一层
 *
 * 以前每个用例都在自己造数据（`box.write(...)` + 一串 JSON.stringify）。
 * 同一个漂移样本（比如 Codex 三代父 id、WorkBuddy 的编辑重发）会在
 * 扫描器用例里造一遍、在 Web/MCP 用例里再造一遍——两处只要有一处跟不上
 * 上游格式，就会出现「扫描器能解析、网页读出来是空的」这种只在一端复现的
 * 不一致，而两次造数据的人根本不知道对方造了什么。
 *
 * 所以把**真实形状**的样本落到 `samples/`，由这里统一物化到 sandbox 的
 * 正确路径。扫描器用例、Web 渲染、MCP 读取都用同一份字节：上游格式变了，
 * 改一个文件，所有入口一起变红。
 *
 * ## 为什么不放真实用户会话
 *
 * 真实数据里有用户的项目名、提问、路径。仓库要开源，不能放。这里每个
 * 样本都是**按真实形状合成的最小样本**（几十行），保留结构、去掉隐私。
 * `README.md` 记着每份样本锁的是哪个坑、形状从哪来。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, 'samples');

/**
 * 样本表。
 *
 * `files` 是「sandbox 里的相对路径 → samples 里的文件名」。
 * `scanner` 指明该用哪个扫描器，`expect` 记着扫描后应当看到什么——
 * 契约用例就是拿它来断言，避免把预期写死在用例里、跟样本各改各的。
 */
export const FIXTURES = {
  workbuddy: {
    scanner: 'workbuddy',
    files: {
      '.workbuddy/projects/e-demo-project/aaaaaaaa-1111-4222-8333-444444444444.jsonl':
        'workbuddy.jsonl',
    },
    expect: {
      sessions: 1,
      title: 'WorkBuddy 演示会话',
      project: 'E:/demo-project',
      userTexts: ['第二版问题'],
      toolOutput: '工具输出：找到 1 条',
    },
  },

  'claude-fork': {
    scanner: 'claude-code',
    files: {
      '.claude/projects/E--demo-project/fork-aaaa-1111.jsonl': 'claude-fork-origin.jsonl',
      '.claude/projects/E--demo-project/fork-bbbb-2222.jsonl': 'claude-fork-branch.jsonl',
      '.claude/projects/E--demo-project/fork-cccc-3333.jsonl': 'claude-fork-copy.jsonl',
    },
    expect: {
      sessions: 3,
      // 复制品被 mainOnly 过滤，分叉留在时间线上并带 branchOf
      original: 'fork-aaaa-1111',
      copyOf: 'fork-aaaa-1111',
      branchOf: 'fork-aaaa-1111',
      userTexts: ['演示问题：这个项目怎么跑'],
    },
  },

  'codex-3gen': {
    scanner: 'codex',
    files: {
      '.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-22222222.jsonl': 'codex-main.jsonl',
      '.codex/sessions/2026/01/01/rollout-2026-01-01T00-02-00-33333333.jsonl': 'codex-sub-new.jsonl',
      '.codex/sessions/2026/01/01/rollout-2026-01-01T00-03-00-44444444.jsonl': 'codex-sub-old.jsonl',
    },
    expect: {
      sessions: 3,
      subagentParents: 2, // 两代写法都要归到同一个父会话
      userTexts: ['演示：让子代理查一下依赖'],
    },
  },

  'dsh-multiframe': {
    scanner: 'dsh',
    files: {
      '.dsh/sessions/E--demo-project/dsh-multiframe-01/session.jsonl.zstd': 'dsh-multiframe.zstd',
    },
    expect: {
      sessions: 1,
      // 只有第二帧里有人话：只解第一帧会拿到空会话
      userTexts: ['多帧里的第二帧内容'],
    },
  },

  'qoder-legacy': {
    scanner: 'qoder',
    files: {
      '.qoder/cache/projects/demo-project-5e450c46/conversation-history/b776ed66/b776ed66.jsonl':
        'qoder-legacy.jsonl',
    },
    expect: {
      sessions: 1,
      title: '旧格式里的问题',
      userTexts: ['旧格式里的问题'],
    },
  },
};

/** 读一份样本的原始字节（二进制样本也走这里）。 */
export function sampleBytes(name) {
  return fs.readFileSync(path.join(SAMPLES, name));
}

/** 读一份样本的文本内容。 */
export function sampleText(name) {
  return sampleBytes(name).toString('utf8');
}

/**
 * 把一组样本物化到 sandbox 的假家目录里。
 *
 * @param {{write: (rel: string, content: string|Buffer) => string}} box
 * @param {string} key FIXTURES 里的键
 * @returns {{scanner: string, paths: string[], expect: object}}
 */
export function materialize(box, key) {
  const spec = FIXTURES[key];
  if (!spec) throw new Error(`没有这个 fixture: ${key}`);
  const paths = [];
  for (const [rel, sample] of Object.entries(spec.files)) {
    paths.push(box.write(rel, sampleBytes(sample)));
  }
  return { scanner: spec.scanner, paths, expect: spec.expect };
}

/** 列表：给"每个样本都必须被某个用例覆盖到"这类元测试用。 */
export function fixtureKeys() {
  return Object.keys(FIXTURES);
}