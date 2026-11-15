// ==UserScript==
// @name         悬浮功能面板 - 订单批量创建执行端
// @namespace    https://example.com/tm-panel
// @version      1.0.0
// @description  订单批量创建：6 档速度 + 停止/恢复二合一 + 日志逆序上报 + 互斥 + 商品映射（按货主分组记忆 + 记忆管理 + 导入导出 + 编辑）+ 暂停手动编辑 + 聊天记录/通用文本双模式解析 + 商品单位自定义 + 中文数量识别 + 噪音行自动过滤 + 数量后干扰项提示 + 默认商品占位 + 快递选择 + 仓库记忆 + 快递记忆 + 免确认模式（需信息完整 + 二次确认）
// @author       You
// @match        https://*.hupun.com/calf-biz/trade/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (!location.hash.startsWith('#/create')) return;
    if (window.self === window.top) return;

    const CHANNEL   = 'tm_panel_exec';
    const SELF_NAME = 'order_create';

    /* ============================================================
     * 面板 UI 配置
     * ============================================================ */
    const LOG_ITEM_LABEL = '运行日志';
    const PANEL_CONFIG = [
        {
            title: '订单',
            open: true,
            logs: true,
            supportsPause: true,
            supportsProgress: true,
            supportsMutex: true,
            supportsDynamicButtons: true,
            items: [
                {
                    label: '批量下单',
                    buttons: [
                        {
                            key: 'chatImport',
                            text: '聊天转订单',
                            fn: 'create_order_chat_import'
                        },
                        {
                            key: 'genericImport',
                            text: '通用文本转订单',
                            fn: 'create_order_generic_import'
                        }
                    ]
                },
                {
                    label: LOG_ITEM_LABEL,
                    textareas: [
                        { key: 'logArea', placeholder: '运行日志（最新在上）…', rows: 12, value: '' }
                    ]
                }
            ]
        }
    ];

    /* ============================================================
     * 速度档位
     * ============================================================ */
    const SPEED_PRESETS = {
        '极速': { clickDelay: 80,  enterDelay: 400,  stepDelay: 250,  orderDelay: 200,  skuWait: 2500,  identifyWait: 700,  submitWait: 600,  resetWait: 350,  simulateGap: 10 },
        '快速': { clickDelay: 120, enterDelay: 700,  stepDelay: 400,  orderDelay: 350,  skuWait: 3500,  identifyWait: 1000, submitWait: 900,  resetWait: 500,  simulateGap: 15 },
        '较快': { clickDelay: 180, enterDelay: 1000, stepDelay: 600,  orderDelay: 550,  skuWait: 4500,  identifyWait: 1300, submitWait: 1200, resetWait: 650,  simulateGap: 20 },
        '正常': { clickDelay: 250, enterDelay: 1400, stepDelay: 850,  orderDelay: 900,  skuWait: 6000,  identifyWait: 1700, submitWait: 1500, resetWait: 850,  simulateGap: 28 },
        '较慢': { clickDelay: 400, enterDelay: 1800, stepDelay: 1200, orderDelay: 1300, skuWait: 8000,  identifyWait: 2200, submitWait: 1800, resetWait: 1100, simulateGap: 40 },
        '慢速': { clickDelay: 500, enterDelay: 2000, stepDelay: 1500, orderDelay: 1500, skuWait: 10000, identifyWait: 2500, submitWait: 2000, resetWait: 1200, simulateGap: 50 }
    };
    let currentPreset = SPEED_PRESETS['正常'];
    let payloadSpeedNameCache = '正常';

    /* ============================================================
     * 仓库 / 快递公司 记忆（含删除）
     * ============================================================ */
    const WAREHOUSE_HISTORY_KEY = 'tm_warehouse_history_v1';
    const EXPRESS_HISTORY_KEY   = 'tm_express_history_v1';

    const EXPRESS_PRESETS = [
        '淘宝中通', '拼多多中通', '抖音中通', '快手中通', '京东中通',
        '邮政快递', '极兔快递', '圆通速递', '中通快递', '申通快递',
        '韵达快递', '顺丰快递', 'EMS', '丰网快递'
    ];

    /* ------------------------------------------------------------
     * 噪音过滤词（聊天/通用文本里固定出现的占位串，如 XX____）
     * ------------------------------------------------------------ */
    const NOISE_KEYWORDS_KEY = 'tm_noise_keywords_v1';
    const NOISE_KEYWORDS_DEFAULT = ['XX____', 'XX__'];

    function getNoiseKeywords() {
        try {
            const raw = localStorage.getItem(NOISE_KEYWORDS_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) return arr.map(s => String(s).trim()).filter(Boolean);
            }
        } catch (e) {}
        return NOISE_KEYWORDS_DEFAULT.slice();
    }

    function setNoiseKeywords(list) {
        const clean = (list || []).map(s => String(s).trim()).filter(Boolean);
        try { localStorage.setItem(NOISE_KEYWORDS_KEY, JSON.stringify(clean)); } catch (e) {}
        return clean;
    }

    function readHistory(key, max) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            const out = [];
            for (const v of arr) {
                const s = String(v == null ? '' : v).trim();
                if (s && out.indexOf(s) < 0) out.push(s);
                if (out.length >= max) break;
            }
            return out;
        } catch (e) {
            return [];
        }
    }

    function writeHistory(key, list) {
        try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
    }

    function pushHistory(key, value, max) {
        const s = String(value == null ? '' : value).trim();
        if (!s) return;
        const list = readHistory(key, max).filter(function (v) { return v !== s; });
        list.unshift(s);
        writeHistory(key, list.slice(0, max));
    }

    function getWarehouseHistory() { return readHistory(WAREHOUSE_HISTORY_KEY, 20); }
    function addWarehouseHistory(v) { pushHistory(WAREHOUSE_HISTORY_KEY, v, 20); }
    function removeWarehouseHistory(v) {
        const s = String(v == null ? '' : v).trim();
        if (!s) return { ok: false };
        const list = readHistory(WAREHOUSE_HISTORY_KEY, 100).filter(x => x !== s);
        writeHistory(WAREHOUSE_HISTORY_KEY, list);
        return { ok: true };
    }

    function getExpressOptions() {
        const hist = readHistory(EXPRESS_HISTORY_KEY, 10);
        const out = hist.slice();
        for (let i = 0; i < EXPRESS_PRESETS.length; i++) {
            if (out.indexOf(EXPRESS_PRESETS[i]) < 0) out.push(EXPRESS_PRESETS[i]);
        }
        return out;
    }
    function addExpressHistory(v) { pushHistory(EXPRESS_HISTORY_KEY, v, 10); }
    function removeExpressHistory(v) {
        const s = String(v == null ? '' : v).trim();
        if (!s) return { ok: false };
        if (EXPRESS_PRESETS.indexOf(s) >= 0) return { ok: false, message: '预设快递不可删除' };
        const list = readHistory(EXPRESS_HISTORY_KEY, 100).filter(x => x !== s);
        writeHistory(EXPRESS_HISTORY_KEY, list);
        return { ok: true };
    }

    /* ============================================================
     * 一、日志
     * ============================================================ */
    const LOG_BUFFER_MAX  = 500;
    const LOG_DISPLAY_MAX = 300;
    const LOG_LEVEL_MARK  = { info: '·', tip: '▸', ok: '✓', error: '✗', warn: '⚠' };
    const logBuffer = [];

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function formatLogTime(d) {
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    let __logDirty = false;

    function logMsg(text, level) {
        level = level || 'info';
        const mark = LOG_LEVEL_MARK[level] || '·';
        const clean = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
        logBuffer.push(formatLogTime(new Date()) + ' ' + mark + ' ' + clean);
        if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
        __logDirty = true;
        if (level === 'error') console.error('[批量下单]', clean);
        else console.log('[批量下单]', clean);
    }

    function logDivider(text) {
        const line = text ? ('— ' + text + ' —') : '────────────────';
        logBuffer.push(line);
        if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
        __logDirty = true;
    }

    function syncLogToConfig() {
        const visible = logBuffer.slice(-LOG_DISPLAY_MAX);
        let errCount = 0;
        for (let i = 0; i < visible.length; i++) {
            if (visible[i].charAt(9) === '✗') errCount++;
        }
        const header = errCount
            ? '— 共 ' + visible.length + ' 条 · 错误 ' + errCount + ' 条 —'
            : '— 共 ' + visible.length + ' 条 —';
        const text = visible.length
            ? header + '\n' + visible.slice().reverse().join('\n')
            : header;

        const items = PANEL_CONFIG[0].items;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it && it.label === LOG_ITEM_LABEL && Array.isArray(it.textareas) && it.textareas[0]) {
                it.textareas[0].value = text;
                return text;
            }
        }
        return text;
    }

    function forceSendReady() {
        syncLogToConfig();
        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL, type: 'READY',
                info: {
                    name: SELF_NAME, url: location.href,
                    title: document.title, ts: Date.now(),
                    panelConfig: PANEL_CONFIG
                }
            }, '*');
        } catch (e) {}
    }

    let __lastReportTs = 0;
    const REPORT_MIN_INTERVAL = 1000;
    setInterval(function () {
        if (!__logDirty) return;
        const now = Date.now();
        if (now - __lastReportTs < REPORT_MIN_INTERVAL) return;
        __logDirty = false;
        __lastReportTs = now;
        forceSendReady();
    }, 300);

    /* ============================================================
     * 二、基础工具
     * ============================================================ */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (s) => (s || '').replace(/[\s\u3000*＊]/g, '');
    const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };

    function hoverEl(el) {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const base = {
            bubbles: true, cancelable: true, view: window,
            clientX: r.left + Math.max(1, r.width) / 2,
            clientY: r.top + Math.max(1, r.height) / 2
        };
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new MouseEvent('mouseenter', base));
        el.dispatchEvent(new MouseEvent('mousemove', base));
    }

    function clickEl(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        const r = el.getBoundingClientRect();
        const opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: r.left + Math.max(1, r.width) / 2,
            clientY: r.top + Math.max(1, r.height) / 2,
            button: 0
        };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
    }

    function doubleClickEl(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        const r = el.getBoundingClientRect();
        const opts = {
            bubbles: true, cancelable: true, view: window,
            clientX: r.left + Math.max(1, r.width) / 2,
            clientY: r.top + Math.max(1, r.height) / 2,
            button: 0
        };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        el.dispatchEvent(new MouseEvent('dblclick', opts));
        return true;
    }

    function setInputValue(input, value) {
        if (!input) return;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setTextareaValue(textarea, value) {
        if (!textarea) return;
        textarea.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function simulateTyping(input, text) {
        if (!input || !text) return;
        input.focus();
        try { input.click(); } catch (e) {}
        await sleep(120);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(120);
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const keyCode = ch.charCodeAt(0);
            let code = '';
            if (/[a-zA-Z]/.test(ch)) code = 'Key' + ch.toUpperCase();
            else if (/[0-9]/.test(ch)) code = 'Digit' + ch;
            else if (ch === '-') code = 'Minus';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
            try { input.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: keyCode, keyCode, which: keyCode, bubbles: true, cancelable: true })); } catch (e) {}
            const newVal = input.value + ch;
            setter.call(input, newVal);
            try {
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
            } catch (e) {
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
            await sleep(currentPreset.simulateGap);
        }
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function focusAndEnter(el) {
        if (!el) return;
        try { el.focus(); } catch (e) {}
        await sleep(60);
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    async function focusAndArrowDown(el) {
        if (!el) return;
        try { el.focus(); } catch (e) {}
        await sleep(40);
        const opts = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    /* ============================================================
     * 二·五、解析相关常量 / 工具
     * ============================================================ */
    let chatDialogRefreshActionBar = null;

    const RE_PHONE = /(?:\+?86[\s-]?)?(?:1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}|1[3-9]\d\*{4}\d{4}|400[\s-]?\d{3}[\s-]?\d{4}|0\d{2,3}[\s-]?\d{7,8}(?:[\s-]?\d{1,6})?)/;
    const ADDR_WORDS = '(?:省|市|区|县|旗|镇|乡|街道|路|街|道|巷|号|村|小区|大厦|广场|花园|苑|园|院|公寓|社区|栋|幢|单元|室|楼|座|弄|里|层)';
    const RE_ADDR_CHAR = new RegExp(ADDR_WORDS);
    const RE_ADDR = new RegExp('((?:[\\u4e00-\\u9fa5]{2,}' + ADDR_WORDS + '[\\u4e00-\\u9fa5\\d\\-]*)+)');

    const DEFAULT_GOODS_NAME = '默认商品';

    /* ---- 中文数量支持（一~十、十一~九十九、两、零）---- */
    const CN_NUM_MAP = {
        '零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '贰': 2, '两': 2,
        '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5,
        '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9
    };
    const CN_NUM_CHARS = '零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾';
    const QTY_PAT = '(?:\\d+(?:\\.\\d+)?|[' + CN_NUM_CHARS + ']{1,3})';

    function cnQtyToNumber(s) {
        s = String(s == null ? '' : s).trim();
        if (!s) return '';
        if (/^\d+(?:\.\d+)?$/.test(s)) return s;
        const tenRe = new RegExp('^([一二两三四五六七八九壹贰叁肆伍陆柒捌玖])?[十拾]([一二三四五六七八九壹贰叁肆伍陆柒捌玖])?$');
        const m = s.match(tenRe);
        if (m) {
            const tens = m[1] ? (CN_NUM_MAP[m[1]] || 0) : 1;
            const ones = m[2] ? (CN_NUM_MAP[m[2]] || 0) : 0;
            return String(tens * 10 + ones);
        }
        if (s.length === 1 && CN_NUM_MAP[s] != null) return String(CN_NUM_MAP[s]);
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (CN_NUM_MAP[ch] == null || CN_NUM_MAP[ch] > 9) return '';
            out += CN_NUM_MAP[ch];
        }
        return out ? String(parseInt(out, 10)) : '';
    }

    function escapeReg(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const UNITS_STORAGE_KEY = 'tm_goods_units_v1';
    const GOODS_PRESET_KEY = 'tm_goods_presets_v2';
    const GOODS_PRESET_KEY_LEGACY = 'tm_goods_presets_v1';
    const UNGROUPED_OWNER = '__ungrouped__';
    const UNGROUPED_LABEL = '未分组记忆';

    /* 精简版常用中文单位（无英文单位、无重复项） */
    const DEFAULT_UNITS = [
        '个', '只', '支', '条', '片', '颗', '粒', '根', '棵', '把',
        '台', '部', '块', '张', '卷', '枚', '副',
        '瓶', '盒', '件', '包', '袋', '罐', '箱', '桶', '听', '杯',
        '碗', '壶',
        '斤', '克', '千克', '公斤', '吨', '两',
        '份', '套', '双', '对', '组', '打', '捆', '串', '提'
    ];

    function getUnits() {
        try {
            const raw = localStorage.getItem(UNITS_STORAGE_KEY);
            if (!raw) return DEFAULT_UNITS.slice();
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return DEFAULT_UNITS.slice();
            const seen = Object.create(null);
            const out = [];
            for (const u of arr) {
                const s = String(u == null ? '' : u).trim();
                if (!s || seen[s]) continue;
                seen[s] = 1;
                out.push(s);
            }
            return out.length ? out : DEFAULT_UNITS.slice();
        } catch (e) {
            return DEFAULT_UNITS.slice();
        }
    }

    function saveUnits(units) {
        try {
            const seen = Object.create(null);
            const out = [];
            for (const u of units || []) {
                const s = String(u == null ? '' : u).trim();
                if (!s || seen[s]) continue;
                seen[s] = 1;
                out.push(s);
            }
            localStorage.setItem(UNITS_STORAGE_KEY, JSON.stringify(out));
        } catch (e) {}
    }

    function addUnit(unit) {
        const s = String(unit == null ? '' : unit).trim();
        if (!s) return { ok: false, message: '单位不能为空' };
        if (s.length > 8) return { ok: false, message: '单位最多 8 个字符' };
        if (/\s/.test(s)) return { ok: false, message: '单位不能包含空格' };
        const units = getUnits();
        if (units.indexOf(s) >= 0) return { ok: false, message: '单位「' + s + '」已存在' };
        units.push(s);
        saveUnits(units);
        return { ok: true, units: units };
    }

    function removeUnit(unit) {
        const s = String(unit == null ? '' : unit).trim();
        const units = getUnits().filter(u => u !== s);
        saveUnits(units);
        return { ok: true, units: units };
    }

    /* ============================================================
     * 商品编码预设（货主 → 商品名 → 编码）
     * ============================================================ */
    function normalizeOwner(owner) {
        return String(owner == null ? '' : owner).trim();
    }

    function readAllPresetsRaw() {
        try {
            const raw = localStorage.getItem(GOODS_PRESET_KEY);
            if (!raw) return {};
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};

            let isFlat = false;
            let hasNested = false;
            for (const k in obj) {
                const v = obj[k];
                if (typeof v === 'string') isFlat = true;
                else if (v && typeof v === 'object' && !Array.isArray(v)) hasNested = true;
            }
            if (isFlat && !hasNested) {
                const out = {};
                out[UNGROUPED_OWNER] = {};
                for (const k in obj) {
                    if (typeof obj[k] === 'string' && obj[k].trim()) {
                        out[UNGROUPED_OWNER][k] = obj[k].trim();
                    }
                }
                writeAllPresetsRaw(out);
                return out;
            }

            const out = {};
            for (const owner in obj) {
                const group = obj[owner];
                if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
                const clean = {};
                for (const n in group) {
                    const c = group[n];
                    if (typeof c === 'string' && c.trim()) clean[n] = c.trim();
                }
                if (Object.keys(clean).length) out[owner] = clean;
            }
            return out;
        } catch (e) {
            return {};
        }
    }

    function writeAllPresetsRaw(all) {
        try { localStorage.setItem(GOODS_PRESET_KEY, JSON.stringify(all)); } catch (e) {}
    }

    function migrateLegacyGoodsPresets() {
        try {
            const rawOld = localStorage.getItem(GOODS_PRESET_KEY_LEGACY);
            if (!rawOld) return;
            const oldObj = JSON.parse(rawOld);
            if (!oldObj || typeof oldObj !== 'object' || Array.isArray(oldObj)) return;
            const all = readAllPresetsRaw();
            if (!all[UNGROUPED_OWNER]) all[UNGROUPED_OWNER] = {};
            let touched = false;
            for (const k in oldObj) {
                const v = oldObj[k];
                if (typeof v === 'string' && v.trim() && all[UNGROUPED_OWNER][k] == null) {
                    all[UNGROUPED_OWNER][k] = v.trim();
                    touched = true;
                }
            }
            if (touched) writeAllPresetsRaw(all);
            localStorage.removeItem(GOODS_PRESET_KEY_LEGACY);
        } catch (e) {}
    }
    migrateLegacyGoodsPresets();

    function getGoodsPresets(owner) {
        const o = normalizeOwner(owner);
        const all = readAllPresetsRaw();
        const out = {};
        const un = all[UNGROUPED_OWNER] || {};
        for (const k in un) out[k] = un[k];
        if (o && all[o]) {
            for (const k in all[o]) out[k] = all[o][k];
        }
        return out;
    }

    function setGoodsPreset(owner, name, code) {
        const o = normalizeOwner(owner);
        const n = String(name == null ? '' : name).trim();
        const c = String(code == null ? '' : code).trim();
        if (!n || !c) return { ok: false };
        const all = readAllPresetsRaw();
        const key = o || UNGROUPED_OWNER;
        if (!all[key]) all[key] = {};
        all[key][n] = c;
        writeAllPresetsRaw(all);
        return { ok: true };
    }

    function removeGoodsPreset(owner, name) {
        const o = normalizeOwner(owner);
        const n = String(name == null ? '' : name).trim();
        if (!n) return { ok: false };
        const all = readAllPresetsRaw();
        const key = o || UNGROUPED_OWNER;
        if (all[key] && n in all[key]) {
            delete all[key][n];
            if (!Object.keys(all[key]).length) delete all[key];
            writeAllPresetsRaw(all);
        }
        return { ok: true };
    }

    function removePresetOwner(owner) {
        const o = normalizeOwner(owner);
        if (!o) return { ok: false };
        const all = readAllPresetsRaw();
        if (o in all) {
            delete all[o];
            writeAllPresetsRaw(all);
        }
        return { ok: true };
    }

    function getAllPresetOwners() {
        const all = readAllPresetsRaw();
        const out = [];
        for (const owner in all) {
            const items = [];
            for (const n in all[owner]) items.push({ name: n, code: all[owner][n] });
            items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
            out.push({
                owner: owner,
                label: owner === UNGROUPED_OWNER ? UNGROUPED_LABEL : owner,
                isUngrouped: owner === UNGROUPED_OWNER,
                items: items
            });
        }
        out.sort((a, b) => {
            if (a.isUngrouped) return 1;
            if (b.isUngrouped) return -1;
            return a.label.localeCompare(b.label, 'zh');
        });
        return out;
    }

    function levenshtein(a, b) {
        a = String(a); b = String(b);
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        const m = a.length, n = b.length;
        const dp = new Array(n + 1);
        for (let j = 0; j <= n; j++) dp[j] = j;
        for (let i = 1; i <= m; i++) {
            let prev = dp[0];
            dp[0] = i;
            for (let j = 1; j <= n; j++) {
                const tmp = dp[j];
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
                prev = tmp;
            }
        }
        return dp[n];
    }

    function findSimilarPresets(owner, keyword, limit) {
        const q = String(keyword == null ? '' : keyword).trim().toLowerCase();
        const all = getGoodsPresets(owner);
        const keys = Object.keys(all);
        if (!q || !keys.length) return [];
        const qNoQty = q.replace(/[\d.\s]+$/, '').trim();
        const out = [];
        for (const name of keys) {
            const ln = name.toLowerCase();
            let score = 0, reason = '';
            if (ln === q) { score = 100; reason = '完全匹配'; }
            else if (qNoQty && ln === qNoQty) { score = 95; reason = '忽略数量'; }
            else if (ln.indexOf(q) >= 0 || q.indexOf(ln) >= 0) { score = 80; reason = '包含匹配'; }
            else {
                const dist = levenshtein(ln, q);
                const maxLen = Math.max(ln.length, q.length);
                if (maxLen > 0) {
                    const sim = 1 - dist / maxLen;
                    if (sim >= 0.6) { score = Math.round(sim * 60); reason = '相似度 ' + Math.round(sim * 100) + '%'; }
                }
            }
            if (score > 0) out.push({ name: name, code: all[name], score: score, reason: reason });
        }
        out.sort(function (a, b) { return b.score - a.score; });
        return limit ? out.slice(0, limit) : out;
    }

    function buildUnitRegexSource(units, optional, capture) {
        const list = (units || []).filter(Boolean).map(escapeReg)
        .sort((a, b) => b.length - a.length);
        if (!list.length) return '';
        const group = capture
        ? '(' + list.join('|') + ')'
        : '(?:' + list.join('|') + ')';
        return group + (optional ? '?' : '');
    }

    function normalizePhone(s) {
        return String(s || '')
            .replace(/\s+/g, '')
            .replace(/^\+86(?=1[3-9]\d{9}$)/, '')
            .trim();
    }

    function looksLikeTime(line) {
        const s = String(line || '').trim();
        if (!s) return false;
        return /^\d{4}年\d{1,2}月\d{1,2}日/.test(s) ||
            /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s) ||
            /^\d{1,2}:\d{2}(?::\d{2})?$/.test(s);
    }

    /* 噪音清洗：先按关键词整行剔除，再自动识别纯 ASCII 短占位串 */
    function cleanNoiseFromText(rawText, extraKeywords) {
        let s = String(rawText == null ? '' : rawText);
        if (!s) return s;

        const kws = (getNoiseKeywords() || []).concat(extraKeywords || []);
        let lines = s.split(/\r?\n/);

        /* (1) 关键词：整行命中→删整行；局部命中→只删关键词，其余保留 */
        if (kws.length) {
            lines = lines.map(function (line) {
                let t = line;
                for (let i = 0; i < kws.length; i++) {
                    const kw = kws[i];
                    if (!kw) continue;
                    if (t.trim() === kw) return '';
                    if (t.indexOf(kw) >= 0) t = t.split(kw).join(' ').trim();
                }
                return t;
            });
        }

        /* (2) 自动识别纯 ASCII 短噪音行：无中文、仅字母/数字/下划线/点/中横线、含字母或下划线、长度≤20 */
        lines = lines.filter(function (line) {
            const t = line.trim();
            if (!t) return true;
            if (/[\u4e00-\u9fa5]/.test(t)) return true;
            if (t.length > 20) return true;
            if (!/^[A-Za-z0-9_.\-]+$/.test(t)) return true;
            if (!/[A-Za-z_]/.test(t)) return true;
            return false;
        });

        return lines.join('\n');
    }

    function detectGlobalGoods(texts, units) {
        if (!texts.length) return { goodsName: null };

        const unitSrcOpt = buildUnitRegexSource(units, true, false);
        /* 有单位时才启用中文数量剥离（避免误吞商品名末尾的“一/二”等） */
        const tailRe = unitSrcOpt
            ? new RegExp(QTY_PAT + '\\s*' + unitSrcOpt + '\\s*$')
            : /\d+\s*$/;

        if (texts.length === 1) {
            const s0 = String(texts[0]).replace(tailRe, '').trim();
            const m = s0.match(/([\u4e00-\u9fa5]{2,})\s*$/);
            if (m && !RE_ADDR_CHAR.test(m[1])) return { goodsName: m[1] };
            return { goodsName: null };
        }

        const freq = Object.create(null);
        for (let i = 0; i < texts.length; i++) {
            const s = String(texts[i]).replace(tailRe, '').trim();
            if (!s) continue;
            const seen = Object.create(null);
            for (let len = 2; len <= 6 && len <= s.length; len++) {
                const suf = s.slice(-len);
                if (!/^[\u4e00-\u9fa5]+$/.test(suf)) break;
                if (!seen[suf]) { seen[suf] = 1; freq[suf] = (freq[suf] || 0) + 1; }
            }
        }
        let best = null, bestCount = 0, bestLen = 0;
        for (const k in freq) {
            const c = freq[k];
            if (c > bestCount || (c === bestCount && k.length > bestLen)) {
                best = k; bestCount = c; bestLen = k.length;
            }
        }
        const threshold = Math.min(2, texts.length);
        if (best && bestCount >= threshold && bestCount >= 2) return { goodsName: best };
        return { goodsName: null };
    }

        function parseBlock(rawText, ctx, units) {
        const res = { name: '', phone: '', address: '', goods: '', mark: '', goodsTail: '' };
        let s = String(rawText == null ? '' : rawText)
        .replace(/[\r\n]+/g, ' ')
        .replace(/\u00a0/g, ' ')
        .trim();
        if (!s) return res;

        const marks = [];
        const reMark = /\[(\d+)\]/g;
        let mm;
        while ((mm = reMark.exec(s))) {
            marks.push({ num: mm[1], start: mm.index, end: mm.index + mm[0].length });
        }

        let p1 = -1, p2 = -1, markNum = '';
        outer:
        for (let i = 0; i < marks.length; i++) {
            for (let j = i + 1; j < marks.length; j++) {
                if (marks[i].num === marks[j].num) {
                    p1 = marks[i].start; p2 = marks[j].start;
                    markNum = marks[i].num;
                    break outer;
                }
            }
        }

        /* ==================== mark 分支（保持不变） ==================== */
        if (p1 >= 0 && p2 > p1) {
            const m1 = marks.find(m => m.start === p1);
            const m2 = marks.find(m => m.start === p2);
            let before1 = s.slice(0, m1.start).trim();
            let between = s.slice(m1.end, m2.start).trim();
            let after2 = s.slice(m2.end).trim();
            res.mark = markNum;
            const markTag = '[' + markNum + ']';

            const isAddrBefore = RE_ADDR_CHAR.test(before1) && before1.length > 4;

            if (!isAddrBefore) {
                const nm = before1.match(/[\u4e00-\u9fa5·]{1,4}\s*$/);
                if (nm) res.name = nm[0].trim() + markTag;
                const pm = RE_PHONE.exec(between);
                if (pm) {
                    res.phone = normalizePhone(pm[0]);
                    between = (between.slice(0, pm.index) + ' ' + between.slice(pm.index + pm[0].length));
                }
                const addrBody = between.replace(/\s+/g, ' ').trim();
                res.address = addrBody ? addrBody + markTag : '';
                res.goods = after2.replace(/\s+/g, ' ').trim();
            } else {
                const addrBody = before1.replace(/\s+/g, ' ').trim();
                res.address = addrBody ? addrBody + markTag : '';
                const pm = RE_PHONE.exec(after2);
                if (pm) res.phone = normalizePhone(pm[0]);
                const m = between.match(/^(.*\d)\s*([\u4e00-\u9fa5·]{1,4})\s*$/);
                if (m) {
                    res.goods = m[1].trim();
                    res.name = m[2].trim() + markTag;
                } else {
                    const nm = between.match(/[\u4e00-\u9fa5·]{1,4}\s*$/);
                    if (nm) {
                        res.name = nm[0].trim() + markTag;
                        res.goods = between.slice(0, nm.index).trim();
                    } else {
                        res.goods = between;
                    }
                }
            }
            return applyDefaultGoodsFallback(res, rawText, units);
        }

        /* ==================== 非 mark 分支（本次修改） ==================== */
        s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

        /* 新增：剥离时间前缀（避免混入姓名/地址） */
        s = s.replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?\s*/, '').trim();
        s = s.replace(/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*/, '').trim();

        const pm = RE_PHONE.exec(s);
        if (pm) {
            res.phone = normalizePhone(pm[0]);
            s = (s.slice(0, pm.index) + ' ' + s.slice(pm.index + pm[0].length)).replace(/\s+/g, ' ').trim();
        }

        let goodsName = ctx && ctx.goodsName;
        let goodsQty = '';
        let goodsUnit = '';

        const unitSrcCap = buildUnitRegexSource(units, true, true);

        if (goodsName) {
            const re = new RegExp(escapeReg(goodsName) + '\\s*(' + QTY_PAT + ')?\\s*' + unitSrcCap);
            const gm = re.exec(s);
            if (gm) {
                goodsQty = cnQtyToNumber(gm[1]) || '';
                goodsUnit = gm[2] || '';
                let matchEnd = gm.index + gm[0].length;
                let tailEnd = matchEnd;
                while (tailEnd < s.length && /[\u4e00-\u9fa5A-Za-z0-9_]/.test(s[tailEnd])) tailEnd++;
                if (tailEnd > matchEnd) {
                    const candidate = s.slice(matchEnd, tailEnd);
                    if (candidate.length <= 8 && !RE_ADDR_CHAR.test(candidate)) {
                        res.goodsTail = candidate;
                        matchEnd = tailEnd;
                    }
                }
                s = (s.slice(0, gm.index) + ' ' + s.slice(matchEnd)).replace(/\s+/g, ' ').trim();
            }
        } else {
            /* 先尝试末尾严格匹配 */
            const reStrict = new RegExp('([\\u4e00-\\u9fa5]{2,}?)\\s*(' + QTY_PAT + ')?\\s*' + unitSrcCap + '\\s*$');
            const m = s.match(reStrict);
            if (m && !RE_ADDR_CHAR.test(m[1])) {
                goodsName = m[1];
                goodsQty = cnQtyToNumber(m[2]) || '';
                goodsUnit = m[3] || '';
                s = s.slice(0, m.index).trim();
            } else {
                /* 宽松匹配：找最靠近末尾的商品，捕获尾部残留供用户决定 */
                const reLoose = new RegExp('([\\u4e00-\\u9fa5]{2,}?)\\s*(' + QTY_PAT + ')?\\s*' + unitSrcCap, 'g');
                let lastM = null, m2;
                while ((m2 = reLoose.exec(s))) {
                    lastM = { m: m2, index: m2.index, end: m2.index + m2[0].length };
                    if (m2[0].length === 0) reLoose.lastIndex++;
                }
                if (lastM) {
                    const cn = lastM.m[1];
                    let tailEnd = lastM.end;
                    while (tailEnd < s.length && /[\u4e00-\u9fa5A-Za-z0-9_]/.test(s[tailEnd])) tailEnd++;
                    const tailTxt = s.slice(lastM.end, tailEnd);
                    const tailOk = !tailTxt || (tailTxt.length <= 8 && !RE_ADDR_CHAR.test(tailTxt));
                    if (!RE_ADDR_CHAR.test(cn) && tailOk) {
                        goodsName = cn;
                        goodsQty = cnQtyToNumber(lastM.m[2]) || '';
                        goodsUnit = lastM.m[3] || '';
                        if (tailTxt) res.goodsTail = tailTxt;
                        s = (s.slice(0, lastM.index) + ' ' + s.slice(tailEnd)).replace(/\s+/g, ' ').trim();
                    }
                }
            }
        }
        res.goods = ((goodsName || '') + (goodsQty || '') + (goodsUnit || '')).trim();

        /* ========== 本次核心修改：姓名从开头提取 + 剩余全部作为地址 ========== */
        if (s) {
            const nmHead = s.match(/^([\u4e00-\u9fa5·]{2,4})(?:\s+|$)/);
            if (nmHead) {
                const candidate = nmHead[1];
                const restAfter = s.slice(nmHead[0].length).trim();
                if (restAfter.length > 0 &&
                    !RE_ADDR_CHAR.test(candidate) &&
                    !/(?:微信|电话|手机|商品|订单|快递|收件|发货)/.test(candidate)) {
                    res.name = candidate;
                    s = restAfter;
                }
            }
        }

        /* 剩余全部文本作为地址（不再依赖 RE_ADDR 分段匹配，避免空格截断） */
        if (s) {
            res.address = s.trim();
        }

        /* 兜底：姓名仍未提取到时，扫描 segs 找姓名并从地址中剔除 */
        if (!res.name && s) {
            const segs = s.split(/[\s,，;；、|｜]+/).filter(Boolean);
            for (let i = 0; i < segs.length; i++) {
                const tk = segs[i];
                if (/^[\u4e00-\u9fa5·]{2,4}$/.test(tk) &&
                    !RE_ADDR_CHAR.test(tk) &&
                    !/(?:微信|电话|手机|商品|订单|快递|收件|发货)/.test(tk)) {
                    res.name = tk;
                    const addrStr = res.address || '';
                    const pos = addrStr.indexOf(tk);
                    if (pos >= 0) {
                        const before = addrStr.slice(0, pos).trim();
                        const after = addrStr.slice(pos + tk.length).trim();
                        res.address = (before + ' ' + after).trim();
                    }
                    break;
                }
            }
        }

        return applyDefaultGoodsFallback(res, rawText, units);
    }

    function applyDefaultGoodsFallback(res, rawText, units) {
        const unitSrcCap = buildUnitRegexSource(units, false, true);
        if (!unitSrcCap) return res;

        if (res.goods) {
            const g = String(res.goods).trim();
            const pureQtyRe = new RegExp('^(' + QTY_PAT + ')\\s*(' + unitSrcCap + ')$');
            const pm = pureQtyRe.exec(g);
            if (pm) {
                res.goods = DEFAULT_GOODS_NAME + (cnQtyToNumber(pm[1]) || pm[1]) + pm[2];
                return res;
            }
        }

        if (!res.goods) {
            const rawForQty = String(rawText || '').replace(/\s+/g, ' ').trim();
            const tailRe = new RegExp('(?:^|[\\s,，;；、|｜])(' + QTY_PAT + ')\\s*(' + unitSrcCap + ')\\s*$');
            const tm = tailRe.exec(rawForQty);
            if (tm) {
                const fullMatch = tm[0].replace(/^[\s,，;；、|｜]+/, '').trim();
                const addrCore = String(res.address || '').replace(/\[\d+\]$/, '').trim();
                if (!addrCore || addrCore.indexOf(fullMatch) < 0) {
                    res.goods = DEFAULT_GOODS_NAME + (cnQtyToNumber(tm[1]) || tm[1]) + tm[2];
                }
            }
        }

        return res;
    }

    function finalizeEntries(entries, units) {
        if (!entries.length) return [];
        const cleanedTexts = entries.map(function (e) {
            let t = String(e.raw).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
            t = t.replace(RE_PHONE, ' ').replace(/\s+/g, ' ').trim();
            return t;
        });
        const ctx = detectGlobalGoods(cleanedTexts, units);
        return entries.map(function (e, idx) {
            const p = parseBlock(e.raw, ctx, units);
            return {
                id: 'o' + idx + '-' + Math.random().toString(36).slice(2, 7),
                wxName: e.wxName, time: e.time,
                name: p.name, phone: p.phone,
                address: p.address, goods: p.goods,
                mark: p.mark, raw: e.raw,
                goodsTail: p.goodsTail || ''
            };
        });
    }

    function parseChat(text) {
        text = cleanNoiseFromText(text);
        const units = getUnits();
        const rawText = String(text || '').replace(/\r\n?/g, '\n');
        const lines = rawText.split('\n').map(function (l) { return l.trim(); });

        function isSenderLine(line) {
            if (!line) return false;
            const core = line.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').trim();
            if (!core) return true;
            if (/\d/.test(core)) return false;
            if (RE_ADDR_CHAR.test(core)) return false;
            if (units.length) {
                for (let i = 0; i < units.length; i++) {
                    if (core.indexOf(units[i]) >= 0) return false;
                }
            } else if (/(?:瓶|装|袋|盒|件|包|PING|ping|Ping)/i.test(core)) {
                return false;
            }
            return core.length <= 8;
        }

        const blocks = [];
        const preLines = [];
        let cur = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (looksLikeTime(line)) {
                if (cur) blocks.push(cur);
                cur = { time: line, lines: [] };
            } else if (cur) {
                if (line) cur.lines.push(line);
            } else {
                if (line) preLines.push(line);
            }
        }
        if (cur) blocks.push(cur);

        if (blocks.length && preLines.length) {
            blocks[0].preLine = preLines[preLines.length - 1];
        }

        for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi];
            const blockText = b.lines.join(' ');
            const hasPhoneOrMark = RE_PHONE.test(blockText) || /\[\d+\]/.test(blockText);
            if (!hasPhoneOrMark) continue;
            while (b.lines.length >= 2 && isSenderLine(b.lines[b.lines.length - 1])) {
                const sender = b.lines.pop();
                const next = blocks[bi + 1];
                if (next) next.preLine = sender;
                else { b.lines.push(sender); break; }
            }
        }

        const rawEntries = [];
        const extras = [];
        for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi];
            const parts = [];
            if (b.preLine) parts.push(b.preLine);
            parts.push(b.time);
            for (let j = 0; j < b.lines.length; j++) parts.push(b.lines[j]);
            const raw = parts.join(' ');

            let wxName = '';
            for (let j = 0; j < b.lines.length; j++) {
                if (/\[\d+\]/.test(b.lines[j])) { wxName = b.lines[j]; break; }
            }
            if (!wxName && b.preLine) wxName = b.preLine;
            if (!wxName && b.lines.length) wxName = b.lines[0];

            const hasPhone = RE_PHONE.test(raw);
            const hasAddr = RE_ADDR_CHAR.test(raw) || /\[\d+\]/.test(raw);

            if (!hasPhone && !hasAddr && rawEntries.length) {
                const content = b.lines.join(' ').replace(/\s+/g, ' ').trim();
                if (content) {
                    const idx = rawEntries.length - 1;
                    extras[idx] = (extras[idx] ? extras[idx] + ' ' : '') + content;
                }
                continue;
            }
            rawEntries.push({ wxName: wxName, time: b.time, raw: raw });
        }

        const result = finalizeEntries(rawEntries, units);
        let defaultGoodsCount = 0;
        for (let i = 0; i < result.length; i++) {
            if (extras[i]) {
                const extra = extras[i].replace(/\s+/g, ' ').trim();
                if (extra) result[i].goods = ((result[i].goods || '') + ' ' + extra).trim();
            }
            if (result[i].goods && result[i].goods.indexOf(DEFAULT_GOODS_NAME) === 0) defaultGoodsCount++;
        }
        if (defaultGoodsCount > 0) {
            logMsg('检测到 ' + defaultGoodsCount + ' 条订单缺少商品名，已使用「' + DEFAULT_GOODS_NAME + '」占位，请在编码映射中填写', 'tip');
        }
        return result;
    }

    function parseGenericText(text) {
        text = cleanNoiseFromText(text);
        const units = getUnits();
        const rawText = String(text || '').replace(/\r\n?/g, '\n');

        let chunks = rawText.split(/\n[ \t]*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        if (chunks.length <= 1) {
            chunks = rawText.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        }

        const entries = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const lines = chunk.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
            if (lines.length > 1 && lines.every(function (l) {
                return RE_PHONE.test(l) || RE_ADDR_CHAR.test(l);
            })) {
                for (let j = 0; j < lines.length; j++) entries.push(lines[j]);
            } else {
                const merged = chunk.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
                if (merged) entries.push(merged);
            }
        }

        const valid = entries.filter(function (t) {
            return RE_PHONE.test(t) || RE_ADDR_CHAR.test(t);
        });
        if (!valid.length) return [];

        const cleanedTexts = valid.map(function (t) {
            let s = String(t).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
            s = s.replace(RE_PHONE, ' ').replace(/\s+/g, ' ').trim();
            return s;
        });
        const ctx = detectGlobalGoods(cleanedTexts, units);

        return valid.map(function (raw, idx) {
            const p = parseBlock(raw, ctx, units);
            return {
                id: 'o' + idx + '-' + Math.random().toString(36).slice(2, 7),
                wxName: '', time: '',
                name: p.name, phone: p.phone,
                address: p.address, goods: p.goods,
                mark: p.mark, raw: raw,
                goodsTail: p.goodsTail || ''
            };
        });
    }

    function orderLine(o) {
        return [o.name, o.phone, o.address]
            .map(function (x) { return String(x || '').trim(); })
            .filter(Boolean)
            .join(' ');
    }
    function goodsLine(o) {
        return String(o.goods || '').trim();
    }

    function copyToClipboard(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
            (document.body || document.documentElement).appendChild(ta);
            ta.select();
            try { ta.setSelectionRange(0, ta.value.length); } catch (e) {}
            const ok = document.execCommand('copy');
            ta.remove();
            if (ok) return Promise.resolve(true);
        } catch (e) {}
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
            }
        } catch (e) {}
        return Promise.resolve(false);
    }

    function dialogToast(msg, isErr) {
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483700;' +
            'padding:8px 18px;border-radius:6px;font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#fff;' +
            'background:' + (isErr ? '#f53f3f' : '#00b42a') + ';box-shadow:0 4px 14px rgba(0,0,0,.22);' +
            'pointer-events:none;transition:opacity .3s;';
        document.body.appendChild(t);
        setTimeout(function () { t.style.opacity = '0'; }, 1500);
        setTimeout(function () { t.remove(); }, 1900);
    }

    /* ============================================================
     * 商品编码记忆管理弹窗（含导出 / 导入 / 编辑）
     * ============================================================ */
    function openPresetManager() {
        const oldWrap = document.getElementById('tm-preset-manager-wrap');
        if (oldWrap) oldWrap.remove();

        const wrap = document.createElement('div');
        wrap.id = 'tm-preset-manager-wrap';
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483650;' +
            'display:flex;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;';

        wrap.innerHTML = `
            <div style="background:#fff;border-radius:10px;width:100%;max-width:640px;max-height:90vh;
                        display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);
                        font:13px/1.6 -apple-system,'Microsoft YaHei',sans-serif;
                        color:#1f2329;overflow:hidden;">
                <div style="padding:12px 18px;border-bottom:1px solid #e5e6eb;
                            display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <div style="font-size:15px;font-weight:600;">🗂 商品编码记忆管理</div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <button id="tm-pm-export" type="button" title="导出全部记忆为 JSON"
                            style="padding:4px 10px;border:1px solid #b8d4ff;background:#eef5ff;color:#1e6fd9;
                                   border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;">⬇ 导出</button>
                        <button id="tm-pm-import" type="button" title="从 JSON 文件导入记忆"
                            style="padding:4px 10px;border:1px solid #b8d4ff;background:#eef5ff;color:#1e6fd9;
                                   border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;">⬆ 导入</button>
                        <button id="tm-pm-close" type="button" title="关闭"
                            style="border:0;background:none;font-size:22px;line-height:1;
                                   cursor:pointer;color:#8f959e;padding:0 4px;">×</button>
                    </div>
                </div>
                <div style="padding:8px 18px;border-bottom:1px solid #e5e6eb;background:#f7f9fc;
                            font-size:11px;color:#8f959e;line-height:1.7;">
                    记忆按「货主（仓库名）」分组，同名商品在不同货主下互不干扰。<br>
                    点货主可展开查看，可单条编辑 / 删除，也可整组删除或导入导出备份。
                </div>
                <div id="tm-pm-body" style="flex:1;overflow:auto;padding:10px 18px;background:#fafbfc;"></div>
                <input id="tm-pm-file" type="file" accept=".json,application/json" style="display:none;">
            </div>
        `;
        document.body.appendChild(wrap);

        const $ = sel => wrap.querySelector(sel);

        function renderBody() {
            const body = $('#tm-pm-body');
            const groups = getAllPresetOwners();
            body.innerHTML = '';

            if (!groups.length) {
                body.innerHTML = '<div style="text-align:center;padding:30px;color:#8f959e;font-size:12px;">' +
                    '暂无任何记忆<br><span style="font-size:11px;">在「聊天转订单」弹窗开始批量时勾选「记住本次映射」即可自动生成</span></div>';
                return;
            }

            groups.forEach(g => {
                const block = document.createElement('div');
                block.style.cssText = 'background:#fff;border:1px solid #e5e6eb;border-radius:6px;' +
                    'margin-bottom:10px;overflow:hidden;';

                const header = document.createElement('div');
                header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;' +
                    'background:' + (g.isUngrouped ? '#fdf6e3' : '#f5f9ff') + ';' +
                    'border-bottom:1px solid #e5e6eb;cursor:pointer;user-select:none;';
                header.innerHTML = `
                    <span class="tm-pm-caret" style="display:inline-block;width:12px;color:#8f959e;transition:transform .15s;">▶</span>
                    <span style="flex:1;font-size:12px;font-weight:600;color:#1f2329;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                          title="${escapeHtml(g.label)}">${escapeHtml(g.label)}</span>
                    <span style="font-size:11px;color:#8f959e;">${g.items.length} 条</span>
                    <button type="button" data-owner="${escapeHtml(g.owner)}" data-act="del-owner"
                        title="删除该货主下全部商品记忆"
                        style="padding:3px 10px;border:1px solid #ffccc7;background:#fff2f0;color:#f53f3f;
                               border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">🗑 删除该货主</button>
                `;

                const bodyEl = document.createElement('div');
                bodyEl.style.cssText = 'display:none;padding:4px 10px 8px;';

                g.items.forEach(it => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;' +
                        'border-bottom:1px dashed #f0f0f0;';
                    row.innerHTML = `
                        <span style="flex:1;min-width:0;font-size:12px;color:#4e5969;
                                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                              title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
                        <span style="font-size:12px;color:#409eff;font-weight:600;white-space:nowrap;
                                     max-width:200px;overflow:hidden;text-overflow:ellipsis;"
                              title="${escapeHtml(it.code)}">→ ${escapeHtml(it.code)}</span>
                        <button type="button" data-owner="${escapeHtml(g.owner)}" data-name="${escapeHtml(it.name)}"
                            data-code="${escapeHtml(it.code)}" data-act="edit-item"
                            style="padding:1px 8px;border:1px solid #dcdfe6;background:#fff;color:#1e6fd9;
                                   border-radius:4px;cursor:pointer;font-size:11px;">编辑</button>
                        <button type="button" data-owner="${escapeHtml(g.owner)}" data-name="${escapeHtml(it.name)}"
                            data-act="del-item"
                            style="padding:1px 8px;border:1px solid #dcdfe6;background:#fff;color:#f53f3f;
                                   border-radius:4px;cursor:pointer;font-size:11px;">删除</button>
                    `;
                    bodyEl.appendChild(row);
                });

                header.onclick = function (e) {
                    if (e.target.closest('button')) return;
                    const isOpen = bodyEl.style.display === 'block';
                    bodyEl.style.display = isOpen ? 'none' : 'block';
                    const caret = header.querySelector('.tm-pm-caret');
                    if (caret) caret.style.transform = isOpen ? '' : 'rotate(90deg)';
                };

                block.appendChild(header);
                block.appendChild(bodyEl);
                body.appendChild(block);
            });
        }

        $('#tm-pm-body').addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'del-owner') {
                const owner = btn.dataset.owner;
                const label = owner === UNGROUPED_OWNER ? UNGROUPED_LABEL : owner;
                if (!confirm('删除货主「' + label + '」的全部商品编码记忆？\n此操作不可撤销。')) return;
                removePresetOwner(owner);
                logMsg('已删除货主记忆：' + label, 'tip');
                renderBody();
            } else if (act === 'del-item') {
                const owner = btn.dataset.owner;
                const name = btn.dataset.name;
                removeGoodsPreset(owner, name);
                logMsg('已删除商品记忆：' + name, 'tip');
                renderBody();
            } else if (act === 'edit-item') {
                startInlineEdit(btn.closest('div'), btn.dataset.owner, btn.dataset.name, btn.dataset.code || '');
            } else if (act === 'save-edit') {
                const owner = btn.dataset.owner;
                const oldName = btn.dataset.oldname;
                const row = btn.closest('div');
                const nameInput = row.querySelector('[data-edit="name"]');
                const codeInput = row.querySelector('[data-edit="code"]');
                if (!nameInput || !codeInput) return;
                const newName = nameInput.value.trim();
                const newCode = codeInput.value.trim();
                if (!newName) { dialogToast('商品名不能为空', true); return; }
                if (!newCode) { dialogToast('商品编码不能为空', true); return; }
                if (newName !== oldName) removeGoodsPreset(owner, oldName);
                setGoodsPreset(owner, newName, newCode);
                logMsg('已更新记忆：' + newName + ' → ' + newCode, 'ok');
                dialogToast('已保存：' + newName);
                renderBody();
            } else if (act === 'cancel-edit') {
                renderBody();
            }
        });

        function startInlineEdit(row, owner, oldName, oldCode) {
            if (!row) return;
            if (row.querySelector('[data-edit="name"]')) return;
            row.innerHTML = `
                <input data-edit="name" type="text" value="${escapeHtml(oldName)}" placeholder="商品名"
                    style="flex:1;min-width:0;padding:3px 6px;border:1px solid #dcdfe6;border-radius:4px;
                           font-size:12px;outline:none;">
                <span style="color:#409eff;font-weight:600;">→</span>
                <input data-edit="code" type="text" value="${escapeHtml(oldCode)}" placeholder="商品编码"
                    style="flex:1;min-width:0;padding:3px 6px;border:1px solid #dcdfe6;border-radius:4px;
                           font-size:12px;outline:none;">
                <button type="button" data-act="save-edit"
                    data-owner="${escapeHtml(owner)}" data-oldname="${escapeHtml(oldName)}"
                    style="padding:1px 8px;border:1px solid #b7eb8f;background:#f6ffed;color:#389e0d;
                           border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">保存</button>
                <button type="button" data-act="cancel-edit"
                    style="padding:1px 8px;border:1px solid #dcdfe6;background:#fff;color:#4e5969;
                           border-radius:4px;cursor:pointer;font-size:11px;">取消</button>
            `;
            const ni = row.querySelector('[data-edit="name"]');
            if (ni) { ni.focus(); try { ni.select(); } catch (e) {} }
        }

        $('#tm-pm-close').onclick = function () { wrap.remove(); };

        /* ====== 导出：生成 JSON 并下载 + 复制到剪贴板 ====== */
        $('#tm-pm-export').onclick = function () {
            const all = readAllPresetsRaw();
            if (!Object.keys(all).length) { dialogToast('暂无可导出的记忆', true); return; }
            const json = JSON.stringify(all, null, 2);
            try {
                const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const d = new Date();
                const fn = 'tm_goods_presets_' +
                    d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
                    pad2(d.getHours()) + pad2(d.getMinutes()) + '.json';
                a.href = url;
                a.download = fn;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            } catch (e) {
                dialogToast('下载导出文件失败', true);
            }
            copyToClipboard(json).then(function (ok) {
                dialogToast(ok ? '已导出并复制到剪贴板' : '已生成下载文件');
            });
            logMsg('已导出商品编码记忆', 'ok');
        };

        /* ====== 导入：选文件 → 校验 → 确认 → 合并写入 ====== */
        $('#tm-pm-import').onclick = function () { $('#tm-pm-file').click(); };

        $('#tm-pm-file').onchange = function (e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function () {
                try {
                    const obj = JSON.parse(String(reader.result || ''));
                    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                        throw new Error('JSON 格式不正确（应为 { 货主: { 商品名: 编码 } }）');
                    }
                    const existing = readAllPresetsRaw();
                    let totalAdded = 0, totalOverwritten = 0;
                    for (const owner in obj) {
                        const group = obj[owner];
                        if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
                        if (!existing[owner]) existing[owner] = {};
                        for (const name in group) {
                            const code = group[name];
                            if (typeof code !== 'string' || !code.trim()) continue;
                            if (name in existing[owner] && existing[owner][name] !== code.trim()) totalOverwritten++;
                            existing[owner][name] = code.trim();
                            totalAdded++;
                        }
                    }
                    if (!totalAdded) { dialogToast('导入文件没有有效数据', true); return; }
                    const okMsg = '准备导入 ' + totalAdded + ' 条商品编码记忆' +
                        (totalOverwritten ? '（将覆盖 ' + totalOverwritten + ' 条已有记录）' : '') +
                        '。\n\n确定继续？';
                    if (!confirm(okMsg)) return;
                    writeAllPresetsRaw(existing);
                    logMsg('已导入商品编码记忆：' + totalAdded + ' 条（覆盖 ' + totalOverwritten + ' 条）', 'ok');
                    dialogToast('导入成功，共 ' + totalAdded + ' 条');
                    renderBody();
                } catch (err) {
                    dialogToast('导入失败：' + ((err && err.message) || err), true);
                }
            };
            reader.onerror = function () { dialogToast('读取文件失败', true); };
            reader.readAsText(file);
            e.target.value = '';
        };

        renderBody();
    }

    /* ============================================================
     * 聊天 / 通用文本转订单弹窗
     * ============================================================ */
    const CHAT2ORDER_DIALOG_ID = 'tm-chat2order-wrap';

    function openChatToOrderDialog(defaultMode) {
        const oldWrap = document.getElementById(CHAT2ORDER_DIALOG_ID);
        if (oldWrap) {
            oldWrap.remove();
            chatDialogRefreshActionBar = null;
        }

        const isGeneric = defaultMode === 'generic';
        const dialogTitle = isGeneric ? '📄 通用文本转订单' : '📦 聊天记录转订单';
        const selChat    = isGeneric ? '' : 'selected';
        const selGeneric = isGeneric ? 'selected' : '';

        let parsed = [];

        const wrap = document.createElement('div');
        wrap.id = CHAT2ORDER_DIALOG_ID;
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483600;' +
            'display:flex;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;';

        wrap.innerHTML = `
            <div style="background:#fff;border-radius:10px;width:100%;max-width:820px;max-height:94vh;
                        display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);
                        font:13px/1.6 -apple-system,'Microsoft YaHei',sans-serif;
                        color:#1f2329;overflow:hidden;">
                <div style="padding:12px 18px;border-bottom:1px solid #e5e6eb;
                            display:flex;align-items:center;justify-content:space-between;">
                    <div style="font-size:15px;font-weight:600;">${dialogTitle}</div>
                    <button id="tm-c2o-close" type="button" title="关闭"
                        style="border:0;background:none;font-size:22px;line-height:1;
                               cursor:pointer;color:#8f959e;padding:0 4px;">×</button>
                </div>
                <div style="padding:10px 18px;border-bottom:1px solid #e5e6eb;
                            display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
                    <label style="display:flex;align-items:center;gap:6px;">
                        <span style="color:#4e5969;font-size:12px;">仓库名</span>
                        <div style="position:relative;">
                            <input id="tm-c2o-warehouse" type="text" placeholder="例如：吉安-杨涛" autocomplete="off"
                                style="padding:5px 22px 5px 9px;border:1px solid #dcdfe6;border-radius:5px;
                                       font-size:12px;width:180px;outline:none;box-sizing:border-box;">
                            <span style="position:absolute;right:7px;top:50%;transform:translateY(-50%);
                                color:#909399;font-size:10px;pointer-events:none;">▾</span>
                            <div id="tm-c2o-warehouse-drop"
                                style="display:none;position:absolute;left:0;top:100%;margin-top:2px;
                                       width:200px;max-height:200px;overflow:auto;background:#fff;
                                       border:1px solid #e5e6eb;border-radius:6px;
                                       box-shadow:0 4px 14px rgba(0,0,0,.12);z-index:30;"></div>
                        </div>
                    </label>
                    <label style="display:flex;align-items:center;gap:6px;">
                        <span style="color:#4e5969;font-size:12px;">快递公司</span>
                        <div style="position:relative;">
                            <input id="tm-c2o-express" type="text" placeholder="如：拼多多中通" autocomplete="off"
                                style="padding:5px 22px 5px 9px;border:1px solid #dcdfe6;border-radius:5px;
                                       font-size:12px;width:180px;outline:none;box-sizing:border-box;">
                            <span style="position:absolute;right:7px;top:50%;transform:translateY(-50%);
                                color:#909399;font-size:10px;pointer-events:none;">▾</span>
                            <div id="tm-c2o-express-drop"
                                style="display:none;position:absolute;left:0;top:100%;margin-top:2px;
                                       width:200px;max-height:220px;overflow:auto;background:#fff;
                                       border:1px solid #e5e6eb;border-radius:6px;
                                       box-shadow:0 4px 14px rgba(0,0,0,.12);z-index:30;"></div>
                        </div>
                    </label>
                    <label style="display:flex;align-items:center;gap:6px;">
                        <span style="color:#4e5969;font-size:12px;">执行速度</span>
                        <select id="tm-c2o-speed"
                            style="padding:5px 9px;border:1px solid #dcdfe6;border-radius:5px;
                                   font-size:12px;outline:none;background:#fff;">
                            <option>极速</option><option>快速</option><option>较快</option>
                            <option selected>正常</option><option>较慢</option><option>慢速</option>
                        </select>
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;"
                        title="跳过每笔订单的人工确认弹窗（要求姓名/电话/地址/商品均完整，商品后无额外内容）">
                        <input id="tm-c2o-auto-confirm" type="checkbox" style="cursor:pointer;">
                        <span style="color:#ff9900;font-size:12px;font-weight:600;">免确认模式</span>
                    </label>
                    <label style="display:flex;align-items:center;gap:6px;">
                        <span style="color:#4e5969;font-size:12px;">商品单位</span>
                        <button id="tm-c2o-units-btn" type="button"
                            style="padding:5px 10px;border:1px solid #dcdfe6;border-radius:5px;
                                   font-size:12px;outline:none;background:#fff;color:#4e5969;cursor:pointer;">
                            <span id="tm-c2o-units-btn-text">管理</span> ▾
                        </button>
                    </label>
                    <label style="display:flex;align-items:center;gap:6px;">
                        <span style="color:#4e5969;font-size:12px;">编码记忆</span>
                        <button id="tm-c2o-preset-btn" type="button"
                            style="padding:5px 10px;border:1px solid #dcdfe6;border-radius:5px;
                                   font-size:12px;outline:none;background:#fff;color:#4e5969;cursor:pointer;">
                            <span id="tm-c2o-preset-btn-text">管理</span> ▾
                        </button>
                    </label>
                </div>
                <div id="tm-c2o-units-panel"
                    style="display:none;padding:10px 18px;border-bottom:1px solid #e5e6eb;background:#f7f9fc;">
                    <div id="tm-c2o-units-tags"
                        style="display:flex;flex-wrap:wrap;gap:6px;max-height:100px;overflow:auto;"></div>
                    <div style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap;">
                        <input id="tm-c2o-unit-input" type="text" placeholder="输入自定义单位，如：斤、扎、提"
                            maxlength="8"
                            style="flex:1;min-width:140px;padding:5px 9px;border:1px solid #dcdfe6;
                                   border-radius:5px;font-size:12px;outline:none;">
                        <button id="tm-c2o-unit-add" type="button"
                            style="padding:5px 14px;border:0;background:#409eff;color:#fff;
                                   border-radius:5px;cursor:pointer;font-size:12px;">添加</button>
                        <button id="tm-c2o-unit-reset" type="button"
                            style="padding:5px 14px;border:1px solid #dcdfe6;background:#fff;color:#4e5969;
                                   border-radius:5px;cursor:pointer;font-size:12px;">恢复默认</button>
                    </div>
                    <div style="margin-top:6px;color:#909399;font-size:11px;">
                        提示：解析聊天记录时会自动识别这些单位，并从商品名称中剥离；例如「可乐2瓶」→ 商品「可乐」数量「2」。
                    </div>
                </div>
                <div style="padding:10px 18px;border-bottom:1px solid #e5e6eb;">
                    <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center;flex-wrap:wrap;">
                        <span style="color:#4e5969;font-size:12px;">解析模式</span>
                        <select id="tm-c2o-mode"
                            style="padding:3px 8px;border:1px solid #dcdfe6;border-radius:4px;
                                   font-size:12px;outline:none;background:#fff;">
                            <option value="chat" ${selChat}>聊天记录</option>
                            <option value="generic" ${selGeneric}>通用文本</option>
                        </select>
                        <label style="display:flex;align-items:center;gap:4px;">
                            <span style="color:#4e5969;font-size:12px;">过滤词</span>
                            <input id="tm-c2o-noise" type="text" placeholder="逗号分隔，如 XX____,ABC__"
                                style="padding:3px 8px;border:1px solid #dcdfe6;border-radius:4px;
                                       font-size:12px;width:180px;outline:none;">
                            <button id="tm-c2o-noise-save" type="button"
                                style="padding:3px 8px;border:1px solid #dcdfe6;background:#fff;color:#4e5969;
                                       border-radius:4px;cursor:pointer;font-size:11px;">保存</button>
                        </label>
                        <span style="color:#909399;font-size:11px;">
                            通用文本：每行一条或空行分隔，字段建议顺序为「姓名 电话 地址 商品（商品放末尾）」
                        </span>
                    </div>
                    <textarea id="tm-c2o-input" placeholder="粘贴内容，支持两种模式：
【聊天记录】按时间分块，字段含微信名[标记]/电话/地址[标记]
【通用文本】每行一条或空行分隔，字段建议顺序：姓名 电话 地址 商品（商品在末尾）"
                        style="width:100%;box-sizing:border-box;min-height:90px;max-height:200px;resize:vertical;
                               padding:8px 10px;border:1px solid #dcdfe6;border-radius:6px;
                               font:12px/1.5 -apple-system,'Microsoft YaHei',sans-serif;
                               color:#1f2329;background:#fff;outline:none;"></textarea>
                    <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">
                        <button id="tm-c2o-parse" type="button"
                            style="padding:5px 14px;border:0;background:#409eff;color:#fff;
                                   border-radius:5px;cursor:pointer;font-size:12px;">解析</button>
                        <button id="tm-c2o-append" type="button"
                            style="padding:5px 14px;border:1px solid #409eff;background:#fff;color:#409eff;
                                   border-radius:5px;cursor:pointer;font-size:12px;">追加解析</button>
                        <button id="tm-c2o-clear-input" type="button"
                            style="padding:5px 14px;border:1px solid #dcdfe6;background:#fff;color:#4e5969;
                                   border-radius:5px;cursor:pointer;font-size:12px;">清空输入</button>
                        <button id="tm-c2o-clear-all" type="button"
                            style="padding:5px 14px;border:1px solid #dcdfe6;background:#fff;color:#4e5969;
                                   border-radius:5px;cursor:pointer;font-size:12px;">清空全部</button>
                        <span id="tm-c2o-stat"
                            style="color:#8f959e;font-size:12px;margin-left:auto;">暂无订单</span>
                    </div>
                </div>
                <div id="tm-c2o-list"
                    style="flex:1;overflow:auto;padding:10px 18px;background:#fafbfc;min-height:100px;"></div>
                <div id="tm-c2o-actions"
                    style="padding:10px 18px;border-top:1px solid #e5e6eb;
                           display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;"></div>
            </div>
        `;
        document.body.appendChild(wrap);

        const $ = function (sel) { return wrap.querySelector(sel); };
        const inputEl = $('#tm-c2o-input');
        const listEl  = $('#tm-c2o-list');
        const statEl  = $('#tm-c2o-stat');

        /* -------------------- 记忆下拉（支持删除） -------------------- */
        function attachHistoryDropdown(input, drop, getList, onDelete, canDelete) {
            function render(filter) {
                let list = getList() || [];
                if (filter) {
                    const f = String(filter).toLowerCase();
                    list = list.filter(function (v) {
                        return String(v).toLowerCase().indexOf(f) >= 0;
                    });
                }
                drop.innerHTML = '';
                if (!list.length) {
                    drop.innerHTML = '<div style="padding:8px 10px;color:#909399;font-size:12px;">无匹配项</div>';
                    return;
                }
                list.forEach(function (v) {
                    const it = document.createElement('div');
                    it.style.cssText = 'display:flex;align-items:center;gap:2px;padding:0 4px 0 10px;' +
                        'font-size:12px;color:#4e5969;cursor:pointer;white-space:nowrap;';

                    const txt = document.createElement('span');
                    txt.textContent = v;
                    txt.title = v;
                    txt.style.cssText = 'flex:1;min-width:0;padding:6px 0;' +
                        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    it.appendChild(txt);

                    if (typeof onDelete === 'function' && (!canDelete || canDelete(v))) {
                        const del = document.createElement('button');
                        del.type = 'button';
                        del.textContent = '×';
                        del.title = '从记忆中删除「' + v + '」';
                        del.style.cssText = 'flex:0 0 auto;padding:2px 6px;border:0;background:none;' +
                            'color:#c0c4cc;cursor:pointer;font-size:15px;line-height:1;border-radius:3px;';
                        del.onmouseenter = function () { del.style.color = '#f53f3f'; del.style.background = '#fff1f0'; };
                        del.onmouseleave = function () { del.style.color = '#c0c4cc'; del.style.background = 'none'; };
                        del.onmousedown = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!confirm('从记忆中删除「' + v + '」？')) return;
                            try { onDelete(v); } catch (err) {}
                            render(input.value.trim());
                        };
                        it.appendChild(del);
                    }

                    it.onmouseenter = function () {
                        it.style.background = '#f5f7fa';
                        txt.style.color = '#1f2329';
                    };
                    it.onmouseleave = function () {
                        it.style.background = '';
                        txt.style.color = '#4e5969';
                    };
                    it.onmousedown = function (e) {
                        if (e.target.closest('button')) return;
                        e.preventDefault();
                        e.stopPropagation();
                        input.value = v;
                        drop.style.display = 'none';
                    };
                    drop.appendChild(it);
                });
            }
            function open() {
                render('');
                drop.style.display = 'block';
            }
            input.addEventListener('focus', open);
            input.addEventListener('click', function (e) {
                e.stopPropagation();
                open();
            });
            input.addEventListener('input', function () {
                if (drop.style.display === 'block') render(input.value.trim());
            });
            drop.addEventListener('mousedown', function (e) { e.stopPropagation(); });
            document.addEventListener('mousedown', function (e) {
                if (e.target === input || drop.contains(e.target)) return;
                drop.style.display = 'none';
            });
        }

        attachHistoryDropdown(
            $('#tm-c2o-warehouse'),
            $('#tm-c2o-warehouse-drop'),
            getWarehouseHistory,
            function (v) {
                removeWarehouseHistory(v);
                logMsg('已从仓库记忆删除：' + v, 'tip');
                dialogToast('已删除仓库记忆：' + v);
            }
        );

        attachHistoryDropdown(
            $('#tm-c2o-express'),
            $('#tm-c2o-express-drop'),
            getExpressOptions,
            function (v) {
                const r = removeExpressHistory(v);
                if (!r.ok) { dialogToast(r.message || '删除失败', true); return; }
                logMsg('已从快递记忆删除：' + v, 'tip');
                dialogToast('已删除快递记忆：' + v);
            },
            function (v) { return EXPRESS_PRESETS.indexOf(v) < 0; }
        );

        /* -------------------- 商品单位管理 -------------------- */
        function renderUnits() {
            const tagsEl = $('#tm-c2o-units-tags');
            if (!tagsEl) return;
            const units = getUnits();
            tagsEl.innerHTML = '';
            if (!units.length) {
                tagsEl.innerHTML = '<span style="color:#909399;font-size:12px;">暂无单位，输入后点「添加」</span>';
                return;
            }
            units.forEach(function (u) {
                const tag = document.createElement('span');
                tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;' +
                    'padding:3px 8px;background:#fff;border:1px solid #dcdfe6;' +
                    'border-radius:12px;font-size:12px;color:#4e5969;';
                const txt = document.createElement('span');
                txt.textContent = u;
                const del = document.createElement('span');
                del.textContent = '×';
                del.title = '删除';
                del.style.cssText = 'cursor:pointer;color:#f53f3f;font-weight:600;line-height:1;';
                del.onclick = function () {
                    removeUnit(u);
                    renderUnits();
                    updateUnitsBtnText();
                };
                tag.appendChild(txt);
                tag.appendChild(del);
                tagsEl.appendChild(tag);
            });
        }

        function updateUnitsBtnText() {
            const t = $('#tm-c2o-units-btn-text');
            if (!t) return;
            t.textContent = '管理（' + getUnits().length + '）';
        }

        function handleAddUnit() {
            const inp = $('#tm-c2o-unit-input');
            if (!inp) return;
            const v = inp.value.trim();
            if (!v) { dialogToast('请输入单位', true); return; }
            const res = addUnit(v);
            if (!res.ok) { dialogToast(res.message, true); return; }
            inp.value = '';
            renderUnits();
            updateUnitsBtnText();
            dialogToast('已添加单位：' + v);
        }

        $('#tm-c2o-units-btn').onclick = function () {
            const panel = $('#tm-c2o-units-panel');
            if (!panel) return;
            const show = panel.style.display === 'none' || !panel.style.display;
            panel.style.display = show ? 'block' : 'none';
            if (show) renderUnits();
        };
        $('#tm-c2o-unit-add').onclick = handleAddUnit;
        $('#tm-c2o-unit-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); handleAddUnit(); }
        });
        $('#tm-c2o-unit-reset').onclick = function () {
            if (!confirm('恢复默认单位列表？当前自定义单位将被覆盖。')) return;
            saveUnits(DEFAULT_UNITS.slice());
            renderUnits();
            updateUnitsBtnText();
        };

        renderUnits();
        updateUnitsBtnText();

        /* -------------------- 过滤词 UI 初始化 -------------------- */
        (function initNoiseUI() {
            const inp = $('#tm-c2o-noise');
            if (inp) inp.value = getNoiseKeywords().join(',');
        })();

        $('#tm-c2o-noise-save').onclick = function () {
            const inp = $('#tm-c2o-noise');
            if (!inp) return;
            const list = (inp.value || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
            setNoiseKeywords(list);
            dialogToast('已保存 ' + list.length + ' 个过滤词');
        };

        $('#tm-c2o-preset-btn').onclick = function () {
            try { openPresetManager(); } catch (e) {}
        };

        function closeDialog() {
            if (chatDialogRefreshActionBar === renderActionBar) chatDialogRefreshActionBar = null;
            wrap.remove();
        }

        function updateStat() {
            const n = parsed.length;
            let bad = 0, withTail = 0;
            for (let i = 0; i < n; i++) {
                const o = parsed[i];
                if (!o.name || !o.phone || !o.address) bad++;
                if (o.goodsTail) withTail++;
            }
            let txt = n
                ? (n + ' 条订单' + (bad ? '（' + bad + ' 条信息不完整）' : '') + (withTail ? '（' + withTail + ' 条含商品后多余内容）' : ''))
                : '暂无订单';
            statEl.textContent = txt;
            statEl.style.color = (bad || withTail) ? '#d9a441' : '#8f959e';
        }

        function renderList() {
            listEl.innerHTML = '';
            if (!parsed.length) {
                listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#8f959e;font-size:12px;">' +
                    '还没有解析结果 —— 粘贴内容后点「解析」</div>';
                updateStat();
                return;
            }
            parsed.forEach(function (o, i) {
                const srcText = (o.wxName || '未知') + (o.time ? ' · ' + o.time : '');
                const tailHtml = o.goodsTail ? `
                    <div style="margin-top:5px;margin-left:46px;display:flex;align-items:center;gap:6px;
                                padding:4px 8px;background:#fffbe6;border:1px solid #ffe58f;border-radius:5px;
                                font-size:11px;color:#ad6800;">
                        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                              title="${escapeHtml(o.goodsTail)}">⚠ 商品数量后检测到额外内容：「${escapeHtml(o.goodsTail)}」</span>
                        <button data-act="merge-tail" data-idx="${i}" type="button"
                            style="padding:1px 8px;border:1px solid #dcdfe6;background:#fff;color:#4e5969;
                                   border-radius:4px;cursor:pointer;font-size:11px;">并入商品</button>
                        <button data-act="drop-tail" data-idx="${i}" type="button"
                            style="padding:1px 8px;border:1px solid #ffccc7;background:#fff2f0;color:#f53f3f;
                                   border-radius:4px;cursor:pointer;font-size:11px;">剔除</button>
                    </div>
                ` : '';

                const card = document.createElement('div');
                card.style.cssText = 'background:#fff;border:1px solid #e5e6eb;border-radius:6px;' +
                    'padding:8px 10px;margin-bottom:8px;';
                card.innerHTML = `
                    <div style="display:flex;align-items:center;gap:8px;padding-bottom:6px;
                                border-bottom:1px dashed #e5e6eb;margin-bottom:6px;">
                        <span style="min-width:20px;height:20px;padding:0 5px;border-radius:10px;
                                     background:#ecf5ff;color:#409eff;display:inline-flex;
                                     align-items:center;justify-content:center;
                                     font-size:11px;font-weight:600;">${i + 1}</span>
                        <span title="${escapeHtml(o.raw || '')}"
                            style="flex:1;min-width:0;color:#8f959e;font-size:11px;
                                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(srcText)}</span>
                        <button data-act="copy-order" data-idx="${i}" type="button"
                            style="padding:2px 8px;border:1px solid #dcdfe6;background:#fff;color:#4e5969;
                                   border-radius:4px;cursor:pointer;font-size:11px;">复制</button>
                        <button data-act="copy-goods" data-idx="${i}" type="button"
                            style="padding:2px 8px;border:1px solid #dcdfe6;background:#fff;color:#b8a888;
                                   border-radius:4px;cursor:pointer;font-size:11px;">商品</button>
                        <button data-act="del" data-idx="${i}" type="button"
                            style="padding:2px 8px;border:1px solid #dcdfe6;background:#fff;color:#f53f3f;
                                   border-radius:4px;cursor:pointer;font-size:11px;">✕</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
                        <span style="flex:0 0 auto;width:40px;text-align:right;color:#8f959e;font-size:11px;">收件人</span>
                        <input data-idx="${i}" data-key="name" type="text"
                            value="${escapeHtml(o.name)}" placeholder="收件人姓名"
                            style="flex:1 1 0;min-width:0;padding:4px 8px;border:1px solid #dcdfe6;
                                   border-radius:5px;font-size:12px;outline:none;">
                        <span style="flex:0 0 auto;width:28px;text-align:right;color:#8f959e;font-size:11px;">电话</span>
                        <input data-idx="${i}" data-key="phone" type="text"
                            value="${escapeHtml(o.phone)}" placeholder="手机号"
                            style="flex:1 1 0;min-width:0;padding:4px 8px;border:1px solid #dcdfe6;
                                   border-radius:5px;font-size:12px;outline:none;">
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
                        <span style="flex:0 0 auto;width:40px;text-align:right;color:#8f959e;font-size:11px;">地址</span>
                        <input data-idx="${i}" data-key="address" type="text"
                            value="${escapeHtml(o.address)}" placeholder="收货地址"
                            style="flex:1 1 0;min-width:0;padding:4px 8px;border:1px solid #dcdfe6;
                                   border-radius:5px;font-size:12px;outline:none;">
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="flex:0 0 auto;width:40px;text-align:right;color:#8f959e;font-size:11px;">商品</span>
                        <input data-idx="${i}" data-key="goods" type="text"
                            value="${escapeHtml(o.goods)}" placeholder="商品 + 数量"
                            style="flex:1 1 0;min-width:0;padding:4px 8px;border:1px solid #e8dfc0;
                                   border-radius:5px;font-size:12px;outline:none;background:#fffdf5;color:#8a6d1f;">
                    </div>
                    ${tailHtml}
                `;
                listEl.appendChild(card);
            });
            updateStat();
        }

        listEl.addEventListener('input', function (e) {
            const input = e.target;
            if (input.tagName !== 'INPUT') return;
            const idx = parseInt(input.dataset.idx, 10);
            const key = input.dataset.key;
            if (!isNaN(idx) && key && parsed[idx]) {
                parsed[idx][key] = input.value;
                updateStat();
            }
        });

        listEl.addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx, 10);
            const act = btn.dataset.act;
            if (isNaN(idx) || !parsed[idx]) return;

            if (act === 'copy-order') {
                const line = orderLine(parsed[idx]);
                if (!line) { dialogToast('该条没有可复制的内容', true); return; }
                copyToClipboard(line).then(function (ok) {
                    if (!ok) { dialogToast('复制失败，请手动选中', true); return; }
                    const old = btn.textContent;
                    btn.textContent = '✓';
                    setTimeout(function () { btn.textContent = old; }, 800);
                    dialogToast('已复制第 ' + (idx + 1) + ' 条');
                });
            } else if (act === 'copy-goods') {
                const g = goodsLine(parsed[idx]);
                if (!g) { dialogToast('该条没有商品信息', true); return; }
                copyToClipboard(g).then(function (ok) {
                    if (!ok) { dialogToast('复制失败', true); return; }
                    btn.textContent = '✓';
                    setTimeout(function () { btn.textContent = '商品'; }, 800);
                    dialogToast('已复制第 ' + (idx + 1) + ' 条商品');
                });
            } else if (act === 'del') {
                parsed.splice(idx, 1);
                renderList();
            } else if (act === 'drop-tail') {
                parsed[idx].goodsTail = '';
                renderList();
                dialogToast('已剔除第 ' + (idx + 1) + ' 条多余内容');
            } else if (act === 'merge-tail') {
                const t = parsed[idx].goodsTail || '';
                parsed[idx].goods = ((parsed[idx].goods || '') + t).trim();
                parsed[idx].goodsTail = '';
                renderList();
                dialogToast('已并入商品字段');
            }
        });

        function doParse(append) {
            const raw = inputEl.value;
            if (!raw.trim()) { dialogToast('请先粘贴内容', true); return; }
            const mode = $('#tm-c2o-mode').value;

            /* 临时过滤词：输入框里填的关键词，不持久化，仅本次解析生效 */
            const extraKw = ($('#tm-c2o-noise').value || '')
                .split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
            const cleaned = cleanNoiseFromText(raw, extraKw);

            const result = (mode === 'generic') ? parseGenericText(cleaned) : parseChat(cleaned);
            if (!result.length) {
                dialogToast(mode === 'generic' ? '通用文本未解析到有效内容（请确认包含电话或地址）' : '没有解析到有效内容', true);
                return;
            }
            parsed = append ? parsed.concat(result) : result;
            renderList();
            const modeName = (mode === 'generic') ? '通用文本' : '聊天记录';
            logMsg(modeName + '解析：' + result.length + ' 条' + (append ? '（追加）' : ''), 'ok');
            dialogToast('已解析 ' + result.length + ' 条' + (append ? '（追加）' : ''));
        }

        function makeSolidBtn(text, bg, disabled, onClick) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.disabled = !!disabled;
            b.style.cssText = 'padding:6px 16px;border:0;border-radius:6px;font-size:12px;' +
                'font-weight:600;color:#fff;background:' + bg + ';' +
                'cursor:' + (disabled ? 'not-allowed' : 'pointer') + ';' +
                'opacity:' + (disabled ? '.6' : '1') + ';';
            if (!disabled && onClick) b.onclick = onClick;
            return b;
        }

        function makeGhostBtn(text, color, onClick) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.style.cssText = 'padding:6px 14px;border:1px solid #dcdfe6;background:#fff;' +
                'color:' + (color || '#4e5969') + ';border-radius:6px;cursor:pointer;font-size:12px;';
            if (onClick) b.onclick = onClick;
            return b;
        }

        function copyAllOrders() {
            const lines = parsed.map(function (o) { return orderLine(o); }).filter(Boolean);
            if (!lines.length) { dialogToast('没有可复制的订单', true); return; }
            copyToClipboard(lines.join('\n')).then(function (ok) {
                if (ok) dialogToast('已复制 ' + lines.length + ' 条订单');
                else dialogToast('复制失败，请手动选中', true);
            });
        }

        function copyAllGoodsFn() {
            const lines = parsed.map(function (o) { return goodsLine(o); }).filter(Boolean);
            if (!lines.length) { dialogToast('没有可复制的商品', true); return; }
            copyToClipboard(lines.join('\n')).then(function (ok) {
                if (ok) dialogToast('已复制 ' + lines.length + ' 条商品');
                else dialogToast('复制失败，请手动选中', true);
            });
        }

        async function startBatch() {
            const warehouse = $('#tm-c2o-warehouse').value.trim();
            const express   = ($('#tm-c2o-express').value || '').trim();
            const speed     = $('#tm-c2o-speed').value;
            const autoConfirmEl = $('#tm-c2o-auto-confirm');
            const autoConfirm = !!(autoConfirmEl && autoConfirmEl.checked);
            if (!warehouse)     { dialogToast('请填写仓库名', true); return; }
            if (!parsed.length) { dialogToast('请先解析内容', true); return; }

            /* 字段完整性检查 */
            const problems = [];
            for (let i = 0; i < parsed.length; i++) {
                const o = parsed[i] || {};
                const missing = [];
                if (!String(o.name || '').trim())    missing.push('姓名');
                if (!String(o.phone || '').trim())   missing.push('电话');
                if (!String(o.address || '').trim()) missing.push('地址');
                if (!String(o.goods || '').trim())   missing.push('商品');
                if (missing.length) problems.push({ idx: i + 1, missing: missing });
            }

            if (problems.length) {
                if (autoConfirm) {
                    const preview = problems.slice(0, 8)
                        .map(function (p) { return '第' + p.idx + '条缺' + p.missing.join('/'); })
                        .join('；');
                    dialogToast('免确认模式要求信息完整：' + preview + (problems.length > 8 ? ' 等' : ''), true);
                    return;
                }
                const first = problems[0];
                dialogToast('第 ' + first.idx + ' 条订单信息不完整（缺 ' + first.missing.join('、') + '）', true);
                return;
            }

            const pendingTails = [];
            for (let i = 0; i < parsed.length; i++) {
                if (parsed[i].goodsTail) pendingTails.push('第 ' + (i + 1) + ' 条「' + parsed[i].goodsTail + '」');
            }
            if (pendingTails.length) {
                if (autoConfirm) {
                    dialogToast('免确认模式要求商品后无额外内容，请先「剔除全部干扰项」', true);
                    return;
                }
                logMsg('有 ' + pendingTails.length + ' 条订单存在未处理的商品后多余内容（已忽略）：' + pendingTails.join('、'), 'warn');
            }

            /* 免确认模式二次确认 */
            if (autoConfirm) {
                const ok = confirm(
                    '【免确认模式】二次确认\n\n' +
                    '已开启免确认模式，每笔订单前置步骤完成后将自动提交，不再弹出人工确认。\n' +
                    '请确认所有订单信息（姓名 / 电话 / 地址 / 商品）均已完整且正确。\n\n' +
                    '共 ' + parsed.length + ' 笔\n' +
                    '仓库：' + warehouse + '\n' +
                    '快递：' + (express || '（未选择）') + '\n' +
                    '速度：' + speed + '\n\n' +
                    '确定继续执行？'
                );
                if (!ok) return;
            }

            const rawOrders = parsed.map(function (o) { return orderLine(o); }).join('\n');
            const rawGoods  = parsed.map(function (o) { return goodsLine(o); }).join('\n');

            closeDialog();

            try {
                await create_orders_batch({
                    warehouse: warehouse,
                    express: express,
                    speed: speed,
                    rawOrders: rawOrders,
                    rawGoods: rawGoods,
                    autoConfirm: autoConfirm
                });
            } catch (e) {
                logMsg('批量执行失败：' + ((e && e.message) || e), 'error');
            }
        }

        function renderActionBar() {
            if (!wrap.isConnected) {
                if (chatDialogRefreshActionBar === renderActionBar) chatDialogRefreshActionBar = null;
                return;
            }
            const bar = $('#tm-c2o-actions');
            if (!bar) return;
            bar.innerHTML = '';

            const paused   = !!resumeResolver;
            const stopping = !paused && batchRunning && progressState.stopping;
            const running  = !paused && batchRunning && !progressState.stopping;

            if (stopping) {
                bar.appendChild(makeSolidBtn('停止中…', '#909399', true));
                return;
            }

            if (paused) {
                bar.appendChild(makeSolidBtn('▶ 恢复批量', '#409eff', false, function () {
                    try { create_order_resume(); } catch (e) {}
                }));
                bar.appendChild(makeSolidBtn('⏹ 停止当前批量', '#f53f3f', false, function () {
                    try { create_orders_stop(); } catch (e) {}
                }));
                return;
            }

            if (running) {
                bar.appendChild(makeSolidBtn('⏹ 停止当前批量', '#f53f3f', false, function () {
                    try { create_orders_stop(); } catch (e) {}
                }));
                return;
            }

            const tailCount = parsed.filter(function (o) { return !!o.goodsTail; }).length;
            if (tailCount > 0) {
                bar.appendChild(makeGhostBtn('⚠ 剔除全部干扰项 (' + tailCount + ')', '#d9a441', function () {
                    let n = 0;
                    parsed.forEach(function (o) { if (o.goodsTail) { o.goodsTail = ''; n++; } });
                    if (n) { renderList(); dialogToast('已剔除 ' + n + ' 条干扰项'); }
                }));
            }

            bar.appendChild(makeGhostBtn('复制全部商品', '#b8a888', copyAllGoodsFn));
            bar.appendChild(makeGhostBtn('复制全部订单', '#4e5969', copyAllOrders));
            bar.appendChild(makeSolidBtn('开始批量下单', '#00b42a', false, startBatch));
        }

        chatDialogRefreshActionBar = renderActionBar;

        $('#tm-c2o-close').onclick        = closeDialog;
        $('#tm-c2o-parse').onclick        = function () { doParse(false); };
        $('#tm-c2o-append').onclick       = function () { doParse(true); };
        $('#tm-c2o-clear-input').onclick  = function () { inputEl.value = ''; inputEl.focus(); };
        $('#tm-c2o-clear-all').onclick    = function () {
            if (!parsed.length) return;
            if (!confirm('清空当前 ' + parsed.length + ' 条解析结果？')) return;
            parsed = [];
            renderList();
        };

        renderList();
        renderActionBar();
        return { ok: true };
    }

    /* ============================================================
     * 三、字段定位
     * ============================================================ */
    function getFieldLi(labelText) {
        const labels = document.querySelectorAll('#app label');
        for (const lbl of labels) {
            const t = norm(lbl.textContent);
            if (t === labelText + '：' || t === labelText) return lbl.closest('li');
        }
        return null;
    }
    async function waitForFieldLi(labelText, maxWait = 10000) {
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const li = getFieldLi(labelText);
            if (li) return li;
            await sleep(120);
        }
        return null;
    }

    /* ============================================================
     * 四、下拉/级联选择
     * ============================================================ */
    const DROPDOWN_SELECTOR = '.hp-cascader-select-dropdown, .el-select-dropdown';
    const getVisibleDropdowns = () => [...document.querySelectorAll(DROPDOWN_SELECTOR)].filter(isVisible);

    async function closeAllDropdowns() {
        for (let i = 0; i < 3; i++) {
            if (!getVisibleDropdowns().length) return;
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
            await sleep(120);
            if (!getVisibleDropdowns().length) return;
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await sleep(120);
        }
    }

    async function openDropdown(li) {
        const trigger = li.querySelector('.el-input__inner') || li.querySelector('.el-input');
        if (!trigger) throw new Error('未找到下拉触发器');
        await closeAllDropdowns();
        for (let i = 0; i < 6; i++) {
            clickEl(trigger);
            await sleep(currentPreset.clickDelay + i * 60);
            const cands = getVisibleDropdowns().filter(d => d.querySelector('.input-filter input'));
            if (cands.length) {
                cands.sort((a, b) => (parseInt(getComputedStyle(b).zIndex) || 0) - (parseInt(getComputedStyle(a).zIndex) || 0));
                return cands[0];
            }
            await closeAllDropdowns();
        }
        throw new Error('下拉未打开');
    }

    function collectOptions(drop) {
        return [...drop.querySelectorAll('li.el-cascader-node, li.el-select-dropdown__item, li.suggestion')]
            .filter(isVisible)
            .filter(el => (el.textContent || '').trim().length > 0);
    }

    async function cascaderPick(li, keywords) {
        if (!li) throw new Error('字段所在 li 为空');
        const kws = Array.isArray(keywords) ? keywords.slice() : [keywords];
        const drop = await openDropdown(li);
        let pickedText = '';
        for (let depth = 0; depth < 4; depth++) {
            const kw = kws[depth] || kws[kws.length - 1] || '';
            const filterInput = drop.querySelector('.input-filter input');
            if (filterInput && kw) { setInputValue(filterInput, kw); await sleep(currentPreset.clickDelay * 2); }
            let options = [];
            for (let i = 0; i < 15; i++) {
                options = collectOptions(drop);
                if (options.length) break;
                await sleep(150);
            }
            if (!options.length) {
                if (depth === 0) throw new Error('下拉无可用选项：' + kw);
                break;
            }
            const nkw = norm(kw);
            const target = options.find(o => norm(o.textContent) === nkw)
            || options.find(o => norm(o.textContent).includes(nkw))
            || options[0];
            const hasArrow = !!target.querySelector('.el-icon-arrow-right, .el-cascader-node__postfix');
            clickEl(target);
            pickedText = (target.textContent || '').trim();
            await sleep(currentPreset.clickDelay + 150);
            if (!hasArrow) break;
            if (!kws[depth + 1]) {
                const cols = [...document.querySelectorAll('.el-cascader-menu')].filter(isVisible);
                const lastCol = cols[cols.length - 1];
                if (lastCol) {
                    const children = [...lastCol.querySelectorAll('li.el-cascader-node')]
                    .filter(isVisible).filter(el => (el.textContent || '').trim().length > 0);
                    if (children.length) {
                        clickEl(children[0]);
                        pickedText += ' / ' + (children[0].textContent || '').trim();
                        await sleep(currentPreset.clickDelay + 80);
                    }
                }
                break;
            }
        }
        await closeAllDropdowns();
        return pickedText;
    }

    /* ============================================================
     * 五、通用弹窗处理
     * ============================================================ */
    async function handleMessageBox() {
        for (let i = 0; i < 3; i++) {
            const boxes = [...document.querySelectorAll('.el-message-box__wrapper')].filter(isVisible);
            if (!boxes.length) return false;
            const box = boxes[0];
            const btn = [...box.querySelectorAll('button')].find(b => /确定|确认|是|OK/i.test(b.textContent || ''));
            if (!btn) return false;
            clickEl(btn);
            await sleep(currentPreset.clickDelay * 2);
        }
        return true;
    }
    async function closeSuccessDialog() {
        for (let i = 0; i < 3; i++) {
            const dlgs = [...document.querySelectorAll('.el-dialog__wrapper')].filter(isVisible);
            let handled = false;
            for (const d of dlgs) {
                const txt = d.textContent || '';
                if (/复制单号/.test(txt) || /订单号/.test(txt)) {
                    const ok = [...d.querySelectorAll('button')].find(b => /确定|确认/.test(b.textContent || ''));
                    if (ok) { clickEl(ok); handled = true; await sleep(currentPreset.clickDelay * 2); break; }
                }
            }
            if (!handled) return;
        }
    }

    /* ============================================================
     * 六、商品表格操作
     * ============================================================ */
    function getGoodsRows() {
        return [...document.querySelectorAll('.table-trades tbody tr.vxe-body--row')]
            .filter(tr => tr.querySelector('td[colid="col_12"]'));
    }
    function cellHasText(td) {
        return !!td && norm(td.textContent).replace(/　/g, '').length > 0;
    }
    function hasGoodsAdded() {
        return getGoodsRows().some(tr => cellHasText(tr.querySelector('td[colid="col_12"]')));
    }
    function findEditableIn(root) {
        return [...root.querySelectorAll('input, textarea')]
            .find(el => !el.readOnly && !el.disabled && isVisible(el)) || null;
    }
    async function activateCellEditor(td) {
        if (!td) return null;
        clickEl(td); await sleep(currentPreset.clickDelay);
        let input = findEditableIn(td);
        if (input) return input;
        clickEl(td); await sleep(currentPreset.clickDelay + 120);
        input = findEditableIn(td);
        if (input) return input;
        const floats = [...document.querySelectorAll('.vxe-table--edit, .vxe-cell--edit, .el-popper')].filter(isVisible);
        for (const f of floats) {
            const i = findEditableIn(f);
            if (i) return i;
        }
        return null;
    }

    /* ============================================================
     * 七、.sku-table 商品下拉
     * ============================================================ */
    function getAllSkuTables(preferRoot) {
        const out = [];
        if (preferRoot) out.push(...preferRoot.querySelectorAll('.sku-table'));
        out.push(...document.querySelectorAll('.sku-table'));
        return [...new Set(out)];
    }
    function isSkuTableReady(table) {
        if (!table || !table.isConnected) return false;
        const r = table.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const loading = table.querySelector('.el-loading-mask');
        if (loading) {
            const lr = loading.getBoundingClientRect();
            if (lr.width > 0 && lr.height > 0) return false;
        }
        return true;
    }
    async function pickSkuFromTable(table) {
        if (!table) return false;
        const rows = [...table.querySelectorAll('li.row')].filter(r => {
            if (!r.isConnected) return false;
            const rc = r.getBoundingClientRect();
            return rc.width > 0 && rc.height > 0;
        });
        if (!rows.length) return false;
        const target = rows.find(r => r.classList.contains('active')) || rows[0];
        const title = (target.querySelector('.title span') || {}).textContent || (target.textContent || '').trim();
        logMsg('点击商品下拉：' + String(title).slice(0, 40), 'tip');
        hoverEl(target);
        await sleep(100);
        clickEl(target);
        await sleep(currentPreset.clickDelay + 300);
        if (hasGoodsAdded()) return true;
        const inner = target.querySelector('.title') || target.querySelector('.middle') || target.querySelector('.img-box');
        if (inner) {
            hoverEl(inner); await sleep(60); clickEl(inner); await sleep(currentPreset.clickDelay + 200);
            if (hasGoodsAdded()) return true;
        }
        doubleClickEl(target); await sleep(currentPreset.clickDelay + 200);
        return hasGoodsAdded();
    }
    async function waitAndPickSku(input, td, timeout) {
        const start = Date.now();
        let lastEnter = 0;
        while (Date.now() - start < timeout) {
            const tables = getAllSkuTables(td);
            for (const t of tables) {
                if (!isSkuTableReady(t)) continue;
                const hit = await pickSkuFromTable(t);
                if (hit) return true;
            }
            if (Date.now() - lastEnter > 1200) {
                lastEnter = Date.now();
                if (input) await focusAndEnter(input);
            }
            await sleep(150);
        }
        return false;
    }

    /* ============================================================
     * 八、商品编码填写
     * ============================================================ */
    async function fillGoodsCode(code) {
        const rows = getGoodsRows();
        if (!rows.length) throw new Error('商品表格无行');
        const td = rows[0].querySelector('td[colid="col_12"]');
        if (!td) throw new Error('未找到商品编码单元格');
        const input = await activateCellEditor(td);
        if (!input) throw new Error('商品编码单元格未进入编辑态');

        logMsg('模拟键入编码：' + code, 'info');
        await simulateTyping(input, code);
        await sleep(currentPreset.clickDelay);
        await focusAndArrowDown(input);
        await sleep(currentPreset.enterDelay / 2);

        if (await waitAndPickSku(input, td, currentPreset.skuWait / 2)) { logMsg('商品已加入', 'ok'); return; }

        logMsg('回车后等待下拉渲染…', 'tip');
        await focusAndEnter(input);
        await sleep(currentPreset.enterDelay);
        if (hasGoodsAdded()) { logMsg('回车已加入商品', 'ok'); return; }
        if (await waitAndPickSku(input, td, currentPreset.skuWait)) { logMsg('商品已加入', 'ok'); return; }

        logMsg('首次未命中，重新输入再试', 'tip');
        await simulateTyping(input, code);
        await sleep(currentPreset.clickDelay);
        await focusAndEnter(input);
        await sleep(currentPreset.enterDelay);
        if (hasGoodsAdded()) { logMsg('回车已加入商品', 'ok'); return; }
        if (await waitAndPickSku(input, td, currentPreset.skuWait)) { logMsg('商品已加入', 'ok'); return; }

        await confirmGoodsPopup(2000);
        if (hasGoodsAdded()) { logMsg('弹窗选择成功', 'ok'); return; }
        throw new Error('商品编码未匹配到商品：' + code);
    }

    async function fillQty(qty) {
        const rows = getGoodsRows();
        if (!rows.length) throw new Error('商品行为空');
        const td = rows[0].querySelector('td[colid="col_20"]');
        if (!td) throw new Error('未找到数量列');
        const input = await activateCellEditor(td);
        if (!input) throw new Error('数量单元格未进入编辑态');
        setInputValue(input, String(qty));
        await sleep(150);
        await focusAndEnter(input);
        await sleep(currentPreset.clickDelay + 200);
    }

    function findGoodsPopup() {
        const wraps = [...document.querySelectorAll('.el-dialog__wrapper')].filter(isVisible);
        return wraps.find(w => {
            const title = w.querySelector('.el-dialog__title');
            const t = title ? title.textContent : (w.textContent || '');
            return /选择商品|商品规格|商品选择|选择规格|规格选择/.test(t);
        }) || null;
    }
    async function confirmGoodsPopup(timeout = 2000) {
        let popup = null;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            popup = findGoodsPopup();
            if (popup) break;
            await sleep(150);
        }
        if (!popup) return false;
        let rows = [];
        for (let i = 0; i < 15; i++) {
            rows = [...popup.querySelectorAll('.vxe-body--row, tbody tr')].filter(isVisible);
            if (rows.length) break;
            await sleep(150);
        }
        if (rows.length) {
            const cell = rows[0].querySelector('td.vxe-body--column') || rows[0].querySelector('td') || rows[0];
            if (cell) { hoverEl(cell); clickEl(cell); await sleep(150); doubleClickEl(cell); await sleep(currentPreset.clickDelay + 300); }
            if (findGoodsPopup()) {
                const focusTarget = findEditableIn(popup) || popup;
                try { focusTarget.focus && focusTarget.focus(); } catch (e) {}
                await focusAndEnter(focusTarget);
                await sleep(currentPreset.clickDelay + 150);
            }
            if (findGoodsPopup()) {
                const okBtn = [...popup.querySelectorAll('button')].filter(isVisible).find(b => /确\s*定|确认|添加/.test(b.textContent || ''));
                if (okBtn) { clickEl(okBtn); await sleep(currentPreset.clickDelay + 400); }
            }
        } else {
            const okBtn = [...popup.querySelectorAll('button')].filter(isVisible).find(b => /确\s*定|确认/.test(b.textContent || ''));
            if (okBtn) { clickEl(okBtn); await sleep(currentPreset.clickDelay + 250); }
        }
        for (let i = 0; i < 10; i++) {
            if (!findGoodsPopup()) return true;
            await sleep(150);
        }
        return false;
    }

    /* ============================================================
     * 九、业务步骤
     * ============================================================ */
    async function stepReset() {
        const btn = [...document.querySelectorAll('.btn-box button')].filter(isVisible).find(b => norm(b.textContent) === '重置');
        if (!btn) throw new Error('未找到"重置"按钮');
        clickEl(btn);
        await sleep(currentPreset.resetWait);
        await handleMessageBox();
        await sleep(currentPreset.clickDelay);
        await closeAllDropdowns();
    }
    async function stepSelectShop() {
        const li = await waitForFieldLi('下单店铺');
        if (!li) throw new Error('未找到"下单店铺"字段');
        return await cascaderPick(li, ['通用手工单', '线下店铺']);
    }
    async function stepSelectWarehouse(name) {
        const li = await waitForFieldLi('仓库');
        if (!li) throw new Error('未找到"仓库"字段');
        return await cascaderPick(li, [name]);
    }
    async function stepSelectExpress(name) {
        if (!name) return '';
        const li = await waitForFieldLi('快递公司');
        if (!li) throw new Error('未找到"快递公司"字段');
        return await cascaderPick(li, [name]);
    }
    async function stepSmartIdentify(text) {
        const box = document.querySelector('.identify-box') || [...document.querySelectorAll('li')].find(li => {
            const lbl = li.querySelector('label');
            return lbl && lbl.textContent.includes('智能识别');
        });
        if (!box) throw new Error('未找到智能识别区域');
        const ta = box.querySelector('textarea');
        if (!ta) throw new Error('未找到智能识别输入框');
        setTextareaValue(ta, text);
        await sleep(200);
        const btn = box.querySelector('.btn.act') || box.querySelector('.btn');
        if (!btn) throw new Error('未找到"识别"按钮');
        clickEl(btn);
        await sleep(currentPreset.identifyWait);

        const li = await waitForFieldLi('收件人', 8000);
        if (li) {
            const start = Date.now();
            while (Date.now() - start < 8000) {
                const inp = li.querySelector('input');
                if (inp && inp.value.trim()) { await sleep(currentPreset.clickDelay); return; }
                await sleep(150);
            }
        }
        await sleep(currentPreset.clickDelay);
    }
    async function stepFillGoods(code, qty) {
        await fillGoodsCode(code);
        await sleep(currentPreset.stepDelay);
        await fillQty(qty);
        await sleep(currentPreset.clickDelay);
    }
    async function stepSubmit() {
        await closeAllDropdowns();
        const btn = [...document.querySelectorAll('.btn-box button')].filter(isVisible).find(b => norm(b.textContent) === '提交订单');
        if (!btn) throw new Error('未找到"提交订单"按钮');
        clickEl(btn);
        await sleep(currentPreset.submitWait);
        await handleMessageBox();
        await closeSuccessDialog();
        await sleep(currentPreset.clickDelay);
    }

    /* ============================================================
     * 十、状态机
     * ============================================================ */
    let progressState = { index: 0, total: 0, running: false, paused: false, stopping: false };
    let batchRunning  = false;
    let batchRunId    = 0;
    let stopRequested = false;
    let resumeResolver = null;

    function buildButtons(status) {
        return {
            chatImport: { text: '聊天转订单', disabled: false },
            genericImport: { text: '通用文本转订单', disabled: false }
        };
    }

    function notifyBatchStatus(status, extra) {
        progressState.running  = (status === 'running' || status === 'paused' || status === 'stopping');
        progressState.paused   = (status === 'paused');
        progressState.stopping = (status === 'stopping');

        const buttons = buildButtons(status);

        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL,
                type: 'BATCH_STATUS',
                from: SELF_NAME,
                status,
                buttons,
                data: Object.assign({
                    ts: Date.now(),
                    index: progressState.index,
                    total: progressState.total,
                    speed: payloadSpeedNameCache
                }, extra || {})
            }, '*');
        } catch (e) {}

        if (typeof chatDialogRefreshActionBar === 'function') {
            try { chatDialogRefreshActionBar(); } catch (e) {}
        }
    }

    /* ============================================================
     * 十一、暂停 / 恢复
     * ============================================================ */
    function showPauseBarFallback() {
        const old = document.getElementById('tm-pause-bar');
        if (old) old.remove();
        const bar = document.createElement('div');
        bar.id = 'tm-pause-bar';
        bar.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
            'background:#fff;border:1px solid #ff9900;box-shadow:0 4px 16px rgba(0,0,0,.2);' +
            'border-radius:8px;padding:10px 16px;z-index:2147483500;' +
            'display:flex;align-items:center;gap:12px;' +
            'font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#1f2329;';
        bar.innerHTML = `
            <span style="color:#ff9900;font-weight:600;">⏸ 已暂停</span>
            <span style="color:#4e5969;font-size:12px;">请在「聊天转订单」弹窗点击「恢复批量」或此处继续</span>
            <button id="tm-resume-btn" style="padding:5px 14px;border:0;background:#409eff;color:#fff;border-radius:5px;cursor:pointer;font-size:12px;">继续下一笔</button>
        `;
        document.body.appendChild(bar);
        bar.querySelector('#tm-resume-btn').onclick = () => {
            try { create_order_resume(); } catch (e) {}
        };
    }

    function waitForUserResume(info) {
        return new Promise((resolve) => {
            resumeResolver = resolve;
            notifyBatchStatus('paused', info);
            logMsg('暂停中，等待「聊天转订单」弹窗「恢复批量」或 iframe 内继续按钮…', 'tip');
            showPauseBarFallback();
        });
    }

    function create_order_resume() {
        if (!resumeResolver) return { ok: false, message: '当前没有暂停中的任务' };
        const r = resumeResolver;
        resumeResolver = null;
        const bar = document.getElementById('tm-pause-bar');
        if (bar) bar.remove();
        notifyBatchStatus('running', { resumed: true });
        logMsg('收到恢复指令，跳过当前笔自动提交并进入下一笔', 'tip');
        r();
        return { ok: true };
    }

    function create_order_stop_or_resume() {
        if (resumeResolver) return create_order_resume();
        if (batchRunning)    return create_orders_stop();
        return { ok: false, message: '当前没有正在执行或暂停的任务' };
    }

    /* ============================================================
     * 十二、确认弹窗
     * ============================================================ */
    function askUserConfirm(info) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483600;' +
                'display:flex;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;';
            wrap.innerHTML = `
              <div style="background:#fff;border-radius:8px;width:100%;max-width:460px;
                          padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);
                          font:13px/1.6 -apple-system,'Microsoft YaHei',sans-serif;
                          color:#1f2329;box-sizing:border-box;max-height:92vh;overflow:auto;">
                <div style="font-size:15px;font-weight:600;margin-bottom:10px;">
                  请确认第 ${info.index} / ${info.total} 笔订单
                </div>
                <div style="background:#f6f8fa;border-radius:6px;padding:8px;margin-bottom:10px;
                            word-break:break-all;color:#333;max-height:100px;overflow:auto;font-size:12px;">
                  ${escapeHtml(info.order)}
                </div>
                <div style="display:flex;gap:14px;margin-bottom:12px;font-size:12px;color:#4e5969;flex-wrap:wrap;">
                  <div>商品编码：<b style="color:#1f2329;">${escapeHtml(info.code)}</b></div>
                  <div>数量：<b style="color:#1f2329;">${escapeHtml(info.qty)}</b></div>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
                  <button id="tm-cf-skip" style="padding:6px 14px;border:1px solid #dcdfe6;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;">跳过本单</button>
                  <button id="tm-cf-pause" style="padding:6px 14px;border:1px solid #ff9900;background:#fff;color:#ff9900;border-radius:6px;cursor:pointer;font-size:12px;">暂停并手动编辑</button>
                  <button id="tm-cf-ok" style="padding:6px 14px;border:0;background:#409eff;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;">确认并提交</button>
                </div>
              </div>`;
            document.body.appendChild(wrap);
            const done = (ok) => { wrap.remove(); resolve({ ok }); };
            wrap.querySelector('#tm-cf-ok').onclick    = () => done(true);
            wrap.querySelector('#tm-cf-skip').onclick  = () => done(false);
            wrap.querySelector('#tm-cf-pause').onclick = () => done('pause');
        });
    }

    /* ============================================================
     * 十三、商品数据解析 + 映射
     * ============================================================ */
    function parseGoodsLines(raw) {
        const units = getUnits();
        const unitSrcOpt = buildUnitRegexSource(units, true, false);
        const re1 = new RegExp('^(.+?)[\\s,，|]+(' + QTY_PAT + ')\\s*' + unitSrcOpt + '\\s*$');
        const re2 = new RegExp('^(.+?)(' + QTY_PAT + ')\\s*' + unitSrcOpt + '\\s*$');

        return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
            let m = line.match(re1);
            if (m) return { name: m[1].trim(), qty: cnQtyToNumber(m[2]) || m[2], raw: line };
            m = line.match(re2);
            if (m) return { name: m[1].trim(), qty: cnQtyToNumber(m[2]) || m[2], raw: line };
            return { name: line, qty: '1', raw: line };
        });
    }

    function askGoodsMapping(uniqueNames, goods, owner) {
        return new Promise((resolve) => {
            const ownerLabel = normalizeOwner(owner) || UNGROUPED_LABEL;
            const stats = {};
            for (const g of goods) {
                if (!g.name) continue;
                if (!stats[g.name]) stats[g.name] = { count: 0, totalQty: 0, samples: [] };
                stats[g.name].count++;
                stats[g.name].totalQty += parseFloat(g.qty) || 1;
                if (stats[g.name].samples.length < 2) stats[g.name].samples.push(g.raw);
            }
            const rows = uniqueNames.map((name) => {
                const st = stats[name] || { count: 1, totalQty: 1, samples: [name] };
                const sampleHtml = st.samples.map(s => `<div style="font-size:11px;color:#909399;">原始: ${escapeHtml(s)}</div>`).join('');

                const presets = findSimilarPresets(owner, name, 3);
                const exact = presets.find(p => p.name === name);
                const defaultValue = exact ? exact.code : '';
                const suggestionsHtml = presets.length
                ? `<div style="margin-top:5px;font-size:11px;color:#8f959e;">预设建议（当前货主）：${
                          presets.map(p =>
                                      `<span class="tm-preset-chip" data-target="${escapeHtml(name)}" data-code="${escapeHtml(p.code)}" title="${escapeHtml(p.name)} · ${escapeHtml(p.reason)}"
                                  style="display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;background:#eef5ff;
                                         border:1px solid #b8d4ff;border-radius:10px;color:#1e6fd9;cursor:pointer;font-size:11px;">${escapeHtml(p.name)} → ${escapeHtml(p.code)}</span>`
                          ).join('')
                }</div>`
                    : '';

                return `
                    <div style="margin-bottom:10px;padding:8px;background:#fafbfc;border-radius:5px;">
                        <div style="font-size:12px;color:#4e5969;margin-bottom:4px;">
                            标识：<b style="color:#1f2329;">${escapeHtml(name)}</b>
                            <span style="color:#909399;margin-left:8px;">出现 ${st.count} 次 · 合计数量 ${st.totalQty}</span>
                        </div>
                        ${sampleHtml}
                        <input type="text" data-name="${escapeHtml(name)}" placeholder="填写实际商品编码"
                            value="${escapeHtml(defaultValue)}"
                            style="margin-top:6px;width:100%;padding:6px 8px;border:1px solid #dcdfe6;
                            border-radius:4px;font-size:12px;box-sizing:border-box;">
                        ${suggestionsHtml}
                    </div>
                `;
            }).join('');
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483600;' +
                'display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;';
            wrap.innerHTML = `
              <div style="background:#fff;border-radius:8px;width:100%;max-width:560px;padding:16px;
                          box-shadow:0 12px 40px rgba(0,0,0,.3);
                          font:13px/1.6 -apple-system,'Microsoft YaHei',sans-serif;
                          color:#1f2329;box-sizing:border-box;max-height:88vh;display:flex;flex-direction:column;">
                <div style="font-size:15px;font-weight:600;margin-bottom:6px;">商品编码映射</div>
                <div style="font-size:12px;color:#909399;margin-bottom:12px;line-height:1.7;">
                    当前货主：<b style="color:#409eff;">${escapeHtml(ownerLabel)}</b><br>
                    检测到 ${uniqueNames.length} 个不同商品，请为每个商品填写实际编码，全部填写后才能开始批量。
                </div>
                <div id="tm-map-body" style="flex:1;overflow:auto;max-height:52vh;padding-right:4px;">${rows}</div>
                <div style="display:flex;gap:12px;align-items:center;margin-top:12px;flex-wrap:wrap;">
                    <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#4e5969;cursor:pointer;">
                        <input id="tm-map-remember" type="checkbox" checked>
                        记住本次映射（绑定到货主「${escapeHtml(ownerLabel)}」）
                    </label>
                    <div style="flex:1;"></div>
                    <button id="tm-map-cancel" style="padding:6px 14px;border:1px solid #dcdfe6;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;">取消</button>
                    <button id="tm-map-ok" style="padding:6px 14px;border:0;background:#409eff;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;">确认并继续</button>
                </div>
              </div>`;
            document.body.appendChild(wrap);

            wrap.querySelectorAll('.tm-preset-chip').forEach(chip => {
                chip.onclick = () => {
                    const targetName = chip.dataset.target;
                    const code = chip.dataset.code;
                    wrap.querySelectorAll('#tm-map-body input').forEach(inp => {
                        if (inp.dataset.name === targetName) {
                            inp.value = code;
                            inp.style.borderColor = '#dcdfe6';
                        }
                    });
                };
            });

            wrap.querySelector('#tm-map-cancel').onclick = () => { wrap.remove(); resolve(null); };
            wrap.querySelector('#tm-map-ok').onclick = () => {
                const inputs = wrap.querySelectorAll('#tm-map-body input');
                const mapping = {};
                let ok = true;
                const rememberEl = wrap.querySelector('#tm-map-remember');
                const remember = !rememberEl || rememberEl.checked;
                inputs.forEach(inp => {
                    const val = inp.value.trim();
                    if (!val) { ok = false; inp.style.borderColor = '#f53f3f'; }
                    else {
                        mapping[inp.dataset.name] = val;
                        inp.style.borderColor = '#dcdfe6';
                        if (remember) setGoodsPreset(owner, inp.dataset.name, val);
                    }
                });
                if (!ok) { logMsg('请为所有商品填写编码', 'error'); return; }
                if (remember) {
                    logMsg('已记忆 ' + Object.keys(mapping).length + ' 条商品编码预设（货主：' + ownerLabel + '）', 'ok');
                }
                wrap.remove();
                resolve(mapping);
            };
        });
    }

    /* ============================================================
     * 十四、进度上报
     * ============================================================ */
    const STEP_TEXT = {
        begin: '开始', reset: '重置表单', shop: '选择店铺', shop_done: '店铺已选',
        warehouse: '选择仓库', warehouse_done: '仓库已选',
        express: '选择快递', express_done: '快递已选',
        identify: '智能识别',
        goods: '填写商品', await_confirm: '等待确认', paused: '已暂停',
        manual_resume: '手动恢复', skipped: '已跳过', submit: '提交订单',
        done: '提交成功', error: '出错', finish: '结束'
    };

    function reportProgress(info) {
        if (info.index != null) progressState.index = info.index;
        if (info.total != null) progressState.total = info.total;
        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL,
                type: 'PROGRESS',
                from: SELF_NAME,
                data: Object.assign({
                    ts: Date.now(),
                    running:  progressState.running,
                    paused:   progressState.paused,
                    stopping: progressState.stopping,
                    speed:    payloadSpeedNameCache,
                    stepText: STEP_TEXT[info.step] || info.step || ''
                }, info)
            }, '*');
        } catch (e) {}
    }

    /* ============================================================
     * 十五、批量下单主函数
     * ============================================================ */
    async function create_orders_batch(payloadOrWarehouse, rawOrders, rawGoods, speed) {
        if (batchRunning) {
            const msg = '已有批量任务在执行，请先等待完成或点击「停止当前批量」';
            logMsg(msg, 'error');
            throw new Error(msg);
        }

        let payload;
        if (typeof payloadOrWarehouse === 'string') {
            payload = { warehouse: payloadOrWarehouse, rawOrders, rawGoods, speed };
        } else {
            payload = payloadOrWarehouse || {};
        }

        const warehouse = String(payload.warehouse || '').trim();
        const express   = String(payload.express || '').trim();
        const speedName = payload.speed || '正常';
        currentPreset = SPEED_PRESETS[speedName] || SPEED_PRESETS['正常'];
        payloadSpeedNameCache = speedName;
        const autoConfirm = !!payload.autoConfirm;

        let orders = Array.isArray(payload.orders) ? payload.orders.slice() : [];
        if (!orders.length && typeof payload.rawOrders === 'string') {
            orders = payload.rawOrders.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        }

        let goods = [];
        if (Array.isArray(payload.goods) && payload.goods.length) {
            goods = payload.goods.map(g => ({ name: g.name, code: g.code, qty: String(g.qty || '1') }));
        } else if (typeof payload.rawGoods === 'string' && payload.rawGoods.trim()) {
            goods = parseGoodsLines(payload.rawGoods);
        }

        if (!warehouse)     { logMsg('仓库名为空', 'error'); throw new Error('仓库名为空'); }
        if (!orders.length) { logMsg('订单数据为空', 'error'); throw new Error('订单数据为空'); }
        if (!goods.length)  { logMsg('商品数据为空', 'error'); throw new Error('商品数据为空'); }
        if (orders.length !== goods.length) {
            const msg = `订单数量（${orders.length}）与商品数量（${goods.length}）不匹配`;
            logMsg(msg, 'error');
            throw new Error(msg);
        }

        addWarehouseHistory(warehouse);
        if (express) addExpressHistory(express);

        if (goods.some(g => g.name && !g.code)) {
            const uniqueNames = [...new Set(goods.map(g => g.name).filter(Boolean))];
            logMsg(`检测到 ${uniqueNames.length} 个不同商品，等待映射编码（货主：${warehouse}）…`, 'tip');
            const mapping = await askGoodsMapping(uniqueNames, goods, warehouse);
            if (!mapping) {
                logMsg('用户取消映射，批量终止', 'tip');
                return { total: 0, cancelled: true, results: [] };
            }
            goods = goods.map(g => ({ code: mapping[g.name] || g.code, qty: g.qty }));
            logMsg('映射完成', 'ok');
        }

        batchRunning  = true;
        const runId   = ++batchRunId;
        stopRequested = false;
        progressState.index    = 0;
        progressState.total    = orders.length;
        progressState.paused   = false;
        progressState.stopping = false;

        const total   = orders.length;
        const results = [];
        let successCount = 0, failedCount = 0, skippedCount = 0, manualCount = 0;

        logDivider('批量开始 · 共 ' + total + ' 笔 · 速度 ' + speedName + (express ? ' · 快递 ' + express : '') + (autoConfirm ? ' · 免确认模式' : ''));
        notifyBatchStatus('running', { total, speed: speedName });
        reportProgress({ step: 'begin', index: 0, total, orderCount: total });

        try {
            for (let i = 0; i < total; i++) {
                if (stopRequested) {
                    results.push({ index: i, skipped: true, reason: 'stopped' });
                    skippedCount++;
                    logMsg(`已停止，跳过第 ${i + 1} 笔`, 'tip');
                    continue;
                }

                const order = orders[i];
                const g = goods[i];
                const idx = i + 1;

                logMsg(`第 ${idx}/${total} 笔 · ${order}`, 'tip');
                reportProgress({
                    step: 'start', index: idx, total,
                    order, code: g.code, qty: g.qty,
                    successCount, failedCount, skippedCount, manualCount
                });

                try {
                    logMsg('重置表单', 'info');
                    reportProgress({ step: 'reset', index: idx, total, order, code: g.code, qty: g.qty });
                    await stepReset();

                    logMsg('选择店铺…', 'info');
                    reportProgress({ step: 'shop', index: idx, total, order, code: g.code, qty: g.qty });
                    const shop = await stepSelectShop();
                    logMsg('店铺 → ' + shop, 'ok');
                    reportProgress({ step: 'shop_done', index: idx, total, order, code: g.code, qty: g.qty, message: shop });

                    logMsg('选择仓库 → ' + warehouse, 'info');
                    reportProgress({ step: 'warehouse', index: idx, total, order, code: g.code, qty: g.qty });
                    const wh = await stepSelectWarehouse(warehouse);
                    logMsg('仓库 → ' + wh, 'ok');
                    reportProgress({ step: 'warehouse_done', index: idx, total, order, code: g.code, qty: g.qty, message: wh });

                    if (express) {
                        logMsg('选择快递公司 → ' + express, 'info');
                        reportProgress({ step: 'express', index: idx, total, order, code: g.code, qty: g.qty });
                        const ex = await stepSelectExpress(express);
                        logMsg('快递公司 → ' + ex, 'ok');
                        reportProgress({ step: 'express_done', index: idx, total, order, code: g.code, qty: g.qty, message: ex });
                    }

                    logMsg('智能识别…', 'info');
                    reportProgress({ step: 'identify', index: idx, total, order, code: g.code, qty: g.qty });
                    await stepSmartIdentify(order);

                    logMsg(`填写商品编码 ${g.code}（数量 ${g.qty}）`, 'info');
                    reportProgress({ step: 'goods', index: idx, total, order, code: g.code, qty: g.qty });
                    await stepFillGoods(g.code, g.qty);
                } catch (e) {
                    results.push({ index: i, ok: false, step: 'pre', error: e.message });
                    failedCount++;
                    logMsg(`第 ${idx} 笔前置步骤失败：${e.message}`, 'error');
                    reportProgress({
                        step: 'error', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        message: e.message,
                        successCount, failedCount, skippedCount, manualCount
                    });
                    continue;
                }

                let ans = { ok: true };
                if (autoConfirm) {
                    /* 兜底：免确认模式下若通过外部直调进入，仍拒绝空字段 */
                    if (!String(order || '').trim() ||
                        !String(g && g.code || '').trim() ||
                        !String(g && g.qty || '').trim()) {
                        results.push({ index: i, skipped: true, reason: 'incomplete' });
                        skippedCount++;
                        logMsg(`第 ${idx} 笔免确认模式信息不完整，已跳过`, 'error');
                        reportProgress({
                            step: 'skipped', index: idx, total,
                            order, code: g && g.code, qty: g && g.qty,
                            successCount, failedCount, skippedCount, manualCount,
                            reason: 'incomplete'
                        });
                        continue;
                    }
                    logMsg(`第 ${idx} 笔 · 免确认模式，自动提交`, 'tip');
                    reportProgress({
                        step: 'await_confirm', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        successCount, failedCount, skippedCount, manualCount,
                        autoConfirm: true
                    });
                } else {
                    logMsg(`请人工确认第 ${idx} 笔`, 'tip');
                    reportProgress({
                        step: 'await_confirm', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        successCount, failedCount, skippedCount, manualCount
                    });
                    ans = await askUserConfirm({ index: idx, total, order, code: g.code, qty: g.qty });
                }

                if (ans.ok === 'pause') {
                    logMsg('用户选择暂停，请手动编辑当前订单', 'tip');
                    reportProgress({
                        step: 'paused', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        successCount, failedCount, skippedCount, manualCount
                    });
                    await waitForUserResume({ index: idx, total });
                    logMsg('恢复，跳过当前笔自动提交，进入下一笔', 'tip');
                    results.push({ index: i, manual: true });
                    manualCount++;
                    reportProgress({
                        step: 'manual_resume', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        successCount, failedCount, skippedCount, manualCount
                    });
                    if (stopRequested) break;
                    await sleep(currentPreset.orderDelay);
                    continue;
                }

                if (!ans.ok) {
                    results.push({ index: i, skipped: true });
                    skippedCount++;
                    logMsg(`第 ${idx} 笔已跳过`, 'tip');
                    reportProgress({
                        step: 'skipped', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        successCount, failedCount, skippedCount, manualCount
                    });
                    if (stopRequested) break;
                    await sleep(currentPreset.orderDelay);
                    continue;
                }

                try {
                    logMsg('提交订单…', 'info');
                    reportProgress({ step: 'submit', index: idx, total, order, code: g.code, qty: g.qty });
                    await stepSubmit();
                    results.push({ index: i, ok: true });
                    successCount++;
                    logMsg(`第 ${idx} 笔提交成功`, 'ok');
                    reportProgress({
                        step: 'done', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        successCount, failedCount, skippedCount, manualCount
                    });
                } catch (e) {
                    results.push({ index: i, ok: false, step: 'submit', error: e.message });
                    failedCount++;
                    logMsg(`第 ${idx} 笔提交失败：${e.message}`, 'error');
                    reportProgress({
                        step: 'error', index: idx, total,
                        order, code: g.code, qty: g.qty,
                        message: e.message,
                        successCount, failedCount, skippedCount, manualCount
                    });
                }

                await sleep(currentPreset.orderDelay);
            }

            logDivider('批量结束 · 成功 ' + successCount + ' · 失败 ' + failedCount +
                       ' · 跳过 ' + skippedCount + ' · 手动 ' + manualCount);
            reportProgress({
                step: 'finish', total,
                successCount, failedCount, skippedCount, manualCount
            });

            return { total, results, successCount, failedCount, skippedCount, manualCount };
        } finally {
            if (runId === batchRunId) {
                batchRunning = false;
                progressState.running  = false;
                progressState.paused   = false;
                progressState.stopping = false;
            }
            const bar = document.getElementById('tm-pause-bar');
            if (bar) bar.remove();
            if (resumeResolver) {
                const r = resumeResolver; resumeResolver = null; r();
            }
            notifyBatchStatus('finished', {
                successCount, failedCount, skippedCount, manualCount, total
            });
        }
    }

    function create_orders_stop() {
        if (!batchRunning) return { ok: false, message: '当前没有正在执行的批量任务' };
        stopRequested = true;

        if (resumeResolver) {
            const r = resumeResolver;
            resumeResolver = null;
            const bar = document.getElementById('tm-pause-bar');
            if (bar) bar.remove();
            r();
        }

        notifyBatchStatus('stopping', { index: progressState.index, total: progressState.total });
        logMsg('收到停止指令，将在当前订单结束后停止', 'tip');
        return { ok: true, message: '已发送停止指令，将在当前订单结束后停止' };
    }

    /* ============================================================
     * 十六、单步业务函数
     * ============================================================ */
    async function create_order_select_shop() {
        const li = await waitForFieldLi('下单店铺');
        return await cascaderPick(li, ['通用手工单', '线下店铺']);
    }
    async function create_order_select_warehouse(name) {
        if (!name) throw new Error('仓库名为空');
        const li = await waitForFieldLi('仓库');
        if (!li) throw new Error('未找到"仓库"字段');
        return await cascaderPick(li, [name]);
    }
    async function create_order_select_express(name) {
        if (!name) throw new Error('快递公司名为空');
        const li = await waitForFieldLi('快递公司');
        if (!li) throw new Error('未找到"快递公司"字段');
        return await cascaderPick(li, [name]);
    }
    async function create_order_smart_identify(text) { await stepSmartIdentify(text); return true; }

    /* ============================================================
     * 十七、函数注册表
     * ============================================================ */
    const FUNC_MAP = {
        create_orders_batch,
        create_orders_stop,
        create_order_resume,
        create_order_stop_or_resume,
        create_order_select_shop,
        create_order_select_warehouse,
        create_order_select_express,
        create_order_smart_identify,
        create_order_chat_import: function () { return openChatToOrderDialog('chat'); },
        create_order_generic_import: function () { return openChatToOrderDialog('generic'); }
    };

    /* ============================================================
     * 十八、消息处理
     * ============================================================ */
    let acked = false;

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
            logMsg(`未知函数：${fn}`, 'error');
            reply(source, { id, ok: false, error: '未找到函数：' + fn });
            return;
        }
        Promise.resolve()
            .then(() => func.apply(null, Array.isArray(args) ? args : []))
            .then(result => reply(source, { id, ok: true, data: result }))
            .catch(e => {
            logMsg(`函数 ${fn} 失败：${(e && e.message) || e}`, 'error');
            reply(source, { id, ok: false, error: (e && e.message) || String(e) });
        });
    }

    function reply(source, payload) {
        if (!source) return;
        try {
            source.postMessage(Object.assign({ __tm_channel: CHANNEL, type: 'RESULT', from: SELF_NAME }, payload), '*');
        } catch (e) {}
    }

    /* ============================================================
     * 十九、注册循环
     * ============================================================ */
    let registerTimer = null, attempts = 0;
    const MAX_ATTEMPTS = 20, INTERVAL = 500;

    function sendReady() {
        if (acked) return;
        syncLogToConfig();
        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL, type: 'READY',
                info: {
                    name: SELF_NAME,
                    url: location.href,
                    title: document.title,
                    ts: Date.now(),
                    panelConfig: PANEL_CONFIG
                }
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

    logMsg('执行端已就绪 · 点「聊天转订单」或「通用文本转订单」开始', 'ok');
    syncLogToConfig();
    startRegisterLoop();

})();
