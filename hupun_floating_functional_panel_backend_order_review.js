// ==UserScript==
// @name         万里牛悬浮功能面板-订单执行端
// @namespace    https://example.com/tm-panel
// @version      1.1.0
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
     * 面板 UI 配置（由本执行端声明，主面板负责渲染）
     * 按钮省略 target，主面板会自动使用 SELF_NAME
     * ============================================================ */
    const PANEL_CONFIG = [
        {
            title: '订单审核',
            open: false,
            items: [
                {
                    label: '审单',
                    buttons: [
                        { text: '查询',   fn: 'function_order_review_01' },
                        { text: '无标记', fn: 'function_order_review_01_empty_biaoji' },
                        { text: '无备注', fn: 'function_order_review_01_empty_remark' },
                        { text: '有标记', fn: 'function_order_review_01_not_empty_biaoji' },
                        { text: '重置',   fn: 'function_order_review_01_reset' }
                    ]
                },
                {
                    label: '店铺选择',
                    buttons: [
                        { text: '永丰',         fn: 'function_order_review_01_select_shop_yf' },
                        { text: '晋贤、张龙',   fn: 'function_order_review_01_select_shop_jx_zl' },
                        { text: '曾招伟',       fn: 'function_order_review_01_select_shop_zzw' },
                        { text: '范婕、袁颖慧', fn: 'function_order_review_01_select_shop_fj_yyh' }
                    ]
                },
                {
                    label: '地区选择',
                    buttons: [
                        { text: '海南', fn: 'function_order_review_01_select_hn' },
                        { text: '新疆', fn: 'function_order_review_01_select_xj' },
                        { text: '偏远', fn: 'function_order_review_01_select_pianyuan' }
                    ]
                }
            ]
        }
    ];

    /* ============================================================
     * 以下业务函数与原脚本一致，此处为节省篇幅略去（保持原文件内容不变）
     * selectShengfeng / selectShop / selectBiaoji / selectALLBiaoji
     * selectRemark / searchBy1000Lines / order_review_search / ...
     * ============================================================ */
    // ...（原脚本第 30 行 ~ FUNC_MAP 之前的所有内容保持不变）...

    /* ============================================================
     * 函数注册表（保持原样）
     * ============================================================ */
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
     * 消息处理
     * ============================================================ */
    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;

        const data = event.data;
        if (!data || typeof data !== 'object' || data.__tm_channel !== CHANNEL) return;

        if (data.type === 'ACK') { acked = true; return; }
        if (data.type === 'DISCOVER') { acked = false; sendReady(); return; }
        if (data.type === 'CALL') { handleCall(data, event.source); }
    });

    function handleCall(data, source) {
        if (data.target && data.target !== 'order' && data.target !== SELF_NAME) return;

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
                from: SELF_NAME
            }, payload), '*');
        } catch (e) {}
    }

    /* ============================================================
     * 向父窗口注册（重试直到收到 ACK）
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
                    ts: Date.now(),
                    /* ★ 关键：把 UI 配置交给主面板渲染 */
                    panelConfig: PANEL_CONFIG
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
