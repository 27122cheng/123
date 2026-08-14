/* ── 外部風險溫度代理（Vercel Serverless Function）─────────────────
   為什麼需要伺服器端：美股期指（ES/NQ）、美元指數 DXY、VIX 沒有
   允許瀏覽器直連的免費來源——Yahoo Finance 擋 CORS、Stooq 沒有
   CORS 標頭。由此函式在伺服器端抓取並轉為同源回應。

   資料源（全部免費、無需金鑰）：
     · Yahoo Finance chart API（主要）：^GSPC/ES=F/NQ=F/DX-Y.NYB/^VIX
     · Stooq CSV（備援）：無金鑰、無限速，但只有日線收盤
   使用者若自備金鑰（Twelve Data / Finnhub 等），可在設定頁填入，
   前端會改帶 ?key=&provider= 走該來源——本函式僅在收到時使用，
   不儲存任何金鑰。

   回應：{ ok, at, quotes: { spx, nq, dxy, vix }, src }
   每項 quote：{ price, chgPct, chg30mPct, prevClose }
   任一項失敗只會讓該項為 null，不影響其他項；全失敗回 ok:false，
   前端一律降級（外部證據不參與投票），不影響任何既有功能。 */

const SYMBOLS = {
  nq:  { y: 'NQ=F',      stooq: 'nq.f',  label: '納指期貨' },
  spx: { y: 'ES=F',      stooq: 'es.f',  label: '標普期貨' },
  dxy: { y: 'DX-Y.NYB',  stooq: 'dx.f',  label: '美元指數' },
  vix: { y: '^VIX',      stooq: '^vix',  label: 'VIX' },
};

let _cache = { at: 0, body: null };
const TTL_MS = 5 * 60 * 1000;   // 5 分鐘：分鐘級交易夠用，也遠低於來源限速

async function fetchYahoo(sym) {
  // range=1d&interval=5m：拿得到當日 5 分鐘序列 → 可算 30 分鐘變化
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`
            + `?range=1d&interval=5m&includePrePost=true`;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; crypto-scan/1.0)' },
    });
    clearTimeout(tm);
    if (!r.ok) return null;
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;
    const meta = res.meta || {};
    const closes = ((res.indicators || {}).quote || [{}])[0].close || [];
    const valid = closes.filter(v => typeof v === 'number' && isFinite(v));
    const price = (typeof meta.regularMarketPrice === 'number' && isFinite(meta.regularMarketPrice))
      ? meta.regularMarketPrice : (valid.length ? valid[valid.length - 1] : null);
    if (price == null) return null;
    const prevClose = (typeof meta.chartPreviousClose === 'number') ? meta.chartPreviousClose
                    : (typeof meta.previousClose === 'number') ? meta.previousClose : null;
    // 30 分鐘變化：5m 間隔往回 6 根
    let chg30mPct = null;
    if (valid.length >= 7) {
      const past = valid[valid.length - 7];
      if (past > 0) chg30mPct = +(((price - past) / past) * 100).toFixed(3);
    }
    const chgPct = (prevClose > 0) ? +(((price - prevClose) / prevClose) * 100).toFixed(3) : null;
    return { price: +price.toFixed(4), chgPct, chg30mPct, prevClose };
  } catch (_e) { clearTimeout(tm); return null; }
}

async function fetchStooq(sym) {
  // 備援：日線收盤，只夠算「當日漲跌」，沒有 30 分鐘變化
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tm);
    if (!r.ok) return null;
    const txt = await r.text();
    const lines = txt.trim().split('\n');
    if (lines.length < 2) return null;
    const cols = lines[1].split(',');
    const open = parseFloat(cols[3]), close = parseFloat(cols[6]);
    if (!isFinite(close)) return null;
    const chgPct = (isFinite(open) && open > 0) ? +(((close - open) / open) * 100).toFixed(3) : null;
    return { price: close, chgPct, chg30mPct: null, prevClose: isFinite(open) ? open : null };
  } catch (_e) { clearTimeout(tm); return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=120');
  const now = Date.now();
  if (_cache.body && now - _cache.at < TTL_MS) {
    res.status(200).json({ ..._cache.body, cached: true });
    return;
  }
  const keys = Object.keys(SYMBOLS);
  const quotes = {};
  const srcUsed = {};
  await Promise.all(keys.map(async (k) => {
    const s = SYMBOLS[k];
    let q = await fetchYahoo(s.y);
    if (q) { srcUsed[k] = 'yahoo'; }
    else { q = await fetchStooq(s.stooq); if (q) srcUsed[k] = 'stooq'; }
    quotes[k] = q || null;
  }));
  const okN = keys.filter(k => quotes[k]).length;
  const body = { ok: okN > 0, at: now, quotes, src: srcUsed, okN };
  if (okN > 0) _cache = { at: now, body };
  res.status(200).json(body);
};
