import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* 報表頁「🔬 交易研究」：一眼結論、準確度儀表（各條件勝率／R）、交易研究台（篩選、排序、單筆展開附同條件歷史）；一般單／快速單切換 */
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof _rptBuildResearchView === 'function' && typeof renderReportPage === 'function', { timeout: 20000 });

const keep = await p.evaluate(() => ({ tl: localStorage.getItem('csp_trade_log'), sl: localStorage.getItem('csp_scalp_log') }));
await p.evaluate(() => {
  const now = Date.now(); const main = [], scalp = [];
  for (let i = 0; i < 80; i++) {
    const against = i % 5 < 2;                         // 32 筆逆 BTC 日線全輸；其餘 48 筆 2/3 贏
    const win = !against && i % 3 !== 1; const long = i % 3 !== 0; const ts = now - i * 10 * 3600e3;
    main.push({ id: 'm' + i, symbol: ['BTC', 'ETH', 'SOL', 'LINK'][i % 4] + '/USDT', direction: long ? 'long' : 'short', status: 'closed', timestamp: ts, entryTime: ts, exitTime: ts + 4 * 3600e3,
      entry: 100, sl: long ? 98.5 : 101.5, tp1: long ? 102 : 98, tp2: long ? 104 : 96, exitPrice: win ? (long ? 102.5 : 97.5) : (long ? 98.5 : 101.5), pnlR: win ? (i % 5 === 0 ? 2.2 : 1.1) : -1, outcome: win ? (i % 5 === 0 ? 'tp2' : 'tp1') : 'sl',
      btcD1: against ? (long ? 'bear' : 'bull') : (long ? 'bull' : 'bear'), entryLs: 1.2, entryFr: 0.0001, entryMode: 'stop', entryTag: 'h1break', h4Adx: 22 + (i % 15), btProb: 0.5 + (i % 3) * 0.1, conviction: 10 + (i % 30), kz: ['NY', 'LDN', 'ASIA'][i % 3], entryTags: ['結構-4H同向', 'KillZone時段'].slice(0, 1 + (i % 2)), sq: 15 + (i % 6), conf: 66 + (i % 20) });
  }
  for (let i = 0; i < 200; i++) {
    const win = i % 5 < 2; const ts = now - i * 3 * 3600e3;
    scalp.push({ id: 's' + i, symbol: ['BTC', 'ETH', 'PEPE'][i % 3] + '/USDT', direction: i % 2 ? 'long' : 'short', status: 'closed', timestamp: ts, entryTime: ts, exitTime: ts + 30 * 60e3, entry: 50, sl: 49.6, tp1: 50.6, pnlR: win ? 1 : (i % 7 === 0 ? 0 : -1), outcome: win ? 'tp1' : (i % 7 === 0 ? 'be' : 'sl'), mode: ['trap', 'pullback', 'breakout', 'vwapRev'][i % 4], family: 'trend', kzQuality: ['high', 'mid', 'low'][i % 3], slHasOuter: i % 2 === 0, btcD1: 'bull', btcH4: 'bull', h1BrkDir: 'bull', slDistAtr: 0.8, volRatio: 1.6 });
  }
  localStorage.setItem('csp_trade_log', JSON.stringify(main)); _tlogRaw = null; _tlogArr = null; try { invalidateLearnCache(); } catch (e) {}
  localStorage.setItem('csp_scalp_log', JSON.stringify(scalp));
  navigateTo('report'); renderReportPage(new Date().getFullYear(), 'research', new Date().getMonth());
});
await p.waitForTimeout(300);
// ① 三大區塊都在；一眼結論抓到「BTC 日線逆向」為在賠的條件
const r1 = await p.evaluate(() => {
  const el = document.getElementById('rpt-view-content'); const html = el.innerHTML;
  const drag = [...el.querySelectorAll('.rs-ins')].find(x => x.textContent.includes('在賠的條件'));
  const cards = el.querySelectorAll('.rs-grid .rs-card').length;
  const rows = el.querySelectorAll('tr.rs-tr').length;
  return { has: html.includes('一眼結論') && html.includes('準確度儀表') && html.includes('交易研究台'), drag: drag && drag.textContent, cards, rows, stat: el.querySelector('.rs-fstat').textContent, marks: el.querySelectorAll('.rs-grid .rs-drag').length };
});
if (!r1.has || !/BTC 日線逆向/.test(r1.drag) || r1.cards < 8 || r1.rows !== 60 || !/80 筆/.test(r1.stat)) throw new Error('① 研究頁結構錯誤：' + JSON.stringify(r1));
console.log(`✓ ① 三區塊齊全；在賠的條件含「BTC 日線逆向」；儀表 ${r1.cards} 卡、▼ ${r1.marks} 個；研究台先顯示 60／80 筆`);

