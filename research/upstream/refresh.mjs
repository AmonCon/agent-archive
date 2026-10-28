#!/usr/bin/env node
/**
 * 上游参照项目的增量跟踪。
 *
 * ## 为什么要有这个脚本
 *
 * MAGPIE 每天在改。靠"重新通读一遍"来跟上游，成本会随项目变大而失控，
 * 而且每次重读都会重新推导同样的结论——人力和判断力都浪费在重复劳动上。
 *
 * 正确的做法是把它当成一个**长期订阅源**：
 *   - sources.json 记住"我们读到哪一版"（commit）
 *   - 这个脚本告诉我们"从那一版到现在，哪些文件变了"
 *   - 我们只读变化的部分，把结论沉淀进 LESSONS.md
 *
 * 于是"继续研究"变成一次几分钟的 diff 复核，而不是又一轮通读。
 *
 * ## 用法
 *
 *   node research/upstream/refresh.mjs            只看有没有新提交
 *   node research/upstream/refresh.mjs --diff     拉新版本并列出改动文件
 *   node research/upstream/refresh.mjs --update   确认已读完，把 pin 推进到最新
 *   node research/upstream/refresh.mjs --diff --update
 *
 * 本地镜像放在 `~/.agent-archive/upstream-cache/<id>`，不进仓库——
 * 这些是别人的源码，仓库里只保留"读到哪一版"和"学到了什么"。
 *
 * 零依赖：只用 git 和 node 标准库。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = path.join(HERE, 'sources.json');

/** 只看这些子树：其余（UI、i18n、打包）与"读别人家会话"无关。 */
const WATCHED = {
  magpie: ['internal/sessions', 'internal/provider', 'LESSONS.md', 'docs'],
  'cc-switch': [
    'src-tauri/src/session_manager',
    'src-tauri/src/codex_state_db.rs',
    'src-tauri/src/codex_rollout_file.rs',
    'src-tauri/src/services',
    'tests',
    'session-manager.md',
  ],
  autoswarm: ['src/autoswarm', 'tests/fixtures', 'scripts', 'docs'],
};

const args = new Set(process.argv.slice(2));
const wantDiff = args.has('--diff');
const wantUpdate = args.has('--update');

function cacheDir(id) {
  return path.join(os.homedir(), '.agent-archive', 'upstream-cache', id);
}

