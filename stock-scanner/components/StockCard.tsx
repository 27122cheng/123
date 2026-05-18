"use client";

import Link from "next/link";
import type { ScannedStock } from "@/types/stock";
import IndicatorBadge from "./IndicatorBadge";

function formatPrice(price: number, market: "TW" | "US"): string {
  return market === "TW"
    ? price.toLocaleString("zh-TW", { minimumFractionDigits: 1, maximumFractionDigits: 2 })
    : price.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function formatVolume(vol: number): string {
  if (vol >= 100_000_000) return `${(vol / 100_000_000).toFixed(1)}億`;
  if (vol >= 10_000) return `${(vol / 10_000).toFixed(0)}萬`;
  return vol.toLocaleString();
}

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 80 ? "from-green-500 to-emerald-400" :
    score >= 60 ? "from-blue-500 to-cyan-400" :
    score >= 40 ? "from-yellow-500 to-orange-400" :
    "from-red-500 to-rose-400";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full bg-gradient-to-r ${color} rounded-full transition-all duration-500`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className={`text-xs font-bold tabular-nums ${
        score >= 80 ? "text-green-400" : score >= 60 ? "text-blue-400" : "text-yellow-400"
      }`}>
        {score}
      </span>
    </div>
  );
}

export default function StockCard({ stock }: { stock: ScannedStock }) {
  const isUp = stock.changePercent >= 0;
  const changeColor = isUp ? "text-red-400" : "text-green-400";
  const changeBg = isUp ? "bg-red-500/10" : "bg-green-500/10";

  return (
    <Link href={`/stock/${encodeURIComponent(stock.symbol)}`}>
      <div className="bg-dark-800 border border-white/10 hover:border-blue-500/40 rounded-2xl p-4 transition-all duration-200 hover:bg-dark-700 cursor-pointer group">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-white font-bold text-base group-hover:text-blue-300 transition-colors">
                {stock.symbol.replace(".TW", "")}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-gray-400 border border-white/5">
                {stock.market}
              </span>
            </div>
            <p className="text-gray-400 text-sm mt-0.5">{stock.name}</p>
          </div>
          <div className="text-right">
            <div className="text-white font-bold text-lg tabular-nums">
              {formatPrice(stock.price, stock.market)}
            </div>
            <div className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded ${changeBg} ${changeColor}`}>
              {isUp ? "▲" : "▼"} {Math.abs(stock.changePercent).toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>信心分數</span>
          </div>
          <ScoreBar score={stock.score} />
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {stock.passedIndicators.map((ind) => (
            <IndicatorBadge key={ind.key} indicator={ind} />
          ))}
        </div>

        <div className="flex justify-between text-xs text-gray-500">
          <span>成交量 {formatVolume(stock.volume)}</span>
          <span className="flex items-center gap-1 text-blue-400 group-hover:text-blue-300">
            查看詳情 →
          </span>
        </div>
      </div>
    </Link>
  );
}
