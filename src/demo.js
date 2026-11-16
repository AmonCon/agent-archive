import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 合成样例（demo）：**没有真实会话的人，也能在 30 秒内看到这个产品长什么样**。
 *
 * ## 它解决的是哪一类人的问题
 *
 * 装完这个工具、打开网页，第一眼看到的是「还没有识别到会话」——因为他的机器上
 * 确实还没有任何 Agent 写过会话，或者写在我们还没适配的位置。这时候他没有任何
 * 办法判断「这东西对我有没有用」，只能先花几周攒数据。
 *
 * 所以这里内置一份**合成的**档案：三家 Agent 在同一个项目上接力改一个小需求，
 * 时间线、换手、交接单全都有内容。跑完就删，不碰用户的任何真实会话。
 *
 * ## 为什么是子进程 + 改环境变量，而不是给扫描层加一个全局 source
 *
 * 这是这个项目已经否决过的一条路（见 research/upstream/LESSONS.md：P0 明确否决
 * `setScanSource` 那种进程级全局 shim）。原因是扫描是**同步且被多处共享**的：
 * 一个全局变量一旦在 await 交错处被改，两个请求就会串根，而且症状是"看到别人的
 * 数据"——最不该出现在档案馆里的那种 bug。
 *
 * 所以隔离靠**换一个进程**：扫描器的根目录都是调用时读 `os.homedir()` /
 * `process.env`（不是模块级常量），把 `USERPROFILE` / `HOME` / `APPDATA` 等
 * 指到临时目录，再把各家的覆盖变量清空，子进程就自然只看得到我们的样例。
 * 代价是一次进程启动（几十毫秒），换来的是：
 *   - 零全局状态，父进程的扫描缓存/磁盘缓存一条都不会被污染；
 *   - demo 永远不可能写进用户真实的 `~/.agent-archive`；
 *   - 与 `test/helpers.js` 的 `sandbox()` 用同一套隔离思路，两处可以互相对照。
 *
 * ## 为什么不复用 test/fixtures
 *
 * 那是**测试资产**，不是产品资产。fixtures 里每个文件都在锁一种会静默出错的
 * 格式边界（注入上下文、编辑重发、子代理、复制/分叉……），刻意又小又怪；
 * 而 demo 要的是"读起来像真的发生过的一段工作"。两者的目标相反：
 *   - 复用 fixtures → demo 展示出来是一堆格式边角料，用户看不出产品价值；
 *   - 把 fixtures 改得好看 → 测试就不再锁那些边界了，等于拆掉门禁。
 *
 * 所以 demo 的内容单独写一份：中文、可读、脱敏，讲一个完整的小故事。
 *
 * ## 故事线（也是时间线要展示的东西）
 *
 *   01-05  claude-code  提出并定位：窄屏下「导出」按钮被裁掉
 *   01-06  codex        按 flex 改一版
 *   01-14  workbuddy    8 天后接手：1024 宽下还是压字，修掉并补用例  ← 长期中断
 *   01-14  codex        写 CHANGELOG、跑 lint
 *   01-15  claude-code  核对措辞、更新待办
 *   01-15  claude-code  把回归用例接进 CI（收尾）
 *
 * 6 场会话、5 段、4 次换手，其中一次间隔 8 天——handoff 的「长期中断」和
 * brief 的「更早的一次换手」都有真实内容可显示。
 */

/**
 * 样例项目路径。
 *
 * **按当前平台生成**，不是写死 `E:/demo-project`：这个工具要给所有人用，
 * 一个 Linux 用户在 demo 里看到 `E:/` 会立刻意识到"这是给 Windows 做的"，
 * 而它本来只是个示例。规则很朴素：
 *
 *   win32   E:/demo-project      （盘符路径，一眼就是示例）
 *   其它    ~/demo-project       （POSIX 绝对路径，展开成真家目录）
 *
 * 注意这里必须用**当前进程**的 `os.homedir()`，但 demo 是在假家目录里跑的
 * （见 runDemo 的子进程环境），所以展开出来的是假家目录里的路径——正好是
 * 样例数据里记录的 cwd，两边一致。
 */
function demoProjectPath() {
  if (process.platform === 'win32') return 'E:/demo-project';
  return path.join(os.homedir(), 'demo-project').replace(/\\/g, '/');
}

const PROJECT = demoProjectPath();

/** 对外暴露项目路径，方便调用方拼 `timeline <项目>` 这类命令。 */
export const DEMO_PROJECT = PROJECT;

/**
 * 各家按工作区目录名分目录时的转义形态。
 *
 * Claude Code 把 `E:\demo-project` 转成 `E--demo-project`（盘符+分隔符变 `-`），
 * WorkBuddy 是 `e-demo-project`。POSIX 路径下这个转义不一样，硬编码 Windows
 * 形态会让 Linux/macOS 上的样例目录名和真实规则对不上——虽然扫描器靠行内
 * `cwd` 字段也能读出来，但"样例长得像真的"本身就是它该有的样子。
 */
function workspaceDirName(kind) {
  const win = process.platform === 'win32';
  if (win) return kind === 'claude' ? 'E--demo-project' : 'e-demo-project';
  // POSIX：Claude Code 把 `/` 换成 `-`，路径开头的 / 也变成 -
  const slug = PROJECT.replace(/[/\\]+/g, '-').replace(/^-+/, '-');
  return kind === 'claude' ? slug : slug.replace(/^-/, '');
}

