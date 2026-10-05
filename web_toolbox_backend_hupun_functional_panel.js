// ==UserScript==
// @name         网页工具箱 · 万里牛面板模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      2.1.0
// @description  万里牛悬浮功能面板（移植为 WTB 模块）。主界面仅提供骨架与控件渲染，实际功能与控件配置由各执行端通过 READY.info.panelConfig 上报。
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
         * 一、执行器通信（仅顶层）
         * ============================================================ */
        if (!IS_TOP) return;

        const CHANNEL        = 'tm_panel_exec';
        const CALL_TIMEOUT   = 30000;
        const FRESH_WINDOW   = 10000;   /* 10s 内注册的视为“新连接” */
        const PRUNE_INTERVAL = 2000;    /* 每 2s 巡检一次执行端连接 */

        const executors    = [];
        const pendingCalls = new Map();
        let   callSeq      = 0;
        let   pruneTimer   = null;

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
            const panelConfig = (info && Array.isArray(info.panelConfig)) ? info.panelConfig : null;

            const existing = executors.find(function (e) { return e.source === source; });
            if (existing) {
                existing.lastSeen = Date.now();
                existing.name     = name;
                if (info && info.url) existing.url = info.url;
                if (panelConfig)      existing.panelConfig = panelConfig;
            } else {
                executors.push({
                    source:      source,
                    name:        name,
                    url:         (info && info.url) || '',
                    panelConfig: panelConfig || [],
                    firstSeen:   Date.now(),
                    lastSeen:    Date.now()
                });
            }
            pruneExecutors();   /* READY 时顺手清理一下旧引用 */
            notifyUI();
        }

        /* -------- 判断单个执行端是否仍存活 -------- */
        function isExecutorAlive(exec) {
            const src = exec.source;
            if (!src) return false;

            try {
                if (src.closed === true) return false;
            } catch (e) {
                return false;
            }

            try {
                const fe = src.frameElement;
                if (fe === null) {
                    if (src !== window) return false;
                } else if (fe && !document.contains(fe)) {
                    return false;
                }
            } catch (e) { /* 跨域：仅依赖 closed */ }

            return true;
        }

        function pruneExecutors() {
            let changed = false;
            for (let i = executors.length - 1; i >= 0; i--) {
                if (!isExecutorAlive(executors[i])) {
                    executors.splice(i, 1);
                    changed = true;
                }
            }
            if (changed) notifyUI();
            return changed;
        }

        function startPruneLoop() {
            if (pruneTimer) return;
            pruneTimer = setInterval(function () {
                pruneExecutors();
                if (ctxRef && execListEl && execListEl.classList.contains('open')) {
                    refreshExecDetail();
                }
            }, PRUNE_INTERVAL);
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
                    targetExec.lastSeen = Date.now();
                    refreshExecDetail();
                } catch (e) {
                    clearTimeout(timer);
                    pendingCalls.delete(id);
                    reject(e);
                }
            });
        }

        /* ============================================================
         * 二、模块 UI（仅骨架 + 通用控件渲染）
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

      .wtb-hp-detail-toggle {
        cursor: pointer; font-size: 11px; color: #8b94a3;
        user-select: none; padding: 1px 4px; border-radius: 3px;
        transition: color .15s, background .15s;
      }
      .wtb-hp-detail-toggle:hover { color: #7fd3ff; background: #232a34; }
      .wtb-hp-detail-toggle.disabled {
        opacity: .4; cursor: default; pointer-events: none;
      }

      .wtb-hp-exec-list {
        display: none;
        margin-bottom: 10px;
        border: 1px solid #333a45;
        border-radius: 6px;
        background: #161a20;
        max-height: 260px;
        overflow-y: auto;
      }
      .wtb-hp-exec-list.open { display: block; }

      .wtb-hp-exec-item {
        padding: 8px 10px;
        border-bottom: 1px dashed #2c333e;
        font-size: 11.5px;
      }
      .wtb-hp-exec-item:last-child { border-bottom: none; }

      .wtb-hp-exec-name {
        display: flex; align-items: center; gap: 6px;
        color: #d8dde5; font-weight: 600;
        margin-bottom: 3px;
      }
      .wtb-hp-exec-name .fresh {
        width: 6px; height: 6px; border-radius: 50%;
        background: #22c55e; flex: 0 0 auto;
        animation: wtb-hp-pulse 1.2s ease-in-out infinite;
      }
      @keyframes wtb-hp-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%      { opacity: .35; transform: scale(.8); }
      }

      .wtb-hp-exec-badge {
        display: inline-block;
        padding: 0 6px;
        font-size: 10px;
        line-height: 16px;
        border-radius: 3px;
        background: #2b6cff; color: #fff;
        font-weight: 500;
      }
      .wtb-hp-exec-badge.ghost {
        background: transparent;
        border: 1px solid #3a4454;
        color: #8b94a3;
      }

      .wtb-hp-exec-url {
        color: #7a8699;
        word-break: break-all;
        line-height: 1.45;
        margin-bottom: 3px;
      }

      .wtb-hp-exec-meta {
        display: flex; gap: 12px; flex-wrap: wrap;
        color: #6f7a8c;
        font-size: 10.5px;
        font-family: Consolas, Monaco, monospace;
      }
      .wtb-hp-exec-meta .k { color: #5c6675; }

      .wtb-hp-empty {
        padding: 24px 12px;
        text-align: center;
        color: #6f7a8c;
        font-size: 12px;
        border: 1px dashed #333a45;
        border-radius: 6px;
        background: #161a20;
      }

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

      .wtb-hp-input-row {
        display: flex; margin-bottom: 8px; gap: 8px;
        align-items: flex-start;
      }
      .wtb-hp-input-row .wtb-hp-field-label {
        flex: 0 0 60px;
        padding-top: 6px;
        font-size: 11.5px;
        color: #8b94a3;
      }
      .wtb-hp-input-row input,
      .wtb-hp-input-row textarea {
        flex: 1 1 auto; min-width: 0;
        padding: 5px 9px;
        background: #161a20; color: #e6e8eb;
        border: 1px solid #333a45; border-radius: 4px;
        font-size: 12px; outline: none;
        transition: border-color .15s;
        font-family: inherit;
        resize: vertical;
      }
      .wtb-hp-input-row textarea { min-height: 60px; line-height: 1.4; }
      .wtb-hp-input-row input:focus,
      .wtb-hp-input-row textarea:focus { border-color: #2b6cff; }

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

        let ctxRef         = null;
        let statusDotEl    = null;
        let statusCntEl    = null;
        let detailToggleEl = null;
        let execListEl     = null;
        let mountPaneEl    = null;
        let groupsWrapEl   = null;

        /* 记录分组展开状态（跨重渲染保留） */
        const groupOpenState = new Map(); /* key: groupTitle -> boolean */

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
            if (detailToggleEl) {
                detailToggleEl.classList.toggle('disabled', executors.length === 0);
                if (executors.length === 0) {
                    detailToggleEl.textContent = '详情';
                    if (execListEl) execListEl.classList.remove('open');
                }
            }
            renderExecList();
            renderPanels();
        }

        function refreshExecDetail() {
            renderExecList();
        }

        function pad2(n) { return n < 10 ? '0' + n : '' + n; }

        function formatTime(ts) {
            const d = new Date(ts);
            return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
        }

        function formatAgo(ts) {
            const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
            if (sec < 5)    return '刚刚';
            if (sec < 60)   return sec + ' 秒前';
            if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
            return Math.floor(sec / 3600) + ' 小时前';
        }

        function renderExecList() {
            if (!execListEl) return;
            execListEl.innerHTML = '';

            if (!executors.length) {
                const empty = h('div', { class: 'wtb-hp-exec-item', style: 'text-align:center;color:#6f7a8c;padding:14px 10px;' }, '暂无已连接执行端');
                execListEl.appendChild(empty);
                return;
            }

            const now = Date.now();
            executors.forEach(function (e, idx) {
                const isFresh = (now - e.firstSeen) < FRESH_WINDOW;

                const item = h('div', { class: 'wtb-hp-exec-item' });

                const nameRow = h('div', { class: 'wtb-hp-exec-name' });
                if (isFresh) nameRow.appendChild(h('span', { class: 'fresh' }));
                nameRow.appendChild(h('span', {}, e.name));
                nameRow.appendChild(h('span', { class: 'wtb-hp-exec-badge' }, '#' + (idx + 1)));
                if (isFresh) nameRow.appendChild(h('span', { class: 'wtb-hp-exec-badge ghost' }, 'NEW'));
                item.appendChild(nameRow);

                if (e.url) {
                    item.appendChild(h('div', { class: 'wtb-hp-exec-url' }, e.url));
                }

                const meta = h('div', { class: 'wtb-hp-exec-meta' }, [
                    h('span', {}, [h('span', { class: 'k' }, '首次 '), formatTime(e.firstSeen)]),
                    h('span', {}, [h('span', { class: 'k' }, '最近 '), formatAgo(e.lastSeen)])
                ]);
                item.appendChild(meta);

                execListEl.appendChild(item);
            });
        }

        /* -------- 动态面板渲染：从执行端上报的 panelConfig 聚合分组 -------- */
        function renderPanels() {
            if (!groupsWrapEl) return;
            groupsWrapEl.innerHTML = '';

            /* key: 分组标题；value: { title, open, items: [{ itemCfg, execName }] } */
            const groupMap = new Map();
            let hasAny = false;

            executors.forEach(function (exec) {
                const list = Array.isArray(exec.panelConfig) ? exec.panelConfig : [];
                list.forEach(function (groupCfg) {
                    if (!groupCfg || !groupCfg.title) return;
                    hasAny = true;
                    const key = groupCfg.title;
                    if (!groupMap.has(key)) {
                        groupMap.set(key, {
                            title: groupCfg.title,
                            open:  !!groupCfg.open,
                            items: []
                        });
                    }
                    const g = groupMap.get(key);
                    (groupCfg.items || []).forEach(function (itemCfg) {
                        g.items.push({ itemCfg: itemCfg, execName: exec.name });
                    });
                });
            });

            if (!hasAny) {
                groupsWrapEl.appendChild(
                    h('div', { class: 'wtb-hp-empty' }, '等待执行端连接…')
                );
                return;
            }

            groupMap.forEach(function (g) {
                groupsWrapEl.appendChild(createGroup(g));
            });
        }

        function toast(msg) {
            if (ctxRef) ctxRef.toast(msg);
        }

        /* -------- 分组 / 条目渲染 -------- */
        function createGroup(g) {
            const key    = g.title;
            const isOpen = groupOpenState.has(key) ? groupOpenState.get(key) : !!g.open;

            const group = h('div', { class: 'wtb-hp-group' + (isOpen ? ' open' : '') });
            const header = h('div', { class: 'wtb-hp-group-header' }, [
                h('span', { class: 'wtb-hp-arrow' }, '▶'),
                h('span', {}, g.title)
            ]);
            header.addEventListener('click', function () {
                groupOpenState.set(key, group.classList.toggle('open'));
            });

            const body = h('div', { class: 'wtb-hp-group-body' });
            g.items.forEach(function (entry) {
                body.appendChild(createItem(entry.itemCfg, entry.execName));
            });

            group.appendChild(header);
            group.appendChild(body);
            return group;
        }

        function createItem(itemCfg, execName) {
            const item = h('div', { class: 'wtb-hp-item' });
            item.appendChild(h('div', { class: 'wtb-hp-item-label' }, itemCfg.label));

            /** key -> 控件元素。旧的单 input 用 __defaultInput 作为 key */
            const fieldEls = {};

            /* -------- 旧式单输入（兼容） -------- */
            if (itemCfg.input) {
                const inputEl = h('input', {
                    type: 'text',
                    placeholder: itemCfg.input.placeholder || '',
                    value: itemCfg.input.value || ''
                });
                item.appendChild(h('div', { class: 'wtb-hp-input-row' }, [inputEl]));
                fieldEls.__defaultInput = inputEl;
            }

            /* -------- 多单行输入 -------- */
            if (Array.isArray(itemCfg.inputs) && itemCfg.inputs.length) {
                itemCfg.inputs.forEach(function (ic) {
                    const wrap = h('div', { class: 'wtb-hp-input-row' });
                    if (ic.label) wrap.appendChild(h('span', { class: 'wtb-hp-field-label' }, ic.label));
                    const inputEl = h('input', {
                        type: 'text',
                        placeholder: ic.placeholder || '',
                        value: ic.value || ''
                    });
                    fieldEls[ic.key] = inputEl;
                    wrap.appendChild(inputEl);
                    item.appendChild(wrap);
                });
            }

            /* -------- 多行输入 -------- */
            if (Array.isArray(itemCfg.textareas) && itemCfg.textareas.length) {
                itemCfg.textareas.forEach(function (tc) {
                    const wrap = h('div', { class: 'wtb-hp-input-row' });
                    if (tc.label) wrap.appendChild(h('span', { class: 'wtb-hp-field-label' }, tc.label));
                    const ta = document.createElement('textarea');
                    ta.placeholder = tc.placeholder || '';
                    ta.rows = tc.rows || 3;
                    ta.value = tc.value || '';
                    fieldEls[tc.key] = ta;
                    wrap.appendChild(ta);
                    item.appendChild(wrap);
                });
            }

            /* -------- 下拉 -------- */
            if (Array.isArray(itemCfg.selects) && itemCfg.selects.length) {
                const row = h('div', { class: 'wtb-hp-select-row' });
                itemCfg.selects.forEach(function (sc) {
                    const wrap = h('div', { class: 'wrap' });
                    if (sc.label) wrap.appendChild(h('label', {}, sc.label));
                    const sel = h('select');
                    (sc.options || []).forEach(function (opt) {
                        const o = document.createElement('option');
                        o.value = opt; o.textContent = opt;
                        sel.appendChild(o);
                    });
                    if (sc.value) sel.value = sc.value;
                    fieldEls[sc.key] = sel;
                    wrap.appendChild(sel);
                    row.appendChild(wrap);
                });
                item.appendChild(row);
            }

            /* -------- 按钮 -------- */
            const btnRow = h('div', { class: 'wtb-hp-btn-row' });
            let buttons = itemCfg.buttons;
            if (!Array.isArray(buttons)) {
                buttons = itemCfg.fn ? [{ text: itemCfg.btn || '执行', fn: itemCfg.fn }] : [];
            }
            buttons.forEach(function (b) {
                const btn = h('button', { class: 'wtb-btn' + (b.wide ? ' wtb-btn-wide' : '') }, b.text || '执行');
                btn.addEventListener('click', function () {
                    let args = [];
                    if (Array.isArray(b.params) && b.params.length) {
                        if (b.asObject) {
                            const obj = {};
                            b.params.forEach(function (k) {
                                const el = fieldEls[k];
                                obj[k] = el ? String(el.value).trim() : '';
                            });
                            args = [obj];
                        } else {
                            args = b.params.map(function (k) {
                                const el = fieldEls[k];
                                return el ? String(el.value).trim() : '';
                            });
                        }
                    } else if (fieldEls.__defaultInput) {
                        const v = fieldEls.__defaultInput.value.trim();
                        if (v !== '') args = [v];
                    }
                    /* 关键：未显式指定 target 时，使用上报该配置的执行端名称 */
                    const target = b.target || execName;
                    invoke(b.fn, args, btn, target);
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

            const prevText = btnEl ? btnEl.textContent : '';
            if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
            toast('调用中：' + fnName + ' …');

            callExecutor(fnName, args, target)
                .then(function (result) {
                    toast('✓ ' + fnName + ' 完成');
                    bus.emit('hupun:call-done', { fn: fnName, target: target, result: result });
                })
                .catch(function (error) {
                    toast('✗ ' + fnName + '：' + (error && error.message ? error.message : String(error)));
                    bus.emit('hupun:call-error', { fn: fnName, target: target, error: String(error) });
                })
                .then(function () {
                    if (btnEl) { btnEl.disabled = false; btnEl.textContent = prevText || '执行'; }
                });
        }

        /* ============================================================
         * 四、注册 WTB 模块
         * ============================================================ */
        bus.registerModule({
            id: 'hupun',
            title: '万里牛',
            icon: '🏢',
            order: 50,
            mount: function (ctx) {
                ctxRef = ctx;
                ctx.addStyle(MODULE_CSS);
                const pane = ctx.pane;
                pane.innerHTML = '';
                mountPaneEl = pane;

                statusDotEl = h('div', { class: 'wtb-hp-dot off' });
                statusCntEl = h('span', { class: 'count' }, '未连接');

                detailToggleEl = h('span', { class: 'wtb-hp-detail-toggle disabled' }, '详情');
                detailToggleEl.addEventListener('click', function () {
                    if (!executors.length) return;
                    const open = execListEl.classList.toggle('open');
                    detailToggleEl.textContent = open ? '详情 ▴' : '详情 ▾';
                    if (open) renderExecList();
                });

                const statusRow = h('div', { class: 'wtb-hp-status' }, [
                    statusDotEl,
                    statusCntEl,
                    detailToggleEl
                ]);
                pane.appendChild(statusRow);

                execListEl = h('div', { class: 'wtb-hp-exec-list' });
                pane.appendChild(execListEl);

                /* 动态分组容器 */
                groupsWrapEl = h('div', { class: 'wtb-hp-groups' });
                pane.appendChild(groupsWrapEl);

                notifyUI();
            },
            unmount: function () {
                ctxRef = null;
            },
            onActivate: function () {
                pruneExecutors();
                refreshExecDetail();
                renderPanels();
            }
        });

        /* ============================================================
         * 五、通过 bus 向其他模块暴露接口
         * ============================================================ */
        bus.hupun = {
            call: function (fn, args, target) { return callExecutor(fn, args || [], target); },
            executors: function () {
                return executors.map(function (e) {
                    return { name: e.name, url: e.url, firstSeen: e.firstSeen, lastSeen: e.lastSeen };
                });
            },
            prune: pruneExecutors
        };

        if (bus.commands) {
            bus.commands.register('hupun.executor.list', {
                description: '列出万里牛面板已连接的执行端',
                handler: function () { return bus.hupun.executors(); }
            });
            bus.commands.register('hupun.call', {
                description: '调用万里牛面板某执行端函数',
                params: { fn: 'string', args: 'array?', target: 'string?' },
                handler: function (args) {
                    if (!args || !args.fn) return Promise.reject(new Error('missing fn'));
                    return callExecutor(args.fn, args.args || [], args.target);
                }
            });
            bus.commands.register('hupun.prune', {
                description: '万里牛面板：手动清理失效执行端',
                handler: function () { return pruneExecutors(); }
            });
        }

        bus.on('pick:result', function (info) {
            bus.emit('hupun:pick-shared', {
                css:   info.css,
                xpath: info.xpath,
                url:   info.url
            });
        });

        startPruneLoop();
        bus.log('[hupun] 模块注册完成');
    }

    if (W.__WTB_BUS__) init();
    else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
