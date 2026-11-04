# host-watchdog.ps1 — 加密掃描 Pro：瀏覽器外面的主機守護程式
# 用途：主機分頁（含守護頁）會被電腦上的某個程式整批結束，瀏覽器裡的任何頁面都躲不掉。
#       這支程式在瀏覽器外面跑，每 30 秒看雲端上的主機心跳（/api/master，主機每 2 分鐘寫一次），
#       心跳停超過 4 分鐘就用「預設瀏覽器」把主機開回來（網址帶 ?revived=ps…，主機開頁後會立即接手訊號）。
# 需求：設定頁「☁️ 使用雲端同步」開著、本裝置為訊號主機。黑掉的舊分頁不會自動關閉，看到了請自己關。
# 啟動：雙擊同資料夾的 host-watchdog.bat（或在 PowerShell 執行本檔）。視窗要一直開著；關掉視窗＝停止守護。
param(
  [string]$Site = 'https://123-kappa-gilt.vercel.app',
  [int]$StaleSec = 240,        # 心跳停幾秒視為主機已死
  [int]$PollSec = 30,          # 幾秒看一次
  [int]$CooldownSec = 300,     # 開過一次後至少等幾秒才再開
  [bool]$PhoneIsNotHost = $true   # 雲端主機是手機時（ua 含 Mobile），視同電腦主機不在，照樣把電腦主機開回來
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lastOpen = [DateTime]::MinValue
$nowMs = { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
Write-Host "🛡️ 主機守護程式已啟動：每 $PollSec 秒檢查 $Site/api/master，心跳停 $StaleSec 秒就開主機。關掉這個視窗＝停止守護。"
while ($true) {
  $stamp = Get-Date -Format 'MM/dd HH:mm:ss'
  try {
    $r = Invoke-RestMethod -Uri "$Site/api/master?_=$(& $nowMs)" -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-store' }
    if (-not $r.ok) {
      Write-Host "$stamp 雲端回應錯誤：$($r.reason) $($r.hint)"
    } elseif (-not $r.master -or -not $r.master.ts) {
      Write-Host "$stamp 雲端沒有主機紀錄（主機從未宣告或已清除；設定頁要開「雲端同步」）"
    } else {
      $age = [int](((& $nowMs) - [int64]$r.master.ts) / 1000)
      $ua = [string]$r.master.ua
      $isPhone = $ua -match 'Mobile|Android|iPhone|iPad|手機'
      $dead = ($age -gt $StaleSec) -or ($PhoneIsNotHost -and $isPhone)
      if (-not $dead) {
        Write-Host "$stamp 主機心跳 $age 秒前（$ua）"
      } elseif (((Get-Date) - $lastOpen).TotalSeconds -lt $CooldownSec) {
        Write-Host "$stamp 心跳已停 $age 秒$(if ($isPhone) { '（目前主機是手機）' })，剛開過主機，等待它接手…"
      } else {
        $url = "$Site/index.html?revived=ps$(& $nowMs)"
        Write-Host "$stamp 心跳已停 $age 秒$(if ($isPhone) { '（目前主機是手機）' }) → 用預設瀏覽器開啟主機：$url"
        try { Start-Process $url } catch { Write-Host "$stamp 開啟瀏覽器失敗：$($_.Exception.Message)" }
        $lastOpen = Get-Date
      }
    }
  } catch {
    Write-Host "$stamp 連線失敗：$($_.Exception.Message)"
  }
  Start-Sleep -Seconds $PollSec
}
