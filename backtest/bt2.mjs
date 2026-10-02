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
const FILTERS = [
  ['順 BTC 1H', x => x.isLong ? x.c.btcUp : x.c.btcDn], ['逆 BTC 1H', x => x.isLong ? x.c.btcDn : x.c.btcUp],
  ['順 BTC 日線', x => x.isLong ? x.c.btcDUp : !x.c.btcDUp], ['逆 BTC 日線', x => x.isLong ? !x.c.btcDUp : x.c.btcDUp],
  ['4H 同向', x => x.isLong ? x.c.h4Up : x.c.h4Dn], ['4H 反向', x => x.isLong ? x.c.h4Dn : x.c.h4Up],
  ['日線同向', x => x.isLong ? x.c.dUp : x.c.dDn], ['日線反向', x => x.isLong ? x.c.dDn : x.c.dUp],
  ['4H ADX≥20', x => x.c.adx4 >= 20], ['4H ADX<20', x => x.c.adx4 < 20], ['4H ADX≥30', x => x.c.adx4 >= 30],
  ['倫敦／紐約時段', x => x.sess === 'LN/NY'], ['亞洲時段', x => x.sess === 'ASIA'], ['其他時段', x => x.sess === 'OFF'],
  ['相對強弱順向(多≥60/空≤40)', x => x.isLong ? x.rsv >= 60 : x.rsv <= 40], ['相對強弱逆向', x => x.isLong ? x.rsv < 40 : x.rsv > 60],
  ['1H RSI 未過熱(多<65/空>35)', x => x.isLong ? x.c.h1Rsi < 65 : x.c.h1Rsi > 35], ['1H RSI 過熱', x => x.isLong ? x.c.h1Rsi >= 65 : x.c.h1Rsi <= 35],
  ['資金費率順向偏低(多≤0.01%/空≥-0.01%)', x => x.ch && x.ch.fund != null && (x.isLong ? x.ch.fund <= 0.0001 : x.ch.fund >= -0.0001)],
  ['資金費率擁擠(多>0.03%/空<-0.03%)', x => x.ch && x.ch.fund != null && (x.isLong ? x.ch.fund > 0.0003 : x.ch.fund < -0.0003)],
  ['多空比反向(多:散戶偏空 ls<1 / 空:ls>1)', x => x.ch && x.ch.ls != null && (x.isLong ? x.ch.ls < 1 : x.ch.ls > 1)],
  ['多空比同向(擁擠)', x => x.ch && x.ch.ls != null && (x.isLong ? x.ch.ls >= 1.3 : x.ch.ls <= 0.8)],
  ['持倉量 24h 增 >3%', x => x.ch && x.ch.oiChg != null && x.ch.oiChg > 0.03], ['持倉量 24h 減 >3%', x => x.ch && x.ch.oiChg != null && x.ch.oiChg < -0.03],
];
function filterReport(rows, title) {
  console.log(`══ ${title}（全樣本 / 前半段 / 後半段 —— 後半段是「用前半段挑條件」的樣本外結果）══`);
  const [h1, h2] = half(rows);
  console.log(['條件', '筆數', '勝率%', '期望R', '｜前半 筆', '勝率', '期望R', '｜後半 筆', '勝率', '期望R'].join('\t'));
  const line = (label, f) => { const a = stats(rows.filter(f), label), b = stats(h1.filter(f), ''), c = stats(h2.filter(f), ''); console.log([label, a.n, a.wr ?? '-', a.exp ?? '-', '｜' + b.n, b.wr ?? '-', b.exp ?? '-', '｜' + c.n, c.wr ?? '-', c.exp ?? '-'].join('\t')); };
  line('全部', () => true); line('多單', x => x.isLong); line('空單', x => !x.isLong);
  for (const [l, f] of FILTERS) line(l, f);
  console.log('');
}

