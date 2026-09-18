# 測試腳本（開發用，不部署）

前置：`python3 -m http.server 8765 --directory <repo>` 於 repo 根目錄啟動；Playwright 路徑依機器調整（腳本頂端 import）。

- `t_smoke4.mjs`：120 幣＋200 筆紀錄的廣泛煙霧測試（掃描、持倉更新、快速單、簡報、七個頁面渲染、設定存讀）
- `t_budget.mjs`：軟門預算、雙弱不建、每輪建單上限、預測成績單門檻、事件無寫死 AI 預測、環境卡風險預算
- `t_pionex.mjs`：一般單 Pionex 價位對齊（等比、±3% 退回、監控依單的價位空間、Telegram 文字）

執行：`node tests/t_smoke4.mjs`
