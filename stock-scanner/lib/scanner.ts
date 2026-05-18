import type { ScannedStock, HistoricalBar } from "@/types/stock";
import type { StockInfo } from "./stockList";
import { calcIndicators, scoreStock } from "./indicators";
import { generateMockHistory } from "./mockData";
import { fetchYFHistory, fetchYFQuote } from "./yahooFetch";
import { fetchTWSEHistory, fetchTWSEQuote } from "./twseFetch";

export type DataSource = "yahoo" | "twse" | "mock";

export interface ScanStockResult extends ScannedStock {
  dataSource: DataSource;
}

/**
 * Fetch historical OHLCV bars.
 * Strategy:
 *  - Taiwan stocks: TWSE exchange report (official, no auth) → fallback Yahoo Finance
 *  - US stocks: Yahoo Finance chart API
 */
async function fetchHistory(info: StockInfo): Promise<{ bars: HistoricalBar[]; source: DataSource }> {
  if (info.market === "TW") {
    const twse = await fetchTWSEHistory(info.symbol);
    if (twse && twse.length >= 20) return { bars: twse, source: "twse" };
  }

  const yf = await fetchYFHistory(info.symbol, "3mo");
  if (yf && yf.length >= 20) return { bars: yf, source: "yahoo" };

  // Last resort — deterministic mock seeded by symbol name
  const seed = info.symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const basePrice =
    info.market === "TW"
      ? 50 + (seed % 950)      // TWD: 50~1000
      : 20 + (seed % 480);     // USD: 20~500
  return { bars: generateMockHistory(basePrice), source: "mock" };
}

/**
 * Fetch current quote (price, change, volume).
 * Strategy:
 *  - Taiwan stocks: TWSE Open API → fallback Yahoo Finance
 *  - US stocks: Yahoo Finance
 */
async function fetchQuote(info: StockInfo) {
  if (info.market === "TW") {
    const twse = await fetchTWSEQuote(info.symbol);
    if (twse && twse.price > 0) return twse;
  }
  const yf = await fetchYFQuote(info.symbol);
  if (yf && yf.price > 0) return yf;
  return null;
}

/**
 * Scan a single stock: fetch data → calculate indicators → score.
 */
export async function scanStock(info: StockInfo): Promise<ScanStockResult | null> {
  const [{ bars, source }, quote] = await Promise.all([
    fetchHistory(info),
    fetchQuote(info),
  ]);

  if (bars.length < 20) return null;

  const lastBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];

  const price = quote?.price ?? lastBar.close;
  const change = quote?.change ?? (prevBar ? price - prevBar.close : 0);
  const changePercent =
    quote?.changePercent ?? (prevBar && prevBar.close > 0 ? (change / prevBar.close) * 100 : 0);
  const volume = quote?.volume ?? lastBar.volume;

  // If we got live quote, update the last bar's close for indicator calc
  const barsForCalc =
    quote?.price
      ? [...bars.slice(0, -1), { ...lastBar, close: price, volume }]
      : bars;

  const ind = calcIndicators(barsForCalc);

  const { score, passed } = scoreStock(ind, price);

  return {
    symbol: info.symbol,
    name: info.name,
    price,
    change,
    changePercent,
    volume,
    market: info.market,
    score,
    indicators: ind,
    passedIndicators: passed,
    scannedAt: new Date().toISOString(),
    dataSource: source,
  };
}

/**
 * Scan a list of stocks with concurrency limit to avoid rate limiting.
 */
export async function scanAll(
  list: StockInfo[],
  concurrency = 5
): Promise<ScanStockResult[]> {
  const results: ScanStockResult[] = [];

  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(scanStock));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }
    // Polite delay between batches
    if (i + concurrency < list.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  return results;
}
