// ==UserScript==
// @name         网页工具箱 · 剪贴板模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  剪贴板历史记录。依赖内核 wtb-core，仅在顶层运行。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_CLIP_MODULE__) return;

  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus || W.__WTB_CLIP_MODULE__) return;
    W.__WTB_CLIP_MODULE__ = true;

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }
    if (!IS_TOP) return;

    const { h } = bus;

    const MAX_ITEMS = 300;
    const PREVIEW_LEN = 140;
    let autoRecord = true;
    let items = [];
    let seq = 0;
    let suppressCopy = false;

    let ctxRef = null;
    let listEl = null;
    let statusEl = null;
    let autoCheckbox = null;

    function fmtTime(t) {
      const d = new Date(t);
      const p = n => String(n).padStart(2, '0');
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function toast(msg, err) {
      if (ctxRef && ctxRef.toast) ctxRef.toast(msg, err);
    }
    function setBadge(n) {
      if (ctxRef && ctxRef.setBadge) ctxRef.setBadge(n);
    }

    async function writeClipboard(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_) {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        suppressCopy = true;
        const ok = document.execCommand('copy');
        suppressCopy = false;
        ta.remove();
        return ok;
      } catch (_) {
        suppressCopy = false;
        return false;
      }
    }

    function refresh() {
      setBadge(items.length);
      if (!listEl) return;
      listEl.textContent = '';
      if (!items.length) {
        listEl.appendChild(h('div', { class: 'wtb-empty' },
          autoRecord ? '在页面里复制点东西试试～' : '点击「读取剪贴板」添加一条'));
        return;
      }

      const frag = document.createDocumentFragment();
      for (const it of items) {
        const item = h('div', { class: 'wtb-clip-item' });
        const txt = h('div', { class: 'txt' },
          it.text.length > PREVIEW_LEN ? it.text.slice(0, PREVIEW_LEN) + ' …' : it.text);
        const meta = h('div', { class: 'meta' }, [
          h('span', {}, fmtTime(it.time) + (it.from === 'manual' ? ' · 手动' : '')),
          h('span', {}, it.text.length + ' 字符')
        ]);
        const del = h('button', { class: 'del', title: '删除这条' }, '✕');
        del.addEventListener('click', e => {
          e.stopPropagation();
          items = items.filter(x => x.id !== it.id);
          refresh();
        });
        item.append(txt, meta, del);
        item.addEventListener('click', async () => {
          const ok = await writeClipboard(it.text);
          toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中', !ok);
        });
        frag.appendChild(item);
      }
      listEl.appendChild(frag);
    }

    function addItem(text, from) {
      if (typeof text !== 'string') return;
      const t = text.replace(/\r\n/g, '\n');
      if (!t.trim()) return;
      items.unshift({ id: ++seq, text: t, time: Date.now(), from: from || 'auto' });
      if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
      refresh();
    }

    function onCopy(e) {
      if (!autoRecord || suppressCopy) return;
      let text = '';
      try { if (e.clipboardData) text = e.clipboardData.getData('text/plain') || ''; } catch (_) {}
      if (!text) {
        const el = e.target;
        if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && typeof el.selectionStart === 'number') {
          text = el.value.slice(el.selectionStart, el.selectionEnd);
        }
      }
      if (!text) {
        const sel = document.getSelection();
        if (sel) text = sel.toString();
      }
      if (text) addItem(text, 'auto');
    }

    async function readClipboard() {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        toast('当前环境不支持读取剪贴板（需 HTTPS）', true);
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast('剪贴板是空的'); return; }
        addItem(text, 'manual');
        toast('已添加');
      } catch (err) {
        toast('读取失败：' + ((err && err.message) || err), true);
      }
    }

    const MODULE_CSS = `
      .wtb-clip-bar {
        display: flex; align-items: center; gap: 8px;
        padding-bottom: 10px; border-bottom: 1px solid #2c333e;
        margin-bottom: 6px;
      }
      .wtb-clip-list { min-height: 60px; }
      .wtb-clip-item {
        position: relative; padding: 8px 10px;
        border-bottom: 1px solid #2c333e; cursor: pointer;
      }
      .wtb-clip-item:hover { background: #262c36; }
      .wtb-clip-item .txt {
        padding-right: 20px; color: #d8dde5; line-height: 1.45;
        white-space: pre-wrap; word-break: break-all;
        max-height: 60px; overflow: hidden;
      }
      .wtb-clip-item .meta {
        margin-top: 4px; display: flex; justify-content: space-between;
        font-size: 10px; color: #6f7a8c;
      }
      .wtb-clip-item .del {
        position: absolute; top: 5px; right: 5px;
        width: 18px; height: 18px; border-radius: 4px;
        display: none; align-items: center; justify-content: center;
        font-size: 10px; color: #8b94a3;
        background: transparent; border: 0; cursor: pointer;
      }
      .wtb-clip-item:hover .del { display: flex; }
      .wtb-clip-item .del:hover { background: #3a2528; color: #ff6b6b; }
    `;

    bus.registerModule({
      id: 'clip',
      title: '剪贴板',
      icon: '📋',
      order: 20,
      mount(ctx) {
        ctxRef = ctx;
        ctx.addStyle(MODULE_CSS);
        const pane = ctx.pane;
        pane.innerHTML = '';

        autoCheckbox = h('input', { type: 'checkbox' });
        autoCheckbox.checked = autoRecord;
        const autoSwitch = h('label', { class: 'wtb-switch', title: '开启后页面内每次复制都会自动记录' }, [
          autoCheckbox,
          h('span', { class: 'track' }),
          h('span', {}, '自动记录')
        ]);
        const readBtn  = h('button', { class: 'wtb-btn ghost' }, '读取剪贴板');
        const clearBtn = h('button', { class: 'wtb-btn ghost' }, '清空');
        clearBtn.style.marginLeft = 'auto';

        const bar = h('div', { class: 'wtb-clip-bar' }, [autoSwitch, readBtn, clearBtn]);
        listEl = h('div', { class: 'wtb-clip-list' });
        statusEl = h('div', { class: 'wtb-status' });

        pane.appendChild(bar);
        pane.appendChild(listEl);
        pane.appendChild(statusEl);

        autoCheckbox.addEventListener('change', () => {
          autoRecord = autoCheckbox.checked;
          toast(autoRecord ? '已开启自动记录' : '已关闭自动记录，请手动添加');
          refresh();
        });
        readBtn.addEventListener('click', readClipboard);
        clearBtn.addEventListener('click', () => {
          if (!items.length) { toast('已经是空的了'); return; }
          items = [];
          refresh();
          toast('已清空');
        });

        document.addEventListener('copy', onCopy, true);
        ctx._onCopy = onCopy;
        refresh();
      },
      unmount(ctx) {
        if (ctx._onCopy) document.removeEventListener('copy', ctx._onCopy, true);
        ctxRef = null;
      }
    });

    /* 对外 API */
    bus.clip = { addItem, list: () => items.slice() };
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