/** 临时目录前缀。cleanup() 靠它确认"这确实是我建的那个目录"。 */
const HOME_PREFIX = 'aa-demo-';

/**
 * 必须在子进程里清空的环境变量。
 *
 * 漏掉任何一个，子进程就会去看**跑 demo 那台机器的真实数据**：这些变量在
 * 真实用户的环境里经常是设着的（把数据放到外置盘、devcontainer、多份备份），
 * 而它们**优先于**家目录默认值。清空之后，扫描器只能退回 `~` 下的默认位置，
 * 而那个 `~` 已经被指到临时目录了。
 *
 * 名单与各扫描器实际读的变量一一对应（`envOverrides([...])` 里的那些），
 * 新增扫描器时如果引入了新的覆盖变量，也要加到这里——测试里有一条"毒丸"用例
 * 专门盯着这件事：把 `CODEX_HOME` 指向一个真实项目，demo 的输出里不许出现它。
 */
const OVERRIDE_VARS = [
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CLAUDE_CONFIG_DIR',
  'HERMES_HOME',
  'DSH_HOME',
  'QODER_CONFIG_DIR',
  'OPENCODE_DATA_DIR',
  'OPENCODE_DB',
  'OPENCODE_CONFIG_DIR',
  'CURSOR_CONFIG_DIR',
  'KIRO_HOME',
  'WORKBUDDY_CONFIG_DIR',
  'CLINE_DIR',
  'CLINE_HOME',
  'CODEBUDDY_CONFIG_DIR',
  'GEMINI_CONFIG_DIR',
  'gemini_config_dir',
  'GEMINI_CLI_HOME',
  'GROK_HOME',
  'KIMI_CODE_HOME',
  'MINIMAX_DATA_DIR',
  'MAVIS_DATA_DIR',
  'PI_CONFIG_DIR',
  'pi_config_dir',
  'PI_CODING_AGENT_DIR',
  'OMP_DATA_DIR',
  'OPENCLAW_CONFIG_DIR',
  'openclaw_config_dir',
  'QWEN_HOME',
  'QWEN_CONFIG_DIR',
  'FACTORY_HOME_OVERRIDE',
];

/* ------------------------------ 物化样例 ------------------------------ */

/**
 * 在临时目录里建一个"假机器"，按三家的真实存储布局写入合成样例。
 *
 * 只写文件、不碰进程环境——所以这个函数在测试里可以放心直接调用，
 * 不会把当前进程伪装成另一台机器（那是 `runDemo()` 通过子进程做的事）。
 *
 * @returns {{dir: string, home: string, state: string, project: string, cleanup: () => boolean}}
 *   `home` 是假家目录，`state` 是工具自己的状态目录（缓存会落在这里），
 *   `cleanup()` 只删这一个临时目录，返回是否真的删了。
 */
