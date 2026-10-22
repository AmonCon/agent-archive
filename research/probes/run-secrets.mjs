import { scanSecrets } from '../../src/secrets.js';

const r = scanSecrets();

if (!r.ready) {
  console.log('索引不可用:', r.message);
  process.exit(1);
}

console.log(`扫描 ${r.scanned} 场会话，命中 ${r.findings.length} 条\n`);

for (const f of r.findings) {
  console.log(`[${f.severity}] ${f.label}`);
  console.log(`   ${f.agent} · ${String(f.title).slice(0, 46)}`);
  console.log(`   出现 ${f.occurrences} 次 · ${f.samples.map((s) => s.masked).join(', ')}`);
  console.log(`   上下文: ${f.context.slice(0, 150)}`);
  console.log('');
}

// 按类型汇总
const byType = {};
for (const f of r.findings) {
  const k = `${f.severity}|${f.label}`;
  byType[k] = (byType[k] || 0) + 1;
}
console.log('=== 按类型 ===');
for (const [k, v] of Object.entries(byType).sort()) {
  const [sev, label] = k.split('|');
  console.log(`  [${sev}] ${label}: ${v} 场`);
}
