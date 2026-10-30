/**
 * 页面外壳与通用组件。
 *
 * 所有页面共享同一套结构：左侧导航 + 顶栏 + 内容区。
 * 组件只负责拼 HTML，不读数据（layout 里的侧栏除外，那是全站唯一的例外）。
 */

import { icon } from './icons.js';
import {
  esc,
  agentColor,
  agentBrand,
  agentMark,
  agentGlyph,
  agentLogoSprite,
  agentIsFull,
} from './format.js';
import { tildify, projectKey } from '../model.js';
import { recentProjects } from './data.js';

const NAV = [
  {
    section: '会话',
    items: [
      { key: 'projects', label: '项目', href: '/', icon: 'archive' },
      { key: 'search', label: '搜索', href: '/search', icon: 'search' },
    ],
  },
  {
    section: '分析',
    items: [
      { key: 'usage', label: '用量', href: '/usage', icon: 'chart' },
      { key: 'handoff', label: '跨 Agent 接力', href: '/handoff', icon: 'gitPull' },
    ],
  },
  {
    section: '环境',
    items: [
      { key: 'env', label: '能力面', href: '/env', icon: 'layers' },
      { key: 'audit', label: '环境体检', href: '/env?tab=audit', icon: 'shield' },
    ],
  },
];

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23141517'/%3E%3Cpath d='M9 10h14M10 11v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V11M13 16h6' stroke='%2332f08c' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E";

const SEARCH_KBD = process.platform === 'darwin' ? '⌘ K' : 'Ctrl K';

/**
 * 文档外壳。
 *
 * 侧栏的"最近项目"是唯一在这里读数据的地方：它必须每页都在，
 * 让页面自己传一遍只会让每个页面都写同样的三行。读失败就退回空列表，
 * 侧栏不该成为页面 500 的理由。
 */
