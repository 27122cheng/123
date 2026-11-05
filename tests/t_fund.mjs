import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* 基本面層（DefiLlama／CoinPaprika／穩定幣／mempool，CoinGecko 備援）、OKX 成交→K 線足跡備援、OKX 清算 REST 備援併入緩衝、交易員總覽卡 */
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof fetchFundamentalsAll === 'function' && typeof renderTraderBrief === 'function' && typeof fundFor === 'function', { timeout: 20000 });

// 假資料路由：外部來源全部由 stub 回應；幣安一律 451（模擬地區封鎖）
await p.evaluate(() => {
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  window.__hits = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url); window.__hits.push(u.slice(0, 60));
    if (u.includes('api.llama.fi/protocols')) return Promise.resolve(J([
      { name: 'Uniswap', symbol: 'UNI', slug: 'uniswap', tvl: 4.0e9, change_7d: 12, change_1d: 1, mcap: 5.0e9, category: 'Dexs', gecko_id: 'uniswap' },
      { name: 'Uniswap V2', symbol: 'UNI', slug: 'uniswap-v2', tvl: 1.0e9, change_7d: -2, mcap: 5.0e9, category: 'Dexs' },
      { name: 'Aave', symbol: 'AAVE', slug: 'aave', tvl: 2.0e10, change_7d: -15, mcap: 3.0e9, category: 'Lending', gecko_id: 'aave' },
      { name: 'Nothing', symbol: '-', tvl: 1 },
    ]));
    if (u.includes('api.llama.fi/overview/fees')) { const rev = u.includes('dailyRevenue'); return Promise.resolve(J({ protocols: [ { name: 'Uniswap', slug: 'uniswap', total24h: rev ? 0 : 2.5e6, total7d: rev ? 0 : 1.6e7, total30d: rev ? 0 : 7.0e7, change_1m: 35 }, { name: 'Aave', slug: 'aave', total24h: 1e6, total7d: 6e6, total30d: rev ? 1.2e7 : 2.5e7, change_1m: -30 } ] })); }
    if (u.includes('api.coinpaprika.com/v1/tickers')) return Promise.resolve(J([
      { id: 'uni-uniswap', name: 'Uniswap', symbol: 'UNI', rank: 20, circulating_supply: 6.0e8, total_supply: 1.0e9, max_supply: 1.0e9, quotes: { USD: { price: 8.3, volume_24h: 4.0e8, market_cap: 5.0e9, percent_change_7d: 4, percent_change_30d: -3, percent_from_price_ath: -82 } } },
      { id: 'uni-fake', name: 'Fake UNI', symbol: 'UNI', rank: 2000, circulating_supply: 1, total_supply: 1, quotes: { USD: { price: 1, volume_24h: 1, market_cap: 10, percent_change_7d: 0, percent_from_price_ath: -99 } } },
      { id: 'aave', name: 'Aave', symbol: 'AAVE', rank: 40, circulating_supply: 1.5e7, total_supply: 1.6e7, max_supply: 1.6e7, quotes: { USD: { price: 200, volume_24h: 2.0e7, market_cap: 3.0e9, percent_change_7d: -8, percent_change_30d: -20, percent_from_price_ath: -70 } } },
      { id: 'btc', name: 'Bitcoin', symbol: 'BTC', rank: 1, circulating_supply: 1.98e7, total_supply: 1.98e7, max_supply: 2.1e7, quotes: { USD: { price: 100000, volume_24h: 5.0e10, market_cap: 2.0e12, percent_change_7d: 2, percent_change_30d: 5, percent_from_price_ath: -8 } } },
      { id: 'newcoin', name: 'NewCoin', symbol: 'NEWX', rank: 300, circulating_supply: 1.0e8, total_supply: 1.0e9, max_supply: 1.0e9, quotes: { USD: { price: 1, volume_24h: 5.0e5, market_cap: 1.0e8, percent_change_7d: -30, percent_from_price_ath: -95 } } },
    ]));
    if (u.includes('stablecoins.llama.fi')) return Promise.resolve(J({ peggedAssets: [ { name: 'USDT', circulating: { peggedUSD: 1.2e11 }, circulatingPrevWeek: { peggedUSD: 1.19e11 }, circulatingPrevMonth: { peggedUSD: 1.15e11 } }, { name: 'USDC', circulating: { peggedUSD: 4.0e10 }, circulatingPrevWeek: { peggedUSD: 3.98e10 }, circulatingPrevMonth: { peggedUSD: 3.9e10 } } ] }));
    if (u.includes('mempool.space/api/v1/mining/hashrate')) return Promise.resolve(J({ hashrates: [ { timestamp: 1, avgHashrate: 8.0e20 } ], currentHashrate: 8.4e20, currentDifficulty: 1.2e14 }));
    if (u.includes('coingecko.com')) return Promise.resolve(J([]));
    if (/binance\.(com|vision)/.test(u) || u.includes('/api/relay')) return Promise.resolve(new Response('', { status: 451 }));
    return realFetch(url, opts);
  };
  // OKX 走 okxApiFetch：直接換成 stub
  window.__okxCalls = [];
  const trades = []; const t0 = Date.now() - 3600e3;
  for (let i = 0; i < 500; i++) trades.push({ instId: 'ABC-USDT-SWAP', tradeId: String(i), px: String(100 + Math.sin(i / 20) * 2), sz: String(1 + (i % 3)), side: i % 5 < 3 ? 'buy' : 'sell', ts: String(t0 + i * 7000) });
  okxApiFetch = async (path, params) => {
    window.__okxCalls.push(path);
    if (path === 'market/trades') return { json: { code: '0', data: trades } };
    if (path === 'public/instruments') return { json: { code: '0', data: [ { instId: 'ABC-USDT-SWAP', ctVal: '10' } ] } };
    if (path === 'public/liquidation-orders') return { json: { code: '0', data: [ { instId: 'ABC-USDT-SWAP', details: [ { bkPx: '100', sz: '500', posSide: 'short', side: 'buy', ts: String(Date.now() - 60e3), bkLoss: '100' }, { bkPx: '99', sz: '50', posSide: 'long', side: 'sell', ts: String(Date.now() - 120e3) }, { bkPx: '98', sz: '1', posSide: 'long', side: 'sell', ts: String(Date.now() - 3 * 3600e3) } ] } ] } };
    return { json: { code: '0', data: [] } };
  };
  localStorage.setItem('csp_pairs', JSON.stringify([{ s: 'UNI/USDT' }, { s: 'AAVE/USDT' }, { s: 'NEWX/USDT' }, { s: 'ABC/USDT' }]));
  localStorage.removeItem('csp_fund'); _fundCache = null;
});

