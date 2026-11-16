import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openReadOnly } from '../sqlite-read.js';
import { makeSession } from '../model.js';
import { makeMessage, textPart, toolPart, reasoningPart } from '../messages.js';
import { editorDataCandidates, findUnder } from '../platform.js';
import { extraRoots } from '../config.js';

/**
 * Cursor 会话扫描。
 *
 * **Cursor 有三个互不相干的会话存储**，只读其中一个会漏掉一大半：
 *
 *   1. 编辑器（GUI）——VSCode 键值库，本文件主要处理的就是它：
 *        Windows  %APPDATA%/Cursor/User/globalStorage/state.vscdb
 *        macOS    ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *        Linux    $XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb
 *
 *   2. **CLI（`cursor-agent`）**——`~/.cursor/chats/<md5(cwd)>/<chat id>/store.db`，
 *      每个工作目录一个 MD5 命名的目录。三平台都是 `~/.cursor`，不看 XDG、
 *      也不看 Application Support。
 *
 *   3. **新版编辑器的 project transcripts**——`~/.cursor/projects/<slug>/agent-transcripts/<id>/`，
 *      同样是 `~/.cursor`。
 *
 * 2、3 两处来自 MAGPIE `internal/sessions/cursor.go` 与 `Found()` 的三个来源
 * （`CursorDir()/chats`、`cursorDataDir()/projects`、`cursorEditorDB()`）。
 * 我们原来只读第 1 个，于是"用 CLI 干活、编辑器没开过"的用户会看到
 * Cursor 一场会话都没有。
 *
 * ## 编辑器库的格式
 *
 * 这是个 VSCode 的 SQLite 键值库，两张关键表/键：
 *   composerHeaders     一场会话一行（composerId, createdAt, isArchived, isSubagent）
 *   cursorDiskKV        composerData:<id>  会话元信息（名字、消息顺序）
 *                       bubbleId:<id>:<bid> 单条消息
 *
 * 消息顺序在 composerData.fullConversationHeadersOnly 里，bubble 本身
 * 无序存储。bubble 的字段名很杂，实际用到的只有三个：
 *   text        正文
 *   thinking    推理（{text, ...}）
 *   toolFormerData  工具调用（含 name / params / result）
 *
 * 时间在 composer.createdAt 与 bubble.createdAt 上，都是毫秒时间戳。
 * 项目路径在 bubble.workspaceProjectDir，形如
 * "c:\\Users\\...\\.cursor\\projects\\e-my-app"，需要反解成 e:\my-app
 * ——Cursor 把路径里的 \ 和 : 换成了 -，并且全部小写。
 */

export const name = 'cursor';

/**
 * 结构声明（数据源解耦 P1）。应用根是 AppData/Roaming 下的 `Cursor` 目录
 * 那一层，库在 User/globalStorage/state.vscdb。rootAnchor 从命中文件
 * 上溯 3 层回到应用根。
 */
export const structureSpec = {
  agent: name,
  probes: [
    { path: 'User/globalStorage/state.vscdb', kind: 'file', weight: 5 },
    { path: 'User/globalStorage', kind: 'dir', weight: 1 },
  ],
  rootAnchor: { from: 'User/globalStorage/state.vscdb', up: 3 },
  dataPaths: ['User/globalStorage/state.vscdb'],
  format: 'cursor-vscdb-sqlite',
  minScore: 5,
  dirHints: ['Cursor'],
};

const DB_REL = 'User/globalStorage/state.vscdb';

/**
 * Cursor 的产品目录名。
 *
 * macOS 上是 "Cursor"，但用户也可能装的是预发布版或其他分发渠道，
 * 目录名会不同。按候选顺序找。
 */
const CURSOR_APPS = ['Cursor', 'Cursor - Insiders', 'Cursor Nightly'];

/**
 * CLI 与 project-transcripts 的数据根：**三平台都是 `~/.cursor`**。
 *
 * 这不是"没做跨平台"，而是 Cursor 自己就这么写：MAGPIE 的
 * `cursorDataDir()` 是 `$CURSOR_DATA_DIR` 否则 `~/.cursor`，没有 darwin 分支，
 * 也不用 `os.UserConfigDir()`。编辑器那个库才走平台目录。
 *
 * 所以这里和 `cursorRoots()`（编辑器数据目录）是两套根，不能混：
 * 拿 `~/Library/Application Support/Cursor` 去找 `chats/` 会永远找不到。
 */
function cliDataRoots() {
  const out = [];
  for (const p of extraRoots(name)) {
    const abs = path.resolve(String(p));
    if (!out.includes(abs)) out.push(abs);
  }
  const envData = String(process.env.CURSOR_DATA_DIR || '').trim();
  if (envData && path.isAbsolute(envData)) out.push(envData);
  out.push(path.join(os.homedir(), '.cursor'));
  return out;
}

