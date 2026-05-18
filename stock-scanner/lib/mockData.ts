import type { HistoricalBar, ScannedStock } from "@/types/stock";

function randBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

export function generateMockHistory(basePrice: number, days = 65): HistoricalBar[] {
  const bars: HistoricalBar[] = [];
  let price = basePrice;
  const now = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const change = price * randBetween(-0.03, 0.035);
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * randBetween(1, 1.02);
    const low = Math.min(open, close) * randBetween(0.98, 1);
    const volume = Math.floor(randBetween(5_000_000, 30_000_000));
    bars.push({
      date: d.toISOString().split("T")[0],
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });
    price = close;
  }
  return bars;
}

export const MOCK_STOCKS: ScannedStock[] = [
  {
    symbol: "2330.TW", name: "台積電", price: 870.0, change: 12.0, changePercent: 1.4,
    volume: 28_500_000, market: "TW", score: 85,
    indicators: { rsi: 58.3, macd: 2.1, macdSignal: 1.8, macdHistogram: 0.3, ma5: 862, ma20: 845, ma60: 810, bollingerUpper: 895, bollingerMiddle: 850, bollingerLower: 805, avgVolume5: 18_000_000, currentVolume: 28_500_000 },
    passedIndicators: [
      { key: "rsi", label: "RSI健康", value: "RSI 58.3" },
      { key: "macd", label: "MACD金叉", value: "柱狀 0.300" },
      { key: "ma", label: "均線多頭", value: "MA5>MA20>MA60" },
      { key: "volume", label: "量能放大", value: "1.6倍" },
      { key: "bollinger", label: "布林中線上", value: "中線 850.00" },
    ],
    scannedAt: new Date().toISOString(),
  },
  {
    symbol: "2454.TW", name: "聯發科", price: 1285.0, change: 25.0, changePercent: 2.0,
    volume: 12_300_000, market: "TW", score: 80,
    indicators: { rsi: 62.1, macd: 5.4, macdSignal: 4.9, macdHistogram: 0.5, ma5: 1270, ma20: 1240, ma60: 1190, bollingerUpper: 1320, bollingerMiddle: 1250, bollingerLower: 1180, avgVolume5: 7_500_000, currentVolume: 12_300_000 },
    passedIndicators: [
      { key: "rsi", label: "RSI健康", value: "RSI 62.1" },
      { key: "macd", label: "MACD金叉", value: "柱狀 0.500" },
      { key: "ma", label: "均線多頭", value: "MA5>MA20>MA60" },
      { key: "volume", label: "量能放大", value: "1.6倍" },
      { key: "bollinger", label: "布林中線上", value: "中線 1250.00" },
    ],
    scannedAt: new Date().toISOString(),
  },
  {
    symbol: "NVDA", name: "NVIDIA", price: 875.4, change: 18.6, changePercent: 2.17,
    volume: 45_000_000, market: "US", score: 90,
    indicators: { rsi: 65.0, macd: 8.2, macdSignal: 7.1, macdHistogram: 1.1, ma5: 860, ma20: 830, ma60: 780, bollingerUpper: 920, bollingerMiddle: 840, bollingerLower: 760, avgVolume5: 28_000_000, currentVolume: 45_000_000 },
    passedIndicators: [
      { key: "rsi", label: "RSI健康", value: "RSI 65.0" },
      { key: "macd", label: "MACD金叉", value: "柱狀 1.100" },
      { key: "ma", label: "均線多頭", value: "MA5>MA20>MA60" },
      { key: "volume", label: "量能放大", value: "1.6倍" },
      { key: "bollinger", label: "布林中線上", value: "中線 840.00" },
    ],
    scannedAt: new Date().toISOString(),
  },
  {
    symbol: "AAPL", name: "Apple", price: 213.5, change: 3.2, changePercent: 1.52,
    volume: 62_000_000, market: "US", score: 75,
    indicators: { rsi: 55.4, macd: 1.2, macdSignal: 0.9, macdHistogram: 0.3, ma5: 211, ma20: 205, ma60: 195, bollingerUpper: 225, bollingerMiddle: 207, bollingerLower: 189, avgVolume5: 40_000_000, currentVolume: 62_000_000 },
    passedIndicators: [
      { key: "rsi", label: "RSI健康", value: "RSI 55.4" },
      { key: "macd", label: "MACD金叉", value: "柱狀 0.300" },
      { key: "ma", label: "均線多頭", value: "MA5>MA20>MA60" },
      { key: "volume", label: "量能放大", value: "1.6倍" },
      { key: "bollinger", label: "布林中線上", value: "中線 207.00" },
    ],
    scannedAt: new Date().toISOString(),
  },
  {
    symbol: "2382.TW", name: "廣達", price: 298.5, change: 5.5, changePercent: 1.88,
    volume: 18_000_000, market: "TW", score: 70,
    indicators: { rsi: 59.7, macd: 1.5, macdSignal: 1.2, macdHistogram: 0.3, ma5: 294, ma20: 285, ma60: 270, bollingerUpper: 315, bollingerMiddle: 288, bollingerLower: 261, avgVolume5: 11_000_000, currentVolume: 18_000_000 },
    passedIndicators: [
      { key: "rsi", label: "RSI健康", value: "RSI 59.7" },
      { key: "macd", label: "MACD金叉", value: "柱狀 0.300" },
      { key: "ma", label: "均線多頭", value: "MA5>MA20>MA60" },
      { key: "volume", label: "量能放大", value: "1.6倍" },
    ],
    scannedAt: new Date().toISOString(),
  },
  {
    symbol: "MSFT", name: "Microsoft", price: 415.2, change: -2.1, changePercent: -0.5,
    volume: 22_000_000, market: "US", score: 60,
    indicators: { rsi: 48.2, macd: 0.5, macdSignal: 0.3, macdHistogram: 0.2, ma5: 417, ma20: 410, ma60: 395, bollingerUpper: 435, bollingerMiddle: 412, bollingerLower: 389, avgVolume5: 20_000_000, currentVolume: 22_000_000 },
    passedIndicators: [
      { key: "rsi", label: "RSI健康", value: "RSI 48.2" },
      { key: "macd", label: "MACD金叉", value: "柱狀 0.200" },
      { key: "bollinger", label: "布林中線上", value: "中線 412.00" },
    ],
    scannedAt: new Date().toISOString(),
  },
];
