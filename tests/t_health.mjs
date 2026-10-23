import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof _runRefreshTick === 'function' && typeof _healthDecide === 'function', { timeout: 15000 });

// ══ ① 刷新迴圈：某輪拋出未包住的例外 → scanning 仍歸零、下一輪照跑 ══
const tick = await p.evaluate(async () => {
  state.data = [{ symbol: 'BTC/USDT', price: '100', score: 60, trend: '看漲' }];
  fetchMarketData = async () => ({ data: state.data, source: 'binance' });
  const origRe = _rerenderPositionsAfter; _rerenderPositionsAfter = () => { throw new Error('boom'); };
  state.scanning = false; const n0 = _refreshTickN;
  await _runRefreshTick(60); const afterBoom = { scanning: state.scanning, done: _lastRefreshDone > 0, n: _refreshTickN - n0 };
  _rerenderPositionsAfter = origRe;
  await _runRefreshTick(60); const afterOk = { scanning: state.scanning, n: _refreshTickN - n0 };
  const hl = JSON.parse(localStorage.getItem('csp_health_log') || '[]');
  return { afterBoom, afterOk, note: hl.some(x => x.kind === 'tick-error' && x.text.includes('boom')) };
});
if (tick.afterBoom.scanning || !tick.afterBoom.done || tick.afterBoom.n !== 1 || tick.afterOk.scanning || tick.afterOk.n !== 2 || !tick.note) throw new Error('刷新迴圈例外後應歸零並記錄：' + JSON.stringify(tick));
console.log(`✓ 刷新迴圈：某輪拋例外 → scanning=${tick.afterBoom.scanning}、健康日誌有 tick-error；下一輪照跑（第 ${tick.afterOk.n} 輪）`);

// ══ ② 看門狗：scanning 卡住超過 5 分鐘 → 強制歸零、釋放建單鎖與插針旗標，然後本輪照跑 ══
const dog = await p.evaluate(async () => {
  state.scanning = true; _refreshStartedAt = Date.now() - 6 * 60e3; _createLocks.scanSignals = true; _wickCheckBusy = true;
  const n0 = _refreshTickN; await _runRefreshTick(60);
  const hl = JSON.parse(localStorage.getItem('csp_health_log') || '[]');
  const r = { ran: _refreshTickN - n0, scanning: state.scanning, lock: _createLocks.scanSignals, wick: _wickCheckBusy, note: hl.some(x => x.kind === 'scan-stuck') };
  state.scanning = true; _refreshStartedAt = Date.now() - 60e3; const n1 = _refreshTickN; await _runRefreshTick(60); r.skippedRecent = (_refreshTickN === n1); state.scanning = false;
  return r;
});
if (dog.ran !== 1 || dog.scanning || dog.lock || dog.wick || !dog.note || !dog.skippedRecent) throw new Error('看門狗行為錯誤：' + JSON.stringify(dog));
console.log(`✓ 看門狗：卡住 6 分鐘 → 強制歸零並照跑（鎖=${dog.lock}、插針旗標=${dog.wick}）；卡住 1 分鐘 → 只是跳過`);

