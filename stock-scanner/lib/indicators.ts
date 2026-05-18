import type { TechnicalIndicators, PassedIndicator, HistoricalBar } from "@/types/stock";

export function calcSMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calcEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) {
      ema.push(prices[0]);
    } else {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }
  }
  return ema;
}

export function calcRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  const recent = changes.slice(-period);
  const gains = recent.filter((c) => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = recent.filter((c) => c < 0).map((c) => Math.abs(c)).reduce((a, b) => a + b, 0) / period;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function calcMACD(prices: number[]): { macd: number; signal: number; histogram: number } {
  if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine.slice(-9), 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];
  return { macd, signal, histogram: macd - signal };
}

export function calcBollinger(prices: number[], period = 20): { upper: number; middle: number; lower: number } {
  if (prices.length < period) {
    const last = prices[prices.length - 1] || 0;
    return { upper: last * 1.05, middle: last, lower: last * 0.95 };
  }
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
}

export function calcIndicators(bars: HistoricalBar[]): TechnicalIndicators {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);

  const rsi = calcRSI(closes);
  const { macd, signal, histogram } = calcMACD(closes);
  const ma5 = calcSMA(closes, 5);
  const ma20 = calcSMA(closes, 20);
  const ma60 = calcSMA(closes, 60);
  const { upper, middle, lower } = calcBollinger(closes);
  const avgVol5 = calcSMA(volumes, 5);
  const currentVolume = volumes[volumes.length - 1] || 0;

  return {
    rsi,
    macd,
    macdSignal: signal,
    macdHistogram: histogram,
    ma5,
    ma20,
    ma60,
    bollingerUpper: upper,
    bollingerMiddle: middle,
    bollingerLower: lower,
    avgVolume5: avgVol5,
    currentVolume,
  };
}

export function scoreStock(ind: TechnicalIndicators, currentPrice: number): { score: number; passed: PassedIndicator[] } {
  const passed: PassedIndicator[] = [];
  let score = 0;

  // RSI 30~70 健康區間
  if (ind.rsi >= 30 && ind.rsi <= 70) {
    score += 20;
    passed.push({ key: "rsi", label: "RSI健康", value: `RSI ${ind.rsi.toFixed(1)}` });
  } else if (ind.rsi < 30) {
    score += 10;
    passed.push({ key: "rsi_oversold", label: "RSI超賣", value: `RSI ${ind.rsi.toFixed(1)}` });
  }

  // MACD 金叉
  if (ind.macd > ind.macdSignal && ind.macdHistogram > 0) {
    score += 25;
    passed.push({ key: "macd", label: "MACD金叉", value: `柱狀 ${ind.macdHistogram.toFixed(3)}` });
  }

  // 均線多頭排列
  if (ind.ma5 > 0 && ind.ma20 > 0 && ind.ma60 > 0 && ind.ma5 > ind.ma20 && ind.ma20 > ind.ma60) {
    score += 25;
    passed.push({ key: "ma", label: "均線多頭", value: `MA5>MA20>MA60` });
  }

  // 成交量放大
  if (ind.avgVolume5 > 0 && ind.currentVolume >= ind.avgVolume5 * 1.5) {
    score += 15;
    passed.push({ key: "volume", label: "量能放大", value: `${(ind.currentVolume / ind.avgVolume5).toFixed(1)}倍` });
  }

  // 布林中線以上
  if (ind.bollingerMiddle > 0 && currentPrice >= ind.bollingerMiddle) {
    score += 15;
    passed.push({ key: "bollinger", label: "布林中線上", value: `中線 ${ind.bollingerMiddle.toFixed(2)}` });
  }

  return { score: Math.min(score, 100), passed };
}