// ══ 一般單 A：15m 動能突破（停損進場，收盤確認）多＋空 ══
function expBreakout() {
  const rows = [], wick = [];
  for (const sym of Object.keys(D['15m'])) {
    if (!okSym(sym)) continue;
    const b = D['15m'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) {
      const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 8) continue;
        if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20);
        const body = isLong ? b[i][4] > b[i][1] : b[i][4] < b[i][1];
        const brk = (isLong ? b[i][4] > lvl : b[i][4] < lvl) && body && (b[i][2] - b[i][3]) > 0.8 * A[i];
        if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i];
        let fW = -1, fC = -1;
        for (let k = i + 1; k <= Math.min(b.length - 1, i + 8); k++) { const tw = isLong ? b[k][2] >= trig : b[k][3] <= trig, tc = isLong ? b[k][4] >= trig : b[k][4] <= trig; if (fW < 0 && tw) fW = k; if (fC < 0 && tc) fC = k; if (fW >= 0 && fC >= 0) break; }
        const mk = k => { const entry = trig, risk = Math.max(0.9 * A[i], 0.008 * entry); const sl = isLong ? entry - risk : entry + risk; const feeR = FEE_RT * entry / risk; const r = simulate(b, k + 1, isLong, entry, sl, 1.5, 3.0, 96, feeR); return r && { ...r, sym, t: b[k][0], c, isLong, sess: session(b[i][0]), rsv: rsRank(b[i][0])[sym], ch: chipsAt(sym, b[i][0]), entry, sl, i0: k + 1, b }; };
        const rw = fW >= 0 ? mk(fW) : null, rc = fC >= 0 ? mk(fC) : null;
        if (rw) wick.push(rw); if (rc) rows.push(rc);
      }
    }
  }
  console.log('══ 一般單 A：15m 動能突破（1H 趨勢同向）——進場確認方式 ══');
  print([stats(wick, '影線觸發就成交（舊規則）'), stats(rows, '收盤站上才成交（現行）'), stats(wick.filter(x => x.isLong), '影線｜多'), stats(wick.filter(x => !x.isLong), '影線｜空'), stats(rows.filter(x => x.isLong), '收盤｜多'), stats(rows.filter(x => !x.isLong), '收盤｜空')]);
  filterReport(rows, '一般單 A 過濾條件（收盤確認版）');
  return rows;
}

// ══ 一般單 B：15m 回踩 EMA20 限價（多＋空）══
function expPullback() {
  const rows = []; let signals = 0, flew = 0;
  for (const sym of Object.keys(D['15m'])) {
    if (!okSym(sym)) continue;
    const b = D['15m'][sym]; const A = atr(b), E = ema(b.map(x => x[4]), 20), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) {
      const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const near = isLong ? (b[i][4] > E[i] * 1.003 && b[i][4] < E[i] * 1.02 && b[i][4] > b[i - 1][4]) : (b[i][4] < E[i] * 0.997 && b[i][4] > E[i] * 0.98 && b[i][4] < b[i - 1][4]);
        if (!near) continue; last[key] = i; signals++;
        const entry = E[i]; const sl = isLong ? Math.min(llv(b, i, 10), entry - 0.9 * A[i]) - 0.3 * A[i] : Math.max(hhv(b, i, 10), entry + 0.9 * A[i]) + 0.3 * A[i];
        const risk = Math.abs(entry - sl); if (!(risk > 0) || risk / entry > 0.03) continue;
        const tp1 = isLong ? entry + 1.5 * risk : entry - 1.5 * risk; let fill = -1;
        for (let k = i + 1; k <= Math.min(b.length - 1, i + 16); k++) { if (isLong ? b[k][2] >= tp1 : b[k][3] <= tp1) { flew++; break; } if (isLong ? b[k][3] <= entry : b[k][2] >= entry) { fill = k; break; } }
        if (fill < 0) continue;
        const r = simulate(b, fill + 1, isLong, entry, sl, 1.5, 3.0, 96, FEE_RT * entry / risk); if (r) rows.push({ ...r, sym, t: b[fill][0], c, isLong, sess: session(b[i][0]), rsv: rsRank(b[i][0])[sym], ch: chipsAt(sym, b[i][0]) });
      }
    }
  }
  console.log(`══ 一般單 B：15m 回踩 EMA20 限價：訊號 ${signals}、成交 ${rows.length}（${(rows.length / signals * 100).toFixed(0)}%）、未回踩直接飛越止盈一 ${flew}（${(flew / signals * 100).toFixed(0)}%）══`);
  print([stats(rows, '成交的回踩單'), stats(rows.filter(x => x.isLong), '多'), stats(rows.filter(x => !x.isLong), '空')]);
  filterReport(rows, '一般單 B 過濾條件');
  return rows;
}

