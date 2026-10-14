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

await p.evaluate(() => { localStorage.removeItem('csp_selfheal'); localStorage.removeItem('csp_health_log'); });
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_health');
await b.close();