export function materializeDemo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), HOME_PREFIX));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  for (const [rel, content] of Object.entries(demoFiles())) {
    const full = path.join(home, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  return {
    dir,
    home,
    state,
    project: PROJECT,
    cleanup: () => removeDemoDir(dir),
  };
}

/**
 * 删掉一个 demo 临时目录。
 *
 * 为什么先校验再删：`cleanup()` 是这个模块**唯一会删东西的出口**，而它的入参
 * 一旦被谁传错（把 `home` 甚至用户目录传进来），删掉的就是别人的东西。
 * 所以要求同时满足两条：仍在系统临时目录之下、且目录名带我们的前缀。
 * 两条都不满足就什么都不做，返回 false。
 *
 * 幂等：第二次调用返回 false，不抛错（清理路径上抛错会让 `finally` 掩盖真正的错误）。
 *
 * 「返回 true 就代表真的删掉了一个目录」这条要显式检查存在性：`rmSync` 带
 * `force: true` 时对不存在的路径**不抛错也不做事**，靠它判断会永远返回 true。
 */
function removeDemoDir(dir) {
  if (!dir) return false;
  const abs = path.resolve(String(dir));
  const rel = path.relative(path.resolve(os.tmpdir()), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (!path.basename(abs).startsWith(HOME_PREFIX)) return false;
  if (!fs.existsSync(abs)) return false;
  try {
    fs.rmSync(abs, { recursive: true, force: true });
    return true;
  } catch {
    // Windows 上偶发占用（杀软/索引服务短暂持有句柄），忽略即可：
    // 这是临时目录，系统迟早会清。
    return false;
  }
}

/**
 * 子进程的环境变量补丁（值为 `null` 表示要删掉这个变量）。
 *
 * 单独导出是因为**测试要用同一份补丁**去跑进程内的扫描（`withEnv`），
 * 而不是在测试里再抄一遍变量名——抄一遍就迟早会漂移，而漂移的表现是
 * "demo 看起来正常，其实读到了本机数据"，最难发现。
 *
 * 入参是 `materializeDemo()` 给出的那一对目录（`<dir>/home`、`<dir>/state`）。
 * APPDATA / XDG 这些派生目录放在它们的**共同父目录**下；如果传进来的
 * home 不是这个形状（比如有人直接塞了个临时目录），就退回放在 home 里面
 * ——宁可多套一层，也不能让路径跑到临时目录根上去污染系统。
 */
export function demoEnvPatch(home, state) {
  const absHome = path.resolve(String(home));
  const absState = path.resolve(String(state));
  const parent = path.dirname(absHome);
  // 只有 state 确实是 home 的兄弟时才认这个父目录，否则把派生目录收进 home
  const dir =
    path.dirname(absState) === parent ? parent : path.join(absHome, '.demo-env');
  const patch = {
    // 家目录：`os.homedir()` 在运行时跟随这两个变量（Windows 认 USERPROFILE，
    // POSIX 认 HOME），所以指到临时目录之后，所有扫描器的默认根都跟着走。
    USERPROFILE: absHome,
    HOME: absHome,

    // 工具自己的状态目录（扫描缓存、索引、配置）。指到临时目录，
    // demo 就不可能写进用户真实的 ~/.agent-archive。
    AGENT_ARCHIVE_HOME: absState,

    // 平台默认根**独立于家目录**，必须单独改。Cursor / Kiro / Copilot /
    // Hermes 这类走的是它们，不是 `~`。只隔离家目录的话，这些扫描器会读到
    // 跑 demo 那台机器的真实会话——test/helpers.js 里记着真出过这件事。
    APPDATA: path.join(dir, 'appdata'),
    LOCALAPPDATA: path.join(dir, 'localappdata'),
    XDG_DATA_HOME: path.join(dir, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
    XDG_CACHE_HOME: path.join(dir, 'xdg-cache'),

    // **PATH 也要换掉。** 这一条不是洁癖：`env cli` 会扫 PATH 列出"装了哪些
    // 命令行产品"，`env skills` / `env mcp` 也会顺着 PATH 找私有目录。
    // 留着真实 PATH，demo 的能力面就会列出用户本机装的阿里云 CLI、飞书 CLI、
    // 各种内部工具——而 demo 的截图正是最容易被贴到群里/issue 里的东西。
    //
    // 换成 demo 自己的 bin 目录（里面只有几个通用工具的空壳），这样能力面
    // 那块不是一片空白，同时**指向的是一眼就是示例的名字**。
    //
    // 放在**假家目录里面**（不是临时目录根）：`tildify()` 只把家目录缩成 `~`，
    // 放在外面的话路径会显示成 `/tmp/aa-demo-xxx/demo-bin/git`——临时目录名
    // 里带本机用户名的 8.3 短名（实测 `ADMINI~1.DES`），等于换个地方泄漏。
    PATH: demoBinDir(path.join(absHome, '.demo-bin')),
  };
  for (const name of OVERRIDE_VARS) patch[name] = null;
  return patch;
}

/**
 * demo 专用的 PATH 目录：放几个通用工具的空壳文件。
 *
 * 为什么不是干脆空 PATH：能力面里"CLI 产品覆盖"是一整块面板，空着的话
 * 截图和 demo 都像坏了。但也不能用真实 PATH——那会泄漏用户装了什么。
 *
 * 折中：造几个**跨平台的通用工具**（git / node / npm / docker / python），
 * 内容是空的、只要求文件存在（`env cli` 只 stat 不执行）。这样：
 *   - 任何人跑 demo 看到的都一样，截图可以放心贴；
 *   - 不会指向任何真实用户装的东西。
 *
 * @param {string} bin 已经是最终目录（调用方给全路径，别再拼一层）
 */
function demoBinDir(bin) {
  try {
    fs.mkdirSync(bin, { recursive: true });
    const ext = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['git', 'node', 'npm', 'docker', 'python']) {
      const f = path.join(bin, name + ext);
      if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8');
    }
  } catch {
    /* 建不出来就让 PATH 指一个不存在的目录，能力面为空——比泄漏好 */
  }
  return bin;
}

/**
 * 把补丁应用到一份环境变量上。
 *
 * **PATH 要按大小写不敏感处理**：Windows 上这个变量的真实键名常常是 `Path`
 * （不是全大写），而 `process.env` 在 Windows 上是大小写不敏感的代理对象——
 * 直接 `env.PATH = x` 可能既没覆盖掉原来的 `Path`，又凭空多出一个 `PATH`。
 * 所以先把所有大小写变体删掉，再写一个规范键名。
 */
export function applyDemoEnv(env, patch) {
  const out = { ...env };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    // 同一个键的其它大小写变体一起清掉，避免 Windows 上留下两份
    const lower = k.toLowerCase();
    for (const existing of Object.keys(out)) {
      if (existing !== k && existing.toLowerCase() === lower) delete out[existing];
    }
    out[k] = String(v);
  }
  return out;
}

/**
 * 子进程的完整环境变量（在当前环境的基础上打补丁）。
 *
 * 是**补丁**而不是整份替换：整体替换会把 `PATH` / `SystemRoot` 之类弄丢，
 * Windows 上连 `spawn` 都会变得不可靠。这一点与 `test/helpers.js` 的
 * `withEnv` 是同一个取舍。
 */
export function demoEnv(home, state) {
  return applyDemoEnv(process.env, demoEnvPatch(home, state));
}

/* ------------------------------ 跑子进程 ------------------------------ */

/** `src/cli.js` 的绝对路径（用 import.meta.url 定位，不写死仓库位置）。 */
function cliPath() {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

/** 仓库根目录。子进程的 cwd 放这里，让相对路径参数的行为可预期。 */
function repoRoot() {
  return path.dirname(path.dirname(cliPath()));
}

/**
 * 在一个已经物化好的 demo 环境里跑一条 CLI 命令。
 *
 * 拆出来（而不是只给一个 `runDemo`）是因为**一次 demo 要在同一个假机器上
 * 跑好几条命令**：projects → timeline → handoff → brief。每条命令都重新
 * 物化一次也能跑，但那样每条命令看到的都是"新机器"（缓存全空），
 * 而真实体验是热的——而且会白付 4 次建目录的钱。
 *
 * @param {object} box materializeDemo() 的返回值
 * @param {string[]} argv 传给 CLI 的参数（不含 node 与脚本路径）
 * @param {{onOutput?: (text: string) => void}} [opts]
 *   给了 `onOutput` 就改用管道收输出（测试、网页要拿文本时用），
 *   否则 stdio 继承——用户在终端里能直接看到颜色和进度。
 * @returns {Promise<number>} 子进程退出码
 */
export function runDemoCommand(box, argv = [], { onOutput = null } = {}) {
  const capture = typeof onOutput === 'function';
  const args = ['--no-warnings', cliPath(), ...argv];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot(),
      env: demoEnv(box.home, box.state),
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });

    if (capture) {
      let out = '';
      const collect = (chunk) => {
        out += chunk;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('close', (code) => {
        onOutput(out);
        resolve(code == null ? 1 : code);
      });
    } else {
      child.on('close', (code) => resolve(code == null ? 1 : code));
    }
    child.on('error', reject);
  });
}

