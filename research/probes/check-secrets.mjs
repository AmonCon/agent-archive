import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 扫描本机已知的 Agent 配置文件，检查是否还有明文阿里云 AccessKey。
 *
 * 只做只读检查，输出里一律掩码——绝不把完整凭证打到终端或日志里。
 */

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

const targets = [
  '~/.zcode/cli/config.json',
  '~/.claude.json',
  '~/.codex/config.toml',
  '~/.qoder/mcp.json',
  '~/.gemini/config/mcp_config.json',
  '~/.gemini/antigravity-ide/mcp_config.json',
  '~/.gemini/antigravity-backup/mcp_config.json',
  '~/.cursor/mcp.json',
  '~/.hermes/config.yaml',
  '~/.hermes/.env',
  '%APPDATA%/Trae/User/mcp.json',
  '%APPDATA%/Qoder/SharedClientCache/mcp.json',
  '%APPDATA%/Qoder/SharedClientCache/extension/local/mcp.json',
];

const AKID = /LTAI[0-9A-Za-z]{12,24}/g;
const AKPAIR = /"ALIBABA_CLOUD_ACCESS_KEY_(ID|SECRET)"\s*:\s*"([^"]+)"/gi;

function mask(s) {
  const t = String(s);
  if (t.length <= 8) return '***';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

/**
 * secret 连首尾字符都不能露。
 *
 * 终端输出会被写进会话记录，而会话记录又会被这个档案馆索引——
 * 露出前 6 位 + 后 4 位，等于把凭证的一半写进了索引。
 * 这里只报长度。
 */
function maskSecret(s) {
  return `***（${String(s).length} 位）`;
}

function resolve(p) {
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (p.startsWith('%APPDATA%/')) return path.join(appData, p.slice('%APPDATA%/'.length));
  return p;
}

const findings = [];

for (const t of targets) {
  const file = resolve(t);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const ids = text.match(AKID) || [];
  if (ids.length) {
    findings.push({
      file: t.replace(/^~/, '~'),
      kind: 'AccessKeyId 明文',
      values: [...new Set(ids)].map(mask),
    });
  }

  // 配对出现的 ID/SECRET
  const pairs = [];
  let m;
  AKPAIR.lastIndex = 0;
  while ((m = AKPAIR.exec(text)) !== null) {
    const isSecret = String(m[1]).toUpperCase().includes('SECRET');
    pairs.push({ key: m[1], value: isSecret ? maskSecret(m[2]) : mask(m[2]) });
  }
  if (pairs.length) {
    findings.push({
      file: t.replace(/^~/, '~'),
      kind: 'ALIBABA_CLOUD_* 环境变量',
      values: pairs.map((p) => `${p.key}=${p.value}`),
    });
  }
}

console.log('=== 配置文件检查 ===\n');
if (!findings.length) {
  console.log('  没有在已知配置里发现明文 AccessKey。');
} else {
  for (const f of findings) {
    console.log(`  ⚠ ${f.file}`);
    console.log(`     ${f.kind}: ${f.values.join(', ')}`);
  }
}

// 常见的历史副本
console.log('\n=== 历史副本检查 ===\n');
const backups = [
  '~/.zcode/cli/config.json.bak',
  '~/.zcode/backup',
  '~/.claude.json.backup',
  '~/.codex/config.toml.bak',
];

let backupHits = 0;
for (const b of backups) {
  const p = resolve(b);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    continue;
  }
  if (st.isDirectory()) {
    // 目录：看有没有文件提到 LTAI
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const fp = path.join(p, e.name);
      try {
        const txt = fs.readFileSync(fp, 'utf8');
        const ids = txt.match(AKID);
        if (ids) {
          backupHits++;
          console.log(`  ⚠ ${b}/${e.name}  ${[...new Set(ids)].map(mask).join(', ')}`);
        }
      } catch {
        /* 二进制文件跳过 */
      }
    }
    continue;
  }
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const ids = txt.match(AKID);
    if (ids) {
      backupHits++;
      console.log(`  ⚠ ${b}  ${[...new Set(ids)].map(mask).join(', ')}`);
    }
  } catch {
    /* 跳过 */
  }
}
if (!backupHits) console.log('  没有在常见备份路径里发现 AccessKey。');

// 当前 ZCode 配置里 ADB 那个 server 的状态
console.log('\n=== ZCode MCP 里的 aliyun server ===\n');
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
  const servers = (cfg.mcp && cfg.mcp.servers) || {};
  for (const [name, s] of Object.entries(servers)) {
    const env = s.env || {};
    const keys = Object.keys(env).filter((k) => /ALIBABA|ALIYUN|ACCESS_KEY|SECRET/i.test(k));
    if (!keys.length) continue;
    console.log(`  ${name}:`);
    for (const k of keys) {
      const v = String(env[k]);
      const looksMasked = /^[$%{]|^\*+|^<|placeholder|your[-_]/i.test(v);
      const shown = /SECRET/i.test(k) ? maskSecret(v) : mask(v);
      console.log(`    ${k} = ${shown}  ${looksMasked ? '（看起来是占位/引用）' : '（疑似真实值）'}`);
    }
  }
  if (!Object.keys(servers).length) console.log('  没有 MCP server 配置。');
} catch (e) {
  console.log('  读不了配置:', e.message);
}
