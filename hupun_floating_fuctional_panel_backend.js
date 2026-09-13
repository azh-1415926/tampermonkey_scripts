// ==UserScript==
// @name         万里牛悬浮功能面板 - 执行端
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

    /* ============================================================
   * 一、业务函数区 —— 真正的功能实现放在这里
   * ------------------------------------------------------------
   *  · 函数可以同步返回，也可以返回 Promise（执行端会自动处理）
   *  · 返回值会作为 RESULT 消息的 data 回传给面板
   *  · 抛出的异常会被捕获，作为 error 回传给面板
   * ============================================================ */

    function function_order_review_01() {
        console.log('[执行端] 订单审核 - 功能1');
        // 示例：在 iframe 内操作 DOM
        //document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > ul > li:nth-child(1) > div.el-select.hp-cascader-select-lazy.el-select--mini > div.el-input.el-input--mini.el-input--prefix.el-input--suffix > span.el-input__prefix > div").click();

        //const inputOfWarehouse = document.querySelector('body > div.el-select-dropdown.el-popper.hp-cascader-select-dropdown > div.el-scrollbar > div.el-select-dropdown__wrap.el-scrollbar__wrap > ul > div > div.header > div.input-filter.el-input.el-input--suffix > input');
        //const xpath = '//div[contains(@class,"hp-cascader-select-dropdown")]' +
        //      '//div[contains(@class,"input-filter")]//input';
        //const inputOfWarehouse = document.evaluate(
        //    xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        //).singleNodeValue;
        //console.log(inputOfWarehouse);

        // more
        const btnOfMoreOption = document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > div > div.more-button");
        if(btnOfMoreOption.className==='more-button')
        {
            btnOfMoreOption.click();
        }

        // 1000 行
        document.querySelector("#app > div > div:nth-child(1) > div.btns-bar > div > div.right-wrap > div.hp-pager > div.drop-page > div.el-select.select-page-size > div.el-input.el-input--suffix > span > span").click();
        //document.querySelector("body > div.el-select-dropdown.el-popper > div.el-scrollbar > div.el-select-dropdown__wrap.el-scrollbar__wrap > ul > li.el-select-dropdown__item.hover");

        // 全部备注 无内容
        //document.querySelector("body > div:nth-child(22) > div.el-scrollbar > div.el-select-dropdown__wrap.el-scrollbar__wrap > ul > li.el-select-dropdown__item.hover > span").click();

        //document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.query-box.more.show-more > ul > li:nth-child(10) > div.switch-input > div.region-select > div.region-select-input.el-input.el-input--mini.el-input--suffix > input").value='新疆维吾尔自治区';

        document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.query-box.more.show-more > ul > li:nth-child(10) > div.switch-input > div.region-select > div.el-select.el-select--mini > div > span > span").click();
        document.querySelector("#pane-省 > div.regions--vertical > div:nth-child(33) > label > span > span").checked=true;

        document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.query-box.more.show-more > ul > li:nth-child(10) > div.switch-input > div.region-select > div.el-select.el-select--mini > div > span > span").click();
        document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > div > button.el-button.el-button--primary.el-button--medium").click();

        return { ok: true, msg: '功能1执行完毕' };
    }

    function function_order_review_01_reset() {
        const btnOfMoreOption = document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > div > div.more-button.opened");
        if(btnOfMoreOption.className==='more-button opened')
        {
            btnOfMoreOption.click();
        }

        document.querySelector("#app > div > div:nth-child(1) > div.query-condition.header.box.header-bar > div.top-box > div > button.el-button.el-button--default.el-button--medium.is-plain > span").click();
    }

    function function_order_review_02(orderNo) {
        console.log('[执行端] 订单审核 - 功能2，订单号 =', orderNo);
        if (!orderNo) throw new Error('订单号为空');
        // 示例：填充输入框并提交
        // const input = document.querySelector('input[name="orderNo"]');
        // if (input) input.value = orderNo;
        return { ok: true, msg: '功能2执行完毕', received: orderNo };
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

    /* ---------- 分组二 · 功能1 的两个动作 ---------- */

    function function_group02_01_a() {
        console.log('[执行端] 分组二 - 操作A');
        return { ok: true, action: 'A' };
    }

    function function_group02_01_b() {
        console.log('[执行端] 分组二 - 操作B');
        return { ok: true, action: 'B' };
    }

    function function_group03_01() {
        console.log('[执行端] 分组三 - 功能1');
        return { ok: true };
    }

    function function_group03_02(value) {
        console.log('[执行端] 分组三 - 功能2，参数 =', value);
        return { ok: true, received: value };
    }

    function function_group04_01() {
        console.log('[执行端] 分组四 - 功能1');
        return { ok: true };
    }

    function function_group04_02(value) {
        console.log('[执行端] 分组四 - 功能2，参数 =', value);
        return { ok: true, received: value };
    }

    /* 函数注册表：面板传来的 fn 字符串从这里查找 */
    const FUNC_MAP = {
        function_order_review_01: function_order_review_01,
        function_order_review_01_reset : function_order_review_01_reset,
        function_order_review_02: function_order_review_02,
        function_group02_01_a:      function_group02_01_a,
        function_group02_01_b:      function_group02_01_b,
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
        const id = data.id;
        const fnName = data.fn;
        const args = Array.isArray(data.args) ? data.args : [];

        const fn = FUNC_MAP[fnName];
        if (typeof fn !== 'function') {
            reply(source, { id: id, ok: false, error: '执行端未找到函数：' + fnName });
            return;
        }

        // 支持同步 / 异步（Promise）函数
        Promise.resolve()
            .then(function () { return fn.apply(null, args); })
            .then(function (result) {
            reply(source, { id: id, ok: true, data: result });
        })
            .catch(function (err) {
            reply(source, {
                id: id,
                ok: false,
                error: (err && err.message) || String(err)
            });
        });
    }

    function reply(source, payload) {
        if (!source) return;
        try {
            source.postMessage(Object.assign({
                __tm_channel: CHANNEL,
                type: 'RESULT'
            }, payload), '*');
        } catch (e) { /* ignore */ }
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