// ② 點條件 → 篩成該條件（32 筆、勝率 0%、顯著較差）；清除篩選復原
const r2 = await p.evaluate(() => { _rsPick('macro:btcD1:against'); const el = document.getElementById('rpt-view-content'); return { stat: el.querySelector('.rs-fstat').textContent, rows: el.querySelectorAll('tr.rs-tr').length, chip: !!el.querySelector('.rs-chip-on') }; });
if (!/32 筆/.test(r2.stat) || !/0%/.test(r2.stat) || !/顯著較差/.test(r2.stat) || r2.rows !== 32 || !r2.chip) throw new Error('② 條件篩選錯誤：' + JSON.stringify(r2));
const r2b = await p.evaluate(() => { _rsClear(); return document.querySelectorAll('tr.rs-tr').length; });
if (r2b !== 60) throw new Error('② 清除篩選未復原：' + r2b);
console.log(`✓ ② 點「BTC 日線逆向」→ ${r2.stat.slice(0, 40)}…；清除後復原`);

// ③ 篩選：方向＋結果＋幣種；排序 R；再顯示 100 筆
const r3 = await p.evaluate(() => {
  _rsSet('dir', 'short'); _rsSet('out', 'win'); _rsSymInput('ETH'); return new Promise(res => setTimeout(() => { const el = document.getElementById('rpt-view-content'); const rows = [...el.querySelectorAll('tr.rs-tr')]; res({ n: rows.length, allEthShortWin: rows.every(tr => /ETH/.test(tr.children[1].textContent) && tr.children[2].textContent === '空' && /止盈/.test(tr.children[5].textContent)), stat: el.querySelector('.rs-fstat').textContent }); }, 500));
});
if (!r3.n || !r3.allEthShortWin || !/100%/.test(r3.stat)) throw new Error('③ 複合篩選錯誤：' + JSON.stringify(r3));
const r3b = await p.evaluate(() => { _rsClear(); _rsSort('r'); const a = [...document.querySelectorAll('tr.rs-tr')].map(tr => parseFloat(tr.children[6].textContent)); _rsSort('r'); const b = [...document.querySelectorAll('tr.rs-tr')].map(tr => parseFloat(tr.children[6].textContent)); _rsSet('limit', 160); return { descOk: a.every((v, i) => i === 0 || a[i - 1] >= v), ascOk: b.every((v, i) => i === 0 || b[i - 1] <= v), rows: document.querySelectorAll('tr.rs-tr').length }; });
if (!r3b.descOk || !r3b.ascOk || r3b.rows !== 80) throw new Error('③ 排序／加載錯誤：' + JSON.stringify(r3b));
console.log(`✓ ③ 多空＋結果＋幣種複合篩選 ${r3.n} 筆全符合；R 排序雙向正確；再顯示 → 80 筆`);

// ④ 單筆展開：核心價位＋條件晶片（含同條件歷史 n／勝率／R）；逆向那筆的晶片標 ▼ 類
const r4 = await p.evaluate(() => { _rsSet('sel', 'm0'); const d = document.querySelector('.rs-detail'); return d && { core: d.querySelectorAll('.rs-core div').length, chips: d.querySelectorAll('.rs-chip').length, drag: d.querySelectorAll('.rs-chip-drag').length, txt: d.textContent.slice(0, 80) }; });
if (!r4 || r4.core < 8 || r4.chips < 6 || r4.drag < 1) throw new Error('④ 單筆展開錯誤：' + JSON.stringify(r4));
console.log(`✓ ④ 單筆展開：${r4.core} 個核心欄、${r4.chips} 個條件晶片（${r4.drag} 個劣勢）`);

// ⑤ 切快速單：模式卡存在、200 筆；回一般單
const r5 = await p.evaluate(() => { _rsSet('kind', 'scalp'); const el = document.getElementById('rpt-view-content'); return { stat: el.querySelector('.rs-fstat').textContent, mode: [...el.querySelectorAll('.rs-card-ttl')].some(x => x.textContent === '模式'), head: el.querySelector('.rs-tbl thead').textContent }; });
if (!/200 筆/.test(r5.stat) || !r5.mode || !/模式/.test(r5.head)) throw new Error('⑤ 快速單切換錯誤：' + JSON.stringify(r5));
console.log(`✓ ⑤ 快速單：${r5.stat.slice(0, 30)}…，模式卡與表頭正確`);

// 還原
await p.evaluate(k => { if (k.tl) localStorage.setItem('csp_trade_log', k.tl); else localStorage.removeItem('csp_trade_log'); if (k.sl) localStorage.setItem('csp_scalp_log', k.sl); else localStorage.removeItem('csp_scalp_log'); _tlogRaw = null; _tlogArr = null; try { invalidateLearnCache(); } catch (e) {} }, keep);
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_research');
await b.close();
