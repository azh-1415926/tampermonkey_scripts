// ==UserScript==
// @name         待分配订单提取器（嵌入主面板 · 全列扫描 · 时间排序）
// @namespace    https://example.com/wave-wait
// @version      1.2.0
// @description  待分配订单抓取/导出；全列扫描；记忆列选择；按下单时间排序
// @match        https://wms-v.hupun.com/wms/waveWait*
// @match        https://wms-v.hupun.com/url.d*
// @match        https://wms.hupun.com/wms/waveWait*
// @match        https://wms.hupun.com/url.d*
// @match        https://wms-t.hupun.com/wms/waveWait*
// @match        https://wms-t.hupun.com/url.d*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ==========================================================
     * 基础常量 & 工具
     * ========================================================== */
    const CHANNEL   = 'tm_panel_exec';
    const SELF_NAME = 'wave_wait';
    const Z         = 2147483647;

    const log   = (...a) => console.log('[待分配]', ...a);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $  = (s, r = document) => { try { return r.querySelector(s); } catch (e) { return null; } };
    const $$ = (s, r = document) => { try { return [...r.querySelectorAll(s)]; } catch (e) { return []; } };

    log('启动', { url: location.href, isTop: window.top === window.self });

    /* ==========================================================
     * 主面板配置（新增"抓取并排序"）
     * ========================================================== */
    const PANEL_CONFIG = [
        {
            title: '待分配',
            open: false,
            items: [
                {
                    label: '待分配订单',
                    selects: [],
                    buttons: [
                        { text: '抓取并编辑',   fn: 'function_wave_wait_grab_and_edit', params: [] },
                        { text: '抓取并排序',   fn: 'function_wave_wait_grab_sort',     params: [] },
                        { text: '仅抓取',       fn: 'function_wave_wait_grab_only',     params: [] },
                        { text: '重开工作窗',   fn: 'function_wave_wait_reopen',        params: [] },
                        { text: '清空缓存',     fn: 'function_wave_wait_clear',         params: [] }
                    ]
                }
            ]
        }
    ];

    /* ==========================================================
     * 表格定位 / 底层读写
     * ========================================================== */
    function findMainTable() {
        const cs = $$('.vxe-table').filter(t =>
            t.isConnected && t.getClientRects().length > 0 &&
            t.querySelector('.vxe-table--header thead th')
        );
        if (!cs.length) return null;
        cs.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
        return cs[0];
    }

    function getBodyWrapper(table) {
        return table.querySelector('.vxe-table--main-wrapper .vxe-table--body-wrapper')
            || table.querySelector('.vxe-table--body-wrapper');
    }
    function isVirtualX(table) {
        return table.classList.contains('is--virtual-x');
    }

    function extractHeadersVisible(table) {
        const headers = {}, order = [];
        const hd = table.querySelector('.vxe-table--main-wrapper .vxe-table--header')
                || table.querySelector('.vxe-table--header');
        if (!hd) return { headers, order };
        for (const th of hd.querySelectorAll('thead th')) {
            const colid = th.getAttribute('colid');
            if (!colid || headers[colid]) continue;
            const t = (th.querySelector('.vxe-cell--title')?.textContent || '').trim();
            if (!t) continue;
            headers[colid] = t;
            order.push({ colid, title: t });
        }
        return { headers, order };
    }

    /* ==========================================================
     * 阶段 A：横向滚动采集所有列
     * ========================================================== */
    async function scanAllHeaders(table) {
        const wr = getBodyWrapper(table);
        const headers = {}, colPos = {};

        const fixedHd = table.querySelector('.vxe-table--fixed-left-wrapper .vxe-table--header');
        if (fixedHd) {
            for (const th of fixedHd.querySelectorAll('thead th')) {
                const cid = th.getAttribute('colid');
                if (!cid || headers[cid]) continue;
                const t = (th.querySelector('.vxe-cell--title')?.textContent || '').trim();
                if (!t) continue;
                headers[cid] = t;
                colPos[cid] = -1;
            }
        }
        if (!wr) return sortByPos(headers, colPos);

        if (!isVirtualX(table)) {
            const v = extractHeadersVisible(table);
            for (const [cid, t] of Object.entries(v.headers)) {
                if (!headers[cid]) { headers[cid] = t; colPos[cid] = 0; }
            }
            return sortByPos(headers, colPos);
        }

        const orig = wr.scrollLeft;
        wr.scrollLeft = 0;
        await sleep(120);
        let lastCount = -1, stable = 0;
        for (let step = 0; step < 80; step++) {
            const v = extractHeadersVisible(table);
            for (const [cid, t] of Object.entries(v.headers)) {
                if (!headers[cid]) { headers[cid] = t; colPos[cid] = wr.scrollLeft; }
            }
            const total = Object.keys(headers).length;
            if (total === lastCount) { stable++; if (stable >= 2) break; }
            else { stable = 0; lastCount = total; }

            const before = wr.scrollLeft;
            wr.scrollLeft += Math.max(60, Math.floor(wr.clientWidth * 0.7));
            await sleep(80);
            if (wr.scrollLeft === before) break;
            if (wr.scrollLeft + wr.clientWidth >= wr.scrollWidth - 6) {
                await sleep(100);
                const last = extractHeadersVisible(table);
                for (const [cid, t] of Object.entries(last.headers)) {
                    if (!headers[cid]) { headers[cid] = t; colPos[cid] = wr.scrollLeft; }
                }
                break;
            }
        }
        wr.scrollLeft = orig;
        return sortByPos(headers, colPos);
    }

    function sortByPos(headers, colPos) {
        const order = Object.keys(headers)
            .map(cid => ({ colid: cid, title: headers[cid], pos: colPos[cid] ?? 0 }))
            .sort((a, b) => a.pos - b.pos)
            .map(({ colid, title }) => ({ colid, title }));
        return { headers, order };
    }

    /* ==========================================================
     * 阶段 B：纵向滚动 + 每屏横向全扫
     * ========================================================== */
    async function grabRowsFull(table, headers, onProgress) {
        const wr = getBodyWrapper(table);
        if (!wr) return [];
        const rows = new Map();
        const vx = isVirtualX(table);
        const origTop = wr.scrollTop, origLeft = wr.scrollLeft;

        const collectCurrent = () => {
            for (const tr of wr.querySelectorAll('tr.vxe-body--row')) {
                const rid = tr.getAttribute('rowid');
                if (!rid) continue;
                let row = rows.get(rid);
                if (!row) { row = { __rowid: rid }; rows.set(rid, row); }
                for (const td of tr.querySelectorAll('td[colid]')) {
                    const cid = td.getAttribute('colid');
                    if (!cid || !headers[cid]) continue;
                    const label = td.querySelector('.vxe-cell--label');
                    const v = (label ? label.textContent : td.textContent || '')
                                .replace(/\u00a0/g, ' ').trim();
                    if (row[cid] === undefined || !row[cid]) row[cid] = v;
                }
            }
        };

        const scanHWindow = async () => {
            if (!vx) { collectCurrent(); return; }
            wr.scrollLeft = 0;
            await sleep(60);
            for (let j = 0; j < 60; j++) {
                collectCurrent();
                const b = wr.scrollLeft;
                wr.scrollLeft += Math.max(60, Math.floor(wr.clientWidth * 0.7));
                await sleep(50);
                if (wr.scrollLeft === b) break;
                if (wr.scrollLeft + wr.clientWidth >= wr.scrollWidth - 6) {
                    await sleep(60);
                    collectCurrent();
                    break;
                }
            }
            wr.scrollLeft = 0;
            await sleep(50);
        };

        wr.scrollTop = 0; wr.scrollLeft = 0;
        await sleep(150);

        let lastSize = -1, stable = 0;
        for (let i = 0; i < 800; i++) {
            await scanHWindow();
            onProgress && onProgress({ rows: rows.size, cols: Object.keys(headers).length });
            if (rows.size === lastSize) { stable++; if (stable >= 2) break; }
            else { stable = 0; lastSize = rows.size; }

            const before = wr.scrollTop;
            wr.scrollTop += Math.max(60, Math.floor(wr.clientHeight * 0.7));
            await sleep(70);
            if (wr.scrollTop === before) break;
            if (wr.scrollTop + wr.clientHeight >= wr.scrollHeight - 6) {
                await sleep(100);
                await scanHWindow();
                break;
            }
        }
        wr.scrollTop = origTop;
        wr.scrollLeft = origLeft;
        return [...rows.values()];
    }

    /* ==========================================================
     * 缓存 / 智能默认 / 记忆
     * ========================================================== */
    const cache = {
        headers: {},
        order: [],
        rows: [],
        __origRows: null,   // ★ 原始顺序备份
        __sortState: null   // { by, dir } | null
    };

    const COMMON_TITLES = [
        '系统单号','线上单号','外部单号','运单号','快递单号','收货人','买家','手机',
        '详细地址','店铺名称','平台/店铺','商品名称','商品总数','实付'
    ];

    function isEmptyCol(rows, colid) {
        return rows.every(r => !String(r[colid] || '').trim());
    }

    function getSmartDefaultColids(headers, order, rows) {
        const result = new Set();
        for (const o of order) {
            if (COMMON_TITLES.some(c => o.title === c || o.title.includes(c))) {
                if (!isEmptyCol(rows, o.colid)) result.add(o.colid);
            }
        }
        if (result.size < 3) {
            for (const o of order) {
                if (result.size >= 5) break;
                if (!result.has(o.colid) && !isEmptyCol(rows, o.colid)) result.add(o.colid);
            }
        }
        if (!result.size) order.slice(0, 5).forEach(o => result.add(o.colid));
        return [...result];
    }

    const SELECTED_TITLES_KEY = 'tm_wait_selected_titles';
    const POS_KEY             = 'tm_wait_pos';
    const PREF_KEY            = 'tm_wait_pref';

    function saveSelectedTitles(order, selected) {
        try {
            const titles = order.filter(o => selected.has(o.colid)).map(o => o.title);
            localStorage.setItem(SELECTED_TITLES_KEY, JSON.stringify(titles));
        } catch (e) {}
    }
    function loadSelectedTitles() {
        try {
            const raw = localStorage.getItem(SELECTED_TITLES_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function colidsByTitles(order, titles) {
        if (!titles || !titles.length) return null;
        const set = new Set(titles);
        const hit = order.filter(o => set.has(o.title)).map(o => o.colid);
        return hit.length ? hit : null;
    }

    function loadPos() { try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { return null; } }
    function savePos(x, y) { try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch (e) {} }
    function clampX(x) { return Math.max(0, Math.min(x, window.innerWidth - 80)); }
    function clampY(y) { return Math.max(0, Math.min(y, window.innerHeight - 40)); }

    /* ==========================================================
     * ★ 时间排序工具
     * ========================================================== */
    const DATE_COL_PREFERRED = '下单时间';
    const DATE_COL_ALIASES   = ['下单时间', '创建时间', '订单创建时间', '付款时间', '支付时间'];

    function findDateColid() {
        // 1) 精确匹配"下单时间"
        let o = cache.order.find(x => x.title === DATE_COL_PREFERRED);
        if (o) return o.colid;

        // 2) 别名匹配
        for (const alias of DATE_COL_ALIASES) {
            o = cache.order.find(x => x.title === alias);
            if (o) return o.colid;
        }
        // 3) 包含匹配（兜底）
        for (const alias of DATE_COL_ALIASES) {
            o = cache.order.find(x => x.title.includes(alias));
            if (o) return o.colid;
        }
        return null;
    }

    /**
     * 对 cache.rows 按下单时间排序（就地修改）
     * @param {'asc'|'desc'} dir
     * @returns {{colid, title, count} | null}
     */
    function sortCacheByDate(dir) {
        const cid = findDateColid();
        if (!cid) return null;
        const d = dir === 'desc' ? -1 : 1;

        cache.rows.sort((a, b) => {
            const va = String(a[cid] || '').trim();
            const vb = String(b[cid] || '').trim();
            // 空值固定排最后
            if (!va && !vb) return 0;
            if (!va) return 1;
            if (!vb) return -1;
            // 时间字符串 YYYY-MM-DD HH:mm:ss 直接字典序即可
            const cmp = va.localeCompare(vb);
            return cmp * d;
        });

        cache.__sortState = { by: cache.headers[cid], dir };
        return { colid: cid, title: cache.headers[cid], count: cache.rows.length };
    }

    /* ==========================================================
     * 输出 / 复制
     * ========================================================== */
    function buildOutput(colids, sep, withHeader, filters) {
        const valid = cache.order.filter(o => colids.includes(o.colid));
        if (!valid.length) return { text: '', rows: [] };
        let rows = cache.rows;
        if (filters?.length) {
            rows = rows.filter(row => filters.every(f => {
                if (!f.colid || !cache.headers[f.colid]) return true;
                const c = row[f.colid] || '', v = f.value || '';
                switch (f.op) {
                    case 'contains':    return c.includes(v);
                    case 'equals':      return c === v;
                    case 'notcontains': return !c.includes(v);
                    case 'notempty':    return c.trim() !== '';
                    case 'empty':       return c.trim() === '';
                    case 'regex':       try { return new RegExp(v).test(c); } catch (e) { return false; }
                    default:            return true;
                }
            }));
        }
        const lines = [];
        if (withHeader) lines.push(valid.map(c => cache.headers[c.colid]).join(sep));
        for (const r of rows) {
            lines.push(valid.map(c => String(r[c.colid] || '').replace(/\r?\n/g, ' ')).join(sep));
        }
        return { text: lines.join('\n'), rows };
    }

    async function copyText(text) {
        try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) {}
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            (document.body || document.documentElement).appendChild(ta);
            ta.select(); const ok = document.execCommand('copy'); ta.remove();
            return ok;
        } catch (e) { return false; }
    }

    /* ==========================================================
     * 工作窗样式
     * ========================================================== */
    const WORK_STYLE_ID = 'tmw-style';
    const WORK_STYLE = `
    .tmw-dialog { position: fixed; z-index: ${Z};
        width: 780px; max-width: 94vw; max-height: 88vh;
        background: #fff; border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0,0,0,.35);
        display: flex; flex-direction: column; overflow: hidden;
        font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #333; }
    .tmw-hd { padding: 10px 14px; background: #f5f7fa; border-bottom: 1px solid #e4e7ed;
        display: flex; justify-content: space-between; align-items: center; font-weight: bold;
        cursor: move; user-select: none; }
    .tmw-hd .tmw-x { cursor: pointer; color: #999; font-size: 16px; }
    .tmw-hd .tmw-x:hover { color: #f56c6c; }
    .tmw-body { padding: 12px 14px; overflow-y: auto; flex: 1; }
    .tmw-sec { margin-bottom: 12px; }
    .tmw-sec-t { font-weight: bold; color: #606266; margin-bottom: 6px;
        display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
    .tmw-sec-t small { font-weight: normal; color: #909399; }
    .tmw-sec-t a { color: #4a90e2; text-decoration: none; cursor: pointer; margin: 0 3px; }
    .tmw-sec-t a.active { color: #fff; background: #4a90e2; padding: 1px 6px; border-radius: 3px; }
    .tmw-search { width: 100%; box-sizing: border-box; padding: 5px 8px; font: inherit; font-size: 12px;
        border: 1px solid #dcdfe6; border-radius: 4px; margin-bottom: 6px; }
    .tmw-cols { border: 1px solid #e4e7ed; border-radius: 4px; padding: 6px; max-height: 240px;
        overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px; }
    .tmw-cols label { display: flex; align-items: center; gap: 5px; padding: 3px 5px;
        border-radius: 3px; cursor: pointer; font-size: 12px; overflow: hidden; white-space: nowrap; }
    .tmw-cols label:hover { background: #f0f7ff; }
    .tmw-cols label.tmw-empty span { color: #c0c4cc; }
    .tmw-cols label .tmw-tag  { color: #c0c4cc; font-size: 10px; margin-left: 2px; }
    .tmw-cols label .tmw-star { color: #e6a23c; font-size: 10px; margin-left: 2px; }
    .tmw-opt-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .tmw-opt-row select { font: inherit; font-size: 12px; padding: 3px 6px;
        border: 1px solid #dcdfe6; border-radius: 3px; }
    .tmw-preview { width: 100%; box-sizing: border-box; min-height: 100px; max-height: 200px;
        font-family: Consolas,Menlo,monospace; font-size: 12px; padding: 6px;
        border: 1px solid #e4e7ed; border-radius: 4px; background: #fafafa;
        resize: vertical; white-space: pre; overflow: auto; }
    .tmw-stat { color: #4a90e2; font-weight: bold; }
    .tmw-ft { padding: 10px 14px; border-top: 1px solid #e4e7ed; display: flex;
        justify-content: flex-end; gap: 8px; }
    .tmw-btn { padding: 6px 16px; border: 1px solid #dcdfe6; border-radius: 4px; background: #fff;
        cursor: pointer; font: inherit; font-size: 13px; color: #606266; }
    .tmw-btn:hover { border-color: #4a90e2; color: #4a90e2; }
    .tmw-btn.primary { background: #4a90e2; color: #fff; border-color: #4a90e2; }
    .tmw-btn.primary:hover { background: #357abd; border-color: #357abd; }
    .tmw-sort-info { color: #909399; font-size: 11px; margin-left: 6px; }
    .tmw-sort-info.warn { color: #e6a23c; }
    `;

    function ensureWorkStyle() {
        if (document.getElementById(WORK_STYLE_ID)) return;
        const st = document.createElement('style');
        st.id = WORK_STYLE_ID;
        st.textContent = WORK_STYLE;
        document.head.appendChild(st);
    }

    let activeDialog = null;

    function showWorkDialog(meta = '') {
        ensureWorkStyle();
        if (!cache.order.length) { alert('缓存为空，请先抓取'); return; }

        if (activeDialog) {
            if (activeDialog.__cleanup) activeDialog.__cleanup();
            activeDialog.remove();
            activeDialog = null;
        }

        const savedTitles = loadSelectedTitles();
        const savedColids = colidsByTitles(cache.order, savedTitles);
        let selected = new Set(
            savedColids ? savedColids : getSmartDefaultColids(cache.headers, cache.order, cache.rows)
        );
        if (!selected.size) getSmartDefaultColids(cache.headers, cache.order, cache.rows).forEach(c => selected.add(c));

        const emptyCols = new Set(cache.order.filter(o => isEmptyCol(cache.rows, o.colid)).map(o => o.colid));

        const dlg = document.createElement('div');
        dlg.className = 'tmw-dialog';
        dlg.innerHTML = `
            <div class="tmw-hd">
                <span>待分配数据提取 · ${cache.rows.length} 行 · ${cache.order.length} 列${meta ? ' · ' + meta : ''}</span>
                <span class="tmw-x" title="关闭 (Esc)">✕</span>
            </div>
            <div class="tmw-body">
                <div class="tmw-sec">
                    <div class="tmw-sec-t">
                        <span>排序 <span class="tmw-sort-info"></span></span>
                        <small>
                            <a data-act="sort-origin">原始顺序</a> ·
                            <a data-act="sort-asc">下单时间 ↑</a> ·
                            <a data-act="sort-desc">下单时间 ↓</a>
                        </small>
                    </div>
                </div>

                <div class="tmw-sec">
                    <div class="tmw-sec-t">
                        <span>导出列 <span class="tmw-cnt"></span></span>
                        <small>
                            <a data-act="common">常用</a> ·
                            <a data-act="last">上次</a> ·
                            <a data-act="all">全选</a> ·
                            <a data-act="none">清空</a> ·
                            <a data-act="invert">反选</a>
                        </small>
                    </div>
                    <input class="tmw-search" placeholder="搜索列名（支持多个关键字，空格分隔）">
                    <div class="tmw-cols"></div>
                </div>

                <div class="tmw-sec">
                    <div class="tmw-sec-t"><span>选项</span></div>
                    <div class="tmw-opt-row">
                        <label>分隔符
                            <select class="tmw-sep">
                                <option value="\t">Tab（推荐 Excel）</option>
                                <option value=",">逗号</option>
                                <option value="|">竖线 |</option>
                                <option value="  ">空格</option>
                            </select>
                        </label>
                        <label><input type="checkbox" class="tmw-header" checked> 包含表头</label>
                    </div>
                </div>

                <div class="tmw-sec">
                    <div class="tmw-sec-t"><span>预览</span><span class="tmw-stat"></span></div>
                    <textarea class="tmw-preview" readonly></textarea>
                </div>
            </div>
            <div class="tmw-ft">
                <button class="tmw-btn" data-act="close">关闭</button>
                <button class="tmw-btn primary" data-act="copy">复制全部</button>
            </div>
        `;

        const savedPos = loadPos();
        const initW = Math.min(780, window.innerWidth * 0.94);
        dlg.style.left = ((savedPos && typeof savedPos.x === 'number')
            ? clampX(savedPos.x) : Math.max(0, (window.innerWidth - initW) / 2)) + 'px';
        dlg.style.top  = ((savedPos && typeof savedPos.y === 'number')
            ? clampY(savedPos.y) : Math.max(20, Math.round(window.innerHeight * 0.06))) + 'px';

        document.body.appendChild(dlg);
        activeDialog = dlg;

        const colsBox   = $('.tmw-cols', dlg);
        const cntEl     = $('.tmw-cnt', dlg);
        const statEl    = $('.tmw-stat', dlg);
        const previewEl = $('.tmw-preview', dlg);
        const searchEl  = $('.tmw-search', dlg);
        const sepEl     = $('.tmw-sep', dlg);
        const headerEl  = $('.tmw-header', dlg);
        const sortInfoEl = $('.tmw-sort-info', dlg);

        try {
            const pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
            if (pref.sep) sepEl.value = pref.sep;
            if (typeof pref.header === 'boolean') headerEl.checked = pref.header;
        } catch (e) {}

        function savePref() {
            try {
                localStorage.setItem(PREF_KEY, JSON.stringify({
                    sep: sepEl.value, header: headerEl.checked
                }));
            } catch (e) {}
        }
        function persistSelection() {
            saveSelectedTitles(cache.order, selected);
        }

        /* ★ 排序状态显示 */
        function refreshSortButtons() {
            const s = cache.__sortState;
            dlg.querySelectorAll('[data-act^="sort-"]').forEach(a => a.classList.remove('active'));
            if (!s) {
                sortInfoEl.textContent = '（原始顺序）';
                sortInfoEl.classList.remove('warn');
                const origin = dlg.querySelector('[data-act="sort-origin"]');
                if (origin) origin.classList.add('active');
            } else {
                sortInfoEl.textContent = `（${s.by} ${s.dir === 'desc' ? '↓' : '↑'}）`;
                sortInfoEl.classList.remove('warn');
                const key = s.dir === 'desc' ? 'sort-desc' : 'sort-asc';
                const btn = dlg.querySelector(`[data-act="${key}"]`);
                if (btn) btn.classList.add('active');
            }
        }

        function renderCols(keyword = '') {
            const kws = keyword.toLowerCase().split(/\s+/).filter(Boolean);
            colsBox.innerHTML = cache.order.map(o => {
                if (kws.length && !kws.every(k => o.title.toLowerCase().includes(k))) return '';
                const checked  = selected.has(o.colid) ? 'checked' : '';
                const isEmpty  = emptyCols.has(o.colid);
                const isCommon = COMMON_TITLES.some(c => o.title === c || o.title.includes(c));
                const marks =
                    (isEmpty ? '<span class="tmw-tag">(空)</span>' : '') +
                    (isCommon ? '<span class="tmw-star">★</span>' : '');
                const sample = cache.rows.map(r => r[o.colid]).find(v => v && v.trim()) || '';
                const titleAttr = sample ? `${o.title} — 例: ${sample.slice(0, 60)}` : o.title;
                return `
                    <label class="${isEmpty ? 'tmw-empty' : ''}" title="${titleAttr.replace(/"/g, '&quot;')}">
                        <input type="checkbox" data-colid="${o.colid}" ${checked}>
                        <span>${o.title}${marks}</span>
                    </label>`;
            }).join('');
        }

        let updateTimer = null;
        function scheduleUpdate() {
            clearTimeout(updateTimer);
            updateTimer = setTimeout(updatePreview, 80);
        }
        function updatePreview() {
            const colids = cache.order.filter(o => selected.has(o.colid)).map(o => o.colid);
            cntEl.textContent = `(${colids.length}/${cache.order.length})`;
            if (!colids.length) { previewEl.value = ''; statEl.textContent = '请至少选择一列'; return; }
            const { text, rows } = buildOutput(colids, sepEl.value, headerEl.checked);
            const lines = text.split('\n');
            previewEl.value = lines.slice(0, 25).join('\n');
            statEl.textContent = `${rows.length} 行 × ${colids.length} 列` +
                (lines.length > 25 ? '（预览仅前 25 行）' : '');
        }

        colsBox.addEventListener('change', e => {
            const cb = e.target;
            if (cb.tagName !== 'INPUT') return;
            const cid = cb.getAttribute('data-colid');
            if (cb.checked) selected.add(cid); else selected.delete(cid);
            persistSelection();
            scheduleUpdate();
        });

        searchEl.addEventListener('input', () => renderCols(searchEl.value));

        dlg.querySelectorAll('[data-act]').forEach(el => {
            el.addEventListener('click', async () => {
                const act = el.getAttribute('data-act');
                if (act === 'sort-origin') {
                    if (cache.__origRows) {
                        cache.rows = [...cache.__origRows];
                        cache.__sortState = null;
                        refreshSortButtons();
                        scheduleUpdate();
                        log('[sort] 已恢复原始顺序');
                    }
                    return;
                }
                if (act === 'sort-asc' || act === 'sort-desc') {
                    if (!cache.__origRows) cache.__origRows = [...cache.rows];
                    const dir = act === 'sort-desc' ? 'desc' : 'asc';
                    const r = sortCacheByDate(dir);
                    if (!r) {
                        sortInfoEl.textContent = '（未找到下单时间列）';
                        sortInfoEl.classList.add('warn');
                        alert('当前表格未找到"下单时间"列，无法按下单时间排序');
                        return;
                    }
                    refreshSortButtons();
                    scheduleUpdate();
                    log(`[sort] 已按 ${r.title} ${dir === 'desc' ? '降序' : '升序'} 排序，共 ${r.count} 行`);
                    return;
                }

                if (act === 'all') {
                    cache.order.forEach(o => selected.add(o.colid));
                } else if (act === 'none') {
                    selected.clear();
                } else if (act === 'invert') {
                    cache.order.forEach(o => {
                        selected.has(o.colid) ? selected.delete(o.colid) : selected.add(o.colid);
                    });
                } else if (act === 'common') {
                    selected = new Set(getSmartDefaultColids(cache.headers, cache.order, cache.rows));
                } else if (act === 'last') {
                    const last = colidsByTitles(cache.order, loadSelectedTitles());
                    if (last) selected = new Set(last);
                    else alert('暂无上次勾选记录');
                } else if (act === 'close') {
                    closeDialog(); return;
                } else if (act === 'copy') {
                    const colids = cache.order.filter(o => selected.has(o.colid)).map(o => o.colid);
                    if (!colids.length) { alert('请至少选择一列'); return; }
                    const { text, rows } = buildOutput(colids, sepEl.value, headerEl.checked);
                    if (!text) { alert('生成内容为空'); return; }
                    const old = el.textContent;
                    const ok = await copyText(text);
                    if (ok) {
                        el.textContent = `✓ 已复制 ${rows.length} 行`;
                        el.style.background = '#67c23a';
                        el.style.borderColor = '#67c23a';
                        setTimeout(() => {
                            el.textContent = old;
                            el.style.background = '';
                            el.style.borderColor = '';
                        }, 1500);
                    } else {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        ta.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;font:12px/1.5 monospace;padding:20px;';
                        document.body.appendChild(ta);
                        ta.focus(); ta.select();
                        alert('自动复制被拦截，请按 Ctrl+C 复制，完成后点确定');
                        ta.remove();
                    }
                    savePref();
                    return;
                }
                persistSelection();
                renderCols(searchEl.value);
                scheduleUpdate();
            });
        });

        sepEl.addEventListener('change', () => { savePref(); scheduleUpdate(); });
        headerEl.addEventListener('change', () => { savePref(); scheduleUpdate(); });

        function closeDialog() {
            persistSelection();
            savePref();
            if (dlg.__cleanup) dlg.__cleanup();
            dlg.remove();
            if (activeDialog === dlg) activeDialog = null;
        }
        $('.tmw-x', dlg).addEventListener('click', closeDialog);

        const onEsc = e => { if (e.key === 'Escape' && activeDialog === dlg) closeDialog(); };
        document.addEventListener('keydown', onEsc);

        (function enableDrag() {
            const hd = $('.tmw-hd', dlg);
            let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
            function onDown(e) {
                if (e.target.classList.contains('tmw-x')) return;
                if (e.button !== 0) return;
                dragging = true;
                const r = dlg.getBoundingClientRect();
                sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
                document.body.style.userSelect = 'none';
                e.preventDefault();
            }
            function onMove(e) {
                if (!dragging) return;
                dlg.style.left = clampX(ox + e.clientX - sx) + 'px';
                dlg.style.top  = clampY(oy + e.clientY - sy) + 'px';
            }
            function onUp() {
                if (!dragging) return;
                dragging = false;
                document.body.style.userSelect = '';
                savePos(parseFloat(dlg.style.left) || 0, parseFloat(dlg.style.top) || 0);
            }
            hd.addEventListener('mousedown', onDown);
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);

            dlg.__cleanup = () => {
                hd.removeEventListener('mousedown', onDown);
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.removeEventListener('keydown', onEsc);
                document.body.style.userSelect = '';
                clearTimeout(updateTimer);
            };
        })();

        const onResize = () => {
            if (!dlg.isConnected) return;
            dlg.style.left = clampX(parseFloat(dlg.style.left) || 0) + 'px';
            dlg.style.top  = clampY(parseFloat(dlg.style.top)  || 0) + 'px';
        };
        window.addEventListener('resize', onResize);
        const origCleanup = dlg.__cleanup;
        dlg.__cleanup = () => {
            window.removeEventListener('resize', onResize);
            if (origCleanup) origCleanup();
        };

        refreshSortButtons();
        renderCols('');
        updatePreview();
    }

    /* ==========================================================
     * 抓取入口
     * ========================================================== */
    async function doGrab(onProgress) {
        const t = findMainTable();
        if (!t) throw new Error('未找到订单主表，请确认页面已加载');
        onProgress?.({ phase: 'headers' });
        const { headers, order } = await scanAllHeaders(t);
        if (!order.length) throw new Error('未识别到任何列');
        const rows = await grabRowsFull(t, headers, p => onProgress?.({ phase: 'rows', ...p }));

        cache.headers = headers;
        cache.order   = order;
        cache.rows    = rows;
        cache.__origRows = [...rows];   // ★ 备份原始顺序
        cache.__sortState = null;
        log(`抓取完成 rows=${rows.length} cols=${order.length}`);
        return { headers, order, rows };
    }

    /* ==========================================================
     * 对外 CALL 函数
     * ========================================================== */
    async function function_wave_wait_grab_and_edit() {
        const res = await doGrab(p => {
            if (p.phase === 'headers') setBootStatus('扫描列清单…');
            else setBootStatus(`采集数据… 行 ${p.rows || 0} / 列 ${p.cols || 0}`);
        });
        clearBootStatus();
        if (!res.rows.length) throw new Error('抓取到 0 行数据');
        showWorkDialog('全量抓取');
        return { ok: true, count: res.rows.length, cols: res.order.length,
                 note: '工作窗已打开，请在窗内勾选并复制' };
    }

    /* ★ 新增：抓取 + 自动按下单时间降序 + 打开工作窗 */
    async function function_wave_wait_grab_sort() {
        const res = await doGrab(p => {
            if (p.phase === 'headers') setBootStatus('扫描列清单…');
            else setBootStatus(`采集数据… 行 ${p.rows || 0} / 列 ${p.cols || 0}`);
        });
        clearBootStatus();
        if (!res.rows.length) throw new Error('抓取到 0 行数据');

        const r = sortCacheByDate('desc');
        if (!r) {
            showWorkDialog('全量 · 未找到下单时间列');
            return { ok: true, count: res.rows.length, cols: res.order.length,
                     sorted: false, note: '未找到"下单时间"列，已按原始顺序展示' };
        }
        showWorkDialog(`全量 · 按下单时间↓`);
        log(`[grab_sort] 完成，${r.count} 行已按 ${r.title} 降序排列`);
        return { ok: true, count: res.rows.length, cols: res.order.length,
                 sorted: true, sortBy: r.title, direction: 'desc',
                 note: `已按"${r.title}"降序排列` };
    }

    async function function_wave_wait_grab_only() {
        const res = await doGrab(p => {
            if (p.phase === 'headers') setBootStatus('扫描列清单…');
            else setBootStatus(`采集数据… 行 ${p.rows || 0} / 列 ${p.cols || 0}`);
        });
        clearBootStatus();
        return { ok: true, count: res.rows.length, cols: res.order.length };
    }

    async function function_wave_wait_reopen() {
        if (!cache.rows.length) throw new Error('缓存为空，请先抓取');
        showWorkDialog('缓存数据');
        return { ok: true, count: cache.rows.length };
    }

    async function function_wave_wait_clear() {
        cache.headers = {}; cache.order = []; cache.rows = [];
        cache.__origRows = null; cache.__sortState = null;
        if (activeDialog) {
            if (activeDialog.__cleanup) activeDialog.__cleanup();
            activeDialog.remove();
            activeDialog = null;
        }
        try { localStorage.removeItem(SELECTED_TITLES_KEY); } catch (e) {}
        return { ok: true };
    }

    const FUNC_MAP = {
        function_wave_wait_grab_and_edit,
        function_wave_wait_grab_sort,
        function_wave_wait_grab_only,
        function_wave_wait_reopen,
        function_wave_wait_clear
    };

    /* ==========================================================
     * 提示气泡
     * ========================================================== */
    let bootTip = null;
    function setBootStatus(text) {
        if (!bootTip) {
            bootTip = document.createElement('div');
            bootTip.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:${Z};
                background:#303133;color:#fff;padding:8px 14px;border-radius:6px;
                font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
                box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;`;
            document.body.appendChild(bootTip);
        }
        bootTip.textContent = text;
    }
    function clearBootStatus() {
        if (bootTip) { bootTip.remove(); bootTip = null; }
    }

    /* ==========================================================
     * 主面板协议
     * ========================================================== */
    let acked = false, registerTimer = null, attempts = 0;
    const MAX_ATTEMPTS = 20, INTERVAL = 500;

    function sendReady() {
        if (acked) return;
        try {
            window.parent.postMessage({
                __tm_channel: CHANNEL, type: 'READY',
                info: { name: SELF_NAME, url: location.href, title: document.title, ts: Date.now(), panelConfig: PANEL_CONFIG }
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
    function reply(source, payload) {
        if (!source) return;
        try {
            source.postMessage(Object.assign({ __tm_channel: CHANNEL, type: 'RESULT', from: SELF_NAME }, payload), '*');
        } catch (e) {}
    }
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
            .catch(e => { clearBootStatus(); reply(source, { id, ok: false, error: (e && e.message) || String(e) }); });
    }

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;
        if (data.type === 'ACK')      { acked = true; log('主面板已确认注册'); return; }
        if (data.type === 'DISCOVER') { acked = false; sendReady(); return; }
        if (data.type === 'CALL') {
            if (data.target && data.target !== SELF_NAME) return;
            handleCall(data, event.source);
        }
    });

    /* ==========================================================
     * 独立打开兜底
     * ========================================================== */
    function injectStandalone() {
        if (document.getElementById('tm-wait-float-btn')) return;
        const btn = document.createElement('div');
        btn.id = 'tm-wait-float-btn';
        btn.textContent = '待分配';
        btn.title = '点击抓取并打开工作窗';
        btn.style.cssText = `position:fixed;right:20px;bottom:200px;z-index:${Z};
            width:56px;height:56px;border-radius:50%;
            background:linear-gradient(135deg,#4a90e2,#357abd);
            color:#fff;font-size:12px;font-weight:bold;
            display:flex;align-items:center;justify-content:center;
            cursor:pointer;user-select:none;
            box-shadow:0 4px 16px rgba(74,144,226,.45);
            transition:transform .15s;`;
        btn.addEventListener('mouseenter', () => btn.style.transform = 'scale(1.06)');
        btn.addEventListener('mouseleave', () => btn.style.transform = 'scale(1)');
        btn.addEventListener('click', () => showStandaloneMenu());
        document.body.appendChild(btn);
        log('独立模式：已注入悬浮按钮');
    }

    function showStandaloneMenu() {
        document.getElementById('tm-wait-menu')?.remove();
        const menu = document.createElement('div');
        menu.id = 'tm-wait-menu';
        menu.style.cssText = `position:fixed;right:90px;bottom:200px;z-index:${Z};
            background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);
            padding:6px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
            min-width:170px;`;
        const items = [
            { text: '抓取并编辑', fn: async () => {
                await doGrab(p => setBootStatus(p.phase === 'headers' ? '扫描列…' : `行 ${p.rows || 0}`));
                clearBootStatus(); showWorkDialog('独立模式');
            }},
            { text: '抓取并排序', fn: async () => {
                await doGrab(p => setBootStatus(p.phase === 'headers' ? '扫描列…' : `行 ${p.rows || 0}`));
                clearBootStatus();
                const r = sortCacheByDate('desc');
                showWorkDialog(r ? '独立 · 按下单时间↓' : '独立 · 未找到时间列');
            }}
        ];
        items.forEach(it => {
            const a = document.createElement('div');
            a.textContent = it.text;
            a.style.cssText = `padding:8px 14px;cursor:pointer;border-radius:4px;color:#4a90e2;`;
            a.addEventListener('mouseenter', () => a.style.background = '#f0f7ff');
            a.addEventListener('mouseleave', () => a.style.background = '');
            a.addEventListener('click', async () => {
                menu.remove();
                try { await it.fn(); }
                catch (e) { alert('操作失败：' + (e.message || e)); clearBootStatus(); }
            });
            menu.appendChild(a);
        });
        document.body.appendChild(menu);
        setTimeout(() => {
            const close = e => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('mousedown', close, true);
                }
            };
            document.addEventListener('mousedown', close, true);
        }, 50);
    }

    /* ==========================================================
     * 入口
     * ========================================================== */
    function looksLikeWaitTable(table) {
        const { order } = extractHeadersVisible(table);
        const titles = order.map(o => o.title);
        const markers = ['系统单号','外部单号','店铺名称','运单号','收货人','商品总数','实付'];
        const hits = markers.filter(m => titles.some(t => t.includes(m))).length;
        return hits >= 3;
    }

    async function waitAndDetect(maxMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            const t = findMainTable();
            if (t && looksLikeWaitTable(t)) return t;
            await sleep(300);
        }
        return null;
    }

    (async function main() {
        document.documentElement.setAttribute('data-tm-wait', '1');
        const table = await waitAndDetect(8000);
        if (!table) { log('未检测到特征表格，不注册'); return; }
        log('✔ 表格就绪，' + (window.parent === window.self ? '独立模式' : '嵌入式模式'));
        if (window.parent === window.self) injectStandalone();
        else startRegisterLoop();
    })();
})();
