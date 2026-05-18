import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "股票掃描系統 | Stock Scanner",
  description: "台股/美股技術指標掃描，找出適合交易的股票",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body className="bg-dark-900 text-white min-h-screen antialiased">
        <nav className="border-b border-white/5 bg-dark-800/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                </svg>
              </div>
              <span className="font-bold text-white text-lg tracking-tight">股票掃描系統</span>
            </div>
            <span className="text-xs text-gray-500">台股 / 美股 技術指標分析</span>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
