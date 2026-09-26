// ==UserScript==
// @name         网页工具箱 · 万里牛面板模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      2.0.0
// @description  万里牛悬浮功能面板（移植为 WTB 模块）。保留原 postMessage 执行器通信与高亮广播；通过 bus 向其他模块暴露接口。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @run-at       document-idle
// @all-frames   true
// ==/UserScript==

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_HUPUN_MODULE__) return;

  /* 只在 hupun.com 域名生效 */
  if (!/(^|\.)hupun\.com$/i.test(location.hostname)) return;

  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus || W.__WTB_HUPUN_MODULE__) return;
    W.__WTB_HUPUN_MODULE__ = true;

    const { h } = bus;

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }

    /* ============================================================
     * 一、高亮执行器（所有 frame 都运行）
     *    原样保留 tm_table_hl 通道，不与 WTB 的 find 模块冲突
     * ============================================================ */
    const HL_CHANNEL  = 'tm_table_hl';
    const HL_CLASS    = 'tm-hl';
    const HL_ACTIVE   = 'tm-hl-active';
    const TD_SELECTOR = 'tbody td';

    let hlMatches = [];
    let hlCurrent = -1;

    function hlInjectStyle() {
      if (document.getElementById('tm-hl-style')) return;
      const s = document.createElement('style');
      s.id = 'tm-hl-style';
      s.textContent = [
        'mark.' + HL_CLASS + '{ background:#ffe066 !important; color:#000 !important;',
        '  padding:0 1px; border-radius:2px; box-shadow:0 0 0 1px rgba(0,0,0,.08); }',
        'mark.' + HL_ACTIVE + '{ background:#ff6a00 !important; color:#fff !important; }'
      ].join('\n');
      (document.head || document.documentElement).appendChild(s);
    }

    function hlClear() {
      document.querySelectorAll('mark.' + HL_CLASS).forEach(function (mark) {
        const p = mark.parentNode;
        if (!p) return;
        p.replaceChild(document.createTextNode(mark.textContent), mark);
        p.normalize();
      });
      hlMatches = [];
      hlCurrent = -1;
    }

    function hlHighlight(keyword) {
      hlClear();
      if (!keyword) return 0;
      const key    = keyword.toLowerCase();
      const keyLen = keyword.length;

      document.querySelectorAll(TD_SELECTOR).forEach(function (td) {
        const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (node.parentElement && node.parentElement.closest('mark.' + HL_CLASS))
              return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);

        nodes.forEach(function (node) {
          const text  = node.nodeValue;
          const lower = text.toLowerCase();
          let idx = lower.indexOf(key);
          if (idx === -1) return;

          const frag = document.createDocumentFragment();
          let last = 0;
          while (idx !== -1) {
            if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
            const mark = document.createElement('mark');
            mark.className   = HL_CLASS;
            mark.textContent = text.slice(idx, idx + keyLen);
            frag.appendChild(mark);
            last = idx + keyLen;
            idx  = lower.indexOf(key, last);
          }
          if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
          node.parentNode.replaceChild(frag, node);
        });
      });

      hlMatches = Array.prototype.slice.call(document.querySelectorAll('mark.' + HL_CLASS));
      hlCurrent = hlMatches.length ? 0 : -1;
      if (hlCurrent === 0) hlFocusMatch(0, false);
      return hlMatches.length;
    }

    function hlFocusMatch(index, scroll) {
      if (!hlMatches.length) return;
      hlMatches.forEach(function (m) { m.classList.remove(HL_ACTIVE); });
      hlCurrent = (index + hlMatches.length) % hlMatches.length;
      const el = hlMatches[hlCurrent];
      el.classList.add(HL_ACTIVE);
      if (scroll !== false) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    /* 监听 hl 通道（供顶层面板广播） */
    window.addEventListener('message', function (e) {
      const d = e.data;
      if (!d || typeof d !== 'object' || d.channel !== HL_CHANNEL) return;
      switch (d.action) {
        case 'search': hlHighlight(d.payload || ''); break;
        case 'clear':  hlClear(); break;
        case 'next':   hlFocusMatch(hlCurrent + 1, true); break;
        case 'prev':   hlFocusMatch(hlCurrent - 1, true); break;
      }
    });

    /* 本窗口直接可调 */
    W.__tmHighlight = {
      highlight: hlHighlight,
      clear:     hlClear,
      next:      function () { hlFocusMatch(hlCurrent + 1, true); },
      prev:      function () { hlFocusMatch(hlCurrent - 1, true); },
      state:     function () { return { total: hlMatches.length, current: hlCurrent + 1 }; }
    };

    hlInjectStyle();
    bus.log('[hupun] 高亮执行器已就绪 (' + (IS_TOP ? '顶层' : 'iframe') + ')');

    /* ============================================================
     * 二、执行器通信（仅顶层）
     * ============================================================ */
    if (!IS_TOP) return;

    const CHANNEL      = 'tm_panel_exec';
    const CALL_TIMEOUT = 30000;

    const executors    = [];
    const pendingCalls = new Map();
    let   callSeq      = 0;

    window.addEventListener('message', function (event) {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;

      if (data.type === 'READY') {
        registerExecutor(event.source, data.info);
        try { event.source.postMessage({ __tm_channel: CHANNEL, type: 'ACK' }, '*'); } catch (e) {}
        bus.emit('hupun:executor-registered', data.info);
        return;
      }
      if (data.type === 'RESULT') {
        const p = pendingCalls.get(data.id);
        if (!p) return;
        pendingCalls.delete(data.id);
        clearTimeout(p.timer);
        data.ok ? p.resolve(data.data) : p.reject(new Error(data.error || '执行端返回错误'));
      }
    });

    function registerExecutor(source, info) {
      if (!source) return;
      const name = (info && info.name) || 'default';
      const existing = executors.find(function (e) { return e.source === source; });
      if (existing) {
        existing.lastSeen = Date.now();
        existing.name = name;
        if (info && info.url) existing.url = info.url;
      } else {
        executors.push({
          source:    source,
          name:      name,
          url:       (info && info.url) || '',
          firstSeen: Date.now(),
          lastSeen:  Date.now()
        });
      }
      notifyUI();
    }

    function pruneExecutors() {
      for (let i = executors.length - 1; i >= 0; i--) {
        let closed = false;
        try { closed = !!executors[i].source.closed; } catch (e) { closed = true; }
        if (closed) executors.splice(i, 1);
      }
      notifyUI();
    }

    function broadcastDiscover() {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(function (el) {
        try {
          const win = el.contentWindow;
          if (win) win.postMessage({ __tm_channel: CHANNEL, type: 'DISCOVER' }, '*');
        } catch (e) {}
      });
    }

    function callExecutor(fnName, args, target) {
      pruneExecutors();
      let targetExec = null;

      if (target) {
        targetExec = executors.find(function (e) { return e.name === target; }) || null;
        if (!targetExec) return Promise.reject(new Error('未找到执行端：' + target));
      } else {
        targetExec = executors[0] || null;
      }
      if (!targetExec) return Promise.reject(new Error('未连接执行端（iframe 未就绪）'));

      const id = 'c' + (++callSeq) + '_' + Date.now();
      bus.emit('hupun:call', { fn: fnName, args: args, target: target });

      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pendingCalls.delete(id);
          reject(new Error('调用超时（' + (CALL_TIMEOUT / 1000) + 's）'));
        }, CALL_TIMEOUT);
        pendingCalls.set(id, { resolve: resolve, reject: reject, timer: timer });
        try {
          targetExec.source.postMessage({
            __tm_channel: CHANNEL,
            type: 'CALL',
            id: id,
            fn: fnName,
            args: args || [],
            target: target || null
          }, '*');
        } catch (e) {
          clearTimeout(timer);
          pendingCalls.delete(id);
          reject(e);
        }
      });
    }

    /* ============================================================
     * 三、面板配置（原样保留）
     * ============================================================ */
    const PANEL_CONFIG = [
      {
        title: '检索高亮',
        open: false,
        items: [
          {
            label: '文本检索',
            input: { placeholder: '输入要查找的文本…' },
            buttons: [
              { text: '搜索',     fn: '__tm_hl_search' },
              { text: '↑ 上一个', fn: '__tm_hl_prev' },
              { text: '↓ 下一个', fn: '__tm_hl_next' },
              { text: '清除',     fn: '__tm_hl_clear' }
            ]
          }
        ]
      },
      {
        title: '订单审核',
        open: false,
        items: [
          {
            label: '审单',
            buttons: [
              { text: '查询',   fn: 'function_order_review_01',                 target: 'order' },
              { text: '无标记', fn: 'function_order_review_01_empty_biaoji',    target: 'order' },
              { text: '无备注', fn: 'function_order_review_01_empty_remark',    target: 'order' },
              { text: '有标记', fn: 'function_order_review_01_not_empty_biaoji',target: 'order' },
              { text: '重置',   fn: 'function_order_review_01_reset',           target: 'order' }
            ]
          },
          {
            label: '店铺选择',
            buttons: [
              { text: '永丰',         fn: 'function_order_review_01_select_shop_yf',   target: 'order' },
              { text: '晋贤、张龙',   fn: 'function_order_review_01_select_shop_jx_zl',target: 'order' },
              { text: '曾招伟',       fn: 'function_order_review_01_select_shop_zzw',  target: 'order' },
              { text: '范婕、袁颖慧', fn: 'function_order_review_01_select_shop_fj_yyh',target: 'order' }
            ]
          },
          {
            label: '地区选择',
            buttons: [
              { text: '海南', fn: 'function_order_review_01_select_hn',       target: 'order' },
              { text: '新疆', fn: 'function_order_review_01_select_xj',       target: 'order' },
              { text: '偏远', fn: 'function_order_review_01_select_pianyuan', target: 'order' }
            ]
          }
        ]
      },
      {
        title: '打单',
        open: false,
        items: [
          {
            label: '待分配',
            buttons: [
              { text: '无单号', fn: 'function_print_pick_empty_search',     target: 'print_pick' },
              { text: '有单号', fn: 'function_print_pick_not_empty_search', target: 'print_pick' },
              { text: '重置',   fn: 'function_print_pick_reset',            target: 'print_pick' }
            ]
          },
          {
            label: '波次打单',
            selects: [
              { key: 'carrier', label: '承运商',   options: ['中通','极兔','邮政','圆通'], value: '中通' },
              { key: 'area',    label: '拣货区域', options: ['A','B','C','D','E'],         value: 'E' }
            ],
            buttons: [
              { text: '查询', fn: 'function_wave_print',       params: ['carrier','area'], target: 'print_wave' },
              { text: '清空', fn: 'function_wave_print_clear',                              target: 'print_wave' }
            ]
          }
        ]
      }
    ];

    /* ============================================================
     * 四、模块 UI
     * ============================================================ */
    const MODULE_CSS = `
      .wtb-hp-status {
        display: flex; align-items: center; gap: 6px;
        padding-bottom: 10px;
        border-bottom: 1px dashed #333a45;
        margin-bottom: 10px;
        font-size: 12px;
        color: #cfd6e4;
      }
      .wtb-hp-dot {
        width: 9px; height: 9px; border-radius: 50%;
        background: #6b7280; flex: 0 0 auto;
        transition: background .2s;
      }
      .wtb-hp-dot.on  { background: #22c55e; }
      .wtb-hp-dot.off { background: #6b7280; }
      .wtb-hp-status .count { color: #7fd3ff; font-family: Consolas, Monaco, monospace; }
      .wtb-hp-status .spacer { flex: 1 1 auto; }

      .wtb-hp-group {
        border: 1px solid #333a45;
        border-radius: 6px;
        margin-bottom: 8px;
        overflow: hidden;
      }
      .wtb-hp-group:last-child { margin-bottom: 0; }

      .wtb-hp-group-header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px;
        background: #262c36;
        cursor: pointer;
        font-weight: 600;
        color: #d8dde5;
        user-select: none;
        transition: background .15s;
      }
      .wtb-hp-group-header:hover { background: #2c333e; }

      .wtb-hp-arrow {
        font-size: 10px; color: #7a8699;
        transition: transform .18s ease;
      }
      .wtb-hp-group.open .wtb-hp-arrow { transform: rotate(90deg); }

      .wtb-hp-group-body {
        display: none;
        padding: 10px;
        background: #1a1f26;
      }
      .wtb-hp-group.open .wtb-hp-group-body { display: block; }

      .wtb-hp-item {
        padding: 8px 0;
        border-bottom: 1px dashed #2c333e;
      }
      .wtb-hp-item:last-child { border-bottom: none; padding-bottom: 2px; }
      .wtb-hp-item:first-child { padding-top: 2px; }

      .wtb-hp-item-label {
        font-size: 11.5px; color: #8b94a3;
        margin-bottom: 6px;
      }

      .wtb-hp-input-row { display: flex; margin-bottom: 8px; }
      .wtb-hp-input-row input {
        flex: 1 1 auto; min-width: 0;
        padding: 5px 9px;
        background: #161a20; color: #e6e8eb;
        border: 1px solid #333a45; border-radius: 4px;
        font-size: 12px; outline: none;
        transition: border-color .15s;
      }
      .wtb-hp-input-row input:focus { border-color: #2b6cff; }

      .wtb-hp-select-row {
        display: flex; gap: 8px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .wtb-hp-select-row .wrap {
        flex: 1 1 0; min-width: 0;
        display: flex; flex-direction: column; gap: 3px;
      }
      .wtb-hp-select-row label {
        font-size: 10.5px; color: #6f7a8c;
        padding-left: 2px;
      }
      .wtb-hp-select-row select {
        width: 100%;
        padding: 5px 8px;
        background: #161a20; color: #e6e8eb;
        border: 1px solid #333a45; border-radius: 4px;
        font-size: 12px; outline: none;
        cursor: pointer;
      }
      .wtb-hp-select-row select:focus { border-color: #2b6cff; }

      .wtb-hp-btn-row {
        display: flex; flex-wrap: wrap;
        gap: 8px; row-gap: 8px;
      }
      .wtb-hp-btn-row .wtb-btn {
        flex: 0 0 auto;
        padding: 5px 12px;
        white-space: nowrap;
      }
      .wtb-hp-btn-row .wtb-btn-wide {
        flex: 1 1 100%;
        text-align: center;
      }
    `;

    let ctxRef      = null;
    let statusDotEl = null;
    let statusCntEl = null;
    let mountPaneEl = null;

    function notifyUI() {
      if (!ctxRef) return;
      if (statusDotEl) {
        statusDotEl.classList.toggle('on',  executors.length > 0);
        statusDotEl.classList.toggle('off', executors.length === 0);
      }
      if (statusCntEl) {
        statusCntEl.textContent = executors.length === 0
          ? '未连接'
          : ('已连接 ×' + executors.length);
      }
    }

    function toast(msg) {
      if (ctxRef) ctxRef.toast(msg);
    }

    /* -------- 分组 / 条目渲染 -------- */
    function createGroup(groupCfg) {
      const group = h('div', { class: 'wtb-hp-group' + (groupCfg.open ? ' open' : '') });
      const header = h('div', { class: 'wtb-hp-group-header' }, [
        h('span', { class: 'wtb-hp-arrow' }, '▶'),
        h('span', {}, groupCfg.title)
      ]);
      header.addEventListener('click', () => group.classList.toggle('open'));

      const body = h('div', { class: 'wtb-hp-group-body' });
      (groupCfg.items || []).forEach(it => body.appendChild(createItem(it)));

      group.appendChild(header);
      group.appendChild(body);
      return group;
    }

    function createItem(itemCfg) {
      const item = h('div', { class: 'wtb-hp-item' });
      item.appendChild(h('div', { class: 'wtb-hp-item-label' }, itemCfg.label));

      /* 输入框 */
      let inputEl = null;
      if (itemCfg.input) {
        inputEl = h('input', { type: 'text', placeholder: itemCfg.input.placeholder || '', value: itemCfg.input.value || '' });
        item.appendChild(h('div', { class: 'wtb-hp-input-row' }, [inputEl]));
      }

      /* 下拉框 */
      const selectEls = {};
      if (Array.isArray(itemCfg.selects) && itemCfg.selects.length) {
        const row = h('div', { class: 'wtb-hp-select-row' });
        itemCfg.selects.forEach(sc => {
          const wrap = h('div', { class: 'wrap' });
          if (sc.label) wrap.appendChild(h('label', {}, sc.label));
          const sel = h('select');
          (sc.options || []).forEach(opt => {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            sel.appendChild(o);
          });
          if (sc.value) sel.value = sc.value;
          selectEls[sc.key] = sel;
          wrap.appendChild(sel);
          row.appendChild(wrap);
        });
        item.appendChild(row);
      }

      /* 按钮行 */
      const btnRow = h('div', { class: 'wtb-hp-btn-row' });
      let buttons = itemCfg.buttons;
      if (!Array.isArray(buttons)) {
        buttons = itemCfg.fn ? [{ text: itemCfg.btn || '执行', fn: itemCfg.fn }] : [];
      }
      buttons.forEach(b => {
        const btn = h('button', { class: 'wtb-btn' + (b.wide ? ' wtb-btn-wide' : '') }, b.text || '执行');
        btn.addEventListener('click', () => {
          let args = [];
          if (Array.isArray(b.params) && b.params.length) {
            args = b.params.map(k => {
              const el = selectEls[k];
              return el ? el.value : '';
            });
          } else if (inputEl) {
            const v = inputEl.value.trim();
            if (v !== '') args = [v];
          }
          invoke(b.fn, args, btn, b.target);
        });
        btnRow.appendChild(btn);
      });
      item.appendChild(btnRow);
      return item;
    }

    /* -------- 调用分发 -------- */
    function invoke(fnName, args, btnEl, target) {
      if (!fnName) { toast('未配置函数名'); return; }
      args = Array.isArray(args) ? args : (args === undefined ? [] : [args]);

      /* 高亮：本地 + 广播 */
      if (fnName.indexOf('__tm_hl_') === 0) {
        handleHighlightCall(fnName, args);
        return;
      }

      const prevText = btnEl ? btnEl.textContent : '';
      if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
      toast('调用中：' + fnName + ' …');

      callExecutor(fnName, args, target)
        .then(result => {
          toast('✓ ' + fnName + ' 完成');
          bus.emit('hupun:call-done', { fn: fnName, target, result });
        })
        .catch(error => {
          toast('✗ ' + fnName + '：' + (error && error.message ? error.message : String(error)));
          bus.emit('hupun:call-error', { fn: fnName, target, error: String(error) });
        })
        .then(() => {
          if (btnEl) { btnEl.disabled = false; btnEl.textContent = prevText || '执行'; }
        });
    }

    /* -------- 高亮指令 -------- */
    function handleHighlightCall(fnName, args) {
      const api = W.__tmHighlight;
      if (!api) { toast('高亮模块未就绪'); return; }

      function broadcast(action, payload) {
        const msg = { channel: HL_CHANNEL, action: action, payload: payload };
        document.querySelectorAll('iframe').forEach(f => {
          try {
            if (f.contentWindow) f.contentWindow.postMessage(msg, '*');
          } catch (e) {}
        });
      }

      switch (fnName) {
        case '__tm_hl_search': {
          const k = (args && args[0]) || '';
          if (!k) { toast('请输入关键词'); return; }
          api.highlight(k);
          broadcast('search', k);
          toast('已标记高亮');
          break;
        }
        case '__tm_hl_next':
          api.next(); broadcast('next'); break;
        case '__tm_hl_prev':
          api.prev(); broadcast('prev'); break;
        case '__tm_hl_clear':
          api.clear(); broadcast('clear');
          toast('已清除高亮'); break;
      }
    }

    /* ============================================================
     * 五、注册 WTB 模块
     * ============================================================ */
    bus.registerModule({
      id: 'hupun',
      title: '万里牛',
      icon: '🏢',
      order: 50,
      mount(ctx) {
        ctxRef = ctx;
        ctx.addStyle(MODULE_CSS);
        const pane = ctx.pane;
        pane.innerHTML = '';
        mountPaneEl = pane;

        /* 状态行 */
        statusDotEl = h('div', { class: 'wtb-hp-dot off' });
        statusCntEl = h('span', { class: 'count' }, '未连接');
        const refreshBtn = h('button', { class: 'wtb-btn ghost', style: 'padding:3px 10px;font-size:11px;' }, '重新发现');
        refreshBtn.addEventListener('click', () => {
          broadcastDiscover();
          toast('已广播 DISCOVER');
        });

        const statusRow = h('div', { class: 'wtb-hp-status' }, [
          statusDotEl,
          statusCntEl,
          h('span', { class: 'spacer' }),
          refreshBtn
        ]);
        pane.appendChild(statusRow);

        /* 分组 */
        PANEL_CONFIG.forEach(g => pane.appendChild(createGroup(g)));

        notifyUI();

        /* 进入模块时兜底广播一次 */
        setTimeout(broadcastDiscover, 300);
        setTimeout(broadcastDiscover, 2000);
      },
      unmount() {
        // 面板卸载时不断开，保持与执行端的连接（关闭面板后按钮仍可被 bus 调用）
        ctxRef = null;
      },
      onActivate() {
        // 每次切到该 tab 时重新发现执行端
        broadcastDiscover();
      }
    });

    /* ============================================================
     * 六、通过 bus 向其他模块暴露接口
     * ============================================================ */
    bus.hupun = {
      /* 调用执行端 */
      call: (fn, args, target) => callExecutor(fn, args || [], target),
      /* 广播指令让 iframe 执行 */
      discover: broadcastDiscover,
      /* 执行器列表 */
      executors: () => executors.map(e => ({ name: e.name, url: e.url, firstSeen: e.firstSeen, lastSeen: e.lastSeen })),
      /* 高亮相关 */
      highlight: {
        search: k => {
          const api = W.__tmHighlight;
          if (api) api.highlight(k);
          document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow && f.contentWindow.postMessage({ channel: HL_CHANNEL, action: 'search', payload: k }, '*'); } catch (e) {}
          });
        },
        next: () => {
          const api = W.__tmHighlight;
          if (api) api.next();
          document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow && f.contentWindow.postMessage({ channel: HL_CHANNEL, action: 'next' }, '*'); } catch (e) {}
          });
        },
        prev: () => {
          const api = W.__tmHighlight;
          if (api) api.prev();
          document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow && f.contentWindow.postMessage({ channel: HL_CHANNEL, action: 'prev' }, '*'); } catch (e) {}
          });
        },
        clear: () => {
          const api = W.__tmHighlight;
          if (api) api.clear();
          document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow && f.contentWindow.postMessage({ channel: HL_CHANNEL, action: 'clear' }, '*'); } catch (e) {}
          });
        },
        state: () => {
          const api = W.__tmHighlight;
          return api ? api.state() : { total: 0, current: 0 };
        }
      }
    };

    /* 也可以注册成外部命令，让 cpp-bridge 直接调用 */
    if (bus.commands) {
      bus.commands.register('hupun.executor.list', {
        description: '列出万里牛面板已连接的执行端',
        handler() { return bus.hupun.executors(); }
      });
      bus.commands.register('hupun.call', {
        description: '调用万里牛面板某执行端函数',
        params: { fn: 'string', args: 'array?', target: 'string?' },
        handler(args) {
          if (!args || !args.fn) return Promise.reject(new Error('missing fn'));
          return callExecutor(args.fn, args.args || [], args.target);
        }
      });
      bus.commands.register('hupun.highlight.search', {
        description: '万里牛面板：高亮关键词',
        params: { keyword: 'string' },
        handler(args) {
          if (!args || !args.keyword) return false;
          bus.hupun.highlight.search(args.keyword);
          return true;
        }
      });
      bus.commands.register('hupun.highlight.next', {
        description: '万里牛面板：下一个高亮',
        handler() { bus.hupun.highlight.next(); return true; }
      });
      bus.commands.register('hupun.highlight.prev', {
        description: '万里牛面板：上一个高亮',
        handler() { bus.hupun.highlight.prev(); return true; }
      });
      bus.commands.register('hupun.highlight.clear', {
        description: '万里牛面板：清除高亮',
        handler() { bus.hupun.highlight.clear(); return true; }
      });
      bus.commands.register('hupun.discover', {
        description: '万里牛面板：广播 DISCOVER 重新发现执行端',
        handler() { broadcastDiscover(); return true; }
      });
    }

    /* 监听 WTB 拾取模块的结果，转给 hupun 执行端（可选联动） */
    bus.on('pick:result', info => {
      bus.emit('hupun:pick-shared', {
        css:   info.css,
        xpath: info.xpath,
        url:   info.url
      });
    });

    bus.log('[hupun] 模块注册完成');
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
