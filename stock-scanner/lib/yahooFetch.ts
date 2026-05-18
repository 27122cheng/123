import type { HistoricalBar } from "@/types/stock";

const BASE_URLS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8",
  "Cache-Control": "no-cache",
};

async function yfFetch(path: string): Promise<Response | null> {
  for (const base of BASE_URLS) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: FETCH_HEADERS,
        next: { revalidate: 300 },
      });
      if (res.ok) return res;
    } catch {
      // try next base
    }
  }
  return null;
}

export interface YFQuote {
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  shortName: string;
}

/**
 * Fetch daily OHLCV history from Yahoo Finance public chart API.
 * No API key required. Works from server-side environments (Vercel, etc.)
 */
export async function fetchYFHistory(
  symbol: string,
  range: "1mo" | "3mo" | "6mo" = "3mo"
): Promise<HistoricalBar[] | null> {
  try {
    const res = await yfFetch(
      `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includePrePost=false`
    );
    if (!res) return null;

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};

    const bars: HistoricalBar[] = timestamps
      .map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().split("T")[0],
        open: q.open?.[i] ?? 0,
        high: q.high?.[i] ?? 0,
        low: q.low?.[i] ?? 0,
        close: q.close?.[i] ?? 0,
        volume: q.volume?.[i] ?? 0,
      }))
      .filter((b) => b.close > 0 && b.open > 0);

    return bars.length >= 5 ? bars : null;
  } catch {
    return null;
  }
}

/**
 * Fetch current quote (price, change, volume) from Yahoo Finance chart meta.
 */
export async function fetchYFQuote(symbol: string): Promise<YFQuote | null> {
  try {
    const res = await yfFetch(
      `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
    );
    if (!res) return null;

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price: number = meta.regularMarketPrice ?? 0;
    const prevClose: number = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = price - prevClose;
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return {
      price,
      previousClose: prevClose,
      change,
      changePercent,
      volume: meta.regularMarketVolume ?? 0,
      shortName: meta.shortName ?? symbol,
    };
  } catch {
    return null;
  }
}

/**
 * Batch fetch quotes for multiple symbols.
 * Yahoo Finance v7 quoteSummary allows comma-separated symbols.
 */
export async function fetchYFBatchQuotes(
  symbols: string[]
): Promise<Map<string, YFQuote>> {
  const result = new Map<string, YFQuote>();

  // Process in batches of 10 to avoid rate limiting
  const batchSize = 10;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async (sym) => {
        const q = await fetchYFQuote(sym);
        if (q) result.set(sym, q);
      })
    );
    // Small delay between batches to be respectful to the API
    if (i + batchSize < symbols.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return result;
}
