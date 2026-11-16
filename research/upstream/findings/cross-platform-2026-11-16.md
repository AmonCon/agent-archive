# 上游代码当证据：三平台路径规则（2026-11-16）

> **为什么写这份东西**：我们只有 Windows 真机，Mac 不在身边。但 MAGPIE 和
> CC Switch 都是**跨平台、有真实用户**的产品，它们对 macOS/Linux 路径的处理
> 是被人用出来的，不是猜的。这是没有真机时能拿到的最强证据。
>
> 口径：`git show FETCH_HEAD:<path>`（magpie `aa330758`、cc-switch `09acca04`），
> 行号相对该版本。**未在 Mac 上运行过**，本文只证明"上游这么写"，
> 不证明"系统这么表现"。

## 0. 结论摘要

| 我们的假设 | 上游怎么做的 | 判定 |
|---|---|---|
| `~/Library/Application Support/<App>`（macOS 应用数据） | magpie `desktopdir.Sets` 的 `darwin` 分支；cc-switch `macos_paths_from_home` | ✅ 一致 |
| Linux 用 `$XDG_CONFIG_HOME`，默认 `~/.config` | magpie `env("XDG_CONFIG_HOME", filepath.Join(home, ".config"))` | ⚠️ **我们原来硬编码 `~/.config`，已修** |
| 路径要按目标平台拼，不能按进程平台 | 两家都把 OS 做成参数/编译期常量 | ⚠️ **我们原来用 `path.join`，已修** |
| Cursor 的会话只在编辑器 `globalStorage` | magpie `Found()` 列了**三个**来源 | ❌ **我们只读了一个，已补** |
| ZCode 只看 `os.homedir()` | magpie `ZCodeHomeOn` 在 Windows 上优先 `$HOME` | ❌ **我们漏了，已补** |

## 1. 核心方法论：平台是参数，不是全局状态

这是两家最重要的共同点，也是我们 `platform.js` 早就对、但实现上有漏洞的地方。

**magpie**（`internal/desktopdir/desktopdir.go:88-92`）：

```go
// OS is the system whose folders Here, and the agent's Desktop, look for:
// runtime.GOOS, set by a test to try another system's.
var OS = runtime.GOOS

func Here() Dirs {
	home, _ := os.UserHomeDir()
	return Find(OS, home, appdir.Getenv)
}

func Find(goos, home string, getenv func(string) string) Dirs
```

**cc-switch**（`src-tauri/src/claude_desktop_config.rs:1617-1621`）用编译期常量：

```rust
#[cfg(target_os = "macos")]
fn macos_paths_from_home(home: &Path) -> ClaudeDesktopPaths {
    let app_support = home.join("Library").join("Application Support");
    paths_from_dirs(app_support.join("Claude"), app_support.join("Claude-3p"))
}
```

**两家的测试都遍历多个平台**（`desktopdir_test.go:108-118`）：

```go
func TestFindOthers(t *testing.T) {
	home := t.TempDir()
	as := filepath.Join(home, "Library", "Application Support")
	if got := Find("darwin", home, env(nil)); got != (Dirs{
		Data:   filepath.Join(as, "Claude"),
		Mode:   filepath.Join(as, "Claude"),
		ThreeP: filepath.Join(as, "Claude-3p"),
	}) {
		t.Errorf("darwin: %+v", got)
	}
	...
	if got := Find("linux", home, env(map[string]string{"XDG_CONFIG_HOME": x})); ...
}
```

### 我们踩的坑

`userDataCandidates(appName, { platform: 'darwin' })` 用 `path.join` 拼路径——
而 `path.join` 用的是**当前进程**的分隔符。在 Windows 上跑这个调用会得到：

```
\Users\alice\Library\Application Support\Claude
```

反斜杠 + POSIX 家目录，**一个在任何平台都不存在的路径**。而这条路径正是
测试里用来断言"macOS 上会去哪找"的。

更糟的是测试里有个 `norm()` 把反斜杠统一成正斜杠，正好把这个 bug 抹平：
测试看起来在验证跨平台，实际验证的是被修正过的字符串。

**修法**：`joinFor(platform, ...parts)` 先统一成 `/` 再按目标平台换回。
测试改成**断言原始值、不做归一**。

## 2. XDG_CONFIG_HOME：两家都认

**magpie**（`desktopdir.go:127`）：

