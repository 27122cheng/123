export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  market: "TW" | "US";
}

export interface TechnicalIndicators {
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  ma5: number;
  ma20: number;
  ma60: number;
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  avgVolume5: number;
  currentVolume: number;
}

export interface PassedIndicator {
  key: string;
  label: string;
  value: string;
}

export type DataSource = "yahoo" | "twse" | "mock";

export interface ScannedStock {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  market: "TW" | "US";
  score: number;
  indicators: TechnicalIndicators;
  passedIndicators: PassedIndicator[];
  scannedAt: string;
  dataSource?: DataSource;
}

export interface HistoricalBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockDetail extends ScannedStock {
  history: HistoricalBar[];
}

export interface ScanResult {
  stocks: ScannedStock[];
  scannedAt: string;
  totalScanned: number;
  market: "TW" | "US" | "ALL";
  dataSourceStats: { yahoo: number; twse: number; mock: number };
}

export interface ScanProgress {
  total: number;
  current: number;
  status: "idle" | "scanning" | "done" | "error";
  lastScanAt: string | null;
}
