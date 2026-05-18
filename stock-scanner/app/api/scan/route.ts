import { NextRequest, NextResponse } from "next/server";
import { getStockList } from "@/lib/stockList";
import { scanAll } from "@/lib/scanner";
import { MOCK_STOCKS } from "@/lib/mockData";
import type { ScanResult } from "@/types/stock";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get("market") as "TW" | "US" | "ALL") ?? "TW";
  const demoMode = req.nextUrl.searchParams.get("demo") === "1";

  // Demo mode: return static mock data instantly
  if (demoMode) {
    const filtered =
      market === "ALL" ? MOCK_STOCKS : MOCK_STOCKS.filter((s) => s.market === market);
    const result: ScanResult = {
      stocks: filtered.sort((a, b) => b.score - a.score),
      scannedAt: new Date().toISOString(),
      totalScanned: filtered.length,
      market,
      dataSourceStats: { yahoo: 0, twse: 0, mock: filtered.length },
    };
    return NextResponse.json(result);
  }

  const list = getStockList(market);

  // Scan with real data (Yahoo Finance + TWSE), mock fallback per-stock
  const scanned = await scanAll(list, 5);

  const stocks = scanned
    .filter((s) => s.score >= 40)
    .sort((a, b) => b.score - a.score);

  const stats = { yahoo: 0, twse: 0, mock: 0 };
  scanned.forEach((s) => {
    const src = s.dataSource ?? "mock";
    stats[src]++;
  });

  const result: ScanResult = {
    stocks,
    scannedAt: new Date().toISOString(),
    totalScanned: list.length,
    market,
    dataSourceStats: stats,
  };

  return NextResponse.json(result);
}
