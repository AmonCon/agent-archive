/**
 * 新增扫描器接线自检（收尾注册前跑一次）。
 *
 * 只 import 模块、检查导出形状，不扫本机、不读任何真实会话、不写任何文件。
 * 目的：把「注册进 registry.js 才发现 import 失败 / 导出缺一半 / name 撞车」
 * 这类集成期才暴露的问题提前到交付核验阶段。
 *
 * 用法：node research/probes/verify-new-scanners.mjs
 * 传参可追加候选名：node ... pi omp cline
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gemini', 'openclaw', 'codebuddy', 'pi', 'omp', 'cline', 'kimi', 'grokbuild', 'mcode'];

const REQUIRED = ['name', 'discover', 'candidateRoots', 'structureSpec', 'discoverWithin', 'readMessages'];
const SPEC_KEYS = ['agent', 'probes', 'rootAnchor', 'dataPaths', 'format', 'minScore'];

let failed = 0;
const seenNames = new Set();

for (const n of CANDIDATES) {
  const file = path.resolve('src', 'scanners', `${n}.js`);
  const fs = await import('node:fs');
  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${n}: 文件还没落地（teammate 仍在写）`);
    continue;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    console.log(`FAIL  ${n}: import 抛错 → ${e && e.message}`);
    failed++;
    continue;
  }

  const problems = [];
  for (const k of REQUIRED) {
    if (mod[k] === undefined) problems.push(`缺导出 ${k}`);
  }
  if (typeof mod.name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(mod.name)) {
    problems.push(`name 非法：${String(mod.name)}`);
  } else if (seenNames.has(mod.name)) {
    problems.push(`name 撞车：${mod.name}`);
  } else {
    seenNames.add(mod.name);
  }
  if (typeof mod.parse !== 'function' && typeof mod.parseAll !== 'function') {
    problems.push('parse / parseAll 一个都没有');
  }
  const spec = mod.structureSpec;
  if (spec && typeof spec === 'object') {
    for (const k of SPEC_KEYS) if (spec[k] === undefined) problems.push(`structureSpec 缺 ${k}`);
    if (spec.agent !== mod.name) problems.push(`structureSpec.agent(${spec.agent}) ≠ name(${mod.name})`);
    if (!Array.isArray(spec.probes) || !spec.probes.length) problems.push('structureSpec.probes 为空');
    if (!Array.isArray(spec.dataPaths) || !spec.dataPaths.length) problems.push('structureSpec.dataPaths 为空');
  }
  if (typeof mod.discoverWithin === 'function' && mod.discoverWithin.length < 1) {
    problems.push('discoverWithin 不接受 roots 参数');
  }

  if (problems.length) {
    console.log(`FAIL  ${n}: ${problems.join('；')}`);
    failed++;
  } else {
    console.log(
      `OK    ${n}: name=${mod.name} parse=${typeof mod.parse === 'function' ? 'parse' : 'parseAll'}` +
      ` probes=${spec.probes.length} anchor=${JSON.stringify(spec.rootAnchor)} minScore=${spec.minScore}`
    );
  }
}

console.log(`\n结果：${CANDIDATES.length} 家候选，失败 ${failed} 家${failed ? '（需修复）' : '（全部可注册）'}`);
process.exitCode = failed ? 1 : 0;
