import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * 测试用的临时环境。
 *
 * ## 为什么测试必须自己造数据
 *
 * 这个项目要开源给所有人用。用本机真实会话做测试，换一台机器就全失效——
 * 而"在别人机器上能不能跑"恰恰是这个产品最需要保证的东西。
 *
 * 所以每个用例自己造最小的、脱敏的存储形态：一小段 JSONL、一个两行的
 * SQLite、一个多帧 zstd。它们同时充当**格式契约**：上游改了格式，
 * 这些用例会先红。
 *
 * ## 环境隔离
 *
 * scanner 的根目录都是**调用时**读环境变量（不是模块级常量），所以
 * 在用例里先设 env 再调用即可。每个用例用独立临时目录，跑完删掉。
 */

/**
 * 一个完全隔离的"假机器"。
 *
 * 关键点：`os.homedir()` 在运行时跟随 `USERPROFILE`（Windows）/ `HOME`（POSIX），
 * 所以把家目录指到临时目录之后，**所有扫描器自然只看得到我们的 fixture**，
 * 不需要给每一家单独做环境变量覆盖，也不会碰到跑测试那台机器上的真实会话。
 *
 * 这同时让测试变快：本机真实数据有 2400 多个文件、几个几百 MB 的库，
 * 全扫一遍要一分多钟；空家目录下是毫秒级。
 *
 * 这也正好符合这个产品的处境——它要装到别人机器上，测试不能依赖开发者的
 * 家目录长什么样。
 */
export function sandbox(prefix = 'aa-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const state = path.join(dir, 'state');

  const box = {
    dir,
    home,
    state,
    /** 相对假家目录的路径 */
    path: (...p) => path.join(home, ...p),
    write(rel, content) {
      const full = path.join(home, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return full;
    },
    mkdir(rel) {
      const full = path.join(home, rel);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },
    /** 在隔离环境里跑 fn（家目录 + 状态目录都指向临时位置） */
    async run(fn) {
      return withEnv(
        {
          USERPROFILE: home,
          HOME: home,
          AGENT_ARCHIVE_HOME: state,
          // 明确清掉可能存在的覆盖变量，否则真实环境的设置会漏进来
          CODEX_HOME: null,
          CLAUDE_CONFIG_DIR: null,
          HERMES_HOME: null,
          DSH_HOME: null,
          QODER_CONFIG_DIR: null,
          OPENCODE_DATA_DIR: null,
          OPENCODE_DB: null,
          CURSOR_CONFIG_DIR: null,
          KIRO_HOME: null,
        },
        fn
      );
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 上偶发占用，忽略 */
      }
    },
  };
  return box;
}

/** 造一个临时目录（不隔离家目录，用于纯函数测试）。 */
export function tempDir(prefix = 'aa-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    path: (...p) => path.join(dir, ...p),
    write(rel, content) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return full;
    },
    mkdir(rel) {
      const full = path.join(dir, rel);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 在一个隔离的环境变量上下文里跑函数，结束后还原。
 *
 * 只还原**我们动过的那几个键**，不整体替换 process.env——否则会把
 * PATH 之类的东西弄丢，Windows 上会连带影响 spawn。
 */
export async function withEnv(vars, fn) {
  const saved = new Map();
  for (const k of Object.keys(vars)) {
    saved.set(k, process.env[k]);
  }
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined || v === null) delete process.env[k];
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

/** 造一条 Codex rollout 行。 */
export function codexLine(type, payload, timestamp) {
  return JSON.stringify({ timestamp, type, payload }) + '\n';
}

/** 造一个 Codex session_meta。 */
export function codexMeta({ id, cwd, parent, source, timestamp }) {
  const payload = { id, session_id: id, cwd, timestamp };
  if (parent) payload.parent_thread_id = parent;
  if (source) payload.source = source;
  return codexLine('session_meta', payload, timestamp);
}

/** 造一条 Codex 用户消息。 */
export function codexUser(text, timestamp) {
  return codexLine(
    'response_item',
    { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    timestamp
  );
}

/** 造一条 Codex 助手消息。 */
export function codexAssistant(text, timestamp) {
  return codexLine(
    'response_item',
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    timestamp
  );
}

/**
 * 用 node:sqlite 造一个最小库。
 *
 * @param {string} file 路径
 * @param {(db) => void} build 建表/插数据的回调
 */
export function makeSqlite(file, build) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    build(db);
  } finally {
    db.close();
  }
  return file;
}
