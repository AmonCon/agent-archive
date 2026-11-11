/** 收尾复核：detectGaps() 的覆盖率清单（21 家 + blocked 口径）。纯只读。 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { detectGaps } = await import(pathToFileURL(path.join(REPO, 'src', 'doctor.js')).href);
const gaps = detectGaps();
const supported = gaps.filter((g) => g.supported);
const unsupported = gaps.filter((g) => !g.supported);
console.log(`清单共 ${gaps.length} 条：supported=${supported.length} unsupported=${unsupported.length}`);
console.log('\n-- 已接入（supported）--');
for (const g of supported) {
  console.log(`  ${String(g.agent).padEnd(12)} present=${g.present} blocked=${g.blocked || '无'}`);
}
console.log('\n-- 未接入 --');
for (const g of unsupported) {
  console.log(`  ${String(g.agent).padEnd(12)} present=${g.present} blocked=${g.blocked || '无'}`);
}
const cline = gaps.find((g) => g.agent === 'cline');
console.log(`\ncline: supported=${cline && cline.supported} blocked=${cline && (cline.blocked || '无')}（应 supported=true、blocked=无）`);
const contraditions = gaps.filter((g) => g.supported && g.blocked);
console.log(`自相矛盾（已接入却标 blocked）: ${contraditions.length} 条`);