// ① 抓取＋合併：三個第一選擇來源；同代號取 TVL／市值最大；只保留清單幣；穩定幣與算力進 macro；資料鮮度 fund 標記
const r1 = await p.evaluate(async () => { const c = await fundRefresh(true); const f = _feedAt.fund; return { n: Object.keys(c.coins).length, uni: c.coins.UNI, aave: c.coins.AAVE, btc: !!c.coins.BTC, src: c.src, errs: c.errs, macro: c.macro, feed: f && { ok: f.ok, note: f.note }, hits: window.__hits.filter(h => /llama|paprika|mempool/.test(h)).length }; });
if (!r1.uni || r1.uni.llamaName !== 'Uniswap' || r1.uni.tvl !== 4.0e9 || r1.uni.fees30d !== 7.0e7 || r1.uni.feesChg1m !== 35 || r1.uni.circ !== 6.0e8 || r1.uni.athDist !== -82 || r1.uni.name !== 'Uniswap' || !r1.btc || r1.n < 4 || !r1.macro.stable || Math.abs(r1.macro.stable.chg7d - 0.75) > 0.1 || !r1.macro.btc || !r1.feed || !r1.feed.ok || r1.errs.length) throw new Error('① 基本面抓取錯誤：' + JSON.stringify(r1));
console.log(`✓ ① 基本面抓取：${r1.n} 幣（${r1.src.join('、')}）；UNI 手續費 30 日 ${r1.uni.fees30d / 1e6}M、月增 ${r1.uni.feesChg1m}%、TVL ${r1.uni.tvl / 1e9}B；穩定幣 7 日 +${r1.macro.stable.chg7d}%；鮮度「${r1.feed.note.slice(0, 40)}」`);

