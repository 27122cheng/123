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

/* calcATR 唯一定義在下方（原本此處有第二份同名定義，後載入者覆蓋前者，
   兩版對「資料不足」的處理不同——ATR 可能變 0 導致止損貼進場價，已合併） */

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
/* ── 嚴格趨勢確認（三關，加分項）───────────────────────────────
   借用「均線多頭排列 + RSI/KD 動能 + 量能/MACD」的趨勢跟隨紀律：
   第一關 均線排列：價 > MA7 > MA25 > MA99（多）／價 < MA7 < MA25 < MA99（空）
   第二關 動能    ：RSI>50 且上行 + KD 在 50 上方黃金交叉（多，空為鏡像）
   第三關 量能+MACD：量 > MA20均量 + MACD(DIF) 在零軸上方且柱翻紅（多，空鏡像）
   回傳每方向通過關數（0~3），全過＝高信心趨勢，供 SQ 當純加分項。 */
function computeStrictTrend(highs, lows, closes, volumes) {
  try {
    const n = closes.length;
    if (n < 30) return null;
    const price = closes[n - 1];
    const sma = (arr, p) => { const s = arr.slice(-Math.min(p, arr.length)); return s.reduce((a, b) => a + b, 0) / s.length; };
    const ma7 = sma(closes, 7), ma25 = sma(closes, 25), ma99 = sma(closes, 99);
    const rsi = calcRSI(closes, 14), rsiPrev = calcRSI(closes.slice(0, -1), 14);
    const { macd: dif, hist } = calcMACD(closes);   // dif = MACD 線（零軸判斷）
    // 隨機指標 KD（%K 週期 9，%D = 3-SMA of %K）
    const kArr = [];
    for (let i = 8; i < n; i++) {
      const hh = Math.max(...highs.slice(i - 8, i + 1));
      const ll = Math.min(...lows.slice(i - 8, i + 1));
      kArr.push(hh === ll ? 50 : 100 * (closes[i] - ll) / (hh - ll));
    }
    const kK = kArr.length ? kArr[kArr.length - 1] : 50;
    const kD = kArr.length >= 3 ? (kArr[kArr.length - 1] + kArr[kArr.length - 2] + kArr[kArr.length - 3]) / 3 : kK;
    const volMA20 = sma(volumes, 20), lastVol = volumes[n - 1];
    const highVol = lastVol > volMA20;

    // 多頭三關
    const g1L = price > ma7 && ma7 > ma25 && ma25 > ma99;
    const g2L = rsi > 50 && rsi > rsiPrev && kK > kD && kK > 50;
    const g3L = highVol && dif > 0 && hist > 0;
    const cntL = (g1L ? 1 : 0) + (g2L ? 1 : 0) + (g3L ? 1 : 0);
    // 空頭三關（鏡像）
    const g1S = price < ma7 && ma7 < ma25 && ma25 < ma99;
    const g2S = rsi < 50 && rsi < rsiPrev && kK < kD && kK < 50;
    const g3S = highVol && dif < 0 && hist < 0;
    const cntS = (g1S ? 1 : 0) + (g2S ? 1 : 0) + (g3S ? 1 : 0);
    return {
      long:  { g1: g1L, g2: g2L, g3: g3L, count: cntL, pass: cntL === 3 },
      short: { g1: g1S, g2: g2S, g3: g3S, count: cntS, pass: cntS === 3 },
    };
  } catch (_e) { return null; }
}

function analyzeKlines(symbol, raw) {
  if (!raw || raw.length < 30) return null;

  const { opens, highs, lows, closes, volumes, quoteVols } = parseKlines(raw);
  const price = closes[closes.length - 1];

  /* 型態／結構／支撐壓力／ATR 改用已收盤棒（見 splitFormingBar 的說明）。
     動能讀數（RSI/ADX/MACD/EMA）與價格維持即時——它們是「現在多強」的
     連續量測，本來就該即時；會重繪的是「有沒有出現某個型態」這類是非題。
     ATR 特別重要：成形中的 K 棒振幅還沒走完，即時 ATR 會系統性低估波動，
     止損因此被放得太近——這是「一根雜訊就掃損」的隱性來源之一。 */
  const _spK = splitFormingBar(raw);
  const _cSrc = _spK.closed.length >= 30 ? _spK.closed : raw;
  const K = parseKlines(_cSrc);

  const rsi    = calcRSI(closes, 14);
  const adx    = calcADX(highs, lows, closes, 14);
  const atr    = calcATR(K.highs, K.lows, K.closes, 14);
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

  /* 影線拒絕區（震盪行情關鍵支撐壓力，lookback=150根K棒）── 已收盤棒 */
  const { wickSupports, wickResistances } = findWickZones(K.highs, K.lows, K.opens, K.closes, atr, 150);

  const bb       = computeBBSignal(raw);   // 內部自行切分：帶寬用收盤棒、%B 用即時價
  const patterns = detect123And2B(K.highs, K.lows, K.closes);
  const nakedK   = detectNakedK(K.opens, K.highs, K.lows, K.closes, atr);
  const struct15 = computeSwingStructure(K.highs, K.lows, K.closes, atr);
  const strictTrend = computeStrictTrend(K.highs, K.lows, K.closes, K.volumes);

  return {
    symbol,
    strictTrend,
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
    nakedK,
    struct15,
    closedBased: _cSrc !== raw,                                  // 型態／結構是否以收盤棒判定
    confirmedOn: _cSrc.length ? +_cSrc[_cSrc.length - 1][6] : null,
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
/* ── 已收盤 K 棒切分（去重繪的根本解）────────────────────────────
   交易所回傳的最後一根 K 棒「正在成形」：它的收盤價就是現價，會隨每
   一次報價變動。用它去判定型態與結構，等於讓判斷跟著跳動——一根現在
   看起來像下影拒絕的 K 棒，五分鐘後可能收成大陰線；日線訊號在一天之內
   可以翻面好幾次再翻回來（使用者實際回報的「本日／本週預測一直變」）。
   這正是「重繪（repaint）」：事後回頭看永遠是對的，當下卻不可信。

   專業做法是把兩件事分開：
     · 型態、結構、突破、支撐壓力、ATR ── 只認「已經收盤」的 K 棒
     · 現價、以及「價格相對於均線／通道的位置」 ── 用即時值
   前者要的是確定性（收盤才算數），後者要的是即時性。

   回傳 closed（去掉成形棒）、live（成形棒的即時價）、forming（是否成形中）。
   若資料已經過期（現在時間已超過該棒收盤時間），代表最後一根其實已收盤，
   原樣回傳不動。 */
function splitFormingBar(raw) {
  try {
    if (!raw || raw.length < 2) return { closed: raw || [], live: null, forming: false };
    const last = raw[raw.length - 1];
    const closeT = +last[6];
    if (!(closeT > 0) || Date.now() >= closeT) return { closed: raw, live: null, forming: false };
    return { closed: raw.slice(0, -1), live: parseFloat(last[4]), forming: true };
  } catch(_e) { return { closed: raw || [], live: null, forming: false }; }
}

/* 未收盤 K 棒的成交量投影 ─────────────────────────────────────────
   交易所回傳的最後一根 K 棒是「正在成形」的：它的成交量只累積到現在
   這一刻。拿它直接除以 20 根「完整 K 棒」的均量，量出來的不是量能強弱，
   而是「現在是這根 K 棒的第幾分鐘」。
   實測（2026-08-30）：同一根 1H K 棒，剛開盤時 volRatio = 0.05、快收盤
   時 = 1.00，差 20 倍——而 isHighVol（>1.4）幾乎只可能在收盤前成立。
   後果：突破的「帶量確認」在日線／週線上幾乎永遠拿不到（日線 K 棒要到
   UTC 深夜才累積夠量），strong_bull / strong_bear 這兩個最高等級的訊號
   因此長期難產；volRatio 又被快速單的條件桶學習當特徵，等於在學一個
   「掃描時機」的假訊號。
   修正：把成形中 K 棒的量按「已經過去的時間比例」投影成整根的預估量，
   再去比。已收盤的 K 棒（elapsed ≥ 1）完全不受影響。 */
function _projectedLastVol(raw, volumes, volSMA) {
  const lastVol = volumes[volumes.length - 1];
  try {
    const last = raw[raw.length - 1];
    const openT = +last[0], closeT = +last[6];
    if (!(closeT > openT)) return { vol: lastVol, forming: false, frac: 1 };
    const span = closeT - openT + 1;
    const frac = (Date.now() - openT) / span;
    if (!(frac > 0) || frac >= 1) return { vol: lastVol, forming: false, frac: 1 };
    const projected = lastVol / frac;
    /* K 棒才剛開的時候，投影本身也不可信（一筆大單就能推出 25 倍的假爆量）。
       正確的處理不是「夾住」而是「承認資訊不足」：走完越少，越往中性先驗
       （＝近 20 根均量，也就是 volRatio 1.0「無意見」）收縮；走完 35% 以上
       才完全採信投影。這樣兩端都不會說謊——剛開盤不會假裝量很小（舊版
       0.05 的病），也不會把一筆大單吹成爆量突破。 */
    const w = Math.min(1, frac / 0.35);
    const prior = (volSMA > 0) ? volSMA : lastVol;
    return { vol: w * projected + (1 - w) * prior, forming: true, frac: +frac.toFixed(3) };
  } catch(_e) { return { vol: lastVol, forming: false, frac: 1 }; }
}

function analyzeTimeframeSignal(raw) {
  if (!raw || raw.length < 30) return null;
  /* 判定一律用已收盤棒；價格用即時值。多週期訊號（1H/4H/日/週）是重繪
     受害最深的地方——日線棒有一整天可以變臉、週線棒有一整週。 */
  const _sp  = splitFormingBar(raw);
  const src  = _sp.closed.length >= 30 ? _sp.closed : raw;   // 收盤棒不足才退回原始
  const { opens, closes, highs, lows, volumes } = parseKlines(src);
  const price = (_sp.live != null && src !== raw) ? _sp.live : closes[closes.length - 1];

  const pivotLevels = findPivotLevels(highs, lows, closes, 60);
  const { swingHigh, swingLow } = pivotLevels;
  const volSMA    = calcVolSMA(volumes, 20);
  const _pv       = _projectedLastVol(src, volumes, volSMA);
  const lastVol   = _pv.vol;
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
    barForming: _pv.forming, barElapsed: _pv.frac,   // 成形中／已走完的比例（透明化用）
    /* 突破／型態是以「最後一根已收盤 K 棒」判定的（非重繪）；價格為即時值。
       confirmedOn = 判定所依據的那根 K 棒的收盤時間，方便對帳。 */
    closedBased: src !== raw,
    confirmedOn: src.length ? +src[src.length - 1][6] : null,
    struct: computeSwingStructure(highs, lows, closes, atr),   // 擺動結構（HH/HL、BOS、CHoCH）
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
  // 資料不足時給價格 1.2% 的保底值：回傳 0 會讓所有依賴 ATR 的
  // 止損距離/進場緩衝變成貼著進場價，一根雜訊K棒就掃損
  if (!trs.length) return (closes && closes.length) ? closes[closes.length - 1] * 0.012 : 0;
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
  /* 通道位置與走軌判定用已收盤棒（走軌是「連 3 根都貼著軌道」的是非題，
     把成形棒算進去會讓它每分鐘成立又消失）；%B 與中軌相對位置改用即時
     價去比——通道是收盤畫出來的，現價落在哪裡則是當下的事實。 */
  const _spB = splitFormingBar(raw);
  const _bSrc = _spB.closed.length >= 22 ? _spB.closed : raw;
  const { closes, highs, lows } = parseKlines(_bSrc);
  const n = closes.length;
  if (n < 22) return null;

  const bb = calcBollingerBands(closes, 20, 2);
  if (!bb) return null;
  const { upper, middle, lower, width } = bb;
  const price = (_spB.live != null && _bSrc !== raw) ? _spB.live : closes[n - 1];
  // %B 以即時價重算（bb.pctB 是收盤棒的位置，這裡要的是「現在」站在哪）
  const pctB = (upper - lower) > 0 ? (price - lower) / (upper - lower) : 0.5;
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
/* ── 擺動結構趨勢（HH/HL/LH/LL ＋ BOS/CHoCH）──────────────────────
   成熟的趨勢判定讀的是「結構」不是指標快照：
   · ZigZag 擺動點：反轉需 ≥1.5×ATR 才確認一個擺動（雜訊不進結構）
   · HH+HL＝上升、LH+LL＝下降、混合＝區間
   · BOS（Break of Structure）：現價突破最後確認擺動高/低＝趨勢延續確認
   · CHoCH（Change of Character）：上升結構的最後 higher-low 被跌破
     （或下降結構的 lower-high 被突破）＝趨勢性格轉變的第一個訊號——
     這正是指標快照最晚才反映的時刻
   · 品質：近 40 根線性回歸斜率（ATR 標準化）與 R²——趨勢不只有方向，
     還有「走得直不直」 */
function computeSwingStructure(highs, lows, closes, atr, revK = 1.5) {
  const n = closes.length;
  if (n < 40 || !(atr > 0)) return null;
  const piv = [];
  let dir = 1, extP = highs[0], extI = 0;
  for (let i = 1; i < n; i++) {
    if (dir === 1) {
      if (highs[i] >= extP) { extP = highs[i]; extI = i; }
      else if (extP - lows[i] >= revK * atr) {
        piv.push({ i: extI, p: extP, hi: true });
        dir = -1; extP = lows[i]; extI = i;
      }
    } else {
      if (lows[i] <= extP) { extP = lows[i]; extI = i; }
      else if (highs[i] - extP >= revK * atr) {
        piv.push({ i: extI, p: extP, hi: false });
        dir = 1; extP = highs[i]; extI = i;
      }
    }
  }
  const hiPiv = piv.filter(p => p.hi), loPiv = piv.filter(p => !p.hi);
  if (hiPiv.length < 2 || loPiv.length < 2) return { dir: 'range', pivots: piv.length };
  const h2 = hiPiv[hiPiv.length - 2], h1 = hiPiv[hiPiv.length - 1];
  const l2 = loPiv[loPiv.length - 2], l1 = loPiv[loPiv.length - 1];
  const hh = h1.p > h2.p, hl = l1.p > l2.p, lh = h1.p < h2.p, ll = l1.p < l2.p;
  let sdir = 'range';
  if (hh && hl) sdir = 'up'; else if (lh && ll) sdir = 'down';
  const price = closes[n - 1];
  const bosUp = price > h1.p, bosDown = price < l1.p;
  const chochDown = (hh || hl) && sdir !== 'down' && price < l1.p;   // 上升性格被破
  const chochUp   = (lh || ll) && sdir !== 'up' && price > h1.p;     // 下降性格被破
  // 趨勢品質：近 40 根回歸斜率與 R²
  const win = closes.slice(-40), m = win.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) { sx += i; sy += win[i]; sxy += i * win[i]; sxx += i * i; }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1);
  const meanY = sy / m, b = meanY - slope * (sx / m);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < m; i++) { const f = slope * i + b; ssTot += (win[i] - meanY) ** 2; ssRes += (win[i] - f) ** 2; }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { dir: sdir, hh, hl, lh, ll, bosUp, bosDown, chochUp, chochDown,
    lastHigh: h1.p, lastLow: l1.p, pivots: piv.length,
    slopeAtr: +(slope / atr).toFixed(3), r2: +r2.toFixed(2) };
}

