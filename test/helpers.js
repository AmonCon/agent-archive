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
 * 这个项目要开源给所有人用。用实测真实会话做测试，换一台机器就全失效——
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
 * 「假机器」的环境变量清单。
 *
 * **这是隔离的唯一一份定义**：进程内的 `sandbox().run()` 和起子进程的
 * `runCli()` 都必须用它，否则两份名单迟早漂移——而漂移的表现是某个扫描器
 * 在测试里读到了跑测试那台机器的真实会话，既不报错也不失败，只是慢和不准。
 *
 * 两类变量都要改：
 *   1. 家目录与平台默认根（`%APPDATA%` / XDG 是**独立于家目录**的变量，
 *      Cursor、Kiro、Copilot、Hermes 走它们）；
 *   2. 各家自己的覆盖变量（`CODEX_HOME` 之类）必须清空，否则真实环境的
 *      设置会从缝里漏进来。
 *
 * @returns {Record<string, string|null>} null 表示"删掉这个变量"
 */
export function fakeMachineEnv(box) {
  return {
    USERPROFILE: box.home,
    HOME: box.home,
    AGENT_ARCHIVE_HOME: box.state,

    APPDATA: path.join(box.dir, 'appdata'),
    LOCALAPPDATA: path.join(box.dir, 'localappdata'),
    XDG_DATA_HOME: path.join(box.dir, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(box.dir, 'xdg-config'),
    XDG_CACHE_HOME: path.join(box.dir, 'xdg-cache'),

    CODEX_HOME: null,
    CODEX_SQLITE_HOME: null,
    CLAUDE_CONFIG_DIR: null,
    HERMES_HOME: null,
    DSH_HOME: null,
    QODER_CONFIG_DIR: null,
    OPENCODE_DATA_DIR: null,
    OPENCODE_DB: null,
    OPENCODE_CONFIG_DIR: null,
    CURSOR_CONFIG_DIR: null,
    KIRO_HOME: null,
    KIMI_CODE_HOME: null,
    GROK_HOME: null,
    WORKBUDDY_CONFIG_DIR: null,
    CODEBUDDY_CONFIG_DIR: null,
    MINIMAX_DATA_DIR: null,
    MAVIS_DATA_DIR: null,
    PI_CONFIG_DIR: null,
    PI_CODING_AGENT_DIR: null,
    PI_CODING_AGENT_SESSION_DIR: null,
    OMP_DATA_DIR: null,
    CLINE_DIR: null,
    CLINE_HOME: null,
    OPENCLAW_CONFIG_DIR: null,
    GEMINI_CONFIG_DIR: null,
    QWEN_HOME: null,
    FACTORY_HOME_OVERRIDE: null,
    COPILOT_HOME: null,
  };
}

/**
 * 当前被**显式覆盖**的环境变量（withEnv 的嵌套栈）。
 *
 * 为什么需要：`sandbox().run()` 会把各家覆盖变量清空（防真实环境漏进来），
 * 但用例常常要**先**用 withEnv 设一个覆盖变量、**再**在盒子里跑扫描器。
 * 没有这个栈，内层的"清空"会把外层刚设的值删掉——症状是
 * 「环境变量指向的根要参与发现」这条用例直接红，而且原因极难看出来。
 *
 * 规则：fakeMachineEnv 里值为 null（= 要删掉）的键，如果外层已经显式设过，
 * 就跳过不删，让外层赢。
 */
const explicitOverrides = new Map();

/**
 * 把 `fakeMachineEnv()` 应用到一份**已存在的 env 对象**上（给 spawn 用）。
 *
 * 与 `withEnv` 的区别：那个改的是 `process.env`，这个只返回一份新对象，
 * 适合传给 `child_process`。null 的键会被真正删掉。
 */
export function applyFakeMachineEnv(box, base = process.env) {
  const env = { ...base };
  for (const [k, v] of Object.entries(fakeMachineEnv(box))) {
    if (v === null) {
      // 外层 withEnv 显式设过的，交给外层（见 explicitOverrides 的注释）
      if (!explicitOverrides.has(k)) delete env[k];
    } else {
      env[k] = v;
    }
  }
  return env;
}

/**
 * 一个完全隔离的"假机器"。
 *
 * 关键点：`os.homedir()` 在运行时跟随 `USERPROFILE`（Windows）/ `HOME`（POSIX），
 * 所以把家目录指到临时目录之后，**所有扫描器自然只看得到我们的 fixture**，
 * 不需要给每一家单独做环境变量覆盖，也不会碰到跑测试那台机器上的真实会话。
 *
 * 这同时让测试变快：本机的真实数据有 2400 多个文件、几个几百 MB 的库，
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
    /** 子进程要用的环境变量（同一份隔离定义）。 */
    env(base = process.env) {
      return applyFakeMachineEnv(box, base);
    },
    /** 在隔离环境里跑 fn（家目录 + 状态目录都指向临时位置） */
    async run(fn) {
      return withEnv(fakeMachineEnv(box), fn);
    },    cleanup() {
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
 *
 * 设了值的键会记进 `explicitOverrides`，这样嵌套在里面的 `sandbox().run()`
 * 不会把它当成"要清掉的真实环境变量"删掉（见那个栈的注释）。
 */
export async function withEnv(vars, fn) {
  const saved = new Map();
  for (const k of Object.keys(vars)) {
    saved.set(k, process.env[k]);
  }
  const marked = [];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined || v === null) {
        // 外层 withEnv 显式设过的键，内层的"清空"要让位——
        // 否则 `withEnv({ X: 自定义根 }, () => box.run(...))` 里的 X 会被删掉。
        if (!explicitOverrides.has(k)) delete process.env[k];
      } else {
        process.env[k] = String(v);
        marked.push(k);
        explicitOverrides.set(k, (explicitOverrides.get(k) || 0) + 1);
      }
    }
    return await fn();
  } finally {
    for (const k of marked) {
      const n = (explicitOverrides.get(k) || 1) - 1;
      if (n <= 0) explicitOverrides.delete(k);
      else explicitOverrides.set(k, n);
    }
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * 数据源（source）测试用的隔离盒子。
 *
 * 与 sandbox() 的关键区别：**只重定向工具自己的状态目录 AGENT_ARCHIVE_HOME，
 * 绝不改 HOME/USERPROFILE/APPDATA 去把本机伪装成另一台机器**。数据来自
 * tempDir 里的一份合成目录，正是要证明的「不靠伪装本机也能解出别处的数据」。
 * 所有缓存/索引/配置都落进盒内的 state，不污染真实家目录。
 *
 * run(fn) 只注入 AGENT_ARCHIVE_HOME，其余环境（含真实 home）保持原样；
 * 需要额外的官方覆盖变量（如 CODEX_HOME 毒丸）由用例自己用 withEnv 叠加。
 */
export function sourceBox(prefix = 'aa-source-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });

  return {
    dir,
    state,
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
    /** 在隔离的状态目录下跑 fn（不动 HOME） */
    async run(fn) {
      return withEnv({ AGENT_ARCHIVE_HOME: state }, fn);
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 上偶发占用，忽略 */
      }
    },
  };
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
