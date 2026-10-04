import { D, FEE_RT, okSym, atr, hhv, llv, TFMS, simulate, stats, print, ctxFor, half } from './btlib.mjs';
import fs from 'node:fs';
const src = fs.readFileSync('./bt3.mjs', 'utf8');
// 重用 bt3 的產生器與邏輯迴歸（以 eval 載入函式定義，避免重複貼）
const grab = (name) => { const m = src.match(new RegExp(`(function ${name}[\\s\\S]*?\\n})\\n`)); return m[1]; };
const lib = await import('./btlib.mjs');
const ctxCode = `const { D, CH, FEE_RT, okSym, ema, atr, adx, rsi, hhv, llv, mkHtf, TFMS, session, simulate, stats, print, ctxFor, rsRank, chipsAt, half, breadth } = lib; const SLIP = 0.0005;
${grab('genBreakout')}
${grab('fitLogit')}
const auc = ${src.match(/const auc = ([\s\S]*?);\n/)[1]};
return { genBreakout, fitLogit, auc };`;
const { genBreakout, fitLogit, auc } = new Function('lib', ctxCode)(lib);
const rows = genBreakout(); const [h1, h2] = half(rows);
const thirds = rs => { const ts = rs.map(x => x.t).sort((a, b) => a - b); const a = ts[Math.floor(ts.length / 3)], b = ts[Math.floor(2 * ts.length / 3)]; return [rs.filter(x => x.t < a), rs.filter(x => x.t >= a && x.t < b), rs.filter(x => x.t >= b)]; };
const dec = (rs, pf, title) => { const s = [...rs].sort((a, b) => pf(b) - pf(a)); const n = s.length; const out = []; for (let d = 0; d < 4; d++) { const part = s.slice(Math.floor(d * n / 4), Math.floor((d + 1) * n / 4)); out.push(stats(part, `第 ${d + 1} 檔 p ${(pf(part[0]) * 100).toFixed(0)}～${(pf(part[part.length - 1]) * 100).toFixed(0)}%`)); } console.log('── ' + title); print(out); };
for (const feats of [['btcD', 'btcH', 'h4', 'd1', 'adx4', 'rsiAl', 'rs', 'ls', 'oi', 'vol', 'brAl', 'lnny'], ['btcD', 'adx4', 'rsiAl', 'rs', 'ls', 'vol', 'brAl']]) {
  const m = fitLogit(h1, feats), m2 = fitLogit(h2, feats);
  console.log(`特徵 ${feats.join(',')}：前→後 AUC ${auc(h2, m.pred).toFixed(3)}；後→前 AUC ${auc(h1, m2.pred).toFixed(3)}`);
  console.log('  前半係數：' + feats.map((f, j) => `${f} ${m.w[j].toFixed(2)}`).join('、') + ` 截距 ${m.b0.toFixed(2)}`);
  dec(h2, m.pred, '後半（樣本外）'); 
  print([0.45, 0.5, 0.55].map(p => stats(h2.filter(r => m.pred(r) >= p), `後半 p≥${p}`)).concat([stats(h2.filter(r => m.pred(r) < 0.45), '後半 p<0.45（應擋）'), stats(h2.filter(r => m.pred(r) < 0.5), '後半 p<0.5')]));
  const mAll = fitLogit(rows, feats); console.log('  全樣本係數：' + JSON.stringify(Object.fromEntries(feats.map((f, j) => [f, +mAll.w[j].toFixed(3)]))) + ` 截距 ${mAll.b0.toFixed(3)}`);
  // 加在現行硬擋之上還有沒有增量
  const g = r => r.f.btcD && r.c.adx4 >= 20;
  print([stats(h2.filter(g), '後半 現行硬擋'), stats(h2.filter(r => g(r) && m.pred(r) >= 0.5), '現行硬擋＋p≥0.5'), stats(h2.filter(r => g(r) && m.pred(r) < 0.5), '現行硬擋但 p<0.5')]);
}
// 1H 突破：分三段、變體（止損倍數、持有時間、ADX、只做順 BTC 日線）
function genH1({ slMult = 1.0, slFloor = 0.01, hold = 72, tp1 = 1.0, tp2 = 2.5, p1 = 0.5, lock = 0.3, look = 20 } = {}) {
  const out = [];
  for (const sym of Object.keys(D['1H'])) {
    if (!okSym(sym)) continue;
    const b = D['1H'][sym]; const A = atr(b), ctx = ctxFor(sym); let last = { 1: -100, 0: -100 };
    for (let i = 60; i < b.length - 20; i++) {
      const c = ctx(b[i][0] + TFMS['1H']); if (!c.ok) continue;
      for (const isLong of [true, false]) {
        const key = isLong ? 1 : 0; if (i - last[key] < 6) continue; if (isLong ? !c.h4Up : !c.h4Dn) continue;
        const lvl = isLong ? hhv(b, i, look) : llv(b, i, look); const brk = (isLong ? b[i][4] > lvl && b[i][4] > b[i][1] : b[i][4] < lvl && b[i][4] < b[i][1]); if (!brk) continue; last[key] = i;
        const trig = isLong ? lvl + 0.05 * A[i] : lvl - 0.05 * A[i]; let k = -1;
        for (let j = i + 1; j <= Math.min(b.length - 1, i + 4); j++) if (isLong ? b[j][2] >= trig : b[j][3] <= trig) { k = j; break; }
        if (k < 0) continue;
        const entry = trig * (isLong ? 1.0005 : 0.9995); const risk = Math.max(slMult * A[i], slFloor * entry); const sl = isLong ? entry - risk : entry + risk;
        const r = simulate(b, k, isLong, entry, sl, tp1, tp2, hold, FEE_RT * entry / risk, p1, lock); if (r) out.push({ ...r, t: b[k][0], isLong, c, sym, riskPct: risk / entry });
      }
    }
  }
  return out;
}
const al = r => r.isLong ? r.c.btcDUp : !r.c.btcDUp;
const base = genH1();
console.log('══ 1H 突破：三等分（90 天）══');
const T = thirds(base); print(T.map((x, i) => stats(x, `第 ${i + 1} 段 全部`)).concat(T.map((x, i) => stats(x.filter(al), `第 ${i + 1} 段 順 BTC 日線`))).concat(T.map((x, i) => stats(x.filter(r => al(r) && r.c.adx4 >= 20), `第 ${i + 1} 段 順 BTC 日線＋ADX≥20`))));
console.log('══ 1H 突破：變體（全部順 BTC 日線）══');
print([stats(base.filter(al), '基準 1×ATR／1%／72h／1R-2.5R'), stats(genH1({ slMult: 1.5 }).filter(al), '止損 1.5×ATR'), stats(genH1({ slMult: 0.8 }).filter(al), '止損 0.8×ATR'), stats(genH1({ hold: 48 }).filter(al), '最長 48h'), stats(genH1({ hold: 120 }).filter(al), '最長 120h'), stats(genH1({ tp1: 1.5, tp2: 3, p1: 0.5, lock: 0.5 }).filter(al), '1.5R 出 50%／3R'), stats(genH1({ tp1: 1, tp2: 3, p1: 0.5, lock: 0.3 }).filter(al), '1R／3R'), stats(genH1({ look: 30 }).filter(al), '回看 30 根'), stats(genH1({ look: 12 }).filter(al), '回看 12 根')]);
const avgRisk = base.reduce((a, x) => a + x.riskPct, 0) / base.length; console.log(`1H 突破平均止損距離 ${(avgRisk * 100).toFixed(2)}%，每日平均筆數 ${(base.length / 90).toFixed(1)}（15m 突破 ${(rows.length / 45).toFixed(1)}）`);
// 兩套系統同時跑的相關性：同一小時內同方向重複的比例
const keyOf = r => `${r.sym}|${Math.floor(r.t / 3600e3)}|${r.isLong}`; const s15 = new Set(rows.map(keyOf)); const dup = base.filter(r => s15.has(keyOf(r))).length; console.log(`1H 突破與 15m 突破同幣同小時同向重疊：${dup}/${base.length}`);
