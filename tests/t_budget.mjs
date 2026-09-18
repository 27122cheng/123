import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof recordSignalsFromScan === 'function' && typeof MAIN_ROUND_CAP !== 'undefined', { timeout: 15000 });

const MK = `(s, score) => ({
  symbol: s, price: '100', score, rsi: 60, adx: 28, atr: 1.6, change24h: 2.5, volume: 3e8, volumeStrength: '高', macdHist: 0.35, momentum: 6, trend: '看漲',
  ema20: '99.2', ema50: '98', ema200: '93', bb: { upper: 103.5, lower: 96.5, mid: 100, width: 7 },
  signal15m: 'bull', h1Signal: 'bull', h4Signal: 'bull', dailySignal: 'bull', weeklySignal: 'bull', h4SwingHigh: 108, h4SwingLow: 96.2, h4Rsi: 58, h1Rsi: 57,
  dayStruct: { dir: 'up', hh: true, hl: true, lastHigh: 110, lastLow: 94, r2: 0.7, pivots: 6 }, h4Struct: { dir: 'up', hh: true, hl: true, lastHigh: 108, lastLow: 96, r2: 0.6, pivots: 5 },
  struct15: { dir: 'up', pivots: 5 }, nakedK: { tags: ['多頭吞噬'], bullEngulf: true }, wickSupports: [97.5, 96.8], wickResistances: [105.2, 107.5],
  derivData: { fundingRate: -0.0003, takerBuySell: 1.12, topLongRatio: 0.58, openInterest: 5e7 } })`;
const SETUP = `() => {
  isSignalMaster = () => true; computeKillZone = () => ({ quality: 'high', zone: 'london', label: '倫敦盤' });
  getAdaptiveGates = () => ({ minConf: 65, minSq: 12, minRR: minRequiredRR(), relaxed: false, label: '' });   // 夾具 SQ≈13：門檻 12 才不會自帶一道 SQ 軟門
  getUpcomingEconEvents = () => []; getTodayEconEvents = () => []; _evBlkCache = null; _evBlkCacheTs = 0;
  _macroCache = { fg: { value: '58' }, btcDominance: 50, marketCapChange: 1.5 }; _macroCacheAt = Date.now();
  _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
  localStorage.removeItem('csp_scan_funnel'); localStorage.removeItem(SIGNAL_LEDGER_KEY); localStorage.removeItem(CANCEL_COOLDOWN_KEY); localStorage.removeItem('csp_starve_probe_at');
  _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.(); _beCache = null; _beCacheTs = 0; invalidateWinup?.(); _sigEvCache = {}; _sigEvCacheTs = 0; _condCache = null; _condCacheTs = 0; _dailyRCache = null; _dailyRCacheTs = 0;
}`;

// ══ ① 軟門預算：一道 0.6 建單且部位真的縮；0.6×0.5＝0.3 → 不建 ══
const sb = await p.evaluate(async ([mk, su]) => {
  const mkCoin = (0, eval)('(' + mk + ')'); const setupEnv = (0, eval)('(' + su + ')');
  const now = Date.now();
  const run = async (hist, condBlock) => {
    localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(hist)); setupEnv();
    condBlockCheck = () => condBlock;
    state.data = [mkCoin('BTC/USDT', 62), mkCoin('SB/USDT', 74)]; state.data[1].change24h = 4.5;
    for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
    updateMarketContext(state.data); _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
    await recordSignalsFromScan(state.data);
    const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}');
    const t = loadTradeLog().find(x => x.status === 'pending' && x.symbol === 'SB/USDT');
    return { built: !!t, softMult: t?.softMult, gates: t?.softGates, sizeRiskPct: t?.sizeRiskPct, fBuilt: f.built, keys: Object.keys(f.rejects || {}).filter(k => /軟門預算|條件封鎖|負期望/.test(k)) };
  };
  const dry = await run([], null);
  const one = await run([], '條件封鎖（測試桶）');
  const tag = dry.built ? loadTradeLog().find(x => x.symbol === 'SB/USDT')?.entryTag : null;
  return { dry, one, tag };
}, [MK, SETUP]);
if (!sb.dry.built || sb.dry.fBuilt !== 1) throw new Error('乾跑未建單或漏斗 built 計數錯：' + JSON.stringify(sb.dry));
if (!sb.one.built || sb.one.softMult !== 0.6 || !(sb.one.sizeRiskPct < sb.dry.sizeRiskPct)) throw new Error('單道軟門應建單且部位縮小：' + JSON.stringify({ dry: sb.dry, one: sb.one }));
console.log(`✓ 單道軟門（條件封鎖 ×0.6）：建單、softMult ${sb.one.softMult}、風險 % ${sb.dry.sizeRiskPct} → ${sb.one.sizeRiskPct}（縮倉真的反映到部位）；漏斗 built=${sb.dry.fBuilt}（不再用反推法）`);

