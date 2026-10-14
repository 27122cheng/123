// 長時間運行壓力測試：用真實的刷新迴圈（refreshInterval=3s、背景掃描 15s）跑 N 分鐘，量 heap／DOM／監聽器／timer／快取／localStorage 的成長
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const MIN = parseFloat(process.argv[2] || '4');
const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
p.on('console', m => { const t = m.text(); if (/\[post-scan\]|耗時|崩潰|長任務/.test(t)) errs.push('console: ' + t.slice(0, 160)); });
await p.addInitScript(() => {
  // 計數活著的 timer／監聽器
  window.__timers = { to: 0, iv: 0, toTotal: 0, ivTotal: 0, listeners: 0 };
  const _st = window.setTimeout, _ct = window.clearTimeout, _si = window.setInterval, _ci = window.clearInterval;
  const live = new Set();
  window.setTimeout = function(fn, ms, ...a) { window.__timers.toTotal++; const id = _st.call(window, function() { live.delete(id); window.__timers.to = live.size; try { return typeof fn === 'function' ? fn.apply(this, a) : fn; } catch(e) { throw e; } }, ms); live.add(id); window.__timers.to = live.size; return id; };
  window.clearTimeout = function(id) { live.delete(id); window.__timers.to = live.size; return _ct.call(window, id); };
  const liveIv = new Set();
  window.setInterval = function(fn, ms, ...a) { window.__timers.ivTotal++; const id = _si.call(window, fn, ms, ...a); liveIv.add(id); window.__timers.iv = liveIv.size; return id; };
  window.clearInterval = function(id) { liveIv.delete(id); window.__timers.iv = liveIv.size; return _ci.call(window, id); };
  const _ael = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(...a) { window.__timers.listeners++; return _ael.apply(this, a); };
});
const cdp = await ctx.newCDPSession(p); await cdp.send('Performance.enable');
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof recordSignalsFromScan === 'function' && typeof startRefreshCycle === 'function', { timeout: 15000 });
await p.evaluate(() => {
  let s = 4242; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; const now = Date.now();
  window.__mk = (sym, score, px0) => { const px = px0 * (1 + (rnd() - 0.5) * 0.01); return { symbol: sym, price: String(px.toFixed(4)), score, rsi: 30 + rnd() * 40, adx: 15 + rnd() * 30, atr: px * 0.015, change24h: (rnd() - 0.4) * 8, volume: 1e8 + rnd() * 5e8,
    volumeStrength: '高', macdHist: (rnd() - 0.5) * px * 0.01, momentum: 3, trend: score > 50 ? '看漲' : '看跌', ema20: String(px * 0.995), ema50: String(px * 0.98), ema200: String(px * 0.93),
    bb: { upper: px * 1.035, lower: px * 0.965, mid: px, width: 7, pctB: rnd() }, signal15m: score > 50 ? 'bull' : 'bear', h1Signal: score > 50 ? 'bull' : 'bear', h4Signal: score > 50 ? 'bull' : 'bear', dailySignal: score > 50 ? 'bull' : 'bear', weeklySignal: 'bull',
    h4SwingHigh: px * 1.08, h4SwingLow: px * 0.962, h4Adx: 25 + rnd() * 20, h1Rsi: 40 + rnd() * 35, h4Rsi: 55, dayStruct: { dir: 'up', hh: true, hl: true, lastHigh: px * 1.1, lastLow: px * 0.94, r2: 0.7, pivots: 6 }, h4Struct: { dir: 'up', hh: true, hl: true, lastHigh: px * 1.08, lastLow: px * 0.96, r2: 0.6, pivots: 5 },
    struct15: { dir: 'up', pivots: 5 }, nakedK: { tags: [], bullEngulf: false }, wickSupports: [{ level: px * 0.975, wicks: 2 }], wickResistances: [{ level: px * 1.05, wicks: 2 }], derivData: { fundingRate: 0.0001, takerBuySell: 1.05, topLongRatio: 0.55, openInterest: 5e7 + rnd() * 1e7, lsRatio: 1.2 },
    h1Brk: rnd() < 0.15 ? { dir: score > 50 ? 'bull' : 'bear', lvl: score > 50 ? px * 1.004 : px * 0.996, atr: px * 0.012, age: 0 } : null, h1Atr: px * 0.012 }; };
  window.__px = {}; const syms = ['BTC/USDT', 'ETH/USDT']; for (let i = 0; i < 118; i++) syms.push(`C${i}/USDT`); for (const s2 of syms) window.__px[s2] = 1 + rnd() * 300;
  window.__scores = {}; for (const s2 of syms) window.__scores[s2] = Math.round(20 + rnd() * 60);
  window.__gen = () => syms.map(s2 => { window.__px[s2] *= 1 + (rnd() - 0.5) * 0.02; return window.__mk(s2, window.__scores[s2], window.__px[s2]); });
  state.data = window.__gen();
  isSignalMaster = () => true; _macroCache = { fg: { value: '60' }, btcDominance: 55, marketCapChange: 1 }; _macroCacheAt = now;
  fetchMarketData = async () => ({ data: window.__gen(), source: 'binance' });
  fetchKlinesSmart = async (s2, tf, limit) => Array.from({ length: limit }, (_, i) => { const t = now - (limit - i) * 3600e3; const px = 100 + Math.sin(i / 4) * 3; return [t, String(px), String(px + 1), String(px - 1), String(px + 0.3), '1000', t + 3599e3, '100000', 100, '500', '50000', '0']; });
  fetchKlinesExec = fetchKlinesSmart; fetchKlines = fetchKlinesSmart;
  fetchMTFKlines = async () => ({ '1h': { raw: Array.from({ length: 60 }, (_, i) => [i, '100', '101', '99', '100.5', '10', i, '1', 1, '1', '1', '0']) } });
  for (const c of state.data) _scanFetchCache[c.symbol] = { ts: now, deriv: c.derivData, whale: null };
  const tl = []; for (let i = 0; i < 200; i++) { const st = i < 8 ? 'pending' : i < 14 ? 'open' : 'closed'; const r = rnd() > 0.5 ? 1.4 : -1;
    tl.push({ id: 't' + i, symbol: state.data[i % 120].symbol, direction: 'long', status: st, outcome: st === 'closed' ? (r > 0 ? 'tp1' : 'sl') : null, pnlR: st === 'closed' ? r : null, entry: 100, entryPrice: 100, sl: 98.5, baseSl: 98.5, tp1: 102, tp2: 104, conf: 70, rr1: 1.33, rr2: 2.67, timestamp: now - i * 7200e3, entryTime: st !== 'pending' ? now - i * 7200e3 + 600e3 : null, exitTime: st === 'closed' ? now - i * 7200e3 + 7200e3 : null, telegramSent: true, cancelNotifySent: true, tradeType: 'directional', entryMode: 'stop', btProb: 0.6 + rnd() * 0.2 }); }
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(tl)); _tlogRaw = null; _tlogArr = null; invalidateLearnCache?.();
  const s3 = loadSettings(); s3.refreshInterval = 3; s3.scalpEnabled = true; s3.notifTelegram = false; saveSettings(s3); state.settings = loadSettings();
  state.currentPage = 'dashboard';
  startRefreshCycle();
});
const sample = async (label) => {
  const m = (await cdp.send('Performance.getMetrics')).metrics.reduce((a, x) => { a[x.name] = x.value; return a; }, {});
  const inpage = await p.evaluate(() => {
    let lsBytes = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); lsBytes += (localStorage.getItem(k) || '').length + k.length; }
    const big = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); big.push([k, (localStorage.getItem(k) || '').length]); } big.sort((a, b2) => b2[1] - a[1]);
    const sz = o => { try { return Object.keys(o).length; } catch(e) { return -1; } };
    return { lsKB: Math.round(lsBytes / 1024), top: big.slice(0, 5).map(([k, v]) => `${k}:${Math.round(v / 1024)}K`).join(' '), timers: window.__timers,
      caches: { setup: sz(_tradeSetupCache), scanFetch: sz(_scanFetchCache), kline: typeof _klineCache !== 'undefined' ? _klineCache.size : -1, slMoved: _slMovedAt.size, slBuf: _slNotifBuf.size, ttPlan: sz(_ttPlanCache), oiHist: sz(_oiHist), sbxHist: sz(_sbxHist), oiWatch: sz(_oiWatchCache), scalpK: sz(_scalpKlineCache), boot: _bootTraceArr.length, sigEv: sz(_sigEvCache), biasProven: sz(_biasProvenCache) },
      logs: { tl: loadTradeLog().length, sl: (typeof loadScalpLog === 'function' ? loadScalpLog().length : -1), lab: (typeof loadAILab === 'function' ? loadAILab().length : -1) } };
  });
  const row = { t: label, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents, frames: m.Frames, layout: Math.round(m.LayoutCount), ...inpage };
  console.log(JSON.stringify(row)); return row;
};
const rows = [await sample('0s')];
const end = Date.now() + MIN * 60e3; let n = 1;
while (Date.now() < end) { await new Promise(r => setTimeout(r, 20000)); rows.push(await sample(`${n * 20}s`)); n++; }
await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); rows.push(await sample('after GC'));
const f = rows[1] || rows[0], l = rows[rows.length - 2];
console.log(`\nΔ heap ${(l.heapMB - f.heapMB).toFixed(1)}MB  nodes ${l.nodes - f.nodes}  listeners ${l.listeners - f.listeners}  timers to ${f.timers.to}→${l.timers.to} iv ${f.timers.iv}→${l.timers.iv}  lsKB ${f.lsKB}→${l.lsKB}`);
console.log('errors:', errs.length ? errs.slice(0, 12) : 'none');
fs.writeFileSync('/tmp/claude-0/-home-user-123/ae07c8bb-db0f-5a8a-95fc-814a45691119/scratchpad/soak_out.json', JSON.stringify(rows, null, 1));
await b.close();