function cursorRoots() {
  // 配置文件里的根 = "Cursor" 这一层应用数据目录，排在最前
  return [...extraRoots(name), ...editorDataCandidates(CURSOR_APPS)];
}

function dbPath() {
  const found = findUnder(cursorRoots(), DB_REL);
  if (found) return found;
  return path.join(cursorRoots()[0], 'User', 'globalStorage', 'state.vscdb');
}

/** 声明"我会去哪里找数据"（编辑器数据目录 + CLI 的 `~/.cursor`；给 doctor 与反向发现用）。 */
export function candidateRoots() {
  const out = [...cursorRoots()];
  for (const p of cliDataRoots()) if (!out.includes(p)) out.push(p);
  return out;
}

/** 契约 A：discover() 无参，旧签名 / 旧行为一字不改。 */
export function discover() {
  return discoverWithin([dbPath()], {});
}

/**
 * 契约 B：纯函数。roots 是应用根（Cursor 目录）时拼出 state.vscdb；
 * 本机 discover() 直接传 db 文件本身，两种都收。只 accessSync，不读内容。
 */
export function discoverWithin(roots, ctx = {}) {
  const out = [];
  for (const root of roots || []) {
    const p = dbFileUnder(root);
    try {
      fs.accessSync(p, fs.constants.R_OK);
    } catch {
      continue;
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function dbFileUnder(root) {
  return /\.(vscdb|db|sqlite)$/i.test(root) ? root : path.join(root, 'User', 'globalStorage', 'state.vscdb');
}

/** source 形如 `<db 文件>#<会话 id>`，从中取回库文件路径。 */
function dbFileFromSource(source) {
  const s = String(source || '');
  const i = s.indexOf('#');
  return i > 0 ? s.slice(0, i) : dbPath();
}

let cachedDb = null;
let cachedPath = null;

function getDb(file) {
  // 连接按传入的 file 缓存：显式数据源下 file 是外部备份的库，不能退回本机 dbPath()
  const p = file || dbPath();
  if (cachedDb && cachedPath === p) return cachedDb;
  closeStore();
  try {
    cachedDb = openReadOnly(p);
    if (!cachedDb) {
      cachedPath = p;
      return null;
    }
    cachedDb.prepare('pragma busy_timeout = 5000').run();
  } catch {
    cachedDb = null;
  }
  cachedPath = p;
  return cachedDb;
}

export function closeStore() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* 已关闭 */
    }
    cachedDb = null;
    cachedPath = null;
  }
}

/**
 * 一场会话一个文件。
 *
 * Cursor 把所有会话塞在同一个 SQLite 里，所以这里的 "file" 是数据库路径，
 * 会话由 composerHeaders 逐行给出。用 parseAll 一次产出全部，
 * 避免每个会话都重新打开 3.8 MB 的库。
 */
export function parseAll(file, ctx = {}) {
  const db = getDb(file);
  if (!db) return [];

  let rows;
  try {
    rows = db
      .prepare(
        // workspaceId 必须取：下面 buildSession 要用它查
        // workspaceStorage/<workspaceId>/workspace.json 拿权威项目路径。
        // 之前漏了这一列，`row.workspaceId` 恒为 undefined，
        // 于是"权威来源优先"这条规则从未生效过——一直靠目录名反解，
        // 而反解有损（`Users-a-my-app` 可能是 /Users/a/my-app 或 /Users/a/my/app）。
        `select composerId, workspaceId, createdAt, isArchived, isSubagent
         from composerHeaders
         where coalesce(isSubagent, 0) = 0`
      )
      .all();
  } catch {
    return [];
  }

  const out = [];
  for (const r of rows) {
    const s = buildSession(db, r, file);
    if (s) out.push(s);
  }
  return out;
}

