import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof expMatrix === 'function' && typeof buildExpHtml === 'function', { timeout: 20000 });

// ══ ① 統一特徵抽取：一般單／快速單／實驗室三種樣本都抽得出各面向的特徵 ══
const feat = await p.evaluate(() => {
  const m = expFeatures({ direction: 'long', entryMode: 'stop', entryTag: 'h1break', h4Adx: 25, rsi: 55, btcD1: 'bull', entryLs: 1.3, entryFr: 0.0005, btProb: 0.7, conviction: 30, softMult: 1, planMode: 'high', trailModeAt: 'struct', kz: 'NY', regime: 'trend', entryTBias: 'bear', entryTags: ['結構-4H同向', 'OI-新錢同向', '宏觀順風', 'KillZone時段', '裸K-吞噬'], riskKeys: ['f3_adx'], convEv: { f: ['wk'], a: ['h1'] } }, 'main');
  const s = expFeatures({ direction: 'short', mode: 'momentum', family: 'trend', kzQuality: 'high', oiState: 'favorable', mtfAlign: 2, slDistAtr: 0.8, volRatio: 1.7, slHuntAvoid: true, slHasOuter: false, slWidened: false, btcD1: 'bull', btcH4: 'bear', h1BrkDir: 'bear', entryLs: 0.8, entryFr: -0.0004 }, 'scalp');
  const l = expFeatures({ direction: 'long', tags: ['ICT-FVG', '巨鯨同向', '市場-趨勢順向'], riskKeys: ['f1_conf'] }, 'lab');
  const dims = arr => [...new Set(arr.map(f => f.d))].sort().join(',');
  return { mN: m.length, mDims: dims(m), mKeys: m.map(f => f.k), sN: s.length, sDims: dims(s), sKeys: s.map(f => f.k), lN: l.length, lDims: dims(l) };
});
if (!feat.mKeys.includes('macro:btcD1:aligned') || !feat.mKeys.includes('chips:ls:aligned') || !feat.mKeys.includes('chips:fr:crowded') || !feat.mKeys.includes('macro:tbias:against') || !feat.mKeys.includes('pattern:tag:結構-4H同向') || !feat.mKeys.includes('chips:tag:OI-新錢同向') || !feat.mKeys.includes('session:tag:KillZone時段') || !feat.mKeys.includes('model:btp:預測勝率≥65%')) throw new Error('一般單特徵錯誤：' + JSON.stringify(feat.mKeys));
if (!feat.sKeys.includes('macro:btcD1:against') || !feat.sKeys.includes('tech:h1brk:aligned') || !feat.sKeys.includes('chips:ls:aligned') || !feat.sKeys.includes('pattern:outer:n') || !feat.sKeys.includes('chips:fr:crowded')) throw new Error('快速單特徵錯誤：' + JSON.stringify(feat.sKeys));
if (feat.lN !== 5 || feat.lDims !== 'chips,macro,model,pattern,risk') throw new Error('實驗室特徵錯誤：' + JSON.stringify(feat));
console.log(`✓ 統一特徵：一般單 ${feat.mN} 個（${feat.mDims}）、快速單 ${feat.sN} 個（${feat.sDims}）、實驗室 ${feat.lN} 個（${feat.lDims}）`);

