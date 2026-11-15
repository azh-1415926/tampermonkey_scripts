// ==UserScript==
// @name         万里牛悬浮功能面板-订单审核执行端
// @namespace    https://example.com/tm-panel
// @version      1.2.0
// @description  在 iframe 内运行，向主面板上报 UI 配置并执行对应业务函数
// @author       You
// @match        https://*.hupun.com/calf-biz/trade/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (location.hash !== '#/approval') return;
    if (window.self === window.top) return;

    const CHANNEL = 'tm_panel_exec';
    const SELF_NAME = 'order';

    /* ============================================================
     * 通用工具
     * ============================================================ */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        if (el.offsetParent === null && st.position !== 'fixed') return false;
        return true;
    };

    const clickEl = (el) => {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
        const rect = el.getBoundingClientRect();
        const opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: rect.left + Math.max(1, rect.width) / 2,
            clientY: rect.top + Math.max(1, rect.height) / 2,
            button: 0,
        };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
    };

    const setInputValue = (input, value) => {
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    };

    const waitFor = async (fn, { timeout = 1500, interval = 50 } = {}) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            const v = fn();
            if (v) return v;
            await sleep(interval);
        }
        return null;
    };

    const btnText = (btn) => (btn.textContent || '').replace(/\s/g, '');

    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const q = (sel, root = document) => root.querySelector(sel);

    const hasVisiblePopper = () =>
        [...document.querySelectorAll('.hp-cascader-select-dropdown, .el-select-dropdown, .region-picker')].some(isVisible);

    const closeAllPoppers = async () => {
        for (let i = 0; i < 3 && hasVisiblePopper(); i++) {
            const opts = { bubbles: true, cancelable: true, view: window };
            document.body.dispatchEvent(new MouseEvent('mousedown', opts));
            document.body.dispatchEvent(new MouseEvent('mouseup', opts));
            document.body.dispatchEvent(new MouseEvent('click', opts));
            await sleep(80);
        }
    };

    /* ============================================================
     * DOM 定位
     * ============================================================ */
    const findQueryLiByLabel = (text) => {
        for (const lb of document.querySelectorAll('.query-condition .query-ul > li > label')) {
            if (lb.textContent.trim() === text) return lb.closest('li');
        }
        return null;
    };

    const getMoreButton = () => q('.query-condition.header-bar .top-box .more-button');

    const getOpsButton = (name) => {
        const ops = q('.query-condition.header-bar .top-box .field.operations');
        if (ops) {
            for (const btn of ops.querySelectorAll('button.el-button')) {
                if (btnText(btn) === name) return btn;
            }
        }
        return null;
    };

    const getQueryButton = () => getOpsButton('查询');

    const getResetButton = () => {
        const btn = getOpsButton('重置');
        if (btn) return btn;
        for (const b of document.querySelectorAll('button.el-button')) {
            if (isVisible(b) && btnText(b) === '重置') return b;
        }
        return null;
    };

    const getTriggerByLabel = (label) => {
        const li = findQueryLiByLabel(label);
        return li ? q('.hp-cascader-select-lazy .el-input__suffix-inner', li) : null;
    };

    const getShopTrigger = () => getTriggerByLabel('店铺：');
    const getWarehouseTrigger = () => getTriggerByLabel('仓库：');
    const getBiaojiTrigger = () => getTriggerByLabel('标记指定：');

    const getRemarkTrigger = () =>
        q('.query-condition .query-ul.top .combox-box .el-select .el-input__suffix-inner')
        || q('.query-condition .query-ul .combox-box .el-select .el-input__suffix-inner');

    const getShengfengTrigger = () => document.evaluate(
        "//div[contains(@class,'region-select')][.//input[@placeholder='省 / 市 / 区县']]" +
        "//i[contains(@class,'el-select__caret')]",
        document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;

    const getVisibleCascaderDropdown = () =>
        [...document.querySelectorAll('.hp-cascader-select-dropdown')]
            .find((d) => isVisible(d) && d.querySelector('.cascader-select-picker, .cascader-select-lazy-picker'));

    const isShengfengOpen = () => {
        const pane = document.getElementById('pane-省')
                  || document.getElementById('pane-市')
                  || document.getElementById('pane-区县');
        return !!pane && isVisible(pane);
    };

    const expandMore = async () => {
        const more = getMoreButton();
        if (!more) return false;
        if (more.classList.contains('opened')) return true;
        clickEl(more);
        await sleep(200);
        return true;
    };

    const findVisibleOptionByText = (text) =>
        [...document.querySelectorAll('li.el-select-dropdown__item')]
            .filter(isVisible)
            .find((li) => {
                const s = li.querySelector('span');
                return s && s.textContent.trim() === text;
            });

    /* ============================================================
     * 查询按钮
     * ============================================================ */
    function clickQueryButton() {
        const btn = getQueryButton();
        if (btn) clickEl(btn);
        else alert('无法定位到查询按钮');
    }

    /* ============================================================
     * 级联选择核心逻辑（店铺 / 仓库共用）
     * ============================================================ */
    const hasAnySelectedInLi = (li) => {
        if (!li) return false;
        const input = li.querySelector('.el-input__inner');
        if (input) {
            const v = (input.value || '').trim();
            if (v && v !== '请选择') return true;
        }
        for (const t of li.querySelectorAll('.el-input__prefix .tags .el-tooltip')) {
            if ((t.textContent || '').trim()) return true;
            if (t.querySelector('.el-tag')) return true;
        }
        return false;
    };

    const hasAnySelectedByLabel = (label) => hasAnySelectedInLi(findQueryLiByLabel(label));

    // 打开级联面板；如已选，按 clearKeywords 逐个搜索→点"全选"取消
    async function openCascaderAndClear(trigger, clearKeywords, delay) {
        await closeAllPoppers();
        if (!trigger) return false;
        clickEl(trigger);
        if (!await waitFor(getVisibleCascaderDropdown, { timeout: 1500 })) return false;
        await sleep(delay);

        for (const kw of clearKeywords) {
            let cur = getVisibleCascaderDropdown();
            if (!cur) break;
            const input = q('.input-filter input', cur);
            if (!input) continue;

            input.focus();
            setInputValue(input, kw);
            await sleep(delay);

            for (let i = 0; i < 3; i++) {
                cur = getVisibleCascaderDropdown();
                if (!cur) break;
                const checked = cur.querySelectorAll('li.el-cascader-node label.el-checkbox.is-checked').length;
                if (checked === 0) break;
                const selectAll = cur.querySelector('.header label.operate-check:not(.reverse)');
                if (!selectAll) break;
                clickEl(selectAll.querySelector('span') || selectAll);
                await sleep(delay);
            }
        }

        const last = getVisibleCascaderDropdown();
        if (last) {
            const inp = q('.input-filter input', last);
            if (inp) setInputValue(inp, '');
        }
        return !!getVisibleCascaderDropdown();
    }

    // 在已打开的级联面板中，按关键词逐个搜索→点"全选"（仅在未选中时点击）
    async function pickAllByKeywords(keywords, delay) {
        const failed = [];
        for (const kw of keywords) {
            const dd = getVisibleCascaderDropdown();
            if (!dd) { failed.push(kw); continue; }
            const input = q('.input-filter input', dd);
            if (!input) { failed.push(kw); continue; }

            input.focus();
            setInputValue(input, kw);
            await sleep(delay);
            if (input.value !== kw) { failed.push(kw); continue; }

            const after = getVisibleCascaderDropdown();
            if (!after || !after.querySelector('li.el-cascader-node')) { failed.push(kw); continue; }

            const label = after.querySelector('.header label.operate-check:not(.reverse)');
            if (label && !label.classList.contains('is-checked')) {
                clickEl(label.querySelector('span') || label);
                await sleep(delay);
            }
        }
        return failed;
    }

    // 在已打开的级联面板中，按关键词逐个搜索→点击切换"全选"状态（用于排除）
    async function toggleByKeywords(keywords, delay) {
        const failed = [];
        for (const kw of keywords) {
            const dd = getVisibleCascaderDropdown();
            if (!dd) { failed.push(kw); continue; }
            const input = q('.input-filter input', dd);
            if (!input) { failed.push(kw); continue; }

            input.focus();
            setInputValue(input, kw);
            await sleep(delay);

            const after = getVisibleCascaderDropdown();
            if (!after || !after.querySelector('li.el-cascader-node')) { failed.push(kw); continue; }

            const label = after.querySelector('.header label.operate-check:not(.reverse)');
            if (label) {
                clickEl(label.querySelector('span') || label);
                await sleep(delay);
            }
        }
        return failed;
    }

    /* ============================================================
     * 店铺
     * ============================================================ */
    const SHOP_OP_DELAY = 500;
    const KNOWN_SHOP_KEYWORDS = ['永丰', '晋贤', '张龙', '曾招伟', '范婕', '袁颖慧', '邓先生', '黄小东', '宁仁涛'];

    async function selectShop(shopNames) {
        const names = Array.isArray(shopNames) ? shopNames : [shopNames];
        if (!names.length) return true;

        const trigger = getShopTrigger();
        if (!trigger) { alert('无法定位到店铺下拉框'); return false; }

        const alreadySelected = hasAnySelectedByLabel('店铺：');
        const opened = await openCascaderAndClear(
            trigger,
            alreadySelected ? KNOWN_SHOP_KEYWORDS : [],
            SHOP_OP_DELAY
        );
        if (!opened) { alert('无法定位到店铺下拉面板'); return false; }
        if (alreadySelected) await sleep(SHOP_OP_DELAY);

        const failed = await pickAllByKeywords(names, SHOP_OP_DELAY);
        await closeAllPoppers();
        if (failed.length) console.warn('[selectShop] 未匹配：', failed);
        return failed.length === 0;
    }

    /* ============================================================
     * 仓库
     * ============================================================ */
    const WAREHOUSE_OP_DELAY = 300;
    const WAREHOUSE_EXCLUDE_DELAY = 350;
    const KNOWN_WAREHOUSE_KEYWORDS = ['永丰', '吉安', '吉水', '南昌', '上饶', '余姚', '新疆', '云仓'];

    async function selectWarehouse(keywordOrList) {
        const keywords = Array.isArray(keywordOrList) ? keywordOrList : [keywordOrList];
        if (!keywords.length) return true;

        const trigger = getWarehouseTrigger();
        if (!trigger) { alert('无法定位到仓库下拉框'); return false; }

        const alreadySelected = hasAnySelectedByLabel('仓库：');
        const opened = await openCascaderAndClear(
            trigger,
            alreadySelected ? KNOWN_WAREHOUSE_KEYWORDS : [],
            WAREHOUSE_OP_DELAY
        );
        if (!opened) { alert('无法定位到仓库下拉面板'); return false; }
        if (alreadySelected) await sleep(WAREHOUSE_OP_DELAY);

        const failed = await pickAllByKeywords(keywords, WAREHOUSE_OP_DELAY);
        await closeAllPoppers();
        if (failed.length) console.warn('[selectWarehouse] 未匹配：', failed);
        return failed.length === 0;
    }

    async function excludeWarehouse(excludeList) {
        const excludes = Array.isArray(excludeList) ? excludeList : [excludeList];
        if (!excludes.length) return true;

        await closeAllPoppers();
        const trigger = getWarehouseTrigger();
        if (!trigger) { console.warn('[excludeWarehouse] 无法定位到仓库下拉框'); return false; }

        clickEl(trigger);
        if (!await waitFor(getVisibleCascaderDropdown, { timeout: 1500 })) {
            console.warn('[excludeWarehouse] 无法打开仓库下拉');
            return false;
        }
        await sleep(WAREHOUSE_OP_DELAY);

        const failed = await toggleByKeywords(excludes, WAREHOUSE_EXCLUDE_DELAY);

        const last = getVisibleCascaderDropdown();
        if (last) {
            const inp = q('.input-filter input', last);
            if (inp) setInputValue(inp, '');
            await sleep(150);
        }

        await closeAllPoppers();
        if (failed.length) console.warn('[excludeWarehouse] 未匹配：', failed);
        return failed.length === 0;
    }

    /* ============================================================
     * 列表存储（仓库名单 / 排除名单 / 隐藏按钮）
     * ============================================================ */
    const WAREHOUSE_LIST_STORAGE_KEY = 'hupun_unrelated_warehouse_list';
    const EXCLUDE_LIST_STORAGE_KEY = 'hupun_unrelated_exclude_list';
    const HIDDEN_BUTTONS_STORAGE_KEY = 'hupun_hidden_buttons';

    const DEFAULT_WAREHOUSE_LIST = [
        '永丰-匡广龙', '永丰-高金连', '永丰-黄让礼', '永丰黄让礼2',
        '永丰-宁仁涛', '永丰-邓先生',
    ];
    const DEFAULT_EXCLUDE_LIST = ['永丰-龙华山', '永丰-贝婴之家'];

    function makeListStore(key, defaults) {
        const get = () => {
            try {
                const raw = localStorage.getItem(key);
                if (!raw) return [...defaults];
                const arr = JSON.parse(raw);
                if (!Array.isArray(arr) || !arr.length) return [...defaults];
                return arr.filter(Boolean);
            } catch (e) {
                return [...defaults];
            }
        };
        const set = (list) => { try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {} };
        const add = (name) => {
            const list = get();
            if (list.includes(name)) return false;
            list.push(name);
            set(list);
            return true;
        };
        const remove = (index) => {
            const list = get();
            if (index >= 0 && index < list.length) {
                list.splice(index, 1);
                set(list);
            }
        };
        const reset = () => { try { localStorage.removeItem(key); } catch (e) {} };
        return { get, set, add, remove, reset };
    }

    const warehouseStore = makeListStore(WAREHOUSE_LIST_STORAGE_KEY, DEFAULT_WAREHOUSE_LIST);
    const excludeStore = makeListStore(EXCLUDE_LIST_STORAGE_KEY, DEFAULT_EXCLUDE_LIST);

    const getWarehouseList = warehouseStore.get;
    const setWarehouseList = warehouseStore.set;
    const addWarehouseToList = warehouseStore.add;
    const removeWarehouseFromList = warehouseStore.remove;

    const getExcludeList = excludeStore.get;
    const setExcludeList = excludeStore.set;
    const addExcludeToList = excludeStore.add;
    const removeExcludeFromList = excludeStore.remove;

    /* ---------- 隐藏按钮存储 ---------- */
    const getHiddenButtons = () => {
        try {
            const raw = localStorage.getItem(HIDDEN_BUTTONS_STORAGE_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr.filter((s) => typeof s === 'string' && s);
        } catch (e) {
            return [];
        }
    };
    const setHiddenButtons = (list) => {
        try { localStorage.setItem(HIDDEN_BUTTONS_STORAGE_KEY, JSON.stringify(list)); } catch (e) {}
    };
    const resetHiddenButtons = () => {
        try { localStorage.removeItem(HIDDEN_BUTTONS_STORAGE_KEY); } catch (e) {}
    };

    const shortenButtonText = (name) => {
        const m = String(name).match(/^永丰[-_－—]\s*(.+)$/);
        return m ? m[1] : name;
    };

    /* ============================================================
     * 动态函数 & 面板配置
     * ============================================================ */
    const DYNAMIC_FNS = {};

    function rebuildDynamicFns() {
        for (const k of Object.keys(DYNAMIC_FNS)) delete DYNAMIC_FNS[k];
        getWarehouseList().forEach((name, idx) => {
            DYNAMIC_FNS[`fn_unrelated_dyn_${idx}`] =
                () => runUnrelatedOrder({ warehouseKeywords: name, sortBy: '线上商品' });
        });
    }

    // 永远显示、不参与隐藏控制的按钮（防止把配置入口锁死）
    const LOCKED_BUTTON_FNS = new Set(['fn_unrelated_config']);

    // 完整配置（含被隐藏的按钮）；供配置面板渲染
    function buildPanelConfigRaw() {
        rebuildDynamicFns();
        const unrelatedButtons = [{ text: '所有', fn: 'fn_unrelated_all' }];
        getWarehouseList().forEach((name, idx) => {
            unrelatedButtons.push({
                text: shortenButtonText(name),
                fn: `fn_unrelated_dyn_${idx}`,
                dynamic: true,
            });
        });
        unrelatedButtons.push({ text: '配置', fn: 'fn_unrelated_config', locked: true });

        return [{
            title: '订单审核',
            open: false,
            items: [
                {
                    label: '审单',
                    buttons: [
                        { text: '查询', fn: 'fn_query' },
                        { text: '无标记无备注', fn: 'fn_none_biaoji_none_remark' },
                        { text: '有标记无备注', fn: 'fn_has_biaoji_none_remark' },
                        { text: '有标记有备注', fn: 'fn_has_biaoji_has_remark' },
                        { text: '重置', fn: 'fn_reset' },
                    ],
                },
                {
                    label: '店铺选择',
                    buttons: [
                        { text: '上午', fn: 'fn_shop_morning' },
                        { text: '13:30', fn: 'fn_shop_1330' },
                        { text: '15:30', fn: 'fn_shop_1530' },
                        { text: '17:00', fn: 'fn_shop_1700' },
                    ],
                },
                {
                    label: '地区选择',
                    buttons: [
                        { text: '海南', fn: 'fn_region_hn' },
                        { text: '西藏', fn: 'fn_region_xz' },
                        { text: '新疆', fn: 'fn_region_xj' },
                        { text: '其它地区', fn: 'fn_region_other' },
                        { text: '偏远', fn: 'fn_region_pianyuan' },
                        { text: '非偏远', fn: 'fn_region_non_remote' },
                    ],
                },
                {
                    label: '一键执行',
                    buttons: [
                        { text: '简单筛选', fn: 'fn_execute_simple' },
                        { text: '有标记筛选', fn: 'fn_execute_simple_marked' },
                        { text: '宁仁涛2偏远', fn: 'fn_execute_ningrentao2' },
                    ],
                },
                {
                    label: '一键执行（特殊）',
                    buttons: [
                        { text: '邓先生', fn: 'fn_special_deng' },
                        { text: '黄小东', fn: 'fn_special_huang' },
                    ],
                },
                {
                    label: '未关联订单',
                    buttons: unrelatedButtons,
                },
            ],
        }];
    }

    // 过滤后配置；用于上报父面板
    function buildPanelConfig() {
        const hidden = new Set(getHiddenButtons());
        const raw = buildPanelConfigRaw();
        return raw
            .map((group) => ({
                ...group,
                items: group.items
                    .map((item) => ({
                        ...item,
                        buttons: item.buttons
                            .filter((b) => b.dynamic || b.locked || !hidden.has(b.fn))
                            .map((b) => {
                                const { dynamic, locked, ...rest } = b;
                                return rest;
                            }),
                    }))
                    .filter((item) => item.buttons.length > 0),
            }))
            .filter((group) => group.items.length > 0);
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
                    panelConfig: buildPanelConfig(),
                },
            }, '*');
        } catch (e) {}
    }

    /* ============================================================
     * 预设序列化 / 反序列化
     * ============================================================ */
    function serializePreset() {
        return JSON.stringify({
            version: 2,
            exportedAt: new Date().toISOString(),
            warehouseList: getWarehouseList(),
            excludeList: getExcludeList(),
            hiddenButtons: getHiddenButtons(),
        }, null, 2);
    }

    function parsePreset(text) {
        const raw = String(text || '').trim();
        if (!raw) throw new Error('内容为空');

        let data;
        try { data = JSON.parse(raw); }
        catch (e) { throw new Error('不是合法的 JSON 文本'); }

        // 兼容旧格式：纯数组 => 视为快速按钮名单
        if (Array.isArray(data)) data = { warehouseList: data };
        if (!data || typeof data !== 'object') throw new Error('格式不正确');

        const pick = (v) => {
            if (!Array.isArray(v)) return null;
            const out = [];
            const seen = new Set();
            for (const item of v) {
                if (typeof item !== 'string') continue;
                const s = item.trim();
                if (!s || seen.has(s)) continue;
                seen.add(s);
                out.push(s);
            }
            return out;
        };

        const warehouseList = pick(data.warehouseList);
        const excludeList = pick(data.excludeList);
        const hiddenButtons = pick(data.hiddenButtons);

        if (!warehouseList && !excludeList && !hiddenButtons) {
            throw new Error('未找到可导入字段（warehouseList / excludeList / hiddenButtons）');
        }
        return { warehouseList, excludeList, hiddenButtons };
    }

    /* ============================================================
     * 配置弹窗
     * ============================================================ */
    const BTN_BASE = 'padding: 6px 14px; border-radius: 5px; cursor: pointer; font-size: 12.5px; white-space: nowrap;';
    const ROW_BASE = 'display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 6px; margin-bottom: 6px;';
    const ROW_NAME = 'flex: 1; font-size: 13px; color: #1d2129; word-break: break-all;';
    const ROW_RUN = 'padding: 4px 12px; background: #2b6cff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
    const ROW_DEL = 'padding: 4px 10px; background: #fff; color: #f53f3f; border: 1px solid #f53f3f; border-radius: 4px; cursor: pointer; font-size: 12px;';
    const INPUT_STYLE = 'flex: 1; padding: 7px 12px; border: 1px solid #d9d9d9; border-radius: 5px; font-size: 13px; outline: none; box-sizing: border-box;';
    const ADD_BTN = (bg) => `padding: 7px 16px; background: ${bg}; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 13px; white-space: nowrap;`;
    const SECTION_TITLE = 'font-weight: 600; font-size: 13px; color: #1d2129; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;';
    const SECTION_BAR = (color) => `width: 3px; height: 14px; background: ${color}; border-radius: 2px;`;
    const CHIP_STYLE = (on) => `display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 14px; font-size: 12px; cursor: pointer; user-select: none; border: 1px solid ${on ? '#2b6cff' : '#d9d9d9'}; background: ${on ? '#eef3ff' : '#f7f8fa'}; color: ${on ? '#2b6cff' : '#86909c'};`;

    function showWarehousePanel() {
        const existing = document.getElementById('hupun-warehouse-panel');
        if (existing) { existing.remove(); return; }

        const panel = document.createElement('div');
        panel.id = 'hupun-warehouse-panel';
        panel.style.cssText = `
            position: fixed !important; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.45); z-index: 2147483647;
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
        `;

        panel.innerHTML = `
            <div style="width: 520px; max-height: 84vh; background: #fff; border-radius: 10px;
                        box-shadow: 0 12px 40px rgba(0,0,0,0.3); display: flex; flex-direction: column; overflow: hidden;">
                <div style="padding: 14px 18px; border-bottom: 1px solid #e5e6eb; display: flex;
                            justify-content: space-between; align-items: center; flex: 0 0 auto;">
                    <span style="font-weight: 600; font-size: 14px; color: #1d2129;">未关联订单 · 配置</span>
                    <span id="hw-close" style="cursor: pointer; font-size: 20px; color: #86909c;
                                               line-height: 1; padding: 0 4px; user-select: none;">×</span>
                </div>
                <div style="padding: 8px 18px; font-size: 11.5px; color: #86909c; background: #f7f8fa;
                            border-bottom: 1px solid #e5e6eb; line-height: 1.6; flex: 0 0 auto;">
                    「所有」= 搜索"永丰"全选后取消排除项，按<b>仓库</b>排序<br>
                    单个仓库按钮 = 直接搜名字全选，按<b>线上商品</b>排序<br>
                    改完会自动同步到父面板按钮
                </div>
                <div style="padding: 14px 18px; overflow-y: auto; flex: 1 1 auto;">
                    <div style="margin-bottom: 20px;">
                        <div style="${SECTION_TITLE}">
                            <span style="${SECTION_BAR('#2b6cff')}"></span>
                            快速按钮
                        </div>
                        <div id="hw-list"></div>
                        <div style="display: flex; gap: 8px; margin-top: 10px;">
                            <input id="hw-input" type="text" placeholder="输入仓库名，如 永丰-张三" style="${INPUT_STYLE}">
                            <button id="hw-add" type="button" style="${ADD_BTN('#2b6cff')}">添加</button>
                        </div>
                    </div>
                    <div style="margin-bottom: 20px;">
                        <div style="${SECTION_TITLE}">
                            <span style="${SECTION_BAR('#f53f3f')}"></span>
                            排除仓库（点「所有」时跳过）
                        </div>
                        <div id="hw-exclude-list"></div>
                        <div style="display: flex; gap: 8px; margin-top: 10px;">
                            <input id="hw-exclude-input" type="text" placeholder="输入要排除的仓库名，如 永丰-龙华山" style="${INPUT_STYLE}">
                            <button id="hw-exclude-add" type="button" style="${ADD_BTN('#f53f3f')}">添加</button>
                        </div>
                    </div>
                    <div>
                        <div style="${SECTION_TITLE}">
                            <span style="${SECTION_BAR('#86909c')}"></span>
                            面板按钮显示控制
                        </div>
                        <div style="font-size: 11.5px; color: #86909c; margin-bottom: 10px; line-height: 1.6;">
                            勾选 = 显示，取消 = 隐藏；「配置」按钮与动态仓库按钮不受此处控制，会始终显示。
                        </div>
                        <div id="hw-buttons"></div>
                    </div>
                </div>
                <div style="padding: 12px 18px; border-top: 1px solid #e5e6eb; background: #fafbfc; flex: 0 0 auto;">
                    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                        <button id="hw-export" type="button" style="${BTN_BASE} background: #2b6cff; color: #fff; border: 1px solid #2b6cff;">导出预设</button>
                        <button id="hw-import" type="button" style="${BTN_BASE} background: #fff; color: #2b6cff; border: 1px solid #2b6cff;">导入预设</button>
                        <button id="hw-copy" type="button" style="${BTN_BASE} background: #fff; color: #4e5969; border: 1px solid #d9d9d9;">复制</button>
                        <button id="hw-default" type="button" style="${BTN_BASE} background: #fff; color: #86909c; border: 1px solid #d9d9d9; margin-left: auto;">恢复默认</button>
                    </div>
                    <textarea id="hw-io" spellcheck="false"
                        placeholder="点击「导出预设」生成当前配置，或粘贴 JSON 后点击「导入预设」"
                        style="display: none; width: 100%; box-sizing: border-box; margin-top: 8px; height: 130px;
                               padding: 8px 10px; border: 1px solid #d9d9d9; border-radius: 5px; font-size: 12px;
                               font-family: Consolas, Menlo, monospace; line-height: 1.5; resize: vertical;
                               outline: none; color: #1d2129;"></textarea>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        const $ = (id) => panel.querySelector('#' + id);
        const listEl = $('hw-list');
        const excludeListEl = $('hw-exclude-list');
        const inputEl = $('hw-input');
        const excludeInputEl = $('hw-exclude-input');
        const ioEl = $('hw-io');
        let busy = false;

        /* ---------- 列表渲染 ---------- */
        function renderItems(container, items, opts) {
            const { deleteAct, withRun, bg, border, empty } = opts;
            container.innerHTML = '';
            if (!items.length) {
                container.innerHTML = `<div style="padding: 20px 12px; text-align: center; color: #86909c; font-size: 12.5px; background: #f7f8fa; border-radius: 6px;">${empty}</div>`;
                return;
            }
            items.forEach((name, idx) => {
                const row = document.createElement('div');
                row.style.cssText = ROW_BASE + `background: ${bg};` + (border ? ` border: ${border};` : '');
                row.innerHTML = `
                    <span style="${ROW_NAME}">${escapeHtml(name)}</span>
                    ${withRun ? `<button type="button" data-act="run" data-idx="${idx}" style="${ROW_RUN}">执行</button>` : ''}
                    <button type="button" data-act="${deleteAct}" data-idx="${idx}" style="${ROW_DEL}">删除</button>
                `;
                container.appendChild(row);
            });
        }

        const renderList = () => renderItems(listEl, getWarehouseList(), {
            deleteAct: 'del', withRun: true, bg: '#f7f8fa', border: '', empty: '名单为空',
        });
        const renderExcludeList = () => renderItems(excludeListEl, getExcludeList(), {
            deleteAct: 'del-exclude', withRun: false, bg: '#fff5f5', border: '1px solid #ffe1e1', empty: '暂无排除项',
        });

        /* ---------- 按钮显示控制 ---------- */
        function renderButtonToggles() {
            const container = $('hw-buttons');
            if (!container) return;
            const hidden = new Set(getHiddenButtons());
            const raw = buildPanelConfigRaw();
            container.innerHTML = '';

            raw.forEach((group) => {
                group.items.forEach((item) => {
                    // 动态仓库按钮 + 锁定按钮不在这里控制
                    const buttons = item.buttons.filter((b) => !b.dynamic && !b.locked);
                    if (!buttons.length) return;

                    const section = document.createElement('div');
                    section.style.cssText = 'margin-bottom: 12px;';

                    const title = document.createElement('div');
                    title.style.cssText = 'font-size: 12px; color: #4e5969; font-weight: 600; margin-bottom: 6px;';
                    title.textContent = item.label;
                    section.appendChild(title);

                    const wrap = document.createElement('div');
                    wrap.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';

                    buttons.forEach((btn) => {
                        const visible = !hidden.has(btn.fn);
                        const chip = document.createElement('label');
                        chip.style.cssText = CHIP_STYLE(visible);

                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.checked = visible;
                        cb.style.cssText = 'margin: 0; cursor: pointer; accent-color: #2b6cff;';
                        cb.addEventListener('change', () => {
                            const set = new Set(getHiddenButtons());
                            if (cb.checked) set.delete(btn.fn);
                            else set.add(btn.fn);
                            setHiddenButtons([...set]);
                            chip.style.cssText = CHIP_STYLE(cb.checked);
                            pushPanelConfig();
                        });

                        chip.appendChild(cb);
                        chip.appendChild(document.createTextNode(btn.text));
                        wrap.appendChild(chip);
                    });

                    section.appendChild(wrap);
                    container.appendChild(section);
                });
            });
        }

        /* ---------- 快速按钮列表事件 ---------- */
        listEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (busy) { alert('正在执行中，请稍候'); return; }

            const act = btn.dataset.act;
            const idx = parseInt(btn.dataset.idx, 10);

            if (act === 'del') {
                removeWarehouseFromList(idx);
                renderList();
                renderButtonToggles();
                pushPanelConfig();
                return;
            }
            if (act === 'run') {
                const name = getWarehouseList()[idx];
                if (!name) return;
                busy = true;
                btn.textContent = '…';
                btn.disabled = true;
                try {
                    await runUnrelatedOrder({ warehouseKeywords: name, sortBy: '线上商品' });
                } catch (err) {
                    alert('执行失败：' + ((err && err.message) || String(err)));
                } finally {
                    busy = false;
                    btn.textContent = '执行';
                    btn.disabled = false;
                }
            }
        });

        /* ---------- 排除列表事件 ---------- */
        excludeListEl.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn || btn.dataset.act !== 'del-exclude') return;
            removeExcludeFromList(parseInt(btn.dataset.idx, 10));
            renderExcludeList();
        });

        /* ---------- 添加逻辑 ---------- */
        function makeAddHandler(inputEl, addFn, renderFn, afterFn) {
            const doAdd = () => {
                const v = inputEl.value.trim();
                if (!v) return;
                if (!addFn(v)) { alert('已存在：' + v); return; }
                inputEl.value = '';
                renderFn();
                if (afterFn) afterFn();
            };
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
            });
            return doAdd;
        }

        $('hw-add').addEventListener('click',
            makeAddHandler(inputEl, addWarehouseToList, () => {
                renderList();
                renderButtonToggles();
            }, pushPanelConfig));
        $('hw-exclude-add').addEventListener('click',
            makeAddHandler(excludeInputEl, addExcludeToList, renderExcludeList));

        /* ---------- 导入 / 导出 / 复制 / 恢复默认 ---------- */
        $('hw-export').addEventListener('click', () => {
            ioEl.value = serializePreset();
            ioEl.style.display = 'block';
            ioEl.focus();
            ioEl.select();
        });

        $('hw-import').addEventListener('click', () => {
            if (ioEl.style.display === 'none') ioEl.style.display = 'block';
            if (!ioEl.value.trim()) { ioEl.focus(); return; }

            let preset;
            try { preset = parsePreset(ioEl.value); }
            catch (err) { alert('导入失败：' + ((err && err.message) || String(err))); return; }

            const parts = [];
            if (preset.warehouseList) parts.push(`快速按钮 ${preset.warehouseList.length} 项`);
            if (preset.excludeList) parts.push(`排除仓库 ${preset.excludeList.length} 项`);
            if (preset.hiddenButtons) parts.push(`隐藏按钮 ${preset.hiddenButtons.length} 项`);
            if (!parts.length) { alert('没有可导入的内容'); return; }
            if (!confirm('即将导入：' + parts.join('，') + '\n\n会覆盖对应配置，是否继续？')) return;

            if (preset.warehouseList) setWarehouseList(preset.warehouseList);
            if (preset.excludeList) setExcludeList(preset.excludeList);
            if (preset.hiddenButtons) setHiddenButtons(preset.hiddenButtons);

            renderList();
            renderExcludeList();
            renderButtonToggles();
            pushPanelConfig();
            alert('导入成功，父面板按钮已同步');
        });

        $('hw-copy').addEventListener('click', async () => {
            const btn = $('hw-copy');
            if (ioEl.style.display === 'none' || !ioEl.value.trim()) {
                ioEl.value = serializePreset();
                ioEl.style.display = 'block';
            }
            const text = ioEl.value;
            let done = false;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                    done = true;
                }
            } catch (e) {}
            if (!done) {
                try {
                    ioEl.focus();
                    ioEl.select();
                    done = document.execCommand('copy');
                } catch (e) {}
            }
            const old = btn.textContent;
            btn.textContent = done ? '已复制' : '复制失败';
            setTimeout(() => { btn.textContent = old; }, 1200);
        });

        $('hw-default').addEventListener('click', () => {
            if (!confirm('恢复为默认配置？当前自定义的快速按钮、排除仓库与按钮显示设置都将被清空。')) return;
            warehouseStore.reset();
            excludeStore.reset();
            resetHiddenButtons();
            renderList();
            renderExcludeList();
            renderButtonToggles();
            pushPanelConfig();
        });

        /* ---------- 关闭 ---------- */
        $('hw-close').addEventListener('click', () => panel.remove());
        panel.addEventListener('click', (e) => { if (e.target === panel) panel.remove(); });

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                const p = document.getElementById('hupun-warehouse-panel');
                if (p) p.remove();
                document.removeEventListener('keydown', escHandler, true);
            }
        };
        document.addEventListener('keydown', escHandler, true);

        renderList();
        renderExcludeList();
        renderButtonToggles();
        setTimeout(() => inputEl.focus(), 50);
    }

    /* ============================================================
     * 表格等待 + 排序
     * ============================================================ */
    async function waitTableLoaded({ timeout = 12000 } = {}) {
        await sleep(500);
        const start = Date.now();
        let noLoading = 0;
        while (Date.now() - start < timeout) {
            const loading = document.querySelector('.vxe-table--loading');
            if (loading && isVisible(loading)) noLoading = 0;
            else if (++noLoading >= 5) return true;
            await sleep(200);
        }
        return false;
    }

    async function sortByColumn(columnKeyword) {
        const headers = [...document.querySelectorAll('th.vxe-header--column')];
        let targetTh = null;
        for (const th of headers) {
            const titleEl = th.querySelector('.vxe-cell--title');
            if (titleEl && titleEl.textContent.trim().startsWith(columnKeyword)) {
                targetTh = th;
                break;
            }
        }
        if (!targetTh) {
            console.warn(`[sortByColumn] 未找到列头：${columnKeyword}`);
            return false;
        }
        const cell = targetTh.querySelector('.vxe-cell');
        if (!cell) return false;
        clickEl(cell);
        await sleep(1200);
        console.log(`[sortByColumn] 已按「${columnKeyword}」排序`);
        return true;
    }

    /* ============================================================
     * 标记多选
     * ============================================================ */
    function normalizeBiaoji(input) {
        if (!input) return [];
        if (Array.isArray(input)) {
            return input.map((it) => typeof it === 'string'
                ? { label: it, index: 0 }
                : { label: it.label, index: it.index ?? 0 });
        }
        if (typeof input === 'object') {
            return Object.entries(input).map(([label, index]) => ({ label, index }));
        }
        return [];
    }

    async function selectBiaoji(items) {
        const tasks = normalizeBiaoji(items);
        if (!tasks.length) return true;

        await closeAllPoppers();
        const trigger = getBiaojiTrigger();
        if (!trigger) { alert('无法定位到标记指定下拉框'); return false; }
        clickEl(trigger);

        if (!await waitFor(getVisibleCascaderDropdown, { timeout: 1200 })) {
            alert('无法定位到标记下拉面板');
            return false;
        }

        const failed = [];
        for (const { label, index } of tasks) {
            const dd = getVisibleCascaderDropdown();
            if (!dd) { failed.push(label); continue; }

            const nodes = [...dd.querySelectorAll('li.el-cascader-node')]
                .filter(isVisible)
                .filter((n) => {
                    const l = n.querySelector('.el-cascader-node__label');
                    return l && l.textContent.trim() === label;
                });

            const node = nodes[index];
            if (!node) { failed.push(label); continue; }
            const cb = node.querySelector('label.el-checkbox');
            if (!cb) { failed.push(label); continue; }
            if (!cb.classList.contains('is-checked')) {
                clickEl(cb);
                await sleep(30);
            }
        }

        await closeAllPoppers();
        if (failed.length) console.warn('[selectBiaoji] 未匹配：', failed);
        return failed.length === 0;
    }

    const ALL_BIAOJI_MARKED = [
        '无',
        '集采订单', '指定快递', '乡村件', '承诺送达',
        '亚美尼亚集运', '柬埔寨集运', '灾害原因不发', '老挝集运', '顺丰包邮',
        '格鲁吉亚集运', '中国澳门集运', '中国青海集运', '中国宁夏集运', '中国甘肃集运',
        '无盖', '中国内蒙古集运', '乌兹别克斯坦集运', '吉尔吉斯斯坦集运', '管控驱不发',
        '大连剪刀暂时不发', '承诺发货', '暂不发货', '北京暂时不发', '优先发货',
        'wms取消失败', '拼多多暂停发货', '发货后关闭', 'wms通知发货失败', '地址异常',
        '西藏中转', '泰国集运', '中国台湾集运', '越南集运', '日本集运',
        '新加坡集运', '韩国集运', '香港集运', '哈萨克斯坦集运', '马来西亚集运',
        '新疆中转', '加运费发顺丰',
    ];

    const selectMarkedBiaoji = () => selectBiaoji(ALL_BIAOJI_MARKED);
    const selectNoneBiaoji = () => selectBiaoji(['无']);

    /* ============================================================
     * 备注内容
     * ============================================================ */
    function normalizeRemark(input) {
        if (!input) return ['无内容'];
        if (typeof input === 'string') return [input];
        if (Array.isArray(input)) return input.filter(Boolean);
        if (typeof input === 'object') {
            return Object.entries(input).filter(([, v]) => v).map(([k]) => k);
        }
        return ['无内容'];
    }

    async function selectRemark(types) {
        const targets = normalizeRemark(types);
        if (!targets.length) return true;

        await closeAllPoppers();
        const trigger = getRemarkTrigger();
        if (!trigger) { alert('无法定位到备注下拉框'); return false; }
        clickEl(trigger);
        await sleep(300);

        const failed = [];
        for (const text of targets) {
            let item = findVisibleOptionByText(text);
            if (!item) {
                clickEl(trigger);
                await sleep(250);
                item = findVisibleOptionByText(text);
            }
            if (!item) { failed.push(text); continue; }

            const selected = item.classList.contains('selected')
                || item.classList.contains('is-selected')
                || item.getAttribute('aria-selected') === 'true';
            if (selected) continue;

            clickEl(item);
            await sleep(150);
        }

        await closeAllPoppers();
        if (failed.length) console.warn('[selectRemark] 未匹配：', failed);
        return failed.length === 0;
    }

    /* ============================================================
     * 省市区
     * ============================================================ */
    const PROVINCE_TABS = ['省', '市', '区县'];

    async function clearAllProvinces() {
        await expandMore();
        const trigger = getShengfengTrigger();
        if (!trigger) return false;

        await closeAllPoppers();
        clickEl(trigger);
        await sleep(200);
        if (!isShengfengOpen()) return false;

        const regionInput = q('.region-select .region-select-input input');
        if (regionInput && regionInput.value) {
            setInputValue(regionInput, '');
            await sleep(100);
        }

        for (const tabName of PROVINCE_TABS) {
            const tab = document.getElementById('tab-' + tabName);
            if (!tab || tab.classList.contains('is-disabled')) continue;
            if (!tab.classList.contains('is-active')) {
                clickEl(tab);
                await sleep(80);
            }
            const pane = document.getElementById('pane-' + tabName);
            if (!pane) continue;

            for (let round = 0; round < 5; round++) {
                const checked = pane.querySelectorAll(
                    'label.el-checkbox.is-checked, .el-checkbox__input.is-checked'
                );
                if (!checked.length) break;
                for (const cb of checked) {
                    clickEl(cb.closest('label.el-checkbox') || cb);
                    await sleep(20);
                }
            }
        }

        for (const c of document.querySelectorAll(
            '.region-select .tags .el-tag__close, .region-select .tags .el-icon-close'
        )) {
            clickEl(c);
            await sleep(30);
        }

        const shengTab = document.getElementById('tab-省');
        if (shengTab && !shengTab.classList.contains('is-active')) {
            clickEl(shengTab);
            await sleep(80);
        }
        return true;
    }

    function findProvinceCheckbox(SF, pane) {
        if (!pane) return null;

        const exact = document.evaluate(
            ".//div[contains(@class,'region-box') and normalize-space(.)='" + SF + "']" +
            "/ancestor::div[contains(@class,'region')][1]//label[contains(@class,'el-checkbox')]",
            pane, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (exact) return exact;

        for (const box of pane.querySelectorAll('.region-box')) {
            const name = box.textContent.trim();
            if (name === SF || name.startsWith(SF)) {
                const region = box.closest('[class*="region"]');
                if (!region) continue;
                const cb = region.querySelector('label.el-checkbox');
                if (cb) return cb;
            }
        }
        return null;
    }

    async function selectShengfengMulti(list, { skipClear = false } = {}) {
        if (!list || !list.length) return true;
        if (!skipClear) await clearAllProvinces();

        await expandMore();
        const trigger = getShengfengTrigger();
        if (!trigger) { alert('无法定位到省份下拉框'); return false; }

        if (!isShengfengOpen()) {
            clickEl(trigger);
            await sleep(200);
        }
        if (!isShengfengOpen()) { alert('无法打开省份下拉'); return false; }

        const shengTab = document.getElementById('tab-省');
        if (shengTab && !shengTab.classList.contains('is-active')) {
            clickEl(shengTab);
            await sleep(80);
        }

        const pane = document.getElementById('pane-省');
        if (!pane) return false;

        const failed = [];
        for (const SF of list) {
            const cb = findProvinceCheckbox(SF, pane);
            if (!cb) { failed.push(SF); continue; }
            if (!cb.classList.contains('is-checked')) {
                clickEl(cb);
                await sleep(25);
            }
        }

        if (isShengfengOpen()) {
            clickEl(trigger);
            await sleep(100);
        }

        if (failed.length) console.warn('[selectShengfengMulti] 未找到：', failed);
        return failed.length === 0;
    }

    async function getAllProvinces() {
        await expandMore();
        const trigger = getShengfengTrigger();
        if (!trigger) return [];

        await closeAllPoppers();
        clickEl(trigger);
        await sleep(250);
        if (!isShengfengOpen()) return [];

        const shengTab = document.getElementById('tab-省');
        if (shengTab && !shengTab.classList.contains('is-active')) {
            clickEl(shengTab);
            await sleep(100);
        }

        const pane = document.getElementById('pane-省');
        if (!pane) return [];

        const names = [...pane.querySelectorAll('.region-box')]
            .map((el) => el.textContent.trim())
            .filter(Boolean);

        if (isShengfengOpen()) {
            clickEl(trigger);
            await sleep(100);
        }
        return names;
    }

    /* ============================================================
     * 偏远地区
     * ============================================================ */
    const REMOTE_REGIONS = [
        '香港特别行政区', '澳门特别行政区', '海外',
        '新疆维吾尔自治区', '西藏自治区', '内蒙古自治区', '宁夏回族自治区',
    ];

    /* ============================================================
     * 审单
     * ============================================================ */
    async function fn_query() {
        clickQueryButton();
        return { ok: true, action: '查询' };
    }

    async function fn_none_biaoji_none_remark() {
        await selectNoneBiaoji();
        await selectRemark('无内容');
        return { ok: true, action: '无标记无备注（仅设条件）' };
    }

    async function fn_has_biaoji_none_remark() {
        await selectMarkedBiaoji();
        await selectRemark('无内容');
        return { ok: true, action: '有标记无备注（含无标记，仅设条件）' };
    }

    async function fn_has_biaoji_has_remark() {
        await selectMarkedBiaoji();
        await selectRemark('有内容');
        return { ok: true, action: '有标记有备注（含无标记，仅设条件）' };
    }

    async function fn_reset() {
        await closeAllPoppers();

        const more = getMoreButton();
        if (more && more.classList.contains('opened')) {
            clickEl(more);
            await sleep(200);
        }

        const resetBtn = await waitFor(getResetButton, { timeout: 1500 });
        if (!resetBtn) throw new Error('找不到【重置】按钮');

        clickEl(resetBtn);
        await sleep(80);
        const inner = resetBtn.querySelector('span');
        if (inner) clickEl(inner);
        await sleep(300);

        const more2 = getMoreButton();
        if (more2 && more2.classList.contains('opened')) {
            clickEl(more2);
            await sleep(150);
        }
        return { ok: true, action: '重置' };
    }

    /* ============================================================
     * 地区选择
     * ============================================================ */
    const regionFn = (regions, action) => async () => {
        await selectShengfengMulti(regions);
        return { ok: true, action, regions };
    };
    const fn_region_hn = regionFn(['海南省'], '选择海南');
    const fn_region_xz = regionFn(['西藏自治区'], '选择西藏');
    const fn_region_xj = regionFn(['新疆维吾尔自治区'], '选择新疆');

    async function fn_region_other() {
        const all = await getAllProvinces();
        if (!all.length) throw new Error('无法获取省份列表');

        const exclude = ['海南省', '西藏自治区', '新疆维吾尔自治区'];
        const targets = all.filter((p) => !exclude.includes(p));
        if (!targets.length) throw new Error('没有可选择的省份');

        const ok = await selectShengfengMulti(targets);
        return { ok: true, action: '其它地区', count: targets.length, applied: ok };
    }

    async function fn_region_pianyuan() {
        await selectShengfengMulti(REMOTE_REGIONS);
        return { ok: true, action: '选择偏远', regions: REMOTE_REGIONS };
    }

    async function fn_region_non_remote() {
        const all = await getAllProvinces();
        if (!all.length) throw new Error('无法获取省份列表');

        const targets = all.filter((p) => !REMOTE_REGIONS.includes(p));
        if (!targets.length) throw new Error('没有可选择的省份');

        const ok = await selectShengfengMulti(targets);
        return {
            ok: true, action: '非偏远地区', count: targets.length,
            applied: ok, excluded: REMOTE_REGIONS,
        };
    }

    /* ============================================================
     * 店铺预设
     * ============================================================ */
    const SHOP_PRESET_SHOPS = {
        morning: ['永丰'],
        '1330':  ['永丰', '晋贤', '张龙'],
        '1530':  ['永丰', '晋贤', '张龙', '曾招伟'],
        '1700':  ['永丰', '晋贤', '张龙', '曾招伟', '范婕', '袁颖慧'],
    };

    const shopFn = (key, label) => async () => {
        await selectShop(SHOP_PRESET_SHOPS[key]);
        return { ok: true, action: label, shops: SHOP_PRESET_SHOPS[key] };
    };
    const fn_shop_morning = shopFn('morning', '上午');
    const fn_shop_1330 = shopFn('1330', '13:30');
    const fn_shop_1530 = shopFn('1530', '15:30');
    const fn_shop_1700 = shopFn('1700', '17:00');

    // 根据当前时间挑选对应的店铺预设
    //   <12:00 -> 上午    <14:00 -> 13:30   <16:00 -> 15:30   其余 -> 17:00
    function getCurrentShopPreset() {
        const hour = new Date().getHours();
        if (hour < 12) return { key: 'morning', label: '上午' };
        if (hour < 14) return { key: '1330', label: '13:30' };
        if (hour < 16) return { key: '1530', label: '15:30' };
        return { key: '1700', label: '17:00' };
    }

    /* ============================================================
     * 一键执行
     * ============================================================ */
    async function fn_execute_simple() {
        const preset = getCurrentShopPreset();
        const shops = SHOP_PRESET_SHOPS[preset.key];

        await selectShop(shops);
        await selectNoneBiaoji();
        await selectRemark('无内容');
        await fn_region_other();
        clickQueryButton();

        return {
            ok: true, action: '简单筛选',
            shops, presetTime: preset.label, region: 'other',
        };
    }

    // 与简单筛选一致，仅把"无标记"换成"有标记无备注"
    async function fn_execute_simple_marked() {
        const preset = getCurrentShopPreset();
        const shops = SHOP_PRESET_SHOPS[preset.key];

        await selectShop(shops);
        await selectMarkedBiaoji();
        await selectRemark('无内容');
        await fn_region_other();
        clickQueryButton();

        return {
            ok: true, action: '有标记筛选',
            shops, presetTime: preset.label,
            biaoji: '有标记（含无标记）', region: 'other',
        };
    }

    async function fn_execute_ningrentao2() {
        const SHOP_KEYWORD = '永丰-宁仁涛';
        await selectShop(SHOP_KEYWORD);
        await selectMarkedBiaoji();
        await selectRemark('无内容');
        await fn_region_pianyuan();
        clickQueryButton();
        return {
            ok: true, action: '简单筛选·宁仁涛2偏远',
            shopKeyword: SHOP_KEYWORD, biaoji: '有标记（含无标记）',
            remark: '无内容', region: '偏远',
        };
    }

    /* ============================================================
     * 特殊一键执行
     * ============================================================ */
    async function fn_special_deng() {
        const SHOP_KEYWORD = '永丰-邓先生';
        const REGIONS = ['江苏省', '浙江省', '上海市', '江西省', '广东省', '湖南省'];
        await fn_reset();
        await selectShop(SHOP_KEYWORD);
        await selectNoneBiaoji();
        await selectRemark('无内容');
        await selectShengfengMulti(REGIONS);
        clickQueryButton();
        return { ok: true, action: '邓先生', shopKeyword: SHOP_KEYWORD, regions: REGIONS };
    }

    async function fn_special_huang() {
        const SHOP_KEYWORD = '黄小东';
        await fn_reset();
        await selectShop(SHOP_KEYWORD);

        const all = await getAllProvinces();
        if (!all.length) throw new Error('无法获取省份列表');
        const exclude = ['新疆维吾尔自治区', '西藏自治区'];
        const targets = all.filter((p) => !exclude.includes(p));
        if (!targets.length) throw new Error('没有可选择的省份');

        await selectShengfengMulti(targets);
        clickQueryButton();
        return {
            ok: true, action: '黄小东', shopKeyword: SHOP_KEYWORD,
            regionCount: targets.length, exclude,
        };
    }

    /* ============================================================
     * 未关联订单
     * ============================================================ */
    const UNRELATED_BIAOJI = '不从系统发货';
    const UNRELATED_REMARK = '无内容';
    const ALL_YONGFENG_KEYWORD = '永丰';

    async function runUnrelatedOrder({ warehouseKeywords, sortBy = '仓库' }) {
        await fn_reset();
        await selectBiaoji([UNRELATED_BIAOJI]);
        await selectRemark(UNRELATED_REMARK);
        await selectWarehouse(warehouseKeywords);
        clickQueryButton();

        const loaded = await waitTableLoaded({ timeout: 12000 });
        if (!loaded) console.warn('[runUnrelatedOrder] 表格加载超时，仍尝试排序');
        const sorted = await sortByColumn(sortBy);

        return { ok: true, action: '未关联订单', warehouseKeywords, sortBy, loaded, sorted };
    }

    async function fn_unrelated_all() {
        const excludeList = getExcludeList();
        console.log('[所有] 排除列表：', excludeList);

        await fn_reset();
        await selectBiaoji([UNRELATED_BIAOJI]);
        await selectRemark(UNRELATED_REMARK);
        await selectWarehouse(ALL_YONGFENG_KEYWORD);

        const excludeOk = excludeList.length ? await excludeWarehouse(excludeList) : true;
        clickQueryButton();

        const loaded = await waitTableLoaded({ timeout: 12000 });
        if (!loaded) console.warn('[所有] 表格加载超时，仍尝试排序');
        const sorted = await sortByColumn('仓库');

        return {
            ok: true, action: '未关联订单（所有）', keyword: ALL_YONGFENG_KEYWORD,
            excluded: excludeList, excludeOk, sortBy: '仓库', loaded, sorted,
        };
    }

    async function fn_unrelated_config() {
        showWarehousePanel();
        return { ok: true, action: '打开配置' };
    }

    /* ============================================================
     * 消息处理
     * ============================================================ */
    const FUNC_MAP = {
        fn_query, fn_none_biaoji_none_remark, fn_has_biaoji_none_remark, fn_has_biaoji_has_remark,
        fn_reset,
        fn_region_hn, fn_region_xz, fn_region_xj, fn_region_other, fn_region_pianyuan, fn_region_non_remote,
        fn_shop_morning, fn_shop_1330, fn_shop_1530, fn_shop_1700,
        fn_execute_simple, fn_execute_simple_marked, fn_execute_ningrentao2,
        fn_special_deng, fn_special_huang,
        fn_unrelated_all, fn_unrelated_config,
    };

    let acked = false;

    function reply(source, payload) {
        if (!source) return;
        try {
            source.postMessage(Object.assign({
                __tm_channel: CHANNEL,
                type: 'RESULT',
                from: SELF_NAME,
            }, payload), '*');
        } catch (e) {}
    }

    function handleCall(data, source) {
        if (data.target && data.target !== SELF_NAME) return;
        const { id, fn: fnName } = data;
        const args = Array.isArray(data.args) ? data.args : [];
        const fn = FUNC_MAP[fnName] || DYNAMIC_FNS[fnName];

        if (typeof fn !== 'function') {
            reply(source, { id, ok: false, error: '执行端未找到函数：' + fnName });
            return;
        }

        Promise.resolve()
            .then(() => fn.apply(null, args))
            .then((result) => reply(source, { id, ok: true, data: result }))
            .catch((err) => reply(source, { id, ok: false, error: (err && err.message) || String(err) }));
    }

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
                    ts: Date.now(),
                    panelConfig: buildPanelConfig(),
                },
            }, '*');
        } catch (e) {}
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;

        if (data.type === 'ACK') { acked = true; return; }
        if (data.type === 'DISCOVER') { acked = false; sendReady(); return; }
        if (data.type === 'CALL') handleCall(data, event.source);
    });

    /* ============================================================
     * 注册
     * ============================================================ */
    let attempts = 0;
    const MAX_ATTEMPTS = 20;
    const INTERVAL = 1500;

    sendReady();
    const registerTimer = setInterval(() => {
        if (acked || attempts++ >= MAX_ATTEMPTS) {
            clearInterval(registerTimer);
            return;
        }
        sendReady();
    }, INTERVAL);

})();
