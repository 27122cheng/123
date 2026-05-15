/* ============================================================
   indicators.js — 技術指標計算庫（純前端，對應 TradingView 標準算法）
   ============================================================ */

/* ── 指數移動平均 EMA ─────────────────────────────────────── */
function calcEMA(data, period) {
  if (!data || data.length === 0) return 0;
  const p = Math.min(period, data.length);
  const k = 2 / (p + 1);
  let ema = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

/* ── 相對強弱指標 RSI（Wilder 平滑法）──────────────────────── */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum += Math.abs(d);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

/* ── 平均趨向指標 ADX（Wilder 平滑法）──────────────────────── */
function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2 + 1) return 20;

  const trs = [], pdms = [], ndms = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    ));
    const up   = highs[i]    - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    pdms.push(up   > down && up   > 0 ? up   : 0);
    ndms.push(down > up   && down > 0 ? down : 0);
  }

  /* Wilder 平滑（首值為前 period 之和，後續滾動） */
  const wilderSmooth = (arr, p) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };

  const sTR  = wilderSmooth(trs,  period);
  const sPDM = wilderSmooth(pdms, period);
  const sNDM = wilderSmooth(ndms, period);

  const dxs = sTR.map((tr, i) => {
    if (tr === 0) return 0;
    const pdi = 100 * sPDM[i] / tr;
    const ndi = 100 * sNDM[i] / tr;
    const s   = pdi + ndi;
    return s === 0 ? 0 : 100 * Math.abs(pdi - ndi) / s;
  });

  if (dxs.length < period) return 20;
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) adx = (adx * (period - 1) + dxs[i]) / period;
  return parseFloat(adx.toFixed(2));
}

/* ── MACD（Signal 線附加參考）────────────────────────────── */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0 };
  const emaFast = closes.map((_, i) => calcEMA(closes.slice(0, i + 1), fast));
  const emaSlow = closes.map((_, i) => calcEMA(closes.slice(0, i + 1), slow));
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine.slice(slow - 1), signal);
  const macdVal = macdLine[macdLine.length - 1];
  return {
    macd:   parseFloat(macdVal.toFixed(6)),
    signal: parseFloat(signalLine.toFixed(6)),
    hist:   parseFloat((macdVal - signalLine).toFixed(6)),
  };
}

