// ==UserScript==
// @name         悬浮功能面板 - 波次打单执行端
// @namespace    https://example.com/tm-panel
// @version      1.2.0
// @description  在“波次打单” iframe 内运行，向主面板上报 UI 配置并按承运商 / 拣货区域执行波次（含每页500条设置 + 表头排序 + 确认打单 / 全选+快递单；承运商/拣货区域支持“空”=不选；面板按钮可勾选隐藏）
// @author       You
// @match        https://wms-t.hupun.com/url.d*
// @match        https://wms.hupun.com/url.d*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('_id') !== '203') {
        return;
    }
    if (window.self === window.top) return;

    const CHANNEL   = 'tm_panel_exec';
    const SELF_NAME = 'print_wave';

    /* ============================================================
     * 面板 UI 配置（静态目录）
     * ============================================================ */

    // 承运商 / 拣货区域下拉
    const ITEM_SELECTS = [
        { key: 'carrier', label: '承运商',   options: ['空','中通','极兔','邮政','圆通'], value: '中通' },
        { key: 'area',    label: '拣货区域', options: ['空','A','B','C','D','E','B+E','A+C+D','A+B+C+D+E','F','Y'], value: 'E' }
    ];

    // 静态按钮分组目录：既用于构建父面板，也用于配置弹窗中的显隐勾选
    const PANEL_BUTTON_GROUPS = [
        {
            label: '波次打单',
            buttons: [
                { text: '查询',         fn: 'function_wave_print',                     params: ['carrier','area'] },
                { text: '清空',         fn: 'function_wave_print_clear' },
                { text: '确认打单',     fn: 'function_wave_print_commit' },
                { text: '全选+快递单',  fn: 'function_wave_print_select_all_and_express' }
            ]
        }
    ];

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $  = (sel) => { try { return document.querySelector(sel); } catch (e) { return null; } };
    const $$ = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch (e) { return []; } };

    /* ============================================================
     * 通用工具：短超时轮询 / 强制查找（找不到即抛错）
     * ★ 所有超时统一 ≤ 500ms
     * ============================================================ */

    async function waitFor(fn, timeout = 500, interval = 60) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try { const r = fn(); if (r) return r; } catch (e) {}
            await sleep(interval);
        }
        return null;
    }

    function mustGet(fn, errMsg, timeout = 500) {
        return waitFor(fn, timeout).then(r => {
            if (!r) throw new Error(errMsg);
            return r;
        });
    }

    /* ============================================================
     * 0. 拣货区域额外勾选配置
     * ============================================================ */
    const AREA_EXTRA_TEXTS = {
        A: ['货架区']
    };

    /* ============================================================
     * 0.1 面板按钮可见性存储
     * ============================================================ */
    const BUTTON_VISIBILITY_STORAGE_KEY = 'hupun_wave_hidden_buttons';

    function getHiddenButtons() {
        try {
            const raw = localStorage.getItem(BUTTON_VISIBILITY_STORAGE_KEY);
            if (!raw) return {};
            const obj = JSON.parse(raw);
            return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
        } catch (e) {
            return {};
        }
    }

    function setHiddenButtons(map) {
        try {
            localStorage.setItem(BUTTON_VISIBILITY_STORAGE_KEY, JSON.stringify(map || {}));
        } catch (e) {}
    }

    function isButtonVisible(fnName) {
        return !getHiddenButtons()[fnName];
    }

    function setButtonVisible(fnName, visible) {
        if (!fnName) return;
        const map = getHiddenButtons();
        if (visible) delete map[fnName];
        else map[fnName] = true;
        setHiddenButtons(map);
    }

    function resetButtonVisibility() {
        try { localStorage.removeItem(BUTTON_VISIBILITY_STORAGE_KEY); } catch (e) {}
    }

    /* ============================================================
     * 0.2 构建 panelConfig（按隐藏项过滤按钮；“配置”按钮永不过滤）
     * ============================================================ */
    function buildPanelConfig() {
        const hidden = getHiddenButtons();

        const items = PANEL_BUTTON_GROUPS.map((g) => {
            const buttons = g.buttons
                .filter((b) => !hidden[b.fn])
                .map((b) => {
                    const nb = { text: b.text, fn: b.fn };
                    if (b.params) nb.params = b.params;
                    return nb;
                });

            // “配置”按钮始终存在，避免用户把自己锁在门外
            buttons.push({ text: '配置', fn: 'fn_config' });

            return {
                label: g.label,
                selects: ITEM_SELECTS,
                buttons
            };
        });

        return [{
            title: '打单',
            open: false,
            items
        }];
    }

    function pushPanelConfig() {
        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL,
                type: 'READY',
                info: {
                    name: SELF_NAME,
                    url: location.href,
                    title: document.title,
                    ts: Date.now(),
                    panelConfig: buildPanelConfig()
                }
            }, '*');
        } catch (e) {}
    }

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

        if (window.jQuery) {
            try {
                const $cb = window.jQuery(cb);
                $cb.trigger('mousedown').trigger('mouseup').trigger('click');
                await sleep(20);
                if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略2(jQuery) 生效'); return true; }
            } catch (e) {}
        }

        const candidates = [cb, cb.querySelector('.icon'), cb.querySelector('.caption')].filter(Boolean);
        for (const t of candidates) {
            fullPointerClick(t);
            await sleep(20);
            if (isDCheckboxChecked(cb) !== before) { console.log('[clickDCheckbox] 策略3(pointer+mouse) 生效'); return true; }
        }

        try {
            cb.focus();
            cb.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ', code: 'Space', keyCode: 32, which: 32 }));
            cb.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: ' ', code: 'Space', keyCode: 32, which: 32 }));
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
     * 四、按 label 文本定位 form-element 内的下拉触发器
     * ============================================================ */

    function findTriggerByLabel(labelText) {
        const labels = $$('.form-label');
        for (const l of labels) {
            const txt = (l.textContent || '').trim().replace(/[:：]\s*$/, '');
            if (txt !== labelText) continue;
            const fe = l.closest('.d-form-element');
            if (!fe) continue;
            const dropIcon = fe.querySelector('.d-trigger-icon-drop');
            if (dropIcon) {
                const btn = dropIcon.closest('.d-icon-button.d-trigger');
                if (btn) return btn;
            }
            const anyTrigger = fe.querySelector('.d-icon-button.d-trigger');
            if (anyTrigger) return anyTrigger;
        }
        return null;
    }

    /* ============================================================
     * 五、每页显示条数设为 500
     * ============================================================ */

    async function setPageSizeTo500() {
        console.log('[setPageSize] ▶ 设置每页显示条数为 500');
        const TARGET = 500;

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
                    await sleep(100);
                    return true;
                }
            } catch (e) { console.warn('[setPageSize] editorPageSize API 异常', e); }
        }

        if (window.view && typeof window.view.get === 'function') {
            try {
                const ds = window.view.get("#dsWave");
                if (ds && typeof ds.set === 'function') {
                    ds.set("pageSize", TARGET);
                    console.log('[setPageSize] ✔ 通过 widget.set("#dsWave.pageSize", 500) 设置');
                    await sleep(100);
                    return true;
                }
            } catch (e) { console.warn('[setPageSize] dsWave API 异常', e); }
        }

        const editorEl = $('#d_editorPageSize');
        if (!editorEl) {
            console.warn('[setPageSize] ⚠ 未找到 #d_editorPageSize，跳过 DOM 策略');
            return false;
        }

        const trigger = editorEl.querySelector('.d-icon-button.d-trigger')
        || editorEl.querySelector('.d-trigger-icon-drop');
        if (trigger) {
            doradoClickSmart(trigger, 3);

            const target = await waitFor(() => {
                const options = $$('.d-list-item, li, .d-list-dropdown-item, .d-dropdown-item');
                for (const o of options) {
                    if (!o.isConnected) continue;
                    if (o.getClientRects().length === 0) continue;
                    if ((o.textContent || '').trim() === String(TARGET)) return o;
                }
                return null;
            }, 500, 100);

            if (target) {
                doradoClickSmart(target, 2);
                await sleep(100);
                console.log('[setPageSize] ✔ 通过下拉选择 500');
                return true;
            }
            console.warn('[setPageSize] 下拉里未找到 500 选项，尝试关闭下拉');
            document.body.click();
            await sleep(100);
        }

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
                await sleep(100);
                return true;
            } catch (e) { console.warn('[setPageSize] DOM 写入失败', e); }
        }

        console.warn('[setPageSize] ⚠ 所有策略均未生效');
        return false;
    }

    /* ============================================================
     * 六、承运商（支持“空”=不选）
     * ============================================================ */

    function findCarrierTrigger() {
        return findTriggerByLabel('承运商')
            || $('#d__uid_1317')
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

        const trigger = await mustGet(findCarrierTrigger, '找不到承运商下拉触发器（已尝试按 label "承运商" 定位）', 500);
        console.log('[selectCarrier] trigger 已找到');

        document.body.click();
        await sleep(20);
        doradoClickSmart(trigger, 3);

        const panel = await mustGet(findCarrierPanel, '承运商面板未出现', 500);
        console.log('[selectCarrier] 面板已打开');

        const filterInput = $('#d_textDeliveryNameFuzz input.editor')
            || $('#d_textDeliveryNameFuzz input');
        if (filterInput) {
            setInputValue(filterInput, name === '空' ? '' : name);
            await sleep(100);
            console.log('[selectCarrier] 过滤框写入：', name === '空' ? '(空)' : name, '| 实际：', filterInput.value);
        } else {
            console.warn('[selectCarrier] 未找到过滤框');
        }

        const allCb = $('#d_cbDeliveryAll');
        if (!allCb) throw new Error('未找到全选 #d_cbDeliveryAll');

        if (name === '空') {
            let state = isDCheckboxChecked(allCb);
            let tries = 0;
            while (state !== false && tries < 4) {
                await clickDCheckbox(allCb);
                await sleep(20);
                state = isDCheckboxChecked(allCb);
                tries++;
            }
            document.body.click();
            await sleep(20);
            if (state !== false) {
                console.warn('[selectCarrier] ⚠ 无法确保全不选，当前状态:', state);
            } else {
                console.log('[selectCarrier] ✔ 完成（空模式，已清空）');
            }
            return;
        }

        const ok = await clickDCheckbox(allCb);
        console.log('[selectCarrier] 全选点击结果:', ok, '| 当前状态:', isDCheckboxChecked(allCb));
        if (isDCheckboxChecked(allCb) !== true) {
            throw new Error('承运商全选未生效');
        }

        document.body.click();
        await sleep(20);
        console.log('[selectCarrier] ✔ 完成');
    }

    /* ============================================================
     * 七、拣选区域（支持“空”=不选）
     * ============================================================ */

    function findAreaTrigger() {
        return findTriggerByLabel('拣选区域')
            || $('#d__uid_1320')
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

        const trigger = await mustGet(findAreaTrigger, '找不到拣选区域下拉触发器（已尝试按 label "拣选区域" 定位）', 500);
        console.log('[selectArea] trigger 已找到');

        document.body.click();
        await sleep(20);
        doradoClickSmart(trigger, 3);

        const panel = await mustGet(findAreaPanel, '拣选区域面板未出现', 500);
        console.log('[selectArea] 面板已打开');

        const rows = [...panel.querySelectorAll('tr')];
        console.log(`[selectArea] 面板内 ${rows.length} 行`);

        const ALL_AREAS = ['A', 'B', 'C', 'D', 'E', 'F', 'Y'];

        const isClear = (area === '空');

        const areaList = isClear
            ? []
            : (area.includes('+')
                ? area.split('+').map(s => s.trim()).filter(Boolean)
                : [area]);

        const extras = [];
        if (!isClear) {
            for (const a of areaList) {
                const arr = AREA_EXTRA_TEXTS[a];
                if (arr) extras.push(...arr);
            }
        }

        let maxChecked;
        if (isClear) {
            maxChecked = 0;
        } else if (areaList.length > 1) {
            maxChecked = areaList.reduce((sum, a) => {
                const ex = AREA_EXTRA_TEXTS[a];
                return sum + 1 + (ex ? ex.length : 0);
            }, 0);
        } else {
            maxChecked = 2;
        }

        const isAreaRelated = (txt) => {
            if (isClear) return !!txt;
            if (ALL_AREAS.some(a => matchesArea(txt, a))) return true;
            for (const arr of Object.values(AREA_EXTRA_TEXTS)) {
                if (arr.some(e => txt.includes(e))) return true;
            }
            return false;
        };

        const isTargetRow = (txt) => {
            if (isClear) return false;
            if (areaList.some(a => matchesArea(txt, a))) return true;
            return extras.some(e => txt.includes(e));
        };

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
        console.log(`[selectArea] 匹配到 ${relatedRows.length} 个相关行，其中目标行 ${relatedRows.filter(r => r.isTarget).length} 个 | 勾选上限=${maxChecked}`);
        relatedRows.forEach(r => console.log(`  · "${r.txt}" target=${r.isTarget}`));

        if (!isClear && relatedRows.length === 0) {
            throw new Error(`拣选区域面板中未找到任何相关行（区域=${area}）`);
        }

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

        if (isClear) {
            document.body.click();
            await sleep(20);
            console.log('[selectArea] ✔ 完成（空模式，已清空）');
            return;
        }

        console.log('[selectArea] 第二趟：勾选目标行');

        const isAItem = (txt) =>
            matchesArea(txt, 'A') || (AREA_EXTRA_TEXTS.A || []).some(e => txt.includes(e));

        let iterateTargets = relatedRows;
        if (areaList.length > 1) {
            const nonAItems = [];
            const aItems = [];
            for (const it of relatedRows) {
                if (!it.isTarget) continue;
                if (isAItem(it.txt)) aItems.push(it);
                else nonAItems.push(it);
            }
            iterateTargets = [...nonAItems, ...aItems];
            console.log(`[selectArea] 组合区域排序：非A目标行 ${nonAItems.length} 个先行，A 目标行 ${aItems.length} 个最后`);
        }

        let checkedCount = 0;
        for (const item of iterateTargets) {
            if (checkedCount >= maxChecked) break;
            if (!item.isTarget) continue;

            let state = isDCheckboxChecked(item.cb);
            console.log(`[selectArea] 目标 "${item.txt}" 当前状态=${state}`);

            if (state === true) {
                console.log(`[selectArea] "${item.txt}" 已勾选，跳过`);
                checkedCount++;
                continue;
            }

            await clickDCheckbox(item.cb);
            await sleep(20);
            let nowState = isDCheckboxChecked(item.cb);

            if (nowState !== true) {
                console.log(`[selectArea] "${item.txt}" 首次点击后=${nowState}，二次点击`);
                await clickDCheckbox(item.cb);
                await sleep(20);
                nowState = isDCheckboxChecked(item.cb);
            }

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

        if (checkedCount === 0) {
            throw new Error(`拣选区域 "${area}" 未能勾选任何目标行`);
        }
        console.log(`[selectArea] ✔ 完成 | 成功勾选 ${checkedCount} 行`);
    }

    /* ============================================================
     * 八、查询 / 清空
     * ============================================================ */

    async function clickSearch() {
        const btn = await mustGet(() => $('#d_btnSearch'), '找不到查询按钮 #d_btnSearch', 500);
        doradoClickSmart(btn, 2);
        await sleep(20);
        console.log('[clickSearch] ✔ 已点击查询');
    }

    async function clickClear() {
        const btn = await mustGet(() => $('#d_btnCancel'), '找不到清空按钮 #d_btnCancel', 500);
        doradoClickSmart(btn, 2);
        await sleep(20);
        console.log('[clickClear] ✔ 已点击清空');
    }

    /* ============================================================
     * 九、波次表格（#d_gridWave）表头点击排序
     * ============================================================ */

    function findGridWaveHeaderCell(text) {
        const grid = $('#d_gridWave');
        if (!grid) return null;
        const headers = grid.querySelectorAll('table.header-table td.header');
        for (const td of headers) {
            const cell = td.querySelector('.cell');
            if (!cell) continue;
            const t = (cell.textContent || '').replace(/\s/g, '').trim();
            if (t === text.replace(/\s/g, '')) return td;
        }
        return null;
    }

    async function clickGridWaveHeaderSort(text) {
        const td = await mustGet(
            () => findGridWaveHeaderCell(text),
            `找不到波次表格表头："${text}"`,
            500
        );

        const cell = td.querySelector('.cell') || td;
        const target =
            cell.querySelector('span[style*="cursor"]') ||
            cell.querySelector('label.caption') ||
            cell.querySelector('span') ||
            cell;

        doradoClickSmart(target, 3);
        await sleep(100);
        console.log(`[clickGridWaveHeaderSort] ✔ 已点击表头：${text}`);
    }

    /* ============================================================
     * 十、确认打单 / 全选 + 快递单
     * ============================================================ */

    function findRowSelector() {
        const grid = $('#d_gridWave');
        if (!grid) return null;
        return grid.querySelector('thead td.row-selector .cell')
            || grid.querySelector('thead td.row-selector');
    }

    function findVisibleMenuItem(text) {
        const items = $$('.menu-item');
        for (const it of items) {
            if (!it.isConnected) continue;
            if (it.getClientRects().length === 0) continue;
            const cap = it.querySelector('.caption');
            const t = (cap?.textContent || it.textContent || '').replace(/\s/g, '').trim();
            if (t === text.replace(/\s/g, '')) return it;
        }
        return null;
    }

    async function function_wave_print_commit() {
        const btn = await mustGet(() => $('#d_btnCommit'), '找不到确认打单按钮 #d_btnCommit', 500);
        document.body.click();
        await sleep(20);
        doradoClickSmart(btn, 2);
        await sleep(100);
        console.log('[function_wave_print_commit] ✔ 已点击确认打单');
        return { ok: true };
    }

    async function function_wave_print_select_all_and_express() {
        const selector = await mustGet(
            findRowSelector,
            '找不到波次表格行选择器（全选下拉框触发器）',
            500
        );
        document.body.click();
        await sleep(20);
        doradoClickSmart(selector, 3);
        console.log('[select_all_and_express] 已点击行选择器，等待下拉框');

        const allItem = await mustGet(
            () => findVisibleMenuItem('全选'),
            '找不到可见的"全选"菜单项',
            500
        );
        doradoClickSmart(allItem, 2);
        await sleep(100);
        console.log('[select_all_and_express] ✔ 已点击全选');

        const expressBtn = await mustGet(
            () => $('#d_btnPrintExpress'),
            '找不到快递单按钮 #d_btnPrintExpress',
            500
        );
        doradoClickSmart(expressBtn, 2);
        await sleep(100);
        console.log('[select_all_and_express] ✔ 已点击快递单');

        return { ok: true };
    }

    /* ============================================================
     * 十一、对外业务函数
     * ============================================================ */

    async function function_wave_print(carrier, area) {
        console.log('[波次打单] carrier=', carrier, 'area=', area);
        if (!carrier) throw new Error('未选择承运商');
        if (!area) throw new Error('未选择拣货区域');

        await mustGet(() => $('#d_btnSearch'), '页面未就绪：找不到查询按钮', 500);
        await mustGet(findCarrierTrigger,   '页面未就绪：找不到承运商下拉触发器', 500);
        await mustGet(findAreaTrigger,      '页面未就绪：找不到拣选区域下拉触发器', 500);

        await clickClear();
        await setPageSizeTo500();
        await selectCarrier(carrier);
        await selectArea(area);

        await sleep(500);
        await clickSearch();

        await sleep(500);

        await clickGridWaveHeaderSort('商品名称');
        await sleep(300);
        await clickGridWaveHeaderSort('货主');
        await sleep(300);
        await clickGridWaveHeaderSort('货主');

        return { ok: true, carrier, area };
    }

    async function function_wave_print_clear() {
        await clickClear();
        return { ok: true };
    }

    async function function_wave_print_search() {
        await setPageSizeTo500();
        await sleep(500);
        await clickSearch();
        await sleep(500);
        await clickGridWaveHeaderSort('商品名称');
        await sleep(300);
        await clickGridWaveHeaderSort('货主');
        await sleep(300);
        await clickGridWaveHeaderSort('货主');
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

    async function function_sort_grid_headers() {
        await clickGridWaveHeaderSort('商品名称');
        await sleep(300);
        await clickGridWaveHeaderSort('货主');
        await sleep(300);
        await clickGridWaveHeaderSort('货主');
        return { ok: true };
    }

    async function fn_config() {
        showWaveConfigPanel();
        return { ok: true, action: '打开配置' };
    }

    /* ============================================================
     * 十一.1 配置弹窗（订单审核端同款风格）
     * ============================================================ */
    const SECTION_TITLE = 'font-weight: 600; font-size: 13px; color: #1d2129; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;';
    const SECTION_BAR = (color) => `width: 3px; height: 14px; background: ${color}; border-radius: 2px;`;

    function showWaveConfigPanel() {
        const existing = document.getElementById('hupun-wave-config-panel');
        if (existing) { existing.remove(); return; }

        const panel = document.createElement('div');
        panel.id = 'hupun-wave-config-panel';
        panel.style.cssText = `
            position: fixed !important; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.45); z-index: 2147483647;
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
        `;

        panel.innerHTML = `
            <div style="width: 420px; max-height: 80vh; background: #fff; border-radius: 10px;
                        box-shadow: 0 12px 40px rgba(0,0,0,0.3); display: flex; flex-direction: column; overflow: hidden;">
                <div style="padding: 14px 18px; border-bottom: 1px solid #e5e6eb; display: flex;
                            justify-content: space-between; align-items: center; flex: 0 0 auto;">
                    <span style="font-weight: 600; font-size: 14px; color: #1d2129;">波次打单 · 配置</span>
                    <span id="hwc-close" style="cursor: pointer; font-size: 20px; color: #86909c;
                                               line-height: 1; padding: 0 4px; user-select: none;">×</span>
                </div>
                <div style="padding: 8px 18px; font-size: 11.5px; color: #86909c; background: #f7f8fa;
                            border-bottom: 1px solid #e5e6eb; line-height: 1.6; flex: 0 0 auto;">
                    勾选表示在父面板中显示该按钮，取消勾选则隐藏<br>
                    「配置」按钮本身不受影响，始终显示<br>
                    改完会立即同步到父面板按钮
                </div>
                <div style="padding: 14px 18px; overflow-y: auto; flex: 1 1 auto;">
                    <div>
                        <div style="${SECTION_TITLE}">
                            <span style="${SECTION_BAR('#2b6cff')}"></span>
                            面板按钮显示
                            <button id="hwc-btn-all" type="button"
                                style="margin-left: auto; padding: 3px 10px; background: #fff; color: #2b6cff;
                                       border: 1px solid #2b6cff; border-radius: 4px; cursor: pointer; font-size: 11.5px;">
                                全部显示
                            </button>
                        </div>
                        <div id="hwc-button-groups"></div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        const $p = (id) => panel.querySelector('#' + id);
        const buttonGroupsEl = $p('hwc-button-groups');

        function renderButtonGroups() {
            const hidden = getHiddenButtons();
            buttonGroupsEl.innerHTML = '';
            PANEL_BUTTON_GROUPS.forEach((group) => {
                // “配置”按钮本身不参与显隐勾选
                const visibleButtons = group.buttons.filter((b) => b.fn !== 'fn_config');
                if (!visibleButtons.length) return;

                const wrap = document.createElement('div');
                wrap.style.cssText = 'margin-bottom: 12px;';

                const title = document.createElement('div');
                title.style.cssText = 'font-size: 12px; color: #86909c; margin-bottom: 6px;';
                title.textContent = group.label;
                wrap.appendChild(title);

                const row = document.createElement('div');
                row.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';

                visibleButtons.forEach((btn) => {
                    const label = document.createElement('label');
                    label.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; ' +
                        'background: #f7f8fa; border: 1px solid #e5e6eb; border-radius: 4px; cursor: pointer; ' +
                        'font-size: 12px; color: #1d2129; user-select: none;';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.dataset.fn = btn.fn;
                    cb.checked = !hidden[btn.fn];
                    cb.style.cssText = 'cursor: pointer; margin: 0;';

                    label.appendChild(cb);
                    label.appendChild(document.createTextNode(' ' + btn.text));
                    row.appendChild(label);
                });

                wrap.appendChild(row);
                buttonGroupsEl.appendChild(wrap);
            });
        }

        buttonGroupsEl.addEventListener('change', (e) => {
            const cb = e.target;
            if (!cb || cb.type !== 'checkbox' || !cb.dataset.fn) return;
            setButtonVisible(cb.dataset.fn, cb.checked);
            pushPanelConfig();
        });

        $p('hwc-btn-all').addEventListener('click', () => {
            resetButtonVisibility();
            renderButtonGroups();
            pushPanelConfig();
        });

        $p('hwc-close').addEventListener('click', () => panel.remove());
        panel.addEventListener('click', (e) => { if (e.target === panel) panel.remove(); });

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                const p = document.getElementById('hupun-wave-config-panel');
                if (p) p.remove();
                document.removeEventListener('keydown', escHandler, true);
            }
        };
        document.addEventListener('keydown', escHandler, true);

        renderButtonGroups();
    }

    /* ============================================================
     * 十二、对外函数表
     * ============================================================ */
    const FUNC_MAP = {
        function_wave_print_clear,
        function_wave_print_search,
        function_wave_print_select_carrier,
        function_wave_print_select_area,
        function_wave_print,
        function_set_page_size,
        function_sort_grid_headers,
        function_wave_print_commit,
        function_wave_print_select_all_and_express,
        fn_config
    };

    /* ============================================================
     * 十三、消息处理 / 注册
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
    const MAX_ATTEMPTS = 20, INTERVAL = 500;

    function sendReady() {
        if (acked) return;
        pushPanelConfig();
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