// ══ 快速單：5m 動能／回歸，多＋空；止損下限、時段、時間停損 ══
function expScalp() {
  if (!D['5m']) { console.log('（無 5m 資料）'); return []; }
  const out = { mom07: [], mom125: [], rev07: [], rev125: [] }; const tagged = [];
  for (const sym of Object.keys(D['5m'])) {
    if (!okSym(sym) || !(D['5m'][sym] && D['5m'][sym].length > 500)) continue;
    const b = D['5m'][sym]; const A = atr(b), R = rsi(b); const b15 = D['15m'][sym]; const e15 = { f: ema(b15.map(x => x[4]), 20), s: ema(b15.map(x => x[4]), 50) }, q15 = mkHtf(b15); const ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 30; i++) {
      const i15 = q15(b[i][0], TFMS['15m']); if (i15 < 50) continue; const up15 = e15.f[i15] > e15.s[i15], dn15 = e15.f[i15] < e15.s[i15]; const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 6) continue;
        const mom = isLong ? (up15 && b[i][4] > hhv(b, i, 20) && b[i][4] > b[i][1]) : (dn15 && b[i][4] < llv(b, i, 20) && b[i][4] < b[i][1]);
        const rng = b[i][2] - b[i][3];
        const rev = isLong ? (R[i] < 28 && b[i][4] > b[i][3] + 0.5 * rng) : (R[i] > 72 && b[i][4] < b[i][2] - 0.5 * rng);
        if (!mom && !rev) continue; last[key] = i;
        const entry = b[i][4];
        const run = (floorPct, key2) => { const risk = Math.max(0.7 * A[i], floorPct * entry); const sl = isLong ? entry - risk : entry + risk; const feeR = FEE_RT * entry / risk; const r = simulate(b, i + 1, isLong, entry, sl, 1.0, 1.6, 12, feeR); if (r) { const row = { ...r, feeR, sym, t: b[i][0], c, isLong, sess: session(b[i][0]), rsv: rsRank(b[i][0])[sym], ch: chipsAt(sym, b[i][0]), mode: mom ? 'mom' : 'rev', entry, sl, i0: i + 1, b }; out[key2].push(row); if (key2.endsWith('125')) tagged.push(row); } };
        if (mom) { run(0.004, 'mom07'); run(0.0125, 'mom125'); } else { run(0.004, 'rev07'); run(0.0125, 'rev125'); }
      }
    }
  }
  const fee = k => out[k].length ? (out[k].reduce((a, x) => a + x.feeR, 0) / out[k].length).toFixed(2) : '-';
  console.log('══ 快速單：5m（止盈一 1R 出 60%、止盈二 1.6R、最長 12 根＝1 小時）——止損距離與手續費 ══');
  print([stats(out.mom07, `動能突破｜止損 0.7×ATR（平均費 ${fee('mom07')}R）`), stats(out.mom125, `動能突破｜止損下限 1.25%（平均費 ${fee('mom125')}R）`),
    stats(out.rev07, `RSI 極端回歸｜止損 0.7×ATR（平均費 ${fee('rev07')}R）`), stats(out.rev125, `RSI 極端回歸｜止損下限 1.25%（平均費 ${fee('rev125')}R）`),
    stats(out.mom125.filter(x => x.isLong), '動能｜多（1.25%）'), stats(out.mom125.filter(x => !x.isLong), '動能｜空（1.25%）'), stats(out.rev125.filter(x => x.isLong), '回歸｜多（1.25%）'), stats(out.rev125.filter(x => !x.isLong), '回歸｜空（1.25%）')]);
  filterReport(tagged.filter(x => x.mode === 'mom'), '快速單 動能模式 過濾條件（止損下限 1.25% 版）');
  // 時間停損／持有時間變化（動能 1.25%）
  const vary = (maxBars, tp1R, tp2R, p1, lockR) => { const rows = []; for (const x of out.mom125) { const r = simulate(x.b, x.i0, x.isLong, x.entry, x.sl, tp1R, tp2R, maxBars, x.feeR, p1, lockR); if (r) rows.push({ ...r, t: x.t }); } return rows; };
  console.log('══ 快速單 動能模式：出場結構變化 ══');
  print([stats(vary(12, 1.0, 1.6, 0.6, 0.5), '現行：1R 出 60%，鎖 +0.5R，1.6R，12 根'), stats(vary(24, 1.0, 1.6, 0.6, 0.5), '最長 24 根'), stats(vary(12, 1.0, 2.0, 0.4, 0.3), '1R 出 40%，鎖 +0.3R，2R'), stats(vary(12, 1.5, 1.5, 1, 0), '不分批 1.5R'), stats(vary(12, 1.2, 1.2, 1, 0), '不分批 1.2R'), stats(vary(12, 0.8, 1.6, 0.5, 0.2), '0.8R 出 50%，鎖 +0.2R，1.6R')]);
  return tagged;
}

