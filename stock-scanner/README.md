# 📈 股票掃描系統 Stock Scanner

台股／美股技術指標掃描系統，自動分析 RSI、MACD、均線、成交量、布林通道，找出適合交易的股票。

## 功能特色

- 🔍 掃描台股（25支主要個股）及美股（20支 S&P 500）
- 📊 技術指標：RSI、MACD 金叉、均線多頭排列、量能放大、布林通道
- 🏆 信心分數 0~100，直覺判斷買賣時機
- 📉 近60日走勢折線圖（含 MA5、MA20、布林中線）
- 🌙 深色主題，紅漲綠跌符合台灣習慣
- 🚀 Mock 資料模式，API 失敗時自動切換，確保 Demo 可運行

---

## 本地啟動步驟

### 1. 安裝依賴

```bash
cd stock-scanner
npm install
```

### 2. 設定環境變數（可選）

```bash
cp .env.example .env.local
# 編輯 .env.local，填入需要的設定
```

### 3. 啟動開發伺服器

```bash
npm run dev
```

開啟瀏覽器訪問 [http://localhost:3000](http://localhost:3000)

### 4. 建置正式版本

```bash
npm run build
npm start
```

---

## 如何推送到 GitHub

### 1. 在 GitHub 建立新 Repository

前往 [github.com/new](https://github.com/new)，建立名為 `stock-scanner` 的公開 Repository。

### 2. 初始化並推送

```bash
cd stock-scanner
git init
git add .
git commit -m "feat: 初始化股票掃描系統"
git branch -M main
git remote add origin https://github.com/你的帳號/stock-scanner.git
git push -u origin main
```

---

## 如何連結 Vercel 自動部署

### 方法 A：透過 Vercel 網站（推薦）

1. 前往 [vercel.com](https://vercel.com) 並登入
2. 點擊 **Add New → Project**
3. 選擇你的 `stock-scanner` GitHub Repository
4. Framework Preset 選 **Next.js**
5. 點擊 **Deploy**

完成後，每次 `git push` 都會自動觸發部署。

### 方法 B：透過 Vercel CLI

```bash
npm install -g vercel
vercel login
cd stock-scanner
vercel --prod
```

### 環境變數設定（Vercel 後台）

在 Vercel 後台 → Settings → Environment Variables 中可新增：

| 變數名稱 | 說明 |
|---------|------|
| `NEXT_PUBLIC_APP_NAME` | 應用程式名稱（可選） |

---

## 技術架構

| 技術 | 版本 | 用途 |
|------|------|------|
| Next.js | 14 | App Router、API Routes |
| TypeScript | 5 | 型別安全 |
| Tailwind CSS | 3 | 樣式 |
| Recharts | 2 | 走勢圖 |
| yahoo-finance2 | 2 | 股票資料 |

## 技術指標說明

| 指標 | 判斷條件 | 分數 |
|------|---------|------|
| RSI | 30~70 健康區間 | +20 |
| MACD | 金叉（MACD > 訊號線） | +25 |
| 均線 | MA5 > MA20 > MA60 多頭排列 | +25 |
| 成交量 | 今日量 > 5日均量 1.5 倍 | +15 |
| 布林通道 | 股價 > 布林中線 | +15 |

> ⚠️ 本系統分析結果僅供參考，不構成投資建議。投資有風險，請獨立判斷。