// ══ ③ 自我修復決策：heap 超標／刷新停擺／運行過久；10 分鐘冷卻內不重複；非緊急等背景 ══
const dec = await p.evaluate(() => {
  const base = { heapMB: 200, uptimeMin: 120, sinceDoneMin: 1, scanning: false, scanningMin: 0, lsKB: 500, interval: 60, ticks: 100 };
  const d = h => _healthDecide({ ...base, ...h });
  const reloads = []; const origReload = _selfHealReload; _selfHealReload = (r) => reloads.push(r);
  localStorage.removeItem('csp_selfheal');
  // 停擺：頁面剛開不算停擺（uptime 門檻），所以把快照換成「已運行 2 小時、15 分鐘沒完成刷新」
  const origSnap = _healthSnapshot; _healthSnapshot = () => ({ ...base, sinceDoneMin: 15 }); state.scanning = false; _healthReloadArmed = false;
  const fresh = (() => { const r = []; const o = _selfHealReload; _selfHealReload = x => r.push(x); _healthSnapshot = () => ({ ...base, uptimeMin: 0.5, sinceDoneMin: 15 }); _healthTick(); _selfHealReload = o; _healthSnapshot = () => ({ ...base, sinceDoneMin: 15 }); return r.length; })();
  _healthTick(); const stallReload = reloads.length;
  // 冷卻：剛重整過 → 不再重整
  localStorage.setItem('csp_selfheal', JSON.stringify({ reason: 'x', at: Date.now() })); _healthReloadArmed = false; _healthTick(); const cooldownReload = reloads.length;
  localStorage.removeItem('csp_selfheal'); _healthSnapshot = origSnap; _selfHealReload = origReload;
  return { ok: d({}), heap: d({ heapMB: 950 }), stall: d({ sinceDoneMin: 12 }), soft: d({ uptimeMin: 21 * 60 }), hard: d({ uptimeMin: 31 * 60 }), stallReload, cooldownReload, fresh };
});
if (dec.ok !== null || !dec.heap?.urgent || !dec.stall?.urgent || dec.soft?.urgent !== false || !dec.hard?.urgent) throw new Error('決策錯誤：' + JSON.stringify(dec));
if (dec.fresh !== 0 || dec.stallReload !== 1 || dec.cooldownReload !== 1) throw new Error('剛開頁不算停擺；停擺應重整一次、冷卻內不重複：' + JSON.stringify(dec));
console.log(`✓ 自我修復：正常→不動；heap 950MB→緊急；停擺 12 分→緊急；21h→等背景；31h→緊急；停擺實跑觸發 1 次重整（剛開頁不算）、冷卻內不重複`);

// ══ ④ localStorage 裁剪：超量只裁非核心紀錄，交易紀錄不動 ══
const ls = await p.evaluate(() => {
  const tl = JSON.stringify([{ id: 'keep', status: 'closed' }]); localStorage.setItem(TRADE_LOG_KEY, tl);
  localStorage.setItem('csp_sbx_log', JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ id: i, pad: 'x'.repeat(200) }))));
  localStorage.setItem('csp_scan_profile', '[1]');
  const r = _lsQuotaGuard(true);
  return { trimmed: r.trimmed, sbx: JSON.parse(localStorage.getItem('csp_sbx_log')).length, tl: localStorage.getItem(TRADE_LOG_KEY) === tl, prof: localStorage.getItem('csp_scan_profile') };
});
if (ls.sbx !== 400 || !ls.tl || ls.prof !== null || !ls.trimmed.length) throw new Error('裁剪錯誤：' + JSON.stringify(ls));
console.log(`✓ 儲存裁剪：沙盒 900→${ls.sbx}、暫存移除、交易紀錄不動（${ls.trimmed.length} 項）`);

// ══ ⑤ K 線快取上限：超過 600 筆先清過期再砍一半 ══
const kc = await p.evaluate(() => {
  _klineCache.clear(); const rows = [[1, '1', '1', '1', '1', '1']];
  for (let i = 0; i < 700; i++) _klineCacheSet(`S${i}|1h|100`, rows);
  const after700 = _klineCache.size; _klineCacheSet('X|1h|100', rows); return { after700, max: Math.max(after700, _klineCache.size) };
});
if (kc.max > 700 || kc.after700 > 601) throw new Error('K 線快取未受控：' + JSON.stringify(kc));
console.log(`✓ K 線快取：700 筆寫入後維持 ${kc.after700} 筆（上限 600＋1）`);

// ══ ⑥ 無人值守：閒置停發預設關閉 → 7 小時沒操作主機仍在發；設 2 小時才停 ══
const idle = await p.evaluate(() => {
  const s0 = loadSettings(); delete s0.idleStopHours; s0.signalMaster = true; s0.cloudSync = false; saveSettings(s0);
  _lastInteractAt = Date.now() - 7 * 3600e3;
  const def = { hours: deviceIdleState().hours, idle: deviceIdleState().idle, master: isSignalMaster() };
  const s1 = loadSettings(); s1.idleStopHours = 2; saveSettings(s1);
  const two = { idle: deviceIdleState().idle, master: isSignalMaster() };
  const s2 = loadSettings(); s2.idleStopHours = 0; saveSettings(s2); _lastInteractAt = Date.now();
  return { def, two, keep: typeof _keepAlive, hasLock: !!(navigator.locks && navigator.locks.request) };
});
if (idle.def.hours !== 0 || idle.def.idle || !idle.def.master || !idle.two.idle || idle.two.master) throw new Error('閒置停發預設應關閉：' + JSON.stringify(idle));
console.log(`✓ 無人值守：預設閒置停發 ${idle.def.hours}h → 7 小時沒操作仍是主機；設 2h 才停發`);

