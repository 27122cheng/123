// 回測 v5：① 止損移動（TP1 後追蹤回吐）② 同向併發上限對回撤 ③ 回踩單用新出場 ④ RSI 過熱 vs 突破 ⑤ 時間止損
import { D, FEE_RT, okSym, ema, atr, hhv, llv, TFMS, stats, print, ctxFor, half, rsRank } from './btlib.mjs';
const SLIP = 0.0005;
// 含追蹤停利的出場模擬：TP1 後止損 = max(lock, peak − give)；give=null 表示不追蹤（固定 TP2）
function sim(bars, i0, isLong, entry, sl, tp1R, tp2R, maxBars, feeR, p1, lockR, giveR, timeStop) {
  const risk = Math.abs(entry - sl); const dir = isLong ? 1 : -1; const tp1 = entry + dir * risk * tp1R, tp2 = entry + dir * risk * tp2R;
  let slNow = sl, tp1Hit = false, r = 0, peakR = 0, exitI = i0;
  for (let i = i0; i < Math.min(bars.length, i0 + maxBars); i++) {
    const h = bars[i][2], l = bars[i][3]; exitI = i;
    const hitSl = isLong ? l <= slNow : h >= slNow; const hitTp2 = isLong ? h >= tp2 : l <= tp2; const hitTp1 = !tp1Hit && (isLong ? h >= tp1 : l <= tp1);
    if (hitSl) { const rr = dir * (slNow - entry) / risk; r += (tp1Hit ? 1 - p1 : 1) * rr; return { r: r - feeR, t: bars[i][0], how: tp1Hit ? 'trail' : 'sl' }; }
    if (hitTp1) { tp1Hit = true; r += p1 * tp1R; slNow = entry + dir * risk * lockR; }
    if (hitTp2 && tp1Hit) { r += (1 - p1) * tp2R; return { r: r - feeR, t: bars[i][0], how: 'tp2' }; }
    if (tp1Hit && giveR != null) { peakR = Math.max(peakR, dir * ((isLong ? h : l) - entry) / risk); const lk = Math.max(lockR, peakR - giveR); const ns = entry + dir * risk * lk; if (isLong ? ns > slNow : ns < slNow) slNow = ns; }
    // 時間止損：未到 TP1、持有 ≥ timeStop 根且浮盈在 ±0.3R 內 → 平倉
    if (timeStop && !tp1Hit && i - i0 >= timeStop) { const cr = dir * (bars[i][4] - entry) / risk; if (Math.abs(cr) <= 0.3) return { r: cr - feeR, t: bars[i][0], how: 'time' }; }
  }
  const c = bars[exitI][4]; const rr = dir * (c - entry) / risk; r += (tp1Hit ? 1 - p1 : 1) * rr; return { r: r - feeR, t: bars[exitI][0], how: 'expire' };
}
// 突破訊號（15m）與 1H 突破訊號：回傳 {b, i0, isLong, entry, sl, t, sym, c, rsi}
function sigs15() {
  const out = [];
  for (const sym of Object.keys(D['15m'])) { if (!okSym(sym)) continue; const b = D['15m'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) { const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) { const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const body = isLong ? b[i][4] > b[i][1] : b[i][4] < b[i][1]; const brk = (isLong ? b[i][4] > lvl : b[i][4] < lvl) && body && (b[i][2] - b[i][3]) > 0.8 * A[i]; if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1; for (let j = i + 1; j <= Math.min(b.length - 1, i + 8); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; } if (k < 0) continue;
        const entry = trig * (isLong ? 1 + SLIP : 1 - SLIP); const risk = Math.max(0.9 * A[i], 0.008 * entry); out.push({ b, i0: k, isLong, entry, sl: isLong ? entry - risk : entry + risk, t: b[k][0], sym, c, gate: (isLong ? c.btcDUp : !c.btcDUp) && c.adx4 >= 20, tf: 96 }); } } }
  return out;
}
function sigs1h() {
  const out = [];
  for (const sym of Object.keys(D['1H'])) { if (!okSym(sym)) continue; const b = D['1H'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 20; i++) { const c = ctx(b[i][0] + TFMS['1H']); if (!c.ok) continue;
      for (const isLong of [true, false]) { const key = isLong ? 1 : 0; if (i - last[key] < 6) continue; if (isLong ? !c.h4Up : !c.h4Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const brk = isLong ? b[i][4] > lvl && b[i][4] > b[i][1] : b[i][4] < lvl && b[i][4] < b[i][1]; if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1; for (let j = i + 1; j <= Math.min(b.length - 1, i + 4); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; } if (k < 0) continue;
        const entry = trig * (isLong ? 1 + SLIP : 1 - SLIP); const risk = Math.max(1.0 * A[i], 0.01 * entry); out.push({ b, i0: k, isLong, entry, sl: isLong ? entry - risk : entry + risk, t: b[k][0], sym, c, gate: (isLong ? c.btcDUp : !c.btcDUp) && c.adx4 >= 20, tf: 72 }); } } }
  return out;
}
const run = (S, o) => S.map(s => { const r = sim(s.b, s.i0, s.isLong, s.entry, s.sl, o.tp1 ?? 1, o.tp2 ?? 2.5, o.hold ?? s.tf, FEE_RT * s.entry / Math.abs(s.entry - s.sl), o.p1 ?? 0.5, o.lock ?? 0.3, o.give === undefined ? null : o.give, o.ts || 0); return { ...r, t0: s.t, isLong: s.isLong, sym: s.sym }; });
const S15 = sigs15().filter(s => s.gate), S1 = sigs1h().filter(s => s.gate);
console.log(`樣本：15m 突破（順 BTC 日線＋ADX≥20）${S15.length} 筆；1H 突破 ${S1.length} 筆\n`);
for (const [name, S] of [['15m 突破', S15], ['1H 突破', S1]]) {
  console.log(`══ ① 止損移動／出場（${name}）══`);
  print([stats(run(S, { give: null }), '不追蹤：TP1 後鎖 0.3R，等 2.5R'), stats(run(S, { give: 0.5 }), '追蹤回吐 0.5R'), stats(run(S, { give: 0.8 }), '追蹤回吐 0.8R（現行）'), stats(run(S, { give: 1.2 }), '追蹤回吐 1.2R'), stats(run(S, { give: 0.8, tp2: 4 }), '追蹤 0.8R＋TP2 放到 4R'), stats(run(S, { give: 0.8, tp2: 99 }), '追蹤 0.8R、無 TP2（純追蹤）'), stats(run(S, { give: null, lock: 0 }), '鎖保本（0R）不追蹤'), stats(run(S, { give: null, lock: 0.5 }), '鎖 0.5R 不追蹤')]);
  console.log(`══ ⑤ 時間止損（${name}；未到 TP1、浮盈 ±0.3R 內 → 平）══`);
  const tsBars = name.startsWith('15m') ? [16, 32, 64] : [8, 16, 24];
  print([stats(run(S, {}), '無時間止損'), ...tsBars.map(n => stats(run(S, { ts: n }), `持有 ${n} 根仍原地踏步 → 平`))]);
}
// ② 同向併發上限：按時間順序，同時持有同方向筆數 ≤ N 才接單；看淨 R／回撤／每 R 風險
console.log('══ ② 同向併發上限（15m＋1H 突破合併，順序接單）══');
const all = [...run(S15, {}), ...run(S1, {})].sort((a, b) => a.t0 - b.t0);
const cap = (N, Ntot) => { const open = []; let e = 0, pk = 0, dd = 0, n = 0, w = 0; for (const x of all) { for (let i = open.length - 1; i >= 0; i--) if (open[i].t <= x.t0) open.splice(i, 1); const same = open.filter(o => o.isLong === x.isLong).length; if (same >= N || open.length >= Ntot) continue; open.push(x); n++; if (x.r > 0) w++; e += x.r; pk = Math.max(pk, e); dd = Math.max(dd, pk - e); } return { label: `同向 ≤${N}、總 ≤${Ntot}`, n, wr: +(w / n * 100).toFixed(1), exp: +(e / n).toFixed(3), pf: null, net: +e.toFixed(1), maxDD: +dd.toFixed(1) }; };
print([cap(99, 99), cap(6, 8), cap(4, 6), cap(3, 5), cap(2, 4), cap(2, 3), cap(1, 2)]);
// ③ 回踩限價單：舊出場 vs 新出場、加閘門
console.log('══ ③ 回踩 EMA20 限價單：出場結構與閘門 ══');
const PB = [];
for (const sym of Object.keys(D['15m'])) { if (!okSym(sym)) continue; const b = D['15m'][sym]; const A = atr(b), E = ema(b.map(x => x[4]), 20), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
  for (let i = 60; i < b.length - 40; i++) { const c = ctx(b[i][0]); if (!c.ok) continue;
    for (const isLong of [true, false]) { const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
      const near = isLong ? (b[i][4] > E[i] * 1.003 && b[i][4] < E[i] * 1.02 && b[i][4] > b[i - 1][4]) : (b[i][4] < E[i] * 0.997 && b[i][4] > E[i] * 0.98 && b[i][4] < b[i - 1][4]); if (!near) continue; last[key] = i;
      const entry = E[i]; const sl = isLong ? Math.min(llv(b, i, 10), entry - 0.9 * A[i]) - 0.3 * A[i] : Math.max(hhv(b, i, 10), entry + 0.9 * A[i]) + 0.3 * A[i]; const risk = Math.abs(entry - sl); if (!(risk > 0) || risk / entry > 0.03) continue;
      const tp1 = isLong ? entry + 1.5 * risk : entry - 1.5 * risk; let fill = -1; for (let k = i + 1; k <= Math.min(b.length - 1, i + 16); k++) { if (isLong ? b[k][2] >= tp1 : b[k][3] <= tp1) break; if (isLong ? b[k][3] <= entry : b[k][2] >= entry) { fill = k; break; } } if (fill < 0) continue;
      PB.push({ b, i0: fill + 1, isLong, entry, sl, t: b[fill][0], sym, c, gate: (isLong ? c.btcDUp : !c.btcDUp) && c.adx4 >= 20, hot: isLong ? c.h1Rsi >= 65 : c.h1Rsi <= 35, tf: 96 }); } } }
print([stats(run(PB, { tp1: 1.5, tp2: 3, p1: 0.6, lock: 0.5, give: 0.8 }), '全部｜舊出場 1.5R/60%/3R'), stats(run(PB, {}), '全部｜新出場 1R/50%/2.5R'), stats(run(PB.filter(s => s.gate), { tp1: 1.5, tp2: 3, p1: 0.6, lock: 0.5, give: 0.8 }), '閘門後｜舊出場'), stats(run(PB.filter(s => s.gate), {}), '閘門後｜新出場'), stats(run(PB.filter(s => s.gate && s.hot), {}), '閘門後＋1H RSI 順向過熱｜新出場')]);
const [pbA, pbB] = half(run(PB.filter(s => s.gate), {}).map(x => ({ ...x, t: x.t0 }))); print([stats(pbA, '閘門後新出場｜前半'), stats(pbB, '閘門後新出場｜後半')]);
// ④ RSI 過熱 vs 突破單（閘門後）
console.log('══ ④ 1H RSI 順向過熱（多 ≥65／空 ≤35）對突破單（閘門後）══');
const hot = s => s.isLong ? s.c.h1Rsi >= 65 : s.c.h1Rsi <= 35;
print([stats(run(S15.filter(hot), {}), '15m 突破｜RSI 過熱'), stats(run(S15.filter(s => !hot(s)), {}), '15m 突破｜RSI 未過熱'), stats(run(S1.filter(hot), {}), '1H 突破｜RSI 過熱'), stats(run(S1.filter(s => !hot(s)), {}), '1H 突破｜RSI 未過熱')]);
console.log('══ 追加：追蹤 0.5R 組合（前半／後半）══');
for (const [name, S] of [['15m', S15], ['1H', S1]]) {
  const rows = o => run(S, o).map(x => ({ ...x, t: x.t0 }));
  for (const [l, o] of [['現行 0.8R＋2.5R', { give: 0.8 }], ['0.5R＋2.5R', { give: 0.5 }], ['0.5R＋4R', { give: 0.5, tp2: 4 }], ['0.5R 純追蹤', { give: 0.5, tp2: 99 }], ['0.8R 純追蹤', { give: 0.8, tp2: 99 }]]) {
    const rs = rows(o); const [a, b] = half(rs); const A = stats(rs, ''), B = stats(a, ''), C = stats(b, ''); console.log([`${name}｜${l}`, A.n, A.wr, A.exp, 'DD', A.maxDD, '｜前半', B.exp, 'DD', B.maxDD, '｜後半', C.exp, 'DD', C.maxDD].join('\t'));
  }
}
console.log('══ 追加：回踩＋RSI 過熱 切片前後半 ══');
{ const rs = run(PB.filter(s => s.gate && s.hot), {}).map(x => ({ ...x, t: x.t0 })); const [a, b] = half(rs); print([stats(a, '前半'), stats(b, '後半')]);
  const rs2 = run(PB.filter(s => s.gate && !s.hot), {}).map(x => ({ ...x, t: x.t0 })); print([stats(rs2, '閘門後但 RSI 未過熱（應刪）')]); }