/* ── 綜合趨勢評分（0–100）────────────────────────────────── */
function calcScore(price, rsi, adx, ema20, ema50, ema200, macdHist) {
  let score = 50;

  /* RSI 貢獻（±15） */
  if      (rsi >= 70) score += 15;
  else if (rsi >= 60) score += 10;
  else if (rsi >= 55) score +=  5;
  else if (rsi <= 30) score -= 15;
  else if (rsi <= 40) score -= 10;
  else if (rsi <= 45) score -=  5;

  /* 均線位置（±25） */
  if (price > ema20)  score +=  6; else score -=  6;
  if (price > ema50)  score +=  7; else score -=  7;
  if (price > ema200) score += 12; else score -= 12;

  /* 均線多空排列（±10） */
  if (ema20 > ema50)  score += 5; else score -= 5;
  if (ema50 > ema200) score += 5; else score -= 5;

  /* MACD 柱（±5） */
  if (macdHist !== undefined) {
    if (macdHist > 0) score += 5; else if (macdHist < 0) score -= 5;
  }

  /* ADX 趨勢強度放大 */
  const amp = adx > 40 ? 1.3 : adx > 30 ? 1.15 : adx > 20 ? 1.0 : 0.85;
  score = 50 + (score - 50) * amp;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ── 解析幣安 K 線原始數據 ───────────────────────────────── */
function parseKlines(raw) {
  return {
    opens:     raw.map(k => parseFloat(k[1])),
    highs:     raw.map(k => parseFloat(k[2])),
    lows:      raw.map(k => parseFloat(k[3])),
    closes:    raw.map(k => parseFloat(k[4])),
    volumes:   raw.map(k => parseFloat(k[5])),
    quoteVols: raw.map(k => parseFloat(k[7])), // USDT 成交額
  };
}

/* ── 格式化精度 ─────────────────────────────────────────── */
function fmtDecimals(v) {
  if (v >= 10000) return parseFloat(v.toFixed(2));
  if (v >= 1000)  return parseFloat(v.toFixed(2));
  if (v >= 1)     return parseFloat(v.toFixed(4));
  if (v >= 0.01)  return parseFloat(v.toFixed(5));
  if (v >= 0.001) return parseFloat(v.toFixed(6));
  return parseFloat(v.toFixed(8));
}

/* ── 完整技術分析入口 ────────────────────────────────────── */
function analyzeKlines(symbol, raw) {
  if (!raw || raw.length < 30) return null;

  const { highs, lows, closes, quoteVols } = parseKlines(raw);
  const price = closes[closes.length - 1];

  const rsi    = calcRSI(closes, 14);
  const adx    = calcADX(highs, lows, closes, 14);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const { hist: macdHist } = calcMACD(closes);
  const score  = calcScore(price, rsi, adx, ema20, ema50, ema200, macdHist);

  /* 取最近 96 根 K 線的 USDT 成交額作為 24h 成交量估算 */
  const vol24h = quoteVols.slice(-96).reduce((a, b) => a + b, 0);

  return {
    symbol,
    price:      fmtDecimals(price),
    rsi:        parseFloat(rsi.toFixed(1)),
    adx:        parseFloat(adx.toFixed(1)),
    ema20:      fmtDecimals(ema20),
    ema50:      fmtDecimals(ema50),
    ema200:     fmtDecimals(ema200),
    macdHist:   parseFloat(macdHist.toFixed(6)),
    score,
    volume:     Math.round(vol24h),
    momentum:   parseFloat((rsi - 50).toFixed(1)),
    strength:   Math.round(adx),
  };
}

/* ── 成交量移動平均 ─────────────────────────────────── */
function calcVolSMA(volumes, period = 20) {
  const len = Math.min(period, volumes.length);
  return volumes.slice(-len).reduce((a, b) => a + b, 0) / len;
}

/* ── 每根K棒的成交量Delta估算 ─────────────────────── */
function calcVolumeDelta(opens, closes, highs, lows, volumes) {
  return volumes.map((v, i) => {
    const range = highs[i] - lows[i];
    if (range === 0) return v * (closes[i] >= opens[i] ? 0.5 : -0.5);
    const body = Math.abs(closes[i] - opens[i]);
    const pct  = body / range;
    return closes[i] >= opens[i] ? pct * v : -pct * v;
  });
}

/* ── 累積成交量差 CVD ──────────────────────────────── */
function calcCVD(opens, closes, highs, lows, volumes) {
  const deltas = calcVolumeDelta(opens, closes, highs, lows, volumes);
  let sum = 0;
  return deltas.map(d => (sum += d));
}

/* ── 近期擺動高低點 ───────────────────────────────── */
function findSwingPoints(highs, lows, lookback = 30) {
  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  return { swingHigh: Math.max(...h), swingLow: Math.min(...l) };
}

/* ── 多層支撐壓力位（pivot point 法）──────────────── */
function findPivotLevels(highs, lows, closes, lookback = 60) {
  const n  = Math.min(highs.length, lookback);
  const h  = highs.slice(-n);
  const l  = lows.slice(-n);
  const c  = closes.slice(-n);
  const price = c[c.length - 1];

  const pivotH = [], pivotL = [];
  for (let i = 2; i < h.length - 2; i++) {
    if (h[i] >= h[i-1] && h[i] >= h[i-2] && h[i] >= h[i+1] && h[i] >= h[i+2]) pivotH.push(h[i]);
    if (l[i] <= l[i-1] && l[i] <= l[i-2] && l[i] <= l[i+1] && l[i] <= l[i+2]) pivotL.push(l[i]);
  }

  const cluster = (arr, asc) => {
    if (!arr.length) return [];
    const sorted = [...arr].sort((a, b) => asc ? a - b : b - a);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const last = out[out.length - 1];
      if (Math.abs(sorted[i] - last) / last > 0.006) out.push(sorted[i]);
    }
    return out.slice(0, 4);
  };

  const swingHigh = Math.max(...h);
  const swingLow  = Math.min(...l);

  let resistances = cluster(pivotH.filter(p => p > price * 1.001), true);
  let supports    = cluster(pivotL.filter(p => p < price * 0.999), false);

  if (!resistances.length) resistances = [price * 1.015, price * 1.03];
  if (!supports.length)    supports    = [price * 0.985, price * 0.97];

  return { resistances, supports, swingHigh, swingLow };
}

