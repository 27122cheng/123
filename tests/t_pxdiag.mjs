import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof _priceSpaceText === 'function', { timeout: 15000 });
const r = await p.evaluate(() => {
  const coin = { symbol: 'WLD/USDT', price: '0.5602', score: 70, rsi: 60, adx: 30, trend: '看漲', change24h: 3, volume: 1e8, ema20: '0.55', ema50: '0.54', ema200: '0.5' };
  const setup = { entry: 0.560152, sl: 0.549497, tp1: 0.581423, tp2: 0.592115, rr1: 2, rr2: 3, conf: 76, entryMode: 'stop', canScaleIn: false, entryReasons: [], sqGrade: 'A', sqScore: 16 };
  const s = loadSettings(); s.mainPriceSrc = 'pionex_perp'; saveSettings(s);
  _pionexPx = { at: 0, prices: {}, perp: {} };
  _mainPx('WLD/USDT', 0.5602);   // 退回 → 記下原因
  const noQuote = buildTelegramText(coin, 'long', { ...setup, priceSrc: 'okx' }, _macroCache, '');
  _pionexPx = { at: Date.now(), prices: { 'WLD/USDT': 0.5601 }, perp: {}, err: { spot: null, perp: 'HTTP 403' } };
  _mainPx('WLD/USDT', 0.5602);
  const spotOnly = buildTelegramText(coin, 'long', { ...setup, priceSrc: 'pionex' }, _macroCache, '');
  _pionexPx = { at: Date.now(), prices: {}, perp: { 'WLD/USDT': 0.56 } };
  const perp = buildTelegramText(coin, 'long', { ...setup, priceSrc: 'pionex_perp' }, _macroCache, '');
  s.mainPriceSrc = 'okx'; saveSettings(s);
  return { noQuote: noQuote.match(/💱[^\n]*/)?.[0], spotOnly: spotOnly.match(/💱[^\n]*/)?.[0], perp: perp.match(/💱[^\n]*/)?.[0], footer: perp.match(/🖥[^\n]*/)?.[0] };
});
if (!/OKX（⚠️ 設定為 Pionex 合約，但未套用：Pionex 報價尚未抓到/.test(r.noQuote)) throw new Error('未抓到時應說明原因：' + r.noQuote);
if (!/Pionex 現貨報價（該幣無合約報價：.*合約 0 個.*HTTP 403/.test(r.spotOnly)) throw new Error('退現貨時應說明：' + r.spotOnly);
if (!/Pionex 永續合約報價/.test(r.perp) || !/🖥 .* · v\d{8}[a-z]/.test(r.footer)) throw new Error('合約／頁尾錯誤：' + JSON.stringify(r));
console.log('✓ 訊息自我診斷：\n   ' + r.noQuote + '\n   ' + r.spotOnly + '\n   ' + r.perp + '\n   ' + r.footer);
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_pxdiag'); await b.close();
