/**
 * 展示层的格式化工具。
 *
 * 全部是纯函数：页面渲染和 API 各用各的，不在这里读文件、不查数据库。
 */

/** HTML 转义。会话正文、摘要、项目路径全部走这里。 */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtDate(d) {
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function fmtDay(d) {
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtMonthDay(d) {
  if (!d) return '—';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(d) {
  if (!d) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 人读的相对时间；超过一周就退回日期，避免"23 天前"这种没有信息量的说法。 */
export function fmtRel(d) {
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return fmtDate(d);
  const s = Math.floor(diff / 1000);
  if (s < 45) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days === 1) return `昨天 ${fmtTime(d)}`;
  if (days < 7) return `${days} 天前`;
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) return fmtMonthDay(d);
  return fmtDay(d);
}

export function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 1000) return '';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** token 数量级跨度大，用中文单位比一排零好读。 */
export function fmtTok(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v);
  if (abs < 10000) return String(v);
  if (abs < 1e8) return (v / 1e4).toFixed(1) + '万';
  return (v / 1e8).toFixed(2) + '亿';
}

export function fmtCost(g) {
  if (!g) return '—';
  if (g.cost != null) return `$${g.cost.toFixed(2)}${g.costUnknown ? '+' : ''}`;
  if (g.costEst != null) return `~$${g.costEst.toFixed(2)}`;
  return '—';
}

export function pct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

export function clip(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + `\n…（已截断，原 ${s.length} 字）` : s;
}

export function oneLine(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function summarizeInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input, 90);
  if (typeof input === 'object') {
    if (Array.isArray(input.command)) return oneLine(input.command.join(' '), 90);
    for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'prompt', 'skill']) {
      if (typeof input[k] === 'string' && input[k]) return oneLine(input[k], 90);
    }
    return oneLine(JSON.stringify(input), 80);
  }
  return String(input);
}

/**
 * 判断一段用户输入是不是 Markdown。
 *
 * 用户消息默认按纯文本排（人话里出现 * 和 # 不该被当成语法）；
 * 但粘贴进来的报告、代码块、列表明显是 Markdown 时，按 Markdown 排更好读。
 * 只做很保守的识别：标题、围栏、列表、引用、加粗、行内代码。
 */
export function looksLikeMarkdown(text) {
  const s = String(text || '');
  return (
    /(^|\n)\s*(#{1,4}\s|```|>\s|[-*]\s|\d+[.)]\s)/.test(s) ||
    /\*\*[^*\n]+\*\*/.test(s) ||
    /`[^`\n]+`/.test(s)
  );
}

/** 把摘录里的关键词包成 <mark>，其余照常转义。 */
export function highlight(snippet, query) {
  const text = String(snippet || '');
  const q = String(query || '').trim();
  if (!q) return esc(text);

  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts = [];
  let i = 0;
  let found = 0;

  while (found < 8) {
    const at = lower.indexOf(ql, i);
    if (at === -1) break;
    parts.push(esc(text.slice(i, at)));
    parts.push(`<mark>${esc(text.slice(at, at + q.length))}</mark>`);
    i = at + q.length;
    found++;
  }
  parts.push(esc(text.slice(i)));
  return parts.join('');
}

/** 行内：先转义，再把链接、**粗体** 和 `代码` 换成标签。 */
function inline(s) {
  return esc(s)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * 极简 Markdown 渲染。
 *
 * 只处理摘要和助手正文里实际会出现的结构：标题、列表、引用、加粗、
 * 行内代码、链接、围栏代码块。先整体转义再套标签，所以即使正文里混进
 * HTML 也不会执行。
 *
 * 两个刻意的取舍：
 *   - 连续普通行合成一段（用 <br> 保留换行），否则模型每行一句会被排成
 *     十几个段落，行距大得没法读。
 *   - 列表项之间空一行仍然算同一个列表；模型经常这么写。
 */
export function renderMarkdownLite(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let code = null;
  let para = [];
  let blank = false;
  let lastWasList = false;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };

  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
      list = null;
    }
  };

  const flushCode = () => {
    if (code) {
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      code = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^\s*```/.test(line)) {
      if (code) flushCode();
      else {
        flushPara();
        flushList();
        code = [];
      }
      blank = false;
      lastWasList = false;
      continue;
    }

    if (code) {
      code.push(raw);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      blank = true;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(h[1].length + 1, 5);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      blank = false;
      lastWasList = false;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr>');
      blank = false;
      lastWasList = false;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      blank = false;
      lastWasList = false;
      continue;
    }

    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || list.tag !== 'ol') {
        flushList();
        list = { tag: 'ol', items: [] };
      }
      if (ol[2].trim()) list.items.push(`<li>${inline(ol[2])}</li>`);
      blank = false;
      lastWasList = true;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.tag !== 'ul') {
        flushList();
        list = { tag: 'ul', items: [] };
      }
      if (ul[1].trim()) list.items.push(`<li>${inline(ul[1])}</li>`);
      blank = false;
      lastWasList = true;
      continue;
    }

    // 列表项后面紧跟一行普通文字（中间没有空行）：算这个列表项的续行。
    if (lastWasList && !blank && list && list.items.length) {
      list.items[list.items.length - 1] = list.items[list.items.length - 1].replace(
        /<\/li>$/,
        `<br>${inline(line)}</li>`
      );
      continue;
    }

    flushList();
    para.push(line);
    blank = false;
    lastWasList = false;
  }

  flushPara();
  flushList();
  flushCode();
  return out.join('\n');
}