// ══ ② 分層績效矩陣＋實驗登錄：逆 BTC 日線的一般單全輸 → 劣勢／證實；快速單同理 → 自動套用攔截 ══
const mat = await p.evaluate(async () => {
  const keep = { tl: localStorage.getItem('csp_trade_log'), sl: localStorage.getItem('csp_scalp_log'), st: localStorage.getItem('csp_settings') };
  const now = Date.now(); const main = [], scalp = [];
  for (let i = 0; i < 70; i++) {
    const against = i < 30;   // 30 筆逆 BTC 日線（全輸）、40 筆順向（多數贏）
    main.push({ id: 'm' + i, symbol: 'X' + i + '/USDT', direction: 'long', status: 'closed', timestamp: now - i * 3600e3, exitTime: now - i * 3600e3 + 60e3,
      pnlR: against ? -1 : (i % 4 === 0 ? -1 : 1.2), btcD1: against ? 'bear' : 'bull', entryLs: 1.2, entryFr: against ? 0.0006 : 0.0001, entryMode: 'stop', h4Adx: 28, btProb: 0.7 });
    scalp.push({ id: 's' + i, symbol: 'X' + i + '/USDT', direction: 'long', status: 'closed', timestamp: now - i * 1800e3, exitTime: now - i * 1800e3 + 60e3,
      pnlR: against ? -1 : (i % 5 === 0 ? -1 : 1.0), btcD1: against ? 'bear' : 'bull', mode: 'momentum', family: 'trend', slHasOuter: !against });
  }
  localStorage.setItem('csp_trade_log', JSON.stringify(main)); _tlogRaw = null; _tlogArr = null; try { invalidateLearnCache(); } catch(_e) {}
  localStorage.setItem('csp_scalp_log', JSON.stringify(scalp));
  const mm = expMatrix('main', true), sm = expMatrix('scalp', true);
  const rowM = mm.rows.find(r => r.k === 'macro:btcD1:against'), rowFr = mm.rows.find(r => r.k === 'chips:fr:crowded'), rowS = sm.rows.find(r => r.k === 'macro:btcD1:against');
  const v = expVerdicts(true); const vM = v.find(x => x.id === 'm_btcd1_against'), vFr = v.find(x => x.id === 'm_fr_crowded'), vS = v.find(x => x.id === 's_btcd1_against'), vO = v.find(x => x.id === 's_outer_none');
  // 自動套用：關 → 不擋；開 → 擋
  const st = loadSettings(); st.expAutoApply = false; saveSettings(st);
  const blockOff = expScalpBlock({ btcD1: 'against', h1brk: 'neutral', ls: 'neutral', outer: true });
  const softOff = expMainSoft(['chips:fr:crowded']).mult;
  st.expAutoApply = true; saveSettings(st);
  const blockOn = expScalpBlock({ btcD1: 'against', h1brk: 'neutral', ls: 'neutral', outer: true });
  const blockOuter = expScalpBlock({ btcD1: 'aligned', h1brk: 'neutral', ls: 'neutral', outer: false });
  const blockNone = expScalpBlock({ btcD1: 'aligned', h1brk: 'neutral', ls: 'neutral', outer: true });
  const softOn = expMainSoft(['chips:fr:crowded', 'macro:btcD1:against']);
  const html = buildExpHtml(); const suff = expSampleSufficiency();
  let labOk = false; try { renderLabPage(); labOk = !!document.querySelector('#lab-page, #page-lab'); } catch(_e) {}
  // 還原
  if (keep.tl) localStorage.setItem('csp_trade_log', keep.tl); else localStorage.removeItem('csp_trade_log'); _tlogRaw = null; _tlogArr = null; try { invalidateLearnCache(); } catch(_e) {}
  if (keep.sl) localStorage.setItem('csp_scalp_log', keep.sl); else localStorage.removeItem('csp_scalp_log');
  if (keep.st) localStorage.setItem('csp_settings', keep.st); else localStorage.removeItem('csp_settings');
  for (const k of ['main', 'scalp', 'lab']) delete _expCache[k];
  return { base: mm.base, rowM: rowM && { n: rowM.n, wr: rowM.wr, verdict: rowM.verdict }, rowFr: rowFr && { n: rowFr.n, verdict: rowFr.verdict }, rowS: rowS && { n: rowS.n, verdict: rowS.verdict },
    vM: vM.status, vFr: vFr.status, vS: vS.status, vO: vO.status, blockOff, softOff, blockOn, blockOuter, blockNone, softOn, htmlOk: html.includes('實驗登錄') && html.includes('樣本充足度') && html.includes('分層績效矩陣'), suffN: suff.length, suffMain: suff[1], labOk };
});
console.log('matrix', JSON.stringify({ base: mat.base, rowM: mat.rowM, rowS: mat.rowS, v: [mat.vM, mat.vFr, mat.vS, mat.vO] }));
if (!mat.rowM || mat.rowM.n !== 30 || mat.rowM.verdict !== 'drag' || mat.vM !== 'proven' || mat.vFr !== 'proven' || mat.vS !== 'proven' || mat.vO !== 'proven') throw new Error('矩陣／登錄判定錯誤：' + JSON.stringify(mat));
if (mat.blockOff !== null || mat.softOff !== 1 || !mat.blockOn || !mat.blockOn.includes('逆 BTC 日線') || !mat.blockOuter || mat.blockNone !== null || Math.abs(mat.softOn.mult - 0.7) > 1e-9 || mat.softOn.why.length !== 1) throw new Error('自動套用錯誤：' + JSON.stringify({ off: mat.blockOff, softOff: mat.softOff, on: mat.blockOn, outer: mat.blockOuter, none: mat.blockNone, soft: mat.softOn }));
if (!mat.htmlOk || mat.suffN < 8 || mat.suffMain.n !== 70) throw new Error('面板／充足度錯誤：' + JSON.stringify({ htmlOk: mat.htmlOk, suffN: mat.suffN, suffMain: mat.suffMain }));
console.log(`✓ 分層矩陣：逆 BTC 日線 30 筆勝率 ${(mat.rowM.wr * 100).toFixed(0)}% → 劣勢；登錄：一般單／費率擁擠／快速單／止損外側 皆「證實」；自動套用關→不擋、開→擋「${mat.blockOn.slice(0, 30)}…」、一般單軟門 ×${mat.softOn.mult}（${mat.softOn.why[0]}）；充足度 ${mat.suffN} 列`);

if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_exp');
await b.close();