// ══ ⑦ 讓步不走計時器（MessageChannel）；背景分頁停擺門檻放寬三倍 ══
const yl = await p.evaluate(async () => {
  const t0 = performance.now(); for (let i = 0; i < 50; i++) await _yieldMain(); const ms = performance.now() - t0;
  const base = { heapMB: 200, uptimeMin: 120, sinceDoneMin: 12, scanning: false, scanningMin: 0, lsKB: 500, interval: 60, ticks: 100 };
  return { ms: +ms.toFixed(1), fg: _healthDecide({ ...base, hidden: false }), bg: _healthDecide({ ...base, hidden: true }), bg35: _healthDecide({ ...base, hidden: true, sinceDoneMin: 35 }) };
});
if (yl.ms > 500 || !yl.fg || yl.bg !== null || !yl.bg35) throw new Error('讓步／背景停擺規則錯誤：' + JSON.stringify(yl));
console.log(`✓ 讓步 50 次 ${yl.ms}ms；前景停擺 12 分 → 重整，背景 12 分 → 不動、35 分 → 重整`);

// ══ ⑧ 成效診斷：舊規則／回踩／逆 BTC 日線拖累會被點名；面板可渲染 ══
const diag = await p.evaluate(() => {
  const now = Date.now(); const old = Date.UTC(2026, 9, 1), nw = Date.UTC(2026, 9, 10);
  const mk = (i, ts, mode, pnl, extra) => ({ id: 'd' + i, symbol: 'DG/USDT', direction: 'long', status: 'closed', entry: 100, sl: 98, tp1: 102, tp2: 108, timestamp: ts + i * 60e3, exitTime: ts + i * 60e3 + 3600e3, entryMode: mode, pnlR: pnl, outcome: pnl > 0 ? 'tp1' : 'sl', conf: 70, ...extra });
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(mk(i, old, 'limit', i % 3 === 0 ? 1 : -1, {}));                                   // 舊規則回踩：33%
  for (let i = 20; i < 45; i++) rows.push(mk(i, nw, 'stop', i % 4 === 0 ? -1 : 0.8, { btProb: 0.7, btcD1: 'bull' }));         // 新規則順向：75%
  for (let i = 45; i < 52; i++) rows.push(mk(i, nw, 'stop', i % 2 ? -1 : 0.5, { btProb: 0.5, btcD1: 'bear' }));              // 逆 BTC 日線
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(rows)); _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.();
  const d = perfDiagnose(); const html = _perfDiagPanel();
  localStorage.setItem(TRADE_LOG_KEY, '[]'); _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.();
  return { nMain: d.nMain, labels: d.main.map(r => r.label), findings: d.findings, html: html.includes('成效診斷') && html.includes('新規則') };
});
if (diag.nMain !== 52 || !diag.findings.some(f => f.includes('舊規則')) || !diag.findings.some(f => f.includes('回踩限價單')) || !diag.findings.some(f => f.includes('逆 BTC 日線')) || !diag.html) throw new Error('成效診斷未點名拖累項：' + JSON.stringify(diag));
console.log(`✓ 成效診斷：52 筆 → 分組 ${diag.labels.length} 列；發現 ${diag.findings.length} 項（舊規則／回踩／逆 BTC 日線）`);

