/* ── 加密新聞代理（Vercel Serverless Function）──────────────────────
   為什麼需要伺服器端：新聞 RSS 沒有 CORS 標頭，前端原本繞道 rss2json
   這類第三方轉換服務——免費額度小、常失效，結果就是「新聞 4 天沒更新
   也沒人發現」。改由伺服器端直接抓 RSS、最小化解析成 JSON，10 分鐘一份
   快取所有裝置共用；前端保留 rss2json / CoinGecko 為備援。

   回應：{ ok, at, items: [{ title, body, url, source, publishedAt }], src, cached }
   任一來源失敗只影響該來源；全失敗回 ok:false，前端自行降級。 */

const SOURCES = [
  { url: 'https://cointelegraph.com/rss',                    name: 'CoinTelegraph' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',  name: 'CoinDesk' },
  { url: 'https://decrypt.co/feed',                          name: 'Decrypt' },
];

let _cache = { at: 0, body: null };
const TTL_MS = 10 * 60 * 1000;

const strip = html => String(html || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? strip(m[1]) : '';
}

function parseRss(xml, sourceName) {
  const out = [];
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  for (const it of items.slice(0, 12)) {
    const title = tag(it, 'title');
    if (title.length <= 10) continue;
    const link = tag(it, 'link') || ((it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '');
    const pub = tag(it, 'pubDate') || tag(it, 'dc:date') || tag(it, 'published');
    const ts = pub ? Date.parse(pub) : NaN;
    out.push({
      title,
      body: (tag(it, 'description') || tag(it, 'content:encoded')).slice(0, 250),
      url: link,
      source: sourceName,
      publishedAt: isFinite(ts) ? ts : null,
    });
  }
  return out;
}

async function fetchRss(src) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; crypto-scan/1.0)', Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    });
    clearTimeout(tm);
    if (!r.ok) return [];
    return parseRss(await r.text(), src.name);
  } catch (_e) { clearTimeout(tm); return []; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=120');
  const now = Date.now();
  if (_cache.body && now - _cache.at < TTL_MS) {
    res.status(200).json({ ..._cache.body, cached: true });
    return;
  }
  const results = await Promise.all(SOURCES.map(fetchRss));
  const srcUsed = {};
  let items = [];
  results.forEach((arr, i) => { if (arr.length) { srcUsed[SOURCES[i].name] = arr.length; items = items.concat(arr); } });
  // 依發布時間新到舊；沒有時間戳的排最後
  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  items = items.slice(0, 20);
  const body = { ok: items.length >= 3, at: now, items, src: srcUsed };
  if (body.ok) _cache = { at: now, body };
  res.status(200).json(body);
};
