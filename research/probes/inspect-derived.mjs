import { listArtifacts, deriveStats } from '../../src/derive.js';

const stats = deriveStats();
console.log('衍生库:', stats.total, '条');
for (const g of stats.groups) {
  console.log(`  ${g.kind} · ${g.model} · ${g.promptVersion}: ${g.count} 条`);
}

console.log('\n条目:');
for (const a of listArtifacts({ limit: 20 })) {
  const preview = String(a.subject);
  console.log(`  [${a.kind}] ${preview}  ${a.size} 字节  ${a.createdAt.toISOString().slice(0, 16)}`);
}