// ══ ⑨ 候選階段麵包屑與最慢候選；背景分頁不畫畫面、切回前景補畫 ══
const cand = await p.evaluate(async () => {
  localStorage.removeItem('csp_slow_cands'); _scanProf = { t0: performance.now(), last: performance.now(), phases: {}, counts: {} };
  _candSym = 'ZZ/USDT'; _candT0 = performance.now() - 1500; _profMark('SQ評分');
  const crumb = JSON.parse(localStorage.getItem('csp_last_step') || '{}').n;
  _candDone(_candSym, performance.now() - _candT0); _candSym = '';
  const slow = JSON.parse(localStorage.getItem('csp_slow_cands') || '[]');
  // 背景：renderAll 不該被呼叫；切回前景補畫一次
  let renders = 0; const orig = renderAll; renderAll = () => { renders++; }; const origAF = applyFilters; applyFilters = () => {};
  state.data = [{ symbol: 'BTC/USDT', price: '100', score: 60, trend: '看漲' }]; fetchMarketData = async () => ({ data: state.data, source: 'binance' }); state.scanning = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  await _runRefreshTick(60); const hiddenRenders = renders;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange')); const afterVisible = renders;
  renderAll = orig; applyFilters = origAF; localStorage.removeItem('csp_slow_cands');
  return { crumb, slow: slow[0], hiddenRenders, afterVisible };
});
if (cand.crumb !== '掃描候選 ZZ/USDT/SQ評分' || !cand.slow || cand.slow.sym !== 'ZZ/USDT' || cand.slow.sub !== 'SQ評分' || cand.slow.ms < 1400) throw new Error('候選階段麵包屑／最慢候選錯誤：' + JSON.stringify(cand));
if (cand.hiddenRenders !== 0 || cand.afterVisible !== 1) throw new Error('背景不畫、前景補畫錯誤：' + JSON.stringify(cand));
console.log(`✓ 候選麵包屑「${cand.crumb}」；最慢候選 ${cand.slow.sym} ${cand.slow.ms}ms@${cand.slow.sub}；背景刷新 renderAll ${cand.hiddenRenders} 次、切回前景補畫 ${cand.afterVisible} 次`);

// ══ ⑩ 心跳判定：心跳比步驟晚 ≥1 分鐘 → 外部關閉；同時停 → 卡死；心跳有在寫 ══
const hb = await p.evaluate(async () => {
  const t = Date.now();
  const a = _freezeVerdict({ n: 'x', t: t - 10 * 60e3 }, { t: t - 2 * 60e3 }), b2 = _freezeVerdict({ n: 'x', t: t - 10 * 60e3 }, { t: t - 10 * 60e3 + 3000 });
  await new Promise(r => setTimeout(r, 5500));   // 心跳每 5 秒寫一次
  const w = JSON.parse(localStorage.getItem('csp_hb') || 'null');
  const step = JSON.parse(localStorage.getItem('csp_last_step') || '{}');
  return { a, b2, hbFresh: !!(w && Date.now() - w.t < 10000), hbRaw: w, keys: Object.keys(localStorage).length, hasHid: typeof step.hid === 'boolean' || step.n === undefined };
});
if (!hb.a.includes('外部關閉') || !hb.b2.includes('卡住') || !hb.hbFresh) throw new Error('心跳判定錯誤：' + JSON.stringify(hb));
console.log(`✓ 心跳判定：晚 8 分鐘 → 「${hb.a.slice(0, 22)}…」；同時停 → 「${hb.b2.slice(0, 20)}…」；心跳正在寫`);

// ══ ⑪ 診斷包：含最後步驟／心跳／最慢候選／設定，可序列化；凍結線索判定排最前 ══
const dg = await p.evaluate(() => { const t = _diagBundle(); const j = JSON.parse(t.replace(/^```json\n|\n```$/g, '')); return { ok: !!(j.v && j.heartbeat && 'lastStep' in j && 'slowCands' in j && j.settings), len: t.length }; });
if (!dg.ok) throw new Error('診斷包缺欄位：' + JSON.stringify(dg));
console.log(`✓ 診斷包：${dg.len} 字元，含版本／最後步驟／心跳／最慢候選／設定`);

