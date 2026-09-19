import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof verifyIntrabarHits === 'function', { timeout: 15000 });

// ══ ① 競態重現：插針驗證 await 期間掛單被主迴圈取消 → 取消必須保住、不發止盈一／止損調整 ══
const race = await p.evaluate(async () => {
  isSignalMaster = () => true;
  const sent = []; sendTelegramMessage = async (tk, ch, text) => { sent.push(text.slice(0, 40)); return true; };
  const s = loadSettings(); s.notifTelegram = true; s.tgToken = 't'; s.tgChatId = 'c'; saveSettings(s);
  sendCancelTelegramNotification = (t, r) => { sent.push('取消:' + String(r).slice(0, 20)); };
  sendSLChangeNotification = () => { sent.push('止損調整'); };
  const now = Date.now();
  const t0 = now - 4 * 60000;
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify([{ id: 'race', symbol: 'RC/USDT', direction: 'long', status: 'pending', entry: 100, entryPrice: 100.5, sl: 98, tp1: 103, tp2: 106,
    timestamp: t0, telegramSent: true, conf: 70, tradeType: 'directional', refined: true, cancelNotifySent: true }])); _tlogRaw = null; _tlogArr = null;
  // 1m K 線：先回踩到 99.8（觸及進場）再衝到 103.5（過止盈一）——但要等 300ms 才回來
  fetchKlinesExec = async () => { await new Promise(r => setTimeout(r, 300)); const bar = (t, o, h, l, c) => [t, String(o), String(h), String(l), String(c), '100', t + 59999, '1', 1, '1', '1', '0'];
    return [bar(t0 + 60000, 100.4, 100.6, 99.8, 100.2), bar(t0 + 120000, 100.2, 103.5, 100.1, 103.2), bar(t0 + 180000, 103.2, 103.6, 102.9, 103.4)]; };
  const pWick = verifyIntrabarHits();                      // 拿到快照後開始等 K 線
  await new Promise(r => setTimeout(r, 50));
  // 主迴圈這時看到現價 103.4 ≥ 止盈一、未成交 → 飛越取消
  updateOpenTrades([{ symbol: 'RC/USDT', price: '103.4', score: 70, trend: '看漲' }]);
  const afterCancel = loadTradeLog().find(t => t.id === 'race').status;
  await pWick;
  await new Promise(r => setTimeout(r, 100));
  const t = loadTradeLog().find(x => x.id === 'race');
  return { afterCancel, final: t.status, tp1Hit: !!t.tp1Hit, sl: t.sl, sent };
});
if (race.afterCancel !== 'cancelled') throw new Error('主迴圈未取消：' + JSON.stringify(race));
if (race.final !== 'cancelled' || race.tp1Hit || race.sl !== 98) throw new Error('取消被插針驗證覆蓋（單子復活）：' + JSON.stringify(race));
if (race.sent.some(x => x.includes('止盈一已達到') || x.includes('止損調整'))) throw new Error('取消後仍發了止盈一／止損調整：' + JSON.stringify(race.sent));
console.log(`✓ 競態：主迴圈取消（${race.afterCancel}）→ 插針驗證回來後仍是 ${race.final}、止損未動、未發止盈一；訊息只有 ${JSON.stringify(race.sent)}`);

// ══ ② 正常路徑：持倉中真的插針到止盈一 → 一則止盈一通知＋止損上移 ══
const ok = await p.evaluate(async () => {
  const sent = []; sendTelegramMessage = async (tk, ch, text) => { sent.push(text.slice(0, 30)); return true; };
  sendSLChangeNotification = () => { sent.push('止損調整'); };
  const now = Date.now(); const t0 = now - 4 * 60000;
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify([{ id: 'live', symbol: 'LV/USDT', direction: 'long', status: 'open', entry: 100, baseSl: 98, sl: 98, tp1: 103, tp2: 106,
    timestamp: t0, entryTime: t0, telegramSent: true, conf: 70 }])); _tlogRaw = null; _tlogArr = null;
  fetchKlinesExec = async () => { const bar = (t, o, h, l, c) => [t, String(o), String(h), String(l), String(c), '100', t + 59999, '1', 1, '1', '1', '0'];
    return [bar(t0 + 60000, 100.4, 100.6, 99.8, 100.2), bar(t0 + 120000, 100.2, 103.5, 100.1, 103.2)]; };
  await verifyIntrabarHits(); await new Promise(r => setTimeout(r, 100));
  const t = loadTradeLog().find(x => x.id === 'live');
  return { status: t.status, tp1Hit: !!t.tp1Hit, sl: t.sl, sent };
});
if (ok.status !== 'open' || !ok.tp1Hit || !(ok.sl > 100) || !ok.sent.some(x => x.includes('止盈一')) || !ok.sent.includes('止損調整')) throw new Error('正常止盈一路徑壞了：' + JSON.stringify(ok));
console.log(`✓ 正常路徑：持倉插針到 103.5 → tp1Hit、止損上移至 ${ok.sl}、發止盈一與止損調整各一則`);

await p.evaluate(() => { const s = loadSettings(); s.notifTelegram = false; saveSettings(s); });
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_wick');
await b.close();
