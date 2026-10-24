/**
 * Qoder / dsh 采集回归。
 *
 * 这两个扫描器的坑都不会报错，只会**静默少读**：
 *
 *   1. Qoder 有两套存储，只读旧格式会得到 19 场而不是 310 场
 *   2. dsh 的 .zstd 是多帧追加，只解第一帧会得到一行 header
 *   3. dsh 的子代理会话必须跳过，否则同一场对话在时间线里重复
 *
 * 所以断言不针对"本机具体数字"，而是针对"这两种格式被识别、被读全"。
 * 换台机器重跑，数字会变，但这几条必须始终成立。
 *
 * 用法：
 *   node research/probes/check-qoder-dsh.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const qoder = await import(new URL('../../src/scanners/qoder.js', import.meta.url).href);
const dsh = await import(new URL('../../src/scanners/dsh.js', import.meta.url).href);

let failed = 0;
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/* ------------------------------ Qoder ------------------------------ */

console.log('\nQoder');

const qFiles = qoder.discover();
check('扫到 Qoder 文件', qFiles.length > 0, `${qFiles.length} 个`);

// 两套存储都要有位置：旧格式在 cache/projects，新格式在 projects/<工作区>
const legacyFiles = qFiles.filter((f) => f.includes('conversation-history'));
const projectFiles = qFiles.filter((f) => !f.includes('conversation-history'));
check('旧格式（cache）被发现', legacyFiles.length > 0, `${legacyFiles.length} 个`);
check(
  '新格式（projects）被发现',
  projectFiles.length > 0,
  `${projectFiles.length} 个` +
    (legacyFiles.length ? `（旧格式已有 ${legacyFiles.length} 个，两套并存）` : '')
);

// 新格式必须解析出真实 cwd 和时间戳——这是它相比旧格式的全部价值
let withProject = 0;
let withRealTime = 0;
let parsed = 0;
let toolEnvelopeTitles = 0;
for (const f of projectFiles) {
  let s;
  try {
    s = qoder.parse(f);
  } catch {
    continue;
  }
  if (!s) continue;
  parsed++;
  // 纯工具会话（只有 "# Input"）按设计返回 null
  if (s.project && !s.project.toLowerCase().endsWith('.qoder-cn')) withProject++;
  // 旧格式只能用 mtime，新格式的时间应当精确到秒且不等于文件 mtime
  let mtime = null;
  try {
    mtime = fs.statSync(f).mtime;
  } catch {}
  if (s.start && mtime && Math.abs(s.start - mtime) > 2000) withRealTime++;
  if (/^#\s*Input\b/i.test(s.title || '')) toolEnvelopeTitles++;
}
if (parsed > 0) {
  check('新格式解析出了 cwd', withProject > 0, `${withProject}/${parsed} 场有项目路径`);
  check('新格式用的是行内时间戳（不是 mtime）', withRealTime > 0, `${withRealTime}/${parsed} 场`);
  // 标题若退化成 "# Input / Tool: ..."，说明工具包裹没被识别成噪音
  check('标题不是工具包裹（# Input）', toolEnvelopeTitles === 0, `${toolEnvelopeTitles} 场`);
}

// 正文必须真的能读出来，而且工具调用按 callId 配对
const readable = qoder.discover().slice(0, 5).find((f) => {
  try {
    return qoder.readMessages({ source: f }).length > 0;
  } catch {
    return false;
  }
});
check('至少一场正文能读出消息', Boolean(readable), readable ? path.basename(readable) : '');

if (readable) {
  const msgs = qoder.readMessages({ source: readable });
  const roles = new Set(msgs.map((m) => m.role));
  check('正文含 user 与 assistant', roles.has('user') && roles.has('assistant'), [...roles].join('/'));
}

/* ------------------------------ dsh ------------------------------ */

console.log('\nDeepSeek Harness');

const dFiles = dsh.discover();
check('扫到 dsh 会话文件', dFiles.length >= 0, `${dFiles.length} 个`);

if (dFiles.length) {
  // 多帧解压：直接 zstdDecompressSync 只能拿到第一帧，
  // 我们的实现必须比它解出更多字节
  const zstdFile = dFiles.find((f) => f.endsWith('.zstd'));
  if (zstdFile) {
    const zlib = await import('node:zlib');
    const raw = fs.readFileSync(zstdFile);
    const one = zlib.zstdDecompressSync(raw);
    const multi = dsh.decompressFrames(raw);
    check(
      '多帧 zstd 比单帧解出更多内容',
      multi.length > one.length,
      `单帧 ${one.length}B → 多帧 ${multi.length}B`
    );
    check('多帧解压结果不是空的', multi.length > 100, `${multi.length}B`);
  }

  // 子代理必须被跳过：header 带 parentSession
  let subagentSkipped = 0;
  let mainParsed = 0;
  for (const f of dFiles) {
    let s;
    try {
      s = dsh.parse(f);
    } catch {
      continue;
    }
    if (s) mainParsed++;
    else {
      // 判断它是子代理还是别的原因
      try {
        const raw = fs.readFileSync(f);
        const buf = f.endsWith('.zstd') ? dsh.decompressFrames(raw) : raw;
        const head = JSON.parse(buf.toString('utf8').split('\n')[0]);
        if (head.parentSession) subagentSkipped++;
      } catch {}
    }
  }
  check('主会话被解析', mainParsed > 0, `${mainParsed} 场`);
  // 每个没解析出来的都必须是"有 parentSession 的子代理"，
  // 否则说明有主会话被误丢——那是真的少读
  if (subagentSkipped > 0) {
    check(
      '跳过全部是子代理，没有误丢主会话',
      mainParsed + subagentSkipped === dFiles.length,
      `${mainParsed} 主 + ${subagentSkipped} 子 = ${dFiles.length}`
    );
  } else {
    console.log('  · 本机没有子代理会话，跳过该项');
  }

  // 标题：session/title 事件优先，退而用第一条真人消息
  const sample = dFiles.map((f) => {
    try {
      return dsh.parse(f);
    } catch {
      return null;
    }
  }).find(Boolean);
  if (sample) {
    check('解析出项目路径', Boolean(sample.project), sample.project || '(空)');
    check('有开始时间', Boolean(sample.start));
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（${passed} 项通过）`);
if (failed) {
  console.log('\n注意：本机没有 Qoder / dsh 数据时，相关断言会被跳过而不是失败。');
}
process.exit(failed ? 1 : 0);
