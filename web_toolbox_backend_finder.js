// ==UserScript==
// @name         网页工具箱 · 查找模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.2
// @description  跨 iframe 文本检索高亮；拾取式抓取，抓取时以元素祖先链上最近的 div 为根节点，纳入根节点内全部文本。依赖内核 wtb-core。
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
    const DEBOUNCE  = 180;
    const MAX_DIV_TEXT = 8000;

    let styleInjected = false;
    let localContainers = [];
    let localMarks = [];
    let localCurrentIndex = -1;

    /* 抓取注册表：uid -> { el: 根节点, label }（本 frame 内） */
    const localGrabbed = new Map();

    /* ============ 0. 容器稳定 ID ============ */
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
      const onlyA = (kind === 'all-links') ? true :
                    (kind === 'div-links') ? true : false;
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

    /* ============ 4. 抓取模式（拾取式） ============ */
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

    /**
     * 计算抓取根节点：
     *   从元素自身向上找第一个 div 祖先（不包含 body/html）。
     *   - 若找到 → 该 div 为根
     *   - 若找不到 → 退回元素自身
     * 注意：如果元素本身就是 div，则取它更上一层的 div（"上一层div"）。
     */
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
      // 直接高亮最终的"根节点"，所见即所得
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

      // 拾取式反馈：单击后立即显示根节点高亮
      showHighlight(root, ev);

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
      // 抓取完成后自动退出抓取模式（与拾取一致）
      setGrabEnabled(false);
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

    /* ============ 6. 消息与状态 ============ */
    let allContainers = [];
    let activeEntry = null;
    let activeCount = 0;
    let activeIndex = -1;
    let searchTimer = null;
    let scanTimer = null;
    let filterKeyword = '';

    const KIND_LABELS = {
      grabbed: '已抓取根节点',
      struct: '表格 列表',
      'div-links': '链接容器 div',
      'text-block': '文本 div',
      'all-links': '其他 a 标签'
    };
    const KIND_SHOW = {
      grabbed: '已抓取根',
      struct: '表格 / 列表',
      'div-links': '链接容器 div',
      'text-block': '文本 div',
      'all-links': '其他'
    };

    let selEl = null, inputEl = null, filterEl = null,
        prevBtn = null, nextBtn = null, statusEl = null, onlyAEl = null,
        grabBtn = null;

    /* 顶层持有的单一抓取项 */
    let grabbedEntry = null;

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
      refreshSelectionAndSearch();
    }

    function updateStatus() {
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
      if (!activeCount) { statusEl.innerHTML = '未找到匹配项' + scope; return; }
      statusEl.innerHTML = '匹配 <b>' + activeCount + '</b> 项 ｜ 当前第 <b>' + (activeIndex + 1) + '</b> 项' +
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

      const kw = filterKeyword.trim().toLowerCase();
      if (kw) {
        filtered = filtered.filter(c => {
          const haystack = (c.label + ' ' + (c.frameLabel || '') + ' ' + (KIND_LABELS[c.kind] || '')).toLowerCase();
          return haystack.indexOf(kw) > -1;
        });
      }

      if (!filtered.length) {
        const o = document.createElement('option');
        if (grabActive() && !kw) o.textContent = '已抓取的控件暂不可用';
        else o.textContent = '没有匹配「' + (filterKeyword || '') + '」的选项';
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

    function doSearch(query) {
      resetAllFramesHighlight();
      activeCount = 0;
      activeIndex = -1;
      if (!activeEntry || !query) { updateStatus(); return; }

      if (activeEntry.frameId === FRAME_ID) {
        const c = findLocalContainerByUid(activeEntry.uid);
        const count = runSearchLocal(c, query);
        activeCount = count > 0 ? count : 0;
        activeIndex = localCurrentIndex;
        updateStatus();
      } else {
        broadcastToChildren({
          [MSG_TAG]: true, type: 'find/run',
          frameId: activeEntry.frameId,
          containerUid: activeEntry.uid,
          query: query
        });
        updateStatus();
      }
    }

    function doGoto(delta) {
      if (!activeEntry || !activeCount) return;
      const newIndex = ((activeIndex + delta) % activeCount + activeCount) % activeCount;
      if (activeEntry.frameId === FRAME_ID) {
        goToLocal(newIndex);
        activeIndex = localCurrentIndex;
        updateStatus();
      } else {
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
      if (r && r.changed && activeEntry) {
        if (q) doSearch(q);
        else { resetAllFramesHighlight(); updateStatus(); }
      } else {
        updateStatus();
      }
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
        const q = inputEl ? inputEl.value.trim() : '';
        if (q) doSearch(q);
        else updateStatus();
      }, 500);
    }

    function handleMessage(d) {
      if (!IS_TOP) {
        if (d.type === 'find/scan' || d.type === 'find/clear' ||
            d.type === 'find/run'  || d.type === 'find/goto' ||
            d.type === 'find/grab-toggle') {
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

      if (d.type === 'find/grab-toggle') {
        setGrabEnabled(d.enabled, true);
        return;
      }

      if (d.type === 'find/run' && d.frameId === FRAME_ID) {
        let c = d.containerUid ? findLocalContainerByUid(d.containerUid) : null;
        if (!c && typeof d.containerIdx === 'number') c = localContainers[d.containerIdx];
        if (!c) return;
        const count = runSearchLocal(c, d.query);
        toTop({
          [MSG_TAG]: true, type: 'find/run-result',
          frameId: FRAME_ID,
          count: count > 0 ? count : 0,
          currentIndex: localCurrentIndex
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
            allContainers.push({
              frameId: d.frameId, frameLabel: d.frameLabel,
              idx: c.idx, uid: c.uid, kind: c.kind, label: c.label
            });
          }
        } else if (d.type === 'find/run-result' || d.type === 'find/goto-result') {
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

    /* ============ 7. 初始化（所有 frame） ============ */
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

        filterEl  = h('input', { type: 'text', placeholder: '🔎 过滤下拉框选项（名称 / 类别 / 来源）' });
        const rescanBtn = h('button', { class: 'wtb-btn ghost', title: '重新扫描' }, '⟳');
        const row1 = h('div', { class: 'wtb-row' }, [filterEl, rescanBtn]);

        selEl = h('select');
        selEl.style.flex = '1';
        const row2 = h('div', { class: 'wtb-row' }, [selEl]);

        inputEl = h('input', { type: 'text', placeholder: '输入要检索的文本，回车切换下一项' });
        inputEl.style.flex = '1';
        const clearBtn = h('button', { class: 'wtb-btn ghost', title: '清空输入框' }, '✕');
        const row3 = h('div', { class: 'wtb-row' }, [inputEl, clearBtn]);

        prevBtn = h('button', { class: 'wtb-btn ghost' }, '↑ 上一个');
        prevBtn.style.flex = '1';
        nextBtn = h('button', { class: 'wtb-btn ghost' }, '↓ 下一个');
        nextBtn.style.flex = '1';
        const row4 = h('div', { class: 'wtb-row' }, [prevBtn, nextBtn]);

        grabBtn = h('button', {
          class: 'wtb-btn ghost wtb-find-grab',
          title: '单击页面元素，将以该元素上一层 div 为根节点，根节点内全部文本纳入检索范围'
        }, '📌 抓取控件');
        grabBtn.style.flex = '1';
        const row5 = h('div', { class: 'wtb-row' }, [grabBtn]);

        onlyAEl = h('input', { type: 'checkbox', checked: true });
        const row6 = h('div', { class: 'wtb-row' }, [
          h('label', { class: 'wtb-switch', title: '仅对“链接容器 div”这一类别生效' }, [
            onlyAEl, h('span', { class: 'track' }),
            h('span', {}, '链接容器 div 仅检索链接文本')
          ])
        ]);

        statusEl = h('div', { class: 'wtb-find-status' }, '初始化中…');

        pane.appendChild(row1);
        pane.appendChild(row2);
        pane.appendChild(row3);
        pane.appendChild(row4);
        pane.appendChild(row5);
        pane.appendChild(row6);
        pane.appendChild(statusEl);

        const syncClearBtn = () => { clearBtn.disabled = !inputEl.value; };
        syncClearBtn();

        filterEl.addEventListener('input', () => {
          filterKeyword = filterEl.value;
          const r = buildSelect();
          if (r && r.changed && activeEntry) {
            const q = inputEl.value.trim();
            if (q) doSearch(q);
            else { resetAllFramesHighlight(); updateStatus(); }
          } else updateStatus();
        });
        filterEl.addEventListener('keydown', e => {
          if (e.key === 'Escape') {
            if (filterEl.value) {
              filterEl.value = ''; filterKeyword = '';
              buildSelect(); updateStatus();
            } else filterEl.blur();
            e.stopPropagation();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            inputEl.focus(); inputEl.select();
          }
        });

        selEl.addEventListener('change', () => {
          const sep = selEl.value.indexOf('#');
          if (sep < 0) { activeEntry = null; return; }
          const fid = selEl.value.slice(0, sep);
          const uid = selEl.value.slice(sep + 1);
          activeEntry = allContainers.find(c => c.frameId === fid && c.uid === uid) || null;
          activeCount = 0; activeIndex = -1;
          const q = inputEl.value.trim();
          if (q) doSearch(q);
          else { resetAllFramesHighlight(); updateStatus(); }
        });

        inputEl.addEventListener('input', () => {
          syncClearBtn();
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => doSearch(inputEl.value.trim()), DEBOUNCE);
        });
        inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(searchTimer);
            const q = inputEl.value.trim();
            if (!activeCount) doSearch(q);
            else doGoto(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            inputEl.value = '';
            syncClearBtn();
            clearTimeout(searchTimer);
            resetAllFramesHighlight();
            activeCount = 0; activeIndex = -1;
            updateStatus();
          }
        });

        clearBtn.addEventListener('click', () => {
          inputEl.value = '';
          syncClearBtn();
          clearTimeout(searchTimer);
          resetAllFramesHighlight();
          activeCount = 0;
          activeIndex = -1;
          updateStatus();
          inputEl.focus();
        });

        prevBtn.addEventListener('click', () => doGoto(-1));
        nextBtn.addEventListener('click', () => doGoto(1));
        rescanBtn.addEventListener('click', rescan);
        onlyAEl.addEventListener('change', () => {
          const q = inputEl.value.trim();
          if (q) doSearch(q);
          else { resetAllFramesHighlight(); updateStatus(); }
        });

        /* 抓取按钮：进入/退出抓取模式 */
        grabBtn.addEventListener('click', () => {
          setGrabEnabled(!grabEnabled);
          updateStatus();
        });

        rescan();
        setTimeout(() => { if (!allContainers.length) rescan(); }, 1500);
      },
      unmount() {
        clearTimeout(searchTimer);
        clearTimeout(scanTimer);
        if (IS_TOP) setGrabEnabled(false);
        resetAllFramesHighlight();
      }
    });

    /* 对外 API */
    bus.find = {
      rescan,
      search: q => doSearch(q),
      next: () => doGoto(1),
      prev: () => doGoto(-1),
      clear: () => { resetAllFramesHighlight(); activeCount = 0; activeIndex = -1; updateStatus(); },
      grabMode: on => setGrabEnabled(!!on),
      hasGrab: () => !!grabbedEntry
    };
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