function git(cwd, argv, opts = {}) {
  const r = spawnSync('git', argv, {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
    ...opts,
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function remoteHead(repo) {
  const r = spawnSync('git', ['ls-remote', repo, 'HEAD'], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return null;
  const line = String(r.stdout || '').trim().split('\n')[0];
  return line ? line.split(/\s+/)[0] : null;
}

/**
 * 保证本地有一份能对比的镜像。
 *
 * 用 `--filter=blob:none` + 较浅的历史：我们只需要看"最近改了什么"，
 * 不需要完整历史，也不需要每个文件的历史版本。首次 clone 之后每次只 fetch。
 */
function ensureMirror(src) {
  const dir = cacheDir(src.id);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const f = git(dir, ['fetch', '--depth', '200', 'origin', 'HEAD']);
    if (!f.ok) return { dir: null, error: f.err || 'fetch 失败' };
  } else {
    // 上一次克隆可能中断，留下一个没有 .git 的目录。先清掉再克隆，
    // 否则 git 会以 "destination path already exists" 直接失败。
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清不掉就让 clone 自己报错 */
      }
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const c = spawnSync(
      'git',
      ['clone', '--filter=blob:none', '--depth', '200', src.repo, dir],
      { encoding: 'utf8', timeout: 300000 }
    );
    if (c.status !== 0) {
      // git 的 stderr 混着进度输出，只取最后一行"fatal:"更像原因
      const lines = String(c.stderr || '').trim().split('\n');
      const fatal = lines.filter((l) => /^(fatal|error):/.test(l)).join(' | ');
      return { dir: null, error: fatal || lines.slice(-1)[0] || 'clone 失败' };
    }
  }

  // 浅克隆里可能没有我们 pin 的那个提交（上游做过 force-push 或压缩历史）。
  // 显式按 SHA 补取一次，diff 才有旧端可以对比。GitHub 允许 fetch 任意 SHA。
  const has = git(dir, ['cat-file', '-e', `${src.commit}^{commit}`]);
  if (!has.ok) {
    const bySha = git(dir, ['fetch', '--depth', '1', 'origin', src.commit]);
    if (!bySha.ok) {
      return { dir, error: `取不到 pin 的提交 ${src.commit.slice(0, 8)}（上游可能重写过历史）` };
    }
  }
  return { dir };
}

function summarizeChanges(dir, from, to, watched) {
  // 只取我们关心的子树里的变化
  const pathspec = watched.flatMap((p) => [p]);
  const r = git(dir, ['diff', '--name-status', `${from}..${to}`, '--', ...pathspec]);
  if (!r.ok) return { error: r.err || 'diff 失败' };
  const lines = r.out ? r.out.split('\n').filter(Boolean) : [];

  const stat = git(dir, ['diff', '--shortstat', `${from}..${to}`, '--', ...pathspec]);
  return { files: lines, shortstat: stat.ok ? stat.out : '' };
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  let drifted = 0;

  for (const src of cfg.sources) {
    const head = remoteHead(src.repo);
    if (!head) {
      console.log(`? ${src.id.padEnd(10)} 取不到远端（网络或仓库不可达）`);
      continue;
    }

    const same = head === src.commit;
    console.log(
      `${same ? '=' : '↑'} ${src.id.padEnd(10)} ${src.commit.slice(0, 8)} → ${head.slice(0, 8)}` +
        (same ? '  （与记录一致）' : '  （有新提交）')
    );

    if (same) continue;
    drifted++;

    if (!wantDiff) continue;

    const { dir, error } = ensureMirror(src);
    if (!dir) {
      console.log(`    读不了镜像：${error}`);
      continue;
    }
    if (error) {
      console.log(`    ${error}`);
      console.log(`    退化为只看最新一次提交的改动：`);
      const last = git(dir, ['show', '--stat', '--oneline', 'HEAD']);
      if (last.ok) for (const l of last.out.split('\n').slice(0, 15)) console.log(`      ${l}`);
      if (wantUpdate) {
        src.commit = head;
        src.fetchedAt = new Date().toISOString().slice(0, 10);
        console.log(`    pin 已更新到 ${head.slice(0, 8)}（旧历史不可得，从这一版重新计）`);
      }
      continue;
    }

    // 新 clone 的历史是浅的，用 head 所在的本地引用
    const to = 'FETCH_HEAD';
    const changes = summarizeChanges(dir, src.commit, to, WATCHED[src.id] || ['.']);
    if (changes.error) {
      console.log(`    对比失败：${changes.error}（可能是浅克隆里没有旧提交）`);
      console.log(`    建议：cd ${dir} && git fetch --unshallow`);
      continue;
    }

    console.log(`    关注范围内改动 ${changes.files.length} 个文件 ${changes.shortstat}`);
    for (const line of changes.files.slice(0, 40)) console.log(`      ${line}`);
    if (changes.files.length > 40) console.log(`      …还有 ${changes.files.length - 40} 个`);

    if (wantUpdate) {
      src.commit = head;
      src.fetchedAt = new Date().toISOString().slice(0, 10);
      console.log(`    pin 已更新到 ${head.slice(0, 8)}`);
    }
  }

  if (drifted && !wantUpdate) {
    console.log(
      '\n有新提交。读完后用 --update 推进 pin，并把结论写进 research/upstream/LESSONS.md。'
    );
  } else if (!drifted) {
    console.log('\n全部与记录一致，没有新东西要读。');
  }

  fs.writeFileSync(SOURCES, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

main();
