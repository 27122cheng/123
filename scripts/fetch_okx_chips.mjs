// 籌碼面資料抓取（在 GitHub Actions 執行）：資金費率歷史、多空人數比、持倉量
// 來源：OKX 公開端點；每個幣各一份，寫到 data/chips.json
import fs from 'node:fs';
const SYMS = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','DOT','LTC','ATOM','NEAR','APT','ARB','OP','SUI','WLD','PEPE','TON'];
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
// 資金費率歷史：newest-first，after= 往回翻，拿 ~90 筆（8h 一筆 ≈ 30 天）
async function funding(inst) {
  const out = []; let after = '';
  while (out.length < 300) {
    const d = await get(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=100${after ? '&after=' + after : ''}`);
    if (!d.length) break;
    for (const c of d) out.push([+c.fundingTime, +c.realizedRate || +c.fundingRate]);
    after = d[d.length - 1].fundingTime; await sleep(120);
    if (d.length < 100) break;
  }
  return out.sort((a, b) => a[0] - b[0]);
}
// 多空人數比（1H）、持倉量＋成交量（1H）：rubik 端點，begin/end 毫秒，最多回 ~30 天
async function rubik(path, ccy, period = '1H') {
  const end = Date.now(), begin = end - 30 * 86400e3;
  const d = await get(`https://www.okx.com/api/v5/rubik/stat/contracts/${path}?ccy=${ccy}&period=${period}&begin=${begin}&end=${end}`);
  await sleep(150);
  return d.map(r => r.map(Number)).sort((a, b) => a[0] - b[0]);
}
fs.mkdirSync('data', { recursive: true });
const all = {};
for (const s of SYMS) {
  all[s + '/USDT'] = {
    funding: await funding(`${s}-USDT-SWAP`),              // [ts, rate]
    lsRatio: await rubik('long-short-account-ratio', s),    // [ts, ratio]
    oi: await rubik('open-interest-volume', s),             // [ts, oi, vol]
  };
  console.log(s, all[s + '/USDT'].funding.length, all[s + '/USDT'].lsRatio.length, all[s + '/USDT'].oi.length);
}
fs.writeFileSync('data/chips.json', JSON.stringify(all));
