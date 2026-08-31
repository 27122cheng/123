/* ── 加密宏觀代理（Vercel Serverless Function）─────────────────────
   為什麼需要伺服器端：加密大盤（CoinGecko /global）與恐慌貪婪指數
   （alternative.me）原本由瀏覽器直連。CoinGecko 的免費端點是「依來源 IP
   限速」，而使用者的分頁每輪掃描都在請求——一旦踩到 429，之後就長時間
   拿不到資料。使用者實例：資料鮮度頁顯示「加密大盤 15 小時前 · 過期」
   「恐慌貪婪 15 小時前 · 過期」，同一時間幣價與 K 線都還是秒級新鮮，
   正說明問題出在這兩個特定來源而不是網路。

   改由伺服器端抓有三個好處：
     ① 一個 IP、一份 5 分鐘快取，所有裝置共用 → 請求量從「每台每輪」
        降到「每 5 分鐘一次」，幾乎不可能再撞限速
     ② 沒有瀏覽器 CORS 限制
     ③ 兩個來源各自獨立，一個失敗不影響另一個

   回應：{ ok, at, global, fg, src, cached }
   任一項失敗只會讓該項為 null；前端保留直連為備援，兩邊都失敗才算沒資料。 */

let _cache = { at: 0, body: null };
const TTL_MS = 5 * 60 * 1000;

async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; crypto-scan/1.0)', Accept: 'application/json' },
    });
    clearTimeout(tm);
    if (!r.ok) return { err: 'HTTP ' + r.status };
    return { data: await r.json() };
  } catch (e) { clearTimeout(tm); return { err: String((e && e.message) || e) }; }
}

async function fetchGlobal() {
  const { data, err } = await getJson('https://api.coingecko.com/api/v3/global');
  if (err || !data || !data.data) return { v: null, err: err || 'bad_shape' };
  const d = data.data;
  return {
    v: {
      btcDominance:    +(d.market_cap_percentage?.btc || 0).toFixed(1),
      ethDominance:    +(d.market_cap_percentage?.eth || 0).toFixed(1),
      totalMarketCap:  d.total_market_cap?.usd ?? null,
      totalVolume:     d.total_volume?.usd ?? null,
      marketCapChange: d.market_cap_change_percentage_24h_usd != null
        ? +d.market_cap_change_percentage_24h_usd.toFixed(2) : null,
      activeCryptos:   d.active_cryptocurrencies ?? null,
    },
    err: null,
  };
}

async function fetchFng() {
  const { data, err } = await getJson('https://api.alternative.me/fng/?limit=1');
  const row = data && Array.isArray(data.data) ? data.data[0] : null;
  if (err || !row) return { v: null, err: err || 'bad_shape' };
  return { v: row, err: null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=120');
  const now = Date.now();
  if (_cache.body && now - _cache.at < TTL_MS) {
    res.status(200).json({ ..._cache.body, cached: true });
    return;
  }
  const [g, f] = await Promise.all([fetchGlobal(), fetchFng()]);
  const body = {
    ok: !!(g.v || f.v), at: now,
    global: g.v, fg: f.v,
    src: { global: g.v ? 'coingecko' : null, fg: f.v ? 'alternative.me' : null },
    err: { global: g.err, fg: f.err },
  };
  if (body.ok) _cache = { at: now, body };
  res.status(200).json(body);
};
