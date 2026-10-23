import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLI 命令的退出码回归。
 *
 * 用 spawnSync 而不是 cmd 批处理：`%ERRORLEVEL%` 在括号块里会提前展开，
 * 拿到的永远是上一次的值，等于没测。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', '..', 'src', 'cli.js');

// [参数数组, 期望退出码, 说明]
const cases = [
  [['projects'], 0, '列项目'],
  [['timeline', '.'], 0, '时间线'],
  [['agents', '.'], 0, 'Agent 分布'],
  [['stats'], 0, '统计'],
  [['doctor'], 0, '采集体检'],
  [['secrets'], 0, '凭证扫描'],
  [['llm'], 0, '模型配置'],
  [['search', '迁移'], 0, '搜索'],
  [['export', '.'], 0, '导出时间线'],
  [['mcp', '--json'], 0, 'MCP 配置'],
  [['cat', '--project', '.'], 0, '读正文'],
  [['digest', 'E:/car'], 0, '估算不需要凭证'],
  [['digest', 'E:/car', '--run'], 2, '未配置模型时 --run 应退出 2'],
  [['refresh'], 0, '派生数据审计'],
  [['refresh', '--run'], 2, '未配置模型时 refresh --run 应退出 2'],
  [['search'], 2, '缺搜索词应退出 2'],
  [['timeline'], 2, '缺项目路径应退出 2'],
  [['cat', 'zzzz_nonexistent_zzzz'], 2, '找不到会话应退出 2'],
  [['no-such-command'], 2, '未知命令应退出 2'],
];

const results = [];
for (const [args, want, label] of cases) {
  const r = spawnSync(process.execPath, ['--no-warnings', cli, ...args], {
    encoding: 'utf8',
    timeout: 120000,
  });
  const got = r.status;
  results.push([label, got === want, `期望 ${want}，实际 ${got}`]);
}

let pass = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '通过' : '失败'}  ${name}  (${detail})`);
  if (ok) pass++;
}
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
