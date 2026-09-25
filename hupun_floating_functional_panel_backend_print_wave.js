// ==UserScript==
// @name         悬浮功能面板 - 波次打单执行端
// @namespace    https://example.com/tm-panel
// @version      1.0.0
// @description  在"波次打单" iframe 内运行，接收主控端 postMessage 并按承运商 / 拣货区域执行波次（含每页500条设置，极速版）
// @author       You
// @match        https://wms-t.hupun.com/url.d*
// @match        https://wms.hupun.com/url.d*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (window.self === window.top) return;

    const CHANNEL = 'tm_panel_exec';
    const SELF_NAME = 'print_wave';

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $ = (sel) => { try { return document.querySelector(sel); } catch (e) { return null; } };
    const $$ = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch (e) { return []; } };

    async function waitFor(fn, timeout = 15000, interval = 60) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try { const r = fn(); if (r) return r; } catch (e) {}
            await sleep(interval);
        }
        return null;
    }

    /* ============================================================
     * 0. 拣货区域额外勾选配置
     * 选 A 时，除了匹配 "[区域]货架A区"，还要额外勾选这些文本的节点
     * ============================================================ */
    const AREA_EXTRA_TEXTS = {
        A: ['货架区']
    };

    /* ============================================================
     * 一、dorado 专用点击工具
     * ============================================================ */

    function doradoClick(el) {
        if (!el || !el.isConnected) return false;
        try {
            const rect = el.getBoundingClientRect();
            const x = rect.left + Math.max(1, rect.width) / 2;
            const y = rect.top + Math.max(1, rect.height) / 2;
            const base = { bubbles: true, cancelable: true, view: window, button: 0, detail: 1 };
            el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('mouseup',   { ...base, buttons: 0, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('click',     { ...base, buttons: 0, clientX: x, clientY: y }));
            return true;
        } catch (e) {
            try { el.click(); return true; } catch (e2) { return false; }
        }
    }

    function doradoClickSmart(el, depth = 3) {
        let cur = el, i = 0;
        while (cur && i < depth) {
            if (doradoClick(cur)) {
                if (i > 0) console.log(`[doradoClickSmart] 在祖先第 ${i} 级命中`);
                return true;
            }
            cur = cur.parentElement;
            i++;
        }
        return false;
    }

    function fullPointerClick(el) {
        if (!el || !el.isConnected) return;
        const rect = el.getBoundingClientRect();
        const x = rect.left + Math.max(1, rect.width) / 2;
        const y = rect.top + Math.max(1, rect.height) / 2;
        const base = { bubbles: true, cancelable: true, view: window, button: 0, detail: 1 };
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
        } catch (e) {}
        el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, clientX: x, clientY: y }));
        try {
            el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
        } catch (e) {}
        el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, clientX: x, clientY: y }));
    }

    /* ============================================================
     * 二、dorado checkbox 专用操作
     * ============================================================ */

    function getDoradoWidget(el) {
        if (!el) return null;
        if (el._widget) return el._widget;
        if (el.__widget__) return el.__widget__;
        if (el.widget) return el.widget;
        if (window.jQuery) {
            try {
                const w = window.jQuery(el).data('widget');
                if (w) return w;
            } catch (e) {}
        }
        let p = el.parentElement, i = 0;
        while (p && i < 3) {
            if (p._widget) return p._widget;
            if (p.__widget__) return p.__widget__;
            p = p.parentElement;
            i++;
        }
        return null;
    }

    function isDCheckboxChecked(cb) {
        if (!cb) return false;
        if (cb.classList.contains('d-checkbox-checked')) return true;
        if (cb.classList.contains('d-checkbox-unchecked')) return false;
        if (cb.classList.contains('d-checkbox-indeterminate')) return 'indeterminate';
        const icon = cb.querySelector('.icon');
        if (icon) {
            if (icon.classList.contains('checked')) return true;
            if (icon.classList.contains('unchecked')) return false;
            if (icon.classList.contains('indeterminate')) return 'indeterminate';
        }
        return false;
    }

    async function clickDCheckbox(cb) {
        if (!cb) return false;
        const before = isDCheckboxChecked(cb);

        // 策略 1：dorado widget API
        const w = getDoradoWidget(cb);
        if (w) {
            try {
                if (typeof w.set === 'function') {
                    w.set('checked', !before);
                    await sleep(20);
                    if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略1(widget.set) 生效'); return true; }
                }
                if (typeof w.toggle === 'function') {
                    w.toggle();
                    await sleep(20);
                    if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略1b(widget.toggle) 生效'); return true; }
                }
                if (typeof w.click === 'function') {
                    w.click();
                    await sleep(20);
                    if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略1c(widget.click) 生效'); return true; }
                }
            } catch (e) { console.warn('[clickDCheckbox] widget API 异常', e); }
        }

        // 策略 2：jQuery trigger
        if (window.jQuery) {
            try {
                const $cb = window.jQuery(cb);
                $cb.trigger('mousedown').trigger('mouseup').trigger('click');
                await sleep(20);
                if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略2(jQuery) 生效'); return true; }
            } catch (e) {}
        }

        // 策略 3：pointer + mouse 完整序列
        const candidates = [cb, cb.querySelector('.icon'), cb.querySelector('.caption')].filter(Boolean);
        for (const t of candidates) {
            fullPointerClick(t);
            await sleep(20);
            if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略3(pointer+mouse) 生效'); return true; }
        }

        // 策略 4：聚焦 + 键盘 Space
        try {
            cb.focus();
            cb.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ', code: 'Space', keyCode: 32, which: 32 }));
            cb.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ', code: 'Space', keyCode: 32, which: 32 }));
            await sleep(20);
            if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略4(Keyboard Space) 生效'); return true; }
        } catch (e) {}

        console.warn('[clickDCheckbox] ⚠ 所有策略均未生效');
        return false;
    }

    /* ============================================================
     * 三、写值
     * ============================================================ */

    function setInputValue(input, value) {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    }

    /* ============================================================
     * 四、每页显示条数设为 500
     * ============================================================ */

    async function setPageSizeTo500() {
        console.log('[setPageSize] ▶ 设置每页显示条数为 500');
        const TARGET = 500;

        // 策略 1：widget API —— editorPageSize.set("value", 500)
        if (window.view && typeof window.view.get === 'function') {
            try {
                const editor = window.view.get("#editorPageSize");
                if (editor && typeof editor.set === 'function') {
                    const cur = (typeof editor.get === 'function') ? editor.get("value") : null;
                    if (String(cur) === String(TARGET)) {
                        console.log('[setPageSize] 已经是 500，跳过');
                        return true;
                    }
                    editor.set("value", TARGET);
                    console.log('[setPageSize] ✔ 通过 widget.set("#editorPageSize", 500) 设置');
                    await sleep(20);
                    return true;
                }
            } catch (e) { console.warn('[setPageSize] editorPageSize API 异常', e); }
        }

        // 策略 2：直接设置 dsWave.pageSize
        if (window.view && typeof window.view.get === 'function') {
            try {
                const ds = window.view.get("#dsWave");
                if (ds && typeof ds.set === 'function') {
                    ds.set("pageSize", TARGET);
                    console.log('[setPageSize] ✔ 通过 widget.set("#dsWave.pageSize", 500) 设置');
                    await sleep(20);
                    return true;
                }
            } catch (e) { console.warn('[setPageSize] dsWave API 异常', e); }
        }

        // 策略 3：操作 DOM —— 打开下拉选 500
        const editorEl = $('#d_editorPageSize');
        if (!editorEl) { console.warn('[setPageSize] 未找到 #d_editorPageSize'); return false; }

        const trigger = editorEl.querySelector('.d-icon-button.d-trigger')
        || editorEl.querySelector('.d-trigger-icon-drop');
        if (trigger) {
            doradoClickSmart(trigger, 3);
            // 轮询等待下拉项出现
            const target = await waitFor(() => {
                const options = $$('.d-list-item, li, .d-list-dropdown-item, .d-dropdown-item');
                for (const o of options) {
                    if (!o.isConnected) continue;
                    if (o.getClientRects().length === 0) continue;
                    if ((o.textContent || '').trim() === String(TARGET)) return o;
                }
                return null;
            }, 20, 60);

            if (target) {
                doradoClickSmart(target, 2);
                await sleep(20);
                console.log('[setPageSize] ✔ 通过下拉选择 500');
                return true;
            }
            console.warn('[setPageSize] 下拉里未找到 500 选项，尝试关闭下拉');
            document.body.click();
            await sleep(20);
        }

        // 策略 4：直接给 input 写值
        const input = editorEl.querySelector('input.editor') || editorEl.querySelector('input');
        if (input) {
            try {
                const hadReadonly = input.hasAttribute('readonly');
                if (hadReadonly) input.removeAttribute('readonly');
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                setter.call(input, String(TARGET));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
                if (hadReadonly) input.setAttribute('readonly', 'readonly');
                console.log('[setPageSize] ✔ 通过 DOM 写入 500');
                await sleep(20);
                return true;
            } catch (e) { console.warn('[setPageSize] DOM 写入失败', e); }
        }

        console.warn('[setPageSize] ⚠ 所有策略均未生效');
        return false;
    }

    /* ============================================================
     * 五、承运商
     * ============================================================ */

    function findCarrierTrigger() {
        return $('#d__uid_1277')
        || $('#d__uid_747 .d-icon-button.d-trigger')
        || $('#d__uid_747 .d-trigger-icon-drop')?.closest('.d-icon-button.d-trigger')
        || null;
    }

    function findCarrierPanel() {
        const grid = $('#d_gridDeliveryMultiFuzz');
        if (grid) {
            let p = grid;
            while (p && p !== document.body) {
                if (p.classList && p.classList.contains('d-container-ui-default')) return p;
                p = p.parentElement;
            }
            return grid.parentElement;
        }
        const input = $('#d_textDeliveryNameFuzz');
        return input ? input.closest('.d-container-ui-default') : null;
    }

    async function selectCarrier(name) {
        console.log('[selectCarrier] ▶ 承运商：', name);

        const trigger = await waitFor(findCarrierTrigger, 15000, 100);
        if (!trigger) throw new Error('找不到承运商下拉触发器');
        console.log('[selectCarrier] trigger 已找到');

        document.body.click();
        await sleep(20);

        doradoClickSmart(trigger, 3);

        // 轮询等面板出现
        const panel = await waitFor(findCarrierPanel, 2500, 60);
        if (!panel) throw new Error('承运商面板未出现');
        console.log('[selectCarrier] 面板已打开');

        const filterInput = $('#d_textDeliveryNameFuzz input.editor')
        || $('#d_textDeliveryNameFuzz input');
        if (filterInput) {
            setInputValue(filterInput, name);
            await sleep(20);   // 等列表过滤刷新
            console.log('[selectCarrier] 过滤框写入：', name, '| 实际：', filterInput.value);
        } else {
            console.warn('[selectCarrier] 未找到过滤框');
        }

        const allCb = $('#d_cbDeliveryAll');
        if (allCb) {
            const ok = await clickDCheckbox(allCb);
            console.log('[selectCarrier] 全选点击结果:', ok, '| 当前状态:', isDCheckboxChecked(allCb));
        } else {
            console.warn('[selectCarrier] 未找到全选 #d_cbDeliveryAll');
        }

        document.body.click();
        await sleep(10);
        console.log('[selectCarrier] ✔ 完成');
    }

    /* ============================================================
     * 六、拣选区域
     * ============================================================ */

    function findAreaTrigger() {
        return $('#d__uid_1280')
        || $('#d__uid_749 .d-icon-button.d-trigger')
        || $('#d__uid_749 .d-trigger-icon-drop')?.closest('.d-icon-button.d-trigger')
        || null;
    }

    function findAreaPanel() {
        const cands = $$('.d-container-ui-default, .d-popup, .d-popup-content, .d-dropdown, .d-list-dropdown');
        for (let i = cands.length - 1; i >= 0; i--) {
            const c = cands[i];
            if (!c.isConnected) continue;
            if (c.querySelector('td.d-tree-node') || c.querySelector('label.node-label')) {
                return c;
            }
        }
        const cell = $$('td.d-tree-node').find(td => td.getClientRects().length > 0);
        if (cell) {
            let p = cell.parentElement;
            while (p && p !== document.body) {
                if (p.classList && (p.classList.contains('d-container-ui-default') || p.classList.contains('d-popup'))) return p;
                p = p.parentElement;
            }
            return cell.closest('table');
        }
        return null;
    }

    function matchesArea(txt, letter) {
        const t = txt.replace(/\s/g, '');
        const re = new RegExp('(^|[^A-Z])' + letter + '(区|$)');
        return re.test(t);
    }

    async function selectArea(area) {
        console.log('[selectArea] ▶ 拣选区域：', area);

        const trigger = await waitFor(findAreaTrigger, 15000, 100);
        if (!trigger) throw new Error('找不到拣选区域下拉触发器');
        console.log('[selectArea] trigger 已找到');

        document.body.click();
        await sleep(20);

        doradoClickSmart(trigger, 3);

        const panel = await waitFor(findAreaPanel, 2500, 60);
        if (!panel) throw new Error('拣选区域面板未出现');
        console.log('[selectArea] 面板已打开');

        const rows = [...panel.querySelectorAll('tr')];
        console.log(`[selectArea] 面板内 ${rows.length} 行`);

        const ALL_AREAS = ['A', 'B', 'C', 'D', 'E'];
        const extras = AREA_EXTRA_TEXTS[area] || [];

        // 判断某行是否与"拣货区域"有关（A~E 或 额外文本）
        const isAreaRelated = (txt) => {
            if (ALL_AREAS.some(a => matchesArea(txt, a))) return true;
            // 额外文本也算相关（放在一起清空）
            for (const arr of Object.values(AREA_EXTRA_TEXTS)) {
                if (arr.some(e => txt.includes(e))) return true;
            }
            return false;
        };

        // 判断某行是否属于本次 area 的目标（A~E 或 额外文本）
        const isTargetRow = (txt) => {
            if (matchesArea(txt, area)) return true;
            return extras.some(e => txt.includes(e));
        };

        // 收集所有相关行
        const relatedRows = [];
        for (const tr of rows) {
            const label = tr.querySelector('.node-label');
            const txt = (label?.textContent || '').trim();
            if (!txt) continue;
            const cb = tr.querySelector('span.d-checkbox');
            if (!cb) continue;
            if (!isAreaRelated(txt)) continue;
            relatedRows.push({ tr, txt, cb, isTarget: isTargetRow(txt) });
        }
        console.log(`[selectArea] 匹配到 ${relatedRows.length} 个相关行，其中目标行 ${relatedRows.filter(r => r.isTarget).length} 个`);
        relatedRows.forEach(r => console.log(`  · "${r.txt}" target=${r.isTarget}`));

        // ---------- 第一趟：清空所有相关行（含 indeterminate 半选） ----------
        console.log('[selectArea] 第一趟：清空所有相关行勾选');
        for (const item of relatedRows) {
            let state = isDCheckboxChecked(item.cb);
            if (state === true || state === 'indeterminate') {
                let ok = await clickDCheckbox(item.cb);
                await sleep(20);
                let nowState = isDCheckboxChecked(item.cb);
                if (nowState === true || nowState === 'indeterminate') {
                    await clickDCheckbox(item.cb);
                    await sleep(20);
                    nowState = isDCheckboxChecked(item.cb);
                }
                console.log(`[selectArea] 清空 "${item.txt}" 初始=${state} 点击=${ok} 最终=${nowState}`);
            }
        }
        await sleep(20);

        // ---------- 第二趟：勾选所有目标行 ----------
        console.log('[selectArea] 第二趟：勾选目标行');
        let checkedCount = 0;
        for (const item of relatedRows) {
            if(checkedCount>=2)
            {
                break;
            }
            if (!item.isTarget) continue;

            let state = isDCheckboxChecked(item.cb);
            console.log(`[selectArea] 目标 "${item.txt}" 当前状态=${state}`);

            if (state === true) {
                console.log(`[selectArea] "${item.txt}" 已勾选，跳过`);
                checkedCount++;
                continue;
            }

            // 首次点击
            await clickDCheckbox(item.cb);
            await sleep(20);
            let nowState = isDCheckboxChecked(item.cb);

            // 半选 / 未生效 → 二次点击
            if (nowState !== true) {
                console.log(`[selectArea] "${item.txt}" 首次点击后=${nowState}，二次点击`);
                await clickDCheckbox(item.cb);
                await sleep(20);
                nowState = isDCheckboxChecked(item.cb);
            }

            // 仍未勾上 → 直接点内部 icon
            if (nowState !== true) {
                const icon = item.cb.querySelector('.icon');
                if (icon) {
                    console.log(`[selectArea] "${item.txt}" 二次点击仍失败，改点内部 icon`);
                    doradoClickSmart(icon, 2);
                    await sleep(20);
                    nowState = isDCheckboxChecked(item.cb);
                }
            }

            console.log(`[selectArea] 勾选 "${item.txt}" 最终状态=${nowState}`);
            if (nowState === true) checkedCount++;
        }

        document.body.click();
        await sleep(20);
        console.log(`[selectArea] ✔ 完成 | 成功勾选 ${checkedCount} 行`);
    }

    /* ============================================================
     * 七、查询 / 清空
     * ============================================================ */

    async function clickSearch() {
        const btn = await waitFor(() => $('#d_btnSearch'), 8000, 80);
        if (!btn) throw new Error('找不到查询按钮');
        doradoClickSmart(btn, 2);
        await sleep(20);
        console.log('[clickSearch] ✔ 已点击查询');
    }

    async function clickClear() {
        const btn = $('#d_btnCancel');
        if (!btn) return;
        doradoClickSmart(btn, 2);
        await sleep(20);
        console.log('[clickClear] ✔ 已点击清空');
    }

    /* ============================================================
     * 八、对外业务函数
     * ============================================================ */

    async function function_wave_print(carrier, area) {
        console.log('[波次打单] carrier=', carrier, 'area=', area);
        if (!carrier) throw new Error('未选择承运商');
        if (!area) throw new Error('未选择拣货区域');

        await waitFor(() => $('#d_btnSearch') && findCarrierTrigger(), 20000, 150);

        await clickClear();
        await setPageSizeTo500();
        await selectCarrier(carrier);
        await selectArea(area);
        await clickSearch();

        return { ok: true, carrier, area };
    }

    async function function_wave_print_clear() {
        await clickClear();
        return { ok: true };
    }

    async function function_wave_print_search() {
        await setPageSizeTo500();
        await clickSearch();
        return { ok: true };
    }

    async function function_wave_print_select_carrier(carrier) {
        if (!carrier) throw new Error('未选择承运商');
        await clickClear();
        await setPageSizeTo500();
        await selectCarrier(carrier);
        return { ok: true, carrier };
    }

    async function function_wave_print_select_area(area) {
        if (!area) throw new Error('未选择拣货区域');
        await selectArea(area);
        return { ok: true, area };
    }

    async function function_set_page_size() {
        const ok = await setPageSizeTo500();
        return { ok };
    }

    const FUNC_MAP = {
        function_wave_print_clear,
        function_wave_print_search,
        function_wave_print_select_carrier,
        function_wave_print_select_area,
        function_wave_print,
        function_set_page_size
    };

    /* ============================================================
     * 九、消息处理 / 注册
     * ============================================================ */

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;
        if (data.type === 'ACK') { acked = true; return; }
        if (data.type === 'DISCOVER') { acked = false; sendReady(); return; }
        if (data.type === 'CALL') {
            if (data.target && data.target !== SELF_NAME) return;
            handleCall(data, event.source);
        }
    });

    function handleCall(data, source) {
        const { id, fn, args = [] } = data;
        const func = FUNC_MAP[fn];
        if (typeof func !== 'function') {
            reply(source, { id, ok: false, error: '未找到函数：' + fn });
            return;
        }
        Promise.resolve()
            .then(() => func.apply(null, Array.isArray(args) ? args : []))
            .then(result => reply(source, { id, ok: true, data: result }))
            .catch(e => reply(source, { id, ok: false, error: (e && e.message) || String(e) }));
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

    let acked = false, registerTimer = null, attempts = 0;
    const MAX_ATTEMPTS = 20, INTERVAL = 1500;

    function sendReady() {
        if (acked) return;
        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL,
                type: 'READY',
                info: { name: SELF_NAME, url: location.href, title: document.title, ts: Date.now() }
            }, '*');
        } catch (e) {}
    }

    function startRegisterLoop() {
        sendReady();
        registerTimer = setInterval(() => {
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
