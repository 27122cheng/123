// 回測 v3：① 機率模型（前半訓練／後半驗證）② 新進場模型 ③ 市場寬度 ④ 依機率調倉的權益曲線
import { D, CH, FEE_RT, okSym, ema, atr, adx, rsi, hhv, llv, mkHtf, TFMS, session, simulate, stats, print, ctxFor, rsRank, chipsAt, half, breadth } from './btlib.mjs';

const SLIP = 0.0005;
// ── 突破單（真實成交）產生器：回傳含特徵的交易列 ──
function genBreakout({ tp1R = 1.0, tp2R = 2.5, p1 = 0.5, lockR = 0.3 } = {}) {
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
        const entry = trig * (isLong ? 1 + SLIP : 1 - SLIP); const risk = Math.max(0.9 * A[i], 0.008 * entry); const sl = isLong ? entry - risk : entry + risk; const feeR = FEE_RT * entry / risk;
        const r = simulate(b, k, isLong, entry, sl, tp1R, tp2R, 96, feeR, p1, lockR); if (!r) continue;
        const ch = chipsAt(sym, b[i][0]) || {};
        const atrPct = A[i] / b[i][4]; const br = breadth(b[i][0]);
        const rsv = rsRank(b[i][0])[sym];
        rows.push({ ...r, sym, t: b[k][0], isLong, c, sess: session(b[i][0]), rsv, ch, atrPct, br, win: r.r > 0 ? 1 : 0,
          // 特徵（全部轉成「對這筆方向而言」的順向量）
          f: {
            btcD: (isLong ? c.btcDUp : !c.btcDUp) ? 1 : 0,
            btcH: (isLong ? c.btcUp : c.btcDn) ? 1 : (isLong ? c.btcDn : c.btcUp) ? -1 : 0,
            h4: (isLong ? c.h4Up : c.h4Dn) ? 1 : -1,
            d1: (isLong ? c.dUp : c.dDn) ? 1 : -1,
            adx4: Math.min(60, c.adx4) / 60,
            rsiAl: ((isLong ? c.h1Rsi : 100 - c.h1Rsi) - 50) / 50,     // 順向 RSI 偏離（多：RSI−50；空：50−RSI）
            rs: rsv != null ? ((isLong ? rsv : 100 - rsv) - 50) / 50 : 0,
            ls: ch.ls != null ? Math.max(-1, Math.min(1, (isLong ? ch.ls - 1 : 1 - ch.ls))) : 0,
            lsKnown: ch.ls != null ? 1 : 0,
            oi: ch.oiChg != null ? Math.max(-1, Math.min(1, ch.oiChg * 10)) : 0,
            vol: Math.min(1, atrPct / 0.02),
            brAl: isLong ? br - 0.5 : 0.5 - br,
            lnny: session(b[i][0]) === 'LN/NY' ? 1 : 0,
            isLong: isLong ? 1 : 0,
          } });
      }
    }
  }
  return rows;
}

