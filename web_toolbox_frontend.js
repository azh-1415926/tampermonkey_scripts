// ==UserScript==
// @name         网页工具箱 · 悬浮窗主界面
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.1.0
// @description  工具箱外壳：浮动面板 + 模块注册中心 + 消息总线。功能由独立模块脚本提供。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
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
    /* 尺寸由内联样式控制（宽高、字号），透明度同样由内联样式控制 */
    .wtb-fab {
      position: fixed; right: 18px; bottom: 18px;
      width: 46px; height: 46px; border-radius: 50%;
      background: #2b6cff; color: #fff;
      display: flex; align-items: center; justify-content: center;
      cursor: grab; user-select: none; font-size: 22px;
      box-shadow: 0 4px 14px rgba(0,0,0,.3);
      transition: transform .15s, background .15s, opacity .2s;
      touch-action: none;             /* 触屏拖动不滚页面 */
      -webkit-user-drag: none;
      z-index: ${Z_INDEX};
      overflow: visible;              /* 保证 badge 不被裁剪 */
    }
    .wtb-fab:hover { transform: scale(1.08); }
    .wtb-fab.dragging {
      cursor: grabbing; transform: none;
      transition: none;               /* 拖动时不要缩放动画 */
      box-shadow: 0 8px 22px rgba(0,0,0,.45);
    }
    .wtb-fab-icon {
      pointer-events: none;
      line-height: 1;
      z-index: 1;
    }
    .wtb-fab-img {
      position: absolute; top: 0; left: 0;
      width: 100%; height: 100%;
      border-radius: 50%;
      object-fit: cover;
      pointer-events: none;
      z-index: 0;
    }
    .wtb-fab-img[hidden] { display: none; }
    .wtb-badge {
      position: absolute; top: -3px; right: -3px;
      min-width: 18px; height: 18px; padding: 0 4px;
      border-radius: 9px; background: #ff4d4f; color: #fff;
      font-size: 10px; line-height: 18px; text-align: center;
      display: none;
      z-index: 2;
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

    .wtb-head-actions { display: flex; align-items: center; flex: 0 0 auto; }
    .wtb-gear, .wtb-close {
      background: transparent; border: 0; color: #8b94a3;
      cursor: pointer; padding: 4px 10px; line-height: 1;
      font-family: inherit;
    }
    .wtb-gear { font-size: 14px; }
    .wtb-close { font-size: 16px; }
    .wtb-gear:hover, .wtb-close:hover { color: #fff; }
    .wtb-gear.active { color: #2b6cff; }

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

    /* 尺寸预设按钮组：上描述 / 下尺寸 */
    .wtb-size-group { gap: 6px; }
    .wtb-size-group .wtb-btn {
      flex: 1 1 auto; min-width: 58px; text-align: center;
      padding: 5px 4px; display: flex; flex-direction: column; gap: 2px;
      line-height: 1.25;
    }
    .wtb-size-group .wtb-btn .sz-name { font-size: 12px; font-weight: 600; }
    .wtb-size-group .wtb-btn .sz-desc {
      font-size: 10.5px; opacity: .78;
      font-family: Consolas, Monaco, monospace;
    }

    /* ---------- 透明度滑块 ---------- */
    .wtb-opacity-row { align-items: center; }
    .wtb-opacity-row input[type="range"] {
      -webkit-appearance: none; appearance: none;
      flex: 1 1 auto; min-width: 120px; height: 4px;
      background: #3a4352; border-radius: 2px; outline: none;
      cursor: pointer; padding: 0; border: 0;
    }
    .wtb-opacity-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: #2b6cff; border: 2px solid #fff;
      cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .wtb-opacity-row input[type="range"]::-moz-range-thumb {
      width: 14px; height: 14px; border-radius: 50%;
      background: #2b6cff; border: 2px solid #fff;
      cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .wtb-opacity-val {
      flex: 0 0 auto; min-width: 42px; text-align: right;
      font-family: Consolas, Monaco, monospace;
      font-size: 11.5px; color: #7fd3ff;
    }

    /* ---------- 图标上传 ---------- */
    .wtb-icon-row { align-items: center; gap: 8px; }
    .wtb-icon-preview {
      flex: 0 0 auto;
      width: 34px; height: 34px; border-radius: 50%;
      background: #2b6cff; color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; overflow: hidden;
      border: 1px solid #3a4352;
    }
    .wtb-icon-preview img { width: 100%; height: 100%; object-fit: cover; }

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
    select { flex: 1 1 auto; min-width: 0; cursor: pointer; }

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
    <div class="wtb-fab" title="网页工具箱（单击展开 · 拖动移动 · 右键复位）">
      <span class="wtb-fab-icon">🧰</span>
      <img class="wtb-fab-img" alt="" hidden>
      <span class="wtb-badge"></span>
    </div>
    <div class="wtb-panel" hidden>
      <div class="wtb-panel-head">
        <div class="wtb-tabs"></div>
        <div class="wtb-head-actions">
          <button class="wtb-gear" title="设置">⚙</button>
          <button class="wtb-close" title="收起">✕</button>
        </div>
      </div>
      <div class="wtb-panel-body"></div>
    </div>
    <div class="wtb-toast"></div>
  `;

  /* ---------------- 状态 ---------------- */
  let host, shadowRoot, fabEl, fabIconEl, fabImgEl, panelEl, tabsEl, panesEl, badgeEl, toastEl, gearEl;
  let settingsPane = null, settingsSel = null;
  let sizeBtnMap = null, fabSizeBtnMap = null;
  let opacityRange = null, opacityValEl = null;
  let iconPreviewEl = null;
  const tabs = new Map();          // id -> { def, tab, pane, ctx }
  let activeId = null;
  let toastTimer = null;

  /* ---------------- 配置持久化 ---------------- */
  const CFG_KEY = 'wtb:core:config:v1';
  const cfg = {
    fab: null,
    defaultTab: null,
    size: 'standard',
    fabSize: 'standard',
    fabOpacity: 1,                 // 0.1 ~ 1
    fabIcon: null                  // data URL（自定义图标）
  };

  /* ---------------- 面板大小预设 ---------------- */
  const SIZE_PRESETS = [
    { id: 'nano',     label: '迷你', w: 260, h: 360 },
    { id: 'tiny',     label: '超小', w: 300, h: 420 },
    { id: 'compact',  label: '紧凑', w: 340, h: 460 },
    { id: 'standard', label: '标准', w: 480, h: 620 },
    { id: 'large',    label: '大',   w: 640, h: 760 }
  ];
  const MIN_PANEL_W = 200;
  const MIN_PANEL_H = 150;

  /* ---------------- 悬浮球大小预设 ---------------- */
  const FAB_SIZE_PRESETS = [
    { id: 'nano',     label: '迷你', size: 32, font: 15 },
    { id: 'small',    label: '小',   size: 38, font: 18 },
    { id: 'standard', label: '标准', size: 46, font: 22 },
    { id: 'large',    label: '大',   size: 56, font: 27 },
    { id: 'xlarge',   label: '超大', size: 68, font: 32 }
  ];
  const DEFAULT_FAB_SIZE_ID = 'standard';
  const FAB_SIZE_FALLBACK = 46;

  /* ---------------- 透明度 & 图标约束 ---------------- */
  const FAB_OPACITY_MIN = 0.1;           // 最低 10%，避免完全不可见
  const FAB_OPACITY_MAX = 1;
  const FAB_ICON_MAX_FILE = 3 * 1024 * 1024;   // 3MB 原文件大小上限
  const FAB_ICON_MAX_DIM  = 128;               // 缩放后的最大边长
  const FAB_ICON_MAX_DATA = 400 * 1024;        // 最终 data URL 大小上限（约 400KB）

  function getSizePreset(id) {
    return SIZE_PRESETS.find(p => p.id === id) || SIZE_PRESETS[3];
  }
  function sizeText(p) { return p.w + '×' + p.h; }

  function getFabSizePreset(id) {
    return FAB_SIZE_PRESETS.find(p => p.id === id)
        || FAB_SIZE_PRESETS.find(p => p.id === DEFAULT_FAB_SIZE_ID)
        || FAB_SIZE_PRESETS[2];
  }

  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

  function readStore(key) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, null);
        if (v != null) return v;
      }
    } catch (e) {}
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, val) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
    } catch (e) {}
    try { localStorage.setItem(key, val); } catch (e) {}
  }
  function loadCfg() {
    const raw = readStore(CFG_KEY);
    if (!raw) return;
    try {
      const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!o || typeof o !== 'object') return;
      if (o.fab && isFinite(o.fab.x) && isFinite(o.fab.y)) {
        cfg.fab = {
          x: Math.min(1, Math.max(0, Number(o.fab.x))),
          y: Math.min(1, Math.max(0, Number(o.fab.y)))
        };
      }
      if (typeof o.defaultTab === 'string' && o.defaultTab) cfg.defaultTab = o.defaultTab;
      if (typeof o.size === 'string' && SIZE_PRESETS.some(p => p.id === o.size)) cfg.size = o.size;
      if (o.size === 'auto') cfg.size = 'standard';        // 兼容已废弃的 auto
      if (typeof o.fabSize === 'string' && FAB_SIZE_PRESETS.some(p => p.id === o.fabSize)) {
        cfg.fabSize = o.fabSize;
      }
      if (typeof o.fabOpacity === 'number' && isFinite(o.fabOpacity)) {
        cfg.fabOpacity = clamp(o.fabOpacity, FAB_OPACITY_MIN, FAB_OPACITY_MAX);
      }
      if (typeof o.fabIcon === 'string' && /^data:image\//i.test(o.fabIcon)) {
        cfg.fabIcon = o.fabIcon;
      }
    } catch (e) {}
  }
  function saveCfg() {
    try { writeStore(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  /* ---------------- 构建外壳 ---------------- */
  function buildShell() {
    host = document.createElement('div');
    host.setAttribute(UI_ATTR, '1');
    document.documentElement.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<style>' + BASE_CSS + '</style>' + SHELL_HTML;

    fabEl     = shadowRoot.querySelector('.wtb-fab');
    fabIconEl = shadowRoot.querySelector('.wtb-fab-icon');
    fabImgEl  = shadowRoot.querySelector('.wtb-fab-img');
    panelEl   = shadowRoot.querySelector('.wtb-panel');
    tabsEl    = shadowRoot.querySelector('.wtb-tabs');
    panesEl   = shadowRoot.querySelector('.wtb-panel-body');
    badgeEl   = shadowRoot.querySelector('.wtb-badge');
    toastEl   = shadowRoot.querySelector('.wtb-toast');
    gearEl    = shadowRoot.querySelector('.wtb-gear');

    fabEl.addEventListener('click', onFabClick);
    bindFabDrag();
    bindFabContextMenu();

    shadowRoot.querySelector('.wtb-close').addEventListener('click', closePanel);
    gearEl.addEventListener('click', toggleSettings);

    // 设置面板（内核自带，不属于任何模块）
    const built = buildSettingsPane();
    settingsPane  = built.pane;
    settingsSel   = built.sel;
    sizeBtnMap    = built.sizeBtns;
    fabSizeBtnMap = built.fabSizeBtns;
    opacityRange  = built.opacityRange;
    opacityValEl  = built.opacityVal;
    iconPreviewEl = built.iconPreview;
    panesEl.appendChild(settingsPane);

    // 全局快捷键 → 通过总线广播给模块，内核自己不做业务
    window.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey && (e.code === 'KeyS' || e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        bus.emit('shortcut:toggle-pick');
      } else if (e.key === 'Escape') {
        bus.emit('shortcut:escape');
      }
    }, true);

    window.addEventListener('resize', onViewportChange, { passive: true });

    // 初始化：面板大小 → 悬浮球大小 → 透明度 → 图标
    applyPanelSize(false);
    applyFabSize(true);
    applyFabOpacity(true);
    applyFabIcon(true);
  }

  /* ============================================================
   * 2. 悬浮球：尺寸 / 透明度 / 图标 / 拖动 / 复位
   * ============================================================ */

  const DRAG_THRESHOLD = 4;
  const EDGE_PADDING   = 4;

  let dragState = null;
  let suppressClick = false;

  function fabSize() {
    return fabEl && fabEl.offsetWidth ? fabEl.offsetWidth : FAB_SIZE_FALLBACK;
  }

  /* ---------- 尺寸 ---------- */
  function applyFabSize(silent) {
    if (!fabEl) return null;
    const preset = getFabSizePreset(cfg.fabSize);
    fabEl.style.width    = preset.size + 'px';
    fabEl.style.height   = preset.size + 'px';
    fabEl.style.fontSize = preset.font + 'px';

    if (cfg.fab) applyFabPosition();
    if (panelEl && !panelEl.hidden) positionPanel();

    syncFabSizeButtons();
    if (!silent) toast('悬浮球大小：' + preset.label + '（' + preset.size + 'px）');
    bus.emit('fab:size', { id: preset.id, size: preset.size });
    return preset;
  }
  function setFabSize(id, silent) {
    if (!FAB_SIZE_PRESETS.some(p => p.id === id)) id = DEFAULT_FAB_SIZE_ID;
    cfg.fabSize = id;
    saveCfg();
    applyFabSize(silent);
    return cfg.fabSize;
  }
  function syncFabSizeButtons() {
    if (!fabSizeBtnMap) return;
    for (const [id, btn] of fabSizeBtnMap) {
      btn.classList.toggle('on', id === cfg.fabSize);
      btn.classList.toggle('ghost', id !== cfg.fabSize);
    }
  }

  /* ---------- 透明度 ---------- */
  function applyFabOpacity(silent) {
    if (!fabEl) return;
    const v = clamp(Number(cfg.fabOpacity) || 1, FAB_OPACITY_MIN, FAB_OPACITY_MAX);
    cfg.fabOpacity = v;
    fabEl.style.opacity = String(v);
    syncFabOpacityControls();
    if (!silent) bus.emit('fab:opacity', { value: v });
  }
  function setFabOpacity(v, silent) {
    cfg.fabOpacity = clamp(Number(v) || 1, FAB_OPACITY_MIN, FAB_OPACITY_MAX);
    saveCfg();
    applyFabOpacity(silent);
    return cfg.fabOpacity;
  }
  function syncFabOpacityControls() {
    if (opacityRange) opacityRange.value = String(Math.round(cfg.fabOpacity * 100));
    if (opacityValEl) opacityValEl.textContent = Math.round(cfg.fabOpacity * 100) + '%';
  }

  /* ---------- 自定义图标 ---------- */
  function applyFabIcon(silent) {
    if (!fabEl || !fabIconEl || !fabImgEl) return;
    if (cfg.fabIcon) {
      fabImgEl.src = cfg.fabIcon;
      fabImgEl.hidden = false;
      fabIconEl.style.display = 'none';
    } else {
      fabImgEl.removeAttribute('src');
      fabImgEl.hidden = true;
      fabIconEl.style.display = '';
    }
    syncFabIconPreview();
    if (!silent) bus.emit('fab:icon', { hasIcon: !!cfg.fabIcon });
  }
  function setFabIcon(dataUrl, silent) {
    cfg.fabIcon = (typeof dataUrl === 'string' && /^data:image\//i.test(dataUrl)) ? dataUrl : null;
    saveCfg();
    applyFabIcon(silent);
    return cfg.fabIcon;
  }
  function clearFabIcon() {
    setFabIcon(null);
    toast('已恢复默认图标');
  }
  function syncFabIconPreview() {
    if (!iconPreviewEl) return;
    iconPreviewEl.textContent = '';
    if (cfg.fabIcon) {
      const img = document.createElement('img');
      img.src = cfg.fabIcon;
      img.alt = '';
      iconPreviewEl.appendChild(img);
    } else {
      iconPreviewEl.textContent = '🧰';
    }
  }

  /** 读取用户选择的图片，裁剪 / 缩放为正方形，输出 data URL */
  function processIconFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error('EMPTY')); return; }
      if (!/^image\//i.test(file.type)) { reject(new Error('NOT_IMAGE')); return; }
      if (file.size > FAB_ICON_MAX_FILE) { reject(new Error('TOO_LARGE')); return; }

      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          try {
            const srcW = img.naturalWidth  || img.width;
            const srcH = img.naturalHeight || img.height;
            if (!srcW || !srcH) { reject(new Error('BAD_DIM')); return; }

            // 正方形居中裁剪 + 缩放
            const side = Math.min(srcW, srcH);
            const sx = Math.floor((srcW - side) / 2);
            const sy = Math.floor((srcH - side) / 2);
            const out = Math.min(FAB_ICON_MAX_DIM, side);

            const canvas = document.createElement('canvas');
            canvas.width = out; canvas.height = out;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, out, out);
            ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);

            // 优先 PNG；若体积过大则退回 JPEG（无透明）
            let dataUrl = canvas.toDataURL('image/png');
            if (dataUrl.length > FAB_ICON_MAX_DATA) {
              const jpeg = canvas.toDataURL('image/jpeg', 0.85);
              if (jpeg.length < dataUrl.length) dataUrl = jpeg;
            }
            if (dataUrl.length > FAB_ICON_MAX_DATA) {
              reject(new Error('ENCODED_TOO_LARGE'));
              return;
            }
            resolve(dataUrl);
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = () => reject(new Error('LOAD_FAIL'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('READ_FAIL'));
      reader.readAsDataURL(file);
    });
  }

  async function handleIconUpload(file) {
    try {
      const dataUrl = await processIconFile(file);
      setFabIcon(dataUrl);
      toast('自定义图标已应用');
    } catch (e) {
      const msg = {
        EMPTY: '未选择文件',
        NOT_IMAGE: '请选择图片文件',
        TOO_LARGE: '图片过大（上限 3MB）',
        ENCODED_TOO_LARGE: '图片压缩后仍过大，请换一张',
        LOAD_FAIL: '图片解析失败',
        READ_FAIL: '图片读取失败',
        BAD_DIM: '图片尺寸无效'
      }[e && e.message] || '图标处理失败';
      toast(msg, true);
    }
  }

  /* ---------- 拖动 / 位置 ---------- */
  function moveFab(left, top) {
    const size = fabSize();
    const maxLeft = Math.max(EDGE_PADDING, window.innerWidth  - size - EDGE_PADDING);
    const maxTop  = Math.max(EDGE_PADDING, window.innerHeight - size - EDGE_PADDING);
    const l = clamp(left, EDGE_PADDING, maxLeft);
    const t = clamp(top,  EDGE_PADDING, maxTop);
    fabEl.style.left   = l + 'px';
    fabEl.style.top    = t + 'px';
    fabEl.style.right  = 'auto';
    fabEl.style.bottom = 'auto';
    return { left: l, top: t };
  }

  function saveFabPosition() {
    if (!fabEl) return;
    const size = fabSize();
    const rect = fabEl.getBoundingClientRect();
    const maxX = Math.max(1, window.innerWidth  - size);
    const maxY = Math.max(1, window.innerHeight - size);
    cfg.fab = { x: rect.left / maxX, y: rect.top / maxY };
    saveCfg();
  }

  function applyFabPosition() {
    if (!fabEl || !cfg.fab) return;
    const size = fabSize();
    const maxX = Math.max(0, window.innerWidth  - size);
    const maxY = Math.max(0, window.innerHeight - size);
    moveFab(cfg.fab.x * maxX, cfg.fab.y * maxY);
  }

  function resetFab(silent) {
    if (!fabEl) return;
    cfg.fab = null;
    saveCfg();
    fabEl.style.left   = '';
    fabEl.style.top    = '';
    fabEl.style.right  = '';
    fabEl.style.bottom = '';
    if (panelEl && !panelEl.hidden) positionPanel();
    bus.emit('fab:reset');
    if (!silent) toast('悬浮球已复位');
  }

  function bindFabDrag() {
    fabEl.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const rect = fabEl.getBoundingClientRect();
      dragState = {
        id: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        originLeft: rect.left, originTop: rect.top,
        moved: false
      };
      try { fabEl.setPointerCapture(e.pointerId); } catch (err) {}
    });

    fabEl.addEventListener('pointermove', e => {
      if (!dragState || e.pointerId !== dragState.id) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;

      if (!dragState.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        dragState.moved = true;
        fabEl.classList.add('dragging');
      }
      if (e.cancelable) e.preventDefault();
      moveFab(dragState.originLeft + dx, dragState.originTop + dy);
    });

    const endDrag = e => {
      if (!dragState || e.pointerId !== dragState.id) return;
      const moved = dragState.moved;
      try { fabEl.releasePointerCapture(dragState.id); } catch (err) {}
      dragState = null;
      fabEl.classList.remove('dragging');

      if (!moved) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);

      saveFabPosition();
      if (panelEl && !panelEl.hidden) positionPanel();
      bus.emit('fab:moved', { fab: cfg.fab });
    };

    fabEl.addEventListener('pointerup', endDrag);
    fabEl.addEventListener('pointercancel', endDrag);
  }

  function bindFabContextMenu() {
    fabEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      resetFab();
    });
  }

  function onFabClick(e) {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    togglePanel();
  }

  /* ============================================================
   * 3. 面板尺寸：预设 + 尺寸约束
   * ============================================================ */

  function resolvePanelSize(id) {
    const preset = getSizePreset(id);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let w = preset.w;
    let h = preset.h;
    w = Math.max(MIN_PANEL_W, Math.min(w, vw - 36));
    h = Math.max(MIN_PANEL_H, Math.min(h, vh - 100));
    return { w, h, preset };
  }

  function applyPanelSize(reposition) {
    if (!panelEl) return null;
    const { w, h } = resolvePanelSize(cfg.size);
    panelEl.style.width  = w + 'px';
    panelEl.style.height = h + 'px';
    if (reposition !== false && !panelEl.hidden) positionPanel();
    return { w, h };
  }

  function setPanelSize(id, silent) {
    if (!SIZE_PRESETS.some(p => p.id === id)) id = 'standard';
    cfg.size = id;
    saveCfg();
    const size = applyPanelSize();
    syncSizeButtons();
    if (!silent && size) {
      toast('面板大小：' + size.preset.label + '（' + size.w + '×' + size.h + '）');
    }
    bus.emit('panel:size', { id, ...(size || {}) });
    return cfg.size;
  }

  function syncSizeButtons() {
    if (!sizeBtnMap) return;
    for (const [id, btn] of sizeBtnMap) {
      btn.classList.toggle('on', id === cfg.size);
      btn.classList.toggle('ghost', id !== cfg.size);
    }
  }

  /* ---------------- 面板开合 & 定位 ---------------- */
  function togglePanel() { panelEl.hidden ? openPanel() : closePanel(); }

  function openPanel() {
    if (!panelEl.hidden) return;
    panelEl.style.visibility = 'hidden';
    panelEl.hidden = false;
    applyPanelSize(false);
    positionPanel();
    panelEl.style.visibility = '';
    applyDefaultTab();
    bus.emit('panel:open');
  }

  function closePanel() {
    if (panelEl.hidden) return;
    panelEl.hidden = true;
    bus.emit('panel:close');
  }

  function positionPanel() {
    if (!panelEl || panelEl.hidden || !fabEl) return;

    const GAP = 12;
    const fabR = fabEl.getBoundingClientRect();
    const pw = panelEl.offsetWidth;
    const ph = panelEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left;
    if (fabR.left + fabR.width / 2 < vw / 2) left = fabR.left;
    else left = fabR.left + fabR.width - pw;
    left = clamp(left, 8, Math.max(8, vw - pw - 8));

    let top = fabR.top - GAP - ph;
    if (top < 8) top = fabR.bottom + GAP;
    top = clamp(top, 8, Math.max(8, vh - ph - 8));

    panelEl.style.left   = left + 'px';
    panelEl.style.top    = top + 'px';
    panelEl.style.right  = 'auto';
    panelEl.style.bottom = 'auto';
  }

  let resizeRaf = 0;
  function onViewportChange() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (cfg.fab) applyFabPosition();
      applyPanelSize(false);
      if (panelEl && !panelEl.hidden) positionPanel();
    });
  }

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

  /* ============================================================
   * 4. 设置面板
   * ============================================================ */

  function buildSettingsPane() {
    /* ---- 面板大小 ---- */
    const sizeBtns = new Map();
    const sizeGroup = h('div', { class: 'wtb-row wtb-size-group' });
    for (const p of SIZE_PRESETS) {
      const btn = h('button', {
        class: 'wtb-btn ghost',
        'data-size': p.id,
        title: p.label + ' · ' + p.w + ' × ' + p.h
      }, [
        h('span', { class: 'sz-name' }, p.label),
        h('span', { class: 'sz-desc' }, sizeText(p))
      ]);
      btn.addEventListener('click', () => setPanelSize(p.id));
      sizeBtns.set(p.id, btn);
      sizeGroup.appendChild(btn);
    }
    const sizeHint = h('div', { class: 'wtb-hint' }, '');

    /* ---- 悬浮球大小 ---- */
    const fabSizeBtns = new Map();
    const fabSizeGroup = h('div', { class: 'wtb-row wtb-size-group' });
    for (const p of FAB_SIZE_PRESETS) {
      const btn = h('button', {
        class: 'wtb-btn ghost',
        'data-fab-size': p.id,
        title: p.label + ' · ' + p.size + 'px'
      }, [
        h('span', { class: 'sz-name' }, p.label),
        h('span', { class: 'sz-desc' }, p.size + 'px')
      ]);
      btn.addEventListener('click', () => setFabSize(p.id));
      fabSizeBtns.set(p.id, btn);
      fabSizeGroup.appendChild(btn);
    }

    /* ---- 悬浮球透明度 ---- */
    const opacityR = h('input', {
      type: 'range',
      min: String(Math.round(FAB_OPACITY_MIN * 100)),
      max: String(Math.round(FAB_OPACITY_MAX * 100)),
      step: '5',
      class: 'wtb-opacity-range'
    });
    const opacityV = h('span', { class: 'wtb-opacity-val' }, '100%');

    const commitOpacity = (v, silent) => {
      setFabOpacity(v / 100, silent);
      syncFabOpacityControls();
    };
    opacityR.addEventListener('input', () => {
      // 实时预览，不弹出 toast
      cfg.fabOpacity = clamp(Number(opacityR.value) / 100, FAB_OPACITY_MIN, FAB_OPACITY_MAX);
      if (fabEl) fabEl.style.opacity = String(cfg.fabOpacity);
      if (opacityV) opacityV.textContent = Math.round(cfg.fabOpacity * 100) + '%';
    });
    opacityR.addEventListener('change', () => {
      commitOpacity(Number(opacityR.value));
    });

    /* ---- 自定义图标 ---- */
    const iconPreview = h('div', { class: 'wtb-icon-preview' }, '🧰');
    const fileInput = h('input', {
      type: 'file', accept: 'image/*',
      style: 'display:none'
    });
    fileInput.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) handleIconUpload(f);
      fileInput.value = '';
    });

    const uploadBtn = h('button', { class: 'wtb-btn' }, '上传图片');
    uploadBtn.addEventListener('click', () => fileInput.click());

    const clearIconBtn = h('button', { class: 'wtb-btn ghost' }, '恢复默认');
    clearIconBtn.addEventListener('click', clearFabIcon);

    /* ---- 默认展示页面 ---- */
    const sel = h('select', { class: 'wtb-set-default', title: '默认展示页面' });
    sel.addEventListener('change', () => {
      cfg.defaultTab = sel.value || null;
      saveCfg();
      toast(cfg.defaultTab ? '默认页面已设置' : '已恢复：跟随上次打开的页面');
      bus.emit('settings:default-tab', cfg.defaultTab);
    });

    /* ---- 悬浮球位置 ---- */
    const resetFabBtn = h('button', { class: 'wtb-btn ghost' }, '复位到默认位置');
    resetFabBtn.addEventListener('click', () => resetFab());

    const pane = h('div', { class: 'wtb-pane wtb-settings' }, [
      h('div', { class: 'wtb-sec' }, [
        h('div', { class: 'wtb-sec-title' }, '面板大小'),
        sizeGroup,
        sizeHint,
        h('div', { class: 'wtb-hint' }, '尺寸会自动限制在当前视口内，超出部分会被裁剪。')
      ]),
      h('div', { class: 'wtb-sec' }, [
        h('div', { class: 'wtb-sec-title' }, '悬浮球大小'),
        fabSizeGroup,
        h('div', { class: 'wtb-hint' }, '悬浮球图标与文字将按所选尺寸同步缩放。')
      ]),
      h('div', { class: 'wtb-sec' }, [
        h('div', { class: 'wtb-sec-title' }, '悬浮球透明度'),
        h('div', { class: 'wtb-row wtb-opacity-row' }, [opacityR, opacityV]),
        h('div', { class: 'wtb-hint' }, '拖动滑块调整悬浮球的整体不透明度，最低 10%。')
      ]),
      h('div', { class: 'wtb-sec' }, [
        h('div', { class: 'wtb-sec-title' }, '悬浮球图标'),
        h('div', { class: 'wtb-row wtb-icon-row' }, [
          iconPreview, uploadBtn, clearIconBtn, fileInput
        ]),
        h('div', { class: 'wtb-hint' }, '上传图片会自动居中裁剪为正方形并缩放；建议使用透明背景 PNG。')
      ]),
      h('div', { class: 'wtb-sec' }, [
        h('div', { class: 'wtb-sec-title' }, '默认展示页面'),
        h('div', { class: 'wtb-row' }, [sel]),
        h('div', { class: 'wtb-hint' }, '每次打开工具箱时自动切换到所选页面；未设置则跟随上次打开的页面。')
      ]),
      h('div', { class: 'wtb-sec' }, [
        h('div', { class: 'wtb-sec-title' }, '悬浮球位置'),
        h('div', { class: 'wtb-row' }, [resetFabBtn]),
        h('div', { class: 'wtb-hint' }, '按住悬浮球拖动即可移动；在悬浮球上点右键可快速复位；窗口尺寸变化时按比例保持位置。')
      ])
    ]);

    sizeHint.__sync = function () {
      const { w, h, preset } = resolvePanelSize(cfg.size);
      sizeHint.textContent = '当前：' + preset.label + ' · ' + w + ' × ' + h + ' px';
    };
    sizeHint.__sync();

    return { pane, sel, sizeBtns, sizeHint, fabSizeBtns, opacityRange: opacityR, opacityVal: opacityV, iconPreview };
  }

  function fillDefaultTabSelect() {
    if (!settingsSel) return;
    settingsSel.textContent = '';
    settingsSel.appendChild(h('option', { value: '' }, '（跟随上次打开的页面）'));
    for (const def of bus.listModules()) {
      settingsSel.appendChild(h('option', { value: def.id },
        (def.icon ? def.icon + ' ' : '') + (def.title || def.id)));
    }
    settingsSel.value = cfg.defaultTab || '';
    if (settingsSel.value !== (cfg.defaultTab || '')) settingsSel.value = '';
  }

  function settingsVisible() {
    return !!(settingsPane && settingsPane.classList.contains('active'));
  }

  function toggleSettings() {
    openPanel();
    if (settingsVisible()) {
      settingsSel.value = cfg.defaultTab || '';
      const first = tabs.keys().next();
      if (!first.done) activate(first.value);
      else { settingsPane.classList.remove('active'); gearEl.classList.remove('active'); }
      return;
    }
    fillDefaultTabSelect();
    syncSizeButtons();
    syncFabSizeButtons();
    syncFabOpacityControls();
    syncFabIconPreview();
    if (settingsPane.__sizeHint) settingsPane.__sizeHint.__sync();
    const cur = tabs.get(activeId);
    if (cur) { cur.tab.classList.remove('active'); cur.pane.classList.remove('active'); }
    activeId = null;
    settingsPane.classList.add('active');
    gearEl.classList.add('active');
  }

  /* ---------------- 默认展示页面 ---------------- */
  function applyDefaultTab() {
    const id = cfg.defaultTab;
    if (!id || !tabs.has(id) || activeId === id || settingsVisible()) return;
    activate(id);
  }

  /* ---------------- Tab 激活 ---------------- */
  function activate(id) {
    const next = tabs.get(id);
    if (!next) return;

    const wasSettings = settingsVisible();
    if (activeId === id && !wasSettings) return;

    const prev = tabs.get(activeId);
    if (prev) {
      prev.tab.classList.remove('active');
      prev.pane.classList.remove('active');
      try { if (prev.def.onDeactivate) prev.def.onDeactivate(prev.ctx); } catch (e) {}
    }
    if (settingsPane) settingsPane.classList.remove('active');
    if (gearEl) gearEl.classList.remove('active');

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

    let refTab = null, refPane = null;
    for (const entry of tabs.values()) {
      const o = entry.def.order == null ? 100 : entry.def.order;
      if (o > order) { refTab = entry.tab; refPane = entry.pane; break; }
    }
    tabsEl.insertBefore(tabBtn, refTab);
    panesEl.insertBefore(pane, refPane);

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
    if (cfg.defaultTab === def.id) activate(def.id);
    if (settingsVisible()) fillDefaultTabSelect();
  }

  function removeModule(id) {
    const entry = tabs.get(id);
    if (!entry) return;
    try { if (entry.def.unmount) entry.def.unmount(entry.ctx); } catch (e) {}
    entry.tab.remove();
    entry.pane.remove();
    tabs.delete(id);

    if (cfg.defaultTab === id) { cfg.defaultTab = null; saveCfg(); }
    if (settingsVisible()) fillDefaultTabSelect();

    if (activeId === id) {
      activeId = null;
      const first = tabs.keys().next();
      if (!first.done) activate(first.value);
    }
  }

  /* ---------------- 对总线/模块暴露的公共 API ---------------- */
  bus.setDefaultTab = function (id) {
    cfg.defaultTab = id || null;
    saveCfg();
    if (settingsSel) fillDefaultTabSelect();
    return cfg.defaultTab;
  };
  bus.getDefaultTab = function () { return cfg.defaultTab; };

  bus.setPanelSize = function (id) { return setPanelSize(id); };
  bus.getPanelSize = function () { return cfg.size; };
  bus.listPanelSizes = function () {
    return SIZE_PRESETS.map(p => ({ id: p.id, label: p.label, w: p.w, h: p.h }));
  };

  bus.setFabSize = function (id) { return setFabSize(id); };
  bus.getFabSize = function () { return cfg.fabSize; };
  bus.listFabSizes = function () {
    return FAB_SIZE_PRESETS.map(p => ({ id: p.id, label: p.label, size: p.size }));
  };

  bus.setFabOpacity = function (v) { return setFabOpacity(v); };
  bus.getFabOpacity = function () { return cfg.fabOpacity; };

  bus.setFabIcon = function (dataUrl) { return setFabIcon(dataUrl); };
  bus.getFabIcon = function () { return cfg.fabIcon; };
  bus.clearFabIcon = function () { clearFabIcon(); };

  bus.resetFab = function () { resetFab(); };
  bus.setFabPosition = function (left, top) {
    moveFab(left, top);
    saveFabPosition();
    if (panelEl && !panelEl.hidden) positionPanel();
  };

  /* ---------------- 启动 ---------------- */
  function boot() {
    try { loadCfg(); } catch (e) {}
    try { buildShell(); }
    catch (e) { console.error('[WTB] 外壳构建失败', e); return; }

    try {
      if (settingsPane) settingsPane.__sizeHint = settingsPane.querySelector('.wtb-hint');
    } catch (e) {}

    try { applyFabPosition(); } catch (e) {}

    bus._attachShell({
      addModule,
      removeModule,
      activate,
      openPanel,
      closePanel,
      setBadge,
      toast,
      openSettings: toggleSettings,
      setDefaultTab: bus.setDefaultTab,
      getDefaultTab: bus.getDefaultTab,
      setPanelSize: bus.setPanelSize,
      getPanelSize: bus.getPanelSize,
      setFabSize: bus.setFabSize,
      getFabSize: bus.getFabSize,
      setFabOpacity: bus.setFabOpacity,
      getFabOpacity: bus.getFabOpacity,
      setFabIcon: bus.setFabIcon,
      getFabIcon: bus.getFabIcon,
      clearFabIcon: bus.clearFabIcon,
      resetFab,
      setFabPosition: bus.setFabPosition,
      get shadowRoot() { return shadowRoot; },
      get host() { return host; }
    });

    try { applyDefaultTab(); } catch (e) {}

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('🧰 显示工具箱面板', openPanel);
        GM_registerMenuCommand('🎯 复位悬浮球位置', () => resetFab());
        GM_registerMenuCommand('⚙️ 工具箱设置', () => {
          openPanel();
          if (!settingsVisible()) toggleSettings();
        });
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
