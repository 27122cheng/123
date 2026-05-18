import { NextRequest, NextResponse } from "next/server";
import { getStockList } from "@/lib/stockList";
import { scanStock } from "@/lib/scanner";
import { MOCK_STOCKS } from "@/lib/mockData";
import type { ScanResult } from "@/types/stock";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get("market") as "TW" | "US" | "ALL") ?? "TW";
  const useMock = req.nextUrl.searchParams.get("mock") === "1";

  if (useMock) {
    const filtered = market === "ALL" ? MOCK_STOCKS : MOCK_STOCKS.filter((s) => s.market === market);
    const result: ScanResult = {
      stocks: filtered.sort((a, b) => b.score - a.score),
      scannedAt: new Date().toISOString(),
      totalScanned: filtered.length,
      market,
    };
    return NextResponse.json(result);
  }

  const list = getStockList(market);
  const results = await Promise.allSettled(list.map((info) => scanStock(info)));

  const stocks = results
    .filter((r): r is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof scanStock>>>> =>
      r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value)
    .filter((s) => s.score >= 40)
    .sort((a, b) => b.score - a.score);

  const result: ScanResult = {
    stocks,
    scannedAt: new Date().toISOString(),
    totalScanned: list.length,
    market,
  };

  return NextResponse.json(result);
}
