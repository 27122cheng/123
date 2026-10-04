// 回測框架 v2：多空雙向；過濾條件（技術面／大盤／籌碼面）；出場結構；前後半段樣本外檢驗（學習能力）
// 用法：node bt2.mjs <dataDir>
import fs from 'node:fs';
const DIR = process.argv[2] || './data';
const load = f => { try { return JSON.parse(fs.readFileSync(`${DIR}/${f}.json`, 'utf8')); } catch (e) { return null; } };
const D = { '1H': load('okx_1H'), '15m': load('okx_15m'), '5m': load('okx_5m'), '4H': load('okx_4H'), '1D': load('okx_1D') };
const CH = load('chips');
const FEE_RT = 0.001;
const okSym = s => ['1H','15m','4H','1D'].every(tf => D[tf] && D[tf][s] && D[tf][s].length > 100);

const ema = (arr, n) => { const k = 2 / (n + 1); const out = []; let e = arr[0]; for (let i = 0; i < arr.length; i++) { e = i ? arr[i] * k + e * (1 - k) : arr[i]; out.push(e); } return out; };
const atr = (b, n = 14) => { const out = []; let a = 0; for (let i = 0; i < b.length; i++) { const tr = i ? Math.max(b[i][2] - b[i][3], Math.abs(b[i][2] - b[i - 1][4]), Math.abs(b[i][3] - b[i - 1][4])) : b[i][2] - b[i][3]; a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n; out.push(a); } return out; };
const adx = (b, n = 14) => { const out = new Array(b.length).fill(0); let tr = 0, pdm = 0, ndm = 0, a = 0; for (let i = 1; i < b.length; i++) { const up = b[i][2] - b[i - 1][2], dn = b[i - 1][3] - b[i][3]; const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0; const t = Math.max(b[i][2] - b[i][3], Math.abs(b[i][2] - b[i - 1][4]), Math.abs(b[i][3] - b[i - 1][4])); tr = tr - tr / n + t; pdm = pdm - pdm / n + p; ndm = ndm - ndm / n + m; const pdi = tr ? 100 * pdm / tr : 0, ndi = tr ? 100 * ndm / tr : 0; const d = (pdi + ndi) ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0; a = i < 2 * n ? (a * (i - 1) + d) / i : (a * (n - 1) + d) / n; out[i] = a; } return out; };
const rsi = (b, n = 14) => { const out = new Array(b.length).fill(50); let g = 0, l = 0; for (let i = 1; i < b.length; i++) { const d = b[i][4] - b[i - 1][4]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l ? 100 - 100 / (1 + g / l) : 100; } return out; };
const hhv = (b, i, n) => { let h = -Infinity; for (let k = Math.max(0, i - n); k < i; k++) h = Math.max(h, b[k][2]); return h; };
const llv = (b, i, n) => { let l = Infinity; for (let k = Math.max(0, i - n); k < i; k++) l = Math.min(l, b[k][3]); return l; };
const mkIdx = (ts) => (t, tfMs) => { let lo = 0, hi = ts.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] + tfMs <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
const mkHtf = bars => mkIdx(bars.map(b => b[0]));
const TFMS = { '5m': 5 * 60e3, '15m': 15 * 60e3, '1H': 3600e3, '4H': 4 * 3600e3, '1D': 86400e3 };
const session = t => { const h = new Date(t).getUTCHours(); return (h >= 7 && h < 10) || (h >= 12 && h < 15) ? 'LN/NY' : (h >= 1 && h < 4) ? 'ASIA' : 'OFF'; };

// 出場模擬：止盈一出 p1、剩餘移到 +lockR、止盈二全出；同棒先算止損（保守）
function simulate(bars, i0, isLong, entry, sl, tp1R, tp2R, maxBars, feeR, p1 = 0.6, lockR = 0.5) {
  const risk = Math.abs(entry - sl); if (!(risk > 0)) return null;
  const dir = isLong ? 1 : -1; const tp1 = entry + dir * risk * tp1R, tp2 = entry + dir * risk * tp2R;
  let slNow = sl, tp1Hit = false, r = 0, exitI = i0;
  for (let i = i0; i < Math.min(bars.length, i0 + maxBars); i++) {
    const h = bars[i][2], l = bars[i][3]; exitI = i;
    const hitSl = isLong ? l <= slNow : h >= slNow; const hitTp2 = isLong ? h >= tp2 : l <= tp2; const hitTp1 = !tp1Hit && (isLong ? h >= tp1 : l <= tp1);
    if (hitSl) { const rr = dir * (slNow - entry) / risk; r += (tp1Hit ? 1 - p1 : 1.0) * rr; return { r: r - feeR, bars: i - i0, how: tp1Hit ? 'trail' : 'sl' }; }
    if (hitTp1) { tp1Hit = true; r += p1 * tp1R; slNow = entry + dir * risk * lockR; if (p1 >= 1) return { r: r - feeR, bars: i - i0, how: 'tp1' }; }
    if (hitTp2 && tp1Hit) { r += (1 - p1) * tp2R; return { r: r - feeR, bars: i - i0, how: 'tp2' }; }
  }
  const c = bars[exitI][4]; const rr = dir * (c - entry) / risk; r += (tp1Hit ? 1 - p1 : 1.0) * rr; return { r: r - feeR, bars: exitI - i0, how: 'time' };
}
const stats = (rows, label) => { const n = rows.length; if (!n) return { label, n: 0 }; const w = rows.filter(x => x.r > 0).length; const sum = rows.reduce((a, x) => a + x.r, 0); const gw = rows.filter(x => x.r > 0).reduce((a, x) => a + x.r, 0), gl = -rows.filter(x => x.r <= 0).reduce((a, x) => a + x.r, 0); const sorted = [...rows].sort((a, b) => a.t - b.t); let eq = 0, pk = 0, dd = 0; for (const x of sorted) { eq += x.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); } return { label, n, wr: +(w / n * 100).toFixed(1), exp: +(sum / n).toFixed(3), pf: gl ? +(gw / gl).toFixed(2) : null, net: +sum.toFixed(1), maxDD: +dd.toFixed(1) }; };
const print = rows => { console.log(['條件', '筆數', '勝率%', '期望R/筆', '獲利因子', '淨R', '最大回撤R'].join('\t')); for (const s of rows) console.log([s.label, s.n, s.wr ?? '-', s.exp ?? '-', s.pf ?? '-', s.net ?? '-', s.maxDD ?? '-'].join('\t')); console.log(''); };

