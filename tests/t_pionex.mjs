import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof _coinForMain === 'function' && typeof fetchPionexPrices === 'function', { timeout: 15000 });
const MK = `(s, score) => ({
  symbol: s, price: '100', score, rsi: 60, adx: 28, atr: 1.6, change24h: 2.5, volume: 3e8, volumeStrength: '高', macdHist: 0.35, momentum: 6, trend: '看漲',
  ema20: '99.2', ema50: '98', ema200: '93', bb: { upper: 103.5, lower: 96.5, mid: 100, width: 7 },
  signal15m: 'bull', h1Signal: 'bull', h4Signal: 'bull', dailySignal: 'bull', weeklySignal: 'bull', h4SwingHigh: 108, h4SwingLow: 96.2, h4Rsi: 58, h1Rsi: 57,
  dayStruct: { dir: 'up', hh: true, hl: true, lastHigh: 110, lastLow: 94, r2: 0.7, pivots: 6 }, h4Struct: { dir: 'up', hh: true, hl: true, lastHigh: 108, lastLow: 96, r2: 0.6, pivots: 5 },
  struct15: { dir: 'up', pivots: 5 }, nakedK: { tags: ['多頭吞噬'], bullEngulf: true }, wickSupports: [{ level: 97.5, wicks: 3 }, { level: 96.8, wicks: 2 }], wickResistances: [{ level: 105.2, wicks: 4 }],
  derivData: { fundingRate: -0.0003, takerBuySell: 1.12, topLongRatio: 0.58, openInterest: 5e7 } })`;

