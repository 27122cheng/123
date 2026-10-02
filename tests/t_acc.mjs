import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof recordSignalsFromScan === 'function' && typeof isLimitFilled === 'function', { timeout: 15000 });

// ══ ① 停損買進：觸及觸發價即成交（與交易所停損單一致；2026-10 回測：等收盤確認多付 0.58R）══
const fill = await p.evaluate(async () => {
  isSignalMaster = () => true; sendCancelTelegramNotification = () => {}; sendEntryFilledNotification = () => {};
  const now = Date.now(); const t0 = now - 4 * 60000;
  const mk = (id) => ({ id, symbol: 'ST/USDT', direction: 'long', status: 'pending', entry: 101, entryPrice: 100, sl: 98.5, tp1: 104, tp2: 106, timestamp: t0, telegramSent: true, conf: 70, tradeType: 'directional', refined: true, entryMode: 'stop' });
  const set = () => { localStorage.setItem(TRADE_LOG_KEY, JSON.stringify([mk('st')])); _tlogRaw = null; _tlogArr = null; };
  // 監控：先把 hiSince 拉到 101.4（影線），現價 100.6 → 不成交；現價 101.2 → 成交
  set(); updateOpenTrades([{ symbol: 'ST/USDT', price: '101.4', score: 70, trend: '看漲' }]);   // 這一輪現價本身就站上 → 會成交；改用預設 hiSince 模擬影線
  set(); const t = loadTradeLog()[0]; t.hiSince = 101.4; t.loSince = 100; saveTradeLog(loadTradeLog().map(x => x.id === 'st' ? t : x));
  updateOpenTrades([{ symbol: 'ST/USDT', price: '100.6', score: 70, trend: '看漲' }]); const wick = loadTradeLog().find(x => x.id === 'st').status;
  updateOpenTrades([{ symbol: 'ST/USDT', price: '101.2', score: 70, trend: '看漲' }]); const above = loadTradeLog().find(x => x.id === 'st').status;
  // 1m 驗證：棒高 101.5 但收 100.9 → 不成交；收 101.1 → 成交
  const bar = (t, o, h, l, c) => [t, String(o), String(h), String(l), String(c), '100', t + 59999, '1', 1, '1', '1', '0'];
  set(); fetchKlinesExec = async () => [bar(t0 + 60000, 100.5, 101.5, 100.4, 100.9)]; await verifyIntrabarHits(); const wickBar = loadTradeLog().find(x => x.id === 'st').status;
  set(); fetchKlinesExec = async () => [bar(t0 + 60000, 100.5, 101.5, 100.4, 101.1)]; await verifyIntrabarHits(); const closeBar = loadTradeLog().find(x => x.id === 'st').status;
  return { wick, above, wickBar, closeBar };
});
if (fill.wick !== 'open' || fill.above !== 'open' || fill.wickBar !== 'open' || fill.closeBar !== 'open') throw new Error('停損買進應觸及即成交：' + JSON.stringify(fill));
console.log(`✓ 停損買進：影線刺到 101.4（現價 100.6）→ ${fill.wick}；現價 101.2 → ${fill.above}；1m 高 101.5 收 100.9 → ${fill.wickBar}；收 101.1 → ${fill.closeBar}`);

// ══ ② 逆 BTC 1H：×0.75；RS<35 且逆 BTC → 不建；低品質時段 ×0.8 ══
const MK = `(s, score) => ({
  symbol: s, price: '100', score, rsi: 60, adx: 28, atr: 1.6, change24h: 2.5, volume: 3e8, volumeStrength: '高', macdHist: 0.35, momentum: 6, trend: '看漲',
  ema20: '99.2', ema50: '98', ema200: '93', bb: { upper: 103.5, lower: 96.5, mid: 100, width: 7 },
  signal15m: 'bull', h1Signal: 'bull', h4Signal: 'bull', dailySignal: 'bull', weeklySignal: 'bull', h4SwingHigh: 108, h4SwingLow: 96.2, h4Rsi: 58, h1Rsi: 57,
  dayStruct: { dir: 'up', hh: true, hl: true, lastHigh: 110, lastLow: 94, r2: 0.7, pivots: 6 }, h4Struct: { dir: 'up', hh: true, hl: true, lastHigh: 108, lastLow: 96, r2: 0.6, pivots: 5 },
  struct15: { dir: 'up', pivots: 5 }, nakedK: { tags: ['多頭吞噬'], bullEngulf: true }, wickSupports: [97.5, 96.8], wickResistances: [105.2, 107.5],
  derivData: { fundingRate: -0.0003, takerBuySell: 1.12, topLongRatio: 0.58, openInterest: 5e7 } })`;
