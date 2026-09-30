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
  /* Pionex 的 tickers 端點預設只回現貨；永續合約要另外帶 type=PERP（合約代號如 BTC_USDT_PERP）。
     兩個請求並行、各自失敗不影響對方；另回傳樣本代號與錯誤，設定頁可直接看到抓到什麼。 */
  const pull = async (url) => {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; crypto-scan/1.0)' } });
      clearTimeout(tm);
      if (!r.ok) return { list: [], err: 'HTTP ' + r.status };
      const j = await r.json();
      const list = (j && j.data && Array.isArray(j.data.tickers)) ? j.data.tickers : (Array.isArray(j && j.data) ? j.data : []);
      return { list, err: (j && j.result === false) ? String(j.message || j.code || 'result=false') : null };
    } catch (e) { clearTimeout(tm); return { list: [], err: String((e && e.message) || e) }; }
  };
  const [spotR, perpR] = await Promise.all([
    pull('https://api.pionex.com/api/v1/market/tickers'),
    pull('https://api.pionex.com/api/v1/market/tickers?type=PERP'),
  ]);
  const prices = {}, perp = {};
  const norm = sym => sym.replace(/[._-]?(PERP|SWAP)[._-]?/i, '_').replace(/__+/g, '_').replace(/^_|_$/g, '');
  for (const t of spotR.list) {
    const sym = String(t.symbol || ''); const px = parseFloat(t.close ?? t.last ?? t.price);
    if (!(isFinite(px) && px > 0)) continue;
    if (/PERP|SWAP/i.test(sym)) { const b = norm(sym); if (b.endsWith('_USDT')) perp[b.replace('_USDT', '/USDT')] = px; continue; }
    if (sym.endsWith('_USDT')) prices[sym.replace('_USDT', '/USDT')] = px;
  }
  for (const t of perpR.list) {
    const sym = String(t.symbol || ''); const px = parseFloat(t.close ?? t.last ?? t.price);
    if (!(isFinite(px) && px > 0)) continue;
    const b = norm(sym);
    if (b.endsWith('_USDT')) perp[b.replace('_USDT', '/USDT')] = px;
  }
  const body = { ok: Object.keys(prices).length > 0 || Object.keys(perp).length > 0, at: now,
    n: Object.keys(prices).length, nPerp: Object.keys(perp).length, prices, perp,
    sample: { spot: spotR.list[0] ? String(spotR.list[0].symbol) : null, perp: perpR.list[0] ? String(perpR.list[0].symbol) : null },
    err: { spot: spotR.err, perp: perpR.err } };
  if (body.ok) _cache = { at: now, body };
  res.status(200).json(body);
};
