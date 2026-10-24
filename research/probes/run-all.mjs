import { spawnSync } from 'node:child_process';

const suites = [
  ['环境层', 'research/probes/check-env.mjs'],
  ['平台路径', 'research/probes/check-platform.mjs'],
  ['CLI', 'research/probes/check-cli.mjs'],
  ['MCP 工具', 'research/probes/check-mcp.mjs'],
  ['可移植性 lint', 'research/probes/lint-portability.mjs'],
  ['路径审计', 'research/probes/audit-paths.mjs'],
];

let failed = 0;
for (const [name, file] of suites) {
  const r = spawnSync(process.execPath, ['--no-warnings', file], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.trim().split(/\r?\n/);
  // 抓最后几行结论
  const tail = lines.slice(-3).filter((l) => l.trim()).join(' | ');
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(14)} ${tail.slice(0, 130)}`);
}

console.log(`\n${failed === 0 ? '全部套件通过' : failed + ' 个套件失败'}`);
process.exit(failed ? 1 : 0);
