export interface StockInfo {
  symbol: string;
  name: string;
  market: "TW" | "US";
}

export const TW_STOCKS: StockInfo[] = [
  { symbol: "2330.TW", name: "台積電", market: "TW" },
  { symbol: "2317.TW", name: "鴻海", market: "TW" },
  { symbol: "2454.TW", name: "聯發科", market: "TW" },
  { symbol: "2308.TW", name: "台達電", market: "TW" },
  { symbol: "2881.TW", name: "富邦金", market: "TW" },
  { symbol: "2882.TW", name: "國泰金", market: "TW" },
  { symbol: "2412.TW", name: "中華電", market: "TW" },
  { symbol: "2002.TW", name: "中鋼", market: "TW" },
  { symbol: "1301.TW", name: "台塑", market: "TW" },
  { symbol: "1303.TW", name: "南亞", market: "TW" },
  { symbol: "2886.TW", name: "兆豐金", market: "TW" },
  { symbol: "2891.TW", name: "中信金", market: "TW" },
  { symbol: "3711.TW", name: "日月光投控", market: "TW" },
  { symbol: "2303.TW", name: "聯電", market: "TW" },
  { symbol: "2345.TW", name: "智邦", market: "TW" },
  { symbol: "2379.TW", name: "瑞昱", market: "TW" },
  { symbol: "2395.TW", name: "研華", market: "TW" },
  { symbol: "2408.TW", name: "南亞科", market: "TW" },
  { symbol: "2357.TW", name: "華碩", market: "TW" },
  { symbol: "2382.TW", name: "廣達", market: "TW" },
  { symbol: "3034.TW", name: "聯詠", market: "TW" },
  { symbol: "2301.TW", name: "光寶科", market: "TW" },
  { symbol: "2327.TW", name: "國巨", market: "TW" },
  { symbol: "5871.TW", name: "中租-KY", market: "TW" },
  { symbol: "2207.TW", name: "和泰車", market: "TW" },
];

export const US_STOCKS: StockInfo[] = [
  { symbol: "AAPL", name: "Apple", market: "US" },
  { symbol: "MSFT", name: "Microsoft", market: "US" },
  { symbol: "GOOGL", name: "Alphabet", market: "US" },
  { symbol: "AMZN", name: "Amazon", market: "US" },
  { symbol: "NVDA", name: "NVIDIA", market: "US" },
  { symbol: "META", name: "Meta", market: "US" },
  { symbol: "TSLA", name: "Tesla", market: "US" },
  { symbol: "TSM", name: "TSMC ADR", market: "US" },
  { symbol: "AVGO", name: "Broadcom", market: "US" },
  { symbol: "JPM", name: "JPMorgan Chase", market: "US" },
  { symbol: "V", name: "Visa", market: "US" },
  { symbol: "JNJ", name: "Johnson & Johnson", market: "US" },
  { symbol: "WMT", name: "Walmart", market: "US" },
  { symbol: "MA", name: "Mastercard", market: "US" },
  { symbol: "PG", name: "Procter & Gamble", market: "US" },
  { symbol: "AMD", name: "AMD", market: "US" },
  { symbol: "INTC", name: "Intel", market: "US" },
  { symbol: "NFLX", name: "Netflix", market: "US" },
  { symbol: "DIS", name: "Disney", market: "US" },
  { symbol: "PYPL", name: "PayPal", market: "US" },
];

export function getStockList(market: "TW" | "US" | "ALL"): StockInfo[] {
  if (market === "TW") return TW_STOCKS;
  if (market === "US") return US_STOCKS;
  return [...TW_STOCKS, ...US_STOCKS];
}
