import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof recordSignalsFromScan === 'function' && typeof computeSimpleSetup === 'function', { timeout: 15000 });

// 2026-10-02 回測驗證閘門：逆 BTC 日線硬擋、4H ADX<20 硬擋、多空人數比反向 ×0.7；突破單出場 1R/2.5R、減倉 50%、鎖 +0.3R
const MK = `(s, score) => ({
  symbol: s, price: '100', score, rsi: 60, adx: 28, atr: 1.6, change24h: 2.5, volume: 3e8, volumeStrength: '高', macdHist: 0.35, momentum: 6, trend: '看漲',
  ema20: '99.2', ema50: '98', ema200: '93', bb: { upper: 103.5, lower: 96.5, mid: 100, width: 7 },
  signal15m: 'bull', h1Signal: 'bull', h4Signal: 'bull', dailySignal: 'bull', weeklySignal: 'bull', h4SwingHigh: 108, h4SwingLow: 96.2, h4Rsi: 58, h1Rsi: 57,
  dayStruct: { dir: 'up', hh: true, hl: true, lastHigh: 110, lastLow: 94, r2: 0.7, pivots: 6 }, h4Struct: { dir: 'up', hh: true, hl: true, lastHigh: 108, lastLow: 96, r2: 0.6, pivots: 5 },
  struct15: { dir: 'up', pivots: 5 }, nakedK: { tags: ['多頭吞噬'], bullEngulf: true }, wickSupports: [97.5, 96.8], wickResistances: [105.2, 107.5],
  derivData: { fundingRate: -0.0003, takerBuySell: 1.12, topLongRatio: 0.58, openInterest: 5e7 } })`;
const gate = await p.evaluate(async (mk) => {
  const mkCoin = (0, eval)('(' + mk + ')');
  const run = async ({ btcD1 = 'bull', h4Adx = null, ls = null } = {}) => {
    const now = Date.now();
    isSignalMaster = () => true; computeKillZone = () => ({ quality: 'high', zone: 'x', label: 'x' });
    getAdaptiveGates = () => ({ minConf: 65, minSq: 12, minRR: minRequiredRR(), relaxed: false, label: '' });
    getUpcomingEconEvents = () => []; getTodayEconEvents = () => []; _evBlkCache = null; _evBlkCacheTs = 0; condBlockCheck = () => null;
    _macroCache = { fg: { value: '58' }, btcDominance: 50, marketCapChange: 1.5 }; _macroCacheAt = now;
    localStorage.setItem(TRADE_LOG_KEY, '[]'); localStorage.removeItem('csp_scan_funnel'); localStorage.removeItem(SIGNAL_LEDGER_KEY); localStorage.removeItem(CANCEL_COOLDOWN_KEY);
    _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.(); _sigEvCache = {}; _sigEvCacheTs = 0; _condCache = null; _condCacheTs = 0;
    const btc = mkCoin('BTC/USDT', 62); btc.dailySignal = btcD1; _btcD1Dir = btcD1;
    const al = mkCoin('AL/USDT', 74); al.change24h = 4.5; if (h4Adx != null) al.h4Adx = h4Adx; if (ls != null) al.derivData.lsRatio = ls;
    state.data = [btc, al];
    for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
    updateMarketContext(state.data); _rsRank = { 'AL/USDT': 70 }; _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
    await recordSignalsFromScan(state.data);
    const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}'); const t = loadTradeLog().find(x => x.symbol === 'AL/USDT' && x.status === 'pending');
    return { built: !!t, softMult: t?.softMult, gates: (t?.softGates || []).map(g => g.reason || g), entryLs: t?.entryLs, h4Adx: t?.h4Adx, btcD1: t?.btcD1, keys: Object.keys(f.rejects || {}).filter(k => /BTC 日線|4H ADX|多空人數比/.test(k)) };
  };
  return { base: await run(), againstD1: await run({ btcD1: 'bear' }), lowAdx: await run({ h4Adx: 15 }), okAdx: await run({ h4Adx: 27 }), lsAgainst: await run({ ls: 0.8 }), lsWith: await run({ ls: 1.4 }) };
}, MK);
if (!gate.base.built || gate.base.softMult !== 1 || gate.base.btcD1 !== 'bull') throw new Error('基準應全額建單：' + JSON.stringify(gate.base));
if (gate.againstD1.built || !gate.againstD1.keys.some(k => k.includes('逆 BTC 日線'))) throw new Error('逆 BTC 日線應不建：' + JSON.stringify(gate.againstD1));
if (gate.lowAdx.built || !gate.lowAdx.keys.some(k => k.includes('4H ADX'))) throw new Error('4H ADX<20 應不建：' + JSON.stringify(gate.lowAdx));
if (!gate.okAdx.built || gate.okAdx.h4Adx !== 27) throw new Error('4H ADX 27 應建單並記錄：' + JSON.stringify(gate.okAdx));
if (!gate.lsAgainst.built || gate.lsAgainst.softMult !== 0.7 || !gate.lsAgainst.gates.some(g => g.includes('多空人數比反向')) || gate.lsAgainst.entryLs !== 0.8) throw new Error('多空人數比反向應 ×0.7 並記錄：' + JSON.stringify(gate.lsAgainst));
if (!gate.lsWith.built || gate.lsWith.softMult !== 1 || gate.lsWith.entryLs !== 1.4) throw new Error('多空人數比同向應全額：' + JSON.stringify(gate.lsWith));
console.log(`✓ 回測閘門：逆 BTC 日線 → 不建；4H ADX 15 → 不建、27 → 建單；多空比 0.8 做多 ×${gate.lsAgainst.softMult}、1.4 → ×${gate.lsWith.softMult}；紀錄含 entryLs/h4Adx/btcD1`);

