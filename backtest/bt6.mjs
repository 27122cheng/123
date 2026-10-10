// 回測 v6：勝率 80% 可不可能？出場網格 × 訊號分層 → 勝率／期望／回撤／每日筆數
import { D, FEE_RT, okSym, atr, hhv, llv, TFMS, stats, ctxFor, half, rsRank, chipsAt, breadth, session } from './btlib.mjs';
import fs from 'node:fs';
const SLIP = 0.0005;
function sim(bars, i0, isLong, entry, sl, tp1R, tp2R, maxBars, feeR, p1, lockR, giveR) {
  const risk = Math.abs(entry - sl); const dir = isLong ? 1 : -1; const tp1 = entry + dir * risk * tp1R, tp2 = entry + dir * risk * tp2R;
  let slNow = sl, tp1Hit = false, r = 0, peakR = 0, exitI = i0;
  for (let i = i0; i < Math.min(bars.length, i0 + maxBars); i++) {
    const h = bars[i][2], l = bars[i][3]; exitI = i;
    const hitSl = isLong ? l <= slNow : h >= slNow; const hitTp2 = isLong ? h >= tp2 : l <= tp2; const hitTp1 = !tp1Hit && (isLong ? h >= tp1 : l <= tp1);
    if (hitSl) { const rr = dir * (slNow - entry) / risk; r += (tp1Hit ? 1 - p1 : 1) * rr; return { r: r - feeR, t: bars[i][0] }; }
    if (hitTp1) { tp1Hit = true; r += p1 * tp1R; slNow = entry + dir * risk * lockR; if (p1 >= 1) return { r: r - feeR, t: bars[i][0] }; }
    if (hitTp2 && tp1Hit) { r += (1 - p1) * tp2R; return { r: r - feeR, t: bars[i][0] }; }
    if (tp1Hit && giveR != null) { peakR = Math.max(peakR, dir * ((isLong ? h : l) - entry) / risk); const ns = entry + dir * risk * Math.max(lockR, peakR - giveR); if (isLong ? ns > slNow : ns < slNow) slNow = ns; }
  }
  const c = bars[exitI][4]; const rr = dir * (c - entry) / risk; r += (tp1Hit ? 1 - p1 : 1) * rr; return { r: r - feeR, t: bars[exitI][0] };
}
const feat = (sym, t, c, isLong, atrPct) => { const ch = chipsAt(sym, t) || {}; const rsv = rsRank(t)[sym]; const br = breadth(t);
  return { btcD: (isLong ? c.btcDUp : !c.btcDUp) ? 1 : 0, adx4: Math.min(60, c.adx4) / 60, rsiAl: ((isLong ? c.h1Rsi : 100 - c.h1Rsi) - 50) / 50, rs: rsv != null ? ((isLong ? rsv : 100 - rsv) - 50) / 50 : 0, ls: ch.ls != null ? Math.max(-1, Math.min(1, isLong ? ch.ls - 1 : 1 - ch.ls)) : 0, vol: Math.min(1, atrPct / 0.02), brAl: isLong ? br - 0.5 : 0.5 - br }; };
const W = { btcD: 0.098, adx4: 0.255, rsiAl: 0.335, rs: 0.093, ls: 0.222, vol: 0.476, brAl: -0.006 }, B0 = 0.05;
const prob = f => { let z = B0; for (const k in W) z += W[k] * f[k]; return 1 / (1 + Math.exp(-z)); };
function sigs15() { const out = [];
  for (const sym of Object.keys(D['15m'])) { if (!okSym(sym)) continue; const b = D['15m'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) { const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) { const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const body = isLong ? b[i][4] > b[i][1] : b[i][4] < b[i][1]; const brk = (isLong ? b[i][4] > lvl : b[i][4] < lvl) && body && (b[i][2] - b[i][3]) > 0.8 * A[i]; if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1; for (let j = i + 1; j <= Math.min(b.length - 1, i + 8); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; } if (k < 0) continue;
        const entry = trig * (isLong ? 1 + SLIP : 1 - SLIP); const risk = Math.max(0.9 * A[i], 0.008 * entry);
        if (!((isLong ? c.btcDUp : !c.btcDUp) && c.adx4 >= 20)) continue;
        out.push({ src: '15m', b, i0: k, isLong, entry, sl: isLong ? entry - risk : entry + risk, t: b[k][0], sym, c, hot: isLong ? c.h1Rsi >= 65 : c.h1Rsi <= 35, p: prob(feat(sym, b[i][0], c, isLong, A[i] / b[i][4])), tf: 96 }); } } }
  return out; }