// ── 環境（技術面＋大盤）──
const _ctx = {};
function ctxFor(sym) {
  if (_ctx[sym]) return _ctx[sym];
  const b1 = D['1H'][sym], b4 = D['4H'][sym], bd = D['1D'][sym], btc1 = D['1H']['BTC/USDT'], btcd = D['1D']['BTC/USDT'];
  const e1 = { f: ema(b1.map(x => x[4]), 20), s: ema(b1.map(x => x[4]), 50) }, q1 = mkHtf(b1), r1 = rsi(b1);
  const be = { f: ema(btc1.map(x => x[4]), 20), s: ema(btc1.map(x => x[4]), 50) }, qb = mkHtf(btc1);
  const bde = { f: ema(btcd.map(x => x[4]), 20), s: ema(btcd.map(x => x[4]), 50) }, qbd = mkHtf(btcd);
  const a4 = adx(b4), e4 = { f: ema(b4.map(x => x[4]), 20), s: ema(b4.map(x => x[4]), 50) }, q4 = mkHtf(b4);
  const ed = { f: ema(bd.map(x => x[4]), 20), s: ema(bd.map(x => x[4]), 50) }, qd = mkHtf(bd);
  const f = t => { const i1 = q1(t, TFMS['1H']), ib = qb(t, TFMS['1H']), i4 = q4(t, TFMS['4H']), id = qd(t, TFMS['1D']), ibd = qbd(t, TFMS['1D']);
    return { h1Up: i1 > 0 && e1.f[i1] > e1.s[i1], h1Dn: i1 > 0 && e1.f[i1] < e1.s[i1], h1Rsi: i1 > 0 ? r1[i1] : 50,
      btcUp: ib > 0 && be.f[ib] > be.s[ib], btcDn: ib > 0 && be.f[ib] < be.s[ib], btcDUp: ibd > 0 && bde.f[ibd] > bde.s[ibd],
      adx4: i4 > 0 ? a4[i4] : 0, h4Up: i4 > 0 && e4.f[i4] > e4.s[i4], h4Dn: i4 > 0 && e4.f[i4] < e4.s[i4],
      dUp: id > 0 && ed.f[id] > ed.s[id], dDn: id > 0 && ed.f[id] < ed.s[id], ok: i1 > 50 && ib > 50 && i4 > 30 && id > 25 }; };
  return (_ctx[sym] = f);
}
const _rs = {};
function rsRank(t) {
  const key = Math.floor(t / 3600e3); if (_rs[key]) return _rs[key];
  const vals = []; for (const sym of Object.keys(D['1H'])) { const b = D['1H'][sym]; if (!b.length) continue; const i = mkHtf(b)(t, TFMS['1H']); if (i > 24) vals.push([sym, b[i][4] / b[i - 24][4] - 1]); }
  vals.sort((a, b) => a[1] - b[1]); const m = {}; vals.forEach(([s], k) => { m[s] = Math.round(k / (vals.length - 1) * 100); }); return (_rs[key] = m);
}
// ── 籌碼面：最近一筆資金費率、多空人數比、持倉量 24h 變化 ──
const _chq = {};
function chipsAt(sym, t) {
  if (!CH || !CH[sym]) return null;
  if (!_chq[sym]) { const c = CH[sym]; _chq[sym] = { fq: mkIdx(c.funding.map(x => x[0])), lq: mkIdx(c.lsRatio.map(x => x[0])), oq: mkIdx(c.oi.map(x => x[0])) }; }
  const c = CH[sym], q = _chq[sym]; const fi = q.fq(t, 0), li = q.lq(t, 0), oi = q.oq(t, 0);
  const out = {};
  if (fi >= 0) out.fund = c.funding[fi][1];
  if (li >= 0) out.ls = c.lsRatio[li][1];
  if (oi >= 24) out.oiChg = c.oi[oi][1] / c.oi[oi - 24][1] - 1;
  return out;
}

const half = rows => { const ts = rows.map(x => x.t).sort((a, b) => a - b); const mid = ts[Math.floor(ts.length / 2)] || 0; return [rows.filter(x => x.t < mid), rows.filter(x => x.t >= mid)]; };
// 市場寬度：某時刻池中 1H EMA20>EMA50 的幣佔比
const _br = {};
function breadth(t) {
  const key = Math.floor(t / 3600e3); if (_br[key] != null) return _br[key];
  let up = 0, n = 0; for (const sym of Object.keys(D['1H'])) { const b = D['1H'][sym]; if (!b || b.length < 60) continue; const c = ctxFor(sym)(t); if (!c.ok) continue; n++; if (c.h1Up) up++; }
  return (_br[key] = n ? up / n : 0.5);
}
export { D, CH, FEE_RT, okSym, ema, atr, adx, rsi, hhv, llv, mkIdx, mkHtf, TFMS, session, simulate, stats, print, ctxFor, rsRank, chipsAt, half, breadth };
