@echo off
chcp 65001 >nul
echo.
echo  ========================================
echo   Pionex CORS 代理伺服器
echo  ========================================
echo.
echo  啟動後請勿關閉此視窗
echo  瀏覽器連到 Pionex 的請求會透過此代理
echo.
python pionex-proxy.py
pause
