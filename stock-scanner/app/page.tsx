"use client";

import { useState, useEffect, useCallback } from "react";
import type { ScannedStock, ScanResult } from "@/types/stock";
import StockCard from "@/components/StockCard";
import ScanProgress from "@/components/ScanProgress";
import { MOCK_STOCKS } from "@/lib/mockData";

type Market = "TW" | "US" | "ALL";
type SortKey = "score" | "change" | "volume";

export default function HomePage() {
  const [stocks, setStocks] = useState<ScannedStock[]>(MOCK_STOCKS);
  const [scanning, setScanning] = useState(false);
  const [lastScanAt, setLastScanAt] = useState<string | null>(new Date().toISOString());
  const [market, setMarket] = useState<Market>("TW");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [minScore, setMinScore] = useState(0);
  const [scannedCount, setScannedCount] = useState(MOCK_STOCKS.length);
  const [totalCount, setTotalCount] = useState(MOCK_STOCKS.length);
  const [useMock, setUseMock] = useState(false);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setScannedCount(0);

    const stockCounts: Record<Market, number> = { TW: 25, US: 20, ALL: 45 };
    const total = stockCounts[market];
    setTotalCount(total);

    // Animate progress while fetching
    const interval = setInterval(() => {
      setScannedCount((prev) => Math.min(prev + Math.floor(Math.random() * 3) + 1, total - 1));
    }, 400);

    try {
      const res = await fetch(`/api/scan?market=${market}&mock=${useMock ? 1 : 0}`);
      clearInterval(interval);

      if (!res.ok) throw new Error("API 錯誤");
      const data: ScanResult = await res.json();
      setStocks(data.stocks);
      setScannedCount(data.totalScanned);
      setLastScanAt(data.scannedAt);
    } catch {
      clearInterval(interval);
      // Fallback to mock
      const filtered = market === "ALL" ? MOCK_STOCKS : MOCK_STOCKS.filter((s) => s.market === market);
      setStocks(filtered);
      setScannedCount(filtered.length);
      setLastScanAt(new Date().toISOString());
      setUseMock(true);
    } finally {
      setScanning(false);
    }
  }, [market, useMock]);

  useEffect(() => {
    const filtered = MOCK_STOCKS.filter(
      (s) => market === "ALL" || s.market === market
    );
    setStocks(filtered);
    setScannedCount(filtered.length);
    setTotalCount(filtered.length);
  }, [market]);

  const filtered = stocks
    .filter((s) => s.score >= minScore)
    .sort((a, b) => {
      if (sortKey === "score") return b.score - a.score;
      if (sortKey === "change") return b.changePercent - a.changePercent;
      return b.volume - a.volume;
    });

  return (
    <>
      {/* Header stats */}
      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "推薦股票", value: filtered.length, unit: "支", color: "text-blue-400" },
          { label: "平均信心分數", value: filtered.length ? Math.round(filtered.reduce((s, st) => s + st.score, 0) / filtered.length) : 0, unit: "分", color: "text-cyan-400" },
          { label: "高分股票(≥80)", value: filtered.filter((s) => s.score >= 80).length, unit: "支", color: "text-green-400" },
          { label: "上漲股票", value: filtered.filter((s) => s.changePercent > 0).length, unit: "支", color: "text-red-400" },
        ].map((stat) => (
          <div key={stat.label} className="bg-dark-800 border border-white/5 rounded-xl p-4">
            <p className="text-gray-400 text-xs mb-1">{stat.label}</p>
            <p className={`text-2xl font-bold ${stat.color}`}>
              {stat.value}<span className="text-sm font-normal text-gray-400 ml-1">{stat.unit}</span>
            </p>
          </div>
        ))}
      </div>

      <ScanProgress
        scanning={scanning}
        scannedCount={scannedCount}
        totalCount={totalCount}
        lastScanAt={lastScanAt}
        onScan={handleScan}
        market={market}
        onMarketChange={setMarket}
      />

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <h2 className="text-white font-semibold">
          推薦股票 <span className="text-gray-400 text-sm font-normal">({filtered.length} 支)</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-400">最低分數：</label>
          <select
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="bg-dark-700 border border-white/10 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value={0}>不限制</option>
            <option value={40}>40分以上</option>
            <option value={60}>60分以上</option>
            <option value={80}>80分以上</option>
          </select>
          <label className="text-xs text-gray-400 ml-2">排序：</label>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="bg-dark-700 border border-white/10 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value="score">信心分數</option>
            <option value="change">漲跌幅</option>
            <option value="volume">成交量</option>
          </select>
        </div>
      </div>

      {/* Mock data notice */}
      {useMock && (
        <div className="mb-4 flex items-center gap-2 text-sm text-yellow-300 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          使用展示資料（Demo 模式）—— 實際部署請設定 API 金鑰
        </div>
      )}

      {/* Stock grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p>尚無符合條件的股票，請調整篩選條件或重新掃描</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((stock) => (
            <StockCard key={stock.symbol} stock={stock} />
          ))}
        </div>
      )}
    </>
  );
}
