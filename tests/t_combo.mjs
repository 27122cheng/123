import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* 條件組合研究：兩兩交叉找優勢／劣勢組合 → 每日自動登錄假設 → 既有證實管線 → 快速單攔截（組合鍵）／一般單軟門（組合鍵）；研究台組合卡與組合篩選 */
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof expCombos === 'function' && typeof expAutoRefresh === 'function', { timeout: 20000 });
const keep = await p.evaluate(() => ({ tl: localStorage.getItem('csp_trade_log'), sl: localStorage.getItem('csp_scalp_log'), st: localStorage.getItem('csp_settings'), au: localStorage.getItem('csp_exp_auto') }));

// ① 快速單：假突破 × 低品質時段 全輸 40 筆；其他組合多數贏 → 組合研究判為劣勢；一般單：逆 BTC 日線 × 亞洲時段 全輸
const r1 = await p.evaluate(() => {
  const now = Date.now(); const scalp = [], main = [];
  for (let i = 0; i < 120; i++) {
    const bad = i < 40; const mode = bad ? 'trap' : ['trap', 'breakout', 'vwapRev'][i % 3]; const kz = bad ? 'low' : ['high', 'mid', 'high'][i % 3];
    const win = bad ? false : i % 4 !== 0; const ts = now - i * 1800e3;
    scalp.push({ id: 's' + i, symbol: 'X/USDT', direction: 'long', status: 'closed', timestamp: ts, entryTime: ts, exitTime: ts + 600e3, pnlR: win ? 1 : -1, outcome: win ? 'tp1' : 'sl', mode, family: mode === 'vwapRev' ? 'revert' : 'trend', kzQuality: kz, btcD1: 'bull', slHasOuter: true, volRatio: 1.6 });
  }
  for (let i = 0; i < 100; i++) {
    const bad = i < 35; const win = bad ? false : i % 3 !== 0; const ts = now - i * 7200e3;
    main.push({ id: 'm' + i, symbol: 'Y/USDT', direction: 'long', status: 'closed', timestamp: ts, entryTime: ts, exitTime: ts + 3600e3, pnlR: win ? 1.2 : -1, outcome: win ? 'tp1' : 'sl', btcD1: bad ? 'bear' : 'bull', kz: bad ? 'ASIA' : ['NY', 'LDN', 'NY'][i % 3], entryMode: 'stop', entryTag: 'h1break', h4Adx: 25 });
  }
  localStorage.setItem('csp_scalp_log', JSON.stringify(scalp)); localStorage.setItem('csp_trade_log', JSON.stringify(main)); _tlogRaw = null; _tlogArr = null; try { invalidateLearnCache(); } catch (e) {}
  for (const k of ['main', 'scalp']) { delete _expCache[k]; delete _expComboCache[k]; }
  const cs = expCombos('scalp', true), cm = expCombos('main', true);
  const ds = cs.drags.find(r => r.k === 'combo:model:mode:trap&session:kz:low'), dm = cm.drags.find(r => r.k === 'combo:macro:btcD1:against&session:kz:ASIA');
  return { sPairs: cs.nPairs, ds: ds && { n: ds.n, wr: ds.wr, verdict: ds.verdict, l: ds.l }, dm: dm && { n: dm.n, verdict: dm.verdict, l: dm.l }, sEdges: cs.edges.length, baseS: cs.base.wr };
});
if (!r1.ds || r1.ds.n !== 40 || r1.ds.wr !== 0 || r1.ds.verdict !== 'drag' || !r1.dm || r1.dm.n !== 35 || r1.dm.verdict !== 'drag') throw new Error('① 組合研究錯誤：' + JSON.stringify(r1));
console.log(`✓ ① 組合研究：快速單 ${r1.sPairs} 組，劣勢「${r1.ds.l}」${r1.ds.n} 筆 0%；一般單劣勢「${r1.dm.l}」${r1.dm.n} 筆；優勢組合 ${r1.sEdges} 組`);