/**
 * 物化一份样例，跑一条 CLI 命令，然后清理。
 *
 * 这是给 `agent-archive demo` 用的最小入口：调用方只需要决定"跑哪条命令"，
 * 隔离、清理、退出码都由这里负责。
 *
 * @param {string[]} argv 例如 `['handoff', DEMO_PROJECT]`
 * @param {{keep?: boolean, onOutput?: (text: string) => void}} [opts]
 *   `keep: true` 时不删临时目录，并把位置打到 stderr 上（方便人去看原始文件）；
 *   默认删——demo 是"看一眼"，不该在磁盘上留垃圾。
 * @returns {Promise<number>} 退出码
 */
export async function runDemo(argv = [], { keep = false, onOutput = null } = {}) {
  const box = materializeDemo();
  try {
    return await runDemoCommand(box, argv, { onOutput });
  } finally {
    if (keep) {
      process.stderr.write(`[demo] 合成样例保留在：${box.home}\n`);
    } else {
      box.cleanup();
    }
  }
}

/**
 * `agent-archive demo` 的默认巡览：一条命令看完四件事。
 *
 * 顺序是有讲究的，正好是从"有什么"到"具体发生了什么"再到"我接手要看什么"：
 *   1. projects  这台机器上有哪些项目（规模感）
 *   2. timeline  一个项目里到底发生过什么（按天分组的时间线）
 *   3. handoff   这个项目被哪些 Agent 轮流接手、断点有多长（本产品独有的视角）
 *   4. brief     上一位干到哪儿了、动过哪些文件、留下什么任务（可操作的结论）
 *
 * 四步共用**同一个**假机器（一次物化），所以后三步能命中扫描缓存，很快。
 */
export const DEMO_TOUR = [
  ['projects'],
  ['timeline', PROJECT],
  ['handoff', PROJECT],
  ['brief', PROJECT],
];

/**
 * 跑完整巡览。
 *
 * 默认 stdio 继承，**不把子进程的输出抓成字符串再转发**：抓成字符串之后
 * `process.stdout.isTTY` 在子进程里是 false，颜色和表格宽度判断会一起失效，
 * 终端里看到的就是一坨无色文本。`onOutput` 只给测试和网页层用。
 *
 * @param {{keep?: boolean, steps?: string[][], onOutput?: (text: string) => void}} [opts]
 * @returns {Promise<number[]>} 每一步的退出码（中途失败就停，数组会更短）
 */
export async function runDemoTour({ keep = false, steps = DEMO_TOUR, onOutput = null } = {}) {
  const capture = typeof onOutput === 'function';
  const say = (text) => (capture ? onOutput(text) : process.stdout.write(text));
  const box = materializeDemo();
  const codes = [];
  try {
    say(
      '合成样例：三家 Agent 在同一个项目上接力改一个小需求。\n' +
        '数据写在临时目录里，跑完就删，不会碰你的真实会话。\n'
    );
    for (const argv of steps) {
      let code;
      if (capture) {
        let text = '';
        code = await runDemoCommand(box, argv, {
          onOutput: (t) => {
            text += t;
          },
        });
        // 步骤之间空一行：四段输出挨在一起会糊成一片，读不出"这是另一条命令"
        say(`\n$ agent-archive ${argv.join(' ')}\n\n${text}`);
      } else {
        say(`\n$ agent-archive ${argv.join(' ')}\n\n`);
        code = await runDemoCommand(box, argv, {});
      }
      codes.push(code);
      if (code !== 0) break;
    }
  } finally {
    if (keep) process.stderr.write(`[demo] 合成样例保留在：${box.home}\n`);
    else box.cleanup();
  }
  return codes;
}

/* ------------------------------ 样例内容 ------------------------------ */

