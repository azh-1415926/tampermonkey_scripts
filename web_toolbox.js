// ==UserScript==
// @name         网页工具箱（拾取 / 剪贴板 / 检索 / 表格）
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  四合一：元素地址拾取 + 剪贴板历史 + 表格/列表/链接检索高亮 + 表格内容抓取。仅在顶层窗口创建面板。
// @author       you
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @all-frames   true
// ==/UserScript==

(function () {
    'use strict';

    if (window.__WTB_LOADED__) return;
    window.__WTB_LOADED__ = true;

    const MSG_TAG  = '__WTB_MSG__';
    const Z_INDEX  = 2147483647;
    const HL_Z     = 2147483646;
    const UI_ATTR  = 'data-wtb-ui';

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }

    const LOG = (...a) => { try { console.log('[WTB]', ...a); } catch (e) {} };
    const ERR = (...a) => { try { console.error('[WTB]', ...a); } catch (e) {} };

    /* ============================================================
   * 0. 通用工具
   * ============================================================ */
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
        try { if (node.closest && node.closest('[' + UI_ATTR + ']')) return true; } catch (e) {}
        try {
            const root = node.getRootNode && node.getRootNode();
            if (root && root.host && root.host.nodeType === 1 && root.host.hasAttribute(UI_ATTR)) return true;
        } catch (e) {}
        return false;
    }
    function safeCall(fn, arg, fallback) {
        try { return fn(arg); } catch (e) { return fallback; }
    }
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

    /* ============================================================
   * 1. XPath / CSS 生成
   * ============================================================ */
    function getAbsoluteXPath(el) {
        const doc = el.ownerDocument;
        if (!doc) return '';
        if (el === doc.documentElement) return '/html';
        const parts = [];
        let cur = el, guard = 0;
        while (cur && cur.nodeType === 1 && guard++ < 500) {
            if (cur === doc.documentElement) { parts.unshift('html'); break; }
            const tag = cur.tagName.toLowerCase();
            let idx = 1, sib = cur.previousElementSibling;
            while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
            parts.unshift(tag + '[' + idx + ']');
            if (cur.parentElement) cur = cur.parentElement;
            else {
                const root = cur.getRootNode && cur.getRootNode();
                cur = (root && root.host && root.host.nodeType === 1) ? root.host : null;
                if (cur) parts.unshift('#shadow-root');
            }
        }
        return '/' + parts.join('/');
    }
    function getShortXPath(el) {
        const doc = el.ownerDocument;
        const tag = el.tagName.toLowerCase();
        if (el.id) {
            try { if (doc.querySelectorAll('#' + esc(el.id)).length === 1) return '//*[@id="' + escAttr(el.id) + '"]'; } catch (e) {}
        }
        const attrs = ['name','data-testid','data-test','data-qa','data-id','aria-label','placeholder','title','alt','type','role'];
        for (const a of attrs) {
            const v = el.getAttribute && el.getAttribute(a);
            if (!v || v.length > 80) continue;
            try {
                if (doc.querySelectorAll(tag + '[' + a + '="' + escAttr(v) + '"]').length === 1)
                    return '//' + tag + '[@' + a + '="' + v.replace(/"/g, '&quot;') + '"]';
            } catch (e) {}
        }
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const textTags = ['a','button','span','label','li','td','th','h1','h2','h3','h4','h5','h6','p','strong','em','b','i'];
        if (txt && txt.length <= 30 && !/["'\[\]]/.test(txt) && textTags.indexOf(tag) > -1) {
            try {
                const xp = '//' + tag + '[normalize-space(text())="' + txt + '"]';
                if (doc.evaluate(xp, doc, null, 7, null).snapshotLength === 1) return xp;
            } catch (e) {}
        }
        return getAbsoluteXPath(el);
    }
    function buildCssPath(el, useClass) {
        const doc = el.ownerDocument;
        const parts = [];
        let cur = el, guard = 0;
        while (cur && cur.nodeType === 1 && cur !== doc.documentElement && guard++ < 500) {
            let seg = cur.tagName.toLowerCase();
            if (useClass && cur.classList && cur.classList.length) {
                const cls = [];
                for (let i = 0; i < cur.classList.length && cls.length < 2; i++) {
                    const c = cur.classList[i];
                    if (isValidIdent(c)) cls.push(esc(c));
                }
                if (cls.length) seg += '.' + cls.join('.');
            }
            const parent = cur.parentElement;
            if (parent) {
                let sameTag = 0, index = 0;
                for (let i = 0; i < parent.children.length; i++) {
                    const c = parent.children[i];
                    if (c.tagName === cur.tagName) { sameTag++; if (c === cur) index = sameTag; }
                }
                if (sameTag > 1) seg += ':nth-of-type(' + index + ')';
            }
            parts.unshift(seg);
            cur = cur.parentElement;
        }
        parts.unshift('html');
        return parts.join(' > ');
    }
    function getCssSelector(el) {
        const doc = el.ownerDocument;
        if (!doc) return '';
        if (el === doc.documentElement) return 'html';
        if (el.id) {
            try { const sel = '#' + esc(el.id); if (doc.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
        }
        const attrs = ['data-testid','data-test','data-qa','data-id','name','aria-label','title','alt','placeholder','role','type'];
        for (const a of attrs) {
            const v = el.getAttribute && el.getAttribute(a);
            if (!v || v.length > 60) continue;
            try {
                const sel = el.tagName.toLowerCase() + '[' + a + '="' + escAttr(v) + '"]';
                if (doc.querySelectorAll(sel).length === 1) return sel;
            } catch (e) {}
        }
        const withClass = buildCssPath(el, true);
        const noClass   = buildCssPath(el, false);
        try { if (doc.querySelectorAll(withClass).length === 1) return withClass; } catch (e) {}
        try { if (doc.querySelectorAll(noClass).length === 1) return noClass; } catch (e) {}
        return withClass;
    }
    function getStrictCssSelector(el) {
        const doc = el.ownerDocument;
        if (!doc) return '';
        if (el === doc.documentElement) return 'html';
        const parts = [];
        let cur = el, guard = 0;
        while (cur && cur.nodeType === 1 && cur !== doc.documentElement && guard++ < 500) {
            let seg = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
                const same = [];
                for (let i = 0; i < parent.children.length; i++) {
                    if (parent.children[i].tagName === cur.tagName) same.push(parent.children[i]);
                }
                if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
            }
            parts.unshift(seg);
            cur = cur.parentElement;
        }
        parts.unshift('html');
        return parts.join(' > ');
    }

    /* ============================================================
   * 2. iframe 链 / 信息采集
   * ============================================================ */
    function getFrameChain(win) {
        const chain = [];
        let w = win, depth = 0;
        while (w && depth++ < 20) {
            let isTop = false;
            try { isTop = (w === w.top); } catch (e) { isTop = true; }
            if (isTop) break;
            let fe = null;
            try { fe = w.frameElement; } catch (e) { fe = null; }
            let url = '';
            try { url = w.location.href; } catch (e) { url = '(跨域，无法读取)'; }
            if (fe) {
                chain.unshift({
                    tag: fe.tagName.toLowerCase(),
                    name: fe.getAttribute('name') || '',
                    id: fe.id || '',
                    src: fe.getAttribute('src') || '',
                    selector: safeCall(getCssSelector, fe, ''),
                    xpath: safeCall(getAbsoluteXPath, fe, ''),
                    url: url
                });
            } else {
                chain.unshift({ tag: 'iframe', name: '', id: '', src: '', selector: '(跨域，无法读取父级 frameElement)', xpath: '', url: url });
            }
            let parent = null;
            try { parent = w.parent; } catch (e) { parent = null; }
            if (!parent || parent === w) break;
            w = parent;
        }
        return chain;
    }

    function collectInfo(el) {
        const doc = el.ownerDocument;
        const win = doc.defaultView || window;
        let rect = { x: 0, y: 0, width: 0, height: 0 };
        try { rect = el.getBoundingClientRect(); } catch (e) {}
        let value = '';
        try {
            if ('value' in el && typeof el.value === 'string' && el.type !== 'password') value = el.value.slice(0, 200);
        } catch (e) {}
        let cls = '';
        try {
            cls = (typeof el.className === 'string') ? el.className : (el.getAttribute ? (el.getAttribute('class') || '') : '');
        } catch (e) {}
        let text = '';
        try { text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120); } catch (e) {}
        let outerHTML = '';
        try { outerHTML = el.outerHTML ? String(el.outerHTML).slice(0, 600) : ''; } catch (e) {}
        let url = '', origin = '', host = '', hostname = '', protocol = '', pathname = '', search = '', hash = '';
        try {
            url = win.location.href; origin = win.location.origin; host = win.location.host;
            hostname = win.location.hostname; protocol = win.location.protocol;
            pathname = win.location.pathname; search = win.location.search; hash = win.location.hash;
        } catch (e) {}
        return {
            tag: el.tagName.toLowerCase(), id: el.id || '', className: cls,
            name: (el.getAttribute && el.getAttribute('name')) || '',
            type: (el.getAttribute && el.getAttribute('type')) || '',
            role: (el.getAttribute && el.getAttribute('role')) || '',
            text, value,
            placeholder: (el.getAttribute && el.getAttribute('placeholder')) || '',
            href: (el.getAttribute && el.getAttribute('href')) || '',
            src:  (el.getAttribute && el.getAttribute('src'))  || '',
            xpath:     safeCall(getAbsoluteXPath, el, ''),
            xpathShort:safeCall(getShortXPath, el, ''),
            css:       safeCall(getCssSelector, el, ''),
            cssStrict: safeCall(getStrictCssSelector, el, ''),
            url, origin, host, hostname, protocol, pathname, search, hash,
            docTitle: doc.title || '', docUrl: doc.URL || '', baseURI: doc.baseURI || '',
            charset: doc.characterSet || '', referrer: doc.referrer || '',
            readyState: doc.readyState || '', isTopFrame: IS_TOP,
            frameChain: getFrameChain(win),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            outerHTML
        };
    }

    /* ============================================================
   * 3. 拾取高亮
   * ============================================================ */
    let hlBox = null, hlTip = null;

    function ensureHighlightLayer() {
        if (hlBox && hlBox.isConnected) return;
        hlBox = document.createElement('div');
        hlBox.setAttribute(UI_ATTR, '1');
        hlBox.style.cssText = [
            'position:fixed','left:0','top:0','width:0','height:0',
            'z-index:' + HL_Z,'pointer-events:none','display:none',
            'border:2px solid #2b6cff','background:rgba(43,108,255,.16)',
            'border-radius:3px','box-sizing:border-box',
            'box-shadow:0 0 0 1px rgba(255,255,255,.55) inset'
        ].join(';');
        (document.body || document.documentElement).appendChild(hlBox);
    }
    function ensureTipLayer() {
        if (hlTip && hlTip.isConnected) return;
        hlTip = document.createElement('div');
        hlTip.setAttribute(UI_ATTR, '1');
        hlTip.style.cssText = [
            'position:fixed','left:0','top:0',
            'z-index:' + (HL_Z + 1),'pointer-events:none','display:none',
            'background:#1e2229','color:#7fd3ff',
            'font:12px/1.5 Consolas,Monaco,"Courier New",monospace',
            'padding:3px 8px','border-radius:4px','border:1px solid #2b6cff',
            'max-width:60vw','white-space:nowrap','overflow:hidden','text-overflow:ellipsis',
            'box-shadow:0 3px 12px rgba(0,0,0,.4)'
        ].join(';');
        (document.body || document.documentElement).appendChild(hlTip);
    }
    function describeEl(el) {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.classList && el.classList.length) {
            const c = [];
            for (let i = 0; i < el.classList.length && c.length < 3; i++) c.push(el.classList[i]);
            if (c.length) s += '.' + c.join('.');
        }
        return s;
    }
    function showHighlight(el, ev) {
        ensureHighlightLayer(); ensureTipLayer();
        let r; try { r = el.getBoundingClientRect(); } catch (e) { return; }
        hlBox.style.display = 'block';
        hlBox.style.left   = r.left + 'px';
        hlBox.style.top    = r.top + 'px';
        hlBox.style.width  = r.width + 'px';
        hlBox.style.height = r.height + 'px';
        hlTip.textContent = describeEl(el);
        hlTip.style.display = 'block';
        const cx = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
        const cy = ev && typeof ev.clientY === 'number' ? ev.clientY : 0;
        hlTip.style.left = Math.min(cx + 14, window.innerWidth - 12) + 'px';
        hlTip.style.top  = Math.min(cy + 18, window.innerHeight - 12) + 'px';
    }
    function hideHighlight() {
        if (hlBox) hlBox.style.display = 'none';
        if (hlTip) hlTip.style.display = 'none';
    }

    /* ============================================================
   * 4. 拾取事件 + 跨 frame 通信
   * ============================================================ */
    const BLOCK_EVENTS = ['mousedown','mouseup','click','dblclick','pointerdown','pointerup','contextmenu'];
    let pickEnabled = false;
    let pickAttached = false;
    let stopTablePickFn = null;

    function stopEvt(e) {
        try { e.preventDefault(); } catch (err) {}
        try { e.stopPropagation(); } catch (err) {}
        try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (err) {}
    }
    function onMouseMove(e) {
        if (!pickEnabled) return;
        const el = e.target;
        if (!el || el.nodeType !== 1 || isOwnUI(el)) { hideHighlight(); return; }
        showHighlight(el, e);
    }
    function onBlock(e) {
        if (!pickEnabled) return;
        const el = e.target;
        if (!el || el.nodeType !== 1 || isOwnUI(el)) return;
        stopEvt(e);
        if (e.type === 'click') pickElement(el, e);
    }
    function onKeyDown(e) {
        if (!pickEnabled) return;
        if (e.key === 'Escape') {
            if (IS_TOP) setPickEnabled(false);
            else {
                try { window.top.postMessage({ [MSG_TAG]: true, type: 'escape' }, '*'); } catch (err) {}
                pickEnabled = false; detachPick(); hideHighlight();
            }
        }
    }
    function pickElement(el, ev) {
        const info = collectInfo(el);
        reportResult(info);
        showHighlight(el, ev);
    }
    function attachPick() {
        if (pickAttached) return;
        pickAttached = true;
        document.addEventListener('mousemove', onMouseMove, true);
        for (const ev of BLOCK_EVENTS) document.addEventListener(ev, onBlock, true);
        window.addEventListener('keydown', onKeyDown, true);
    }
    function detachPick() {
        if (!pickAttached) return;
        pickAttached = false;
        document.removeEventListener('mousemove', onMouseMove, true);
        for (const ev of BLOCK_EVENTS) document.removeEventListener(ev, onBlock, true);
        window.removeEventListener('keydown', onKeyDown, true);
    }
    function broadcastToChildren(msg) {
        let frames;
        try { frames = window.frames; } catch (e) { return; }
        for (let i = 0; i < frames.length; i++) {
            try { frames[i].postMessage(msg, '*'); } catch (e) {}
        }
    }
    function reportResult(info) {
        if (IS_TOP) { renderPickResult(info); return; }
        try { window.top.postMessage({ [MSG_TAG]: true, type: 'result', payload: info }, '*'); }
        catch (e) { LOG('无法发送到顶层窗口', info); }
    }
    function setPickEnabled(v, fromParent) {
        if (v && typeof stopTablePickFn === 'function') { try { stopTablePickFn(); } catch (e) {} }
        pickEnabled = !!v;
        if (IS_TOP) updatePickButton();
        if (pickEnabled) attachPick();
        else { detachPick(); hideHighlight(); }
        if (!fromParent) broadcastToChildren({ [MSG_TAG]: true, type: 'toggle', enabled: pickEnabled });
    }

    window.addEventListener('message', function (e) {
        const d = e.data;
        if (!d || typeof d !== 'object' || d[MSG_TAG] !== true) return;
        if (d.type === 'toggle') {
            setPickEnabled(d.enabled, true);
            broadcastToChildren(d);
        } else if (d.type === 'result') {
            if (IS_TOP) renderPickResult(d.payload);
            else { try { window.top.postMessage(d, '*'); } catch (err) {} }
        } else if (d.type === 'escape') {
            if (IS_TOP) setPickEnabled(false);
        }
    }, false);

    /* ============================================================
   * 5. 顶层 UI
   * ============================================================ */
    let uiHost = null, uiShadow = null;
    let fabEl = null, panelEl = null, badgeEl = null, pickBtn = null;

    // 关键修复：用 querySelector 替代 getElementById，兼容所有浏览器
    function $id(id) {
        if (!uiShadow) return null;
        try { return uiShadow.querySelector('#' + id); } catch (e) { return null; }
    }

    function updatePickButton() {
        if (!pickBtn) return;
        pickBtn.textContent = pickEnabled ? '停止拾取' : '开始拾取';
        pickBtn.classList.toggle('on', pickEnabled);
    }

    const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }

    .fab {
      position: fixed; right: 18px; bottom: 18px;
      width: 46px; height: 46px; border-radius: 50%;
      background: #2b6cff; color: #fff;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none; font-size: 22px;
      box-shadow: 0 4px 14px rgba(0,0,0,.3);
      transition: transform .15s, background .15s;
      z-index: ${Z_INDEX};
    }
    .fab:hover { transform: scale(1.08); }
    .fab .badge {
      position: absolute; top: -3px; right: -3px;
      min-width: 18px; height: 18px; padding: 0 4px;
      border-radius: 9px; background: #ff4d4f; color: #fff;
      font-size: 10px; line-height: 18px; text-align: center;
      display: none;
    }
    .fab .badge.show { display: block; }

    .panel {
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
    .panel[hidden] { display: none !important; }

    .panel-head {
      display: flex; align-items: center; justify-content: space-between;
      background: #262c36; border-bottom: 1px solid #333a45;
      flex: 0 0 auto;
    }
    .tabs { display: flex; flex-wrap: wrap; }
    .tab {
      background: transparent; border: 0; color: #8b94a3;
      padding: 10px 12px; cursor: pointer; font-size: 12px;
      font-family: inherit; border-bottom: 2px solid transparent;
    }
    .tab:hover { color: #d8dde5; }
    .tab.active { color: #fff; border-bottom-color: #2b6cff; }
    .close-btn {
      background: transparent; border: 0; color: #8b94a3;
      font-size: 16px; cursor: pointer; padding: 4px 10px; line-height: 1;
    }
    .close-btn:hover { color: #fff; }

    .panel-body { flex: 1 1 auto; overflow: hidden; position: relative; }
    .pane {
      display: none; height: 100%; overflow-y: auto;
      padding: 12px;
    }
    .pane.active { display: block; }
    .pane::-webkit-scrollbar { width: 8px; }
    .pane::-webkit-scrollbar-thumb { background: #3d4552; border-radius: 4px; }

    .sec { margin-bottom: 14px; }
    .sec:last-child { margin-bottom: 0; }
    .sec-title {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      color: #6f7a8c; text-transform: uppercase;
      margin-bottom: 6px; padding-bottom: 4px;
      border-bottom: 1px dashed #333a45;
    }
    .kv { display: flex; gap: 8px; padding: 2px 0; }
    .kv .k { flex: 0 0 76px; color: #8b94a3; }
    .kv .v { flex: 1 1 auto; color: #d8dde5; word-break: break-all; }
    .kv .v.mono { font-family: Consolas, Monaco, monospace; color: #7fd3ff; }

    .code-row {
      display: flex; align-items: flex-start; gap: 6px;
      background: #161a20; border: 1px solid #2c333e;
      border-radius: 6px; padding: 7px 8px; margin-top: 6px;
    }
    .code-row .code-label {
      flex: 0 0 auto; color: #6f7a8c; font-size: 11px;
      padding-top: 2px; white-space: nowrap;
    }
    .code-row .code-val {
      flex: 1 1 auto; font-family: Consolas, Monaco, monospace;
      font-size: 11.5px; color: #7fd3ff; word-break: break-all;
      white-space: pre-wrap; user-select: text; padding-top: 2px;
    }
    .code-row .copy-btn {
      flex: 0 0 auto; background: #2b6cff; color: #fff;
      border: 0; border-radius: 4px; padding: 3px 9px;
      font-size: 11px; cursor: pointer; white-space: nowrap;
    }
    .code-row .copy-btn:hover { background: #4680ff; }
    .code-row .copy-btn.done { background: #16a34a; }

    .btn {
      background: #2b6cff; color: #fff; border: 0;
      border-radius: 5px; padding: 5px 12px;
      font-size: 12px; cursor: pointer; font-family: inherit;
    }
    .btn:hover { background: #4680ff; }
    .btn.ghost { background: #2c333e; color: #cfd6e4; }
    .btn.ghost:hover { background: #3a4352; }
    .btn.on { background: #16a34a; }
    .btn.on:hover { background: #1db954; }

    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .row:last-child { margin-bottom: 0; }

    input[type="text"], select, textarea {
      background: #161a20; color: #e6e8eb;
      border: 1px solid #333a45; border-radius: 5px;
      padding: 4px 8px; font-size: 12px; outline: none;
      font-family: inherit;
    }
    input[type="text"]:focus, select:focus, textarea:focus { border-color: #2b6cff; }
    input[type="text"] { flex: 1 1 100px; min-width: 0; }

    .pick-toggle-bar {
      display: flex; align-items: center; gap: 10px;
      padding-bottom: 12px; border-bottom: 1px dashed #333a45;
      margin-bottom: 12px;
    }
    .hint { color: #6f7a8c; font-size: 11px; }

    .clip-bar {
      display: flex; align-items: center; gap: 8px;
      padding-bottom: 10px; border-bottom: 1px solid #2c333e;
      margin-bottom: 6px;
    }
    .switch { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; color: #cfd6e4; }
    .switch input { display: none; }
    .switch .track {
      width: 30px; height: 17px; border-radius: 9px; background: #4a5262;
      position: relative; transition: background .18s; flex: 0 0 auto;
    }
    .switch .track::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 13px; height: 13px; border-radius: 50%; background: #fff;
      transition: transform .18s;
    }
    .switch input:checked + .track { background: #2b6cff; }
    .switch input:checked + .track::after { transform: translateX(13px); }

    .clip-list { min-height: 60px; }
    .clip-item {
      position: relative; padding: 8px 10px;
      border-bottom: 1px solid #2c333e; cursor: pointer;
    }
    .clip-item:hover { background: #262c36; }
    .clip-item .txt {
      padding-right: 20px; color: #d8dde5; line-height: 1.45;
      white-space: pre-wrap; word-break: break-all;
      max-height: 60px; overflow: hidden;
    }
    .clip-item .meta {
      margin-top: 4px; display: flex; justify-content: space-between;
      font-size: 10px; color: #6f7a8c;
    }
    .clip-item .del {
      position: absolute; top: 5px; right: 5px;
      width: 18px; height: 18px; border-radius: 4px;
      display: none; align-items: center; justify-content: center;
      font-size: 10px; color: #8b94a3;
      background: transparent; border: 0; cursor: pointer;
    }
    .clip-item:hover .del { display: flex; }
    .clip-item .del:hover { background: #3a2528; color: #ff6b6b; }

    .empty { color: #6f7a8c; font-style: italic; padding: 30px 0; text-align: center; }

    .find-status { font-size: 12px; color: #9aa6bb; margin-top: 8px; word-break: break-all; }
    .find-status b { color: #ffd166; font-weight: 600; }

    .tbl-textarea {
      width: 100%; min-height: 150px; max-height: 320px;
      resize: vertical; padding: 8px;
      background: #12151d; color: #dfe4ec;
      border: 1px solid #333a45; border-radius: 6px;
      font: 12px/1.6 Consolas, Monaco, monospace;
      white-space: pre; overflow: auto;
    }
    .status-line { font-size: 12px; color: #7dd3a0; min-height: 16px; margin-top: 8px; }
    .status-line.err { color: #f87171; }

    .frame-item {
      background: #161a20; border-left: 3px solid #2b6cff;
      border-radius: 4px; padding: 6px 8px; margin-top: 6px;
    }
    .frame-item .fi-hd {
      color: #7fd3ff; font-family: Consolas, Monaco, monospace;
      font-size: 11.5px; margin-bottom: 3px; word-break: break-all;
    }
    .frame-item .fi-row { font-size: 11.5px; color: #9aa4b2; word-break: break-all; }
    .frame-item .fi-row b { color: #8b94a3; font-weight: 500; }
  `;

    const UI_HTML = `
    <div class="fab" id="wtb-fab" title="网页工具箱（Alt+Shift+S 拾取）">🧰<span class="badge" id="wtb-badge"></span></div>
    <div class="panel" id="wtb-panel" hidden>
      <div class="panel-head">
        <div class="tabs">
          <button class="tab active" data-tab="pick">🎯 拾取</button>
          <button class="tab" data-tab="clip">📋 剪贴板</button>
          <button class="tab" data-tab="find">🔍 检索</button>
          <button class="tab" data-tab="table">📊 表格</button>
        </div>
        <button class="close-btn" id="wtb-close" title="收起">✕</button>
      </div>
      <div class="panel-body">
        <div class="pane active" data-pane="pick">
          <div class="pick-toggle-bar">
            <button class="btn" id="pickToggle">开始拾取</button>
            <span class="hint">Alt+Shift+S 快捷切换 · Esc 取消</span>
          </div>
          <div id="pickResult"></div>
        </div>

        <div class="pane" data-pane="clip">
          <div class="clip-bar">
            <label class="switch" title="开启后页面内每次复制都会自动记录">
              <input type="checkbox" id="clipAuto" checked>
              <span class="track"></span>
              <span>自动记录</span>
            </label>
            <button class="btn ghost" id="clipRead">读取剪贴板</button>
            <button class="btn ghost" id="clipClear" style="margin-left:auto">清空</button>
          </div>
          <div class="clip-list" id="clipList"></div>
          <div class="status-line" id="clipStatus"></div>
        </div>

        <div class="pane" data-pane="find">
          <div class="row">
            <select id="findSel" style="flex:1"></select>
            <button class="btn ghost" id="findRescan" title="重新扫描">⟳</button>
          </div>
          <div class="row">
            <input type="text" id="findInput" placeholder="输入要检索的文本，回车切换下一项">
          </div>
          <div class="row">
            <button class="btn ghost" id="findPrev" style="flex:1">↑ 上一个</button>
            <button class="btn ghost" id="findNext" style="flex:1">↓ 下一个</button>
          </div>
          <div class="row">
            <label class="switch"><input type="checkbox" id="findOnlyA" checked><span class="track"></span><span>div 容器仅检索链接文本</span></label>
          </div>
          <div class="find-status" id="findStatus">初始化中…</div>
        </div>

        <div class="pane" data-pane="table">
          <div class="row">
            <button class="btn" id="tblPick">① 选择表格</button>
            <button class="btn" id="tblGrab">② 抓取内容</button>
            <span class="hint" id="tblInfo">未选择</span>
          </div>
          <div class="row">
            <label class="hint">抓取方式</label>
            <select id="tblMode">
              <option value="row">按行合并（每行一项）</option>
              <option value="col">按列合并（每列一项）</option>
            </select>
          </div>
          <div class="row">
            <label class="hint">分隔符</label>
            <input type="text" id="tblSep" value=" | " title="支持输入 \\n \\t 转义">
          </div>
          <div class="row" id="tblColRow" hidden>
            <label class="hint">列号</label>
            <input type="text" id="tblColRange" placeholder="如 1,3,5-7；留空全部">
          </div>
          <div class="row">
            <label class="hint">排序</label>
            <select id="tblSort">
              <option value="asc">文本升序</option>
              <option value="desc">文本降序</option>
              <option value="len">按长度升序</option>
              <option value="num">按数字大小</option>
            </select>
            <button class="btn ghost" id="tblSortBtn">应用</button>
          </div>
          <div class="row">
            <label class="hint">序号</label>
            <input type="text" id="tblRange" placeholder="如 1-10,15,20-">
            <button class="btn ghost" id="tblKeep">保留</button>
            <button class="btn ghost" id="tblDel">剔除</button>
          </div>
          <div class="row">
            <label class="hint">关键词</label>
            <input type="text" id="tblKw" placeholder="逗号分隔">
            <button class="btn ghost" id="tblKwBtn">剔除</button>
          </div>
          <div class="row">
            <label class="switch"><input type="checkbox" id="tblSkipEmpty" checked><span class="track"></span><span>忽略空行</span></label>
            <label class="switch"><input type="checkbox" id="tblTrim" checked><span class="track"></span><span>去首尾空白</span></label>
            <span class="hint" id="tblCount" style="margin-left:auto">0 项</span>
          </div>
          <textarea class="tbl-textarea" id="tblOut" spellcheck="false" placeholder="抓取到的内容会显示在这里，每行一项，可直接编辑"></textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn" id="tblCopy">复制全部</button>
            <button class="btn ghost" id="tblUndo">撤销</button>
            <button class="btn ghost" id="tblDedup">去重</button>
            <button class="btn ghost" id="tblClear">清空</button>
          </div>
          <div class="status-line" id="tblStatus"></div>
        </div>
      </div>
    </div>
  `;

    function buildUI() {
        if (uiHost) return;
        uiHost = document.createElement('div');
        uiHost.setAttribute(UI_ATTR, '1');
        document.documentElement.appendChild(uiHost);
        uiShadow = uiHost.attachShadow({ mode: 'open' });
        uiShadow.innerHTML = '<style>' + UI_CSS + '</style>' + UI_HTML;

        fabEl   = $id('wtb-fab');
        panelEl = $id('wtb-panel');
        badgeEl = $id('wtb-badge');
        pickBtn = $id('pickToggle');

        if (!fabEl || !panelEl) {
            ERR('UI 构建失败：找不到 fab 或 panel');
            return;
        }

        fabEl.addEventListener('click', () => { panelEl.hidden = !panelEl.hidden; });
        const closeBtn = $id('wtb-close');
        if (closeBtn) closeBtn.addEventListener('click', () => { panelEl.hidden = true; });

        const tabs = uiShadow.querySelectorAll('.tab');
        const panes = uiShadow.querySelectorAll('.pane');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const name = tab.getAttribute('data-tab');
                tabs.forEach(t => t.classList.toggle('active', t === tab));
                panes.forEach(p => p.classList.toggle('active', p.getAttribute('data-pane') === name));
                try {
                    if (name === 'clip') WTB_clip.refresh();
                    if (name === 'find' && WTB_find.isDirty()) WTB_find.rescan(true);
                } catch (e) { ERR('切换 tab 失败', e); }
            });
        });

        if (pickBtn) pickBtn.addEventListener('click', () => setPickEnabled(!pickEnabled));
        updatePickButton();
    }

    /* ============================================================
   * 6. 拾取结果渲染
   * ============================================================ */
    function kv(k, v, cls) {
        return h('div', { class: 'kv' }, [
            h('div', { class: 'k', text: k }),
            h('div', { class: 'v' + (cls ? ' ' + cls : ''), text: v == null || v === '' ? '—' : String(v) })
        ]);
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
                if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); done(); return; }
            } catch (e) {}
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
    function codeRow(label, value) {
        const btn = h('button', { class: 'copy-btn' }, '复制');
        btn.addEventListener('click', () => copyText(value, btn));
        return h('div', { class: 'code-row' }, [
            h('div', { class: 'code-label', text: label }),
            h('code', { class: 'code-val', text: value || '—' }),
            btn
        ]);
    }
    function section(title, children) {
        return h('div', { class: 'sec' }, [
            h('div', { class: 'sec-title', text: title }),
            ...children
        ]);
    }

    function renderPickResult(info) {
        if (!uiShadow) return;
        const host = $id('pickResult');
        if (!host) return;

        const activeTab = uiShadow.querySelector('.tab.active');
        if (activeTab && activeTab.getAttribute('data-tab') !== 'pick') {
            uiShadow.querySelectorAll('.tab').forEach(t =>
                                                      t.classList.toggle('active', t.getAttribute('data-tab') === 'pick'));
            uiShadow.querySelectorAll('.pane').forEach(p =>
                                                       p.classList.toggle('active', p.getAttribute('data-pane') === 'pick'));
        }

        host.innerHTML = '';

        const elRows = [
            kv('标签', info.tag, 'mono'),
            kv('id', info.id, 'mono'),
            kv('class', info.className, 'mono'),
            kv('name', info.name, 'mono'),
            kv('type', info.type, 'mono'),
            kv('role', info.role, 'mono'),
            kv('文本', info.text),
            kv('值', info.value),
            kv('尺寸', info.rect.width + ' × ' + info.rect.height + '  (x:' + info.rect.x + ', y:' + info.rect.y + ')')
        ];
        if (info.placeholder) elRows.splice(6, 0, kv('placeholder', info.placeholder));
        if (info.href) elRows.push(kv('href', info.href, 'mono'));
        if (info.src)  elRows.push(kv('src',  info.src,  'mono'));
        host.appendChild(section('元素', elRows));

        host.appendChild(section('所在文档 / 域', [
            kv('页面 URL', info.url, 'mono'),
            kv('Origin', info.origin, 'mono'),
            kv('Host', info.host, 'mono'),
            kv('域名', info.hostname, 'mono'),
            kv('协议', info.protocol, 'mono'),
            kv('路径', info.pathname, 'mono'),
            kv('查询串', info.search, 'mono'),
            kv('Hash', info.hash, 'mono'),
            kv('document.title', info.docTitle),
            kv('document.URL', info.docUrl, 'mono'),
            kv('baseURI', info.baseURI, 'mono'),
            kv('charset', info.charset, 'mono'),
            kv('referrer', info.referrer, 'mono'),
            kv('readyState', info.readyState, 'mono'),
            kv('是否顶层窗口', info.isTopFrame ? '是' : '否（位于 iframe 内）')
        ]));

        const frameChildren = [];
        if (info.frameChain && info.frameChain.length) {
            info.frameChain.forEach((f, i) => {
                frameChildren.push(h('div', { class: 'frame-item' }, [
                    h('div', { class: 'fi-hd' }, '[' + (i + 1) + '] <' + f.tag + '>' +
                      (f.id ? ' #' + f.id : '') + (f.name ? ' [name=' + f.name + ']' : '')),
                    h('div', { class: 'fi-row' }, [h('b', {}, 'src: '), f.src || '—']),
                    h('div', { class: 'fi-row' }, [h('b', {}, 'url: '), f.url || '—']),
                    h('div', { class: 'fi-row' }, [h('b', {}, 'css: '), f.selector || '—']),
                    h('div', { class: 'fi-row' }, [h('b', {}, 'xpath: '), f.xpath || '—'])
                ]));
            });
        } else {
            frameChildren.push(h('div', { class: 'empty' }, '该元素位于顶层 document，无 iframe 嵌套。'));
        }
        host.appendChild(section('所在 iframe 链（由外到内）', frameChildren));

        host.appendChild(section('XPath', [
            codeRow('绝对', info.xpath),
            codeRow('优化', info.xpathShort)
        ]));
        host.appendChild(section('CSS Selector', [
            codeRow('唯一', info.css),
            codeRow('严格', info.cssStrict)
        ]));
        host.appendChild(section('其它', [
            codeRow('outerHTML', info.outerHTML)
        ]));

        const allText = [
            'URL: ' + info.url,
            'Origin: ' + info.origin,
            'Host: ' + info.host,
            'iframe 链: ' + ((info.frameChain || []).map(f => f.selector).join(' -> ') || '（顶层）'),
            'XPath: ' + info.xpath,
            'XPath(优化): ' + info.xpathShort,
            'CSS: ' + info.css,
            'CSS(严格): ' + info.cssStrict
        ].join('\n');

        const allBtn = h('button', { class: 'btn' }, '复制全部定位信息');
        allBtn.style.cssText = 'width:100%;padding:7px;margin-top:10px;font-size:12px;';
        allBtn.addEventListener('click', () => copyText(allText, allBtn));
        host.appendChild(allBtn);
    }

    /* ============================================================
   * 7. 剪贴板历史模块
   * ============================================================ */
    const WTB_clip = (function () {
        const MAX_ITEMS = 300;
        const PREVIEW_LEN = 140;
        let autoRecord = true;
        let items = [];
        let seq = 0;
        let suppressCopy = false;
        let started = false;

        function fmtTime(t) {
            const d = new Date(t);
            const p = n => String(n).padStart(2, '0');
            return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        }

        function toast(msg, err) {
            const el = $id('clipStatus');
            if (!el) return;
            el.textContent = msg;
            el.classList.toggle('err', !!err);
            setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
        }

        function refresh() {
            const listEl = $id('clipList');
            if (!listEl) return;
            const count = items.length;

            if (badgeEl) {
                if (count > 0) {
                    badgeEl.textContent = count > 99 ? '99+' : String(count);
                    badgeEl.classList.add('show');
                } else {
                    badgeEl.classList.remove('show');
                }
            }

            listEl.textContent = '';
            if (!items.length) {
                const empty = h('div', { class: 'empty' },
                                autoRecord ? '在页面里复制点东西试试～' : '点击「读取剪贴板」添加一条');
                listEl.appendChild(empty);
                return;
            }

            const frag = document.createDocumentFragment();
            for (const it of items) {
                const item = h('div', { class: 'clip-item' });
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
            pulse();
        }

        function pulse() {
            try {
                if (fabEl && fabEl.animate) {
                    fabEl.animate(
                        [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }],
                        { duration: 320, easing: 'ease-out' }
                    );
                }
            } catch (_) {}
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

        function start() {
            if (started) return;
            started = true;
            const auto = $id('clipAuto');
            const readBtn = $id('clipRead');
            const clearBtn = $id('clipClear');
            if (auto) {
                auto.checked = autoRecord;
                auto.addEventListener('change', () => {
                    autoRecord = auto.checked;
                    toast(autoRecord ? '已开启自动记录' : '已关闭自动记录，请手动添加');
                    refresh();
                });
            }
            if (readBtn) readBtn.addEventListener('click', readClipboard);
            if (clearBtn) clearBtn.addEventListener('click', () => {
                if (!items.length) { toast('已经是空的了'); return; }
                items = [];
                refresh();
                toast('已清空');
            });
            document.addEventListener('copy', onCopy, true);
            refresh();
        }

        return { start, refresh, addItem };
    })();

    /* ============================================================
   * 8. 文本检索高亮模块
   * ============================================================ */
    const WTB_find = (function () {
        const MARK_CLASS   = 'wtb-mark';
        const ACTIVE_CLASS = 'wtb-active';
        const STRUCT_SEL = [
            'table', 'ul', 'ol', 'dl',
            '[role="table"]', '[role="grid"]',
            '[role="list"]', '[role="listbox"]',
            '[role="tree"]', '[role="menu"]'
        ].join(',');
        const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','TEMPLATE','SVG','CANVAS']);
        const MAX_MARKS = 3000;
        const DEBOUNCE  = 180;
        const MAX_DIV_TEXT = 8000;

        let containers = [];
        let activeContainer = null;
        let marks = [];
        let currentIndex = -1;
        let searchTimer = null;
        let dirty = true;
        let started = false;

        function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

        function byDocOrder(a, b) {
            if (a.el === b.el) return 0;
            if (!a.el) return 1;
            if (!b.el) return -1;
            const pos = a.el.compareDocumentPosition(b.el);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        }

        function updateStatus() {
            const el = $id('findStatus');
            if (!el) return;
            if (!containers.length) { el.textContent = '未找到可检索控件（表格 / 列表 / 含链接的 div）'; return; }
            if (!marks.length) {
                const input = $id('findInput');
                el.textContent = (input && input.value.trim()) ? '未找到匹配项' : '输入文本开始检索';
                return;
            }
            el.innerHTML = '匹配 <b>' + marks.length + '</b> 项 ｜ 当前第 <b>' + (currentIndex + 1) + '</b> 项';
        }

        function clearMarks() {
            document.querySelectorAll('mark.' + MARK_CLASS).forEach(m => {
                const parent = m.parentNode;
                if (!parent) return;
                parent.replaceChild(document.createTextNode(m.textContent), m);
                parent.normalize();
            });
            marks = [];
            currentIndex = -1;
        }

        function collectTextNodes(container) {
            const out = [];
            const kind = container.kind;
            const onlyACheckbox = $id('findOnlyA');
            const onlyA =
                  kind === 'all-links' ? true :
            kind === 'div-links' ? (onlyACheckbox ? onlyACheckbox.checked : true) :
            false;
            const roots = container.el
            ? [container.el]
            : Array.prototype.slice.call(document.querySelectorAll('a'));
            for (const root of roots) {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                    acceptNode(node) {
                        const val = node.nodeValue;
                        if (!val || !val.trim()) return NodeFilter.FILTER_REJECT;
                        const p = node.parentElement;
                        if (!p) return NodeFilter.FILTER_REJECT;
                        if (SKIP_TAGS.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
                        if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
                        if (p.classList && p.classList.contains(MARK_CLASS)) return NodeFilter.FILTER_REJECT;
                        if (onlyA && !p.closest('a')) return NodeFilter.FILTER_REJECT;
                        return NodeFilter.FILTER_ACCEPT;
                    }
                });
                let n;
                while ((n = walker.nextNode())) out.push(n);
            }
            return out;
        }

        function highlightNode(textNode, re) {
            const text = textNode.nodeValue;
            re.lastIndex = 0;
            if (!re.test(text)) return 0;
            re.lastIndex = 0;
            const frag = document.createDocumentFragment();
            let last = 0, count = 0, m;
            while ((m = re.exec(text)) !== null) {
                if (m[0].length === 0) { re.lastIndex++; continue; }
                if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                const mark = document.createElement('mark');
                mark.className = MARK_CLASS;
                mark.textContent = m[0];
                frag.appendChild(mark);
                last = m.index + m[0].length;
                count++;
                if (count >= MAX_MARKS) break;
            }
            if (!count) return 0;
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            textNode.parentNode.replaceChild(frag, textNode);
            return count;
        }

        function runSearch(query) {
            clearMarks();
            dirty = false;
            if (!activeContainer || !query) { updateStatus(); return; }
            let total = 0;
            try {
                const re = new RegExp(escapeRegExp(query), 'gi');
                const nodes = collectTextNodes(activeContainer);
                for (const node of nodes) {
                    total += highlightNode(node, re);
                    if (total >= MAX_MARKS) break;
                }
                if (activeContainer.el) {
                    marks = Array.prototype.slice.call(activeContainer.el.querySelectorAll('mark.' + MARK_CLASS));
                } else {
                    marks = Array.prototype.slice.call(document.querySelectorAll('mark.' + MARK_CLASS));
                }
            } catch (e) {
                const el = $id('findStatus');
                if (el) el.textContent = '检索出错：' + e.message;
                return;
            }
            if (marks.length) goTo(0);
            else updateStatus();
        }

        function goTo(index) {
            if (!marks.length) { updateStatus(); return; }
            const len = marks.length;
            currentIndex = ((index % len) + len) % len;
            marks.forEach((m, i) => {
                if (i === currentIndex) m.classList.add(ACTIVE_CLASS);
                else m.classList.remove(ACTIVE_CLASS);
            });
            const el = marks[currentIndex];
            try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); }
            catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
            updateStatus();
        }

        function labelFor(container, idx) {
            const { el, kind } = container;
            if (kind === 'all-links') {
                const n = document.querySelectorAll('a').length;
                return '所有 a 标签 (' + n + ' 个)';
            }
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role');
            const kindTag = role ? tag + '[' + role + ']' : tag;
            let meta = '';
            if (kind === 'div-links') {
                meta = el.querySelectorAll('a').length + ' 个链接';
            } else if (tag === 'table' || role === 'table' || role === 'grid') {
                const rows = el.querySelectorAll('tr').length;
                const firstRow = el.querySelector('tr');
                const cols = firstRow ? firstRow.children.length : 0;
                meta = rows + '行' + (cols ? '×' + cols + '列' : '');
                const cap = el.querySelector('caption');
                if (cap && cap.textContent.trim()) meta = cap.textContent.trim().slice(0, 12) + ' · ' + meta;
            } else {
                let n = el.querySelectorAll(':scope > li, :scope > dt, :scope > dd').length;
                if (!n) n = el.children.length;
                meta = n + '项';
            }
            const preview = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 16);
            return '#' + (idx + 1) + ' [' + kindTag + '] ' + meta + ' ' + preview;
        }

        function scanContainers() {
            const result = [];
            document.querySelectorAll(STRUCT_SEL).forEach(el => {
                if (!(el.textContent || '').trim()) return;
                if (el.parentElement && el.parentElement.closest(STRUCT_SEL)) return;
                result.push({ el, kind: 'struct', onlyAnchors: false });
            });

            const divSet = new Set();
            document.querySelectorAll('a').forEach(a => {
                let p = a.parentElement;
                while (p && p !== document.body && p !== document.documentElement) {
                    if (p.tagName === 'DIV') divSet.add(p);
                    p = p.parentElement;
                }
            });
            const divCandidates = [];
            divSet.forEach(d => {
                if (d.querySelector(STRUCT_SEL)) return;
                const txt = (d.textContent || '').trim();
                if (txt.length > MAX_DIV_TEXT) return;
                const n = d.querySelectorAll('a').length;
                const children = d.querySelectorAll(':scope > div, :scope > section, :scope > nav, :scope > article, :scope > main, :scope > aside');
                for (const c of children) {
                    if (c.querySelectorAll('a').length === n) return;
                }
                divCandidates.push({ el: d, kind: 'div-links', onlyAnchors: true });
            });
            divCandidates.sort(byDocOrder);
            divCandidates.forEach(c => result.push(c));

            if (document.querySelectorAll('a').length) {
                result.push({ el: null, kind: 'all-links', onlyAnchors: true });
            }
            return result;
        }

        function rebuildSelect(preserveActive) {
            const sel = $id('findSel');
            if (!sel) return;
            sel.innerHTML = '';
            if (!containers.length) {
                const o = document.createElement('option');
                o.textContent = '未找到可检索控件';
                sel.appendChild(o);
                sel.disabled = true;
                activeContainer = null;
                return;
            }
            sel.disabled = false;
            const groups = { struct: [], 'div-links': [], 'all-links': [] };
            containers.forEach((c, i) => (groups[c.kind] || groups.struct).push({ c, i }));
            const addGroup = (label, list) => {
                if (!list.length) return;
                const og = document.createElement('optgroup');
                og.label = label + ' (' + list.length + ')';
                list.forEach(({ c, i }) => {
                    const o = document.createElement('option');
                    o.value = String(i);
                    o.textContent = labelFor(c, i);
                    og.appendChild(o);
                });
                sel.appendChild(og);
            };
            addGroup('表格 / 列表', groups.struct);
            addGroup('链接容器 div', groups['div-links']);
            addGroup('其他', groups['all-links']);

            let idx = 0;
            if (preserveActive && activeContainer) {
                const i = containers.findIndex(c => c.el === activeContainer.el && c.kind === activeContainer.kind);
                if (i >= 0) idx = i;
            }
            sel.value = String(idx);
            activeContainer = containers[idx];
        }

        function rescan(preserve) {
            containers = scanContainers();
            rebuildSelect(preserve);
            clearMarks();
            const input = $id('findInput');
            const q = input ? input.value.trim() : '';
            if (q) runSearch(q);
            else updateStatus();
        }

        function start() {
            if (started) return;
            started = true;

            const pageStyle = document.createElement('style');
            pageStyle.textContent = `
        mark.${MARK_CLASS} {
          background-color: #ffe066 !important;
          background-image: none !important;
          color: #111 !important;
          padding: 0 1px !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 2px !important;
          box-shadow: 0 0 0 1px rgba(0,0,0,.18) !important;
          text-shadow: none !important;
          font: inherit !important;
          line-height: inherit !important;
          display: inline !important;
          position: static !important;
          vertical-align: baseline !important;
          white-space: inherit !important;
        }
        mark.${MARK_CLASS}.${ACTIVE_CLASS} {
          background-color: #ff7a00 !important;
          color: #fff !important;
          box-shadow: 0 0 0 2px #ff3b30, 0 0 8px rgba(255,59,48,.7) !important;
        }
      `;
        (document.head || document.documentElement).appendChild(pageStyle);

        const sel   = $id('findSel');
        const input = $id('findInput');
        const prev  = $id('findPrev');
        const next  = $id('findNext');
        const rescanBtn = $id('findRescan');
        const onlyA = $id('findOnlyA');

        if (!sel || !input) { ERR('find 模块缺少关键元素'); return; }

        sel.addEventListener('change', () => {
            const i = Number(sel.value);
            if (!Number.isNaN(i) && containers[i]) activeContainer = containers[i];
            const q = input.value.trim();
            if (q) runSearch(q);
            else { clearMarks(); updateStatus(); }
        });
        input.addEventListener('input', () => {
            dirty = true;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => runSearch(input.value.trim()), DEBOUNCE);
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(searchTimer);
                const q = input.value.trim();
                if (dirty || !marks.length) runSearch(q);
                else goTo(currentIndex + (e.shiftKey ? -1 : 1));
            } else if (e.key === 'Escape') {
                input.value = '';
                clearTimeout(searchTimer);
                clearMarks();
                updateStatus();
            }
        });
        if (prev) prev.addEventListener('click', () => goTo(currentIndex - 1));
        if (next) next.addEventListener('click', () => goTo(currentIndex + 1));
        if (rescanBtn) rescanBtn.addEventListener('click', () => rescan(true));
        if (onlyA) onlyA.addEventListener('change', () => {
            const q = input.value.trim();
            if (q) runSearch(q);
            else { clearMarks(); updateStatus(); }
        });

        rescan(false);
        setTimeout(() => { if (!containers.length) rescan(false); }, 1500);
    }

      return { start, rescan, isDirty: () => dirty };
  })();

    /* ============================================================
   * 9. 表格内容抓取模块
   * ============================================================ */
    const WTB_table = (function () {
        const state = { table: null, pickMode: false, hoverEl: null, undo: [] };
        let started = false;
        let statusTimer = null;
        let pickHint = null;

        function status(msg, isErr) {
            const el = $id('tblStatus');
            if (!el) return;
            el.textContent = msg || '';
            el.classList.toggle('err', !!isErr);
            clearTimeout(statusTimer);
            if (msg) statusTimer = setTimeout(() => { el.textContent = ''; }, 3500);
        }

        /* -------- 浮动提示条 -------- */
        function showPickHint(html) {
            hidePickHint();
            pickHint = document.createElement('div');
            pickHint.setAttribute(UI_ATTR, '1');
            pickHint.style.cssText = [
                'position:fixed',
                'left:50%',
                'top:18px',
                'transform:translateX(-50%)',
                'z-index:' + (HL_Z + 2),
                'background:rgba(30,34,41,.96)',
                'color:#e6e8eb',
                'padding:8px 16px',
                'border-radius:10px',
                'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
                'border:1px solid #2b6cff',
                'box-shadow:0 6px 24px rgba(0,0,0,.55)',
                'pointer-events:none',
                'user-select:none',
                'max-width:80vw',
                'white-space:nowrap',
                'overflow:hidden',
                'text-overflow:ellipsis'
            ].join(';');
            pickHint.innerHTML = html;
            (document.body || document.documentElement).appendChild(pickHint);
        }
        function hidePickHint() {
            if (pickHint && pickHint.isConnected) pickHint.remove();
            pickHint = null;
        }

        function setOutline(el, color) {
            if (!el) return;
            if (el.dataset.wtbOutline === undefined) {
                el.dataset.wtbOutline = el.style.outline || '';
            }
            el.style.outline = '2px solid ' + color;
            el.style.outlineOffset = '1px';
        }
        function clearOutline(el) {
            if (!el) return;
            el.style.outline = el.dataset.wtbOutline || '';
            el.style.outlineOffset = '';
            delete el.dataset.wtbOutline;
        }
        function isOwnNode(node) {
            return !node || node === uiHost || (node.nodeType === 1 && uiHost && uiHost.contains(node)) || isOwnUI(node);
        }

        function getSeparator() {
            const sepEl = $id('tblSep');
            if (!sepEl) return ' ';
            let s = sepEl.value;
            s = s.replace(/\\\\/g, '\u0000')
                .replace(/\\r\\n/g, '\n')
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\u0000/g, '\\');
            return s;
        }

        function getCellText(td) {
            if (!td.querySelector('table')) {
                return (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
            }
            const clone = td.cloneNode(true);
            clone.querySelectorAll('table, script, style, noscript').forEach(n => n.remove());
            const tmp = document.createElement('div');
            tmp.style.cssText = 'position:absolute;left:-99999px;top:0;width:auto;white-space:normal;';
            tmp.appendChild(clone);
            document.body.appendChild(tmp);
            const txt = clone.innerText || clone.textContent || '';
            tmp.remove();
            return txt.replace(/\s+/g, ' ').trim();
        }

        function tableInfo(tbl) {
            let rows = 0, maxCol = 0;
            tbl.querySelectorAll('tr').forEach(tr => {
                let n = 0;
                Array.prototype.forEach.call(tr.children, c => {
                    if (!/^(TD|TH)$/i.test(c.tagName)) return;
                    n += Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10) || 1);
                });
                if (n > 0) { rows++; if (n > maxCol) maxCol = n; }
            });
            return { rows, maxCol };
        }

        function buildMatrix(tbl) {
            const matrix = [];
            tbl.querySelectorAll('tr').forEach(tr => {
                const cells = [];
                Array.prototype.forEach.call(tr.children, c => {
                    if (!/^(TD|TH)$/i.test(c.tagName)) return;
                    const span = Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10) || 1);
                    const text = getCellText(c);
                    for (let i = 0; i < span; i++) cells.push(text);
                });
                if (cells.length) matrix.push(cells);
            });
            return matrix;
        }

        function parseRange(str, max) {
            const set = new Set();
            str.split(/[,，\s]+/).filter(Boolean).forEach(part => {
                const m = part.match(/^(\d+)?\s*[-~至]\s*(\d+)?$/);
                if (m && (m[1] || m[2])) {
                    let a = m[1] ? parseInt(m[1], 10) : 1;
                    let b = m[2] ? parseInt(m[2], 10) : max;
                    if (a > b) { const t = a; a = b; b = t; }
                    for (let i = a; i <= b; i++) set.add(i);
                } else if (/^\d+$/.test(part)) {
                    set.add(parseInt(part, 10));
                }
            });
            return set;
        }

        function extractItems() {
            const modeEl = $id('tblMode');
            const mode = modeEl ? modeEl.value : 'row';
            const sep  = getSeparator();
            const matrix = buildMatrix(state.table);
            if (!matrix.length) return null;
            const maxCol = matrix.reduce((m, r) => Math.max(m, r.length), 0);
            const items = [];
            if (mode === 'row') {
                matrix.forEach(cells => {
                    if (!cells.some(c => c !== '')) return;
                    items.push(cells.join(sep));
                });
            } else {
                const colRangeEl = $id('tblColRange');
                const rstr = colRangeEl ? colRangeEl.value.trim() : '';
                let colSet;
                if (!rstr) {
                    colSet = new Set();
                    for (let i = 1; i <= maxCol; i++) colSet.add(i);
                } else {
                    colSet = parseRange(rstr, maxCol);
                    if (!colSet.size) return { error: '列号格式无效，请使用如 1,3,5-7 的格式' };
                }
                const ordered = [...colSet].sort((a, b) => a - b);
                let outOfRange = 0;
                ordered.forEach(idx => {
                    if (idx < 1 || idx > maxCol) { outOfRange++; return; }
                    const vals = matrix.map(r => (r[idx - 1] || '').trim()).filter(v => v !== '');
                    if (vals.length) items.push(vals.join(sep));
                });
                if (!items.length) {
                    return { error: outOfRange ? '列号超出范围（当前共 ' + maxCol + ' 列）' : '所选列中没有内容' };
                }
            }
            return { items, maxCol };
        }

        /* -------- 选中 / 取消选择 -------- */
        function updateDeselectVisible() {
            const btn = $id('tblDeselect');
            if (!btn) return;
            btn.hidden = !state.table;
        }

        function selectTable(tbl) {
            if (state.table && state.table !== tbl) clearOutline(state.table);
            state.table = tbl;
            setOutline(tbl, '#22c55e');
            const info = tableInfo(tbl);
            const infoEl = $id('tblInfo');
            if (infoEl) infoEl.textContent = '已选：' + info.rows + ' 行 / ' + info.maxCol + ' 列';
            updateDeselectVisible();
            grab();
        }

        function deselectTable(silent) {
            if (state.table) {
                clearOutline(state.table);
                state.table = null;
            }
            const infoEl = $id('tblInfo');
            if (infoEl) infoEl.textContent = '未选择';
            updateDeselectVisible();
            if (!silent) status('已取消选择');
        }

        function getLines() {
            const out = $id('tblOut');
            if (!out) return [];
            const v = out.value;
            return v === '' ? [] : v.split('\n');
        }
        function setLines(arr) {
            const trimEl = $id('tblTrim');
            const skipEl = $id('tblSkipEmpty');
            const doTrim = trimEl ? trimEl.checked : true;
            const skipEmpty = skipEl ? skipEl.checked : true;
            let lines = arr.map(s => (doTrim ? String(s).trim() : String(s)));
            if (skipEmpty) lines = lines.filter(l => l.trim() !== '');
            const out = $id('tblOut');
            if (out) out.value = lines.join('\n');
            updateCount();
        }
        function updateCount() {
            const n = getLines().filter(l => l.trim() !== '').length;
            const el = $id('tblCount');
            if (el) el.textContent = n + ' 项';
        }
        function pushUndo() {
            const out = $id('tblOut');
            if (!out) return;
            state.undo.push(out.value);
            if (state.undo.length > 60) state.undo.shift();
        }

        function grab() {
            const t = state.table;
            if (!t) return status('请先点击「选择表格」', true);
            if (!document.contains(t)) {
                deselectTable(true);
                return status('表格已失效，请重新选择', true);
            }
            const res = extractItems();
            if (!res) return status('表格中没有可抓取的内容', true);
            if (res.error) return status(res.error, true);
            pushUndo();
            setLines(res.items);
            const n = getLines().filter(l => l.trim() !== '').length;
            const modeEl = $id('tblMode');
            const modeTip = (modeEl && modeEl.value === 'col') ? '（共 ' + res.maxCol + ' 列）' : '';
            status('已抓取 ' + n + ' 项' + modeTip);
        }

        /* -------- 选择模式 -------- */
        function startPickMode() {
            if (state.pickMode) return;
            if (pickEnabled) setPickEnabled(false);
            state.pickMode = true;
            if (panelEl) panelEl.hidden = true;
            document.documentElement.style.cursor = 'crosshair';

            // 检查页面上有多少表格
            let count = 0;
            try { count = document.querySelectorAll('table').length; } catch (e) { count = 0; }

            if (count === 0) {
                showPickHint('⚠️ 页面上没有找到 &lt;table&gt; 元素 · 按 <b style="color:#ffd166">Esc</b> 取消');
            } else {
                showPickHint('🔍 点击一个表格以选中 · 当前页面有 <b style="color:#ffd166">' + count + '</b> 个表格 · 按 <b style="color:#ffd166">Esc</b> 取消');
            }

            document.addEventListener('mousemove', onPickMove, true);
            document.addEventListener('click', onPickClick, true);
            document.addEventListener('keydown', onPickKey, true);
        }

        function stopPickMode() {
            if (!state.pickMode) return;
            state.pickMode = false;
            hidePickHint();
            document.removeEventListener('mousemove', onPickMove, true);
            document.removeEventListener('click', onPickClick, true);
            document.removeEventListener('keydown', onPickKey, true);
            document.documentElement.style.cursor = '';
            if (panelEl) panelEl.hidden = false;
            if (state.hoverEl && state.hoverEl !== state.table) clearOutline(state.hoverEl);
            state.hoverEl = null;
        }

        function onPickMove(e) {
            if (!state.pickMode) return;
            const t = e.target;
            if (isOwnNode(t) || !t || !t.closest) return;
            const tbl = t.closest('table');
            if (tbl === state.hoverEl) return;
            if (state.hoverEl && state.hoverEl !== state.table) clearOutline(state.hoverEl);
            state.hoverEl = tbl;
            if (tbl) setOutline(tbl, '#f97316');
        }

        function onPickClick(e) {
            if (!state.pickMode) return;
            const t = e.target;
            if (isOwnNode(t)) return;
            e.preventDefault();
            e.stopPropagation();
            if (!t || !t.closest) return;
            const tbl = t.closest('table');
            if (!tbl) {
                // 用户点了非表格区域 —— 刷新提示，保持模式
                let count = 0;
                try { count = document.querySelectorAll('table').length; } catch (err) { count = 0; }
                if (count === 0) {
                    showPickHint('⚠️ 页面上没有找到 &lt;table&gt; 元素 · 按 <b style="color:#ffd166">Esc</b> 取消');
                } else {
                    showPickHint('❌ 这里不是表格 · 请点击表格区域 · 按 <b style="color:#ffd166">Esc</b> 取消');
                }
                return;
            }
            stopPickMode();
            selectTable(tbl);
        }

        function onPickKey(e) {
            if (e.key === 'Escape') {
                stopPickMode();
                status('已取消选择');
            }
        }

        /* -------- 排序 / 筛选 / 去重 -------- */
        function applySort() {
            const sortEl = $id('tblSort');
            const type = sortEl ? sortEl.value : 'asc';
            let lines = getLines().filter(l => l.trim() !== '');
            if (!lines.length) return status('没有内容可排序', true);
            const cmp = (a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
            if (type === 'asc') lines.sort(cmp);
            else if (type === 'desc') lines.sort((a, b) => cmp(b, a));
            else if (type === 'len') lines.sort((a, b) => a.length - b.length || cmp(a, b));
            else if (type === 'num') {
                const toNum = s => {
                    const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
                    return m ? parseFloat(m[0]) : NaN;
                };
                lines.sort((a, b) => {
                    const x = toNum(a), y = toNum(b);
                    const xn = isNaN(x), yn = isNaN(y);
                    if (xn && yn) return cmp(a, b);
                    if (xn) return 1;
                    if (yn) return -1;
                    return x - y;
                });
            }
            pushUndo();
            setLines(lines);
            status('已排序');
        }

        function applyRange(keep) {
            const rangeEl = $id('tblRange');
            const rstr = rangeEl ? rangeEl.value.trim() : '';
            if (!rstr) return status('请输入序号范围，如 1-10,15,20-', true);
            const lines = getLines();
            if (!lines.length) return status('没有内容', true);
            const skipEl = $id('tblSkipEmpty');
            const skipEmpty = skipEl ? skipEl.checked : true;
            const rowIndexOfItem = [];
            lines.forEach((l, i) => { if (!skipEmpty || l.trim() !== '') rowIndexOfItem.push(i); });
            const set = parseRange(rstr, rowIndexOfItem.length);
            if (!set.size) return status('序号格式无效', true);
            const targets = new Set();
            set.forEach(n => {
                if (n >= 1 && n <= rowIndexOfItem.length) targets.add(rowIndexOfItem[n - 1]);
            });
            if (!targets.size) return status('该范围内没有对应项', true);
            pushUndo();
            const result = keep
            ? lines.filter((l, i) => targets.has(i))
            : lines.filter((l, i) => !targets.has(i));
            const out = $id('tblOut');
            if (out) out.value = result.join('\n');
            updateCount();
            status((keep ? '保留 ' : '剔除 ') + targets.size + ' 项');
        }

        function removeByText() {
            const kwEl = $id('tblKw');
            const raw = kwEl ? kwEl.value.trim() : '';
            if (!raw) return status('请输入要剔除的关键词', true);
            const kws = raw.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
            if (!kws.length) return status('关键词无效', true);
            const lines = getLines();
            const out = lines.filter(l => !kws.some(k => l.includes(k)));
            if (out.length === lines.length) return status('没有匹配到需要剔除的行', true);
            pushUndo();
            const outEl = $id('tblOut');
            if (outEl) outEl.value = out.join('\n');
            updateCount();
            status('已剔除 ' + (lines.length - out.length) + ' 行');
        }

        function dedup() {
            const seen = new Set();
            const out = [];
            getLines().forEach(l => {
                const key = l.trim();
                if (key === '' || seen.has(key)) return;
                seen.add(key);
                out.push(l);
            });
            pushUndo();
            const outEl = $id('tblOut');
            if (outEl) outEl.value = out.join('\n');
            updateCount();
            status('已去重');
        }

        function fallbackCopy(text, cb) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            ta.remove();
            if (ok) cb();
            else status('复制失败，请手动选中复制', true);
        }
        function copyAll() {
            const out = $id('tblOut');
            const text = out ? out.value : '';
            if (!text.trim()) return status('没有可复制的内容', true);
            const n = text.split('\n').filter(l => l.trim() !== '').length;
            const done = () => status('已复制 ' + n + ' 项到剪贴板');
            if (typeof GM_setClipboard === 'function') {
                try { GM_setClipboard(text, 'text'); done(); return; } catch (e) {}
            }
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
            } else fallbackCopy(text, done);
        }

        function syncModeUI() {
            const modeEl = $id('tblMode');
            const colRow = $id('tblColRow');
            if (!modeEl || !colRow) return;
            colRow.hidden = modeEl.value !== 'col';
        }

        function start() {
            if (started) return;
            started = true;

            const pick = $id('tblPick');
            const deselectBtn = $id('tblDeselect');
            const grabBtn = $id('tblGrab');
            const modeEl = $id('tblMode');
            const sortBtn = $id('tblSortBtn');
            const keepBtn = $id('tblKeep');
            const delBtn = $id('tblDel');
            const kwBtn = $id('tblKwBtn');
            const copyBtn = $id('tblCopy');
            const undoBtn = $id('tblUndo');
            const dedupBtn = $id('tblDedup');
            const clearBtn = $id('tblClear');
            const out = $id('tblOut');
            const skipEl = $id('tblSkipEmpty');
            const rangeEl = $id('tblRange');
            const kwEl = $id('tblKw');
            const colRangeEl = $id('tblColRange');

            if (!pick || !grabBtn || !out) { ERR('table 模块缺少关键元素'); return; }

            pick.addEventListener('click', startPickMode);
            if (deselectBtn) deselectBtn.addEventListener('click', () => deselectTable(false));
            grabBtn.addEventListener('click', grab);
            if (modeEl) modeEl.addEventListener('change', syncModeUI);
            if (sortBtn) sortBtn.addEventListener('click', applySort);
            if (keepBtn) keepBtn.addEventListener('click', () => applyRange(true));
            if (delBtn) delBtn.addEventListener('click', () => applyRange(false));
            if (kwBtn) kwBtn.addEventListener('click', removeByText);
            if (copyBtn) copyBtn.addEventListener('click', copyAll);
            if (undoBtn) undoBtn.addEventListener('click', () => {
                if (!state.undo.length) return status('没有可撤销的操作', true);
                out.value = state.undo.pop();
                updateCount();
                status('已撤销');
            });
            if (dedupBtn) dedupBtn.addEventListener('click', dedup);
            if (clearBtn) clearBtn.addEventListener('click', () => {
                pushUndo();
                out.value = '';
                updateCount();
                status('已清空');
            });
            out.addEventListener('input', updateCount);
            if (skipEl) skipEl.addEventListener('change', updateCount);

            if (rangeEl) rangeEl.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); applyRange(true); }
            });
            if (kwEl) kwEl.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); removeByText(); }
            });
            if (colRangeEl) colRangeEl.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); grab(); }
            });

            syncModeUI();
            updateCount();
            updateDeselectVisible();
        }

        stopTablePickFn = stopPickMode;

        return { start, stopPickMode };
    })();

    /* ============================================================
   * 10. 初始化
   * ============================================================ */
    function initTopModules() {
        // 每个模块独立 try/catch，一个崩了不影响其他
        try { WTB_clip.start(); }  catch (e) { ERR('剪贴板模块初始化失败', e); }
        try { WTB_find.start(); }  catch (e) { ERR('检索模块初始化失败', e); }
        try { WTB_table.start(); } catch (e) { ERR('表格模块初始化失败', e); }
    }

    function bootstrap() {
        if (!IS_TOP) return;

        const run = () => {
            try {
                buildUI();
            } catch (e) {
                ERR('UI 构建异常', e);
                return;
            }
            // 等 UI 挂载完成再初始化模块
            requestAnimationFrame(() => initTopModules());
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run, { once: true });
        } else {
            run();
        }

        window.addEventListener('keydown', e => {
            if (e.altKey && e.shiftKey && (e.code === 'KeyS' || e.key === 'S' || e.key === 's')) {
                e.preventDefault();
                setPickEnabled(!pickEnabled);
            }
        }, true);

        try {
            if (typeof GM_registerMenuCommand === 'function') {
                GM_registerMenuCommand('🎯 切换元素拾取模式', () => setPickEnabled(!pickEnabled));
                GM_registerMenuCommand('🧰 显示工具箱面板', () => { if (panelEl) panelEl.hidden = false; });
            }
        } catch (e) {}
    }

    bootstrap();

    window.__webToolbox = {
        enablePick:  () => { if (IS_TOP) setPickEnabled(true); },
        disablePick: () => { if (IS_TOP) setPickEnabled(false); },
        togglePick:  () => { if (IS_TOP) setPickEnabled(!pickEnabled); },
        getInfo:     el => collectInfo(el || document.body)
    };
})();
