#!/usr/bin/env node
/**
 * 在另一台机器上跑完整的验证（macOS / Linux）。
 *
 * ## 为什么需要
 *
 * 这个项目要装到所有人的机器上，但开发机只有 Windows。CI 能覆盖一部分，
 * 可"真的在这台 Mac 上读一次数据"仍然只有真机能做。
 *
 * 手工步骤容易漏（版本对不对、有没有装依赖、跑的是哪份代码），所以固化成一个
 * 命令：把**当前 HEAD 的受版本控制的文件**打包传过去，在远端解开、跑测试、
 * 把结果带回来。
 *
 * ## 为什么不 git clone
 *
 * 仓库可能是私有的，远端机器也不一定有你的凭据。用 `git archive` 传当前
 * 这份代码更可靠：测的就是你本地这个 commit，不受远端网络与认证影响。
 *
 * ## 为什么不装依赖
 *
 * 这个项目零依赖，`npm test` 不需要 `npm install`。所以整条链路只要求远端有
 * Node ≥ 22.15 —— 版本不对会由入口的能力自检直接说清楚。
 *
 * ## 用法
 *
 *   node research/probes/remote-verify.mjs --host user@192.168.1.9
 *   node research/probes/remote-verify.mjs --host mac --user alice
 *   node research/probes/remote-verify.mjs --host mac --dry-run     # 只打印要做什么
 *
 * 前提：远端开了「远程登录」（macOS：系统设置 → 通用 → 共享 → 远程登录），
 * 并且你本机能免密登录（推荐先把公钥加到远端 ~/.ssh/authorized_keys）。
 *
 * 全程只写远端的临时目录，跑完删掉；不碰远端任何 Agent 的真实数据
 * ——测试自己造假数据，这点见 test/helpers.js 的沙箱。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const usage = () => {
  console.log(`用法: node research/probes/remote-verify.mjs --host <user@host> [--dry-run] [--keep] [--node-bin DIR]

  --host      远端（macOS/Linux），形如 user@192.168.1.9
  --node-bin  远端没装 Node 时，指向临时解压出来的 bin 目录（只在本次会话生效）
  --dry-run   只打印将要执行的命令，不真的连
  --keep      跑完保留远端临时目录（默认删掉，方便看现场时用）

远端需要：Node >= 22.15、能免密 ssh 登录。`);
};

const host = opt('host');
if (!host) {
  usage();
  process.exit(2);
}
if (!/^[\w.@:+-]+$/.test(host)) {
  console.error(`--host 取值可疑：${host}`);
  process.exit(2);
}

const dry = has('dry-run');
const keep = has('keep');
const repo = process.cwd();
const remoteDir = `/tmp/agent-archive-verify-${Date.now()}`;
// 远端没装 Node 时，可以指向一个临时解压出来的 Node（见 README 的说明）
const nodeBin = opt('node-bin', null);
// 默认用一把专门为验证生成的钥匙，免得和日常 key 混在一起
const identity = opt('identity', path.join(os.homedir(), '.ssh', 'id_ed25519_agentarchive'));
const sshOpts = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'IdentitiesOnly=yes',
  '-i', identity,
];

/** 生成当前 HEAD 的 tar 流（只含受版本控制的文件）。 */
function archive() {
  const r = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: repo,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error('git archive 失败（当前目录是 git 仓库吗？）：' + String(r.stderr || ''));
  }
  return r.stdout;
}

/** 远端要跑的脚本。一步失败就停，并把失败点打出来。 */
function remoteScript() {
  // 远端可能没装 Node（比如一台干净的 Mac）：允许把临时解压出来的 node bin
  // 目录塞进 PATH。这不改变系统环境，只在这次 ssh 会话里生效。
  const pathPrefix = nodeBin ? `export PATH=${JSON.stringify(nodeBin)}:$PATH\n` : '';
  return `
set -e
${pathPrefix}cd /tmp
mkdir -p ${remoteDir}
cd ${remoteDir}
tar -xf /tmp/aa-verify.tar
echo "=== 环境 ==="
node -v
node -e "const z=require('node:zlib');const s=require('node:sqlite');if(typeof z.zstdDecompressSync!=='function'||typeof s.DatabaseSync!=='function'){console.error('缺 zstd 或 node:sqlite（Node 需要 >= 22.15）');process.exit(1)}console.log('能力自检通过', process.platform, process.arch)"
echo "=== 测试 ==="
npm test
echo "=== 打包检查 ==="
# macOS 的 BSD tail 不认 \`-5\`，必须写 \`-n 5\`（第一版就踩了）
npm pack --dry-run 2>&1 | tail -n 5
`;
}

const sshArgs = (command) => {
  const base = sshOpts.slice();
  if (command === null) return base.concat([host]);
  return base.concat([host, command]);
};

if (dry) {
  console.log('将要执行：');
  console.log(`  1. git archive --format=tar HEAD   → /tmp/aa-verify.tar`);
  console.log(`  2. scp /tmp/aa-verify.tar ${host}:/tmp/aa-verify.tar`);
  console.log(`  3. ssh ${host} 'bash -lc "<解包并跑 npm test>"'`);
  console.log(`  4. 远端目录：${remoteDir}${keep ? '（保留）' : '（跑完删除）'}`);
  process.exit(0);
}

// 1) 打包
let tar;
try {
  tar = archive();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const localTar = path.join(os.tmpdir(), `aa-verify-${Date.now()}.tar`);
fs.writeFileSync(localTar, tar);
console.log(`已打包当前 HEAD：${(tar.length / 1024).toFixed(0)} KB`);

// 2) 传过去
const scp = spawnSync('scp', [...sshOpts, localTar, `${host}:/tmp/aa-verify.tar`], {
  encoding: 'utf8',
  timeout: 180000,
});
if (scp.status !== 0) {
  console.error('传文件失败。常见原因：');
  console.error('  · 远端没开「远程登录」（macOS：系统设置 → 通用 → 共享 → 远程登录）');
  console.error('  · 没配免密登录（把本机公钥加到远端 ~/.ssh/authorized_keys）');
  console.error('  · 地址/用户名不对，或不在同一网络');
  console.error(String(scp.stderr || '').trim());
  try {
    fs.unlinkSync(localTar);
  } catch {
    /* ignore */
  }
  process.exit(1);
}
try {
  fs.unlinkSync(localTar);
} catch {
  /* ignore */
}

// 3) 远端执行
// 脚本走 **stdin**（bash -s），不当参数传：把带换行的脚本塞进一个 shell 参数
// 需要跨 cmd → ssh → 远端 shell 三层转义，`\n` 会被 JSON 转义成字面量而
// 不是换行（第一版就这么失败的，症状是整段脚本被当成一行、什么也没跑）。
const script = remoteScript();
const ssh = spawnSync('ssh', sshArgs('bash -s'), {
  input: script,
  encoding: 'utf8',
  timeout: 600000,
  maxBuffer: 64 * 1024 * 1024,
});

process.stdout.write(ssh.stdout || '');
if (ssh.stderr) process.stderr.write(ssh.stderr);

// 4) 清理
if (!keep) {
  spawnSync('ssh', sshArgs(`rm -rf ${remoteDir} /tmp/aa-verify.tar`), { encoding: 'utf8', timeout: 60000 });
} else {
  console.log(`\n远端目录保留：${remoteDir}`);
}

if (ssh.status !== 0) {
  console.error(`\n✗ 远端验证失败（退出码 ${ssh.status}）。上面是完整输出。`);
  process.exit(1);
}
console.log('\n✓ 远端验证通过');