export async function layout({ title, page, crumb = [], body, currentProject = '' }) {
  let recent = [];
  try {
    recent = await recentProjects();
  } catch {
    recent = [];
  }

  const active = page === 'project' || page === 'session' ? 'projects' : page;
  const currentKey = currentProject ? projectKey(currentProject) : null;

  const nav = NAV.map((group) => {
    const items = group.items
      .map((it) => {
        const on = it.key === active || (active === 'projects' && it.key === 'projects');
        return `<a href="${esc(it.href)}" class="${on ? 'on' : ''}"${
          on ? ' aria-current="page"' : ''
        }><span class="nav-icon">${icon(it.icon, 16)}</span>${esc(it.label)}</a>`;
      })
      .join('');
    return `<div class="nav-label">${esc(group.section)}</div>${items}`;
  }).join('');

  const recentHtml = recent.length
    ? `<div class="recent">
        <div class="recent-head"><span>最近项目</span><span>${recent.length}</span></div>
        <div class="recent-list">${recent
          .map((p) => {
            const on = currentKey && p.key === currentKey;
            return `<a href="/p?path=${encodeURIComponent(p.display)}" class="${on ? 'on' : ''}" title="${esc(
              tildify(p.display)
            )}">
              ${icon('folder', 14)}
              <span class="name">${esc(lastSegment(tildify(p.display)))}</span>
              <span class="n">${p.count}</span>
            </a>`;
          })
          .join('')}</div>
      </div>`
    : '';

  const crumbs = crumb.length
    ? `<nav class="crumbs" aria-label="面包屑">${crumb
        .map((c, i) => {
          const last = i === crumb.length - 1;
          const node = last
            ? `<span class="current">${esc(c.label)}</span>`
            : c.href
              ? `<a href="${esc(c.href)}">${esc(c.label)}</a>`
              : `<span>${esc(c.label)}</span>`;
          return `${i ? '<span class="sep">/</span>' : ''}${node}`;
        })
        .join('')}</nav>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — agent-archive</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/assets/theme.css">
<script src="/assets/app.js"></script>
</head>
<body>
${agentLogoSprite()}
<a class="skip-link" href="#main">跳到内容</a>
<div class="scrim" data-nav-close hidden></div>
<div class="shell">
  <aside class="sidebar" aria-label="主导航">
    <div class="side-inner">
      <a class="brand" href="/">
        <span class="brand-mark">${icon('archive', 18)}</span>
        <span>
          <span class="brand-name">agent-archive</span>
          <span class="brand-sub">本地会话档案馆</span>
        </span>
      </a>
      <nav class="nav">${nav}</nav>
      ${recentHtml}
      <div class="side-foot">
        <button class="side-search" type="button" data-open-palette>
          ${icon('search', 15)}
          <span>搜索会话</span>
          <kbd class="kbd">${SEARCH_KBD}</kbd>
        </button>
        <div class="side-row">
          <span class="side-status"><span class="status-dot"></span>本地只读 · 127.0.0.1</span>
          <span class="theme-toggle" role="group" aria-label="主题">
            <button type="button" data-theme-toggle="light" aria-label="浅色主题" aria-pressed="false">${icon(
              'sun',
              14
            )}</button>
            <button type="button" data-theme-toggle="dark" aria-label="深色主题" aria-pressed="false">${icon(
              'moon',
              14
            )}</button>
          </span>
        </div>
      </div>
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <button class="btn ghost icon sm menu-btn" type="button" data-nav-toggle aria-label="打开导航" aria-expanded="false">${icon(
        'menu',
        17
      )}</button>
      <a class="mobile-brand" href="/"><span class="brand-mark">${icon('archive', 15)}</span>agent-archive</a>
      ${crumbs}
      <div class="topbar-actions">
        <button class="searchbtn" type="button" data-open-palette aria-label="搜索会话">
          ${icon('search', 15)}
          <span class="searchbtn-label">搜索会话…</span>
          <kbd class="kbd">${SEARCH_KBD}</kbd>
        </button>
        <button class="btn ghost icon sm" type="button" data-theme-cycle aria-label="切换主题">${icon(
          'moon',
          16
        )}</button>
      </div>
    </header>
    <main class="page" id="main">${body}</main>
  </div>
</div>

<div class="palette" id="palette" hidden>
  <div class="palette-dialog" role="dialog" aria-modal="true" aria-label="搜索与跳转">
    <div class="palette-input">
      ${icon('search', 18)}
      <input id="palette-input" type="text" placeholder="搜索会话，或跳到页面 / 最近项目…" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="palette-results" aria-expanded="false">
      <kbd class="kbd">esc</kbd>
    </div>
    <div class="palette-results" id="palette-results" role="listbox" aria-label="搜索结果"></div>
    <div class="palette-foot">
      <span><kbd class="kbd">↑</kbd> <kbd class="kbd">↓</kbd> 选择</span>
      <span><kbd class="kbd">↵</kbd> 打开</span>
      <span class="push">结果来自本机全文索引</span>
    </div>
  </div>
</div>

<button class="to-top" type="button" data-to-top aria-label="回到顶部">${icon('arrowUp', 16)}</button>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
</body>
</html>`;
}

/* ------------------------------ 页头 ------------------------------ */

export function pageHead({ eyebrow, eyebrowIcon, title, lead, actions = '', titleClass = '' }) {
  return `<header class="page-head">
    <div>
      ${
        eyebrow
          ? `<div class="eyebrow">${eyebrowIcon ? icon(eyebrowIcon, 13) : ''}${esc(eyebrow)}</div>`
          : ''
      }
      <h1 class="page-title ${titleClass}">${title}</h1>
      ${lead ? `<p class="lead">${lead}</p>` : ''}
    </div>
    ${actions ? `<div class="head-actions">${actions}</div>` : ''}
  </header>`;
}

export function sectionHead({ title, desc, actions = '' }) {
  return `<div class="section-head">
    <div>
      <h2 class="section-title">${title}</h2>
      ${desc ? `<p class="section-desc">${desc}</p>` : ''}
    </div>
    ${actions ? `<div class="section-actions">${actions}</div>` : ''}
  </div>`;
}

