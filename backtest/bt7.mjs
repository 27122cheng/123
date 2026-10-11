// 回測 v7：移動止損「躲在結構後方」vs 純 R 追蹤（TP1 後）
import { D, FEE_RT, okSym, ema, atr, hhv, llv, TFMS, stats, print, ctxFor, half } from './btlib.mjs';
const SLIP = 0.0005;
// mode: 'r' 純 R 追蹤；'struct' 結構錨定：候選＝min(R 追蹤位, 最高支撐 − 0.25ATR)，支撐＝EMA20／近 10 根擺動低點（需低於現價 0.15ATR），無支撐時不動
function sim(bars, E, A, i0, isLong, entry, sl, tp1R, tp2R, maxBars, feeR, p1, lockR, giveR, mode, buf = 0.25) {
  const risk = Math.abs(entry - sl); const dir = isLong ? 1 : -1; const tp1 = entry + dir * risk * tp1R, tp2 = entry + dir * risk * tp2R;
  let slNow = sl, tp1Hit = false, r = 0, peakR = 0, exitI = i0;
  for (let i = i0; i < Math.min(bars.length, i0 + maxBars); i++) {
    const h = bars[i][2], l = bars[i][3], c = bars[i][4]; exitI = i;
    const hitSl = isLong ? l <= slNow : h >= slNow; const hitTp2 = isLong ? h >= tp2 : l <= tp2; const hitTp1 = !tp1Hit && (isLong ? h >= tp1 : l <= tp1);
    if (hitSl) { const rr = dir * (slNow - entry) / risk; r += (tp1Hit ? 1 - p1 : 1) * rr; return { r: r - feeR, t: bars[i][0] }; }
    if (hitTp1) { tp1Hit = true; r += p1 * tp1R; slNow = entry + dir * risk * lockR; }
    if (hitTp2 && tp1Hit) { r += (1 - p1) * tp2R; return { r: r - feeR, t: bars[i][0] }; }
    if (tp1Hit) {
      peakR = Math.max(peakR, dir * ((isLong ? h : l) - entry) / risk); const T = entry + dir * risk * Math.max(lockR, peakR - giveR);
      let ns = T;
      if (mode === 'struct') {
        const sw = isLong ? llv(bars, i, 10) : hhv(bars, i, 10); const cands = [E[i], sw].filter(v => isFinite(v) && (isLong ? v < c - 0.15 * A[i] : v > c + 0.15 * A[i]));
        if (!cands.length) ns = slNow; else { const L = isLong ? Math.max(...cands) : Math.min(...cands); const beh = isLong ? L - buf * A[i] : L + buf * A[i]; ns = isLong ? Math.min(T, beh) : Math.max(T, beh); }
      } else if (mode === 'snap') {   // 結構在 R 追蹤位與現價之間 → 貼到結構外側（更緊）；否則用 R 追蹤
        const sw = isLong ? llv(bars, i, 10) : hhv(bars, i, 10); const cands = [E[i], sw].filter(v => isFinite(v) && (isLong ? v < c - 0.15 * A[i] : v > c + 0.15 * A[i]));
        if (cands.length) { const L = isLong ? Math.max(...cands) : Math.min(...cands); const beh = isLong ? L - buf * A[i] : L + buf * A[i]; ns = isLong ? Math.max(T, beh) : Math.min(T, beh); }
      } else if (mode === 'swing') {   // 只認擺動低/高點（不認 EMA）：止損＝min(R 追蹤位, 近 10 根擺動點外側)，無擺動點則不動
        const sw = isLong ? llv(bars, i, 10) : hhv(bars, i, 10); const ok = isFinite(sw) && (isLong ? sw < c - 0.15 * A[i] : sw > c + 0.15 * A[i]);
        ns = ok ? (isLong ? Math.min(T, sw - buf * A[i]) : Math.max(T, sw + buf * A[i])) : slNow;
      } else if (mode === 'swing20') {
        const sw = isLong ? llv(bars, i, 20) : hhv(bars, i, 20); const ok = isFinite(sw) && (isLong ? sw < c - 0.15 * A[i] : sw > c + 0.15 * A[i]);
        ns = ok ? (isLong ? Math.min(T, sw - buf * A[i]) : Math.max(T, sw + buf * A[i])) : slNow;
      }
      if (isLong ? ns > slNow : ns < slNow) slNow = ns;
    }
  }
  const cc = bars[exitI][4]; const rr = dir * (cc - entry) / risk; r += (tp1Hit ? 1 - p1 : 1) * rr; return { r: r - feeR, t: bars[exitI][0] };
}
function sigs(tf) { const out = []; const look = tf === '1H' ? 4 : 8;
  for (const sym of Object.keys(D[tf])) { if (!okSym(sym)) continue; const b = D[tf][sym]; const A = atr(b), E = ema(b.map(x => x[4]), 20), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) { const c = ctx(tf === '1H' ? b[i][0] + TFMS['1H'] : b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) { const key = isLong ? 1 : 0; if (i - last[key] < (tf === '1H' ? 6 : 8)) continue; const al = tf === '1H' ? (isLong ? c.h4Up : c.h4Dn) : (isLong ? c.h1Up : c.h1Dn); if (!al) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const body = isLong ? b[i][4] > b[i][1] : b[i][4] < b[i][1]; const brk = (isLong ? b[i][4] > lvl : b[i][4] < lvl) && body && (tf === '1H' || (b[i][2] - b[i][3]) > 0.8 * A[i]); if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1; for (let j = i + 1; j <= Math.min(b.length - 1, i + look); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; } if (k < 0) continue;
        if (!((isLong ? c.btcDUp : !c.btcDUp) && c.adx4 >= 20)) continue;
        const entry = trig * (isLong ? 1 + SLIP : 1 - SLIP); const risk = tf === '1H' ? Math.max(1.0 * A[i], 0.01 * entry) : Math.max(0.9 * A[i], 0.008 * entry);
        out.push({ b, E, A, i0: k, isLong, entry, sl: isLong ? entry - risk : entry + risk, t: b[k][0], hot: isLong ? c.h1Rsi >= 65 : c.h1Rsi <= 35, tf: tf === '1H' ? 72 : 96 }); } } }
  return out; }