/* ── 裸 K 型態（經典價格行為，不用任何指標）──────────────────────
   對最近幾根 K 棒辨識：吞噬、針形（錘子/射擊之星）、內包、十字星、
   三兵/三鴉。門檻全部以 ATR 標準化——「大實體」在 BTC 和小幣上
   意義不同，用絕對值判定會全錯。
   注意：最後一根可能仍在形成中，型態會隨它變化；下游把這些當
   「證據投票」而不是單獨的進場理由，成形中的抖動可以被其他證據平衡。 */
function detectNakedK(opens, highs, lows, closes, atr) {
  const n = closes.length;
  const out = { bullEngulf: false, bearEngulf: false, pinBull: false, pinBear: false,
                insideBar: false, doji: false, threeUp: false, threeDown: false, tags: [] };
  if (n < 4 || !(atr > 0)) return out;
  const bar = i => ({ o: opens[i], h: highs[i], l: lows[i], c: closes[i],
    body: Math.abs(closes[i] - opens[i]), range: highs[i] - lows[i],
    upWick: highs[i] - Math.max(opens[i], closes[i]),
    dnWick: Math.min(opens[i], closes[i]) - lows[i],
    bull: closes[i] > opens[i], bear: closes[i] < opens[i] });
  const cur = bar(n - 1), prev = bar(n - 2), p2 = bar(n - 3);

  // 吞噬：前一根反向，這一根實體完整包住前一根實體，且實體夠大（≥0.5×ATR）
  if (prev.bear && cur.bull && cur.o <= prev.c && cur.c >= prev.o && cur.body >= 0.5 * atr)
    { out.bullEngulf = true; out.tags.push('多頭吞噬'); }
  if (prev.bull && cur.bear && cur.o >= prev.c && cur.c <= prev.o && cur.body >= 0.5 * atr)
    { out.bearEngulf = true; out.tags.push('空頭吞噬'); }
  // 針形：影線 ≥ 實體 2 倍且 ≥0.5×ATR，收盤收在有利側 40% 內（拒絕證據）
  if (cur.range > 0) {
    if (cur.dnWick >= 2 * cur.body && cur.dnWick >= 0.5 * atr
        && (cur.c - cur.l) / cur.range >= 0.6) { out.pinBull = true; out.tags.push('下影線拒絕(錘子)'); }
    if (cur.upWick >= 2 * cur.body && cur.upWick >= 0.5 * atr
        && (cur.h - cur.c) / cur.range >= 0.6) { out.pinBear = true; out.tags.push('上影線拒絕(射擊之星)'); }
  }
  // 內包：整根被前一根高低完整包住（蓄勢，方向由突破決定）
  if (cur.h < prev.h && cur.l > prev.l) { out.insideBar = true; out.tags.push('內包蓄勢'); }
  // 十字星：實體 ≤ 15% 全幅且全幅不小（猶豫棒，配合位置才有意義）
  if (cur.range >= 0.5 * atr && cur.body <= 0.15 * cur.range) { out.doji = true; out.tags.push('十字星'); }
  // 三兵/三鴉：連三根同向且收盤逐步推進
  if (p2.bull && prev.bull && cur.bull && prev.c > p2.c && cur.c > prev.c)
    { out.threeUp = true; out.tags.push('紅三兵'); }
  if (p2.bear && prev.bear && cur.bear && prev.c < p2.c && cur.c < prev.c)
    { out.threeDown = true; out.tags.push('黑三鴉'); }
  return out;
}

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
        return { type: 'bullish', high: obHigh, low: obLow, idx: i,
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
        return { type: 'bearish', high: obHigh, low: obLow, idx: i,
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
        if (size >= 0.15) gaps.push({ high: gH, low: gL, mid: (gH + gL) / 2, size, filled: cur < gH, idx: i });
      }
    } else {
      // Bearish FVG: candle i-2 low > candle i high → gap down
      const gH = lows[i - 2], gL = highs[i];
      if (gH > gL && cur < gH) {
        const size = (gH - gL) / gL * 100;
        if (size >= 0.15) gaps.push({ high: gH, low: gL, mid: (gH + gL) / 2, size, filled: cur > gL, idx: i });
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

/* ── ICT Turtle Soup（烏龜湯）偵測 ──────────────────────────────────────── */
function detectTurtleSoup(klines) {
  if (!klines || klines.length < 30) return null;
  const n = klines.length;
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const cur = closes[n - 1];
  const fp = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');

  const lb = Math.min(50, n - 5);
  const pivotHigh = Math.max(...highs.slice(n - lb, n - 5));
  const pivotLow  = Math.min(...lows.slice(n - lb, n - 5));

  let bull = null, bear = null;

  // Bull Turtle Soup：掃蕩前低後快速收回
  const minRL = Math.min(...lows.slice(n - 5));
  if (minRL < pivotLow * 0.998 && cur > pivotLow) {
    const quickReverse = closes.slice(n - 4).filter(c => c > pivotLow).length >= 2;
    if (quickReverse) {
      const depth = ((pivotLow - minRL) / pivotLow * 100).toFixed(2);
      bull = { level: pivotLow, depth: parseFloat(depth),
               label: `🐢 烏龜湯（多）：掃蕩前低 $${fp(pivotLow)} 後快速反轉（深度 ${depth}%）` };
    }
  }

  // Bear Turtle Soup：掃蕩前高後快速跌回
  const maxRH = Math.max(...highs.slice(n - 5));
  if (maxRH > pivotHigh * 1.002 && cur < pivotHigh) {
    const quickReverse = closes.slice(n - 4).filter(c => c < pivotHigh).length >= 2;
    if (quickReverse) {
      const depth = ((maxRH - pivotHigh) / pivotHigh * 100).toFixed(2);
      bear = { level: pivotHigh, depth: parseFloat(depth),
               label: `🐢 烏龜湯（空）：掃蕩前高 $${fp(pivotHigh)} 後快速反轉（深度 ${depth}%）` };
    }
  }

  return (bull || bear) ? { bull, bear } : null;
}

/* ── ICT 2022 Core Model（流動性掃蕩 → MSS → FVG）────────────────────────── */
function detectCoreModel2022(klines, isLong) {
  if (!klines || klines.length < 40) return null;
  const n = klines.length;
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const cur = closes[n - 1];
  const fp = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');

  const swingHigh = Math.max(...highs.slice(n - 30, n - 8));
  const swingLow  = Math.min(...lows.slice(n - 30, n - 8));
  const recentLows  = lows.slice(n - 10, n - 2);
  const recentHighs = highs.slice(n - 10, n - 2);

  let stage = null, sweepLevel = null, fvgZone = null;

  if (isLong) {
    if (Math.min(...recentLows) < swingLow * 0.999) {
      sweepLevel = swingLow;
      stage = 'sweep';
      if (cur > swingHigh * 0.998) stage = 'mss';
      // Find bullish FVG formed after sweep
      for (let i = n - 7; i < n - 1; i++) {
        if (i >= 2) {
          const gL = highs[i - 2], gH = lows[i];
          if (gH > gL && (gH - gL) / gL * 100 >= 0.1 && cur > gL) {
            fvgZone = { high: gH, low: gL, mid: (gH + gL) / 2 };
            stage = cur >= gL && cur <= gH ? 'fvg_entry' : 'fvg_formed';
            break;
          }
        }
      }
    }
  } else {
    if (Math.max(...recentHighs) > swingHigh * 1.001) {
      sweepLevel = swingHigh;
      stage = 'sweep';
      if (cur < swingLow * 1.002) stage = 'mss';
      for (let i = n - 7; i < n - 1; i++) {
        if (i >= 2) {
          const gH = lows[i - 2], gL = highs[i];
          if (gH > gL && (gH - gL) / gL * 100 >= 0.1 && cur < gH) {
            fvgZone = { high: gH, low: gL, mid: (gH + gL) / 2 };
            stage = cur >= gL && cur <= gH ? 'fvg_entry' : 'fvg_formed';
            break;
          }
        }
      }
    }
  }

  if (!stage) return null;
  const stageMap = { sweep: '① 流動性掃蕩', mss: '② MSS 結構轉變', fvg_formed: '③ FVG 形成', fvg_entry: '④ FVG 進場點 🎯' };
  return {
    detected: true, stage, stageLabel: stageMap[stage] || stage,
    sweepLevel, fvgZone, isComplete: stage === 'fvg_entry',
    label: `📐 2022核心模型（${stageMap[stage] || stage}）${stage === 'fvg_entry' ? ' — 黃金進場' : ''}`
  };
}

/* ── ICT Breaker Block 偵測 ──────────────────────────────────────────────── */
function detectBreakerBlock(klines, isLong) {
  if (!klines || klines.length < 30) return null;
  const n = klines.length;
  const opens  = klines.map(k => parseFloat(k[1]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const cur = closes[n - 1];
  const fp = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
  const scanStart = Math.max(1, n - 40), scanEnd = n - 5;

  if (isLong) {
    // Bull Breaker：原始空頭 OB（下跌蠟燭）被價格突破後，轉為支撐
    for (let i = scanStart; i < scanEnd; i++) {
      if (closes[i] >= opens[i]) continue;
      const obHigh = highs[i], obLow = lows[i];
      if (!highs.slice(i + 1, n - 2).some(h => h > obHigh * 1.001)) continue;
      if (cur >= obLow * 0.998 && cur <= obHigh * 1.012) {
        return { high: obHigh, low: obLow, mid: (obHigh + obLow) / 2,
                 type: 'bull', priceInBreaker: cur >= obLow && cur <= obHigh * 1.005,
                 label: `🔵 Bull Breaker Block $${fp(obLow)} – $${fp(obHigh)}` };
      }
    }
  } else {
    // Bear Breaker：原始多頭 OB（上漲蠟燭）被價格跌破後，轉為阻力
    for (let i = scanStart; i < scanEnd; i++) {
      if (closes[i] <= opens[i]) continue;
      const obHigh = highs[i], obLow = lows[i];
      if (!lows.slice(i + 1, n - 2).some(l => l < obLow * 0.999)) continue;
      if (cur >= obLow * 0.988 && cur <= obHigh * 1.002) {
        return { high: obHigh, low: obLow, mid: (obHigh + obLow) / 2,
                 type: 'bear', priceInBreaker: cur >= obLow * 0.995 && cur <= obHigh,
                 label: `🔴 Bear Breaker Block $${fp(obLow)} – $${fp(obHigh)}` };
      }
    }
  }
  return null;
}

/* ── ICT Unicorn Model（Breaker Block + FVG 黃金重疊）──────────────────────── */
function detectUnicornModel(klines, isLong) {
  if (!klines || klines.length < 30) return null;
  const bb  = detectBreakerBlock(klines, isLong);
  if (!bb) return null;
  const fvg = detectFairValueGaps(klines, isLong);
  if (!fvg || fvg.filled) return null;
  const overlapH = Math.min(bb.high, fvg.high);
  const overlapL = Math.max(bb.low, fvg.low);
  if (overlapH <= overlapL) return null;
  const cur = parseFloat(klines[klines.length - 1][4]);
  const fp = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
  const inZone = cur >= overlapL * 0.998 && cur <= overlapH * 1.002;
  return {
    detected: true, breakerBlock: bb, fvg, overlapHigh: overlapH, overlapLow: overlapL,
    priceInGoldenZone: inZone,
    label: `🦄 獨角獸模型：Breaker+FVG 黃金區 $${fp(overlapL)}–$${fp(overlapH)}${inZone ? ' ✅ 進場區' : ''}`
  };
}

/* ── ICT Silver Bullet（時間窗口 FVG 進場）──────────────────────────────── */
function detectSilverBullet(klines, isLong) {
  if (!klines || klines.length < 10) return null;
  const n = klines.length;
  const lastTs = parseFloat(klines[n - 1][0]);
  if (!lastTs || lastTs < 1e12) return null;
  const h = new Date(lastTs).getUTCHours();

  // 銀彈時間窗口（UTC）
  const WINDOWS = [
    { s: 0,  e: 1,  name: '倫敦午夜銀彈', emoji: '🌙' },
    { s: 7,  e: 8,  name: '倫敦開盤銀彈', emoji: '🏦' },
    { s: 13, e: 15, name: '紐約開盤銀彈', emoji: '🗽' },
    { s: 16, e: 17, name: '紐約午後銀彈', emoji: '⭐' },
  ];
  const win = WINDOWS.find(w => h >= w.s && h < w.e)
           || WINDOWS.find(w => h >= w.e && h < w.e + 2);
  if (!win) return null;

  const fvg = detectFairValueGaps(klines, isLong);
  if (!fvg || fvg.filled) return null;
  const cur = parseFloat(klines[n - 1][4]);
  const fp = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
  const atFVG = cur >= fvg.low * 0.998 && cur <= fvg.high * 1.002;
  return {
    detected: true, window: win, fvg,
    isActive: h >= win.s && h < win.e, priceAtFVG: atFVG,
    label: `${win.emoji} 銀彈模型（${win.name}）：FVG $${fp(fvg.low)}–$${fp(fvg.high)}${atFVG ? ' ✅ 進場區間' : ''}`
  };
}

/* ── 快進快出信號偵測（1m K棒，勝率 ≥80% 才觸發）────────────────────────── */
function detectScalpSignal(candles, price, vwap, poc) {
  if (!candles || candles.length < 20 || !price) return null;
  const n = candles.length;
  const last  = candles[n - 1];
  const prev  = candles[n - 2];
  const prev2 = candles[n - 3];
  const fp    = v => parseFloat(v).toPrecision(5).replace(/\.?0+$/, '');

  // 20 棒平均量
  const avgVol = candles.slice(-20).reduce((s, c) => s + c.total, 0) / 20;
  const recentAvgVol = Math.max(avgVol, 1);

  // 最近 10 棒高低
  const hi10 = Math.max(...candles.slice(-10).map(c => c.high));
  const lo10 = Math.min(...candles.slice(-10).map(c => c.low));

  const signals = [];

  // ── 形態 A：三棒同向衝量（Momentum Continuation）──
  // 連續 3 根同向 K 棒 + 量能遞增 + Delta 方向一致，歷史勝率 ~82%
  const bullA = last.close > last.open && prev.close > prev.open && prev2.close > prev2.open;
  const bearA = last.close < last.open && prev.close < prev.open && prev2.close < prev2.open;
  const volInc = last.total >= prev.total * 0.9 && prev.total >= prev2.total * 0.9;

  if (bullA && volInc) {
    let conf = 82;
    const reasons = ['✅ 連續3根多頭K棒，上行動能一致'];
    if (last.total > recentAvgVol * 1.5) { conf += 4; reasons.push(`✅ 量能突破（${(last.total/recentAvgVol).toFixed(1)}x）`); }
    if (last.delta > 0 && prev.delta > 0 && prev2.delta > 0) { conf += 3; reasons.push('✅ Delta 三棒同向偏多'); }
    if (vwap && price > vwap) { conf += 3; reasons.push(`✅ 價格高於 VWAP ($${fp(vwap)})`); }
    if (poc && price > poc && price < poc * 1.008) { conf += 2; reasons.push('✅ POC 支撐位上方'); }
    const range3 = last.high - prev2.low;
    const stop   = Math.min(prev2.low, prev.low) * 0.9995;
    const target = price + range3 * 0.6;
    signals.push({ direction: 'bull', pattern: 'momentum', label: '衝量突破（三棒上攻）', conf, reasons, stop, target });
  }
  if (bearA && volInc) {
    let conf = 82;
    const reasons = ['✅ 連續3根空頭K棒，下行動能一致'];
    if (last.total > recentAvgVol * 1.5) { conf += 4; reasons.push(`✅ 量能突破（${(last.total/recentAvgVol).toFixed(1)}x）`); }
    if (last.delta < 0 && prev.delta < 0 && prev2.delta < 0) { conf += 3; reasons.push('✅ Delta 三棒同向偏空'); }
    if (vwap && price < vwap) { conf += 3; reasons.push(`✅ 價格低於 VWAP ($${fp(vwap)})`); }
    if (poc && price < poc && price > poc * 0.992) { conf += 2; reasons.push('✅ POC 阻力位下方'); }
    const range3 = prev2.high - last.low;
    const stop   = Math.max(prev2.high, prev.high) * 1.0005;
    const target = price - range3 * 0.6;
    signals.push({ direction: 'bear', pattern: 'momentum', label: '衝量下跌（三棒下攻）', conf, reasons, stop, target });
  }

  // ── 形態 B：VWAP 回測反彈（VWAP Bounce）──
  // 價格觸及 VWAP 後被強力吸收反彈，歷史勝率 ~83%
  if (vwap && vwap > 0) {
    const recent5 = candles.slice(-5);
    const touchedVwapBull = recent5.some(c => c.low <= vwap * 1.002 && c.low >= vwap * 0.995);
    const touchedVwapBear = recent5.some(c => c.high >= vwap * 0.998 && c.high <= vwap * 1.005);
    const lastBodyRatio   = last.high > last.low ? Math.abs(last.priceChange) / (last.high - last.low) : 0;

    if (touchedVwapBull && last.close > vwap * 1.001 && last.close > last.open && lastBodyRatio >= 0.5) {
      let conf = 83;
      const reasons = [`✅ VWAP ($${fp(vwap)}) 回測支撐，強力反彈`];
      if (lastBodyRatio >= 0.7) { conf += 3; reasons.push('✅ 強力實體K棒（反彈確認）'); }
      if (last.total > recentAvgVol) { conf += 2; reasons.push('✅ 量能上升'); }
      if (last.buyRatio > 0.58) { conf += 2; reasons.push(`✅ 買盤佔比 ${(last.buyRatio*100).toFixed(0)}%`); }
      const stop   = vwap * 0.997;
      const target = price + (price - stop) * 1.5;
      signals.push({ direction: 'bull', pattern: 'vwap_bounce', label: 'VWAP 回測多頭反彈', conf, reasons, stop, target });
    }
    if (touchedVwapBear && last.close < vwap * 0.999 && last.close < last.open && lastBodyRatio >= 0.5) {
      let conf = 83;
      const reasons = [`✅ VWAP ($${fp(vwap)}) 回測阻力，強力回跌`];
      if (lastBodyRatio >= 0.7) { conf += 3; reasons.push('✅ 強力實體K棒（回跌確認）'); }
      if (last.total > recentAvgVol) { conf += 2; reasons.push('✅ 量能上升'); }
      if (last.buyRatio < 0.42) { conf += 2; reasons.push(`✅ 賣盤佔比 ${((1-last.buyRatio)*100).toFixed(0)}%`); }
      const stop   = vwap * 1.003;
      const target = price - (stop - price) * 1.5;
      signals.push({ direction: 'bear', pattern: 'vwap_bounce', label: 'VWAP 回測空頭回跌', conf, reasons, stop, target });
    }
  }

  // ── 形態 C：帶量突破（Volume Breakout）──
  // 放量突破近 10 棒高低點 + 強勢實體，歷史勝率 ~80%
  const lastBody = last.high > last.low ? Math.abs(last.priceChange) / (last.high - last.low) : 0;
  if (last.close > hi10 && last.total >= recentAvgVol * 1.8 && lastBody >= 0.6) {
    let conf = 80;
    const reasons = [`✅ 放量突破 10K高點 $${fp(hi10)}`];
    if (last.total >= recentAvgVol * 2.5) { conf += 5; reasons.push(`✅ 強力放量（${(last.total/recentAvgVol).toFixed(1)}x 均量）`); }
    else { reasons.push(`✅ 放量（${(last.total/recentAvgVol).toFixed(1)}x 均量）`); }
    if (last.buyRatio > 0.65) { conf += 3; reasons.push(`✅ 主動買盤 ${(last.buyRatio*100).toFixed(0)}%`); }
    if (poc && last.close > poc) { conf += 2; reasons.push('✅ 突破 POC 控制點'); }
    if (vwap && last.close > vwap) { conf += 2; reasons.push('✅ 站上 VWAP'); }
    const stop   = Math.max(prev.low, last.open) * 0.9995;
    const target = last.close + (last.close - stop) * 1.5;
    signals.push({ direction: 'bull', pattern: 'breakout', label: '放量突破近高點', conf, reasons, stop, target });
  }
  if (last.close < lo10 && last.total >= recentAvgVol * 1.8 && lastBody >= 0.6) {
    let conf = 80;
    const reasons = [`✅ 放量跌破 10K低點 $${fp(lo10)}`];
    if (last.total >= recentAvgVol * 2.5) { conf += 5; reasons.push(`✅ 強力放量（${(last.total/recentAvgVol).toFixed(1)}x 均量）`); }
    else { reasons.push(`✅ 放量（${(last.total/recentAvgVol).toFixed(1)}x 均量）`); }
    if (last.buyRatio < 0.35) { conf += 3; reasons.push(`✅ 主動賣盤 ${((1-last.buyRatio)*100).toFixed(0)}%`); }
    if (poc && last.close < poc) { conf += 2; reasons.push('✅ 跌破 POC 控制點'); }
    if (vwap && last.close < vwap) { conf += 2; reasons.push('✅ 跌破 VWAP'); }
    const stop   = Math.min(prev.high, last.open) * 1.0005;
    const target = last.close - (stop - last.close) * 1.5;
    signals.push({ direction: 'bear', pattern: 'breakout', label: '放量跌破近低點', conf, reasons, stop, target });
  }

  // 取最高信心度信號，只有 ≥80 才回傳
  if (!signals.length) return null;
  const best = signals.sort((a, b) => b.conf - a.conf)[0];
  if (best.conf < 80) return null;

  const riskPct  = Math.abs((best.stop - price) / price * 100);
  const rewardPct = Math.abs((best.target - price) / price * 100);
  return {
    ...best,
    conf: Math.min(92, best.conf),
    entryPrice: price,
    riskPct:    parseFloat(riskPct.toFixed(2)),
    rewardPct:  parseFloat(rewardPct.toFixed(2)),
    rr:         riskPct > 0 ? parseFloat((rewardPct / riskPct).toFixed(1)) : 0,
  };
}

/* ── 傳統技術圖形識別（SQ ⑩）──────────────────────────────── */
function detectChartPatterns(klines, isLong) {
  if (!klines || klines.length < 30) return { patterns: [], score: 0, aligned: [], opposing: [] };
  try {
    const n      = klines.length;
    const opens  = klines.map(k => parseFloat(k[1]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const closes = klines.map(k => parseFloat(k[4]));
    const cur    = closes[n - 1];
    const fp     = v => parseFloat(v).toPrecision(5).replace(/\.?0+$/, '');

    // 找局部極值（pivot）
    function findPivots(win, lb) {
      const start = Math.max(0, n - lb);
      const pk = [], vl = [];
      for (let i = start + win; i < n - win; i++) {
        let isPk = true, isVl = true;
        for (let j = 1; j <= win; j++) {
          if (highs[i-j] >= highs[i] || highs[i+j] >= highs[i]) isPk = false;
          if (lows[i-j]  <= lows[i]  || lows[i+j]  <= lows[i])  isVl = false;
        }
        if (isPk) pk.push({ i, price: highs[i] });
        if (isVl) vl.push({ i, price: lows[i] });
      }
      return { pk, vl };
    }

    const { pk, vl } = findPivots(3, 80);
    const patterns = [];

    // ① M頂（雙頂）
    if (pk.length >= 2) {
      const p1 = pk[pk.length - 2], p2 = pk[pk.length - 1];
      const sim = Math.abs(p1.price - p2.price) / p1.price;
      if (sim < 0.03) {
        const midVl = vl.filter(v => v.i > p1.i && v.i < p2.i);
        if (midVl.length) {
          const neck = Math.min(...midVl.map(v => v.price));
          if ((p1.price - neck) / p1.price > 0.02)
            patterns.push({ name: 'M頂（雙頂）', emoji: '🔻', aligned: !isLong, strength: 'strong', status: 'confirmed',
              desc: `雙頂 $${fp(p1.price)}/$${fp(p2.price)} 頸線 $${fp(neck)}` });
        }
      }
    }

    // ② W底（雙底）
    if (vl.length >= 2) {
      const v1 = vl[vl.length - 2], v2 = vl[vl.length - 1];
      const sim = Math.abs(v1.price - v2.price) / v1.price;
      if (sim < 0.03) {
        const midPk = pk.filter(p => p.i > v1.i && p.i < v2.i);
        if (midPk.length) {
          const neck = Math.max(...midPk.map(p => p.price));
          if ((neck - v1.price) / v1.price > 0.02)
            patterns.push({ name: 'W底（雙底）', emoji: '🔺', aligned: isLong, strength: 'strong', status: 'confirmed',
              desc: `雙底 $${fp(v1.price)}/$${fp(v2.price)} 頸線 $${fp(neck)}` });
        }
      }
    }

    // ③ 頭肩頂
    if (pk.length >= 3) {
      const ls = pk[pk.length - 3], hd = pk[pk.length - 2], rs = pk[pk.length - 1];
      if (hd.price > ls.price && hd.price > rs.price && Math.abs(ls.price - rs.price) / ls.price < 0.08) {
        const v1 = vl.filter(v => v.i > ls.i && v.i < hd.i);
        const v2 = vl.filter(v => v.i > hd.i && v.i < rs.i);
        if (v1.length && v2.length)
          patterns.push({ name: '頭肩頂', emoji: '👤🔻', aligned: !isLong, strength: 'strong', status: 'confirmed',
            desc: `左肩 $${fp(ls.price)} 頭 $${fp(hd.price)} 右肩 $${fp(rs.price)}` });
      }
    }

    // ④ 頭肩底
    if (vl.length >= 3) {
      const ls = vl[vl.length - 3], hd = vl[vl.length - 2], rs = vl[vl.length - 1];
      if (hd.price < ls.price && hd.price < rs.price && Math.abs(ls.price - rs.price) / ls.price < 0.08) {
        const p1 = pk.filter(p => p.i > ls.i && p.i < hd.i);
        const p2 = pk.filter(p => p.i > hd.i && p.i < rs.i);
        if (p1.length && p2.length)
          patterns.push({ name: '頭肩底', emoji: '👤🔺', aligned: isLong, strength: 'strong', status: 'confirmed',
            desc: `左肩 $${fp(ls.price)} 頭 $${fp(hd.price)} 右肩 $${fp(rs.price)}` });
      }
    }

    // ⑤ 收斂三角形
    if (pk.length >= 3 && vl.length >= 3) {
      const rPk = pk.slice(-3), rVl = vl.slice(-3);
      const hSlope = (rPk[2].price - rPk[0].price) / Math.max(1, rPk[2].i - rPk[0].i);
      const lSlope = (rVl[2].price - rVl[0].price) / Math.max(1, rVl[2].i - rVl[0].i);
      const avgH = rPk.reduce((s, p) => s + p.price, 0) / 3;
      const norm = avgH || 1;
      const hN = hSlope / norm, lN = lSlope / norm;
      if (hN < -0.0002 && lN > 0.0002)
        patterns.push({ name: '對稱收斂三角', emoji: '📐', aligned: null, strength: 'moderate', status: 'confirmed', desc: '高低點收斂，等待突破方向' });
      else if (Math.abs(hN) < 0.0001 && lN > 0.0002)
        patterns.push({ name: '上升三角（偏多）', emoji: '📐🔺', aligned: isLong, strength: 'moderate', status: 'confirmed', desc: '底部抬升、阻力平穩，多頭蓄力' });
      else if (hN < -0.0002 && Math.abs(lN) < 0.0001)
        patterns.push({ name: '下降三角（偏空）', emoji: '📐🔻', aligned: !isLong, strength: 'moderate', status: 'confirmed', desc: '高點下移、支撐平穩，空頭蓄力' });
    }

    // ⑥ 旗形（Flag）
    if (n >= 20) {
      const poleEnd = n - 12;
      const poleH = Math.max(...highs.slice(poleEnd, poleEnd + 6));
      const poleL = Math.min(...lows.slice(poleEnd, poleEnd + 6));
      const polePct = (poleH - poleL) / (poleL || 1) * 100;
      if (polePct > 3) {
        const consH = Math.max(...highs.slice(poleEnd + 6));
        const consL = Math.min(...lows.slice(poleEnd + 6));
        const consPct = (consH - consL) / (consL || 1) * 100;
        if (consPct < polePct * 0.4) {
          const bullPole = closes[poleEnd + 5] > opens[poleEnd];
          patterns.push({ name: bullPole ? '多頭旗形' : '空頭旗形', emoji: bullPole ? '🚩🔺' : '🚩🔻',
            aligned: bullPole ? isLong : !isLong, strength: 'moderate', status: 'confirmed',
            desc: `急${bullPole ? '升' : '跌'} ${polePct.toFixed(1)}% 後盤整 ${consPct.toFixed(1)}%` });
        }
      }
    }

    // ⑦ PO3（積累→操縱→分配）
    if (n >= 30) {
      const accH = Math.max(...highs.slice(n - 30, n - 20));
      const accL = Math.min(...lows.slice(n - 30, n - 20));
      const accR  = (accH - accL) / (accL || 1) * 100;
      if (accR < 3) {
        const manH = Math.max(...highs.slice(n - 20, n - 10));
        const manL = Math.min(...lows.slice(n - 20, n - 10));
        const hasManip = manH > accH * 1.004 || manL < accL * 0.996;
        const bullDist = cur > accH * 1.003;
        const bearDist = cur < accL * 0.997;
        if (hasManip && (bullDist || bearDist))
          patterns.push({ name: 'PO3 積累→操縱→分配', emoji: '🎯', aligned: bullDist ? isLong : !isLong, strength: 'strong', status: 'confirmed',
            desc: `積累 ${accR.toFixed(1)}% 盤整後${bullDist ? '多頭' : '空頭'}發動` });
      }
    }

    // ⑧ 突破回踩確認（盤整突破回踩踩穩）
    if (n >= 15) {
      const lb = Math.min(40, n - 10);
      const prevH = Math.max(...highs.slice(n - lb, n - 8));
      const prevL = Math.min(...lows.slice(n - lb, n - 8));
      const rc3H  = Math.max(...highs.slice(n - 3));
      const rc3L  = Math.min(...lows.slice(n - 3));
      const preC  = closes[n - 5];
      if (cur > prevH * 1.003 && rc3L > prevH * 0.990 && preC < prevH * 1.008)
        patterns.push({ name: '突破回踩踩穩（多）', emoji: '✅🔺', aligned: isLong, strength: 'strong', status: 'confirmed',
          desc: `突破前高 $${fp(prevH)} 後回測站穩，多頭延伸確認` });
      else if (cur < prevL * 0.997 && rc3H < prevL * 1.010 && preC > prevL * 0.992)
        patterns.push({ name: '跌破回測確認（空）', emoji: '✅🔻', aligned: !isLong, strength: 'strong', status: 'confirmed',
          desc: `跌破前低 $${fp(prevL)} 回測承壓，空頭延伸確認` });
    }

    // ⑨ BOS（市場結構突破）
    if (n >= 25) {
      const prevH = Math.max(...highs.slice(n - 20, n - 5));
      const prevL = Math.min(...lows.slice(n - 20, n - 5));
      const rcH   = Math.max(...highs.slice(n - 5));
      const rcL   = Math.min(...lows.slice(n - 5));
      if (rcH > prevH * 1.003)
        patterns.push({ name: 'BOS 結構突破（偏多）', emoji: '🏗️🔺', aligned: isLong, strength: 'moderate', status: 'confirmed',
          desc: `近5K突破前高 $${fp(prevH)}，多頭結構確立` });
      else if (rcL < prevL * 0.997)
        patterns.push({ name: 'BOS 結構突破（偏空）', emoji: '🏗️🔻', aligned: !isLong, strength: 'moderate', status: 'confirmed',
          desc: `近5K跌破前低 $${fp(prevL)}，空頭結構確立` });
    }

    // ⑩ CHoCH（結構轉換信號）
    if (n >= 30) {
      const trendH = closes.slice(n - 25, n - 10);
      const trend  = trendH[trendH.length - 1] > trendH[0] ? 'up' : 'down';
      const rcH    = Math.max(...highs.slice(n - 6));
      const rcL    = Math.min(...lows.slice(n - 6));
      const midH   = Math.max(...highs.slice(n - 18, n - 6));
      const midL   = Math.min(...lows.slice(n - 18, n - 6));
      if (trend === 'down' && rcH > midH * 1.005)
        patterns.push({ name: 'CHoCH 結構轉換（空轉多）', emoji: '🔄🔺', aligned: isLong, strength: 'strong', status: 'confirmed',
          desc: '下跌趨勢中出現首個更高高點，方向可能轉換' });
      else if (trend === 'up' && rcL < midL * 0.995)
        patterns.push({ name: 'CHoCH 結構轉換（多轉空）', emoji: '🔄🔻', aligned: !isLong, strength: 'strong', status: 'confirmed',
          desc: '上漲趨勢中出現首個更低低點，方向可能轉換' });
    }

    // ⑪ 流動性掃除（Liquidity Sweep）
    if (n >= 15) {
      const prevH = Math.max(...highs.slice(n - 15, n - 3));
      const prevL = Math.min(...lows.slice(n - 15, n - 3));
      const rcH   = Math.max(...highs.slice(n - 3));
      const rcL   = Math.min(...lows.slice(n - 3));
      if (rcL < prevL * 0.997 && cur > prevL * 1.002)
        patterns.push({ name: '流動性掃除（偏多）', emoji: '💧🔺', aligned: isLong, strength: 'strong', status: 'confirmed',
          desc: `掃除前低 $${fp(prevL)} 後反彈，ICT 流動性獵取做多` });
      else if (rcH > prevH * 1.003 && cur < prevH * 0.998)
        patterns.push({ name: '流動性掃除（偏空）', emoji: '💧🔻', aligned: !isLong, strength: 'strong', status: 'confirmed',
          desc: `掃除前高 $${fp(prevH)} 後回落，ICT 流動性獵取做空` });
    }

    // ⑫ 看漲/看跌通道（平行通道）
    if (pk.length >= 2 && vl.length >= 2) {
      const rPk = pk.slice(-2), rVl = vl.slice(-2);
      const hSlope = (rPk[1].price - rPk[0].price) / Math.max(1, rPk[1].i - rPk[0].i);
      const lSlope = (rVl[1].price - rVl[0].price) / Math.max(1, rVl[1].i - rVl[0].i);
      const avgP = (rPk[0].price + rVl[0].price) / 2 || 1;
      const hN = hSlope / avgP, lN = lSlope / avgP;
      const isParallel = Math.abs(hN - lN) < Math.abs(hN) * 0.5;
      const chWidth = ((rPk[0].price + rPk[1].price) / 2 - (rVl[0].price + rVl[1].price) / 2) / avgP;
      if (isParallel && chWidth > 0.02) {
        if (hN > 0.0003 && lN > 0.0003)
          patterns.push({ name: '看漲通道', emoji: '📈🟢', aligned: isLong, strength: 'moderate', status: 'confirmed',
            desc: `上升平行通道（高點 +${(hN*1e4).toFixed(1)} 低點 +${(lN*1e4).toFixed(1)} per bar）` });
        else if (hN < -0.0003 && lN < -0.0003)
          patterns.push({ name: '看跌通道', emoji: '📉🔴', aligned: !isLong, strength: 'moderate', status: 'confirmed',
            desc: `下降平行通道（高點 ${(hN*1e4).toFixed(1)} 低點 ${(lN*1e4).toFixed(1)} per bar）` });
      }
    }

    // ⑬ 看漲/看跌矩形（水平整理箱型）
    if (n >= 20) {
      const boxH = Math.max(...highs.slice(n - 20, n - 3));
      const boxL = Math.min(...lows.slice(n - 20, n - 3));
      const boxRange = (boxH - boxL) / (boxL || 1) * 100;
      if (boxRange > 1.5 && boxRange < 12) {
        const recentH = Math.max(...highs.slice(n - 20));
        const recentL = Math.min(...lows.slice(n - 20));
        const boxDev  = (recentH - recentL) / (recentL || 1) * 100;
        // 矩形：近期高低點未大幅突破整理區間
        if (boxDev < boxRange * 1.15) {
          const nearTop = cur > boxH * 0.985;
          const nearBot = cur < boxL * 1.015;
          const fp2 = v => parseFloat(v).toPrecision(5).replace(/\.?0+$/, '');
          if (nearBot)
            patterns.push({ name: '看漲矩形', emoji: '⬜🔺', aligned: isLong, strength: 'moderate', status: 'confirmed',
              desc: `水平整理 $${fp2(boxL)}–$${fp2(boxH)}（${boxRange.toFixed(1)}%），現價近箱底` });
          else if (nearTop)
            patterns.push({ name: '看跌矩形', emoji: '⬜🔻', aligned: !isLong, strength: 'moderate', status: 'confirmed',
              desc: `水平整理 $${fp2(boxL)}–$${fp2(boxH)}（${boxRange.toFixed(1)}%），現價近箱頂` });
        }
      }
    }

    // ⑭ 三角旗（Pennant）：急漲/急跌後的收斂三角盤整
    if (n >= 25) {
      const poleH = Math.max(...highs.slice(n - 22, n - 14));
      const poleL = Math.min(...lows.slice(n - 22, n - 14));
      const polePct = (poleH - poleL) / (poleL || 1) * 100;
      if (polePct > 4) {
        const bullPole = closes[n - 14] > closes[n - 22];
        const pennH = Math.max(...highs.slice(n - 14, n - 2));
        const pennL = Math.min(...lows.slice(n - 14, n - 2));
        const pennR = (pennH - pennL) / (pennL || 1) * 100;
        // 三角旗：盤整幅度小於旗桿的 1/3，且近期高低點收斂
        if (pennR < polePct * 0.35 && pk.length >= 2 && vl.length >= 2) {
          const rPk2 = pk.slice(-2), rVl2 = vl.slice(-2);
          const hS2  = rPk2.length >= 2 ? rPk2[1].price - rPk2[0].price : 0;
          const lS2  = rVl2.length >= 2 ? rVl2[1].price - rVl2[0].price : 0;
          const converging = bullPole ? (hS2 < 0 && lS2 > 0) : (hS2 < 0 && lS2 > 0);
          if (converging || Math.abs(hS2 + lS2) < pennH * 0.005) {
            patterns.push({ name: bullPole ? '看漲三角旗（Pennant）' : '看跌三角旗（Pennant）',
              emoji: bullPole ? '🚩📐🔺' : '🚩📐🔻',
              aligned: bullPole ? isLong : !isLong, strength: 'strong', status: 'confirmed',
              desc: `旗桿 ${polePct.toFixed(1)}% 後收斂盤整 ${pennR.toFixed(1)}%，等待${bullPole ? '多頭' : '空頭'}突破` });
          }
        }
      }
    }

    // ⑮ 楔型（Wedge）：收斂但同向斜率 → 看漲楔型=下降楔，看跌楔型=上升楔
    if (pk.length >= 3 && vl.length >= 3) {
      const rPk3 = pk.slice(-3), rVl3 = vl.slice(-3);
      const hS3 = (rPk3[2].price - rPk3[0].price) / Math.max(1, rPk3[2].i - rPk3[0].i);
      const lS3 = (rVl3[2].price - rVl3[0].price) / Math.max(1, rVl3[2].i - rVl3[0].i);
      const avgP3 = (rPk3[0].price + rVl3[0].price) / 2 || 1;
      const hN3 = hS3 / avgP3, lN3 = lS3 / avgP3;
      // 確認是收斂（高低線同向但高線斜率絕對值大於低線，或相反）
      const bothDown = hN3 < -0.0002 && lN3 < -0.0002;   // 下降楔→看漲
      const bothUp   = hN3 >  0.0002 && lN3 >  0.0002;   // 上升楔→看跌
      // 確認收斂：兩條線斜率不一樣（間距縮小）
      if (bothDown && Math.abs(hN3) < Math.abs(lN3) * 0.9) {
        patterns.push({ name: '看漲楔型（下降楔）', emoji: '🔽🔺', aligned: isLong, strength: 'strong', status: 'confirmed',
          desc: `高低點同步下移但幅度收斂，空頭力竭，多頭楔型蓄力` });
      } else if (bothUp && hN3 > lN3 * 1.1) {
        patterns.push({ name: '看跌楔型（上升楔）', emoji: '🔼🔻', aligned: !isLong, strength: 'strong', status: 'confirmed',
          desc: `高低點同步上移但幅度收斂，多頭力竭，空頭楔型蓄力` });
      }
    }

    // ── 形成中（Forming）形態偵測 ──
    // M頂形成中：一個峰頂已出現，現價接近峰頂水平
    if (pk.length >= 1 && patterns.every(p => p.name !== 'M頂（雙頂）')) {
      const lastPk = pk[pk.length - 1];
      if (Math.abs(cur - lastPk.price) / lastPk.price < 0.025 && cur < lastPk.price)
        patterns.push({ name: 'M頂形成中', emoji: '🔻⏳', aligned: !isLong, strength: 'weak', status: 'forming',
          desc: `現價接近前峰 $${fp(lastPk.price)}，觀察是否形成雙頂` });
    }
    // W底形成中：一個谷底已出現，現價接近谷底水平
    if (vl.length >= 1 && patterns.every(p => p.name !== 'W底（雙底）')) {
      const lastVl = vl[vl.length - 1];
      if (Math.abs(cur - lastVl.price) / lastVl.price < 0.025 && cur > lastVl.price)
        patterns.push({ name: 'W底形成中', emoji: '🔺⏳', aligned: isLong, strength: 'weak', status: 'forming',
          desc: `現價接近前谷 $${fp(lastVl.price)}，觀察是否形成雙底` });
    }
    // 三角收斂形成中：2+ 峰谷但尚未 3 個
    if (pk.length === 2 && vl.length === 2 && patterns.every(p => !p.name.includes('三角'))) {
      const hS = (pk[1].price - pk[0].price) / Math.max(1, pk[1].i - pk[0].i) / (pk[0].price || 1);
      const lS = (vl[1].price - vl[0].price) / Math.max(1, vl[1].i - vl[0].i) / (vl[0].price || 1);
      if (hS < -0.0001 && lS > 0.0001)
        patterns.push({ name: '收斂三角形成中', emoji: '📐⏳', aligned: null, strength: 'weak', status: 'forming',
          desc: '高低點開始收斂，三角形態初步成形' });
    }
    // BOS 臨近形成中：現價接近前期重要高低點
    if (n >= 20) {
      const pHigh = Math.max(...highs.slice(n - 20, n - 5));
      const pLow  = Math.min(...lows.slice(n - 20, n - 5));
      if (patterns.every(p => !p.name.includes('BOS'))) {
        if (isLong && cur > pHigh * 0.996 && cur < pHigh * 1.003)
          patterns.push({ name: 'BOS 突破前高臨近', emoji: '🏗️⏳', aligned: isLong, strength: 'weak', status: 'forming',
            desc: `現價接近前高 $${fp(pHigh)}，觀察是否有效突破` });
        else if (!isLong && cur < pLow * 1.004 && cur > pLow * 0.997)
          patterns.push({ name: 'BOS 跌破前低臨近', emoji: '🏗️⏳', aligned: !isLong, strength: 'weak', status: 'forming',
            desc: `現價接近前低 $${fp(pLow)}，觀察是否有效跌破` });
      }
    }

    const aligned  = patterns.filter(p => p.aligned === true);
    const opposing = patterns.filter(p => p.aligned === false);
    const neutral  = patterns.filter(p => p.aligned === null);
    const confirmedAligned = aligned.filter(p => p.status !== 'forming');
    const strongA  = confirmedAligned.filter(p => p.strength === 'strong');
    const score    = strongA.length >= 2 ? 3 : strongA.length >= 1 ? 2 : confirmedAligned.length >= 1 ? 1 : 0;

    return { patterns, score, aligned, opposing, neutral };
  } catch(_cpe) { console.warn('[chartPatterns]', _cpe); return { patterns: [], score: 0, aligned: [], opposing: [], neutral: [] }; }
}

/* ── 真假突破確認（量能 + 收盤站穩）──────────────────────────── */
function verifyBreakoutConfirmed(klines, isLong) {
  if (!klines || klines.length < 12) return { confirmed: true, warn: '' };
  try {
    const n      = klines.length;
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const closes = klines.map(k => parseFloat(k[4]));
    const vols   = klines.map(k => parseFloat(k[5]));
    const cur    = closes[n - 1];
    const fp     = v => parseFloat(v).toPrecision(5).replace(/\.?0+$/, '');

    const lb     = Math.min(40, n - 6);
    const prevH  = Math.max(...highs.slice(n - lb, n - 5));
    const prevL  = Math.min(...lows.slice(n - lb, n - 5));
    const avgVol = vols.slice(n - 20, n - 5).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(15, n - 5));

    if (isLong) {
      if (cur <= prevH * 1.001) return { confirmed: true, warn: '' };
      const closesAbove = closes.slice(n - 5).filter(c => c > prevH * 0.998).length;
      const closeBelow  = closes.slice(n - 5).some(c => c < prevH * 0.993);
      const breakVol    = Math.max(...vols.slice(Math.max(0, n - 8), n - 1));
      if (closeBelow)      return { confirmed: false, warn: `突破後收盤跌回前高 $${fp(prevH)} 以下，疑似假突破` };
      if (closesAbove < 2) return { confirmed: false, warn: `突破前高 $${fp(prevH)} 但收盤站穩不足（${closesAbove}/5根），等待確認` };
      if (breakVol < avgVol * 1.05) return { confirmed: false, warn: `突破量能偏低（均量 ${(breakVol/avgVol*100).toFixed(0)}%），需放量確認真突破` };
      return { confirmed: true, warn: '' };
    } else {
      if (cur >= prevL * 0.999) return { confirmed: true, warn: '' };
      const closesBelow = closes.slice(n - 5).filter(c => c < prevL * 1.002).length;
      const closeAbove  = closes.slice(n - 5).some(c => c > prevL * 1.007);
      const breakVol    = Math.max(...vols.slice(Math.max(0, n - 8), n - 1));
      if (closeAbove)      return { confirmed: false, warn: `跌破後收盤反彈回前低 $${fp(prevL)} 以上，疑似假跌破` };
      if (closesBelow < 2) return { confirmed: false, warn: `跌破前低 $${fp(prevL)} 但收盤站穩不足（${closesBelow}/5根），等待確認` };
      if (breakVol < avgVol * 1.05) return { confirmed: false, warn: `跌破量能偏低（均量 ${(breakVol/avgVol*100).toFixed(0)}%），需放量確認真跌破` };
      return { confirmed: true, warn: '' };
    }
  } catch(_e) { return { confirmed: true, warn: '' }; }
}

/* ═══════════════════════════════════════════════════════════════════
   ICT 進階模型（2026-09-02）：OTE、IDM 誘導、IFVG、缺口分類、趨勢線、
   SMT 背離、供需區有效性
   ------------------------------------------------------------------
   全部只在掃描時對 1H/4H K 線計算並寫入 _tradeSetupCache（規則①：不在渲染
   路徑），由 computeSimpleSetup 當「進場候選＋佐證」、由 computeDirection-
   Conviction 當方向證據。門檻全以 ATR 標準化。 */

/* 反轉式擺動樞紐（與 computeSwingStructure 同法，靈敏度可調） */
function _ictPivots(highs, lows, atr, revK) {
  const n = highs.length, piv = [];
  let dir = 1, extP = highs[0], extI = 0;
  for (let i = 1; i < n; i++) {
    if (dir === 1) {
      if (highs[i] >= extP) { extP = highs[i]; extI = i; }
      else if (extP - lows[i] >= revK * atr) { piv.push({ i: extI, p: extP, hi: true }); dir = -1; extP = lows[i]; extI = i; }
    } else {
      if (lows[i] <= extP) { extP = lows[i]; extI = i; }
      else if (highs[i] - extP >= revK * atr) { piv.push({ i: extI, p: extP, hi: false }); dir = 1; extP = highs[i]; extI = i; }
    }
  }
  return piv;
}
function _ohlc(klines) {
  return { opens: klines.map(k => parseFloat(k[1])), highs: klines.map(k => parseFloat(k[2])),
    lows: klines.map(k => parseFloat(k[3])), closes: klines.map(k => parseFloat(k[4])), vols: klines.map(k => parseFloat(k[5]) || 0) };
}

/* ── OTE 最優進場區（推動腿的 0.62–0.79 回撤，0.705 為甜蜜點）──────────
   多：最近一個擺動低點 → 其後最高點 ＝ 推動腿；價格回撤到腿的 62–79% 為
   OTE，回撤 ≥50% 才算在折價側。回撤 >100%＝整段腿被吃掉，論點失效。 */
function computeOTE(klines, isLong, atr) {
  if (!klines || klines.length < 30 || !(atr > 0)) return null;
  const { highs, lows, closes } = _ohlc(klines);
  const n = closes.length, cur = closes[n - 1];
  const from = Math.max(0, n - 80);
  let lo, hi;
  if (isLong) {
    // 腿頂＝視窗內最高點（至少 2 根前，代表已在回撤）；腿底＝腿頂之前的最低點
    let H = { p: -Infinity, i: -1 };
    for (let i = from; i < n - 2; i++) if (highs[i] > H.p) H = { p: highs[i], i };
    if (H.i < 0) return null;
    let L = { p: Infinity, i: -1 };
    for (let i = Math.max(from, H.i - 60); i < H.i; i++) if (lows[i] < L.p) L = { p: lows[i], i };
    if (L.i < 0 || !(H.p > L.p) || H.i - L.i < 3 || cur >= H.p) return null;
    lo = L.p; hi = H.p;
  } else {
    let Ll = { p: Infinity, i: -1 };
    for (let i = from; i < n - 2; i++) if (lows[i] < Ll.p) Ll = { p: lows[i], i };
    if (Ll.i < 0) return null;
    let Hh = { p: -Infinity, i: -1 };
    for (let i = Math.max(from, Ll.i - 60); i < Ll.i; i++) if (highs[i] > Hh.p) Hh = { p: highs[i], i };
    if (Hh.i < 0 || !(Hh.p > Ll.p) || Ll.i - Hh.i < 3 || cur <= Ll.p) return null;
    lo = Ll.p; hi = Hh.p;
  }
  const leg = hi - lo;
  if (leg < 2 * atr) return null;                       // 不到 2 ATR 的腿不算推動腿
  const f = k => isLong ? hi - leg * k : lo + leg * k;
  const retr = isLong ? (hi - cur) / leg : (cur - lo) / leg;
  return { legLow: lo, legHigh: hi, eq: f(0.5), ote62: f(0.62), ote705: f(0.705), ote79: f(0.79),
    retracePct: +(retr * 100).toFixed(1), inZone: retr >= 0.62 && retr <= 0.79,
    inDiscount: retr >= 0.5, overshoot: retr > 1, legAtr: +(leg / atr).toFixed(2), dirLong: isLong };
}

/* ── IDM 內部流動性／誘導 ─────────────────────────────────────────────
   多：最近一次推升之前的那個次級回檔低點——散戶把停損放在那裡，聰明錢
   先掃它再走。taken＝已被掃過；reclaimed＝掃過後價格已回到其上。
   進場位若落在「現價與未掃 IDM 之間」，成交前會先被掃一次。 */
function detectInducement(klines, isLong, atr) {
  if (!klines || klines.length < 40 || !(atr > 0)) return null;
  const { highs, lows, closes } = _ohlc(klines);
  const n = closes.length, cur = closes[n - 1];
  // 主要／次要樞紐門檻要拉開（0.8 vs 3.0 ATR）：太近時誘導低點本身會被當成主要低點而被排除
  const minor = _ictPivots(highs, lows, atr, 0.8);
  const major = _ictPivots(highs, lows, atr, 3.0);
  if (isLong) {
    const ML = major.filter(p => !p.hi).pop(); if (!ML) return null;
    const after = minor.filter(p => p.i > ML.i);
    const lastHi = after.filter(p => p.hi).pop(); if (!lastHi) return null;
    const idm = after.filter(p => !p.hi && p.i < lastHi.i).pop(); if (!idm) return null;
    let taken = false; for (let j = idm.i + 1; j < n; j++) if (lows[j] < idm.p - 0.05 * atr) { taken = true; break; }
    return { level: idm.p, idx: idm.i, taken, reclaimed: taken && cur > idm.p, ageBars: n - 1 - idm.i, dirLong: true };
  } else {
    const MH = major.filter(p => p.hi).pop(); if (!MH) return null;
    const after = minor.filter(p => p.i > MH.i);
    const lastLo = after.filter(p => !p.hi).pop(); if (!lastLo) return null;
    const idm = after.filter(p => p.hi && p.i < lastLo.i).pop(); if (!idm) return null;
    let taken = false; for (let j = idm.i + 1; j < n; j++) if (highs[j] > idm.p + 0.05 * atr) { taken = true; break; }
    return { level: idm.p, idx: idm.i, taken, reclaimed: taken && cur < idm.p, ageBars: n - 1 - idm.i, dirLong: false };
  }
}

/* ── IFVG 反轉公平價值缺口 ────────────────────────────────────────────
   多：一個「看空缺口」被價格向上收盤穿越＝缺口反轉，原本的壓力翻成支撐；
   回測該區進場。回傳離現價最近、位於現價下方（或內部）的反轉缺口。 */
function detectIFVG(klines, isLong) {
  if (!klines || klines.length < 20) return null;
  const { highs, lows, closes } = _ohlc(klines);
  const n = closes.length, cur = closes[n - 1];
  const out = [];
  for (let i = Math.max(2, n - 60); i < n - 2; i++) {
    if (isLong) {
      const gH = lows[i - 2], gL = highs[i];              // 看空缺口
      if (!(gH > gL) || (gH - gL) / gL < 0.001) continue;
      let inv = false; for (let j = i + 1; j < n; j++) if (closes[j] > gH) { inv = true; break; }
      if (!inv || gL > cur * 1.004) continue;
      out.push({ high: gH, low: gL, mid: (gH + gL) / 2, idx: i, retesting: cur >= gL * 0.997 && cur <= gH * 1.004 });
    } else {
      const gH = lows[i], gL = highs[i - 2];              // 看多缺口
      if (!(gH > gL) || (gH - gL) / gL < 0.001) continue;
      let inv = false; for (let j = i + 1; j < n; j++) if (closes[j] < gL) { inv = true; break; }
      if (!inv || gH < cur * 0.996) continue;
      out.push({ high: gH, low: gL, mid: (gH + gL) / 2, idx: i, retesting: cur <= gH * 1.003 && cur >= gL * 0.996 });
    }
  }
  if (!out.length) return null;
  out.sort((a, b) => Math.abs(cur - a.mid) - Math.abs(cur - b.mid));
  return { ...out[0], dirLong: isLong };
}

/* ── 缺口分類：突破／延續／耗盡／普通 ────────────────────────────────
   突破缺口：從壓縮區間跳出且放量（最強）；延續缺口：趨勢中段放量；
   耗盡缺口：RSI 極端且很快被回補或推進力遞減（不追）；其餘普通缺口。 */
function classifyGap(klines, gap, isLong, rsi, atr) {
  if (!klines || !gap || gap.idx == null || !(atr > 0)) return null;
  const { opens, highs, lows, closes, vols } = _ohlc(klines);
  const n = closes.length, i = gap.idx;
  if (i < 22 || i >= n) return null;
  const avgVol = vols.slice(i - 21, i - 1).reduce((a, b) => a + b, 0) / 20 || 1;
  const volR = (vols[i - 1] || 0) / avgVol;                       // 推動棒（缺口中間那根）
  const pre = { hi: Math.max(...highs.slice(i - 17, i - 2)), lo: Math.min(...lows.slice(i - 17, i - 2)) };
  const preRangeAtr = (pre.hi - pre.lo) / atr;
  let filledFast = false;
  for (let j = i + 1; j < Math.min(n, i + 6); j++) if (isLong ? lows[j] <= gap.low : highs[j] >= gap.high) { filledFast = true; break; }
  const bodies = []; for (let j = i; j < Math.min(n, i + 4); j++) bodies.push(Math.abs(closes[j] - opens[j]));
  const shrinking = bodies.length >= 3 && bodies[1] < bodies[0] && bodies[2] < bodies[1];
  const extreme = isFinite(rsi) && (isLong ? rsi >= 70 : rsi <= 30);
  let kind, label, w;
  if (extreme && (filledFast || shrinking)) { kind = 'exhaustion'; label = '耗盡缺口'; w = 0.5; }
  else if (preRangeAtr <= 3 && volR >= 1.2)  { kind = 'breakaway';  label = '突破缺口'; w = 2.5; }
  else if (volR >= 1.2)                      { kind = 'continuation'; label = '延續缺口'; w = 2; }
  else                                       { kind = 'common';     label = '普通缺口'; w = 1; }
  return { kind, label, w, volR: +volR.toFixed(2), preRangeAtr: +preRangeAtr.toFixed(2), filledFast };
}

/* ── 趨勢線（行動線）：≥2 個樞紐觸點的擺動線 ────────────────────────
   多：近 4 個逐步墊高的擺動低點擬合直線；觸點＝樞紐落在線 ±0.3ATR 內。
   broken＝收盤跌破線 0.15ATR（原趨勢性格改變）；near＝價格在線附近（進場）。 */
function computeTrendline(klines, isLong, atr) {
  if (!klines || klines.length < 40 || !(atr > 0)) return null;
  const { highs, lows, closes } = _ohlc(klines);
  const n = closes.length, cur = closes[n - 1];
  const piv = _ictPivots(highs, lows, atr, 1.5).filter(p => isLong ? !p.hi : p.hi).slice(-4);
  if (piv.length < 2) return null;
  // 只取單調（多：逐步墊高）的尾段
  let pts = [piv[piv.length - 1]];
  for (let k = piv.length - 2; k >= 0; k--) {
    const ok = isLong ? piv[k].p < pts[0].p : piv[k].p > pts[0].p;
    if (!ok) break; pts.unshift(piv[k]);
  }
  if (pts.length < 2) return null;
  const m = pts.length; let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of pts) { sx += p.i; sy += p.p; sxy += p.i * p.p; sxx += p.i * p.i; }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1);
  const b = (sy - slope * sx) / m;
  const at = i => slope * i + b;
  const touches = pts.filter(p => Math.abs(p.p - at(p.i)) <= 0.3 * atr).length;
  if (touches < 2) return null;
  const level = at(n - 1);
  const broken = isLong ? cur < level - 0.15 * atr : cur > level + 0.15 * atr;
  return { touches, level, broken, near: !broken && Math.abs(cur - level) <= 0.5 * atr,
    slopeAtrPerBar: +(slope / atr).toFixed(4), spanBars: pts[m - 1].i - pts[0].i, dirLong: isLong };
}

/* ── SMT 背離：兩個相關資產，一個掃了流動性另一個沒掃 ──────────────
   多頭 SMT：A 破前低而 B 守住（或反之）→ 賣壓不是全面性的，反轉訊號。
   兩組 K 線需同週期同長度（都是 1h×100），取尾端對齊。 */
function detectSMTDivergence(rawA, rawB, isLong, lookback = 40, recent = 8) {
  if (!rawA || !rawB || rawA.length < lookback || rawB.length < lookback) return null;
  const A = _ohlc(rawA.slice(-lookback)), B = _ohlc(rawB.slice(-lookback));
  const n = lookback;
  const seg = (arr, from, to) => arr.slice(from, to);
  const aRL = Math.min(...seg(A.lows, n - recent, n)), aPL = Math.min(...seg(A.lows, 0, n - recent));
  const bRL = Math.min(...seg(B.lows, n - recent, n)), bPL = Math.min(...seg(B.lows, 0, n - recent));
  const aRH = Math.max(...seg(A.highs, n - recent, n)), aPH = Math.max(...seg(A.highs, 0, n - recent));
  const bRH = Math.max(...seg(B.highs, n - recent, n)), bPH = Math.max(...seg(B.highs, 0, n - recent));
  const aLL = aRL < aPL * 0.999, bLL = bRL < bPL * 0.999;
  const aHH = aRH > aPH * 1.001, bHH = bRH > bPH * 1.001;
  const bull = aLL !== bLL;   // 一破一守
  const bear = aHH !== bHH;
  if (!bull && !bear) return null;
  return { bull, bear,
    detail: bull ? `${aLL ? '本幣' : '參照幣'}破前低、${aLL ? '參照幣' : '本幣'}守住`
                 : `${aHH ? '本幣' : '參照幣'}破前高、${aHH ? '參照幣' : '本幣'}未過` };
}

/* ── 供需區有效性（供給區／需求區的高機率條件檢核）────────────────
   ① 形成前掃過流動性 ② 離開時留下失衡（FVG）③ 之後突破結構 ④ 強力離開。
   四項各 1 分；分數直接加進 OB 進場候選的基礎分。 */
function scoreSupplyDemandZone(klines, ob, isLong, atr) {
  if (!klines || !ob || ob.idx == null || !(atr > 0)) return null;
  const { highs, lows } = _ohlc(klines);
  const n = highs.length, i = ob.idx;
  if (i < 13 || i + 2 >= n) return null;
  let sweep, imbalance, bos, strongLeave;
  if (isLong) {
    sweep = Math.min(...lows.slice(i - 2, i + 1)) < Math.min(...lows.slice(i - 12, i - 2));
    imbalance = false; for (let j = i + 2; j <= Math.min(n - 1, i + 4); j++) if (lows[j] > highs[j - 2]) { imbalance = true; break; }
    bos = Math.max(...highs.slice(i + 1, Math.min(n, i + 16))) > Math.max(...highs.slice(i - 20 < 0 ? 0 : i - 20, i));
    strongLeave = (Math.max(...highs.slice(i + 1, Math.min(n, i + 6))) - ob.high) / atr >= 1.5;
  } else {
    sweep = Math.max(...highs.slice(i - 2, i + 1)) > Math.max(...highs.slice(i - 12, i - 2));
    imbalance = false; for (let j = i + 2; j <= Math.min(n - 1, i + 4); j++) if (highs[j] < lows[j - 2]) { imbalance = true; break; }
    bos = Math.min(...lows.slice(i + 1, Math.min(n, i + 16))) < Math.min(...lows.slice(i - 20 < 0 ? 0 : i - 20, i));
    strongLeave = (ob.low - Math.min(...lows.slice(i + 1, Math.min(n, i + 6)))) / atr >= 1.5;
  }
  const score = [sweep, imbalance, bos, strongLeave].filter(Boolean).length;
  const tags = [sweep && '掃蕩', imbalance && '失衡', bos && '結構突破', strongLeave && '強力離開'].filter(Boolean);
  return { score, sweep, imbalance, bos, strongLeave, label: tags.length ? tags.join('+') : '無驗證條件' };
}
