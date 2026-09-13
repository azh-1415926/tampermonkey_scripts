// ==UserScript==
// @name         万里牛悬浮功能面板 - 主控端
// @namespace    https://example.com/tm-panel
// @version      1.0.0
// @description  悬浮窗面板（父页面），通过 postMessage 调用 iframe 内执行端脚本
// @author       You
// @match        https://erp.hupun.com/
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '[面板]';
    const log  = function () { console.log.apply(console,  [TAG].concat([].slice.call(arguments))); };
    const warn = function () { console.warn.apply(console, [TAG].concat([].slice.call(arguments))); };
    const err  = function () { console.error.apply(console,[TAG].concat([].slice.call(arguments))); };

    log('脚本开始执行');
    log('  URL         =', location.href);
    log('  readyState  =', document.readyState);
    log('  是顶层窗口?  =', window.self === window.top);

    /* ⚠️ 关键点 1：不用 @noframes，用运行时判断代替，更可靠 */
    if (window.self !== window.top) {
        log('当前是 iframe，主控端退出（只应在顶层运行）');
        return;
    }

    /* ============================================================
   * 通信层
   * ============================================================ */
    const CHANNEL = 'tm_panel_exec';
    const CALL_TIMEOUT = 30000;

    const executors = [];
    const pendingCalls = new Map();
    let callSeq = 0;
    let statusEl = null;

    window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;

        if (data.type === 'READY') {
            log('收到执行端 READY:', data.info);
            registerExecutor(event.source, data.info);
            try { event.source.postMessage({ __tm_channel: CHANNEL, type: 'ACK' }, '*'); } catch (e) {}
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
        const existing = executors.find(function (e) { return e.source === source; });
        if (existing) {
            existing.lastSeen = Date.now();
            if (info && info.url) existing.url = info.url;
        } else {
            executors.push({
                source: source,
                url: (info && info.url) || '',
                firstSeen: Date.now(),
                lastSeen: Date.now()
            });
        }
        updateStatus();
    }

    function pruneExecutors() {
        for (let i = executors.length - 1; i >= 0; i--) {
            let closed = false;
            try { closed = !!executors[i].source.closed; } catch (e) { closed = true; }
            if (closed) executors.splice(i, 1);
        }
        updateStatus();
    }

    function broadcastDiscover() {
        const iframes = document.querySelectorAll('iframe');
        log('广播 DISCOVER，页面 iframe 数量 =', iframes.length);
        iframes.forEach(function (el) {
            try {
                const win = el.contentWindow;
                if (win) win.postMessage({ __tm_channel: CHANNEL, type: 'DISCOVER' }, '*');
            } catch (e) {}
        });
    }

    function callExecutor(fnName, args) {
        pruneExecutors();
        if (executors.length === 0) {
            return Promise.reject(new Error('未连接执行端（iframe 未就绪）'));
        }
        const target = executors[0];
        const id = 'c' + (++callSeq) + '_' + Date.now();
        log('发送 CALL:', fnName, '参数 =', args, '→', target.url);
        return new Promise(function (resolve, reject) {
            const timer = setTimeout(function () {
                pendingCalls.delete(id);
                reject(new Error('调用超时（' + (CALL_TIMEOUT / 1000) + 's）'));
            }, CALL_TIMEOUT);
            pendingCalls.set(id, { resolve: resolve, reject: reject, timer: timer });
            try {
                target.source.postMessage({
                    __tm_channel: CHANNEL, type: 'CALL', id: id, fn: fnName, args: args || []
                }, '*');
            } catch (e) {
                clearTimeout(timer); pendingCalls.delete(id); reject(e);
            }
        });
    }

    function updateStatus() {
        if (!statusEl) return;
        const n = executors.length;
        statusEl.textContent = n === 0 ? '未连接' : ('已连接 ×' + n);
        statusEl.className = 'status ' + (n === 0 ? 'off' : 'on');
    }

    /* ============================================================
   * 面板配置
   * ============================================================ */
    const PANEL_CONFIG = [
        {
            title: '订单审核',
            open: true,
            items: [
                {
                    label: '功能1',
                    // 无输入框，三个按钮并排
                    buttons: [
                        { text: '无备注查询', fn: 'function_order_review_01' },
                        { text: '重置',  fn: 'function_order_review_01_reset' }
                    ]
                },
                {
                    label: '功能2',
                    // 一个输入框 + 两个按钮，按钮共享这个输入框
                    input: { placeholder: '请输入订单号' },
                    buttons: [
                        { text: '查询', fn: 'function_order_review_02_query' },
                        { text: '导出', fn: 'function_order_review_02_export' }
                    ]
                }
            ]
        },
        {
            title: '分组二',
            open: false,
            items: [
                {
                    label: '功能1',
                    buttons: [
                        { text: '操作A', fn: 'function_group02_01_a' },
                        { text: '操作B', fn: 'function_group02_01_b' }
                    ]
                },
                {
                    label: '功能2',
                    input: { placeholder: '请输入内容' },
                    buttons: [
                        { text: '执行', fn: 'function_group02_02' }
                    ]
                }
            ]
        },
        {
            title: '分组三',
            open: false,
            items: [
                {
                    label: '功能1',
                    buttons: [
                        { text: '执行', fn: 'function_group03_01' }
                    ]
                },
                {
                    label: '功能2',
                    input: { placeholder: '请输入内容' },
                    buttons: [
                        { text: '执行', fn: 'function_group03_02' }
                    ]
                }
            ]
        },
        {
            title: '分组四',
            open: false,
            items: [
                {
                    label: '功能1',
                    buttons: [
                        { text: '执行', fn: 'function_group04_01' }
                    ]
                },
                {
                    label: '功能2',
                    input: { placeholder: '请输入内容' },
                    buttons: [
                        { text: '执行', fn: 'function_group04_02' }
                    ]
                }
            ]
        }
    ];

    /* ============================================================
   * UI
   * ============================================================ */
    const HOST_ID = 'tm-float-panel-host';
    const STORAGE_KEY = 'tm_float_panel_pos';
    const PANEL_WIDTH = 270;

    if (document.getElementById(HOST_ID)) {
        warn('检测到已存在的面板宿主元素，脚本退出以防重复注入');
        return;
    }

    const CSS = `
    * { box-sizing: border-box; }

    /* ============ 面板主体 ============ */
    .panel {
      width: ${PANEL_WIDTH}px;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
                   "Microsoft YaHei", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      color: #2c3e50;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .18);
      overflow: hidden;
      user-select: none;
    }

    /* ============ 标题栏 ============ */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 12px;
      background: linear-gradient(135deg, #4a7dff, #3a63e8);
      color: #fff;
      font-weight: 600;
      cursor: move;
    }
    .header-left { display: flex; align-items: center; gap: 8px; }
    .header .title { font-size: 13px; letter-spacing: .5px; }

    .status {
      font-size: 11px;
      padding: 1px 7px;
      border-radius: 8px;
      font-weight: normal;
      letter-spacing: 0;
    }
    .status.off { background: rgba(255, 255, 255, .22); color: #ffe3e3; }
    .status.on  { background: rgba(70, 220, 140, .38); color: #e0ffef; }

    .header .collapse-btn {
      width: 20px;
      height: 20px;
      line-height: 18px;
      text-align: center;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background .15s;
    }
    .header .collapse-btn:hover { background: rgba(255, 255, 255, .22); }

    /* ============ 主体滚动区 ============ */
    .body {
      max-height: 72vh;
      overflow-y: auto;
      padding: 6px;
    }
    .panel.collapsed .body { display: none; }

    /* ============ 分组 ============ */
    .group {
      border: 1px solid #e6e9f0;
      border-radius: 6px;
      margin-bottom: 6px;
      overflow: hidden;
    }
    .group:last-child { margin-bottom: 0; }

    .group-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      background: #f5f7fb;
      font-weight: 600;
      color: #2c3e50;
      cursor: pointer;
      transition: background .15s;
    }
    .group-header:hover { background: #eef2fa; }

    .arrow {
      display: inline-block;
      font-size: 10px;
      color: #7a8699;
      transition: transform .18s ease;
    }
    .group.open .arrow { transform: rotate(90deg); }

    .group-body {
      display: none;
      padding: 8px 10px;
      background: #fff;
    }
    .group.open .group-body { display: block; }

    /* ============ 功能项 ============ */
    .item {
      padding: 8px 0;
      border-bottom: 1px dashed #eceff5;
    }
    .item:last-child { border-bottom: none; padding-bottom: 2px; }
    .item:first-child { padding-top: 2px; }

    .item-label {
      font-size: 12px;
      color: #5a677a;
      margin-bottom: 6px;
    }

    /* ============ 输入框行 ============ */
    .item-input-row {
      display: flex;
      margin-bottom: 8px;
    }
    .item-input-row input {
      flex: 1 1 auto;
      min-width: 0;
      padding: 6px 9px;
      border: 1px solid #d5dbe6;
      border-radius: 4px;
      font-size: 12px;
      color: #2c3e50;
      outline: none;
      user-select: text;
      transition: border-color .15s;
    }
    .item-input-row input:focus { border-color: #4a7dff; }

    /* ============ 按钮行 ============ */
    .item-btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      row-gap: 8px;
    }

    .item-btn-row .btn {
      flex: 0 0 auto;
      min-width: 56px;
      padding: 6px 14px;
      border: none;
      border-radius: 5px;
      background: #4a7dff;
      color: #fff;
      font-size: 12px;
      line-height: 1.2;
      cursor: pointer;
      white-space: nowrap;
      transition: background .15s, opacity .15s;
    }
    .item-btn-row .btn:hover  { background: #3a63e8; }
    .item-btn-row .btn:active { transform: translateY(1px); }
    .item-btn-row .btn:disabled { opacity: .55; cursor: not-allowed; }

    /* 长按钮：单独占满一行（配置里加 wide: true 生效） */
    .item-btn-row .btn-wide {
      flex: 1 1 100%;
      text-align: center;
    }

    /* ============ 轻提示 ============ */
    .toast {
      position: fixed;
      left: 50%;
      bottom: 40px;
      transform: translateX(-50%) translateY(10px);
      padding: 7px 16px;
      background: rgba(0, 0, 0, .78);
      color: #fff;
      font-size: 12px;
      border-radius: 16px;
      opacity: 0;
      pointer-events: none;
      transition: opacity .2s, transform .2s;
      white-space: nowrap;
      z-index: 9999;
      max-width: 80vw;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  `;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
        'position:fixed',
        'top:80px',
        'left:' + Math.max(10, window.innerWidth - PANEL_WIDTH - 24) + 'px',
        'z-index:2147483647'
    ].join(';');

    let shadow, toastEl;

    function tryBuild() {
        try {
            build();
            log('面板构建成功 ✓');
        } catch (e) {
            err('面板构建失败：', e);
        }
    }

    /* 等 body 就绪（MutationObserver 兜底） */
    function waitForBody(cb) {
        if (document.body) { log('body 已存在，立即构建'); cb(); return; }
        log('body 尚未就绪，等待中…');
        const obs = new MutationObserver(function () {
            if (document.body) { obs.disconnect(); cb(); }
        });
        obs.observe(document.documentElement || document, { childList: true, subtree: true });
        setTimeout(function () {
            if (document.body) { obs.disconnect(); cb(); }
            else warn('等待 body 超时，仍在尝试');
        }, 10000);
    }

    waitForBody(function () {
        document.body.appendChild(host);
        log('宿主元素已挂载到 body，id =', HOST_ID);
        tryBuild();

        /* 兜底广播 */
        setTimeout(broadcastDiscover, 500);
        setTimeout(broadcastDiscover, 2000);
        setTimeout(broadcastDiscover, 5000);
    });

    function build() {
        shadow = host.attachShadow({ mode: 'open' });

        const styleEl = document.createElement('style');
        styleEl.textContent = CSS;
        shadow.appendChild(styleEl);

        toastEl = document.createElement('div');
        toastEl.className = 'toast';

        const panel = document.createElement('div');
        panel.className = 'panel';

        const header = document.createElement('div');
        header.className = 'header';
        const headerLeft = document.createElement('div');
        headerLeft.className = 'header-left';
        const titleEl = document.createElement('span');
        titleEl.className = 'title';
        titleEl.textContent = '功能面板';
        statusEl = document.createElement('span');
        statusEl.className = 'status off';
        statusEl.textContent = '未连接';
        headerLeft.appendChild(titleEl);
        headerLeft.appendChild(statusEl);
        const collapseBtn = document.createElement('span');
        collapseBtn.className = 'collapse-btn';
        collapseBtn.textContent = '−';
        header.appendChild(headerLeft);
        header.appendChild(collapseBtn);

        const body = document.createElement('div');
        body.className = 'body';
        PANEL_CONFIG.forEach(function (g) { body.appendChild(createGroup(g)); });

        panel.appendChild(header);
        panel.appendChild(body);
        shadow.appendChild(panel);
        shadow.appendChild(toastEl);

        collapseBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            const collapsed = panel.classList.toggle('collapsed');
            collapseBtn.textContent = collapsed ? '+' : '−';
        });

        initDrag(header);
        restorePosition();
        updateStatus();
    }

    function createGroup(groupCfg) {
        const group = document.createElement('div');
        group.className = 'group' + (groupCfg.open ? ' open' : '');
        const gHeader = document.createElement('div');
        gHeader.className = 'group-header';
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '▶';
        const gTitle = document.createElement('span');
        gTitle.textContent = groupCfg.title;
        gHeader.appendChild(arrow);
        gHeader.appendChild(gTitle);
        gHeader.addEventListener('click', function () { group.classList.toggle('open'); });
        const gBody = document.createElement('div');
        gBody.className = 'group-body';
        (groupCfg.items || []).forEach(function (it) { gBody.appendChild(createItem(it)); });
        group.appendChild(gHeader);
        group.appendChild(gBody);
        return group;
    }

    function createItem(itemCfg) {
        const item = document.createElement('div');
        item.className = 'item';

        // 标签
        const label = document.createElement('div');
        label.className = 'item-label';
        label.textContent = itemCfg.label;
        item.appendChild(label);

        // 可选输入框（独占一行）
        let inputEl = null;
        if (itemCfg.input) {
            const inputRow = document.createElement('div');
            inputRow.className = 'item-input-row';
            inputEl = document.createElement('input');
            inputEl.type = 'text';
            inputEl.placeholder = itemCfg.input.placeholder || '';
            inputEl.value = itemCfg.input.value || '';
            inputRow.appendChild(inputEl);
            item.appendChild(inputRow);
        }

        // 按钮行（支持多个按钮）
        const btnRow = document.createElement('div');
        btnRow.className = 'item-btn-row';

        // 统一成数组：新格式用 itemCfg.buttons；旧格式（单个 btn/fn）自动包装
        let buttons = itemCfg.buttons;
        if (!Array.isArray(buttons)) {
            if (itemCfg.fn) {
                buttons = [{ text: itemCfg.btn || '执行', fn: itemCfg.fn }];
            } else {
                buttons = [];
            }
        }

        buttons.forEach(function (b) {
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.type = 'button';
            btn.textContent = b.text || '执行';

            btn.addEventListener('click', function () {
                // 有输入框就把输入值一起传给执行端
                const value = inputEl ? inputEl.value.trim() : undefined;
                invoke(b.fn, value, btn);
            });

            btnRow.appendChild(btn);
        });

        item.appendChild(btnRow);
        return item;
    }

    function invoke(fnName, arg, btnEl) {
        if (!fnName) { toast('未配置函数名'); return; }
        const args = (arg === undefined || arg === '') ? [] : [arg];
        const prevText = btnEl ? btnEl.textContent : '';
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
        toast('调用中：' + fnName + ' …');
        callExecutor(fnName, args)
            .then(function (result) {
            toast('✓ ' + fnName + ' 完成');
            log(fnName + ' 返回：', result);
        })
            .catch(function (e) {
            toast('✗ ' + fnName + '：' + e.message);
            err(fnName + ' 失败：', e);
        })
            .then(function () {
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = prevText || '执行'; }
        });
    }

    let toastTimer = null;
    function toast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
    }

    function initDrag(handle) {
        let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
        handle.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            if (e.target.classList && e.target.classList.contains('collapse-btn')) return;
            const rect = host.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            dragging = true;
            host.style.left = rect.left + 'px';
            host.style.top = rect.top + 'px';
            e.preventDefault();
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        });
        function onMove(e) {
            if (!dragging) return;
            const w = host.offsetWidth || PANEL_WIDTH;
            const h = host.offsetHeight || 40;
            let left = startLeft + (e.clientX - startX);
            let top = startTop + (e.clientY - startY);
            left = Math.min(Math.max(left, 0), Math.max(0, window.innerWidth - w));
            top = Math.min(Math.max(top, 0), Math.max(0, window.innerHeight - h));
            host.style.left = left + 'px';
            host.style.top = top + 'px';
            e.preventDefault();
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            savePosition();
        }
    }

    function savePosition() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                left: parseFloat(host.style.left),
                top: parseFloat(host.style.top)
            }));
        } catch (e) {}
    }

    function restorePosition() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (saved && isFinite(saved.left) && isFinite(saved.top)) {
                const w = host.offsetWidth || PANEL_WIDTH;
                const h = host.offsetHeight || 40;
                const left = Math.min(Math.max(saved.left, 0), Math.max(0, window.innerWidth - w));
                const top  = Math.min(Math.max(saved.top, 0), Math.max(0, window.innerHeight - h));
                host.style.left = left + 'px';
                host.style.top  = top + 'px';
            }
        } catch (e) {}
    }

    log('主控端脚本加载完成');
})();