// ── 邏輯迴歸（L2，梯度下降）──
const FEATS = ['btcD', 'btcH', 'h4', 'd1', 'adx4', 'rsiAl', 'rs', 'ls', 'lsKnown', 'oi', 'vol', 'brAl', 'lnny', 'isLong'];
function fitLogit(rows, feats = FEATS, { iters = 3000, lr = 0.05, l2 = 0.01 } = {}) {
  const w = new Array(feats.length).fill(0); let b0 = 0; const n = rows.length;
  const X = rows.map(r => feats.map(f => r.f[f])), Y = rows.map(r => r.win);
  for (let it = 0; it < iters; it++) {
    const gw = new Array(feats.length).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { let z = b0; for (let j = 0; j < feats.length; j++) z += w[j] * X[i][j]; const p = 1 / (1 + Math.exp(-z)); const e = p - Y[i]; gb += e; for (let j = 0; j < feats.length; j++) gw[j] += e * X[i][j]; }
    b0 -= lr * gb / n; for (let j = 0; j < feats.length; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  const pred = r => { let z = b0; for (let j = 0; j < feats.length; j++) z += w[j] * r.f[feats[j]]; return 1 / (1 + Math.exp(-z)); };
  return { w, b0, feats, pred };
}
const auc = (rows, pf) => { const pos = rows.filter(r => r.win), neg = rows.filter(r => !r.win); let s = 0; for (const p of pos) for (const q of neg) s += pf(p) > pf(q) ? 1 : pf(p) === pf(q) ? 0.5 : 0; return pos.length && neg.length ? s / (pos.length * neg.length) : 0.5; };
const brier = (rows, pf) => rows.reduce((a, r) => a + (pf(r) - r.win) ** 2, 0) / rows.length;
function decileTable(rows, pf, title) {
  const s = [...rows].sort((a, b) => pf(b) - pf(a)); const n = s.length; const out = [];
  for (let d = 0; d < 5; d++) { const part = s.slice(Math.floor(d * n / 5), Math.floor((d + 1) * n / 5)); const st = stats(part, `第 ${d + 1} 檔（預測 ${(pf(part[0]) * 100).toFixed(0)}%～${(pf(part[part.length - 1]) * 100).toFixed(0)}%）`); out.push(st); }
  console.log(`── ${title}：依預測勝率分五檔（高→低）──`); print(out);
}

function expModel() {
  const rows = genBreakout();
  const [h1, h2] = half(rows);
  console.log(`══ ① 機率模型：突破單 ${rows.length} 筆（出場 1R 出 50%／鎖 0.3R／2.5R），前半 ${h1.length} 訓練、後半 ${h2.length} 驗證 ══`);
  const m = fitLogit(h1);
  console.log('係數（順向量，正＝提高勝率）：' + m.feats.map((f, j) => `${f} ${m.w[j].toFixed(2)}`).join('、') + `、截距 ${m.b0.toFixed(2)}`);
  console.log(`後半 AUC ${auc(h2, m.pred).toFixed(3)}（0.5＝無鑑別力）　Brier ${brier(h2, m.pred).toFixed(3)}（基準 ${brier(h2, () => h1.filter(x => x.win).length / h1.length).toFixed(3)}）`);
  decileTable(h2, m.pred, '後半段（樣本外）');
  // 門檻掃描：只做預測 ≥ p 的單
  console.log('── 後半段：只做預測勝率 ≥ 門檻的單 ──');
  print([0, 0.45, 0.5, 0.55, 0.6, 0.65].map(p => stats(h2.filter(r => m.pred(r) >= p), `p ≥ ${p}`)));
  // 對照：簡單加總規則（現行閘門：順 BTC 日線 & ADX≥20）
  print([stats(h2, '後半全部'), stats(h2.filter(r => r.f.btcD && r.c.adx4 >= 20), '現行硬擋（順 BTC 日線＋ADX≥20）'), stats(h2.filter(r => r.f.btcD && r.c.adx4 >= 20 && m.pred(r) >= 0.55), '現行硬擋＋p≥0.55')]);
  // 全樣本重訓（部署用係數）＋反向驗證（後半訓練、前半驗證）
  const m2 = fitLogit(h2); console.log(`反向驗證：後半訓練→前半 AUC ${auc(h1, m2.pred).toFixed(3)}`); decileTable(h1, m2.pred, '前半段（反向樣本外）');
  const mAll = fitLogit(rows);
  console.log('全樣本係數（部署）：' + JSON.stringify(Object.fromEntries(mAll.feats.map((f, j) => [f, +mAll.w[j].toFixed(3)]))) + ` 截距 ${mAll.b0.toFixed(3)}`);
  // 權益曲線：固定注 vs 依機率調倉（p<0.5 不做；注＝(p−0.45)/0.2 夾 0.5~1.5）
  const eq = (rs, sz) => { let e = 0, pk = 0, dd = 0; for (const r of [...rs].sort((a, b) => a.t - b.t)) { const s = sz(r); e += s * r.r; pk = Math.max(pk, e); dd = Math.max(dd, pk - e); } return { net: +e.toFixed(1), dd: +dd.toFixed(1) }; };
  const fixed = eq(h2, () => 1), sized = eq(h2, r => { const p = m.pred(r); return p < 0.5 ? 0 : Math.max(0.5, Math.min(1.5, (p - 0.45) / 0.2)); });
  console.log(`後半權益：固定注 淨 ${fixed.net}R／回撤 ${fixed.dd}R；依機率調倉 淨 ${sized.net}R／回撤 ${sized.dd}R\n`);
  return { rows, mAll };
}

// ── ② 新進場模型 ──
function expNewEntries() {
  // a. 1H 突破（20 根高低點）、4H 同向、停損單成交、止損 max(1×ATR1H, 1%)、1R 出 50%／2.5R、最長 72 小時
  const a = [];
  for (const sym of Object.keys(D['1H'])) {
    if (!okSym(sym)) continue;
    const b = D['1H'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 20; i++) {
      const c = ctx(b[i][0] + TFMS['1H']); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 6) continue; if (isLong ? !c.h4Up : !c.h4Dn) continue;
        const lvl = isLong ? hhv(b, i, 20) : llv(b, i, 20); const brk = (isLong ? b[i][4] > lvl && b[i][4] > b[i][1] : b[i][4] < lvl && b[i][4] < b[i][1]); if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1;
        for (let j = i + 1; j <= Math.min(b.length - 1, i + 4); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; }
        if (k < 0) continue;
        const entry = trig * (isLong ? 1 + SLIP : 1 - SLIP); const risk = Math.max(1.0 * A[i], 0.01 * entry); const sl = isLong ? entry - risk : entry + risk;
        const r = simulate(b, k, isLong, entry, sl, 1.0, 2.5, 72, FEE_RT * entry / risk, 0.5, 0.3); if (r) a.push({ ...r, t: b[k][0], isLong, c });
      }
    }
  }
  // b. 15m 布林收縮後突破：帶寬在 60 根最低 20% 內，收盤突破上/下軌，1H 同向
  const bb = [];
  for (const sym of Object.keys(D['15m'])) {
    if (!okSym(sym)) continue;
    const b = D['15m'][sym]; const A = atr(b), ctx = ctxFor(sym); const cl = b.map(x => x[4]); const E = ema(cl, 20);
    const sd = cl.map((_, i) => { if (i < 20) return 0; let s = 0; for (let k = i - 19; k <= i; k++) s += (cl[k] - E[i]) ** 2; return Math.sqrt(s / 20); });
    const bw = sd.map((s, i) => E[i] ? 4 * s / E[i] : 0); let last = { 1: -100, 0: -100 };
    for (let i = 80; i < b.length - 40; i++) {
      const c = ctx(b[i][0]); if (!c.ok) continue;
      let lo = Infinity, hi = -Infinity; for (let k = i - 60; k < i; k++) { lo = Math.min(lo, bw[k]); hi = Math.max(hi, bw[k]); }
      const squeezed = bw[i - 1] <= lo + 0.2 * (hi - lo); if (!squeezed) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        const up = E[i] + 2 * sd[i], dn = E[i] - 2 * sd[i]; const brk = isLong ? b[i][4] > up && b[i][4] > b[i][1] : b[i][4] < dn && b[i][4] < b[i][1]; if (!brk) continue; last[key] = i;
        const entry = b[i][4] * (isLong ? 1 + SLIP : 1 - SLIP); const risk = Math.max(0.9 * A[i], 0.008 * entry); const sl = isLong ? entry - risk : entry + risk;
        const r = simulate(b, i + 1, isLong, entry, sl, 1.0, 2.5, 96, FEE_RT * entry / risk, 0.5, 0.3); if (r) bb.push({ ...r, t: b[i][0], isLong, c });
      }
    }
  }
  // c. 回踩確認：前 1~3 根曾回到 EMA20 ±0.3ATR，本根收回趨勢側且實體同向 → 市價進；止損＝回踩極值外 0.3ATR（下限 0.8%）
  const pc = [];
  for (const sym of Object.keys(D['15m'])) {
    if (!okSym(sym)) continue;
    const b = D['15m'][sym]; const A = atr(b), ctx = ctxFor(sym); const E = ema(b.map(x => x[4]), 20); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 40; i++) {
      const c = ctx(b[i][0]); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 8) continue; if (isLong ? !c.h1Up : !c.h1Dn) continue;
        let touched = false, ext = isLong ? Infinity : -Infinity;
        for (let k = i - 3; k < i; k++) { if (isLong ? b[k][3] <= E[k] + 0.3 * A[k] : b[k][2] >= E[k] - 0.3 * A[k]) { touched = true; ext = isLong ? Math.min(ext, b[k][3]) : Math.max(ext, b[k][2]); } }
        if (!touched) continue;
        const confirm = isLong ? (b[i][4] > E[i] && b[i][4] > b[i][1] && b[i][4] > b[i - 1][2]) : (b[i][4] < E[i] && b[i][4] < b[i][1] && b[i][4] < b[i - 1][3]);
        if (!confirm) continue; last[key] = i;
        const entry = b[i][4] * (isLong ? 1 + SLIP : 1 - SLIP); let sl = isLong ? ext - 0.3 * A[i] : ext + 0.3 * A[i]; const risk0 = Math.abs(entry - sl); const risk = Math.max(risk0, 0.008 * entry); sl = isLong ? entry - risk : entry + risk;
        if (risk / entry > 0.03) continue;
        const r = simulate(b, i + 1, isLong, entry, sl, 1.0, 2.5, 96, FEE_RT * entry / risk, 0.5, 0.3); if (r) pc.push({ ...r, t: b[i][0], isLong, c });
      }
    }
  }
  const rep = (rows, name) => { const [h1, h2] = half(rows); const al = r => r.isLong ? r.c.btcDUp : !r.c.btcDUp; print([stats(rows, `${name}｜全部`), stats(rows.filter(r => r.isLong), `${name}｜多`), stats(rows.filter(r => !r.isLong), `${name}｜空`), stats(rows.filter(al), `${name}｜順 BTC 日線`), stats(h1.filter(al), `${name}｜順 BTC 日線 前半`), stats(h2.filter(al), `${name}｜順 BTC 日線 後半`), stats(rows.filter(r => al(r) && r.c.adx4 >= 20), `${name}｜順 BTC 日線＋ADX≥20`)]); };
  console.log('══ ② 新進場模型（都用 1R 出 50%／鎖 0.3R／2.5R）══');
  rep(a, '1H 突破'); rep(bb, '15m 布林收縮突破'); rep(pc, '15m 回踩確認');
}