for (const tf of ['15m', '1H']) {
  const S = sigs(tf);
  console.log(`══ ${tf} 突破（閘門後 ${S.length} 筆）：TP1 1R 出 50%／鎖 0.3R／追蹤 0.5R／4R ══`);
  const run = (mode, buf, filt = () => true) => S.filter(filt).map(s => ({ ...sim(s.b, s.E, s.A, s.i0, s.isLong, s.entry, s.sl, 1, 4, s.tf, FEE_RT * s.entry / Math.abs(s.entry - s.sl), 0.5, 0.3, 0.5, mode, buf) }));
  const rows = [['純 R 追蹤（現行）', run('r')], ['結構錨定（EMA20／擺動 10 根）min', run('struct', 0.25)], ['貼結構（更緊）max', run('snap', 0.25)], ['只認擺動低點 10 根 min', run('swing', 0.25)], ['只認擺動低點 20 根 min', run('swing20', 0.25)], ['純 R 但回吐 0.8R', S.map(s => sim(s.b, s.E, s.A, s.i0, s.isLong, s.entry, s.sl, 1, 4, s.tf, FEE_RT * s.entry / Math.abs(s.entry - s.sl), 0.5, 0.3, 0.8, 'r'))], ['純 R 但回吐 1.0R', S.map(s => sim(s.b, s.E, s.A, s.i0, s.isLong, s.entry, s.sl, 1, 4, s.tf, FEE_RT * s.entry / Math.abs(s.entry - s.sl), 0.5, 0.3, 1.0, 'r'))]];
  print(rows.map(([l, r]) => stats(r, l)));
  for (const [l, r] of rows.slice(0, 2)) { const [a, b] = half(r); console.log(`  ${l}：前半 ${stats(a, '').exp}R（勝率 ${stats(a, '').wr}）／後半 ${stats(b, '').exp}R（${stats(b, '').wr}）`); }
  print([stats(run('r', 0, s => s.hot), 'RSI 過熱｜純 R'), stats(run('struct', 0.25, s => s.hot), 'RSI 過熱｜結構錨定')]);
}