/**
 * 三家的文件路径与内容。
 *
 * 布局严格照各扫描器的真实约定（见 src/scanners/*.js 的文件头注释）：
 *   .claude/projects/<工作区转义>/<session-uuid>.jsonl
 *   .codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl
 *   .workbuddy/projects/<工作区转义>/<session-id>.jsonl
 *
 * 会话 id 都是合法 uuid 形状，且**互不相同**（否则 registry 会把它们合并成
 * 一场会话，时间线就只剩一半）。
 */
function demoFiles() {
  const claude1 = 'c1a0de00-0000-4000-8000-000000000001';
  const codex1 = 'c0de0000-0000-4000-8000-000000000002';
  const wb1 = 'b0b00000-0000-4000-8000-000000000003';
  const codex2 = 'c0de0000-0000-4000-8000-000000000004';
  const claude2 = 'c1a0de00-0000-4000-8000-000000000005';
  const claude3 = 'c1a0de00-0000-4000-8000-000000000006';

  // Codex 的路径里带日期（`sessions/YYYY/MM/DD/rollout-<时间>-<id>.jsonl`）。
  // 目录名本身不影响解析（时间戳在文件内容里），但写错日期会让人以为
  // 样例是坏的——所以跟着样例的位移一起算。
  const codexPath = (y, m, d, h, mi, id) =>
    `.codex/sessions/${codexDate(y, m, d)}/rollout-${codexStamp(y, m, d, h, mi)}-${id}.jsonl`;

  return {
    // 第 1 天：提出并定位（Claude Code）
    [`.claude/projects/${workspaceDirName('claude')}/${claude1}.jsonl`]: sessionClaudeKickoff(claude1),
    // 第 2 天：按 flex 改一版（Codex）
    [codexPath(2026, 1, 6, 9, 20, codex1)]: sessionCodexFlex(codex1),
    // 第 10 天：八天后接手，窄屏下还是压字（WorkBuddy）
    [`.workbuddy/projects/${workspaceDirName('workbuddy')}/${wb1}.jsonl`]: sessionWorkbuddyFix(wb1),
    // 第 10 天：写 CHANGELOG、跑 lint（Codex）
    [codexPath(2026, 1, 14, 16, 20, codex2)]: sessionCodexChangelog(codex2),
    // 第 11 天：核对措辞、更新待办（Claude Code）
    [`.claude/projects/${workspaceDirName('claude')}/${claude2}.jsonl`]: sessionClaudePolish(claude2),
    // 第 11 天：把回归用例接进 CI（Claude Code，与上一场同一段工作）
    [`.claude/projects/${workspaceDirName('claude')}/${claude3}.jsonl`]: sessionClaudeCi(claude3),
  };
}

/* ---- 时间工具 ---- */

/**
 * 样例日期相对「今天」位移。
 *
 * 为什么不让日期写死在 2026-01：第一眼打开 demo 的人看到的是「最近 14 天
 * 0 场会话」和一个空的活动柱状图——样例本身没错，但它演示的是"一份过期的
 * 档案"，恰好把产品最想展示的"最近在做什么"变成了空白。
 *
 * 所以整份样例跟着今天平移：最后一场会话 = 昨天，第一场 = 11 天前。
 * 位移只在整数天上做，钟点原样保留，这样正文里写的「10:02」和显示的对得上。
 */
const ANCHOR_LAST_DAY = new Date(2026, 0, 15); // 样例里最后一场会话所在的本地日
const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDays() {
  const today = new Date();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // 最后一场放在昨天，留出「今天还没干活」的真实感
  const target = new Date(todayDay.getTime() - DAY_MS);
  return Math.round((target - ANCHOR_LAST_DAY) / DAY_MS);
}

let SHIFT = null;
function shift() {
  if (SHIFT === null) SHIFT = shiftDays();
  return SHIFT;
}

/** 测试用：把位移固定成某个值，避免跨零点跑测试时结果漂移。 */
export function __setDemoShift(days) {
  SHIFT = days;
}

/**
 * 本地时间 → ISO 字符串（**不带时区**），并按样例位移平移到最近的日期。
 *
 * 不带时区是刻意的：`new Date('2026-01-05T10:02:00')` 按本地时间解析，
 * 所以不管用户在东八区还是西五区，demo 里显示的都是 10:02——和样例正文里
 * 写的时间对得上。用 `Z` 的话，同一条命令在不同时区会显示成不同钟点，
 * 读起来会以为数据错了。
 */
function iso(y, m, d, h, mi, s = 0) {
  const p = (n) => String(n).padStart(2, '0');
  const dt = new Date(y, m - 1, d, h, mi, s);
  dt.setDate(dt.getDate() + shift());
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(
    dt.getMinutes()
  )}:${p(dt.getSeconds())}`;
}

/** 本地时间 → 毫秒时间戳（WorkBuddy 存的是 13 位毫秒，不是秒）。 */
function ms(y, m, d, h, mi, s = 0) {
  const dt = new Date(y, m - 1, d, h, mi, s);
  dt.setDate(dt.getDate() + shift());
  return dt.getTime();
}

/** Codex 路径里的 `YYYY/MM/DD`，跟着位移走。 */
function codexDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + shift());
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}/${p(dt.getMonth() + 1)}/${p(dt.getDate())}`;
}

