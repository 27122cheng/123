// Vercel Serverless Function — Pionex CORS Proxy
// 所有 /api/pionex/* 請求都會被轉發到 api.pionex.com
export default async function handler(req, res) {
  // 允許瀏覽器跨域請求
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-PIONEX-KEY, X-PIONEX-SIGNATURE, X-PIONEX-TIMESTAMP');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 取出 /api/pionex 後面的路徑（e.g. /api/v1/account/balances）
  const pionexPath = req.url.replace(/^\/api\/pionex/, '') || '/';
  const targetUrl  = 'https://api.pionex.com' + pionexPath;

  // 轉發 Pionex 認證標頭
  const forwardHeaders = {};
  for (const h of ['content-type', 'x-pionex-key', 'x-pionex-signature', 'x-pionex-timestamp']) {
    if (req.headers[h]) forwardHeaders[h] = req.headers[h];
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
    if (!body.length) body = undefined;
  }

  try {
    const upstream = await fetch(targetUrl, {
      method:  req.method,
      headers: forwardHeaders,
      body,
    });
    const data = await upstream.arrayBuffer();
    res.status(upstream.status)
       .setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
       .send(Buffer.from(data));
  } catch (err) {
    res.status(502).json({ result: false, message: String(err) });
  }
}
