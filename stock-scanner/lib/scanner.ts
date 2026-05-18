import type { ScannedStock, HistoricalBar } from "@/types/stock";
import type { StockInfo } from "./stockList";
import { calcIndicators, scoreStock } from "./indicators";
import { generateMockHistory } from "./mockData";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YF = any;

async function getYF(): Promise<YF | null> {
  try {
    const mod = await import("yahoo-finance2");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function fetchHistory(symbol: string): Promise<HistoricalBar[] | null> {
  try {
    const yf = await getYF();
    if (!yf) return null;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 90);
    const result = await yf.historical(symbol, {
      period1: startDate.toISOString().split("T")[0],
      period2: endDate.toISOString().split("T")[0],
      interval: "1d",
    });
    return result.map((r: YF) => ({
      date: (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().split("T")[0],
      open: r.open ?? r.close,
      high: r.high ?? r.close,
      low: r.low ?? r.close,
      close: r.close,
      volume: r.volume ?? 0,
    }));
  } catch {
    return null;
  }
}

async function fetchQuote(symbol: string): Promise<{ price: number; change: number; changePercent: number; volume: number } | null> {
  try {
    const yf = await getYF();
    if (!yf) return null;
    const q = await yf.quote(symbol);
    return {
      price: q.regularMarketPrice ?? 0,
      change: q.regularMarketChange ?? 0,
      changePercent: q.regularMarketChangePercent ?? 0,
      volume: q.regularMarketVolume ?? 0,
    };
  } catch {
    return null;
  }
}

export async function scanStock(info: StockInfo): Promise<ScannedStock | null> {
  const bars = (await fetchHistory(info.symbol)) ?? generateMockHistory(
    info.market === "TW" ? Math.floor(Math.random() * 900 + 100) : Math.floor(Math.random() * 400 + 50)
  );

  if (bars.length < 30) return null;

  const quote = await fetchQuote(info.symbol);
  const lastBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];
  const price = quote?.price ?? lastBar.close;
  const change = quote?.change ?? (prevBar ? price - prevBar.close : 0);
  const changePercent = quote?.changePercent ?? (prevBar ? (change / prevBar.close) * 100 : 0);
  const volume = quote?.volume ?? lastBar.volume;

  const ind = calcIndicators(bars);
  ind.currentVolume = volume;

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
  };
}
