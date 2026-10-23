// api/relay.js 單元測試（Node，直接呼叫 handler；fetch 以假物件替代）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const relay = require('../api/relay.js');
const mkRes = () => { const r = { code: 0, hdr: {}, body: null, status(c) { r.code = c; return r; }, setHeader(k, v) { r.hdr[k] = v; return r; }, send(b) { r.body = b; return r; }, json(o) { r.body = JSON.stringify(o); return r; } }; return r; };
let calls = 0;
globalThis.fetch = async (u) => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify({ u, n: calls }) }; };
const ok = 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1';
if (!relay.allowed(ok) || relay.allowed('https://fapi.binance.com/fapi/v1/order') || relay.allowed('https://evil.com/api/v3/klines') || !relay.allowed('https://api.binance.com/api/v3/klines?symbol=BTCUSDT') || !relay.allowed('https://mempool.space/api/blocks/tip/height')) throw new Error('白名單判定錯誤');
const r1 = mkRes(); await relay({ query: { u: ok } }, r1); const r2 = mkRes(); await relay({ query: { u: ok } }, r2);
if (r1.code !== 200 || JSON.parse(r1.body).u !== ok || r2.body !== r1.body || calls !== 1) throw new Error('轉發／快取錯誤：' + JSON.stringify({ c1: r1.code, b1: r1.body, b2: r2.body, calls }));
const r3 = mkRes(); await relay({ query: { u: 'https://fapi.binance.com/fapi/v1/order?x=1' } }, r3); if (r3.code !== 400) throw new Error('非白名單應 400');
globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
const r4 = mkRes(); await relay({ query: { u: 'https://mempool.space/api/blocks/tip/height' } }, r4); if (r4.code !== 502) throw new Error('上游失敗應 502');
console.log('✓ relay：白名單、轉發、15 秒快取（同網址只打一次）、非白名單 400、上游失敗 502');
console.log('ALL PASS t_relay');
