/**
 * 渠道（模型供应商）的跨 Agent 识别。
 *
 * 会话层回答"聊过什么"，MCP/技能层回答"具备什么工具"，这一层回答
 * **"模型从哪儿来"**：本机配了几个渠道、每个渠道服务哪些模型、哪几家
 * Agent 在用它、凭证是写在配置里还是走环境变量。
 *
 * ## 与 cc-switch 的关键区别
 *
 * cc-switch 的 Provider 是它自己的数据库记录，`settings_config` 里存着
 * 要写回某家的原生 JSON。我们**不写配置**，只读各家的原生配置，
 * 按 `base_url` 归一成"渠道"——所以同一家中转站被 Claude Code、Codex、
 * Qoder 各配了一遍时，这里显示的是**一个渠道、三家在用**，而不是三条。
 *
 * ## 安全边界
 *
 * **apiKey / token / header 的值绝不出这个模块。** 只回传 `auth` 形态
 * （inline / env / oauth / none）和**环境变量名**，不返回值本身。
 * URL 也会去掉 query、username、password（有些中转把 token 放 query 里）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function homeDir() {
  return os.homedir();
}

function envDir(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

function readJsonStrict(file) {
  const text = readText(file);
  if (text == null) throw new Error('读不到文件');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 解析失败：' + ((e && e.message) || e));
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * URL 脱敏：去 query/hash/账号密码，只留协议 + 主机 + 路径。
 * 有些中转把 token 放在 `?key=` 里，整个 URL 原样输出等于泄露。
 */
function sanitizeUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    // 不是完整 URL（比如 `localhost:3425`），只去掉明显的凭证段
    return s.split('?')[0].replace(/\/+$/, '');
  }
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return String(url).replace(/^[a-z]+:\/\//i, '').split('/')[0].toLowerCase();
  }
}

/** 渠道身份 = 脱敏后的 base_url（同 host 不同路径算不同渠道，例如网关的 /v1 与 /anthropic）。 */
function channelKeyOf(baseUrl) {
  const clean = sanitizeUrl(baseUrl);
  return clean ? clean.toLowerCase() : 'unknown';
}

/** 极简 TOML 段解析：只处理 `[a.b]` 与 `key = value` 标量/数组。 */
function parseTomlSections(text) {
  const top = {};
  const sections = {};
  let cur = top;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const name = sec[1].trim();
      sections[name] = sections[name] || {};
      cur = sections[name];
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    let val = v.trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(val)) val = Number(val);
    else if (/^\[.*\]$/.test(val)) {
      val = [...val.matchAll(/'([^']*)'|"([^"]*)"|([^,\s[\]]+)/g)]
        .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
        .filter(Boolean);
    }
    cur[k] = val;
  }
  return { top, sections };
}

/**
 * 极简 YAML「一层映射」解析：`section:` 下面 2 空格是条目名，
 * 4 空格是条目的标量键。`models:` 支持映射（`name: {}`）或块列表（`- name`）。
 * 只服务于 providers 段，不追求通用。
 */
