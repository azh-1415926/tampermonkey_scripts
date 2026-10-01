/* ==========================================================================
 *  网页工具箱 · 自定义脚本模块
 *  —— 以「剪贴板模块」为模板改写
 *
 *  功能：
 *    · 可视化新建 / 编辑 / 保存脚本
 *    · 操作步骤：定位控件、点击、输入、按键、滚动、等待、等待出现、执行代码
 *    · 跨 iframe（含跨域）控件定位与操作  ← 核心难点
 *    · 导出到本地文件 / 保存到网页存储（localStorage）
 *    · 导入本地脚本文件
 * ========================================================================== */

// ==UserScript==
// @name         网页工具箱 · 自定义脚本模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  可视化自定义脚本：定位控件、点击、输入、等待、按键，支持跨 iframe 操作与导入导出。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_CUSTOM_MODULE__) return;
  W.__WTB_CUSTOM_MODULE__ = true;

  let IS_TOP = false;
  try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }

  /* ======================================================================
   *  第一部分：帧内 DOM 执行器
   *  顶层窗口与所有 iframe 共用同一套实现。
   *  顶层直接调用 handleAction()；iframe 通过 postMessage 收命令再回结果。
   * ==================================================================== */

  const FRAME_MSG = '__wtb_custom_script__';
  const MAX_TEXT = 120;

  function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms | 0))); }

  function clampNum(v, min, max, dflt) {
    let n = Number(v);
    if (!isFinite(n)) n = dflt;
    return Math.min(max, Math.max(min, n));
  }

  /* 生成元素的可读描述 */
  function describeEl(el) {
    if (!el) return null;
    let cls = '';
    try { cls = (typeof el.className === 'string' ? el.className : '') || ''; } catch (_) {}
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      id: el.id || '',
      cls: cls,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
      value: (typeof el.value === 'string') ? el.value.slice(0, MAX_TEXT) : '',
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      visible: rect.width > 0 && rect.height > 0
    };
  }

  /* 按选择器 + 序号取元素，取不到就抛错 */
  function resolveEl(selector, index) {
    if (!selector) throw new Error('选择器为空');
    let list;
    try {
      list = document.querySelectorAll(selector);
    } catch (e) {
      throw new Error('选择器语法错误：' + selector);
    }
    const i = index | 0;
    if (!list.length) throw new Error('未找到匹配元素：' + selector);
    if (i >= list.length) throw new Error('只匹配到 ' + list.length + ' 个元素，取不到第 ' + (i + 1) + ' 个');
    return { el: list[i], count: list.length };
  }

  /* ---------- 点击：模拟完整指针/鼠标事件序列 + 原生 click() ---------- */
  function doClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1
    };

    const fire = (type, extra) => {
      try {
        const usePointer = type.indexOf('pointer') === 0 && typeof window.PointerEvent === 'function';
        const Ctor = usePointer ? window.PointerEvent : window.MouseEvent;
        el.dispatchEvent(new Ctor(type, Object.assign({}, base, extra || {})));
      } catch (_) { /* 忽略单个事件失败 */ }
    };

    fire('pointerover', { pointerType: 'mouse', isPrimary: true });
    fire('pointerenter', { pointerType: 'mouse', isPrimary: true, bubbles: false });
    fire('mouseover');
    fire('mouseenter');
    fire('pointermove', { pointerType: 'mouse', isPrimary: true });
    fire('mousemove');
    fire('pointerdown', { pointerType: 'mouse', isPrimary: true });
    fire('mousedown');
    fire('pointerup', { pointerType: 'mouse', isPrimary: true, buttons: 0 });
    fire('mouseup', { buttons: 0 });

    // 原生 click() 会触发默认行为（复选框切换、表单提交、链接跳转等）
    if (typeof el.click === 'function') {
      try { el.click(); return; } catch (_) {}
    }
    fire('click', { buttons: 0 });
  }

  /* ---------- 输入：兼容 React / Vue 受控组件 ---------- */
  function setNativeValue(el, value) {
    const proto =
      (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype :
      (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) ? HTMLInputElement.prototype :
      null;
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) { desc.set.call(el, value); return; }
    }
    el.value = value;
  }

  function emitInputEvents(el, text) {
    let ev;
    try {
      ev = new InputEvent('input', { bubbles: true, cancelable: false, data: text, inputType: 'insertText' });
    } catch (_) {
      ev = new Event('input', { bubbles: true, cancelable: false });
    }
    el.dispatchEvent(ev);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function doInput(el, text, opts) {
    opts = opts || {};
    try { el.focus(); } catch (_) {}

    if (el.isContentEditable) {
      const cur = el.textContent || '';
      el.textContent = opts.append ? cur + text : text;
      try {
        const sel = document.getSelection();
        if (sel && opts.append === false) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (_) {}
      emitInputEvents(el, text);
      return;
    }

    const cur = typeof el.value === 'string' ? el.value : '';
    const next = opts.append ? cur + text : text;
    setNativeValue(el, next);
    try { el.setSelectionRange(next.length, next.length); } catch (_) {}
    emitInputEvents(el, text);
  }

  /* ---------- 按键 ---------- */
  const KEY_MAP = {
    Enter:     { keyCode: 13, code: 'Enter' },
    Tab:       { keyCode: 9,  code: 'Tab' },
    Escape:    { keyCode: 27, code: 'Escape' },
    Space:     { keyCode: 32, code: 'Space' },
    Backspace: { keyCode: 8,  code: 'Backspace' },
    Delete:    { keyCode: 46, code: 'Delete' },
    ArrowUp:   { keyCode: 38, code: 'ArrowUp' },
    ArrowDown: { keyCode: 40, code: 'ArrowDown' },
    ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
    ArrowRight:{ keyCode: 39, code: 'ArrowRight' }
  };

  function doKey(el, key) {
    try { el.focus(); } catch (_) {}
    const meta = KEY_MAP[key] || { keyCode: 0, code: key };
    const base = {
      key: key, code: meta.code, keyCode: meta.keyCode, which: meta.keyCode,
      bubbles: true, cancelable: true, composed: true
    };
    try { el.dispatchEvent(new KeyboardEvent('keydown', base)); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent('keypress', base)); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent('keyup', base)); } catch (_) {}
  }

  /* ---------- 动作表 ---------- */
  const ACTIONS = {
    query(p) {
      let list;
      try { list = document.querySelectorAll(p.selector); }
      catch (e) { throw new Error('选择器语法错误：' + p.selector); }
      const i = p.index | 0;
      if (!list.length) return { found: false, count: 0 };
      if (i >= list.length) return { found: false, count: list.length, reason: 'index-out-of-range' };
      return { found: true, count: list.length, info: describeEl(list[i]) };
    },

    click(p) {
      const { el, count } = resolveEl(p.selector, p.index);
      doClick(el);
      return { count: count, info: describeEl(el) };
    },

    input(p) {
      const { el, count } = resolveEl(p.selector, p.index);
      doInput(el, p.text == null ? '' : String(p.text), { append: !!p.append });
      return { count: count, info: describeEl(el) };
    },

    key(p) {
      const { el, count } = resolveEl(p.selector, p.index);
      doKey(el, p.key || 'Enter');
      return { count: count, info: describeEl(el) };
    },

    scroll(p) {
      const { el, count } = resolveEl(p.selector, p.index);
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (_) {}
      return { count: count };
    },

    script(p) {
      let fn;
      try {
        fn = new Function('document', 'window', 'self', String(p.code || ''));
      } catch (e) {
        throw new Error('代码语法错误：' + e.message);
      }
      const r = fn(document, window, window.self || window);
      return { result: r === undefined ? null : String(r) };
    }
  };

  /* 统一入口：返回 { ok, ... }，绝不抛错 */
  function handleAction(payload) {
    try {
      if (!payload || !payload.action) return { ok: false, error: '缺少 action' };
      const fn = ACTIONS[payload.action];
      if (!fn) return { ok: false, error: '未知操作：' + payload.action };
      const res = fn(payload) || {};
      return Object.assign({ ok: true }, res);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* ======================================================================
   *  第二部分：iframe 桥接（非顶层窗口）
   *
   *  跨域难点说明：
   *    · 顶层无法通过 iframe.contentDocument 访问跨域子文档（同源策略）
   *    · 但本脚本以 注入到每一个 frame，
   *      因此每个子 frame 里都有一份「执行器」在运行
   *    · 于是用 postMessage 做跨文档消息通道：
   *        顶层 --exec--> 子frame --本地执行--> 顶层
   *    · 握手阶段子 frame 主动喊 hello，顶层用 event.source 记住
   *      这个 WindowProxy（跨域下依然可用于 postMessage），并分配一个 id
   * ====================================================================
   */

  function installFrameBridge() {
    let frameId = null;

    const sendToParent = (data) => {
      try { window.parent.postMessage(data, '*'); } catch (_) {}
    };

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d.__wtb !== FRAME_MSG) return;
      // 只接受来自直接父窗口的消息
      if (e.source !== window.parent) return;

      if (d.kind === 'assign') {
        frameId = d.id;
        return;
      }

      if (d.kind === 'exec') {
        const result = handleAction(d.payload || {});
        sendToParent({
          __wtb: FRAME_MSG,
          kind: 'result',
          cmdId: d.cmdId,
          frameId: frameId,
          result: result
        });
      }
    });

    // 握手：不断向父窗口自报家门，直到被分配 id（应对顶层模块晚于本 frame 初始化的情况）
    let tries = 0;
    (function hello() {
      if (frameId) return;
      tries++;
      sendToParent({ __wtb: FRAME_MSG, kind: 'hello' });
      if (tries < 60) setTimeout(hello, 500);
    })();
  }

  if (!IS_TOP) {
    try { installFrameBridge(); } catch (_) {}
    return;
  }

  /* ======================================================================
   *  第三部分：顶层 —— 模块 UI 与执行引擎
   * ==================================================================== */

  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus) return;

    const h = bus.h;

    /* ---------------- 常量 ---------------- */

    const LS_KEY = 'wtb.customScripts.v1';

    const STEP_DEFS = {
      locate: {
        label: '定位控件', icon: '🎯',
        make: () => ({ type: 'locate', target: '', index: 0, name: 'el1', frame: 'auto', timeout: 5000 })
      },
      click: {
        label: '点击', icon: '👆',
        make: () => ({ type: 'click', target: '', index: 0, frame: 'auto', delay: 300 })
      },
      input: {
        label: '输入', icon: '⌨️',
        make: () => ({ type: 'input', target: '', text: '', append: false, index: 0, frame: 'auto', delay: 200 })
      },
      key: {
        label: '按键', icon: '⏎',
        make: () => ({ type: 'key', target: '', key: 'Enter', index: 0, frame: 'auto', delay: 200 })
      },
      scroll: {
        label: '滚动到可见', icon: '🖱',
        make: () => ({ type: 'scroll', target: '', index: 0, frame: 'auto' })
      },
      wait: {
        label: '等待', icon: '⏱',
        make: () => ({ type: 'wait', ms: 1000 })
      },
      waitFor: {
        label: '等待元素出现', icon: '⏳',
        make: () => ({ type: 'waitFor', target: '', index: 0, frame: 'auto', timeout: 10000 })
      },
      script: {
        label: '执行代码', icon: '🧩',
        make: () => ({ type: 'script', code: '', frame: 'top' })
      }
    };

    /* ---------------- 状态 ---------------- */

    let scripts = [];
    let editing = null;          // 正在编辑的脚本草稿
    let running = false;
    let abortRun = false;
    let logLines = [];

    let ctxRef = null;
    let bodyEl = null;
    let logEl = null;

    /* ---------------- 帧管理 ---------------- */

    const frameById = new Map();   // frameId -> WindowProxy
    const frameMap  = new Map();   // WindowProxy -> frameId
    const frameOrder = [];
    let frameSeq = 0;

    const pending = new Map();     // cmdId -> { resolve, timer }
    let cmdSeq = 0;

    /* ---------------- 小工具 ---------------- */

    const uid = (p) => p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

    function fmtTime(t) {
      const d = new Date(t);
      const p = n => String(n).padStart(2, '0');
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function fmtDate(t) {
      if (!t) return '—';
      const d = new Date(t);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function short(s, n) {
      s = String(s == null ? '' : s).replace(/\s+/g, ' ');
      return s.length > (n || 40) ? s.slice(0, n || 40) + '…' : s;
    }
    function descInfo(info) {
      if (!info) return '未知元素';
      let s = '<' + info.tag + '>';
      if (info.id) s += '#' + info.id;
      if (info.cls) s += '.' + String(info.cls).split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      if (info.text) s += ' “' + short(info.text, 28) + '”';
      return s;
    }
    function frameLabel(id) {
      if (id === 'top') return '主页面';
      const i = frameOrder.indexOf(id);
      return i >= 0 ? `iframe #${i + 1}` : `iframe ${id}`;
    }

    function toast(msg, err) {
      if (ctxRef && ctxRef.toast) ctxRef.toast(msg, err);
    }
    function setBadge(n) {
      if (ctxRef && ctxRef.setBadge) ctxRef.setBadge(n);
    }

    /* ---------------- 顶层消息监听：握手 & 收结果 ---------------- */

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d.__wtb !== FRAME_MSG) return;

      if (d.kind === 'hello') {
        let id = frameMap.get(e.source);
        if (!id) {
          id = 'f' + (++frameSeq);
          frameMap.set(e.source, id);
          frameById.set(id, e.source);
          frameOrder.push(id);
          if (editing === null) render();   // 列表页刷新一下 iframe 计数
        }
        try { e.source.postMessage({ __wtb: FRAME_MSG, kind: 'assign', id: id }, '*'); } catch (_) {}
        return;
      }

      if (d.kind === 'result') {
        const p = pending.get(d.cmdId);
        if (!p) return;
        pending.delete(d.cmdId);
        clearTimeout(p.timer);
        p.resolve(d.result || { ok: false, error: 'iframe 未返回结果' });
      }
    });

    /* ---------------- 向某个 frame 发命令 ---------------- */

    function callFrame(frameId, payload, timeout) {
      timeout = timeout || 5000;

      if (frameId === 'top') {
        return Promise.resolve(handleAction(payload));
      }

      const win = frameById.get(frameId);
      if (!win) return Promise.resolve({ ok: false, error: '目标 iframe 已不存在' });

      return new Promise((resolve) => {
        const cmdId = 'c' + (++cmdSeq);
        const timer = setTimeout(() => {
          pending.delete(cmdId);
          resolve({ ok: false, error: 'iframe 响应超时' });
        }, timeout);

        pending.set(cmdId, { resolve: resolve, timer: timer });

        try {
          win.postMessage({ __wtb: FRAME_MSG, kind: 'exec', cmdId: cmdId, payload: payload }, '*');
        } catch (err) {
          clearTimeout(timer);
          pending.delete(cmdId);
          resolve({ ok: false, error: '无法与 iframe 通信' });
        }
      });
    }

    /* 决定一条命令应该发往哪个 frame */
    async function pickFrame(hint, selector, index) {
      if (hint === 'top') return 'top';
      if (hint && hint !== 'auto') {
        if (!frameById.has(hint)) throw new Error('目标 iframe 已失效，请重新选择作用域');
        return hint;
      }

      // auto：先查主页面，再按顺序查各个 iframe
      const q = { action: 'query', selector: selector, index: index | 0 };
      const topRes = handleAction(q);
      if (topRes.ok && topRes.found) return 'top';

      for (let i = 0; i < frameOrder.length; i++) {
        const fid = frameOrder[i];
        if (!frameById.has(fid)) continue;
        const r = await callFrame(fid, q, 900);
        if (r && r.ok && r.found) return fid;
      }
      return 'top';
    }

    /* ---------------- 存储 ---------------- */

    function loadScripts() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        const data = raw ? JSON.parse(raw) : [];
        scripts = Array.isArray(data) ? data.filter(Boolean) : [];
      } catch (_) {
        scripts = [];
      }
    }

    function saveScripts() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(scripts));
      } catch (e) {
        toast('保存到网页存储失败：' + ((e && e.message) || e), true);
      }
    }

    /* ---------------- 导入导出 ---------------- */

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    }

    function safeFileName(s) {
      return String(s || 'script').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
    }

    function exportOne(sc) {
      const blob = new Blob([JSON.stringify(sc, null, 2)], { type: 'application/json' });
      downloadBlob(blob, safeFileName(sc.name) + '.wtbscript.json');
      toast('已导出脚本文件');
    }

    function exportAll() {
      if (!scripts.length) { toast('还没有脚本可以导出', true); return; }
      const payload = { type: 'wtb-scripts', version: 1, exportedAt: Date.now(), scripts: scripts };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'wtb-scripts-' + Date.now() + '.json');
      toast('已导出 ' + scripts.length + ' 个脚本');
    }

    function normalizeScript(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const steps = Array.isArray(raw.steps) ? raw.steps : [];
      return {
        id: raw.id || uid('sc'),
        name: String(raw.name || '导入的脚本').slice(0, 80),
        desc: String(raw.desc || ''),
        createdAt: raw.createdAt || Date.now(),
        updatedAt: Date.now(),
        steps: steps
          .filter(s => s && typeof s === 'object' && STEP_DEFS[s.type])
          .map(s => Object.assign({}, s, { id: s.id || uid('st') }))
      };
    }

    async function importFile(input) {
      const f = input.files && input.files[0];
      input.value = '';
      if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : (Array.isArray(data.scripts) ? data.scripts : [data]);
        let n = 0;
        for (const raw of list) {
          const sc = normalizeScript(raw);
          if (!sc) continue;
          sc.id = uid('sc');          // 避免 id 冲突
          scripts.push(sc);
          n++;
        }
        saveScripts();
        render();
        toast(n ? `已导入 ${n} 个脚本` : '文件里没有可识别的脚本', !n);
      } catch (e) {
        toast('导入失败：' + ((e && e.message) || e), true);
      }
    }

    /* ==================================================================
     *  执行引擎
     * ================================================================ */

    function resolveTarget(st, scope) {
      const raw = String(st.target == null ? '' : st.target).trim();
      if (!raw) throw new Error('未填写目标选择器');
      if (raw.charAt(0) === '$') {
        const name = raw.slice(1);
        const ref = scope[name];
        if (!ref) throw new Error(`尚未定位到 $${name}，请确认它前面有「定位控件」步骤且已成功`);
        return { selector: ref.selector, index: ref.index, frameId: ref.frameId };
      }
      return { selector: raw, index: clampNum(st.index, 0, 9999, 0), frameId: null };
    }

    async function frameFor(t, hint) {
      if (t.frameId) return t.frameId;
      return pickFrame(hint, t.selector, t.index);
    }

    function logPush(msg, isErr) {
      logLines.push({ t: Date.now(), msg: msg, isErr: !!isErr });
      if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
      renderLog();
    }

    async function runStep(st, scope, tag) {
      switch (st.type) {

        /* ---------- 等待 ---------- */
        case 'wait': {
          const ms = clampNum(st.ms, 0, 600000, 0);
          logPush(`${tag}：等待 ${ms}ms`);
          await sleep(ms);
          return;
        }

        /* ---------- 定位控件 ---------- */
        case 'locate': {
          const name = String(st.name || '').trim();
          if (!name) throw new Error('请填写变量名');
          if (!String(st.target || '').trim()) throw new Error('请填写选择器');

          const timeout = clampNum(st.timeout, 0, 120000, 5000);
          const deadline = Date.now() + timeout;
          let frameId = 'top';
          let res = null;

          for (;;) {
            frameId = await pickFrame(st.frame, st.target, st.index);
            res = await callFrame(frameId, { action: 'query', selector: st.target, index: st.index });
            if (res && res.ok && res.found) break;
            if (Date.now() >= deadline) break;
            await sleep(200);
          }

          if (!res || !res.ok || !res.found) {
            throw new Error(res && res.error ? res.error : `${timeout}ms 内未找到元素`);
          }

          scope[name] = { frameId: frameId, selector: st.target, index: st.index, info: res.info };
          logPush(`${tag}：已定位 $${name} → ${descInfo(res.info)}（${frameLabel(frameId)}，共 ${res.count} 个匹配）`);
          return;
        }

        /* ---------- 等待出现 ---------- */
        case 'waitFor': {
          const timeout = clampNum(st.timeout, 0, 120000, 10000);
          const deadline = Date.now() + timeout;
          let ok = false;
          let frameId = 'top';

          for (;;) {
            frameId = await pickFrame(st.frame, st.target, st.index);
            const r = await callFrame(frameId, { action: 'query', selector: st.target, index: st.index }, 1500);
            if (r && r.ok && r.found) { ok = true; break; }
            if (Date.now() >= deadline) break;
            await sleep(300);
          }

          if (!ok) throw new Error(`${timeout}ms 内元素未出现：${st.target}`);
          logPush(`${tag}：元素已出现 ${st.target}（${frameLabel(frameId)}）`);
          return;
        }

        /* ---------- 点击 ---------- */
        case 'click': {
          const t = resolveTarget(st, scope);
          const frameId = await frameFor(t, st.frame);
          const res = await callFrame(frameId, { action: 'click', selector: t.selector, index: t.index });
          if (!res.ok) throw new Error(res.error || '点击失败');
          logPush(`${tag}：点击 ${t.selector} → ${descInfo(res.info)}（${frameLabel(frameId)}）`);
          const d = clampNum(st.delay, 0, 60000, 0);
          if (d) await sleep(d);
          return;
        }

        /* ---------- 输入 ---------- */
        case 'input': {
          const t = resolveTarget(st, scope);
          const text = String(st.text == null ? '' : st.text);
          const frameId = await frameFor(t, st.frame);
          const res = await callFrame(frameId, {
            action: 'input', selector: t.selector, index: t.index,
            text: text, append: !!st.append
          });
          if (!res.ok) throw new Error(res.error || '输入失败');
          logPush(`${tag}：向 ${t.selector} ${st.append ? '追加' : '填入'}「${short(text, 40)}」（${frameLabel(frameId)}）`);
          const d = clampNum(st.delay, 0, 60000, 0);
          if (d) await sleep(d);
          return;
        }

        /* ---------- 按键 ---------- */
        case 'key': {
          const t = resolveTarget(st, scope);
          const frameId = await frameFor(t, st.frame);
          const res = await callFrame(frameId, {
            action: 'key', selector: t.selector, index: t.index, key: st.key || 'Enter'
          });
          if (!res.ok) throw new Error(res.error || '按键失败');
          logPush(`${tag}：在 ${t.selector} 上按下 ${st.key || 'Enter'}（${frameLabel(frameId)}）`);
          const d = clampNum(st.delay, 0, 60000, 0);
          if (d) await sleep(d);
          return;
        }

        /* ---------- 滚动 ---------- */
        case 'scroll': {
          const t = resolveTarget(st, scope);
          const frameId = await frameFor(t, st.frame);
          const res = await callFrame(frameId, { action: 'scroll', selector: t.selector, index: t.index });
          if (!res.ok) throw new Error(res.error || '滚动失败');
          logPush(`${tag}：已滚动到 ${t.selector}（${frameLabel(frameId)}）`);
          return;
        }

        /* ---------- 执行代码 ---------- */
        case 'script': {
          const code = String(st.code || '').trim();
          if (!code) throw new Error('代码为空');
          let frameId;
          if (st.frame && st.frame !== 'auto') {
            if (st.frame !== 'top' && !frameById.has(st.frame)) throw new Error('目标 iframe 已失效');
            frameId = st.frame;
          } else {
            frameId = 'top';
          }
          const res = await callFrame(frameId, { action: 'script', code: code }, 10000);
          if (!res.ok) throw new Error(res.error || '执行失败');
          logPush(`${tag}：代码执行完成${res.result != null ? ' → ' + short(res.result, 60) : ''}（${frameLabel(frameId)}）`);
          return;
        }

        default:
          throw new Error('未知步骤类型：' + st.type);
      }
    }

    async function runScript(sc) {
      if (running) { toast('已有脚本正在运行', true); return; }
      if (!sc.steps || !sc.steps.length) { toast('脚本里还没有任何操作', true); return; }

      running = true;
      abortRun = false;
      logLines = [];
      renderLog();
      render();   // 刷新按钮状态

      const scope = {};
      const t0 = Date.now();
      logPush(`▶ 开始运行「${sc.name || '未命名'}」，共 ${sc.steps.length} 步`);

      try {
        for (let i = 0; i < sc.steps.length; i++) {
          if (abortRun) throw new Error('已被手动停止');

          const st = sc.steps[i];
          const def = STEP_DEFS[st.type];
          const tag = `第 ${i + 1} 步 · ${def ? def.label : st.type}`;

          try {
            await runStep(st, scope, tag);
          } catch (e) {
            throw new Error(`${tag} 失败：${(e && e.message) || e}`);
          }
        }
        logPush(`✔ 运行完成，总用时 ${Date.now() - t0}ms`);
        toast('脚本运行完成');
      } catch (err) {
        logPush('✘ ' + ((err && err.message) || err), true);
        toast('脚本执行出错，详见日志', true);
      } finally {
        running = false;
        abortRun = false;
        render();
      }
    }

    /* ==================================================================
     *  UI 渲染
     * ================================================================ */

    function mkBtn(label, cls, fn) {
      const b = h('button', { class: 'wtb-btn' + (cls ? ' ' + cls : '') }, label);
      b.addEventListener('click', fn);
      return b;
    }

    function fieldRow(label, control) {
      const row = h('label', { class: 'wtb-cs-field' });
      row.appendChild(h('span', { class: 'wtb-cs-flabel' }, label));
      row.appendChild(control);
      return row;
    }

    function textInput(value, placeholder, onInput) {
      const inp = h('input', { class: 'wtb-input', type: 'text' });
      inp.placeholder = placeholder || '';
      inp.value = value == null ? '' : String(value);
      inp.addEventListener('input', () => onInput(inp.value));
      return inp;
    }

    function numberInput(value, onInput, min, max) {
      const inp = h('input', { class: 'wtb-input', type: 'number' });
      inp.min = String(min == null ? 0 : min);
      inp.max = String(max == null ? 999999 : max);
      inp.value = value == null ? '' : String(value);
      inp.addEventListener('input', () => onInput(inp.value === '' ? '' : Number(inp.value)));
      return inp;
    }

    function checkBox(checked, label, onChange) {
      const wrap = h('label', { class: 'wtb-cs-check' });
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !!checked;
      cb.addEventListener('change', () => onChange(cb.checked));
      wrap.appendChild(cb);
      wrap.appendChild(h('span', {}, label));
      return wrap;
    }

    function frameSelect(st) {
      const sel = h('select', { class: 'wtb-input' });
      const add = (v, t) => {
        const o = h('option', {}, t);
        o.value = v;
        sel.appendChild(o);
      };
      add('auto', '自动（先主页面，再逐个 iframe）');
      add('top', '仅主页面（顶层文档）');
      frameOrder.forEach((id, i) => add(id, `iframe #${i + 1}（${id}）`));

      if (st.frame && st.frame !== 'auto' && st.frame !== 'top' && frameOrder.indexOf(st.frame) < 0) {
        add(st.frame, `iframe ${st.frame}（已失效）`);
      }

      sel.value = st.frame || 'auto';
      sel.addEventListener('change', () => { st.frame = sel.value; });
      return sel;
    }

    /* ---------------- 步骤字段渲染 ---------------- */

    function renderStepFields(st, box, sc) {
      switch (st.type) {

        case 'locate':
          box.appendChild(fieldRow('选择器', textInput(st.target, '#login-btn / .btn.primary', v => st.target = v)));
          box.appendChild(fieldRow('匹配序号', numberInput(st.index, v => st.index = v, 0, 999)));
          box.appendChild(fieldRow('变量名', textInput(st.name, '如 btn1', v => st.name = v)));
          box.appendChild(fieldRow('作用域', frameSelect(st)));
          box.appendChild(fieldRow('超时(ms)', numberInput(st.timeout, v => st.timeout = v, 0, 120000)));
          box.appendChild(h('div', { class: 'wtb-cs-tip' }, '后续步骤用 $变量名 引用它，例如 $btn1'));
          break;

        case 'click':
          box.appendChild(fieldRow('目标', textInput(st.target, '#submit 或 $btn1', v => st.target = v)));
          box.appendChild(fieldRow('匹配序号', numberInput(st.index, v => st.index = v, 0, 999)));
          box.appendChild(fieldRow('作用域', frameSelect(st)));
          box.appendChild(fieldRow('点击后等待(ms)', numberInput(st.delay, v => st.delay = v, 0, 60000)));
          break;

        case 'input':
          box.appendChild(fieldRow('目标', textInput(st.target, 'input[name=kw] 或 $searchBox', v => st.target = v)));
          box.appendChild(fieldRow('输入文本', textInput(st.text, '要填入的文本', v => st.text = v)));
          box.appendChild(fieldRow('', checkBox(st.append, '追加到已有内容之后（默认覆盖）', v => st.append = v)));
          box.appendChild(fieldRow('匹配序号', numberInput(st.index, v => st.index = v, 0, 999)));
          box.appendChild(fieldRow('作用域', frameSelect(st)));
          box.appendChild(fieldRow('输入后等待(ms)', numberInput(st.delay, v => st.delay = v, 0, 60000)));
          break;

        case 'key': {
          const sel = h('select', { class: 'wtb-input' });
          ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete',
           'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].forEach(k => {
            const o = h('option', {}, k);
            o.value = k;
            sel.appendChild(o);
          });
          sel.value = st.key || 'Enter';
          sel.addEventListener('change', () => st.key = sel.value);

          box.appendChild(fieldRow('目标', textInput(st.target, '#search-input 或 $box1', v => st.target = v)));
          box.appendChild(fieldRow('按键', sel));
          box.appendChild(fieldRow('作用域', frameSelect(st)));
          box.appendChild(fieldRow('按键后等待(ms)', numberInput(st.delay, v => st.delay = v, 0, 60000)));
          break;
        }

        case 'scroll':
          box.appendChild(fieldRow('目标', textInput(st.target, '#section-2 或 $el1', v => st.target = v)));
          box.appendChild(fieldRow('匹配序号', numberInput(st.index, v => st.index = v, 0, 999)));
          box.appendChild(fieldRow('作用域', frameSelect(st)));
          break;

        case 'wait':
          box.appendChild(fieldRow('等待时长(ms)', numberInput(st.ms, v => st.ms = v, 0, 600000)));
          break;

        case 'waitFor':
          box.appendChild(fieldRow('选择器', textInput(st.target, '#result', v => st.target = v)));
          box.appendChild(fieldRow('匹配序号', numberInput(st.index, v => st.index = v, 0, 999)));
          box.appendChild(fieldRow('作用域', frameSelect(st)));
          box.appendChild(fieldRow('超时(ms)', numberInput(st.timeout, v => st.timeout = v, 0, 120000)));
          break;

        case 'script': {
          const ta = h('textarea', { class: 'wtb-input wtb-cs-code' });
          ta.placeholder = '// 在当前作用域内执行，可用 document / window\n// return 的值会写入日志';
          ta.value = st.code || '';
          ta.addEventListener('input', () => st.code = ta.value);
          box.appendChild(fieldRow('代码', ta));
          box.appendChild(fieldRow('作用域', frameSelect(st)));
          break;
        }
      }
    }

    /* ---------------- 步骤卡片 ---------------- */

    function renderStepCard(sc, st, i) {
      const def = STEP_DEFS[st.type];
      const card = h('div', { class: 'wtb-cs-step' });

      const head = h('div', { class: 'wtb-cs-stephead' });
      head.appendChild(h('span', { class: 'wtb-cs-stepno' }, String(i + 1)));
      head.appendChild(h('span', { class: 'wtb-cs-steptype' }, `${def.icon} ${def.label}`));
      head.appendChild(h('span', { class: 'wtb-cs-spacer' }));

      const up = h('button', { class: 'wtb-cs-mini', title: '上移' }, '↑');
      up.addEventListener('click', () => {
        if (i === 0) return;
        const tmp = sc.steps[i - 1];
        sc.steps[i - 1] = sc.steps[i];
        sc.steps[i] = tmp;
        render();
      });

      const down = h('button', { class: 'wtb-cs-mini', title: '下移' }, '↓');
      down.addEventListener('click', () => {
        if (i >= sc.steps.length - 1) return;
        const tmp = sc.steps[i + 1];
        sc.steps[i + 1] = sc.steps[i];
        sc.steps[i] = tmp;
        render();
      });

      const del = h('button', { class: 'wtb-cs-mini danger', title: '删除该步骤' }, '✕');
      del.addEventListener('click', () => {
        sc.steps.splice(i, 1);
        render();
      });

      head.append(up, down, del);
      card.appendChild(head);

      const box = h('div', { class: 'wtb-cs-fields' });
      renderStepFields(st, box, sc);
      card.appendChild(box);

      return card;
    }

    /* ---------------- 编辑器视图 ---------------- */

    function renderEditor(root) {
      const sc = editing;

      /* 顶部工具条 */
      const bar = h('div', { class: 'wtb-cs-bar' });
      bar.appendChild(mkBtn('← 返回', 'ghost', () => { editing = null; render(); }));

      const nameInput = h('input', { class: 'wtb-input wtb-cs-nameinput', type: 'text' });
      nameInput.placeholder = '脚本名称';
      nameInput.value = sc.name || '';
      nameInput.addEventListener('input', () => { sc.name = nameInput.value; });
      bar.appendChild(nameInput);

      bar.appendChild(mkBtn('💾 保存', '', () => {
        commitEditing();
        toast('已保存到网页存储');
      }));
      bar.appendChild(mkBtn('▶ 运行', '', () => {
        commitEditing();
        runScript(sc);
      }));
      bar.appendChild(mkBtn('⬇ 导出', 'ghost', () => {
        commitEditing();
        exportOne(sc);
      }));

      if (running) {
        bar.appendChild(mkBtn('■ 停止', 'ghost danger', () => {
          abortRun = true;
          toast('将在当前步骤结束后停止');
        }));
      }

      root.appendChild(bar);

      /* 步骤列表 */
      const stepsWrap = h('div', { class: 'wtb-cs-steps' });
      if (!sc.steps.length) {
        stepsWrap.appendChild(h('div', { class: 'wtb-empty' }, '还没有操作步骤，从下面选一个加进来吧'));
      }
      sc.steps.forEach((st, i) => stepsWrap.appendChild(renderStepCard(sc, st, i)));
      root.appendChild(stepsWrap);

      /* 添加步骤 */
      const addBar = h('div', { class: 'wtb-cs-addbar' });
      Object.keys(STEP_DEFS).forEach(type => {
        const def = STEP_DEFS[type];
        const b = mkBtn(`${def.icon} ${def.label}`, 'ghost', () => {
          const st = def.make();
          st.id = uid('st');
          sc.steps.push(st);
          render();
        });
        addBar.appendChild(b);
      });
      root.appendChild(addBar);

      /* 脚本信息 */
      root.appendChild(h('div', { class: 'wtb-cs-tip' },
        `共 ${sc.steps.length} 步 · 创建于 ${fmtDate(sc.createdAt)} · 存储位置：当前站点的网页存储（localStorage）`));
    }

    /* ---------------- 列表视图 ---------------- */

    function renderList(root) {
      const bar = h('div', { class: 'wtb-cs-bar' });

      bar.appendChild(mkBtn('＋ 新建脚本', '', () => {
        editing = {
          id: uid('sc'),
          name: '新脚本 ' + (scripts.length + 1),
          desc: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          steps: []
        };
        render();
      }));

      const fileInput = h('input', { type: 'file' });
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => importFile(fileInput));

      const importBtn = mkBtn('📂 导入脚本文件', 'ghost', () => fileInput.click());
      bar.appendChild(importBtn);
      bar.appendChild(fileInput);

      bar.appendChild(mkBtn('📦 导出全部', 'ghost', exportAll));

      bar.appendChild(h('span', { class: 'wtb-cs-hint' },
        `${scripts.length} 个脚本 · 已识别 ${frameOrder.length} 个 iframe`));

      root.appendChild(bar);

      const list = h('div', { class: 'wtb-cs-list' });
      if (!scripts.length) {
        list.appendChild(h('div', { class: 'wtb-empty' }, '还没有脚本，点「新建脚本」开始吧'));
      }

      scripts.forEach(sc => {
        const card = h('div', { class: 'wtb-cs-card' });

        const head = h('div', { class: 'wtb-cs-cardhead' });
        head.appendChild(h('div', { class: 'wtb-cs-name' }, sc.name || '(未命名)'));
        head.appendChild(h('div', { class: 'wtb-cs-meta' },
          `${sc.steps.length} 步 · 更新于 ${fmtDate(sc.updatedAt)}`));
        card.appendChild(head);

        const acts = h('div', { class: 'wtb-cs-acts' });
        acts.appendChild(mkBtn('▶ 运行', '', () => runScript(sc)));
        acts.appendChild(mkBtn('✎ 编辑', 'ghost', () => {
          editing = JSON.parse(JSON.stringify(sc));
          render();
        }));
        acts.appendChild(mkBtn('⬇ 导出', 'ghost', () => exportOne(sc)));
        acts.appendChild(mkBtn('🗑 删除', 'ghost danger', () => {
          if (!W.confirm(`确定删除脚本「${sc.name}」？`)) return;
          scripts = scripts.filter(x => x.id !== sc.id);
          saveScripts();
          render();
        }));
        card.appendChild(acts);

        list.appendChild(card);
      });

      root.appendChild(list);
    }

    /* ---------------- 日志面板 ---------------- */

    function renderLog() {
      if (!logEl) return;
      logEl.textContent = '';

      if (!logLines.length) {
        logEl.appendChild(h('div', { class: 'wtb-cs-log-empty' },
          '运行日志会显示在这里'));
        return;
      }

      const frag = document.createDocumentFragment();
      logLines.forEach(l => {
        const div = h('div', { class: 'wtb-cs-logline' + (l.isErr ? ' err' : '') });
        div.textContent = `[${fmtTime(l.t)}] ${l.msg}`;
        frag.appendChild(div);
      });
      logEl.appendChild(frag);
      logEl.scrollTop = logEl.scrollHeight;
    }

    /* ---------------- 总渲染 ---------------- */

    function render() {
      if (!bodyEl) return;
      bodyEl.textContent = '';
      if (editing) renderEditor(bodyEl);
      else renderList(bodyEl);
      setBadge(scripts.length);
    }

    function commitEditing() {
      if (!editing) return;
      editing.name = String(editing.name || '未命名脚本').trim() || '未命名脚本';
      editing.updatedAt = Date.now();

      const idx = scripts.findIndex(s => s.id === editing.id);
      if (idx >= 0) scripts[idx] = JSON.parse(JSON.stringify(editing));
      else scripts.push(JSON.parse(JSON.stringify(editing)));

      saveScripts();
    }

    /* ==================================================================
     *  模块 CSS
     * ================================================================ */

    const MODULE_CSS = `
      .wtb-cs { display: flex; flex-direction: column; gap: 10px; }
      .wtb-cs-body { display: flex; flex-direction: column; gap: 10px; }

      .wtb-cs-bar {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding-bottom: 10px; border-bottom: 1px solid #2c333e;
      }
      .wtb-cs-hint { font-size: 11px; color: #6f7a8c; margin-left: auto; }
      .wtb-cs-tip  { font-size: 11px; color: #6f7a8c; line-height: 1.6; }
      .wtb-cs-nameinput { min-width: 160px; flex: 1 1 160px; }

      .wtb-cs-list { display: flex; flex-direction: column; gap: 8px; }
      .wtb-cs-card {
        border: 1px solid #2c333e; border-radius: 8px; padding: 10px;
        background: #1e242c; display: flex; flex-direction: column; gap: 8px;
      }
      .wtb-cs-cardhead { display: flex; flex-direction: column; gap: 2px; }
      .wtb-cs-name { color: #d8dde5; font-size: 13px; font-weight: 600; }
      .wtb-cs-meta { font-size: 11px; color: #6f7a8c; }
      .wtb-cs-acts { display: flex; gap: 6px; flex-wrap: wrap; }

      .wtb-input {
        background: #161b22; border: 1px solid #2c333e; border-radius: 6px;
        color: #d8dde5; padding: 5px 8px; font-size: 12px;
        outline: none; min-width: 0; box-sizing: border-box;
        font-family: inherit;
      }
      .wtb-input:focus { border-color: #3d6ea8; }
      select.wtb-input { cursor: pointer; }
      textarea.wtb-input { resize: vertical; }

      .wtb-cs-field { display: flex; align-items: center; gap: 8px; }
      .wtb-cs-flabel { flex: 0 0 92px; font-size: 11px; color: #8b94a3; text-align: right; }
      .wtb-cs-field > .wtb-input { flex: 1 1 auto; }
      .wtb-cs-field > .wtb-cs-check { flex: 1 1 auto; }
      .wtb-cs-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #aab3c0; cursor: pointer; }
      .wtb-cs-check input { cursor: pointer; }

      .wtb-cs-steps { display: flex; flex-direction: column; gap: 8px; }
      .wtb-cs-step {
        border: 1px solid #2c333e; border-radius: 8px;
        background: #1a2029; overflow: hidden;
      }
      .wtb-cs-stephead {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px; background: #222a34;
        font-size: 12px; color: #aab3c0;
      }
      .wtb-cs-stepno {
        width: 18px; height: 18px; border-radius: 50%;
        background: #2f3946; color: #c8d0dc; font-size: 10px;
        display: flex; align-items: center; justify-content: center;
      }
      .wtb-cs-steptype { font-weight: 600; }
      .wtb-cs-spacer { flex: 1; }
      .wtb-cs-mini {
        width: 20px; height: 20px; border-radius: 4px;
        background: transparent; border: 0; cursor: pointer;
        color: #8b94a3; font-size: 11px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      }
      .wtb-cs-mini:hover { background: #333d4a; color: #d8dde5; }
      .wtb-cs-mini.danger:hover { background: #3a2528; color: #ff6b6b; }

      .wtb-cs-fields { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
      .wtb-cs-code { min-height: 70px; font-family: ui-monospace, Consolas, monospace; font-size: 11px; }

      .wtb-cs-addbar { display: flex; gap: 6px; flex-wrap: wrap; }

      .wtb-cs-log {
        max-height: 160px; overflow: auto;
        border-top: 1px solid #2c333e; padding-top: 8px;
        font-family: ui-monospace, Consolas, monospace;
        font-size: 11px; line-height: 1.65; color: #8b94a3;
      }
      .wtb-cs-logline.err { color: #ff7b7b; }
      .wtb-cs-log-empty { color: #55606f; }
    `;

    /* ==================================================================
     *  模块注册
     * ================================================================ */

    bus.registerModule({
      id: 'custom-script',
      title: '自定义脚本',
      icon: '🧩',
      order: 30,

      mount(ctx) {
        ctxRef = ctx;
        ctx.addStyle(MODULE_CSS);

        const pane = ctx.pane;
        pane.innerHTML = '';

        const rootEl = h('div', { class: 'wtb-cs' });
        bodyEl = h('div', { class: 'wtb-cs-body' });
        logEl  = h('div', { class: 'wtb-cs-log' });

        rootEl.append(bodyEl, logEl);
        pane.appendChild(rootEl);

        loadScripts();
        render();
        renderLog();
      },

      unmount() {
        ctxRef = null;
        bodyEl = null;
        logEl = null;
      }
    });

    /* ---------------- 对外 API ---------------- */

    bus.customScript = {
      list: () => scripts.slice(),
      run: (idOrName) => {
        const sc = scripts.find(s => s.id === idOrName || s.name === idOrName);
        if (!sc) return false;
        runScript(sc);
        return true;
      },
      frames: () => frameOrder.slice()
    };
  }

  /* ---------------- 启动 ---------------- */

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });

})();