// ══ ⑫ await 期限：掛住的 fetchMarketData 90 秒內（測試縮成 300ms）結束本輪、scanning 歸零；補充抓取逾時不卡住；停擺兩倍門檻即使掃描中也重整；低效能模式切換 ══
const tmo = await p.evaluate(async () => {
  const origWT = _withTimeout; _withTimeout = (pr, ms, fb) => origWT(pr, Math.min(ms, 300), fb);
  fetchMarketData = () => new Promise(() => {});   // 永遠不回來
  state.scanning = false; const n0 = _refreshTickN; const t0 = performance.now();
  await _runRefreshTick(60);
  const r = { ms: Math.round(performance.now() - t0), scanning: state.scanning, ran: _refreshTickN - n0, note: (JSON.parse(localStorage.getItem('csp_health_log') || '[]')).some(x => x.kind === 'fetch-timeout') };
  _withTimeout = origWT;
  // 停擺兩倍門檻：掃描中也要重整
  const reloads = []; const o = _selfHealReload; _selfHealReload = x => reloads.push(x); const oS = _healthSnapshot;
  localStorage.removeItem('csp_selfheal'); state.scanning = true; _healthReloadArmed = false;
  _healthSnapshot = () => ({ heapMB: 200, uptimeMin: 120, sinceDoneMin: 12, scanning: true, scanningMin: 12, lsKB: 500, interval: 60, ticks: 100, hidden: false }); _healthTick(); r.softWhileScanning = reloads.length;
  _healthSnapshot = () => ({ heapMB: 200, uptimeMin: 120, sinceDoneMin: 25, scanning: true, scanningMin: 25, lsKB: 500, interval: 60, ticks: 100, hidden: false }); _healthReloadArmed = false; _healthTick(); r.hardWhileScanning = reloads.length;
  _selfHealReload = o; _healthSnapshot = oS; state.scanning = false; localStorage.removeItem('csp_selfheal');
  // 低效能模式
  const st = loadSettings(); st.liteMode = true; saveSettings(st); applyLiteMode(); r.liteOn = document.body.classList.contains('lite');
  st.liteMode = false; saveSettings(st); applyLiteMode(); r.liteOff = !document.body.classList.contains('lite'); delete st.liteMode; saveSettings(st);
  return r;
});
if (tmo.ms > 5000 || tmo.scanning || tmo.ran !== 1 || !tmo.note || tmo.softWhileScanning !== 0 || tmo.hardWhileScanning !== 1 || !tmo.liteOn || !tmo.liteOff) throw new Error('await 期限／硬重整／低效能模式錯誤：' + JSON.stringify(tmo));
console.log(`✓ await 期限：掛住的行情請求 ${tmo.ms}ms 內結束本輪、scanning=${tmo.scanning}、健康日誌有 fetch-timeout；停擺 12 分掃描中不重整、25 分硬重整；低效能模式開關正常`);

// ══ ⑬ relayFetch：直連失敗 → 改打 /api/relay；連續 3 次失敗後代理優先；非白名單主機直接直連 ══
const rl = await p.evaluate(async () => {
  const log = []; const orig = window.fetch;
  window.fetch = async (u, o) => { const s = String(u); log.push(s.slice(0, 40)); if (s.startsWith('/api/relay')) return new Response('{"relayed":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); if (/binance\.com/.test(s)) throw new TypeError('Failed to fetch'); return new Response('{"direct":true}', { status: 200 }); };
  const r1 = await (await relayFetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT')).json();
  await relayFetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=ETHUSDT'); await relayFetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=SOLUSDT');
  const before = log.length; await relayFetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=XRPUSDT'); const proxyFirst = log.slice(before);
  const r2 = await (await relayFetch('https://www.okx.com/api/v5/market/tickers')).json();
  window.fetch = orig;
  return { r1, proxyFirst, r2, st: relayStatus() };
});
if (!rl.r1.relayed || rl.proxyFirst.length !== 1 || !rl.proxyFirst[0].startsWith('/api/relay') || !rl.r2.direct || !(rl.st.uses >= 4) || !rl.st.hosts.includes('fapi.binance.com')) throw new Error('relayFetch 行為錯誤：' + JSON.stringify(rl));
console.log(`✓ relayFetch：直連失敗 → 轉發（${JSON.stringify(rl.r1)}）；3 次後代理優先（第 4 次只打 ${rl.proxyFirst[0]}）；非白名單主機維持直連；狀態 ${JSON.stringify(rl.st.hosts)}`);

await p.evaluate(() => { localStorage.removeItem('csp_selfheal'); localStorage.removeItem('csp_health_log'); });
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_health');
await b.close();