/**
 * 会话正文的排版。
 *
 * 保持原文，只把围栏代码块单独排成 <pre>：模型回复里大量正文是代码，
 * 整段按普通段落排会很难读。普通文字仍然 pre-wrap，不改写任何内容。
 */
export function renderTextBlocks(text) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let plain = [];
  let code = null;

  const flushPlain = () => {
    const t = plain.join('\n');
    if (t.trim()) out.push(`<div class="prose">${esc(t.replace(/^\n+|\n+$/g, ''))}</div>`);
    plain = [];
  };

  const flushCode = () => {
    if (code) {
      out.push(`<pre class="prose code"><code>${esc(code.join('\n'))}</code></pre>`);
      code = null;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code) flushCode();
      else {
        flushPlain();
        code = [];
      }
      continue;
    }
    if (code) code.push(line);
    else plain.push(line);
  }

  flushPlain();
  flushCode();
  return out.join('');
}

/** 24 小时内每小时的柱状序列，用来画活动热力。 */
export function activitySeries(dates, { days = 30, now = new Date() } = {}) {
  const buckets = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = fmtDay(d);
    index.set(key, buckets.length);
    buckets.push({ key, label: key.slice(5), n: 0 });
  }
  for (const d of dates) {
    if (!d) continue;
    const i = index.get(fmtDay(d));
    if (i != null) buckets[i].n++;
  }
  return buckets;
}

/** 从 summary.days（[[YYYY-MM-DD, n], ...]）拼出连续日序列。 */
export function seriesFromDays(days, { count = 30, now = new Date() } = {}) {
  const map = new Map((days || []).map(([k, n]) => [k, n]));
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = fmtDay(d);
    out.push({ key, label: key.slice(5), n: map.get(key) || 0 });
  }
  return out;
}

// 取自 TraeCode 的 accent 色板：深底上足够亮，浅底上仍然可辨。
const AGENT_COLORS = {
  'claude-code': '#ff9392',
  codex: '#7bb8ff',
  zcode: '#bfa5ff',
  qoder: '#ec93ff',
  hermes: '#dcb364',
  cursor: '#2dd288',
  opencode: '#8acb3a',
  gemini: '#04cbe5',
  antigravity: '#a599ff',
  dsh: '#afb9cf',
  kiro: '#e6a637',
  copilot: '#8e80ff',
  accio: '#d27e24',
  'shared-agents': '#9599a6',
};

const FALLBACK_COLORS = ['#dcb364', '#2dd288', '#ec93ff', '#7bb8ff', '#ff9392', '#8acb3a'];

/** 每个 Agent 一个稳定的颜色。未知 Agent 用名字哈希取一个，不随排序变化。 */
export function agentColor(agent) {
  const key = String(agent || '');
  if (AGENT_COLORS[key]) return AGENT_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}

export { pad };
