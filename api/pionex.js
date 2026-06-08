// Vercel Serverless Function — Pionex Signing Proxy (CommonJS)
// Browser POSTs {key, secret, method, path, queryStr, bodyStr} as JSON.
// Proxy computes HMAC-SHA256, forwards the real request to Pionex.
// This avoids CORS custom-header forwarding issues entirely.
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

module.exports = async function handler(req, res) {
  try {
    await _handle(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ result: false, message: `Proxy crash: ${err.message}` });
    }
  }
};

async function _handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Read request body
  const raw = await new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch (_) {
    return res.status(400).json({ result: false, message: 'Invalid JSON body' });
  }

  // Ping mode: test connectivity to Pionex public API without auth
  if (payload.ping) {
    return await new Promise((resolve) => {
      const proxyReq = https.request({
        hostname: 'api.pionex.com',
        path: '/api/v1/common/symbols?limit=1',
        method: 'GET',
        headers: { 'Host': 'api.pionex.com' },
      }, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          res.json({ result: true, message: `Pionex 公開 API 連線正常 (HTTP ${proxyRes.statusCode})` });
          resolve();
        });
      });
      proxyReq.on('error', (err) => {
        res.status(502).json({ result: false, message: `無法連線到 Pionex: ${err.message}` });
        resolve();
      });
      proxyReq.end();
    });
  }

  const { key, secret, method, path, queryStr = '', bodyStr = '' } = payload;
  if (!key || !secret || !method || !path) {
    return res.status(400).json({ result: false, message: 'Missing required fields' });
  }

  // Sign on the server side — no custom headers from browser needed
  const ts = Date.now().toString();
  const msg = ts + method + path + (queryStr || bodyStr);
  const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');

  const targetUrl = 'https://api.pionex.com' + path + queryStr;
  const parsed = new URL(targetUrl);

  const fwdHeaders = {
    'Host':               parsed.hostname,
    'Content-Type':       'application/json',
    'X-PIONEX-KEY':       key,
    'X-PIONEX-SIGNATURE': sig,
    'X-PIONEX-TIMESTAMP': ts,
  };
  if (bodyStr) fwdHeaders['Content-Length'] = String(Buffer.byteLength(bodyStr));

  const options = {
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method,
    headers:  fwdHeaders,
  };

  await new Promise((resolve) => {
    const proxyReq = https.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const data = Buffer.concat(chunks);
        res.status(proxyRes.statusCode);
        res.setHeader('Content-Type', 'application/json');
        // On errors, augment with debug info (never exposes secret)
        let pionexBody = {};
        try { pionexBody = JSON.parse(data.toString()); } catch(_) {}
        if (pionexBody.result === false) {
          res.json({
            result: false,
            message: `${pionexBody.message} [keyLen=${key.length} secretLen=${secret.length} url=${targetUrl}]`,
          });
        } else {
          res.send(data);
        }
        resolve();
      });
    });
    proxyReq.on('error', (err) => {
      res.status(502).json({ result: false, message: String(err) });
      resolve();
    });
    if (bodyStr) proxyReq.write(bodyStr);
    proxyReq.end();
  });
};