/* ------------------------------ 统计 ------------------------------ */

export function statGrid(items) {
  return `<div class="stat-grid">${items.map(statCard).join('')}</div>`;
}

export function statCard({ label, value, sub, icon: iconName, tone = '', wide = false, small = false }) {
  return `<div class="stat${wide ? ' wide' : ''}">
    ${iconName ? `<span class="stat-icon ${tone}">${icon(iconName, 16)}</span>` : ''}
    <div class="stat-main">
      <p class="stat-label">${esc(label)}</p>
      <div class="stat-value${small ? ' sm' : ''}">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>
  </div>`;
}

/* ------------------------------ 卡片 / 表格 ------------------------------ */

export function card({ title, desc, actions = '', body = '', foot = '', id = '', className = '' }) {
  return `<section class="card ${className}"${id ? ` id="${esc(id)}"` : ''}>
    ${
      title || actions
        ? `<div class="card-head">
            <div>
              ${title ? `<h2 class="card-title">${title}</h2>` : ''}
              ${desc ? `<p class="card-desc">${desc}</p>` : ''}
            </div>
            ${actions || ''}
          </div>`
        : ''
    }
    ${body ? `<div class="card-body">${body}</div>` : ''}
    ${foot ? `<div class="card-foot">${foot}</div>` : ''}
  </section>`;
}