/* ── 完整訂單流分析 ──────────────────────────────── */
function analyzeOrderFlow(raw) {
  if (!raw || raw.length < 10) return null;
  const { opens, closes, highs, lows, volumes } = parseKlines(raw);

  const volSMA   = calcVolSMA(volumes, 20);
  const lastVol  = volumes[volumes.length - 1];
  const volRatio = volSMA > 0 ? lastVol / volSMA : 1;

  const deltas = calcVolumeDelta(opens, closes, highs, lows, volumes);
  const cvdArr = calcCVD(opens, closes, highs, lows, volumes);
  const cvdLast = cvdArr[cvdArr.length - 1];
  const cvdPrev = cvdArr[Math.max(0, cvdArr.length - 6)];

  const recent20  = deltas.slice(-20);
  const buyVol    = recent20.filter(d => d > 0).reduce((a, b) => a + b, 0);
  const sellVol   = Math.abs(recent20.filter(d => d < 0).reduce((a, b) => a + b, 0));
  const total     = buyVol + sellVol;
  const buyPct    = total > 0 ? Math.round(buyVol / total * 100) : 50;

  const v20mean   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const bigCandles = volumes.slice(-20).filter(v => v > v20mean * 2).length;
  const recentDeltaSum = deltas.slice(-10).reduce((a, b) => a + b, 0);

  return {
    volRatio:       parseFloat(volRatio.toFixed(2)),
    volSMA,
    lastVol,
    cvdTrend:       cvdLast > cvdPrev ? 'bull' : 'bear',
    cvdLast,
    recentDeltaSum,
    bigCandles,
    buyPct,
    sellPct: 100 - buyPct,
  };
}

/* ── 單一時間框架突破信號 ─────────────────────────── */
function analyzeTimeframeSignal(raw) {
  if (!raw || raw.length < 30) return null;
  const { opens, closes, highs, lows, volumes } = parseKlines(raw);
  const price = closes[closes.length - 1];

  const pivotLevels = findPivotLevels(highs, lows, closes, 60);
  const { swingHigh, swingLow } = pivotLevels;
  const volSMA    = calcVolSMA(volumes, 20);
  const lastVol   = volumes[volumes.length - 1];
  const isHighVol = lastVol > volSMA * 1.4;
  const volRatio  = volSMA > 0 ? parseFloat((lastVol / volSMA).toFixed(2)) : 1;

  const n          = opens.length - 1;
  const bodyHigh   = Math.max(opens[n], closes[n]);
  const bodyLow    = Math.min(opens[n], closes[n]);
  const isBullCdl  = closes[n] >= opens[n];

  const bullBreak = isBullCdl && bodyLow <= swingHigh * 1.003 && bodyHigh > swingHigh * 1.001;
  const bearBreak = !isBullCdl && bodyHigh >= swingLow * 0.997 && bodyLow < swingLow * 0.999;

  const rsi     = calcRSI(closes, 14);
  const rsiPrev = calcRSI(closes.slice(0, -3), 14);
  const rsiSlope = parseFloat((rsi - rsiPrev).toFixed(1));

  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const atr   = calcATR(highs, lows, closes, 14);

  let signal = 'neutral';
  if      (bullBreak && isHighVol) signal = 'strong_bull';
  else if (bearBreak && isHighVol) signal = 'strong_bear';
  else if (bullBreak)              signal = 'bull_break';
  else if (bearBreak)              signal = 'bear_break';
  else if (price > ema20 && ema20 > ema50 && rsi > 55) signal = 'bull';
  else if (price < ema20 && ema20 < ema50 && rsi < 45) signal = 'bear';

  return {
    signal, price, rsi: parseFloat(rsi.toFixed(1)), rsiSlope,
    ema20, ema50, swingHigh, swingLow,
    bullBreak, bearBreak, isHighVol, volRatio,
    atr, pivotLevels,
  };
}

/* ── 平均真實波動幅度 ATR（Wilder 平滑）─────────────────── */
function calcATR(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    ));
  }
  if (!trs.length) return 0;
  const p = Math.min(period, trs.length);
  let atr = trs.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}