// ══ ① 代理接線、等比對齊、±3% 異常退回 ══
const al = await p.evaluate(async (mk) => {
  const mkCoin = (0, eval)('(' + mk + ')');
  const origFetch = window.fetch; window._pxTable = { 'PX/USDT': 101, 'BAD/USDT': 120 };
  window.fetch = async (url, opt) => String(url).startsWith('/api/pionex')
    ? new Response(JSON.stringify({ ok: true, at: Date.now(), n: 2, prices: window._pxTable }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : origFetch(url, opt);
  const s = loadSettings(); s.mainPriceSrc = 'pionex'; saveSettings(s);
  _pionexPx = { at: 0, prices: {} }; await fetchPionexPrices();
  const c = _coinForMain(mkCoin('PX/USDT', 74));
  const bad = _coinForMain(mkCoin('BAD/USDT', 74));
  const off = (() => { const s2 = loadSettings(); s2.mainPriceSrc = 'okx'; saveSettings(s2); const r = _coinForMain(mkCoin('PX/USDT', 74)); s2.mainPriceSrc = 'pionex'; saveSettings(s2); return r; })();
  delete _tradeSetupCache['PX/USDT'];
  const setup = computeSimpleSetup(c, true);
  return { px: pionexPrice('PX/USDT'), price: c.price, src: c._pxSrc, ratio: c._pxRatio, ema20: c.ema20, h4hi: c.h4SwingHigh, wick: c.wickSupports[0].level, bbUp: c.bb.upper,
    badSrc: bad._pxSrc, badPrice: bad.price, offSrc: off._pxSrc, setupSrc: setup.priceSrc, entry: setup.entry, sl: setup.sl, tp1: setup.tp1 };
}, MK);
if (al.px !== 101 || al.src !== 'pionex' || al.price !== '101' || Math.abs(al.ema20 - 100.192) > 0.001 || Math.abs(al.h4hi - 109.08) > 0.001 || Math.abs(al.wick - 98.475) > 0.001 || Math.abs(al.bbUp - 104.535) > 0.001) throw new Error('等比對齊錯誤：' + JSON.stringify(al));
if (al.badSrc || al.badPrice !== '100') throw new Error('±3% 異常報價應退回 OKX：' + JSON.stringify(al));
if (al.offSrc) throw new Error('OKX 模式不該對齊：' + JSON.stringify(al));
if (al.setupSrc !== 'pionex' || !(al.sl < al.entry && al.tp1 > al.entry)) throw new Error('setup 未帶 Pionex 價位空間：' + JSON.stringify(al));
console.log(`✓ Pionex 對齊：OKX 100 → Pionex 101（比值 ${al.ratio}）：EMA20 ${al.ema20}、4H 前高 ${al.h4hi}、影線 ${al.wick}、BB 上軌 ${al.bbUp} 全部等比；120（+20%）視為異常退回 OKX；OKX 模式不對齊；setup.priceSrc=${al.setupSrc}`);

// ══ ② 建單寫入 priceSrc／entryMode；監控用該單自己的價位空間 ══
const mon = await p.evaluate(() => {
  isSignalMaster = () => true; sendCancelTelegramNotification = () => {};
  const now = Date.now();
  const mk = (id, priceSrc, entry) => ({ id, symbol: 'PX/USDT', direction: 'long', status: 'pending', entry, entryPrice: entry * 0.995, sl: entry * 0.98, tp1: entry * 1.03, tp2: entry * 1.05,
    timestamp: now - 60e3, telegramSent: true, conf: 70, tradeType: 'directional', refined: true, priceSrc, entryMode: 'stop' });
  // Pionex 報價 101.5 已穿過 Pionex 空間的進場 101.2；OKX 報價 100.4 尚未穿過 OKX 空間的進場 100.8
  window._pxTable['PX/USDT'] = 101.5; _pionexPx = { at: Date.now(), prices: { ...window._pxTable } };
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify([mk('pp', 'pionex', 101.2), mk('oo', 'okx', 100.8)])); _tlogRaw = null; _tlogArr = null;
  updateOpenTrades([{ symbol: 'PX/USDT', price: '100.4', score: 70, trend: '看漲' }]);
  const a = loadTradeLog().find(t => t.id === 'pp'), o = loadTradeLog().find(t => t.id === 'oo');
  const html = buildPendingPositionSetup(o, 100.4);
  return { pionexTrade: a.status, okxTrade: o.status, label: html.includes('等待突破做多（停損買進）') };
});
if (mon.pionexTrade !== 'open' || mon.okxTrade !== 'pending') throw new Error('監控未依單的價位空間取現價：' + JSON.stringify(mon));
if (!mon.label) throw new Error('停損買進的卡片標籤未更新');
console.log(`✓ 監控：Pionex 單以 Pionex 現價 101.5 判定成交（${mon.pionexTrade}），同幣 OKX 單以 OKX 現價 100.4 仍等待（${mon.okxTrade}）；卡片標籤「等待突破做多（停損買進）」`);

// ══ ③ 掃描建單：priceSrc/entryMode 落到紀錄，Telegram 文字含價位空間與觸發方式 ══
const sc = await p.evaluate(async (mk) => {
  const mkCoin = (0, eval)('(' + mk + ')');
  const now = Date.now();
  isSignalMaster = () => true; computeKillZone = () => ({ quality: 'high', zone: 'london', label: '倫敦盤' });
  getAdaptiveGates = () => ({ minConf: 65, minSq: 12, minRR: minRequiredRR(), relaxed: false, label: '' });
  getUpcomingEconEvents = () => []; getTodayEconEvents = () => []; _evBlkCache = null; _evBlkCacheTs = 0; condBlockCheck = () => null;
  _macroCache = { fg: { value: '58' }, btcDominance: 50, marketCapChange: 1.5 }; _macroCacheAt = now;
  localStorage.setItem(TRADE_LOG_KEY, '[]'); localStorage.removeItem('csp_scan_funnel'); localStorage.removeItem(SIGNAL_LEDGER_KEY); localStorage.removeItem(CANCEL_COOLDOWN_KEY);
  _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.(); _sigEvCache = {}; _sigEvCacheTs = 0; _condCache = null; _condCacheTs = 0;
  window._pxTable = { 'PX/USDT': 101, 'BTC/USDT': 101 }; _pionexPx = { at: Date.now(), prices: { ...window._pxTable } };
  state.data = [mkCoin('BTC/USDT', 62), mkCoin('PX/USDT', 74)]; state.data[1].change24h = 4.5;
  for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
  updateMarketContext(state.data); _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
  await recordSignalsFromScan(state.data);
  const t = loadTradeLog().find(x => x.status === 'pending' && x.symbol === 'PX/USDT');
  const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}');
  const tg = t ? buildTelegramText(state.data[1], 'long', { ...t }, _macroCache, '') : '';
  return { built: !!t, priceSrc: t?.priceSrc, entryMode: t?.entryMode, entry: t?.entry, tgSrc: tg.includes('價位空間：Pionex'), tgMode: tg.includes('突破觸發') || tg.includes('回踩限價'), rej: Object.keys(f.rejects || {}).slice(0, 4) };
}, MK);
if (!sc.built || sc.priceSrc !== 'pionex' || !sc.entryMode) throw new Error('掃描建單未帶 Pionex 價位空間：' + JSON.stringify(sc));
if (!sc.tgSrc || !sc.tgMode) throw new Error('Telegram 文字缺價位空間或觸發方式：' + JSON.stringify(sc));
console.log(`✓ 掃描建單：priceSrc=${sc.priceSrc}、entryMode=${sc.entryMode}、進場 ${sc.entry}（Pionex 空間）；Telegram 含「價位空間：Pionex」與觸發方式`);

await p.evaluate(() => { const s = loadSettings(); s.mainPriceSrc = 'okx'; saveSettings(s); });
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_pionex');
await b.close();