```go
d := env("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
return []Dirs{{Data: filepath.Join(d, "Claude"), ...}}
```

其中 `env` 的定义（`desktopdir.go:110-115`）：

```go
env := func(k, def string) string {
	if v := getenv(k); v != "" && filepath.IsAbs(v) {
		return v
	}
	return def
}
```

注意 **`filepath.IsAbs(v)`**：相对路径被忽略，当作没设。这条我们原来没做。

**cc-switch** 走 `linux_paths_from_config_dir(config_dir)`，`config_dir` 来自
Tauri 的 `app_config_dir()`（内部就是 XDG）。

### 我们的问题

原来硬编码 `path.join(home, '.config', appName)`，**完全忽略 `XDG_CONFIG_HOME`**。
改过 XDG 的用户会看到"这些 Agent 都没装"。

已修：`xdgConfig || join(home, '.config')`，并处理尾部斜杠。

## 3. Cursor 有三个会话存储，我们只读了一个

这是覆盖面缺口，不只是路径问题。

**magpie**（`internal/sessions/access.go:236`）：

```go
add("cursor",
	filepath.Join(CursorDir(), "chats"),              // ① CLI 的 chats
	filepath.Join(cursorDataDir(), "projects"),       // ② project transcripts
	cursorEditorDB())                                  // ③ 编辑器 globalStorage
```

三个来源的根**各不相同**：

| 来源 | 根 | 三平台一致？ |
|---|---|---|
| ① CLI `chats/<md5(cwd)>/<chat>/store.db` | `$CURSOR_CONFIG_DIR` 否则 `~/.cursor` | **是** |
| ② `projects/<slug>/agent-transcripts/<id>/` | `$CURSOR_DATA_DIR` 否则 `~/.cursor` | **是** |
| ③ 编辑器 `User/globalStorage/state.vscdb` | `os.UserConfigDir()` | **否**（按平台） |

关键在 `cursorDataDir()`（`cursor.go:62-68`）：

```go
func cursorDataDir() string {
	if d := strings.TrimSpace(appdir.Getenv("CURSOR_DATA_DIR")); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cursor")
}
```

**没有 darwin 分支，也不用 `os.UserConfigDir()`。** 所以拿
`~/Library/Application Support/Cursor` 去找 `chats/` 会永远找不到。

而编辑器那个（`cursor_editor.go:86-92`）用 `os.UserConfigDir()`——Go 的
这个函数自动按平台分派：

```go
func cursorEditorDB() string {
	dir, err := os.UserConfigDir()   // Windows %APPDATA%，macOS ~/Library/Application Support，Linux $XDG_CONFIG_HOME
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "Cursor", "User", "globalStorage", "state.vscdb")
}
```

### 我们的状态

- ③ 已支持（`editorDataCandidates`），但有个 bug：**忽略了传入的 `opts`**，
  所以"模拟 macOS"时仍用真实平台/家目录。已修。
- ① ② **完全没读**。已把 `~/.cursor` 加进 `candidateRoots()`。
- 顺带修了一个"假绿"测试：`workspaceStorage` 那条写死 `.config/Cursor/...`
  （Linux 位置），在 Windows 上从来没生效过——它一直是靠兜底路径偶然通过的。
  现在按当前平台算路径。

## 4. ZCode 在 Windows 上优先 `$HOME`

**magpie**（`internal/appdir/zcode.go:1-27` 注释 + `ZCodeHomeOn`）：

```go
// ZCode, a Node app, takes $HOME before os.homedir() on every OS:
// its data folder (getDataBaseDir: process.env.HOME?.trim() || homedir())...
// On Windows Go's is USERPROFILE and HOME is mostly unset, but one the user
// set (for Git Bash, MSYS2 or Emacs) is where ZCode keeps everything, and
// magpie wrote its provider under USERPROFILE, where ZCode never looked
// (Gearclickist on Discord: connected, no error, and no magpie in ZCode).

func ZCodeHomeOn(goos, home string) string {
	if goos != "windows" {
		return home
	}
	h := strings.TrimSpace(os.Getenv("HOME"))
	if h == "" || !rooted(h) || !strings.EqualFold(filepath.Clean(home), filepath.Clean(os.Getenv("USERPROFILE"))) {
		return home
	}
	return h
}
```

