/* ── Pionex 同源代理（Vercel Serverless Function）─────────────────
   Pionex 公開 API 不允許瀏覽器跨域（CORS）直連，純前端打不到。
   前端改打同網域的 /api/pionex?path=market/klines&symbol=...，
   由此函式在伺服器端轉發，回應自帶同源身分，CORS 問題消失。
   僅允許轉發公開行情端點（allowlist），不碰任何帳戶/交易端點。 */

const ALLOW_PATHS = new Set([
  'market/klines',
  'market/tickers',
  'market/trades',
  'market/depth',
  'common/symbols',
]);

module.exports = async (req, res) => {
  const query = req.query || {};
  const path = query.path || '';
  if (!ALLOW_PATHS.has(path)) {
    res.status(400).json({ result: false, error: 'path not allowed' });
    return;
  }
  const qs = new URLSearchParams();
  for (const k of Object.keys(query)) {
    if (k !== 'path') qs.append(k, query[k]);
  }
  const q = qs.toString();
  const url = `https://api.pionex.com/api/v1/${path}${q ? '?' + q : ''}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    const body = await r.text();
    // 行情數據短快取：同一秒內多分頁/多請求共用，減輕 Pionex 限速壓力
    res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=8');
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ result: false, error: String((e && e.message) || e) });
  }
};
