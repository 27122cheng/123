// 回測資料抓取（在 GitHub Actions 執行；本機沙箱連不到交易所）
// 來源：OKX 公開 history-candles，newest-first，用 after= 往回翻頁
import fs from 'node:fs';
const SYMS = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','DOT','LTC','ATOM','NEAR','APT','ARB','OP','SUI','WLD','PEPE','TON'];
const TFS = [['1H', 2160], ['15m', 4320], ['5m', 6048], ['4H', 560], ['1D', 130]];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.status === 429) { await sleep(1500); continue; }
      const j = await r.json(); if (j && j.code === '0') return j.data || [];
      await sleep(400);
    } catch (e) { await sleep(600); }
  }
  return [];
}
async function candles(inst, bar, want) {
  const out = []; let after = '';
  while (out.length < want) {
    const d = await get(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${bar}&limit=100${after ? '&after=' + after : ''}`);
    if (!d.length) break;
    for (const c of d) out.push([+c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
    after = d[d.length - 1][0];
    await sleep(120);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(-want);
}
fs.mkdirSync('data', { recursive: true });
for (const [tf, want] of TFS) {
  const all = {};
  for (const s of SYMS) { all[s + '/USDT'] = await candles(s + '-USDT-SWAP', tf, want); console.log(tf, s, all[s + '/USDT'].length); }
  fs.writeFileSync(`data/okx_${tf}.json`, JSON.stringify(all));
}
fs.writeFileSync('data/meta.json', JSON.stringify({ at: new Date().toISOString(), syms: SYMS, tfs: TFS, src: 'OKX USDT 永續' }));
