# 回測（開發用，不部署）

- 資料在 `backtest-data` 分支：`data/okx_{1H,15m,5m,4H,1D}.json`（OKX USDT 永續）、`data/chips.json`（資金費率／多空人數比／持倉量）。
  抓取腳本 `scripts/fetch_okx.mjs`、`scripts/fetch_okx_chips.mjs` 在同一分支，push 腳本即由 GitHub Actions 重抓並提交。
- 執行：把 `data/` 下載到本機後 `node backtest/bt2.mjs ./data`。
- 報告：`docs/回測報告-2026-10-02.md`；原始輸出 `backtest/結果-2026-10-02.txt`。
