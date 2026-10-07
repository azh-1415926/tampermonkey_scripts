// ==UserScript==
// @name         网页工具箱 · 外部模块抓取器（无ui）
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  从本地 Qt 推送工具拉取子模块代码，热插拔到工具箱内核，无需刷新页面
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_COUPLER__) return;
  W.__WTB_COUPLER__ = true;

  /* ================= 配置 ================= */
  const CFG_KEY     = 'wtb:coupler:config:v1';
  const POLL_IDLE   = 2500;
  const POLL_ERR    = 8000;
  const REQ_TIMEOUT = 8000;
  const BUS_WAIT_MS = 15000;

  const cfg = { endpoint: 'http://127.0.0.1:7531', enabled: true };

  function loadCfg() {
    try {
      const raw = (typeof GM_getValue === 'function') ? GM_getValue(CFG_KEY, null) : null;
      if (!raw) return;
      const o = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      if (!o || typeof o !== 'object') return;
      if (typeof o.endpoint === 'string' && /^https?:\/\//i.test(o.endpoint)) {
        cfg.endpoint = o.endpoint.replace(/\/+$/, '');
      }
      if (typeof o.enabled === 'boolean') cfg.enabled = o.enabled;
    } catch (e) {}
  }
  function saveCfg() {
    try { if (typeof GM_setValue === 'function') GM_setValue(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  const LOG  = (...a) => { try { console.log('%c[WTB-Coupler]', 'color:#2b6cff', ...a); } catch (e) {} };
  const ERR  = (...a) => { try { console.error('[WTB-Coupler]', ...a); } catch (e) {} };
  const WARN = (...a) => { try { console.warn('[WTB-Coupler]', ...a); } catch (e) {} };

  /* ================= 运行时状态 =================
   * loaded: Map<jsonId, {
   *   hash, version, title,
   *   actualIds: string[]   // ★ 关键：内核里实际注册的 id 数组
   * }>
   */
  const loaded = new Map();
  let bus = null;
  let timer = null;
  let waitingBus = false;

  /* ================= 守卫清理 ================= */
  const CORE_GLOBAL_KEEP = new Set([
    '__WTB_BUS__', '__WTB_CORE__', '__WTB_COUPLER__',
    '__WTB_MSG__', '__WTB_UI__', '__WTB_RUNTIME__'
  ]);

  function clearModuleGlobals(code) {
    const candidates = new Set();

    const patterns = [
      /\b(?:window|unsafeWindow|W)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g,
      /if\s*\(\s*(?:window|unsafeWindow|W)\s*\.\s*([A-Za-z_$][\w$]*)\s*\)/g
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(code)) !== null) candidates.add(m[1]);
    }

    const targets = [];
    if (W) targets.push(W);
    try {
      if (typeof window !== 'undefined' && window && window !== W) targets.push(window);
    } catch (e) {}

    for (const t of targets) {
      try {
        for (const key of Object.getOwnPropertyNames(t)) {
          if (!key.startsWith('__WTB_')) continue;
          if (CORE_GLOBAL_KEEP.has(key)) continue;
          candidates.add(key);
        }
      } catch (e) {}
    }

    if (!candidates.size) return [];

    const cleared = [];
    for (const name of candidates) {
      if (CORE_GLOBAL_KEEP.has(name)) continue;
      let removed = false;
      for (const t of targets) {
        try {
          if (name in t) { delete t[name]; removed = true; }
        } catch (e1) {
          try { t[name] = undefined; removed = true; } catch (e2) {}
        }
      }
      if (removed) cleared.push(name);
    }
    return cleared;
  }

  /* ================= 等待内核 ================= */
  function whenBus(cb) {
    const deadline = Date.now() + BUS_WAIT_MS;
    (function tick() {
      const b = W.__WTB_BUS__;
      if (b && typeof b.registerModule === 'function' && typeof b.unregisterModule === 'function') {
        cb(b); return;
      }
      if (Date.now() > deadline) {
        ERR('等待超时：未检测到工具箱内核 __WTB_BUS__');
        waitingBus = false;
        return;
      }
      setTimeout(tick, 100);
    })();
  }

  /* ================= 内核状态查询 ================= */
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function shellToast(msg, isErr) {
    try {
      const sh = bus && bus.getShell && bus.getShell();
      if (sh && typeof sh.toast === 'function') sh.toast(msg, !!isErr);
    } catch (e) {}
  }

  // 拿到内核里所有已注册模块的 id
  function getRegisteredIds() {
    try {
      if (typeof bus.listModules === 'function') {
        return bus.listModules().map(m => m.id);
      }
      if (bus.modules && typeof bus.modules.keys === 'function') {
        return Array.from(bus.modules.keys());
      }
    } catch (e) {}
    return [];
  }

  function isModuleRegistered(id) {
    try {
      if (typeof bus.getModule === 'function') return !!bus.getModule(id);
      if (bus.modules && typeof bus.modules.has === 'function') return bus.modules.has(id);
    } catch (e) {}
    return false;
  }

  /* ================= 模块加载 ================= */
  function loadModule(m, hash) {
    const code = String(m.code || '');
    if (!code.trim()) {
      ERR('模块代码为空，跳过:', m.id);
      loaded.set(m.id, { hash, version: m.version || '', title: m.title || '', actualIds: [] });
      return false;
    }

    // ★ 记录执行前的内核状态快照
    const beforeIds = new Set(getRegisteredIds());

    const cleared = clearModuleGlobals(code);
    if (cleared.length) LOG('已清除旧守卫:', m.id, '→', cleared.join(', '));

    const meta = {
      id:      m.id,
      title:   m.title || m.id,
      version: m.version || '1.0.0',
      order:   (typeof m.order === 'number') ? m.order : 100,
      hash
    };

    let fn;
    try {
      fn = new Function('bus', 'unsafeWindow', 'document', 'module', code);
    } catch (e) {
      ERR('模块代码语法错误:', m.id, e);
      shellToast('模块语法错误：' + m.id, true);
      loaded.set(m.id, { hash, version: meta.version, title: meta.title, actualIds: [] });
      return false;
    }

    try {
      const doc = (W && W.document) ? W.document : document;
      const ret = fn.call(W, bus, W, doc, meta);
      if (ret && typeof ret === 'object' && ret.id) {
        bus.registerModule(ret);
      }
    } catch (e) {
      ERR('模块执行失败:', m.id, e);
      shellToast('模块执行失败：' + m.id, true);
      loaded.set(m.id, { hash, version: meta.version, title: meta.title, actualIds: [] });
      return false;
    }

    // ★ 记录执行后的内核状态，差集就是这次实际注册的 id
    const afterIds = getRegisteredIds();
    const actualIds = afterIds.filter(id => !beforeIds.has(id));

    // 若差集为空（可能代码只注册了一次且被 modules.has 拦截），
    // 或 id 与 JSON id 不同——统一由 actualIds 记录，后续卸载只信它。
    if (actualIds.length === 0) {
      // 兜底：如果 JSON id 本身已经在内核里，也记下来（可能代码里 id === jsonId）
      if (isModuleRegistered(m.id)) actualIds.push(m.id);
    }

    loaded.set(m.id, {
      hash,
      version: meta.version,
      title:   meta.title,
      actualIds
    });

    if (actualIds.length > 0) {
      const mismatch = !actualIds.includes(m.id);
      LOG('已加载模块:', m.id, 'v' + meta.version,
          '实际注册 ids: [' + actualIds.join(', ') + ']' + (mismatch ? ' ⚠与JSON id不一致' : ''));
      if (mismatch) {
        WARN('提示：模块 JSON id =', m.id, '，代码内 id =', actualIds.join(','),
             '。耦合层已按实际 id 跟踪，功能正常。');
      }
      return true;
    }

    WARN('模块执行完毕但未在内核中注册:', m.id, '（可能仍被内部守卫拦截）');
    shellToast('模块未能注册：' + m.id, true);
    return false;
  }

  /* ================= 模块卸载 ================= */
  function unloadModule(jsonId) {
    if (!jsonId) return;

    const entry = loaded.get(jsonId);
    // ★ 优先用 actualIds；若没有则退回到 jsonId 本身
    const idsToRemove = (entry && Array.isArray(entry.actualIds) && entry.actualIds.length > 0)
      ? entry.actualIds.slice()
      : [jsonId];

    for (const id of idsToRemove) {
      try {
        if (isModuleRegistered(id)) {
          bus.unregisterModule(id);
          LOG('已卸载模块:', id, '(jsonId=' + jsonId + ')');
        }
      } catch (e) {
        ERR('卸载失败:', id, e);
      }
    }

    loaded.delete(jsonId);
  }

  /* ================= 强制清空全部外部模块 ================= */
  function purgeAllModules() {
    const ids = getRegisteredIds();
    let n = 0;
    for (const id of ids) {
      try {
        bus.unregisterModule(id);
        n++;
      } catch (e) {}
    }
    loaded.clear();
    try { clearModuleGlobals(''); } catch (e) {}
    LOG('强制清空完成，卸载了', n, '个模块:', ids.join(', '));
    return n;
  }

  /* ================= 差量同步 ================= */
  function applyModules(list) {
    const incoming = new Map();

    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.id !== 'string' || !m.id) continue;
      if (m.enabled === false) continue;
      const hash = (typeof m.hash === 'string' && m.hash)
        ? m.hash
        : hashStr(String(m.code || ''));
      incoming.set(m.id, Object.assign({}, m, { __hash: hash }));
    }

    /* 1) 服务器不再提供的 —— 卸载 */
    for (const jsonId of Array.from(loaded.keys())) {
      if (!incoming.has(jsonId)) unloadModule(jsonId);
    }

    /* 2) 新增 / hash 变化的 —— 重载 */
    let changed = 0;
    for (const [jsonId, m] of incoming) {
      const prev = loaded.get(jsonId);

      // hash 相同，且实际 id 都还在内核里 → 跳过
      if (prev && prev.hash === m.__hash) {
        const actual = (Array.isArray(prev.actualIds) && prev.actualIds.length > 0)
          ? prev.actualIds
          : [jsonId];
        const allAlive = actual.every(id => isModuleRegistered(id));
        if (allAlive) continue;
        // 否则视为需要重载
        WARN('模块记录存在但内核中已丢失，将重载:', jsonId);
      }

      if (prev) unloadModule(jsonId);
      if (loadModule(m, m.__hash)) changed++;
    }

    if (changed > 0) {
      LOG('同步完成，热更新数：', changed, '当前跟踪：', loaded.size);
      shellToast('已热更新 ' + changed + ' 个模块');
    }
  }

  /* ================= 网络轮询 ================= */
  function scheduleNext(delay) {
    clearTimeout(timer);
    if (!cfg.enabled) return;
    timer = setTimeout(poll, delay);
  }

  function poll() {
    if (!cfg.enabled) return;
    if (!bus) {
      if (!waitingBus) { waitingBus = true; whenBus(b => { bus = b; poll(); }); }
      return;
    }
    if (typeof GM_xmlhttpRequest !== 'function') {
      ERR('缺少 GM_xmlhttpRequest 权限，请检查脚本头部 @grant');
      return;
    }

    const url = cfg.endpoint + '/wtb/sync?_=' + Date.now();

    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: REQ_TIMEOUT,
      headers: { 'Accept': 'application/json' },
      onload(res) {
        if (res.status !== 200) { ERR('HTTP', res.status); scheduleNext(POLL_ERR); return; }
        let data;
        try { data = JSON.parse(res.responseText); }
        catch (e) { ERR('响应不是合法 JSON'); scheduleNext(POLL_ERR); return; }

        if (!data || !Array.isArray(data.modules)) {
          ERR('响应缺少 modules 字段'); scheduleNext(POLL_ERR); return;
        }

        try { applyModules(data.modules); }
        catch (e) { ERR('应用模块失败', e); }

        scheduleNext(POLL_IDLE);
      },
      onerror()   { scheduleNext(POLL_ERR); },
      ontimeout() { scheduleNext(POLL_ERR); }
    });
  }

  function restart() {
    clearTimeout(timer);
    waitingBus = false;
    bus = null;
    if (cfg.enabled) poll();
  }

  /* ================= 菜单 ================= */
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    GM_registerMenuCommand('🔌 立即同步子模块', () => {
      if (!bus) { LOG('内核尚未就绪'); return; }
      clearTimeout(timer);
      poll();
    });

    GM_registerMenuCommand('🧹 清除耦合层跟踪的模块', () => {
      if (!bus) return;
      let n = 0;
      for (const jsonId of Array.from(loaded.keys())) { unloadModule(jsonId); n++; }
      shellToast('已清除 ' + n + ' 个模块');
    });

    GM_registerMenuCommand('💣 强制清空内核所有外部模块', () => {
      if (!bus) return;
      const n = purgeAllModules();
      shellToast('已强制卸载 ' + n + ' 个模块');
    });

    GM_registerMenuCommand('📊 打印内核状态', () => {
      if (!bus) { LOG('内核未就绪'); return; }
      const ids = getRegisteredIds();
      LOG('内核已注册模块 ids:', ids);
      LOG('耦合层跟踪记录:');
      for (const [jsonId, e] of loaded) {
        LOG('  ', jsonId, '→ 实际:', (e.actualIds || []).join(',') || '(空)',
            'hash:', e.hash);
      }
      alert('内核模块 (' + ids.length + '): ' + ids.join(', ') +
            '\n\n耦合层跟踪 (' + loaded.size + '): ' +
            Array.from(loaded.keys()).join(', '));
    });

    GM_registerMenuCommand('⚙️ 设置推送服务器地址', () => {
      const v = prompt('推送服务器地址：', cfg.endpoint);
      if (v == null) return;
      const t = String(v).trim();
      if (!/^https?:\/\//i.test(t)) { alert('需以 http:// 或 https:// 开头'); return; }
      cfg.endpoint = t.replace(/\/+$/, '');
      saveCfg();
      restart();
    });

    GM_registerMenuCommand('⏸ 暂停 / 恢复自动同步', () => {
      cfg.enabled = !cfg.enabled;
      saveCfg();
      if (cfg.enabled) restart();
      else { clearTimeout(timer); LOG('已暂停'); }
    });
  }

  /* ================= 启动 ================= */
  loadCfg();
  registerMenu();
  poll();

})();