// ② 評分與證據：UNI 強（手續費便宜、月增、TVL 流入、流通高、距 ATH 遠 −1）；NEWX 弱（FDV 10×、流動性薄、−95%）；BTC 中性偏強
const r2 = await p.evaluate(() => { const u = fundFor('UNI/USDT'), n = fundFor('NEWX/USDT'), btc = fundFor('BTC/USDT'), none = fundFor('ZZZ/USDT'); return { u: u && { score: u.score, label: u.label, pf: u.m.pf, ev: u.ev.map(e => e.txt) }, n: n && { score: n.score, label: n.label, fdv: n.m.fdvMcap, ev: n.ev.filter(e => e.pts < 0).map(e => e.txt) }, btc: btc && { score: btc.score, label: btc.label }, none, line: fundLine(u), snapL: fundSnapshot('UNI/USDT', true), snapS: fundSnapshot('NEWX/USDT', false), html: fundHtml('UNI/USDT').includes('基本面') && fundHtml('ZZZ/USDT').includes('無資料') }; });
if (!r2.u || r2.u.label !== 'strong' || !(r2.u.pf > 5 && r2.u.pf < 7) || !r2.n || r2.n.label !== 'weak' || r2.n.fdv !== 10 || r2.none !== null || !r2.line.includes('🏛 基本面：強') || r2.snapL.al !== 'aligned' || r2.snapS.al !== 'aligned' || !r2.html) throw new Error('② 評分錯誤：' + JSON.stringify(r2));
console.log(`✓ ② 評分：UNI ${r2.u.label} ${r2.u.score}（市值／年化手續費 ${r2.u.pf}×）；NEWX ${r2.n.label} ${r2.n.score}（${r2.n.ev.slice(0, 2).join('、')}）；BTC ${r2.btc.label}；訊息「${r2.line.trim().slice(0, 50)}…」`);

// ③ 研究特徵、實驗登錄、研究台分組
const r3 = await p.evaluate(() => ({ feats: expFeatures({ direction: 'long', fund: fundSnapshot('NEWX/USDT', true) }, 'main').filter(x => x.d === 'fund').map(x => x.k), ids: EXP_REGISTRY.filter(h => h.key.startsWith('fund:')).map(h => h.id), grp: _RS_GROUPS.main.some(g => g.t === '基本面'), dim: EXP_DIM_LABEL.fund }));
if (!r3.feats.includes('fund:al:against') || !r3.feats.includes('fund:fdv:high') || r3.ids.length !== 2 || !r3.grp || r3.dim !== '基本面') throw new Error('③ 研究特徵錯誤：' + JSON.stringify(r3));
console.log(`✓ ③ 研究特徵 ${r3.feats.join('、')}；登錄 ${r3.ids.join('、')}；研究台「基本面」組`);

