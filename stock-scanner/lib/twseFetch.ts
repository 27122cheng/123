import type { HistoricalBar } from "@/types/stock";

// Taiwan Stock Exchange (TWSE) Open Data API — completely public, no auth needed
// Docs: https://openapi.twse.com.tw/
const TWSE_OPEN = "https://openapi.twse.com.tw/v1";

// TWSE exchange report for daily historical data (per stock per month)
const TWSE_EXCHANGE = "https://www.twse.com.tw/exchangeReport";

// Taipei Exchange (TPEx) for OTC stocks
const TPEX_OPEN = "https://www.tpex.org.tw/openapi/v1";

export interface TWQuote {
  code: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  open: number;
  high: number;
  low: number;
}

// In-memory cache for the whole-market snapshot (refreshes every 5 min)
const cache = {
  data: null as TWQuote[] | null,
  ts: 0,
};

function parseTWNumber(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

/**
 * Fetch all listed stocks' latest quote from TWSE Open API.
 * Returns a map from stock code → TWQuote.
 */
export async function getAllTWSEQuotes(): Promise<Map<string, TWQuote>> {
  const map = new Map<string, TWQuote>();

  // Use cache if fresh
  if (cache.data && Date.now() - cache.ts < 5 * 60_000) {
    cache.data.forEach((q) => map.set(q.code, q));
    return map;
  }

  try {
    const res = await fetch(`${TWSE_OPEN}/exchangeReport/STOCK_DAY_ALL`, {
      next: { revalidate: 300 },
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return map;

    // TWSE returns array of objects
    const raw: {
      Code: string;
      Name: string;
      ClosingPrice: string;
      Change: string;
      TradeVolume: string;
      OpeningPrice: string;
      HighestPrice: string;
      LowestPrice: string;
    }[] = await res.json();

    const quotes: TWQuote[] = raw
      .map((item) => {
        const price = parseTWNumber(item.ClosingPrice);
        const change = parseTWNumber(item.Change);
        const prevClose = price - change;
        const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
        return {
          code: item.Code,
          name: item.Name,
          price,
          change,
          changePercent,
          volume: parseTWNumber(item.TradeVolume) * 1000, // unit: thousand shares → shares
          open: parseTWNumber(item.OpeningPrice),
          high: parseTWNumber(item.HighestPrice),
          low: parseTWNumber(item.LowestPrice),
        };
      })
      .filter((q) => q.price > 0);

    cache.data = quotes;
    cache.ts = Date.now();
    quotes.forEach((q) => map.set(q.code, q));
  } catch {
    // Network error or API unavailable — return empty map, caller will fall back
  }

  return map;
}

/**
 * Fetch one Taiwan stock's latest quote.
 * symbol format: "2330.TW"
 */
export async function fetchTWSEQuote(symbol: string): Promise<TWQuote | null> {
  const code = symbol.replace(/\.(TW|TWO)$/, "");
  const allQuotes = await getAllTWSEQuotes();
  return allQuotes.get(code) ?? null;
}

/**
 * Fetch one month of daily OHLCV from TWSE exchangeReport.
 * date: "YYYYMMDD" (any day in that month)
 */
async function fetchTWSEMonthHistory(code: string, yyyymmdd: string): Promise<HistoricalBar[]> {
  try {
    const url = `${TWSE_EXCHANGE}/STOCK_DAY?response=json&stockNo=${code}&date=${yyyymmdd}`;
    const res = await fetch(url, {
      next: { revalidate: 3600 },
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];

    const data = await res.json();
    // data.data is array of: [日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數]
    if (!Array.isArray(data?.data)) return [];

    return data.data
      .map((row: string[]) => {
        // Date format: "113/01/02" (ROC calendar, year - 1911 = CE)
        const [rocDate] = row;
        const parts = rocDate.split("/");
        const year = parseInt(parts[0]) + 1911;
        const month = parts[1].padStart(2, "0");
        const day = parts[2].padStart(2, "0");

        return {
          date: `${year}-${month}-${day}`,
          open: parseTWNumber(row[3]),
          high: parseTWNumber(row[4]),
          low: parseTWNumber(row[5]),
          close: parseTWNumber(row[6]),
          volume: parseTWNumber(row[1]),
        };
      })
      .filter((b: HistoricalBar) => b.close > 0);
  } catch {
    return [];
  }
}

/**
 * Fetch ~90 days of daily history for a Taiwan stock from TWSE.
 * symbol format: "2330.TW"
 */
export async function fetchTWSEHistory(symbol: string): Promise<HistoricalBar[] | null> {
  const code = symbol.replace(/\.(TW|TWO)$/, "");
  const now = new Date();

  // Fetch this month and previous 2 months
  const monthDates: string[] = [];
  for (let m = 0; m < 3; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    monthDates.push(
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}01`
    );
  }

  const monthResults = await Promise.all(
    monthDates.map((date) => fetchTWSEMonthHistory(code, date))
  );

  const bars = monthResults
    .flat()
    .sort((a, b) => a.date.localeCompare(b.date));

  return bars.length >= 10 ? bars : null;
}

/**
 * Fetch TPEx (OTC) stock history — placeholder for future extension.
 */
export async function fetchTPExHistory(_symbol: string): Promise<HistoricalBar[] | null> {
  // TPEx uses a different endpoint format
  // Not implemented yet — returns null to trigger fallback
  return null;
}
