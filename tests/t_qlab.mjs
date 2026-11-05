import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* 逐模式量化實驗室（持續自動）＋ 回測自動排程與近三次判定 */
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof qlabModeDecide === 'function' && typeof btVerdict === 'function' && typeof renderLabPage === 'function', { timeout: 20000 });

const keep = await p.evaluate(() => ({ sl: localStorage.getItem('csp_scalp_log'), qm: localStorage.getItem('csp_qlab_mode'), bh: localStorage.getItem('csp_bt_hist'), st: localStorage.getItem('csp_settings') }));

// ① 逐模式：70 筆 trap 可重放樣本 → 計算（永遠自動）、建議或維持；套用受閘（設定關 → 不套用但建議留著）
const r1 = await p.evaluate(() => {
  const now = Date.now(); const log = [];
  for (let i = 0; i < 70; i++) {
    const win = i % 3 !== 0; const ts = now - i * 3600e3;
    log.push({ id: 'q' + i, symbol: 'X/USDT', direction: i % 2 ? 'long' : 'short', status: 'closed', timestamp: ts, entryTime: ts, exitTime: ts + 1800e3, entry: 100, sl: 99, tp1: 101.2, exitPrice: win ? 101.3 : 99.2, pnlR: win ? 1.1 : -1,
      mode: 'trap', family: 'revert', maeAtr: win ? 0.3 + (i % 5) * 0.1 : 1.6, mfeAtr: win ? 1.4 + (i % 4) * 0.5 : 0.2, levelGapAtr: 0.4, atrAtEntry: 1, slMult: 0.75 });
  }
  localStorage.setItem('csp_scalp_log', JSON.stringify(log)); localStorage.removeItem('csp_qlab_mode'); _qlabModeCache = null;
  saveSettings({ qlabAutoApply: false }); state.settings = loadSettings();
  const d = qlabModeDecide('trap');
  const st = loadQlabMode(); const m = st.modes.trap;
  const dry = qlabModeDecide('trap', { dryRun: true });
  return { action: d.action, why: d.why, canApply: d.canApply, n: m && m.n, ran: !!(m && m.lastRunAt), best: m && m.best, active: !!(m && m.active), dryAction: dry.action, effBefore: qlabEffectiveFor('trap').modeApplied };
});
if (!r1.ran || r1.n !== 70 || r1.canApply || r1.active || r1.effBefore || !['none', 'recommend'].includes(r1.action) || !r1.best) throw new Error('① 逐模式計算錯誤：' + JSON.stringify(r1));
console.log(`✓ ① trap 70 筆：已計算（最佳 止損 ${r1.best.slMult}／${r1.best.tp1R}／${r1.best.tp2R}，Δ${r1.best.delta}R）→ ${r1.action}；未套用：${r1.why.slice(0, 40)}…`);

// ② 排程：第一次 tick 跑最久沒跑的模式；6 小時內不重跑同一模式；全部跑過後回 null
const r2 = await p.evaluate(() => { const out = []; for (let i = 0; i < 9; i++) { const r = qlabModeTick(); out.push(r ? r.mode : null); } const st = loadQlabMode(); return { seq: out, ran: Object.keys(st.modes).filter(m => st.modes[m].lastRunAt).length }; });
const modesRun = r2.seq.filter(Boolean);
if (new Set(modesRun).size !== modesRun.length || modesRun.includes('trap') || modesRun.length !== 7 || r2.seq[8] !== null || r2.ran !== 8) throw new Error('② 排程錯誤：' + JSON.stringify(r2));
console.log(`✓ ② 排程：9 輪依序跑 ${modesRun.length} 個其他模式（trap 6 小時內不重跑）、跑完回 null；已跑 ${r2.ran}/8`);