// ④ 足跡備援：幣安 451 → OKX 500 筆成交分桶（7 秒一筆 ≈ 58 分鐘 → 12 個 5m 桶）→ fetchFootprintData 成功且來源標註
const r4 = await p.evaluate(async () => { const k = await _okxTradesKlines('ABC/USDT'); const fp = await fetchFootprintData('ABC/USDT'); return { k5: k && k.k5.length, k1: k && k.k1.length, buy: k && k.k5[0][9] > 0 && k.k5[0][9] <= k.k5[0][5], fp: fp && { deltaDir: fp.deltaDir, vwap: +fp.vwap.toFixed(2), tbr: fp.takerBuyRatio }, note: _feedAt.fp && _feedAt.fp.note, calls: window.__okxCalls.filter(x => x === 'market/trades').length }; });
if (!r4.k5 || r4.k5 < 10 || !r4.buy || !r4.fp || !/okx-trades/.test(r4.note)) throw new Error('④ 足跡備援錯誤：' + JSON.stringify(r4));
console.log(`✓ ④ 足跡備援：OKX 成交 → ${r4.k5} 個 5m 桶／${r4.k1} 個 1m 桶；Delta ${r4.fp.deltaDir}、VWAP ${r4.fp.vwap}；鮮度「${r4.note}」`);

// ⑤ 清算備援：OKX 強平單（ctVal 10）→ 名目 = 100×500×10 = 50 萬；併入緩衝去重；liqStats 判空單被清為主（short dom）
const r5 = await p.evaluate(async () => { const list = await okxLiqFetch('ABC/USDT'); const n1 = _liqMergeRest(list); const n2 = _liqMergeRest(list); const st = liqStats('ABC/USDT'); return { n: list.length, usd0: list[0] && list[0].usd, side0: list[0] && list[0].side, n1, n2, st, note: _feedAt.liqrest && _feedAt.liqrest.note }; });
if (r5.n !== 3 || r5.usd0 !== 500000 || r5.side0 !== 'short' || r5.n1 !== 2 || r5.n2 !== 0 || r5.st.dom !== 'short' || r5.st.shortUsd !== 500000) throw new Error('⑤ 清算備援錯誤：' + JSON.stringify(r5));
console.log(`✓ ⑤ 清算備援：${r5.n} 筆解析、併入 ${r5.n1}（60 分鐘內）、重複 0；30 分統計 空單被清 $${r5.st.shortUsd}（dom=${r5.st.dom}）`);

// ⑥ 交易員總覽卡：五個區塊、含基本面資料時間；60 秒快取；強制重繪
const r6 = await p.evaluate(() => { localStorage.setItem('csp_scan_funnel', JSON.stringify({ at: Date.now(), candidates: 100, built: 0, gates: { minConf: 65, minSq: 14, minRR: 1.2 }, rejects: { 'ℹ️ 機會品質排序前3（|評分−50|＋確信度對齊×0.8）：UNI 80、AAVE 77': 0, '↓ 低品質時段': 50, '回踩限價單已停用（回測：閘門後期望 −0.02R）': 34, '4H ADX 17 <20 無趨勢（回測：期望 +0.02R）': 5, '4H ADX 12 <20 無趨勢（回測：期望 +0.02R）': 7, '評分中性(50)': 19 } })); renderTraderBrief(true); const el = document.getElementById('trader-brief-body'); const t = el.textContent; return { boxes: el.querySelectorAll('.tb-box').length, has: ['市場', '本輪判斷', '持倉與掛單', '績效與回撤', '系統'].every(k => t.includes(k)), top: /最接近出手：UNI 80/.test(t), hard: /沒出手的主因：/.test(t) && /4H ADX <20 無趨勢 12/.test(t), fund: /基本面 \d+ 幣/.test(t) }; });
if (r6.boxes !== 5 || !r6.has || !r6.top || !r6.hard || !r6.fund) throw new Error('⑥ 總覽卡錯誤：' + JSON.stringify(r6));
console.log(`✓ ⑥ 交易員總覽：${r6.boxes} 區塊；最接近出手與沒出手主因（ADX 分桶合併）、基本面資料時間`);

await p.evaluate(() => { localStorage.removeItem('csp_fund'); localStorage.removeItem('csp_pairs'); localStorage.removeItem('csp_scan_funnel'); });
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_fund');
await b.close();