// ② 自動登錄 → 證實 → 攔截／軟門（組合鍵需兩者皆有）；自動套用關 → 不擋
const r2 = await p.evaluate(() => {
  localStorage.removeItem('csp_exp_auto');
  const list = expAutoRefresh(true);
  // 40 筆全輸的那群同時滿足多個組合（都是 0%），前三名未必是 trap×low 這一組；只要求有快速單劣勢組合登錄且含 kz:low
  const sa = list.find(h => h.scope === 'scalp' && h.expect === 'drag' && h.key.includes('session:kz:low')), ma = list.find(h => h.scope === 'main' && h.expect === 'drag' && h.key.includes('session:kz:ASIA'));
  const vs = expVerdicts(true); const vS = vs.find(v => v.id === (sa && sa.id)), vM = vs.find(v => v.id === (ma && ma.id));
  const st = loadSettings(); st.expAutoApply = true; saveSettings(st);
  const [ka, kb] = sa.key.slice(6).split('&');
  const both = expScalpBlock({ btcD1: 'neutral', h1brk: 'neutral', ls: 'neutral', outer: true }, new Set([ka, kb]));
  const one = expScalpBlock({ btcD1: 'neutral', h1brk: 'neutral', ls: 'neutral', outer: true }, new Set([ka, 'session:kz:high']));
  const [ma1, ma2] = ma.key.slice(6).split('&');
  const softBoth = expMainSoft([ma1, ma2]), softOne = expMainSoft([ma1]);
  st.expAutoApply = false; saveSettings(st);
  const off = expScalpBlock({ btcD1: 'neutral', h1brk: 'neutral', ls: 'neutral', outer: true }, new Set([ka, kb]));
  return { n: list.length, sa: sa && { apply: sa.apply, expect: sa.expect }, ma: ma && { apply: ma.apply }, vS: vS && vS.status, vM: vM && vM.status, both, one, softBoth: softBoth.mult, softOne: softOne.mult, off };
});
if (!r2.sa || r2.sa.apply !== 'scalpReject' || !r2.ma || r2.ma.apply !== 'mainSoft' || r2.vS !== 'proven' || r2.vM !== 'proven' || !r2.both || !r2.both.includes('組合') || r2.one !== null || Math.abs(r2.softBoth - 0.7) > 1e-9 || r2.softOne !== 1 || r2.off !== null) throw new Error('② 自動登錄／套用錯誤：' + JSON.stringify(r2));
console.log(`✓ ② 自動登錄 ${r2.n} 條；證實後：快速單兩鍵齊 → 「${r2.both.slice(0, 28)}…」、只有一鍵 → 不擋；一般單軟門 ×${r2.softBoth}／單鍵 ×${r2.softOne}；自動套用關 → 不擋`);

// ③ 研究台：組合卡、點組合篩選只留同時符合的 40 筆
const r3 = await p.evaluate(() => { navigateTo('report'); renderReportPage(new Date().getFullYear(), 'research', new Date().getMonth()); _rsSet('kind', 'scalp'); const el = document.getElementById('rpt-view-content'); const card = [...el.querySelectorAll('.rs-card')].find(c => c.textContent.includes('條件組合')); const chip = card && card.querySelector('.rs-chip-drag'); if (chip) chip.click(); const el2 = document.getElementById('rpt-view-content'); return { card: !!card, drag: !!chip, label: chip && chip.textContent.slice(0, 30), stat: el2.querySelector('.rs-fstat').textContent, rows: el2.querySelectorAll('tr.rs-tr').length, on: !!el2.querySelector('.rs-chip-on') }; });
if (!r3.card || !r3.drag || !/40 筆/.test(r3.stat) || r3.rows !== 40 || !r3.on) throw new Error('③ 研究台組合錯誤：' + JSON.stringify(r3));
console.log(`✓ ③ 研究台：組合卡存在，點「${r3.label}」→ ${r3.stat.slice(0, 20)}…`);

await p.evaluate(k => { for (const [key, v] of [['csp_trade_log', k.tl], ['csp_scalp_log', k.sl], ['csp_settings', k.st], ['csp_exp_auto', k.au]]) { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } _tlogRaw = null; _tlogArr = null; try { invalidateLearnCache(); } catch (e) {} for (const kk of ['main', 'scalp']) { delete _expCache[kk]; delete _expComboCache[kk]; } }, keep);
if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_combo');
await b.close();