/** Codex 文件名里的 `YYYY-MM-DDTHH-MM-SS`，跟着位移走。 */
function codexStamp(y, m, d, h, mi) {
  const dt = new Date(y, m - 1, d, h, mi);
  dt.setDate(dt.getDate() + shift());
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(h)}-${p(mi)}-00`;
}

/* ---- Claude Code ---- */

const claudeLine = (o) => JSON.stringify(o) + '\n';
const claudeText = (text) => ({ type: 'text', text });
const claudeToolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const claudeToolResult = (id, output) => ({ type: 'tool_result', tool_use_id: id, content: output });

function claudeUser(sessionId, uuid, ts, content) {
  return claudeLine({
    type: 'user',
    uuid,
    sessionId,
    cwd: PROJECT,
    timestamp: ts,
    message: { role: 'user', content },
  });
}

function claudeAssistant(sessionId, uuid, ts, content) {
  return claudeLine({
    type: 'assistant',
    uuid,
    sessionId,
    cwd: PROJECT,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: Array.isArray(content) ? content : [claudeText(content)],
    },
  });
}

/** 01-05：提出需求 + 定位（只读，不动代码）。 */
function sessionClaudeKickoff(sessionId) {
  return (
    claudeUser(
      sessionId,
      'u-0001',
      iso(2026, 1, 5, 10, 2),
      '我的笔记本是 1280 宽，项目里那个「导出」按钮被右边裁掉了一半。先别改，帮我确认一下是哪个文件把宽度写死了。'
    ) +
    claudeAssistant(sessionId, 'u-0002', iso(2026, 1, 5, 10, 3), '我先看一眼工具栏的样式。') +
    claudeAssistant(sessionId, 'u-0003', iso(2026, 1, 5, 10, 3), [
      claudeToolUse('t-0001', 'Read', { file_path: `${PROJECT}/web/styles/toolbar.css` }),
    ]) +
    claudeUser(sessionId, 'u-0004', iso(2026, 1, 5, 10, 3), [
      claudeToolResult(
        't-0001',
        '.toolbar {\n  display: flex;\n  width: 720px;\n  padding: 0 24px;\n}\n\n.toolbar-actions {\n  width: 240px;\n}\n'
      ),
    ]) +
    claudeAssistant(
      sessionId,
      'u-0005',
      iso(2026, 1, 5, 10, 5),
      '找到了，两处：`web/styles/toolbar.css` 里 `.toolbar` 写死 `width: 720px`，`.toolbar-actions` 也写死了 240px。窄屏下这两个宽度都不会缩，右边的按钮就溢出被裁。'
    ) +
    claudeUser(
      sessionId,
      'u-0006',
      iso(2026, 1, 5, 10, 20),
      '今天先到这。明天我换 Codex 接着改，你把结论留在这儿就行。'
    ) +
    claudeAssistant(
      sessionId,
      'u-0007',
      iso(2026, 1, 5, 10, 38),
      '结论记一下，给下一位：① `.toolbar` 的固定宽度改成 flex 自适应；② `.toolbar-actions` 同样处理；③ 改完在 1024 宽下回归一次。这次只定位，代码一行没动。'
    )
  );
}

/** 01-15：核对 CHANGELOG 措辞 + 更新待办。 */
function sessionClaudePolish(sessionId) {
  return (
    claudeUser(
      sessionId,
      'v-0001',
      iso(2026, 1, 15, 11, 10),
      '收尾：把 CHANGELOG 里那条的措辞核对一下，和项目里其他条目保持一致；再把这次改动记进待办，标成已完成。'
    ) +
    claudeAssistant(sessionId, 'v-0002', iso(2026, 1, 15, 11, 12), '先读一遍 CHANGELOG 现在的写法。') +
    claudeAssistant(sessionId, 'v-0003', iso(2026, 1, 15, 11, 12), [
      claudeToolUse('t-0101', 'Read', { file_path: `${PROJECT}/CHANGELOG.md` }),
    ]) +
    claudeUser(sessionId, 'v-0004', iso(2026, 1, 15, 11, 12), [
      claudeToolResult(
        't-0101',
        '# 更新日志\n\n## [0.2.1]\n\n### 修复\n\n- 窄屏下工具栏按钮被裁掉。\n- 导入大文件时进度条不走。\n'
      ),
    ]) +
    claudeAssistant(sessionId, 'v-0005', iso(2026, 1, 15, 11, 15), [
      claudeText('其他条目都用「被裁切」，改成一样的说法。'),
      claudeToolUse('t-0102', 'Edit', {
        file_path: `${PROJECT}/CHANGELOG.md`,
        old_string: '- 窄屏下工具栏按钮被裁掉。',
        new_string: '- 窄屏下工具栏按钮被裁切。',
      }),
    ]) +
    claudeAssistant(sessionId, 'v-0006', iso(2026, 1, 15, 11, 18), [
      claudeToolUse('t-0103', 'TodoWrite', {
        todos: [
          { content: '核对 CHANGELOG 措辞', status: 'completed' },
          { content: '把回归用例接进 CI', status: 'pending' },
        ],
      }),
    ]) +
    claudeAssistant(
      sessionId,
      'v-0007',
      iso(2026, 1, 15, 11, 35),
      '措辞改成「裁切」了，和项目里其他条目一致。待办也更新了：措辞已核对，回归用例接 CI 还没做。'
    )
  );
}

/** 01-15：把 1024 宽那条用例接进 CI（收尾）。 */
function sessionClaudeCi(sessionId) {
  return (
    claudeUser(
      sessionId,
      'w-0001',
      iso(2026, 1, 15, 14, 0),
      '把 1024 宽那条用例接进 CI，别只在本地跑。'
    ) +
    claudeAssistant(sessionId, 'w-0002', iso(2026, 1, 15, 14, 5), [
      claudeText('CI 里现在只跑 `npm test`，加一步 web 的用例。'),
      claudeToolUse('t-0201', 'Edit', {
        file_path: `${PROJECT}/.github/workflows/ci.yml`,
        old_string: '      - run: npm test',
        new_string: '      - run: npm test\n      - run: npm run test:web',
      }),
    ]) +
    claudeAssistant(sessionId, 'w-0003', iso(2026, 1, 15, 14, 10), [
      claudeToolUse('t-0202', 'TodoWrite', {
        todos: [
          { content: '核对 CHANGELOG 措辞', status: 'completed' },
          { content: '把回归用例接进 CI', status: 'completed' },
        ],
      }),
    ]) +
    claudeAssistant(
      sessionId,
      'w-0004',
      iso(2026, 1, 15, 14, 20),
      '接进去了，CI 里多跑一步 `npm run test:web`。这个小需求从头到尾就算收尾了。'
    )
  );
}

/* ---- Codex ---- */

const codexLine = (o) => JSON.stringify(o) + '\n';

function codexMeta(ts, sessionId) {
  return codexLine({
    timestamp: ts,
    type: 'session_meta',
    payload: {
      id: sessionId,
      session_id: sessionId,
      cwd: PROJECT,
      timestamp: ts,
      originator: 'cli',
      cli_version: '0.0.0-demo',
    },
  });
}

function codexUser(ts, text) {
  return codexLine({
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
}

function codexAssistant(ts, text) {
  return codexLine({
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
}

function codexCall(ts, name, args, callId) {
  return codexLine({
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId },
  });
}

function codexOutput(ts, callId, output, exitCode = 0) {
  return codexLine({
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({ output, metadata: { exit_code: exitCode } }),
    },
  });
}

/** 01-06：把两处固定宽度改成 flex。 */
function sessionCodexFlex(sessionId) {
  return (
    codexMeta(iso(2026, 1, 6, 9, 20), sessionId) +
    codexUser(
      iso(2026, 1, 6, 9, 21),
      '昨天在 Claude Code 那边定位到 `web/styles/toolbar.css` 的 `.toolbar` 写死 720px，`.toolbar-actions` 也写死了。按 flex 改一版，改完把改动列出来。'
    ) +
    codexAssistant(iso(2026, 1, 6, 9, 22), '先确认现状再动手。') +
    codexCall(iso(2026, 1, 6, 9, 22), 'shell', { command: ['cat', 'web/styles/toolbar.css'] }, 'call_1') +
    codexOutput(
      iso(2026, 1, 6, 9, 22),
      'call_1',
      '.toolbar {\n  display: flex;\n  width: 720px;\n  padding: 0 24px;\n}\n\n.toolbar-actions {\n  width: 240px;\n}\n'
    ) +
    codexAssistant(
      iso(2026, 1, 6, 9, 26),
      '两处都是固定宽度。改成 `width: auto` + `min-width: 0`，让 flex 自己分配空间，别用媒体查询硬压。'
    ) +
    codexCall(
      iso(2026, 1, 6, 9, 27),
      'apply_patch',
      {
        patch:
          '*** Update File: web/styles/toolbar.css\n' +
          '-  width: 720px;\n' +
          '+  width: auto;\n' +
          '+  min-width: 0;\n',
      },
      'call_2'
    ) +
    codexOutput(iso(2026, 1, 6, 9, 27), 'call_2', 'Done.') +
    codexAssistant(
      iso(2026, 1, 6, 10, 2),
      '改完了，1280 宽下按钮不再被裁。1024 宽我这边没有对应的窗口尺寸，没法复现，留给下一个人验。'
    ) +
    codexAssistant(
      iso(2026, 1, 6, 10, 5),
      '改动就两行：`.toolbar` 和 `.toolbar-actions` 的固定宽度都去掉了。没写用例，也没跑 lint。'
    )
  );
}

/** 01-14：写 CHANGELOG + 跑 lint。 */
function sessionCodexChangelog(sessionId) {
  return (
    codexMeta(iso(2026, 1, 14, 16, 20), sessionId) +
    codexUser(
      iso(2026, 1, 14, 16, 21),
      '工具栏那个修复已经进去了，帮我写一条 CHANGELOG，再跑一遍 lint。'
    ) +
    codexCall(iso(2026, 1, 14, 16, 22), 'shell', { command: ['npm', 'run', 'lint'] }, 'call_1') +
    codexOutput(iso(2026, 1, 14, 16, 25), 'call_1', 'lint 通过，0 个问题\n') +
    codexCall(
      iso(2026, 1, 14, 16, 30),
      'apply_patch',
      {
        patch:
          '*** Update File: CHANGELOG.md\n' +
          '+### 修复\n' +
          '+\n' +
          '+ - 窄屏下工具栏按钮被裁掉。\n',
      },
      'call_2'
    ) +
    codexOutput(iso(2026, 1, 14, 16, 30), 'call_2', 'Done.') +
    codexAssistant(
      iso(2026, 1, 14, 16, 52),
      'CHANGELOG 加好了，lint 也过了。措辞我写的是「窄屏下工具栏按钮被裁掉」，你要觉得不准确可以让下一位改。'
    ) +
    codexAssistant(iso(2026, 1, 14, 16, 55), '就这样，我这边收工。')
  );
}

/* ---- WorkBuddy ---- */

const wbLine = (o) => JSON.stringify(o) + '\n';

/**
 * WorkBuddy 的一条用户消息：真话裹在 `<user_query>` 里，前面是几 KB 的注入上下文。
 *
 * 这里刻意保留这个形状（而不是写纯文本）：它是这一家最容易被解析错的地方，
 * demo 顺带把「档案馆读得出真话、不把注入上下文当标题」这件事演出来。
 */
function wbUser(ts, sessionId, query) {
  const injected =
    '<system-reminder data-role="user-context">\n' +
    '<user_info>\nOS: Windows\nShell: bash\n</user_info>\n' +
    '</system-reminder>\n';
  return wbLine({
    id: `wb-u-${ts}`,
    timestamp: ts,
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `${injected}<user_query>${query}</user_query>` }],
    sessionId,
    cwd: PROJECT,
  });
}

function wbAssistant(ts, sessionId, text) {
  return wbLine({
    id: `wb-a-${ts}`,
    timestamp: ts,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
    sessionId,
    cwd: PROJECT,
  });
}

function wbReasoning(ts, sessionId, text) {
  return wbLine({
    timestamp: ts,
    type: 'reasoning',
    rawContent: [{ type: 'reasoning_text', text }],
    sessionId,
    cwd: PROJECT,
  });
}

function wbCall(ts, sessionId, name, args, callId) {
  return wbLine({
    type: 'function_call',
    id: `wb-f-${ts}`,
    callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
    timestamp: ts,
    sessionId,
    cwd: PROJECT,
  });
}

function wbResult(ts, sessionId, callId, text) {
  return wbLine({
    type: 'function_call_result',
    callId,
    output: { type: 'text', text },
    status: 'completed',
    timestamp: ts,
    sessionId,
    cwd: PROJECT,
  });
}

/** 01-14：8 天后接手，修掉 1024 宽下的挤压，补用例。 */
function sessionWorkbuddyFix(sessionId) {
  return (
    wbLine({ type: 'session-meta', id: 'wb-m-1', sessionId, timestamp: ms(2026, 1, 14, 14, 5), meta: {} }) +
    wbUser(
      ms(2026, 1, 14, 14, 5),
      sessionId,
      'Codex 那边把固定宽度改成 flex 了，但 1024 宽下按钮会压住左边的文字。你复现一下，修掉，再补一条用例。'
    ) +
    wbReasoning(
      ms(2026, 1, 14, 14, 7),
      sessionId,
      '按 1024 宽算一遍可用空间：左右 padding 各 24，按钮组最小 240，gap 还是 16，留给文字的不到 200。所以不是按钮太宽，是 gap 没跟着缩。'
    ) +
    wbCall(ms(2026, 1, 14, 14, 8), sessionId, 'read_file', { path: 'web/styles/toolbar.css' }, 'call_1') +
    wbResult(
      ms(2026, 1, 14, 14, 8),
      sessionId,
      'call_1',
      '.toolbar {\n  display: flex;\n  gap: 16px;\n  padding: 0 24px;\n}\n\n.toolbar-actions {\n  display: flex;\n  gap: 8px;\n}\n'
    ) +
    wbAssistant(
      ms(2026, 1, 14, 14, 12),
      sessionId,
      '复现了：`.toolbar` 的 `gap: 16px` 在窄屏下不缩，按钮组又不允许收缩，于是压到文字上。加一条媒体查询，1024 以下 gap 降到 8px，按钮组 `flex-shrink: 0`，文字区 `min-width: 0`。'
    ) +
    wbCall(
      ms(2026, 1, 14, 14, 14),
      sessionId,
      'write_file',
      { path: 'web/styles/toolbar.css', content: '/* 窄屏回归见 __tests__/toolbar.test.js */' },
      'call_2'
    ) +
    wbResult(ms(2026, 1, 14, 14, 15), sessionId, 'call_2', 'written') +
    wbCall(
      ms(2026, 1, 14, 14, 18),
      sessionId,
      'write_file',
      { path: 'web/__tests__/toolbar.test.js', content: '// 1024 宽快照断言' },
      'call_3'
    ) +
    wbResult(ms(2026, 1, 14, 14, 19), sessionId, 'call_3', 'written') +
    wbAssistant(
      ms(2026, 1, 14, 14, 30),
      sessionId,
      '修好了，用例补在 `web/__tests__/toolbar.test.js`，一条 1024 宽的快照断言，本地跑通。'
    ) +
    wbUser(ms(2026, 1, 14, 14, 38), sessionId, '好，收尾的时候让 Codex 写一条 CHANGELOG。') +
    wbAssistant(
      ms(2026, 1, 14, 14, 40),
      sessionId,
      '行，CHANGELOG 我这边没动，留给下一位。'
    ) +
    // ai-title：应用自己生成的标题。扫描器优先用它，所以时间线里显示的是这句。
    wbLine({
      type: 'ai-title',
      aiTitle: '修复窄屏下工具栏挤压',
      sessionId,
      timestamp: ms(2026, 1, 14, 14, 41),
      cwd: PROJECT,
    })
  );
}
