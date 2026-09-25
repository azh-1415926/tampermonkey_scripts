// ==UserScript==
// @name         悬浮功能面板 - 待分配执行端
// @namespace    https://example.com/tm-panel
// @version      1.0.0
// @description  在"待分配" iframe 内运行，接收主控端 postMessage 并执行无单号 / 有单号 / 重置
// @author       You
// @match        https://wms-vt.hupun.com/wms/waveWait*
// @match        https://wms-v.hupun.com/wms/waveWait*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (window.self === window.top) return;

    const CHANNEL = 'tm_panel_exec';
    const SELF_NAME = 'print_pick';

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ============================================================
     * 工具函数
     * ============================================================ */

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        if (el.offsetParent === null) {
            // fixed 元素的 offsetParent 也是 null
            const st = getComputedStyle(el);
            if (st.position !== 'fixed') return false;
        }
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        return true;
    }

    /** 派发完整鼠标事件（Element UI 通常监听 mousedown/click） */
    function fireClick(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
        const rect = el.getBoundingClientRect();
        const opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: rect.left + Math.max(1, rect.width) / 2,
            clientY: rect.top + Math.max(1, rect.height) / 2,
            button: 0
        };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
    }

    /** 轮询等待 */
    async function waitFor(fn, timeout = 5000, interval = 80) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const r = fn();
                if (r) return r;
            } catch (e) {}
            await sleep(interval);
        }
        return null;
    }

    /** 通过按钮文字找按钮（去掉空白后比对） */
    function findButton(text) {
        const want = String(text).replace(/\s/g, '');
        const btns = document.querySelectorAll('button.el-button');
        for (const b of btns) {
            const t = (b.textContent || '').replace(/\s/g, '');
            if (t === want) return b;
        }
        return null;
    }

    /** 在 condFormItem 里找指定 label 的表单项 */
    function findCondItem(labelText) {
        const want = String(labelText).replace(/[:：\s]/g, '');
        const labels = document.querySelectorAll('label.condLabel');
        for (const l of labels) {
            const t = (l.textContent || '').replace(/[:：\s]/g, '');
            if (t === want) {
                return l.closest('.condFormItem');
            }
        }
        return null;
    }

    /* ============================================================
     * 一、业务动作
     * ============================================================ */

    /** 点重置 */
    async function actionReset() {
        const btn = await waitFor(() => findButton('重置'), 5000, 80);
        if (!btn) throw new Error('找不到【重置】按钮');
        fireClick(btn);
        await sleep(300);
        console.log('[待分配] ✔ 已点击【重置】');
    }

    /** 点查询 */
    async function actionSearch() {
        const btn = await waitFor(() => findButton('查询'), 5000, 80);
        if (!btn) throw new Error('找不到【查询】按钮');
        fireClick(btn);
        await sleep(300);
        console.log('[待分配] ✔ 已点击【查询】');
    }

    /** 选择运单号的下拉：有单号 / 无单号 */
    async function actionSelectWaybill(optionText) {
        // 找运单号表单项
        const item = await waitFor(() => findCondItem('运单号'), 5000, 80);
        if (!item) throw new Error('找不到【运单号】表单项');

        // 里面的 el-select（第一个）
        const selectEl = item.querySelector('.el-select');
        if (!selectEl) throw new Error('运单号表单项里找不到 el-select');

        // 点开下拉：优先点 input
        const trigger = selectEl.querySelector('.el-input__inner')
        || selectEl.querySelector('.el-input')
        || selectEl;
        fireClick(trigger);

        // 等待下拉可见
        const li = await waitFor(() => {
            // 先看组件内的
            const local = selectEl.querySelector('.el-select-dropdown');
            if (local && isVisible(local)) {
                const found = findLiByText(local, optionText);
                if (found) return found;
            }
            // 全局查找（append-to-body 的情况）
            const dropdowns = document.querySelectorAll('.el-select-dropdown');
            for (const d of dropdowns) {
                if (!isVisible(d)) continue;
                const found = findLiByText(d, optionText);
                if (found) return found;
            }
            return null;
        }, 3000, 80);

        if (!li) throw new Error(`运单号下拉里找不到选项【${optionText}】`);
        fireClick(li);
        await sleep(300);
        console.log(`[待分配] ✔ 已选择【${optionText}】`);
    }

    function findLiByText(root, text) {
        const want = String(text).replace(/\s/g, '');
        const lis = root.querySelectorAll('li.el-select-dropdown__item, li');
        for (const li of lis) {
            const t = (li.textContent || '').replace(/\s/g, '');
            if (t === want) return li;
        }
        return null;
    }

    /**
     * 勾选全部项（多策略 + 状态校验 + 逐行兜底）
     * ★ 所有查找限定在 .mainTable 作用域内，避免误伤平台店铺等弹窗里的表格
     */
    /**
     * 只点击主表格表头的【全选】按钮
     * ★ 全部查找限定在 .mainTable 作用域内，不会误伤平台店铺等弹窗
     * ★ 不做逐行勾选，选项多也瞬间完成
     */
        /**
     * 勾选全部项：两步走
     *   1) 点击主表格表头 .my-vxetable-check-box 弹出下拉菜单
     *   2) 点下拉菜单里的"全选"
     * ★ 全部查找限定在 .mainTable 作用域内，不碰平台店铺等弹窗
     */
    /**
     * 勾选全部项：两步走
     *   1) 点击主表格表头 .my-vxetable-check-box 弹出下拉菜单
     *   2) 点下拉菜单里的"全选"
     * ★ 全部查找限定在 .mainTable 作用域内，不碰平台店铺等弹窗
     */
    async function actionSelectAll() {
        console.log('[待分配] ▶ 点击主表格表头全选按钮');

        // ---------- 主表格作用域 ----------
        const scope = await waitFor(() =>
            document.querySelector('.mainTable .myTable') ||
            document.querySelector('.mainTable') ||
            document.querySelector('.myTable')
        , 4000, 100);

        if (!scope) {
            console.warn('[待分配] 未找到主表格作用域 .mainTable');
            return false;
        }
        console.log('[待分配] 主表格作用域已锁定');

        // ---------- 找表头全选按钮 ----------
        const findHeaderBox = () => {
            const sels = [
                '.my-vxetable-check-box',
                '.my-vxetable-el-icon-check'
            ];
            for (const sel of sels) {
                const list = scope.querySelectorAll(sel);
                for (const c of list) {
                    if (c.closest('thead') && isVisible(c)) return c;
                }
            }
            return null;
        };

        const headerBox = await waitFor(findHeaderBox, 4000, 100);
        if (!headerBox) {
            console.warn('[待分配] 未找到表头全选按钮');
            return false;
        }
        console.log('[待分配] 找到表头全选按钮:', headerBox);

        // ---------- 关闭可能残留的下拉 ----------
        document.body.click();
        await sleep(100);

        // ---------- 点击表头按钮，弹出下拉菜单 ----------
        fireClick(headerBox);
        await sleep(250);

        // 若下拉没弹出，再点一次父级容器
        let menu = document.querySelector('._contains');
        if (!menu || !isVisible(menu)) {
            const parent = headerBox.closest('.my-vxetable-check-box');
            if (parent && parent !== headerBox) {
                fireClick(parent);
                await sleep(250);
            }
        }

        // ---------- 等下拉菜单出现，并点击"全选" ----------
        const selectAllItem = await waitFor(() => {
            // 下拉菜单容器：class="_contains"，里面有 .title 三项
            const containers = document.querySelectorAll('._contains');
            for (const c of containers) {
                if (!isVisible(c)) continue;
                const titles = [...c.querySelectorAll('.title')];
                if (titles.length < 3) continue;
                const texts = titles.map(el => (el.textContent || '').trim());
                // 精确判断：必须同时含"全选、全不选、反选"
                if (texts.includes('全选') && texts.includes('全不选') && texts.includes('反选')) {
                    return titles.find(el => (el.textContent || '').trim() === '全选');
                }
            }
            return null;
        }, 2500, 80);

        if (!selectAllItem) {
            console.warn('[待分配] 未找到下拉菜单【全选】项');
            return false;
        }

        console.log('[待分配] 找到下拉菜单【全选】项:', selectAllItem);
        fireClick(selectAllItem);
        await sleep(300);

        // ---------- 关闭下拉菜单 ----------
        document.body.click();
        await sleep(150);

        console.log('[待分配] ✔ 已点击【全选】');
        return true;
    }

    /* ============================================================
     * 二、业务函数区
     * ============================================================ */

    async function function_print_pick_empty_search() {
        console.log('[待分配执行端] 无单号查询');

        await actionReset();
        await actionSelectWaybill('无单号');
        await actionSearch();

        // 等主表格 body 里出现行（确保数据渲染完）
        await waitFor(() => {
            const trs = document.querySelectorAll('.mainTable .vxe-table--body-wrapper tbody tr');
            return trs.length > 0 ? true : null;
        }, 5000, 150);

        // 只点表头全选按钮
        await actionSelectAll();

        return { ok: true, action: 'empty_search' };
    }

    async function function_print_pick_not_empty_search() {
        console.log('[待分配执行端] 有单号查询');

        await actionReset();
        await actionSelectWaybill('有单号');
        await actionSearch();

        return { ok: true, action: 'not_empty_search' };
    }

    async function function_print_pick_reset() {
        console.log('[待分配执行端] 重置');

        await actionReset();

        return { ok: true, action: 'reset' };
    }

    const FUNC_MAP = {
        function_print_pick_empty_search:     function_print_pick_empty_search,
        function_print_pick_not_empty_search: function_print_pick_not_empty_search,
        function_print_pick_reset:            function_print_pick_reset
    };

    /* ============================================================
     * 三、消息处理
     * ============================================================ */

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;

        const data = event.data;
        if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;

        if (data.type === 'ACK')      { acked = true; return; }
        if (data.type === 'DISCOVER') { acked = false; sendReady(); return; }
        if (data.type === 'CALL') {
            if (data.target && data.target !== SELF_NAME) return;
            handleCall(data, event.source);
        }
    });

    function handleCall(data, source) {
        const id = data.id;
        const fnName = data.fn;
        const args = Array.isArray(data.args) ? data.args : [];

        const fn = FUNC_MAP[fnName];
        if (typeof fn !== 'function') {
            reply(source, { id: id, ok: false, error: '待分配执行端未找到函数：' + fnName });
            return;
        }

        Promise.resolve()
            .then(function () { return fn.apply(null, args); })
            .then(function (result) { reply(source, { id: id, ok: true, data: result }); })
            .catch(function (e) {
            reply(source, { id: id, ok: false, error: (e && e.message) || String(e) });
        });
    }

    function reply(source, payload) {
        if (!source) return;
        try {
            source.postMessage(Object.assign({
                __tm_channel: CHANNEL,
                type: 'RESULT',
                from: SELF_NAME
            }, payload), '*');
        } catch (e) {}
    }

    /* ============================================================
     * 四、向父窗口注册
     * ============================================================ */

    let acked = false;
    let registerTimer = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 20;
    const INTERVAL = 1500;

    function sendReady() {
        if (acked) return;
        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL,
                type: 'READY',
                info: {
                    name: SELF_NAME,
                    url: location.href,
                    title: document.title,
                    ts: Date.now()
                }
            }, '*');
        } catch (e) {}
    }

    function startRegisterLoop() {
        sendReady();
        registerTimer = setInterval(function () {
            if (acked || attempts++ >= MAX_ATTEMPTS) {
                clearInterval(registerTimer);
                registerTimer = null;
                return;
            }
            sendReady();
        }, INTERVAL);
    }

    startRegisterLoop();

})();
