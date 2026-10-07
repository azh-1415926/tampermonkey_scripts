// ==UserScript==
// @name         网页工具箱 · 任务清单模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  多清单任务 / 注意事项管理，跨页面、跨标签页同步存储，支持复制清单、编辑创建时间。依赖内核 wtb-core，仅在顶层运行。
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
  if (W.__WTB_TASK_MODULE__) return;

  /* ============================================================
   *  存储层：优先 GM_*（跨站点共享），退回 localStorage（同源共享）
   * ============================================================ */
  const STORE_KEY = 'wtb_tasks_v1';
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

  /** 完整时间戳 YYYY-MM-DD HH:mm */
  function fmtFullTime(t) {
    if (!t) return '';
    const d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /**
   * 解析用户输入的时间字符串，支持格式：
   *   HH:mm                 → 替换 fallback 同一天的时分
   *   MM-DD HH:mm           → 当年
   *   MM-DD                 → 当年 00:00
   *   YYYY-MM-DD HH:mm      → 完整
   *   YYYY-MM-DD            → 当天 00:00
   *   YYYY/MM/DD HH:mm 等常见变体
   * 解析失败返回 null。
   */
  function parseTimeInput(str, fallbackTs) {
    const s = String(str || '').trim();
    if (!s) return null;

    const fallback = new Date(+fallbackTs || Date.now());
    const now = new Date();
    let m;

    // 1) 纯时间 HH:mm(:ss)
    m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const d = new Date(fallback);
      d.setHours(+m[1], +m[2], m[3] ? +m[3] : 0, 0);
      return d.getTime();
    }

    // 2) MM-DD HH:mm(:ss)
    m = s.match(/^(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const d = new Date(now.getFullYear(), +m[1] - 1, +m[2],
        +m[3], +m[4], m[5] ? +m[5] : 0, 0);
      return d.getTime();
    }

    // 3) MM-DD
    m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (m) {
      const d = new Date(now.getFullYear(), +m[1] - 1, +m[2], 0, 0, 0, 0);
      return d.getTime();
    }

    // 4) YYYY-MM-DD HH:mm(:ss)（含 T 分隔）
    m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3],
        +m[4], +m[5], m[6] ? +m[6] : 0, 0);
      return d.getTime();
    }

    // 5) YYYY-MM-DD
    m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
      return d.getTime();
    }

    // 6) 中文友好：2025年1月1日 09:30
    m = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3],
        m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0);
      return d.getTime();
    }

    // 7) 兜底：Date.parse
    const t = Date.parse(s.replace(/\//g, '-'));
    if (!isNaN(t)) return t;

    return null;
  }

  /* ============================================================
   *  模块主体
   * ============================================================ */
  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus || W.__WTB_TASK_MODULE__) return;
    W.__WTB_TASK_MODULE__ = true;

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }
    if (!IS_TOP) return;

    const { h } = bus;

    /* ---------- 常量 & 状态 ---------- */
    const MAX_TASKS_PER_LIST = 500;
    const MAX_LISTS = 30;

    let DB = { v: 1, lists: [], activeId: null };
    let seq = 0;
    let ctxRef = null;
    let unsub = null;

    let listsEl = null;
    let bodyEl = null;
    let statEl = null;
    let clearDoneBtn = null;
    let inputEl = null;

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
      const out = { v: 1, lists: [], activeId: null };

      if (raw && Array.isArray(raw.lists)) {
        for (const l of raw.lists) {
          if (!l || typeof l !== 'object') continue;
          const tasks = [];
          if (Array.isArray(l.tasks)) {
            for (const t of l.tasks) {
              if (!t || typeof t.text !== 'string') continue;
              const text = t.text.trim();
              if (!text) continue;
              tasks.push({
                id: t.id || uid(),
                text: text,
                done: !!t.done,
                created: +t.created || Date.now(),
                doneAt: +t.doneAt || 0
              });
              if (tasks.length >= MAX_TASKS_PER_LIST) break;
            }
          }
          out.lists.push({
            id: l.id || uid(),
            name: String(l.name || '未命名清单').slice(0, 40),
            tasks: tasks
          });
          if (out.lists.length >= MAX_LISTS) break;
        }
      }

      if (!out.lists.length) {
        out.lists.push({ id: uid(), name: '默认清单', tasks: [] });
      }
      const ids = out.lists.map(l => l.id);
      const want = raw && raw.activeId;
      out.activeId = ids.indexOf(want) >= 0 ? want : out.lists[0].id;
      return out;
    }

    function load() { DB = normalize(store.read()); }
    function save() { store.write(DB); }

    function activeList() {
      return DB.lists.find(l => l.id === DB.activeId) || DB.lists[0];
    }

    /* ---------- 渲染 ---------- */
    function updateBadge() {
      let n = 0;
      for (const l of DB.lists) for (const t of l.tasks) if (!t.done) n++;
      setBadge(n);
    }

    function renderLists() {
      if (!listsEl) return;
      listsEl.textContent = '';
      for (const l of DB.lists) {
        const on = l.id === DB.activeId;
        const chip = h('button', { class: 'wtb-tk-chip' + (on ? ' on' : ''), type: 'button' }, l.name);
        chip.dataset.id = l.id;
        chip.title = l.name + '（双击重命名）';
        chip.addEventListener('click', () => {
          if (DB.activeId === l.id) return;
          DB.activeId = l.id;
          save();
          renderAll();
        });
        chip.addEventListener('dblclick', e => {
          e.preventDefault();
          e.stopPropagation();
          renameListInline(l);
        });
        listsEl.appendChild(chip);
      }
    }

    function cmpTask(a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return a.created - b.created;
    }

    function renderTask(task) {
      const row = h('div', { class: 'wtb-tk-item' + (task.done ? ' done' : '') });

      /* 勾选 */
      const cb = h('div', { class: 'cb', title: task.done ? '标记为未完成' : '标记为已完成' }, '✓');
      cb.addEventListener('click', e => {
        e.stopPropagation();
        task.done = !task.done;
        task.doneAt = task.done ? Date.now() : 0;
        save();
        renderAll();
      });

      /* 正文 */
      const txt = h('div', { class: 'txt' }, task.text);
      txt.addEventListener('dblclick', e => {
        e.stopPropagation();
        startEdit(row, txt, task);
      });

      /* 副信息行：创建时间（可点击编辑）+ 完成时间 */
      const sub = h('div', { class: 'sub' });
      const timeEl = h('span', {
        class: 'wtb-tk-time',
        title: '点击修改创建时间（支持 HH:mm / MM-DD HH:mm / YYYY-MM-DD HH:mm）'
      }, fmtTime(task.created));
      timeEl.addEventListener('click', e => {
        e.stopPropagation();
        startEditTime(timeEl, task);
      });
      sub.appendChild(timeEl);

      if (task.done && task.doneAt) {
        sub.appendChild(h('span', { class: 'wtb-tk-donetime' },
          ' · 完成于 ' + fmtTime(task.doneAt)));
      }

      const body = h('div', { class: 'body' }, [txt, sub]);

      /* 删除 */
      const del = h('button', { class: 'del', type: 'button', title: '删除' }, '✕');
      del.addEventListener('click', e => {
        e.stopPropagation();
        const list = activeList();
        list.tasks = list.tasks.filter(x => x.id !== task.id);
        save();
        renderAll();
      });

      row.append(cb, body, del);
      return row;
    }

    function renderTasks() {
      if (!bodyEl) return;
      bodyEl.textContent = '';

      const list = activeList();
      const tasks = list.tasks.slice().sort(cmpTask);

      if (!tasks.length) {
        bodyEl.appendChild(h('div', { class: 'wtb-empty' }, '这个清单还空着，写点什么吧～'));
      } else {
        const frag = document.createDocumentFragment();
        for (const t of tasks) frag.appendChild(renderTask(t));
        bodyEl.appendChild(frag);
      }

      const total = list.tasks.length;
      const undone = list.tasks.filter(t => !t.done).length;
      statEl.textContent = total ? (undone + ' 项待办 / 共 ' + total + ' 项') : '暂无任务';
      clearDoneBtn.style.display = list.tasks.some(t => t.done) ? '' : 'none';
    }

    function renderAll() {
      renderLists();
      renderTasks();
      updateBadge();
    }

    /* ---------- 行内编辑任务文字 ---------- */
    function startEdit(row, txtEl, task) {
      const input = h('input', { class: 'edit', type: 'text' });
      input.value = task.text;
      txtEl.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (ok && v) { task.text = v; save(); }
        renderTasks();
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    /* ---------- 行内编辑创建时间 ---------- */
    function startEditTime(timeEl, task) {
      const input = h('input', {
        class: 'edit time-edit',
        type: 'text',
        title: 'HH:mm / MM-DD HH:mm / YYYY-MM-DD HH:mm'
      });
      input.value = fmtFullTime(task.created);

      // 用 span 包住，保持 sub 行内布局
      timeEl.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (ok && v) {
          const ts = parseTimeInput(v, task.created);
          if (ts === null) {
            toast('时间格式无法识别，试试 2025-01-01 09:30', true);
          } else {
            task.created = ts;
            save();
            toast('已更新创建时间');
          }
        }
        renderTasks();
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    /* ---------- 行内编辑清单名 ---------- */
    function renameListInline(list) {
      const chip = listsEl.querySelector('[data-id="' + list.id + '"]');
      if (!chip) return;
      const input = h('input', { class: 'wtb-tk-newinput', type: 'text' });
      input.value = list.name;
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
        if (ok && v) { list.name = v.slice(0, 40); save(); }
        renderAll();
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    /* ---------- 增删改 ---------- */
    function addTask(text) {
      const v = String(text || '').replace(/\s+/g, ' ').trim();
      if (!v) return;
      const list = activeList();
      if (list.tasks.length >= MAX_TASKS_PER_LIST) {
        toast('单个清单最多 ' + MAX_TASKS_PER_LIST + ' 项', true);
        return;
      }
      list.tasks.push({ id: uid(), text: v, done: false, created: Date.now(), doneAt: 0 });
      save();
      renderAll();

      requestAnimationFrame(function () {
        const nodes = bodyEl.querySelectorAll('.wtb-tk-item');
        if (nodes.length) {
          try { nodes[nodes.length - 1].scrollIntoView({ block: 'nearest' }); } catch (e) {}
        }
      });
    }

    /* ---------- 新建清单（行内输入） ---------- */
    function createListInline() {
      if (listsEl.querySelector('.wtb-tk-newinput')) return;
      if (DB.lists.length >= MAX_LISTS) { toast('最多 ' + MAX_LISTS + ' 个清单', true); return; }

      const input = h('input', { class: 'wtb-tk-newinput', type: 'text', placeholder: '清单名称' });
      input.style.cssText = 'flex:0 0 100px;padding:3px 10px;border-radius:999px;' +
        'font-family:inherit;font-size:12px;color:#d8dde5;background:#1b2029;' +
        'border:1px solid #3d5a7d;outline:none;';
      listsEl.appendChild(input);
      input.focus();

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (input.parentNode) input.remove();
        if (ok && name) {
          const list = { id: uid(), name: name.slice(0, 40), tasks: [] };
          DB.lists.push(list);
          DB.activeId = list.id;
          save();
          renderAll();
          toast('已创建清单「' + list.name + '」');
        }
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    /* ---------- 复制当前清单为新清单 ---------- */
    function duplicateActiveList() {
      if (listsEl.querySelector('.wtb-tk-newinput')) return;
      if (DB.lists.length >= MAX_LISTS) { toast('最多 ' + MAX_LISTS + ' 个清单', true); return; }

      const src = activeList();
      const baseName = src.name.replace(/\s*副本(\s*\d+)?$/, '') + ' 副本';
      let suggest = baseName;
      let n = 1;
      const used = new Set(DB.lists.map(l => l.name));
      while (used.has(suggest)) { suggest = baseName + ' ' + (++n); }

      const input = h('input', { class: 'wtb-tk-newinput', type: 'text', placeholder: '新清单名称' });
      input.value = suggest;
      input.style.cssText = 'flex:0 0 130px;padding:3px 10px;border-radius:999px;' +
        'font-family:inherit;font-size:12px;color:#d8dde5;background:#1b2029;' +
        'border:1px solid #3d5a7d;outline:none;';
      listsEl.appendChild(input);
      input.focus();
      input.select();

      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (input.parentNode) input.remove();
        if (!ok || !name) return;

        const newList = {
          id: uid(),
          name: name.slice(0, 40),
          tasks: src.tasks.map(t => ({
            id: uid(),
            text: t.text,
            done: t.done,
            created: t.created,
            doneAt: t.doneAt
          }))
        };
        DB.lists.push(newList);
        DB.activeId = newList.id;
        save();
        renderAll();
        toast('已复制为「' + newList.name + '」（' + newList.tasks.length + ' 项）');
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    function deleteActiveList() {
      if (DB.lists.length <= 1) { toast('至少要保留一个清单', true); return; }
      const list = activeList();
      if (!ask('删除清单「' + list.name + '」及其 ' + list.tasks.length + ' 项任务？')) return;
      const idx = DB.lists.indexOf(list);
      DB.lists = DB.lists.filter(l => l.id !== list.id);
      DB.activeId = DB.lists[Math.min(idx, DB.lists.length - 1)].id;
      save();
      renderAll();
      toast('已删除清单');
    }

    function clearDone() {
      const list = activeList();
      const n = list.tasks.filter(t => t.done).length;
      if (!n) return;
      list.tasks = list.tasks.filter(t => !t.done);
      save();
      renderAll();
      toast('已清除 ' + n + ' 项已完成');
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
      .wtb-tk-bar {
        display: flex; align-items: center; gap: 6px;
        padding-bottom: 8px; border-bottom: 1px solid #2c333e;
      }
      .wtb-tk-lists {
        display: flex; align-items: center; gap: 6px;
        flex: 1 1 auto; min-width: 0;
        overflow-x: auto; padding-bottom: 2px;
      }
      .wtb-tk-lists::-webkit-scrollbar { height: 4px; }
      .wtb-tk-lists::-webkit-scrollbar-thumb { background: #3a4250; border-radius: 2px; }
      .wtb-tk-lists::-webkit-scrollbar-track { background: transparent; }

      .wtb-tk-chip {
        flex: 0 0 auto; max-width: 130px;
        padding: 3px 10px; border-radius: 999px;
        font-size: 12px; line-height: 1.6; font-family: inherit;
        color: #8b94a3; background: #222833; border: 1px solid transparent;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        cursor: pointer;
        transition: background .12s, color .12s, border-color .12s;
      }
      .wtb-tk-chip:hover { color: #d8dde5; background: #2a3140; }
      .wtb-tk-chip.on { color: #8fc4ff; background: #1e2c3e; border-color: #2f4a68; }

      .wtb-tk-icon {
        flex: 0 0 auto; width: 22px; height: 22px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid #2c333e; border-radius: 6px;
        background: transparent; color: #8b94a3;
        font-size: 12px; line-height: 1; font-family: inherit;
        cursor: pointer;
        transition: background .12s, color .12s, border-color .12s;
      }
      .wtb-tk-icon:hover { background: #2a3140; color: #d8dde5; }
      .wtb-tk-icon.danger:hover { background: #3a2528; color: #ff6b6b; border-color: #4a2b2f; }

      .wtb-tk-add { display: flex; gap: 6px; margin: 10px 0 8px; }
      .wtb-tk-input {
        flex: 1 1 auto; min-width: 0;
        padding: 7px 9px; border-radius: 6px; font-family: inherit;
        font-size: 12px; color: #d8dde5;
        background: #1b2029; border: 1px solid #2c333e;
        outline: none; transition: border-color .12s;
      }
      .wtb-tk-input::placeholder { color: #5a6474; }
      .wtb-tk-input:focus { border-color: #3d5a7d; }

      .wtb-tk-body { min-height: 60px; }

      .wtb-tk-item {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 7px 6px; border-radius: 6px;
      }
      .wtb-tk-item:hover { background: #262c36; }

      .wtb-tk-item .cb {
        flex: 0 0 auto; width: 15px; height: 15px; margin-top: 1px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 4px; border: 1.5px solid #4a5464;
        font-size: 10px; line-height: 1; color: transparent;
        cursor: pointer; user-select: none;
        transition: background .12s, border-color .12s, color .12s;
      }
      .wtb-tk-item .cb:hover { border-color: #6ea8fe; }
      .wtb-tk-item.done .cb { background: #3f7d4e; border-color: #3f7d4e; color: #fff; }

      .wtb-tk-item .body { flex: 1 1 auto; min-width: 0; }
      .wtb-tk-item .txt {
        font-size: 12px; line-height: 1.45; color: #d8dde5;
        white-space: pre-wrap; word-break: break-word;
        cursor: text;
      }
      .wtb-tk-item.done .txt { color: #6f7a8c; text-decoration: line-through; }
      .wtb-tk-item .sub { margin-top: 2px; font-size: 10px; color: #6f7a8c; }

      /* 可编辑的创建时间 */
      .wtb-tk-time {
        cursor: pointer;
        border-bottom: 1px dashed transparent;
        transition: color .12s, border-color .12s;
      }
      .wtb-tk-time:hover { color: #8fc4ff; border-bottom-color: #3d5a7d; }

      .wtb-tk-item .edit {
        width: 100%; box-sizing: border-box;
        padding: 3px 6px; border-radius: 4px; font-family: inherit;
        font-size: 12px; color: #d8dde5;
        background: #1b2029; border: 1px solid #3d5a7d; outline: none;
      }
      .wtb-tk-item .edit.time-edit {
        width: 140px; display: inline-block;
        padding: 1px 5px; font-size: 10px;
      }

      .wtb-tk-item .del {
        flex: 0 0 auto; width: 18px; height: 18px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 0; border-radius: 4px; background: transparent;
        font-size: 10px; color: #8b94a3; cursor: pointer;
        opacity: 0;
        transition: opacity .12s, background .12s, color .12s;
      }
      .wtb-tk-item:hover .del { opacity: 1; }
      .wtb-tk-item .del:hover { background: #3a2528; color: #ff6b6b; }
      @media (hover: none) { .wtb-tk-item .del { opacity: 1; } }

      .wtb-tk-foot {
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
      id: 'tasks',
      title: '任务',
      icon: '✅',
      order: 30,

      mount(ctx) {
        ctxRef = ctx;
        ctx.addStyle(MODULE_CSS);

        const pane = ctx.pane;
        pane.innerHTML = '';

        /* --- 顶部：清单切换 --- */
        listsEl = h('div', { class: 'wtb-tk-lists' });

        const newBtn = h('button', { class: 'wtb-tk-icon', type: 'button', title: '新建清单' }, '＋');
        newBtn.addEventListener('click', createListInline);

        const dupBtn = h('button', { class: 'wtb-tk-icon', type: 'button', title: '复制当前清单为新清单' }, '⧉');
        dupBtn.addEventListener('click', duplicateActiveList);

        const renBtn = h('button', { class: 'wtb-tk-icon', type: 'button', title: '重命名当前清单' }, '✎');
        renBtn.addEventListener('click', () => renameListInline(activeList()));

        const delBtn = h('button', { class: 'wtb-tk-icon danger', type: 'button', title: '删除当前清单' }, '🗑');
        delBtn.addEventListener('click', deleteActiveList);

        const bar = h('div', { class: 'wtb-tk-bar' }, [listsEl, newBtn, dupBtn, renBtn, delBtn]);

        /* --- 输入行 --- */
        inputEl = h('input', { class: 'wtb-tk-input', type: 'text', placeholder: '添加任务，回车确认' });
        inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            addTask(inputEl.value);
            inputEl.value = '';
          }
        });

        const addBtn = h('button', { class: 'wtb-btn', type: 'button' }, '添加');
        addBtn.addEventListener('click', () => {
          addTask(inputEl.value);
          inputEl.value = '';
          inputEl.focus();
        });

        const addRow = h('div', { class: 'wtb-tk-add' }, [inputEl, addBtn]);

        /* --- 列表 & 底部 --- */
        bodyEl = h('div', { class: 'wtb-tk-body' });

        statEl = h('span', {});
        clearDoneBtn = h('button', { class: 'wtb-btn ghost', type: 'button' }, '清除已完成');
        clearDoneBtn.addEventListener('click', clearDone);

        const foot = h('div', { class: 'wtb-tk-foot' }, [statEl, clearDoneBtn]);

        pane.append(bar, addRow, bodyEl, foot);

        /* --- 初始化数据 --- */
        load();
        unsub = store.watch(onRemoteChange);
        renderAll();
      },

      unmount(ctx) {
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        ctxRef = null;
        listsEl = bodyEl = statEl = clearDoneBtn = inputEl = null;
      }
    });

    /* 对外 API，方便其它模块读写 */
    bus.tasks = {
      all: () => JSON.parse(JSON.stringify(DB)),
      lists: () => DB.lists.map(l => ({ id: l.id, name: l.name, count: l.tasks.length })),
      add(text, listName) {
        const list = listName
          ? (DB.lists.find(l => l.name === listName) || activeList())
          : activeList();
        const v = String(text || '').replace(/\s+/g, ' ').trim();
        if (!v) return false;
        list.tasks.push({ id: uid(), text: v, done: false, created: Date.now(), doneAt: 0 });
        save();
        if (ctxRef) renderAll();
        return true;
      },
      /** 复制清单：sourceId 省略则复制当前；返回新清单 id */
      duplicate(sourceId, newName) {
        if (DB.lists.length >= MAX_LISTS) return null;
        const src = sourceId
          ? DB.lists.find(l => l.id === sourceId)
          : activeList();
        if (!src) return null;
        const list = {
          id: uid(),
          name: String(newName || (src.name + ' 副本')).slice(0, 40),
          tasks: src.tasks.map(t => ({
            id: uid(),
            text: t.text,
            done: t.done,
            created: t.created,
            doneAt: t.doneAt
          }))
        };
        DB.lists.push(list);
        save();
        if (ctxRef) renderAll();
        return list.id;
      },
      /** 修改某任务的创建时间（毫秒时间戳） */
      setCreated(listId, taskId, ts) {
        const list = DB.lists.find(l => l.id === listId);
        if (!list) return false;
        const task = list.tasks.find(t => t.id === taskId);
        if (!task || !isFinite(ts)) return false;
        task.created = +ts;
        save();
        if (ctxRef) renderAll();
        return true;
      },
      undone: () => DB.lists.reduce(
        (n, l) => n + l.tasks.filter(t => !t.done).length, 0)
    };
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