注意那个 `!strings.EqualFold(clean(home), clean(USERPROFILE))` 守卫：
只有当 `home` **就是** USERPROFILE 时才采用 HOME。测试给的自定义 home
（临时目录、WSL 的）保持原样。这条很细，但没有它，测试就没法注入。

### 我们的问题

`zcode.js` 只用 `os.homedir()`（= USERPROFILE）。设了 HOME 的 Git Bash /
MSYS2 / Emacs 用户，ZCode 数据在 `$HOME/.zcode`，我们看不到。

已修：`zcodeHomes()` 先看 `$HOME`（要求绝对路径），再 `os.homedir()`。
加了测试：把库放在"另一个 HOME"下，断言 `candidateRoots()` 和 `discover()`
都能找到——不加支持就会红。

## 5. 交叉核对过的其他家

| Agent | 上游规则 | 我们 | 结论 |
|---|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR` 否则 `~/.claude`（三平台同） | 同 | ✅ |
| Codex | `$CODEX_HOME` 否则 `~/.codex`（三平台同） | 同 | ✅ |
| Hermes | `$HERMES_HOME` 否则 Windows `%LOCALAPPDATA%\hermes`、其余 `~/.hermes` | 同 | ✅ |
| Claude Desktop | macOS `~/Library/Application Support/Claude`；Windows `%APPDATA%\Claude`；Linux `$XDG_CONFIG_HOME/Claude` | 原来只拼 `%APPDATA%`，已改 `userDataCandidates` | ⚠️ 已修 |
| MiniMax Code | `$MINIMAX_DATA_DIR` → `$MAVIS_DATA_DIR` → `~/.minimax` | 同 | ✅ |
| 用户文件夹（Downloads/Desktop/Documents） | macOS 就是 `~/<kind>`，**不能移动**；Windows 走 known folder；Linux 读 `user-dirs.dirs` | 我们用 `isProjectPath` 按名单排除，没读 `user-dirs.dirs` | 待议（见下） |

### 待议：Linux 的 `user-dirs.dirs`

magpie 在 Linux 上读 `$XDG_CONFIG_HOME/user-dirs.dirs` 拿真实的下载/桌面/文档
目录（中文桌面是 `~/下载`）。我们 `isProjectPath` 用的是英文名单
（`downloads` / `desktop` / …）。

后果：**中文 Linux 桌面上 `~/下载` 不会被排除**，可能作为"项目"出现在列表里。
影响不大（多一行噪声），但不是零。没做，因为需要解析 `user-dirs.dirs`，
而它的格式是 shell 赋值语句，手写解析要小心。记在这里，下轮再议。

## 6. 这轮改了什么（对应代码）

| 文件 | 改动 |
|---|---|
| `src/platform.js` | 新增 `joinFor(platform, ...)`；`userDataCandidates` / `dataCandidates` / `editorDataCandidates` 全部改用它；认 `XDG_CONFIG_HOME` / `XDG_DATA_HOME`；`editorDataCandidates` 补 `opts` 透传 |
| `src/scanners/zcode.js` | 新增 `zcodeHomes()`，Windows 上优先 `$HOME` |
| `src/scanners/cursor.js` | 补 CLI 的两个数据根（`~/.cursor/chats`、`~/.cursor/projects`）；`projectFromWorkspaceJson` 的 `User` 切分不再依赖 `path.sep` |
| `test/platform.test.js` | 新增 3 条：分隔符按目标平台（**断言原始值，不做归一**）、XDG_CONFIG_HOME、根目录边界 |
| `test/zcode.test.js` | 新增 1 条：`$HOME` 里的数据也能发现 |
| `test/cursor.test.js` | `workspaceStorage` 用例改成按当前平台算路径（原来在 Windows 上是假绿） |

验证：445/445 全绿；`research/probes/verify-posix.mjs` 8/8。

## 7. 仍然没验证的（诚实清单）

- **没在任何 Mac / Linux 上真机跑过。** 本文全部是"上游这么写 + 我们这么写"，
  不是"系统这么表现"。
- 大小写不敏感（macOS APFS 默认）只在 `pathKey()` 里做了逻辑处理，没实测。
- 符号链接（`/Users` vs `/home`、`/opt/homebrew` 软链）没实测。
- `user-dirs.dirs` 的本地化目录名没处理（见 §5）。
- CI 的 macOS job 这轮才改成必跑，**第一次跑的结果还不知道**。
