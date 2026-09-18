/* ── Pionex 現貨報價代理（Vercel Serverless Function）──────────────
   使用者的一般單（長線／短線）在 Pionex 執行，快速單在 OKX。一般單的
   進場／止損／止盈若用 OKX 價位，掛到 Pionex 會差幾個 tick——結構沒錯但
   數字對不上。Pionex 公開行情端點不保證允許瀏覽器跨域，由此函式在伺服器
   端一次抓全部 tickers、10 秒共用快取，前端每輪掃描只打一次。
   僅轉發公開行情，不碰任何帳戶／交易端點。
   回應：{ ok, at, n, prices: { 'BTC/USDT': 63847.6, ... }, cached } */

let _cache = { at: 0, body: null };
const TTL_MS = 10 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=5');
  const now = Date.now();
  if (_cache.body && now - _cache.at < TTL_MS) {
    res.status(200).json({ ..._cache.body, cached: true });
    return;
  }
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://api.pionex.com/api/v1/market/tickers', {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; crypto-scan/1.0)' },
    });
    clearTimeout(tm);
    if (!r.ok) { res.status(200).json({ ok: false, at: now, n: 0, prices: {}, err: 'HTTP ' + r.status }); return; }
    const j = await r.json();
    const list = (j && j.data && Array.isArray(j.data.tickers)) ? j.data.tickers : (Array.isArray(j && j.data) ? j.data : []);
    const prices = {}, perp = {};
    for (const t of list) {
      const sym = String(t.symbol || '');
      const px = parseFloat(t.close ?? t.last ?? t.price);
      if (!(isFinite(px) && px > 0)) continue;
      /* 永續合約：Pionex 的合約代號未在公開文件固定下來，這裡同時接受常見寫法
         （BTC_USDT_PERP／BTC.PERP_USDT／BTC_USDT.PERP／type 欄位含 PERP），
         全部歸一成 'BTC/USDT'；沒有任何合約 ticker 時 perp 為空表，前端退回現貨。 */
      const isPerp = /PERP|SWAP/i.test(sym) || /PERP|SWAP/i.test(String(t.type || t.category || ''));
      if (isPerp) {
        const base = sym.replace(/[._-]?(PERP|SWAP)[._-]?/i, '_').replace(/__+/g, '_').replace(/^_|_$/g, '');
        if (base.endsWith('_USDT')) perp[base.replace('_USDT', '/USDT')] = px;
        continue;
      }
      if (!sym.endsWith('_USDT')) continue;
      prices[sym.replace('_USDT', '/USDT')] = px;
    }
    const body = { ok: Object.keys(prices).length > 0 || Object.keys(perp).length > 0, at: now,
      n: Object.keys(prices).length, nPerp: Object.keys(perp).length, prices, perp };
    if (body.ok) _cache = { at: now, body };
    res.status(200).json(body);
  } catch (e) {
    clearTimeout(tm);
    res.status(200).json({ ok: false, at: now, n: 0, prices: {}, err: String((e && e.message) || e) });
  }
};