function sigs1h() { const out = [];
  for (const sym of Object.keys(D['1H'])) { if (!okSym(sym)) continue; const b = D['1H'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 20; i++) { const c = ctx(b[i][0] + TFMS['1H']); if (!c.ok) continue;
      for (const isLong of [true, false]) { const key = isLong ? 1 : 0; if (i - last[key] < 6) continue; if (isLong ? !c.h4Up : !c.h4Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const brk = isLong ? b[i][4] > lvl && b[i][4] > b[i][1] : b[i][4] < lvl && b[i][4] < b[i][1]; if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1; for (let j = i + 1; j <= Math.min(b.length - 1, i + 4); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; } if (k < 0) continue;
        const entry = trig * (isLong ? 1 + SLIP : 1 - SLIP); const risk = Math.max(1.0 * A[i], 0.01 * entry);
        if (!((isLong ? c.btcDUp : !c.btcDUp) && c.adx4 >= 20)) continue;
        out.push({ src: '1H', b, i0: k, isLong, entry, sl: isLong ? entry - risk : entry + risk, t: b[k][0], sym, c, hot: isLong ? c.h1Rsi >= 65 : c.h1Rsi <= 35, p: prob(feat(sym, b[i][0], c, isLong, A[i] / b[i][4])), tf: 72 }); } } }
  return out; }
const S15 = sigs15(), S1 = sigs1h();
const days15 = (D['15m']['BTC/USDT'].at(-1)[0] - D['15m']['BTC/USDT'][0][0]) / 86400e3, days1 = (D['1H']['BTC/USDT'].at(-1)[0] - D['1H']['BTC/USDT'][0][0]) / 86400e3;
const run = (S, o) => S.map(s => { const r = sim(s.b, s.i0, s.isLong, s.entry, s.sl, o.tp1, o.tp2, s.tf, FEE_RT * s.entry / Math.abs(s.entry - s.sl), o.p1, o.lock, o.give); return { ...r, src: s.src, p: s.p, hot: s.hot, sym: s.sym }; });
const line = (label, rows, perDay) => { const st = stats(rows, label); const [a, b] = half(rows); const A = stats(a, ''), B = stats(b, ''); return [label, st.n, perDay.toFixed(1), st.wr, st.exp, st.maxDD, (st.maxDD * 0.6).toFixed(1) + '%', '｜' + A.wr, A.exp, '｜' + B.wr, B.exp].join('\t'); };
const EXITS = [['1R/50%/鎖0.3/追0.5/4R（現行）', { tp1: 1, tp2: 4, p1: 0.5, lock: 0.3, give: 0.5 }], ['0.7R/60%/鎖0.2/追0.5/4R', { tp1: 0.7, tp2: 4, p1: 0.6, lock: 0.2, give: 0.5 }], ['0.5R/60%/鎖0.1/追0.5/4R', { tp1: 0.5, tp2: 4, p1: 0.6, lock: 0.1, give: 0.5 }], ['0.5R/70%/鎖0.1/追0.5/4R', { tp1: 0.5, tp2: 4, p1: 0.7, lock: 0.1, give: 0.5 }], ['0.7R/50%/鎖0/追0.4/3R', { tp1: 0.7, tp2: 3, p1: 0.5, lock: 0, give: 0.4 }], ['不分批 0.8R', { tp1: 0.8, tp2: 0.8, p1: 1, lock: 0, give: null }], ['不分批 0.6R', { tp1: 0.6, tp2: 0.6, p1: 1, lock: 0, give: null }]];
const TIERS = [['全部（閘門後）', s => true], ['p ≥ 0.60', s => s.p >= 0.6], ['p ≥ 0.65', s => s.p >= 0.65], ['RSI 順向過熱', s => s.hot], ['RSI 過熱 且 p ≥ 0.6', s => s.hot && s.p >= 0.6]];
console.log(['出場 × 分層', '筆數', '每日筆', '勝率%', '期望R', '回撤R', '回撤%(每筆冒0.6%)', '｜前半勝率', '期望', '｜後半勝率', '期望'].join('\t'));
for (const [src, S, days] of [['15m 突破', S15, days15], ['1H 突破', S1, days1], ['15m＋1H 合併', [...S15, ...S1], days15]]) {
  console.log(`══ ${src}（${S.length} 筆、${days.toFixed(0)} 天）══`);
  for (const [tl, tf] of TIERS) for (const [el, eo] of EXITS) { const rows = run(S.filter(tf), eo); if (!rows.length) continue; console.log(line(`${tl}｜${el}`, rows, rows.length / (src.startsWith('15m＋') ? days15 : days))); }
}
