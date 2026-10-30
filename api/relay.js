/* ── 公開行情同源轉發（Vercel Serverless Function）────────────────────
   為什麼需要：使用者的主機筆電所在網路擋掉瀏覽器直連幣安（fapi/api.binance.com）
   與 mempool.space——資料鮮度頁 8 項「尚未取得」全是直連的那幾個，走同源代理的
   （OKX／CoinGecko／新聞／場外）全部正常。前端先直連，失敗才打
   /api/relay?u=<完整網址>，由此函式在伺服器端轉發。
   只轉發白名單內的「公開行情」端點，不碰任何帳戶／交易端點；15 秒快取。 */

const ALLOW = [
  /^https:\/\/fapi\.binance\.com\/(fapi\/v1\/(fundingRate|openInterest|premiumIndex|aggTrades|klines|depth|ticker\/24hr)|futures\/data\/(openInterestHist|globalLongShortAccountRatio|topLongShortAccountRatio|takerlongshortRatio|takerBuySellVol))(\?|$)/,
  /^https:\/\/(api[1-3]?\.binance\.com|data-api\.binance\.vision)\/api\/v3\/(klines|aggTrades|ticker\/price|ticker\/24hr|depth|exchangeInfo)(\?|$)/,
  /^https:\/\/mempool\.space\/api\/blocks\/tip\/height$/,
  /^https:\/\/blockchain\.info\/q\/getblockcount$/,
  /^https:\/\/open-api\.coinglass\.com\/public\/v2\/liquidation_chart\?/,
];
const TTL_MS = 15 * 1000;
const _cache = new Map();   // url → { at, status, body }

function allowed(u) { return ALLOW.some(re => re.test(u)); }

module.exports = async (req, res) => {
  const u = String((req.query && req.query.u) || '');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-relay', '1');
  if (!allowed(u)) { res.status(400).json({ ok: false, err: 'url not allowed' }); return; }
  const now = Date.now();
  const hit = _cache.get(u);
  if (hit && now - hit.at < TTL_MS) { res.status(hit.status).setHeader('Content-Type', 'application/json').send(hit.body); return; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    let r = await fetch(u, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; crypto-scan/1.0)' } });
    /* 451＝幣安依伺服器所在地區拒絕（Vercel 預設美國區就是這樣；vercel.json 已改 hnd1）。
       現貨 /api/v3 端點另有官方不分地區的鏡像 data-api.binance.vision，451 時改走它；合約 fapi 沒有鏡像，只能靠區域設定。 */
    if (r.status === 451 && /^https:\/\/api[1-3]?\.binance\.com\/api\/v3\//.test(u)) {
      try { r = await fetch(u.replace(/^https:\/\/api[1-3]?\.binance\.com/, 'https://data-api.binance.vision'), { signal: ctrl.signal, headers: { Accept: 'application/json' } }); res.setHeader('x-relay-via', 'binance.vision'); } catch(_e) {}
    }
    clearTimeout(timer);
    const body = await r.text();
    if (r.status === 451) { res.status(451).json({ ok: false, err: 'upstream 451: 幣安拒絕此伺服器地區（請在 vercel.json 的 regions 改成非美國區，例如 hnd1／sin1／fra1）' }); return; }
    if (_cache.size > 500) _cache.clear();
    if (r.ok) _cache.set(u, { at: now, status: r.status, body });
    res.status(r.status).setHeader('Content-Type', 'application/json').send(body);
  } catch (e) {
    res.status(502).json({ ok: false, err: String(e && e.message || e).slice(0, 120) });
  }
};
module.exports.allowed = allowed;