function buildSession(db, row, file) {
  const id = row.composerId;
  if (!id || id === 'empty-state-draft') return null;

  let data;
  try {
    const got = db.prepare('select value from cursorDiskKV where key = ?').get(`composerData:${id}`);
    if (!got) return null;
    data = JSON.parse(got.value);
  } catch {
    return null;
  }

  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];

  // 空会话不算会话。Cursor 会为"新建但没聊"的 composer 也写一行，
  // 它们只有 createdAt 和空消息列表，列进时间线纯属噪声。
  if (!headers.length) return null;

  // 会话级别的时间：createdAt 来自 composer，最后一条消息的 createdAt 作结束
  let start = row.createdAt ? new Date(row.createdAt) : null;

  // 先试权威来源：Cursor 在 workspaceStorage/<workspaceId>/workspace.json
  // 写了真实路径。取不到才退到目录名反解。
  let project = projectFromWorkspaceJson(row.workspaceId);

  let end = null;
  let firstUser = null;
  let firstAssistant = null;

  for (const h of headers) {
    const ts = parseTime(h.createdAt);
    if (ts) {
      if (!start || ts < start) start = ts;
      if (!end || ts > end) end = ts;
    }
  }

  // 只需要开头几条就能拿到标题和项目路径；全量读留到 readMessages
  const probe = headers.slice(0, 12);
  for (const h of probe) {
    let j;
    try {
      const got = db.prepare('select value from cursorDiskKV where key = ?').get(`bubbleId:${id}:${h.bubbleId}`);
      if (!got) continue;
      j = JSON.parse(got.value);
    } catch {
      continue;
    }
    // 项目路径的取法有优先级：workspace.json 是权威来源，
    // 目录名反解只在确定能解对时才用，否则宁可留空。
    // 编一个看起来合理的错路径会静默污染项目归集，比缺数据难发现。
    if (!project && j.workspaceProjectDir) project = cursorProjectDir(j.workspaceProjectDir);
    if (!project && Array.isArray(j.workspaceUris)) {
      for (const u of j.workspaceUris) {
        const p = uriToPath(u);
        if (p) {
          project = p;
          break;
        }
      }
    }
    const txt = String(j.text || '').trim();
    if (!txt) continue;
    if (h.type === 1 && !firstUser) firstUser = txt;
    else if (h.type === 2 && !firstAssistant) firstAssistant = txt;
  }

  if (!start && !end) return null;

  return makeSession({
    agent: name,
    id,
    // Cursor 自己给会话起的名字（如 "Project familiarization"），没有就用首句
    project,
    title: data.name || firstUser || firstAssistant,
    start,
    end: end || start,
    source: `${file}#${id}`,
    resume: null,
  });
}

/**
 * 把 Cursor 的 workspaceProjectDir 还原成真实路径。
 *
 * 形如 "c:\\Users\\X\\.cursor\\projects\\e-my-app"（Windows）
 * 或     "/Users/X/.cursor/projects/Users-X-myapp"（macOS/Linux）。
 *
 * 目录名是「绝对路径把所有分隔符换成 -」得到的，这个编码**有损**：
 *   - "Users-X-my-repo" 可能是 /Users/X/my-repo 或 /Users/X/my/repo
 *   - 项目名本身带连字符时无法区分
 * 所以不能可靠反解——反解出来的东西看着像路径，实际可能是错的。
 *
 * 应对：**优先用 workspace.json 里的真实路径**（Cursor 会写），
 * 拿不到再用一个保守的启发式：只在能确定盘符形态时才反解，
 * 其余情况返回 null。宁可返回 null 让上层显示"无项目"，
 * 也不要给一个看起来合理、实际错误的路径——那种错误会静默污染
 * 项目归集，比缺数据难发现得多。
 */
export function cursorProjectDir(dir) {
  const s = String(dir || '');
  const m = s.match(/\.cursor[\\/]projects[\\/](.+)$/i);
  if (!m) return null;
  return slugToPath(m[1]);
}

