# 測試腳本（開發用，不部署）

前置：`python3 -m http.server 8765 --directory <repo>` 於 repo 根目錄啟動；Playwright 路徑依機器調整（腳本頂端 import）。

- `t_smoke4.mjs`：120 幣＋200 筆紀錄的廣泛煙霧測試（掃描、持倉更新、快速單、簡報、七個頁面渲染、設定存讀）
- `t_budget.mjs`：軟門預算、雙弱不建、每輪建單上限、預測成績單門檻、事件無寫死 AI 預測、環境卡風險預算
- `t_pionex.mjs`：一般單 Pionex 價位對齊（等比、±3% 退回、監控依單的價位空間、Telegram 文字）
- `t_bt.mjs`：2026-10 回測驗證閘門（逆 BTC 日線／4H ADX／多空人數比）、突破單 1R/2.5R 出場計畫、快速單設定
- `t_health.mjs`：刷新迴圈例外歸零、卡住看門狗、自我修復決策與冷卻、localStorage 裁剪、K 線快取上限
- `t_relay.mjs`：api/relay.js 白名單／轉發／快取（Node 直接呼叫 handler）
- `t_exp.mjs`：實驗整合層——統一特徵抽取、分層績效矩陣、實驗登錄判定、自動套用（快速單攔截／一般單軟門）、樣本充足度
- `t_report.mjs`：api/report.js Chrome Reporting API 崩潰回報接收（Node 直接呼叫 handler）
- `t_boot.mjs`：開頁順序——自動安全模式一開頁就 html.lite、連續未完成計數、細粒度開頁軌跡、背景模組等 done 後才啟動
- `soak.mjs <分鐘>`：長時間運行壓力測試（真實刷新迴圈 3 秒一輪），輸出 heap／DOM／監聽器／timer／快取／localStorage 成長

執行：`node tests/t_smoke4.mjs`
