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

/* ── 平均真實範圍 ATR（Wilder 平滑法）──────────────────── */
function calcATR(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return closes[n - 1] * 0.012;
  const trs = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    ));
  }
  // Wilder 平滑
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

/* ── 影線拒絕區偵測（震盪行情支撐壓力）───────────────────
   在 lookback 根 K 棒中，找 pivot 高低點並統計：
   每個 pivot 被「影線觸及 + 實體拒絕」的次數 ≥ 2 → 視為有效震盪區
   ─────────────────────────────────────────────────────── */
function findWickZones(highs, lows, opens, closes, atr, lookback = 150) {
  const n   = Math.min(highs.length, lookback);
  const h   = highs.slice(-n), l = lows.slice(-n);
  const o   = opens.slice(-n), c = closes.slice(-n);
  const price     = c[c.length - 1];
  const tolerance = atr * 0.5;

  // ── Pivot 高低點 ──
  const pivotH = [], pivotL = [];
  for (let i = 2; i < h.length - 2; i++) {
    if (h[i] >= h[i-1] && h[i] >= h[i-2] && h[i] >= h[i+1] && h[i] >= h[i+2]) pivotH.push(h[i]);
    if (l[i] <= l[i-1] && l[i] <= l[i-2] && l[i] <= l[i+1] && l[i] <= l[i+2]) pivotL.push(l[i]);
  }

  // ── 聚類：相差 < 0.8% 視為同一區域 ──
  const clusterLevels = arr => {
    if (!arr.length) return [];
    const sorted = [...arr].sort((a, b) => a - b);
    const out = [{ level: sorted[0], count: 1 }];
    for (let i = 1; i < sorted.length; i++) {
      const last = out[out.length - 1];
      if (Math.abs(sorted[i] - last.level) / last.level < 0.008) {
        // 加權平均更新 level
        last.level = (last.level * last.count + sorted[i]) / (last.count + 1);
        last.count++;
      } else {
        out.push({ level: sorted[i], count: 1 });
      }
    }
    return out;
  };

  // ── 計算影線拒絕次數 ──
  const countWickRejects = (level, isSup) => {
    let rejects = 0;
    for (let i = 0; i < h.length; i++) {
      const body = Math.abs(c[i] - o[i]);
      if (isSup) {
        // 支撐：下影線觸及區域 且 收盤遠離（守住）
        const touched  = l[i] <= level + tolerance;
        const defended = c[i] > level - tolerance * 0.3;
        const lowerWick = Math.min(o[i], c[i]) - l[i];
        const hasWick  = lowerWick > body * 0.5 && lowerWick > atr * 0.05;
        if (touched && defended && hasWick) rejects++;
      } else {
        // 壓力：上影線觸及區域 且 收盤遠離（守住）
        const touched  = h[i] >= level - tolerance;
        const defended = c[i] < level + tolerance * 0.3;
        const upperWick = h[i] - Math.max(o[i], c[i]);
        const hasWick  = upperWick > body * 0.5 && upperWick > atr * 0.05;
        if (touched && defended && hasWick) rejects++;
      }
    }
    return rejects;
  };

  // ── 組建支撐區（低於現價）──
  const supClusters = clusterLevels(pivotL.filter(p => p < price * 0.999));
  const wickSupports = supClusters
    .map(z => ({ level: z.level, count: z.count, wicks: countWickRejects(z.level, true) }))
    .filter(z => z.wicks >= 2)
    .sort((a, b) => b.level - a.level)  // 最近的在前
    .slice(0, 3);

  // ── 組建壓力區（高於現價）──
  const resClusters = clusterLevels(pivotH.filter(p => p > price * 1.001));
  const wickResistances = resClusters
    .map(z => ({ level: z.level, count: z.count, wicks: countWickRejects(z.level, false) }))
    .filter(z => z.wicks >= 2)
    .sort((a, b) => a.level - b.level)  // 最近的在前
    .slice(0, 3);

  return { wickSupports, wickResistances };
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

  const { opens, highs, lows, closes, quoteVols } = parseKlines(raw);
  const price = closes[closes.length - 1];

  const rsi    = calcRSI(closes, 14);
  const adx    = calcADX(highs, lows, closes, 14);
  const atr    = calcATR(highs, lows, closes, 14);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const { hist: macdHist } = calcMACD(closes);
  const score  = calcScore(price, rsi, adx, ema20, ema50, ema200, macdHist);

  /* 取最近 96 根 K 線的 USDT 成交額作為 24h 成交量估算 */
  const vol24h = quoteVols.slice(-96).reduce((a, b) => a + b, 0);

  /* 24h 漲跌幅：用時間戳找最接近 24h 前的 K 棒 */
  const lastCloseTime = raw[raw.length - 1][6];
  const target24h     = lastCloseTime - 24 * 3600 * 1000;
  let idx24h = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i][0] <= target24h) { idx24h = i; break; }
  }
  const price24hAgo = parseFloat(raw[idx24h][4]) || price;
  const change24h   = parseFloat(((price - price24hAgo) / price24hAgo * 100).toFixed(2));

  /* 影線拒絕區（震盪行情關鍵支撐壓力，lookback=150根K棒） */
  const { wickSupports, wickResistances } = findWickZones(highs, lows, opens, closes, atr, 150);

  const bb       = computeBBSignal(raw);
  const patterns = detect123And2B(highs, lows, closes);

  return {
    symbol,
    price:      fmtDecimals(price),
    rsi:        parseFloat(rsi.toFixed(1)),
    adx:        parseFloat(adx.toFixed(1)),
    atr:        fmtDecimals(atr),
    ema20:      fmtDecimals(ema20),
    ema50:      fmtDecimals(ema50),
    ema200:     fmtDecimals(ema200),
    macdHist:   parseFloat(macdHist.toFixed(6)),
    score,
    volume:     Math.round(vol24h),
    momentum:   parseFloat((rsi - 50).toFixed(1)),
    strength:   Math.round(adx),
    change24h,
    wickSupports:    wickSupports.map(z => ({ level: fmtDecimals(z.level), wicks: z.wicks })),
    wickResistances: wickResistances.map(z => ({ level: fmtDecimals(z.level), wicks: z.wicks })),
    bb,
    patterns,
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

/* ── 布林通道 Bollinger Bands ────────────────────────────── */
function calcBollingerBands(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const slice  = closes.slice(-period);
  const mean   = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper  = mean + mult * stdDev;
  const lower  = mean - mult * stdDev;
  const price  = closes[closes.length - 1];
  const width  = mean > 0 ? (upper - lower) / mean : 0;  // 帶寬比
  const pctB   = (upper - lower) > 0 ? (price - lower) / (upper - lower) : 0.5; // %B 位置
  return { upper, middle: mean, lower, width, pctB, stdDev };
}

/* ── 布林通道信號分析（含走軌/背離/收窄偵測）─────────────── */
function computeBBSignal(raw) {
  if (!raw || raw.length < 22) return null;
  const { closes, highs, lows } = parseKlines(raw);
  const n = closes.length;
  if (n < 22) return null;

  const bb = calcBollingerBands(closes, 20, 2);
  if (!bb) return null;
  const { upper, middle, lower, pctB, width } = bb;
  const price = closes[n - 1];
  let bullBonus = 0, bearBonus = 0;
  const tags = [];

  // 觸及下軌 → 超賣反彈多頭信號
  if      (pctB <= 0.05) { bullBonus += 2; tags.push('BB下軌觸及'); }
  else if (pctB <= 0.2)  { bullBonus += 1; tags.push('BB近下軌');   }

  // 觸及上軌 → 超買壓回空頭信號
  if      (pctB >= 0.95) { bearBonus += 2; tags.push('BB上軌觸及'); }
  else if (pctB >= 0.8)  { bearBonus += 1; tags.push('BB近上軌');   }

  // 站在中軌上方 → 多頭偏向；中軌下方 → 空頭偏向
  if (price > middle) bullBonus += 1;
  else                bearBonus += 1;

  // ── 相對收窄：與 10 根前帶寬比較（動態閾值，適配不同波動率資產）──
  const bb10ago = n >= 30 ? calcBollingerBands(closes.slice(0, n - 10), 20, 2) : null;
  const isSqueezing = bb10ago ? (width < bb10ago.width * 0.65) : (width < 0.03);
  if (isSqueezing) { bullBonus += 1; bearBonus += 1; tags.push('BB收窄蓄力'); }

  // ── 走軌偵測：最近 3 根 K 線持續貼近同一條布林帶 → 強勢趨勢走軌 ──
  const pctBHist = [];
  for (let off = 2; off >= 0; off--) {
    if (n - off >= 20) {
      const bbH = calcBollingerBands(closes.slice(0, n - off), 20, 2);
      if (bbH) pctBHist.push(bbH.pctB);
    }
  }
  const walkingBull = pctBHist.length >= 3 && pctBHist.every(p => p >= 0.75);
  const walkingBear = pctBHist.length >= 3 && pctBHist.every(p => p <= 0.25);
  if (walkingBull) { bullBonus += 2; tags.push('BB多頭走軌'); }
  if (walkingBear) { bearBonus += 2; tags.push('BB空頭走軌'); }

  // ── 背離偵測：近期新高/低但收盤未觸碰布林帶 → 動能衰竭警告 ──
  const lookH = Math.min(n - 1, 10);
  if (lookH >= 2) {
    const prevHigh = Math.max(...highs.slice(-lookH, -1));
    const prevLow  = Math.min(...lows.slice(-lookH, -1));
    const curHigh  = highs[n - 1];
    const curLow   = lows[n - 1];
    const bbDivBear = curHigh > prevHigh * 1.001 && price < upper * 0.994;
    const bbDivBull = curLow  < prevLow  * 0.999 && price > lower * 1.006;
    if (bbDivBear) tags.push('BB頂背離');
    if (bbDivBull) tags.push('BB底背離');
    return { bullBonus, bearBonus, pctB, width, upper, middle, lower, tags,
             isSqueezing, walkingBull, walkingBear, bbDivBear, bbDivBull };
  }

  return { bullBonus, bearBonus, pctB, width, upper, middle, lower, tags,
           isSqueezing, walkingBull, walkingBear, bbDivBear: false, bbDivBull: false };
}

/* ── 123法則 / 2B法則 型態偵測 ───────────────────────────── */
function detect123And2B(highs, lows, closes, lookback = 60) {
  const n = closes.length;
  if (n < 30) return { bull123: false, bear123: false, bull2B: false, bear2B: false };

  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  const c = closes.slice(-lookback);
  const len = h.length;
  const price = c[len - 1];

  // 偵測局部擺動高低點（左右各 3 根確認）
  const swingHighs = [], swingLows = [];
  for (let i = 3; i < len - 3; i++) {
    if (h[i] >= h[i-1] && h[i] >= h[i-2] && h[i] >= h[i+1] && h[i] >= h[i+2]) {
      swingHighs.push({ idx: i, price: h[i] });
    }
    if (l[i] <= l[i-1] && l[i] <= l[i-2] && l[i] <= l[i+1] && l[i] <= l[i+2]) {
      swingLows.push({ idx: i, price: l[i] });
    }
  }

  let bull123 = false, bear123 = false, bull2B = false, bear2B = false;

  // 多頭 123：P1（前低）→ P2（中間高）→ P3（較高低點）→ 現價突破 P2
  if (swingLows.length >= 2 && swingHighs.length >= 1) {
    const P1 = swingLows[swingLows.length - 2];
    const P3 = swingLows[swingLows.length - 1];
    if (P3.price > P1.price * 1.001) {
      const midHighs = swingHighs.filter(sh => sh.idx > P1.idx && sh.idx < P3.idx);
      if (midHighs.length > 0) {
        const P2 = midHighs.reduce((a, b) => a.price > b.price ? a : b);
        if (price > P2.price) bull123 = true;
      }
    }
  }

  // 空頭 123：P1（前高）→ P2（中間低）→ P3（較低高點）→ 現價跌破 P2
  if (swingHighs.length >= 2 && swingLows.length >= 1) {
    const P1 = swingHighs[swingHighs.length - 2];
    const P3 = swingHighs[swingHighs.length - 1];
    if (P3.price < P1.price * 0.999) {
      const midLows = swingLows.filter(sl => sl.idx > P1.idx && sl.idx < P3.idx);
      if (midLows.length > 0) {
        const P2 = midLows.reduce((a, b) => a.price < b.price ? a : b);
        if (price < P2.price) bear123 = true;
      }
    }
  }

  // 多頭 2B：前低被短暫突破後迅速收回（假跌破）
  if (swingLows.length >= 2) {
    const prevL = swingLows[swingLows.length - 2].price;
    const recentMinLow = Math.min(...lows.slice(-6));
    if (recentMinLow < prevL * 0.999 && price > prevL * 1.001) bull2B = true;
  }

  // 空頭 2B：前高被短暫突破後迅速回落（假突破）
  if (swingHighs.length >= 2) {
    const prevH = swingHighs[swingHighs.length - 2].price;
    const recentMaxHigh = Math.max(...highs.slice(-6));
    if (recentMaxHigh > prevH * 1.001 && price < prevH * 0.999) bear2B = true;
  }

  return { bull123, bear123, bull2B, bear2B };
}

/* ── 籌碼分佈（Volume Profile）─────────────────────────────── */
function computeVolumeProfile(klines, numBuckets = 24) {
  if (!klines || klines.length < 10) return null;
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const vols   = klines.map(k => parseFloat(k[5]));

  const priceHigh = Math.max(...highs);
  const priceLow  = Math.min(...lows);
  if (priceHigh <= priceLow) return null;

  const bucketSize = (priceHigh - priceLow) / numBuckets;
  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    low:  priceLow + i * bucketSize,
    high: priceLow + (i + 1) * bucketSize,
    mid:  priceLow + (i + 0.5) * bucketSize,
    vol:  0,
  }));

  klines.forEach((_, idx) => {
    const h = highs[idx], l = lows[idx], v = vols[idx];
    const range = h - l || 0.0001;
    for (const b of buckets) {
      const overlap = Math.max(0, Math.min(h, b.high) - Math.max(l, b.low));
      if (overlap > 0) b.vol += v * (overlap / range);
    }
  });

  const totalVol = buckets.reduce((s, b) => s + b.vol, 0);
  const poc = buckets.reduce((m, b) => b.vol > m.vol ? b : m, buckets[0]);

  // Value Area — 70% of volume around POC
  let vaVol = poc.vol, lo = buckets.indexOf(poc), hi = lo;
  const vaTarget = totalVol * 0.70;
  while (vaVol < vaTarget && (lo > 0 || hi < numBuckets - 1)) {
    const upVol = hi + 1 < numBuckets ? buckets[hi + 1].vol : -1;
    const dnVol = lo - 1 >= 0 ? buckets[lo - 1].vol : -1;
    if (upVol >= dnVol && hi + 1 < numBuckets) { hi++; vaVol += buckets[hi].vol; }
    else if (lo - 1 >= 0) { lo--; vaVol += buckets[lo].vol; }
    else break;
  }

  // HVN / LVN
  const sorted = [...buckets].sort((a, b) => b.vol - a.vol);
  const hvns = sorted.slice(0, 5).map(b => b.mid).sort((a, b) => a - b);
  const lvns = sorted.slice(-4).map(b => b.mid).sort((a, b) => a - b);
  const currentPrice = closes[closes.length - 1];

  return {
    poc: poc.mid, pocVol: poc.vol, totalVol,
    vah: buckets[hi].high, val: buckets[lo].low,
    hvns, lvns, buckets,
    priceHigh, priceLow, bucketSize,
    currentPrice,
    priceAbovePOC: currentPrice > poc.mid,
    distToPOC: parseFloat(((currentPrice - poc.mid) / poc.mid * 100).toFixed(2)),
  };
}

