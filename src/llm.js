import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './paths.js';

/**
 * 模型接入层。
 *
 * 只做两件事：读配置、发一次 chat 请求。不做重试策略、不做流式、
 * 不做多轮编排——那些是上面 diget 层的事，混在一起会很难改。
 *
 * 支持两种请求形状，覆盖绝大多数场景：
 *   openai    /chat/completions，DeepSeek / Kimi / Qwen / GLM / Ollama /
 *             LM Studio 以及各种第三方中转站都是这个形状
 *   anthropic /v1/messages
 *
 * 密钥存放：~/.agent-archive/llm.json，权限 600。
 * **绝不能放项目目录**——这个目录会进 git，密钥一旦进了历史就洗不掉。
 * 环境变量优先于配置文件，方便临时切换和测试。
 */

const CONFIG_VERSION = 1;

export function configPath() {
  return statePath('llm.json');
}

/**
 * 读配置。环境变量优先，便于测试时指向本地 mock，不碰真实配置。
 */
export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {};
  } catch {
    file = {};
  }

  const provider = process.env.AGENT_ARCHIVE_LLM_PROVIDER || file.provider || 'openai';
  const baseUrl =
    process.env.AGENT_ARCHIVE_LLM_BASE_URL || file.baseUrl || defaultBaseUrl(provider);
  const apiKey = process.env.AGENT_ARCHIVE_LLM_API_KEY || file.apiKey || '';
  const model = process.env.AGENT_ARCHIVE_LLM_MODEL || file.model || '';

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    maxTokens: Number(file.maxTokens) || 1600,
    timeoutMs: Number(file.timeoutMs) || 120000,
    // 可选：用于估算费用。单位是"每百万 token 的价格"，币种由用户自己理解。
    inputPricePerM: file.inputPricePerM === undefined ? null : Number(file.inputPricePerM),
    outputPricePerM: file.outputPricePerM === undefined ? null : Number(file.outputPricePerM),
  };
}

function defaultBaseUrl(provider) {
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
}

/** 写配置。密钥文件必须只有本人可读。 */
export function saveConfig(patch) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {};
  } catch {
    cur = {};
  }
  const next = { ...cur, ...patch, version: CONFIG_VERSION };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try {
    // Windows 上 mode 不一定生效，补一次显式权限
    fs.chmodSync(configPath(), 0o600);
  } catch {
    /* 尽力而为 */
  }
  return next;
}

/** 供展示用：密钥只留头和尾。 */
export function maskKey(k) {
  if (!k) return '(未设置)';
  const s = String(k);
  if (s.length <= 10) return '***';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/**
 * 发一次 chat 请求。
 *
 * 失败时抛出带可读原因的 Error——上层要能把"密钥错了"和"网络不通"
 * 区分开，不能笼统说"调用失败"。
 */
export async function chat({ messages, maxTokens, temperature = 0.2 } = {}) {
  const cfg = loadConfig();

  if (!cfg.apiKey) {
    throw new Error(
      '还没有配置 API Key。运行：agent-archive llm --key <your-key> --model <model>\n' +
        '或设置环境变量 AGENT_ARCHIVE_LLM_API_KEY / _MODEL / _BASE_URL。'
    );
  }
  if (!cfg.model) {
    throw new Error('还没有指定模型。运行：agent-archive llm --model <model-name>');
  }

  const body =
    cfg.provider === 'anthropic'
      ? {
          model: cfg.model,
          max_tokens: maxTokens || cfg.maxTokens,
          temperature,
          system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
          messages: messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content })),
        }
      : {
          model: cfg.model,
          max_tokens: maxTokens || cfg.maxTokens,
          temperature,
          messages,
        };

  const url = joinUrl(cfg.baseUrl, cfg.provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');

  const headers =
    cfg.provider === 'anthropic'
      ? {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      throw new Error(`请求超时（${cfg.timeoutMs} ms）。模型可能在处理很长的输入。`);
    }
    throw new Error(`连不上 ${url}：${e && e.message ? e.message : e}`);
  }
  clearTimeout(timer);

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}：${summarizeError(raw)}`);
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`返回的不是 JSON：${raw.slice(0, 200)}`);
  }

  const text = extractText(j, cfg.provider);
  if (!text) throw new Error('返回里没有可提取的文本，响应格式可能不兼容');

  return {
    text,
    usage: extractUsage(j, cfg.provider),
    model: cfg.model,
  };
}

function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + suffix;
}

function extractText(j, provider) {
  if (provider === 'anthropic') {
    const blocks = j.content;
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('')
        .trim();
    }
    return '';
  }
  const choice = j.choices && j.choices[0];
  if (choice && choice.message && typeof choice.message.content === 'string') {
    return choice.message.content.trim();
  }
  return '';
}

function extractUsage(j, provider) {
  const u = j.usage || {};
  if (provider === 'anthropic') {
    return {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
    };
  }
  return {
    input: Number(u.prompt_tokens) || 0,
    output: Number(u.completion_tokens) || 0,
  };
}

/** 错误响应只留有用的部分，不把整个 body 倒出来。 */
function summarizeError(raw) {
  try {
    const j = JSON.parse(raw);
    const msg =
      (j.error && (j.error.message || j.error.type)) || j.message || JSON.stringify(j).slice(0, 200);
    return String(msg).slice(0, 300);
  } catch {
    return String(raw).slice(0, 300);
  }
}

/**
 * 粗略估 token。
 *
 * 中文约 1.5 字/token，英文约 4 字符/token。混排取 1.8 作为保守估计——
 * 宁可高估让用户有心理准备，也别低估导致实际花费超预期。
 */
export function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / 1.8);
}

/** 估算费用。没配单价就返回 null。 */
export function estimateCost(usage) {
  const cfg = loadConfig();
  if (cfg.inputPricePerM == null && cfg.outputPricePerM == null) return null;
  const inCost = ((usage.input || 0) / 1e6) * (cfg.inputPricePerM || 0);
  const outCost = ((usage.output || 0) / 1e6) * (cfg.outputPricePerM || 0);
  return inCost + outCost;
}