function parseYamlSectionMap(text, sectionName) {
  const lines = String(text || '').split(/\r?\n/);
  const out = {};
  let start = -1;
  let baseIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^(\\s*)${sectionName}\\s*:\\s*$`));
    if (m) {
      start = i;
      baseIndent = m[1].length;
      break;
    }
  }
  if (start === -1) return out;

  let cur = null;
  let inModels = false;
  const at = (line, n) => line.match(/^ */)[0].length === baseIndent + n;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    // 回到同级或更浅：段结束
    if (indent <= baseIndent) break;

    // 条目名：base+2
    const nameM = line.match(/^( +)([A-Za-z0-9_.@-]+)\s*:\s*(.*)$/);
    if (nameM && nameM[1].length === baseIndent + 2) {
      cur = nameM[2];
      inModels = false;
      out[cur] = out[cur] || {};
      continue;
    }
    if (!cur) continue;

    // 条目内的键：base+4
    const subM = line.match(/^( +)([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (subM && subM[1].length === baseIndent + 4) {
      const [, , k, v] = subM;
      const val = v.trim();
      inModels = k === 'models';
      if (inModels) {
        out[cur].models = out[cur].models || {};
        continue;
      }
      if (val) out[cur][k] = val.replace(/^["']|["']$/g, '');
      continue;
    }

    if (inModels && indent >= baseIndent + 6) {
      // `models:` 下面是两种形状：
      //   映射：`claude-fable-5: {}`
      //   列表：`- name: claude-fable-5`（DSH 的模型对象还带 contextWindow 等字段，
      //         只认 name/id，不能把同级的 contextWindow 当模型名）
      const listName = line.match(/^\s*-\s+(?:name|id)\s*:\s*(.+)$/);
      if (listName) {
        const v = listName[1].trim().replace(/^["']|["']$/g, '');
        if (v) out[cur].models[v] = {};
        continue;
      }
      if (indent === baseIndent + 6) {
        const keyOnly = line.match(/^ *([A-Za-z0-9_.@/-]+)\s*:\s*(\{\}|)$/);
        if (keyOnly) out[cur].models[keyOnly[1]] = {};
      }
    }
  }
  return out;
}

/* ------------------------------ 各家读取 ------------------------------ */

function fromClaudeCode(file) {
  const j = readJsonStrict(file);
  if (!j || !j.env) return [];
  const env = j.env;
  const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const models = [
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_DEFAULT_FABLE_MODEL,
  ].filter(Boolean);
  const auth = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY ? 'inline' : 'oauth';
  return [
    {
      agent: 'claude-code',
      file,
      name: hostOf(baseUrl) || 'anthropic',
      baseUrl,
      protocol: 'anthropic',
      models: [...new Set(models)],
      auth,
      apiKeyEnv: env.ANTHROPIC_AUTH_TOKEN
        ? 'ANTHROPIC_AUTH_TOKEN'
        : env.ANTHROPIC_API_KEY
          ? 'ANTHROPIC_API_KEY'
          : null,
      isDefault: true,
    },
  ];
}

function fromCodex(file) {
  const text = readText(file);
  if (!text) return [];
  const { top, sections } = parseTomlSections(text);
  const out = [];
  const current = top.model_provider || 'openai';

  for (const [name, sec] of Object.entries(sections)) {
    if (!name.startsWith('model_providers.')) continue;
    const id = name.slice('model_providers.'.length);
    const baseUrl = sec.base_url || null;
    if (!baseUrl) continue;
    out.push({
      agent: 'codex',
      file,
      name: sec.name || id,
      baseUrl,
      protocol: /anthropic/i.test(String(sec.wire_api || '')) ? 'anthropic' : 'openai',
      models: top.model && id === current ? [top.model] : [],
      auth: sec.env_key ? 'env' : 'inline',
      apiKeyEnv: sec.env_key || null,
      isDefault: id === current,
    });
  }

  if (out.length === 0 && top.openai_base_url) {
    out.push({
      agent: 'codex',
      file,
      name: hostOf(top.openai_base_url) || 'openai',
      baseUrl: top.openai_base_url,
      protocol: 'openai',
      models: top.model ? [top.model] : [],
      auth: 'oauth',
      apiKeyEnv: null,
      isDefault: true,
    });
  }
  return out;
}

function fromQoder(file) {
  const j = readJsonStrict(file);
  if (!j || !j.providers || typeof j.providers !== 'object') return [];
  const current = (j.model && (j.model.name || j.model.id)) || null;
  const out = [];
  for (const [id, p] of Object.entries(j.providers)) {
    if (!p || typeof p !== 'object') continue;
    const baseUrl = p.baseUrl || p.base_url || null;
    const models = Array.isArray(p.models)
      ? p.models.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean)
      : [];
    out.push({
      agent: 'qoder',
      file,
      name: p.displayName || id,
      baseUrl,
      protocol: /anthropic/i.test(String(p.protocol || '')) ? 'anthropic' : 'openai',
      models: [...new Set(models)],
      auth: p.apiKey ? 'inline' : 'none',
      apiKeyEnv: null,
      isDefault: current === p.model || current === id,
    });
  }
  return out;
}

function fromOpencode(file) {
  const j = readJsonStrict(file);
  if (!j || !j.provider || typeof j.provider !== 'object') return [];
  const disabled = new Set(Array.isArray(j.disabled_providers) ? j.disabled_providers : []);
  const current = typeof j.model === 'string' ? j.model : '';
  const out = [];
  for (const [id, p] of Object.entries(j.provider)) {
    if (!p || typeof p !== 'object' || disabled.has(id)) continue;
    const options = p.options || {};
    const baseUrl = options.baseURL || options.baseUrl || null;
    const models = p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
    out.push({
      agent: 'opencode',
      file,
      name: p.name || id,
      baseUrl,
      protocol: /anthropic/i.test(String(p.npm || '')) ? 'anthropic' : 'openai',
      models,
      auth: options.apiKey ? 'inline' : 'none',
      apiKeyEnv: null,
      isDefault: current.startsWith(id + '/'),
    });
  }
  return out;
}

function fromHermes(file) {
  const text = readText(file);
  if (!text) return [];
  const providers = parseYamlSectionMap(text, 'providers');
  const out = [];
  for (const [id, p] of Object.entries(providers)) {
    const baseUrl = p.base_url || null;
    if (!baseUrl) continue;
    out.push({
      agent: 'hermes',
      file,
      name: p.name || id,
      baseUrl,
      protocol: /anthropic|claude/i.test(String(p.api_mode || p.provider || '')) ? 'anthropic' : 'openai',
      models: Object.keys(p.models || {}),
      auth: p.api_key ? 'inline' : p.key_env ? 'env' : 'none',
      apiKeyEnv: p.key_env || null,
      isDefault: /^(true|yes)$/i.test(String(p.default || '')),
    });
  }
  return out;
}

function fromDsh(file) {
  const text = readText(file);
  if (!text) return [];
  const providers = parseYamlSectionMap(text, 'providers');
  const out = [];
  for (const [id, p] of Object.entries(providers)) {
    const baseUrl = p.baseURL || p.base_url || null;
    if (!baseUrl) continue;
    const models = p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
    out.push({
      agent: 'dsh',
      file,
      name: p.displayName || id,
      baseUrl,
      protocol: /anthropic/i.test(String(p.api || '')) ? 'anthropic' : 'openai',
      models,
      auth: p.apiKeyEnv ? 'env' : p.apiKey ? 'inline' : 'none',
      apiKeyEnv: p.apiKeyEnv || null,
      isDefault: false,
    });
  }
  return out;
}

function fromKimi(file) {
  const text = readText(file);
  if (!text) return [];
  const { sections } = parseTomlSections(text);
  const p = sections.provider;
  if (!p || !p.base_url) return [];
  return [
    {
      agent: 'kimi',
      file,
      name: hostOf(p.base_url) || 'kimi',
      baseUrl: p.base_url,
      protocol: 'anthropic',
      models: [],
      auth: p.oauth ? 'oauth' : p.api_key ? 'inline' : 'none',
      apiKeyEnv: null,
      isDefault: true,
    },
  ];
}

/* ------------------------------ 扫描 ------------------------------ */

function sources() {
  const home = homeDir();
  return [
    { agent: 'claude-code', file: path.join(home, '.claude', 'settings.json'), read: fromClaudeCode },
    { agent: 'codex', file: path.join(envDir('CODEX_HOME', path.join(home, '.codex')), 'config.toml'), read: fromCodex },
    { agent: 'qoder', file: path.join(home, '.qoder', 'settings.json'), read: fromQoder },
    {
      agent: 'opencode',
      file: path.join(envDir('XDG_CONFIG_HOME', path.join(home, '.config')), 'opencode', 'opencode.json'),
      read: fromOpencode,
    },
    { agent: 'hermes', file: path.join(envDir('HERMES_HOME', path.join(home, '.hermes')), 'config.yaml'), read: fromHermes },
    {
      agent: 'dsh',
      file: path.join(envDir('DSH_HOME', path.join(home, 'DeepSeekHarness')), 'settings.yaml'),
      read: fromDsh,
    },
    { agent: 'kimi', file: path.join(envDir('KIMI_CODE_HOME', path.join(home, '.kimi-code')), 'config.toml'), read: fromKimi },
  ];
}

/**
 * 扫描本机各 Agent 的模型渠道。
 *
 * @returns {{registrations: Array, files: Array, errors: Array, channels: Array}}
 */
export function scanProviders() {
  const registrations = [];
  const files = [];
  const errors = [];

  for (const src of sources()) {
    let st;
    try {
      st = fs.statSync(src.file);
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        files.push({ file: src.file, agent: src.agent, status: 'unreadable' });
        errors.push({ file: src.file, agent: src.agent, error: `读不到：${e.code || e.message}` });
      }
      continue;
    }
    if (!st.isFile()) continue;

    let regs;
    try {
      regs = src.read(src.file);
    } catch (e) {
      files.push({ file: src.file, agent: src.agent, status: 'unparsable' });
      errors.push({ file: src.file, agent: src.agent, error: String((e && e.message) || e) });
      continue;
    }
    files.push({ file: src.file, agent: src.agent, status: 'ok', providers: regs.length });
    for (const r of regs) {
      // 原始 baseUrl 可能带 query token——统一脱敏后再进入结果
      registrations.push({ ...r, baseUrl: sanitizeUrl(r.baseUrl), channel: channelKeyOf(r.baseUrl) });
    }
  }

  return { registrations, files, errors, channels: groupByChannel(registrations) };
}

/** 同一 base_url 的多条注册折叠成一个渠道。 */
export function groupByChannel(registrations) {
  const map = new Map();
  for (const r of registrations) {
    const key = r.channel;
    let g = map.get(key);
    if (!g) {
      g = {
        id: key,
        display: r.name || hostOf(r.baseUrl) || key,
        baseUrl: sanitizeUrl(r.baseUrl),
        host: hostOf(r.baseUrl),
        protocols: new Set(),
        models: new Set(),
        agents: new Set(),
        auth: new Set(),
        apiKeyEnvs: new Set(),
        registrations: [],
        local: /^(localhost|127\.0\.0\.1|\[::1\])/.test(hostOf(r.baseUrl) || ''),
      };
      map.set(key, g);
    }
    if (r.name && r.name.length < g.display.length) g.display = r.name;
    if (r.protocol) g.protocols.add(r.protocol);
    for (const m of r.models || []) g.models.add(m);
    g.agents.add(r.agent);
    if (r.auth) g.auth.add(r.auth);
    if (r.apiKeyEnv) g.apiKeyEnvs.add(r.apiKeyEnv);
    g.registrations.push({ agent: r.agent, name: r.name, file: r.file, isDefault: Boolean(r.isDefault) });
  }

  return [...map.values()]
    .map((g) => ({
      id: g.id,
      display: g.display,
      baseUrl: g.baseUrl,
      host: g.host,
      local: g.local,
      protocols: [...g.protocols].sort(),
      models: [...g.models].sort(),
      modelCount: g.models.size,
      agents: [...g.agents].sort(),
      auth: [...g.auth].sort(),
      apiKeyEnvs: [...g.apiKeyEnvs].sort(),
      registrations: g.registrations,
      // 多渠道里哪条是当前默认（同一 Agent 可能有多个渠道，只有一个在用）
      defaults: g.registrations.filter((r) => r.isDefault).map((r) => r.agent),
    }))
    .sort((a, b) => b.agents.length - a.agents.length || a.display.localeCompare(b.display));
}

/** 给 env 总览 / MCP inventory 用的摘要。 */
export function providerSummary() {
  const { registrations, files, errors, channels } = scanProviders();
  return {
    channels: channels.length,
    registrations: registrations.length,
    agents: [...new Set(registrations.map((r) => r.agent))].sort(),
    // 读不到的文件：未知，不算零
    filesUnknown: files.filter((f) => f.status === 'unreadable' || f.status === 'unparsable').length,
    errors,
    byAgent: registrations.reduce((acc, r) => {
      acc[r.agent] = (acc[r.agent] || 0) + 1;
      return acc;
    }, {}),
    list: channels.map((c) => ({
      id: c.id,
      display: c.display,
      host: c.host,
      local: c.local,
      protocols: c.protocols,
      modelCount: c.modelCount,
      models: c.models.slice(0, 12),
      agents: c.agents,
      auth: c.auth,
      apiKeyEnvs: c.apiKeyEnvs,
      defaults: c.defaults,
      registrations: c.registrations,
    })),
  };
}

export { channelKeyOf, sanitizeUrl, parseTomlSections, parseYamlSectionMap };