function slugToPath(slug) {
  const s = String(slug);

  // Windows：盘符形态 "e-my-app" → "e:/my-app"。
  // 只有当第一段恰好是一个字母、且后面还有内容时才这么解；
  // 单个字母开头的目录名在 macOS 上很常见（如 "Users-..."），
  // 但那种情况下第二段是 "sers"，不是完整单词，所以这个规则本身
  // 只在 Windows 上成立。用盘符是否合法来兜底。
  const m = s.match(/^([a-zA-Z])-(.+)$/);
  if (m && /^[a-zA-Z]$/.test(m[1]) && process.platform === 'win32') {
    return `${m[1].toLowerCase()}:/${m[2]}`;
  }

  // macOS / Linux：路径以 / 开头，编码后开头的 "-" 被去掉，
  // 所以 "Users-X-myapp" 对应 /Users/X/myapp。但分段不可逆，
  // 只知道首段是根下的一级目录名。取前两段能覆盖绝大多数情况：
  //   /Users/<name>/...          → macOS 家目录
  //   /home/<name>/...           → Linux 家目录
  if (process.platform !== 'win32') {
    if (/^Users-/.test(s)) {
      // /Users/<username>/<剩下的原样保留，连字符不还原>
      const rest = s.slice('Users-'.length);
      const dash = rest.indexOf('-');
      if (dash > 0) return `/Users/${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
      return `/Users/${rest}`;
    }
    if (/^home-/.test(s)) {
      const rest = s.slice('home-'.length);
      const dash = rest.indexOf('-');
      if (dash > 0) return `/home/${rest.slice(0, dash)}/${rest.slice(dash + 1)}`;
      return `/home/${rest}`;
    }
  }

  // 其余形状（Linux 下的 /opt/...、/srv/... 等）不做猜测
  return null;
}

/**
 * 从 Cursor 的 workspace.json 读真实项目路径。
 *
 * Cursor 在每个 workspaceStorage/<hash>/ 下写 workspace.json，
 * 里面的 folder 字段是 file:// URI。这是**权威来源**，
 * 优先于从目录名反解。
 */
function projectFromWorkspaceJson(workspaceId) {
  if (!workspaceId) return null;

  const roots = [];
  for (const root of cursorRoots()) {
    // 只要产品根目录（.../Cursor），不要下面的 User/...
    //
    // 判断分隔符不能用 `path.sep`：`cursorRoots()` 里既有当前平台的默认位置，
    // 也有"别的平台可能拷过来"的兜底候选（比如 Windows 上也会列出
    // `~/.config/Cursor`）。用 `path.sep` 切一条正斜杠路径会切不动，
    // 于是权威来源静默失效、退回目录名反解。
    const m = String(root).match(/^(.*?)[\\/]User(?:[\\/]|$)/);
    const appRoot = m ? m[1].replace(/[\\/]+$/, '') : String(root).replace(/[\\/]+$/, '');
    if (!appRoot) continue;
    const dir = path.join(appRoot, 'User', 'workspaceStorage', workspaceId);
    if (!roots.includes(dir)) roots.push(dir);
  }

  for (const dir of roots) {
    try {
      const wj = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
      const folder = wj && wj.folder;
      if (typeof folder === 'string') {
        const p = uriToPath(folder);
        if (p) return p;
      }
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** file:///e%3A/my-app 或 file:///Users/x/proj → 平台路径 */
function uriToPath(uri) {
  const s = String(uri || '');
  if (!s.startsWith('file:')) return null;
  let p = s.slice(5).replace(/^\/+/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  p = p.replace(/\\/g, '/');

  // Windows：e%3A/... → e:/...
  const drive = p.match(/^([a-zA-Z]):\/?(.*)$/);
  if (drive) return `${drive[1].toLowerCase()}:/${drive[2]}`;

  // POSIX：保持以 / 开头
  if (p && !p.startsWith('/')) p = '/' + p;
  return p || null;
}

function parseTime(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v);
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).trim() !== '') return new Date(n);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 读一场会话的完整正文。
 *
 * 顺序必须走 fullConversationHeadersOnly——bubble 在 KV 表里是无序的，
 * 按 key 排序会得到一段乱序的对话。
 */
export function readMessages(session, ctx = {}) {
  const db = getDb(dbFileFromSource(session.source));
  if (!db) throw new Error('打不开 Cursor 数据库');

  const id = String(session.source).split('#')[1] || session.id;

  let data;
  try {
    const got = db.prepare('select value from cursorDiskKV where key = ?').get(`composerData:${id}`);
    if (!got) throw new Error('会话不存在');
    data = JSON.parse(got.value);
  } catch (e) {
    throw new Error(`读不了会话 ${id}: ${e && e.message ? e.message : e}`);
  }

  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  const out = [];

  for (const h of headers) {
    let j;
    try {
      const got = db
        .prepare('select value from cursorDiskKV where key = ?')
        .get(`bubbleId:${id}:${h.bubbleId}`);
      if (!got) continue;
      j = JSON.parse(got.value);
    } catch {
      continue;
    }

    const parts = [];

    // 推理
    if (j.thinking && typeof j.thinking.text === 'string') {
      const p = reasoningPart(j.thinking.text);
      if (p) parts.push(p);
    }

    // 工具调用
    if (j.toolFormerData && typeof j.toolFormerData === 'object') {
      const t = j.toolFormerData;
      parts.push(
        toolPart({
          name: t.name || t.toolName || 'tool',
          input: t.params !== undefined ? t.params : t.rawArgs,
          output: typeof t.result === 'string' ? t.result : t.result ? JSON.stringify(t.result) : null,
          status: t.status || null,
        })
      );
    }

    // 正文：type 1 用户、type 2 助手
    const txt = String(j.text || '').trim();
    if (txt) {
      const p = textPart(txt);
      if (p) parts.push(p);
    }

    if (!parts.length) continue;

    out.push(
      makeMessage({
        role: h.type === 1 ? 'user' : 'assistant',
        parts,
        ts: parseTime(h.createdAt) || parseTime(j.createdAt),
      })
    );
  }

  return out;
}
