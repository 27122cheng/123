import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof recordSignalsFromScan === 'function', { timeout: 15000 });
const step = async (label, fn) => { const t0 = Date.now();
  try { const r = await Promise.race([p.evaluate(fn), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 20s')), 20000))]); console.log('ok  ', label.padEnd(26), String(Date.now() - t0).padStart(5), 'ms', JSON.stringify(r ?? null).slice(0, 80)); }
  catch (e) { console.log('FAIL', label.padEnd(26), e.message.slice(0, 160)); process.exitCode = 1; } };
await step('seed 120 coins + logs', () => {
  let s = 4242; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; const now = Date.now();
  const mk = (sym, score) => { const px = 1 + rnd() * 300; return { symbol: sym, price: String(px.toFixed(4)), score, rsi: 30 + rnd() * 40, adx: 15 + rnd() * 30, atr: px * 0.015, change24h: (rnd() - 0.5) * 10, volume: 1e8,
    volumeStrength: '高', macdHist: (rnd() - 0.5) * px * 0.01, momentum: 3, trend: score > 50 ? '看漲' : '看跌', ema20: String(px * 0.995), ema50: String(px * 0.98), ema200: String(px * 0.93),
    bb: { upper: px * 1.035, lower: px * 0.965, mid: px, width: 7, pctB: rnd() }, signal15m: score > 50 ? 'bull' : 'bear', h1Signal: score > 50 ? 'bull' : 'bear', h4Signal: score > 50 ? 'bull' : 'bear', dailySignal: 'bull', weeklySignal: 'bull',
    h4SwingHigh: px * 1.08, h4SwingLow: px * 0.962, dayStruct: { dir: 'up', hh: true, hl: true, lastHigh: px * 1.1, lastLow: px * 0.94, r2: 0.7, pivots: 6 }, h4Struct: { dir: 'up', hh: true, hl: true, lastHigh: px * 1.08, lastLow: px * 0.96, r2: 0.6, pivots: 5 },
    struct15: { dir: 'up', pivots: 5 }, nakedK: { tags: [], bullEngulf: false }, wickSupports: [px * 0.975], wickResistances: [px * 1.05], derivData: { fundingRate: 0.0001, takerBuySell: 1.05, topLongRatio: 0.5, openInterest: 5e7 } }; };
  state.data = [mk('BTC/USDT', 62), mk('ETH/USDT', 58)]; for (let i = 0; i < 118; i++) state.data.push(mk(`C${i}/USDT`, Math.round(20 + rnd() * 60)));
  isSignalMaster = () => true; _macroCache = { fg: { value: '60' }, btcDominance: 55, marketCapChange: 1 }; _macroCacheAt = now; computeKillZone = () => ({ quality: 'high', zone: 'london', label: '倫敦盤' });
  getUpcomingEconEvents = () => []; getTodayEconEvents = () => [];
  fetchKlinesSmart = async (s2, tf, limit) => Array.from({ length: limit }, (_, i) => { const t = now - (limit - i) * 3600e3; const px = 100 + Math.sin(i / 4) * 3; return [t, String(px), String(px + 1), String(px - 1), String(px + Math.cos(i / 3)), '1000', t + 3599e3, '1', 1, '1', '1', '0']; });
  for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
  const tl = []; for (let i = 0; i < 200; i++) { const st = i < 8 ? 'pending' : i < 14 ? 'open' : 'closed'; const r = rnd() > 0.5 ? 1.4 : -1;
    tl.push({ id: 't' + i, symbol: state.data[i % 120].symbol, direction: 'long', status: st, outcome: st === 'closed' ? (r > 0 ? 'tp1' : 'sl') : null, pnlR: st === 'closed' ? r : null, entry: 100, entryPrice: 99.5, sl: 98, tp1: 103, tp2: 106, conf: 70,
      timestamp: now - i * 7200e3, entryTime: st !== 'pending' ? now - i * 7200e3 + 600e3 : null, exitTime: st === 'closed' ? now - i * 7200e3 + 7200e3 : null, telegramSent: true, cancelNotifySent: true, entryTag: 'ema20', entryTags: ['ADX強趨勢', 'MACD動能'], regime: 'bull_hv', adx: 25, rsi: 55 }); }
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(tl)); _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.();
  const sl = []; for (let i = 0; i < 120; i++) { const st = i < 4 ? 'open' : 'closed'; const r = rnd() > 0.45 ? 1.2 : -1;
    sl.push({ id: 's' + i, symbol: state.data[i % 120].symbol, direction: 'long', status: st, pendingFill: i < 2, signalTime: now - 30000, entry: 100, sl: 99.3, baseSl: 99.3, tp1: 100.7, tp2: 101.26, mode: ['breakout', 'pullback', 'vwapRev', 'range'][i % 4], family: 'trend',
      pnlR: st === 'closed' ? r : null, outcome: st === 'closed' ? (r > 0 ? 'tp1' : 'sl') : null, timestamp: now - i * 1800e3, entryTime: now - i * 1800e3, exitTime: st === 'closed' ? now - i * 1800e3 + 900e3 : null, atrAtEntry: 0.5, maeAtr: 0.2, mfeAtr: 0.6, qty: 8, notional: 800, riskAmt: 6, feeR: 0.14, conf: 70 }); }
  localStorage.setItem(SCALP_LOG_KEY, JSON.stringify(sl)); _slogRaw = null; _slogArr = null;
  return { coins: state.data.length, tl: tl.length, sl: sl.length };
});
await step('recordSignalsFromScan', async () => { await recordSignalsFromScan(state.data); const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}'); return { built: f.built, cand: f.candidates, pend: loadTradeLog().filter(t => t.status === 'pending').length }; });
await step('updateOpenTrades', () => { updateOpenTrades(state.data); return loadTradeLog().filter(t => t.status === 'open').length; });
await step('updateScalpTrades+signals', async () => { updateScalpTrades(state.data); await recordScalpSignals(state.data); return Object.keys(_scalpReject).length; });
await step('scalpDrawdownAutopsy', () => { _scalpAutopsyCache = null; _scalpAutopsyKey = ''; const a = scalpDrawdownAutopsy(); return { ready: a.ready, n: a.n, wr: a.wr }; });
await step('buildTradeEnvCard', () => buildTradeEnvCard().length);
await step('buildDailyBriefingMsg', () => buildDailyBriefingMsg({ value: '60', value_classification: 'Greed' }, { marketCapChange: 1, btcDominance: 55 }).length);
await step('computeSimpleSetup stop', () => { const c = { ...state.data[0], price: '100', ema20: '99.2', adx: 32, atr: 1.6, signal15m: 'bull', h1Signal: 'bull' }; delete _tradeSetupCache[c.symbol]; const s2 = computeSimpleSetup(c, true); return { mode: s2.entryMode, entry: s2.entry, sl: s2.sl, tp1: s2.tp1 }; });
await step('dailyRGuard', () => { _dailyRCache = null; return dailyRGuard(); });
await step('scalpModeGate', () => scalpModeGate('vwapRev'));
await step('pairLabAnalyze', () => { const r = pairLabAnalyze(); return [r.rows.length, r.proven.length]; });
await step('ensureBriefMarketData', async () => { fetchMTFKlines = async () => ({ '1h': { raw: Array.from({ length: 60 }, (_, i) => [i, '100', '101', '99', '100.5', '10', i, '1', 1, '1', '1', '0']) }, '4h': { raw: Array.from({ length: 60 }, (_, i) => [i, '100', '101', '99', '100.5', '10', i, '1', 1, '1', '1', '0']) } }); await ensureBriefMarketData(); return Object.keys(_tradeSetupCache['BTC/USDT'] || {}).length; });
for (const pg of ['dashboard', 'ranking', 'positions', 'tradelog', 'report', 'lab', 'settings']) {
  const t0 = Date.now();
  try { const r = await Promise.race([p.evaluate((pg) => { state.currentPage = pg; try { navigateTo(pg); } catch(e) {} applyFilters(); renderAll(); if (pg === 'positions') renderPositionsPage(); if (pg === 'tradelog') renderTradeLogPage(); if (pg === 'lab') renderLabPage(); if (pg === 'settings') populateSettingsPage(); return document.body.innerHTML.length; }, pg), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 20s')), 20000))]);
    console.log('ok  ', ('render ' + pg).padEnd(26), String(Date.now() - t0).padStart(5), 'ms', r); }
  catch (e) { console.log('FAIL', ('render ' + pg).padEnd(26), e.message.slice(0, 160)); process.exitCode = 1; }
}
await step('populateSettings/save', () => { populateSettingsPage(); saveAllSettings(); return Object.keys(loadSettings()).length; });
console.log('page errors:', errs.length ? errs.slice(0, 5) : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
