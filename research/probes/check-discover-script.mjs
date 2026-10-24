import fs from 'node:fs';

const t = fs.readFileSync('research/probes/mac-discover.mjs', 'utf8');
const noComments = t.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');

const checks = [
  ['没有硬编码反斜杠路径', !/`[^`]*\\\\[A-Za-z][^`]*`/.test(noComments)],
  ['没有 CommonJS require', !/[^.\w]require\(/.test(noComments)],
  ['sqlite 缺失能降级', /if \(!DatabaseSync\)/.test(t)],
  ['只有一个 writeFileSync（写报告）', (t.match(/fs\.writeFileSync/g) || []).length === 1],
  ['报告写在 tmpdir', /path\.join\(os\.tmpdir\(\)/.test(t)],
  ['用 which 探测可执行文件', /execFileSync\('which'/.test(t)],
  ['跳过备份目录避免误判主库', /backup\|backups\|cache\|tmp/.test(t)],
  ['主库按大小+名字打分选，不取第一个', /findMainDb/.test(t) && /cands\.sort/.test(t)],
  ['结论区分已支持与未适配', /SUPPORTED/.test(t) && /supportedBy/.test(t)],
];

let bad = 0;
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${n}`);
}

// 写操作目标检查
const writes = [...t.matchAll(/fs\.writeFileSync\(([^,]+),/g)].map((m) => m[1].trim());
console.log(`\n写操作目标：${writes.join(', ') || '(无)'}`);

console.log(`\n${bad === 0 ? '全部通过' : bad + ' 项失败'}`);
process.exit(bad ? 1 : 0);
