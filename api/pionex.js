// Vercel Serverless Function — Pionex CORS Proxy (CommonJS)
const https = require('https');
const { URL } = require('url');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-PIONEX-KEY, X-PIONEX-SIGNATURE, X-PIONEX-TIMESTAMP');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // req.url is the full original path e.g. /api/pionex/api/v1/account/balances?...
  const afterPrefix = req.url.replace(/^\/api\/pionex/, '') || '/';
  const targetUrl = 'https://api.pionex.com' + afterPrefix;

  // Node.js lowercases all headers; restore original casing for Pionex
  const HEADER_MAP = {
    'content-type':        'Content-Type',
    'x-pionex-key':        'X-PIONEX-KEY',
    'x-pionex-signature':  'X-PIONEX-SIGNATURE',
    'x-pionex-timestamp':  'X-PIONEX-TIMESTAMP',
  };
  const fwdHeaders = {};
  for (const [lower, canonical] of Object.entries(HEADER_MAP)) {
    if (req.headers[lower]) fwdHeaders[canonical] = req.headers[lower];
  }

  // Collect request body
  const body = await new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const parsed = new URL(targetUrl);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: { ...fwdHeaders, 'Host': parsed.hostname },
  };
  if (body.length) options.headers['Content-Length'] = body.length;

  await new Promise((resolve) => {
    const proxyReq = https.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const data = Buffer.concat(chunks);
        res.status(proxyRes.statusCode);
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
        res.send(data);
        resolve();
      });
    });
    proxyReq.on('error', (err) => {
      res.status(502).json({ result: false, message: String(err) });
      resolve();
    });
    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
};
