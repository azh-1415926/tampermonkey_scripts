// ==UserScript==
// @name         网页工具箱 · 剪切板备忘录模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  多分组剪切备忘录，点击即复制正文（备注不复制），支持追加备注、搜索、置顶、编辑、跨页面 / 跨标签页同步存储、导入导出备份。依赖内核 wtb-core，仅在顶层运行。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_CLIP_MODULE__) return;

  /* ============================================================
   *  存储层：优先 GM_*（跨站点共享），退回 localStorage（同源共享）
   * ============================================================ */
  const STORE_KEY = 'wtb_clips_v1';
  const hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

  const store = {
    readRaw() {
      try {
        return hasGM
          ? (GM_getValue(STORE_KEY, '') || '')
          : (localStorage.getItem(STORE_KEY) || '');
      } catch (e) { return ''; }
    },
    read() {
      const raw = this.readRaw();
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
    write(data) {
      const raw = JSON.stringify(data);
      try {
        if (hasGM) GM_setValue(STORE_KEY, raw);
        else localStorage.setItem(STORE_KEY, raw);
      } catch (e) { /* 配额满 / 隐私模式，静默忽略 */ }
    },
    /** 监听其它标签页 / 页面的写入，返回取消监听的函数 */
    watch(cb) {
      const teardown = [];

      if (hasGM && typeof GM_addValueChangeListener === 'function') {
        try {
          const id = GM_addValueChangeListener(STORE_KEY, function (n, ov, nv, remote) {
            if (remote) cb();
          });
          teardown.push(function () {
            try { if (typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(id); } catch (e) {}
          });
        } catch (e) {}
      }

      const onStorage = function (e) { if (!e || e.key === STORE_KEY) cb(); };
      window.addEventListener('storage', onStorage);
      teardown.push(function () { window.removeEventListener('storage', onStorage); });

      // 兜底轮询：GM 存储没有 storage 事件，某些环境也不支持 change listener
      let last = store.readRaw();
      const timer = setInterval(function () {
        const now = store.readRaw();
        if (now !== last) { last = now; cb(); }
      }, 4000);
      teardown.push(function () { clearInterval(timer); });

      return function () {
        teardown.forEach(function (fn) { try { fn(); } catch (e) {} });
      };
    }
  };

  /* ============================================================
   *  时间工具
   * ============================================================ */
  const pad2 = n => String(n).padStart(2, '0');

  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t), now = new Date();
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const sameDay = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? hm : (pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm);
  }

  /* ============================================================
   *  剪贴板写入（execCommand 优先，clipboard API 兜底）
   * ============================================================ */
  function fallbackCopy(text) {
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      try { ta.setSelectionRange(0, ta.value.length); } catch (e) {}
      const ok = document.execCommand('copy');
      return !!ok;
    } catch (e) {
      return false;
    } finally {
      if (ta && ta.parentNode) ta.remove();
    }
  }

  function copyText(text) {
    // 用户手势内同步执行成功率最高
    if (fallbackCopy(text)) return Promise.resolve(true);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          function () { return true; },
          function () { return false; }
        );
      }
    } catch (e) {}
    return Promise.resolve(false);
  }

  /* ============================================================
   *  模块主体
   * ============================================================ */
  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus || W.__WTB_CLIP_MODULE__) return;
    W.__WTB_CLIP_MODULE__ = true;

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }
    if (!IS_TOP) return;

    const { h } = bus;

    /* ---------- 常量 & 状态 ---------- */
    const MAX_GROUPS = 30;
    const MAX_ITEMS_PER_GROUP = 800;
    const MAX_TEXT_LEN = 20000;      // 单条正文最大字符数
    const MAX_NOTE_LEN = 2000;       // 单条备注最大字符数
    const MAX_TOTAL_CHARS = 800000;  // 总量粗上限

    let DB = { v: 1, groups: [], activeId: null };
    let seq = 0;
    let ctxRef = null;
    let unsub = null;

    let groupsEl = null;
    let bodyEl = null;
    let statEl = null;
    let clearAllBtn = null;
    let inputEl = null;
    let searchEl = null;

    /* ---------- 小工具 ---------- */
    function uid() {
      return Date.now().toString(36) + '-' + (++seq).toString(36) +
        Math.random().toString(36).slice(2, 5);
    }
    function toast(msg, err) {
      if (ctxRef && ctxRef.toast) ctxRef.toast(msg, err);
    }
    function setBadge(n) {
      if (ctxRef && ctxRef.setBadge) ctxRef.setBadge(n);
    }
    function ask(msg) {
      try { return window.confirm(msg); } catch (e) { return true; }
    }

    /* ---------- 数据规范化 ---------- */
    function normalize(raw) {
      const out = { v: 1, groups: [], activeId: null };

      if (raw && Array.isArray(raw.groups)) {
        for (const g of raw.groups) {
          if (!g || typeof g !== 'object') continue;
          const items = [];
          if (Array.isArray(g.items)) {
            for (const it of g.items) {
              if (!it || typeof it.text !== 'string') continue;
              if (!it.text.trim()) continue;
              const created = +it.created || Date.now();
              items.push({
                id: it.id || uid(),
                text: it.text.slice(0, MAX_TEXT_LEN),
                note: typeof it.note === 'string' ? it.note.slice(0, MAX_NOTE_LEN) : '',
                pinned: !!it.pinned,
                created: created,
                updated: +it.updated || created,
                copiedAt: +it.copiedAt || 0,
                copyCount: +it.copyCount || 0
              });
              if (items.length >= MAX_ITEMS_PER_GROUP) break;
            }
          }
          out.groups.push({
            id: g.id || uid(),
            name: String(g.name || '未命名分组').slice(0, 40),
            items: items
          });
          if (out.groups.length >= MAX_GROUPS) break;
        }
      }

      if (!out.groups.length) {
        out.groups.push({ id: uid(), name: '默认分组', items: [] });
      }
      const ids = out.groups.map(g => g.id);
      const want = raw && raw.activeId;
      out.activeId = ids.indexOf(want) >= 0 ? want : out.groups[0].id;
      return out;
    }

    function load() { DB = normalize(store.read()); }
    function save() { store.write(DB); }

    function activeGroup() {
      return DB.groups.find(g => g.id === DB.activeId) || DB.groups[0];
    }

    function totalChars() {
      let n = 0;
      for (const g of DB.groups) for (const it of g.items) n += it.text.length;
      return n;
    }

    /* ---------- 核心：写入一条内容 ----------
     * 返回写入（或已存在）的条目对象；失败返回 null
     * ------------------------------------------ */
    function pushItem(group, text) {
      const v = String(text == null ? '' : text);
      if (!v.trim()) return null;
      if (v.length > MAX_TEXT_LEN) return null;
      if (group.items.length >= MAX_ITEMS_PER_GROUP) return null;
      if (totalChars() + v.length > MAX_TOTAL_CHARS) return null;

      const dup = group.items.find(x => x.text === v);
      if (dup) { dup.updated = Date.now(); return dup; }

      const item = {
        id: uid(),
        text: v,
        note: '',
        pinned: false,
        created: Date.now(),
        updated: Date.now(),
        copiedAt: 0,
        copyCount: 0
      };
      group.items.push(item);
      return item;
    }

    /* ---------- 渲染：分组 ---------- */
    function updateBadge() {
      setBadge(activeGroup().items.length);
    }

    function renderGroups() {
      if (!groupsEl) return;
      groupsEl.textContent = '';
      for (const g of DB.groups) {
        const on = g.id === DB.activeId;
        const chip = h('button', { class: 'wtb-cl-chip' + (on ? ' on' : ''), type: 'button' }, g.name);
        chip.dataset.id = g.id;
        chip.title = g.name + '（双击重命名）';
        chip.addEventListener('click', () => {
          if (DB.activeId === g.id) return;
          DB.activeId = g.id;
          save();
          renderAll();
        });
        chip.addEventListener('dblclick', e => {
          e.preventDefault();
          e.stopPropagation();
          renameGroupInline(g);
        });
        groupsEl.appendChild(chip);
      }
    }

    /* ---------- 渲染：条目 ---------- */
    function cmpItem(a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updated - a.updated;
    }

    function doCopy(item, row, paintMeta) {
      // 只复制正文，备注不参与复制
      copyText(item.text).then(function (ok) {
        if (!ok) {
          toast('复制失败，请手动选中文本复制', true);
          return;
        }
        item.copyCount = (item.copyCount || 0) + 1;
        item.copiedAt = Date.now();
        save();
        if (paintMeta) paintMeta();
        if (row) {
          row.classList.add('copied');
          setTimeout(function () {
            try { row.classList.remove('copied'); } catch (e) {}
          }, 600);
        }
        toast('已复制正文到剪贴板');
      });
    }

    function renderItem(item) {
      const row = h('div', { class: 'wtb-cl-item' + (item.pinned ? ' pinned' : '') });
      row.title = '点击复制正文到剪贴板（备注不会被复制）';

      const txt = h('div', { class: 'wtb-cl-text' }, item.text);

      /* 备注：只读展示，点击可编辑 */
      const noteEl = h('div', {
        class: 'wtb-cl-note' + (item.note ? '' : ' empty')
      }, item.note || '');
      noteEl.title = '点击编辑备注（不会随正文复制）';
      noteEl.addEventListener('click', e => {
        e.stopPropagation();
        startEditNote(row, item);
      });

      const meta = h('div', { class: 'wtb-cl-meta' });
      const paintMeta = function () {
        meta.textContent = fmtTime(item.updated) +
          (item.copyCount ? ' · 已复制 ' + item.copyCount + ' 次' : '');
      };
      paintMeta();

      const body = h('div', { class: 'wtb-cl-body' }, [txt, noteEl, meta]);

      const pinBtn = h('button', {
        class: 'wtb-cl-btn' + (item.pinned ? ' on' : ''),
        type: 'button',
        title: item.pinned ? '取消置顶' : '置顶'
      }, item.pinned ? '★' : '☆');
      pinBtn.addEventListener('click', e => {
        e.stopPropagation();
        item.pinned = !item.pinned;
        save();
        renderItems();
      });

      const noteBtn = h('button', {
        class: 'wtb-cl-btn' + (item.note ? ' note-on' : ''),
        type: 'button',
        title: item.note ? '编辑备注' : '添加备注'
      }, '💬');
      noteBtn.addEventListener('click', e => {
        e.stopPropagation();
        startEditNote(row, item);
      });

      const editBtn = h('button', { class: 'wtb-cl-btn', type: 'button', title: '编辑正文' }, '✎');
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        startEditItem(row, body, item);
      });

      const delBtn = h('button', { class: 'wtb-cl-btn danger', type: 'button', title: '删除' }, '✕');
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        const g = activeGroup();
        g.items = g.items.filter(x => x.id !== item.id);
        save();
        renderItems();
        updateBadge();
      });

      const tools = h('div', { class: 'wtb-cl-tools' }, [pinBtn, noteBtn, editBtn, delBtn]);

      row.append(body, tools);

      row.addEventListener('click', function () {
        if (row.__editing) return;
        doCopy(item, row, paintMeta);
      });

      return row;
    }

    function renderItems() {
      if (!bodyEl) return;
      bodyEl.textContent = '';

      const g = activeGroup();
      const kw = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();

      let items = g.items.slice();
      if (kw) {
        items = items.filter(it =>
          it.text.toLowerCase().indexOf(kw) >= 0 ||
          (it.note && it.note.toLowerCase().indexOf(kw) >= 0)
        );
      }
      items.sort(cmpItem);

      if (!items.length) {
        bodyEl.appendChild(h('div', { class: 'wtb-empty' },
          kw ? '没有匹配的内容' : '这里还空着，粘贴点什么吧～'));
      } else {
        const frag = document.createDocumentFragment();
        for (const it of items) frag.appendChild(renderItem(it));
        bodyEl.appendChild(frag);
      }

      const total = g.items.length;
      const chars = g.items.reduce((s, it) => s + it.text.length, 0);
      statEl.textContent = total
        ? (total + ' 条 · ' + chars + ' 字符' + (kw ? '（已筛选）' : ''))
        : '暂无内容';
      clearAllBtn.style.display = total ? '' : 'none';
    }

    function renderAll() {
      renderGroups();
      renderItems();
      updateBadge();
    }

    /* ---------- 行内编辑正文 ---------- */
    function startEditItem(row, bodyElm, item) {
      if (row.__editing) return;
      row.__editing = true;

      const ta = h('textarea', { class: 'wtb-cl-edit' });
      ta.value = item.text;
      ta.rows = Math.min(10, Math.max(3, item.text.split('\n').length));
      bodyElm.replaceWith(ta);
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const v = ta.value;
        if (ok && v.trim()) {
          item.text = v.slice(0, MAX_TEXT_LEN);
          item.updated = Date.now();
          save();
        }
        renderItems();
      };
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      ta.addEventListener('blur', function () { finish(true); });
      ta.addEventListener('click', e => e.stopPropagation());
      ta.addEventListener('dblclick', e => e.stopPropagation());
    }

    /* ---------- 行内编辑备注 ---------- */
    function startEditNote(row, item) {
      if (row.__editing) return;
      const noteEl = row.querySelector('.wtb-cl-note');
      if (!noteEl) return;
      row.__editing = true;

      const ta = h('textarea', {
        class: 'wtb-cl-edit-note',
        placeholder: '备注（Enter 保存 / Shift+Enter 换行 / Esc 取消，不会随正文复制）'
      });
      ta.value = item.note || '';
      ta.rows = 2;
      noteEl.replaceWith(ta);
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const v = ta.value.trim();
        if (ok) {
          item.note = v.slice(0, MAX_NOTE_LEN);
          item.updated = Date.now();
          save();
        }
        renderItems();
      };
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      ta.addEventListener('blur', function () { finish(true); });
      ta.addEventListener('click', e => e.stopPropagation());
      ta.addEventListener('dblclick', e => e.stopPropagation());
    }

    /* ---------- 行内重命名分组 ---------- */
    function renameGroupInline(group) {
      const chip = groupsEl.querySelector('[data-id="' + group.id + '"]');
      if (!chip) return;
      const input = h('input', { class: 'wtb-cl-newinput', type: 'text' });
      input.value = group.name;
      input.style.cssText = 'flex:0 0 110px;padding:3px 10px;border-radius:999px;' +
        'font-family:inherit;font-size:12px;color:#d8dde5;background:#1b2029;' +
        'border:1px solid #3d5a7d;outline:none;';
      chip.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (ok && v) { group.name = v.slice(0, 40); save(); }
        renderAll();
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    /* ---------- 增删改 ---------- */
    function addItem(text) {
      const v = String(text == null ? '' : text);
      if (!v.trim()) return;
      const g = activeGroup();
      if (v.length > MAX_TEXT_LEN) {
        toast('单条正文上限 ' + MAX_TEXT_LEN + ' 字符', true);
        return;
      }
      if (g.items.length >= MAX_ITEMS_PER_GROUP) {
        toast('单个分组最多 ' + MAX_ITEMS_PER_GROUP + ' 条', true);
        return;
      }
      if (totalChars() + v.length > MAX_TOTAL_CHARS) {
        toast('存储接近上限，请先导出备份并清理', true);
        return;
      }
      const dup = g.items.some(x => x.text === v);
      if (!pushItem(g, v)) return;
      save();
      renderItems();
      updateBadge();
      if (dup) toast('内容已存在，已移到最前');
    }

    /* ---------- 新建分组（行内输入） ---------- */
    function createGroupInline() {
      if (groupsEl.querySelector('.wtb-cl-newinput')) return;
      if (DB.groups.length >= MAX_GROUPS) { toast('最多 ' + MAX_GROUPS + ' 个分组', true); return; }

      const input = h('input', { class: 'wtb-cl-newinput', type: 'text', placeholder: '分组名称' });
      input.style.cssText = 'flex:0 0 100px;padding:3px 10px;border-radius:999px;' +
        'font-family:inherit;font-size:12px;color:#d8dde5;background:#1b2029;' +
        'border:1px solid #3d5a7d;outline:none;';
      groupsEl.appendChild(input);
      input.focus();

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (input.parentNode) input.remove();
        if (ok && name) {
          const g = { id: uid(), name: name.slice(0, 40), items: [] };
          DB.groups.push(g);
          DB.activeId = g.id;
          save();
          renderAll();
          toast('已创建分组「' + g.name + '」');
        }
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    /* ---------- 复制当前分组为新分组 ---------- */
    function duplicateActiveGroup() {
      if (groupsEl.querySelector('.wtb-cl-newinput')) return;
      if (DB.groups.length >= MAX_GROUPS) { toast('最多 ' + MAX_GROUPS + ' 个分组', true); return; }

      const src = activeGroup();
      const baseName = src.name.replace(/\s*副本(\s*\d+)?$/, '') + ' 副本';
      let suggest = baseName;
      let n = 1;
      const used = new Set(DB.groups.map(g => g.name));
      while (used.has(suggest)) { suggest = baseName + ' ' + (++n); }

      const input = h('input', { class: 'wtb-cl-newinput', type: 'text', placeholder: '新分组名称' });
      input.value = suggest;
      input.style.cssText = 'flex:0 0 130px;padding:3px 10px;border-radius:999px;' +
        'font-family:inherit;font-size:12px;color:#d8dde5;background:#1b2029;' +
        'border:1px solid #3d5a7d;outline:none;';
      groupsEl.appendChild(input);
      input.focus();
      input.select();

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (input.parentNode) input.remove();
        if (!ok || !name) return;

        const newGroup = {
          id: uid(),
          name: name.slice(0, 40),
          items: src.items.map(it => ({
            id: uid(),
            text: it.text,
            note: it.note,
            pinned: it.pinned,
            created: it.created,
            updated: it.updated,
            copiedAt: it.copiedAt,
            copyCount: it.copyCount
          }))
        };
        DB.groups.push(newGroup);
        DB.activeId = newGroup.id;
        save();
        renderAll();
        toast('已复制为「' + newGroup.name + '」（' + newGroup.items.length + ' 条）');
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    function deleteActiveGroup() {
      if (DB.groups.length <= 1) { toast('至少要保留一个分组', true); return; }
      const g = activeGroup();
      if (!ask('删除分组「' + g.name + '」及其 ' + g.items.length + ' 条内容？')) return;
      const idx = DB.groups.indexOf(g);
      DB.groups = DB.groups.filter(x => x.id !== g.id);
      DB.activeId = DB.groups[Math.min(idx, DB.groups.length - 1)].id;
      save();
      renderAll();
      toast('已删除分组');
    }

    function clearActiveGroup() {
      const g = activeGroup();
      if (!g.items.length) return;
      if (!ask('清空分组「' + g.name + '」中的 ' + g.items.length + ' 条内容？')) return;
      g.items = [];
      save();
      renderAll();
      toast('已清空分组');
    }

    /* ---------- 读取系统剪贴板填入输入框 ---------- */
    function pasteFromClipboard() {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        toast('当前环境不支持读取剪贴板，请手动粘贴（Ctrl+V）', true);
        return;
      }
      navigator.clipboard.readText().then(function (t) {
        if (!t) { toast('剪贴板是空的', true); return; }
        if (inputEl) { inputEl.value = t; inputEl.focus(); }
      }, function () {
        toast('无法读取剪贴板，请手动粘贴（Ctrl+V）', true);
      });
    }

    /* ---------- 导出：下载 JSON 备份 ---------- */
    function exportData() {
      try {
        const data = JSON.stringify(DB, null, 2);
        const now = new Date();
        const stamp = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
          '-' + pad2(now.getHours()) + pad2(now.getMinutes());
        const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'wtb-clips-' + stamp + '.json';
        a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(function () {
          try { a.remove(); } catch (e) {}
          try { URL.revokeObjectURL(url); } catch (e) {}
        }, 1000);

        const n = DB.groups.reduce((s, g) => s + g.items.length, 0);
        toast('已导出 ' + DB.groups.length + ' 个分组 / ' + n + ' 条内容');
      } catch (e) {
        toast('导出失败：' + ((e && e.message) || e), true);
      }
    }

    /* ---------- 导入：选择 JSON 文件 ---------- */
    function importData() {
      let picker;
      try {
        picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.json,application/json,text/plain';
        picker.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      } catch (e) {
        toast('当前环境不支持文件选择', true);
        return;
      }

      picker.addEventListener('change', function () {
        const file = picker.files && picker.files[0];
        try { picker.remove(); } catch (e) {}
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function () {
          let raw = null;
          try {
            raw = JSON.parse(String(reader.result || ''));
          } catch (e) {
            toast('导入失败：不是合法的 JSON 文件', true);
            return;
          }
          importFromJSON(raw);
        };
        reader.onerror = function () { toast('读取文件失败', true); };
        try { reader.readAsText(file, 'utf-8'); }
        catch (e) { toast('读取文件失败', true); }
      });

      (document.body || document.documentElement).appendChild(picker);
      picker.click();
    }

    /* ---------- 导入：数据合并 / 覆盖 ---------- */
    function importFromJSON(raw) {
      if (!raw || !Array.isArray(raw.groups) || !raw.groups.length) {
        toast('导入失败：文件中没有分组数据', true);
        return;
      }

      const incoming = normalize({ v: 1, groups: raw.groups });
      const totalItems = incoming.groups.reduce((s, g) => s + g.items.length, 0);

      const replace = ask(
        '即将导入 ' + incoming.groups.length + ' 个分组 / ' + totalItems + ' 条内容。\n\n' +
        '「确定」= 覆盖现有全部数据\n' +
        '「取消」= 合并到现有数据之后'
      );

      if (replace) {
        DB = incoming;
        save();
        renderAll();
        toast('已覆盖导入 ' + DB.groups.length + ' 个分组 / ' + totalItems + ' 条内容');
        return;
      }

      const used = new Set(DB.groups.map(g => g.name));
      let addedGroups = 0;
      let addedItems = 0;

      for (const g of incoming.groups) {
        if (DB.groups.length >= MAX_GROUPS) break;
        let name = g.name;
        let i = 1;
        while (used.has(name)) { name = g.name + ' (' + (++i) + ')'; }
        used.add(name);

        const items = g.items.map(it => ({
          id: uid(),
          text: it.text,
          note: it.note,
          pinned: it.pinned,
          created: it.created,
          updated: it.updated,
          copiedAt: it.copiedAt,
          copyCount: it.copyCount
        }));

        DB.groups.push({ id: uid(), name: name.slice(0, 40), items: items });
        addedGroups++;
        addedItems += items.length;
      }

      if (!addedGroups) { toast('未导入：分组数量已达上限', true); return; }

      DB.activeId = DB.groups[DB.groups.length - 1].id;
      save();
      renderAll();
      toast('已合并 ' + addedGroups + ' 个分组 / ' + addedItems + ' 条内容');
    }

    /* ---------- 跨页面同步 ---------- */
    function onRemoteChange() {
      const next = normalize(store.read());
      if (JSON.stringify(next) === JSON.stringify(DB)) return;
      DB = next;
      renderAll();
    }

    /* ============================================================
     *  样式
     * ============================================================ */
    const MODULE_CSS = `
      .wtb-cl-bar {
        display: flex; align-items: center; gap: 6px;
        padding-bottom: 8px; border-bottom: 1px solid #2c333e;
      }
      .wtb-cl-groups {
        display: flex; align-items: center; gap: 6px;
        flex: 1 1 auto; min-width: 0;
        overflow-x: auto; padding-bottom: 2px;
      }
      .wtb-cl-groups::-webkit-scrollbar { height: 4px; }
      .wtb-cl-groups::-webkit-scrollbar-thumb { background: #3a4250; border-radius: 2px; }
      .wtb-cl-groups::-webkit-scrollbar-track { background: transparent; }

      .wtb-cl-chip {
        flex: 0 0 auto; max-width: 130px;
        padding: 3px 10px; border-radius: 999px;
        font-size: 12px; line-height: 1.6; font-family: inherit;
        color: #8b94a3; background: #222833; border: 1px solid transparent;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        cursor: pointer;
        transition: background .12s, color .12s, border-color .12s;
      }
      .wtb-cl-chip:hover { color: #d8dde5; background: #2a3140; }
      .wtb-cl-chip.on { color: #8fc4ff; background: #1e2c3e; border-color: #2f4a68; }

      .wtb-cl-icon {
        flex: 0 0 auto; width: 22px; height: 22px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid #2c333e; border-radius: 6px;
        background: transparent; color: #8b94a3;
        font-size: 12px; line-height: 1; font-family: inherit;
        cursor: pointer;
        transition: background .12s, color .12s, border-color .12s;
      }
      .wtb-cl-icon:hover { background: #2a3140; color: #d8dde5; }
      .wtb-cl-icon.danger:hover { background: #3a2528; color: #ff6b6b; border-color: #4a2b2f; }

      .wtb-cl-search { display: flex; gap: 6px; margin-top: 10px; }
      .wtb-cl-input {
        flex: 1 1 auto; min-width: 0;
        padding: 6px 9px; border-radius: 6px; font-family: inherit;
        font-size: 12px; color: #d8dde5;
        background: #1b2029; border: 1px solid #2c333e;
        outline: none; transition: border-color .12s;
      }
      .wtb-cl-input::placeholder { color: #5a6474; }
      .wtb-cl-input:focus { border-color: #3d5a7d; }

      .wtb-cl-add { display: flex; gap: 6px; margin: 8px 0; align-items: flex-start; }
      .wtb-cl-textarea {
        flex: 1 1 auto; min-width: 0; box-sizing: border-box;
        min-height: 40px; max-height: 150px; resize: vertical;
        padding: 7px 9px; border-radius: 6px; font-family: inherit;
        font-size: 12px; line-height: 1.5; color: #d8dde5;
        background: #1b2029; border: 1px solid #2c333e;
        outline: none; transition: border-color .12s;
      }
      .wtb-cl-textarea::placeholder { color: #5a6474; }
      .wtb-cl-textarea:focus { border-color: #3d5a7d; }

      .wtb-cl-body { min-height: 60px; }

      .wtb-cl-item {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 7px 8px; border-radius: 6px;
        border: 1px solid transparent;
        cursor: pointer;
        transition: background .12s, border-color .12s;
      }
      .wtb-cl-item:hover { background: #262c36; }
      .wtb-cl-item.pinned { border-color: #38414f; box-shadow: inset 2px 0 0 #c9a34a; }
      .wtb-cl-item.copied { background: #1e3a2a; border-color: #2f6b45; }

      .wtb-cl-body { flex: 1 1 auto; min-width: 0; }
      .wtb-cl-text {
        font-size: 12px; line-height: 1.5; color: #d8dde5;
        white-space: pre-wrap; word-break: break-word;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .wtb-cl-meta { margin-top: 3px; font-size: 10px; color: #6f7a8c; }

      /* 备注：只展示不复制 */
      .wtb-cl-note {
        margin-top: 4px;
        padding: 2px 6px;
        font-size: 11px; line-height: 1.5;
        color: #b8a888;
        background: #23262b;
        border-left: 2px solid #6b5f45;
        border-radius: 0 4px 4px 0;
        white-space: pre-wrap; word-break: break-word;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden;
        cursor: text;
      }
      .wtb-cl-note.empty { display: none; }

      .wtb-cl-tools {
        flex: 0 0 auto; display: flex; gap: 2px;
        opacity: 0; transition: opacity .12s;
      }
      .wtb-cl-item:hover .wtb-cl-tools { opacity: 1; }
      @media (hover: none) { .wtb-cl-tools { opacity: 1; } }

      .wtb-cl-btn {
        width: 20px; height: 20px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 0; border-radius: 4px; background: transparent;
        font-size: 11px; line-height: 1; color: #8b94a3;
        font-family: inherit; cursor: pointer;
        transition: background .12s, color .12s;
      }
      .wtb-cl-btn:hover { background: #333b47; color: #d8dde5; }
      .wtb-cl-btn.on { color: #e8c46a; }
      .wtb-cl-btn.note-on { color: #b8a888; }
      .wtb-cl-btn.danger:hover { background: #3a2528; color: #ff6b6b; }

      .wtb-cl-edit {
        width: 100%; box-sizing: border-box;
        padding: 5px 7px; border-radius: 5px; font-family: inherit;
        font-size: 12px; line-height: 1.5; color: #d8dde5;
        background: #1b2029; border: 1px solid #3d5a7d; outline: none;
        resize: vertical;
      }

      .wtb-cl-edit-note {
        width: 100%; box-sizing: border-box;
        margin-top: 4px;
        padding: 4px 6px; border-radius: 4px; font-family: inherit;
        font-size: 11px; line-height: 1.5; color: #d8dde5;
        background: #1b2029; border: 1px solid #6b5f45; outline: none;
        resize: vertical;
      }
      .wtb-cl-edit-note::placeholder { color: #5a6474; }

      .wtb-cl-foot {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; margin-top: 8px; padding-top: 8px;
        border-top: 1px solid #2c333e;
        font-size: 10px; color: #6f7a8c;
      }
    `;

    /* ============================================================
     *  注册模块
     * ============================================================ */
    bus.registerModule({
      id: 'clips',
      title: '剪切板备忘录',
      icon: '📋',
      order: 40,

      mount(ctx) {
        ctxRef = ctx;
        ctx.addStyle(MODULE_CSS);

        const pane = ctx.pane;
        pane.innerHTML = '';

        /* --- 顶部：分组切换 --- */
        groupsEl = h('div', { class: 'wtb-cl-groups' });

        const newBtn = h('button', { class: 'wtb-cl-icon', type: 'button', title: '新建分组' }, '＋');
        newBtn.addEventListener('click', createGroupInline);

        const dupBtn = h('button', { class: 'wtb-cl-icon', type: 'button', title: '复制当前分组为新分组' }, '⧉');
        dupBtn.addEventListener('click', duplicateActiveGroup);

        const renBtn = h('button', { class: 'wtb-cl-icon', type: 'button', title: '重命名当前分组' }, '✎');
        renBtn.addEventListener('click', () => renameGroupInline(activeGroup()));

        const delBtn = h('button', { class: 'wtb-cl-icon danger', type: 'button', title: '删除当前分组' }, '🗑');
        delBtn.addEventListener('click', deleteActiveGroup);

        const expBtn = h('button', { class: 'wtb-cl-icon', type: 'button', title: '导出全部内容（下载 JSON 备份）' }, '📤');
        expBtn.addEventListener('click', exportData);

        const impBtn = h('button', { class: 'wtb-cl-icon', type: 'button', title: '导入内容（选择 JSON 文件，可覆盖或合并）' }, '📥');
        impBtn.addEventListener('click', importData);

        const bar = h('div', { class: 'wtb-cl-bar' }, [groupsEl, newBtn, dupBtn, renBtn, delBtn, expBtn, impBtn]);

        /* --- 搜索 --- */
        searchEl = h('input', { class: 'wtb-cl-input', type: 'text', placeholder: '搜索正文或备注…' });
        searchEl.addEventListener('input', renderItems);
        searchEl.addEventListener('keydown', e => {
          if (e.key === 'Escape') { searchEl.value = ''; renderItems(); }
        });
        const searchRow = h('div', { class: 'wtb-cl-search' }, [searchEl]);

        /* --- 添加行 --- */
        inputEl = h('textarea', {
          class: 'wtb-cl-textarea',
          placeholder: '粘贴或输入内容，Ctrl + Enter 保存（Enter 换行）；保存后点 💬 可追加备注'
        });
        inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            addItem(inputEl.value);
            inputEl.value = '';
            inputEl.focus();
          }
        });

        const addBtn = h('button', { class: 'wtb-btn', type: 'button' }, '保存');
        addBtn.addEventListener('click', function () {
          addItem(inputEl.value);
          inputEl.value = '';
          inputEl.focus();
        });

        const pasteBtn = h('button', { class: 'wtb-btn ghost', type: 'button', title: '读取系统剪贴板' }, '读剪贴板');
        pasteBtn.addEventListener('click', pasteFromClipboard);

        const addRow = h('div', { class: 'wtb-cl-add' }, [inputEl, addBtn, pasteBtn]);

        /* --- 列表 & 底部 --- */
        bodyEl = h('div', { class: 'wtb-cl-body' });

        statEl = h('span', {});
        clearAllBtn = h('button', { class: 'wtb-btn ghost', type: 'button' }, '清空当前分组');
        clearAllBtn.addEventListener('click', clearActiveGroup);

        const foot = h('div', { class: 'wtb-cl-foot' }, [statEl, clearAllBtn]);

        pane.append(bar, searchRow, addRow, bodyEl, foot);

        /* --- 初始化数据 --- */
        load();
        unsub = store.watch(onRemoteChange);
        renderAll();
      },

      unmount(ctx) {
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        ctxRef = null;
        groupsEl = bodyEl = statEl = clearAllBtn = inputEl = searchEl = null;
      }
    });

    /* 对外 API，方便其它模块读写 */
    bus.clips = {
      all: () => JSON.parse(JSON.stringify(DB)),
      groups: () => DB.groups.map(g => ({ id: g.id, name: g.name, count: g.items.length })),
      total: () => DB.groups.reduce((n, g) => n + g.items.length, 0),
      /** 添加一条内容；groupName 省略则写入当前分组；note 为可选备注 */
      add(text, groupName, note) {
        const g = groupName
          ? (DB.groups.find(x => x.name === groupName) || activeGroup())
          : activeGroup();
        const item = pushItem(g, text);
        if (!item) return false;
        if (note != null) item.note = String(note).slice(0, MAX_NOTE_LEN);
        save();
        if (ctxRef) { renderItems(); updateBadge(); }
        return true;
      },
      /** 设置某条内容的备注（备注不参与复制） */
      setNote(groupId, itemId, note) {
        const g = DB.groups.find(x => x.id === groupId);
        if (!g) return false;
        const it = g.items.find(x => x.id === itemId);
        if (!it) return false;
        it.note = String(note == null ? '' : note).slice(0, MAX_NOTE_LEN);
        it.updated = Date.now();
        save();
        if (ctxRef) renderItems();
        return true;
      },
      /** 读取某条内容正文 */
      text(groupId, itemId) {
        const g = DB.groups.find(x => x.id === groupId);
        if (!g) return null;
        const it = g.items.find(x => x.id === itemId);
        return it ? it.text : null;
      },
      /** 读取某条内容备注 */
      note(groupId, itemId) {
        const g = DB.groups.find(x => x.id === groupId);
        if (!g) return null;
        const it = g.items.find(x => x.id === itemId);
        return it ? it.note : null;
      },
      /** 复制分组：sourceId 省略则复制当前；返回新分组 id */
      duplicate(sourceId, newName) {
        if (DB.groups.length >= MAX_GROUPS) return null;
        const src = sourceId
          ? DB.groups.find(g => g.id === sourceId)
          : activeGroup();
        if (!src) return null;
        const group = {
          id: uid(),
          name: String(newName || (src.name + ' 副本')).slice(0, 40),
          items: src.items.map(it => ({
            id: uid(),
            text: it.text,
            note: it.note,
            pinned: it.pinned,
            created: it.created,
            updated: it.updated,
            copiedAt: it.copiedAt,
            copyCount: it.copyCount
          }))
        };
        DB.groups.push(group);
        save();
        if (ctxRef) renderAll();
        return group.id;
      },
      /** 导出（返回 JSON 字符串） */
      exportJSON: () => JSON.stringify(DB, null, 2),
      /** 导入（raw 为已解析对象或 JSON 字符串，replace=true 覆盖） */
      importJSON(raw, replace) {
        let data = raw;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (e) { return false; }
        }
        if (!data || !Array.isArray(data.groups) || !data.groups.length) return false;
        if (replace) {
          DB = normalize({ v: 1, groups: data.groups });
        } else {
          const incoming = normalize({ v: 1, groups: data.groups });
          const used = new Set(DB.groups.map(g => g.name));
          for (const g of incoming.groups) {
            if (DB.groups.length >= MAX_GROUPS) break;
            let name = g.name, i = 1;
            while (used.has(name)) { name = g.name + ' (' + (++i) + ')'; }
            used.add(name);
            DB.groups.push({
              id: uid(),
              name: name.slice(0, 40),
              items: g.items.map(it => ({
                id: uid(),
                text: it.text,
                note: it.note,
                pinned: it.pinned,
                created: it.created,
                updated: it.updated,
                copiedAt: it.copiedAt,
                copyCount: it.copyCount
              }))
            });
          }
        }
        save();
        if (ctxRef) renderAll();
        return true;
      }
    };
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
