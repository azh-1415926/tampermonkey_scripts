// ==UserScript==
// @name         网页工具箱 · 2048 游戏模块
// @namespace    https://github.com/yourname/web-toolbox
// @version      1.0.0
// @description  2048 小游戏。键盘 / 鼠标拖拽 / 触摸滑动操作，支持 AI 自动完成并可视化展示最优解。依赖内核 wtb-core，仅在顶层运行。
// @author       you
// @match        *://*/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__WTB_2048_MODULE__) return;

  function init() {
    const bus = W.__WTB_BUS__;
    if (!bus || W.__WTB_2048_MODULE__) return;
    W.__WTB_2048_MODULE__ = true;

    let IS_TOP = false;
    try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }
    if (!IS_TOP) return;

    const { h } = bus;

    /* ---------------- 常量 / 状态 ---------------- */
    const SIZE = 4;
    const STORE_KEY = 'wtb.2048.best';
    const SWIPE_MIN = 24;        // 键盘/触摸/鼠标统一的最小触发距离（px）
    const AI_DEPTH = 3;          // expectimax 搜索深度（越大越强，越慢）
    const AUTO_STEP_MS = 400;    // 自动模式下每步总间隔
    const HINT_LEAD_MS = 160;    // 方向提示先于落子展示的时长

    let grid = [];               // SIZE × SIZE，0 表示空格
    let score = 0;
    let best = 0;
    let over = false;
    let reached2048 = false;

    let autoPlaying = false;
    let autoTimer = null;

    let ctxRef = null;
    let boardEl = null;
    let hintEl = null;
    let tileEls = [];
    let scoreEl = null;
    let bestEl = null;
    let statusEl = null;
    let autoBtn = null;
    let mounted = false;
    let ro = null;

    /* ---------------- 与主界面通信 ---------------- */
    function toast(msg, err) {
      if (ctxRef && ctxRef.toast) ctxRef.toast(msg, err);
    }
    function setBadge(n) {
      if (ctxRef && ctxRef.setBadge) ctxRef.setBadge(n);
    }
    function emit(name, detail) {
      try {
        if (typeof bus.emit === 'function') { bus.emit(name, detail); return; }
        document.dispatchEvent(new CustomEvent('wtb:' + name, { detail: detail }));
      } catch (_) {}
    }

    /* ---------------- 最高分存档 ---------------- */
    function loadBest() {
      try {
        const v = parseInt(localStorage.getItem(STORE_KEY) || '0', 10);
        return Number.isFinite(v) && v > 0 ? v : 0;
      } catch (_) { return 0; }
    }
    function saveBest() {
      try { localStorage.setItem(STORE_KEY, String(best)); } catch (_) {}
    }

    /* ---------------- 棋盘基础工具 ---------------- */
    function emptyGrid() {
      const g = new Array(SIZE);
      for (let r = 0; r < SIZE; r++) g[r] = new Array(SIZE).fill(0);
      return g;
    }
    function cloneGrid(g) {
      const out = new Array(SIZE);
      for (let r = 0; r < SIZE; r++) out[r] = g[r].slice();
      return out;
    }
    function emptyCellsFrom(g) {
      const out = [];
      for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++)
          if (!g[r][c]) out.push([r, c]);
      return out;
    }

    /* ---------------- 纯函数版滑动（不修改原 grid） ---------------- */
    function slidePure(g, dir) {
      const next = emptyGrid();
      let moved = false;
      let gained = 0;
      const horizontal = (dir === 'left' || dir === 'right');
      const reverse = (dir === 'right' || dir === 'down');

      for (let i = 0; i < SIZE; i++) {
        const line = [];
        for (let j = 0; j < SIZE; j++) {
          line.push(horizontal ? g[i][j] : g[j][i]);
        }
        if (reverse) line.reverse();

        const nums = line.filter(v => v);
        const out = [];
        for (let k = 0; k < nums.length; k++) {
          if (nums[k] === nums[k + 1]) {
            const v = nums[k] * 2;
            out.push(v);
            gained += v;
            k++;
          } else {
            out.push(nums[k]);
          }
        }
        while (out.length < SIZE) out.push(0);
        let res = out;
        if (reverse) res = out.slice().reverse();

        for (let j = 0; j < SIZE; j++) {
          if (horizontal) {
            if (g[i][j] !== res[j]) moved = true;
            next[i][j] = res[j];
          } else {
            if (g[j][i] !== res[j]) moved = true;
            next[j][i] = res[j];
          }
        }
      }
      return { grid: next, gained: gained, moved: moved };
    }

    /* ---------------- AI：评估函数 ---------------- */
    // 单调性：分别取行 / 列中"更顺的一侧"作为得分
    function monotonicity(g) {
      const t = [0, 0, 0, 0];
      for (let x = 0; x < SIZE; x++) {
        let cur = 0, nxt = 1;
        while (nxt < SIZE) {
          while (nxt < SIZE && g[x][nxt] === 0) nxt++;
          if (nxt >= SIZE) break;
          const cv = g[x][cur] ? Math.log2(g[x][cur]) : 0;
          const nv = Math.log2(g[x][nxt]);
          if (cv > nv) t[0] += nv - cv;
          else if (nv > cv) t[1] += cv - nv;
          cur = nxt;
          nxt++;
        }
      }
      for (let x = 0; x < SIZE; x++) {
        let cur = 0, nxt = 1;
        while (nxt < SIZE) {
          while (nxt < SIZE && g[nxt][x] === 0) nxt++;
          if (nxt >= SIZE) break;
          const cv = g[cur][x] ? Math.log2(g[cur][x]) : 0;
          const nv = Math.log2(g[nxt][x]);
          if (cv > nv) t[2] += nv - cv;
          else if (nv > cv) t[3] += cv - nv;
          cur = nxt;
          nxt++;
        }
      }
      return Math.max(t[0], t[1]) + Math.max(t[2], t[3]);
    }

    function evaluateGrid(g) {
      let emptyCount = 0;
      let smoothness = 0;
      let maxVal = 0;

      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const v = g[r][c];
          if (!v) { emptyCount++; continue; }
          if (v > maxVal) maxVal = v;
          const lv = Math.log2(v);
          if (c + 1 < SIZE && g[r][c + 1]) {
            smoothness -= Math.abs(lv - Math.log2(g[r][c + 1]));
          }
          if (r + 1 < SIZE && g[r + 1][c]) {
            smoothness -= Math.abs(lv - Math.log2(g[r + 1][c]));
          }
        }
      }

      const mono = monotonicity(g);

      let cornerBonus = 0;
      if (maxVal > 0) {
        const corners = [g[0][0], g[0][SIZE - 1], g[SIZE - 1][0], g[SIZE - 1][SIZE - 1]];
        if (corners.indexOf(maxVal) !== -1) cornerBonus = Math.log2(maxVal);
      }

      // 权重参考经典 2048 AI
      return emptyCount * 2.7 + smoothness * 0.1 + mono * 1.0 + cornerBonus;
    }

    /* ---------------- AI：expectimax 搜索 ---------------- */
    // isPlayer=true 玩家选最大；isPlayer=false 电脑按概率求期望
    function expectimax(g, depth, isPlayer) {
      if (depth <= 0) return evaluateGrid(g);

      if (isPlayer) {
        let bestScore = -Infinity;
        let hasMove = false;
        const dirs = ['up', 'down', 'left', 'right'];
        for (let i = 0; i < 4; i++) {
          const r = slidePure(g, dirs[i]);
          if (!r.moved) continue;
          hasMove = true;
          const v = expectimax(r.grid, depth - 1, false);
          if (v > bestScore) bestScore = v;
        }
        if (!hasMove) return evaluateGrid(g) - 1000;
        return bestScore;
      }

      const cells = emptyCellsFrom(g);
      if (!cells.length) return evaluateGrid(g);
      let sum = 0;
      for (let i = 0; i < cells.length; i++) {
        const r = cells[i][0], c = cells[i][1];
        const g2 = cloneGrid(g);
        g2[r][c] = 2;
        sum += 0.9 * expectimax(g2, depth - 1, true);
        const g4 = cloneGrid(g);
        g4[r][c] = 4;
        sum += 0.1 * expectimax(g4, depth - 1, true);
      }
      return sum / cells.length;
    }

    // 在当前 grid 下寻找最佳方向；返回 { dir, score, scores }
    function findBestMove() {
      const dirs = ['up', 'down', 'left', 'right'];
      let bestDir = null;
      let bestScore = -Infinity;
      const allScores = {};
      for (let i = 0; i < 4; i++) {
        const dir = dirs[i];
        const r = slidePure(grid, dir);
        if (!r.moved) { allScores[dir] = null; continue; }
        const v = expectimax(r.grid, AI_DEPTH - 1, false);
        allScores[dir] = v;
        if (v > bestScore) {
          bestScore = v;
          bestDir = dir;
        }
      }
      if (bestDir === null) return null;
      return { dir: bestDir, score: bestScore, scores: allScores };
    }

    /* ---------------- 游戏逻辑 ---------------- */
    function emptyCells() { return emptyCellsFrom(grid); }

    function spawnTile() {
      const cells = emptyCells();
      if (!cells.length) return;
      const pair = cells[Math.floor(Math.random() * cells.length)];
      grid[pair[0]][pair[1]] = Math.random() < 0.9 ? 2 : 4;
    }
    function hasValue(v) {
      for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++)
          if (grid[r][c] === v) return true;
      return false;
    }
    function canMove() {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const v = grid[r][c];
          if (!v) return true;
          if (c + 1 < SIZE && grid[r][c + 1] === v) return true;
          if (r + 1 < SIZE && grid[r + 1][c] === v) return true;
        }
      }
      return false;
    }
    function slide(dir) {
      const r = slidePure(grid, dir);
      if (r.moved) {
        grid = r.grid;
        score += r.gained;
        if (score > best) { best = score; saveBest(); }
      }
      return r.moved;
    }

    /* ---------------- 渲染 ---------------- */
    function buildBoard() {
      boardEl.textContent = '';
      tileEls = [];
      const frag = document.createDocumentFragment();
      for (let i = 0; i < SIZE * SIZE; i++) {
        const t = h('div', { class: 'wtb-2048-tile' });
        tileEls.push(t);
        frag.appendChild(t);
      }
      boardEl.appendChild(frag);
    }

    function paint() {
      if (!boardEl) return;
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const v = grid[r][c];
          const el = tileEls[r * SIZE + c];
          if (!el) continue;
          if (v) {
            el.textContent = String(v);
            el.setAttribute('data-v', v > 2048 ? 'big' : String(v));
          } else {
            el.textContent = '';
            el.removeAttribute('data-v');
          }
        }
      }
      if (scoreEl) scoreEl.textContent = String(score);
      if (bestEl) bestEl.textContent = String(best);
      setBadge(score);
    }

    function setStatus(text, kind) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.className = 'wtb-status' + (kind ? ' wtb-2048-' + kind : '');
    }

    function fitFont() {
      if (!boardEl) return;
      const w = boardEl.clientWidth;
      if (!w) return;
      boardEl.style.fontSize = Math.max(11, Math.min(30, (w / SIZE) * 0.36)) + 'px';
    }

    // AI 方向可视化
    function showHint(dir) {
      if (!hintEl) return;
      const arrow = { up: '↑', down: '↓', left: '←', right: '→' }[dir] || '';
      hintEl.textContent = arrow;
      hintEl.classList.add('show');
    }
    function hideHint() {
      if (hintEl) hintEl.classList.remove('show');
    }

    /* ---------------- 游戏流程 ---------------- */
    function newGame() {
      grid = emptyGrid();
      score = 0;
      over = false;
      reached2048 = false;
      spawnTile();
      spawnTile();
      setStatus('');
      paint();
      emit('2048:new', { best: best });
    }

    function checkState() {
      if (!reached2048 && hasValue(2048)) {
        reached2048 = true;
        setStatus('🎉 达成 2048！还能继续', 'win');
        toast('🎉 达成 2048！');
        emit('2048:win', { score: score, best: best });
      }

      if (!canMove()) {
        over = true;
        setStatus('游戏结束 · 得分 ' + score, 'over');
        toast('游戏结束，得分 ' + score, true);
        emit('2048:over', { score: score, best: best });
      }

      emit('2048:score', { score: score, best: best });
    }

    function handleMove(dir) {
      if (over || !mounted) return;
      if (!slide(dir)) return;
      spawnTile();
      paint();
      checkState();
    }

    /* ---------------- 自动操作 ---------------- */
    function startAuto() {
      if (autoPlaying) return;
      if (over || !grid.length) newGame();
      autoPlaying = true;
      if (autoBtn) {
        autoBtn.textContent = '停止';
        autoBtn.classList.add('wtb-2048-active');
      }
      toast('AI 开始自动操作');
      autoStep();
    }

    function stopAuto() {
      autoPlaying = false;
      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
      if (autoBtn) {
        autoBtn.textContent = '自动操作';
        autoBtn.classList.remove('wtb-2048-active');
      }
      hideHint();
    }

    function autoStep() {
      if (!autoPlaying || !mounted) return;
      if (over) {
        stopAuto();
        toast('AI 完成，得分 ' + score);
        return;
      }

      let result = null;
      try {
        result = findBestMove();
      } catch (err) {
        stopAuto();
        toast('AI 计算出错：' + ((err && err.message) || err), true);
        return;
      }
      if (!result) { stopAuto(); return; }

      // 先显示推荐方向，再落子
      showHint(result.dir);
      emit('2048:ai-move', { dir: result.dir, score: result.score });

      autoTimer = setTimeout(() => {
        autoTimer = null;
        if (!autoPlaying || !mounted) return;
        handleMove(result.dir);
        if (!autoPlaying || over) return;
        autoTimer = setTimeout(autoStep, Math.max(60, AUTO_STEP_MS - HINT_LEAD_MS));
      }, HINT_LEAD_MS);
    }

    /* ---------------- 输入：键盘 ---------------- */
    function onKeyDown(e) {
      if (!mounted) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      const k = e.key;

      if (k === 'r' || k === 'R') {
        e.preventDefault();
        if (autoPlaying) stopAuto();
        newGame();
        toast('新的一局');
        return;
      }

      let dir = null;
      switch (k) {
        case 'ArrowLeft':  case 'a': case 'A': dir = 'left';  break;
        case 'ArrowRight': case 'd': case 'D': dir = 'right'; break;
        case 'ArrowUp':    case 'w': case 'W': dir = 'up';    break;
        case 'ArrowDown':  case 's': case 'S': dir = 'down';  break;
        default: return;
      }
      e.preventDefault();
      if (autoPlaying) stopAuto();
      handleMove(dir);
    }

    /* ---------------- 输入：统一方向判定 ---------------- */
    function commitDrag(sx, sy, ex, ey) {
      const dx = ex - sx;
      const dy = ey - sy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return false;
      if (autoPlaying) stopAuto();
      if (Math.abs(dx) > Math.abs(dy)) handleMove(dx > 0 ? 'right' : 'left');
      else handleMove(dy > 0 ? 'down' : 'up');
      return true;
    }

    /* ---------------- 输入：触摸 ---------------- */
    let touchStart = null;
    function onTouchStart(e) {
      if (e.touches.length !== 1) { touchStart = null; return; }
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    function onTouchEnd(e) {
      if (!touchStart) return;
      const t = e.changedTouches[0];
      if (!t) { touchStart = null; return; }
      const s = touchStart;
      touchStart = null;
      if (commitDrag(s.x, s.y, t.clientX, t.clientY)) e.preventDefault();
    }

    /* ---------------- 输入：鼠标拖拽 ---------------- */
    let mouseStart = null;
    function onMouseDown(e) {
      if (!mounted || e.button !== 0) return;
      mouseStart = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      if (boardEl) boardEl.classList.add('dragging');
    }
    function onMouseUp(e) {
      if (!mouseStart) return;
      const s = mouseStart;
      mouseStart = null;
      if (boardEl) boardEl.classList.remove('dragging');
      if (e.button !== 0) return;
      commitDrag(s.x, s.y, e.clientX, e.clientY);
    }
    function onMouseCancel() {
      mouseStart = null;
      if (boardEl) boardEl.classList.remove('dragging');
    }

    /* ---------------- 样式 ---------------- */
    const MODULE_CSS = `
      .wtb-2048-bar {
        display: flex; align-items: center; gap: 10px;
        padding-bottom: 10px; border-bottom: 1px solid #2c333e;
        margin-bottom: 10px;
      }
      .wtb-2048-stats { display: flex; gap: 14px; }
      .wtb-2048-stat {
        display: flex; align-items: baseline; gap: 4px;
        font-size: 10px; color: #7b8698; white-space: nowrap;
      }
      .wtb-2048-stat b {
        font-size: 14px; color: #ccd5e2; font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .wtb-2048-actions { margin-left: auto; display: flex; gap: 6px; }
      .wtb-2048-actions .wtb-btn.active,
      .wtb-btn.ghost.wtb-2048-active {
        background: #3d4756;
        color: #dbe3ee;
        border-color: #4a5666;
      }

      .wtb-2048-board-wrap { position: relative; width: 100%; }
      .wtb-2048-board {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        grid-template-rows: repeat(4, 1fr);
        gap: 6px; padding: 6px;
        width: 100%; aspect-ratio: 1 / 1;
        box-sizing: border-box;
        background: #1f242b;
        border: 1px solid #2f3641;
        border-radius: 12px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.03),
                    0 6px 18px rgba(0,0,0,.25);
        font-size: 20px;
        overflow: hidden;
        cursor: grab;
        touch-action: none;
        -webkit-user-select: none; user-select: none;
      }
      .wtb-2048-board.dragging { cursor: grabbing; }

      .wtb-2048-tile {
        display: flex; align-items: center; justify-content: center;
        border-radius: 7px;
        background: #262c34;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
        color: transparent;
        font-weight: 600; font-size: 1em; line-height: 1;
        overflow: hidden;
        transition: background-color .16s ease, color .16s ease;
      }
      .wtb-2048-tile[data-v="2"]    { background:#353d49; color:#c6d0dc; }
      .wtb-2048-tile[data-v="4"]    { background:#3f4a58; color:#d0dae6; }
      .wtb-2048-tile[data-v="8"]    { background:#40606e; color:#d6eaf2; }
      .wtb-2048-tile[data-v="16"]   { background:#466d68; color:#d8efea; }
      .wtb-2048-tile[data-v="32"]   { background:#4e7360; color:#dcf0e3; }
      .wtb-2048-tile[data-v="64"]   { background:#617f57; color:#e4f0dd; }
      .wtb-2048-tile[data-v="128"]  { background:#83845a; color:#f0efdb; }
      .wtb-2048-tile[data-v="256"]  { background:#927a5a; color:#f2e8d6; }
      .wtb-2048-tile[data-v="512"]  { background:#94695b; color:#f4e1d9; }
      .wtb-2048-tile[data-v="1024"] { background:#8a5f6c; color:#f5e0e6; font-size:.78em; }
      .wtb-2048-tile[data-v="2048"] {
        background:#b38f47; color:#fff8e8;
        box-shadow: inset 0 0 0 1px #d8b96a,
                    0 0 14px rgba(200,165,90,.28);
        font-size:.78em;
      }
      .wtb-2048-tile[data-v="big"]  { background:#7566a6; color:#ebe7fa; font-size:.62em; }

      /* AI 方向提示 */
      .wtb-2048-hint {
        position: absolute;
        inset: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 88px; font-weight: 900; line-height: 1;
        color: rgba(150, 185, 225, 0.32);
        text-shadow: 0 0 40px rgba(120, 170, 240, 0.45);
        pointer-events: none;
        opacity: 0;
        transition: opacity .14s ease;
        -webkit-user-select: none; user-select: none;
      }
      .wtb-2048-hint.show { opacity: 1; }

      .wtb-2048-win  { color: #7dd8a8; }
      .wtb-2048-over { color: #e58b8b; }
    `;

    /* ---------------- 注册模块 ---------------- */
    bus.registerModule({
      id: 'game2048',
      title: '2048',
      icon: '🎮',
      order: 30,
      mount(ctx) {
        ctxRef = ctx;
        ctx.addStyle(MODULE_CSS);
        mounted = true;

        const pane = ctx.pane;
        pane.innerHTML = '';

        best = loadBest();

        scoreEl = h('b', {}, '0');
        bestEl  = h('b', {}, '0');

        const stats = h('div', { class: 'wtb-2048-stats' }, [
          h('span', { class: 'wtb-2048-stat' }, ['得分', scoreEl]),
          h('span', { class: 'wtb-2048-stat' }, ['最高', bestEl])
        ]);

        autoBtn = h('button', {
          class: 'wtb-btn ghost',
          title: '让 AI 自动完成这局'
        }, '自动操作');
        const newBtn = h('button', {
          class: 'wtb-btn ghost',
          title: '快捷键 R'
        }, '新游戏');
        const actions = h('div', { class: 'wtb-2048-actions' }, [autoBtn, newBtn]);
        const bar = h('div', { class: 'wtb-2048-bar' }, [stats, actions]);

        boardEl = h('div', { class: 'wtb-2048-board' });
        hintEl  = h('div', { class: 'wtb-2048-hint' });
        const boardWrap = h('div', { class: 'wtb-2048-board-wrap' }, [boardEl, hintEl]);
        statusEl = h('div', { class: 'wtb-status' });

        pane.appendChild(bar);
        pane.appendChild(boardWrap);
        pane.appendChild(statusEl);

        buildBoard();

        // 面板重开时保留上一局；结束或未开局则重开
        if (!grid.length || over) newGame();
        else paint();

        newBtn.addEventListener('click', () => {
          if (autoPlaying) stopAuto();
          newGame();
          toast('新的一局');
        });
        autoBtn.addEventListener('click', () => {
          if (autoPlaying) stopAuto();
          else startAuto();
        });

        // 键盘
        document.addEventListener('keydown', onKeyDown, true);

        // 触摸
        boardEl.addEventListener('touchstart', onTouchStart, { passive: true });
        boardEl.addEventListener('touchend', onTouchEnd, { passive: false });

        // 鼠标
        boardEl.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mouseup', onMouseUp, true);
        window.addEventListener('blur', onMouseCancel);

        if (typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(fitFont);
          ro.observe(boardEl);
        }
        requestAnimationFrame(fitFont);
      },

      unmount(ctx) {
        stopAuto();
        mounted = false;
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('mouseup', onMouseUp, true);
        window.removeEventListener('blur', onMouseCancel);
        if (boardEl) {
          boardEl.removeEventListener('touchstart', onTouchStart);
          boardEl.removeEventListener('touchend', onTouchEnd);
          boardEl.removeEventListener('mousedown', onMouseDown);
        }
        mouseStart = null;
        touchStart = null;
        if (ro) { ro.disconnect(); ro = null; }
        boardEl = null;
        hintEl = null;
        tileEls = [];
        scoreEl = bestEl = statusEl = autoBtn = null;
        ctxRef = null;
      }
    });

    /* ---------------- 对外 API ---------------- */
    bus.game2048 = {
      newGame: newGame,
      move: handleMove,
      auto: {
        start: startAuto,
        stop: stopAuto,
        isPlaying: () => autoPlaying
      },
      // 只计算、不落子，供外部查看 AI 判断
      bestMove: () => {
        const r = findBestMove();
        return r ? { dir: r.dir, score: r.score, scores: r.scores } : null;
      },
      getState: () => ({
        grid: grid.map(row => row.slice()),
        score: score,
        best: best,
        over: over,
        reached2048: reached2048,
        autoPlaying: autoPlaying
      }),
      getBest: () => best,
      resetBest: () => { best = 0; saveBest(); paint(); }
    };
  }

  if (W.__WTB_BUS__) init();
  else W.addEventListener('wtb:bus-ready', init, { once: true });
})();