const gate = await p.evaluate(async (mk) => {
  const mkCoin = (0, eval)('(' + mk + ')');
  const run = async (btcH1, rs, kz) => {
    const now = Date.now();
    isSignalMaster = () => true; computeKillZone = () => ({ quality: kz, zone: 'x', label: 'x' });
    getAdaptiveGates = () => ({ minConf: 65, minSq: 12, minRR: minRequiredRR(), relaxed: false, label: '' });
    getUpcomingEconEvents = () => []; getTodayEconEvents = () => []; _evBlkCache = null; _evBlkCacheTs = 0; condBlockCheck = () => null;
    _macroCache = { fg: { value: '58' }, btcDominance: 50, marketCapChange: 1.5 }; _macroCacheAt = now;
    localStorage.setItem(TRADE_LOG_KEY, '[]'); localStorage.removeItem('csp_scan_funnel'); localStorage.removeItem(SIGNAL_LEDGER_KEY); localStorage.removeItem(CANCEL_COOLDOWN_KEY);
    _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.(); _sigEvCache = {}; _sigEvCacheTs = 0; _condCache = null; _condCacheTs = 0;
    const btc = mkCoin('BTC/USDT', 62); btc.h1Signal = btcH1;
    state.data = [btc, mkCoin('AL/USDT', 74)]; state.data[1].change24h = 4.5;
    for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
    updateMarketContext(state.data); _rsRank = { 'AL/USDT': rs }; _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
    await recordSignalsFromScan(state.data);
    const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}'); const t = loadTradeLog().find(x => x.symbol === 'AL/USDT' && x.status === 'pending');
    return { built: !!t, softMult: t?.softMult, gates: t?.softGates, keys: Object.keys(f.rejects || {}).filter(k => /BTC|時段/.test(k)) };
  };
  return { base: await run('bull', 70, 'high'), against: await run('bear', 70, 'high'), weak: await run('bear', 20, 'high'), lowKz: await run('bull', 70, 'low') };
}, MK);
if (!gate.base.built || gate.base.softMult !== 1) throw new Error('基準應全額建單：' + JSON.stringify(gate.base));
if (!gate.against.built || gate.against.softMult !== 0.75 || !gate.against.gates.includes('逆 BTC 1H 方向')) throw new Error('逆 BTC 1H 應 ×0.75：' + JSON.stringify(gate.against));
if (gate.weak.built || !gate.weak.keys.some(k => k.includes('逆 BTC 1H 且相對弱勢'))) throw new Error('RS<35 且逆 BTC 應不建：' + JSON.stringify(gate.weak));
if (!gate.lowKz.built || !(gate.lowKz.softMult <= 0.8) || !gate.lowKz.gates.includes('低品質時段')) throw new Error('低品質時段應 ×0.8：' + JSON.stringify(gate.lowKz));   // 低品質時段也會壓低 SQ，可能再疊一道 SQ 軟門
console.log(`✓ 準確度閘門：同向基準 ×1；逆 BTC 1H ×${gate.against.softMult}；RS 20 且逆 BTC → 不建；低品質時段 ×${gate.lowKz.softMult}`);

// ══ ③ 一般單所有建單路徑走 Pionex 價位空間（原始碼接線） ══
const src = await p.evaluate(async () => (await (await fetch('/js/app.js', { cache: 'no-store' })).text()));
const need = ["notifSetup = computeSimpleSetup(_coinForMain(coin), isLong);", "const su = computeSimpleSetup(_coinForMain(coin), isLong);", "entryPrice: +(price * _btsR).toPrecision(9), entry: +(entry * _btsR).toPrecision(9)", "coin = _coinForMain(coin); } catch(_e) {} }\n  const isLong    = direction === 'long';"];
for (const k of need) if (!src.includes(k)) throw new Error('接線缺失：' + k.slice(0, 50));
console.log('✓ 警報建單、詳情頁建單、詳情頁建議、Telegram 現價全部走一般單價格來源（Pionex 合約／現貨）');

await p.evaluate(() => { const s = loadSettings(); s.mainPriceSrc = 'okx'; saveSettings(s); });
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_acc');
await b.close();
