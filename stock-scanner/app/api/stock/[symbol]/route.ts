import { NextRequest, NextResponse } from "next/server";
import { MOCK_STOCKS, generateMockHistory } from "@/lib/mockData";
import { calcIndicators, scoreStock } from "@/lib/indicators";
import { fetchYFHistory, fetchYFQuote } from "@/lib/yahooFetch";
import { fetchTWSEHistory, fetchTWSEQuote } from "@/lib/twseFetch";
import type { StockDetail, HistoricalBar } from "@/types/stock";

export const maxDuration = 30;

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } }
) {
  const symbol = decodeURIComponent(params.symbol).toUpperCase();
  const isTW = symbol.endsWith(".TW") || symbol.endsWith(".TWO");

  let history: HistoricalBar[] | null = null;
  let dataSource: "yahoo" | "twse" | "mock" = "mock";

  // Taiwan stocks: try TWSE first (official source, daily data)
  if (isTW) {
    history = await fetchTWSEHistory(symbol);
    if (history && history.length >= 20) {
      dataSource = "twse";
    }
  }

  // Fallback to Yahoo Finance for both TW and US
  if (!history || history.length < 20) {
    history = await fetchYFHistory(symbol, "3mo");
    if (history && history.length >= 20) {
      dataSource = "yahoo";
    }
  }

  // Last resort: generate deterministic mock history
  if (!history || history.length < 20) {
    const mockBase = MOCK_STOCKS.find((s) => s.symbol === symbol);
    const basePrice = mockBase?.price ?? 100;
    history = generateMockHistory(basePrice);
    dataSource = "mock";
  }

  // Fetch latest quote to override the last bar's price
  let liveQuote: { price: number; change: number; changePercent: number; volume: number } | null = null;
  if (isTW) {
    const twse = await fetchTWSEQuote(symbol);
    if (twse && twse.price > 0) liveQuote = twse;
  }
  if (!liveQuote) {
    const yf = await fetchYFQuote(symbol);
    if (yf && yf.price > 0) liveQuote = yf;
  }

  const lastBar = history[history.length - 1];
  const prevBar = history[history.length - 2];
  const price = liveQuote?.price ?? lastBar.close;
  const change = liveQuote?.change ?? (prevBar ? price - prevBar.close : 0);
  const changePercent =
    liveQuote?.changePercent ?? (prevBar && prevBar.close > 0 ? (change / prevBar.close) * 100 : 0);
  const volume = liveQuote?.volume ?? lastBar.volume;

  // Recalculate indicators with live price on last bar
  const enrichedHistory: HistoricalBar[] = liveQuote
    ? [...history.slice(0, -1), { ...lastBar, close: price, volume }]
    : history;

  const ind = calcIndicators(enrichedHistory);
  const { score, passed } = scoreStock(ind, price);

  const mockBase = MOCK_STOCKS.find((s) => s.symbol === symbol);

  const detail: StockDetail & { dataSource: string } = {
    symbol,
    name: mockBase?.name ?? symbol,
    price,
    change,
    changePercent,
    volume,
    market: isTW ? "TW" : "US",
    score,
    indicators: ind,
    passedIndicators: passed,
    scannedAt: new Date().toISOString(),
    history: enrichedHistory.slice(-65), // last 65 trading days
    dataSource,
  };

  return NextResponse.json(detail);
}
