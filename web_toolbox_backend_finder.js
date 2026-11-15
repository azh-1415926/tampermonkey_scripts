// ==UserScript==
// @name         网页工具箱 · 查找模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.1.0
// @description  跨 iframe 文本检索高亮；拾取式抓取；点搜索才检索（先查当前视图，未找到再滚动遍历）；输入框内嵌历史记忆（可折叠 / 置顶 / 删除 / 清空）
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @run-at       document-idle
// @all-frames   true
// ==/UserScript==

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_FIND_MODULE__) return;

  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus || W.__WTB_FIND_MODULE__) return;
    W.__WTB_FIND_MODULE__ = true;

    const MSG_TAG = bus.const.MSG_TAG;
    const UI_ATTR = bus.const.UI_ATTR;
    const HL_Z    = bus.const.HL_Z;
    const { h, esc, isOwnUI } = bus;

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }

    const FRAME_ID = 'f' + Math.random().toString(36).slice(2, 10);
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
    const MAX_DIV_TEXT = 8000;

    const MAX_SCROLL_STEPS  = 800;
    const SCROLL_STEP_SLEEP = 90;
    const SCROLL_STEP_RATIO = 0.9;
    const SCROLL_TO_START_ROUNDS = 6;
    const SCROLL_TO_START_GAP = 30;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    let styleInjected = false;
    let localContainers = [];
    let localMarks = [];
    let localCurrentIndex = -1;

    const localGrabbed = new Map();

    const uidMap = new WeakMap();
    let uidSeq = 0;
    function uidOf(el) {
      if (!el) return 'all-links';
      let u = uidMap.get(el);
      if (!u) { u = 'u' + (++uidSeq); uidMap.set(el, u); }
      return u;
    }

    /* ============ 1. 样式 ============ */
    function injectStyle() {
      if (styleInjected) return;
      styleInjected = true;
      const st = document.createElement('style');
      st.setAttribute(UI_ATTR, '1');
      st.textContent = `
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
      (document.head || document.documentElement).appendChild(st);
    }

    /* ============ 2. 容器扫描 ============ */
    function byDocOrder(a, b) {
      if (a.el === b.el) return 0;
      if (!a.el) return 1;
      if (!b.el) return -1;
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    }

    function scanContainers() {
      const result = [];
      document.querySelectorAll(STRUCT_SEL).forEach(el => {
        if (!(el.textContent || '').trim()) return;
        if (el.parentElement && el.parentElement.closest(STRUCT_SEL)) return;
        result.push({ el, kind: 'struct', uid: uidOf(el) });
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
        if ((d.textContent || '').trim().length > MAX_DIV_TEXT) return;
        const n = d.querySelectorAll('a').length;
        const children = d.querySelectorAll(':scope > div, :scope > section, :scope > nav, :scope > article, :scope > main, :scope > aside');
        for (const c of children) if (c.querySelectorAll('a').length === n) return;
        divCandidates.push({ el: d, kind: 'div-links', uid: uidOf(d) });
      });
      divCandidates.sort(byDocOrder);
      divCandidates.forEach(c => result.push(c));

      const allDivs = document.querySelectorAll('div');
      const hasTextDivChild = new Set();
      allDivs.forEach(el => {
        if (!(el.textContent || '').trim()) return;
        let p = el.parentElement;
        while (p && p !== document.body && p !== document.documentElement) {
          if (p.tagName === 'DIV') hasTextDivChild.add(p);
          p = p.parentElement;
        }
      });
      const textBlocks = [];
      allDivs.forEach(el => {
        if (hasTextDivChild.has(el)) return;
        if (el.querySelector(STRUCT_SEL)) return;
        if (divSet.has(el)) return;
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length > MAX_DIV_TEXT) return;
        textBlocks.push({ el, kind: 'text-block', uid: uidOf(el) });
      });
      textBlocks.sort(byDocOrder);
      textBlocks.forEach(c => result.push(c));

      if (document.querySelectorAll('a').length) {
        result.push({ el: null, kind: 'all-links', uid: 'all-links' });
      }
      return result;
    }

    function labelFor(container, idx) {
      const { el, kind } = container;
      if (kind === 'all-links') {
        return '所有 a 标签 (' + document.querySelectorAll('a').length + ' 个)';
      }
      if (kind === 'text-block') {
        const preview = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
        const spanN = el.querySelectorAll('span').length;
        const meta = spanN ? spanN + ' 个 span · ' : '';
        return '#' + (idx + 1) + ' [div] ' + meta + preview;
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

    /* ============ 3. 高亮执行 ============ */
    function clearMarks() {
      document.querySelectorAll('mark.' + MARK_CLASS).forEach(m => {
        const parent = m.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      });
      localMarks = [];
      localCurrentIndex = -1;
    }

    function collectTextNodes(container) {
      const out = [];
      const kind = container.kind;
      const onlyA = (kind === 'all-links' || kind === 'div-links');
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

    function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
        const mk = document.createElement('mark');
        mk.className = MARK_CLASS;
        mk.textContent = m[0];
        frag.appendChild(mk);
        last = m.index + m[0].length;
        count++;
        if (count >= MAX_MARKS) break;
      }
      if (!count) return 0;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
      return count;
    }

    function runSearchLocal(container, query) {
      clearMarks();
      if (!container || !query) return 0;
      let total = 0;
      try {
        const re = new RegExp(escapeRegExp(query), 'gi');
        for (const node of collectTextNodes(container)) {
          total += highlightNode(node, re);
          if (total >= MAX_MARKS) break;
        }
        if (container.el) {
          localMarks = Array.prototype.slice.call(container.el.querySelectorAll('mark.' + MARK_CLASS));
        } else {
          localMarks = Array.prototype.slice.call(document.querySelectorAll('mark.' + MARK_CLASS));
        }
      } catch (e) { return -1; }
      if (localMarks.length) goToLocal(0);
      return localMarks.length;
    }

    function goToLocal(index) {
      if (!localMarks.length) return -1;
      const len = localMarks.length;
      localCurrentIndex = ((index % len) + len) % len;
      localMarks.forEach((m, i) => {
        if (i === localCurrentIndex) m.classList.add(ACTIVE_CLASS);
        else m.classList.remove(ACTIVE_CLASS);
      });
      const el = localMarks[localCurrentIndex];
      try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); }
      catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
      return localCurrentIndex;
    }

    /* ============ 3.x 滚动遍历辅助 ============ */
    function isScrollableY(el) {
      try {
        if (!el || el.nodeType !== 1) return false;
        if (el.scrollHeight <= el.clientHeight + 10) return false;
        const st = getComputedStyle(el);
        return /(auto|scroll|overlay|hidden)/.test(st.overflowY);
      } catch (e) { return false; }
    }

    function findScroller(rootEl) {
      if (!rootEl) return null;
      if (isScrollableY(rootEl)) return { type: 'native', el: rootEl, host: rootEl };
      let best = null, bestH = 0;
      try {
        for (const el of rootEl.querySelectorAll('*')) {
          if (isScrollableY(el)) {
            const h = el.scrollHeight;
            if (h > bestH) { best = el; bestH = h; }
          }
        }
      } catch (e) {}
      if (best) return { type: 'native', el: best, host: rootEl };

      let p = rootEl.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        if (isScrollableY(p)) return { type: 'native', el: p, host: rootEl };
        p = p.parentElement;
      }

      const scrollerSels = [
        '.d-modern-scroller',
        '.modern-scroller',
        '.el-scrollbar__bar',
        '[class*="virtual-scroll"]',
        '[class*="scrollbar"]'
      ];
      for (const sel of scrollerSels) {
        const s = rootEl.querySelector(sel);
        if (!s) continue;
        const slider = s.querySelector('.slider, .el-scrollbar__thumb, .thumb, .thumb-vertical');
        const track  = s.querySelector('.track') || s;
        if (slider) return { type: 'custom', host: rootEl, scroller: s, slider, track };
        return { type: 'wheel', host: rootEl, el: s };
      }

      const slider = rootEl.querySelector('.slider, .thumb, .thumb-vertical');
      if (slider && slider.parentElement) {
        const track = slider.parentElement.querySelector('.track') || slider.parentElement;
        return { type: 'custom', host: rootEl, scroller: slider.parentElement, slider, track };
      }

      return { type: 'wheel', host: rootEl, el: rootEl };
    }

    function getCurrentScrollTop(ctrl) {
      if (!ctrl) return 0;
      if (ctrl.type === 'native') return ctrl.el.scrollTop;
      if (ctrl.type === 'custom') return parseFloat(ctrl.slider.style.top) || 0;
      return 0;
    }

    function getViewHeight(ctrl) {
      if (!ctrl) return 400;
      if (ctrl.type === 'native') return ctrl.el.clientHeight || 400;
      if (ctrl.type === 'custom') {
        const t = ctrl.track;
        return (t && (t.clientHeight || t.offsetHeight)) || 400;
      }
      if (ctrl.type === 'wheel') return (ctrl.el && ctrl.el.clientHeight) || 400;
      return 400;
    }

    function fireWheel(targets, dy) {
      for (const t of targets) {
        if (!t) continue;
        try {
          t.dispatchEvent(new WheelEvent('wheel', {
            deltaY: dy, deltaMode: 0,
            bubbles: true, cancelable: true, view: window
          }));
        } catch (e) {}
      }
    }

    function buildWheelTargets(ctrl) {
      const targets = new Set();
      if (ctrl.type === 'native') return targets;
      if (ctrl.type === 'custom') {
        if (ctrl.host) {
          targets.add(ctrl.host);
          try { ctrl.host.querySelectorAll('[tabindex]').forEach(el => targets.add(el)); } catch (e) {}
        }
        if (ctrl.scroller) targets.add(ctrl.scroller);
        if (ctrl.scroller && ctrl.scroller.parentElement) targets.add(ctrl.scroller.parentElement);
        if (ctrl.slider) targets.add(ctrl.slider);
      } else if (ctrl.type === 'wheel') {
        if (ctrl.host) {
          targets.add(ctrl.host);
          try { ctrl.host.querySelectorAll('[tabindex]').forEach(el => targets.add(el)); } catch (e) {}
        }
        if (ctrl.el) targets.add(ctrl.el);
      }
      return targets;
    }

    async function scrollStep(ctrl) {
      if (!ctrl) return { moved: false, reason: 'no-ctrl' };

      if (ctrl.type === 'native') {
        const el = ctrl.el;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          return { moved: false, reason: 'bottom', top: el.scrollTop };
        }
        const viewH = el.clientHeight || 400;
        const step = Math.max(80, Math.min(Math.floor(viewH * SCROLL_STEP_RATIO), 600));
        el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
        try { el.dispatchEvent(new Event('scroll')); } catch (e) {}
        return { moved: true, reason: 'native', top: el.scrollTop };
      }

      if (ctrl.type === 'custom') {
        const { track, slider } = ctrl;
        const trackH  = (track && (track.clientHeight || track.offsetHeight)) || 0;
        const sliderH = slider.offsetHeight || 32;
        const maxTop  = Math.max(0, trackH - sliderH);
        const curTop  = parseFloat(slider.style.top) || 0;
        if (maxTop > 0 && curTop >= maxTop - 2) {
          return { moved: false, reason: 'bottom', top: curTop };
        }
        const viewH = getViewHeight(ctrl);
        const dy = Math.max(200, Math.floor(viewH * SCROLL_STEP_RATIO));
        fireWheel(buildWheelTargets(ctrl), dy);
        return { moved: true, reason: 'wheel', top: curTop };
      }

      if (ctrl.type === 'wheel') {
        const viewH = getViewHeight(ctrl);
        const dy = Math.max(200, Math.floor(viewH * SCROLL_STEP_RATIO));
        fireWheel(buildWheelTargets(ctrl), dy);
        return { moved: true, reason: 'wheel' };
      }

      return { moved: false, reason: 'unknown' };
    }

    async function scrollToStart(ctrl) {
      if (!ctrl) return;
      if (ctrl.type === 'native') {
        ctrl.el.scrollTop = 0;
        try { ctrl.el.dispatchEvent(new Event('scroll')); } catch (e) {}
        await sleep(120);
        return;
      }
      if (ctrl.type === 'custom' || ctrl.type === 'wheel') {
        const targets = buildWheelTargets(ctrl);
        for (let k = 0; k < SCROLL_TO_START_ROUNDS; k++) {
          fireWheel(targets, -99999);
          await sleep(SCROLL_TO_START_GAP);
        }
        await sleep(120);
      }
    }

    function findRowAncestor(el) {
      let p = el, depth = 0;
      while (p && p !== document.body && p !== document.documentElement && depth++ < 30) {
        try {
          if (p.hasAttribute && p.hasAttribute('rowid')) return p;
          if (p.matches && p.matches('tr, [role="row"], li, [role="listitem"], [data-row-key], [data-index]')) return p;
        } catch (e) {}
        p = p.parentElement;
      }
      return null;
    }

    function getRowSignature(rowEl) {
      if (!rowEl) return null;
      const rid = rowEl.getAttribute('rowid')
               || rowEl.getAttribute('data-row-key')
               || rowEl.getAttribute('data-index');
      if (rid) return 'k:' + rid;
      const txt = (rowEl.textContent || '').trim().slice(0, 120);
      return txt ? 't:' + txt : null;
    }

    async function runSearchLocalAsync(container, query) {
      if (!container || !query) { clearMarks(); return 0; }

      const isGrabbed = container.kind === 'grabbed'
                     || (container.uid && localGrabbed.has(container.uid));
      if (!isGrabbed || !container.el) {
        return runSearchLocal(container, query);
      }

      const ctrl = findScroller(container.el);
      if (!ctrl) return runSearchLocal(container, query);

      clearMarks();

      try {
        const re = new RegExp(escapeRegExp(query), 'gi');

        const rowMatches  = new Map();
        const orphanNodes = new WeakSet();
        let   orphanTotal = 0;

        const getTotal = () => {
          let t = orphanTotal;
          for (const c of rowMatches.values()) t += c;
          return t;
        };

        const scanView = () => {
          const nodes = collectTextNodes(container);
          for (const node of nodes) {
            if (!node.parentElement) continue;
            re.lastIndex = 0;
            const m = (node.nodeValue || '').match(re);
            if (!m || !m.length) continue;

            const rowEl = findRowAncestor(node.parentElement);
            const sig   = getRowSignature(rowEl);
            if (sig) {
              const prev = rowMatches.get(sig) || 0;
              if (m.length > prev) rowMatches.set(sig, m.length);
            } else if (!orphanNodes.has(node)) {
              orphanNodes.add(node);
              orphanTotal += m.length;
            }
          }
        };

        await scrollToStart(ctrl);
        await sleep(150);
        scanView();

        let lastTop = getCurrentScrollTop(ctrl);
        let noProgress = 0;

        for (let step = 0; step < MAX_SCROLL_STEPS; step++) {
          if (getTotal() >= MAX_MARKS) break;
          const r = await scrollStep(ctrl);
          await sleep(SCROLL_STEP_SLEEP);
          scanView();

          if (!r.moved) {
            await sleep(150);
            scanView();
            break;
          }

          const curTop = getCurrentScrollTop(ctrl);
          if (curTop === lastTop) {
            if (++noProgress >= 4) {
              await sleep(150);
              scanView();
              break;
            }
          } else {
            noProgress = 0;
            lastTop = curTop;
          }
        }

        const total = getTotal();
        await scrollToStart(ctrl);
        await sleep(150);
        runSearchLocal(container, query);
        return total;
      } catch (e) {
        return runSearchLocal(container, query);
      }
    }

    /* ============ 4. 抓取模式 ============ */
    const GRAB_EVENTS = ['mousedown','mouseup','click','dblclick','pointerdown','pointerup','contextmenu'];
    let grabEnabled = false;
    let grabAttached = false;
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
    function buildGrabLabel(el) {
      let s = describeEl(el);
      let txt = '';
      try { txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24); } catch (e) {}
      if (txt) s += ' · ' + txt;
      return s;
    }

    function computeGrabRoot(el) {
      if (!el || el.nodeType !== 1) return el;
      let p = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        if (p.tagName === 'DIV') return p;
        p = p.parentElement;
      }
      return el;
    }

    function showHighlight(el, ev) {
      ensureHighlightLayer(); ensureTipLayer();
      let r; try { r = el.getBoundingClientRect(); } catch (e) { return; }
      hlBox.style.display = 'block';
      hlBox.style.left   = r.left + 'px';
      hlBox.style.top    = r.top + 'px';
      hlBox.style.width  = r.width + 'px';
      hlBox.style.height = r.height + 'px';
      hlTip.textContent = '↖ ' + buildGrabLabel(el);
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

    function stopEvt(e) {
      try { e.preventDefault(); } catch (err) {}
      try { e.stopPropagation(); } catch (err) {}
      try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (err) {}
    }

    function onGrabMouseMove(e) {
      if (!grabEnabled) return;
      const el = e.target;
      if (!el || el.nodeType !== 1 || isOwnUI(el)) { hideHighlight(); return; }
      const root = computeGrabRoot(el);
      showHighlight(root, e);
    }

    function onGrabBlock(e) {
      if (!grabEnabled) return;
      const el = e.target;
      if (!el || el.nodeType !== 1 || isOwnUI(el)) return;
      stopEvt(e);
      if (e.type === 'click') doGrabPick(el, e);
    }

    function onGrabKeyDown(e) {
      if (!grabEnabled) return;
      if (e.key !== 'Escape') return;
      if (IS_TOP) setGrabEnabled(false);
      else {
        try { window.top.postMessage({ [MSG_TAG]: true, type: 'find/grab-escape' }, '*'); } catch (err) {}
        setGrabEnabled(false, true);
      }
    }

    function attachGrab() {
      if (grabAttached) return;
      grabAttached = true;
      document.addEventListener('mousemove', onGrabMouseMove, true);
      for (const ev of GRAB_EVENTS) document.addEventListener(ev, onGrabBlock, true);
      window.addEventListener('keydown', onGrabKeyDown, true);
    }
    function detachGrab() {
      if (!grabAttached) return;
      grabAttached = false;
      document.removeEventListener('mousemove', onGrabMouseMove, true);
      for (const ev of GRAB_EVENTS) document.removeEventListener(ev, onGrabBlock, true);
      window.removeEventListener('keydown', onGrabKeyDown, true);
      hideHighlight();
    }

    function doGrabPick(el, ev) {
      const root = computeGrabRoot(el);
      const uid = uidOf(root);
      const label = buildGrabLabel(root);
      localGrabbed.set(uid, { el: root, label: label });

      const payload = {
        frameId: FRAME_ID,
        frameLabel: getFrameLabel(),
        uid: uid,
        kind: 'grabbed',
        label: label
      };

      if (IS_TOP) handleGrabbed(payload);
      else {
        try { window.top.postMessage({ [MSG_TAG]: true, type: 'find/grab-add', payload: payload }, '*'); }
        catch (e) {}
      }

      showHighlight(root, ev);
      setTimeout(() => { if (!grabEnabled) hideHighlight(); }, 700);

      if (IS_TOP) {
        setGrabEnabled(false);
      } else {
        setGrabEnabled(false, true);
        try { window.top.postMessage({ [MSG_TAG]: true, type: 'find/grab-escape' }, '*'); }
        catch (e) {}
      }
    }

    function setGrabEnabled(v, fromParent) {
      grabEnabled = !!v;
      if (grabEnabled) attachGrab();
      else { detachGrab(); hideHighlight(); }
      if (IS_TOP && grabBtn) {
        grabBtn.classList.toggle('wtb-grab-on', grabEnabled);
        grabBtn.textContent = grabEnabled ? '📌 抓取中… (Esc 退出)' : '📌 抓取控件';
      }
      if (!fromParent) {
        broadcastToChildren({ [MSG_TAG]: true, type: 'find/grab-toggle', enabled: grabEnabled });
      }
    }

    /* ============ 5. 跨 frame 通讯 ============ */
    function getFrameLabel() {
      try {
        if (IS_TOP) return '顶层窗口';
        const url = window.location.href;
        return url.replace(/^https?:\/\//, '').slice(0, 60) || '(unknown)';
      } catch (e) { return '未知 frame'; }
    }
    function toTop(msg) {
      if (IS_TOP) return;
      try { window.top.postMessage(msg, '*'); } catch (e) {}
    }
    function broadcastToChildren(msg) {
      let frames;
      try { frames = window.frames; } catch (e) { return; }
      for (let i = 0; i < frames.length; i++) {
        try { frames[i].postMessage(msg, '*'); } catch (e) {}
      }
    }

    /* ============ 6. 状态 ============ */
    let allContainers = [];
    let activeEntry = null;
    let activeCount = 0;
    let activeTotal = 0;
    let activeIndex = -1;
    let activeQuery = '';
    let scanTimer = null;

    const KIND_SHOW = {
      grabbed: '已抓取根',
      struct: '表格 / 列表',
      'div-links': '链接容器 div',
      'text-block': '文本 div',
      'all-links': '其他'
    };

    let selEl = null, inputEl = null,
        prevBtn = null, nextBtn = null, statusEl = null,
        grabBtn = null, cancelGrabBtn = null, refreshBtn = null;

    /* 内嵌历史区（参考任务模块风格） */
    let histSection = null, histHead = null, histListEl = null,
        histTitleEl = null, histArrowEl = null, histEmptyEl = null;
    let histOpen = true;

    let grabbedEntry = null;

    /* ============ 6.x 检索历史记忆 ============ */
    const HISTORY_KEY = 'wtb-find-history-v1';
    const HISTORY_MAX = 50;

    function loadHistory() {
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr
          .filter(x => x && typeof x.q === 'string' && x.q)
          .map(x => ({
            q: x.q,
            pinned: !!x.pinned,
            ts: typeof x.ts === 'number' ? x.ts : 0
          }));
      } catch (e) { return []; }
    }

    function saveHistory(list) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
      } catch (e) {}
    }

    function sortHistory(list) {
      list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.ts || 0) - (a.ts || 0);
      });
      return list;
    }

    function addHistory(q) {
      q = (q || '').trim();
      if (!q) return;
      const list = loadHistory();
      const idx = list.findIndex(x => x.q === q);
      if (idx >= 0) {
        list[idx].ts = Date.now();
      } else {
        list.push({ q, pinned: false, ts: Date.now() });
      }
      sortHistory(list);
      saveHistory(list);
    }

    function removeHistory(q) {
      saveHistory(loadHistory().filter(x => x.q !== q));
    }

    function togglePinHistory(q) {
      const list = loadHistory();
      const idx = list.findIndex(x => x.q === q);
      if (idx < 0) return;
      list[idx].pinned = !list[idx].pinned;
      if (list[idx].pinned) list[idx].ts = Date.now();
      sortHistory(list);
      saveHistory(list);
    }

    function clearHistoryUnpinned() {
      saveHistory(loadHistory().filter(x => x.pinned));
    }

    function clearHistoryAll() {
      saveHistory([]);
    }

    /** 根据当前 histOpen 更新折叠状态 */
    function applyHistOpenState() {
      if (!histSection) return;
      if (histOpen) histSection.classList.add('is-open');
      else histSection.classList.remove('is-open');
      if (histArrowEl) histArrowEl.textContent = histOpen ? '▾' : '▸';
    }

    /** 重新渲染历史列表（保持展开状态） */
    function renderHistorySection() {
      if (!histListEl || !histTitleEl) return;
      const list = sortHistory(loadHistory());

      if (histTitleEl) {
        histTitleEl.textContent = '📜 历史记录 (' + list.length + ')';
      }

      histListEl.innerHTML = '';

      if (!list.length) {
        histListEl.appendChild(
          h('div', { class: 'wtb-find-hist-empty' }, '暂无历史记录')
        );
        return;
      }

      for (const item of list) {
        const row = h('div', { class: 'wtb-find-hist-item' });

        const txt = h('span', {
          class: 'wtb-find-hist-text',
          title: item.q
        }, item.q);
        txt.addEventListener('click', () => {
          if (!inputEl) return;
          inputEl.value = item.q;
          try { inputEl.dispatchEvent(new Event('input')); } catch (e) {}
          try { inputEl.focus(); } catch (e) {}
          updateStatus();
        });
        row.appendChild(txt);

        const pin = h('button', {
          type: 'button',
          class: 'wtb-find-hist-icon' + (item.pinned ? ' is-pinned' : ''),
          title: item.pinned ? '取消置顶' : '置顶'
        }, item.pinned ? '📌' : '📍');
        pin.addEventListener('click', e => {
          e.stopPropagation();
          togglePinHistory(item.q);
          renderHistorySection();
        });
        row.appendChild(pin);

        const del = h('button', {
          type: 'button',
          class: 'wtb-find-hist-icon danger',
          title: '删除'
        }, '✕');
        del.addEventListener('click', e => {
          e.stopPropagation();
          removeHistory(item.q);
          renderHistorySection();
        });
        row.appendChild(del);

        histListEl.appendChild(row);
      }
    }

    /* ============ 6.y 抓取/检索核心（与之前一致） ============ */
    function isGrabbed(entry) {
      return !!(grabbedEntry && entry &&
        entry.frameId === grabbedEntry.frameId && entry.uid === grabbedEntry.uid);
    }
    function grabActive() { return !!grabbedEntry; }

    function handleGrabbed(payload) {
      if (!payload || !payload.uid) return;
      grabbedEntry = {
        frameId: payload.frameId,
        frameLabel: payload.frameLabel,
        uid: payload.uid,
        kind: payload.kind || 'grabbed',
        label: payload.label
      };
      let entry = allContainers.find(c =>
        c.frameId === grabbedEntry.frameId && c.uid === grabbedEntry.uid);
      if (!entry) {
        entry = {
          frameId: grabbedEntry.frameId,
          frameLabel: grabbedEntry.frameLabel,
          uid: grabbedEntry.uid,
          kind: grabbedEntry.kind,
          label: grabbedEntry.label
        };
        allContainers.push(entry);
      }
      activeEntry = entry;
      activeCount = 0; activeTotal = 0; activeIndex = -1; activeQuery = '';
      refreshSelectionAndSearch();
    }

    function cancelGrab() {
      grabbedEntry = null;
      localGrabbed.clear();
      broadcastToChildren({ [MSG_TAG]: true, type: 'find/grab-clear' });
      activeEntry = null;
      activeCount = 0;
      activeTotal = 0;
      activeIndex = -1;
      activeQuery = '';
      resetAllFramesHighlight();
      rescan();
      updateStatus();
    }

    function updateStatus() {
      if (cancelGrabBtn) cancelGrabBtn.disabled = !grabbedEntry;
      if (!statusEl) return;
      if (!allContainers.length) {
        statusEl.textContent = '未找到可检索控件（表格 / 列表 / 链接 div / 文本 div）';
        return;
      }
      const scope = grabActive()
        ? ' ｜ 范围：' + esc(grabbedEntry.label || '(已抓取)')
        : '';
      if (!activeEntry) {
        statusEl.innerHTML = '请先在下拉框中选择一个容器' + scope;
        return;
      }
      const q = inputEl ? inputEl.value.trim() : '';
      if (!q) { statusEl.innerHTML = '输入文本开始检索' + scope; return; }
      if (activeQuery !== q) {
        statusEl.innerHTML = '点击 <b>🔍</b> 或按回车检索' + scope;
        return;
      }
      if (!activeTotal) { statusEl.innerHTML = '未找到匹配项' + scope; return; }
      const navPart = activeCount > 0
        ? ' ｜ 可视 <b>' + activeCount + '</b> 项 · 当前第 <b>' + (activeIndex + 1) + '</b>'
        : '';
      statusEl.innerHTML =
        '匹配 <b>' + activeTotal + '</b> 项' + navPart +
        ' ｜ 来源：' + activeEntry.frameLabel + scope;
    }

    function buildSelect() {
      if (!selEl) return { changed: false };
      selEl.innerHTML = '';
      if (!allContainers.length) {
        const o = document.createElement('option');
        o.textContent = '未找到可检索控件';
        selEl.appendChild(o);
        selEl.disabled = true;
        activeEntry = null;
        return { changed: true };
      }
      selEl.disabled = false;

      let filtered = allContainers;
      if (grabActive()) filtered = filtered.filter(isGrabbed);

      if (!filtered.length) {
        const o = document.createElement('option');
        o.textContent = grabActive() ? '已抓取的控件暂不可用' : '没有可用选项';
        selEl.appendChild(o);
        selEl.disabled = true;
        const prev = activeEntry;
        activeEntry = null;
        return { changed: prev !== null };
      }

      const byFrame = new Map();
      for (const c of filtered) {
        if (!byFrame.has(c.frameId)) byFrame.set(c.frameId, { label: c.frameLabel, items: [] });
        byFrame.get(c.frameId).items.push(c);
      }
      const frameIds = Array.from(byFrame.keys()).sort((a, b) => {
        if (a === FRAME_ID) return -1;
        if (b === FRAME_ID) return 1;
        return 0;
      });

      const KIND_ORDER = ['grabbed', 'struct', 'div-links', 'text-block', 'all-links'];
      for (const fid of frameIds) {
        const group = byFrame.get(fid);
        const kindGroups = { grabbed: [], struct: [], 'div-links': [], 'text-block': [], 'all-links': [] };
        for (const item of group.items) {
          const bucket = kindGroups[item.kind] || kindGroups.struct;
          bucket.push(item);
        }
        for (const kind of KIND_ORDER) {
          const list = kindGroups[kind];
          if (!list.length) continue;
          const og = document.createElement('optgroup');
          const short = group.label.length > 30 ? group.label.slice(0, 30) + '…' : group.label;
          og.label = '[' + short + '] ' + KIND_SHOW[kind] + ' (' + list.length + ')';
          for (const item of list) {
            const o = document.createElement('option');
            o.value = item.frameId + '#' + item.uid;
            o.textContent = (grabActive() ? '📌 ' : '') + item.label;
            og.appendChild(o);
          }
          selEl.appendChild(og);
        }
      }

      let pickValue = null;
      if (activeEntry) {
        const v = activeEntry.frameId + '#' + activeEntry.uid;
        for (const opt of selEl.querySelectorAll('option')) if (opt.value === v) { pickValue = v; break; }
      }
      if (!pickValue) {
        const first = selEl.querySelector('option');
        if (first) pickValue = first.value;
      }
      const prevEntry = activeEntry;
      if (pickValue) {
        selEl.value = pickValue;
        const sep = pickValue.indexOf('#');
        const fid = pickValue.slice(0, sep);
        const uid = pickValue.slice(sep + 1);
        activeEntry = allContainers.find(c => c.frameId === fid && c.uid === uid) || null;
      } else {
        activeEntry = null;
      }
      return { changed: prevEntry !== activeEntry };
    }

    function findLocalContainerByUid(uid) {
      if (!uid) return null;
      const g = localGrabbed.get(uid);
      if (g) return { el: g.el, kind: 'grabbed', uid, label: g.label };
      for (let i = 0; i < localContainers.length; i++) {
        if (localContainers[i].uid === uid) return localContainers[i];
      }
      return null;
    }

    function resetAllFramesHighlight() {
      clearMarks();
      broadcastToChildren({ [MSG_TAG]: true, type: 'find/clear' });
    }

    async function doSearch(query, forceFull) {
      resetAllFramesHighlight();
      activeCount = 0;
      activeTotal = 0;
      activeIndex = -1;
      activeQuery = '';
      if (!activeEntry || !query) { updateStatus(); return; }
      activeQuery = query;

      /* 记录历史 + 刷新内嵌历史区 */
      addHistory(query);
      try { renderHistorySection(); } catch (e) {}

      if (activeEntry.frameId === FRAME_ID) {
        const c = findLocalContainerByUid(activeEntry.uid);
        if (!c) { updateStatus(); return; }

        let total;
        try {
          if (forceFull) {
            if (statusEl) statusEl.textContent = '正在滚动遍历检索…';
            total = await runSearchLocalAsync(c, query);
          } else {
            if (statusEl) statusEl.textContent = '检索中…';
            total = runSearchLocal(c, query);
            if (total === 0) {
              if (statusEl) statusEl.textContent = '当前视图未找到，正在滚动遍历…';
              total = await runSearchLocalAsync(c, query);
            }
          }
        } catch (e) { total = 0; }
        activeTotal = total > 0 ? total : 0;
        activeCount = localMarks.length;
        activeIndex = localCurrentIndex;
        updateStatus();
      } else {
        if (statusEl) statusEl.textContent = '正在目标 frame 检索…';
        broadcastToChildren({
          [MSG_TAG]: true, type: 'find/run',
          frameId: activeEntry.frameId,
          containerUid: activeEntry.uid,
          query: query,
          forceFull: !!forceFull
        });
      }
    }

    function doGoto(delta) {
      if (!activeEntry) return;
      if (activeEntry.frameId === FRAME_ID) {
        if (!localMarks.length) return;
        const newIndex = ((localCurrentIndex + delta) % localMarks.length + localMarks.length) % localMarks.length;
        goToLocal(newIndex);
        activeIndex = localCurrentIndex;
        updateStatus();
      } else {
        if (!activeCount) return;
        const newIndex = ((activeIndex + delta) % activeCount + activeCount) % activeCount;
        broadcastToChildren({
          [MSG_TAG]: true, type: 'find/goto',
          frameId: activeEntry.frameId,
          index: newIndex
        });
      }
    }

    function refreshSelectionAndSearch() {
      const r = buildSelect();
      const q = inputEl ? inputEl.value.trim() : '';
      if (r && r.changed && activeEntry && q) {
        doSearch(q, false);
      } else {
        updateStatus();
      }
    }

    function refreshSearch() {
      const q = inputEl ? inputEl.value.trim() : '';
      if (!q) {
        resetAllFramesHighlight();
        activeCount = 0; activeTotal = 0; activeIndex = -1; activeQuery = '';
        updateStatus();
        return;
      }
      if (!activeEntry && allContainers.length) buildSelect();
      if (!activeEntry) { updateStatus(); return; }
      doSearch(q, true);
    }

    function rescan() {
      localContainers = scanContainers();
      allContainers = localContainers.map((c, i) => ({
        frameId: FRAME_ID,
        frameLabel: getFrameLabel(),
        idx: i, uid: c.uid, kind: c.kind, label: labelFor(c, i)
      }));
      if (grabbedEntry) {
        const found = allContainers.find(c =>
          c.frameId === grabbedEntry.frameId && c.uid === grabbedEntry.uid);
        if (!found) {
          allContainers.push({
            frameId: grabbedEntry.frameId,
            frameLabel: grabbedEntry.frameLabel,
            uid: grabbedEntry.uid,
            kind: grabbedEntry.kind,
            label: grabbedEntry.label
          });
        }
        activeEntry = allContainers.find(c =>
          c.frameId === grabbedEntry.frameId && c.uid === grabbedEntry.uid) || activeEntry;
      }

      broadcastToChildren({ [MSG_TAG]: true, type: 'find/scan' });

      if (grabEnabled) {
        broadcastToChildren({ [MSG_TAG]: true, type: 'find/grab-toggle', enabled: true });
      }

      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        buildSelect();
        updateStatus();
      }, 500);
    }

    function handleMessage(d) {
      if (!IS_TOP) {
        if (d.type === 'find/scan' || d.type === 'find/clear' ||
            d.type === 'find/run'  || d.type === 'find/goto' ||
            d.type === 'find/grab-toggle' || d.type === 'find/grab-clear') {
          broadcastToChildren(d);
        }
      }

      if (d.type === 'find/scan') {
        const list = scanContainers();
        localContainers = list;
        if (!IS_TOP) {
          toTop({
            [MSG_TAG]: true, type: 'find/scan-result',
            frameId: FRAME_ID,
            frameLabel: getFrameLabel(),
            containers: list.map((c, i) => ({ idx: i, uid: c.uid, kind: c.kind, label: labelFor(c, i) }))
          });
        }
        return;
      }

      if (d.type === 'find/clear') { clearMarks(); return; }

      if (d.type === 'find/grab-clear') { localGrabbed.clear(); return; }

      if (d.type === 'find/grab-toggle') {
        setGrabEnabled(d.enabled, true);
        return;
      }

      if (d.type === 'find/run' && d.frameId === FRAME_ID) {
        const c = d.containerUid ? findLocalContainerByUid(d.containerUid) : null;
        if (!c) return;
        (async () => {
          let total;
          if (d.forceFull) {
            total = await runSearchLocalAsync(c, d.query);
          } else {
            total = runSearchLocal(c, d.query);
            if (total === 0) total = await runSearchLocalAsync(c, d.query);
          }
          return total;
        })().then(total => {
          toTop({
            [MSG_TAG]: true, type: 'find/run-result',
            frameId: FRAME_ID,
            total: total > 0 ? total : 0,
            visibleCount: localMarks.length,
            currentIndex: localCurrentIndex
          });
        }).catch(() => {
          toTop({
            [MSG_TAG]: true, type: 'find/run-result',
            frameId: FRAME_ID,
            total: 0, visibleCount: 0, currentIndex: -1
          });
        });
        return;
      }

      if (d.type === 'find/goto' && d.frameId === FRAME_ID) {
        const idx = goToLocal(d.index);
        toTop({
          [MSG_TAG]: true, type: 'find/goto-result',
          frameId: FRAME_ID,
          currentIndex: idx,
          count: localMarks.length
        });
        return;
      }

      if (IS_TOP) {
        if (d.type === 'find/scan-result') {
          for (const c of d.containers) {
            const exists = allContainers.some(x => x.frameId === d.frameId && x.uid === c.uid);
            if (!exists) {
              allContainers.push({
                frameId: d.frameId, frameLabel: d.frameLabel,
                idx: c.idx, uid: c.uid, kind: c.kind, label: c.label
              });
            }
          }
        } else if (d.type === 'find/run-result') {
          if (activeEntry && activeEntry.frameId === d.frameId) {
            activeTotal = d.total != null ? d.total : (d.count || 0);
            activeCount = d.visibleCount != null ? d.visibleCount : (d.count || 0);
            activeIndex = d.currentIndex;
            updateStatus();
          }
        } else if (d.type === 'find/goto-result') {
          if (activeEntry && activeEntry.frameId === d.frameId) {
            activeCount = d.count;
            activeIndex = d.currentIndex;
            updateStatus();
          }
        } else if (d.type === 'find/grab-add') {
          handleGrabbed(d.payload);
        }
      }
    }

    window.addEventListener('message', e => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d[MSG_TAG] !== true) return;
      if (typeof d.type !== 'string' || d.type.indexOf('find/') !== 0) return;

      if (d.type === 'find/grab-state-request' && IS_TOP) {
        try {
          if (e.source) {
            e.source.postMessage({
              [MSG_TAG]: true,
              type: 'find/grab-toggle',
              enabled: grabEnabled
            }, '*');
          }
        } catch (err) {}
        return;
      }

      if (d.type === 'find/grab-escape' && IS_TOP) {
        setGrabEnabled(false);
        return;
      }

      handleMessage(d);
    }, false);

    /* ============ 7. 初始化 ============ */
    injectStyle();
    localContainers = scanContainers();

    if (!IS_TOP) {
      try {
        window.top.postMessage({ [MSG_TAG]: true, type: 'find/grab-state-request' }, '*');
      } catch (e) {}
    }

    /* ============ 8. 顶层 UI 模块 ============ */
    if (!IS_TOP) return;

    const MODULE_CSS = `
      .wtb-find-status { font-size: 12px; color: #9aa6bb; margin-top: 8px; word-break: break-all; }
      .wtb-find-status b { color: #ffd166; font-weight: 600; }
      .wtb-find-grab.wtb-grab-on {
        background: #4ea1ff !important;
        border-color: #4ea1ff !important;
        color: #04121f !important;
        font-weight: 600;
      }
      .wtb-btn[disabled] { opacity: .45; cursor: not-allowed; }

      /* ---- 内嵌历史区（参考任务模块风格） ---- */
      .wtb-find-hist-section {
        margin-top: 8px;
        border: 1px solid #2c333e;
        border-radius: 6px;
        overflow: hidden;
        background: #1b2029;
      }

      .wtb-find-hist-head {
        display: flex; align-items: center; gap: 4px;
        padding: 5px 8px;
        background: #222833;
        border-bottom: 1px solid #2c333e;
        font-size: 11px; color: #8b94a3;
        cursor: pointer;
        user-select: none;
      }
      .wtb-find-hist-head:hover { color: #d8dde5; }
      .wtb-find-hist-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wtb-find-hist-arrow { flex: 0 0 auto; transition: transform .15s; }

      .wtb-find-hist-head .wtb-find-hist-tool {
        flex: 0 0 auto;
        padding: 1px 6px;
        background: transparent;
        border: 1px solid #2c333e;
        border-radius: 3px;
        color: #8b94a3;
        cursor: pointer;
        font-size: 10px;
        font-family: inherit;
        line-height: 1.4;
      }
      .wtb-find-hist-head .wtb-find-hist-tool:hover {
        color: #d8dde5; border-color: #3a7bd5;
      }

      .wtb-find-hist-section:not(.is-open) .wtb-find-hist-list { display: none; }

      .wtb-find-hist-list {
        max-height: 140px;
        overflow-y: auto;
        padding: 2px 0;
      }
      .wtb-find-hist-list::-webkit-scrollbar { width: 4px; }
      .wtb-find-hist-list::-webkit-scrollbar-thumb { background: #3a4250; border-radius: 2px; }
      .wtb-find-hist-list::-webkit-scrollbar-track { background: transparent; }

      .wtb-find-hist-item {
        display: flex; align-items: center; gap: 4px;
        padding: 4px 8px;
        font-size: 12px;
      }
      .wtb-find-hist-item:hover { background: #262c36; }

      .wtb-find-hist-text {
        flex: 1 1 auto; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: #d8dde5;
        cursor: pointer;
      }
      .wtb-find-hist-text:hover { color: #7fd3ff; }

      .wtb-find-hist-icon {
        flex: 0 0 auto;
        width: 16px; height: 16px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: 0; border-radius: 3px;
        color: #6f7a8c;
        font-size: 10px; line-height: 1; font-family: inherit;
        cursor: pointer;
        opacity: .35;
        transition: opacity .12s, background .12s, color .12s;
      }
      .wtb-find-hist-item:hover .wtb-find-hist-icon { opacity: 1; }
      .wtb-find-hist-icon.is-pinned { opacity: 1; color: #ffd166; }
      .wtb-find-hist-icon:hover { color: #8fc4ff; background: #2a3140; }
      .wtb-find-hist-icon.danger:hover { color: #ff6b6b; background: #3a2528; }

      .wtb-find-hist-empty {
        padding: 10px 8px;
        text-align: center;
        color: #6f7a8c;
        font-size: 11px;
      }
    `;

    bus.registerModule({
      id: 'find',
      title: '检索',
      icon: '🔍',
      order: 10,
      mount(ctx) {
        ctx.addStyle(MODULE_CSS);
        const pane = ctx.pane;
        pane.innerHTML = '';

        /* 第 1 行：容器下拉框 + 重新扫描 */
        selEl = h('select');
        selEl.style.flex = '1';
        const rescanBtn = h('button', { type: 'button', class: 'wtb-btn ghost', title: '重新扫描' }, '⟳');
        const row1 = h('div', { class: 'wtb-row' }, [selEl, rescanBtn]);

        /* 第 2 行：输入框 + 搜索 + 刷新（完整）+ 清空 */
        inputEl = h('input', { type: 'text', placeholder: '输入要检索的文本，点 🔍 或按回车检索' });
        inputEl.style.flex = '1';
        const searchBtn = h('button', { type: 'button', class: 'wtb-btn', title: '检索：先查找当前视图，未找到再自动滚动遍历' }, '🔍');
        refreshBtn = h('button', { type: 'button', class: 'wtb-btn ghost', title: '完整检索：滚动遍历整个列表后高亮（手动刷新）' }, '↻');
        const clearBtn = h('button', { type: 'button', class: 'wtb-btn ghost', title: '清空输入框' }, '✕');
        const row2 = h('div', { class: 'wtb-row' }, [inputEl, searchBtn, refreshBtn, clearBtn]);

        /* 第 3 行：导航 */
        prevBtn = h('button', { type: 'button', class: 'wtb-btn ghost' }, '↑ 上一个');
        prevBtn.style.flex = '1';
        nextBtn = h('button', { type: 'button', class: 'wtb-btn ghost' }, '↓ 下一个');
        nextBtn.style.flex = '1';
        const row3 = h('div', { class: 'wtb-row' }, [prevBtn, nextBtn]);

        /* 第 4 行：抓取 */
        grabBtn = h('button', {
          type: 'button',
          class: 'wtb-btn ghost wtb-find-grab',
          title: '单击页面元素，将以该元素上一层 div 为根节点；抓取后点 🔍 检索，未找到再滚动遍历'
        }, '📌 抓取控件');
        grabBtn.style.flex = '1';
        cancelGrabBtn = h('button', {
          type: 'button', class: 'wtb-btn ghost',
          title: '取消本次抓取，并重新索引页面（含所有 iframe）的全部控件'
        }, '✖ 取消抓取');
        cancelGrabBtn.disabled = true;
        const row4 = h('div', { class: 'wtb-row' }, [grabBtn, cancelGrabBtn]);

        /* 内嵌历史区（参考任务模块的折叠式列表） */
        histTitleEl = h('span', { class: 'wtb-find-hist-title' }, '📜 历史记录 (0)');
        histArrowEl = h('span', { class: 'wtb-find-hist-arrow' }, '▾');

        const clearUnpinnedBtn = h('button', {
          type: 'button', class: 'wtb-find-hist-tool', title: '清空未置顶的历史'
        }, '清空未置顶');
        const clearAllBtn = h('button', {
          type: 'button', class: 'wtb-find-hist-tool', title: '清空全部历史'
        }, '清空全部');

        histHead = h('div', { class: 'wtb-find-hist-head' }, [
          histTitleEl, clearUnpinnedBtn, clearAllBtn, histArrowEl
        ]);
        histListEl = h('div', { class: 'wtb-find-hist-list' });
        histSection = h('div', { class: 'wtb-find-hist-section' }, [histHead, histListEl]);

        /* 折叠头点击：切换展开状态（避开内部按钮） */
        histHead.addEventListener('click', e => {
          if (e.target === clearUnpinnedBtn || e.target === clearAllBtn) return;
          histOpen = !histOpen;
          applyHistOpenState();
        });

        clearUnpinnedBtn.addEventListener('click', e => {
          e.stopPropagation();
          clearHistoryUnpinned();
          renderHistorySection();
        });
        clearAllBtn.addEventListener('click', e => {
          e.stopPropagation();
          try {
            if (!window.confirm('确定清空全部历史记录？')) return;
          } catch (err) {}
          clearHistoryAll();
          renderHistorySection();
        });

        statusEl = h('div', { class: 'wtb-find-status' }, '初始化中…');

        pane.appendChild(row1);
        pane.appendChild(row2);
        pane.appendChild(row3);
        pane.appendChild(row4);
        pane.appendChild(histSection);
        pane.appendChild(statusEl);

        /* --- 事件 --- */
        const syncClearBtn = () => { clearBtn.disabled = !inputEl.value; };
        syncClearBtn();

        selEl.addEventListener('change', () => {
          const sep = selEl.value.indexOf('#');
          if (sep < 0) { activeEntry = null; return; }
          const fid = selEl.value.slice(0, sep);
          const uid = selEl.value.slice(sep + 1);
          activeEntry = allContainers.find(c => c.frameId === fid && c.uid === uid) || null;
          activeCount = 0; activeTotal = 0; activeIndex = -1; activeQuery = '';
          resetAllFramesHighlight();
          updateStatus();
        });

        inputEl.addEventListener('input', () => {
          syncClearBtn();
          updateStatus();
        });

        inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const q = inputEl.value.trim();
            if (!q) return;
            if (activeQuery === q && activeCount > 0) {
              doGoto(e.shiftKey ? -1 : 1);
            } else {
              if (!activeEntry && allContainers.length) buildSelect();
              if (!activeEntry) { updateStatus(); return; }
              doSearch(q, false);
            }
          } else if (e.key === 'Escape') {
            inputEl.value = '';
            syncClearBtn();
            resetAllFramesHighlight();
            activeCount = 0; activeTotal = 0; activeIndex = -1; activeQuery = '';
            updateStatus();
          }
        });

        searchBtn.addEventListener('click', () => {
          const q = inputEl.value.trim();
          if (!q) { inputEl.focus(); return; }
          if (!activeEntry && allContainers.length) buildSelect();
          if (!activeEntry) { updateStatus(); return; }
          doSearch(q, false);
        });

        refreshBtn.addEventListener('click', () => {
          refreshSearch();
          refreshBtn.textContent = '✓';
          clearTimeout(refreshBtn._t);
          refreshBtn._t = setTimeout(() => { refreshBtn.textContent = '↻'; }, 700);
        });

        clearBtn.addEventListener('click', () => {
          inputEl.value = '';
          syncClearBtn();
          resetAllFramesHighlight();
          activeCount = 0;
          activeTotal = 0;
          activeIndex = -1;
          activeQuery = '';
          updateStatus();
          inputEl.focus();
        });

        prevBtn.addEventListener('click', () => doGoto(-1));
        nextBtn.addEventListener('click', () => doGoto(1));
        rescanBtn.addEventListener('click', rescan);

        grabBtn.addEventListener('click', () => {
          setGrabEnabled(!grabEnabled);
          updateStatus();
        });

        cancelGrabBtn.addEventListener('click', () => { cancelGrab(); });

        rescan();
        applyHistOpenState();
        renderHistorySection();
        setTimeout(() => { if (!allContainers.length) rescan(); }, 1500);
      },
      unmount() {
        clearTimeout(scanTimer);
        if (IS_TOP) setGrabEnabled(false);
        resetAllFramesHighlight();
        histSection = null;
        histHead = null;
        histListEl = null;
        histTitleEl = null;
        histArrowEl = null;
      }
    });

    /* 对外 API */
    bus.find = {
      rescan,
      search: q => doSearch(q, false),
      searchFull: q => doSearch(q, true),
      next: () => doGoto(1),
      prev: () => doGoto(-1),
      clear: () => {
        resetAllFramesHighlight();
        activeCount = 0; activeTotal = 0; activeIndex = -1; activeQuery = '';
        updateStatus();
      },
      refresh: () => refreshSearch(),
      grabMode: on => setGrabEnabled(!!on),
      cancelGrab: () => cancelGrab(),
      hasGrab: () => !!grabbedEntry,
      getHistory: () => sortHistory(loadHistory()),
      clearHistory: () => {
        clearHistoryAll();
        try { renderHistorySection(); } catch (e) {}
      }
    };
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