const sb2 = await p.evaluate(async ([mk, su, tag]) => {
  const mkCoin = (0, eval)('(' + mk + ')'); const setupEnv = (0, eval)('(' + su + ')');
  const now = Date.now(); const hist = [];
  for (let i = 0; i < 25; i++) hist.push({ id: 'g' + i, symbol: 'H/USDT', direction: 'long', status: 'closed', outcome: i < 5 ? 'tp1' : 'sl', pnlR: i < 5 ? 1.2 : -1,
    entryTag: tag, regime: 'bull_hv', exitTime: now - (i + 2) * 86400e3, timestamp: now - (i + 2) * 86400e3 - 3600e3 });
  for (let i = 0; i < 12; i++) hist.push({ id: 'n' + i, symbol: 'N/USDT', direction: 'long', status: 'closed', outcome: i < 6 ? 'tp1' : 'sl', pnlR: i < 6 ? 1.5 : -1, exitTime: now - 2 * 86400e3, timestamp: now - 2 * 86400e3 - 3600e3 });
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(hist)); setupEnv();
  condBlockCheck = () => '條件封鎖（測試桶）';
  state.data = [mkCoin('BTC/USDT', 62), mkCoin('SB/USDT', 74)]; state.data[1].change24h = 4.5;
  for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
  updateMarketContext(state.data); _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
  await recordSignalsFromScan(state.data);
  const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}');
  return { built: loadTradeLog().filter(x => x.status === 'pending' && x.symbol === 'SB/USDT').length, budget: Object.keys(f.rejects || {}).find(k => k.startsWith('軟門預算')), fBuilt: f.built };
}, [MK, SETUP, sb.tag]);
if (sb2.built !== 0 || !sb2.budget || sb2.fBuilt !== 0) throw new Error('兩道軟門疊加應不建：' + JSON.stringify(sb2));
console.log(`✓ 兩道軟門疊加（負期望 ×0.5 × 條件封鎖 ×0.6 = 0.30 < 0.5）→ 不建，漏斗「${sb2.budget.slice(0, 40)}…」`);

// ══ ② 每輪建單上限 3 筆 ══
const cap = await p.evaluate(async ([mk, su]) => {
  const mkCoin = (0, eval)('(' + mk + ')'); const setupEnv = (0, eval)('(' + su + ')');
  const now = Date.now();
  localStorage.setItem(TRADE_LOG_KEY, '[]'); setupEnv(); condBlockCheck = () => null;
  sameDirGuard = () => null;   // 隔離：只測本輪上限
  state.data = [mkCoin('BTC/USDT', 62)]; for (let i = 0; i < 8; i++) { const c = mkCoin(`R${i}/USDT`, 74 - i); c.change24h = 4.5; state.data.push(c); }
  for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
  updateMarketContext(state.data); _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
  await recordSignalsFromScan(state.data);
  const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}');
  return { built: loadTradeLog().filter(x => x.status === 'pending').length, capKey: Object.keys(f.rejects || {}).find(k => k.startsWith('本輪建單上限')), capN: f.rejects?.[Object.keys(f.rejects || {}).find(k => k.startsWith('本輪建單上限'))], fBuilt: f.built };
}, [MK, SETUP]);
if (cap.built !== 3 || !cap.capKey || cap.fBuilt !== 3) throw new Error('每輪上限未生效：' + JSON.stringify(cap));
console.log(`✓ 每輪建單上限：9 個候選 → 建 ${cap.built} 筆，其餘 ${cap.capN} 個記「${cap.capKey.slice(0, 22)}…」留下輪`);