/** head: ['名称', {label:'会话', num:true}]；rows: ['<tr>…</tr>', …] */
export function table({ head, rows, className = '', id = '', wrap = true }) {
  const thead = head
    .map((h) => {
      const o = typeof h === 'string' ? { label: h } : h;
      const attrs = [o.num ? 'class="num"' : '', o.width ? `style="width:${o.width}"` : '']
        .filter(Boolean)
        .join(' ');
      return `<th${attrs ? ' ' + attrs : ''}>${esc(o.label)}</th>`;
    })
    .join('');
  const html = `<table class="t ${className}"${id ? ` id="${esc(id)}"` : ''}>
    <thead><tr>${thead}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;
  return wrap ? `<div class="table-wrap">${html}</div>` : html;
}

export function tabsNav(tabs, active, hrefFor) {
  return `<nav class="tabs" aria-label="视图切换">${tabs
    .map(
      ([key, label]) =>
        `<a href="${esc(hrefFor(key))}" class="${key === active ? 'on' : ''}"${
          key === active ? ' aria-current="page"' : ''
        }>${esc(label)}</a>`
    )
    .join('')}</nav>`;
}

/* ------------------------------ 标签 / Agent ------------------------------ */

export function badge(text, variant = '', iconName = '') {
  return `<span class="badge ${variant}">${iconName ? icon(iconName, 11) : ''}${esc(text)}</span>`;
}

/** 小号 app 图标：品牌色底 + logo。没有 logo 的 Agent 由调用方退回色点。 */
export function agentTile(agent, className = 'agent-tile') {
  const b = agentBrand(agent);
  const glyph = agentGlyph(agent);
  if (!glyph) return '';
  const full = agentIsFull(agent) ? ' full' : '';
  return `<span class="${className}${full}" style="--agent-bg:${b.bg};--agent-fg:${b.fg}">${glyph}</span>`;
}

export function agentChip(agent, { count = null } = {}) {
  const a = String(agent || '?');
  return `<span class="agent" style="--agent:${agentColor(a)}">
    ${agentTile(a) || '<span class="agent-dot"></span>'}${esc(a)}${
      count != null ? ` <span class="subtle">${count}</span>` : ''
    }
  </span>`;
}

export function agentStack(agents, max = 4) {
  const list = (agents || []).filter(Boolean);
  if (!list.length) return '<span class="subtle">—</span>';
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return `<span class="agent-stack">${shown
    .map((a) => {
      const b = agentBrand(a);
      const full = agentIsFull(a) ? ' full' : '';
      return `<span class="avatar${full}" style="--agent-bg:${b.bg};--agent-fg:${b.fg}" title="${esc(
        a
      )}">${agentMark(a)}</span>`;
    })
    .join('')}${rest > 0 ? `<span class="more">+${rest}</span>` : ''}</span>`;
}

/* ------------------------------ 图表 ------------------------------ */

export function sparkline(series, { big = false, label = '场' } = {}) {
  const max = Math.max(1, ...series.map((s) => s.n));
  return `<span class="spark${big ? ' big' : ''}" role="img" aria-label="最近 ${series.length} 天活动">${series
    .map(
      (s) =>
        `<i class="${s.n ? '' : 'zero'}" style="height:${Math.max(6, Math.round((s.n / max) * 100))}%" title="${esc(
          s.key
        )} · ${s.n} ${esc(label)}"></i>`
    )
    .join('')}</span>`;
}

/**
 * 表格里的迷你柱状图。
 *
 * 一行一个 SVG 路径，而不是 30 个 <span>：首页有几十个项目，
 * 每个都铺 30 个 span 会把 HTML 撑到 200 KB，而 path 只要几百字节。
 */
export function sparkSvg(series, { label = '最近 30 天活动' } = {}) {
  const max = Math.max(1, ...series.map((s) => s.n));
  const d = series
    .map((s, i) => {
      const h = s.n ? Math.max(0.6, (s.n / max) * 9.2) : 0.5;
      return `M${(i + 0.5).toFixed(1)} 10V${(10 - h).toFixed(2)}`;
    })
    .join('');
  return `<svg class="spark-svg" viewBox="0 0 ${series.length} 10" preserveAspectRatio="none" role="img" aria-label="${esc(
    label
  )}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="0.62" stroke-linecap="butt"/><path d="M0 10H${series.length}" stroke="currentColor" stroke-width="0.12" opacity="0.35"/></svg>`;
}

export function stackBar(parts) {
  const total = parts.reduce((n, p) => n + (p.value || 0), 0) || 1;
  return `<div class="stack">${parts
    .map(
      (p) =>
        `<span style="width:${((p.value || 0) / total) * 100}%;background:${p.color}" title="${esc(
          p.label
        )}：${esc(p.display || p.value)}"></span>`
    )
    .join('')}</div>
  <div class="legend">${parts
    .map(
      (p) =>
        `<span><i style="background:${p.color}"></i>${esc(p.label)} <span class="subtle">${esc(
          p.display || p.value
        )}</span></span>`
    )
    .join('')}</div>`;
}

/* ------------------------------ 提示 / 空状态 ------------------------------ */

export function callout(html, { tone = '', icon: iconName = 'info' } = {}) {
  return `<div class="callout ${tone}">${icon(iconName, 15)}<div>${html}</div></div>`;
}

export function emptyState({ icon: iconName = 'inbox', title, desc, action = '' }) {
  return `<div class="empty">
    <span class="empty-icon">${icon(iconName, 20)}</span>
    <h3>${esc(title)}</h3>
    ${desc ? `<p>${desc}</p>` : ''}
    ${action}
  </div>`;
}

export function commandLine(cmd, label = '复制命令') {
  return `<div class="cmd"><code>${esc(cmd)}</code>
    <button class="copy-btn" type="button" data-copy="${esc(cmd)}" aria-label="${esc(label)}">${icon(
      'copy',
      14
    )}</button></div>`;
}

export function copyButton(value, label = '复制') {
  return `<button class="btn ghost icon sm" type="button" data-copy="${esc(value)}" title="${esc(
    label
  )}" aria-label="${esc(label)}">${icon('copy', 14)}</button>`;
}

export function apiBlock(items) {
  return `<details class="api-block">
    <summary>JSON 接口（给其他 Agent 读）</summary>
    <ul class="api-list">${items.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>
  </details>`;
}

export function lastSegment(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s || 'archive';
}
