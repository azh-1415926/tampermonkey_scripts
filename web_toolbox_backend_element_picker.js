// ==UserScript==
// @name         网页工具箱 · 拾取模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  元素地址拾取（XPath / CSS / iframe 链）。依赖内核 wtb-core。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @run-at       document-idle
// @all-frames   true
// ==/UserScript==

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_PICK_MODULE__) return;

  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus || W.__WTB_PICK_MODULE__) return;
    W.__WTB_PICK_MODULE__ = true;

    const MSG_TAG = bus.const.MSG_TAG;
    const UI_ATTR = bus.const.UI_ATTR;
    const HL_Z    = bus.const.HL_Z;
    const { h, esc, escAttr, isValidIdent, isOwnUI, safeCall, copyText } = bus;

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }

    /* ============ 1. XPath / CSS 生成 ============ */
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

    /* ============ 2. iframe 链 ============ */
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

    /* ============ 3. 信息采集 ============ */
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

    /* ============ 4. 高亮 ============ */
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

    /* ============ 5. 拾取状态 ============ */
    const BLOCK_EVENTS = ['mousedown','mouseup','click','dblclick','pointerdown','pointerup','contextmenu'];
    let pickEnabled = false;
    let pickAttached = false;

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
          try { window.top.postMessage({ [MSG_TAG]: true, type: 'pick/escape' }, '*'); } catch (err) {}
          setPickEnabled(false, true);
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
      if (IS_TOP) bus.emit('pick:result', info);
      else {
        try { window.top.postMessage({ [MSG_TAG]: true, type: 'pick/result', payload: info }, '*'); }
        catch (e) { bus.log('无法发送到顶层窗口', info); }
      }
    }
    function setPickEnabled(v, fromParent) {
      pickEnabled = !!v;
      if (pickEnabled) attachPick();
      else { detachPick(); hideHighlight(); }
      if (IS_TOP) bus.emit('pick:state', { enabled: pickEnabled });
      if (!fromParent) broadcastToChildren({ [MSG_TAG]: true, type: 'pick/toggle', enabled: pickEnabled });
    }

    /* ============ 6. 所有 frame 消息桥 ============ */
    window.addEventListener('message', e => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d[MSG_TAG] !== true) return;
      if (d.type === 'pick/toggle') {
        setPickEnabled(d.enabled, true);
        broadcastToChildren(d);
      } else if (d.type === 'pick/result') {
        if (IS_TOP) bus.emit('pick:result', d.payload);
        else { try { window.top.postMessage(d, '*'); } catch (err) {} }
      } else if (d.type === 'pick/escape') {
        if (IS_TOP) setPickEnabled(false);
        else setPickEnabled(false, true);
      }
    }, false);

    /* ============ 7. 对外 API ============ */
    bus.pick = {
      enable:  () => { if (IS_TOP) setPickEnabled(true); },
      disable: () => { if (IS_TOP) setPickEnabled(false); },
      toggle:  () => { if (IS_TOP) setPickEnabled(!pickEnabled); },
      getInfo: el => collectInfo(el || document.body),
      isEnabled: () => pickEnabled
    };

    /* ============ 8. 顶层 UI 模块 ============ */
    if (!IS_TOP) return;

    bus.on('shortcut:toggle-pick', () => setPickEnabled(!pickEnabled));
    bus.on('shortcut:escape', () => { if (pickEnabled) setPickEnabled(false); });

    const MODULE_CSS = `
      .wtb-pick-bar {
        display: flex; align-items: center; gap: 10px;
        padding-bottom: 12px; border-bottom: 1px dashed #333a45;
        margin-bottom: 12px;
      }
      .wtb-pick-bar .wtb-btn.on { background: #16a34a; }
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

    function kv(k, v, cls) {
      return h('div', { class: 'wtb-kv' }, [
        h('div', { class: 'k', text: k }),
        h('div', { class: 'v' + (cls ? ' ' + cls : ''), text: v == null || v === '' ? '—' : String(v) })
      ]);
    }
    function section(title, children) {
      return h('div', { class: 'wtb-sec' }, [
        h('div', { class: 'wtb-sec-title', text: title }),
        ...children
      ]);
    }
    function codeRow(label, value) {
      const btn = h('button', { class: 'copy-btn' }, '复制');
      btn.addEventListener('click', () => copyText(value, btn));
      return h('div', { class: 'wtb-code-row' }, [
        h('div', { class: 'code-label', text: label }),
        h('code', { class: 'code-val', text: value || '—' }),
        btn
      ]);
    }
    function renderResult(host, info) {
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
        frameChildren.push(h('div', { class: 'wtb-empty' }, '该元素位于顶层 document，无 iframe 嵌套。'));
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

      const allBtn = h('button', { class: 'wtb-btn' }, '复制全部定位信息');
      allBtn.style.cssText = 'width:100%;padding:7px;margin-top:10px;font-size:12px;';
      allBtn.addEventListener('click', () => copyText(allText, allBtn));
      host.appendChild(allBtn);
    }

    bus.registerModule({
      id: 'pick',
      title: '拾取',
      icon: '🎯',
      order: 30,
      mount(ctx) {
        ctx.addStyle(MODULE_CSS);
        const pane = ctx.pane;
        pane.innerHTML = '';

        const toggleBtn = h('button', { class: 'wtb-btn' }, '开始拾取');
        const bar = h('div', { class: 'wtb-pick-bar' }, [
          toggleBtn,
          h('span', { class: 'wtb-hint' }, 'Alt+Shift+S 快捷切换 · Esc 取消')
        ]);
        const resultBox = h('div');
        pane.appendChild(bar);
        pane.appendChild(resultBox);

        function renderButton() {
          toggleBtn.textContent = pickEnabled ? '停止拾取' : '开始拾取';
          toggleBtn.classList.toggle('on', pickEnabled);
        }
        toggleBtn.addEventListener('click', () => setPickEnabled(!pickEnabled));

        ctx._offState  = bus.on('pick:state',  renderButton);
        ctx._offResult = bus.on('pick:result', info => renderResult(resultBox, info));
        renderButton();
      },
      unmount(ctx) {
        if (ctx._offState)  ctx._offState();
        if (ctx._offResult) ctx._offResult();
      }
    });

    /* 向后兼容：旧 API */
    W.__webToolbox = W.__webToolbox || {};
    W.__webToolbox.enablePick  = () => setPickEnabled(true);
    W.__webToolbox.disablePick = () => setPickEnabled(false);
    W.__webToolbox.togglePick  = () => setPickEnabled(!pickEnabled);
    W.__webToolbox.getInfo     = el => collectInfo(el || document.body);
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
