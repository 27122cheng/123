"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import type { HistoricalBar, TechnicalIndicators } from "@/types/stock";

interface ChartData {
  date: string;
  close: number;
  ma5: number | null;
  ma20: number | null;
}

function calcMA(bars: HistoricalBar[], period: number): (number | null)[] {
  return bars.map((_, i) => {
    if (i < period - 1) return null;
    const slice = bars.slice(i - period + 1, i + 1);
    return slice.reduce((s, b) => s + b.close, 0) / period;
  });
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: { value: number; name: string; color: string }[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-dark-600 border border-white/10 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-gray-400 mb-2">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="text-white font-medium tabular-nums">{p.value?.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

export default function StockChart({
  bars,
  indicators,
}: {
  bars: HistoricalBar[];
  indicators: TechnicalIndicators;
}) {
  const recent = bars.slice(-60);
  const ma5Vals = calcMA(bars, 5).slice(-60);
  const ma20Vals = calcMA(bars, 20).slice(-60);

  const data: ChartData[] = recent.map((b, i) => ({
    date: formatDate(b.date),
    close: b.close,
    ma5: ma5Vals[i],
    ma20: ma20Vals[i],
  }));

  const closes = recent.map((b) => b.close);
  const minClose = Math.min(...closes);
  const maxClose = Math.max(...closes);
  const padding = (maxClose - minClose) * 0.15;
  const yMin = Math.floor(minClose - padding);
  const yMax = Math.ceil(maxClose + padding);

  const isUp = recent.length > 1 && recent[recent.length - 1].close >= recent[0].close;
  const gradientColor = isUp ? "#ef4444" : "#22c55e";

  return (
    <div className="w-full">
      <div className="h-64 sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={gradientColor} stopOpacity={0.3} />
                <stop offset="95%" stopColor={gradientColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="date"
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              tickLine={false}
              interval={9}
            />
            <YAxis
              domain={[yMin, yMax]}
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={60}
              tickFormatter={(v) => v.toFixed(0)}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={indicators.bollingerMiddle} stroke="#06b6d4" strokeDasharray="4 2" strokeOpacity={0.5} label={{ value: "BB中", fill: "#06b6d4", fontSize: 10 }} />
            <Area
              type="monotone"
              dataKey="close"
              name="收盤價"
              stroke={gradientColor}
              strokeWidth={2}
              fill="url(#priceGradient)"
              dot={false}
              activeDot={{ r: 4, fill: gradientColor }}
            />
            <Area
              type="monotone"
              dataKey="ma5"
              name="MA5"
              stroke="#f59e0b"
              strokeWidth={1.5}
              fill="none"
              dot={false}
              strokeDasharray="0"
            />
            <Area
              type="monotone"
              dataKey="ma20"
              name="MA20"
              stroke="#8b5cf6"
              strokeWidth={1.5}
              fill="none"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-4 justify-center mt-2 text-xs text-gray-400">
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 rounded" style={{ backgroundColor: gradientColor, display: "inline-block" }} />收盤價</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 rounded bg-yellow-400 inline-block" />MA5</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 rounded bg-purple-400 inline-block" />MA20</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 rounded bg-cyan-400 inline-block" />BB中線</span>
      </div>
    </div>
  );
}
