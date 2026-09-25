// ==UserScript==
// @name         网页工具箱 · 内核
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  工具箱外壳：浮动面板 + 模块注册中心 + 消息总线。功能由独立模块脚本提供。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @all-frames   true
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 0. WTB Runtime（自包含引导，所有脚本内联同一段，首个执行者生效）
   * ============================================================ */
  (function () {
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    if (W.__WTB_BUS__) return;

    const VERSION = '2.0.0';
    const CONST = {
      MSG_TAG: '__WTB_MSG__',
      UI_ATTR: 'data-wtb-ui',
      Z_INDEX: 2147483647,
      HL_Z:    2147483646
    };
    const LOG = (...a) => { try { console.log('[WTB]', ...a); } catch (e) {} };
    const ERR = (...a) => { try { console.error('[WTB]', ...a); } catch (e) {} };

    /* ---------- DOM 小工具 ---------- */
    function h(tag, props, children) {
      const el = document.createElement(tag);
      if (props) {
        for (const k in props) {
          if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
          const v = props[k];
          if (v == null) continue;
          if (k === 'class') el.className = v;
          else if (k === 'text') el.textContent = v;
          else if (k === 'html') el.innerHTML = v;
          else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
          else el.setAttribute(k, v);
        }
      }
      if (children) {
        const arr = Array.isArray(children) ? children : [children];
        for (const c of arr) {
          if (c == null) continue;
          el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
      }
      return el;
    }

    function esc(s) {
      s = String(s);
      if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
      return s.replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, ch => '\\' + ch);
    }
    function escAttr(s) {
      return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
    function isValidIdent(s) {
      return /^-?[_a-zA-Z\u00A0-\uFFFF][\w\u00A0-\uFFFF-]*$/.test(s);
    }
    function isOwnUI(node) {
      if (!node || node.nodeType !== 1) return false;
      try { if (node.closest && node.closest('[' + CONST.UI_ATTR + ']')) return true; } catch (e) {}
      try {
        const root = node.getRootNode && node.getRootNode();
        if (root && root.host && root.host.nodeType === 1 && root.host.hasAttribute(CONST.UI_ATTR)) return true;
      } catch (e) {}
      return false;
    }
    function safeCall(fn, arg, fallback) {
      try { return fn(arg); } catch (e) { return fallback; }
    }
    function copyText(text, btn) {
      if (!text) return;
      const done = () => {
        if (!btn) return;
        const old = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1200);
      };
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch (e) {}
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else fallback();
    }

    /* ---------- 事件总线 ---------- */
    const handlers = new Map();   // type -> Set<fn>
    const modules  = new Map();   // id   -> module def
    let   shell    = null;

    const bus = {
      version: VERSION,
      const: CONST,
      modules,
      log: LOG,
      err: ERR,
      h, esc, escAttr, isValidIdent, isOwnUI, safeCall, copyText,

      /* --- 事件 --- */
      on(type, fn) {
        if (typeof fn !== 'function') return () => {};
        let set = handlers.get(type);
        if (!set) { set = new Set(); handlers.set(type, set); }
        set.add(fn);
        return () => bus.off(type, fn);
      },
      once(type, fn) {
        const off = bus.on(type, (p, t) => { off(); fn(p, t); });
        return off;
      },
      off(type, fn) {
        const set = handlers.get(type);
        if (!set) return;
        set.delete(fn);
        if (!set.size) handlers.delete(type);
      },
      emit(type, payload) {
        const direct = handlers.get(type);
        if (direct) for (const fn of Array.from(direct)) {
          try { fn(payload, type); } catch (e) { ERR('handler error @' + type, e); }
        }
        const star = handlers.get('*');
        if (star) for (const fn of Array.from(star)) {
          try { fn(payload, type); } catch (e) { ERR('wildcard handler error', e); }
        }
      },
      /* --- 请求 / 响应（模拟 RPC） --- */
      request(type, payload, timeout) {
        timeout = timeout || 3000;
        return new Promise(resolve => {
          const reqId = 'r' + Math.random().toString(36).slice(2, 10);
          let settled = false;
          const off = bus.on(type + ':reply:' + reqId, data => {
            if (settled) return;
            settled = true; off(); resolve(data);
          });
          bus.emit(type, Object.assign({ __reqId: reqId }, payload));
          setTimeout(() => {
            if (settled) return;
            settled = true; off(); resolve(null);
          }, timeout);
        });
      },
      reply(type, reqId, data) {
        bus.emit(type + ':reply:' + reqId, data);
      },

      /* --- 模块注册 --- */
      registerModule(def) {
        if (!def || !def.id) return;
        if (modules.has(def.id)) { LOG('模块已注册，跳过:', def.id); return; }
        modules.set(def.id, def);
        LOG('模块注册:', def.id);
        if (shell && typeof shell.addModule === 'function') {
          try { shell.addModule(def); } catch (e) { ERR('addModule 失败', e); }
        }
        bus.emit('module:registered', def);
      },
      unregisterModule(id) {
        const def = modules.get(id);
        if (!def) return;
        modules.delete(id);
        if (shell && shell.removeModule) { try { shell.removeModule(id); } catch (e) {} }
        bus.emit('module:unregistered', def);
      },
      getModule(id) { return modules.get(id); },
      listModules() { return Array.from(modules.values()); },

      /* --- 由内核调用 --- */
      _attachShell(s) {
        shell = s;
        bus.emit('shell:ready', s);
        if (!s || typeof s.addModule !== 'function') return;
        for (const def of Array.from(modules.values())) {
          try { s.addModule(def); } catch (e) { ERR('addModule 失败', e); }
        }
      },
      getShell() { return shell; }
    };

    W.__WTB_BUS__ = bus;
    try { W.dispatchEvent(new CustomEvent('wtb:bus-ready', { detail: { version: VERSION } })); } catch (e) {}
  })();

  /* ============================================================
   * 1. 内核本体
   * ============================================================ */
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const bus = W.__WTB_BUS__;
  if (!bus) return;

  if (W.__WTB_CORE__) return;        // 内核只初始化一次
  W.__WTB_CORE__ = true;

  let IS_TOP = false;
  try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }

  // 子框架不建 UI，只把总线留在那里给模块做跨 frame 逻辑
  if (!IS_TOP) return;

  const UI_ATTR = bus.const.UI_ATTR;
  const Z_INDEX = bus.const.Z_INDEX;
  const { h } = bus;

  /* ---------------- 基础样式（外壳 + 公共控件） ---------------- */
  const BASE_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }

    /* ---------- FAB ---------- */
    .wtb-fab {
      position: fixed; right: 18px; bottom: 18px;
      width: 46px; height: 46px; border-radius: 50%;
      background: #2b6cff; color: #fff;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none; font-size: 22px;
      box-shadow: 0 4px 14px rgba(0,0,0,.3);
      transition: transform .15s, background .15s;
      z-index: ${Z_INDEX};
    }
    .wtb-fab:hover { transform: scale(1.08); }
    .wtb-badge {
      position: absolute; top: -3px; right: -3px;
      min-width: 18px; height: 18px; padding: 0 4px;
      border-radius: 9px; background: #ff4d4f; color: #fff;
      font-size: 10px; line-height: 18px; text-align: center;
      display: none;
    }
    .wtb-badge.show { display: block; }

    /* ---------- Panel ---------- */
    .wtb-panel {
      position: fixed; right: 18px; bottom: 76px;
      width: 480px; max-width: calc(100vw - 36px);
      height: 620px; max-height: calc(100vh - 100px);
      background: #1e2229; color: #e6e8eb;
      border-radius: 12px; overflow: hidden;
      display: flex; flex-direction: column;
      box-shadow: 0 12px 44px rgba(0,0,0,.5);
      border: 1px solid #333a45;
      font-size: 12px; line-height: 1.6;
      z-index: ${Z_INDEX};
    }
    .wtb-panel[hidden] { display: none !important; }

    .wtb-panel-head {
      display: flex; align-items: center; justify-content: space-between;
      background: #262c36; border-bottom: 1px solid #333a45;
      flex: 0 0 auto;
    }
    .wtb-tabs { display: flex; flex-wrap: wrap; }
    .wtb-tab {
      background: transparent; border: 0; color: #8b94a3;
      padding: 10px 12px; cursor: pointer; font-size: 12px;
      font-family: inherit; border-bottom: 2px solid transparent;
    }
    .wtb-tab:hover { color: #d8dde5; }
    .wtb-tab.active { color: #fff; border-bottom-color: #2b6cff; }
    .wtb-close {
      background: transparent; border: 0; color: #8b94a3;
      font-size: 16px; cursor: pointer; padding: 4px 10px; line-height: 1;
    }
    .wtb-close:hover { color: #fff; }

    .wtb-panel-body { flex: 1 1 auto; overflow: hidden; position: relative; }
    .wtb-pane {
      display: none; height: 100%; overflow-y: auto;
      padding: 12px;
    }
    .wtb-pane.active { display: block; }
    .wtb-pane::-webkit-scrollbar { width: 8px; }
    .wtb-pane::-webkit-scrollbar-thumb { background: #3d4552; border-radius: 4px; }

    /* ---------- 公共控件 ---------- */
    .wtb-sec { margin-bottom: 14px; }
    .wtb-sec:last-child { margin-bottom: 0; }
    .wtb-sec-title {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: #6f7a8c; text-transform: uppercase;
      margin-bottom: 6px; padding-bottom: 4px;
      border-bottom: 1px dashed #333a45;
    }
    .wtb-kv { display: flex; gap: 8px; padding: 2px 0; }
    .wtb-kv .k { flex: 0 0 76px; color: #8b94a3; }
    .wtb-kv .v { flex: 1 1 auto; color: #d8dde5; word-break: break-all; }
    .wtb-kv .v.mono { font-family: Consolas, Monaco, monospace; color: #7fd3ff; }

    .wtb-code-row {
      display: flex; align-items: flex-start; gap: 6px;
      background: #161a20; border: 1px solid #2c333e;
      border-radius: 6px; padding: 7px 8px; margin-top: 6px;
    }
    .wtb-code-row .code-label {
      flex: 0 0 auto; color: #6f7a8c; font-size: 11px;
      padding-top: 2px; white-space: nowrap;
    }
    .wtb-code-row .code-val {
      flex: 1 1 auto; font-family: Consolas, Monaco, monospace;
      font-size: 11.5px; color: #7fd3ff; word-break: break-all;
      white-space: pre-wrap; user-select: text; padding-top: 2px;
    }
    .wtb-code-row .copy-btn {
      flex: 0 0 auto; background: #2b6cff; color: #fff;
      border: 0; border-radius: 4px; padding: 3px 9px;
      font-size: 11px; cursor: pointer; white-space: nowrap;
    }
    .wtb-code-row .copy-btn:hover { background: #4680ff; }
    .wtb-code-row .copy-btn.done { background: #16a34a; }

    .wtb-btn {
      background: #2b6cff; color: #fff; border: 0;
      border-radius: 5px; padding: 5px 12px;
      font-size: 12px; cursor: pointer; font-family: inherit;
    }
    .wtb-btn:hover { background: #4680ff; }
    .wtb-btn.ghost { background: #2c333e; color: #cfd6e4; }
    .wtb-btn.ghost:hover { background: #3a4352; }
    .wtb-btn.on { background: #16a34a; }
    .wtb-btn.on:hover { background: #1db954; }

    .wtb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .wtb-row:last-child { margin-bottom: 0; }

    input[type="text"], select, textarea {
      background: #161a20; color: #e6e8eb;
      border: 1px solid #333a45; border-radius: 5px;
      padding: 4px 8px; font-size: 12px; outline: none;
      font-family: inherit;
    }
    input[type="text"]:focus, select:focus, textarea:focus { border-color: #2b6cff; }
    input[type="text"] { flex: 1 1 100px; min-width: 0; }

    .wtb-switch {
      display: inline-flex; align-items: center; gap: 5px;
      cursor: pointer; user-select: none; color: #cfd6e4;
    }
    .wtb-switch input { display: none; }
    .wtb-switch .track {
      width: 30px; height: 17px; border-radius: 9px; background: #4a5262;
      position: relative; transition: background .18s; flex: 0 0 auto;
    }
    .wtb-switch .track::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 13px; height: 13px; border-radius: 50%; background: #fff;
      transition: transform .18s;
    }
    .wtb-switch input:checked + .track { background: #2b6cff; }
    .wtb-switch input:checked + .track::after { transform: translateX(13px); }

    .wtb-empty { color: #6f7a8c; font-style: italic; padding: 30px 0; text-align: center; }
    .wtb-hint { color: #6f7a8c; font-size: 11px; }
    .wtb-status { font-size: 12px; color: #9aa6bb; margin-top: 8px; word-break: break-all; }
    .wtb-status b { color: #ffd166; font-weight: 600; }

    /* ---------- Toast ---------- */
    .wtb-toast {
      position: fixed; left: 50%; top: 24px; transform: translate(-50%, -12px);
      background: #262c36; color: #e6e8eb;
      border: 1px solid #3a4352; border-radius: 8px;
      padding: 8px 16px; font-size: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,.45);
      opacity: 0; pointer-events: none;
      transition: opacity .2s, transform .2s;
      z-index: ${Z_INDEX};
      max-width: 70vw;
    }
    .wtb-toast.show { opacity: 1; transform: translate(-50%, 0); }
    .wtb-toast.err { border-color: #7f2b2b; color: #f87171; }
  `;

  /* ---------------- 外壳 HTML ---------------- */
  const SHELL_HTML = `
    <div class="wtb-fab" title="网页工具箱（点击展开）">🧰<span class="wtb-badge"></span></div>
    <div class="wtb-panel" hidden>
      <div class="wtb-panel-head">
        <div class="wtb-tabs"></div>
        <button class="wtb-close" title="收起">✕</button>
      </div>
      <div class="wtb-panel-body"></div>
    </div>
    <div class="wtb-toast"></div>
  `;

  /* ---------------- 状态 ---------------- */
  let host, shadowRoot, fabEl, panelEl, tabsEl, panesEl, badgeEl, toastEl;
  const tabs = new Map();          // id -> { def, tab, pane, ctx }
  let activeId = null;
  let toastTimer = null;

  /* ---------------- 构建外壳 ---------------- */
  function buildShell() {
    host = document.createElement('div');
    host.setAttribute(UI_ATTR, '1');
    document.documentElement.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<style>' + BASE_CSS + '</style>' + SHELL_HTML;

    fabEl    = shadowRoot.querySelector('.wtb-fab');
    panelEl  = shadowRoot.querySelector('.wtb-panel');
    tabsEl   = shadowRoot.querySelector('.wtb-tabs');
    panesEl  = shadowRoot.querySelector('.wtb-panel-body');
    badgeEl  = shadowRoot.querySelector('.wtb-badge');
    toastEl  = shadowRoot.querySelector('.wtb-toast');

    fabEl.addEventListener('click', togglePanel);
    shadowRoot.querySelector('.wtb-close').addEventListener('click', closePanel);

    // 全局快捷键 → 通过总线广播给模块，内核自己不做业务
    window.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey && (e.code === 'KeyS' || e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        bus.emit('shortcut:toggle-pick');
      } else if (e.key === 'Escape') {
        bus.emit('shortcut:escape');
      }
    }, true);
  }

  /* ---------------- 面板开合 ---------------- */
  function togglePanel() { panelEl.hidden ? openPanel() : closePanel(); }
  function openPanel()   { panelEl.hidden = false; }
  function closePanel()  { panelEl.hidden = true; }

  /* ---------------- 徽标 / Toast ---------------- */
  function setBadge(n) {
    if (!badgeEl) return;
    n = Number(n) || 0;
    if (n > 0) {
      badgeEl.textContent = n > 99 ? '99+' : String(n);
      badgeEl.classList.add('show');
    } else {
      badgeEl.classList.remove('show');
    }
  }
  function toast(msg, isErr) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isErr);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  /* ---------------- Tab 激活 ---------------- */
  function activate(id) {
    if (activeId === id) return;
    const prev = tabs.get(activeId);
    const next = tabs.get(id);
    if (!next) return;

    if (prev) {
      prev.tab.classList.remove('active');
      prev.pane.classList.remove('active');
      try { if (prev.def.onDeactivate) prev.def.onDeactivate(prev.ctx); } catch (e) {}
    }
    next.tab.classList.add('active');
    next.pane.classList.add('active');
    activeId = id;
    try { if (next.def.onActivate) next.def.onActivate(next.ctx); } catch (e) {}
    bus.emit('module:activated', { id });
  }

  /* ---------------- 模块挂载 ---------------- */
  function addModule(def) {
    if (!def || !def.id) return;
    if (tabs.has(def.id)) return;

    const order  = def.order == null ? 100 : def.order;
    const tabBtn = h('button', { class: 'wtb-tab', 'data-tab': def.id },
      (def.icon ? def.icon + ' ' : '') + (def.title || def.id));
    const pane   = h('div', { class: 'wtb-pane', 'data-pane': def.id });

    tabBtn.addEventListener('click', () => { openPanel(); activate(def.id); });

    // 按 order 插入到正确位置
    let refTab = null, refPane = null;
    for (const entry of tabs.values()) {
      const o = entry.def.order == null ? 100 : entry.def.order;
      if (o > order) { refTab = entry.tab; refPane = entry.pane; break; }
    }
    tabsEl.insertBefore(tabBtn, refTab);
    panesEl.insertBefore(pane, refPane);

    /* 模块上下文 —— 模块只能通过它访问外壳能力 */
    const ctx = {
      id: def.id,
      bus,
      pane,
      shadowRoot,
      host,
      h,
      esc: bus.esc,
      escAttr: bus.escAttr,
      safeCall: bus.safeCall,
      isOwnUI: bus.isOwnUI,
      copyText: (text, btn) => bus.copyText(text, btn),
      addStyle(css) {
        const st = document.createElement('style');
        st.setAttribute('data-wtb-mod', def.id);
        st.textContent = css;
        shadowRoot.appendChild(st);
        return st;
      },
      toast,
      setBadge,
      open: () => { openPanel(); activate(def.id); },
      log: (...a) => { try { console.log('[WTB:' + def.id + ']', ...a); } catch (e) {} },
      err: (...a) => { try { console.error('[WTB:' + def.id + ']', ...a); } catch (e) {} }
    };

    tabs.set(def.id, { def, tab: tabBtn, pane, ctx });

    try { if (typeof def.mount === 'function') def.mount(ctx); }
    catch (e) { ctx.err('mount 失败', e); }

    if (!activeId) activate(def.id);
  }

  function removeModule(id) {
    const entry = tabs.get(id);
    if (!entry) return;
    try { if (entry.def.unmount) entry.def.unmount(entry.ctx); } catch (e) {}
    entry.tab.remove();
    entry.pane.remove();
    tabs.delete(id);
    if (activeId === id) {
      activeId = null;
      const first = tabs.keys().next();
      if (!first.done) activate(first.value);
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    try { buildShell(); }
    catch (e) { console.error('[WTB] 外壳构建失败', e); return; }

    // 把外壳能力交给总线，之前注册的模块会立刻被挂载
    bus._attachShell({
      addModule,
      removeModule,
      activate,
      openPanel,
      closePanel,
      setBadge,
      toast,
      get shadowRoot() { return shadowRoot; },
      get host() { return host; }
    });

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('🧰 显示工具箱面板', openPanel);
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
