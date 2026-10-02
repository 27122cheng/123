import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof buildTelegramText === 'function', { timeout: 15000 });
const r = await p.evaluate(() => {
  const coin = { symbol: 'WLD/USDT', price: '0.5602', score: 70, rsi: 60, adx: 30, trend: '看漲', change24h: 3, volume: 1e8, ema20: '0.55', ema50: '0.54', ema200: '0.5' };
  _okxPrices['WLDUSDT'] = 0.5602 * 1.014;   // 模擬一份偏高 1.4% 的 OKX 報價快取（舊版會用它把訊息整組乘上去）
  const setup = { entry: 0.560152, sl: 0.549497, tp1: 0.581423, tp2: 0.592115, rr1: 2, rr2: 3, conf: 76, priceSrc: 'okx', entryMode: 'stop', canScaleIn: false, entryReasons: [], sqGrade: 'A', sqScore: 16 };
  const text = buildTelegramText(coin, 'long', setup, _macroCache, '');
  const num = (label) => { const m = text.match(new RegExp(label + '：\\$([0-9.]+)')); return m ? parseFloat(m[1]) : null; };
  const filled = (() => { const s = loadSettings(); s.notifTelegram = true; s.tgToken = 't'; s.tgChatId = 'c'; saveSettings(s); let out = ''; sendTelegramMessage = async (a, b2, t) => { out = t; return true; };
    sendEntryFilledNotification({ symbol: 'WLD/USDT', direction: 'long', entry: 0.560152, sl: 0.549497, tp1: 0.581423, tp2: 0.592115, priceSrc: 'okx', entryMode: 'stop' }, 0.5603);
    s.notifTelegram = false; saveSettings(s); return out; })();
  return { entry: num('進場'), sl: num('止損'), tp1: num('止盈一'), tp2: num('止盈二'), filledHasEntry: filled.includes('0.560152'), filledHasSl: filled.includes('0.549497') };
});
if (r.entry !== 0.560152 || r.sl !== 0.549497 || r.tp1 !== 0.581423 || r.tp2 !== 0.592115) throw new Error('訊號訊息數字與紀錄不一致：' + JSON.stringify(r));
if (!r.filledHasEntry || !r.filledHasSl) throw new Error('成交通知數字錯誤');
console.log(`✓ 訊號訊息：進場 ${r.entry}、止損 ${r.sl}、止盈一 ${r.tp1}、止盈二 ${r.tp2} 與紀錄完全一致（即使 OKX 報價快取偏 1.4% 也不再乘上去）；成交通知同一組數字`);
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_msgpx'); await b.close();
