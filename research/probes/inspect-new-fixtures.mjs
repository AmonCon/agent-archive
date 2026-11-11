/**
 * 登记新样本前，模拟 test/fixtures-contract.test.js 的真实环境拿实测值。
 *
 * 关键：契约测试用 sandbox() 把 HOME/APPDATA 等重定向到临时家目录，
 * 那样各家 readMessages 的「本机根」就是 sandbox home，越界校验才会通过。
 * 直接调 parse 而不重定向 HOME 会被 assertUnderAny 拒绝（不是 scanner 的 bug）。
 *
 * 这里按候选 FIXTURES 的路径物化样本，跑 discover → scanAll → readMessages，
 * 打印每家真实的会话数 / title / project / 正文文本，供写准 expect。
 * 只读 + 系统 temp，不碰本机真实数据、不改仓库文件。
 * 用法：node research/probes/inspect-new-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox } from '../../test/helpers.js';

const REPO = path.resolve('.');
const SAMPLES = path.join(REPO, 'test', 'fixtures', 'samples');
const registry = await import(pathToFileURL(path.join(REPO, 'src', 'registry.js')).href);
const { clearTranscriptCache } = await import(pathToFileURL(path.join(REPO, 'src', 'transcript-cache.js')).href);

/** 候选登记：样本文件 → 假家目录里的相对路径（与各家 discover 的真实形状一致）。 */
const CASES = [
  { key: 'gemini', scanner: 'gemini', files: {
    'gemini-replay.jsonl': '.gemini/tmp/h1/chats/session-replay.jsonl',
    'gemini-legacy.json': '.gemini/tmp/h2/chats/session-legacy.json',
  } },
  { key: 'openclaw', scanner: 'openclaw', files: {
    'openclaw-session.jsonl': '.openclaw/agents/main/sessions/s1.jsonl',
    'openclaw-sessions.json': '.openclaw/agents/main/sessions/sessions.json',
  } },
  { key: 'codebuddy', scanner: 'codebuddy', files: {
    'codebuddy-session.jsonl': '.codebuddy/projects/E--demo-project/aaaaaaaa-1111-4222-8333-444444444444.jsonl',
  } },
  { key: 'pi', scanner: 'pi', files: {
    'pi-tree.jsonl': '.pi/agent/sessions/pi-demo/20261105_pi-tree.jsonl',
  } },
  { key: 'omp', scanner: 'omp', files: {
    'omp-title.jsonl': '.omp/agent/sessions/20261105_omp-title.jsonl',
  } },
  { key: 'cline', scanner: 'cline', files: {
    'cline-manifest.json': '.cline/data/sessions/cline-demo/cline-demo.json',
    'cline-messages.json': '.cline/data/sessions/cline-demo/cline-demo.messages.json',
  } },
  { key: 'kimi', scanner: 'kimi', files: {
    'kimi-state.json': '.kimi-code/sessions/ws/k1/state.json',
    'kimi-wire.jsonl': '.kimi-code/sessions/ws/k1/agents/main/wire.jsonl',
  } },
  { key: 'grokbuild', scanner: 'grokbuild', files: {
    'grokbuild-summary.json': '.grok/sessions/E--demo/g1/summary.json',
    'grokbuild-chat-history.jsonl': '.grok/sessions/E--demo/g1/chat_history.jsonl',
    'grokbuild-updates.jsonl': '.grok/sessions/E--demo/g1/updates.jsonl',
  } },
  { key: 'mcode', scanner: 'mcode', files: {
    'mcode-messages.jsonl': '.minimax/v2/sessions/2026/01/01/00-00-00-000-session_YWJj/messages.jsonl',
  } },
];

function textsOf(messages) {
  return (messages || [])
    .flatMap((m) => m.parts || [])
    .filter((p) => p.kind === 'text')
    .map((p) => p.text);
}

for (const c of CASES) {
  const box = sandbox('aa-fixture-');
  try {
    const result = await box.run(async () => {
      for (const [sample, rel] of Object.entries(c.files)) {
        box.write(rel, fs.readFileSync(path.join(SAMPLES, sample)));
      }
      registry.clearScanCache();
      clearTranscriptCache();
      const scanner = registry.scanners.find((s) => s.name === c.scanner);
      if (!scanner) return { error: `注册表里没有 ${c.scanner}` };
      const discovered = scanner.discover();
      const stats = registry.scanAll({ noCache: true });
      const mine = stats.sessions.filter((s) => s.agent === c.scanner);
      const main = mine.find((s) => s.kind === 'main') || mine[0];
      let texts = [];
      let readError = null;
      if (main) {
        try {
          texts = textsOf(scanner.readMessages(main));
        } catch (e) {
          readError = e.message;
        }
      }
      return {
        discovered: discovered.length,
        sessions: mine.length,
        titles: mine.map((s) => s.title),
        projects: mine.map((s) => s.project),
        mainTitle: main && main.title,
        mainProject: main && main.project,
        texts,
        readError,
      };
    });
    console.log(`\n=== ${c.key} (${c.scanner}) ===`);
    if (result.error) { console.log(`  ERROR ${result.error}`); continue; }
    console.log(`  discovered=${result.discovered} sessions=${result.sessions}`);
    console.log(`  titles=${JSON.stringify(result.titles)} projects=${JSON.stringify(result.projects)}`);
    console.log(`  mainTitle=${JSON.stringify(result.mainTitle)} mainProject=${JSON.stringify(result.mainProject)}`);
    console.log(`  texts=${JSON.stringify(result.texts.slice(0, 8))}${result.readError ? ` readError=${result.readError}` : ''}`);
  } finally {
    box.cleanup();
  }
}
