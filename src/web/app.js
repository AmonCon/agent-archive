/*
 * 查看器交互。
 *
 * 没有框架、没有构建、没有内联脚本（CSP 只允许 'self'）。
 * 所有数据都通过同源的 /api/* 读取，DOM 一律用 textContent 填充，
 * 不把服务端返回的标题/正文拼进 innerHTML。
 */

(function () {
  'use strict';

  var THEME_KEY = 'aa-theme';
  var SUN =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
  var MOON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  var COPY =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  var CHECK =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var CHEVRON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function storedTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : null;
    } catch (e) {
      return null;
    }
  }

  // TraeCode 是 dark-first：没有手动选择过主题时，默认深色。
  // 首屏之前就定下来，避免闪一下白底再切深色。
  var initialTheme = storedTheme() || 'dark';
  document.documentElement.dataset.theme = initialTheme;

  function syncTheme(theme) {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-toggle') === theme));
    });
    document.querySelectorAll('[data-theme-cycle]').forEach(function (b) {
      b.innerHTML = theme === 'dark' ? SUN : MOON;
      b.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
    });
  }

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (e) {
        /* 隐私模式下写不了，不影响本次切换 */
      }
    }
    syncTheme(theme);
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    syncTheme(document.documentElement.dataset.theme || initialTheme);

    /* ------------------------------ 主题 ------------------------------ */

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-theme-toggle]');
      if (btn) {
        applyTheme(btn.getAttribute('data-theme-toggle'), true);
        return;
      }
      var cycle = e.target.closest('[data-theme-cycle]');
      if (cycle) {
        var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next, true);
      }
    });

    /* ------------------------------ 移动端导航 ------------------------------ */

    var navToggle = document.querySelector('[data-nav-toggle]');
    var scrim = document.querySelector('.scrim');

    function setNav(open) {
      document.body.classList.toggle('nav-open', open);
      if (navToggle) navToggle.setAttribute('aria-expanded', String(open));
      if (scrim) scrim.hidden = !open;
    }

    if (navToggle) {
      navToggle.addEventListener('click', function () {
        setNav(!document.body.classList.contains('nav-open'));
      });
    }
    if (scrim) scrim.addEventListener('click', function () { setNav(false); });
    document.querySelectorAll('.sidebar a').forEach(function (a) {
      a.addEventListener('click', function () { setNav(false); });
    });

    /* ------------------------------ 提示 ------------------------------ */

    var toastTimer = null;
    function toast(text) {
      var el = document.getElementById('toast');
      if (!el) return;
      el.textContent = text;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1600);
    }

    /* ------------------------------ 复制 ------------------------------ */

    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (e) {
        /* 下面统一提示失败 */
      }
      document.body.removeChild(ta);
    }

    function copyText(text, btn) {
      var done = function () {
        toast('已复制');
        if (btn) {
          var prev = btn.innerHTML;
          btn.innerHTML = CHECK;
          btn.classList.add('done');
          setTimeout(function () {
            btn.innerHTML = prev || COPY;
            btn.classList.remove('done');
          }, 1400);
        }
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () {
          fallbackCopy(text);
          done();
        });
      } else {
        fallbackCopy(text);
        done();
      }
    }

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-copy]');
      if (!btn) return;
      e.preventDefault();
      var value = btn.getAttribute('data-copy') || '';
      if (!value) {
        var cmd = btn.closest('.cmd');
        var code = cmd && cmd.querySelector('code');
        value = code ? code.textContent : '';
      }
      if (value) copyText(value, btn);
    });

    /* ------------------------------ 摘要展开 ------------------------------ */

    var expandButtons = Array.prototype.slice.call(document.querySelectorAll('[data-expand]'));
    expandButtons.forEach(function (btn) {
      var target = document.getElementById(btn.getAttribute('data-expand'));
      if (!target) return;

      var refresh = function () {
        if (target.classList.contains('open')) return;
        var overflow = target.scrollHeight > target.clientHeight + 8;
        btn.hidden = !overflow;
      };

      btn.addEventListener('click', function () {
        var open = target.classList.toggle('open');
        btn.innerHTML = (open ? '收起摘要' : '展开摘要' + ' ' + CHEVRON);
        if (!open) refresh();
      });

      requestAnimationFrame(function () { setTimeout(refresh, 40); });
      window.addEventListener('resize', refresh);
    });

    /* ------------------------------ 折叠的工具输出 ------------------------------ */

    var msgList = document.getElementById('messages');

    function appendPre(parent, text) {
      var pre = document.createElement('pre');
      pre.textContent = text || '';
      parent.appendChild(pre);
    }

    function loadFolded(details) {
      if (!msgList) return;
      var box = details.querySelector('.folded-body');
      if (!box) return;

      details.dataset.loaded = '1';
      box.textContent = '';
      var loading = document.createElement('p');
      loading.className = 'hint';
      loading.style.padding = '0 11px 11px';
      loading.textContent = '加载中…';
      box.appendChild(loading);

      var url =
        '/api/session?agent=' +
        encodeURIComponent(msgList.dataset.agent || '') +
        '&id=' +
        encodeURIComponent(msgList.dataset.session || '') +
        '&message=' +
        encodeURIComponent(details.dataset.idx || '0');

      fetch(url, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.error) throw new Error(j.error);
          box.textContent = '';
          var parts = (j.message && j.message.parts) || [];
          var body = document.createElement('div');
          body.className = 'tool-body';

          parts.forEach(function (p) {
            if (p.kind === 'text' || p.kind === 'reasoning') {
              var h = document.createElement('h4');
              h.textContent = p.kind === 'reasoning' ? '推理' : '正文';
              body.appendChild(h);
              appendPre(body, p.text);
            } else if (p.kind === 'tool') {
              var name = document.createElement('h4');
              name.textContent = (p.name || '工具') + (p.status && p.status !== 'completed' ? ' · ' + p.status : '');
              body.appendChild(name);
              if (p.input) {
                var inLabel = document.createElement('h4');
                inLabel.textContent = '入参';
                body.appendChild(inLabel);
                appendPre(body, typeof p.input === 'string' ? p.input : JSON.stringify(p.input, null, 2));
              }
              if (p.output) {
                var outLabel = document.createElement('h4');
                outLabel.textContent = '输出';
                body.appendChild(outLabel);
                appendPre(body, p.output);
              }
            }
          });

          if (!body.childNodes.length) {
            var none = document.createElement('p');
            none.className = 'hint';
            none.textContent = '（没有内容）';
            box.appendChild(none);
          } else {
            box.appendChild(body);
          }
        })
        .catch(function (err) {
          box.textContent = '';
          var p = document.createElement('p');
          p.className = 'hint';
          p.style.padding = '0 11px 11px';
          p.textContent = '加载失败：' + (err && err.message ? err.message : err) + '（再点一次重试）';
          box.appendChild(p);
          delete details.dataset.loaded;
        });
    }

    document.addEventListener(
      'toggle',
      function (e) {
        var d = e.target;
        if (!d || !d.classList || !d.classList.contains('folded')) return;
        if (d.open && !d.dataset.loaded) loadFolded(d);
      },
      true
    );

    /* ------------------------------ 表格筛选 ------------------------------ */

    document.querySelectorAll('input[data-filter]').forEach(function (input) {
      var table = document.getElementById(input.getAttribute('data-filter'));
      if (!table) return;
      var body = table.tBodies[0];
      var counter = document.querySelector('[data-filter-count="' + input.getAttribute('data-filter') + '"]');
      if (!body) return;

      var rows = Array.prototype.slice.call(body.rows);

      input.addEventListener('input', function () {
        var q = input.value.trim().toLowerCase();
        var visible = 0;
        rows.forEach(function (tr) {
          var hit = !q || tr.textContent.toLowerCase().indexOf(q) !== -1;
          tr.style.display = hit ? '' : 'none';
          if (hit) visible++;
        });
        if (counter) counter.textContent = q ? visible + ' / ' + rows.length : '';
      });
    });

    /* ------------------------------ 命令面板 ------------------------------ */

    var palette = document.getElementById('palette');
    var input = document.getElementById('palette-input');
    var results = document.getElementById('palette-results');
    var seq = 0;
    var timer = null;
    var selected = 0;
    var abort = null;
    var opener = null;

    if (palette && input && results) {
      var staticItems = [];
      var itemSeq = 0;

      function collectStatic() {
        staticItems = [];
        document.querySelectorAll('.sidebar .nav a').forEach(function (a) {
          var label = a.textContent.trim();
          staticItems.push({
            group: '页面',
            title: label,
            meta: a.getAttribute('href'),
            href: a.getAttribute('href'),
            icon: 'page',
          });
        });
        document.querySelectorAll('.recent-list a').forEach(function (a) {
          var name = a.querySelector('.name');
          staticItems.push({
            group: '最近项目',
            title: name ? name.textContent.trim() : a.textContent.trim(),
            meta: a.getAttribute('title') || '',
            href: a.getAttribute('href'),
            icon: 'folder',
          });
        });
      }

      function makeItem(entry) {
        var a = document.createElement('a');
        a.className = 'palette-item';
        a.id = 'palette-item-' + ++itemSeq;
        a.href = entry.href;
        a.setAttribute('role', 'option');
        a.setAttribute('aria-selected', 'false');
        a.dataset.group = entry.group;

        var icon = document.createElement('span');
        icon.className = 'pi-icon';
        icon.innerHTML = entry.icon === 'folder' ? folderIcon() : pageIcon();
        a.appendChild(icon);

        var main = document.createElement('span');
        main.className = 'pi-main';
        var title = document.createElement('span');
        title.className = 'pi-title';
        title.textContent = entry.title;
        main.appendChild(title);
        if (entry.meta) {
          var meta = document.createElement('span');
          meta.className = 'pi-meta';
          meta.textContent = entry.meta;
          main.appendChild(meta);
        }
        a.appendChild(main);

        var enter = document.createElement('span');
        enter.className = 'pi-enter';
        enter.textContent = '↵';
        a.appendChild(enter);

        a.addEventListener('mouseenter', function () {
          select(Array.prototype.indexOf.call(results.querySelectorAll('.palette-item'), a));
        });
        return a;
      }

      function pageIcon() {
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>';
      }

      function folderIcon() {
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
      }

      function groupLabel(text) {
        var g = document.createElement('div');
        g.className = 'palette-group';
        g.textContent = text;
        return g;
      }

      function select(index) {
        var items = results.querySelectorAll('.palette-item');
        if (!items.length) return;
        selected = Math.max(0, Math.min(items.length - 1, index));
        items.forEach(function (el, i) {
          el.setAttribute('aria-selected', String(i === selected));
        });
        var active = items[selected];
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
        if (active && active.id) input.setAttribute('aria-activedescendant', active.id);
        else input.removeAttribute('aria-activedescendant');
      }

      function renderStatic(q, append) {
        if (!append) results.textContent = '';
        var needle = q.toLowerCase();
        var matches = staticItems.filter(function (it) {
          if (!needle) return true;
          return (it.title + ' ' + it.meta).toLowerCase().indexOf(needle) !== -1;
        });
        if (matches.length) {
          results.appendChild(groupLabel(q ? '页面与项目' : '跳转'));
          matches.slice(0, q ? 10 : 20).forEach(function (it) {
            results.appendChild(makeItem(it));
          });
        }
        return matches.length;
      }

      function renderHits(hits, q) {
        if (!hits.length) return false;
        results.appendChild(groupLabel('会话 · ' + q));
        hits.slice(0, 8).forEach(function (h) {
          results.appendChild(
            makeItem({
              group: '会话',
              title: h.title || h.id,
              meta: [h.agent, h.project || '', h.start ? String(h.start).slice(0, 10) : '']
                .filter(Boolean)
                .join(' · '),
              href: '/s?agent=' + encodeURIComponent(h.agent) + '&id=' + encodeURIComponent(h.id),
              icon: 'page',
            })
          );
        });
        return true;
      }

      function renderEmpty(text) {
        var d = document.createElement('div');
        d.className = 'palette-empty';
        d.textContent = text;
        results.appendChild(d);
      }

      function search(q) {
        if (abort) abort.abort();
        abort = new AbortController();
        var my = ++seq;
        results.textContent = '';
        var loading = document.createElement('div');
        loading.className = 'palette-empty';
        loading.textContent = '搜索会话…';
        results.appendChild(loading);

        fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=8', {
          signal: abort.signal,
          headers: { accept: 'application/json' },
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (my !== seq) return;
            loading.remove();
            if (!j.ready) {
              renderStatic(q, true);
              renderEmpty(j.message || '索引还没建，先运行 agent-archive index。');
              return;
            }
            var drawn = renderHits(j.hits || [], q);
            var pages = renderStatic(q, true);
            if (!drawn && !pages) renderEmpty('没有找到。');
            select(0);
          })
          .catch(function (err) {
            if (err && err.name === 'AbortError') return;
            if (my !== seq) return;
            loading.remove();
            renderStatic(q, true);
            renderEmpty('搜索失败。');
          });
      }

      function open(from) {
        opener = from || null;
        collectStatic();
        palette.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
        input.value = '';
        results.textContent = '';
        renderStatic('');
        selected = 0;
        select(0);
        input.focus();
      }

      function close() {
        palette.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        document.body.style.overflow = '';
        if (abort) abort.abort();
        if (timer) clearTimeout(timer);
        if (opener && opener.focus) opener.focus();
        opener = null;
      }

      document.querySelectorAll('[data-open-palette]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.preventDefault();
          open(b);
        });
      });

      palette.addEventListener('click', function (e) {
        if (e.target === palette) close();
      });

      palette.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') return;
        var focusables = palette.querySelectorAll('input, .palette-item');
        if (!focusables.length) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });

      input.addEventListener('input', function () {
        var q = input.value.trim();
        if (timer) clearTimeout(timer);
        if (!q) {
          seq++;
          if (abort) abort.abort();
          renderStatic('');
          select(0);
          return;
        }
        timer = setTimeout(function () { search(q); }, 160);
      });

      input.addEventListener('keydown', function (e) {
        var items = results.querySelectorAll('.palette-item');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          select(selected + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          select(selected - 1);
        } else if (e.key === 'Enter') {
          if (items[selected]) {
            e.preventDefault();
            items[selected].click();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      });

      document.addEventListener('keydown', function (e) {
        var mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === 'k' || e.key === 'K')) {
          e.preventDefault();
          if (palette.hidden) open();
          else close();
          return;
        }
        if (e.key === '/' && palette.hidden) {
          var t = e.target;
          var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
          e.preventDefault();
          open();
          return;
        }
        if (e.key === 'Escape') {
          if (!palette.hidden) close();
          else setNav(false);
        }
      });
    }

    /* ------------------------------ 回到顶部 ------------------------------ */

    var toTop = document.querySelector('[data-to-top]');
    if (toTop) {
      var onScroll = function () {
        toTop.classList.toggle('show', window.scrollY > 600);
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
      toTop.addEventListener('click', function () {
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      });
    }
  });
})();
