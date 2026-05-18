import { NextRequest, NextResponse } from "next/server";
import { MOCK_STOCKS, generateMockHistory } from "@/lib/mockData";
import { calcIndicators, scoreStock } from "@/lib/indicators";
import type { StockDetail, HistoricalBar } from "@/types/stock";

export const maxDuration = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YF = any;

async function getYahooFinance(): Promise<YF | null> {
  try {
    const mod = await import("yahoo-finance2");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, { params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toUpperCase();
  const useMock = req.nextUrl.searchParams.get("mock") === "1";

  let history: HistoricalBar[] | null = null;

  if (!useMock) {
    try {
      const yf = await getYahooFinance();
      if (yf) {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - 70);

        const raw = await yf.historical(symbol, {
          period1: startDate.toISOString().split("T")[0],
          period2: endDate.toISOString().split("T")[0],
          interval: "1d",
        });

        history = raw.map((r: YF) => ({
          date: (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().split("T")[0],
          open: r.open ?? r.close,
          high: r.high ?? r.close,
          low: r.low ?? r.close,
          close: r.close,
          volume: r.volume ?? 0,
        }));
      }
    } catch {
      history = null;
    }
  }

  const mockBase = MOCK_STOCKS.find((s) => s.symbol === symbol);

  if (!history || history.length < 10) {
    const basePrice = mockBase?.price ?? 100;
    history = generateMockHistory(basePrice);
  }

  const lastBar = history[history.length - 1];
  const prevBar = history[history.length - 2];
  const ind = calcIndicators(history);
  const price = lastBar.close;
  const change = prevBar ? price - prevBar.close : 0;
  const changePercent = prevBar ? (change / prevBar.close) * 100 : 0;

  const { score, passed } = scoreStock(ind, price);

  const detail: StockDetail = {
    symbol,
    name: mockBase?.name ?? symbol,
    price,
    change,
    changePercent,
    volume: lastBar.volume,
    market: symbol.endsWith(".TW") ? "TW" : "US",
    score,
    indicators: ind,
    passedIndicators: passed,
    scannedAt: new Date().toISOString(),
    history,
  };

  return NextResponse.json(detail);
}