// ③ 套用覆寫：模擬 trap 已套用 → qlabEffectiveFor 疊上模式值；取消 → 回全域
const r3 = await p.evaluate(() => { const st = loadQlabMode(); st.modes.trap = { ...(st.modes.trap || {}), active: true, slMult: 0.9, tp1R: 1.2, tp2R: 2.0, appliedAt: Date.now() }; saveQlabMode(st); const a = qlabEffectiveFor('trap'), g = qlabEffectiveFor('breakout'); qlabModeRevert('trap'); const c = qlabEffectiveFor('trap'); return { a: { on: a.modeApplied, sl: a.slMult, t1: a.tp1R, t2: a.tp2R, r1: a.revertTp1R }, g: g.modeApplied, c: c.modeApplied, hist: (loadQlabMode().modes.trap.history || []).slice(-1)[0] }; });
if (!r3.a.on || r3.a.sl !== 0.9 || r3.a.t1 !== 1.2 || r3.a.t2 !== 2 || r3.a.r1 !== 1.2 || r3.g || r3.c || !r3.hist || r3.hist.action !== 'manual-revert') throw new Error('③ 覆寫錯誤：' + JSON.stringify(r3));
console.log('✓ ③ 模式覆寫：trap 套用 0.9／1.2／2.0 只影響 trap（回歸家族止盈同值）；取消後回全域');

// ④ 回測判定：歷史三次 → 某策略 ≥2 次 ≤0 ＝不合用；另一策略皆 >0 ＝合用；一次不足＝累積中；自動排程在無幣種資料時不啟動
const r4 = await p.evaluate(() => {
  localStorage.removeItem('csp_bt_hist');
  const ids = SBX_STRATS.map(s => s.id); const bad = ids[0], good = ids[1];
  const mk = (at, e) => ({ at, totalTrades: 100, syms: ['A/USDT'], rows: ids.map(id => ({ id, stats: { n: 20, expectancy: id === bad ? e.bad : id === good ? e.good : 0.01, totalR: 1, maxDD: 2, rankScore: 0.1 } })) });
  btPushHistory(mk(Date.now() - 3 * 86400e3, { bad: -0.1, good: 0.2 }));
  const one = btVerdict(bad).v;
  btPushHistory(mk(Date.now() - 2 * 86400e3, { bad: 0.05, good: 0.1 }));
  btPushHistory(mk(Date.now() - 1 * 86400e3, { bad: -0.2, good: 0.3 }));
  const vb = btVerdict(bad), vg = btVerdict(good);
  const wasData = state.data; state.data = []; const tick = btAutoTick(); state.data = wasData;
  localStorage.setItem('csp_bt_last', JSON.stringify({ ...mk(Date.now() - 1 * 86400e3, { bad: -0.2, good: 0.3 }), rows: ids.map(id => ({ id, name: id, icon: '', stats: { n: 20, expectancy: 0.1, totalR: 1, maxDD: 2, rankScore: 0.1, winRate: 50 } })) })); _btState.results = null;
  const html = buildBtHtml(); localStorage.removeItem('csp_bt_last');
  return { one, vb: vb.v, vg: vg.v, vbText: vb.text, tick, hist: btHistory().length, html: html.includes('近三次判定') && html.includes('自動：每 12 小時一次') };
});
if (r4.one !== 'unknown' || r4.vb !== 'unfit' || r4.vg !== 'fit' || r4.tick !== 'no-data' && r4.tick !== 'not-master' || r4.hist !== 3 || !r4.html) throw new Error('④ 回測判定錯誤：' + JSON.stringify(r4));
console.log(`✓ ④ 回測判定：一次→累積中；三次→ ${r4.vbText}；另一策略合用；自動排程 ${r4.tick}；面板含判定欄`);

// ⑤ 實驗室頁可渲染且含逐模式面板
const r5 = await p.evaluate(() => { navigateTo('lab'); try { setLabTab('quant'); } catch (e) { return { err: e.message }; } const t = document.getElementById('page-lab').textContent; const okQ = t.includes('逐模式參數實驗') && t.includes(SCALP_MODE_LABEL.trap); try { setLabTab('bt'); } catch (e) { return { err: e.message }; } const okB = document.getElementById('page-lab').textContent.includes('自動：每 12 小時一次'); setLabTab('main'); return { ok: okQ && okB }; });
if (!r5.ok) throw new Error('⑤ 實驗室頁錯誤：' + JSON.stringify(r5));
console.log('✓ ⑤ 實驗室頁含「逐模式參數實驗」面板');

await p.evaluate(k => { for (const [key, v] of [['csp_scalp_log', k.sl], ['csp_qlab_mode', k.qm], ['csp_bt_hist', k.bh], ['csp_settings', k.st]]) { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } _qlabModeCache = null; }, keep);
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_qlab');
await b.close();
