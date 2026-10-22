/**
 * 凭证泄漏扫描。
 *
 * 由来：做采集体检时发现，用户的会话归档里散落着真实的云凭证——
 * AccessKey 明文粘进对话、工具输出里回显、部署脚本里硬编码。
 * 这类东西用户自己看不见（它们埋在几万条消息里），但档案馆有全文，
 * 扫一遍就能找出来。这正是"档案馆能看到你看不见的东西"的价值。
 *
 * 设计原则：
 *   1. 只扫描，不改任何文件，也不"帮你顺手删掉"——那是用户的决定。
 *   2. **输出一律掩码**。报出位置和类型就够定位了，把完整凭证
 *      打进终端等于二次泄漏。
 *   3. 宁可少报几个，也别把正常代码误判成密钥——误报多了
 *      这个功能就没人看了。
 */

import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/**
 * 凭证特征库。
 *
 * 每条给出：类型名、正则、掩码方式。正则尽量用真实格式前缀，
 * 不做"高熵字符串"这种模糊判断——误报率太高。
 */
const PATTERNS = [
  {
    id: 'aliyun-ak',
    label: '阿里云 AccessKey ID',
    // 阿里云 AK 固定以 LTAI 开头，后面是字母数字
    re: /\bLTAI[0-9A-Za-z]{12,24}\b/g,
    mask: (m) => m.slice(0, 6) + '…' + m.slice(-4),
    severity: 'high',
  },
  {
    id: 'aws-ak',
    label: 'AWS Access Key ID',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    mask: (m) => m.slice(0, 6) + '…' + m.slice(-4),
    severity: 'high',
  },
  {
    id: 'github-token',
    label: 'GitHub Token',
    re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
    mask: (m) => m.slice(0, 8) + '…',
    severity: 'high',
  },
  {
    id: 'openai-key',
    label: 'OpenAI / 兼容接口 Key',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    mask: (m) => m.slice(0, 7) + '…',
    severity: 'high',
  },
  {
    id: 'anthropic-key',
    label: 'Anthropic Key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    mask: (m) => m.slice(0, 11) + '…',
    severity: 'high',
  },
  {
    id: 'private-key',
    label: '私钥文件内容',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    mask: () => '-----BEGIN PRIVATE KEY-----（内容未展示）',
    severity: 'critical',
  },
  {
    id: 'aliyun-secret-assign',
    label: '疑似阿里云 Secret（赋值形式）',
    // ALIBABA_CLOUD_ACCESS_KEY_SECRET = "xxxx" 这类
    re: /ALIBABA_CLOUD_ACCESS_KEY_SECRET["']?\s*[:=]\s*["']([A-Za-z0-9]{20,40})["']/gi,
    mask: (m, value) => 'SECRET=' + value.slice(0, 3) + '…' + value.slice(-3),
    severity: 'high',
    capture: 1,
  },
  {
    id: 'generic-secret-assign',
    label: '疑似密钥赋值（SECRET/API_KEY）',
    re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|service[_-]?role[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{24,})["']/gi,
    mask: (m, value) => value.slice(0, 4) + '…' + value.slice(-4),
    severity: 'medium',
    capture: 1,
  },
];

function indexFile() {
  return path.join(os.homedir(), '.agent-archive', 'index', 'fulltext-v1.sqlite');
}

/** 两条固定 SQL，不根据条件拼 where。 */
const SQL_ALL = `select key, agent, id, project, title, start, body from doc`;
const SQL_AGENT = `select key, agent, id, project, title, start, body from doc where agent = ?`;

/**
 * 扫描归档里的凭证。
 *
 * 只扫索引里的正文（doc.body）。工具输出不进索引，所以"某条命令回显了
 * 密钥"这种情况会漏——但正文覆盖了人实际粘贴和讨论的部分，性价比最高。
 *
 * @param {object} opts
 * @param {string} opts.agent  只看某个 Agent
 * @param {string} opts.severity  只报 >= 这个等级
 */
export function scanSecrets({ agent, severity } = {}) {
  let db;
  try {
    db = new DatabaseSync(indexFile(), { readOnly: true });
  } catch {
    return { ready: false, message: '索引还没建，先运行：agent-archive index', findings: [] };
  }

  let rows;
  try {
    rows = agent ? db.prepare(SQL_AGENT).all(agent) : db.prepare(SQL_ALL).all();
  } catch {
    db.close();
    return { ready: true, message: '索引结构不认识，可能版本不匹配', findings: [] };
  }
  db.close();

  const findings = [];
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };

  for (const row of rows) {
    const body = String(row.body || '');
    if (!body) continue;

    for (const p of PATTERNS) {
      if (severity && rank[p.severity] < rank[severity]) continue;

      // 用 matchAll 而不是 exec 循环：不受正则实例 lastIndex 影响，
      // 也不会因为上一轮提前 break 而漏掉后面的匹配。
      let hits = 0;
      const samples = [];

      for (const m of body.matchAll(p.re)) {
        hits++;
        if (samples.length < 3) {
          const raw = p.capture ? m[p.capture] : m[0];
          samples.push({ masked: p.mask(m[0], raw), offset: m.index });
        }
        if (hits > 50) break; // 同一类型在一场会话里刷屏没有意义
      }

      if (!hits) continue;

      findings.push({
        type: p.id,
        label: p.label,
        severity: p.severity,
        agent: row.agent,
        id: row.id,
        title: row.title,
        project: row.project,
        start: row.start ? new Date(row.start) : null,
        occurrences: hits,
        samples,
        context: contextAround(body, samples[0].offset),
      });
    }
  }

  // 严重程度优先，同级别按出现次数
  findings.sort((a, b) => rank[b.severity] - rank[a.severity] || b.occurrences - a.occurrences);

  return { ready: true, scanned: rows.length, findings };
}

/**
 * 取命中位置附近的上下文，用来判断"这是真泄漏还是文档里举例"。
 *
 * 返回前必须把上下文里所有可能的凭证都掩掉——否则这个工具本身
 * 就成了泄漏渠道。所以掩码规则比命中规则更激进：命中只认已知前缀，
 * 但掩码会把任何 24 字符以上的连续字母数字串都打掉。
 * 正常的中文、英文单词不会被误伤。
 */
function contextAround(body, offset) {
  const from = Math.max(0, offset - 70);
  const to = Math.min(body.length, offset + 90);
  let s = body.slice(from, to).replace(/\s+/g, ' ').trim();

  s = s.replace(/\bLTAI[0-9A-Za-z]{12,24}\b/g, 'LTAI****');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA****');
  s = s.replace(/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, 'sk-ant-****');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-****');
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh*_****');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_****');
  // 兜底：任何 24 位以上的连续字母数字（含 JWT 片段、OSS Secret 之类）
  s = s.replace(/\b[A-Za-z0-9]{24,}\b/g, (m) => m.slice(0, 4) + '****');

  return s;
}

/** 便于 doctor 调用：只返回汇总。 */
export function secretSummary() {
  const r = scanSecrets();
  if (!r.ready) return { ready: false, sessions: 0, byType: {} };
  const byType = {};
  for (const f of r.findings) byType[f.label] = (byType[f.label] || 0) + 1;
  const sessions = new Set(r.findings.map((f) => `${f.agent}|${f.id}`)).size;
  return { ready: true, sessions, byType };
}
