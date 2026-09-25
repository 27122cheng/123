import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof updateScalpTrades === 'function' && typeof qlabEffective === 'function', { timeout: 15000 });

// ══ ① 常數與學習夾具：止盈一永遠 ≥1R ══
const cf = await p.evaluate(() => {
  const base = qlabEffective();
  localStorage.setItem('csp_qlab_applied', JSON.stringify({ active: true, slMult: 0.6, tp1R: 0.6, tp2R: 1.0, at: Date.now() }));
  let eff = null; try { eff = qlabEffective(); } catch(_e) {}
  localStorage.removeItem('csp_qlab_applied');
  const src = String(buildScalpSetup);
  return { cfg: { r1: SCALP_CFG.revertTp1R, r2: SCALP_CFG.revertTp2R, min: SCALP_CFG.minTp1R }, base, eff,
    guard: src.includes("if (_rr < 1.5) return _sr(`回歸目標太近") && src.includes('const _t1Eff = Math.max(SCALP_CFG.minTp1R || 1.0, _t1R)') && !src.includes('(tp2 - entry) * 0.6') };
});
if (cf.cfg.r1 !== 1.0 || cf.cfg.r2 !== 1.6 || cf.cfg.min !== 1.0) throw new Error('常數未更新：' + JSON.stringify(cf.cfg));
if (!cf.guard) throw new Error('建單幾何守門未接線');
if (cf.eff && (cf.eff.tp1R < 1.0 || cf.eff.revertTp1R < 1.0 || cf.eff.tp2R < 1.6)) throw new Error('學習結果未夾住：' + JSON.stringify(cf.eff));
console.log(`✓ 常數：回歸止盈一 ${cf.cfg.r1}R／止盈二 ${cf.cfg.r2}R、底線 ${cf.cfg.min}R；自動調參即使套 tp1R 0.6 也夾成 ${cf.eff ? cf.eff.tp1R : '（未套用）'}；回歸目標 <1.5R 不建、不再把止盈一縮到目標 60%`);

// ══ ② 成交幾何：順向滑移讓止盈一 <1R → 重錨目標（止損仍釘結構）；追價 >0.35R → 作廢 ══
const fill = await p.evaluate(() => {
  isSignalMaster = () => false;
  const now = Date.now();
  const mk = (id, extra) => ({ id, symbol: 'X/USDT', direction: 'long', status: 'open', pendingFill: true, signalPrice: 100, signalTime: now - 60000, timestamp: now - 60000, entryTime: now - 60000,
    entry: 100, sl: 99.3, baseSl: 99.3, tp1: 100.7, tp2: 101.26, mode: 'pullback', family: 'trend', breakLevel: 99.6, atrAtEntry: 0.5, maeAtr: 0, mfeAtr: 0, tp1RUsed: 1, tp2RUsed: 1.8,
    qty: 8.5714, notional: 857.14, riskAmt: 6, feeR: 0.143, slDistPct: 0.7, telegramSent: false, ...extra });
  const run = (px, extra) => { localStorage.setItem(SCALP_LOG_KEY, JSON.stringify([mk('g', extra)])); _slogRaw = null; _slogArr = null;
    updateScalpTrades([{ symbol: 'X/USDT', price: String(px) }]); const t = loadScalpLog().find(x => x.id === 'g');
    return { status: t.status, entry: t.entry, sl: t.sl, tp1: t.tp1, tp2: t.tp2, rr1: t.rr1AtFill, rr2: t.rrAtFill, re: !!t.tpReanchored, why: t.voidWhy }; };
  return { mild: run(100.14), slip: run(100.21), chase: run(100.35), adverse: run(99.86), bot: run(100.21, { botMode: true, notifiedAtSignal: true }) };
});
// 100.14：風險 0.84、止盈一距 0.56 → 0.67R <1R → 重錨：tp1 = 100.14+0.84 = 100.98、tp2 = 100.14+1.512
if (fill.mild.status !== 'open' || !fill.mild.re || Math.abs(fill.mild.tp1 - 100.98) > 0.001 || fill.mild.sl !== 99.3 || fill.mild.rr1 < 1) throw new Error('順向滑移未重錨止盈：' + JSON.stringify(fill.mild));
if (fill.slip.status !== 'open' || !fill.slip.re || fill.slip.rr1 < 1) throw new Error('+0.3R 滑移應重錨後成交：' + JSON.stringify(fill.slip));
if (fill.chase.status !== 'expired' || !/追價/.test(fill.chase.why || '')) throw new Error('+0.5R 追價應作廢：' + JSON.stringify(fill.chase));
if (fill.adverse.status !== 'open' || fill.adverse.re || fill.adverse.tp1 !== 100.7) throw new Error('逆向滑移（止盈一已 >1R）不該動目標：' + JSON.stringify(fill.adverse));
if (fill.bot.status !== 'expired' || !/機器人模式/.test(fill.bot.why || '')) throw new Error('機器人模式不得事後改數字，應作廢：' + JSON.stringify(fill.bot));
console.log(`✓ 成交幾何：+0.2R 滑移 → 止損仍 ${fill.mild.sl}，止盈一 100.7→${fill.mild.tp1}（R:R ${fill.mild.rr1}）、止盈二 ${fill.mild.tp2}；+0.3R 同樣重錨（R:R ${fill.slip.rr1}）；+0.5R 追價作廢；逆向滑移目標不動（R:R ${fill.adverse.rr1}）；機器人模式不改已發數字 → 作廢`);

if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_scalprr');
await b.close();
