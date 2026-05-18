"use client";

interface ScanProgressProps {
  scanning: boolean;
  scannedCount: number;
  totalCount: number;
  lastScanAt: string | null;
  onScan: () => void;
  market: "TW" | "US" | "ALL";
  onMarketChange: (m: "TW" | "US" | "ALL") => void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "尚未掃描";
  const d = new Date(iso);
  return d.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
}

export default function ScanProgress({
  scanning,
  scannedCount,
  totalCount,
  lastScanAt,
  onScan,
  market,
  onMarketChange,
}: ScanProgressProps) {
  const progress = totalCount > 0 ? Math.round((scannedCount / totalCount) * 100) : 0;

  return (
    <div className="bg-dark-800 border border-white/10 rounded-2xl p-5 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-white font-semibold text-lg">掃描控制台</h2>
            {scanning && (
              <span className="flex items-center gap-1.5 text-sm text-cyan-400">
                <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                掃描中…
              </span>
            )}
          </div>
          <p className="text-gray-400 text-sm">
            上次掃描：<span className="text-gray-300">{formatTime(lastScanAt)}</span>
          </p>
          {scanning && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>已分析 {scannedCount} / {totalCount} 支股票</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 bg-dark-600 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            {(["TW", "US", "ALL"] as const).map((m) => (
              <button
                key={m}
                onClick={() => onMarketChange(m)}
                className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                  market === m
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:text-white hover:bg-white/5"
                }`}
              >
                {m === "TW" ? "台股" : m === "US" ? "美股" : "全部"}
              </button>
            ))}
          </div>
          <button
            onClick={onScan}
            disabled={scanning}
            className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
          >
            {scanning ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                掃描中…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                重新掃描
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