// ══ 一般單 出場結構 ══
function expExit(rows) {
  const vary = (tp1R, tp2R, p1, lockR, maxBars = 96) => { const o = []; for (const x of rows) { const r = simulate(x.b, x.i0, x.isLong, x.entry, x.sl, tp1R, tp2R, maxBars, FEE_RT * x.entry / Math.abs(x.entry - x.sl), p1, lockR); if (r) o.push({ ...r, t: x.t }); } return o; };
  console.log('══ 一般單 A 出場結構（同一批突破單）══');
  print([stats(vary(1.0, 1.8, 0.6, 0.5), '止盈一 1R 出 60%＋1.8R'), stats(vary(1.5, 3.0, 0.6, 0.5), '止盈一 1.5R 出 60%＋3R（現行）'), stats(vary(1.5, 3.0, 0.4, 0.3), '止盈一 1.5R 出 40%，鎖 +0.3R，3R'), stats(vary(2.0, 2.0, 1, 0), '不分批 2R'), stats(vary(1.5, 4.0, 0.5, 0.5), '1.5R 出 50%＋4R'), stats(vary(1.5, 3.0, 0.6, 0.5, 48), '現行但最長 48 根（12 小時）'), stats(vary(1.5, 3.0, 0.6, 0.5, 192), '現行但最長 192 根（2 天）')]);
}

if (!D['15m'] || !D['1H']) { console.log('缺資料：', Object.keys(D).filter(k => !D[k])); process.exit(1); }
const span = b => `${new Date(b[0][0]).toISOString().slice(0, 10)}～${new Date(b[b.length - 1][0]).toISOString().slice(0, 10)}`;
console.log(`資料：${Object.keys(D['15m']).length} 個幣；15m ${D['15m']['BTC/USDT'].length} 根（${span(D['15m']['BTC/USDT'])}）、1H ${D['1H']['BTC/USDT'].length} 根（${span(D['1H']['BTC/USDT'])}）、5m ${D['5m'] ? D['5m']['BTC/USDT'].length : 0} 根（${D['5m'] ? span(D['5m']['BTC/USDT']) : '-'}）；籌碼資料：${CH ? '有' : '無'}；費用來回 ${FEE_RT * 100}%\n`);
const A = expBreakout(); expPullback(); expExit(A);