/* ── 成交量 AI 分析 ──────────────────────────────────────────── */
function analyzeVolumeAI(raw) {
  if (!raw || raw.length < 20) return null;
  const { opens, closes, highs, lows, volumes } = parseKlines(raw);
  const n = closes.length;

  const vol20MA = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const vol5MA  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol10MA = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
  const lastVol = volumes[n - 1];
  const volRatio = parseFloat((lastVol / (vol20MA || 1)).toFixed(2));

  // 上漲 vs 下跌 K 棒成交量比 (近 20 根)
  let upVol = 0, downVol = 0;
  for (let i = n - 20; i < n; i++) {
    if (closes[i] >= opens[i]) upVol += volumes[i]; else downVol += volumes[i];
  }
  const upVolRatio = parseFloat((upVol / ((upVol + downVol) || 1)).toFixed(2));

  // 量能趨勢
  const volTrend = vol5MA > vol10MA * 1.2 ? 'rising' : vol5MA < vol10MA * 0.8 ? 'falling' : 'flat';

  // 背離
  const priceChg5 = (closes[n - 1] - closes[n - 6]) / (closes[n - 6] || 1);
  const divergence =
    priceChg5 > 0.008 && volTrend === 'falling' ? 'bearish_div' :
    priceChg5 < -0.008 && volTrend === 'falling' ? 'bullish_div' : null;

  // 放量信號
  const isSpike   = volRatio > 2.5;
  const isHighVol = volRatio > 1.5;

  // 頂底背離（高量小實體 = 潛在反轉）
  const lastBodyPct = Math.abs(closes[n-1] - opens[n-1]) / ((highs[n-1] - lows[n-1]) || 0.001);
  const isClimax    = isSpike && lastBodyPct < 0.35;

  // 連續放量突破
  const last3Vol    = volumes.slice(-3).filter(v => v > vol20MA * 1.3).length;
  const isBreakout  = last3Vol >= 2 && priceChg5 > 0.005;

  const bias = upVolRatio > 0.62 && volTrend !== 'falling' ? 'bull'
    : upVolRatio < 0.38 && volTrend !== 'falling' ? 'bear' : 'neutral';

  return {
    volRatio, volTrend, divergence,
    upVolRatio, bias,
    isSpike, isHighVol, isClimax, isBreakout,
    vol20MA: parseFloat(vol20MA.toFixed(0)),
    priceChg5: parseFloat((priceChg5 * 100).toFixed(2)),
  };
}