// ══ ② 突破單幾何：止盈一 1R、止盈二 2.5R、出場計畫 50%／+0.3R；回踩單不帶計畫 ══
const geo = await p.evaluate((mk) => {
  const mkCoin = (0, eval)('(' + mk + ')');
  const c = mkCoin('GE/USDT', 74); c.adx = 32; c.price = '100'; c.ema20 = '99.2'; delete _tradeSetupCache[c.symbol];
  const s = computeSimpleSetup(c, true);
  const r = Math.abs(s.entry - s.sl);
  const c2 = mkCoin('GL/USDT', 74); c2.adx = 14; c2.price = '100'; c2.ema20 = '99.2'; c2.signal15m = 'neutral'; delete _tradeSetupCache[c2.symbol];
  const s2 = computeSimpleSetup(c2, true);
  return { mode: s.entryMode, tp1R: +((s.tp1 - s.entry) / r).toFixed(2), tp2R: +((s.tp2 - s.entry) / r).toFixed(2), frac: s.tp1FracPlan, lock: s.tp1LockRPlan, rrBlocked: s.rrBlocked, reason: s.tp1Reason, mode2: s2.entryMode, frac2: s2.tp1FracPlan };
}, MK);
if (geo.mode !== 'stop') throw new Error('夾具應走突破單：' + JSON.stringify(geo));
if (geo.tp1R !== 1 || geo.tp2R !== 2.5 || geo.frac !== 0.5 || geo.lock !== 0.3 || geo.rrBlocked || !geo.reason.includes('減倉 50%')) throw new Error('突破單出場幾何錯誤：' + JSON.stringify(geo));
if (geo.mode2 === 'stop' || geo.frac2 != null) throw new Error('回踩單不應帶突破出場計畫：' + JSON.stringify(geo));
console.log(`✓ 突破單：止盈一 ${geo.tp1R}R、止盈二 ${geo.tp2R}R、減倉 ${geo.frac * 100}%、鎖 +${geo.lock}R，R/R 門檻不擋；回踩單（${geo.mode2}）不帶計畫`);

// ══ ③ 監控：帶計畫的持倉觸及止盈一 → 止損鎖 +0.3R、tp1Frac=0.5；不帶計畫 → 出場實驗室預設 ══
const hit = await p.evaluate(async () => {
  isSignalMaster = () => true; const sent = []; sendSLChangeNotification = (t, a, b2, why) => { sent.push(why); };
  const now = Date.now();
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify([
    { id: 'plan', symbol: 'PL/USDT', direction: 'long', status: 'open', entry: 100, baseSl: 98, sl: 98, tp1: 102, tp2: 105, timestamp: now - 3e5, entryTime: now - 3e5, telegramSent: true, conf: 70, entryMode: 'stop', tp1FracPlan: 0.5, tp1LockRPlan: 0.3 },
    { id: 'def', symbol: 'DF/USDT', direction: 'long', status: 'open', entry: 100, baseSl: 98, sl: 98, tp1: 103, tp2: 106, timestamp: now - 3e5, entryTime: now - 3e5, telegramSent: true, conf: 70 },
  ])); _tlogRaw = null; _tlogArr = null;
  updateOpenTrades([{ symbol: 'PL/USDT', price: '102.1', score: 70, trend: '看漲' }, { symbol: 'DF/USDT', price: '103.1', score: 70, trend: '看漲' }]);
  const a = loadTradeLog().find(t => t.id === 'plan'), d = loadTradeLog().find(t => t.id === 'def'); const eff = exitEffective();
  return { aSl: a.sl, aFrac: a.tp1Frac, aHit: !!a.tp1Hit, dSl: d.sl, dFrac: d.tp1Frac, effFrac: eff.tp1ExitFrac, effLock: eff.tp1LockR, sent };
});
if (!hit.aHit || Math.abs(hit.aSl - 100.6) > 1e-6 || hit.aFrac !== 0.5) throw new Error('突破單止盈一應鎖 +0.3R、減倉 50%：' + JSON.stringify(hit));
if (Math.abs(hit.dSl - (100 + 2 * hit.effLock)) > 1e-6 || hit.dFrac !== hit.effFrac) throw new Error('一般單應沿用出場實驗室參數：' + JSON.stringify(hit));
if (!hit.sent.some(s => s.includes('減倉 50%') && s.includes('+0.3R'))) throw new Error('止盈一通知文字應反映計畫：' + JSON.stringify(hit.sent));
console.log(`✓ 監控：突破單止盈一 → 止損 ${hit.aSl}（+0.3R）、減倉 50%；一般單 → +${hit.effLock}R、減倉 ${hit.effFrac * 100}%`);

// ══ ④ 快速單設定：A/B 動能模式停用、費用門 8%、學習止損下限 0.7 ══
const sc = await p.evaluate(() => ({ a: SCALP_CFG.enableBreakout, b: SCALP_CFG.enableMomentum, fee: SCALP_CFG.maxFeeR, slMin: SCALP_CFG.slMultMin, c: SCALP_CFG.enableRetest, rev: SCALP_CFG.enableRange }));
if (sc.a || sc.b || sc.fee !== 0.08 || sc.slMin !== 0.7 || !sc.c || !sc.rev) throw new Error('快速單設定未更新：' + JSON.stringify(sc));
console.log(`✓ 快速單：突破／動能模式停用，費用門 ${sc.fee * 100}% R（止損 ≥1.25%），學習止損下限 ${sc.slMin}×ATR；回踩確認／回歸家族保留`);

await p.evaluate(() => { const s = loadSettings(); s.mainPriceSrc = 'okx'; saveSettings(s); });
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_bt');
await b.close();