// ══ 追加實驗 ══
function expRobust(rows) {
  // 1) 悲觀成交：收盤確認時以「確認棒收盤價」成交（而非觸發價）＋滑價 0.05%
  const pess = []; for (const x of rows) { const k = x.i0 - 1; const close = x.b[k][4]; const entry = x.isLong ? close * 1.0005 : close * 0.9995; const risk = Math.abs(x.entry - x.sl); const sl = x.sl; const riskNew = Math.abs(entry - sl); if (!(riskNew > 0)) continue; const r = simulate(x.b, x.i0, x.isLong, entry, sl, 1.5, 3.0, 96, FEE_RT * entry / riskNew); if (r) pess.push({ ...r, t: x.t, isLong: x.isLong, c: x.c }); }
  // 1b) 悲觀但止損距離照「新進場價」重算（網站實際做法：成交後重新定位 SL）
  const pess2 = []; for (const x of rows) { const k = x.i0 - 1; const close = x.b[k][4]; const entry = x.isLong ? close * 1.0005 : close * 0.9995; const risk = Math.abs(x.entry - x.sl); const sl = x.isLong ? entry - risk : entry + risk; const r = simulate(x.b, x.i0, x.isLong, entry, sl, 1.5, 3.0, 96, FEE_RT * entry / risk); if (r) pess2.push({ ...r, t: x.t, isLong: x.isLong, c: x.c }); }
  console.log('══ 穩健性：一般單 A 悲觀成交（確認棒收盤價＋0.05% 滑價）══');
  print([stats(rows, '觸發價成交（樂觀）'), stats(pess, '確認棒收盤成交，止損不動'), stats(pess2, '確認棒收盤成交，止損依新進場價重放'), stats(pess2.filter(x => x.isLong), '悲觀｜多'), stats(pess2.filter(x => !x.isLong), '悲觀｜空')]);
  // 2) 組合條件（悲觀版）前後半
  const [h1, h2] = half(pess2);
  const combos = [['順 BTC 日線', x => x.isLong ? x.c.btcDUp : !x.c.btcDUp], ['順 BTC 日線＋4H ADX≥20', x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && x.c.adx4 >= 20], ['順 BTC 日線＋日線同向', x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && (x.isLong ? x.c.dUp : x.c.dDn)], ['順 BTC 日線＋順 BTC 1H＋ADX≥20', x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && (x.isLong ? x.c.btcUp : x.c.btcDn) && x.c.adx4 >= 20], ['只做多', x => x.isLong], ['只做多＋ADX≥20', x => x.isLong && x.c.adx4 >= 20]];
  console.log('══ 一般單 A 組合過濾（悲觀成交版）：全 / 前半 / 後半 ══');
  console.log(['條件', '筆數', '勝率%', '期望R', '｜前半 筆', '勝率', '期望R', '｜後半 筆', '勝率', '期望R'].join('\t'));
  for (const [l, f] of [['全部', () => true], ...combos]) { const a = stats(pess2.filter(f), l), b = stats(h1.filter(f), ''), c = stats(h2.filter(f), ''); console.log([l, a.n, a.wr ?? '-', a.exp ?? '-', '｜' + b.n, b.wr ?? '-', b.exp ?? '-', '｜' + c.n, c.wr ?? '-', c.exp ?? '-'].join('\t')); }
  console.log('');
  return pess2;
}
// 3) 「學習」模擬：前半段挑出期望值最高的 k 個條件（任一成立就做），後半段驗證；對照「不挑」
function expLearn(rows, title) {
  const [h1, h2] = half(rows);
  const scored = FILTERS.map(([l, f]) => { const s = stats(h1.filter(f), l); return { l, f, n: s.n, exp: s.exp ?? -9 }; }).filter(x => x.n >= 30).sort((a, b) => b.exp - a.exp);
  console.log(`══ 學習模擬（${title}）：前半段最佳條件 → 後半段表現（樣本 ≥30）══`);
  console.log(['前半段挑出的條件', '前半 期望R', '後半 筆', '後半 勝率', '後半 期望R', '｜對照：後半全部期望R'].join('\t'));
  const base = stats(h2, '');
  for (const x of scored.slice(0, 5)) { const s = stats(h2.filter(x.f), ''); console.log([x.l, x.exp, s.n, s.wr ?? '-', s.exp ?? '-', '｜' + base.exp].join('\t')); }
  const worst = scored.slice(-3);
  for (const x of worst) { const s = stats(h2.filter(x.f), ''); console.log(['（前半最差）' + x.l, x.exp, s.n, s.wr ?? '-', s.exp ?? '-', '｜' + base.exp].join('\t')); }
  console.log('');
}
// 4) 快速單改到 15m：同一套動能突破訊號，出場 1R 出 60%／1.8R，最長 24 根（6 小時）
function expScalp15() {
  const rows = [];
  for (const sym of Object.keys(D['15m'])) {
    if (!okSym(sym)) continue;
    const b = D['15m'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 30; i++) {
      const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 6) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const mom = isLong ? (b[i][4] > hhv(b, i, 20) && b[i][4] > b[i][1]) : (b[i][4] < llv(b, i, 20) && b[i][4] < b[i][1]);
        if (!mom) continue; last[key] = i;
        const entry = b[i][4] * (isLong ? 1.0005 : 0.9995); const risk = Math.max(0.7 * A[i], 0.0125 * entry); const sl = isLong ? entry - risk : entry + risk; const feeR = FEE_RT * entry / risk;
        const r = simulate(b, i + 1, isLong, entry, sl, 1.0, 1.8, 24, feeR); if (r) rows.push({ ...r, t: b[i][0], isLong, c, sess: session(b[i][0]), rsv: rsRank(b[i][0])[sym], ch: chipsAt(sym, b[i][0]) });
      }
    }
  }
  console.log('══ 快速單改 15m：動能突破市價進（含 0.05% 滑價）、止損 max(0.7ATR, 1.25%)、1R 出 60%／1.8R、最長 6 小時 ══');
  print([stats(rows, '全部'), stats(rows.filter(x => x.isLong), '多'), stats(rows.filter(x => !x.isLong), '空'), stats(rows.filter(x => x.isLong ? x.c.btcDUp : !x.c.btcDUp), '順 BTC 日線'), stats(rows.filter(x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && x.c.adx4 >= 20), '順 BTC 日線＋ADX≥20')]);
  const [h1, h2] = half(rows); print([stats(h1, '前半'), stats(h2, '後半'), stats(h2.filter(x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && x.c.adx4 >= 20), '後半｜順 BTC 日線＋ADX≥20')]);
  return rows;
}
// 5) 5m 快速單：加上 1H 趨勢＋順 BTC 日線 後，各模式是否還有任何正期望（悲觀成交）
function expScalpFiltered(tagged) {
  const f1 = x => (x.isLong ? x.c.h1Up : x.c.h1Dn), f2 = x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp);
  console.log('══ 5m 快速單（止損下限 1.25%）疊加過濾：全 / 前半 / 後半 ══');
  console.log(['條件', '筆數', '勝率%', '期望R', '｜前半 筆', '勝率', '期望R', '｜後半 筆', '勝率', '期望R'].join('\t'));
  const sets = [['動能｜全部', x => x.mode === 'mom'], ['動能＋1H 同向', x => x.mode === 'mom' && f1(x)], ['動能＋1H 同向＋順 BTC 日線', x => x.mode === 'mom' && f1(x) && f2(x)], ['動能＋1H 同向＋順 BTC 日線＋ADX≥20', x => x.mode === 'mom' && f1(x) && f2(x) && x.c.adx4 >= 20], ['回歸｜全部', x => x.mode === 'rev'], ['回歸＋順 BTC 日線', x => x.mode === 'rev' && f2(x)], ['回歸＋ADX<20（非趨勢）', x => x.mode === 'rev' && x.c.adx4 < 20], ['回歸＋1H 同向（順勢回歸）', x => x.mode === 'rev' && f1(x)]];
  const [h1, h2] = half(tagged);
  for (const [l, f] of sets) { const a = stats(tagged.filter(f), l), b = stats(h1.filter(f), ''), c = stats(h2.filter(f), ''); console.log([l, a.n, a.wr ?? '-', a.exp ?? '-', '｜' + b.n, b.wr ?? '-', b.exp ?? '-', '｜' + c.n, c.wr ?? '-', c.exp ?? '-'].join('\t')); }
  console.log('');
}
const P = expRobust(A); expLearn(A, '一般單 A 突破'); const S = expScalp(); expLearn(S.filter(x => x.mode === 'mom'), '5m 快速單 動能'); expScalpFiltered(S); expScalp15();

