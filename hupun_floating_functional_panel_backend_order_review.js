// ==UserScript==
// @name         万里牛悬浮功能面板-订单执行端
// @namespace    https://example.com/tm-panel
// @version      1.0.0
// @description  在 iframe 内运行，接收主控端 postMessage 并执行对应业务函数
// @author       You
// @match        https://old-erp.hupun.com/calf-biz/trade/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* 只在 iframe 内运行 */
    if (window.self === window.top) return;

    const CHANNEL = 'tm_panel_exec';

    function selectShengfeng(SF)
    {
        // more
        const btnOfMoreOption = document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > div > div.more-button");
        if(btnOfMoreOption.className==='more-button')
        {
            btnOfMoreOption.click();
        }

        const menuOfShengfeng = document.evaluate(
            "//div[contains(@class,'region-select')][.//input[@placeholder='省 / 市 / 区县']]" +
            "//i[contains(@class,'el-select__caret')]",
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if(menuOfShengfeng)
        {
            menuOfShengfeng.click();

            const checkboxOfSF = document.evaluate(
                "//div[@id='pane-省']" +
                "//div[contains(@class,'region-box') and normalize-space(.)='"+SF+"']" +
                "/ancestor::div[contains(@class,'region')][1]" +
                "//label[contains(@class,'el-checkbox')]",
                document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;

            checkboxOfSF?.click();
        }
        else
        {
            alert('无法定位到省份下拉框');
        }
    }

    async function selectShop(shopNames) {
        // 兼容只传一个字符串的情况
        const names = Array.isArray(shopNames) ? shopNames : [shopNames];

        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        const WAIT_OPEN = 100;
        const WAIT_FILTER = 300;
        const WAIT_CLICK = 100;

        const menuOfShop = document.querySelector(
            "#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > ul > li:nth-child(1) > div.el-select.hp-cascader-select-lazy.el-select--mini > div > span.el-input__suffix > span"
        );

        if (!menuOfShop) {
            alert('无法定位到店铺下拉框');
            return;
        }

        function isVisible(el) {
            return el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
        }

        function getVisibleDropdown() {
            return [...document.querySelectorAll('.hp-cascader-select-dropdown')]
                .find(d => isVisible(d) && d.querySelector('.cascader-select-lazy-picker.multiple'));
        }

        // 先确保下拉打开
        let dropdown = getVisibleDropdown();
        if (!dropdown) {
            menuOfShop.click();
            await sleep(WAIT_OPEN);
            dropdown = getVisibleDropdown();
        }

        if (!dropdown) {
            alert('无法定位到店铺下拉面板');
            return;
        }

        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

        for (const shopName of names) {
            dropdown = getVisibleDropdown();

            // 如果中途下拉关了，重新打开
            if (!dropdown) {
                menuOfShop.click();
                await sleep(WAIT_OPEN);
                dropdown = getVisibleDropdown();
            }

            if (!dropdown) {
                console.warn(`未找到目标下拉，跳过：${shopName}`);
                continue;
            }

            const input = dropdown.querySelector('.input-filter input');

            if (!input) {
                console.warn(`未找到输入框，跳过：${shopName}`);
                continue;
            }

            input.focus();

            setter.call(input, shopName);
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                data: shopName
            }));

            // 等过滤结果渲染
            await sleep(WAIT_FILTER);

            // 过滤后重新获取可见下拉
            dropdown = getVisibleDropdown();

            if (!dropdown) {
                console.warn(`过滤后未找到下拉，跳过：${shopName}`);
                continue;
            }

            // 原逻辑：点击全选 / 操作项
            const label = document.evaluate(
                ".//label[contains(@class,'operate-check') and not(contains(@class,'reverse'))]",
                dropdown,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            ).singleNodeValue;

            if (label && !label.classList.contains('is-checked')) {
                label.click();
                await sleep(WAIT_CLICK);
            } else {
                console.warn(`未找到可点击项，或已选中：${shopName}`);
            }
        }

        // 最后如果下拉还开着，就关闭
        if (getVisibleDropdown()) {
            menuOfShop.click();
            await sleep(WAIT_OPEN);
        }
    }

    async function selectBiaoji(items) {
        // items 支持多种写法：
        //   1) ['缺货', '空单', '仓库打回']                    → 每个文本点第 1 个（索引 0）
        //   2) { '缺货': 0, '空单': 1, '仓库打回': 1 }         → 每个文本指定索引
        //   3) [{ label: '缺货', index: 0 }, ...]              → 对象数组
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        const WAIT_OPEN = 100;
        const WAIT_RENDER = 20;
        const WAIT_BETWEEN = 10;
        const WAIT_CLOSE = 100;

        // 统一成 [{ label, index }] 结构
        function normalize(input) {
            if (!input) return [];
            if (Array.isArray(input)) {
                return input.map(it =>
                                 typeof it === 'string'
                                 ? { label: it, index: 0 }
                                 : { label: it.label, index: it.index ?? 0 }
                                );
            }
            if (typeof input === 'object') {
                return Object.entries(input).map(([label, index]) => ({ label, index }));
            }
            return [];
        }

        const tasks = normalize(items);
        if (!tasks.length) {
            console.warn('selectBiaoji: 没有要勾选的项');
            return false;
        }

        const MENU_SELECTOR =
              "#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > ul > li:nth-child(5) > div.el-select.hp-cascader-select-lazy.el-select--mini > div > span.el-input__suffix > span";

        const menuOfBiaoji = document.querySelector(MENU_SELECTOR);
        if (!menuOfBiaoji) {
            alert('无法定位到标记指定下拉框');
            return false;
        }

        const isVisible = (el) =>
        !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;

        const dropdownOpen = () =>
        [...document.querySelectorAll('li.el-cascader-node')].some(isVisible);

        async function ensureOpen() {
            if (!dropdownOpen()) {
                menuOfBiaoji.click();
                await sleep(WAIT_OPEN);
            }
        }

        async function ensureClose() {
            if (dropdownOpen()) {
                menuOfBiaoji.click();
                await sleep(WAIT_CLOSE);
            }
        }

        // 每次重新查找：只取可见节点、文本完全匹配
        function findVisibleNodesByLabel(text) {
            return [...document.querySelectorAll('li.el-cascader-node')]
                .filter(isVisible)
                .filter(n => {
                const l = n.querySelector('.el-cascader-node__label');
                return l && l.textContent.trim() === text;
            });
        }

        try {
            await ensureOpen();
            await sleep(WAIT_RENDER);

            const successList = [];
            const failList = [];

            for (const { label, index } of tasks) {
                // 关键：每次操作前重新查找，避免拿到已被替换的旧节点
                const nodes = findVisibleNodesByLabel(label);

                if (!nodes.length) {
                    console.warn(`未找到“${label}”`);
                    failList.push(label);
                    continue;
                }

                const node = nodes[index];
                if (!node) {
                    console.warn(`“${label}”匹配到 ${nodes.length} 个，索引 ${index} 不存在`);
                    failList.push(label);
                    continue;
                }

                const checkbox = node.querySelector('label.el-checkbox');
                if (!checkbox) {
                    console.warn(`“${label}”没有 checkbox`);
                    failList.push(label);
                    continue;
                }

                if (checkbox.classList.contains('is-checked')) {
                    console.log(`已选中，跳过：${label}`);
                    successList.push(label);
                    continue;
                }

                checkbox.click();
                console.log(`已勾选：${label}[${index}]`);
                successList.push(label);

                // 关键：给 DOM 重新渲染的时间，然后再点下一个
                await sleep(WAIT_BETWEEN);
            }

            await ensureClose();

            console.log('勾选完成，成功：', successList, '失败：', failList);
            return failList.length === 0;
        } catch (err) {
            console.error('selectBiaoji 执行异常：', err);
            await ensureClose();
            return false;
        }
    }

    function selectALLBiaoji()
    {
        selectBiaoji([
            '无',
            '集采订单',
            '指定快递',
            '乡村件',
            '承诺送达',
            '亚美尼亚集运',
            '柬埔寨集运',
            '灾害原因不发',
            '老挝集运',
            '顺丰包邮',
            '格鲁吉亚集运',
            '中国澳门集运',
            '中国青海集运',
            '中国宁夏集运',
            '中国甘肃集运',
            '无盖',
            '中国内蒙古集运',
            '乌兹别克斯坦集运',
            '吉尔吉斯斯坦集运',
            '管控驱不发',
            '大连剪刀暂时不发',
            '承诺发货',
            '暂不发货',
            '北京暂时不发',
            '优先发货',
            'wms取消失败',
            '拼多多暂停发货',
            '发货后关闭',
            'wms通知发货失败',
            '地址异常',
            '西藏中转',
            '泰国集运',
            '中国台湾集运',
            '越南集运',
            '日本集运',
            '新加坡集运',
            '韩国集运',
            '香港集运',
            '哈萨克斯坦集运',
            '马来西亚集运',
            '新疆中转',
            '加运费发顺丰'
        ]);
    }

    async function selectRemark(remarkTypes) {
        // remarkTypes 支持：
        //   1) '无内容'                       → 只选一个
        //   2) ['无内容', '有内容']            → 多个都选
        //   3) { '无内容': true, '有内容': true } → 对象写法
        //   4) 不传                            → 默认 ['无内容']
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        const WAIT_OPEN = 300;
        const WAIT_RENDER = 350;
        const WAIT_BETWEEN = 150;
        const WAIT_CLOSE = 200;

        // 统一成字符串数组
        function normalize(input) {
            if (!input) return ['无内容'];
            if (typeof input === 'string') return [input];
            if (Array.isArray(input)) return input.filter(Boolean);
            if (typeof input === 'object') {
                return Object.entries(input)
                    .filter(([, v]) => v)
                    .map(([k]) => k);
            }
            return ['无内容'];
        }

        const targets = normalize(remarkTypes);
        if (!targets.length) {
            console.warn('selectRemark: 没有要选择的项');
            return false;
        }

        const MENU_SELECTOR =
              "#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > ul > li:nth-child(6) > div.switch-input > div.combox-box > div.el-select > div.el-input.el-input--suffix > span > span";

        const menuOfBeizhu = document.querySelector(MENU_SELECTOR);
        if (!menuOfBeizhu) {
            alert('无法定位到全部备注下拉框');
            return false;
        }

        const isVisible = (el) =>
        !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;

        const dropdownOpen = () =>
        [...document.querySelectorAll('li.el-select-dropdown__item')].some(isVisible);

        async function ensureOpen() {
            if (!dropdownOpen()) {
                menuOfBeizhu.click();
                await sleep(WAIT_OPEN);
            }
        }

        async function ensureClose() {
            if (dropdownOpen()) {
                menuOfBeizhu.click();
                await sleep(WAIT_CLOSE);
            }
        }

        // 每次重新查询，避免节点被重渲染后失效
        function findItemByText(text) {
            return [...document.querySelectorAll('li.el-select-dropdown__item')]
                .filter(isVisible)
                .find(li => {
                const span = li.querySelector('span');
                return span && span.textContent.trim() === text;
            });
        }

        // 判断是否已选中（el-select 的选中项一般会加 is-selected）
        const isSelected = (li) =>
        li.classList.contains('is-selected') ||
              li.classList.contains('selected') ||
              li.getAttribute('aria-selected') === 'true';

        try {
            await ensureOpen();
            await sleep(WAIT_RENDER);

            const successList = [];
            const failList = [];

            for (const text of targets) {
                const item = findItemByText(text);

                if (!item) {
                    console.warn(`未找到选项：${text}`);
                    failList.push(text);
                    continue;
                }

                if (isSelected(item)) {
                    console.log(`已选中，跳过：${text}`);
                    successList.push(text);
                    continue;
                }

                item.click();
                console.log(`已选择：${text}`);
                successList.push(text);

                await sleep(WAIT_BETWEEN);
            }

            await ensureClose();

            console.log('选择完成，成功：', successList, '失败：', failList);
            return failList.length === 0;
        } catch (err) {
            console.error('selectRemark 执行异常：', err);
            await ensureClose();
            return false;
        }
    }

    function searchBy1000Lines()
    {
        //行数
        const menuOfLines = document.querySelector("#app > div > div:nth-child(1) > div.btns-bar > div > div.right-wrap > div.hp-pager > div.drop-page > div.el-select.select-page-size > div.el-input.el-input--suffix > span > span");
        if(menuOfLines)
        {
            menuOfLines.click();
            // 定位 1000行选项并点击
            const li = document.evaluate(
                "//li[contains(@class,'el-select-dropdown__item')][.//span[normalize-space(.)='1000']]",
                document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;

            li?.click();
        }
        else
        {
            alert('无法定位到行数下拉框');
        }

        const btnOfQuery = document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > div > button.el-button.el-button--primary.el-button--medium");
        if(btnOfQuery)
        {
            btnOfQuery.click();
        }
        else
        {
            alert('无法定位到查询下拉框');
        }
    }

    /* ============================================================
   * 一、业务函数区 —— 真正的功能实现放在这里
   * ------------------------------------------------------------
   *  · 函数可以同步返回，也可以返回 Promise（执行端会自动处理）
   *  · 返回值会作为 RESULT 消息的 data 回传给面板
   *  · 抛出的异常会被捕获，作为 error 回传给面板
   * ============================================================ */

    function order_review_search()
    {
        document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > div > button.el-button.el-button--primary.el-button--medium > span").click();
    }

    function order_review_01_by_shengfeng(shopNames,SF)
    {
        searchBy1000Lines();
        selectShop(shopNames);
        selectBiaoji(['无']);
        selectRemark('无内容');
        selectShengfeng(SF);
        order_review_search();
    }

    function order_review_01_empty(shopNames)
    {
        searchBy1000Lines();
        selectShop(shopNames);
        selectBiaoji(['无']);
        selectRemark('无内容');
        order_review_search();
    }
    function order_review_01_not_empty(shopNames)
    {
        searchBy1000Lines();
        selectShop(shopNames);
        selectALLBiaoji();
        selectRemark('无内容');
        order_review_search();
    }

    function function_order_review_01() {
        order_review_search();
        return { ok: true, action: '查询' };
    }

    function function_order_review_01_test_01() {
        console.log('[执行端] 订单审核 - 测试功能1');

        searchBy1000Lines();
        //const btnOfSelectALL = document.querySelector("#app > div > div.content.flex-box > div > div:nth-child(1) > div.table-trades.vxe-table.vxe-table--render-default.tid_1.size--mini.border--default.vxe-editable.row--highlight.is--header.is--footer.is--fixed-left.is--animat.is--stripe.is--empty.is--scroll-x.is--virtual-x.is--notfull.single-row-table.scrollbar-left > div.vxe-table--render-wrapper > div.vxe-table--fixed-wrapper > div > div.vxe-table--header-wrapper.fixed-left--wrapper > table > thead > tr > th.vxe-header--column.col_4.col--center.col--checkbox.col--last.col--fixed.col--ellipsis.check-column-header > div.vxe-cell.c--tooltip > span > span > span");

        //if(btnOfSelectALL)
        //{
        //   btnOfSelectALL.click();
        //}else{alert('无法定位到订单全选框');}
        selectShop(['永丰']);
        selectBiaoji(['无']);
        selectRemark('无内容');

        return { ok: true, action: '测试1' };
    }

    function function_order_review_01_test_02() {
        console.log('[执行端] 订单审核 - 测试功能2');

        selectShop(['永丰']);
        selectALLBiaoji();
        selectRemark('无内容');

        return { ok: true, action: '测试2' };
    }

    function function_order_review_01_test_03() {
        console.log('[执行端] 订单审核 - 测试功能3');

        //selectShop('永丰');
        //selectShop(['永丰','晋贤','张龙','曾招伟']);
        selectShop(['永丰','晋贤','张龙','曾招伟','范婕','袁颖慧']);

        return { ok: true, action: '测试2' };
    }

    function function_order_review_01_01() {
        console.log('[执行端] 订单审核 - 功能1 1');


        selectRemark('无内容');
        searchBy1000Lines();

        return { ok: true, action: '有标记' };
    }


    function function_order_review_01_empty_biaoji()
    {
        selectBiaoji(['无']);

        return { ok: true, action: '无标记' };
    }

    function function_order_review_01_not_empty_biaoji()
    {
        selectALLBiaoji();

        return { ok: true, action: '有标记' };
    }

    function function_order_review_01_empty_remark()
    {
        selectRemark('无内容');

        return { ok: true, action: '无备注内容' };
    }

    function function_order_review_01_system_remark()
    {
        selectBiaoji('不从系统发货');

        return { ok: true, action: '不从系统发货' };
    }

    function function_order_review_01_select_xj()
    {
        selectShengfeng('新疆维吾尔自治区');

        return { ok: true, action: '选择新疆' };
    }

    function function_order_review_01_select_hn()
    {
        selectShengfeng('海南省');

        return { ok: true, action: '选择海南' };
    }

    function function_order_review_01_select_pianyuan()
    {
        selectShengfeng('香港特别行政区');
        selectShengfeng('澳门特别行政区');
        selectShengfeng('海外');
        selectShengfeng('新疆维吾尔自治区');
        selectShengfeng('西藏自治区');
        selectShengfeng('内蒙古自治区');
        selectShengfeng('宁夏回族自治区');

        return { ok: true, action: '选择偏远' };
    }

    function function_order_review_01_select_shop_yf() {
        console.log('[执行端] 订单审核 - yf');

        //selectShop('永丰');
        //selectShop(['永丰','晋贤','张龙','曾招伟']);
        selectShop('永丰');

        return { ok: true, action: 'yf' };
    }

    function function_order_review_01_select_shop_jx_zl() {
        console.log('[执行端] 订单审核 - jx zl');

        selectShop(['晋贤','张龙']);

        return { ok: true, action: 'jx_zl' };
    }

    function function_order_review_01_select_shop_zzw() {
        console.log('[执行端] 订单审核 - zzw');

        selectShop('曾招伟');

        return { ok: true, action: 'zzw' };
    }

    function function_order_review_01_select_shop_fj_yyh() {
        console.log('[执行端] 订单审核 - fj_yyh');

        selectShop(['范婕','袁颖慧']);

        return { ok: true, action: 'fj_yyh' };
    }

    async function function_order_review_01_reset() {
        console.log('[执行端] 重置');

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        const isVisible = (el) => {
            if (!el || !el.isConnected) return false;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            if (el.offsetParent === null && st.position !== 'fixed') return false;
            return true;
        };

        /** 派发完整鼠标事件，兼容 Element UI 的 mousedown 监听 */
        const clickEl = (el) => {
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
        };

        // ── 1. 关闭"更多"面板（如果有打开） ──
        // 用 classList.contains 判断，兼容 class 里有多个值的情况
        const closeMore = async () => {
            for (const btn of document.querySelectorAll('.more-button')) {
                if (btn.classList.contains('opened')) {
                    console.log('[重置] 关闭已打开的更多面板');
                    clickEl(btn);
                    await sleep(200);
                    return true;
                }
            }
            return false;
        };
        if (await closeMore()) await sleep(150);

        // ── 2. 查找"重置"按钮 ──
        const findResetButton = () => {
            // 优先：header-bar 内的按钮
            const prefer = [
                '.query-condition.header-bar .top-box > div > button.el-button--default',
                '.query-condition.header-bar .top-box > div > button.el-button',
                '.header-bar .top-box button.el-button--default'
            ];
            for (const sel of prefer) {
                for (const b of document.querySelectorAll(sel)) {
                    if (!isVisible(b)) continue;
                    const t = (b.textContent || '').replace(/\s/g, '');
                    if (t === '重置') return b;
                }
            }
            // 兜底：全文档按钮遍历
            for (const b of document.querySelectorAll('button.el-button')) {
                if (!isVisible(b)) continue;
                const t = (b.textContent || '').replace(/\s/g, '');
                if (t === '重置') return b;
            }
            return null;
        };

        // 轮询等重置按钮可见（应对更多面板收起动画未完成）
        let resetBtn = null;
        for (let i = 0; i < 15; i++) {
            resetBtn = findResetButton();
            if (resetBtn) break;
            await sleep(100);
        }
        if (!resetBtn) throw new Error('找不到【重置】按钮');
        console.log('[重置] 找到重置按钮:', resetBtn);

        // ── 3. 点击重置（外层 + 内部 span 各点一次，兼容不同 Element UI 版本） ──
        clickEl(resetBtn);
        await sleep(80);
        const inner = resetBtn.querySelector('span');
        if (inner) clickEl(inner);
        await sleep(300);

        // ── 4. 兜底：如果 more 面板又被重新打开，再关一次 ──
        if (await closeMore()) await sleep(150);

        return { ok: true, action: '重置' };
    }

    function function_order_review_02(orderNo) {
        console.log('[执行端] 订单审核 - 功能2，订单号 =', orderNo);
        if (!orderNo) throw new Error('订单号为空');
        // 示例：填充输入框并提交
        // const input = document.querySelector('input[name="orderNo"]');
        // if (input) input.value = orderNo;
        return { ok: true, action: '功能2执行完毕', received: orderNo };
    }

    /* ---------- 订单审核 · 功能2（带订单号） ---------- */

    function function_order_review_02_query(orderNo) {
        console.log('[执行端] 订单查询，订单号 =', orderNo);
        if (!orderNo) throw new Error('订单号为空');
        return { ok: true, action: 'query', orderNo: orderNo };
    }

    function function_order_review_02_export(orderNo) {
        console.log('[执行端] 订单导出，订单号 =', orderNo);
        if (!orderNo) throw new Error('订单号为空');
        return { ok: true, action: 'export', orderNo: orderNo };
    }

    function function_group03_01() {
        console.log('[执行端] 分组三 - 功能1');
        return { ok: true, action: 'group3_01' };
    }

    function function_group03_02(value) {
        console.log('[执行端] 分组三 - 功能2，参数 =', value);
        return { ok: true,action: 'group3_02', received: value };
    }

    function function_group04_01() {
        console.log('[执行端] 分组四 - 功能1');
        return { ok: true,action: 'group4_01' };
    }

    function function_group04_02(value) {
        console.log('[执行端] 分组四 - 功能2，参数 =', value);
        return { ok: true, action: 'group4_02',received: value };
    }

    /* 函数注册表：面板传来的 fn 字符串从这里查找 */
    const FUNC_MAP = {
        function_order_review_01 : function_order_review_01,
        function_order_review_01_select_pianyuan:function_order_review_01_select_pianyuan,
        function_order_review_01_select_shop_yf:function_order_review_01_select_shop_yf,
        function_order_review_01_select_shop_jx_zl:function_order_review_01_select_shop_jx_zl,
        function_order_review_01_select_shop_zzw:function_order_review_01_select_shop_zzw,
        function_order_review_01_select_shop_fj_yyh:function_order_review_01_select_shop_fj_yyh,
        function_order_review_01_system_remark : function_order_review_01_system_remark,
        function_order_review_01_01 : function_order_review_01_01,
        function_order_review_01_not_empty_biaoji:function_order_review_01_not_empty_biaoji,
        function_order_review_01_test_01 : function_order_review_01_test_01,
        function_order_review_01_test_02 : function_order_review_01_test_02,
        function_order_review_01_empty_biaoji : function_order_review_01_empty_biaoji,
        function_order_review_01_empty_remark : function_order_review_01_empty_remark,
        function_order_review_01_select_xj : function_order_review_01_select_xj,
        function_order_review_01_select_hn : function_order_review_01_select_hn,
        function_order_review_01_reset : function_order_review_01_reset,
        function_order_review_02: function_order_review_02,
        function_group03_01:      function_group03_01,
        function_group03_02:      function_group03_02,
        function_group04_01:      function_group04_01,
        function_group04_02:      function_group04_02
    };

    /* ============================================================
   * 二、消息处理
   * ============================================================ */

    window.addEventListener('message', function (event) {
        // 只接受来自父窗口的消息
        if (event.source !== window.parent) return;

        const data = event.data;
        if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;

        if (data.type === 'ACK') {
            acked = true;
            return;
        }

        if (data.type === 'DISCOVER') {
            // 面板晚启动时会广播 DISCOVER，回复一次 READY 即可
            acked = false;
            sendReady();
            return;
        }

        if (data.type === 'CALL') {
            handleCall(data, event.source);
        }
    });

    function handleCall(data, source) {
        // 只处理发给自己的 CALL
        if (data.target && data.target !== 'order') return;

        const id = data.id;
        const fnName = data.fn;
        const args = Array.isArray(data.args) ? data.args : [];

        const fn = FUNC_MAP[fnName];
        if (typeof fn !== 'function') {
            reply(source, { id: id, ok: false, error: '执行端未找到函数：' + fnName });
            return;
        }

        Promise.resolve()
            .then(function () { return fn.apply(null, args); })
            .then(function (result) { reply(source, { id: id, ok: true, data: result }); })
            .catch(function (err) {
            reply(source, { id: id, ok: false, error: (err && err.message) || String(err) });
        });
    }

    function reply(source, payload) {
        if (!source) return;
        try {
            source.postMessage(Object.assign({
                __tm_channel: CHANNEL,
                type: 'RESULT',
                from: 'order'
            }, payload), '*');
        } catch (e) {}
    }

    /* ============================================================
   * 三、向父窗口注册（重试直到收到 ACK）
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
                    name: 'order',
                    url: location.href,
                    title: document.title,
                    ts: Date.now()
                }
            }, '*');
        } catch (e) { /* ignore */ }
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