/* ── 市場陷阱偵測 (PO3 / 2B / 流動性掃蕩) ────────────────────── */
function detectTrapPatterns(klines) {
  if (!klines || klines.length < 40) return null;
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const opens  = klines.map(k => parseFloat(k[1]));
  const n = closes.length - 1;
  const cur = closes[n];

  const results = { po3Bull: null, po3Bear: null, twoB_Bull: null, twoB_Bear: null, sweepBull: null, sweepBear: null };

  /* PO3（Power of 3）：假突破後回歸
     看多 PO3：近 10 根 K 棒建立區間 → 下方假突破 → 現在回到區間上方 */
  const range10High = Math.max(...highs.slice(-15, -5));
  const range10Low  = Math.min(...lows.slice(-15, -5));
  const rangeMid    = (range10High + range10Low) / 2;
  const recentLow   = Math.min(...lows.slice(-5));
  const recentHigh  = Math.max(...highs.slice(-5));

  if (range10High > range10Low * 1.002) {
    // PO3 看多：曾跌破區間低點，現在回收
    if (recentLow < range10Low * 0.998 && cur > range10Low * 0.999) {
      const sweepDepth = ((range10Low - recentLow) / range10Low * 100).toFixed(2);
      results.po3Bull = { sweepLevel: range10Low, depth: parseFloat(sweepDepth), label: `PO3 看多陷阱：掃蕩低點 $${range10Low.toPrecision(5)} 後回收` };
    }
    // PO3 看空：曾突破區間高點，現在跌回
    if (recentHigh > range10High * 1.002 && cur < range10High * 1.001) {
      const sweepDepth = ((recentHigh - range10High) / range10High * 100).toFixed(2);
      results.po3Bear = { sweepLevel: range10High, depth: parseFloat(sweepDepth), label: `PO3 看空陷阱：掃蕩高點 $${range10High.toPrecision(5)} 後回落` };
    }
  }

  /* 2B Pattern：雙重頂底（第二次測試失敗）
     2B 看多：第一個低點 → 第二個低點未能創新低 → 反轉 */
  const half = Math.floor((klines.length - 5) / 2);
  const low1  = Math.min(...lows.slice(0, half));
  const low2  = Math.min(...lows.slice(half, -3));
  const high1 = Math.max(...highs.slice(0, half));
  const high2 = Math.max(...highs.slice(half, -3));

  if (low2 > low1 * 1.003 && cur > low2 * 1.005) {
    results.twoB_Bull = { firstLow: low1, secondLow: low2, label: `2B 看多型態：第二低點 $${low2.toPrecision(5)} 未破前低 $${low1.toPrecision(5)}，多頭反轉信號` };
  }
  if (high2 < high1 * 0.997 && cur < high2 * 0.995) {
    results.twoB_Bear = { firstHigh: high1, secondHigh: high2, label: `2B 看空型態：第二高點 $${high2.toPrecision(5)} 未過前高 $${high1.toPrecision(5)}，空頭反轉信號` };
  }

  /* 流動性掃蕩（Stop Hunt）：長上/下影線掃蕩重要位後快速反轉 */
  const lastCandle = { h: highs[n], l: lows[n], o: opens[n], c: closes[n] };
  const prevSwingHigh = Math.max(...highs.slice(-20, -1));
  const prevSwingLow  = Math.min(...lows.slice(-20, -1));

  // 看多掃蕩：下影線掃過前低，收盤收回
  if (lastCandle.l < prevSwingLow * 0.999 && lastCandle.c > prevSwingLow) {
    const wickPct = ((prevSwingLow - lastCandle.l) / lastCandle.l * 100).toFixed(2);
    results.sweepBull = { level: prevSwingLow, wickPct: parseFloat(wickPct), label: `流動性掃蕩（看多）：下影線掃蕩前低 $${prevSwingLow.toPrecision(5)}，空頭陷阱成立` };
  }
  // 看空掃蕩：上影線掃過前高，收盤跌回
  if (lastCandle.h > prevSwingHigh * 1.001 && lastCandle.c < prevSwingHigh) {
    const wickPct = ((lastCandle.h - prevSwingHigh) / prevSwingHigh * 100).toFixed(2);
    results.sweepBear = { level: prevSwingHigh, wickPct: parseFloat(wickPct), label: `流動性掃蕩（看空）：上影線掃蕩前高 $${prevSwingHigh.toPrecision(5)}，多頭陷阱成立` };
  }

  const hasAny = Object.values(results).some(v => v !== null);
  return hasAny ? results : null;
}