// ══ 追加二：機器人實際成交模型 ══
// (a) 停損單在觸發價成交＋0.05% 滑價（Telegram 機器人掛停損進場單的真實情況），止損依成交價重放
function expWickReal() {
  const rows = [];
  for (const sym of Object.keys(D['15m'])) {
    if (!okSym(sym)) continue;
    const b = D['15m'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) {
      const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const body = isLong ? b[i][4] > b[i][1] : b[i][4] < b[i][1];
        const brk = (isLong ? b[i][4] > lvl : b[i][4] < lvl) && body && (b[i][2] - b[i][3]) > 0.8 * A[i]; if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1;
        for (let j = i + 1; j <= Math.min(b.length - 1, i + 8); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; }
        if (k < 0) continue;
        const entry = trig * (isLong ? 1.0005 : 0.9995); const risk = Math.max(0.9 * A[i], 0.008 * entry); const sl = isLong ? entry - risk : entry + risk; const feeR = FEE_RT * entry / risk;
        // 成交棒本身也要檢查是否同棒打到止損（保守：成交棒內先算止損）
        const r = simulate(b, k, isLong, entry, sl, 1.5, 3.0, 96, feeR); if (r) rows.push({ ...r, sym, t: b[k][0], c, isLong, sess: session(b[i][0]), rsv: rsRank(b[i][0])[sym], ch: chipsAt(sym, b[i][0]), entry, sl, i0: k, b });
      }
    }
  }
  console.log('══ 一般單 A 真實成交模型：停損單觸發價成交＋0.05% 滑價，成交棒含止損檢查 ══');
  print([stats(rows, '全部'), stats(rows.filter(x => x.isLong), '多'), stats(rows.filter(x => !x.isLong), '空')]);
  filterReport(rows, '一般單 A（真實成交）過濾條件');
  expLearn(rows, '一般單 A 真實成交');
  const [h1, h2] = half(rows);
  const combos = [['順 BTC 日線', x => x.isLong ? x.c.btcDUp : !x.c.btcDUp], ['順 BTC 日線＋4H ADX≥20', x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && x.c.adx4 >= 20], ['順 BTC 日線＋4H ADX≥30', x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && x.c.adx4 >= 30], ['順 BTC 日線＋順 BTC 1H＋ADX≥20', x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && (x.isLong ? x.c.btcUp : x.c.btcDn) && x.c.adx4 >= 20], ['順 BTC 日線＋日線同向＋ADX≥20', x => (x.isLong ? x.c.btcDUp : !x.c.btcDUp) && (x.isLong ? x.c.dUp : x.c.dDn) && x.c.adx4 >= 20], ['逆 BTC 日線（應擋）', x => x.isLong ? !x.c.btcDUp : x.c.btcDUp], ['逆 BTC 日線＋逆 BTC 1H（應擋）', x => (x.isLong ? !x.c.btcDUp : x.c.btcDUp) && (x.isLong ? x.c.btcDn : x.c.btcUp)]];
  console.log('══ 一般單 A（真實成交）組合過濾：全 / 前半 / 後半 ══');
  console.log(['條件', '筆數', '勝率%', '期望R', '｜前半 筆', '勝率', '期望R', '｜後半 筆', '勝率', '期望R'].join('\t'));
  for (const [l, f] of [['全部', () => true], ...combos]) { const a = stats(rows.filter(f), l), b = stats(h1.filter(f), ''), c = stats(h2.filter(f), ''); console.log([l, a.n, a.wr ?? '-', a.exp ?? '-', '｜' + b.n, b.wr ?? '-', b.exp ?? '-', '｜' + c.n, c.wr ?? '-', c.exp ?? '-'].join('\t')); }
  console.log('');
  // 出場結構（真實成交版）
  const vary = (tp1R, tp2R, p1, lockR, maxBars = 96) => { const o = []; for (const x of rows) { const r = simulate(x.b, x.i0, x.isLong, x.entry, x.sl, tp1R, tp2R, maxBars, FEE_RT * x.entry / Math.abs(x.entry - x.sl), p1, lockR); if (r) o.push({ ...r, t: x.t }); } return o; };
  console.log('══ 一般單 A（真實成交）出場結構 ══');
  print([stats(vary(1.0, 1.8, 0.6, 0.5), '1R 出 60%＋1.8R'), stats(vary(1.0, 2.5, 0.5, 0.3), '1R 出 50%，鎖 +0.3R，2.5R'), stats(vary(1.5, 3.0, 0.6, 0.5), '1.5R 出 60%＋3R（現行）'), stats(vary(1.5, 3.0, 0.5, 0.0), '1.5R 出 50%，鎖保本，3R'), stats(vary(1.5, 4.0, 0.5, 0.5), '1.5R 出 50%＋4R'), stats(vary(2.0, 2.0, 1, 0), '不分批 2R'), stats(vary(1.5, 3.0, 0.6, 0.5, 48), '現行、最長 12 小時')]);
  return rows;
}
// (b) 網站追蹤模型：1m 收盤站上才算成交 → 用 5m 收盤近似（21 天重疊窗），成交價＝該 5m 收盤＋滑價，之後在 5m 棒上模擬出場
function expConfirm5m() {
  const rowsW = [], rowsC = [];
  for (const sym of Object.keys(D['15m'])) {
    if (!okSym(sym) || !(D['5m'][sym] && D['5m'][sym].length > 500)) continue;
    const b = D['15m'][sym], b5 = D['5m'][sym]; const A = atr(b), ctx = ctxFor(sym); const q5 = mkHtf(b5); const t5start = b5[0][0]; let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) {
      if (b[i][0] < t5start + 3600e3) continue; const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const body = isLong ? b[i][4] > b[i][1] : b[i][4] < b[i][1];
        const brk = (isLong ? b[i][4] > lvl : b[i][4] < lvl) && body && (b[i][2] - b[i][3]) > 0.8 * A[i]; if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i];
        const j0 = q5(b[i][0] + TFMS['15m'], TFMS['5m']) + 1; if (j0 < 1 || j0 >= b5.length - 300) continue;
        let kw = -1, kc = -1;
        for (let j = j0; j < Math.min(b5.length, j0 + 24); j++) { if (kw < 0 && (isLong ? b5[j][2] >= trig : b5[j][3] <= trig)) kw = j; if (kc < 0 && (isLong ? b5[j][4] >= trig : b5[j][4] <= trig)) kc = j; if (kw >= 0 && kc >= 0) break; }
        const risk0 = Math.max(0.9 * A[i], 0.008 * trig);
        if (kw >= 0) { const entry = trig * (isLong ? 1.0005 : 0.9995); const sl = isLong ? entry - risk0 : entry + risk0; const r = simulate(b5, kw, isLong, entry, sl, 1.5, 3.0, 288, FEE_RT * entry / risk0); if (r) rowsW.push({ ...r, t: b5[kw][0], isLong, c }); }
        if (kc >= 0) { const entry = b5[kc][4] * (isLong ? 1.0005 : 0.9995); const sl = isLong ? entry - risk0 : entry + risk0; const r = simulate(b5, kc + 1, isLong, entry, sl, 1.5, 3.0, 288, FEE_RT * entry / risk0); if (r) rowsC.push({ ...r, t: b5[kc][0], isLong, c, slipR: Math.abs(entry - trig) / risk0 }); }
      }
    }
  }
  const avgSlip = rowsC.length ? (rowsC.reduce((a, x) => a + x.slipR, 0) / rowsC.length).toFixed(2) : '-';
  console.log(`══ 進場確認方式（21 天重疊窗，5m 棒模擬）：觸發價成交 vs 5m 收盤站上才成交（平均多付 ${avgSlip}R）══`);
  print([stats(rowsW, '觸發價成交（機器人停損單）'), stats(rowsC, '5m 收盤確認後市價（網站追蹤口徑）'), stats(rowsW.filter(x => x.isLong), '觸發｜多'), stats(rowsC.filter(x => x.isLong), '確認｜多')]);
}
const W = expWickReal(); expConfirm5m();
