"use client";

import { useState, useEffect, useCallback } from "react";
import type { ScannedStock, ScanResult } from "@/types/stock";
import StockCard from "@/components/StockCard";
import ScanProgress from "@/components/ScanProgress";
import { MOCK_STOCKS } from "@/lib/mockData";

type Market = "TW" | "US" | "ALL";
type SortKey = "score" | "change" | "volume";

interface DataStats {
  yahoo: number;
  twse: number;
  mock: number;
}

const MARKET_COUNTS: Record<Market, number> = { TW: 25, US: 20, ALL: 45 };

function DataSourceBadge({ stats, total }: { stats: DataStats; total: number }) {
  const realCount = stats.yahoo + stats.twse;
  const isMostlyReal = realCount > total / 2;

  if (total === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-2 text-xs px-4 py-2 rounded-lg border mb-4 ${
        isMostlyReal
          ? "bg-green-500/10 border-green-500/20 text-green-300"
          : "bg-yellow-500/10 border-yellow-500/20 text-yellow-300"
      }`}
    >
      <span className="font-medium">{isMostlyReal ? "✓ 使用真實市場數據" : "⚠ 部分使用展示資料"}</span>
      <span className="text-white/40">|</span>
      {stats.twse > 0 && (
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
          台灣證交所 {stats.twse} 支
        </span>
      )}
      {stats.yahoo > 0 && (
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-purple-400 inline-block" />
          Yahoo Finance {stats.yahoo} 支
        </span>
      )}
      {stats.mock > 0 && (
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-gray-400 inline-block" />
          展示資料 {stats.mock} 支
        </span>
      )}
    </div>
  );
}

export default function HomePage() {
  const [stocks, setStocks] = useState<ScannedStock[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [market, setMarket] = useState<Market>("TW");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [minScore, setMinScore] = useState(0);
  const [scannedCount, setScannedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [dataStats, setDataStats] = useState<DataStats>({ yahoo: 0, twse: 0, mock: 0 });
  const [initialized, setInitialized] = useState(false);

  const handleScan = useCallback(
    async (targetMarket: Market = market) => {
      setScanning(true);
      setScannedCount(0);
      const total = MARKET_COUNTS[targetMarket];
      setTotalCount(total);

      // Animate progress bar while waiting for the API
      const interval = setInterval(() => {
        setScannedCount((prev) => {
          const next = prev + Math.floor(Math.random() * 3) + 1;
          return Math.min(next, total - 2);
        });
      }, 500);

      try {
        const res = await fetch(`/api/scan?market=${targetMarket}`);
        clearInterval(interval);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data: ScanResult = await res.json();
        setStocks(data.stocks);
        setScannedCount(data.totalScanned);
        setLastScanAt(data.scannedAt);
        setDataStats(data.dataSourceStats ?? { yahoo: 0, twse: 0, mock: data.totalScanned });
      } catch {
        clearInterval(interval);
        // Fallback to static mock data
        const filtered =
          targetMarket === "ALL"
            ? MOCK_STOCKS
            : MOCK_STOCKS.filter((s) => s.market === targetMarket);
        setStocks(filtered);
        setScannedCount(filtered.length);
        setTotalCount(filtered.length);
        setLastScanAt(new Date().toISOString());
        setDataStats({ yahoo: 0, twse: 0, mock: filtered.length });
      } finally {
        setScanning(false);
      }
    },
    [market]
  );

  // Auto-scan on first load
  useEffect(() => {
    if (!initialized) {
      setInitialized(true);
      handleScan("TW");
    }
  }, [initialized, handleScan]);

  // Re-scan when market changes (after first init)
  const handleMarketChange = useCallback(
    (m: Market) => {
      setMarket(m);
      handleScan(m);
    },
    [handleScan]
  );

  const filtered = stocks
    .filter((s) => s.score >= minScore)
    .sort((a, b) => {
      if (sortKey === "score") return b.score - a.score;
      if (sortKey === "change") return b.changePercent - a.changePercent;
      return b.volume - a.volume;
    });

  const avgScore =
    filtered.length > 0
      ? Math.round(filtered.reduce((s, st) => s + st.score, 0) / filtered.length)
      : 0;

  return (
    <>
      {/* Header stat cards */}
      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "推薦股票", value: filtered.length, unit: "支", color: "text-blue-400" },
          { label: "平均信心分數", value: avgScore, unit: "分", color: "text-cyan-400" },
          { label: "高分股票(≥80)", value: filtered.filter((s) => s.score >= 80).length, unit: "支", color: "text-green-400" },
          { label: "今日上漲", value: filtered.filter((s) => s.changePercent > 0).length, unit: "支", color: "text-red-400" },
        ].map((stat) => (
          <div key={stat.label} className="bg-dark-800 border border-white/5 rounded-xl p-4">
            <p className="text-gray-400 text-xs mb-1">{stat.label}</p>
            <p className={`text-2xl font-bold ${stat.color}`}>
              {scanning && stat.value === 0 ? (
                <span className="inline-block w-8 h-6 bg-white/10 rounded animate-pulse" />
              ) : (
                <>
                  {stat.value}
                  <span className="text-sm font-normal text-gray-400 ml-1">{stat.unit}</span>
                </>
              )}
            </p>
          </div>
        ))}
      </div>

      <ScanProgress
        scanning={scanning}
        scannedCount={scannedCount}
        totalCount={totalCount}
        lastScanAt={lastScanAt}
        onScan={() => handleScan(market)}
        market={market}
        onMarketChange={handleMarketChange}
      />

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <h2 className="text-white font-semibold">
          推薦股票{" "}
          <span className="text-gray-400 text-sm font-normal">
            ({filtered.length} 支)
          </span>
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

      {/* Data source badge */}
      {!scanning && lastScanAt && (
        <DataSourceBadge stats={dataStats} total={scannedCount} />
      )}

      {/* Stock grid / loading skeleton / empty state */}
      {scanning ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-dark-800 border border-white/5 rounded-2xl p-4 animate-pulse">
              <div className="flex justify-between mb-3">
                <div>
                  <div className="h-5 w-20 bg-white/10 rounded mb-2" />
                  <div className="h-3 w-14 bg-white/5 rounded" />
                </div>
                <div className="text-right">
                  <div className="h-6 w-16 bg-white/10 rounded mb-1" />
                  <div className="h-4 w-12 bg-white/5 rounded" />
                </div>
              </div>
              <div className="h-2 bg-white/10 rounded-full mb-3" />
              <div className="flex gap-1.5 mb-3">
                <div className="h-5 w-16 bg-white/5 rounded-full" />
                <div className="h-5 w-14 bg-white/5 rounded-full" />
                <div className="h-5 w-18 bg-white/5 rounded-full" />
              </div>
              <div className="h-3 w-24 bg-white/5 rounded" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <svg
            className="w-12 h-12 mx-auto mb-3 opacity-30"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
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