/* ── ICT Order Block Detection ──────────────────────────────────────────── */
function detectOrderBlocks(klines, isLong) {
  if (!klines || klines.length < 20) return null;
  const n      = klines.length;
  const opens  = klines.map(k => parseFloat(k[1]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const cur    = closes[n - 1];
  const start  = Math.max(1, n - 35);
  const end    = n - 3;

  if (isLong) {
    for (let i = end; i >= start; i--) {
      if (closes[i] >= opens[i]) continue; // need bearish candle
      const body = Math.abs(closes[i] - opens[i]);
      if (body / closes[i] < 0.001) continue;
      const postHigh = Math.max(...highs.slice(i + 1, Math.min(i + 10, n)));
      if ((postHigh - highs[i]) / highs[i] < 0.004) continue;
      const obHigh = Math.max(opens[i], closes[i]);
      const obLow  = Math.min(opens[i], closes[i]);
      if (cur >= obLow * 0.994 && cur <= obHigh * 1.025) {
        return { type: 'bullish', high: obHigh, low: obLow,
                 priceInOB: cur >= obLow && cur <= obHigh, label: '看多訂單塊 OB' };
      }
    }
  } else {
    for (let i = end; i >= start; i--) {
      if (closes[i] <= opens[i]) continue; // need bullish candle
      const body = Math.abs(closes[i] - opens[i]);
      if (body / closes[i] < 0.001) continue;
      const postLow = Math.min(...lows.slice(i + 1, Math.min(i + 10, n)));
      if ((lows[i] - postLow) / lows[i] < 0.004) continue;
      const obHigh = Math.max(opens[i], closes[i]);
      const obLow  = Math.min(opens[i], closes[i]);
      if (cur >= obLow * 0.975 && cur <= obHigh * 1.006) {
        return { type: 'bearish', high: obHigh, low: obLow,
                 priceInOB: cur >= obLow && cur <= obHigh, label: '看空訂單塊 OB' };
      }
    }
  }
  return null;
}

/* ── ICT Fair Value Gap (FVG/Imbalance) ────────────────────────────────── */
function detectFairValueGaps(klines, isLong) {
  if (!klines || klines.length < 5) return null;
  const n     = klines.length;
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const cur    = closes[n - 1];
  const gaps   = [];
  const scan   = Math.max(2, n - 40);

  for (let i = scan; i < n - 1; i++) {
    if (isLong) {
      // Bullish FVG: candle i-2 high < candle i low → gap up
      const gL = highs[i - 2], gH = lows[i];
      if (gH > gL && cur > gL) {
        const size = (gH - gL) / gL * 100;
        if (size >= 0.15) gaps.push({ high: gH, low: gL, mid: (gH + gL) / 2, size, filled: cur < gH });
      }
    } else {
      // Bearish FVG: candle i-2 low > candle i high → gap down
      const gH = lows[i - 2], gL = highs[i];
      if (gH > gL && cur < gH) {
        const size = (gH - gL) / gL * 100;
        if (size >= 0.15) gaps.push({ high: gH, low: gL, mid: (gH + gL) / 2, size, filled: cur > gL });
      }
    }
  }
  if (!gaps.length) return null;
  const sorted = gaps.sort((a, b) => Math.abs(cur - a.mid) - Math.abs(cur - b.mid));
  return sorted.find(g => !g.filled) || sorted[0];
}

/* ── ICT Premium / Discount Zone ────────────────────────────────────────── */
function computePremiumDiscount(klines) {
  if (!klines || klines.length < 20) return null;
  const n      = klines.length;
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const cur    = closes[n - 1];
  const lb     = Math.min(60, n);
  const rH     = Math.max(...highs.slice(-lb));
  const rL     = Math.min(...lows.slice(-lb));
  if (rH <= rL) return null;
  const pct = (cur - rL) / (rH - rL) * 100;
  let zone, zoneLabel, icon;
  if      (pct >= 75) { zone = 'premium';         zoneLabel = '溢價區 Premium';        icon = '🔴'; }
  else if (pct >= 55) { zone = 'slight_premium';   zoneLabel = '偏高（輕度溢價）';      icon = '🟡'; }
  else if (pct <= 25) { zone = 'discount';         zoneLabel = '折價區 Discount';       icon = '🟢'; }
  else if (pct <= 45) { zone = 'slight_discount';  zoneLabel = '偏低（輕度折價）';      icon = '🟡'; }
  else                { zone = 'equilibrium';       zoneLabel = '均衡區 Equilibrium';   icon = '⚪'; }
  return {
    zone, zoneLabel, icon,
    rangeHigh: rH, rangeLow: rL,
    equilibrium: (rH + rL) / 2,
    pctInRange: parseFloat(pct.toFixed(1)),
    idealForLong:  zone === 'discount' || zone === 'slight_discount',
    idealForShort: zone === 'premium'  || zone === 'slight_premium',
  };
}
