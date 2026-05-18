"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { StockDetail } from "@/types/stock";
import IndicatorBadge from "@/components/IndicatorBadge";
import { MOCK_STOCKS, generateMockHistory } from "@/lib/mockData";
import { calcIndicators, scoreStock } from "@/lib/indicators";

const StockChart = dynamic(() => import("@/components/StockChart"), { ssr: false });

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-dark-800 border border-white/5 rounded-xl p-4">
      <p className="text-gray-400 text-xs mb-1">{label}</p>
      <p className={`text-xl font-bold ${color ?? "text-white"}`}>{value}</p>
      {sub && <p className="text-gray-500 text-xs mt-0.5">{sub}</p>}
    </div>
  );
}

function getBuySellAdvice(score: number, rsi: number, macdHistogram: number): { signal: string; color: string; reason: string } {
  if (score >= 80 && rsi < 65 && macdHistogram > 0) {
    return { signal: "強力買進", color: "text-red-400 bg-red-500/10 border-red-500/30", reason: "多項技術指標共同確認多頭趨勢，量能放大，適合積極布局。" };
  }
  if (score >= 60 && macdHistogram > 0) {
    return { signal: "觀察買進", color: "text-orange-400 bg-orange-500/10 border-orange-500/30", reason: "MACD 出現金叉訊號，趨勢轉多，可分批建立部位，設好停損。" };
  }
  if (rsi > 75) {
    return { signal: "暫緩觀望", color: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30", reason: "RSI 偏高，短期可能回調，等待拉回再進場較為穩健。" };
  }
  if (macdHistogram < 0) {
    return { signal: "暫不建議", color: "text-green-400 bg-green-500/10 border-green-500/30", reason: "MACD 出現死叉，下跌動能仍在，建議等待趨勢反轉確認。" };
  }
  return { signal: "持續觀察", color: "text-gray-300 bg-white/5 border-white/10", reason: "指標訊號混合，建議等待更明確的突破訊號再行動。" };
}

export default function StockDetailPage() {
  const { symbol } = useParams<{ symbol: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<StockDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/stock/${symbol}?mock=0`);
        if (!res.ok) throw new Error();
        const data: StockDetail = await res.json();
        setDetail(data);
      } catch {
        // Build from mock
        const mockStock = MOCK_STOCKS.find((s) => s.symbol === symbol);
        const basePrice = mockStock?.price ?? 100;
        const history = generateMockHistory(basePrice);
        const ind = calcIndicators(history);
        const { score, passed } = scoreStock(ind, history[history.length - 1].close);
        const lastBar = history[history.length - 1];
        const prevBar = history[history.length - 2];
        const price = lastBar.close;
        const change = prevBar ? price - prevBar.close : 0;
        setDetail({
          symbol: symbol as string,
          name: mockStock?.name ?? symbol,
          price,
          change,
          changePercent: prevBar ? (change / prevBar.close) * 100 : 0,
          volume: lastBar.volume,
          market: (symbol as string).endsWith(".TW") ? "TW" : "US",
          score,
          indicators: ind,
          passedIndicators: passed,
          scannedAt: new Date().toISOString(),
          history,
        });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [symbol]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-3 text-gray-400">
        <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        載入股票資料中…
      </div>
    );
  }

  if (!detail) return <div className="text-center py-20 text-gray-400">無法載入資料</div>;

  const isUp = detail.changePercent >= 0;
  const advice = getBuySellAdvice(detail.score, detail.indicators.rsi, detail.indicators.macdHistogram);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-5 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        返回列表
      </button>

      {/* Stock header */}
      <div className="bg-dark-800 border border-white/10 rounded-2xl p-5 mb-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-white">{detail.symbol.replace(".TW", "")}</h1>
              <span className="text-xs px-2 py-0.5 rounded bg-white/5 text-gray-400 border border-white/5">{detail.market}</span>
            </div>
            <p className="text-gray-400">{detail.name}</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-white tabular-nums">
              {detail.market === "TW"
                ? detail.price.toLocaleString("zh-TW", { minimumFractionDigits: 1 })
                : `$${detail.price.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
            </div>
            <div className={`text-lg font-medium ${isUp ? "text-red-400" : "text-green-400"}`}>
              {isUp ? "▲" : "▼"} {Math.abs(detail.change).toFixed(2)} ({Math.abs(detail.changePercent).toFixed(2)}%)
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {detail.passedIndicators.map((ind) => (
            <IndicatorBadge key={ind.key} indicator={ind} />
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="bg-dark-800 border border-white/10 rounded-2xl p-5 mb-5">
        <h2 className="text-white font-semibold mb-4">近60日走勢圖</h2>
        <StockChart bars={detail.history} indicators={detail.indicators} />
      </div>

      {/* Indicators grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <StatCard
          label="RSI (14)"
          value={detail.indicators.rsi.toFixed(1)}
          sub={detail.indicators.rsi < 30 ? "超賣區" : detail.indicators.rsi > 70 ? "超買區" : "健康區間"}
          color={detail.indicators.rsi < 30 ? "text-green-400" : detail.indicators.rsi > 70 ? "text-red-400" : "text-blue-400"}
        />
        <StatCard
          label="MACD"
          value={detail.indicators.macd.toFixed(3)}
          sub={`訊號線 ${detail.indicators.macdSignal.toFixed(3)}`}
          color={detail.indicators.macdHistogram > 0 ? "text-red-400" : "text-green-400"}
        />
        <StatCard
          label="MACD 柱狀"
          value={detail.indicators.macdHistogram.toFixed(3)}
          sub={detail.indicators.macdHistogram > 0 ? "多頭動能" : "空頭動能"}
          color={detail.indicators.macdHistogram > 0 ? "text-red-400" : "text-green-400"}
        />
        <StatCard label="MA5" value={detail.indicators.ma5.toFixed(2)} />
        <StatCard label="MA20" value={detail.indicators.ma20.toFixed(2)} />
        <StatCard label="MA60" value={detail.indicators.ma60.toFixed(2)} />
        <StatCard label="布林上軌" value={detail.indicators.bollingerUpper.toFixed(2)} color="text-red-400" />
        <StatCard label="布林中線" value={detail.indicators.bollingerMiddle.toFixed(2)} color="text-cyan-400" />
        <StatCard label="布林下軌" value={detail.indicators.bollingerLower.toFixed(2)} color="text-green-400" />
      </div>

      {/* Buy/Sell advice */}
      <div className={`border rounded-2xl p-5 ${advice.color}`}>
        <div className="flex items-center gap-3 mb-2">
          <span className="text-lg font-bold">{advice.signal}</span>
          <span className="text-sm font-normal">信心分數：{detail.score} / 100</span>
        </div>
        <p className="text-sm opacity-90">{advice.reason}</p>
        <p className="text-xs opacity-60 mt-3">⚠️ 此分析僅供參考，不構成投資建議。投資有風險，請自行評估。</p>
      </div>
    </div>
  );
}
