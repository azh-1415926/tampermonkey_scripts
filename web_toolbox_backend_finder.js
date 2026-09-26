// ==UserScript==
// @name         网页工具箱 · 查找模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.1
// @description  跨 iframe 文本检索高亮。依赖内核 wtb-core。
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
    const { h } = bus;

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
        result.push({ el, kind: 'struct' });
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
        divCandidates.push({ el: d, kind: 'div-links' });
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
        textBlocks.push({ el, kind: 'text-block' });
      });
      textBlocks.sort(byDocOrder);
      textBlocks.forEach(c => result.push(c));

      if (document.querySelectorAll('a').length) {
        result.push({ el: null, kind: 'all-links' });
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

    /* ============ 4. 跨 frame 通讯 ============ */
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

    /* ============ 5. 消息处理 ============ */
    let allContainers = [];   // 仅顶层用
    let activeEntry = null;
    let activeCount = 0;
    let activeIndex = -1;
    let searchTimer = null;
    let scanTimer = null;
    let filterKeyword = '';

    const KIND_LABELS = {
      struct: '表格 列表', 'div-links': '链接容器 div',
      'text-block': '文本 div', 'all-links': '其他 a 标签'
    };
    const KIND_SHOW = {
      struct: '表格 / 列表', 'div-links': '链接容器 div',
      'text-block': '文本 div', 'all-links': '其他'
    };

    /* -------- 顶层 UI 引用 -------- */
    let selEl = null, inputEl = null, filterEl = null,
        prevBtn = null, nextBtn = null, statusEl = null, onlyAEl = null;

    function updateStatus() {
      if (!statusEl) return;
      if (!allContainers.length) {
        statusEl.textContent = '未找到可检索控件（表格 / 列表 / 链接 div / 文本 div）';
        return;
      }
      if (!activeEntry) {
        statusEl.textContent = '请先在下拉框中选择一个容器';
        return;
      }
      const q = inputEl ? inputEl.value.trim() : '';
      if (!q) { statusEl.textContent = '输入文本开始检索'; return; }
      if (!activeCount) { statusEl.textContent = '未找到匹配项'; return; }
      statusEl.innerHTML = '匹配 <b>' + activeCount + '</b> 项 ｜ 当前第 <b>' + (activeIndex + 1) + '</b> 项' +
        ' ｜ 来源：' + activeEntry.frameLabel;
    }

    function buildSelect() {
      if (!selEl) return;
      selEl.innerHTML = '';
      if (!allContainers.length) {
        const o = document.createElement('option');
        o.textContent = '未找到可检索控件';
        selEl.appendChild(o);
        selEl.disabled = true;
        activeEntry = null;
        return;
      }
      selEl.disabled = false;

      const kw = filterKeyword.trim().toLowerCase();
      let filtered = allContainers;
      if (kw) {
        filtered = allContainers.filter(c => {
          const haystack = (c.label + ' ' + (c.frameLabel || '') + ' ' + (KIND_LABELS[c.kind] || '')).toLowerCase();
          return haystack.indexOf(kw) > -1;
        });
      }
      if (!filtered.length) {
        const o = document.createElement('option');
        o.textContent = '没有匹配「' + filterKeyword + '」的选项';
        selEl.appendChild(o);
        selEl.disabled = true;
        return;
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

      for (const fid of frameIds) {
        const group = byFrame.get(fid);
        const kindGroups = { struct: [], 'div-links': [], 'text-block': [], 'all-links': [] };
        for (const item of group.items) (kindGroups[item.kind] || kindGroups.struct).push(item);
        for (const kind of ['struct','div-links','text-block','all-links']) {
          const list = kindGroups[kind];
          if (!list.length) continue;
          const og = document.createElement('optgroup');
          const short = group.label.length > 30 ? group.label.slice(0, 30) + '…' : group.label;
          og.label = '[' + short + '] ' + KIND_SHOW[kind] + ' (' + list.length + ')';
          for (const item of list) {
            const o = document.createElement('option');
            o.value = item.frameId + '#' + item.idx;
            o.textContent = item.label;
            og.appendChild(o);
          }
          selEl.appendChild(og);
        }
      }

      let pickValue = null;
      if (activeEntry) {
        const v = activeEntry.frameId + '#' + activeEntry.idx;
        for (const opt of selEl.querySelectorAll('option')) if (opt.value === v) { pickValue = v; break; }
      }
      if (!pickValue) {
        const first = selEl.querySelector('option');
        if (first) pickValue = first.value;
      }
      const prevEntry = activeEntry;
      if (pickValue) {
        selEl.value = pickValue;
        const [fid, idx] = pickValue.split('#');
        activeEntry = allContainers.find(c => c.frameId === fid && c.idx === Number(idx)) || null;
      }
      return { changed: prevEntry !== activeEntry };
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
        const c = localContainers[activeEntry.idx];
        const count = runSearchLocal(c, query);
        activeCount = count > 0 ? count : 0;
        activeIndex = localCurrentIndex;
        updateStatus();
      } else {
        broadcastToChildren({
          [MSG_TAG]: true, type: 'find/run',
          frameId: activeEntry.frameId,
          containerIdx: activeEntry.idx,
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

    function rescan() {
      localContainers = scanContainers();
      allContainers = localContainers.map((c, i) => ({
        frameId: FRAME_ID,
        frameLabel: getFrameLabel(),
        idx: i, kind: c.kind, label: labelFor(c, i)
      }));
      broadcastToChildren({ [MSG_TAG]: true, type: 'find/scan' });
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
            d.type === 'find/run'  || d.type === 'find/goto') {
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
            containers: list.map((c, i) => ({ idx: i, kind: c.kind, label: labelFor(c, i) }))
          });
        }
        return;
      }

      if (d.type === 'find/clear') { clearMarks(); return; }

      if (d.type === 'find/run' && d.frameId === FRAME_ID) {
        const c = localContainers[d.containerIdx];
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
              idx: c.idx, kind: c.kind, label: c.label
            });
          }
        } else if (d.type === 'find/run-result' || d.type === 'find/goto-result') {
          if (activeEntry && activeEntry.frameId === d.frameId) {
            activeCount = d.count;
            activeIndex = d.currentIndex;
            updateStatus();
          }
        }
      }
    }

    window.addEventListener('message', e => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d[MSG_TAG] !== true) return;
      if (typeof d.type !== 'string' || d.type.indexOf('find/') !== 0) return;
      handleMessage(d);
    }, false);

    /* ============ 6. 初始化（所有 frame） ============ */
    injectStyle();
    localContainers = scanContainers();

    /* ============ 7. 顶层 UI 模块 ============ */
    if (!IS_TOP) return;

    const MODULE_CSS = `
      .wtb-find-status { font-size: 12px; color: #9aa6bb; margin-top: 8px; word-break: break-all; }
      .wtb-find-status b { color: #ffd166; font-weight: 600; }
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

        onlyAEl = h('input', { type: 'checkbox', checked: true });
        const row5 = h('div', { class: 'wtb-row' }, [
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
          const [fid, idx] = selEl.value.split('#');
          activeEntry = allContainers.find(c => c.frameId === fid && c.idx === Number(idx)) || null;
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

        rescan();
        setTimeout(() => { if (!allContainers.length) rescan(); }, 1500);
      },
      unmount() {
        clearTimeout(searchTimer);
        clearTimeout(scanTimer);
        resetAllFramesHighlight();
      }
    });

    /* 对外 API */
    bus.find = {
      rescan,
      search: q => doSearch(q),
      next: () => doGoto(1),
      prev: () => doGoto(-1),
      clear: () => { resetAllFramesHighlight(); activeCount = 0; activeIndex = -1; updateStatus(); }
    };
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