// ── ③ 市場寬度 ──
function expBreadth(rows) {
  console.log('══ ③ 市場寬度（池中 1H 多頭佔比）對突破單的影響 ══');
  const [h1, h2] = half(rows);
  const bands = [['寬度順向 ≥70%', r => (r.isLong ? r.br : 1 - r.br) >= 0.7], ['順向 55～70%', r => { const v = r.isLong ? r.br : 1 - r.br; return v >= 0.55 && v < 0.7; }], ['中性 45～55%', r => { const v = r.isLong ? r.br : 1 - r.br; return v >= 0.45 && v < 0.55; }], ['逆向 <45%', r => (r.isLong ? r.br : 1 - r.br) < 0.45]];
  console.log(['條件', '筆數', '勝率%', '期望R', '｜前半 筆', '勝率', '期望R', '｜後半 筆', '勝率', '期望R'].join('\t'));
  for (const [l, f] of bands) { const A = stats(rows.filter(f), l), B = stats(h1.filter(f), ''), C = stats(h2.filter(f), ''); console.log([l, A.n, A.wr ?? '-', A.exp ?? '-', '｜' + B.n, B.wr ?? '-', B.exp ?? '-', '｜' + C.n, C.wr ?? '-', C.exp ?? '-'].join('\t')); }
  console.log('');
}

const { rows } = expModel(); expBreadth(rows); expNewEntries();
