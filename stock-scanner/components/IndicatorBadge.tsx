"use client";

import type { PassedIndicator } from "@/types/stock";

const badgeColors: Record<string, string> = {
  rsi: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  rsi_oversold: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  macd: "bg-green-500/20 text-green-300 border-green-500/30",
  ma: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  volume: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  bollinger: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
};

export default function IndicatorBadge({ indicator }: { indicator: PassedIndicator }) {
  const color = badgeColors[indicator.key] ?? "bg-gray-500/20 text-gray-300 border-gray-500/30";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${color}`}
      title={indicator.value}
    >
      {indicator.label}
    </span>
  );
}