// ══ ③ 雙弱不建（原始碼接線）＋ ④ 事件不再帶寫死 AI 預測 ＋ ⑤ 今日預測未證明不參與 ══
const rest = await p.evaluate(async ([mk, su]) => {
  const src = await (await fetch('/js/app.js', { cache: 'no-store' })).text();
  const dw = src.includes("_no(`雙弱不建：SQ ${_scanSqScore} < ${_sqFloor} 且風控分") && src.includes('!_starveThis && _scanSqScore < _sqFloor');
  // 事件
  const ev = getUpcomingEconEvents(0).concat(getUpcomingEconEvents(1), getUpcomingEconEvents(2), getUpcomingEconEvents(3), getUpcomingEconEvents(4));
  const leaked = ev.filter(e => 'aiPred' in e || 'aiDir' in e || 'aiConf' in e).length;
  const msg = buildDailyBriefingMsg({ value: '60', value_classification: 'Greed' }, { marketCapChange: 1, btcDominance: 55 });
  // 今日預測反向：未證明 → 不參與；證明 → 0.7 軟門
  const mkCoin = (0, eval)('(' + mk + ')'); const setupEnv = (0, eval)('(' + su + ')'); const now = Date.now();
  const runBias = async (proven, bias = 'bear') => {
    localStorage.setItem(TRADE_LOG_KEY, '[]'); setupEnv(); condBlockCheck = () => null;
    computeTodayAIBias = () => ({ bias, biasLabel: '▼ 偏空', conf: 60, reasons: [], highEvs: [], riskNote: '' });
    biasTrackStats = () => (proven ? { dirN: 40, dirHit: 24, dirRate: 60, dirUb: 74 } : { dirN: 5, dirHit: 2, dirRate: 40, dirUb: 70 }); for (const k of Object.keys(_biasProvenCache)) delete _biasProvenCache[k];
    state.data = [mkCoin('BTC/USDT', 62), mkCoin('BZ/USDT', 74)]; state.data[1].change24h = 4.5;
    for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
    updateMarketContext(state.data); _regimeCache = { at: Date.now(), key: 'bull_hv', dir: 'bull', vol: 'hv', label: '趨勢多/高波動' };
    await recordSignalsFromScan(state.data);
    const f = JSON.parse(localStorage.getItem('csp_scan_funnel') || '{}'); const t = loadTradeLog().find(x => x.symbol === 'BZ/USDT' && x.status === 'pending');
    return { built: !!t, softMult: t?.softMult, info: Object.keys(f.rejects || {}).some(k => k.includes('今日預測反向，但成績單未達')), soft: Object.keys(f.rejects || {}).some(k => k === '↓ 今日大方向偏空') };
  };
  const base = await runBias(false, 'bull'); const unproven = await runBias(false); const proven = await runBias(true);
  return { base, dw, evN: ev.length, leaked, briefHasAi: msg.includes('AI 預測值') || msg.includes('AI預測'), unproven, proven };
}, [MK, SETUP]);
if (!rest.dw) throw new Error('雙弱不建未接線');
if (rest.leaked !== 0 || rest.briefHasAi) throw new Error('事件仍帶寫死 AI 預測：' + JSON.stringify(rest));
// 夾具本身另有一道 0.7 軟門（SQ 略低於門檻），故以「同向基準」比較：未證明＝與基準相同；已證明＝基準 ×0.7
if (!rest.unproven.built || rest.unproven.softMult !== rest.base.softMult || !rest.unproven.info || rest.unproven.soft) throw new Error('未證明的今日預測不該參與：' + JSON.stringify({ base: rest.base, unproven: rest.unproven }));
if (!rest.proven.built || Math.abs(rest.proven.softMult - rest.base.softMult * 0.7) > 0.02 || !rest.proven.soft) throw new Error('已證明的今日預測應為 ×0.7：' + JSON.stringify({ base: rest.base, proven: rest.proven }));
console.log(`✓ 雙弱不建已接線；${rest.evN} 個事件物件都不再帶 aiPred/aiDir/aiConf，簡報無「AI 預測值」；今日預測反向：成績單未達 → 不參與（softMult ${rest.unproven.softMult}＝同向基準）、達 60%/40 筆 → ${rest.proven.softMult}（×0.7）`);

// ══ ⑥ 環境卡：風險預算列 ══
const card = await p.evaluate(() => buildTradeEnvCard());
if (!card.includes('今日風險預算') || !card.includes('每輪最多 3 筆')) throw new Error('環境卡缺風險預算列');
console.log('✓ 操作環境卡顯示今日風險預算（已用 R／上限）與每輪建單上限');

if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_budget');
await b.close();
