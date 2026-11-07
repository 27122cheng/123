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
- `t_guard.mjs`：守護頁（guard.html）——彈出權限探測；主機心跳停 150 秒且非正常關閉 → 另開主機 ?revived= → 立即接手；unload 不重開；3 分鐘冷卻；第二個守護頁待命；彈出被封鎖 → 守護頁自己轉為主機 → 主機顯示「開啟守護頁」橫幅；主機側重開守護頁、電腦守護程式開的主機（?revived=ps…）、診斷包附 guard
- `t_research.mjs`：報表頁「🔬 交易研究」——學習成長（連續視窗勝率／R／回撤、最近窗 vs 前一窗、目前回撤、學習機制現況）、一眼結論、準確度儀表、交易研究台（篩選／排序／單筆展開）、一般單／快速單切換；分桶校準 btProbCalibrated（倒掛合併、桶 <20 不校準）
- `t_fund.mjs`：基本面層（DefiLlama 協議／手續費／收入、CoinPaprika、穩定幣、mempool；同代號取最大；只留清單幣；評分與證據；訊息／紀錄／研究特徵／登錄）、OKX 成交→K 線足跡備援、OKX 清算 REST 備援併入緩衝、交易員總覽卡
- `t_qlab.mjs`：逐模式量化實驗室（每模式網格＋樣本外、排程輪替、覆寫只影響該模式、取消）、回測自動排程與近三次判定（合用／不合用／累積中）、實驗室頁面板
- `t_combo.mjs`：條件組合研究（兩兩交叉、Wilson 判定）、每日自動登錄假設、證實後快速單攔截（組合鍵）／一般單軟門（組合鍵）、研究台組合卡與組合篩選
- `t_boot.mjs`：開頁順序——自動安全模式一開頁就 html.lite、連續未完成計數、細粒度開頁軌跡、背景模組等 done 後才啟動
- `soak.mjs <分鐘>`：長時間運行壓力測試（真實刷新迴圈 3 秒一輪），輸出 heap／DOM／監聽器／timer／快取／localStorage 成長

執行：`node tests/t_smoke4.mjs`
