/* ============================================================
   app.js — 主應用邏輯（繁體中文 + 幣安實時K線版）
   ============================================================ */

/* ── 交易設置緩存（供 Telegram 通知使用）────────────────────── */
const _tradeSetupCache  = {};
const _footprintCache   = {};  // 足跡圖數據緩存（幣種詳情頁抓取後寫入）
const _liquidationCache = {};  // 爆倉地圖數據緩存（幣種詳情頁抓取後寫入）
const _scanFetchCache   = {};  // 掃描器補充抓取快取（5 分鐘 TTL，避免每 15s 重複請求）
let   _macroCache       = null;
let   _positionsScanTimer = null;
let   _bgScanTimer     = null;  // 持續背景掃描（每 30 秒，與頁面無關）
let   _erScanTimer     = null;  // 極端反轉背景輪掃（台灣時間 00/06/12/18 每6小時更新 BTC/ETH）
let   _erScanRunning   = false;

/* ── 狀態 ───────────────────────────────────────────────────── */
const state = {
  data:         [],
  filtered:     [],
  activeFilter: 'all',
  dashSearch:   '',
  currentPage:  'dashboard',
  currentCoin:  null,
  timeframe:    '15m',
  settings:     {},
  sortState:    {
    bull:    { key: 'score', dir: 'desc' },
    bear:    { key: 'score', dir: 'asc'  },
    ranking: { key: 'score', dir: 'desc' },
  },
  tvWidget:     null,
  reportYear:   new Date().getFullYear(),
  refreshTimer:    null,
  countdownTimer:  null,
  countdown:    60,
  dataSource:   'mock',
  scanning:     false,
};

/* ── 启动 ───────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', init);

async function init() {
  state.settings = loadSettings();
  applySettingsToUI();
  animateLoadingBar();
  registerSW();        // 後台通知 Service Worker
  monthlyTradePrune(); // 歸檔超過一個月的交易記錄（AI 記憶保留）

  try {
    const { data, source } = await fetchMarketData(state.timeframe);
    state.data       = data;
    state.dataSource = source;
    state.filtered   = [...data];
    refreshPionexPrices().catch(() => {});
  } catch (e) {
    console.error('[init] fetchMarketData 失敗，使用空數據', e);
    state.data     = [];
    state.filtered = [];
  }
  // 後續處理獨立保護，不影響 state.data
  try { updateOpenTrades(state.data); } catch(e) { console.error('[init] updateOpenTrades 錯誤:', e); }

  hideLoading();
  hideScanBar();
  try { renderAll(); } catch(e) { console.error('[init] renderAll 錯誤:', e); }
  loadDashboardMacro().catch(e => console.warn('[loadDashboardMacro]', e));
  startRefreshCycle();
  startDailyBriefingCheck();
  startEconCalendarCheck();
  bindEvents();
  checkApiStatus();
  // 預載宏觀快取（背景計時器每 15 秒會自動掃描，不需在 init 立即呼叫 recordSignalsFromScan）
  _prefetchMacroCache();
}

async function _prefetchMacroCache() {
  try {
    const [fg, gm] = await Promise.all([fetchFearGreed(), fetchGlobalMarket()]);
    if (fg || gm) _macroCache = { ...(gm || {}), fg };
  } catch (e) {}
}

/* ── Service Worker 後台通知 ────────────────────────────────── */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // 等待 SW 激活後同步設定
    const doSync = () => syncSettingsToSW();
    if (reg.active) {
      doSync();
    } else {
      const candidate = reg.installing || reg.waiting;
      if (candidate) candidate.addEventListener('statechange', e => { if (e.target.state === 'activated') doSync(); });
    }
    // 請求週期性後台同步（Chrome PWA / Android）
    if ('periodicSync' in reg) {
      try {
        const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (perm.state === 'granted') {
          await reg.periodicSync.register('csp-check', { minInterval: 5 * 60 * 1000 });
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[SW] 註冊失敗', e);
  }
}

function syncSettingsToSW() {
  if (!navigator.serviceWorker?.controller) return;
  const s = loadSettings();
  navigator.serviceWorker.controller.postMessage({
    type: 'SYNC_SETTINGS', settings: s, pairs: loadPairs(),
  });
  const cache = JSON.parse(localStorage.getItem(SIGNAL_CACHE_KEY) || '{}');
  navigator.serviceWorker.controller.postMessage({ type: 'SYNC_CACHE', cache });
}

/* ── 加載動畫 ───────────────────────────────────────────────── */
function animateLoadingBar() {
  const bar   = document.getElementById('loading-bar');
  const texts = ['正在連接幣安行情...', '正在獲取 K 線數據...', '正在計算 RSI / ADX / EMA...', '正在分析趨勢信號...'];
  let p = 0, t = 0;
  setInterval(() => {
    p = Math.min(p + randBetween(4, 10), 90);
    bar.style.width = p + '%';
    if (t < texts.length) document.getElementById('loading-text').textContent = texts[t++];
  }, 500);
}
function randBetween(a, b) { return a + Math.random() * (b - a); }

/* ── 掃描進度條（K線批次加載時顯示）─────────────────────────── */
function updateScanProgress(pct) {
  const bar  = document.getElementById('scan-bar-fill');
  const txt  = document.getElementById('scan-bar-txt');
  const wrap = document.getElementById('scan-bar');
  if (!bar || !wrap) return;
  wrap.style.display = 'flex';
  bar.style.width    = pct + '%';
  if (txt) txt.textContent = `正在分析 ${Math.round(pct)}% 交易對...`;
}
function hideScanBar() {
  const wrap = document.getElementById('scan-bar');
  if (wrap) wrap.style.display = 'none';
}

function hideLoading() {
  document.getElementById('loading-bar').style.width = '100%';
  setTimeout(() => document.getElementById('loading-overlay').classList.add('hide'), 400);
}

/* ── 極端反轉背景輪掃：自動更新 BTC / ETH 頂/底反轉分析 ────────
   只追蹤 BTC 與 ETH 兩大主流幣（各需 6 次 K 線請求），每輪都更新，
   讓 Telegram 每日簡報與通知能取得最新反轉信心，無需手動開啟詳情頁 */
async function backgroundExtremeRevScan() {
  if (_erScanRunning) return;
  if (!state.data || !state.data.length) return;
  _erScanRunning = true;
  try {
    const coins = state.data.filter(c =>
      c?.symbol === 'BTC/USDT' || c?.symbol === 'ETH/USDT');
    for (let n = 0; n < coins.length; n++) {
      const coin = coins[n];
      if (!coin?.symbol) continue;
      try {
        const mtfData = await fetchMTFKlines(coin.symbol);
        const er = detectExtremeReversal(
          coin, mtfData,
          coin.derivData || null,
          _macroCache || null,
          coin.whaleData || null,
          _macroCache?.fg || null
        );
        if (!_tradeSetupCache[coin.symbol]) _tradeSetupCache[coin.symbol] = {};
        _tradeSetupCache[coin.symbol].extremeRev = er;
        _tradeSetupCache[coin.symbol].extremeRevTime = Date.now();
      } catch(e) { /* 單一幣種失敗不中斷輪掃 */ }
      // 批內限流，避免瞬間打滿 K 線 API
      await new Promise(r => setTimeout(r, 700));
    }
  } finally { _erScanRunning = false; }
}

/* ── 自动刷新 ───────────────────────────────────────────────── */
function startRefreshCycle() {
  clearInterval(state.refreshTimer);
  clearInterval(state.countdownTimer);

  // 持續背景掃描：每 30 秒掃描所有幣種交易建議，與頁面無關
  clearInterval(_bgScanTimer);
  _bgScanTimer = setInterval(() => {
    if (!state.data || !state.data.length) return;
    try { recordSignalsFromScan(state.data); } catch(e) {}
    try { updateOpenTrades(state.data); } catch(e) {}
    if (state.currentPage === 'positions') {
      try { renderPositionsPage(); } catch(e) {}
    }
  }, 15000);

  // 極端反轉背景輪掃：台灣時間 00/06/12/18 時（UTC 16/22/04/10）每 6 小時更新 BTC/ETH
  clearTimeout(_erScanTimer);
  _erScanTimer = null;
  (function scheduleErScan() {
    const nowUTC = Date.now();
    const d = new Date(nowUTC);
    // 台灣時間 00/06/12/18 = UTC 16/22/04/10
    const scanHoursUTC = [4, 10, 16, 22];
    const todayBase = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    // 下一個掃描點
    let msToNext = Infinity;
    for (const h of scanHoursUTC) {
      const t = todayBase + h * 3600000;
      if (t > nowUTC) msToNext = Math.min(msToNext, t - nowUTC);
    }
    if (msToNext === Infinity) msToNext = todayBase + 86400000 + scanHoursUTC[0] * 3600000 - nowUTC;
    _erScanTimer = setTimeout(() => {
      backgroundExtremeRevScan().then(() => renderErDashboardWidget()).catch(e => console.warn('[er-scan]', e));
      scheduleErScan();
    }, msToNext);
    // 找最近一個已過的掃描點；若尚未掃描則立即執行
    let lastScanPoint = 0;
    for (const h of scanHoursUTC) {
      const t = todayBase + h * 3600000;
      if (t <= nowUTC) lastScanPoint = Math.max(lastScanPoint, t);
    }
    if (lastScanPoint === 0) lastScanPoint = todayBase - 86400000 + scanHoursUTC[3] * 3600000;
    if ((_tradeSetupCache['BTC/USDT']?.extremeRevTime || 0) < lastScanPoint) {
      setTimeout(() => backgroundExtremeRevScan().then(() => renderErDashboardWidget()).catch(e => console.warn('[er-scan-init]', e)), 5000);
    }
  })();

  const secs = state.settings.refreshInterval || 60;
  state.countdown = secs;
  updateCountdown();

  state.countdownTimer = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    updateCountdown();
  }, 1000);

  state.refreshTimer = setInterval(async () => {
    if (state.scanning) return; // 上次掃描還沒結束，跳過
    state.scanning = true;
    state.countdown = secs;
    updateScanProgress(0);
    let data, source;
    try {
      const result = await fetchMarketData(state.timeframe);
      data   = result.data;
      source = result.source;
    } catch(e) {
      console.error('[refresh] 自動刷新失敗:', e);
      hideScanBar();
      state.scanning = false;
      return;
    }
    // 資料取得成功，後續渲染步驟各自保護
    state.data       = data;
    state.dataSource = source;
    refreshPionexPrices().catch(() => {});
    hideScanBar();
    try { applyFilters(); renderAll(); } catch(e) { console.error('[refresh] renderAll 錯誤:', e); }
    // 先渲染持倉頁面（使用更新前的資料），避免 updateOpenTrades 刪除後顯示空白
    try { if (state.currentPage === 'positions') renderPositionsPage(); } catch(e) {}
    let _cancelled1 = new Set();
    try { checkAndSendAlerts(data); } catch(e) { console.error('[refresh] checkAndSendAlerts 錯誤:', e); }
    try { _cancelled1 = updateOpenTrades(data) || new Set(); } catch(e) { console.error('[refresh] updateOpenTrades 錯誤:', e); }
    // 確保宏觀快取就緒，避免掃描時因 _macroCache 為 null 觸發震盪模式封鎖
    if (!_macroCache) {
      try {
        const [_rfg, _rgm] = await Promise.all([fetchFearGreed(), fetchGlobalMarket()]);
        if (_rfg || _rgm) _macroCache = { ...(_rgm || {}), fg: _rfg };
      } catch(_re) {}
    }
    try { recordSignalsFromScan(data); } catch(e) { console.error('[refresh] recordSignalsFromScan 錯誤:', e); }
    try { checkPostDataReversal(data); } catch(e) { console.error('[refresh] checkPostDataReversal 錯誤:', e); }
    // 自動掃描長線/短線狀態變化（異步，不阻塞主掃描；每幣種 30 分鐘最多一次）
    backgroundMonitorLongTermStatus().catch(e => console.warn('[ltMonitor] 掃描錯誤:', e));
    try {
      // 掃描完成後重新渲染持倉頁面（含新增信號），同時刷新因取消而需更新的幣種詳情
      if (state.currentPage === 'positions') renderPositionsPage();
      if (state.currentPage === 'coin' && state.currentCoin && _cancelled1.has(state.currentCoin)) {
        renderCoinDetail(state.currentCoin);
      }
    } catch(e) { console.error('[refresh] 頁面渲染錯誤:', e); }
    const srcLabel = source === 'api' ? '本地 API 實時' : source === 'binance' ? '幣安 K 線實時' : '離線演示數據';
    showToast(`市場數據已刷新（${srcLabel}）`, 'info');
    state.scanning = false;
  }, secs * 1000);
}

function updateCountdown() {
  const el = document.getElementById('refresh-countdown');
  if (el) el.textContent = state.countdown + '秒';
}

async function manualRefresh() {
  if (state.scanning) { showToast('掃描進行中，請稍候', 'info'); return; }
  clearInterval(state.refreshTimer);
  clearInterval(state.countdownTimer);
  state.scanning = true;
  const secs = state.settings.refreshInterval || 60;
  state.countdown = secs;
  updateCountdown();

  let data, source;
  try {
    const result = await fetchMarketData(state.timeframe);
    data   = result.data;
    source = result.source;
  } catch(e) {
    console.error('[manualRefresh] 資料取得失敗:', e);
    hideScanBar();
    showToast('刷新失敗，請重試', 'error');
    state.scanning = false;
    startRefreshCycle();
    return;
  }

  // 資料取得成功，後續渲染步驟各自保護
  state.data       = data;
  state.dataSource = source;
  hideScanBar();
  try { applyFilters(); renderAll(); } catch(e) { console.error('[manualRefresh] renderAll 錯誤:', e); }
  let _cancelled2 = new Set();
  try { checkAndSendAlerts(data); } catch(e) { console.error('[manualRefresh] checkAndSendAlerts 錯誤:', e); }
  try { _cancelled2 = updateOpenTrades(data) || new Set(); } catch(e) { console.error('[manualRefresh] updateOpenTrades 錯誤:', e); }
  // 確保宏觀快取就緒，避免掃描時因 _macroCache 為 null 觸發震盪模式封鎖
  if (!_macroCache) {
    try {
      const [_rfg2, _rgm2] = await Promise.all([fetchFearGreed(), fetchGlobalMarket()]);
      if (_rfg2 || _rgm2) _macroCache = { ...(_rgm2 || {}), fg: _rfg2 };
    } catch(_re2) {}
  }
  try { recordSignalsFromScan(data); } catch(e) { console.error('[manualRefresh] recordSignalsFromScan 錯誤:', e); }
  try { checkPostDataReversal(data); } catch(e) { console.error('[manualRefresh] checkPostDataReversal 錯誤:', e); }
  try {
    if (state.currentPage === 'positions') renderPositionsPage();
    if (state.currentPage === 'coin' && state.currentCoin && _cancelled2.has(state.currentCoin)) {
      renderCoinDetail(state.currentCoin);
    }
  } catch(e) { console.error('[manualRefresh] 頁面渲染錯誤:', e); }
  const srcLabel = source === 'api' ? '本地 API 實時' : source === 'binance' ? '幣安 K 線實時' : '離線演示數據';
  showToast(`手動刷新完成（${srcLabel}）`, 'success');
  state.scanning = false;
  startRefreshCycle();
}

function computeLongTermBias(mtfData) {
  // 長線單條件：日線 AND 週線都確認同方向（用戶明確要求：日線+週線確定才算長線）
  // 日線或週線缺失 → 不觸發長線單
  const daySig  = mtfData['1d']?.signal;
  const weekSig = mtfData['1w']?.signal;
  if (!daySig || !weekSig) return 'neutral';  // 必須同時有日線和週線

  const dayBull  = daySig.signal?.includes('bull');
  const dayBear  = daySig.signal?.includes('bear');
  if (!dayBull && !dayBear) return 'neutral';  // 日線中性 → 不觸發長線單

  const weekBull = weekSig.signal?.includes('bull');
  const weekBear = weekSig.signal?.includes('bear');
  if (!weekBull && !weekBear) return 'neutral';  // 週線中性 → 不觸發長線單

  // 日線 AND 週線必須方向一致（月線為額外加分）
  if (!dayBull && weekBull) return 'neutral';
  if (!dayBear && weekBear) return 'neutral';

  // 加權評分（月線 > 週線 > 日線），月線額外加成
  const monSig  = mtfData['1M']?.signal;
  const monBull  = monSig?.signal?.includes('bull');
  const monBear  = monSig?.signal?.includes('bear');
  let bull = 0, bear = 0;
  const weights = { '1d': 1, '1w': 3, '1M': 4 };
  for (const [tf, w] of Object.entries(weights)) {
    const sig = mtfData[tf]?.signal;
    if (!sig) continue;
    if (sig.signal?.includes('bull')) bull += w;
    if (sig.signal?.includes('bear')) bear += w;
    const rsi = sig.rsi || 50;
    if (rsi < 42) bull += w * 0.4;
    if (rsi > 58) bear += w * 0.4;
  }

  // 日線+週線確認 + 加權分數達標
  if (dayBull && weekBull && bull >= 3 && bull > bear * 1.2) return 'long';
  if (dayBear && weekBear && bear >= 3 && bear > bull * 1.2) return 'short';
  return 'neutral';
}

/* ── 事件绑定 ───────────────────────────────────────────────── */
function bindEvents() {
  // 时间周期按钮
  document.querySelectorAll('.tf-btn[data-tf]').forEach(btn => {
    btn.addEventListener('click', () => selectTimeframe(btn.dataset.tf));
  });

  // 筛选标签
  document.querySelectorAll('.chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => setFilter(chip.dataset.filter));
  });

  // 統一幣種搜索（排名頁）
  const dSearch = document.getElementById('dash-search');
  if (dSearch) dSearch.addEventListener('input', () => {
    state.dashSearch = dSearch.value.trim().toUpperCase();
    applyFilters();
    renderDashboardTables();
    renderBullBearTables();
    renderRankingTable();
  });

  // 顶部搜索框
  const navInput = document.getElementById('nav-search-input');
  const dropdown = document.getElementById('search-dropdown');
  if (navInput) {
    navInput.addEventListener('input', () => updateSearchDropdown(navInput.value));
    navInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { dropdown.classList.remove('open'); navInput.value = ''; }
    });
    document.addEventListener('click', e => {
      if (!navInput.closest('.nav-search-wrap').contains(e.target)) dropdown.classList.remove('open');
    });
  }

  // 表头排序
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => sortTable(th.dataset.tbl, th.dataset.sort, th));
  });

  // 图表时间周期
  document.querySelectorAll('.tf-btn[data-ctf]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn[data-ctf]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadTradingViewChart(state.currentCoin, btn.dataset.ctf);
    });
  });

  // 设置联动
  document.getElementById('s-timeframe')?.addEventListener('change', e => {
    state.settings = saveSettings({ timeframe: e.target.value });
    selectTimeframe(e.target.value);
  });
  document.getElementById('s-refresh')?.addEventListener('change', e => {
    state.settings = saveSettings({ refreshInterval: parseInt(e.target.value) });
    startRefreshCycle();
    showToast('刷新间隔已更新', 'success');
  });
  document.getElementById('s-dark')?.addEventListener('change', e => {
    state.settings = saveSettings({ darkMode: e.target.checked });
  });
  document.getElementById('s-reversals')?.addEventListener('change', e => {
    state.settings = saveSettings({ reversals: e.target.checked });
  });
}

/* ── 页面路由 ───────────────────────────────────────────────── */
function navigateTo(page, coinSymbol) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-link[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });

  state.currentPage = page;

  if (page === 'coin' && coinSymbol) {
    state.currentCoin = coinSymbol;
    renderCoinDetail(coinSymbol);
    const coinLink = document.getElementById('nav-coin-link');
    if (coinLink) { coinLink.style.display = 'flex'; coinLink.classList.add('active'); }
  } else {
    const coinLink = document.getElementById('nav-coin-link');
    if (coinLink) coinLink.style.display = 'none';
  }

  if (page === 'dashboard') loadDashboardMacro();
  if (page === 'ranking') {
    renderRankingTable();
    renderDashboardTables();
    renderReversalCards();
  }
  if (page === 'settings') populateSettingsPage();
  if (page === 'positions') {
    renderPositionsPage();
    if (_positionsScanTimer) clearInterval(_positionsScanTimer);
    _positionsScanTimer = setInterval(() => {
      if (state.data && state.data.length) {
        try { recordSignalsFromScan(state.data); } catch(e) {}
        try { updateOpenTrades(state.data); } catch(e) {}
      }
      try { renderPositionsPage(); } catch(e) {}
    }, 10000);
  } else if (_positionsScanTimer) {
    clearInterval(_positionsScanTimer);
    _positionsScanTimer = null;
  }
  if (page === 'tradelog') renderTradeLogPage();
  if (page === 'report')   renderReportPage();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleMobileMenu() {
  document.getElementById('mobile-drawer').classList.toggle('open');
  document.getElementById('drawer-overlay').classList.toggle('open');
}

/* ── 时间周期 ───────────────────────────────────────────────── */
function selectTimeframe(tf) {
  state.timeframe = tf;
  state.settings  = saveSettings({ timeframe: tf });

  document.querySelectorAll('.tf-btn[data-tf]').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === tf);
  });

  if (state.currentPage === 'coin' && state.currentCoin) {
    loadTradingViewChart(state.currentCoin, tfToTV(tf));
  }

  /* 切換時間周期時重新獲取 K 線數據並重算指標 */
  if (!state.scanning) {
    state.scanning = true;
    updateScanProgress(0);
    showToast(`正在重新掃描 ${tf} 週期 K 線數據...`, 'info');
    fetchMarketData(tf).then(({ data, source }) => {
      state.data       = data;
      state.dataSource = source;
      state.scanning   = false;
      hideScanBar();
      applyFilters();
      renderAll();
      checkApiStatus();
    });
  }
}

function tfToTV(tf) {
  const map = { '5m': '5', '15m': '15', '1h': '60', '4h': '240' };
  return map[tf] || '15';
}

/* ── 筛选 ───────────────────────────────────────────────────── */
function setFilter(filter) {
  state.activeFilter = filter;
  document.querySelectorAll('.chip[data-filter]').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === filter);
  });
  applyFilters();
  renderDashboardTables();
  renderBullBearTables();
  renderRankingTable();
}

function applyFilters() {
  let result = [...state.data];
  if (state.activeFilter !== 'all') {
    result = result.filter(d => d.trend === state.activeFilter);
  }
  if (state.dashSearch) {
    const q = state.dashSearch.toUpperCase();
    result = result.filter(d => d.symbol.replace('/USDT','').includes(q));
  }
  state.filtered = result;
}

/* ── 全量渲染 ───────────────────────────────────────────────── */
function renderAll() {
  applyFilters();
  updateOverviewCards();
  renderDashboardTables();
  renderBullBearTables();
  renderReversalCards();
  const srcTag = state.dataSource === 'api' ? '本地API'
               : state.dataSource === 'binance' ? '币安实时'
               : '演示数据';
  const el = document.getElementById('last-updated');
  if (el) el.textContent = new Date().toLocaleTimeString('zh-CN') + ' · ' + srcTag;
}

/* ── 概览卡片 ───────────────────────────────────────────────── */
function updateOverviewCards() {
  const d       = state.data;
  const bullish = d.filter(x => x.trend === '看漲' || x.trend === '強勢看漲').length;
  const bearish = d.filter(x => x.trend === '看跌' || x.trend === '強勢看跌').length;
  const neutral = d.filter(x => x.trend === '中性' || x.trend === 'Neutral').length;

  animateCount('ov-total',   d.length);
  animateCount('ov-bull',    bullish);
  animateCount('ov-bear',    bearish);
  animateCount('ov-neutral', neutral);
}

function animateCount(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const dur   = 600, step = 16;
  let elapsed = 0;
  const iv = setInterval(() => {
    elapsed += step;
    const p = Math.min(elapsed / dur, 1);
    el.textContent = Math.round(start + (target - start) * (1 - Math.pow(1 - p, 3)));
    if (p >= 1) clearInterval(iv);
  }, step);
}

/* ── 篩選 / 搜尋結果表格 ────────────────────────────────────── */
function renderDashboardTables() {
  const hasFilter = state.activeFilter !== 'all';
  const hasSearch = !!state.dashSearch;
  const source    = state.filtered;

  const searchWrap = document.getElementById('search-results-wrap');
  if (!searchWrap) return;

  if (!hasFilter && !hasSearch) {
    searchWrap.style.display = 'none';
    return;
  }

  searchWrap.style.display = '';

  const filterLabel = {
    '強勢看漲': '強勢看漲幣種', '看漲': '看漲幣種',
    '中性': '中性幣種', '看跌': '看跌幣種', '強勢看跌': '強勢看跌幣種',
  };
  const dotColors = {
    '強勢看漲': 'var(--bull)', '看漲': 'var(--bull)',
    '中性': 'var(--neutral)', '看跌': 'var(--bear)', '強勢看跌': 'var(--bear)',
  };

  const titleEl = document.getElementById('search-results-title');
  const cntEl   = document.getElementById('search-results-count');
  const dotEl   = document.getElementById('search-dot');
  if (titleEl) titleEl.textContent = hasSearch
    ? `「${state.dashSearch}」搜尋結果`
    : (filterLabel[state.activeFilter] || '篩選結果');
  if (cntEl) cntEl.textContent = source.length;
  if (dotEl) dotEl.style.background = hasSearch
    ? 'var(--blue)'
    : (dotColors[state.activeFilter] || 'var(--text3)');

  const tbody = document.getElementById('all-tbody');
  if (!tbody) return;
  if (source.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:28px">找不到匹配的幣種</td></tr>`;
  } else {
    tbody.innerHTML = sortArr([...source], 'score', 'desc').map(row => buildDashRow(row)).join('');
  }
}

/* ── 看漲 / 看跌排名（市場排名頁）──────────────────────────── */
function renderBullBearTables() {
  const data     = state.data;
  let bullData   = data.filter(d => d.trend === '強勢看漲' || d.trend === '看漲');
  let bearData   = data.filter(d => d.trend === '強勢看跌' || d.trend === '看跌');
  bullData = sortArr(bullData, state.sortState.bull.key, state.sortState.bull.dir);
  bearData = sortArr(bearData, state.sortState.bear.key, state.sortState.bear.dir);

  const bullCount = document.getElementById('bull-count');
  const bearCount = document.getElementById('bear-count');
  if (bullCount) bullCount.textContent = bullData.length;
  if (bearCount) bearCount.textContent = bearData.length;
  renderTableBody('bull-tbody', bullData);
  renderTableBody('bear-tbody', bearData);
}

function buildDashRow(row) {
  const chg = parseFloat(row.change24h) || 0;
  const chgColor = chg > 0 ? 'var(--bull)' : chg < 0 ? 'var(--bear)' : 'var(--text3)';
  const chgSign  = chg > 0 ? '+' : '';
  return `<tr onclick="navigateTo('coin','${row.symbol}')">
    <td class="sym-cell">
      <span class="sym-base">${row.symbol.replace('/USDT','')}</span>
      <span class="sym-quote">/USDT</span>
    </td>
    <td class="price-cell">${fmtPrice(row.price)}</td>
    <td><span class="trend-badge ${trendClass(row.trend)}">${trendArrow(row.trend)} ${row.trend}</span></td>
    <td><span class="vol-chip vol-${volClass(row.volumeStrength)}">${fmtVol(row.volume)}</span></td>
    <td style="color:${chgColor};font-weight:600;white-space:nowrap">${chgSign}${chg.toFixed(2)}%</td>
  </tr>`;
}

function fmtVol(v) {
  v = parseFloat(v) || 0;
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}

function renderTableBody(tbodyId, rows) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:24px">暫無數據</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.slice(0, 25).map(row => buildDashRow(row)).join('');
}

/* ── 市场排名表（巨鯨+籌碼聚集前20）─────────────────────────── */
function whaleVPScore(row) {
  const dirStrength = Math.abs((parseFloat(row.score) || 50) - 50);
  const trendPower  = parseFloat(row.adx) || 20;
  const volNorm     = Math.min(1, Math.log10((parseFloat(row.volume) || 1) + 1) / 10);
  return dirStrength * trendPower * (0.5 + volNorm * 0.5);
}

function renderRankingTable() {
  const tbody = document.getElementById('ranking-tbody');
  if (!tbody) return;

  let rows = [...state.data];
  if (state.activeFilter !== 'all') rows = rows.filter(d => d.trend === state.activeFilter);
  if (state.dashSearch) rows = rows.filter(d => d.symbol.replace('/USDT','').includes(state.dashSearch));

  rows = rows
    .map(r => ({ ...r, _wv: whaleVPScore(r) }))
    .sort((a, b) => b._wv - a._wv)
    .slice(0, 20);

  tbody.innerHTML = rows.map((row, i) => {
    const wvPct   = Math.min(100, (row._wv / 1250) * 100);
    const wvColor = row.score >= 60 ? 'var(--bull)' : row.score <= 40 ? 'var(--bear)' : 'var(--neutral)';
    const wvLabel = row.score >= 60 ? '看多集中' : row.score <= 40 ? '看空集中' : '中性';
    return `
    <tr onclick="navigateTo('coin','${row.symbol}')">
      <td class="rank-cell">${i + 1}</td>
      <td class="sym-cell">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,var(--blue-dim),rgba(0,230,118,0.08));
            display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;color:var(--blue)">
            ${row.symbol.replace('/USDT','').slice(0,3)}
          </div>
          <div>
            <div style="font-weight:600">${row.symbol.replace('/USDT','')}</div>
            <div style="font-size:0.72rem;color:var(--text3)">USDT</div>
          </div>
        </div>
      </td>
      <td class="price-cell">${fmtPrice(row.price)}</td>
      <td><span class="trend-badge ${trendClass(row.trend)}">${trendArrow(row.trend)} ${row.trend}</span></td>
      <td>
        <div style="display:flex;flex-direction:column;gap:3px">
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;height:5px;background:rgba(255,255,255,0.06);border-radius:3px;min-width:60px">
              <div style="height:100%;width:${wvPct}%;background:${wvColor};border-radius:3px;transition:width .3s"></div>
            </div>
            <span style="font-size:0.7rem;color:${wvColor};font-weight:600;min-width:44px">${wvLabel}</span>
          </div>
          <div style="font-size:0.7rem;color:var(--text3)">ADX ${row.adx} · 評分 ${row.score}</div>
        </div>
      </td>
      <td style="color:${rsiColor(row.rsi)}">${row.rsi}</td>
      <td style="color:var(--text2);font-size:0.82rem">${fmtVolume(row.volume)}</td>
    </tr>`;
  }).join('');
}

/* ── 反转机会卡片 ───────────────────────────────────────────── */
function renderReversalCards() {
  const grid = document.getElementById('reversal-grid');
  if (!grid) return;

  if (!state.settings.reversals) {
    grid.innerHTML = '<div class="rev-placeholder">反转提醒已在设置中关闭。</div>';
    document.getElementById('rev-count').textContent = '0';
    return;
  }

  const reversals = state.data.filter(d => {
    if (d.trend === '強勢看漲' && d.rsi < 50) return true;
    if (d.trend === '強勢看跌' && d.rsi > 50) return true;
    if (d.trend === '看跌' && d.rsi > 55 && d.adx > 20) return true;
    if (d.trend === '看漲' && d.rsi < 45 && d.adx > 20) return true;
    return false;
  }).slice(0, 20);

  document.getElementById('rev-count').textContent = reversals.length;

  if (reversals.length === 0) {
    grid.innerHTML = '<div class="rev-placeholder">当前未检测到反转信号。</div>';
    return;
  }

  grid.innerHTML = reversals.map(d => {
    const fromTrend = d.trend;
    const toTrend   = d.trend.includes('看漲') ? '看跌' : '看漲';
    return `
      <div class="rev-card" onclick="navigateTo('coin','${d.symbol}')">
        <div class="rev-sym">${d.symbol.replace('/USDT','')} <span style="color:var(--text3);font-weight:400;font-size:0.8em">/USDT</span></div>
        <div class="rev-info">
          <span class="trend-badge ${trendClass(fromTrend)}" style="padding:2px 7px;font-size:0.72rem">${fromTrend}</span>
          <span class="rev-arrow">⇒</span>
          <span style="font-size:0.8rem;font-weight:600;color:var(--neutral)">${toTrend}？</span>
        </div>
        <div class="rev-score">
          <span>RSI: <span style="color:${rsiColor(d.rsi)};font-family:'JetBrains Mono',monospace">${d.rsi}</span></span>
          <span>评分: <span class="rev-score-val">${d.score}</span></span>
        </div>
      </div>
    `;
  }).join('');
}


/* ── 幣種詳情輔助函數 ────────────────────────────────────────── */

/* ── 衍生品合約面板（資金費率 / 多空比 / OI）──────────────── */
function buildDerivativesPanel(d) {
  if (!d) return '<div class="adv-loading">此幣種暫無合約數據（可能為純現貨幣種）</div>';
  const fr      = (d.fundingRate != null && !isNaN(d.fundingRate)) ? d.fundingRate : null;
  const frPct   = fr != null ? (fr * 100).toFixed(4) : '--';
  const frColor = fr == null ? 'var(--text3)' : fr < -0.005 ? 'var(--bull)' : fr > 0.005 ? 'var(--bear)' : 'var(--neutral)';
  const frTx    = fr == null ? '無法取得費率數據' : fr < 0 ? '空頭支付費率，多頭有利' : fr > 0 ? '多頭支付費率，空頭有利' : '費率中性';
  const topColor = d.topLongRatio > 0.55 ? 'var(--bull)' : d.topLongRatio < 0.45 ? 'var(--bear)' : 'var(--neutral)';
  const takerColor = d.takerBuySell > 1.05 ? 'var(--bull)' : d.takerBuySell < 0.95 ? 'var(--bear)' : 'var(--neutral)';
  return `<div class="deriv-grid">
    <div class="deriv-item">
      <div class="deriv-label">💰 資金費率（8小時）</div>
      <div class="deriv-val" style="color:${frColor}">${frPct}%</div>
      <div class="deriv-sub">${frTx}</div>
    </div>
    <div class="deriv-item">
      <div class="deriv-label">📊 全帳戶多空比</div>
      <div class="deriv-val" style="color:${d.lsRatio > 1 ? 'var(--bull)' : 'var(--bear)'}">
        ${d.lsRatio?.toFixed(2) ?? '--'}
      </div>
      <div class="deriv-sub">多: ${d.longRatio != null ? (d.longRatio*100).toFixed(1)+'%' : '--'} &nbsp;/&nbsp; 空: ${d.shortRatio != null ? (d.shortRatio*100).toFixed(1)+'%' : '--'}</div>
    </div>
    <div class="deriv-item">
      <div class="deriv-label">🏆 頂級交易員持倉</div>
      <div class="deriv-val" style="color:${topColor}">
        多 ${d.topLongRatio != null ? (d.topLongRatio*100).toFixed(1)+'%' : '--'}
      </div>
      <div class="deriv-sub">聰明錢方向指標 — ${d.topLongRatio > 0.55 ? '聰明錢偏多' : d.topLongRatio < 0.45 ? '聰明錢偏空' : '聰明錢中性'}</div>
    </div>
    <div class="deriv-item">
      <div class="deriv-label">⚡ 主動買賣比（Taker）</div>
      <div class="deriv-val" style="color:${takerColor}">${d.takerBuySell?.toFixed(2) ?? '--'}</div>
      <div class="deriv-sub">${d.takerBuySell > 1 ? '主動買盤為主 ▲' : d.takerBuySell < 1 ? '主動賣盤為主 ▼' : '買賣均衡'}</div>
    </div>
    ${d.openInterest > 0 ? `<div class="deriv-item" style="grid-column:1/-1">
      <div class="deriv-label">📈 未平倉合約（OI）</div>
      <div class="deriv-val" style="color:var(--blue)">${fmtVolume(d.openInterest)} USDT</div>
    </div>` : ''}
  </div>`;
}

/* ── 勝率評估橫幅（從 tlog 存儲欄位計算，供持倉頁卡片使用）── */
function _buildHWRBannerFromTrade(t) {
  try {
    const sg   = t.sqGrade || '';
    const sc   = t.sqScore ?? '—';
    const conf = t.conf != null ? t.conf
      : Math.max(0, 100 - Math.min(45, t.learnPenalty || 0) - (t.riskPenalty || 0));
    const adx  = t.adx || 20;
    const _W = [], _P = [];

    // ① 訊號品質
    if (sg === 'SSS')    _P.push('訊號品質 SSS 級（神級）');
    else if (sg === 'SS') _P.push('訊號品質 SS 級（完美）');
    else if (sg === 'S')  _P.push('訊號品質 S 級（頂級）');
    else if (sg === 'A')  _P.push('訊號品質 A 級（優質）');
    else if (sg === 'B') _W.push({ level:'caution', text:`訊號品質 B 級（21因子評分 ${sc} 分）`, source:'AI 訊號品質' });
    else if (sg)         _W.push({ level:'danger',  text:`訊號品質 ${sg} 級（21因子評分 ${sc} 分）`, source:'AI 訊號品質' });

    // ② 風控分（100分制）
    if (conf >= 80)      _P.push(`風控分 ${conf} 分（強勢）`);
    else if (conf >= 60) _W.push({ level:'caution', text:`風控分 ${conf} 分（達門檻，部分風控提示）`, source:'風控分' });
    else                 _W.push({ level:'danger',  text:`風控分 ${conf} 分（低於門檻 60 分）`, source:'風控分' });

    // ③ AI 止損風控
    const lp = t.learnPenalty || 0;
    if (lp >= 20)      _W.push({ level:'danger',  text:`AI 止損風控觸發（扣 -${Math.min(45,lp)} 分）`, source:'AI 止損風控' });
    else if (lp >= 5)  _W.push({ level:'caution', text:`AI 止損風控警告（扣 -${Math.min(45,lp)} 分）`, source:'AI 止損風控' });
    else               _P.push('AI 止損風控通過');

    // ④ AI 趨勢（由 SQ 因子處理，此處僅顯示狀態）
    const atp = t.aiTrendPenalty || 0;
    if (atp >= 12)     _W.push({ level:'caution', text:`AI 多週期趨勢均逆向（SQ 因子已扣分）`, source:'AI 趨勢判斷' });
    else if (atp >= 6) _W.push({ level:'caution', text:`AI 趨勢部分逆向（SQ 因子已反映）`, source:'AI 趨勢判斷' });
    else               _P.push('AI 趨勢方向確認');

    // ⑤ 宏觀（由 SQ 因子處理，此處僅顯示狀態）
    const mp = t.macroPenalty || 0;
    if (mp >= 15)      _W.push({ level:'caution', text:`宏觀逆風強（SQ 因子已扣分）`, source:'宏觀分析' });
    else if (mp >= 8)  _W.push({ level:'caution', text:`宏觀逆風中等（SQ 因子已反映）`, source:'宏觀分析' });
    else               _P.push('宏觀環境無明顯逆風');

    // ⑥ ADX
    const hp = t.hardAdxPenalty || 0;
    if (hp >= 18)      _W.push({ level:'danger',  text:`ADX ${adx} 嚴重偏低（< 18），震盪行情`, source:'技術面' });
    else if (hp > 0 || adx < 22) _W.push({ level:'caution', text:`ADX ${adx} 偏低（< 22），趨勢強度不足`, source:'技術面' });
    else if (adx >= 28) _P.push(`ADX ${adx}（趨勢明確）`);

    const dc = _W.filter(w=>w.level==='danger').length;
    const cc = _W.filter(w=>w.level==='caution').length;
    const isHigh = dc === 0 && cc <= 1 && (sg === 'S' || sg === 'A') && conf >= 60;
    const isLow  = dc >= 1 || cc >= 3;

    if (isHigh) {
      return `<div style="background:rgba(34,197,94,.08);border:1.5px solid rgba(34,197,94,.3);border-radius:10px;padding:9px 13px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
          <span>🏆</span>
          <span style="font-weight:700;color:#22c55e;font-size:0.84rem">高勝率訊號 — 符合頂級交易員進場條件</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${_P.map(p=>`<span style="font-size:0.7rem;color:#22c55e;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);padding:1px 7px;border-radius:20px">✅ ${p}</span>`).join('')}
          ${cc > 0 ? _W.map(w=>`<span style="font-size:0.7rem;color:#f59e0b;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);padding:1px 7px;border-radius:20px">⚠️ ${w.text}</span>`).join('') : ''}
        </div>
      </div>`;
    } else if (isLow) {
      // 低勝率交易已存在於持倉（舊資料）— 僅顯示中性提示，不警告
      return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
        ${_P.map(p=>`<span style="font-size:0.7rem;color:var(--text3);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);padding:1px 7px;border-radius:20px">✅ ${p}</span>`).join('')}
      </div>`;
    } else {
      return `<div style="background:rgba(245,158,11,.07);border:1.5px solid rgba(245,158,11,.3);border-radius:10px;padding:9px 13px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
          <span>⚠️</span>
          <span style="font-weight:700;color:#f59e0b;font-size:0.84rem">中等勝率 — 有條件可進場，建議保守操作</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px">
          ${_W.map(w=>`<div style="font-size:0.77rem;color:${w.level==='danger'?'#ef4444':'#f59e0b'}">${w.level==='danger'?'🚫':'⚠️'} ${w.text}<span style="font-size:0.67rem;color:var(--text3);margin-left:4px">（${w.source}）</span></div>`).join('')}
        </div>
        ${_P.length ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">${_P.map(p=>`<span style="font-size:0.7rem;color:#22c55e;background:rgba(34,197,94,.05);border:1px solid rgba(34,197,94,.15);padding:1px 6px;border-radius:20px">✅ ${p}</span>`).join('')}</div>` : ''}
      </div>`;
    }
  } catch(_e) { return ''; }
}

/* ── SQ 21因子面板（持倉 / 等待進場 共用）────────────────────── */
function buildSQPanelFromTrade(t) {
  try {
    const factors = t.sqFactors;
    if (!factors || !factors.length) return '';
    const grade = t.sqGrade || '?';
    const score = t.sqScore ?? 0;
    const gradeLabel = t.sqGradeLabel || '';
    const conf    = t.conf || 0;
    const rawConf = t.rawConf || conf;
    const gc = { SSS:'#ffffff', SS:'#ff6ef7', S:'#f0c040', A:'#22c55e', B:'#60a5fa', C:'#f59e0b', D:'#ef4444' }[grade] || '#9ca3af';
    const barW  = Math.round(Math.min(100, (score / 22) * 100));
    const pos   = factors.filter(f => f.startsWith('✅'));
    const neg   = factors.filter(f => f.startsWith('❌') || f.startsWith('⚡'));
    const warn  = factors.filter(f => f.startsWith('⚠️'));
    const neut  = factors.filter(f => f.startsWith('⬜'));
    const cClr  = conf >= 60 ? '#22c55e' : conf >= 50 ? '#f59e0b' : '#ef4444';
    return `<div style="background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.2);border-radius:10px;padding:12px 14px;margin-top:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:0.78rem;font-weight:700;color:var(--text2)">📊 訊號品質評分（SQ）</span>
        <span style="font-size:0.8rem;font-weight:800;color:${gc};background:${gc}22;border:1px solid ${gc}55;padding:2px 10px;border-radius:20px">${grade} ${gradeLabel}　${score}分</span>
      </div>
      <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px;margin-bottom:10px">
        <div style="height:100%;width:${barW}%;background:${gc};border-radius:2px"></div>
      </div>
      ${pos.length  ? `<div style="margin-bottom:7px"><div style="font-size:0.7rem;color:#22c55e;font-weight:600;margin-bottom:3px">✅ 同向加分（${pos.length}項）</div>${pos.map(f=>`<div style="font-size:0.73rem;color:#86efac;padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      ${neg.length  ? `<div style="margin-bottom:7px"><div style="font-size:0.7rem;color:#ef4444;font-weight:600;margin-bottom:3px">❌ 逆向扣分（${neg.length}項）</div>${neg.map(f=>`<div style="font-size:0.73rem;color:#fca5a5;padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      ${warn.length ? `<div style="margin-bottom:7px"><div style="font-size:0.7rem;color:#f59e0b;font-weight:600;margin-bottom:3px">⚠️ 偏弱警告（${warn.length}項）</div>${warn.map(f=>`<div style="font-size:0.73rem;color:#fcd34d;padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      ${neut.length ? `<div><div style="font-size:0.7rem;color:var(--text3);font-weight:600;margin-bottom:3px">⬜ 未觸發（${neut.length}項）</div>${neut.map(f=>`<div style="font-size:0.73rem;color:var(--text3);padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      <div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.06);font-size:0.7rem;color:var(--text3)">風控分 <strong style="color:${cClr}">${conf} 分</strong> / 100　門檻 60分　需 A 級以上（≥10分）方可入場</div>
    </div>`;
  } catch(e) { return ''; }
}

/* ── 已開倉時顯示持倉詳情 + 即時損益 ──────────────────────────── */
function buildOpenPositionSetup(t, currentPrice) {
  const isLong   = t.direction === 'long';
  const dirColor = isLong ? 'var(--bull)' : 'var(--bear)';
  const dirLabel = isLong ? '▲ 持倉做多' : '▼ 持倉做空';
  const entry    = t.entry || 0;
  const sl       = t.sl   || 0;
  const tp1      = t.tp1  || 0;
  const tp2      = t.tp2  || 0;
  const risk     = Math.abs(entry - sl) || 1;
  // 最終風控分：優先用 learnPenalty 重算（確保與風控分明細一致）
  const conf     = t.conf != null ? t.conf
    : (t.learnPenalty != null
      ? Math.max(0, Math.round(100 - Math.min(45, t.learnPenalty) - (t.riskPenalty || 0)))
      : Math.max(0, 100 - Math.min(45, t.learnPenalty || 0) - (t.riskPenalty || 0)));
  const confClr  = conf >= 75 ? 'var(--bull)' : conf >= 60 ? '#ff6d00' : 'var(--text3)';
  const ltBias  = t.longTermBias;
  const isLong_ = t.direction === 'long';
  const isLongTermTrade = t.canScaleIn === true;
  const ltTag = isLongTermTrade
    ? ' <span class="lt-tag lt-bull">〔長線單〕</span>'
    : ' <span class="lt-tag" style="background:rgba(251,191,36,.15);border-color:rgba(251,191,36,.35);color:#fbbf24">⚡ 短線單</span>';
  const _openGradeColors = { S:'#f0c040', A:'#22c55e', B:'#60a5fa', C:'#f59e0b', D:'#ef4444' };
  const _openGradeEmojis = { S:'🏆', A:'🥇', B:'🥈', C:'🥉', D:'⚠️' };
  const _openGradeLabels = { S:'頂級訊號', A:'優質訊號', B:'良好訊號', C:'一般訊號', D:'訊號偏弱' };
  const _openEffConf = t.conf != null ? t.conf : Math.max(0, 100 - Math.min(45, t.learnPenalty || 0) - (t.riskPenalty || 0));
  const _openEffGrade = t.sqGrade || (_openEffConf >= 82 ? 'A' : _openEffConf >= 74 ? 'B' : _openEffConf >= 65 ? 'C' : 'D');
  const _openEffLabel = t.sqGradeLabel || _openGradeLabels[_openEffGrade] || '';
  const _openSqTag = (() => {
    const gc = _openGradeColors[_openEffGrade] || '#9ca3af';
    const ge = _openGradeEmojis[_openEffGrade] || '📊';
    return ` <span style="font-size:0.7rem;font-weight:700;background:${gc}22;border:1px solid ${gc}55;color:${gc};padding:2px 7px;border-radius:20px">${ge} AI ${_openEffGrade} ${_openEffLabel}</span>`;
  })();

  // 即時未實現損益
  let unrealHtml = '';
  if (currentPrice && entry) {
    const move    = isLong ? currentPrice - entry : entry - currentPrice;
    const unrealR = move / risk;
    const unrealPct = (move / entry * 100);
    const uClr   = unrealR > 0 ? 'var(--bull)' : unrealR < 0 ? 'var(--bear)' : 'var(--text2)';
    unrealHtml = `
      <div class="open-unreal-row">
        <span style="color:var(--text3);font-size:0.78rem">未實現損益</span>
        <span style="color:${uClr};font-size:1.1rem;font-weight:800">${unrealR >= 0 ? '+' : ''}${unrealR.toFixed(2)} R</span>
        <span style="color:${uClr};font-size:0.85rem">${unrealPct >= 0 ? '+' : ''}${unrealPct.toFixed(2)}%</span>
      </div>`;
  }

  // 進場原因（優先使用陣列，避免內嵌逗號被誤分割）
  const reasons = (t.entryReasons?.length ? t.entryReasons : (t.entryReason || '').split('，')).filter(Boolean);
  const reasonsHtml = reasons.map(r => `<div class="level-desc" style="margin-bottom:3px">• ${r}</div>`).join('');

  // ── 即時 ICT / SMC / SNR + 圖形偵測（從 _tradeSetupCache 讀取，每次開啟詳情頁已更新）──
  let _liveAnalysisHtml = '';
  try {
    const _lc = (typeof _tradeSetupCache !== 'undefined' && t.symbol) ? (_tradeSetupCache[t.symbol] || {}) : {};
    const _lkz  = _lc.killZone || (typeof computeKillZone === 'function' ? computeKillZone() : null);
    const _lob  = _lc.orderBlock;
    const _lob4 = _lc.orderBlock4h;
    const _lfvg = _lc.fvg;
    const _lfv4 = _lc.fvg4h;
    const _lpd  = _lc.premiumDiscount;
    const _lcp  = _lc.chartPat;
    const _lbon = _lc.ictBonus || 0;
    const _lbk  = _lc.breakoutCheck;

    const _lParts = [];

    if (_lkz) {
      const _kzLine = _lkz.quality === 'high'
        ? `🟢 <strong>${_lkz.name}</strong>（${_lkz.desc}）— ICT 黃金進場窗口`
        : _lkz.quality === 'medium'
          ? `🟡 <strong>${_lkz.name}</strong>（${_lkz.desc}）— 波動適中`
          : `⚪ <strong>${_lkz.name}</strong> — 非主力時段`;
      _lParts.push(_kzLine);
    }

    const _obP = [];
    if (_lob)  _obP.push(`1H ${_lob.label} $${fmtPrice(_lob.low)}–$${fmtPrice(_lob.high)}${_lob.priceInOB ? '（✅ 在 OB 內）' : ''}`);
    if (_lob4) _obP.push(`4H ${_lob4.label} $${fmtPrice(_lob4.low)}–$${fmtPrice(_lob4.high)}${_lob4.priceInOB ? '（✅ 在 OB 內）' : ''}`);
    if (_obP.length) _lParts.push(`📦 訂單塊：${_obP.join('；')}`);

    const _fvgP = [];
    if (_lfvg) _fvgP.push(`1H FVG $${fmtPrice(_lfvg.low)}–$${fmtPrice(_lfvg.high)}（${_lfvg.filled ? '已回補' : '⚡ 未回補'}）`);
    if (_lfv4) _fvgP.push(`4H FVG $${fmtPrice(_lfv4.low)}–$${fmtPrice(_lfv4.high)}（${_lfv4.filled ? '已回補' : '⚡ 未回補'}）`);
    if (_fvgP.length) _lParts.push(`📊 FVG 缺口：${_fvgP.join('；')}`);

    if (_lpd) {
      const _pdLine = (isLong && _lpd.idealForLong)
        ? `⚖️ 折扣區（${_lpd.pctInRange.toFixed(0)}%），SMC 多頭最佳位`
        : (!isLong && _lpd.idealForShort)
          ? `⚖️ 溢價區（${_lpd.pctInRange.toFixed(0)}%），SMC 空頭最佳位`
          : `⚖️ ${_lpd.zoneLabel}（${_lpd.pctInRange.toFixed(0)}%），均衡點 $${fmtPrice(_lpd.equilibrium)}`;
      _lParts.push(_pdLine);
    }

    if (_lbon > 0) _lParts.push(`✨ ICT/SMC 結構加成 +${_lbon}%`);

    const _cpP = [];
    if (_lcp) {
      if (_lcp.aligned?.length  > 0) _cpP.push(`✅ ${_lcp.aligned.slice(0,2).map(p => `${p.emoji}${p.name}（${p.status === 'forming' ? '形成中' : '已確認'}）`).join('、')}`);
      if (_lcp.opposing?.length > 0) _cpP.push(`❌ 逆向：${_lcp.opposing.slice(0,2).map(p => `${p.emoji}${p.name}`).join('、')}`);
      if (_lcp.neutral?.length  > 0 && !_lcp.aligned?.length) _cpP.push(`⚠️ 中性：${_lcp.neutral.slice(0,2).map(p => `${p.emoji}${p.name}`).join('、')}，等待突破`);
      if (_lbk && !_lbk.confirmed && _lbk.warn) _cpP.push(`⚡ ${_lbk.warn}`);
      if (!_lcp.patterns?.length) _cpP.push('目前 4H 無明顯圖形形態');
    }

    if (_lParts.length || _cpP.length) {
      _liveAnalysisHtml = `<div style="margin-top:10px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.2);border-radius:8px;padding:10px 13px">
        <div style="font-weight:700;color:#a78bfa;font-size:0.82rem;margin-bottom:6px">🧠 即時 ICT / SMC / SNR 分析</div>
        ${_lParts.length ? `<div style="font-size:0.8rem;line-height:2;color:var(--text2)">${_lParts.map(p => `<div>${p}</div>`).join('')}</div>` : ''}
        ${_cpP.length ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08)">
          <div style="font-weight:600;color:#fbbf24;font-size:0.8rem;margin-bottom:3px">📐 技術圖形偵測（4H）</div>
          <div style="font-size:0.8rem;line-height:2;color:var(--text2)">${_cpP.map(p => `<div>${p}</div>`).join('')}</div>
        </div>` : ''}
      </div>`;
    }
  } catch (_lae) {}

  const fmt = v => v ? fmtPrice(v) : '--';
  const pctStr = (a, b) => {
    if (!a || !b) return '';
    const d = ((b - a) / Math.abs(a) * 100);
    return `<span style="font-size:0.72rem;color:var(--text3);margin-left:4px">${d >= 0 ? '+' : ''}${d.toFixed(2)}%</span>`;
  };

  // 長線單止盈：只顯示最終止盈位（ltTP 或 tp1）；加倉位在回踩後由下方加倉進度區塊顯示
  const ltFinalTP = t.ltTP || tp1;
  const _oRisk = Math.abs(entry - sl) || 1;
  const _oLtR  = (entry && ltFinalTP) ? (Math.abs(ltFinalTP - entry) / _oRisk).toFixed(1) : null;
  const _oTp1R = (entry && tp1) ? (Math.abs(tp1 - entry) / _oRisk).toFixed(1) : null;
  const _oTp2R = (entry && tp2) ? (Math.abs(tp2 - entry) / _oRisk).toFixed(1) : null;
  const tpRows = isLongTermTrade ? `
    <div class="level-row level-tp2" style="border-left:3px solid rgba(34,197,94,.6)">
      <div class="level-tag">🏁 最終止盈</div>
      <div class="level-desc">${t.ltTPReason || t.aiScaleReason || '長線最終目標'}${_oLtR ? `　<span style="color:#22c55e;font-weight:700;font-size:0.78rem">最終 ${_oLtR}R</span>` : ''}</div>
      <div class="level-price-val" style="color:#22c55e">${fmt(ltFinalTP)}${pctStr(entry, ltFinalTP)}</div>
    </div>
    ${t.ltPartialTP ? `<div class="level-row" style="border-left:3px solid rgba(251,191,36,.6)">
      <div class="level-tag">🎯 部分止盈（3R）</div>
      <div class="level-desc">建議在此位置減少50%倉位</div>
      <div class="level-price-val" style="color:#fbbf24">${fmt(t.ltPartialTP)}${pctStr(entry, t.ltPartialTP)}</div>
    </div>` : ''}` : `
    <div class="level-row level-tp1">
      <div class="level-tag">🎯 止盈1</div>
      <div class="level-desc">${t.tp1Reason || '—'}${_oTp1R ? `　<span style="color:#f59e0b;font-size:0.75rem">${_oTp1R}R</span>` : ''}</div>
      <div class="level-price-val">${fmt(tp1)}${pctStr(entry, tp1)}</div>
    </div>
    <div class="level-row" style="border-left:3px solid #22c55e">
      <div class="level-tag">🚀 最終止盈</div>
      <div class="level-desc">${t.tp2Reason || '—'}${_oTp2R ? `　<span style="color:#22c55e;font-weight:700;font-size:0.78rem">最終 ${_oTp2R}R</span>` : ''}</div>
      <div class="level-price-val">${fmt(tp2)}${pctStr(entry, tp2)}</div>
    </div>`;

  return `
    <div class="setup-verdict ${isLong ? 'verdict-long' : 'verdict-short'}">
      <div class="verdict-dir">
        <span class="verdict-arrow">${isLong ? '▲' : '▼'}</span>
        <span class="verdict-label">${dirLabel}</span>
        ${ltTag}${_openSqTag}
        <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">持倉進行中</span>
      </div>
      <div class="verdict-conf-wrap">
        <span style="font-size:0.78rem;color:var(--text3)">風控分</span>
        <div class="conf-bar"><div class="conf-fill" style="width:${conf}%;background:${confClr}"></div></div>
        <span style="color:${confClr};font-weight:700;font-size:0.9rem">${conf} 分</span>${conf < 60 ? '<span style="font-size:0.7rem;color:#f59e0b;margin-left:4px">低於門檻</span>' : ''}
      </div>
      ${isLongTermTrade ? `<div style="font-size:0.7rem;color:#4ade80;margin-top:4px">✅ 日線信號 + 週線信號均同向確認</div>` : ''}
    </div>
    ${_buildHWRBannerFromTrade(t)}
    ${unrealHtml}
    <div class="setup-levels">
      <div class="level-row level-entry">
        <div class="level-tag">📍 進場</div>
        <div class="level-desc" style="flex:1">${reasonsHtml || t.entryReason || '—'}</div>
        <div class="level-price-val">${fmt(entry)}</div>
      </div>
      ${tpRows}
      <div class="level-row level-sl">
        <div class="level-tag">🛑 止損</div>
        <div class="level-desc">${t.slReason || '—'}</div>
        <div class="level-price-val">${fmt(sl)}${pctStr(entry, sl)}</div>
      </div>
    </div>
    ${t.tp1Hit ? '<div style="margin-top:10px;padding:8px 12px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:8px;font-size:0.82rem;color:#22c55e">✅ 止盈一已觸及，止損已自動移至成本價（保本）</div>' : ''}
    ${(() => {
      const sis = (t.scaleIns || []).filter(s => s.status === 'open' || s.status === 'pending');
      if (!sis.length) return '';
      const confirmed = sis.filter(s => s.status === 'open').length;
      return `<div class="scalein-section">
        <div class="scalein-title">📈 加倉進度 ${confirmed}/${sis.length}</div>
        ${sis.map(si => `<div class="scalein-row ${si.status === 'pending' ? 'scalein-pending' : 'scalein-open'}">
          <span class="scalein-num">#${si.seqNum}</span>
          <span class="scalein-badge">${si.status === 'pending' ? '⏳ 等待回踩' : '✅ 已確認'}</span>
          <span>進場 ${fmtPrice(si.entryLevel)}</span>
          <span style="color:var(--bear)">止損 ${fmtPrice(si.sl)}</span>
          <span style="color:var(--bull)">止盈 ${fmtPrice(si.tp1)}</span>
        </div>`).join('')}
      </div>`;
    })()}
    <div style="margin-top:10px;font-size:0.72rem;color:var(--text3)">信號時間：${fmtDateTime(t.timestamp)}　進場確認：<strong style="color:var(--bull)">${t.entryTime ? fmtDateTime(t.entryTime) : '—'}</strong></div>
    ${buildSQPanelFromTrade(t)}`;
}

/* ── 等待進場確認畫面 ────────────────────────────────────────── */
function buildPendingPositionSetup(t, currentPrice) {
  const isLong   = t.direction === 'long';
  const dirColor = isLong ? 'var(--bull)' : 'var(--bear)';
  const dirLabel = isLong ? '▲ 等待做多進場' : '▼ 等待做空進場';
  const entry    = t.entry || 0;
  const sl       = t.sl   || 0;
  const tp1      = t.tp1  || 0;
  const tp2      = t.tp2  || 0;
  const distPct  = entry ? (((currentPrice - entry) / entry) * 100 * (isLong ? 1 : -1)).toFixed(2) : null;
  const distClr  = distPct === null ? 'var(--text3)' : parseFloat(distPct) <= 0.5 ? 'var(--bull)' : 'var(--bear)';
  const _ptTag = t.canScaleIn
    ? `<span style="font-size:0.7rem;font-weight:700;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.35);color:#4ade80;padding:2px 7px;border-radius:20px;margin-left:7px">〔長線單〕</span>`
    : `<span style="font-size:0.7rem;font-weight:700;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.35);color:#fbbf24;padding:2px 7px;border-radius:20px;margin-left:7px">⚡ 短線單</span>`;
  const _gradeColors = { S:'#f0c040', A:'#22c55e', B:'#60a5fa', C:'#f59e0b', D:'#ef4444' };
  const _gradeEmojis = { S:'🏆', A:'🥇', B:'🥈', C:'🥉', D:'⚠️' };
  const _gradeLabels = { S:'頂級訊號', A:'優質訊號', B:'良好訊號', C:'一般訊號', D:'訊號偏弱' };
  // 若 sqGrade 缺失（舊版交易），從風控分反推等級（僅止損/風控扣分）
  const _effConf = t.conf != null ? t.conf : Math.max(0, 100 - Math.min(45, t.learnPenalty || 0) - (t.riskPenalty || 0));
  const _effGrade = t.sqGrade || (_effConf >= 82 ? 'A' : _effConf >= 74 ? 'B' : _effConf >= 65 ? 'C' : 'D');
  const _effLabel = t.sqGradeLabel || _gradeLabels[_effGrade] || '';
  const _sqTag = (() => {
    const gc = _gradeColors[_effGrade] || '#9ca3af';
    const ge = _gradeEmojis[_effGrade] || '📊';
    return `<span style="font-size:0.7rem;font-weight:700;background:${gc}22;border:1px solid ${gc}55;color:${gc};padding:2px 7px;border-radius:20px;margin-left:7px">${ge} AI ${_effGrade} ${_effLabel}</span>`;
  })();

  // 風控分（100分制，直接取 t.conf；fallback 用 learnPenalty 扣分重算）
  const _pLearnDrag = Math.min(45, t.learnPenalty || 0);
  const _pRiskPen = t.riskPenalty || 0;
  // 以儲存的扣分明細重算風控分，確保顯示數字與明細一致
  const _pConf = t.learnPenalty != null
    ? Math.max(0, Math.round(100 - _pLearnDrag - _pRiskPen))
    : (t.conf != null ? t.conf : Math.min(90, t.score || 60));
  const _confBreakdown = (t.learnPenalty != null) ? `
  <div class="conf-breakdown" style="margin-top:10px;padding:9px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;font-size:0.73rem;line-height:1.9">
    <div style="font-weight:700;color:var(--text2);margin-bottom:4px">🛡️ 風控分項明細</div>
    <div>滿分 <strong>100 分</strong></div>
    ${_pLearnDrag > 0 ? `<div style="color:#f59e0b">↳ 止損風控扣分 <strong>-${_pLearnDrag} 分</strong></div>` : '<div style="color:#22c55e">↳ 止損風控通過（無扣分）</div>'}
    ${_pRiskPen > 0 ? `<div style="color:#f97316">↳ 風險評估扣分 <strong>-${_pRiskPen} 分</strong>（${t.riskLevel || ''} ${t.riskScore || 0}/100）</div>` : ''}
    <div style="border-top:1px solid rgba(255,255,255,.08);margin-top:4px;padding-top:4px;font-weight:700">= 風控分：<span style="color:${_pConf >= 80 ? '#22c55e' : _pConf >= 60 ? '#f59e0b' : '#ef4444'}">${_pConf} 分</span></div>
  </div>` : '';

  return `<div class="pending-banner">
    <div class="pending-icon">⏳</div>
    <div>
      <div class="pending-title" style="color:${dirColor}">${dirLabel}${_ptTag}${_sqTag}</div>
      <div class="pending-sub">等待現價觸及進場位後自動確認開倉</div>
    </div>
  </div>
  ${_buildHWRBannerFromTrade(t)}
  <div class="setup-levels" style="margin-top:10px">
    <div class="level-row level-entry">
      <div class="level-tag">📍 進場位</div>
      <div class="level-desc">${distPct !== null ? `現價距進場位 <span style="color:${distClr}">${distPct > 0 ? '+' : ''}${distPct}%</span>` : '計算中…'}</div>
      <div class="level-price-val">${fmtPrice(entry)}</div>
    </div>
    ${(() => {
      const _pRsk = Math.abs(entry - sl) || 1;
      const _pLtTP = t.ltTP || tp1;
      const _pLtR = (entry && _pLtTP) ? (Math.abs(_pLtTP - entry) / _pRsk).toFixed(1) : null;
      const _p1R = (entry && tp1) ? (Math.abs(tp1 - entry) / _pRsk).toFixed(1) : null;
      const _p2R = (entry && tp2) ? (Math.abs(tp2 - entry) / _pRsk).toFixed(1) : null;
      return t.canScaleIn ? `
    <div class="level-row level-tp2" style="border-left:3px solid rgba(34,197,94,.6)">
      <div class="level-tag">🏁 最終止盈</div>
      <div class="level-desc">${t.ltTPReason || t.aiScaleReason || '長線最終目標'}${_pLtR ? `　<span style="color:#22c55e;font-weight:700;font-size:0.78rem">最終 ${_pLtR}R</span>` : ''}</div>
      <div class="level-price-val" style="color:#22c55e">${fmtPrice(_pLtTP)}</div>
    </div>
    ${t.ltPartialTP ? `
    <div class="level-row" style="border-left:3px solid rgba(251,191,36,.6)">
      <div class="level-tag">🎯 部分止盈（3R）</div>
      <div class="level-desc">建議在此位置減少50%倉位</div>
      <div class="level-price-val" style="color:#fbbf24">${fmtPrice(t.ltPartialTP)}</div>
    </div>` : ''}
    <div style="font-size:0.7rem;color:var(--text3);margin-top:4px;padding:5px 10px;background:rgba(99,102,241,.06);border-radius:6px">
      📈 加倉計劃：進場後偵測到回踩時自動顯示，最多 ${t.maxScaleIns || 3} 次
    </div>` : `
    <div class="level-row level-tp1">
      <div class="level-tag">🎯 止盈一</div>
      <div class="level-desc">${t.tp1Reason || '短線目標'}${_p1R ? `　<span style="color:#f59e0b;font-size:0.75rem">${_p1R}R</span>` : ''}</div>
      <div class="level-price-val">${fmtPrice(tp1)}</div>
    </div>
    <div class="level-row level-tp2">
      <div class="level-tag">🚀 最終止盈</div>
      <div class="level-desc">${t.tp2Reason || '波段目標'}${_p2R ? `　<span style="color:#22c55e;font-weight:700;font-size:0.78rem">最終 ${_p2R}R</span>` : ''}</div>
      <div class="level-price-val">${fmtPrice(tp2)}</div>
    </div>`;
    })()}
    <div class="level-row level-sl">
      <div class="level-tag">🛑 止損</div>
      <div class="level-desc">${t.slReason || '結構止損'}</div>
      <div class="level-price-val">${fmtPrice(sl)}</div>
    </div>
  </div>
  ${_confBreakdown}
  <div style="margin-top:10px;font-size:0.72rem;color:var(--text3)">信號時間：${fmtDateTime(t.timestamp)}　有效期至：${fmtDateTime(t.timestamp + SIGNAL_COOLDOWN * 2)}</div>
  ${buildSQPanelFromTrade(t)}`;
}

/* ── ICT Kill Zone 獵殺時段偵測 ────────────────────────────── */
function computeKillZone() {
  const now = new Date();
  const t = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (t >= 1  && t < 4)  return { name: '亞洲獵殺時段',     code: 'asian',  emoji: '🌏', quality: 'medium', desc: '亞洲主力活躍，波動適中' };
  if (t >= 7  && t < 10) return { name: '倫敦開盤獵殺時段', code: 'london', emoji: '🇬🇧', quality: 'high',   desc: '流動性掃蕩高發，方向確認後追進' };
  if (t >= 12 && t < 15) return { name: '紐約開盤獵殺時段', code: 'ny',     emoji: '🗽', quality: 'high',   desc: '最大波動時段，ICT 黃金進場窗口' };
  if (t >= 16 && t < 17) return { name: '倫敦收盤時段',     code: 'lclose', emoji: '🔔', quality: 'low',    desc: '歐洲倉位平倉，注意假突破' };
  return { name: '盤整時段', code: 'off', emoji: '😴', quality: 'low', desc: '非主力時段，等待機會' };
}

/* ── H4 區間結構偵測（3+ 收針拒絕確認區間高低點）─────────────── */
function detectRangeStructure(coin, h4Raw, h4Signal, d1Signal, atr) {
  const price = parseFloat(coin.price) || 0;
  if (!price) return { isRange: false };
  const _atr = atr || h4Signal?.atr || price * 0.012;
  if (!h4Raw || h4Raw.length < 20) {
    const _sH = h4Signal?.swingHigh || d1Signal?.swingHigh;
    const _sL = h4Signal?.swingLow  || d1Signal?.swingLow;
    if (!_sH || !_sL || _sH - _sL < _atr * 2) return { isRange: false };
    if (price < _sL * 0.98 || price > _sH * 1.02) return { isRange: false };
    return { isRange: true, rangeHigh: _sH, rangeLow: _sL,
      rangeMid: (_sH + _sL) / 2, rangeWidth: _sH - _sL,
      resistanceTouches: 2, supportTouches: 2,
      resistancePinBars: 1, supportPinBars: 1, qualityScore: 1.0 };
  }
  const cc = h4Raw.map(k => ({
    o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]),
    c: parseFloat(k[4]), v: parseFloat(k[5]),
  })).filter(c => c.c > 0);
  if (cc.length < 15) return { isRange: false };
  const tol = _atr * 0.9, rawH = [], rawL = [];
  for (let i = 2; i < cc.length - 2; i++) {
    const c = cc[i];
    const body = Math.max(Math.abs(c.c - c.o), _atr * 0.04);
    const up = c.h - Math.max(c.c, c.o), dn = Math.min(c.c, c.o) - c.l;
    if (c.h > cc[i-1].h && c.h > cc[i-2].h && c.h > cc[i+1].h && c.h > cc[i+2].h)
      rawH.push({ p: c.h, pin: up >= body * 1.5 || up >= _atr * 0.25 });
    if (c.l < cc[i-1].l && c.l < cc[i-2].l && c.l < cc[i+1].l && c.l < cc[i+2].l)
      rawL.push({ p: c.l, pin: dn >= body * 1.5 || dn >= _atr * 0.25 });
  }
  const cluster = pts => {
    const z = [];
    for (const pt of pts) {
      const ex = z.find(zn => Math.abs(zn.p - pt.p) <= tol);
      if (ex) { ex.n++; ex.p = (ex.p * (ex.n - 1) + pt.p) / ex.n; if (pt.pin) ex.pins++; }
      else z.push({ p: pt.p, n: 1, pins: pt.pin ? 1 : 0 });
    }
    return z;
  };
  const resZ = cluster(rawH).filter(z => z.p > price * 1.002);
  const supZ = cluster(rawL).filter(z => z.p < price * 0.998);
  if (!resZ.length || !supZ.length) return { isRange: false };
  const bR = resZ.sort((a, b) => (b.pins * 2 + b.n) - (a.pins * 2 + a.n))[0];
  const bS = supZ.sort((a, b) => (b.pins * 2 + b.n) - (a.pins * 2 + a.n))[0];
  if (!bR || !bS || bR.n < 2 || bS.n < 2) return { isRange: false };
  const rH = bR.p, rL = bS.p, rW = rH - rL;
  if (rW < _atr * 2.0) return { isRange: false };
  if (price < rL * 0.99 || price > rH * 1.01) return { isRange: false };
  const rec = cc.slice(-15);
  if (Math.max(...rec.map(c => c.h)) > rH * 1.025 ||
      Math.min(...rec.map(c => c.l)) < rL * 0.975) return { isRange: false };
  const totN = bR.n + bS.n, totP = bR.pins + bS.pins;
  const qual = Math.min(3, (totN >= 8 ? 2 : totN >= 5 ? 1.5 : 1) + (totP >= 4 ? 1 : totP >= 2 ? 0.5 : 0));
  return { isRange: true, rangeHigh: rH, rangeLow: rL, rangeMid: (rH + rL) / 2,
    rangeWidth: rW, resistanceTouches: bR.n, supportTouches: bS.n,
    resistancePinBars: bR.pins, supportPinBars: bS.pins, qualityScore: qual };
}

/* ── 偵測區間邊緣反轉信號（H4 收針 / 吞噬 / RSI / BB%B）──────── */
function detectRangeReversal(coin, h4Raw, rangeDir, rangeStruct, atr) {
  const rIsLong = rangeDir === 'long';
  const rsi     = parseFloat(coin.rsi) || 50;
  const pctB    = coin.bb?.pctB ?? 0.5;
  const sigs    = [];
  let   str     = 0;
  if (h4Raw && h4Raw.length >= 4) {
    const cc = h4Raw.map(k => ({
      o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]),
      c: parseFloat(k[4]), v: parseFloat(k[5]),
    })).filter(c => c.c > 0);
    if (cc.length >= 4) {
      const lc = cc[cc.length - 2], prev = cc[cc.length - 3];
      const body = Math.max(Math.abs(lc.c - lc.o), atr * 0.04);
      const up   = lc.h - Math.max(lc.c, lc.o), dn = Math.min(lc.c, lc.o) - lc.l;
      if (rIsLong) {
        if      (dn >= body * 1.5) { sigs.push(lc.c > lc.o ? '多頭收針（下影線看漲）' : '多頭收針（下影線拒絕）'); str += dn >= body * 2 ? 2.5 : 2; }
        else if (dn >= body)       { sigs.push('下影線拒絕支撐');   str += 1; }
        if (lc.c > lc.o && lc.o <= prev.c && lc.c >= prev.o) { sigs.push('看漲吞噬'); str += 1.5; }
      } else {
        if      (up >= body * 1.5) { sigs.push(lc.c < lc.o ? '空頭收針（上影線看跌）' : '空頭收針（上影線拒絕）'); str += up >= body * 2 ? 2.5 : 2; }
        else if (up >= body)       { sigs.push('上影線拒絕壓力');   str += 1; }
        if (lc.c < lc.o && lc.o >= prev.c && lc.c <= prev.o) { sigs.push('看跌吞噬'); str += 1.5; }
      }
      const avgV = cc.slice(-10, -2).reduce((a, c) => a + c.v, 0) / 8;
      if (avgV > 0 && lc.v >= avgV * 1.3 && ((rIsLong && lc.c > lc.o) || (!rIsLong && lc.c < lc.o))) {
        sigs.push('量能確認'); str += 0.5;
      }
    }
  }
  if      (rIsLong  && rsi <= 35) { sigs.push(`RSI ${rsi} 超賣`);  str += 1.5; }
  else if (!rIsLong && rsi >= 65) { sigs.push(`RSI ${rsi} 超買`);  str += 1.5; }
  else if (rIsLong  && rsi <= 45) { sigs.push(`RSI ${rsi} 偏低`);  str += 0.5; }
  else if (!rIsLong && rsi >= 55) { sigs.push(`RSI ${rsi} 偏高`);  str += 0.5; }
  if      (rIsLong  && pctB <= 0.20) { sigs.push(`BB%B ${pctB.toFixed(2)} 近下軌`); str += 0.5; }
  else if (!rIsLong && pctB >= 0.80) { sigs.push(`BB%B ${pctB.toFixed(2)} 近上軌`); str += 0.5; }
  return { hasReversal: str >= 2, signals: sigs.length ? sigs : [rIsLong ? '支撐觀察中' : '壓力觀察中'],
    strength: str, pattern: sigs[0] || '' };
}

/* ── 極端頂/底部辨識（多訊號聚合，信心≥98% 才建議反向交易）─────── */
function detectExtremeReversal(coin, mtfData, deriv, globalMkt, whale, fearGreed) {
  const price = parseFloat(coin.price) || 0;
  const rsi   = parseFloat(coin.rsi)   || 50;
  const pctB  = coin.bb?.pctB ?? 0.5;
  const macdH = parseFloat(coin.macdHist) || 0;
  const adxV  = parseFloat(coin.adx) || 20;

  const raw1h = mtfData['1h']?.raw || [];
  const raw4h = mtfData['4h']?.raw || [];
  const raw1d = mtfData['1d']?.raw || [];

  const vol1h  = mtfData['1h']?.volAI    || {};
  const vol4h  = mtfData['4h']?.volAI    || {};
  const of1h   = mtfData['1h']?.orderFlow || {};
  const bb1h_  = mtfData['1h']?.bb        || {};
  const bb4h_  = mtfData['4h']?.bb        || {};
  const h4s    = mtfData['4h']?.signal    || {};
  const d1s    = mtfData['1d']?.signal    || {};
  const w1s    = mtfData['1w']?.signal    || {};
  const tr1h   = mtfData['1h']?.traps     || {};
  const tr4h   = mtfData['4h']?.traps     || {};

  const fgVal  = fearGreed ? parseInt(fearGreed.value || '50') : 50;
  const mktChg = globalMkt?.marketCapChange || 0;

  // Parse candles: [ts, open, high, low, close, vol]
  const pc = raw => (raw || []).map(k => ({
    o: parseFloat(k[1]), h: parseFloat(k[2]),
    l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
  })).filter(c => c.c > 0 && c.h >= c.l);

  // Volume divergence: price makes new extreme but volume shrinks → exhaustion
  const volDiv = raw => {
    const cc = pc(raw);
    if (cc.length < 20) return {};
    const r = cc.slice(-8), o = cc.slice(-18, -8);
    if (!r.length || !o.length) return {};
    const rHi = Math.max(...r.map(c => c.h)), oHi = Math.max(...o.map(c => c.h));
    const rLo = Math.min(...r.map(c => c.l)), oLo = Math.min(...o.map(c => c.l));
    const rV  = r.reduce((s, c) => s + c.v, 0) / r.length;
    const oV  = o.reduce((s, c) => s + c.v, 0) / o.length;
    const vFall = oV > 0 && rV < oV * 0.82;
    const vRise = oV > 0 && rV > oV * 1.20;
    const lc = r[r.length - 1];
    return {
      bearDiv:   rHi > oHi * 1.003 && vFall,
      bullDiv:   rLo < oLo * 0.997 && vFall,
      climaxTop: rHi > oHi * 1.001 && vRise && lc && lc.c < lc.o,
      climaxBot: rLo < oLo * 0.999 && vRise && lc && lc.c > lc.o,
    };
  };

  // Per-candle RSI divergence: compare price swing vs RSI swing
  const rsiDiv = raw => {
    const cc = pc(raw);
    if (cc.length < 30) return { bear: false, bull: false };
    const N = 14;
    const closes = cc.map(c => c.c);
    const rsiArr = [];
    for (let i = N; i < closes.length; i++) {
      let g = 0, l = 0;
      for (let j = i - N + 1; j <= i; j++) {
        const d = closes[j] - closes[j - 1];
        if (d > 0) g += d; else l -= d;
      }
      const ag = g / N, al = l / N;
      rsiArr.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
    }
    if (rsiArr.length < 10) return { bear: false, bull: false };
    const n  = rsiArr.length;
    const sl = cc.slice(cc.length - rsiArr.length);
    const rA = rsiArr.slice(n - 5), rB = rsiArr.slice(n - 10, n - 5);
    const pA = sl.slice(n - 5),     pB = sl.slice(n - 10, n - 5);
    const mxR1 = Math.max(...rA), mxR2 = Math.max(...rB);
    const mnR1 = Math.min(...rA), mnR2 = Math.min(...rB);
    const mxP1 = Math.max(...pA.map(c => c.h)), mxP2 = Math.max(...pB.map(c => c.h));
    const mnP1 = Math.min(...pA.map(c => c.l)), mnP2 = Math.min(...pB.map(c => c.l));
    return {
      bear: mxP1 > mxP2 * 1.003 && mxR1 < mxR2 - 3,
      bull: mnP1 < mnP2 * 0.997 && mnR1 > mnR2 + 3,
    };
  };

  // Reversal candlestick patterns
  const candlePat = (raw, forTop) => {
    const cc = pc(raw);
    if (cc.length < 3) return [];
    const found = [];
    for (let i = Math.max(1, cc.length - 5); i < cc.length; i++) {
      const c = cc[i], p = cc[i - 1];
      const body = Math.abs(c.c - c.o), range = c.h - c.l;
      if (range < 1e-10) continue;
      const upW = c.h - Math.max(c.c, c.o), dnW = Math.min(c.c, c.o) - c.l;
      if (forTop) {
        if (upW >= body * 2 && upW >= range * 0.45)
          found.push(c.c < c.o ? '射擊之星' : '上影線拒壓');
        if (c.c < c.o && p.c > p.o && c.o >= p.c * 0.998 && c.c <= p.o * 1.002)
          found.push('看跌吞噬');
        if (i >= 2) {
          const pp = cc[i - 2];
          if (pp.c > pp.o && body < range * 0.35 && c.c < c.o && c.c < (pp.c + pp.o) / 2)
            found.push('黃昏之星');
        }
      } else {
        if (dnW >= body * 2 && dnW >= range * 0.45)
          found.push(c.c > c.o ? '鎚子線' : '下影線支撐');
        if (c.c > c.o && p.c < p.o && c.o <= p.c * 1.002 && c.c >= p.o * 0.998)
          found.push('看漲吞噬');
        if (i >= 2) {
          const pp = cc[i - 2];
          if (pp.c < pp.o && body < range * 0.35 && c.c > c.o && c.c > (pp.c + pp.o) / 2)
            found.push('晨星');
        }
      }
    }
    return [...new Set(found)];
  };

  // Is current price within 2.5% of historical high/low cluster?
  const atHistLevel = (raw, forTop) => {
    const cc = pc(raw);
    if (cc.length < 40) return false;
    const hist   = cc.slice(-80, -3);
    const levels = forTop ? hist.map(c => c.h) : hist.map(c => c.l);
    levels.sort((a, b) => forTop ? b - a : a - b);
    const avg5 = levels.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
    const pct  = forTop ? (price / avg5 - 1) : (avg5 / price - 1);
    return Math.abs(pct) < 0.025;
  };

  // Build score for one direction
  const scoreDir = forTop => {
    const sigs = [];
    let pts = 0;
    const add = (label, p, cat) => { pts += p; sigs.push({ label, pts: p, cat }); };

    const vd1h = volDiv(raw1h), vd4h = volDiv(raw4h);
    const rd1h = rsiDiv(raw1h), rd4h = rsiDiv(raw4h);
    const cp4h = candlePat(raw4h, forTop), cp1h = candlePat(raw1h, forTop);

    // ── 1. Volume exhaustion / divergence (max 20) ──────────────
    if (forTop) {
      if (vol1h.isClimax && vol1h.bias === 'bull')          add('1H 量能衰竭頂部（極量+小實體，買盤動能耗盡）',  12, 'vol');
      else if (vd1h.climaxTop)                               add('1H 爆量見頂後急跌（買力衰竭型頂部）',           10, 'vol');
      else if (vol1h.isSpike && vol1h.bias === 'bull')       add('1H 買方爆量（末段拉升風險）',                    5, 'vol');
      if (vd1h.bearDiv)                                      add('1H 量能頂部背離（新高但量縮）',                  6, 'vol');
      if (vol4h.isClimax && vol4h.bias === 'bull')           add('4H 量能衰竭頂部確認',                            5, 'vol');
      else if (vd4h.bearDiv)                                 add('4H 量能頂部背離（中週期）',                      3, 'vol');
    } else {
      if (vol1h.isClimax && vol1h.bias === 'bear')           add('1H 量能衰竭底部（極量+小實體，賣盤動能耗盡）',  12, 'vol');
      else if (vd1h.climaxBot)                               add('1H 爆量見底後急漲（賣力衰竭型底部）',           10, 'vol');
      else if (vol1h.isSpike && vol1h.bias === 'bear')       add('1H 賣方爆量（末段殺跌風險）',                    5, 'vol');
      if (vd1h.bullDiv)                                      add('1H 量能底部背離（新低但量縮）',                  6, 'vol');
      if (vol4h.isClimax && vol4h.bias === 'bear')           add('4H 量能衰竭底部確認',                            5, 'vol');
      else if (vd4h.bullDiv)                                 add('4H 量能底部背離（中週期）',                      3, 'vol');
    }

    // ── 2. RSI / MACD / BB momentum divergence (max 22) ────────
    if (forTop) {
      if (rsi > 78)                                          add(`RSI ${rsi} 嚴重超買（歷史頂部常見區間）`,       10, 'momentum');
      else if (rsi > 70)                                     add(`RSI ${rsi} 超買頂部警戒`,                        6, 'momentum');
      if (rd1h.bear)                                         add('1H RSI 頂部背離（價格新高但 RSI 走低）',        10, 'momentum');
      else if (rd4h.bear)                                    add('4H RSI 頂部背離（中週期動能衰退）',              7, 'momentum');
      if (bb1h_?.bbDivBear)                                  add('BB 頂背離（1H 新高未觸上軌）',                   5, 'momentum');
      if (bb4h_?.bbDivBear)                                  add('4H BB 頂背離（中週期頂部）',                     3, 'momentum');
      if (pctB >= 0.95)                                      add(`BB%B ${pctB.toFixed(2)} 極度超買（觸及上軌）`,  5, 'momentum');
      else if (pctB >= 0.85)                                 add(`BB%B ${pctB.toFixed(2)} 近上軌`,                 2, 'momentum');
      if (macdH > 0 && rd1h.bear)                           add('MACD 正值同時出現背離（動能衰竭）',               5, 'momentum');
    } else {
      if (rsi < 22)                                          add(`RSI ${rsi} 嚴重超賣（歷史底部常見區間）`,       10, 'momentum');
      else if (rsi < 30)                                     add(`RSI ${rsi} 超賣底部警戒`,                        6, 'momentum');
      if (rd1h.bull)                                         add('1H RSI 底部背離（價格新低但 RSI 走高）',        10, 'momentum');
      else if (rd4h.bull)                                    add('4H RSI 底部背離（中週期動能復甦）',              7, 'momentum');
      if (bb1h_?.bbDivBull)                                  add('BB 底背離（1H 新低未觸下軌）',                   5, 'momentum');
      if (bb4h_?.bbDivBull)                                  add('4H BB 底背離（中週期底部）',                     3, 'momentum');
      if (pctB <= 0.05)                                      add(`BB%B ${pctB.toFixed(2)} 極度超賣（觸及下軌）`,  5, 'momentum');
      else if (pctB <= 0.15)                                 add(`BB%B ${pctB.toFixed(2)} 近下軌`,                 2, 'momentum');
      if (macdH < 0 && rd1h.bull)                           add('MACD 負值同時出現背離（動能轉強）',               5, 'momentum');
    }

    // ── 3. Price structure & candlestick patterns (max 18) ──────
    if (atHistLevel(raw1d, forTop))                          add(forTop ? '日線歷史壓力區間（±2.5%）' : '日線歷史支撐區間（±2.5%）', 8, 'struct');
    if (atHistLevel(raw4h, forTop))                          add(forTop ? '4H 前高壓力確認' : '4H 前低支撐確認', 4, 'struct');
    if (cp4h.length > 0) {
      const p4 = Math.min(6, cp4h.length * 4);
      add(`4H 反轉K線（${cp4h.join('·')}）`, p4, 'struct');
    }
    if (cp1h.length > 0 && cp4h.length === 0)               add(`1H 反轉K線（${cp1h.join('·')}）`, 3, 'struct');
    if (forTop) {
      if (tr1h.sweepBear || tr4h.sweepBear)                 add('流動性掃蕩後急跌（止損獵殺完成）',               5, 'struct');
      if (tr1h.twoB_Bear)                                    add('雙棒頂部反轉確認',                               3, 'struct');
      if (tr1h.po3Bear)                                      add('PO3 空頭訂單塊確認',                             3, 'struct');
    } else {
      if (tr1h.sweepBull || tr4h.sweepBull)                 add('流動性掃蕩後急漲（止損獵殺完成）',               5, 'struct');
      if (tr1h.twoB_Bull)                                    add('雙棒底部反轉確認',                               3, 'struct');
      if (tr1h.po3Bull)                                      add('PO3 多頭訂單塊確認',                             3, 'struct');
    }

    // ── 4. Order flow (max 15) ────────────────────────────────────
    if (forTop) {
      if (of1h.cvdTrend === 'bear')                         add('訂單流 CVD 轉空（主動賣盤主導）',               7, 'flow');
      else if (of1h.cvdTrend === 'neutral')                  add('訂單流 CVD 中性（買力減弱）',                    2, 'flow');
      const bP = of1h.buyPct ?? 50;
      if (bP <= 38)                                          add(`主動賣方佔比 ${100 - bP}%（強勁賣壓）`,          5, 'flow');
      else if (bP <= 46)                                     add(`買方佔比 ${bP}% 偏弱`,                           2, 'flow');
      if (deriv?.takerBuySell < 0.80)                        add(`Taker 賣盤主導（${(deriv.takerBuySell||1).toFixed(2)}）`, 3, 'flow');
      if (whale?.bias === 'bear' && (whale.bigSellCount || 0) >= 3)
                                                             add(`巨鯨連續賣出（${whale.bigSellCount} 筆）`,       3, 'flow');
    } else {
      if (of1h.cvdTrend === 'bull')                         add('訂單流 CVD 轉多（主動買盤主導）',               7, 'flow');
      else if (of1h.cvdTrend === 'neutral')                  add('訂單流 CVD 中性（賣力減弱）',                    2, 'flow');
      const bP = of1h.buyPct ?? 50;
      if (bP >= 62)                                          add(`主動買方佔比 ${bP}%（強勁買壓）`,               5, 'flow');
      else if (bP >= 54)                                     add(`買方佔比 ${bP}% 偏強`,                           2, 'flow');
      if (deriv?.takerBuySell > 1.20)                        add(`Taker 買盤主導（${(deriv.takerBuySell||1).toFixed(2)}）`, 3, 'flow');
      if (whale?.bias === 'bull' && (whale.bigBuyCount || 0) >= 3)
                                                             add(`巨鯨連續買入（${whale.bigBuyCount} 筆）`,        3, 'flow');
    }

    // ── 5. Sentiment & macro extremes (max 12) ────────────────────
    if (forTop) {
      if (fgVal > 85)                                        add(`恐貪指數 ${fgVal}（極度貪婪 — 歷史頂部區間）`, 7, 'sentiment');
      else if (fgVal > 75)                                   add(`恐貪指數 ${fgVal}（貪婪 — 頂部風險）`,           3, 'sentiment');
      if (mktChg > 5)                                        add(`市值急漲 +${mktChg.toFixed(1)}%（市場過熱）`,   3, 'sentiment');
      else if (mktChg > 2)                                   add(`市值上漲 +${mktChg.toFixed(1)}%（偏熱）`,        1, 'sentiment');
      const dom = globalMkt?.btcDominance || 50;
      if (dom < 42)                                          add(`BTC主導率 ${dom.toFixed(1)}%（山寨季末段過熱）`, 2, 'sentiment');
    } else {
      if (fgVal < 15)                                        add(`恐貪指數 ${fgVal}（極度恐慌 — 歷史底部區間）`, 7, 'sentiment');
      else if (fgVal < 25)                                   add(`恐貪指數 ${fgVal}（恐慌 — 底部風險釋放）`,       3, 'sentiment');
      if (mktChg < -5)                                       add(`市值大跌 ${mktChg.toFixed(1)}%（恐慌拋售）`,    3, 'sentiment');
      else if (mktChg < -2)                                  add(`市值下跌 ${mktChg.toFixed(1)}%（悲觀）`,         1, 'sentiment');
      const dom = globalMkt?.btcDominance || 50;
      if (dom > 60)                                          add(`BTC主導率 ${dom.toFixed(1)}%（資金避險集中）`,   2, 'sentiment');
    }

    // ── 5b. 公開輿論（真實財經新聞頭條情緒，反指邏輯：一面倒 = 反轉風險）──
    try {
      const newsItems = (typeof _newsSentimentCache !== 'undefined' && Array.isArray(_newsSentimentCache)) ? _newsSentimentCache : [];
      if (newsItems.length >= 5) {
        const _48h = Date.now() - 48 * 60 * 60 * 1000;
        const recent = newsItems.filter(n => !n.publishedAt || n.publishedAt >= _48h);
        const pool = recent.length >= 5 ? recent : newsItems;
        const bullN = pool.filter(n => n.sentiment === 'bull' || n.sentiment === 'bullish').length;
        const bearN = pool.filter(n => n.sentiment === 'bear' || n.sentiment === 'bearish').length;
        const total = pool.length;
        const bullPct = total > 0 ? bullN / total : 0;
        const bearPct = total > 0 ? bearN / total : 0;
        if (forTop) {
          // 輿論極端看多 = 市場過熱反指；輿論明顯轉空 = 頂部後續確認
          if (bullPct >= 0.75 && bullN >= 5)      add(`公開輿論一面倒看多（${bullN}/${total} 條新聞，過熱反指訊號）`, 4, 'crowd');
          else if (bullPct >= 0.60 && bullN >= 4) add(`公開輿論偏多（${bullN}/${total} 條，情緒偏熱）`,               2, 'crowd');
          if (bearPct >= 0.55 && bearN >= 4)      add(`新聞輿論已轉空（${bearN}/${total} 條，頂部確認跡象）`,         3, 'crowd');
        } else {
          // 輿論極端看空 = 恐慌投降反指；輿論明顯轉多 = 底部後續確認
          if (bearPct >= 0.75 && bearN >= 5)      add(`公開輿論一面倒看空（${bearN}/${total} 條新聞，恐慌投降反指）`, 4, 'crowd');
          else if (bearPct >= 0.60 && bearN >= 4) add(`公開輿論偏空（${bearN}/${total} 條，情緒悲觀）`,               2, 'crowd');
          if (bullPct >= 0.55 && bullN >= 4)      add(`新聞輿論已轉多（${bullN}/${total} 條，底部確認跡象）`,         3, 'crowd');
        }
      }
    } catch(e) {}

    // ── 6. Multi-timeframe alignment (max 15) ─────────────────────
    if (forTop) {
      if (h4s?.signal?.includes('bear'))                    add('4H 時框轉空確認',                               5, 'mtf');
      if (d1s?.signal?.includes('bear'))                    add('日線方向做空',                                   5, 'mtf');
      if (w1s?.signal?.includes('bear'))                    add('週線壓制（大週期空方）',                         5, 'mtf');
    } else {
      if (h4s?.signal?.includes('bull'))                    add('4H 時框轉多確認',                               5, 'mtf');
      if (d1s?.signal?.includes('bull'))                    add('日線方向做多',                                   5, 'mtf');
      if (w1s?.signal?.includes('bull'))                    add('週線支撐（大週期多方）',                         5, 'mtf');
    }

    // ── 7. Trend exhaustion & structure extras (max 8) ────────────
    if (adxV < 18)                                           add('ADX < 18（趨勢動能枯竭）',                      5, 'extra');
    else if (adxV < 22)                                      add('ADX < 22（趨勢動能減弱）',                      2, 'extra');
    if (bb1h_?.tags?.includes('BB收窄蓄力'))
                                                             add('BB 收窄後蓄能釋放（可能為反向爆發）',           3, 'extra');

    return { pts: Math.min(100, pts), sigs };
  };

  const top = scoreDir(true);
  const bot = scoreDir(false);

  const result = {
    topScore: top.pts, topSignals: top.sigs,
    bottomScore: bot.pts, bottomSignals: bot.sigs,
    direction: null, confidence: 0, signals: [],
  };

  if (top.pts >= bot.pts && top.pts >= 60) {
    result.direction  = 'top';
    result.confidence = top.pts;
    result.signals    = top.sigs;
  } else if (bot.pts > top.pts && bot.pts >= 60) {
    result.direction  = 'bottom';
    result.confidence = bot.pts;
    result.signals    = bot.sigs;
  }
  return result;
}

/* ── 極端反轉 HTML 渲染（供 buildTradeSetup 呼叫）──────────────── */
function buildExtremeRevHtml(er, coin, mtfData) {
  try {
    if (!er || er.confidence < 60) return '';
    const price  = parseFloat(coin.price) || 0;
    const isTop  = er.direction === 'top';
    const conf   = er.confidence;

    // Compute ATR from 1h candles
    const raw1h = mtfData['1h']?.raw || [];
    const cc = raw1h.map(k => ({ h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]) })).filter(c => c.c > 0);
    let atr = price * 0.012;
    if (cc.length >= 15) {
      const atrs = [];
      for (let i = 1; i < Math.min(cc.length, 15); i++)
        atrs.push(Math.max(cc[i].h - cc[i].l, Math.abs(cc[i].h - cc[i-1].c), Math.abs(cc[i].l - cc[i-1].c)));
      atr = atrs.reduce((s, v) => s + v, 0) / atrs.length;
    }
    const recentHi = cc.length >= 10 ? Math.max(...cc.slice(-10).map(c => c.h)) : price * 1.02;
    const recentLo = cc.length >= 10 ? Math.min(...cc.slice(-10).map(c => c.l)) : price * 0.98;
    const sl  = isTop ? recentHi + atr * 0.3  : recentLo  - atr * 0.3;
    const tp1 = isTop ? price - atr * 2.0      : price     + atr * 2.0;
    const tp2 = isTop ? price - atr * 3.5      : price     + atr * 3.5;

    const _pxSym = (coin.symbol || '').replace('/', '').toUpperCase();
    const _px = v => { try { return toPionex(_pxSym, price, v); } catch(e) { return v.toFixed(4); } };

    const catLabel = { vol:'量能', momentum:'動能/背離', struct:'價格結構', flow:'訂單流', sentiment:'市場情緒', crowd:'公開輿論', mtf:'多時框', extra:'補充指標' };
    const catColor = { vol:'#60a5fa', momentum:'#f59e0b', struct:'#a78bfa', flow:'#34d399', sentiment:'#f87171', crowd:'#fbbf24', mtf:'#e879f9', extra:'#94a3b8' };

    const grouped = {};
    for (const s of er.signals) {
      if (!grouped[s.cat]) grouped[s.cat] = [];
      grouped[s.cat].push(s);
    }

    const confColor   = conf >= 98 ? '#ef4444' : conf >= 85 ? '#f97316' : '#60a5fa';
    const isHighConf  = conf >= 98;
    const revColor    = isTop ? 'var(--bear)' : 'var(--bull)';
    const revRgb      = isTop ? '239,68,68' : '34,197,94';
    const dirLabel    = isTop ? '頂部' : '底部';
    const revDirLabel = isTop ? '做空' : '做多';
    const revIcon     = isTop ? '📉' : '📈';

    const levelBadge = isHighConf
      ? `<span style="background:${confColor};color:#fff;font-size:0.63rem;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:6px;letter-spacing:.3px">⚡ 高精確反轉</span>`
      : conf >= 85
        ? `<span style="background:#f97316;color:#fff;font-size:0.63rem;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:6px">⚠️ 潛在反轉</span>`
        : `<span style="background:#60a5fa22;color:#60a5fa;font-size:0.63rem;padding:2px 8px;border-radius:10px;margin-left:6px">🔭 早期觀察</span>`;

    const sigHtml = Object.entries(grouped).map(([cat, sigs]) => `
      <div style="margin-bottom:7px">
        <div style="font-size:0.67rem;font-weight:700;color:${catColor[cat]||'#94a3b8'};text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">${catLabel[cat]||cat}</div>
        ${sigs.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)">
          <span style="font-size:0.7rem;color:var(--text2)">${s.label}</span>
          <span style="font-size:0.69rem;font-weight:700;color:${catColor[cat]||'#94a3b8'};margin-left:8px;white-space:nowrap">+${s.pts}</span>
        </div>`).join('')}
      </div>`).join('');

    const tradeHtml = isHighConf ? `
      <div style="margin-top:10px;padding:10px 12px;background:rgba(${revRgb},.08);border:1.5px solid rgba(${revRgb},.4);border-radius:9px">
        <div style="font-size:0.75rem;font-weight:700;color:${revColor};margin-bottom:8px">${revIcon} 建議反向交易 — ${revDirLabel}（逆勢高信心）</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;font-size:0.71rem">
          <div style="background:rgba(255,255,255,.04);padding:5px 8px;border-radius:7px">
            <div style="color:var(--text3);margin-bottom:1px">進場</div>
            <div style="font-weight:700;color:var(--text1)">${_px(price)}</div>
          </div>
          <div style="background:rgba(239,68,68,.08);padding:5px 8px;border-radius:7px">
            <div style="color:var(--text3);margin-bottom:1px">止損</div>
            <div style="font-weight:700;color:var(--bear)">${_px(sl)}</div>
          </div>
          <div style="background:rgba(34,197,94,.08);padding:5px 8px;border-radius:7px">
            <div style="color:var(--text3);margin-bottom:1px">目標①</div>
            <div style="font-weight:700;color:var(--bull)">${_px(tp1)}</div>
          </div>
          <div style="background:rgba(34,197,94,.12);padding:5px 8px;border-radius:7px">
            <div style="color:var(--text3);margin-bottom:1px">目標②</div>
            <div style="font-weight:700;color:var(--bull)">${_px(tp2)}</div>
          </div>
        </div>
        <div style="font-size:0.67rem;color:#f59e0b;margin-top:7px">⚠️ 逆勢反向交易風險較高，建議倉位控制在正常的 50% 以內，務必嚴格止損</div>
      </div>` : conf >= 85 ? `
      <div style="margin-top:8px;padding:8px 10px;background:rgba(249,115,22,.07);border:1px solid rgba(249,115,22,.3);border-radius:8px;font-size:0.7rem;color:#f97316">
        ⚠️ 信號強度尚未達到 98% 建議門檻（還需 <strong>${98 - conf}%</strong>），建議等待更多確認訊號後再考慮反向操作
      </div>` : '';

    return `<div style="margin-top:14px;padding:12px 13px;background:rgba(${revRgb},.04);border:1.5px solid rgba(${revRgb},.22);border-radius:11px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
        <div style="font-size:0.75rem;font-weight:700;color:var(--text1)">${revIcon} ${dirLabel}辨識分析${levelBadge}</div>
        <div style="font-size:0.88rem;font-weight:900;color:${confColor}">${conf}<span style="font-size:0.65rem;font-weight:400;color:var(--text3)">/100</span></div>
      </div>
      <div style="background:rgba(255,255,255,.07);border-radius:4px;height:4px;margin-bottom:7px;overflow:hidden">
        <div style="width:${Math.min(100,conf)}%;height:100%;background:linear-gradient(90deg,${isTop?'#f59e0b,#ef4444':'#22d3ee,#22c55e'});border-radius:4px"></div>
      </div>
      <div style="font-size:0.67rem;color:var(--text3);margin-bottom:9px">
        反向交易觸發門檻：98%
        <span style="color:${isHighConf?'#22c55e':'#94a3b8'}">${isHighConf ? '✅ 已達標，可考慮反向交易' : `（距門檻還需 ${98 - conf} 分）`}</span>
        &nbsp;·&nbsp; 對手方向信號積分：<strong style="color:${isTop?'#60a5fa':'#f97316'}">${er.direction==='top'?er.bottomScore:er.topScore}/100</strong>
      </div>
      <div>${sigHtml}</div>
      ${tradeHtml}
    </div>`;
  } catch(e) { console.warn('[buildExtremeRevHtml]', e); return ''; }
}

/* ── 交易建議（支撐壓力 + 訂單流 + RSI 三位一體）────────────── */
function buildTradeSetup(coin, mtfData, deriv, globalMkt, whale, fearGreed) {
  const price = parseFloat(coin.price) || 0;
  if (!price) return '<div class="adv-loading">價格數據不可用</div>';
  // 極端頂/底部辨識（在所有早期返回之前計算）
  const _extremeRev = (() => { try { return detectExtremeReversal(coin, mtfData, deriv, globalMkt, whale, fearGreed); } catch(_e) { return { direction: null, confidence: 0, signals: [], topScore: 0, bottomScore: 0 }; } })();
  const _erHtml = () => buildExtremeRevHtml(_extremeRev, coin, mtfData);
  const _pxSym = (coin.symbol || '').replace('/', '').toUpperCase();
  const _px = v => { try { return toPionex(_pxSym, price, v); } catch(e) { return v.toFixed(4); } };

  // 若已有進行中的開倉或等待進場的掛單，優先顯示對應畫面
  const tlogNow = loadTradeLog();
  const existingActive = tlogNow.find(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending') && t.entry);
  if (existingActive) {
    // ── 即時宏觀攔截：pending 方向與宏觀大方向衝突 → 立即取消並重新分析 ──
    let pendingCancelledByMacro = false;
    if (existingActive.status === 'pending' && !existingActive.entryTime) {
      try {
        const fgChk = fearGreed || _macroCache?.fg;
        const gmChk = globalMkt  || _macroCache;
        if (fgChk || gmChk) {
          const macroNow = computeMacroNetDir(fgChk, gmChk);
          const isBlocked =
            (existingActive.direction === 'long'  && (macroNow === 'bear' || macroNow === 'strong_bear')) ||
            (existingActive.direction === 'short' && (macroNow === 'bull' || macroNow === 'strong_bull'));
          if (isBlocked) {
            const macroLabel = { strong_bear:'強烈看空', bear:'偏空', strong_bull:'強烈看多', bull:'偏多' }[macroNow] || macroNow;
            const reason = `宏觀大方向${macroLabel}，取消逆勢${existingActive.direction === 'long' ? '多' : '空'}單掛單`;
            const tlogC = loadTradeLog();
            const ci = tlogC.findIndex(t => t.id === existingActive.id);
            if (ci >= 0) {
              addCancelCooldown(tlogC[ci], reason);
              tlogC.splice(ci, 1);
              saveTradeLog(tlogC);
            }
            try { sendCancelTelegramNotification(existingActive, reason); } catch(e) {}
            pendingCancelledByMacro = true;
          }
        }
      } catch(e) {}
    }

    if (!pendingCancelledByMacro) {
      // 每次開啟幣種詳情都重新計算完整信心扣分（ADX + 宏觀 + AI趨勢 + 風控記憶）
      const rsiNow   = parseFloat(coin.rsi) || 50;
      const adxNow   = parseFloat(coin.adx) || 20;
      const isLongNow = existingActive.direction === 'long';
      const hardAdxNow = adxNow < 18 ? 18 : adxNow < 22 ? 10 : 0;
      const vp1hNow  = mtfData['1h']?.vp;
      const mtfAlignNow = ['15m','1h','4h','1d'].filter(tf => {
        const sig = mtfData[tf]?.signal;
        return sig && (isLongNow ? sig.signal?.includes('bull') : sig.signal?.includes('bear'));
      }).length;
      const _h4Now = mtfData['4h']?.signal;
      const _h1Now = mtfData['1h']?.signal;
      const _bb1hNow = mtfData['1h']?.bb;
      const learnCtxNow = {
        abovePOC:      vp1hNow?.priceAbovePOC ?? null,
        whaleBias:     whale?.bias || null,
        volDivergence: mtfData['1h']?.volAI?.divergence || null,
        mtfAlign:      mtfAlignNow,
        slType:        existingActive.entrySlType || 'atr',
        score:         parseFloat(existingActive.score) || 50,
        skipAdxRule:   true,
        macdHist:      parseFloat(coin.macdHist) || 0,
        volWeak:       (coin.volumeStrength || '') === '低' || String(coin.volumeStrength||'').includes('弱'),
        h4Aligned:     isLongNow ? !!_h4Now?.signal?.includes('bull') : !!_h4Now?.signal?.includes('bear'),
        scoreStrength: (() => { const s = isLongNow ? (parseFloat(existingActive.score)||50) : 100-(parseFloat(existingActive.score)||50); return s >= 75 ? 'strong' : s >= 65 ? 'medium' : 'weak'; })(),
        killZone:      (() => { const h = new Date().getUTCHours(); return h >= 7 && h < 11 ? 'london' : h >= 13 && h < 17 ? 'ny' : h >= 0 && h < 4 ? 'asia' : 'other'; })(),
        weeklyAgainst: isLongNow ? (coin.weeklySignal||'').includes('bear') : (coin.weeklySignal||'').includes('bull'),
        h1Aligned:     isLongNow ? !!(_h1Now?.signal||'').includes('bull') : !!(_h1Now?.signal||'').includes('bear'),
        bbWalkingBear: !!(_bb1hNow?.walkingBear),
        bbWalkingBull: !!(_bb1hNow?.walkingBull),
      };

      let learnResultNow = { penalty: 0, warnings: [], hardBlocked: false, blockReasons: [], defenseChecks: [] };
      try { learnResultNow = applyLearnAdjustment(existingActive.direction, rsiNow, adxNow, learnCtxNow); } catch(e) {}
      const learnPenNow = learnResultNow.penalty;

      // 宏觀 + AI 趨勢扣分（完整計算，與 buildTradeSetup 主路徑一致）
      let macroPenNow = 0, aiTrendPenNow = 0;
      const macroReasonsNow = [], aiTrendReasonsNow = [];
      if (_macroCache) {
        try {
          const fg = _macroCache.fg, gm = _macroCache;
          const fgVal  = fg ? parseInt(fg.value || '50') : 50;
          const chgVal = gm?.marketCapChange || 0;
          const domVal = gm?.btcDominance   || 50;
          let against  = 0;
          if (isLongNow) {
            if (chgVal < -2) { against++; macroReasonsNow.push(`大盤下跌 ${chgVal.toFixed(1)}%`); }
            if (domVal > 58) { against++; macroReasonsNow.push(`BTC主導率偏高 ${domVal.toFixed(1)}%`); }
            if (fgVal  < 30) { against++; macroReasonsNow.push(`市場恐慌（F&G ${fgVal}）`); }
            if (fgVal  > 75) { against += 0.5; macroReasonsNow.push(`市場過熱（F&G ${fgVal}）`); }
          } else {
            if (chgVal > 2)  { against++; macroReasonsNow.push(`大盤上漲 ${chgVal.toFixed(1)}%`); }
            if (domVal < 44) { against++; macroReasonsNow.push(`BTC主導率偏低 ${domVal.toFixed(1)}%`); }
            if (fgVal  > 70) { against++; macroReasonsNow.push(`市場貪婪（F&G ${fgVal}）`); }
            if (fgVal  < 25) { against += 0.5; macroReasonsNow.push(`市場極度恐慌（F&G ${fgVal}）`); }
          }
          macroPenNow = against >= 3 ? 22 : against >= 2 ? 15 : against >= 1 ? 8 : 0;
          // 大方向逆向補扣（與 computeSimpleSetup 一致）
          const _bigDirNow = computeMacroNetDir(fg, gm);
          const _bdAgainstNow = (isLongNow && _bigDirNow.includes('bear')) || (!isLongNow && _bigDirNow.includes('bull'));
          if (_bdAgainstNow) {
            const _bdMinNow = (_bigDirNow === 'slight_bear' || _bigDirNow === 'slight_bull') ? 4 : 9;
            if (macroPenNow < _bdMinNow) macroPenNow = _bdMinNow;
          }
          const wb = computeWeeklyAIBias(fg, gm);
          const tb = computeTodayAIBias(fg, gm);
          const _wkConfLowNow = (wb?.conf || 50) < 70;
          const wkAligned = (isLongNow && wb.bias.includes('bull')) || (!isLongNow && wb.bias.includes('bear'));
          const wkOpposed = !_wkConfLowNow && !wkAligned && wb.bias !== 'neutral';
          const tdAligned = (isLongNow && tb.bias.includes('bull')) || (!isLongNow && tb.bias.includes('bear'));
          const tdOpposed = !tdAligned && tb.bias !== 'neutral';
          if (_wkConfLowNow) { aiTrendReasonsNow.push(`本週AI預測信心值 ${wb.conf||50}% 未達 70%，略過週預測`); }
          else if (wkOpposed) { const p = wb.bias.includes('strong') ? 10 : 6; aiTrendPenNow += p; aiTrendReasonsNow.push(`本週 AI ${wb.biasLabel}，逆向 -${p}%`); }
          else if (wb.bias === 'neutral') { aiTrendPenNow += 3; aiTrendReasonsNow.push(`本週 AI ${wb.biasLabel}，中性不確定 -3%`); }
          else aiTrendReasonsNow.push(`本週 AI ${wb.biasLabel} ✓ 同向`);
          if (tdOpposed) { aiTrendPenNow += 7; aiTrendReasonsNow.push(`今日 AI ${tb.biasLabel}，逆風 -7%`); }
          else if (tb.bias === 'neutral') { aiTrendPenNow += 2; aiTrendReasonsNow.push(`今日 AI ${tb.biasLabel}，中性不確定 -2%`); }
          else aiTrendReasonsNow.push(`今日 AI ${tb.biasLabel} ✓ 同向`);
        } catch(e) {}
      }

      // 技術面 / 籌碼面 / 方向面扣分：沿用信號建立時的存儲值（不隨宏觀即時更新）
      const techPenNow  = existingActive.techPenalty  || 0;
      const chipsPenNow = existingActive.chipsPenalty || 0;
      const dirPenNow   = existingActive.dirPenalty   || 0;

      // 資金流動事件動態扣分（與 buildTradeSetup 一致：high 5，normal 3，中性 2，cap 10）
      let cfPenNow = 0;
      const cfEventsNow = [];
      try {
        const _cfNow = getCapitalFlowBias();
        for (const ev of _cfNow.events) {
          if (isLongNow  && ev.bear > 0) { cfPenNow += ev.bear >= 1.2 ? 5 : 3; cfEventsNow.push(ev); }
          else if (!isLongNow && ev.bull > 0) { cfPenNow += ev.bull >= 1.2 ? 5 : 3; cfEventsNow.push(ev); }
          else if (ev.bull === 0 && ev.bear === 0) { cfPenNow += 2; cfEventsNow.push(ev); }
        }
        cfPenNow = Math.min(10, cfPenNow);
      } catch(_e) {}

      const bbPenNow    = existingActive.bbPenalty || 0;
      let rawConfNow = existingActive.rawConf || Math.max(existingActive.conf || 60, Math.min(90, existingActive.score || 60));
      let freshConf  = Math.max(0, 100 - Math.min(45, learnPenNow) - (existingActive.riskPenalty || 0));
      if ((Math.abs((existingActive.conf || 0) - freshConf) >= 1 || (existingActive.learnPenalty || 0) !== learnPenNow) && !existingActive.entryTime) {
        const tlogEdit = loadTradeLog();
        const editIdx  = tlogEdit.findIndex(t => t.id === existingActive.id);
        if (editIdx >= 0) {
          tlogEdit[editIdx].conf         = freshConf;
          tlogEdit[editIdx].rawConf      = rawConfNow;
          tlogEdit[editIdx].learnPenalty = learnPenNow;
          existingActive.conf            = freshConf;
          existingActive.learnPenalty    = learnPenNow;
          saveTradeLog(tlogEdit);
        }
      }

      // 同步更新快取：確保 generateAIAnalysis 讀到的值與 confPanelHtml 顯示一致
      _tradeSetupCache[coin.symbol] = Object.assign(
        _tradeSetupCache[coin.symbol] || {},
        {
          learnPenalty:        learnPenNow,
          hardAdxPenalty:      hardAdxNow,
          macroOpposePenalty:  macroPenNow,
          aiTrendPenalty:      aiTrendPenNow,
          hardBlocked:         learnResultNow.hardBlocked || false,
          blockReasons:        learnResultNow.blockReasons || [],
          learnWarnings:       learnResultNow.warnings || [],
          defenseChecks:       learnResultNow.defenseChecks || [],
          conf:                freshConf,
          rawConf:             rawConfNow,
          finalConf:           freshConf,
          direction:           existingActive.direction,
        }
      );

      // ── 即時 ICT / SMC / SNR + 圖形偵測（持倉幣種每次開啟詳情頁都重算）──
      // Kill Zone is set first and immediately so it's never lost to a later exception
      if (!_tradeSetupCache[coin.symbol]) _tradeSetupCache[coin.symbol] = {};
      _tradeSetupCache[coin.symbol].killZone = typeof computeKillZone === 'function' ? computeKillZone() : null;
      try {
        const _r1hOT = mtfData['1h']?.raw;
        const _r4hOT = mtfData['4h']?.raw;
        let _obOT = null, _fvgOT = null, _pdOT = null, _ob4hOT = null, _fvg4hOT = null;
        let _cpOT = { patterns: [], score: 0, aligned: [], opposing: [], neutral: [] };
        if (_r1hOT?.length >= 5) {
          if (typeof detectOrderBlocks     === 'function') _obOT   = detectOrderBlocks(_r1hOT, isLongNow);
          if (typeof detectFairValueGaps   === 'function') _fvgOT  = detectFairValueGaps(_r1hOT, isLongNow);
          if (typeof computePremiumDiscount === 'function') _pdOT  = computePremiumDiscount(_r1hOT);
        }
        if (_r4hOT?.length >= 5) {
          if (typeof detectOrderBlocks   === 'function') _ob4hOT  = detectOrderBlocks(_r4hOT, isLongNow);
          if (typeof detectFairValueGaps === 'function') _fvg4hOT = detectFairValueGaps(_r4hOT, isLongNow);
        }
        if (_r4hOT?.length >= 30 && typeof detectChartPatterns === 'function')
          _cpOT = detectChartPatterns(_r4hOT, isLongNow);
        Object.assign(_tradeSetupCache[coin.symbol], {
          orderBlock: _obOT, fvg: _fvgOT, premiumDiscount: _pdOT,
          orderBlock4h: _ob4hOT, fvg4h: _fvg4hOT, chartPat: _cpOT,
        });
      } catch (_ictOTE) {}

      // ── 信心扣分明細面板（附加在持倉/掛單卡片下方）──
      const _cc = v => v >= 85 ? '#22c55e' : v >= 80 ? '#4ade80' : v >= 75 ? '#f59e0b' : '#ef4444';
      const totalPenNow = hardAdxNow + macroPenNow + aiTrendPenNow + learnPenNow + cfPenNow + techPenNow + chipsPenNow + dirPenNow + bbPenNow;

      // 已進場：顯示進場時鎖定的風控分，不再動態重算（進場後市況變化不影響已開倉決策）
      if (existingActive.entryTime) {
        const _learnPen = existingActive.learnPenalty != null ? existingActive.learnPenalty : null;
        const _lockDrag = _learnPen != null ? Math.min(45, _learnPen) : 0;
        const _lockedConf = _learnPen != null
          ? Math.max(0, Math.round(100 - _lockDrag))
          : (existingActive.conf || 0);
        const _clr = _cc(_lockedConf);
        const lockedConfPanel = `<div style="margin-top:12px;padding:10px 13px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px">
          <div style="font-size:0.74rem;font-weight:700;color:var(--text2);margin-bottom:6px">🛡️ 風控分項明細（進場時）</div>
          <div style="font-size:0.73rem;line-height:2">
            <div><span style="color:var(--text3)">滿分</span> <strong>100 分</strong></div>
            ${_lockDrag > 0 ? `<div style="color:#f59e0b">　↳ 止損風控扣分 <strong>-${_lockDrag} 分</strong></div>` : '<div style="color:#22c55e">　↳ 止損風控通過（無扣分）</div>'}
            <div style="border-top:1px solid rgba(255,255,255,.08);margin-top:4px;padding-top:4px">
              <span style="color:var(--text3)">= 風控分</span> <strong style="color:${_clr};font-size:1rem">${_lockedConf} 分</strong>
              <span style="font-size:0.68rem;color:var(--text3);margin-left:6px">其餘逆風見 SQ 因子</span>
            </div>
          </div>
        </div>`;
        if (existingActive.status === 'open')    return buildOpenPositionSetup(existingActive, price) + lockedConfPanel;
        if (existingActive.status === 'pending') return buildPendingPositionSetup(existingActive, price) + lockedConfPanel;
      }

      const _learnDragNow = Math.min(45, learnPenNow);
      const _riskPenNow = existingActive.riskPenalty || 0;
      const confPanelHtml = `<div style="margin-top:12px;padding:10px 13px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px">
        <div style="font-size:0.74rem;font-weight:700;color:var(--text2);margin-bottom:8px">📊 風控分評估（動態更新）</div>
        <div style="font-size:0.73rem;line-height:2;margin-bottom:8px;background:rgba(255,255,255,.02);border-radius:6px;padding:6px 8px">
          <div><span style="color:var(--text3)">滿分</span> <strong>100 分</strong></div>
          ${_learnDragNow > 0 ? `<div style="color:#f59e0b">　AI止損風控 <strong>-${_learnDragNow} 分</strong>（歷史止損率/規則/建議）</div>` : '<div style="color:#22c55e">　AI止損風控通過（無扣分）</div>'}
          ${_riskPenNow > 0 ? `<div style="color:#f97316">　風險評估扣分 <strong>-${_riskPenNow} 分</strong>（${existingActive.riskLevel || '中風險'} ${existingActive.riskScore || 0}/100）</div>` : ''}
          <div style="border-top:1px solid rgba(255,255,255,.08);margin-top:4px;padding-top:4px">
            <span style="color:var(--text3)">風控分</span> <strong style="color:${_cc(freshConf)};font-size:1rem">${freshConf} 分</strong>
            <span style="font-size:0.68rem;color:var(--text3);margin-left:6px">其餘逆風見 SQ 因子</span>
          </div>
        </div>
        <div style="font-size:0.72rem;line-height:1.8">
          ${hardAdxNow > 0
            ? `<div style="color:#f59e0b">⚡ ADX ${adxNow}${adxNow < 18 ? '（< 18，震盪過弱）' : '（< 22，趨勢偏弱）'}，扣 -${hardAdxNow}%</div>`
            : `<div style="color:#22c55e">✓ ADX ${adxNow} 趨勢強度正常</div>`}
          ${macroReasonsNow.length
            ? macroReasonsNow.map(r => `<div style="color:#f59e0b">⚠️ ${r}（宏觀逆風）</div>`).join('')
            : `<div style="color:#22c55e">✓ 宏觀環境無明顯逆風</div>`}
          ${aiTrendReasonsNow.map(r => `<div style="color:${r.includes('逆') || r.includes('逆風') ? '#f59e0b' : '#22c55e'}">${r.includes('逆') ? '⚠️' : '✓'} ${r}</div>`).join('')}
          ${learnResultNow.hardBlocked
            ? learnResultNow.blockReasons.slice(0, 2).map(r => `<div style="color:var(--bear)">🚫 ${r}</div>`).join('')
            : learnPenNow > 0
              ? learnResultNow.warnings.map(w => `<div style="color:#f59e0b">⚠️ AI風控：${w}</div>`).join('') || `<div style="color:#f59e0b">⚠️ AI 風控：歷史規則觸發，扣 -${Math.min(45,learnPenNow)} 分</div>`
              : `<div style="color:#22c55e">✓ AI 風控：無歷史止損規則觸發</div>`}
          ${cfPenNow > 0
            ? cfEventsNow.map(ev => {
                const timeStr = ev.isActive ? '進行中' : `${ev.daysUntil}天後`;
                const aiTag   = ev.isAI ? 'AI預測 ' : '';
                const _evPenAmt = (ev.bear > 0 || ev.bull > 0) ? (ev.bear >= 1.2 || ev.bull >= 1.2 ? 5 : 3) : 2;
                const _evDesc   = ev.bear > 0 ? '資金流出逆風' : ev.bull > 0 ? '資金流入逆風' : '資金方向中性';
                return `<div style="color:#f59e0b">⚠️ 💹 ${ev.name}（${timeStr}）：${aiTag}${_evDesc}，扣 -${_evPenAmt}%</div>`;
              }).join('')
            : `<div style="color:#22c55e">✓ 資金流動：無近期逆向事件</div>`}
          ${techPenNow > 0
            ? `<div style="color:#f59e0b">⚠️ 技術面逆風（RSI/MACD/成交量），扣 -${techPenNow}%</div>`
            : `<div style="color:#22c55e">✓ 技術面無明顯逆風</div>`}
          ${chipsPenNow > 0
            ? `<div style="color:#f59e0b">⚠️ 籌碼面逆風（Taker/巨鯨），扣 -${chipsPenNow}%</div>`
            : `<div style="color:#22c55e">✓ 籌碼面無明顯逆風</div>`}
          ${dirPenNow > 0
            ? `<div style="color:#f59e0b">⚠️ 大方向/日線逆向，扣 -${dirPenNow}%</div>`
            : `<div style="color:#22c55e">✓ 大方向/日線同向</div>`}
        </div>
      </div>`;

      if (existingActive.status === 'open')    return buildOpenPositionSetup(existingActive, price) + confPanelHtml;
      if (existingActive.status === 'pending') return buildPendingPositionSetup(existingActive, price) + confPanelHtml;
    }
    // 若 pendingCancelledByMacro = true，繼續往下執行新的交易分析
  }

  // 若冷卻期內有同方向取消記錄（含飛越止盈），顯示機會已過提示
  const recentCancel = loadCancelCooldowns()
    .filter(c => c.symbol === coin.symbol && (Date.now() - (c.cancelTime || 0)) < SIGNAL_COOLDOWN)
    .sort((a, b) => (b.cancelTime || 0) - (a.cancelTime || 0))[0];
  if (recentCancel) {
    const fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
    const dirLabel = recentCancel.direction === 'long' ? '▲ 做多' : '▼ 做空';
    const minsAgo = Math.round((Date.now() - (recentCancel.cancelTime || 0)) / 60000);
    return `<div style="background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.2);border-radius:12px;padding:18px 20px;margin-top:8px">
      <div style="font-size:1rem;font-weight:600;color:#ef4444;margin-bottom:10px">⚡ 本次機會已過（${minsAgo} 分鐘前取消）</div>
      <div style="font-size:0.85rem;color:var(--text2);line-height:1.7">
        <div>方向：<b>${dirLabel}</b> &nbsp;|&nbsp; 原進場位：<b>$${fmt(recentCancel.entry)}</b></div>
        <div>止盈一：<b>$${fmt(recentCancel.tp1)}</b> &nbsp;|&nbsp; 止損：<b>$${fmt(recentCancel.sl)}</b></div>
        <div style="margin-top:8px;color:#f59e0b">⚠️ ${recentCancel.cancelReason || '掛單已取消'}</div>
      </div>
      <div style="margin-top:14px;font-size:0.8rem;color:var(--text3)">冷卻期結束後（約 ${Math.round((SIGNAL_COOLDOWN - (Date.now() - (recentCancel.cancelTime||0)))/60000)} 分鐘）將重新評估新進場機會</div>
    </div>`;
  }


  const m15  = mtfData['15m']?.signal;
  const h1   = mtfData['1h']?.signal;
  const h4   = mtfData['4h']?.signal;

  let bullScore = 0, bearScore = 0;
  const scoreOf = (sig, weight) => {
    if (!sig) return;
    if (sig.signal.includes('bull')) bullScore += weight;
    if (sig.signal.includes('bear')) bearScore += weight;
    if (sig.bullBreak && sig.isHighVol) bullScore += weight;
    if (sig.bearBreak && sig.isHighVol) bearScore += weight;
  };
  scoreOf(m15, 2);
  scoreOf(h1,  2);
  scoreOf(h4,  1);

  let derivBullBonus = 0, derivBearBonus = 0;
  if (deriv) {
    if ((deriv.fundingRate ?? 0) < -0.003) derivBullBonus++;
    if ((deriv.fundingRate ?? 0) > 0.003)  derivBearBonus++;
    if (deriv.takerBuySell > 1.15)  derivBullBonus++;
    if (deriv.takerBuySell < 0.85)  derivBearBonus++;
    if (deriv.topLongRatio > 0.57)  derivBullBonus++;
    if (deriv.topLongRatio < 0.43)  derivBearBonus++;
  }

  // 足跡圖加成（Delta 方向 + 買方吸收信號，作為方向確認因子）
  const _fpBTS = _footprintCache[coin.symbol];
  const fpBull    = (_fpBTS?.deltaDir === 'bull') ? 1 : 0;
  const fpBear    = (_fpBTS?.deltaDir === 'bear') ? 1 : 0;
  const fpAbsBull = (_fpBTS?.absorption && _fpBTS?.deltaDir !== 'bear') ? 1 : 0;

  let macroBullBonus = 0, macroBearBonus = 0;
  if (globalMkt) {
    const chg = globalMkt.marketCapChange || 0;
    if (chg > 2)  macroBullBonus++;
    if (chg < -2) macroBearBonus++;
    if (globalMkt.btcDominance > 58) macroBearBonus++;  // BTC 主導→山寨偏空
    if (globalMkt.btcDominance < 44) macroBullBonus++;  // 山寨季潛力
  }

  // 巨鯨資金流向加成
  let whaleBullBonus = 0, whaleBearBonus = 0;
  if (whale && whale.total > 0) {
    if (whale.bias === 'bull' && whale.bigBuyCount >= 3)  whaleBullBonus++;
    if (whale.bias === 'bear' && whale.bigSellCount >= 3) whaleBearBonus++;
    // 淨流入超過 50% 時強化信號
    if (whale.buyPct > 70 && whale.bigBuyCount >= 5)      whaleBullBonus++;
    if (whale.buyPct < 30 && whale.bigSellCount >= 5)     whaleBearBonus++;
  }

  // 訂單流加成（CVD 趨勢 + 主動買賣比）
  const of15m_        = mtfData['15m']?.orderFlow;
  const cvdTrend_     = of15m_?.cvdTrend || 'neutral';
  const buyPct_       = of15m_?.buyPct   || 50;
  const orderFlowBull = (cvdTrend_ === 'bull' ? 1 : 0) + (buyPct_ > 62 ? 1 : 0);
  const orderFlowBear = (cvdTrend_ === 'bear' ? 1 : 0) + (buyPct_ < 38 ? 1 : 0);

  // Volume AI 加成（放量突破 / 成交量背離）
  const volAI1h_  = mtfData['1h']?.volAI;
  const volAIBull = volAI1h_
    ? ((volAI1h_.isBreakout && volAI1h_.bias === 'bull') || (volAI1h_.isSpike && volAI1h_.bias === 'bull') ? 1 : 0)
      + (volAI1h_.divergence === 'bullish_div' ? 1 : 0)
    : 0;
  const volAIBear = volAI1h_
    ? ((volAI1h_.isBreakout && volAI1h_.bias === 'bear') || (volAI1h_.isSpike && volAI1h_.bias === 'bear') ? 1 : 0)
      + (volAI1h_.divergence === 'bearish_div' ? 1 : 0)
    : 0;

  // 籌碼分佈（VP）加成
  const vp1h_  = mtfData['1h']?.vp;
  const vpBull = vp1h_
    ? ((vp1h_.priceAbovePOC && Math.abs(vp1h_.distToPOC) < 3) ? 1 : 0)
      + (vp1h_.hvns?.some(h => Math.abs(h - price) / price < 0.01) ? 1 : 0)
    : 0;
  const vpBear = vp1h_ ? ((!vp1h_.priceAbovePOC && Math.abs(vp1h_.distToPOC) < 3) ? 1 : 0) : 0;

  // 日線趨勢加成
  const d1sig_  = mtfData['1d']?.signal;
  const d1Bull  = d1sig_?.signal?.includes('bull') ? 1 : 0;
  const d1Bear  = d1sig_?.signal?.includes('bear') ? 1 : 0;

  // 陷阱型態加成（PO3 / 2B / 掃蕩後反轉 = 高信心進場點）
  const traps1h__  = mtfData['1h']?.traps;
  const traps4h__  = mtfData['4h']?.traps;
  const trapBull   = traps1h__ ? ((traps1h__.po3Bull || traps1h__.twoB_Bull || traps1h__.sweepBull) ? 2 : 0) : 0;
  const trapBear   = traps1h__ ? ((traps1h__.po3Bear || traps1h__.twoB_Bear || traps1h__.sweepBear) ? 2 : 0) : 0;
  // 4H 陷阱加成（比 1H 更強的結構確認，加 1 分）
  const trap4hBull = traps4h__ ? ((traps4h__.po3Bull || traps4h__.twoB_Bull || traps4h__.sweepBull) ? 1 : 0) : 0;
  const trap4hBear = traps4h__ ? ((traps4h__.po3Bear || traps4h__.twoB_Bear || traps4h__.sweepBear) ? 1 : 0) : 0;

  // 布林通道加成（1h 主信號 + 15m 輔助確認）
  const bb1h_  = mtfData['1h']?.bb;
  const bb15m_ = mtfData['15m']?.bb;
  const bbBull = (bb1h_?.bullBonus || 0) + (bb15m_ ? Math.min(1, bb15m_.bullBonus) : 0);
  const bbBear = (bb1h_?.bearBonus || 0) + (bb15m_ ? Math.min(1, bb15m_.bearBonus) : 0);

  const totalBull = bullScore + derivBullBonus + macroBullBonus + whaleBullBonus + orderFlowBull + volAIBull + vpBull + d1Bull + trapBull + trap4hBull + bbBull + fpBull + fpAbsBull;
  const totalBear = bearScore + derivBearBonus + macroBearBonus + whaleBearBonus + orderFlowBear + volAIBear + vpBear + d1Bear + trapBear + trap4hBear + bbBear + fpBear;

  let direction = 'wait';
  const primaryBull = (m15?.signal?.includes('bull') ? 1 : 0) + (h1?.signal?.includes('bull') ? 1 : 0);
  const primaryBear = (m15?.signal?.includes('bear') ? 1 : 0) + (h1?.signal?.includes('bear') ? 1 : 0);
  // 頂級交易員思維：15m+1h 雙重確認 + 綜合評分差距更大（至少領先 2）
  if (primaryBull >= 2 && totalBull >= 4 && totalBull > totalBear + 2) direction = 'long';
  else if (primaryBear >= 2 && totalBear >= 4 && totalBear > totalBull + 2) direction = 'short';
  // 單週期初步信號需更強的輔助條件（4h 也確認 + 大幅領先）
  else if (primaryBull >= 1 && totalBull >= 5 && totalBull > totalBear + 3) direction = 'long';
  else if (primaryBear >= 1 && totalBear >= 5 && totalBear > totalBull + 3) direction = 'short';

  if (direction === 'long'  && coin.score < 60) direction = 'wait';
  if (direction === 'short' && coin.score > 40) direction = 'wait';
  // 信號強度未達 60%（與掃描門檻一致）一律觀望
  if (direction !== 'wait') {
    const prelimConf = Math.min(90, Math.max(40, 40 + (direction === 'long' ? totalBull : totalBear) * 7));
    if (prelimConf < 60) direction = 'wait';
  }

  // ── 大時間框架趨勢一致性強制篩選 ──────────────────────────────
  // 規則（更新）：
  //   硬性條件：4H + 15m 必須雙雙同向才允許進場
  //   ① 4H ✅ + 15m ✅ → 通過，建議交易
  //   ② 任一未同向（中性或逆向）→ 嚴格攔截，不建議進場
  //   其餘時框（1H / 日線 / 週線）進入 SQ 加分項
  const _btH4Ok  = direction === 'long' ? !!(h4?.signal?.includes('bull'))  : !!(h4?.signal?.includes('bear'));
  const _btM15Ok = direction === 'long' ? !!(m15?.signal?.includes('bull')) : !!(m15?.signal?.includes('bear'));
  const h4TrendLabel  = h4?.signal?.includes('bull') ? '▲ 偏多'
                      : h4?.signal?.includes('bear') ? '▼ 偏空' : '— 中性';
  const m15TrendLabel = m15?.signal?.includes('bull') ? '▲ 偏多'
                      : m15?.signal?.includes('bear') ? '▼ 偏空' : '— 中性';
  const d1TrendLabel  = d1sig_?.signal?.includes('bull') ? '▲ 偏多'
                      : d1sig_?.signal?.includes('bear') ? '▼ 偏空' : '— 中性';
  let bigTrendBlocked = false, bigTrendBlockReason = '';
  if (direction !== 'wait' && !(_btH4Ok && _btM15Ok)) {
    direction = 'wait';
    bigTrendBlocked = true;
    const _btMiss = !_btH4Ok && !_btM15Ok
      ? `4H（${h4TrendLabel}）與 15m（${m15TrendLabel}）均未同向`
      : !_btH4Ok
      ? `4H（${h4TrendLabel}）未同向，缺少大框架確認`
      : `15m（${m15TrendLabel}）未同向，缺少短線入場信號`;
    bigTrendBlockReason = `${_btMiss}，硬性條件未達標，嚴格攔截`;
  }

  // ATR：優先使用 1h 真實 ATR
  const atrPct = coin.adx > 35 ? 0.018 : coin.adx > 25 ? 0.013 : 0.009;
  const atr    = h1?.atr || price * atrPct;

  // S/R 層位：1h pivot 優先，fallback 到 4h / 簡估
  const pl      = h1?.pivotLevels || h4?.pivotLevels;
  let resists = (pl?.resistances || []).filter(r => r > price);
  let supps   = (pl?.supports    || []).filter(s => s < price);
  const swHigh  = pl?.swingHigh || h4?.swingHigh || price * 1.025;
  const swLow   = pl?.swingLow  || h4?.swingLow  || price * 0.975;

  // 整合 Volume Profile S/R（POC / VAH / VAL / HVN 作為額外關鍵位）
  const vp1h = mtfData['1h']?.vp;
  if (vp1h) {
    const addS = v => { if (v < price * 0.999 && !supps.some(s => Math.abs(s - v) < price * 0.002)) supps.push(v); };
    const addR = v => { if (v > price * 1.001 && !resists.some(r => Math.abs(r - v) < price * 0.002)) resists.push(v); };
    addS(vp1h.poc); addR(vp1h.poc);
    addS(vp1h.val); addR(vp1h.vah);
    vp1h.hvns.forEach(h => { addS(h); addR(h); });
    supps   = supps.sort((a, b) => b - a);
    resists = resists.sort((a, b) => a - b);
  }

  // ── HTF S/R：4H、日線、週線樞軸位（比 1H 更重要的結構位，優先用於 TP/SL 定位）──
  const _pl4h = mtfData['4h']?.signal?.pivotLevels || {};
  const _pld1 = mtfData['1d']?.signal?.pivotLevels || {};
  const _plw1 = mtfData['1w']?.signal?.pivotLevels || {};
  // 4H + 日線：合併進主池，SL / TP 計算均受益
  const _htfResists = [
    ...(_pl4h.resistances || []),
    ...(_pld1.resistances || []),
    ...(_pl4h.swingHigh ? [_pl4h.swingHigh] : []),
    ...(_pld1.swingHigh ? [_pld1.swingHigh] : []),
  ].filter(r => r > price * 1.001).sort((a, b) => a - b);
  const _htfSupps = [
    ...(_pl4h.supports || []),
    ...(_pld1.supports || []),
    ...(_pl4h.swingLow  ? [_pl4h.swingLow]  : []),
    ...(_pld1.swingLow  ? [_pld1.swingLow]  : []),
  ].filter(s => s > 0 && s < price * 0.999).sort((a, b) => b - a);
  // 週線：僅供長線 TP 使用，不合併進主池（避免過遠的週線 SL 偏移）
  const _w1Resists = [
    ...(_plw1.resistances || []),
    ...(_plw1.swingHigh ? [_plw1.swingHigh] : []),
  ].filter(r => r > price * 1.001).sort((a, b) => a - b);
  const _w1Supps = [
    ...(_plw1.supports || []),
    ...(_plw1.swingLow  ? [_plw1.swingLow]  : []),
  ].filter(s => s > 0 && s < price * 0.999).sort((a, b) => b - a);
  // 將 4H/日線 S/R 合併進主池（去重容差 1.2%）
  const _mergeR = v => { if (!resists.some(r => Math.abs(r - v) < price * 0.012)) resists.push(v); };
  const _mergeS = v => { if (!supps.some(s => Math.abs(s - v) < price * 0.012)) supps.push(v); };
  _htfResists.forEach(_mergeR); _htfSupps.forEach(_mergeS);
  resists = resists.sort((a, b) => a - b);
  supps   = supps.sort((a, b) => b - a);
  // Helper：辨識某個位是否屬於 HTF 等級，供 TP/SL Reason 標注時間框架
  const _htfTfLabel = v => {
    if (_w1Resists.some(x => Math.abs(x - v) < price * 0.015) || _w1Supps.some(x => Math.abs(x - v) < price * 0.015)) return '週線';
    if (_htfResists.some(x => Math.abs(x - v) < price * 0.015) || _htfSupps.some(x => Math.abs(x - v) < price * 0.015)) return '4H/日線';
    return '1H';
  };

  // 訂單流 & RSI 斜率
  const of15m    = mtfData['15m']?.orderFlow;
  const buyPct   = of15m?.buyPct   || 50;
  const cvdTrend = of15m?.cvdTrend || 'neutral';
  const rsiSlope = h1?.rsiSlope    || 0;
  const rsi      = parseFloat(coin.rsi) || 50;

  // ── 本週 / 今日 AI 走勢（提前計算，震盪模式判斷需在第一個 wait 之前）──
  let weeklyBiasData, todayBiasData, _btsNetDir;
  try {
    weeklyBiasData = computeWeeklyAIBias(fearGreed, globalMkt);
    todayBiasData  = computeTodayAIBias(fearGreed, globalMkt);
    _btsNetDir     = computeMacroNetDir(fearGreed, globalMkt);
  } catch(e) {
    console.warn('[buildTradeSetup] AI bias 計算失敗，降級為中性:', e);
    weeklyBiasData = { bias: 'neutral', biasLabel: '◆ 震盪中性', conf: 50, rangeMode: true, highEvs: [] };
    todayBiasData  = { bias: 'neutral', biasLabel: '◆ 震盪中性', conf: 50, rangeMode: true, highEvs: [] };
    _btsNetDir     = 'neutral';
  }
  // 提前提取 bias 字串（後續方向對齊、懲罰計算均需要）
  const _wBias = weeklyBiasData.bias || '';
  const _tBias = todayBiasData.bias  || '';
  // isRangeMode：4 個因子中 3 個以上為震盪/中性 → 震盪交易模式
  // 因子1（4H/日線圖表）：任一無明確方向即算震盪（OR 邏輯，兩者各計一票合併為一票）
  // 因子2（大方向/宏觀）：bull/bear/strong_bull/strong_bear = 有方向；其餘（含 slight）= 震盪
  // 因子3（本週AI預測）：同上規則
  // 因子4（今日AI預測）：同上規則
  const _h4IsRange  = !h4?.signal?.includes('bull') && !h4?.signal?.includes('bear');
  const _d1IsRange  = !d1sig_?.signal?.includes('bull') && !d1sig_?.signal?.includes('bear');
  const _h4dIsRange = _h4IsRange || _d1IsRange;  // 任一無明確方向即觸發
  const _DIRECTIONAL = ['bull','bear','strong_bull','strong_bear'];
  const _macroRangeish  = !_DIRECTIONAL.includes(_btsNetDir);
  const _weeklyRangeish = !_DIRECTIONAL.includes(_wBias);
  const _todayRangeish  = !_DIRECTIONAL.includes(_tBias);
  const _rngFactors = (_h4dIsRange ? 1 : 0) + (_macroRangeish ? 1 : 0) + (_weeklyRangeish ? 1 : 0) + (_todayRangeish ? 1 : 0);
  const isRangeMode = _rngFactors >= 3;
  // 4H / 日線信號（供範圍卡顯示及短線標籤判斷）
  const _h4Bull_r  = h4?.signal?.includes('bull');
  const _h4Bear_r  = h4?.signal?.includes('bear');
  const _dayBull_r = d1sig_?.signal?.includes('bull');
  const _dayBear_r = d1sig_?.signal?.includes('bear');

  // ── 定向單方向一致性門檻：大方向宏觀、本週AI、今日AI 其中兩個需同向 ──
  // slight_bull/slight_bear 算同向；neutral 不算同向
  // 震盪單不受此限制（震盪單靠影線/RSI進場，不依賴方向指標）
  let _dirAlignMiss = '';
  if (!isRangeMode && direction !== 'wait') {
    const _isLongDir  = direction === 'long';
    const _macAgrDir  = (_isLongDir && _btsNetDir.includes('bull')) || (!_isLongDir && _btsNetDir.includes('bear'));
    const _wkAgrDir   = (_isLongDir && _wBias.includes('bull'))     || (!_isLongDir && _wBias.includes('bear'));
    const _tdAgrDir   = (_isLongDir && _tBias.includes('bull'))     || (!_isLongDir && _tBias.includes('bear'));
    const _alignCnt   = (_macAgrDir ? 1 : 0) + (_wkAgrDir ? 1 : 0) + (_tdAgrDir ? 1 : 0);
    if (_alignCnt < 2) {
      direction = 'wait';
      _dirAlignMiss = `大方向宏觀/本週/今日預測僅 ${_alignCnt} 個與${_isLongDir ? '多' : '空'}方向一致（需 ≥ 3）`;
    }
  }

  if (direction === 'wait') {
    const reasons = [];
    // 大趨勢攔截說明優先顯示
    if (bigTrendBlocked) reasons.push(`🚫 ${bigTrendBlockReason}`);
    if (_dirAlignMiss) reasons.push(`📊 ${_dirAlignMiss}`);
    if (!bigTrendBlocked) {
      if (primaryBull === 0 && primaryBear === 0) reasons.push('15m/1h 尚未出現明確突破訊號');
      if (coin.adx < 18) reasons.push(`ADX ${coin.adx} 過低，短線震盪不宜追`);
      if (coin.rsi > 72) reasons.push(`RSI ${coin.rsi} 超買，短線追多風險高`);
      if (coin.rsi < 28) reasons.push(`RSI ${coin.rsi} 超賣，短線追空風險高`);
      if (totalBull === totalBear) reasons.push('多空積分相當，等待方向選擇');
      if (coin.score >= 41 && coin.score <= 59) reasons.push(`評分 ${coin.score}，需達 60+ 才推薦做多，40 以下才推薦做空`);
    }
    const entryHigh = resists[0] || swHigh;
    const entryLow  = supps[0]  || swLow;
    // 大時間框架趨勢狀態顯示（硬性條件：4H + 15m 同向）
    const h4Clr_w  = h4?.signal?.includes('bull') ? 'var(--bull)' : h4?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)';
    const m15Clr_w = m15?.signal?.includes('bull') ? 'var(--bull)' : m15?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)';
    const d1Clr_w  = d1sig_?.signal?.includes('bull') ? 'var(--bull)' : d1sig_?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)';
    const bigTrendPanel = `<div style="margin-top:12px;padding:10px 12px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.2);border-radius:9px">
      <div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px">📐 進場硬性條件（4H + 15m）</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span style="font-size:0.73rem;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.05);color:${h4Clr_w};border:1px solid ${h4Clr_w}40">4H ${h4TrendLabel}${h4?.rsi != null ? ' RSI '+h4.rsi : ''}</span>
        <span style="font-size:0.73rem;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.05);color:${m15Clr_w};border:1px solid ${m15Clr_w}40">15m ${m15TrendLabel}</span>
        <span style="font-size:0.73rem;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.05);color:${d1Clr_w};border:1px solid ${d1Clr_w}40">日線 ${d1TrendLabel}（參考）</span>
        ${bigTrendBlocked ? `<span style="font-size:0.73rem;color:var(--bear);font-weight:600">❌ 硬性條件未達標</span>` : `<span style="font-size:0.73rem;color:#f59e0b">⚠️ 等待進場信號</span>`}
      </div>
    </div>`;
    const _wWait = weeklyBiasData?.biasLabel || '—';
    const _tWait = todayBiasData?.biasLabel  || '—';
    const _wBiasWait = weeklyBiasData?.bias || 'neutral';
    const _tBiasWait = todayBiasData?.bias  || 'neutral';
    const _wClr1 = _wBiasWait.includes('bull') ? 'var(--bull)' : _wBiasWait.includes('bear') ? 'var(--bear)' : '#f59e0b';
    const _tClr1 = _tBiasWait.includes('bull') ? 'var(--bull)' : _tBiasWait.includes('bear') ? 'var(--bear)' : '#f59e0b';
    return `<div class="setup-wait">
      <div class="setup-wait-icon">${bigTrendBlocked ? '🚫' : '⏳'}</div>
      <div class="setup-wait-title">${bigTrendBlocked ? '大小趨勢方向衝突，暫不進場' : '建議觀望，短線方向未明'}</div>
      <ul class="setup-wait-reasons">
        ${reasons.length ? reasons.map(r => `<li>${r}</li>`).join('') : '<li>短線訊號不足，耐心等待 15m/1h 有效突破</li>'}
      </ul>
      ${bigTrendPanel}
      <div style="margin-top:10px;padding:10px 12px;background:rgba(129,140,248,.05);border:1px solid rgba(129,140,248,.15);border-radius:9px">
        <div style="font-size:0.73rem;font-weight:600;color:var(--text2);margin-bottom:7px">🤖 AI 趨勢預測（本週 · 今日）</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <span style="font-size:0.73rem;padding:3px 10px;border-radius:16px;border:1px solid ${_wClr1}40;color:${_wClr1}">📈 本週 ${_wWait}（${weeklyBiasData?.conf || 50}%）</span>
          <span style="font-size:0.73rem;padding:3px 10px;border-radius:16px;border:1px solid ${_tClr1}40;color:${_tClr1}">📅 今日 ${_tWait}（${todayBiasData?.conf || 50}%）</span>
        </div>
      </div>
      ${!bigTrendBlocked ? `<div class="setup-wait-cond">
        <strong>等待條件：</strong>15m/1h 帶量實體K棒收破
        <span style="color:var(--bull)">${fmtPrice(entryHigh)}</span>（做多）
        或 <span style="color:var(--bear)">${fmtPrice(entryLow)}</span>（做空）
      </div>` : ''}
    </div>`;
  }

  // ── H4 區間震盪偵測（3+ 收針確認高低點，有效反轉信號後才出建議）────────
  try {
    const _h4Raw = mtfData['4h']?.raw;
    const _rs = detectRangeStructure(coin, _h4Raw, h4, d1sig_, atr);
    if (_rs.isRange && !bigTrendBlocked) {
      const _rtol = atr * 0.7;
      let _rDir = null;
      if      (price <= _rs.rangeLow  + _rtol) _rDir = 'long';
      else if (price >= _rs.rangeHigh - _rtol) _rDir = 'short';
      if (_rDir) {
        const _rev = detectRangeReversal(coin, _h4Raw, _rDir, _rs, atr);
        if (_rev.hasReversal) {
          const _rIsLong = _rDir === 'long';
          // ── 風控分：宏觀扣分 → AI趨勢扣分 → 技術扣分 → 止損記憶扣分 ──
          const _rBase = Math.min(80, 60 + Math.round(_rs.qualityScore * 6));
          let _rMacroPen = 0;
          try {
            if (fearGreed || globalMkt) {
              const _rfgV = fearGreed ? parseInt(fearGreed.value || '50') : 50;
              const _rchg = globalMkt?.marketCapChange || 0;
              const _rdom = globalMkt?.btcDominance   || 50;
              let _ragt = 0;
              if (_rIsLong) {
                if (_rchg < -2) _ragt++;
                if (_rdom > 58) _ragt++;
                if (_rfgV < 30) _ragt++;
                if (_rfgV > 75) _ragt += 0.5;
              } else {
                if (_rchg > 2)  _ragt++;
                if (_rdom < 44) _ragt++;
                if (_rfgV > 70) _ragt++;
                if (_rfgV < 25) _ragt += 0.5;
              }
              _rMacroPen = _ragt >= 3 ? 18 : _ragt >= 2 ? 12 : _ragt >= 1 ? 5 : 0;
            }
          } catch(_rme) {}
          let _rAIPen = 0;
          try {
            const _rwBias = weeklyBiasData.bias || '';
            const _rtBias = todayBiasData.bias  || '';
            if (_rIsLong ? _rwBias.includes('bear') : _rwBias.includes('bull'))
              _rAIPen += _rwBias.includes('strong') ? 8 : 4;
            if (_rIsLong ? _rtBias.includes('bear') : _rtBias.includes('bull'))
              _rAIPen += 5;
          } catch(_rae) {}
          const _rAdxPen = coin.adx < 15 ? 10 : coin.adx < 18 ? 5 : 0;
          let _rLearnPen = 0, _rHardBlocked = false;
          try {
            const _rLearn = applyLearnAdjustment(_rDir, rsi, coin.adx || 20, {});
            _rLearnPen = _rLearn.penalty || 0;
            _rHardBlocked = _rLearn.hardBlocked || false;
          } catch(_rle) {}
          const _rConf = Math.max(0, _rBase - _rMacroPen - _rAIPen - _rAdxPen - _rLearnPen);

          if (_rConf >= 50 && !_rHardBlocked) {
            // TP1 = 區間中點；TP2 = 對面邊界
            const _rTP1   = _rs.rangeMid;
            const _rTP2   = _rIsLong ? _rs.rangeHigh : _rs.rangeLow;
            const _rSL    = _rIsLong ? _rs.rangeLow - atr * 0.3 : _rs.rangeHigh + atr * 0.3;
            const _rEntry = price;
            const _rRisk  = Math.abs(_rEntry - _rSL) || atr * 0.5;
            const _rRR1   = (Math.abs(_rTP1 - _rEntry) / _rRisk).toFixed(1);
            const _rRR2   = (Math.abs(_rTP2 - _rEntry) / _rRisk).toFixed(1);
            const _rIcon  = _rIsLong ? '▲' : '▼';
            const _rColor = _rIsLong ? 'var(--bull)' : 'var(--bear)';
            const _rSlReason   = `${_rIsLong ? '跌破' : '突破'}區間${_rIsLong ? '低點' : '高點'} ${fmtPrice(_rIsLong ? _rs.rangeLow : _rs.rangeHigh)} 止損`;
            const _rTp1Reason  = `區間中點止盈 ${fmtPrice(_rTP1)}，R/R ${_rRR1}:1`;
            const _rTp2Reason  = `區間${_rIsLong ? '高點' : '低點'}延伸目標 ${fmtPrice(_rTP2)}，R/R ${_rRR2}:1`;
            const rEntryReasons = [
              `🔄 H4區間震盪（高點${_rs.resistanceTouches}次/${_rs.resistancePinBars}根收針，低點${_rs.supportTouches}次/${_rs.supportPinBars}根收針）`,
              `${_rIsLong ? '支撐區' : '壓力區'} ${fmtPrice(_rIsLong ? _rs.rangeLow : _rs.rangeHigh)} 出現反轉：${_rev.signals.join('、')}`,
              `本週 ${weeklyBiasData.biasLabel} ／ 今日 ${todayBiasData.biasLabel}`,
            ];
            _tradeSetupCache[coin.symbol] = {
              direction: _rDir, tradeType: 'range',
              entry: _rEntry, sl: _rSL, tp1: _rTP1, tp2: _rTP2,
              entryReason: rEntryReasons.join('，'),
              entryReasons: [...rEntryReasons],
              slReason: _rSlReason, tp1Reason: _rTp1Reason, tp2Reason: _rTp2Reason,
              rr1: _rRR1, rr2: _rRR2, atr, conf: _rConf, rawConf: _rBase,
              learnPenalty: _rLearnPen, hardAdxPenalty: _rAdxPen,
              macroPenalty: _rMacroPen, aiTrendPenalty: _rAIPen,
              weeklyBias: weeklyBiasData.biasLabel, weeklyConf: weeklyBiasData.conf,
              todayBias: todayBiasData.biasLabel, todayConf: todayBiasData.conf,
              rangeMacroDir: _btsNetDir, bigTrend: 'range', bigTrendBlocked: false,
              h4TrendLabel, d1TrendLabel, hardBlocked: false,
              blockReasons: [], learnWarnings: [], defenseChecks: [],
              flipRisks: [], macroReasons: [], aiTrendReasons: [],
              rangeStruct: { rangeHigh: _rs.rangeHigh, rangeLow: _rs.rangeLow, rangeMid: _rs.rangeMid },
            };
            const tlogR = loadTradeLog();
            const hasActiveR = tlogR.some(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending') && t.entry);
            if (!hasActiveR) {
              tlogR.push({
                id: `${coin.symbol}_${Date.now()}`,
                symbol: coin.symbol, direction: _rDir, tradeType: 'range',
                entry: _rEntry, sl: _rSL, tp1: _rTP1, tp2: _rTP2,
                entryReason: rEntryReasons[1],
                slReason: _rSlReason, tp1Reason: _rTp1Reason, tp2Reason: _rTp2Reason,
                conf: _rConf, rawConf: _rBase, atr,
                learnPenalty: _rLearnPen, hardAdxPenalty: _rAdxPen,
                macroPenalty: _rMacroPen, aiTrendPenalty: _rAIPen,
                status: 'pending', entryTime: null, timestamp: Date.now(),
                score: coin.score, adx: coin.adx, rsi,
                refined: false, scaleIns: [],
              });
              saveTradeLog(tlogR);
            }
            return `<div class="setup-verdict ${_rIsLong ? 'verdict-long' : 'verdict-short'}">
              <div class="verdict-dir">
                <span class="verdict-arrow">${_rIcon}</span>
                <span class="verdict-label">${_rIsLong ? '區間做多' : '區間做空'}</span>
                <span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:2px 8px;border-radius:20px;font-size:0.72rem;font-weight:700;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);color:#a5b4fc">🔄 震盪交易</span>
                <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">區間高低點來回操作</span>
              </div>
              <div class="verdict-conf-wrap">
                <span style="font-size:0.78rem;color:var(--text3)">風控分</span>
                <div class="conf-bar"><div class="conf-fill" style="width:${_rConf}%;background:${_rColor}"></div></div>
                <span style="color:${_rColor};font-weight:700;font-size:0.9rem">${_rConf} 分</span>${_rConf < 60 ? '<span style="font-size:0.7rem;color:#f59e0b;margin-left:4px">低於門檻</span>' : ''}
              </div>
              <div style="margin-top:10px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.18);border-radius:10px;padding:10px 12px;font-size:0.8rem">
                <div style="color:var(--text2);font-weight:600;margin-bottom:6px">🔄 H4 區間震盪分析</div>
                <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px">
                  <span style="font-size:0.73rem;color:var(--text3)">區間高點：<b style="color:var(--bear)">${fmtPrice(_rs.rangeHigh)}</b>（${_rs.resistanceTouches}次觸碰，${_rs.resistancePinBars}根收針）</span>
                  <span style="font-size:0.73rem;color:var(--text3)">區間低點：<b style="color:var(--bull)">${fmtPrice(_rs.rangeLow)}</b>（${_rs.supportTouches}次觸碰，${_rs.supportPinBars}根收針）</span>
                </div>
                <div style="color:var(--text3);font-size:0.73rem;margin-bottom:4px">反轉信號：<b style="color:${_rColor}">${_rev.signals.join('、')}</b>（強度 ${_rev.strength.toFixed(1)}）</div>
                <div style="color:var(--text3);font-size:0.73rem">本週 AI：<b style="color:var(--text2)">${weeklyBiasData.biasLabel}</b> ／ 今日 AI：<b style="color:var(--text2)">${todayBiasData.biasLabel}</b></div>
              </div>
            </div>
            <div class="setup-levels" style="margin-top:10px">
              <div class="level-row level-entry">
                <div class="level-tag">📍 進場位</div>
                <div class="level-desc">${_rIsLong ? '支撐區' : '壓力區'} ${fmtPrice(_rIsLong ? _rs.rangeLow : _rs.rangeHigh)} 附近出現反轉，確認進場</div>
                <div class="level-price-val">${fmtPrice(_rEntry)}</div>
              </div>
              <div class="level-row level-tp1">
                <div class="level-tag">🎯 止盈一</div>
                <div class="level-desc">${_rTp1Reason}</div>
                <div class="level-price-val">${fmtPrice(_rTP1)}</div>
              </div>
              <div class="level-row level-tp2">
                <div class="level-tag">🚀 止盈二</div>
                <div class="level-desc">${_rTp2Reason}</div>
                <div class="level-price-val">${fmtPrice(_rTP2)}</div>
              </div>
              <div class="level-row level-sl">
                <div class="level-tag">🛑 止損</div>
                <div class="level-desc">${_rSlReason}</div>
                <div class="level-price-val">${fmtPrice(_rSL)}</div>
              </div>
            </div>`;
          }
        }
      }
    }
  } catch(_rse) { console.warn('[range detect]', coin?.symbol, _rse); }

  const isLong   = direction === 'long';
  const dirColor = isLong ? 'var(--bull)' : 'var(--bear)';
  let   dirLabel = isLong ? '短線做多' : '短線做空';
  const dirIcon  = isLong ? '▲' : '▼';
  // 震盪模式標記：方向明確但宏觀+今日AI中性 → 標示為「🔄 震盪交易」
  const rangeTagHtml = isRangeMode
    ? `<span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:2px 8px;border-radius:20px;font-size:0.72rem;font-weight:700;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);color:#a5b4fc">🔄 震盪交易</span>`
    : '';

  // AI 長線分析（僅括號標注，不另開面板）
  const ltBias = computeLongTermBias(mtfData);
  // 方向一致才標示〔長線單〕（不需區分看多/看空，配對即可）
  // 長線風控分：85+ 才允許加倉（canScaleIn = true），ltTag 與 layout 保持一致
  // 長線單需要日線 + 週線或月線共識（月線權重最高）
  let ltBullScore = 0, ltBearScore = 0;
  const ltWeights = { '1d': 1, '1w': 3, '1M': 4 };
  for (const [tf, w] of Object.entries(ltWeights)) {
    const sig = mtfData[tf]?.signal;
    if (!sig) continue;
    if (sig.signal?.includes('bull')) ltBullScore += w;
    if (sig.signal?.includes('bear')) ltBearScore += w;
    const rsi = sig.rsi || 50;
    if (rsi < 42) ltBullScore += w * 0.4;
    if (rsi > 58) ltBearScore += w * 0.4;
  }
  const ltRawScore = ltBias === 'long' ? ltBullScore : ltBias === 'short' ? ltBearScore : 0;
  // 週線不存在時 ltBias 必為 neutral（computeLongTermBias 已保障），故 ltConf=0
  const ltConf     = ltBias !== 'neutral' ? Math.round(Math.min(95, 55 + ltRawScore * 8)) : 0;
  // 長線單額外條件：宏觀/本週AI/今日AI 三者中 2+ 個同向（供參考，不再單獨決定 canScaleIn）
  const _ltIsLong  = direction === 'long';
  const _ltMacAgr  = (_ltIsLong && _btsNetDir.includes('bull'))  || (!_ltIsLong && _btsNetDir.includes('bear'));
  const _ltWkAgr   = (_ltIsLong && _wBias.includes('bull'))      || (!_ltIsLong && _wBias.includes('bear'));
  const _ltTdAgr   = (_ltIsLong && _tBias.includes('bull'))      || (!_ltIsLong && _tBias.includes('bear'));
  const _ltAlignCnt = (_ltMacAgr ? 1 : 0) + (_ltWkAgr ? 1 : 0) + (_ltTdAgr ? 1 : 0);

  // 多週期同向判斷
  const dayS   = mtfData['1d']?.signal;
  const wkS    = mtfData['1w']?.signal;
  const dayBullSig = dayS?.signal?.includes('bull');
  const dayBearSig = dayS?.signal?.includes('bear');
  const wkBullSig  = wkS?.signal?.includes('bull');
  const wkBearSig  = wkS?.signal?.includes('bear');
  const m15BullSig = m15?.signal?.includes('bull');
  const m15BearSig = m15?.signal?.includes('bear');
  const h1BullSig  = h1?.signal?.includes('bull');
  const h1BearSig  = h1?.signal?.includes('bear');
  const h4BullSig  = h4?.signal?.includes('bull');
  const h4BearSig  = h4?.signal?.includes('bear');

  // 短線單：15m + 1H + 4H + 日線全部同向
  const _4tfAligned = isLong
    ? (m15BullSig && h1BullSig && h4BullSig && dayBullSig)
    : (m15BearSig && h1BearSig && h4BearSig && dayBearSig);

  // 長線單：短線 4 框基礎上再加週線（長線包含短線邏輯）
  const _5tfAligned = _4tfAligned && (isLong ? wkBullSig : wkBearSig);

  const isDayAligned = isLong ? dayBullSig : dayBearSig;

  // 長線單條件：五週期全部同向 + 長線信心 ≥ 85%
  const _dayWkAligned = _5tfAligned && ltConf >= 85;
  let canScaleIn = _dayWkAligned;
  let ltTag = canScaleIn ? ' <span class="lt-tag lt-bull">〔長線單〕</span>' : '';
  // 根據類型更新 dirLabel
  if (canScaleIn) dirLabel = isLong ? '長線做多' : '長線做空';
  else if (!isRangeMode && _4tfAligned) dirLabel = isLong ? '短線做多' : '短線做空';
  else if (!isRangeMode && isDayAligned) dirLabel = isLong ? '做多' : '做空';
  else if (!isRangeMode) dirLabel = isLong ? '做多' : '做空';

  // ── ICT / SMC / SNR 分析（Kill Zone + Order Block + FVG + Premium/Discount）──
  const _kz    = computeKillZone();
  const _raw1h = mtfData['1h']?.raw;
  const _raw4h = mtfData['4h']?.raw;
  let _ictOB = null, _ictFVG = null, _ictPD = null, _ictOB4h = null, _ictFVG4h = null;
  try {
    if (_raw1h?.length >= 5 && typeof detectOrderBlocks   === 'function') _ictOB   = detectOrderBlocks(_raw1h, isLong);
    if (_raw1h?.length >= 5 && typeof detectFairValueGaps === 'function') _ictFVG  = detectFairValueGaps(_raw1h, isLong);
    if (_raw1h?.length >= 5 && typeof computePremiumDiscount === 'function') _ictPD = computePremiumDiscount(_raw1h);
    if (_raw4h?.length >= 5 && typeof detectOrderBlocks   === 'function') _ictOB4h  = detectOrderBlocks(_raw4h, isLong);
    if (_raw4h?.length >= 5 && typeof detectFairValueGaps === 'function') _ictFVG4h = detectFairValueGaps(_raw4h, isLong);
  } catch(_icte) { console.warn('[ICT analysis]', _icte); }

  // ── ICT 五大模型偵測（Turtle Soup / 2022 Core / Unicorn / Silver Bullet）──
  let _turtleSoup = null, _coreModel = null, _unicornModel = null, _silverBullet = null;
  try {
    if (_raw1h?.length >= 30) {
      if (typeof detectTurtleSoup    === 'function') _turtleSoup   = detectTurtleSoup(_raw1h);
      if (typeof detectCoreModel2022 === 'function') _coreModel    = detectCoreModel2022(_raw1h, isLong);
      if (typeof detectUnicornModel  === 'function') _unicornModel = detectUnicornModel(_raw1h, isLong);
      if (typeof detectSilverBullet  === 'function') _silverBullet = detectSilverBullet(_raw1h, isLong);
    }
  } catch(_ict2e) { console.warn('[ICT models]', _ict2e); }

  // ── 圖形識別（傳統技術形態 + ICT）── 以 4H K線為主
  let _chartPat = { patterns: [], score: 0, aligned: [], opposing: [], neutral: [] };
  try {
    if (_raw4h?.length >= 30 && typeof detectChartPatterns === 'function')
      _chartPat = detectChartPatterns(_raw4h, isLong);
  } catch(_cpe) {}

  // ── 真假突破確認 ──
  let _breakoutCheck = { confirmed: true, warn: '' };
  const _hasBreakPatterns = _chartPat.patterns.some(p => p.name.includes('突破') || p.name.includes('BOS') || p.name.includes('CHoCH'));
  if (_hasBreakPatterns && _raw1h?.length >= 12 && typeof verifyBreakoutConfirmed === 'function') {
    try { _breakoutCheck = verifyBreakoutConfirmed(_raw1h, isLong); } catch(_bce) {}
    // 假突破：將突破類型pattern標記為未確認（移出aligned，歸入neutral）
    if (!_breakoutCheck.confirmed) {
      _chartPat.patterns = _chartPat.patterns.map(p =>
        (p.name.includes('突破') || p.name.includes('BOS')) && p.aligned === true
          ? { ...p, aligned: null, strength: 'weak', desc: p.desc + '（⚠️ 待確認）' }
          : p
      );
      _chartPat.aligned  = _chartPat.patterns.filter(p => p.aligned === true);
      _chartPat.neutral  = _chartPat.patterns.filter(p => p.aligned === null);
      _chartPat.score    = Math.max(0, _chartPat.score - 1);
    }
  }

  // ── 進場點 ──
  const m15ema = m15?.ema20 || parseFloat(coin.ema20) || price;
  let entry, entryReasons = [];
  if (isLong) {
    const near4hSup = _htfSupps.find(s => (price - s) < atr * 1.0);
    const nearSup   = supps[0];
    if (near4hSup && (price - near4hSup) < atr * 0.8) {
      entry = Math.min(price, near4hSup + atr * 0.12);
      entryReasons.push(`${_htfTfLabel(near4hSup)}結構支撐 ${fmtPrice(near4hSup)} 確認進場`);
    } else if (nearSup && (price - nearSup) < atr * 0.8) {
      entry = Math.min(price, nearSup + atr * 0.15);
      entryReasons.push(`1H 結構支撐 ${fmtPrice(nearSup)} 附近確認`);
    } else if (m15ema < price && (price - m15ema) < atr * 0.6) {
      entry = Math.min(price, m15ema * 1.002);
      entryReasons.push(`貼近 15m EMA20（${fmtPrice(m15ema)}）`);
    } else {
      entry = price;
    }
    if (rsi < 45 && rsiSlope > 1)  entryReasons.push(`RSI ${rsi} 低位回升（+${rsiSlope}）`);
    else if (rsi < 38)             entryReasons.push(`RSI ${rsi} 超賣反彈機會`);
    if (buyPct > 57)               entryReasons.push(`主動買盤佔 ${buyPct}%`);
    if (cvdTrend === 'bull')       entryReasons.push('CVD 上升 買壓持續');
    if (whale?.bias === 'bull' && whale.bigBuyCount >= 3)
      entryReasons.push(`巨鯨大額買入 ${whale.bigBuyCount} 筆`);
    if (vp1h && vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 3)
      entryReasons.push(`POC $${fmtPrice(vp1h.poc)} 上方 籌碼結構看多`);
    if (vp1h && !vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 1.5)
      entryReasons.push(`逼近POC $${fmtPrice(vp1h.poc)} 籌碼磁吸`);
    // 足跡圖 Delta 確認（方向 + 吸收 + POC）
    if (_fpBTS?.deltaDir === 'bull')  entryReasons.push(`📊 足跡圖 Delta 偏多（累積買超）`);
    if (_fpBTS?.absorption)           entryReasons.push(`🔄 足跡圖買方吸收（賣壓持續被消化）`);
    if (_fpBTS?.poc && Math.abs(price - _fpBTS.poc) / price < 0.012)
      entryReasons.push(`🎯 足跡 POC ${fmtPrice(_fpBTS.poc)} 支撐確認`);
    if (_fpBTS?.deltaDiv) entryReasons.push(`⚠️ 足跡圖 Delta 背離，注意方向轉換風險`);
    // Volume AI entry confluence
    const volAI1h = mtfData['1h']?.volAI;
    if (volAI1h) {
      if (volAI1h.isBreakout && volAI1h.bias === 'bull')
        entryReasons.push(`放量突破 ${volAI1h.volRatio}x均量 量價齊升`);
      else if (volAI1h.isSpike && volAI1h.bias === 'bull')
        entryReasons.push(`成交量暴增 ${volAI1h.volRatio}x 主動買盤主導`);
      if (volAI1h.divergence === 'bullish_div')
        entryReasons.push('量能看漲背離 下跌動能衰竭');
    }
    // 市場陷阱偵測：PO3 / 2B / 流動性掃蕩
    const traps1h = mtfData['1h']?.traps;
    const traps15 = mtfData['15m']?.traps;
    const bullTraps = [
      traps1h?.po3Bull?.label, traps1h?.twoB_Bull?.label, traps1h?.sweepBull?.label,
      traps15?.po3Bull?.label, traps15?.sweepBull?.label,
      traps4h__?.po3Bull?.label   && `4H ${traps4h__?.po3Bull?.label}`,
      traps4h__?.twoB_Bull?.label && `4H ${traps4h__?.twoB_Bull?.label}`,
      traps4h__?.sweepBull?.label && `4H ${traps4h__?.sweepBull?.label}`,
    ].filter(Boolean);
    bullTraps.forEach(t => entryReasons.push(`📌 ${t}`));
    // 長線單：週線同向確認寫入進場理由
    if (canScaleIn) entryReasons.unshift(`日線 + 週線同向確認 長線多頭趨勢成立`);
    // ── 布林通道型態（走軌/收窄/背離）& 123法則/2B法則 ──
    if (bb1h_?.walkingBull)   entryReasons.push(`📈 BB多頭走軌 強勢上軌延續`);
    if (bb1h_?.isSqueezing && bb1h_?.pctB >= 0.5) entryReasons.push(`🔋 BB收窄蓄力 多頭突破準備`);
    if (bb1h_?.bbDivBear)     entryReasons.push(`⚠️ BB頂背離 注意動能衰竭`);
    if (bb15m_?.walkingBull)  entryReasons.push(`📈 15m BB多頭走軌`);
    // 123法則 / 2B法則（使用 coin.patterns 掃描時段數據）
    if (coin.patterns?.bull123) entryReasons.push(`📐 123多頭型態 趨勢反轉確立`);
    if (coin.patterns?.bull2B)  entryReasons.push(`🔄 2B多頭型態 空頭陷阱解除`);
    // 基礎技術指標（補充或作為主要進場依據）
    const ema50L  = parseFloat(coin.ema50)  || 0;
    const ema200L = parseFloat(coin.ema200) || 0;
    const macdHL  = parseFloat(coin.macdHist) || 0;
    const momL    = parseFloat(coin.momentum)  || 0;
    const volStrL = coin.volumeStrength || '';
    const adxL    = parseFloat(coin.adx) || 20;
    if (rsi >= 45 && rsi < 65) entryReasons.push(`RSI ${rsi} 積極偏多`);
    else if (rsi >= 65)        entryReasons.push(`RSI ${rsi} 強勢偏多`);
    if (ema50L > 0 && price > m15ema && m15ema > ema50L) entryReasons.push(`EMA 多頭排列 趨勢向上`);
    else if (price > m15ema && !entryReasons.some(r => r.includes('EMA20'))) entryReasons.push(`價格站上 EMA20 短線偏多`);
    if (ema200L > 0 && price > ema200L) entryReasons.push(`價格在 EMA200 上方 長線支撐`);
    if (macdHL > 0)  entryReasons.push(`MACD 柱狀翻正 多頭動能確認`);
    if (momL > 0)    entryReasons.push(`動量正值 上行動能`);
    if (volStrL === '高') entryReasons.push(`高量配合 量價齊升`);
    if (adxL > 35)   entryReasons.push(`ADX ${adxL} 強趨勢 追多有效`);
    else if (adxL > 22) entryReasons.push(`ADX ${adxL} 趨勢成形`);
    const scoreL = coin.score || 60;
    if (!entryReasons.some(r => r.includes('評分'))) {
      if (scoreL >= 85) entryReasons.push(`綜合評分 ${scoreL} 強勢看漲`);
      else if (scoreL >= 65) entryReasons.push(`綜合評分 ${scoreL} 多頭信號確認`);
    }
    if (!entryReasons.length) entryReasons.push('15m/1h 多頭信號共振');
  } else {
    const near4hRes = _htfResists.find(r => (r - price) < atr * 1.0);
    const nearRes   = resists[0];
    if (near4hRes && (near4hRes - price) < atr * 0.8) {
      entry = Math.max(price, near4hRes - atr * 0.12);
      entryReasons.push(`${_htfTfLabel(near4hRes)}結構壓力 ${fmtPrice(near4hRes)} 確認進場`);
    } else if (nearRes && (nearRes - price) < atr * 0.8) {
      entry = Math.max(price, nearRes - atr * 0.15);
      entryReasons.push(`1H 結構壓力 ${fmtPrice(nearRes)} 附近確認`);
    } else if (m15ema > price && (m15ema - price) < atr * 0.6) {
      entry = Math.max(price, m15ema * 0.998);
      entryReasons.push(`貼近 15m EMA20（${fmtPrice(m15ema)}）`);
    } else {
      entry = price;
    }
    if (rsi > 55 && rsiSlope < -1) entryReasons.push(`RSI ${rsi} 高位回落（${rsiSlope}）`);
    else if (rsi > 62)             entryReasons.push(`RSI ${rsi} 超買回調機會`);
    if (buyPct < 43)               entryReasons.push(`主動賣盤佔 ${100 - buyPct}%`);
    if (cvdTrend === 'bear')       entryReasons.push('CVD 下降 賣壓持續');
    if (whale?.bias === 'bear' && whale.bigSellCount >= 3)
      entryReasons.push(`巨鯨大額賣出 ${whale.bigSellCount} 筆`);
    if (vp1h && !vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 3)
      entryReasons.push(`POC $${fmtPrice(vp1h.poc)} 下方 籌碼結構看空`);
    if (vp1h && vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 1.5)
      entryReasons.push(`逼近POC $${fmtPrice(vp1h.poc)} 磁吸阻力`);
    // 足跡圖 Delta 確認（方向 + POC + 背離）
    if (_fpBTS?.deltaDir === 'bear') entryReasons.push(`📊 足跡圖 Delta 偏空（累積賣超）`);
    if (_fpBTS?.poc && Math.abs(price - _fpBTS.poc) / price < 0.012)
      entryReasons.push(`🎯 足跡 POC ${fmtPrice(_fpBTS.poc)} 壓力確認`);
    if (_fpBTS?.deltaDiv) entryReasons.push(`⚠️ 足跡圖 Delta 背離，謹慎注意多空轉換`);
    // Volume AI entry confluence
    const volAI1hShort = mtfData['1h']?.volAI;
    if (volAI1hShort) {
      if (volAI1hShort.isBreakout && volAI1hShort.bias === 'bear')
        entryReasons.push(`放量突破 ${volAI1hShort.volRatio}x均量 量價齊跌`);
      else if (volAI1hShort.isSpike && volAI1hShort.bias === 'bear')
        entryReasons.push(`成交量暴增 ${volAI1hShort.volRatio}x 主動賣盤主導`);
      if (volAI1hShort.divergence === 'bearish_div')
        entryReasons.push('量能看跌背離 上漲動能不足');
    }
    // 市場陷阱偵測
    const traps1h_ = mtfData['1h']?.traps;
    const traps15_ = mtfData['15m']?.traps;
    const bearTraps = [
      traps1h_?.po3Bear?.label, traps1h_?.twoB_Bear?.label, traps1h_?.sweepBear?.label,
      traps15_?.po3Bear?.label, traps15_?.sweepBear?.label,
      traps4h__?.po3Bear?.label   && `4H ${traps4h__?.po3Bear?.label}`,
      traps4h__?.twoB_Bear?.label && `4H ${traps4h__?.twoB_Bear?.label}`,
      traps4h__?.sweepBear?.label && `4H ${traps4h__?.sweepBear?.label}`,
    ].filter(Boolean);
    bearTraps.forEach(t => entryReasons.push(`📌 ${t}`));
    // 長線單：週線同向確認寫入進場理由
    if (canScaleIn) entryReasons.unshift(`日線 + 週線同向確認 長線空頭趨勢成立`);
    // ── 布林通道型態（走軌/收窄/背離）& 123法則/2B法則 ──
    if (bb1h_?.walkingBear)   entryReasons.push(`📉 BB空頭走軌 強勢下軌延續`);
    if (bb1h_?.isSqueezing && bb1h_?.pctB < 0.5) entryReasons.push(`🔋 BB收窄蓄力 空頭突破準備`);
    if (bb1h_?.bbDivBull)     entryReasons.push(`⚠️ BB底背離 注意下跌動能衰竭`);
    if (bb15m_?.walkingBear)  entryReasons.push(`📉 15m BB空頭走軌`);
    // 123法則 / 2B法則（使用 coin.patterns 掃描時段數據）
    if (coin.patterns?.bear123) entryReasons.push(`📐 123空頭型態 趨勢反轉確立`);
    if (coin.patterns?.bear2B)  entryReasons.push(`🔄 2B空頭型態 多頭陷阱確認`);
    // 基礎技術指標（補充或作為主要進場依據）
    const ema50S  = parseFloat(coin.ema50)  || 0;
    const ema200S = parseFloat(coin.ema200) || 0;
    const macdHS  = parseFloat(coin.macdHist) || 0;
    const momS    = parseFloat(coin.momentum)  || 0;
    const volStrS = coin.volumeStrength || '';
    const adxS    = parseFloat(coin.adx) || 20;
    if (rsi <= 45 && rsi > 35) entryReasons.push(`RSI ${rsi} 偏弱 下行動能確認`);
    else if (rsi <= 35)        entryReasons.push(`RSI ${rsi} 弱勢偏空`);
    else if (rsi > 62)         entryReasons.push(`RSI ${rsi} 超買區 回落機會`);
    if (ema50S > 0 && price < m15ema && m15ema < ema50S) entryReasons.push(`EMA 空頭排列 趨勢向下`);
    else if (price < m15ema && !entryReasons.some(r => r.includes('EMA20'))) entryReasons.push(`價格跌破 EMA20 短線偏空`);
    if (ema200S > 0 && price < ema200S) entryReasons.push(`價格在 EMA200 下方 長線壓力`);
    if (macdHS < 0)  entryReasons.push(`MACD 柱狀負值 空頭動能確認`);
    if (momS < 0)    entryReasons.push(`動量負值 下行動能`);
    if (volStrS === '高') entryReasons.push(`高量配合 量價齊跌`);
    if (adxS > 35)   entryReasons.push(`ADX ${adxS} 強趨勢 追空有效`);
    else if (adxS > 22) entryReasons.push(`ADX ${adxS} 趨勢成形`);
    const scoreS = coin.score || 50;
    if (!entryReasons.some(r => r.includes('評分'))) {
      if (scoreS <= 15) entryReasons.push(`綜合評分 ${scoreS} 強勢看跌`);
      else if (scoreS <= 35) entryReasons.push(`綜合評分 ${scoreS} 空頭信號確認`);
    }
    if (!entryReasons.length) entryReasons.push('15m/1h 空頭信號共振');
  }

  // 圖形識別進場理由
  if (_chartPat.aligned.length > 0)
    _chartPat.aligned.slice(0, 2).forEach(p => entryReasons.push(`${p.emoji} ${p.name}：${p.desc}`));
  if (!_breakoutCheck.confirmed && _breakoutCheck.warn)
    entryReasons.push(`⚠️ 突破待確認：${_breakoutCheck.warn}`);

  // ── ICT/SMC 進場理由補充（共同適用多空）──
  try {
    if (_kz.quality === 'high') entryReasons.push(`${_kz.emoji} ${_kz.name}（${_kz.desc}）`);
    if (_ictOB?.priceInOB) entryReasons.push(`⚡ ${_ictOB.label} 訂單塊確認（ICT Order Block）`);
    if (_ictOB4h?.priceInOB) entryReasons.push(`⚡ 4H ${_ictOB4h.label} 訂單塊確認`);
    if (_ictFVG && !_ictFVG.filled) {
      const _fvgDir = isLong ? '多頭' : '空頭';
      entryReasons.push(`📊 ${_fvgDir} FVG 公平價值缺口 $${fmtPrice(_ictFVG.mid)} 尚未回補`);
    }
    if (_ictPD) {
      if (isLong && _ictPD.idealForLong)   entryReasons.push(`📉 折扣區（${_ictPD.zoneLabel} ${_ictPD.pctInRange.toFixed(0)}%）SMC 優質多頭進場位`);
      if (!isLong && _ictPD.idealForShort) entryReasons.push(`📈 溢價區（${_ictPD.zoneLabel} ${_ictPD.pctInRange.toFixed(0)}%）SMC 優質空頭進場位`);
    }
    // ICT 五大模型進場理由
    if (isLong  && _turtleSoup?.bull)            entryReasons.push(_turtleSoup.bull.label);
    if (!isLong && _turtleSoup?.bear)            entryReasons.push(_turtleSoup.bear.label);
    if (_coreModel?.detected)                    entryReasons.push(_coreModel.label);
    if (_unicornModel?.priceInGoldenZone)        entryReasons.push(_unicornModel.label);
    if (_silverBullet?.priceAtFVG)               entryReasons.push(_silverBullet.label);
  } catch(_ictre) { console.warn('[ICT entry reasons]', _ictre); }

  // ── 爆倉地圖：進場理由補充 + 信心加成 ──
  try {
    const _liqBTS = _liquidationCache[coin.symbol];
    if (_liqBTS && price > 0) {
      const _liqRange15 = price * 0.15;
      if (isLong) {
        // Short liq wall above entry within 15% → squeeze potential
        const _nearSqWall = (_liqBTS.shortLiqs || []).find(
          l => l.price > price && l.price <= price + _liqRange15
        );
        if (_nearSqWall) {
          entryReasons.push(`💥 空單爆倉牆 $${fmtPrice(_nearSqWall.price)} 在進場位上方，擠壓行情有利`);
          rawConf = Math.min(90, rawConf + 1); // +1 squeeze play bonus
        }
        // Long liq wall below SL → add slReason context (will be applied after sl calc)
      } else {
        // Long liq wall below entry within 15% → squeeze potential for shorts
        const _nearLqWall = (_liqBTS.longLiqs || []).find(
          l => l.price < price && l.price >= price - _liqRange15
        );
        if (_nearLqWall) {
          entryReasons.push(`💥 多單爆倉牆 $${fmtPrice(_nearLqWall.price)} 在進場位下方，擠壓行情有利`);
          rawConf = Math.min(90, rawConf + 1);
        }
      }
    }
  } catch(_liqBTSe) {}

  // ── 進場精修：足跡POC吸附 / ICT區位評估 / 進場位最終優化 ──
  try {
    // 足跡 POC 吸附（在 ±1% 範圍內貼合高量節點，獲得更精確進場）
    if (_fpBTS?.poc && price > 0) {
      const _pocDelta = (_fpBTS.poc - price) / price;
      if (isLong  && _pocDelta > -0.010 && _pocDelta < 0) entry = Math.min(entry, _fpBTS.poc * 1.0025);
      if (!isLong && _pocDelta < 0.010  && _pocDelta > 0) entry = Math.max(entry, _fpBTS.poc * 0.9975);
    }
    // VWAP 吸附與微結構質量判斷
    if (_fpBTS?.vwap && price > 0) {
      const _vwapDevBTS = (price - _fpBTS.vwap) / _fpBTS.vwap;
      if (isLong  && _vwapDevBTS > -0.008 && _vwapDevBTS < 0.003)
        entryReasons.push(`⚡ 價格貼近 VWAP $${fmtPrice(_fpBTS.vwap)}（偏離 ${(_vwapDevBTS*100).toFixed(2)}%），Tick 最佳進場區`);
      else if (isLong && _vwapDevBTS > 0.015)
        entryReasons.push(`⚠️ 價格高於 VWAP ${(_vwapDevBTS*100).toFixed(2)}%，建議等回測 VWAP $${fmtPrice(_fpBTS.vwap)} 再進`);
      else if (!isLong && _vwapDevBTS < 0.008 && _vwapDevBTS > -0.003)
        entryReasons.push(`⚡ 價格貼近 VWAP $${fmtPrice(_fpBTS.vwap)}（偏離 ${(_vwapDevBTS*100).toFixed(2)}%），Tick 最佳進場區`);
      else if (!isLong && _vwapDevBTS < -0.015)
        entryReasons.push(`⚠️ 價格低於 VWAP ${Math.abs(_vwapDevBTS*100).toFixed(2)}%，建議等反彈 VWAP $${fmtPrice(_fpBTS.vwap)} 再進`);
    }
    // 市場微結構質量警告（Bid-Ask Bounce 嚴重時降低訊號可信度）
    if (_fpBTS?.bidAskBounceScore != null && _fpBTS.bidAskBounceScore > 65) {
      entryReasons.push(`⚠️ 市場微結構質量低（噪音 ${_fpBTS.bidAskBounceScore}%），Tick 數據存在 Bid-Ask Bounce，建議等微結構穩定`);
      rawConf = Math.max(rawConf - 3, 30);
    } else if (_fpBTS?.microstructureQuality != null && _fpBTS.microstructureQuality >= 70) {
      rawConf = Math.min(rawConf + 2, 90);
    }
    // ICT 區位逆勢警告（溢價做多 / 折扣做空）
    if (_ictPD) {
      if (isLong  && _ictPD.pctInRange > 68 && !_ictPD.idealForLong)
        entryReasons.push(`⚠️ 溢價偏高區（${_ictPD.pctInRange.toFixed(0)}%），SMC建議等均衡點 $${fmtPrice(_ictPD.equilibrium)} 回撤再進`);
      if (!isLong && _ictPD.pctInRange < 32 && !_ictPD.idealForShort)
        entryReasons.push(`⚠️ 折扣偏低區（${_ictPD.pctInRange.toFixed(0)}%），SMC建議等均衡點 $${fmtPrice(_ictPD.equilibrium)} 反彈再進`);
    }
    // Kill Zone 最優時段強調（若尚未加入）
    if (_kz?.quality === 'high' && !entryReasons.some(r => r.includes(_kz.name)))
      entryReasons.unshift(`⏰ ${_kz.emoji} ${_kz.name} 黃金獵殺時段（${_kz.desc}）`);
  } catch(_epE) {}

  // ── 止損：HTF 結構位 + 緩衝（4H/日線優先，1H fallback）──
  let sl, slReason;
  if (isLong) {
    // 陷阱止損：1H 或 4H PO3/2B/掃蕩低點（4H 優先，更強確認）
    const trapLow4h = traps4h__?.po3Bull?.sweepLevel || traps4h__?.sweepBull?.level;
    const trapLow1h = traps1h__?.po3Bull?.sweepLevel || traps1h__?.sweepBull?.level;
    const trapLow   = (trapLow4h && trapLow4h < entry && trapLow4h > entry - atr * 3) ? trapLow4h
                    : (trapLow1h && trapLow1h < entry && trapLow1h > entry - atr * 2) ? trapLow1h : null;
    // 結構止損：4H 支撐 > 日線支撐 > 1H 支撐
    const sl4hSup  = _htfSupps.find(s => s < entry * 0.999 && s > entry - atr * 3);
    const structSup = sl4hSup || supps[0] || (price - atr * 2);
    if (trapLow) {
      sl = trapLow - atr * 0.2;
      const slDistPct = ((entry - sl) / price * 100).toFixed(2);
      const tfLabel = trapLow === trapLow4h ? '4H ' : '';
      slReason = `${tfLabel}PO3/掃蕩低點 ${fmtPrice(trapLow)} 下方止損，-${slDistPct}%（結構化止損）`;
    } else {
      sl = Math.min(structSup - atr * 0.3, entry - atr * 1.3);
      const slDistPct = ((entry - sl) / price * 100).toFixed(2);
      slReason = sl4hSup
        ? `${_htfTfLabel(sl4hSup)}支撐結構 ${fmtPrice(sl4hSup)} 下方緩衝，-${slDistPct}%，跌破 ${_htfTfLabel(sl4hSup)} 結構反轉`
        : supps[0]
          ? `1H 支撐結構 ${fmtPrice(supps[0])} 下方緩衝，-${slDistPct}%，跌破結構反轉`
          : `現價下方 ${slDistPct}%（ATR 止損），動能失效離場`;
    }
  } else {
    const trapHigh4h = traps4h__?.po3Bear?.sweepLevel || traps4h__?.sweepBear?.level;
    const trapHigh1h = traps1h__?.po3Bear?.sweepLevel || traps1h__?.sweepBear?.level;
    const trapHigh   = (trapHigh4h && trapHigh4h > entry && trapHigh4h < entry + atr * 3) ? trapHigh4h
                     : (trapHigh1h && trapHigh1h > entry && trapHigh1h < entry + atr * 2) ? trapHigh1h : null;
    const sl4hRes  = _htfResists.find(r => r > entry * 1.001 && r < entry + atr * 3);
    const structRes = sl4hRes || resists[0] || (price + atr * 2);
    if (trapHigh) {
      sl = trapHigh + atr * 0.2;
      const slDistPct = ((sl - entry) / price * 100).toFixed(2);
      const tfLabel = trapHigh === trapHigh4h ? '4H ' : '';
      slReason = `${tfLabel}PO3/掃蕩高點 ${fmtPrice(trapHigh)} 上方止損，+${slDistPct}%（結構化止損）`;
    } else {
      sl = Math.max(structRes + atr * 0.3, entry + atr * 1.3);
      const slDistPct = ((sl - entry) / price * 100).toFixed(2);
      slReason = sl4hRes
        ? `${_htfTfLabel(sl4hRes)}壓力結構 ${fmtPrice(sl4hRes)} 上方緩衝，+${slDistPct}%，突破 ${_htfTfLabel(sl4hRes)} 結構反轉`
        : resists[0]
          ? `1H 壓力結構 ${fmtPrice(resists[0])} 上方緩衝，+${slDistPct}%，突破結構反轉`
          : `現價上方 ${slDistPct}%（ATR 止損），動能失效離場`;
    }
  }
  // ── 止損精修：噪音底線 / 最大風險上限 / VP VAL|VAH 錨點 ──
  try {
    const _slMinDist = atr * 0.5;
    const _slMaxPct  = price > 10000 ? 0.025 : price > 500 ? 0.035 : 0.045;
    const _slMaxDist = price * _slMaxPct;
    if (isLong) {
      if ((entry - sl) < _slMinDist) { sl = entry - _slMinDist; slReason += `（已擴展至ATR噪音底線）`; }
      if ((entry - sl) > _slMaxDist) { sl = entry - _slMaxDist; slReason = `風控上限止損 ${(_slMaxPct*100).toFixed(1)}% — ${fmtPrice(sl)}`; }
      if (vp1h?.val && vp1h.val < entry && vp1h.val > sl && (entry - vp1h.val) < atr * 2.5)
        { sl = vp1h.val - atr * 0.15; slReason = `VP 價值區低點(VAL) ${fmtPrice(vp1h.val)} 下方止損，-${((entry-sl)/price*100).toFixed(2)}%`; }
    } else {
      if ((sl - entry) < _slMinDist) { sl = entry + _slMinDist; slReason += `（已擴展至ATR噪音底線）`; }
      if ((sl - entry) > _slMaxDist) { sl = entry + _slMaxDist; slReason = `風控上限止損 ${(_slMaxPct*100).toFixed(1)}% — ${fmtPrice(sl)}`; }
      if (vp1h?.vah && vp1h.vah > entry && vp1h.vah < sl && (vp1h.vah - entry) < atr * 2.5)
        { sl = vp1h.vah + atr * 0.15; slReason = `VP 價值區高點(VAH) ${fmtPrice(vp1h.vah)} 上方止損，+${((sl-entry)/price*100).toFixed(2)}%`; }
    }
  } catch(_slE) {}

  // ── 長線單止損升級：週線結構 / EMA200 最終防線（比短線更寬）──
  if (canScaleIn) try {
    const _ltEma200 = parseFloat(coin.ema200) || 0;
    const _ltSlMin  = 0.030; // 長線最小止損距離 3%
    const _ltSlMax  = 0.080; // 長線最大止損距離 8%
    if (isLong) {
      const _wkSwLow = _plw1?.swingLow;
      const _wkSup   = _w1Supps.find(s => s < entry && (entry-s)/price >= _ltSlMin && (entry-s)/price <= _ltSlMax);
      const _ema200C = _ltEma200 > 0 && _ltEma200 < entry * 0.998 && (entry-_ltEma200)/price >= _ltSlMin && (entry-_ltEma200)/price <= _ltSlMax ? _ltEma200 : null;
      const _wkSwC   = _wkSwLow && _wkSwLow < entry && (entry-_wkSwLow)/price >= _ltSlMin && (entry-_wkSwLow)/price <= _ltSlMax ? _wkSwLow : null;
      const _ltSlCands = [_wkSwC, _wkSup, _ema200C].filter(Boolean).sort((a,b) => b - a);
      if (_ltSlCands[0]) {
        sl = _ltSlCands[0] - atr * 0.25;
        const _ltSlPct = ((entry-sl)/price*100).toFixed(2);
        const _ltSrc = (_wkSwC && _ltSlCands[0] === _wkSwC) ? '週線擺動低點'
                     : (_wkSup && _ltSlCands[0] === _wkSup) ? '週線支撐' : 'EMA200';
        slReason = `🔒 長線止損 ${_ltSrc} ${fmtPrice(_ltSlCands[0])} 下方 -${_ltSlPct}%（跌破週級結構清倉）`;
      } else {
        sl = Math.min(sl, entry * (1 - 0.040));
        slReason = `🔒 長線止損：進場下方 ${((entry-sl)/price*100).toFixed(2)}%（週線結構不足，ATR擴展）`;
      }
    } else {
      const _wkSwHigh = _plw1?.swingHigh;
      const _wkRes    = _w1Resists.find(r => r > entry && (r-entry)/price >= _ltSlMin && (r-entry)/price <= _ltSlMax);
      const _ema200C  = _ltEma200 > 0 && _ltEma200 > entry * 1.002 && (_ltEma200-entry)/price >= _ltSlMin && (_ltEma200-entry)/price <= _ltSlMax ? _ltEma200 : null;
      const _wkSwC    = _wkSwHigh && _wkSwHigh > entry && (_wkSwHigh-entry)/price >= _ltSlMin && (_wkSwHigh-entry)/price <= _ltSlMax ? _wkSwHigh : null;
      const _ltSlCands = [_wkSwC, _wkRes, _ema200C].filter(Boolean).sort((a,b) => a - b);
      if (_ltSlCands[0]) {
        sl = _ltSlCands[0] + atr * 0.25;
        const _ltSlPct = ((sl-entry)/price*100).toFixed(2);
        const _ltSrc = (_wkSwC && _ltSlCands[0] === _wkSwC) ? '週線擺動高點'
                     : (_wkRes && _ltSlCands[0] === _wkRes) ? '週線壓力' : 'EMA200';
        slReason = `🔒 長線止損 ${_ltSrc} ${fmtPrice(_ltSlCands[0])} 上方 +${_ltSlPct}%（突破週級結構清倉）`;
      } else {
        sl = Math.max(sl, entry * (1 + 0.040));
        slReason = `🔒 長線止損：進場上方 ${((sl-entry)/price*100).toFixed(2)}%（週線結構不足，ATR擴展）`;
      }
    }
  } catch(_ltSlE) {}

  const risk = Math.abs(entry - sl) || atr;

  // ── 止盈一：ADX 加速縮放 + VP VAH/VAL + 爆倉牆候選 ──
  let tp1, tp1Reason;
  const _adxForTP = parseFloat(coin.adx) || 20;
  const _adxBoost = _adxForTP >= 35 ? 1.0 : _adxForTP >= 28 ? 0.5 : 0;
  const minTP1 = isLong ? entry + risk * (1.5 + _adxBoost) : entry - risk * (1.5 + _adxBoost);
  if (isLong) {
    const _liqDataTP1 = _liquidationCache[coin.symbol];
    const _liqWall1   = _liqDataTP1 ? (_liqDataTP1.shortLiqs || []).filter(l => l.price >= minTP1).sort((a,b)=>a.price-b.price)[0] : null;
    const vpVAH1      = (vp1h?.vah && vp1h.vah >= minTP1) ? vp1h.vah : null;
    const htfR1 = _htfResists.find(r => r >= minTP1 * 0.99);
    const r1    = htfR1 || resists.find(r => r >= minTP1 * 0.99);
    const _tp1Cands = [r1, vpVAH1, _liqWall1?.price].filter(Boolean).sort((a,b)=>a-b);
    tp1 = _tp1Cands[0] || minTP1;
    const rr1v = ((tp1 - entry) / risk).toFixed(1);
    const _tp1Src = (vpVAH1 && tp1 === vpVAH1) ? `VP VAH ${fmtPrice(vpVAH1)}`
                  : (_liqWall1?.price && tp1 === _liqWall1.price) ? `空單爆倉牆 ${fmtPrice(_liqWall1.price)}`
                  : r1 ? `${_htfTfLabel(r1)}壓力 ${fmtPrice(r1)}` : null;
    tp1Reason = _tp1Src
      ? `${_tp1Src}，R/R ${rr1v}:1，到達後減倉 60%`
      : `短線目標 R/R ${rr1v}:1，到達後減倉 60%`;
  } else {
    const _liqDataTP1 = _liquidationCache[coin.symbol];
    const _liqWall1   = _liqDataTP1 ? (_liqDataTP1.longLiqs || []).filter(l => l.price <= minTP1).sort((a,b)=>b.price-a.price)[0] : null;
    const vpVAL1      = (vp1h?.val && vp1h.val <= minTP1) ? vp1h.val : null;
    const htfS1 = _htfSupps.find(s => s <= minTP1 * 1.01);
    const s1    = htfS1 || supps.find(s => s <= minTP1 * 1.01);
    const _tp1Cands = [s1, vpVAL1, _liqWall1?.price].filter(Boolean).sort((a,b)=>b-a);
    tp1 = _tp1Cands[0] || minTP1;
    const rr1v = ((entry - tp1) / risk).toFixed(1);
    const _tp1Src = (vpVAL1 && tp1 === vpVAL1) ? `VP VAL ${fmtPrice(vpVAL1)}`
                  : (_liqWall1?.price && tp1 === _liqWall1.price) ? `多單爆倉牆 ${fmtPrice(_liqWall1.price)}`
                  : s1 ? `${_htfTfLabel(s1)}支撐 ${fmtPrice(s1)}` : null;
    tp1Reason = _tp1Src
      ? `${_tp1Src}，R/R ${rr1v}:1，到達後減倉 60%`
      : `短線目標 R/R ${rr1v}:1，到達後減倉 60%`;
  }

  // ── 止盈二：ADX 加速縮放 + VP VAH/VAL + 爆倉牆候選 ──
  let tp2, tp2Reason;
  const minTP2 = isLong ? entry + risk * (2.5 + _adxBoost * 1.5) : entry - risk * (2.5 + _adxBoost * 1.5);
  if (isLong) {
    const _liqDataTP2 = _liquidationCache[coin.symbol];
    const _liqWall2   = _liqDataTP2 ? (_liqDataTP2.shortLiqs || []).filter(l => l.price >= minTP2 && l.price > tp1 + price*0.003).sort((a,b)=>a.price-b.price)[0] : null;
    const vpVAH2      = (vp1h?.vah && vp1h.vah >= minTP2 && vp1h.vah > tp1 + price*0.003) ? vp1h.vah : null;
    const w1R2  = _w1Resists.find(r => r > tp1 + price * 0.004 && r >= minTP2 * 0.99);
    const htfR2 = w1R2 || _htfResists.find(r => r > tp1 + price * 0.004 && r >= minTP2 * 0.99);
    const r2    = htfR2 || resists.find(r => r > tp1 + price * 0.004 && r >= minTP2 * 0.99);
    const _tp2Cands = [r2, vpVAH2, _liqWall2?.price].filter(Boolean).sort((a,b)=>a-b);
    tp2 = _tp2Cands[0] || Math.max(swHigh, minTP2);
    if (tp2 <= tp1) tp2 = Math.max(tp1 + price * 0.004, minTP2);
    const rr2v = ((tp2 - entry) / risk).toFixed(1);
    const _tp2Src = (vpVAH2 && tp2 === vpVAH2) ? `VP VAH ${fmtPrice(vpVAH2)}`
                  : (_liqWall2?.price && tp2 === _liqWall2.price) ? `空單爆倉牆 ${fmtPrice(_liqWall2.price)}`
                  : r2 ? `${_htfTfLabel(r2)}壓力 ${fmtPrice(r2)}` : null;
    tp2Reason = _tp2Src
      ? `${_tp2Src}，R/R ${rr2v}:1，剩餘倉位移至成本`
      : `擺動高點 ${fmtPrice(swHigh)}，R/R ${rr2v}:1，剩餘倉位移至成本`;
  } else {
    const _liqDataTP2 = _liquidationCache[coin.symbol];
    const _liqWall2   = _liqDataTP2 ? (_liqDataTP2.longLiqs || []).filter(l => l.price <= minTP2 && l.price < tp1 - price*0.003).sort((a,b)=>b.price-a.price)[0] : null;
    const vpVAL2      = (vp1h?.val && vp1h.val <= minTP2 && vp1h.val < tp1 - price*0.003) ? vp1h.val : null;
    const w1S2  = _w1Supps.find(s => s < tp1 - price * 0.004 && s <= minTP2 * 1.01);
    const htfS2 = w1S2 || _htfSupps.find(s => s < tp1 - price * 0.004 && s <= minTP2 * 1.01);
    const s2    = htfS2 || supps.find(s => s < tp1 - price * 0.004 && s <= minTP2 * 1.01);
    const _tp2Cands = [s2, vpVAL2, _liqWall2?.price].filter(Boolean).sort((a,b)=>b-a);
    tp2 = _tp2Cands[0] || Math.min(swLow, minTP2);
    if (tp2 >= tp1) tp2 = Math.min(tp1 - price * 0.004, minTP2);
    const rr2v = ((entry - tp2) / risk).toFixed(1);
    const _tp2Src = (vpVAL2 && tp2 === vpVAL2) ? `VP VAL ${fmtPrice(vpVAL2)}`
                  : (_liqWall2?.price && tp2 === _liqWall2.price) ? `多單爆倉牆 ${fmtPrice(_liqWall2.price)}`
                  : s2 ? `${_htfTfLabel(s2)}支撐 ${fmtPrice(s2)}` : null;
    tp2Reason = _tp2Src
      ? `${_tp2Src}，R/R ${rr2v}:1，剩餘倉位移至成本`
      : `擺動低點 ${fmtPrice(swLow)}，R/R ${rr2v}:1，剩餘倉位移至成本`;
  }

  // 儲存短線 tp1/tp2（若長線降格時還原用，必須在 canScaleIn 覆蓋前存）
  let _stTp1 = tp1, _stTp2 = tp2, _stTp1R = tp1Reason, _stTp2R = tp2Reason;

  // ── 長線單：覆蓋 tp1/tp2 為長線最終止盈，並計算三個加倉位 ──────
  // 觸發條件：ltBias === direction && ltConf >= 85（canScaleIn = true）
  let ltTP = null, ltTPReason = '', scaleInLevels = [], _aiScaleCount = 1, _aiScaleReason = '';
  if (canScaleIn) {
    const minLtRR  = 7.0; // 最低 R/R 要求：低於此值不做長線單（長線必須 >= 7:1）
    const minLtTP  = isLong ? entry + risk * minLtRR : entry - risk * minLtRR;
    const maxDist  = price * 0.35; // 長線上限擴展至 35%
    if (isLong) {
      const cap = entry + maxDist;
      // 優先使用週線 swingHigh，其次週線壓力，再次日線/4H 壓力
      const _wkSwHigh = _plw1.swingHigh;
      const wkSwCand  = _wkSwHigh && _wkSwHigh >= minLtTP && _wkSwHigh <= cap ? _wkSwHigh : null;
      const wkCands   = _w1Resists.filter(r => r >= minLtTP && r <= cap);
      const htfCands  = _htfResists.filter(r => r >= minLtTP && r <= cap);
      const allCands  = [...new Set([
        ...(wkSwCand ? [wkSwCand] : []),
        ...wkCands, ...htfCands,
        ...resists.filter(r => r >= minLtTP && r <= cap)
      ])].sort((a, b) => a - b);
      ltTP = allCands.length ? allCands[allCands.length - 1] : null;
      if (!ltTP) { canScaleIn = false; } // 找不到有效目標 → 降回短線
      else {
        const ltRRv = ((ltTP - entry) / risk).toFixed(1);
        if (parseFloat(ltRRv) < minLtRR) { canScaleIn = false; ltTP = null; } // R/R 不足 → 觀望
        else {
          const _isWkSw = wkSwCand && Math.abs(ltTP - wkSwCand) < price * 0.005;
          const _lt3R = fmtPrice(entry + risk * 3);
          const _lt5R = fmtPrice(entry + risk * 5);
          ltTPReason = `${_isWkSw ? '週線擺動高點' : _htfTfLabel(ltTP)} $${fmtPrice(ltTP)}，R/R ${ltRRv}:1 | 里程碑 3R $${_lt3R} 減30%，5R $${_lt5R} 減30%，最終目標全出`;
        }
      }
    } else {
      const cap = entry - maxDist;
      const _wkSwLow  = _plw1.swingLow;
      const wkSwCand  = _wkSwLow && _wkSwLow <= minLtTP && _wkSwLow >= cap ? _wkSwLow : null;
      const wkCands   = _w1Supps.filter(s => s <= minLtTP && s >= cap);
      const htfCands  = _htfSupps.filter(s => s <= minLtTP && s >= cap);
      const allCands  = [...new Set([
        ...(wkSwCand ? [wkSwCand] : []),
        ...wkCands, ...htfCands,
        ...supps.filter(s => s <= minLtTP && s >= cap)
      ])].sort((a, b) => b - a);
      ltTP = allCands.length ? allCands[allCands.length - 1] : null;
      if (!ltTP) { canScaleIn = false; }
      else {
        const ltRRv = ((entry - ltTP) / risk).toFixed(1);
        if (parseFloat(ltRRv) < minLtRR) { canScaleIn = false; ltTP = null; }
        else {
          const _isWkSw = wkSwCand && Math.abs(ltTP - wkSwCand) < price * 0.005;
          const _lt3R = fmtPrice(entry - risk * 3);
          const _lt5R = fmtPrice(entry - risk * 5);
          ltTPReason = `${_isWkSw ? '週線擺動低點' : _htfTfLabel(ltTP)} $${fmtPrice(ltTP)}，R/R ${ltRRv}:1 | 里程碑 3R $${_lt3R} 減30%，5R $${_lt5R} 減30%，最終目標全出`;
        }
      }
    }
    // 加倉次數：ADX 趨勢強度 + 長線風控分 + R/R 三維評分
    const ltRRraw = (canScaleIn && ltTP && risk > 0) ? Math.abs(ltTP - entry) / risk : 0;
    const _adxLT  = parseFloat(coin.adx) || 20;
    _aiScaleCount = (_adxLT >= 35 && ltConf >= 88 && ltRRraw >= 8.0) ? 3
                  : (_adxLT >= 28 && ltConf >= 85 && ltRRraw >= 5.0) ? 2
                  : 1;
    _aiScaleReason = _aiScaleCount === 3
      ? `ADX ${_adxLT.toFixed(0)} 強勢趨勢、長線風控分 ${ltConf} 分、R/R ${ltRRraw.toFixed(1)}:1，建議 3 次加倉`
      : _aiScaleCount === 2
      ? `ADX ${_adxLT.toFixed(0)}、長線風控分 ${ltConf} 分、R/R ${ltRRraw.toFixed(1)}:1，建議 2 次加倉`
      : `長線風控分 ${ltConf} 分、ADX ${_adxLT.toFixed(0)}，建議 1 次加倉（趨勢確認後再佈局）`;
    // 足跡圖高量區（加倉優先吸附 POC + 強買/賣壓區）
    const totalMove = Math.abs(ltTP - entry);
    const _fpSI = _footprintCache[coin.symbol];
    const _fpSnaps = [];
    if (_fpSI) {
      try {
        if (_fpSI.poc) _fpSnaps.push(_fpSI.poc);
        const _fpBest = isLong ? _fpSI.highBuyLevels : _fpSI.highSellLevels;
        if (_fpBest) _fpBest.slice(0, 3).forEach(lv => _fpSnaps.push(lv.price));
      } catch(_e) {}
    }
    // 足跡 Delta 背離 → 謹慎，加倉次數上限縮減為 1
    if (_fpSI?.deltaDiv) {
      _aiScaleCount = 1;
      _aiScaleReason += '　⚠️ 足跡 Delta 背離，保守降至 1 次加倉';
    }
    // 智慧加倉位候選：EMA + VP + HTF 週線結構（在 entry 到 ltTP 10%-70% 段）
    const _ema200LT = parseFloat(coin.ema200) || 0;
    const _ema50LT  = parseFloat(coin.ema50)  || 0;
    const _siStructCands = [];
    if (isLong) {
      const _siLo = entry + totalMove * 0.08, _siHi = entry + totalMove * 0.70;
      if (_ema50LT  > _siLo && _ema50LT  < _siHi) _siStructCands.push(_ema50LT);
      if (_ema200LT > _siLo && _ema200LT < _siHi) _siStructCands.push(_ema200LT);
      if (vp1h?.poc && vp1h.poc > _siLo && vp1h.poc < _siHi) _siStructCands.push(vp1h.poc);
      _htfSupps.filter(s => s > _siLo && s < _siHi).forEach(s => _siStructCands.push(s));
      _w1Supps.filter(s  => s > _siLo && s < _siHi).forEach(s => _siStructCands.push(s));
    } else {
      const _siLo = entry - totalMove * 0.70, _siHi = entry - totalMove * 0.08;
      if (_ema50LT  > _siLo && _ema50LT  < _siHi) _siStructCands.push(_ema50LT);
      if (_ema200LT > _siLo && _ema200LT < _siHi) _siStructCands.push(_ema200LT);
      if (vp1h?.poc && vp1h.poc > _siLo && vp1h.poc < _siHi) _siStructCands.push(vp1h.poc);
      _htfResists.filter(r => r > _siLo && r < _siHi).forEach(r => _siStructCands.push(r));
      _w1Resists.filter(r  => r > _siLo && r < _siHi).forEach(r => _siStructCands.push(r));
    }
    const _siUniq = [...new Set(_siStructCands)].sort((a,b) => isLong ? a - b : b - a);
    // 預計算等分底座（fallback 用）
    const _rawLevels = Array.from({ length: _aiScaleCount }, (_, i) => {
      const n = i + 1;
      return isLong ? entry + totalMove * (n / (_aiScaleCount + 1))
                    : entry - totalMove * (n / (_aiScaleCount + 1));
    });
    scaleInLevels = _rawLevels.map((raw, i) => {
      // 優先：結構候選 → 足跡高量區 → 1H S/R → 等分
      const structLevel = _siUniq[i];
      const fpNear = _fpSnaps.find(lv => Math.abs(lv - raw) / raw < 0.015);
      const nearby = fpNear || (isLong
        ? resists.find(r => r >= raw * 0.985 && r <= raw * 1.015)
        : supps.find(s  => s <= raw * 1.015  && s >= raw * 0.985));
      const level = structLevel || nearby || raw;
      // 止損移動：加倉 #1 → SL 鎖進場位，加倉 #n → SL 鎖前次加倉位
      const prevEntry = i === 0 ? entry : _rawLevels[i - 1];
      const newSL = isLong ? prevEntry + risk * 0.15 : prevEntry - risk * 0.15;
      return { level, snapped: !!(structLevel || nearby), fpSnapped: !!fpNear, newSL };
    });
    // 覆蓋 tp1/tp2 → updateOpenTrades TP1 觸發 & 持倉記錄均使用長線最終止盈
    // 只有在 canScaleIn 仍為 true（ltTP 有效）時才覆蓋，否則保留短線 tp1/tp2
    if (canScaleIn && ltTP) {
      tp1 = ltTP; tp1Reason = ltTPReason;
      tp2 = ltTP; tp2Reason = ltTPReason;
    }
  }

  // 長線單部分止盈位（3R），用作飛越取消門檻
  const ltPartialTP = canScaleIn ? (isLong ? entry + risk * 3 : entry - risk * 3) : null;

  // Re-sync label: canScaleIn may have been set false if no valid ltTP was found
  if (!canScaleIn || !ltTP) {
    ltTag = '';
    if (!isRangeMode && isDayAligned) dirLabel = isLong ? '短線做多' : '短線做空';
    else if (!isRangeMode)            dirLabel = isLong ? '做多' : '做空';
  }

  const rr1str = ((Math.abs(tp1 - entry) / risk)).toFixed(1);
  const rr2str = ((Math.abs(tp2 - entry) / risk)).toFixed(1);
  const activeFactors = isLong ? totalBull : totalBear;
  // 頂級交易員標準：底線 40，每個確認條件 +6%，上限 92%
  // 4h 方向確認額外加成（最重要的輔助確認）
  const h4Conf   = h4?.signal?.includes(isLong ? 'bull' : 'bear') ? 2 : 0;
  // R/R 加成：R/R >= 3:1 時高信心
  const rrBonus  = parseFloat(rr1str) >= 3 ? 1 : 0;
  // 進場/止盈/止損位置質量加成（落在真實結構位 vs ATR 估算）
  const tp1Quality = isLong
    ? (tp1Reason.includes('壓力') || tp1Reason.includes('前高') ? 1 : 0)
    : (tp1Reason.includes('支撐') || tp1Reason.includes('前低') ? 1 : 0);
  const slQuality = (slReason.includes('支撐結構') || slReason.includes('壓力結構') ||
                     slReason.includes('4H') || slReason.includes('日線') || slReason.includes('週線') ||
                     slReason.includes('PO3') || slReason.includes('掃蕩')) ? 1 : 0;
  const levelQualityBonus = tp1Quality + slQuality;
  // BB走軌/123/2B 型態額外加成（確認趨勢方向）
  const bbWalkBonus = (isLong ? (bb1h_?.walkingBull ? 1 : 0) : (bb1h_?.walkingBear ? 1 : 0));
  const patBonus    = (isLong ? ((coin.patterns?.bull123 || coin.patterns?.bull2B) ? 1 : 0)
                               : ((coin.patterns?.bear123 || coin.patterns?.bear2B) ? 1 : 0));
  let rawConf  = Math.min(92, Math.max(40, 40 + (activeFactors + h4Conf + rrBonus + levelQualityBonus + bbWalkBonus + patBonus) * 6));

  // ICT/SMC 信心加成
  let _ictBonus = 0;
  if (_kz?.quality === 'high')                        _ictBonus += 2;
  if (_ictOB?.priceInOB)                              _ictBonus += 3;
  if (_ictOB4h?.priceInOB)                            _ictBonus += 2;
  if (isLong  && _ictPD?.idealForLong)                _ictBonus += 2;
  if (!isLong && _ictPD?.idealForShort)               _ictBonus += 2;
  if (_ictFVG && !_ictFVG.filled)                     _ictBonus += 1;
  if (_ictFVG4h && !_ictFVG4h.filled)                 _ictBonus += 1;
  // ICT 五大模型信心加成
  if (isLong  && _turtleSoup?.bull)           _ictBonus += 3;
  if (!isLong && _turtleSoup?.bear)           _ictBonus += 3;
  if (_coreModel?.detected) {
    const _cmB = { sweep: 1, mss: 2, fvg_formed: 3, fvg_entry: 5 };
    _ictBonus += (_cmB[_coreModel.stage] || 1);
  }
  if (_unicornModel?.detected && _unicornModel.priceInGoldenZone) _ictBonus += 4;
  if (_silverBullet?.detected && _silverBullet.priceAtFVG)        _ictBonus += 3;
  if (_ictBonus > 0) rawConf = Math.min(92, rawConf + _ictBonus);

  // 足跡圖信心加成（Delta 同向確認 +2%，買方吸收 +1%）
  if (_fpBTS) {
    const _fpDirMatch = isLong ? (_fpBTS.deltaDir === 'bull') : (_fpBTS.deltaDir === 'bear');
    if (_fpDirMatch && !_fpBTS.deltaDiv) rawConf = Math.min(92, rawConf + 2);
    if (_fpBTS.absorption && isLong)     rawConf = Math.min(92, rawConf + 1);
  }

  // MTF 對齐強度獎勵：5 框對齐 +10%，4 框對齐 +5%（多時框共識強風控分顯著提升）
  if (_5tfAligned) rawConf = Math.min(95, rawConf + 10);
  else if (_4tfAligned) rawConf = Math.min(95, rawConf + 5);

  // 宏觀環境同步確認：六大因子各自獨立扣分（反向扣較多，中性扣少一點）
  let macroOpposePenalty = 0, macroReasons = [];
  try {
    // ① 宏觀市場（F&G + 市值 + BTC 主導）
    if (globalMkt || fearGreed) {
      const fgNow  = fearGreed ? parseInt(fearGreed.value || '50') : 50;
      const chgNow = globalMkt?.marketCapChange || 0;
      const domNow = globalMkt?.btcDominance   || 50;
      const f1Labels = [];
      let f1Oppose = false;
      if (isLong) {
        if (chgNow < -2) { f1Oppose = true; f1Labels.push(`市值 ${chgNow.toFixed(1)}% 下跌`); }
        if (domNow > 58) { f1Oppose = true; f1Labels.push(`BTC主導 ${domNow.toFixed(1)}%（偏高）`); }
        if (fgNow < 30)  { f1Oppose = true; f1Labels.push(`恐貪 ${fgNow}（極恐）`); }
        if (fgNow > 75)  { f1Oppose = true; f1Labels.push(`恐貪 ${fgNow}（極貪）`); }
      } else {
        if (chgNow > 2)  { f1Oppose = true; f1Labels.push(`市值 +${chgNow.toFixed(1)}%`); }
        if (domNow < 44) { f1Oppose = true; f1Labels.push(`BTC主導 ${domNow.toFixed(1)}%（偏低）`); }
        if (fgNow > 70)  { f1Oppose = true; f1Labels.push(`恐貪 ${fgNow}（貪婪）`); }
        if (fgNow < 25)  { f1Oppose = true; f1Labels.push(`恐貪 ${fgNow}（極恐）`); }
      }
      const f1Neutral = !f1Oppose && (fgNow >= 40 && fgNow <= 60) && Math.abs(chgNow) < 2;
      if (f1Oppose) {
        macroOpposePenalty += 8;
        macroReasons.push(`宏觀市場逆風（${f1Labels.join('、')}），扣 8%`);
      } else if (f1Neutral) {
        macroOpposePenalty += 3;
        macroReasons.push(`宏觀市場中性（F&G ${fgNow}，市值 ${chgNow >= 0 ? '+' : ''}${chgNow.toFixed(1)}%），方向不明，扣 3%`);
      }
    } else {
      macroOpposePenalty += 3;
      macroReasons.push(`宏觀資料暫無，方向不確定，扣 3%`);
    }

    // ② 加密大方向（computeMacroNetDir）— 獨立扣分
    if (_btsNetDir) {
      const f2Oppose = (isLong && _btsNetDir.includes('bear')) || (!isLong && _btsNetDir.includes('bull'));
      if (f2Oppose) {
        const f2Pen = (_btsNetDir === 'slight_bear' || _btsNetDir === 'slight_bull') ? 5 : 9;
        macroOpposePenalty += f2Pen;
        macroReasons.push(`加密大方向${_btsNetDir.includes('slight') ? '輕微' : ''}${isLong ? '偏空' : '偏多'}（${_btsNetDir}），扣 ${f2Pen}%`);
      } else if (_btsNetDir === 'neutral') {
        macroOpposePenalty += 4;
        macroReasons.push(`加密大方向中性（多空分歧），方向不明，扣 4%`);
      }
    }

    // ⑤ AI 財經新聞偏向（獨立扣分）
    try {
      const _insights = aiGenerateMarketInsights();
      const _bearCnt  = _insights.filter(i => i.sentiment === 'bearish' || i.sentiment === 'bear').length;
      const _bullCnt  = _insights.filter(i => i.sentiment === 'bullish' || i.sentiment === 'bull').length;
      if (isLong && _bearCnt > _bullCnt) {
        macroOpposePenalty += 3;
        macroReasons.push(`AI財經新聞偏空（${_bearCnt}/${_insights.length} 條），多頭逆風，扣 3%`);
      } else if (!isLong && _bullCnt > _bearCnt) {
        macroOpposePenalty += 3;
        macroReasons.push(`AI財經新聞偏多（${_bullCnt}/${_insights.length} 條），空頭逆風，扣 3%`);
      } else if (_bearCnt > 0 || _bullCnt > 0) {
        macroOpposePenalty += 1;
        macroReasons.push(`AI財經新聞多空均衡，方向不確定，扣 1%`);
      }
    } catch(e) {}

    // ④ 今日重要數據事件（高影響 + 即將公布）
    try {
      const _nearEvs = getTodayEconEvents().filter(ev => {
        const mins = (ev.eventTime.getTime() - Date.now()) / 60000;
        return ev.impact === 'high' && mins >= -15 && mins <= 75;
      });
      if (_nearEvs.length > 0) {
        macroOpposePenalty += 5;
        macroReasons.push(`高影響數據即將/剛公布：${_nearEvs.map(e => e.name).join('、')}，不確定性高，扣 5%`);
      }
    } catch(e) {}

    // ⑥ 資金流動事件（獨立扣分，中性事件也微扣）
    try {
      const _cfB = getCapitalFlowBias();
      let _cfPen = 0;
      for (const ev of _cfB.events) {
        const timeStr = ev.isActive ? '進行中' : `${ev.daysUntil}天後`;
        const aiTag   = ev.isAI ? 'AI預測' : '';
        if (isLong && ev.bear > 0) {
          const pen = ev.bear >= 1.2 ? 5 : 3;
          _cfPen += pen;
          macroReasons.push(`${ev.name}（${timeStr}）：${aiTag}資金流出，多頭逆風，扣 ${pen}%`);
        } else if (!isLong && ev.bull > 0) {
          const pen = ev.bull >= 1.2 ? 5 : 3;
          _cfPen += pen;
          macroReasons.push(`${ev.name}（${timeStr}）：${aiTag}資金流入，空頭逆風，扣 ${pen}%`);
        } else if (ev.bull === 0 && ev.bear === 0) {
          _cfPen += 2;
          macroReasons.push(`${ev.name}（${timeStr}）：資金方向中性，扣 2%`);
        }
      }
      macroOpposePenalty += Math.min(_cfPen, 10);
    } catch(_e) {}

  } catch(e) {
    console.warn('[buildTradeSetup] macroOpposePenalty 計算失敗:', e);
  }

  // 頂級交易員逆勢布局：taker 買賣比與宏觀方向相悖時，降低宏觀扣分
  if (deriv && macroOpposePenalty >= 5) {
    const _tkBull = isLong  && (deriv.takerBuySell ?? 1) > 1.15;
    const _tkBear = !isLong && (deriv.takerBuySell ?? 1) < 0.85;
    if (_tkBull || _tkBear) {
      const _tkReduce = Math.min(5, macroOpposePenalty);
      macroOpposePenalty = Math.max(0, macroOpposePenalty - _tkReduce);
      macroReasons.push(`🏆 頂級交易員${_tkBull ? '多頭' : '空頭'}佈局（Taker ${(deriv.takerBuySell ?? 1).toFixed(2)}）逆勢進場，宏觀扣分緩減 -${_tkReduce}%`);
    }
  }

  // ── 本週 / 今日 AI 預測方向對照（_wBias / _tBias 已在函式前段提前定義）──
  // 本週預測信心值 < 70% 時忽略週預測，僅遵守日預測
  const _wkConfLow = (weeklyBiasData?.conf || 50) < 70;
  const weeklyAligned = (isLong && _wBias.includes('bull')) || (!isLong && _wBias.includes('bear'));
  const weeklyNeutral = _wBias === 'neutral' || _wBias === '';
  const weeklyOpposed = !_wkConfLow && !weeklyAligned && !weeklyNeutral;
  const todayAligned  = (isLong && _tBias.includes('bull')) || (!isLong && _tBias.includes('bear'));
  const todayNeutral  = _tBias === 'neutral' || _tBias === '';
  const todayOpposed  = !todayAligned && !todayNeutral;

  // AI 趨勢對照懲罰（宏觀大方向與交易方向一致時不扣分，宏觀優先於事件預測）
  // 邏輯：若宏觀已確認偏空/偏多且與進場方向同向，AI事件預測逆向視為雜訊，不重複懲罰
  const _btsMacroAligned = (!isLong && _btsNetDir.includes('bear')) || (isLong && _btsNetDir.includes('bull'));
  let aiTrendPenalty = 0;
  const aiTrendReasons = [];
  if (_btsMacroAligned) {
    // 宏觀大方向已與交易同向，不因 AI 事件預測而扣分
    if (_wkConfLow) {
      aiTrendReasons.push(`本週AI預測信心值 ${weeklyBiasData.conf || 50}% 未達 70%，略過週預測，僅遵守日預測`);
    } else if (weeklyOpposed) {
      aiTrendReasons.push(`本週AI事件預測 ${weeklyBiasData.biasLabel || _wBias}（逆向），但宏觀大方向已${_btsNetDir.includes('bear') ? '偏空' : '偏多'}，不扣分`);
    } else {
      aiTrendReasons.push(`本週AI預測 ${weeklyBiasData.biasLabel || _wBias}（信心 ${weeklyBiasData.conf || 50}%），與${isLong ? '多' : '空'}方向一致`);
    }
    if (todayOpposed) {
      aiTrendReasons.push(`今日AI事件預測 ${todayBiasData.biasLabel || _tBias}（逆向），宏觀大方向一致，不扣分`);
    } else {
      aiTrendReasons.push(`今日AI預測 ${todayBiasData.biasLabel || _tBias}（信心 ${todayBiasData.conf || 50}%），今日方向一致`);
    }
  } else {
    if (_wkConfLow) {
      aiTrendReasons.push(`本週AI預測信心值 ${weeklyBiasData.conf || 50}% 未達 70%，略過週預測，僅遵守日預測`);
    } else if (weeklyOpposed) {
      const pen = _wBias.includes('strong') ? 8 : 5;
      aiTrendPenalty += pen;
      aiTrendReasons.push(`本週AI預測 ${weeklyBiasData.biasLabel || _wBias}，與${isLong ? '做多' : '做空'}逆向，扣 ${pen}%`);
    } else if (weeklyNeutral) {
      aiTrendPenalty += 2;
      aiTrendReasons.push(`本週AI預測震盪中性（信心 ${weeklyBiasData.conf || 50}%），方向不明，扣 2%`);
    } else {
      aiTrendReasons.push(`本週AI預測 ${weeklyBiasData.biasLabel || _wBias}（信心 ${weeklyBiasData.conf || 50}%），與${isLong ? '多' : '空'}方向一致`);
    }
    if (todayOpposed) {
      aiTrendPenalty += 5;
      aiTrendReasons.push(`今日AI預測 ${todayBiasData.biasLabel || _tBias}，${isLong ? '多頭' : '空頭'}今日逆風，扣 7%`);
    } else if (todayNeutral) {
      aiTrendPenalty += 1;
      aiTrendReasons.push(`今日AI預測中性觀望（信心 ${todayBiasData.conf || 50}%），方向不確定，扣 1%`);
    } else {
      aiTrendReasons.push(`今日AI預測 ${todayBiasData.biasLabel || _tBias}（信心 ${todayBiasData.conf || 50}%），今日方向一致`);
    }
  }

  // 數據公布風險：掃描近 8 小時內的高影響事件，標記可能令方向逆轉的節點
  const nowForFlip = Date.now();
  const flipRisks = (todayBiasData.highEvs || [])
    .map(ev => ({ ev, mins: (ev.eventTime.getTime() - nowForFlip) / 60000 }))
    .filter(({ mins }) => mins > -60 && mins < 480)
    .map(({ ev, mins }) => {
      const timeLabel = mins < 0 ? '剛公布' : mins < 60 ? `${Math.round(mins)}分鐘後` : `${(mins / 60).toFixed(1)}小時後`;
      // 判斷對當前方向的影響
      const riskDesc = isLong
        ? (ev.bearIf ? `若 ${ev.bearIf.slice(0, 50)}，多頭可能轉空` : `高影響數據，方向待確認`)
        : (ev.bullIf ? `若 ${ev.bullIf.slice(0, 50)}，空頭可能轉多` : `高影響數據，方向待確認`);
      const flipDir = isLong ? '轉空' : '轉多';
      return { name: ev.name, timeLabel, riskDesc, flipDir, aiPred: ev.aiPred, aiConf: ev.aiConf };
    });

  // 計算入場時的額外背景資料（供 AI 學習使用）
  const entryMTFAlign = ['15m','1h','4h','1d'].filter(tf => {
    const sig = mtfData[tf]?.signal;
    return sig && (isLong ? sig.signal?.includes('bull') : sig.signal?.includes('bear'));
  }).length;
  const slType = slReason.includes('PO3') || slReason.includes('掃蕩') ? 'po3'
              : slReason.includes('支撐結構') || slReason.includes('壓力結構') ? 'structural'
              : 'atr';

  const tradeCtx = {
    entryAbovePOC:      vp1h?.priceAbovePOC ?? null,
    entryWhaleBias:     whale?.bias || null,
    entryVolBias:       mtfData['1h']?.volAI?.bias || null,
    entryVolBreakout:   mtfData['1h']?.volAI?.isBreakout || false,
    entryVolDivergence: mtfData['1h']?.volAI?.divergence || null,
    entryMTFAlign,
    entrySlType:        slType,
  };

  // AI 學習調整：依歷史止損模式下調信心
  const learnCtx = {
    abovePOC:      vp1h?.priceAbovePOC ?? null,
    whaleBias:     whale?.bias || null,
    volDivergence: mtfData['1h']?.volAI?.divergence || null,
    mtfAlign:      entryMTFAlign,
    slType,
    score:         parseFloat(coin.score) || 50,
    skipAdxRule:   true,  // hardAdxPenalty 已單獨扣分，避免 low_adx 規則雙重扣分
    macdHist:      parseFloat(coin.macdHist) || 0,
    volWeak:       (coin.volumeStrength || '') === '低' || String(coin.volumeStrength||'').includes('弱'),
    h4Aligned:     isLong ? !!h4?.signal?.includes('bull') : !!h4?.signal?.includes('bear'),
    scoreStrength: (() => { const s = isLong ? (parseFloat(coin.score)||50) : 100-(parseFloat(coin.score)||50); return s >= 75 ? 'strong' : s >= 65 ? 'medium' : 'weak'; })(),
    killZone:      (() => { const h = new Date().getUTCHours(); return h >= 7 && h < 11 ? 'london' : h >= 13 && h < 17 ? 'ny' : h >= 0 && h < 4 ? 'asia' : 'other'; })(),
    // 新增：週線、1H、BB走軌方向上下文
    weeklyAgainst: isLong ? (coin.weeklySignal||'').includes('bear') : (coin.weeklySignal||'').includes('bull'),
    h1Aligned:     isLong ? !!(coin.h1Signal||'').includes('bull') : !!(coin.h1Signal||'').includes('bear'),
    bbWalkingBear: !!(bb1h_?.walkingBear),
    bbWalkingBull: !!(bb1h_?.walkingBull),
  };
  const adxVal = parseFloat(coin.adx) || 20;
  // 硬性 ADX 門檻（不依賴歷史數據，始終生效）
  const hardAdxPenalty = adxVal < 18 ? 18 : adxVal < 22 ? 10 : 0;
  let learnResult;
  try { learnResult = applyLearnAdjustment(direction, rsi, adxVal, learnCtx); } catch(e) {
    console.warn('[buildTradeSetup] applyLearnAdjustment 失敗，使用預設值:', e);
    learnResult = { penalty: 0, warnings: [], hardBlocked: false, blockReasons: [], defenseChecks: [] };
  }
  const { penalty: learnPenalty, warnings: learnWarn0, hardBlocked, blockReasons } = learnResult;
  // 合併警告：硬性 ADX 警告 + AI 學習警告 + 最終防線
  const learnWarnings = [...learnWarn0];
  if (hardAdxPenalty > 0) {
    learnWarnings.push(`ADX ${adxVal} 過低（${adxVal < 18 ? '< 18' : '< 22'}），震盪行情信心下調 ${hardAdxPenalty}%，建議等 ADX > 22 再進場`);
  }
  if (hardBlocked) blockReasons.forEach(r => learnWarnings.push(r));

  // ── 技術面逆風扣分 (RSI逆向、MACD背離、成交量弱、大時框架對立) ──
  let techPenalty = 0;
  const techPenReasons = [];
  if (isLong) {
    if (rsi > 78)      { techPenalty += 7; techPenReasons.push(`RSI ${rsi} 嚴重超買，追多止損風險極高，扣 7%`); }
    else if (rsi > 70) { techPenalty += 4; techPenReasons.push(`RSI ${rsi} 超買區間，追多逆向風險，扣 4%`); }
  } else {
    if (rsi < 22)      { techPenalty += 7; techPenReasons.push(`RSI ${rsi} 嚴重超賣，追空止損風險極高，扣 7%`); }
    else if (rsi < 30) { techPenalty += 4; techPenReasons.push(`RSI ${rsi} 超賣區間，追空逆向風險，扣 4%`); }
  }
  const _btsMACD = parseFloat(coin.macdHist) || 0;
  if (isLong  && _btsMACD < 0) { techPenalty += 3; techPenReasons.push(`MACD 柱狀負值，多頭動能待確認，扣 3%`); }
  if (!isLong && _btsMACD > 0) { techPenalty += 3; techPenReasons.push(`MACD 柱狀正值，空頭動能待確認，扣 3%`); }
  const _btsVol = coin.volumeStrength || '';
  if (_btsVol === '低' || _btsVol.includes('弱')) { techPenalty += 3; techPenReasons.push(`成交量弱勢（${_btsVol}），突破動能不足，扣 3%`); }
  // 實體K棒突破量能要求：低量突破直接封鎖；非低量但無明確高量則扣分
  {
    const _hasBreakout = isLong
      ? (m15?.bullBreak || h1?.bullBreak || h4?.bullBreak)
      : (m15?.bearBreak || h1?.bearBreak || h4?.bearBreak);
    if (_hasBreakout) {
      if (_btsVol === '低' || _btsVol.includes('弱')) {
        // 低量突破：直接封鎖（假突破機率極高，不予進場）
        techPenalty += 30;
        techPenReasons.push(`實體K棒突破但量能偏低（${_btsVol}），假突破風險極高，扣 30%`);
      } else {
        const _breakWithVol = isLong
          ? ((m15?.bullBreak && m15?.isHighVol) || (h1?.bullBreak && h1?.isHighVol) || (h4?.bullBreak && h4?.isHighVol))
          : ((m15?.bearBreak && m15?.isHighVol) || (h1?.bearBreak && h1?.isHighVol) || (h4?.bearBreak && h4?.isHighVol));
        if (!_breakWithVol) {
          techPenalty += 8;
          techPenReasons.push(`實體K棒突破但未見放量確認，假突破風險高，扣 8%`);
        }
      }
    }
  }
  // 大時間框架對立扣分（bigTrendBlocked 已攔截雙雙逆勢，這裡處理單邊逆勢）
  if (!bigTrendBlocked) {
    if (h4?.signal?.includes(isLong ? 'bear' : 'bull')) { techPenalty += 4; techPenReasons.push(`4H 方向（${h4TrendLabel}）與${isLong ? '做多' : '做空'}逆勢，中週期阻力，扣 4%`); }
    if (d1sig_?.signal?.includes(isLong ? 'bear' : 'bull')) { techPenalty += 5; techPenReasons.push(`日線方向（${d1TrendLabel}）與${isLong ? '做多' : '做空'}逆勢，大週期阻力，扣 5%`); }
  }
  // BB 背離警告（動能衰竭）
  if (isLong  && bb1h_?.bbDivBear) { techPenalty += 5; techPenReasons.push(`BB頂背離（1H）：新高但收盤未觸上軌，多頭動能衰竭，扣 5%`); }
  if (!isLong && bb1h_?.bbDivBull) { techPenalty += 5; techPenReasons.push(`BB底背離（1H）：新低但收盤未觸下軌，空頭動能衰竭，扣 5%`); }
  // 逆向走軌（對手方向 BB 走軌）
  if (isLong  && bb1h_?.walkingBear) { techPenalty += 4; techPenReasons.push(`BB空頭走軌（1H）：連續貼近下軌，逆勢做多風險，扣 4%`); }
  if (!isLong && bb1h_?.walkingBull) { techPenalty += 4; techPenReasons.push(`BB多頭走軌（1H）：連續貼近上軌，逆勢做空風險，扣 4%`); }
  // 足跡圖逆風扣分（Delta 背離 / 方向逆勢）
  if (_fpBTS) {
    const _fpOppose = isLong ? (_fpBTS.deltaDir === 'bear') : (_fpBTS.deltaDir === 'bull');
    if (_fpBTS.deltaDiv) {
      techPenalty += 4;
      techPenReasons.push(`足跡圖 Delta 背離（${isLong ? '多' : '空'}向行進但 Delta 逆向），動能警告，扣 4%`);
    } else if (_fpOppose) {
      techPenalty += 3;
      techPenReasons.push(`足跡圖 Delta 偏${isLong ? '空' : '多'}，與${isLong ? '做多' : '做空'}方向逆勢，扣 3%`);
    }
  }
  techPenalty = Math.min(18, techPenalty);

  // ── 籌碼面逆風扣分 (Taker比例、巨鯨方向) ──
  let chipsPenalty = 0;
  const chipsPenReasons = [];
  if (deriv) {
    const _btkr = deriv.takerBuySell ?? 1;
    if (isLong  && _btkr < 0.80)        { chipsPenalty += 5; chipsPenReasons.push(`期貨主動賣單主導（Taker ${_btkr.toFixed(2)}），空方籌碼佔優，扣 5%`); }
    else if (isLong  && _btkr < 0.88)   { chipsPenalty += 3; chipsPenReasons.push(`期貨買賣比偏空（Taker ${_btkr.toFixed(2)}），多頭籌碼承壓，扣 3%`); }
    else if (!isLong && _btkr > 1.20)   { chipsPenalty += 5; chipsPenReasons.push(`期貨主動買單主導（Taker ${_btkr.toFixed(2)}），多方籌碼佔優，扣 5%`); }
    else if (!isLong && _btkr > 1.12)   { chipsPenalty += 3; chipsPenReasons.push(`期貨買賣比偏多（Taker ${_btkr.toFixed(2)}），空頭籌碼承壓，扣 3%`); }
  }
  if (whale) {
    if (isLong  && whale.bias === 'bear' && (whale.bigSellCount || 0) >= 3) { chipsPenalty += 4; chipsPenReasons.push(`巨鯨持續賣出（${whale.bigSellCount} 筆大額賣單），多頭逆風，扣 4%`); }
    if (!isLong && whale.bias === 'bull' && (whale.bigBuyCount  || 0) >= 3) { chipsPenalty += 4; chipsPenReasons.push(`巨鯨持續買入（${whale.bigBuyCount} 筆大額買單），空頭逆風，扣 4%`); }
  }
  chipsPenalty = Math.min(10, chipsPenalty);
  // 風控規則直接扣減基礎分數（包括歷史止損 + 當前交易的技術/籌碼逆風）
  const _totalDefenseDrag = learnPenalty + hardAdxPenalty + techPenalty + chipsPenalty;
  rawConf = Math.max(40, rawConf - _totalDefenseDrag);

  // 合併扣分原因
  techPenReasons.forEach(r => aiTrendReasons.push(`📐 技術面：${r}`));
  chipsPenReasons.forEach(r => aiTrendReasons.push(`🐋 籌碼面：${r}`));

  // ── 風控分（100 分扣分制）──
  // 先扣止損風控，再扣風險評估，最終風控分才是入場門檻依據
  const _cLearnDrag = Math.min(45, learnPenalty);
  let conf = Math.max(0, Math.round(100 - _cLearnDrag));
  const baseConf  = Math.max(0, rawConf - hardAdxPenalty);
  const macroConf = Math.max(0, baseConf - macroOpposePenalty - aiTrendPenalty - techPenalty - chipsPenalty);

  // ── AI 風險評估（傳入 pre-risk conf，避免循環依賴）──
  let _risk = { score: 0, level: '低風險', levelColor: '#22c55e', factors: [], recs: [] };
  try {
    _risk = computeFullRisk(coin, {
      conf, macroPenalty: macroOpposePenalty, aiTrendPenalty, learnPenalty,
      techPenalty, chipsPenalty, rr1: rr1str,
      flipRisks, isRangeMode, bigTrendBlocked,
    }, isLong);
  } catch(_re) { console.warn('[buildTradeSetup risk]', coin?.symbol, _re); }

  // 計算風險扣分（比例制）並更新最終風控分
  const _riskPenBTS = calcRiskPenalty(_risk.score);
  conf = Math.max(0, conf - _riskPenBTS);
  const finalConf = conf;

  // 入場門檻：最終風控分 < 60 或 AI 硬封鎖 → 觀望
  if (conf < 60 || hardBlocked) direction = 'wait';
  if (learnWarnings.length && direction !== 'wait') {
    learnWarnings.forEach(w => entryReasons.push(`⚠️ ${w}`));
  }

  // 風控分不足且風險評估是主因 → 顯示風險警示觀望頁（早期返回）
  if (direction === 'wait' && _riskPenBTS > 0 && !hardBlocked && conf < 60) {
    _tradeSetupCache[coin.symbol] = {
      direction: 'wait',
      riskScore: _risk.score, riskLevel: _risk.level,
      riskFactors: _risk.factors, riskRecs: _risk.recs,
    };
    const _rIconMap = { '極高風險': '🚨', '高風險': '⛔', '中風險': '⚠️' };
    const _rIcon = _rIconMap[_risk.level] || '⚠️';
    const _wClrR = weeklyOpposed ? 'var(--bear)' : weeklyNeutral ? '#f59e0b' : 'var(--bull)';
    const _tClrR = todayOpposed  ? 'var(--bear)' : todayNeutral  ? '#f59e0b' : 'var(--bull)';
    return `<div class="setup-wait">
      <div class="setup-wait-icon">${_rIcon}</div>
      <div class="setup-wait-title" style="color:${_risk.levelColor}">${_risk.level}（${_risk.score}/100）— 風控分 ${conf} 分不足 60，AI 建議觀望</div>
      <ul class="setup-wait-reasons">
        ${_risk.factors.map(f => `<li>${f}</li>`).join('')}
      </ul>
      <div style="margin-top:12px;padding:10px 12px;background:${_risk.levelColor}11;border:1px solid ${_risk.levelColor}44;border-radius:9px">
        <div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px">💡 AI 建議（僅供參考）</div>
        ${_risk.recs.map(r => `<div style="font-size:0.73rem;color:#a5f3fc;padding:2px 0">→ ${r}</div>`).join('')}
      </div>
      <div style="margin-top:10px;padding:10px 12px;background:rgba(129,140,248,.05);border:1px solid rgba(129,140,248,.15);border-radius:9px">
        <div style="font-size:0.73rem;font-weight:600;color:var(--text2);margin-bottom:7px">🤖 AI 趨勢預測（本週 · 今日）</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <span style="font-size:0.73rem;padding:3px 10px;border-radius:16px;border:1px solid ${_wClrR}40;color:${_wClrR}">📈 本週 ${weeklyBiasData?.biasLabel || '—'}（${weeklyBiasData?.conf || 50}%）</span>
          <span style="font-size:0.73rem;padding:3px 10px;border-radius:16px;border:1px solid ${_tClrR}40;color:${_tClrR}">📅 今日 ${todayBiasData?.biasLabel || '—'}（${todayBiasData?.conf || 50}%）</span>
        </div>
      </div>
      ${_erHtml()}
    </div>`;
  }

  // 即使是觀望，也記錄最終防線原因供顯示
  if (hardBlocked && direction === 'wait') {
    learnWarnings.forEach(w => entryReasons.push(w));
  }
  // 大趨勢攔截說明
  if (bigTrendBlocked) {
    entryReasons.push(`🚫 ${bigTrendBlockReason}`);
  }

  // ── 訊號品質 AI 評估（全數據多因子評分，最高約 20 分，可因逆風因子扣至 0）──
  const _sqFactors = [];
  let _sqScore = 0;
  // 提前取得止損記憶防線（供 ⑬ 和 ⑱ 共用）
  const _sqDefChecks  = learnResult?.defenseChecks || [];
  const _sqFailChecks = _sqDefChecks.filter(c => !c.pass && c.type !== 'sugg_ref');

  // ① 其餘時框同向加分（1H / 日線 / 週線）— 4H+15m（短線）或日線+4H+15m（長線）為硬性條件，不重複計分
  // 硬性條件通過標籤：長線顯示日線+4H+15m，短線顯示4H+15m
  _sqFactors.push(canScaleIn ? '✅ 日線+4H+15m 三確認（長線硬性條件）' : '✅ 4H+15m 雙確認（短線硬性條件）');
  {
    const _sqH1Ok  = h1?.signal?.includes(isLong ? 'bull' : 'bear');
    const _sqH1Op  = h1?.signal?.includes(isLong ? 'bear' : 'bull');
    const _sqD1Ok  = d1sig_?.signal?.includes(isLong ? 'bull' : 'bear');
    const _sqD1Op  = d1sig_?.signal?.includes(isLong ? 'bear' : 'bull');
    const _sqWk1Ok = wkS?.signal?.includes(isLong ? 'bull' : 'bear');
    const _sqWk1Op = wkS?.signal?.includes(isLong ? 'bear' : 'bull');
    if (_sqH1Ok)  { _sqScore += 1; _sqFactors.push('✅ 1H 走勢同向 +1'); }
    else if (_sqH1Op)                { _sqFactors.push('❌ 1H 走勢逆向'); }
    else                             { _sqFactors.push('⬜ 1H 走勢中性'); }
    if (_sqD1Ok)  { _sqScore += 1; _sqFactors.push('✅ 日線走勢同向 +1'); }
    else if (_sqD1Op) { _sqScore -= 1; _sqFactors.push('❌ 日線走勢逆向 -1'); }
    else                             { _sqFactors.push('⬜ 日線走勢中性'); }
    if (_sqWk1Ok) { _sqScore += 1; _sqFactors.push('✅ 週線走勢同向 +1'); }
    else if (_sqWk1Op){ _sqScore -= 1; _sqFactors.push('❌ 週線走勢逆向 -1'); }
    else                             { _sqFactors.push('⬜ 週線走勢中性'); }
  }

  // ② AI 預測（本週+今日）— max +2，逆向各扣 1 分
  const _sqWkAI    = weeklyBiasData?.bias?.includes(isLong ? 'bull' : 'bear');
  const _sqTdAI    = todayBiasData?.bias?.includes(isLong ? 'bull' : 'bear');
  const _sqWkAIOpp = weeklyBiasData?.bias && !_sqWkAI && weeklyBiasData.bias !== 'neutral';
  const _sqTdAIOpp = todayBiasData?.bias  && !_sqTdAI && todayBiasData.bias  !== 'neutral';
  if (_sqWkAI)         { _sqScore += 1; _sqFactors.push(`✅ 本週AI同向（${weeklyBiasData.biasLabel}）+1`); }
  else if (_sqWkAIOpp) { _sqScore -= 1; _sqFactors.push(`❌ 本週AI逆向（${weeklyBiasData.biasLabel}）-1`); }
  else                 { _sqFactors.push(`⚠️ 本週AI中性（${weeklyBiasData?.biasLabel || '—'}）`); }
  if (_sqTdAI)         { _sqScore += 1; _sqFactors.push(`✅ 今日AI同向（${todayBiasData.biasLabel}）+1`); }
  else if (_sqTdAIOpp) { _sqScore -= 1; _sqFactors.push(`❌ 今日AI逆向（${todayBiasData.biasLabel}）-1`); }
  else                 { _sqFactors.push(`⚠️ 今日AI中性（${todayBiasData?.biasLabel || '—'}）`); }

  // ③ 宏觀環境（獨立評分因子）— max +2，重度逆風時扣分
  {
    const _sqMacOk  = (isLong && _btsNetDir?.includes('bull'))  || (!isLong && _btsNetDir?.includes('bear'));
    const _sqMacOpp = (isLong && _btsNetDir?.includes('bear'))  || (!isLong && _btsNetDir?.includes('bull'));
    const _sqFgVal  = fearGreed ? parseInt(fearGreed.value || '50') : 50;
    const _sqFgNtrl = _sqFgVal >= 40 && _sqFgVal <= 60;
    let _sqMacPts   = 0;
    if (_sqMacOk)  _sqMacPts += 1;
    if (_sqFgNtrl && !_sqMacOpp) _sqMacPts += 1;
    if (_sqMacOpp) _sqMacPts -= 2;
    if (macroOpposePenalty >= 15) _sqMacPts = Math.min(_sqMacPts, _sqMacPts - 1);
    _sqScore += _sqMacPts;
    if (_sqMacPts >= 2)       { _sqFactors.push(`✅ 宏觀環境同向（${_btsNetDir}，F&G ${_sqFgVal}）+2`); }
    else if (_sqMacPts === 1) { _sqFactors.push(`⚠️ 宏觀環境部分支持（F&G ${_sqFgVal}）+1`); }
    else if (_sqMacPts < 0)   { _sqFactors.push(`❌ 宏觀環境逆風（${_sqMacPts}）`); macroReasons.slice(0, 2).forEach(r => _sqFactors.push(`　▸ ${r}`)); }
    else                      { _sqFactors.push(`⬜ 宏觀環境中性（F&G ${_sqFgVal}）`); }
  }

  // ④ 足跡圖 Delta — max +1，逆向/背離時扣分
  if (_fpBTS) {
    const _fpDirOk  = isLong ? (_fpBTS.deltaDir === 'bull') : (_fpBTS.deltaDir === 'bear');
    const _fpDirOpp = isLong ? (_fpBTS.deltaDir === 'bear') : (_fpBTS.deltaDir === 'bull');
    if (_fpBTS.deltaDiv)   { _sqScore -= 1; _sqFactors.push('⚡ 足跡圖 Delta 背離 -1'); }
    else if (_fpDirOk)     { _sqScore += 1; _sqFactors.push('✅ 足跡圖 Delta 確認 +1'); }
    else if (_fpDirOpp)    { _sqScore -= 1; _sqFactors.push('❌ 足跡圖 Delta 逆向 -1'); }
    else                   { _sqFactors.push('⬜ 足跡圖 Delta 中性'); }
  }

  // ⑤ ICT 結構（OB / FVG / Kill Zone）— max +2
  let _sqIctCnt = 0;
  if (_ictOB?.priceInOB || _ictOB4h?.priceInOB) _sqIctCnt++;
  if ((_ictFVG && !_ictFVG.filled) || (_ictFVG4h && !_ictFVG4h.filled)) _sqIctCnt++;
  if (_kz?.quality === 'high') _sqIctCnt++;
  _sqScore += Math.min(2, _sqIctCnt);
  if (_sqIctCnt >= 2)      _sqFactors.push(`✅ ICT 多重結構確認 +${Math.min(2, _sqIctCnt)}`);
  else if (_sqIctCnt === 1) _sqFactors.push('⚠️ ICT 單一結構 +1');
  else                      _sqFactors.push('⬜ ICT 結構：無明顯支撐');

  // ⑥ ADX 趨勢強度 — max +1，過弱時扣分
  if (adxVal >= 28)      { _sqScore += 1; _sqFactors.push(`✅ ADX ${adxVal} 趨勢確立 +1`); }
  else if (adxVal >= 22) { _sqFactors.push(`⚠️ ADX ${adxVal} 趨勢偏弱`); }
  else                   { _sqScore -= 1; _sqFactors.push(`❌ ADX ${adxVal} 趨勢過弱 -1`); }

  // ⑦ 訂單流（CVD + Taker 主動買賣）— max +1
  const _sqOFOk  = isLong ? (cvdTrend === 'bull' && buyPct > 55) : (cvdTrend === 'bear' && buyPct < 45);
  const _sqOFOpp = isLong ? (cvdTrend === 'bear' && buyPct < 45) : (cvdTrend === 'bull' && buyPct > 55);
  if (_sqOFOk)        { _sqScore += 1; _sqFactors.push('✅ 訂單流同向確認 +1'); }
  else if (_sqOFOpp)  { _sqFactors.push('❌ 訂單流逆向'); }
  else                { _sqFactors.push('⬜ 訂單流中性'); }

  // ⑧ 籌碼面全面（Whale 巨鯨 + VP 成交量結構 + 期貨Taker比）— max +2，逆向時扣分
  {
    let _sqChipsPts = 0;
    if (whale) {
      const _sqWhaleOk  = isLong ? (whale.bias === 'bull' && (whale.bigBuyCount  || 0) >= 3) : (whale.bias === 'bear' && (whale.bigSellCount || 0) >= 3);
      const _sqWhaleOpp = isLong ? (whale.bias === 'bear' && (whale.bigSellCount || 0) >= 3) : (whale.bias === 'bull' && (whale.bigBuyCount  || 0) >= 3);
      if (_sqWhaleOk)  { _sqChipsPts += 1; _sqFactors.push(`✅ 巨鯨${isLong ? '買入' : '賣出'}同向（${isLong ? whale.bigBuyCount : whale.bigSellCount}筆）+1`); }
      else if (_sqWhaleOpp) { _sqChipsPts -= 1; _sqFactors.push(`❌ 巨鯨${isLong ? '賣出' : '買入'}逆向（${isLong ? whale.bigSellCount : whale.bigBuyCount}筆）-1`); }
    }
    if (vp1h) {
      const _sqVPOk  = isLong  ? (vp1h.priceAbovePOC  && Math.abs(vp1h.distToPOC) < 3)  : (!vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 3);
      const _sqVPOpp = !isLong ? (vp1h.priceAbovePOC  && Math.abs(vp1h.distToPOC) < 1.5): (!vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 1.5);
      if (_sqVPOk)  { _sqChipsPts += 1; _sqFactors.push(`✅ VP籌碼${isLong ? '多' : '空'}頭結構（POC $${fmtPrice(vp1h.poc)}）+1`); }
      else if (_sqVPOpp) { _sqFactors.push(`❌ VP籌碼逆向（${isLong ? '低於' : '高於'}POC 磁吸阻力）`); }
    }
    if (deriv) {
      const _tkr = deriv.takerBuySell ?? 1;
      const _sqTkOk  = isLong  ? _tkr >= 1.10 : _tkr <= 0.90;
      const _sqTkOpp = isLong  ? _tkr <= 0.85 : _tkr >= 1.15;
      if (_sqTkOk)  { _sqChipsPts += 1; _sqFactors.push(`✅ 期貨Taker同向（${_tkr.toFixed(2)}）+1`); }
      else if (_sqTkOpp) { _sqChipsPts -= 1; _sqFactors.push(`❌ 期貨Taker逆向（${_tkr.toFixed(2)}）-1`); }
    }
    _sqScore += Math.min(2, Math.max(-2, _sqChipsPts));
  }

  // ⑨ 成交量AI（放量突破 / 背離）— max +1，背離時扣分
  {
    const _sqVolAI = mtfData['1h']?.volAI;
    if (_sqVolAI) {
      const _sqVolOk  = isLong  ? ((_sqVolAI.isBreakout || _sqVolAI.isSpike) && _sqVolAI.bias === 'bull') : ((_sqVolAI.isBreakout || _sqVolAI.isSpike) && _sqVolAI.bias === 'bear');
      const _sqVolDiv = isLong  ? (_sqVolAI.divergence === 'bearish_div') : (_sqVolAI.divergence === 'bullish_div');
      if (_sqVolOk && !_sqVolDiv) { _sqScore += 1; _sqFactors.push(`✅ 放量突破同向（${_sqVolAI.volRatio}x均量）+1`); }
      else if (_sqVolDiv)         { _sqScore -= 1; _sqFactors.push(`❌ 成交量背離警告 -1`); }
      else                        { _sqFactors.push(`⬜ 成交量 ${_sqVolAI.bias || '中性'}（${_sqVolAI.volRatio}x）`); }
    }
  }

  // ⑩ 布林通道型態（走軌 / 收窄 / 背離）— max +1，逆向走軌/背離時扣分
  if (bb1h_) {
    const _sqBBOk  = isLong ? bb1h_.walkingBull : bb1h_.walkingBear;
    const _sqBBOpp = isLong ? bb1h_.walkingBear : bb1h_.walkingBull;
    const _sqBBDiv = isLong ? bb1h_.bbDivBear   : bb1h_.bbDivBull;
    if (_sqBBOk && !_sqBBDiv)  { _sqScore += 1; _sqFactors.push(`✅ BB${isLong ? '多' : '空'}頭走軌確認 +1`); }
    else if (_sqBBDiv)         { _sqScore -= 1; _sqFactors.push(`❌ BB${isLong ? '頂' : '底'}背離警告 -1`); }
    else if (_sqBBOpp)         { _sqScore -= 1; _sqFactors.push(`❌ BB逆向走軌 -1`); }
    else if (bb1h_.isSqueezing){ _sqFactors.push('⚠️ BB收窄蓄力（待突破方向確認）'); }
  }

  // ⑪ 技術面無逆風（RSI/MACD/成交量/大框架衝突）— max +1
  const _sqNoTechRisk = techPenalty === 0;
  if (_sqNoTechRisk) { _sqScore += 1; _sqFactors.push('✅ 技術面無逆風 +1'); }
  else {
    _sqFactors.push(`❌ 技術面逆風（信心 -${techPenalty}%）`);
    techPenReasons.slice(0, 3).forEach(r => _sqFactors.push(`　▸ ${r}`));
  }

  // ⑫ R/R 品質（盈虧比）— max +1，不足時扣分
  const _sqRR1 = parseFloat(rr1str) || 0;
  if (_sqRR1 >= 2.0)      { _sqScore += 1; _sqFactors.push(`✅ R/R ${_sqRR1.toFixed(1)}:1 優良 +1`); }
  else if (_sqRR1 >= 1.3) { _sqFactors.push(`⚠️ R/R ${_sqRR1.toFixed(1)}:1（可接受）`); }
  else                    { _sqScore -= 1; _sqFactors.push(`❌ R/R ${_sqRR1.toFixed(1)}:1 盈虧比不足 -1`); }

  // ⑬ 風控評估 + 止損AI建議 — max +2，高風險/警告時扣分
  if (_risk.score <= 20)      { _sqScore += 2; _sqFactors.push(`✅ 風控優良（${_risk.score}分）+2`); }
  else if (_risk.score <= 40) { _sqScore += 1; _sqFactors.push(`✅ 風控良好（${_risk.score}分）+1`); }
  else if (_risk.score <= 54) { _sqFactors.push(`⚠️ 風控中等（${_risk.score}分）`); }
  else                        { _sqScore -= 1; _sqFactors.push(`❌ 風控偏高（${_risk.score}分）-1`); }
  if (_risk.factors?.length) _risk.factors.slice(0, 2).forEach(f => _sqFactors.push(`　▸ ${f}`));
  if (_risk.recs?.length) {
    _sqFactors.push(`💡 止損AI建議：${_risk.recs[0]}`);
  }
  // 有實際扣分記錄的項目 → 扣 SQ 分；零扣分建議 → 僅參考顯示
  {
    const _sqPenChecks = _sqDefChecks.filter(c => !c.pass && (c.penalty || 0) > 0);
    const _sqRefOnly   = _sqDefChecks.filter(c => !c.pass && (c.penalty || 0) === 0 && c.type !== 'sugg_ref');
    if (_sqPenChecks.length) {
      const _sqFlPen = Math.min(3, _sqPenChecks.length);
      _sqScore -= _sqFlPen;
      _sqFactors.push(`❌ 止損記錄警告（${_sqPenChecks.length} 項有扣分）-${_sqFlPen}`);
      _sqPenChecks.slice(0, 2).forEach(c => _sqFactors.push(`　▸ 📉 ${c.label}（扣 ${c.penalty} 分）`));
    }
    if (_sqRefOnly.length) {
      _sqRefOnly.slice(0, 2).forEach(c => _sqFactors.push(`　▸ 📌 ${c.label}（參考）`));
    }
  }

  // ⑭ 技術圖形識別（傳統形態 + ICT）— max +2，逆向圖形時扣 1 分
  _sqScore += Math.min(2, _chartPat.score);
  if (_chartPat.aligned.length > 0) {
    _sqFactors.push(`✅ 圖形確認（${_chartPat.aligned.length}種同向）+${Math.min(2, _chartPat.score)}`);
    _chartPat.aligned.slice(0, 3).forEach(p => _sqFactors.push(`　▸ ${p.emoji} ${p.name}：${p.desc}`));
  } else if (_chartPat.neutral.length > 0) {
    _sqFactors.push('⚠️ 中性圖形（等待突破確認）');
    _chartPat.neutral.slice(0, 2).forEach(p => _sqFactors.push(`　▸ ${p.emoji} ${p.name}：${p.desc}`));
  } else {
    _sqFactors.push('⬜ 圖形識別：無明顯形態');
  }
  if (_chartPat.opposing.length > 0) {
    const _sqOppPen = Math.min(1, _chartPat.opposing.length);
    _sqScore -= _sqOppPen;
    _sqFactors.push(`❌ 逆向圖形警告（${_chartPat.opposing.length}種）-${_sqOppPen}`);
    _chartPat.opposing.slice(0, 2).forEach(p => _sqFactors.push(`　▸ ${p.emoji} ${p.name}：${p.desc}`));
  }

  // ⑮ AI新聞/市場洞察（基本面情緒）— max +1，逆向時扣分
  try {
    const _sqIns     = aiGenerateMarketInsights();
    const _sqBearCnt = _sqIns.filter(i => i.sentiment === 'bearish' || i.sentiment === 'bear').length;
    const _sqBullCnt = _sqIns.filter(i => i.sentiment === 'bullish' || i.sentiment === 'bull').length;
    const _sqInsTotal = _sqBearCnt + _sqBullCnt;
    if (_sqInsTotal > 0) {
      if (isLong  && _sqBullCnt > _sqBearCnt)  { _sqScore += 1; _sqFactors.push(`✅ AI新聞利多（${_sqBullCnt}/${_sqInsTotal}條）+1`); }
      else if (!isLong && _sqBearCnt > _sqBullCnt) { _sqScore += 1; _sqFactors.push(`✅ AI新聞利空（${_sqBearCnt}/${_sqInsTotal}條）+1`); }
      else if (isLong  && _sqBearCnt > _sqBullCnt) { _sqScore -= 1; _sqFactors.push(`❌ AI新聞偏空，多頭逆風（${_sqBearCnt}/${_sqInsTotal}條）-1`); }
      else if (!isLong && _sqBullCnt > _sqBearCnt) { _sqScore -= 1; _sqFactors.push(`❌ AI新聞偏多，空頭逆風（${_sqBullCnt}/${_sqInsTotal}條）-1`); }
      else { _sqFactors.push(`⚠️ AI新聞多空均衡（${_sqInsTotal}條）`); }
    }
  } catch(_sqNE) {}

  // ⑯ 爆倉地圖（近側爆倉牆 = 擠壓行情加分）— max +1
  try {
    const _sqLiq = _liquidationCache[coin.symbol];
    if (_sqLiq && price > 0) {
      const _sqSqWall = isLong
        ? (_sqLiq.shortLiqs || []).find(l => l.price > price && l.price <= price * 1.12)
        : (_sqLiq.longLiqs  || []).find(l => l.price < price && l.price >= price * 0.88);
      if (_sqSqWall) { _sqScore += 1; _sqFactors.push(`✅ 爆倉擠壓牆 $${fmtPrice(_sqSqWall.price)}（${isLong ? '空單' : '多單'}爆倉區）+1`); }
    }
  } catch(_sqLE) {}

  // ⑰ 重要數據/資金流動事件（扣分因子）
  try {
    const _sqNearEvs = getTodayEconEvents().filter(ev => {
      const mins = (ev.eventTime.getTime() - Date.now()) / 60000;
      return ev.impact === 'high' && mins >= -30 && mins <= 90;
    });
    if (_sqNearEvs.length >= 2)      { _sqScore -= 2; _sqFactors.push(`❌ 多個重要數據事件即將公布 -2`); _sqNearEvs.slice(0, 2).forEach(e => _sqFactors.push(`　▸ ${e.name}`)); }
    else if (_sqNearEvs.length === 1) { _sqScore -= 1; _sqFactors.push(`❌ 重要數據即將公布（${_sqNearEvs[0].name}）-1`); }
  } catch(_sqEE) {}
  try {
    const _sqCF     = getCapitalFlowBias();
    const _sqCFOpp  = (_sqCF.events || []).filter(ev => (isLong ? ev.bear : ev.bull) > 0);
    if (_sqCFOpp.length >= 2) {
      _sqScore -= 1; _sqFactors.push(`❌ 資金流動逆風（${_sqCFOpp.length}個事件）-1`);
      _sqCFOpp.slice(0, 2).forEach(ev => _sqFactors.push(`　▸ ${ev.name}（${ev.isActive ? '進行中' : (ev.daysUntil || 0) + '天後'}）`));
    } else if (_sqCFOpp.length === 1) {
      _sqFactors.push(`⚠️ 資金流動警告：${_sqCFOpp[0].name}（${_sqCFOpp[0].isActive ? '進行中' : (_sqCFOpp[0].daysUntil || 0) + '天後'}）`);
    }
  } catch(_sqCFE) {}


  // ⑲ 長線單額外審查（月線逆向 / EMA200 距離追高）
  if (canScaleIn) try {
    const _sqMon = mtfData['1M']?.signal;
    if (_sqMon?.signal) {
      const _sqMonOpp = isLong ? _sqMon.signal.includes('bear') : _sqMon.signal.includes('bull');
      if (_sqMonOpp) { _sqScore -= 1; _sqFactors.push(`❌ 月線趨勢逆向（長線持倉風險）-1`); }
      else            { _sqFactors.push(`✅ 月線同向（${isLong ? '月線偏多' : '月線偏空'}，長線一致）`); }
    }
    const _sqE200 = parseFloat(coin.ema200) || 0;
    if (_sqE200 > 0 && price > 0) {
      const _sqE200Pct = (price - _sqE200) / price * 100;
      if (isLong  && _sqE200Pct > 15) { _sqScore -= 1; _sqFactors.push(`❌ 現價高於 EMA200 逾 ${_sqE200Pct.toFixed(1)}%，長線追高風險 -1`); }
      else if (!isLong && _sqE200Pct < -15) { _sqScore -= 1; _sqFactors.push(`❌ 現價低於 EMA200 逾 ${Math.abs(_sqE200Pct).toFixed(1)}%，長線追空風險 -1`); }
      else { _sqFactors.push(`✅ EMA200 距離適中（${_sqE200Pct > 0 ? '+' : ''}${_sqE200Pct.toFixed(1)}%）`); }
    }
  } catch(_sqLTE) {}

  // ⑳ ICT 五大模型（烏龜湯 / 2022核心 / 獨角獸 / 銀彈）— max +3
  try {
    let _sqIctModelPts = 0;
    const _sqIctModelNames = [];
    if (isLong ? _turtleSoup?.bull : _turtleSoup?.bear) {
      _sqIctModelPts += 2; _sqIctModelNames.push('🐢 烏龜湯');
    }
    if (_coreModel?.detected) {
      _sqIctModelPts += _coreModel.isComplete ? 2 : 1;
      _sqIctModelNames.push(`📐 核心${_coreModel.isComplete ? '完成' : '進行'}`);
    }
    if (_unicornModel?.detected && _unicornModel.priceInGoldenZone) {
      _sqIctModelPts += 2; _sqIctModelNames.push('🦄 獨角獸');
    }
    if (_silverBullet?.detected && _silverBullet.priceAtFVG) {
      _sqIctModelPts += 2; _sqIctModelNames.push('🗽 銀彈');
    }
    _sqIctModelPts = Math.min(3, _sqIctModelPts);
    if (_sqIctModelPts > 0) {
      _sqScore += _sqIctModelPts;
      _sqFactors.push(`✅ ⑳ICT五大模型（${_sqIctModelNames.join('+')}）+${_sqIctModelPts}`);
    } else {
      _sqFactors.push('⬜ ⑳ICT五大模型：未觸發');
    }
  } catch(_sqIctE) {}

  // ㉑ 市場微結構品質（足跡圖 VWAP + Bid-Ask Bounce）— max +1
  try {
    if (_fpBTS?.microstructureQuality != null) {
      if (_fpBTS.microstructureQuality >= 70) {
        _sqScore += 1; _sqFactors.push(`✅ ㉑市場微結構優良（${_fpBTS.microstructureQuality}分）+1`);
      } else if ((_fpBTS.bidAskBounceScore ?? 0) > 65) {
        _sqScore -= 1; _sqFactors.push(`❌ ㉑市場微結構噪音高（Bounce ${_fpBTS.bidAskBounceScore}%）-1`);
      } else {
        _sqFactors.push(`⬜ ㉑市場微結構一般（${_fpBTS.microstructureQuality}分）`);
      }
    }
  } catch(_sqMSE) {}

  // 分數 floor 為 0，等級校準（4H+15m 改硬性條件後 max ≈ 27 分，門檻對應下調 2 分）
  _sqScore = Math.max(0, _sqScore);
  const _sqGrade = _sqScore >= 20 ? 'SSS'
                 : _sqScore >= 17 ? 'SS'
                 : _sqScore >= 15 ? 'S'
                 : _sqScore >= 9  ? 'A'
                 : _sqScore >= 6  ? 'B'
                 : _sqScore >= 3  ? 'C' : 'D';
  const _sqGradeColor = { SSS:'#ffffff', SS:'#ff6ef7', S:'#f0c040', A:'#22c55e', B:'#60a5fa', C:'#f59e0b', D:'#ef4444' }[_sqGrade];
  const _sqGradeLabel = { SSS:'神級訊號', SS:'完美訊號', S:'頂級訊號', A:'優質訊號', B:'良好訊號', C:'一般訊號', D:'訊號偏弱' }[_sqGrade];

  // ── SQ 21因子完整面板（幣種詳情 / 觀望 / 持倉均可注入）──
  const _sqPanelHtml = (() => { try {
    const _sqPos  = _sqFactors.filter(f => f.startsWith('✅'));
    const _sqNeg  = _sqFactors.filter(f => f.startsWith('❌') || f.startsWith('⚡'));
    const _sqWarn = _sqFactors.filter(f => f.startsWith('⚠️'));
    const _sqNeut = _sqFactors.filter(f => f.startsWith('⬜'));
    const _sqBarW = Math.round(Math.min(100, (_sqScore / 20) * 100));
    const _sqBClr = _sqGradeColor || '#9ca3af';
    const _cClr   = conf >= 60 ? '#22c55e' : conf >= 50 ? '#f59e0b' : '#ef4444';
    return `<div style="background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.2);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:0.78rem;font-weight:700;color:var(--text2)">📊 訊號品質評分（SQ）</span>
        <span style="font-size:0.8rem;font-weight:800;color:${_sqBClr};background:${_sqBClr}22;border:1px solid ${_sqBClr}55;padding:2px 10px;border-radius:20px">${_sqGrade} ${_sqGradeLabel}　${_sqScore}分</span>
      </div>
      <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px;margin-bottom:10px">
        <div style="height:100%;width:${_sqBarW}%;background:${_sqBClr};border-radius:2px"></div>
      </div>
      ${_sqPos.length  ? `<div style="margin-bottom:7px"><div style="font-size:0.7rem;color:#22c55e;font-weight:600;margin-bottom:3px">✅ 同向加分（${_sqPos.length}項）</div>${_sqPos.map(f=>`<div style="font-size:0.73rem;color:#86efac;padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      ${_sqNeg.length  ? `<div style="margin-bottom:7px"><div style="font-size:0.7rem;color:#ef4444;font-weight:600;margin-bottom:3px">❌ 逆向扣分（${_sqNeg.length}項）</div>${_sqNeg.map(f=>`<div style="font-size:0.73rem;color:#fca5a5;padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      ${_sqWarn.length ? `<div style="margin-bottom:7px"><div style="font-size:0.7rem;color:#f59e0b;font-weight:600;margin-bottom:3px">⚠️ 偏弱警告（${_sqWarn.length}項）</div>${_sqWarn.map(f=>`<div style="font-size:0.73rem;color:#fcd34d;padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      ${_sqNeut.length ? `<div><div style="font-size:0.7rem;color:var(--text3);font-weight:600;margin-bottom:3px">⬜ 未觸發（${_sqNeut.length}項）</div>${_sqNeut.map(f=>`<div style="font-size:0.73rem;color:var(--text3);padding:1px 0;line-height:1.6">${f}</div>`).join('')}</div>` : ''}
      <div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.06);font-size:0.7rem;color:var(--text3)">風控分 <strong style="color:${_cClr}">${conf}分</strong> / 100　門檻 60分　需 SQ≥A（≥10分）方可入場</div>
    </div>`;
  } catch(_sqPE) { return ''; } })();

  // conf 已在 SQ 計算前完成（100分扣分制），此處不再覆蓋

  // ── ICT / SMC / SNR + 圖形識別（所有情況均顯示於交易建議區）──
  const _ictAnalysisHtml = (() => { try {
    const _ictH = (() => { try {
      const _kzSection = _kz ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">⏰ 獵殺時段</span>
      <span style="color:${_kz.quality === 'high' ? '#22c55e' : _kz.quality === 'medium' ? '#f59e0b' : 'var(--text3)'};font-weight:600">${_kz.emoji} ${_kz.name}</span>
      <span style="color:var(--text3);font-size:0.72rem">${_kz.desc}</span>
      ${_kz.quality === 'high' ? `<span style="background:rgba(34,197,94,.15);color:#22c55e;border-radius:4px;padding:1px 6px;font-size:0.7rem">黃金窗口</span>` : ''}
    </div>` : '';
      return `<div style="background:rgba(16,24,39,.7);border:1px solid rgba(99,102,241,.2);border-radius:10px;padding:10px 14px;margin-bottom:8px;font-size:0.77rem">
    <div style="font-weight:700;color:#a78bfa;margin-bottom:7px;font-size:0.8rem">🧠 ICT / SMC / SNR 智能分析</div>
    ${_kzSection}
    ${(_ictOB || _ictOB4h) ? `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">📦 訂單塊</span>
      <div>
        ${_ictOB ? `<div style="color:${_ictOB.priceInOB ? '#22c55e' : '#f59e0b'}">1H ${_ictOB.label}　$${fmtPrice(_ictOB.low)} – $${fmtPrice(_ictOB.high)}${_ictOB.priceInOB ? ' ✅ 價格在 OB 內' : ''}</div>` : ''}
        ${_ictOB4h ? `<div style="color:${_ictOB4h.priceInOB ? '#22c55e' : '#f59e0b'}">4H ${_ictOB4h.label}　$${fmtPrice(_ictOB4h.low)} – $${fmtPrice(_ictOB4h.high)}${_ictOB4h.priceInOB ? ' ✅ 價格在 OB 內' : ''}</div>` : ''}
      </div>
    </div>` : `<div style="color:var(--text3);margin-bottom:6px">📦 訂單塊　<span style="opacity:.6">當前範圍無明顯 OB</span></div>`}
    ${(_ictFVG || _ictFVG4h) ? `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">📊 FVG 缺口</span>
      <div>
        ${_ictFVG ? `<div style="color:${_ictFVG.filled ? 'var(--text3)' : '#a78bfa'}">1H　$${fmtPrice(_ictFVG.low)} – $${fmtPrice(_ictFVG.high)}（${(_ictFVG.size).toFixed(2)}%）${_ictFVG.filled ? '已回補' : '⚡ 未回補'}</div>` : ''}
        ${_ictFVG4h ? `<div style="color:${_ictFVG4h.filled ? 'var(--text3)' : '#a78bfa'}">4H　$${fmtPrice(_ictFVG4h.low)} – $${fmtPrice(_ictFVG4h.high)}（${(_ictFVG4h.size).toFixed(2)}%）${_ictFVG4h.filled ? '已回補' : '⚡ 未回補'}</div>` : ''}
      </div>
    </div>` : `<div style="color:var(--text3);margin-bottom:6px">📊 FVG 缺口　<span style="opacity:.6">近期無明顯缺口</span></div>`}
    ${_ictPD ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">⚖️ 價格位置</span>
      <span style="color:${_ictPD.idealForLong ? '#22c55e' : _ictPD.idealForShort ? '#ef4444' : '#f59e0b'};font-weight:600">${_ictPD.icon} ${_ictPD.zoneLabel}（${_ictPD.pctInRange.toFixed(0)}% 位置）</span>
      <span style="color:var(--text3);font-size:0.72rem">均衡點 $${fmtPrice(_ictPD.equilibrium)}</span>
      ${(isLong && _ictPD.idealForLong) || (!isLong && _ictPD.idealForShort) ? `<span style="background:rgba(34,197,94,.15);color:#22c55e;border-radius:4px;padding:1px 6px;font-size:0.7rem">SMC 最佳進場</span>` : ''}
    </div>` : ''}
    <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">🎯 關鍵 S/R</span>
      <div style="color:var(--text2);font-size:0.72rem;line-height:1.8">
        ${parseFloat(coin.ema200) > 0 ? `EMA200 $${fmtPrice(parseFloat(coin.ema200))}　` : ''}${parseFloat(coin.ema50) > 0 ? `EMA50 $${fmtPrice(parseFloat(coin.ema50))}　` : ''}${vp1h?.poc ? `POC $${fmtPrice(vp1h.poc)}　` : ''}${bb1h_?.upper ? `BB上 $${fmtPrice(bb1h_.upper)}　BB下 $${fmtPrice(bb1h_.lower)}` : ''}
      </div>
    </div>
    ${(() => { try {
      const _fp = _footprintCache[coin.symbol];
      if (!_fp) return '';
      const _fmtFP = v => parseFloat(v).toPrecision(4).replace(/\.?0+$/, '');
      const _dc = _fp.deltaDir === 'bull' ? '#22c55e' : _fp.deltaDir === 'bear' ? '#ef4444' : 'var(--text3)';
      const _dt = _fp.deltaDir === 'bull' ? '▲ 買盤主導' : _fp.deltaDir === 'bear' ? '▼ 賣盤主導' : '◆ 均衡';
      const _dw = _fp.deltaDiv ? ` <span style="background:rgba(239,68,68,.15);color:#ef4444;padding:1px 5px;border-radius:3px;font-size:0.68rem">⚡ Delta 背離</span>` : '';
      const _vwapDev = (_fp.vwap && price > 0) ? ((price - _fp.vwap) / _fp.vwap * 100) : null;
      const _vwapStr = _fp.vwap ? `　VWAP $${_fmtFP(_fp.vwap)}${_vwapDev != null ? `（${_vwapDev>0?'+':''}${_vwapDev.toFixed(2)}%）` : ''}` : '';
      const _msqClr = (_fp.microstructureQuality ?? 50) >= 70 ? '#22c55e' : (_fp.microstructureQuality ?? 50) >= 45 ? '#f59e0b' : '#ef4444';
      const _msqStr = _fp.microstructureQuality != null ? `　<span style="color:${_msqClr};font-size:0.68rem">微結構${_fp.microstructureQuality}分</span>` : '';
      return `<div style="display:flex;align-items:flex-start;gap:8px"><span style="color:var(--text3);min-width:70px">📈 足跡圖</span><div style="font-size:0.72rem;line-height:1.8"><span style="color:${_dc}">${_dt}</span>${_dw}&nbsp;&nbsp;POC $${_fmtFP(_fp.poc)}${_vwapStr}${_msqStr}${_fp.absorption ? '　<span style="color:#22c55e;font-size:0.68rem">🔵 吸籌</span>' : ''}</div></div>`;
    } catch(_fpe) { return ''; } })()}
    ${(() => { try {
      const _mRows = [];
      const _ts = isLong ? _turtleSoup?.bull : _turtleSoup?.bear;
      if (_ts) _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:#22c55e;font-size:0.69rem;min-width:52px">✅ 觸發</span><span style="font-size:0.71rem;color:var(--text1)">🐢 烏龜湯　${_ts.label.replace(/🐢 /,'')}</span></div>`);
      else _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:var(--text3);font-size:0.69rem;min-width:52px">── 未觸</span><span style="font-size:0.71rem;color:var(--text3)">🐢 烏龜湯</span></div>`);
      if (_coreModel?.detected) {
        const _cc = _coreModel.isComplete ? '#22c55e' : '#f59e0b';
        _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:${_cc};font-size:0.69rem;min-width:52px">${_coreModel.isComplete ? '✅ 完成' : '⚡ 進行'}</span><span style="font-size:0.71rem;color:var(--text1)">📐 2022核心　<span style="color:${_cc}">${_coreModel.stageLabel}</span></span></div>`);
      } else _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:var(--text3);font-size:0.69rem;min-width:52px">── 未觸</span><span style="font-size:0.71rem;color:var(--text3)">📐 2022核心模型</span></div>`);
      if (_unicornModel?.detected) {
        const _uc = _unicornModel.priceInGoldenZone ? '#22c55e' : '#a78bfa';
        _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:${_uc};font-size:0.69rem;min-width:52px">${_unicornModel.priceInGoldenZone ? '✅ 黃金區' : '⚡ 偵測'}</span><span style="font-size:0.71rem;color:var(--text1)">🦄 獨角獸　<span style="color:${_uc}">$${fmtPrice(_unicornModel.overlapLow)}–$${fmtPrice(_unicornModel.overlapHigh)}</span></span></div>`);
      } else _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:var(--text3);font-size:0.69rem;min-width:52px">── 未觸</span><span style="font-size:0.71rem;color:var(--text3)">🦄 獨角獸模型</span></div>`);
      if (_silverBullet?.detected) {
        const _sc = _silverBullet.priceAtFVG ? '#22c55e' : '#f59e0b';
        _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:${_sc};font-size:0.69rem;min-width:52px">${_silverBullet.priceAtFVG ? '✅ 進場' : '⚡ 窗口'}</span><span style="font-size:0.71rem;color:var(--text1)">${_silverBullet.window.emoji} 銀彈　<span style="color:${_sc}">${_silverBullet.window.name}</span></span></div>`);
      } else _mRows.push(`<div style="display:flex;gap:8px;margin-bottom:3px"><span style="color:var(--text3);font-size:0.69rem;min-width:52px">── 非窗口</span><span style="font-size:0.71rem;color:var(--text3)">🗽 銀彈模型</span></div>`);
      return `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)"><div style="font-size:0.7rem;color:#a78bfa;font-weight:600;margin-bottom:5px">🎯 ICT 五大模型偵測</div>${_mRows.join('')}</div>`;
    } catch(_me) { return ''; } })()}
    ${_ictBonus > 0 ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06);color:#22c55e;font-size:0.72rem">✨ ICT/SMC 信心加成 <strong>+${_ictBonus}%</strong></div>` : ''}
  </div>`;
    } catch(_ie) { return ''; } })();
    const _cpH = (() => { try {
      const _rows = _chartPat.patterns.length
        ? _chartPat.patterns.map(p => {
            const clr = p.aligned === true ? '#22c55e' : p.aligned === false ? '#ef4444' : '#f59e0b';
            const tag = p.aligned === true ? '✅ 同向' : p.aligned === false ? '❌ 逆向' : '⚠️ 中性';
            const st  = p.status === 'forming'
              ? `<span style="font-size:0.66rem;color:#f59e0b;margin-left:3px">🔄 形成中</span>`
              : `<span style="font-size:0.66rem;color:#22c55e;margin-left:3px">✅ 已確認</span>`;
            return `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:4px"><span style="color:${clr};font-size:0.7rem;white-space:nowrap;min-width:44px">${tag}</span><div style="font-size:0.72rem;line-height:1.5"><span style="color:var(--text1)">${p.emoji} ${p.name}</span>${st}<span style="color:var(--text3);font-size:0.68rem">　${p.desc}</span></div></div>`;
          }).join('')
        : `<div style="font-size:0.72rem;color:var(--text3)">目前 4H 圖表無明顯技術形態，待形成中訊號</div>`;
      const _bw = (!_breakoutCheck?.confirmed && _breakoutCheck?.warn)
        ? `<div style="margin-top:6px;padding:5px 8px;background:rgba(239,68,68,.08);border-left:2px solid #ef4444;border-radius:4px;font-size:0.7rem;color:#ef4444">⚡ 突破確認不足：${_breakoutCheck.warn}</div>` : '';
      return `<div style="background:rgba(16,24,39,.7);border:1px solid rgba(251,191,36,.2);border-radius:10px;padding:10px 14px;margin-bottom:8px;font-size:0.77rem">
    <div style="font-weight:700;color:#fbbf24;margin-bottom:7px;font-size:0.8rem">📐 技術圖形識別（4H）</div>
    ${_rows}${_bw}
    ${_chartPat.score > 0 ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06);color:#22c55e;font-size:0.72rem">✨ 圖形評分加成 <strong>+${Math.min(2,_chartPat.score)} 分</strong></div>` : ''}
  </div>`;
    } catch(_ce) { return ''; } })();
    return _ictH + _cpH;
  } catch(_ae) { return ''; } })();

  const _ictCacheData = { killZone: _kz, orderBlock: _ictOB, fvg: _ictFVG, premiumDiscount: _ictPD,
    orderBlock4h: _ictOB4h, fvg4h: _ictFVG4h, ictBonus: _ictBonus, breakoutCheck: _breakoutCheck };

  // ── 快進快出信號（1m K棒，勝率≥80%才顯示）──
  const _scalpHtml = (() => { try {
    const _ss = _fpBTS?.scalpSignal;
    if (!_ss || _ss.conf < 80) return '';
    // 15m 方向確認加成
    let _ssConf = _ss.conf;
    const _m15sig = mtfData['15m']?.signal;
    const _ssIsLong = _ss.direction === 'bull';
    if (_m15sig) {
      if ((_ssIsLong && _m15sig.signal === 'bull') || (!_ssIsLong && _m15sig.signal === 'bear'))
        _ssConf = Math.min(93, _ssConf + 3);
      else if ((_ssIsLong && _m15sig.signal === 'bear') || (!_ssIsLong && _m15sig.signal === 'bull'))
        _ssConf = Math.max(75, _ssConf - 5);
    }
    if (_ssConf < 80) return '';
    const _ssDir  = _ssIsLong ? '⬆️ 做多' : '⬇️ 做空';
    const _ssDirC = _ssIsLong ? '#22c55e' : '#ef4444';
    const _ssConfC = _ssConf >= 88 ? '#22c55e' : _ssConf >= 83 ? '#f59e0b' : '#94a3b8';
    const _fp = v => fmtPrice(v);
    const _ssReasonsHtml = (_ss.reasons || []).map(r => `<div style="font-size:0.69rem;color:var(--text2);padding:2px 0">${r}</div>`).join('');
    return `<div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.3);border-radius:10px;padding:11px 14px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:0.85rem">⚡</span>
      <span style="font-weight:700;color:#fbbf24;font-size:0.82rem">快進快出機會（1m 高勝率形態）</span>
      <span style="background:rgba(251,191,36,.18);color:#fbbf24;border-radius:12px;padding:1px 8px;font-size:0.69rem;font-weight:700">${_ssConf}% 勝率</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
      <span style="color:${_ssDirC};font-weight:700;font-size:0.82rem">${_ssDir}</span>
      <span style="color:var(--text2);font-size:0.76rem">${_ss.label}</span>
      <span style="color:${_ssConfC};font-size:0.72rem;font-weight:600">信心 ${_ssConf}%</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px">
      <div style="background:rgba(255,255,255,.04);border-radius:6px;padding:5px 8px;text-align:center">
        <div style="font-size:0.63rem;color:var(--text3)">進場</div>
        <div style="font-size:0.78rem;font-weight:700;color:var(--text1)">$${_fp(_ss.entryPrice)}</div>
      </div>
      <div style="background:rgba(34,197,94,.08);border-radius:6px;padding:5px 8px;text-align:center">
        <div style="font-size:0.63rem;color:var(--text3)">目標</div>
        <div style="font-size:0.78rem;font-weight:700;color:#22c55e">$${_fp(_ss.target)} <span style="font-size:0.63rem">(+${_ss.rewardPct}%)</span></div>
      </div>
      <div style="background:rgba(239,68,68,.08);border-radius:6px;padding:5px 8px;text-align:center">
        <div style="font-size:0.63rem;color:var(--text3)">止損</div>
        <div style="font-size:0.78rem;font-weight:700;color:#ef4444">$${_fp(_ss.stop)} <span style="font-size:0.63rem">(-${_ss.riskPct}%)</span></div>
      </div>
    </div>
    <div style="font-size:0.69rem;color:#f59e0b;margin-bottom:4px;font-weight:600">R/R ${_ss.rr}:1 | 觸發依據</div>
    ${_ssReasonsHtml}
    <div style="margin-top:6px;font-size:0.67rem;color:var(--text3)">⚠️ 快進快出單：建議市價進場，嚴守止損，目標達到即離場；此為短線機會非主波段信號</div>
  </div>`;
  } catch(_sse) { return ''; } })();

  // R/R < 1.3 硬性封鎖（優先於 SQ 等級，無論訊號強度均不進場）
  if (parseFloat(rr1str) < 1.3 && direction !== 'wait') {
    _tradeSetupCache[coin.symbol] = { direction: 'wait', sqGrade: _sqGrade, sqScore: _sqScore, chartPat: _chartPat, ..._ictCacheData };
    return `${_scalpHtml}<div class="setup-wait">
      <div class="setup-wait-icon">🚫</div>
      <div class="setup-wait-title">盈虧比不足（R/R <strong style="color:#ef4444">${parseFloat(rr1str).toFixed(1)}:1</strong>），硬性封鎖進場</div>
      <div style="font-size:0.72rem;color:var(--text3);margin:4px 0 8px">最低要求 R/R ≥ 1.3:1，當前 ${parseFloat(rr1str).toFixed(1)}:1 不達標，無論訊號品質如何均不進場</div>
      <ul class="setup-wait-reasons">${_sqFactors.map(f => `<li>${f}</li>`).join('')}</ul>
    </div>`;
  }

  // Grade B/C/D：訊號品質不足 → 觀望，不顯示交易建議，不推送 Telegram
  if (!['SSS','SS','S','A'].includes(_sqGrade)) {
    _tradeSetupCache[coin.symbol] = { direction: 'wait', sqGrade: _sqGrade, sqScore: _sqScore, chartPat: _chartPat, ..._ictCacheData };
    return `${_scalpHtml}<div class="setup-wait">
      <div class="setup-wait-icon">🤖</div>
      <div class="setup-wait-title">AI 訊號過濾：品質不足（<strong style="color:${_sqGradeColor}">${_sqGrade} 級 — ${_sqGradeLabel}</strong>），建議觀望</div>
      <div style="font-size:0.72rem;color:var(--text3);margin:4px 0 8px">全數據多因子評分 ${_sqScore} 分，需達 A 級（≥ 10 分）才進場</div>
      <ul class="setup-wait-reasons">${_sqFactors.map(f => `<li>${f}</li>`).join('')}</ul>
    </div>`;
  }

  // 風控分不足（< 60 分）→ 觀望，不顯示交易建議
  if (conf < 60) {
    _tradeSetupCache[coin.symbol] = { direction: 'wait', sqGrade: _sqGrade, sqScore: _sqScore, chartPat: _chartPat, ..._ictCacheData };
    return `${_scalpHtml}<div class="setup-wait">
      <div class="setup-wait-icon">🛡️</div>
      <div class="setup-wait-title">風控分不足（<strong style="color:#ef4444">${conf} 分</strong>），低於門檻 60 分，建議觀望</div>
      <div style="font-size:0.72rem;color:var(--text3);margin:4px 0 8px">止損歷史風控扣分後信心不足，需達 60 分以上才顯示交易建議</div>
      <ul class="setup-wait-reasons">${_sqFactors.map(f => `<li>${f}</li>`).join('')}</ul>
    </div>`;
  }

  // 長線單門檻：必須達 S 級（≥ 17 分），否則降格為短線單
  if (canScaleIn && !['SSS','SS','S'].includes(_sqGrade)) {
    const _wasLT = _tradeSetupCache[coin.symbol]?.canScaleIn === true;
    canScaleIn = false; ltTP = null; ltTag = '';
    tp1 = _stTp1; tp2 = _stTp2; tp1Reason = _stTp1R; tp2Reason = _stTp2R;
    if (!isRangeMode && isDayAligned) dirLabel = isLong ? '短線做多' : '短線做空';
    else dirLabel = isLong ? '做多' : '做空';
    _sqFactors.push(`⚠️ 長線單訊號品質 ${_sqGrade}（${_sqScore}分）未達 S 級（15分），已降格為短線單`);
    // 若之前是長線單 → 更新 tlog + 發送降格通知
    if (_wasLT) try {
      const _tlogDG = loadTradeLog();
      const _tDGIdx = _tlogDG.findIndex(t => t.symbol === coin.symbol && t.status === 'pending' && t.canScaleIn === true);
      if (_tDGIdx >= 0) { _tlogDG[_tDGIdx].canScaleIn = false; _tlogDG[_tDGIdx].ltTP = null; saveTradeLog(_tlogDG); }
      const _sDG = loadSettings();
      if (_sDG.notifTelegram && _sDG.tgToken && _sDG.tgChatId) {
        const _dgSetup = {
          entry, sl, tp1, tp2, conf, canScaleIn: false,
          sqGrade: _sqGrade, sqScore: _sqScore, sqGradeLabel: _sqGradeLabel,
          riskScore: _risk.score, riskLevel: _risk.level, riskRecs: _risk.recs,
          weeklyBias: weeklyBiasData?.biasLabel, weeklyConf: weeklyBiasData?.conf,
          todayBias: todayBiasData?.biasLabel, todayConf: todayBiasData?.conf,
          macroOpposePenalty, techPenalty, chipsPenalty,
        };
        sendTelegramMessage(_sDG.tgToken, _sDG.tgChatId,
          buildTelegramText(coin, direction, _dgSetup, _macroCache,
            window.location.origin + window.location.pathname,
            { headerOverride: '⬇️ <b>加密掃描 Pro — 降級短線單信號</b>' }
          )
        );
      }
    } catch(_ltDgE) {}
  }

  // 緩存完整設置供 Telegram 通知 + AI 分析使用
  _tradeSetupCache[coin.symbol] = {
    direction,
    entry, sl, tp1, tp2,
    chartPat: _chartPat,
    entryReason: entryReasons.join('，'),
    entryReasons: [...entryReasons],   // 陣列原始版，避免逗號分割錯誤
    slReason, tp1Reason, tp2Reason,
    rr1: rr1str, rr2: rr2str, atr, conf,
    longTermBias: ltBias, canScaleIn, ltConf,
    maxScaleIns: canScaleIn ? _aiScaleCount : undefined,
    aiScaleReason: canScaleIn ? _aiScaleReason : undefined,
    scaleInTargets: canScaleIn && scaleInLevels.length ? scaleInLevels.map(s => s.level) : [],
    scaleInNewSLs: canScaleIn && scaleInLevels.length ? scaleInLevels.map(s => s.newSL) : [],
    // 三層決策資料（供 Telegram 顯示 AI 邏輯摘要）
    rawConf, macroConf, finalConf,
    bigTrend, bigTrendBlocked, h4TrendLabel, d1TrendLabel,
    learnPenalty, hardAdxPenalty, macroOpposePenalty, aiTrendPenalty, techPenalty, chipsPenalty,
    macroReasons: macroReasons || [],
    aiTrendReasons, flipRisks,
    weeklyBias: weeklyBiasData.biasLabel, weeklyConf: weeklyBiasData.conf,
    weeklyRangeMode: weeklyBiasData.rangeMode,
    todayBias:  todayBiasData.biasLabel,  todayConf:  todayBiasData.conf,
    todayRangeMode: todayBiasData.rangeMode,
    tradeType: isRangeMode ? 'range' : 'directional',
    // AI 風控資料（供 generateAIAnalysis 整合進分析文字）
    hardBlocked,
    blockReasons: blockReasons || [],
    learnWarnings: learnWarnings || [],
    defenseChecks: learnResult?.defenseChecks || [],
    // AI 風險評估（供 generateAIAnalysis 整合進操作建議）
    riskScore: _risk.score, riskLevel: _risk.level, riskFactors: _risk.factors, riskRecs: _risk.recs,
    // ICT/SMC/SNR 分析資料
    killZone: _kz, orderBlock: _ictOB, fvg: _ictFVG, premiumDiscount: _ictPD,
    orderBlock4h: _ictOB4h, fvg4h: _ictFVG4h, ictBonus: _ictBonus,
    breakoutCheck: _breakoutCheck,
    // AI 訊號品質等級（供 Telegram 顯示）
    sqGrade: _sqGrade, sqScore: _sqScore, sqGradeLabel: _sqGradeLabel, sqFactors: _sqFactors,
    // 長線部分止盈位（3R）
    ltPartialTP: ltPartialTP || null,
    ltTP: (canScaleIn && ltTP) ? ltTP : null,
    ltTPReason: (canScaleIn && ltTPReason) ? ltTPReason : null,
    // 極端頂/底反轉辨識（供 Telegram 顯示反轉可能性）
    extremeRev: _extremeRev,
  };

  // 更新或新增交易記錄（查看詳情時用 S/R 精確版本更新已自動記錄的估算值）
  const tlog = loadTradeLog();
  const existIdx = tlog.findIndex(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending') && t.direction === direction);

  // ── 宏觀大方向封鎖（與 recordSignalsFromScan blockLong/blockShort 完全一致）──
  // 只有 bear/strong_bear 才封鎖多單；slight_bear 用扣分處理，不直接封鎖
  let macroBlockedForRecord = false;
  if (_macroCache) {
    try {
      const _mDir = computeMacroNetDir(_macroCache.fg, _macroCache);
      if (direction === 'long')  macroBlockedForRecord = _mDir === 'strong_bear';
      if (direction === 'short') macroBlockedForRecord = _mDir === 'strong_bull';
    } catch(e) {}
  }
  // 封鎖原因追蹤（供模板顯示說明橫幅）
  let _recordBlockedByActive = false;   // 已有開倉中的交易
  let _recordBlockedByCooldown = false; // 相同方向在冷卻期內

  // 低勝率評估（函數域宣告，供 else 建倉判斷 & _hwrBannerHtml 共用）
  const _isLowWinRate =
    !['SSS','SS','S','A'].includes(_sqGrade)                                            // 訊號品質 B/C/D
    || hardBlocked                                                            // AI 學習硬性攔截
    || bigTrendBlocked                                                        // 大時框逆勢
    || (weeklyOpposed && todayOpposed)                                        // 本週+今日 AI 均逆向
    || macroReasons.filter(r => !r.includes('頂級交易員')).length >= 3       // 宏觀逆風強
    || adxVal < 18                                                            // ADX 嚴重偏低
    || learnPenalty >= 10;                                                    // AI 學習強烈警告

  if (existIdx >= 0) {
    const ex = tlog[existIdx];
    // 若 entry 缺失（舊版資料）或尚未精煉，或 tp1 為空（舊版 bug），強制更新完整欄位
    // 但已進場（entryTime 已設定）的持倉絕對不覆蓋進場/止損/止盈
    if ((!ex.refined || !ex.entry || !ex.tp1) && !ex.entryTime) {
      ex.entry = entry; ex.sl = sl; ex.tp1 = tp1; ex.tp2 = tp2;
      ex.entryReason = entryReasons.join('，'); ex.entryReasons = [...entryReasons];
      ex.slReason = slReason; ex.tp1Reason = tp1Reason; ex.tp2Reason = tp2Reason;
      ex.conf = conf; ex.rawConf = rawConf;
      Object.assign(ex, tradeCtx);
      ex.refined = true;
    }
    ex.conf = conf; ex.rawConf = rawConf;
    ex.hardAdxPenalty = hardAdxPenalty; ex.learnPenalty = learnPenalty;
    ex.macroPenalty = macroOpposePenalty; ex.aiTrendPenalty = aiTrendPenalty;
    ex.techPenalty = techPenalty; ex.chipsPenalty = chipsPenalty;
    ex.sqGrade = _sqGrade; ex.sqScore = _sqScore; ex.sqGradeLabel = _sqGradeLabel; ex.sqFactors = _sqFactors;
    ex.dirPenalty = 0; ex.bbPenalty = 0; // PATH B 不獨立計算這兩項，歸零確保持倉與幣種詳情信心分一致
    ex.longTermBias = ltBias;
    if (!ex.entryTime) ex.canScaleIn = canScaleIn; // only update for pending (not yet entered) trades
    ex.is4hDayAligned = isDayAligned;
    if (!ex.scaleIns) ex.scaleIns = [];
    if (ex.peakPrice == null) ex.peakPrice = null;
    // 補齊長線加倉計劃（若之前未儲存）
    if (canScaleIn && scaleInLevels.length && !ex.scaleInTargets?.length) {
      ex.scaleInTargets = scaleInLevels.map(s => s.level);
      ex.scaleInNewSLs  = scaleInLevels.map(s => s.newSL);
      ex.maxScaleIns    = _aiScaleCount;
      ex.aiScaleReason  = _aiScaleReason;
      ex.ltTP = ltTP || null;
      ex.ltTPReason = ltTPReason || null;
    }
    saveTradeLog(tlog);
    // 若既有掛單從未推送 Telegram（建立時推送失敗），補發一次
    if (!ex.telegramSent && !ex.pendingNotify) {
      try {
        const _ns = loadSettings();
        if (_ns.notifTelegram && _ns.tgToken && _ns.tgChatId) {
          const _exTgSetup = Object.assign({}, ex, _tradeSetupCache[coin.symbol] || {}, {
            sqGrade: _sqGrade, sqScore: _sqScore, sqGradeLabel: _sqGradeLabel,
          });
          sendTelegramMessage(_ns.tgToken, _ns.tgChatId,
            buildTelegramText(coin, direction, _exTgSetup, _macroCache,
              window.location.origin + window.location.pathname));
          const _btsTlog = loadTradeLog();
          const _btsExIdx = _btsTlog.findIndex(t => t.id === ex.id);
          if (_btsExIdx >= 0) { _btsTlog[_btsExIdx].telegramSent = true; saveTradeLog(_btsTlog); }
        }
      } catch(_btsExTgE) {}
    }
    // 同步更新持倉頁面（若目前在持倉頁）確保等級與信心分與詳情一致
    try { if (typeof renderPositionsPage === 'function') renderPositionsPage(); } catch(_rpe) {}
  } else {
    // ── 反方向未入場掛單自動取消（方向改變時更新方向）──
    // 例：之前是空單 pending，現在訊號改為多方 → 自動取消舊空單，建立新多單
    const oppIdx = tlog.findIndex(t =>
      t.symbol === coin.symbol && t.status === 'pending' && t.direction !== direction && !t.entryTime
    );
    if (oppIdx >= 0) {
      const oppDir = tlog[oppIdx].direction;
      const _oppReason = `技術訊號方向由${oppDir === 'long' ? '多' : '空'}轉${direction === 'long' ? '多' : '空'}，幣種詳情頁自動更新掛單方向`;
      addCancelCooldown(tlog[oppIdx], _oppReason);
      tlog.splice(oppIdx, 1);
    }

    // hasAnyActive：反方向掛單已於上方取消；只有「已入場（open）」的交易才真正封鎖
    // 相同方向 pending 已由 existIdx 處理，這裡不會再出現
    const hasAnyActive = tlog.some(t => t.symbol === coin.symbol && t.status === 'open');

    // 若同幣種+方向在冷卻期內有取消記錄（含飛越止盈取消），不重複建立掛單
    const recentlyCancelled = loadCancelCooldowns().some(c =>
      c.symbol === coin.symbol &&
      c.direction === direction &&
      (Date.now() - (c.cancelTime || 0)) < SIGNAL_COOLDOWN
    );

    // 幣種詳情頁：訊號已通過 SQ≥A 和 R/R≥1.3 兩道硬性門檻（上方 return 確保）
    // 只要幣種詳情顯示有效訊號（direction ≠ wait），就應納入持倉，確保 UI 與持倉一致
    // 唯一保留：hasAnyActive（已有進場中倉位不重開）、recentlyCancelled（冷卻期）
    let _canAutoRecord = false;
    if (direction !== 'wait' && !hasAnyActive && !recentlyCancelled) {
      if (canScaleIn) {
        // 長線單：風控分≥60 + R/R≥1.3 + 週向不逆勢 + SQ≥S（長線要求更高）
        _canAutoRecord = conf >= 60
          && parseFloat(rr1str) >= 1.3
          && !weeklyOpposed
          && ['SSS','SS','S'].includes(_sqGrade);
      } else {
        // 短線單 / 震盪單：SQ≥A（≥10分）且風控分≥60 方可自動建倉
        _canAutoRecord = conf >= 60 && ['SSS','SS','S','A'].includes(_sqGrade);
      }
    }
    if (_canAutoRecord) {
      tlog.unshift({
        id: `${coin.symbol}-${Date.now()}`,
        symbol: coin.symbol, direction,
        timestamp: Date.now(),
        entryPrice: price, entry, sl, tp1, tp2,
        rsi: parseFloat(coin.rsi) || 50,
        adx: parseFloat(coin.adx) || 20,
        score: coin.score, trend: coin.trend, conf, rawConf,
        hardAdxPenalty, learnPenalty, macroPenalty: macroOpposePenalty, aiTrendPenalty, techPenalty, chipsPenalty,
        entryReason: entryReasons.join('，'), entryReasons: [...entryReasons],
        slReason, tp1Reason, tp2Reason,
        status: 'pending', outcome: null, tp1Hit: false,
        entryTime: null,
        exitPrice: null, exitTime: null, pnlR: null, analysis: null,
        refined: true,
        longTermBias: ltBias, canScaleIn, ltConf, is4hDayAligned: isDayAligned,
        scaleInTargets: canScaleIn && scaleInLevels.length ? scaleInLevels.map(s => s.level) : [],
        scaleInNewSLs:  canScaleIn && scaleInLevels.length ? scaleInLevels.map(s => s.newSL) : [],
        maxScaleIns:    canScaleIn ? _aiScaleCount : undefined,
        aiScaleReason:  canScaleIn ? _aiScaleReason : undefined,
        ltTP: (canScaleIn && ltTP) ? ltTP : null,
        ltTPReason: (canScaleIn && ltTPReason) ? ltTPReason : null,
        ltPartialTP: ltPartialTP || null,
        scaleIns: [], peakPrice: null,
        sqGrade: _sqGrade, sqScore: _sqScore, sqGradeLabel: _sqGradeLabel, sqFactors: _sqFactors,
        dirPenalty: 0, bbPenalty: 0,
        lowWinRate: _isLowWinRate || undefined,
        ...tradeCtx,
      });
      if (tlog.length > 500) tlog.splice(500);
      saveTradeLog(tlog);
      // ── Telegram 通知（查看幣種詳情頁時新建掛單）──
      try {
        const _ns = loadSettings();
        if (_ns.notifTelegram && _ns.tgToken && _ns.tgChatId) {
          // 合併 trade 物件（含 sqGrade/conf 等）和 cache（含 risk/ICT 等）
          const _btsSetup = Object.assign({}, tlog[0] || {}, _tradeSetupCache[coin.symbol] || {}, {
            sqGrade: _sqGrade, sqScore: _sqScore, sqGradeLabel: _sqGradeLabel, sqFactors: _sqFactors,
          });
          sendTelegramMessage(_ns.tgToken, _ns.tgChatId,
            buildTelegramText(coin, direction, _btsSetup, _macroCache,
              typeof window !== 'undefined' ? window.location.origin + window.location.pathname : ''));
          // 標記此掛單已成功推送 Telegram，避免 checkAndSendAlerts 誤判為未通知
          const _btsIdx = tlog.findIndex(t => t.symbol === coin.symbol && t.status === 'pending' && t.direction === direction);
          if (_btsIdx >= 0) { tlog[_btsIdx].telegramSent = true; saveTradeLog(tlog); }
        }
      } catch(_bte) { console.warn('[buildTradeSetup tg]', _bte); }
    } else {
      // 即使未建立新掛單，反方向取消仍需儲存
      if (oppIdx >= 0) saveTradeLog(tlog);
      // 記錄封鎖原因供模板顯示
      if (hasAnyActive)      _recordBlockedByActive = true;
      if (recentlyCancelled) _recordBlockedByCooldown = true;
    }
  }

  // ── 信心不足 / AI 風控攔截 → 僅顯示扣分原因，不顯示任何交易推薦 ──
  if (direction === 'wait') {
    const cColor = v => v >= 80 ? '#22c55e' : v >= 60 ? '#f59e0b' : '#ef4444';
    // 只列出有實際扣分的原因，攔截時列封鎖理由
    const deductLines = [];
    if (hardBlocked) {
      blockReasons.slice(0, 3).forEach(r => deductLines.push(r));
    } else {
      // 逐項列出有實際扣分的風控原因
      const _failedPenalty = _sqDefChecks.filter(c => !c.pass && (c.penalty || 0) > 0);
      if (_failedPenalty.length > 0) {
        _failedPenalty.forEach(c => {
          const _icon = c.type === 'slRate' ? '📉' : c.type === 'rule' ? '⚡' : '🔒';
          deductLines.push(`${_icon} ${c.label} — 扣 ${c.penalty} 分`);
        });
      } else if (learnPenalty > 0) {
        deductLines.push(`AI 止損風控扣 ${_cLearnDrag} 分`);
      }
      deductLines.push(`風控分 ${conf} 分，低於入場門檻 60 分（其餘逆風見 SQ 因子）`);
    }
    const _wClrW = weeklyOpposed ? 'var(--bear)' : weeklyNeutral ? '#f59e0b' : 'var(--bull)';
    const _tClrW = todayOpposed  ? 'var(--bear)' : todayNeutral  ? '#f59e0b' : 'var(--bull)';
    return `<div class="setup-wait">
      <div class="setup-wait-icon">${hardBlocked ? '🚫' : '⚠️'}</div>
      <div class="setup-wait-title">${hardBlocked ? '本次不進場（AI 風控封鎖）' : '本次不推薦交易'}</div>
      ${deductLines.length ? `<ul class="setup-wait-reasons">${deductLines.map(r => `<li>${r}</li>`).join('')}</ul>` : ''}
      <div style="margin-top:10px;padding:10px 12px;background:rgba(129,140,248,.05);border:1px solid rgba(129,140,248,.15);border-radius:9px">
        <div style="font-size:0.73rem;font-weight:600;color:var(--text2);margin-bottom:7px">🤖 AI 趨勢預測（本週 · 今日）</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <span style="font-size:0.73rem;padding:3px 10px;border-radius:16px;border:1px solid ${_wClrW}40;color:${_wClrW}">📈 本週 ${weeklyBiasData?.biasLabel || '—'}（${weeklyBiasData?.conf || 50}%）</span>
          <span style="font-size:0.73rem;padding:3px 10px;border-radius:16px;border:1px solid ${_tClrW}40;color:${_tClrW}">📅 今日 ${todayBiasData?.biasLabel || '—'}（${todayBiasData?.conf || 50}%）</span>
        </div>
      </div>
      ${_erHtml()}
      ${_sqPanelHtml}
    </div>`;
  }


  // 極端反轉點分析面板
  const _erPanelHtml = _erHtml();

  // ── 宏觀經濟摘要 ──
  const fgVal  = fearGreed ? parseInt(fearGreed.value) : null;
  const fgZh   = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fearGreed?.value_classification] || '';
  const mktChg = globalMkt?.marketCapChange || 0;
  const btcDom = globalMkt?.btcDominance   || 0;
  const fgColor = fgVal != null ? (fgVal < 35 ? 'var(--bear)' : fgVal > 65 ? 'var(--bull)' : 'var(--text2)') : '';
  const macroFavor = (() => { try {
    if (!fearGreed && !globalMkt) return null;
    let bull = 0, bear = 0;
    if (fgVal != null) { if (fgVal < 35) bull++; else if (fgVal > 65) bear++; }
    if (mktChg > 2) bull++; else if (mktChg < -2) bear++;
    if (btcDom > 58) bear++; else if (btcDom < 44) bull++;
    if (bull > bear) return `宏觀偏多，${isLong ? '順勢' : '逆勢'}`;
    if (bear > bull) return `宏觀偏空，${isLong ? '逆勢需謹慎' : '順勢'}`;
    return '宏觀中性';
  } catch(e) { return null; } })();

  // ── AI 學習摘要 ──
  const profile = getLearnProfile();
  const aiReady = profile.ready && profile.closed >= 3;

  // ── 布林通道狀態摘要 ──
  const bbStatus1h  = bb1h_  || null;
  const bbStatus15m = bb15m_ || null;
  const bbChipsHtml = (() => { try {
    const chips = [];
    if (bbStatus1h) {
      const pctB  = bbStatus1h.pctB;
      const tags1h = bbStatus1h.tags || [];
      const pos   = pctB <= 0.1 ? '下軌觸及 ↑' : pctB <= 0.25 ? '近下軌' : pctB >= 0.9 ? '上軌觸及 ↓' : pctB >= 0.75 ? '近上軌' : '中軌區';
      const clr   = pctB <= 0.25 ? 'var(--bull)' : pctB >= 0.75 ? 'var(--bear)' : 'var(--text2)';
      const extra = tags1h.includes('BB多頭走軌') ? ' · 走軌▲' : tags1h.includes('BB空頭走軌') ? ' · 走軌▼'
                  : tags1h.includes('BB收窄蓄力') ? ' · 收窄' : '';
      const div1  = tags1h.includes('BB頂背離') ? ' ⚠️頂背離' : tags1h.includes('BB底背離') ? ' ⚠️底背離' : '';
      chips.push(`<span class="setup-macro-chip" style="color:${clr}">📊 BB(1h) ${pos}${extra}${div1}</span>`);
    }
    if (bbStatus15m) {
      const pctB   = bbStatus15m.pctB;
      const tags15 = bbStatus15m.tags || [];
      const pos    = pctB <= 0.1 ? '下軌' : pctB <= 0.25 ? '近下' : pctB >= 0.9 ? '上軌' : pctB >= 0.75 ? '近上' : '中軌';
      const clr    = pctB <= 0.25 ? 'var(--bull)' : pctB >= 0.75 ? 'var(--bear)' : 'var(--text3)';
      const extra2 = tags15.includes('BB多頭走軌') ? ' · 走軌▲' : tags15.includes('BB空頭走軌') ? ' · 走軌▼'
                   : tags15.includes('BB收窄蓄力') ? ' · 收窄' : '';
      chips.push(`<span class="setup-macro-chip" style="color:${clr}">📊 BB(15m) ${pos}${extra2}</span>`);
    }
    return chips.length ? `<div class="setup-macro-chips" style="margin-top:6px">${chips.join('')}</div>` : '';
  } catch(e) { return ''; } })();

  // ── 高勝率評估（整合頂級交易員視角、AI 判斷、信心分、結構因子）──
  const _hwrBannerHtml = (() => { try {
    const _hwrW = [];   // { level:'danger'|'caution', text, source }
    const _hwrP = [];   // pass items

    // ① 訊號品質
    if (_sqGrade === 'SSS')     _hwrP.push('訊號品質 SSS 級（神級）');
    else if (_sqGrade === 'SS') _hwrP.push('訊號品質 SS 級（完美）');
    else if (_sqGrade === 'S')  _hwrP.push('訊號品質 S 級（頂級）');
    else if (_sqGrade === 'A')  _hwrP.push('訊號品質 A 級（優質）');
    else if (_sqGrade === 'B') _hwrW.push({ level:'caution', text:`訊號品質 B 級（良好但非頂級，21因子評分 ${_sqScore} 分）`, source:'AI 訊號品質' });
    else                       _hwrW.push({ level:'danger',  text:`訊號品質 ${_sqGrade} 級（21因子評分 ${_sqScore} 分），勝率基礎偏弱`, source:'AI 訊號品質' });

    // ② 風控分
    if (conf >= 80)      _hwrP.push(`風控分 ${conf} 分（高）`);
    else if (conf >= 60) _hwrW.push({ level:'caution', text:`風控分 ${conf} 分（達門檻，部分風控提示）`, source:'風控分' });
    else                 _hwrW.push({ level:'danger',  text:`風控分 ${conf} 分（低於門檻 60 分）`, source:'風控分' });

    // ③ AI 學習攔截
    if (hardBlocked) _hwrW.push({ level:'danger', text:`AI 學習風控攔截（${blockReasons[0] || '歷史止損模式觸發'}）`, source:'AI 學習' });
    else _hwrP.push('AI 學習風控通過');

    // ④ 大時框趨勢
    if (bigTrendBlocked) _hwrW.push({ level:'danger', text:`大時框逆勢（${bigTrendBlockReason || '4H/日線反向'}），頂級交易員不逆勢`, source:'大時框趨勢' });
    else if (isAligned)  _hwrP.push('4H + 日線大時框方向一致');
    else if (bigTrend === 'mixed') _hwrW.push({ level:'caution', text:'4H / 日線趨勢分歧（mixed），大方向不明確', source:'大時框趨勢' });

    // ⑤ AI 多週期方向
    if (weeklyOpposed && todayOpposed) _hwrW.push({ level:'danger',  text:'本週 + 今日 AI 趨勢均逆向，市場慣性不利，頂級交易員避免逆勢', source:'AI 趨勢判斷' });
    else if (weeklyOpposed)            _hwrW.push({ level:'caution', text:'本週 AI 方向逆向，注意大週期阻力', source:'AI 趨勢判斷' });
    else if (todayOpposed)             _hwrW.push({ level:'caution', text:'今日 AI 方向逆向，短線動能存疑', source:'AI 趨勢判斷' });
    else _hwrP.push('AI 多週期趨勢方向確認');

    // ⑥ 足跡圖訂單流
    const _hwrFP = _footprintCache[coin.symbol];
    if (_hwrFP) {
      if (_hwrFP.deltaDiv) _hwrW.push({ level:'caution', text:'足跡圖 Delta 背離（價量方向不一致），動能衰竭風險高', source:'足跡訂單流' });
      else if (_hwrFP.deltaDir === (isLong ? 'bull' : 'bear')) _hwrP.push(`足跡訂單流同向（${isLong ? '主動買盤' : '主動賣盤'}主導）`);
      else if (_hwrFP.deltaDir && _hwrFP.deltaDir !== 'neutral') _hwrW.push({ level:'caution', text:`足跡訂單流逆向（${_hwrFP.deltaDir === 'bull' ? '買盤' : '賣盤'}主導但方向相反）`, source:'足跡訂單流' });
    }

    // ⑦ 爆倉牆
    const _hwrLiq = _liquidationCache[coin.symbol];
    if (_hwrLiq) {
      const _pNow = parseFloat(coin.price) || 1;
      const _hwrWallAgainst = isLong
        ? (_hwrLiq.longLiqs  || []).find(l => l.price < _pNow && l.price >= _pNow * 0.90 && l.strength > 0)
        : (_hwrLiq.shortLiqs || []).find(l => l.price > _pNow && l.price <= _pNow * 1.10 && l.strength > 0);
      const _hwrWallFor = isLong
        ? (_hwrLiq.shortLiqs || []).find(l => l.price > _pNow && l.price <= _pNow * 1.15 && l.strength > 0)
        : (_hwrLiq.longLiqs  || []).find(l => l.price < _pNow && l.price >= _pNow * 0.85 && l.strength > 0);
      if (_hwrWallAgainst) _hwrW.push({ level:'caution', text:`${isLong ? '多單爆倉牆' : '空單爆倉牆'}在進場點附近（$${fmtPrice(_hwrWallAgainst.price)}），可能成為反彈阻礙`, source:'爆倉地圖' });
      if (_hwrWallFor)     _hwrP.push(`${isLong ? '空單爆倉牆' : '多單爆倉牆'}（$${fmtPrice(_hwrWallFor.price)}）在前方，擠壓行情有利`);
    }

    // ⑧ 宏觀逆風
    const _hwrMacro = macroReasons.filter(r => !r.includes('頂級交易員'));
    if (_hwrMacro.length >= 3)      _hwrW.push({ level:'danger',  text:`宏觀逆風強（${_hwrMacro.length} 項）：${_hwrMacro.slice(0,2).map(r=>r.replace(/，扣.*/,'')).join('；')}`, source:'宏觀分析' });
    else if (_hwrMacro.length >= 2) _hwrW.push({ level:'caution', text:`宏觀逆風中等（${_hwrMacro.length} 項扣分）`, source:'宏觀分析' });
    else if (_hwrMacro.length === 0) _hwrP.push('宏觀環境無明顯逆風');

    // ⑨ ADX 趨勢強度
    if (adxVal >= 28) _hwrP.push(`ADX ${adxVal}（趨勢明確）`);
    else if (adxVal < 22) _hwrW.push({ level:'caution', text:`ADX ${adxVal} 偏低（< 22），趨勢強度不足`, source:'技術面' });

    // 判斷總體勝率等級
    const _hwrDanger  = _hwrW.filter(w => w.level === 'danger').length;
    const _hwrCaution = _hwrW.filter(w => w.level === 'caution').length;
    const _hwrIsHigh = _hwrDanger === 0 && _hwrCaution <= 1 && (_sqGrade === 'S' || _sqGrade === 'A') && conf >= 60;
    // 低勝率用已計算的 _isLowWinRate（與 tlog 封鎖邏輯完全一致）
    if (_isLowWinRate) {
      const _waitSrc = [...new Set(_hwrW.map(w => w.source))].join('、');
      return `<div style="background:rgba(245,158,11,.07);border:1.5px solid rgba(245,158,11,.35);border-radius:10px;padding:10px 14px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:1rem">⚠️</span>
          <span style="font-weight:700;color:#f59e0b;font-size:0.86rem">低勝率風險訊號 — 已加入持倉，建議小倉位保守操作</span>
          <span style="font-size:0.7rem;background:rgba(245,158,11,.15);color:#f59e0b;padding:1px 8px;border-radius:20px;border:1px solid rgba(245,158,11,.3)">⚠️ 低勝率標記</span>
        </div>
        <div style="font-size:0.73rem;color:var(--text3);margin-bottom:5px">風險來源：${_waitSrc || '多重逆風因子'}</div>
        <div style="display:flex;flex-direction:column;gap:3px">
          ${_hwrW.filter(w=>w.level==='danger').map(w =>
            `<div style="font-size:0.77rem;color:#ef4444;line-height:1.5">🚫 ${w.text}<span style="font-size:0.67rem;color:var(--text3);margin-left:4px">（${w.source}）</span></div>`).join('')}
          ${_hwrW.filter(w=>w.level==='caution').map(w =>
            `<div style="font-size:0.77rem;color:#f59e0b;line-height:1.5">⚠️ ${w.text}<span style="font-size:0.67rem;color:var(--text3);margin-left:4px">（${w.source}）</span></div>`).join('')}
        </div>
      </div>`;
    }

    if (_hwrIsHigh) {
      return `<div style="background:rgba(34,197,94,.08);border:1.5px solid rgba(34,197,94,.35);border-radius:10px;padding:10px 14px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:1rem">🏆</span>
          <span style="font-weight:700;color:#22c55e;font-size:0.86rem">高勝率訊號 — 符合頂級交易員進場條件</span>
          <span style="font-size:0.7rem;background:rgba(34,197,94,.15);color:#22c55e;padding:1px 8px;border-radius:20px;border:1px solid rgba(34,197,94,.3)">AI 綜合評估</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${_hwrP.map(p => `<span style="font-size:0.72rem;color:#22c55e;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);padding:2px 8px;border-radius:20px">✅ ${p}</span>`).join('')}
          ${_hwrCaution > 0 ? _hwrW.map(w => `<span style="font-size:0.72rem;color:#f59e0b;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);padding:2px 8px;border-radius:20px">⚠️ ${w.text}</span>`).join('') : ''}
        </div>
      </div>`;
    } else {
      return `<div style="background:rgba(245,158,11,.07);border:1.5px solid rgba(245,158,11,.35);border-radius:10px;padding:10px 14px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:1rem">⚠️</span>
          <span style="font-weight:700;color:#f59e0b;font-size:0.86rem">中等勝率 — 有條件可進場，建議保守操作</span>
          <span style="font-size:0.7rem;background:rgba(245,158,11,.15);color:#f59e0b;padding:1px 8px;border-radius:20px;border:1px solid rgba(245,158,11,.3)">AI 綜合評估</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px">
          ${_hwrW.map(w =>
            `<div style="font-size:0.79rem;color:${w.level==='danger'?'#ef4444':'#f59e0b'};line-height:1.5">${w.level==='danger'?'🚫':'⚠️'} ${w.text}<span style="font-size:0.68rem;color:var(--text3);margin-left:5px">（${w.source}）</span></div>`).join('')}
        </div>
        ${_hwrP.length ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">${_hwrP.map(p=>`<span style="font-size:0.7rem;color:#22c55e;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.18);padding:1px 7px;border-radius:20px">✅ ${p}</span>`).join('')}</div>` : ''}
      </div>`;
    }
  } catch(_hwrE) { return ''; } })();

  return `${_hwrBannerHtml}<div class="setup-verdict ${isLong ? 'verdict-long' : 'verdict-short'}">
    <div class="verdict-dir">
      <span class="verdict-arrow">${dirIcon}</span>
      <span class="verdict-label">${dirLabel}</span>
      ${ltTag}${rangeTagHtml}
      <span style="font-size:0.7rem;font-weight:700;background:${_sqGradeColor}22;border:1px solid ${_sqGradeColor}55;color:${_sqGradeColor};padding:1px 7px;border-radius:20px;margin-left:6px" title="${_sqFactors.join(' | ')}">AI ${_sqGrade} ${_sqGradeLabel}</span>
      <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">${isRangeMode ? '震盪高低點快進快出' : '15m ~ 1h 時間框架'}</span>
    </div>
    ${conf >= 50 ? `<div class="verdict-conf-wrap">
      <span style="font-size:0.78rem;color:var(--text3)">風控分</span>
      <div class="conf-bar"><div class="conf-fill" style="width:${conf}%;background:${dirColor}"></div></div>
      <span style="color:${dirColor};font-weight:700;font-size:0.9rem">${conf} 分</span>${conf < 60 ? '<span style="font-size:0.7rem;color:#f59e0b;margin-left:4px">低於門檻</span>' : ''}
    </div>` : ''}
    ${bbChipsHtml}
  </div>

  ${(() => { try {
    // ── 大時間框架趨勢確認面板 ──
    const h4Clr = h4?.signal?.includes('bull') ? 'var(--bull)' : h4?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)';
    const d1Clr = d1sig_?.signal?.includes('bull') ? 'var(--bull)' : d1sig_?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)';
    const h4RsiTxt = h4?.rsi != null ? ` RSI ${h4.rsi}` : '';
    const d1RsiTxt = d1sig_?.rsi != null ? ` RSI ${d1sig_.rsi}` : '';
    // 三態判斷：全通過 / 中性謹慎 / 嚴格攔截
    const isAligned = (isLong && bigTrend === 'bull') || (!isLong && bigTrend === 'bear');
    const alignColor = bigTrendBlocked ? 'var(--bear)' : bigTrend === 'mixed' ? '#f59e0b' : isAligned ? 'var(--bull)' : 'var(--text3)';
    const alignIcon  = bigTrendBlocked ? '🚫' : bigTrend === 'mixed' ? '⚠️' : isAligned ? '✅' : '—';
    const alignText  = bigTrendBlocked ? '4H+日線雙確認逆勢，嚴格攔截'
                     : bigTrend === 'mixed' ? '趨勢中性/分歧，謹慎操作'
                     : isAligned ? '4H+日線雙確認同向，全部通過'
                     : '大趨勢與方向不明確';
    return `<div style="background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.18);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px">📐 大時間框架趨勢確認</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:0.75rem;padding:3px 10px;border-radius:20px;background:rgba(255,255,255,.05);color:${h4Clr};border:1px solid ${h4Clr}40">4H ${h4TrendLabel}${h4RsiTxt}</span>
        <span style="font-size:0.75rem;padding:3px 10px;border-radius:20px;background:rgba(255,255,255,.05);color:${d1Clr};border:1px solid ${d1Clr}40">日線 ${d1TrendLabel}${d1RsiTxt}</span>
        <span style="font-size:0.75rem;font-weight:600;color:${alignColor};margin-left:4px">${alignIcon} ${alignText}</span>
      </div>
      ${bigTrendBlocked ? `<div style="margin-top:8px;font-size:0.73rem;color:var(--bear);line-height:1.5">🚫 ${bigTrendBlockReason}，嚴格執行不進場</div>` : ''}
    </div>`;
  } catch(e) { return ''; } })()}

  ${_sqPanelHtml}

  ${_ictAnalysisHtml}

  ${_scalpHtml}

  <div class="setup-macro-row">
    <div class="setup-macro-title">🌐 宏觀信號同步分析</div>
    ${(fearGreed || globalMkt) ? `<div class="setup-macro-chips">
      ${fgVal != null ? `<span class="setup-macro-chip" style="color:${fgColor}">🌡 恐貪 ${fgVal}（${fgZh}）</span>` : ''}
      ${mktChg ? `<span class="setup-macro-chip" style="color:${mktChg > 0 ? 'var(--bull)' : 'var(--bear)'}">📈 市值 ${mktChg > 0 ? '+' : ''}${mktChg.toFixed(1)}%</span>` : ''}
      ${btcDom ? `<span class="setup-macro-chip" style="color:${btcDom > 58 ? 'var(--bear)' : btcDom < 44 ? 'var(--bull)' : 'var(--text2)'}">₿ BTC主導 ${btcDom.toFixed(1)}%</span>` : ''}
      ${macroFavor ? `<span class="setup-macro-chip setup-macro-verdict">${macroFavor}</span>` : ''}
    </div>` : ''}
    ${(() => { try {
      // AI 財經新聞重點（今日頭條）
      const insights = aiGenerateMarketInsights();
      const topNews  = insights[0];
      const newsHtml = topNews
        ? `<div class="setup-macro-news"><span class="setup-macro-news-icon">📰</span><span class="setup-macro-news-txt">${topNews.zhTitle}</span><span class="setup-macro-news-tag">${topNews.source}</span></div>`
        : '';
      // 即將公布重要數據事件（今日或本週，未來 48 小時內）
      const todayEvs = getWeeklyEconEvents().filter(ev => {
        const mins = (ev.eventTime.getTime() - Date.now()) / 60000;
        return mins > -120 && mins < 2880; // 2小時前至48小時後
      }).slice(0, 3);
      const evHtml = todayEvs.map(ev => {
        const mins = (ev.eventTime.getTime() - Date.now()) / 60000;
        const timeLabel = mins < 0 ? `已公布` : mins < 60 ? `${Math.round(mins)}分鐘後` : `${Math.round(mins/60)}小時後`;
        const impactColor = ev.impact === 'high' ? 'var(--bear)' : '#f0a500';
        const tradeSide = isLong ? ev.bullIf : ev.bearIf;
        return `<div class="setup-macro-ev">
          <span class="setup-macro-ev-name">${ev.name}</span>
          <span class="setup-macro-ev-time" style="color:${impactColor}">${timeLabel}</span>
          ${tradeSide ? `<div class="setup-macro-ev-impact">${isLong ? '📈' : '📉'} ${tradeSide}</div>` : ''}
        </div>`;
      }).join('');
      // 宏觀預測摘要
      const predHtml = `<div class="setup-macro-pred">🤖 預測：${isLong ? 'BTC ETF 持續淨流入（信心78%），美聯儲維持利率（信心82%），全球流動性擴張有利多頭' : '美聯儲維持鷹派（信心65%），通脹未完全降溫，CPI > 2.7% 時空頭受益'}</div>`;
      // 宏觀風險警告（若有觸發懲罰）
      const macroWarnHtml = macroReasons.length
        ? `<div class="setup-macro-warns">${macroReasons.map(r => `<div class="setup-macro-warn-item">⚠️ ${r}</div>`).join('')}</div>`
        : '';
      return newsHtml + (evHtml ? `<div class="setup-macro-events">${evHtml}</div>` : '') + predHtml + macroWarnHtml;
    } catch(e) { return ''; } })()}
  </div>

  <!-- 本週 / 今日 AI 方向對照 + 數據翻轉風險 -->
  <div style="background:rgba(129,140,248,.05);border:1px solid rgba(129,140,248,.18);border-radius:10px;padding:11px 14px;margin-bottom:10px">
    <div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px">🤖 AI 趨勢對照（本週 · 今日）</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      ${(() => { try {
        const wClr  = weeklyOpposed ? 'var(--bear)' : weeklyNeutral ? '#f59e0b' : 'var(--bull)';
        const wIcon = weeklyOpposed ? '↔' : weeklyNeutral ? '—' : '✓';
        const tClr  = todayOpposed  ? 'var(--bear)' : todayNeutral  ? '#f59e0b' : 'var(--bull)';
        const tIcon = todayOpposed  ? '↔' : todayNeutral  ? '—' : '✓';
        return `
          <span style="font-size:0.74rem;padding:3px 10px;border-radius:16px;border:1px solid ${wClr}40;color:${wClr}">
            📈 本週 ${weeklyBiasData.biasLabel || '—'}（${weeklyBiasData.conf || 50}%）${wIcon}
          </span>
          <span style="font-size:0.74rem;padding:3px 10px;border-radius:16px;border:1px solid ${tClr}40;color:${tClr}">
            📅 今日 ${todayBiasData.biasLabel || '—'}（${todayBiasData.conf || 50}%）${tIcon}
          </span>`;
      } catch(e) { return ''; } })()}
    </div>
    ${aiTrendReasons.length ? `
      <div style="font-size:0.73rem;color:var(--text2);line-height:1.7">
        ${aiTrendReasons.map(r => {
          const isBad = r.includes('逆向') || r.includes('逆風');
          return `<div style="color:${isBad ? 'var(--bear)' : 'var(--text3)'}">${isBad ? '⚠️' : '✓'} ${r}</div>`;
        }).join('')}
      </div>` : ''}
    ${flipRisks.length ? `
      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.06);padding-top:8px">
        <div style="font-size:0.73rem;font-weight:600;color:#f59e0b;margin-bottom:5px">⚡ 數據公布風險 — 可能令方向轉折</div>
        ${flipRisks.map(f => `
          <div style="font-size:0.72rem;background:rgba(245,158,11,.06);border-left:2px solid #f59e0b;padding:5px 9px;border-radius:0 6px 6px 0;margin-bottom:5px;line-height:1.6">
            <span style="color:#f59e0b;font-weight:600">🕐 ${f.timeLabel}</span>
            <span style="color:var(--text1);margin-left:6px">${f.name}</span>
            ${f.aiPred ? `<div style="color:var(--text3);margin-top:2px">AI 預測：${f.aiPred}（信心 ${f.aiConf}%）</div>` : ''}
            <div style="color:var(--bear);margin-top:2px">⚠️ ${f.riskDesc}</div>
          </div>`).join('')}
      </div>` : ''}
  </div>


  ${macroBlockedForRecord ? `<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:9px;padding:9px 14px;margin-bottom:10px;font-size:0.78rem;color:#f59e0b">⚠️ 宏觀大方向${isLong ? '極端偏空' : '極端偏多'}，風控分已扣分反映，訊號已記入持倉供參考</div>` : ''}
  ${_recordBlockedByCooldown ? (() => { const cancelledT = loadCancelCooldowns().find(c => c.symbol === coin.symbol && c.direction === direction && (Date.now() - (c.cancelTime||0)) < SIGNAL_COOLDOWN); const minsAgo = cancelledT ? Math.round((Date.now() - (cancelledT.cancelTime||0)) / 60000) : 0; const minsLeft = cancelledT ? Math.max(0, Math.round((SIGNAL_COOLDOWN - (Date.now() - (cancelledT.cancelTime||0))) / 60000)) : 0; return `<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:9px;padding:9px 14px;margin-bottom:10px;font-size:0.78rem;color:#f59e0b">⏱ 此幣種 ${direction === 'long' ? '多' : '空'}單 ${minsAgo} 分鐘前被取消（冷卻期還有約 ${minsLeft} 分鐘），<strong>未計入掛單記錄</strong>；冷卻結束後掃描將自動重新評估</div>`; })() : ''}
  ${_recordBlockedByActive ? `<div style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.25);border-radius:9px;padding:9px 14px;margin-bottom:10px;font-size:0.78rem;color:#818cf8">📌 此幣種已有持倉進行中，<strong>未計入掛單記錄</strong>（不重複開倉）</div>` : ''}

  ${(() => {
    const _ltFinalR = (risk > 0 && ltTP) ? (Math.abs(ltTP - entry) / risk).toFixed(1) : null;
    const _tp1R = (risk > 0 && tp1) ? (Math.abs(tp1 - entry) / risk).toFixed(1) : null;
    const _tp2R = (risk > 0 && tp2) ? (Math.abs(tp2 - entry) / risk).toFixed(1) : null;
    return canScaleIn && ltTP ? `
  <!-- ═══ 長線單：進場 + 加倉（AI決定次數）+ 最終止盈 ═══ -->
  <div style="font-size:0.73rem;color:#a78bfa;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:7px;padding:7px 11px;margin-bottom:8px">
    🤖 AI 加倉判斷：${_aiScaleReason}
  </div>
  <div class="setup-levels">
    <div class="level-row level-entry">
      <div class="level-tag">📍 進場</div>
      <div class="level-desc">${entryReasons.join('　')}${_ltFinalR ? `　<span style="font-size:0.72rem;color:#4ade80;font-weight:600">預期最終 ${_ltFinalR}R</span>` : ''}</div>
      <div class="level-price-val">${fmtPrice(_px(entry))}</div>
    </div>
    ${scaleInLevels.map((si, i) => {
      const movePct = ((Math.abs(si.level - entry) / price) * 100).toFixed(1);
      const siRR    = ((Math.abs(si.level - entry) / risk)).toFixed(1);
      return `<div class="level-row level-tp1" style="border-left:3px solid rgba(99,102,241,.5)">
        <div class="level-tag">📈 加倉${i + 1}</div>
        <div class="level-desc">+${movePct}%，趨勢持續確認加碼${si.snapped ? '（貼近結構位）' : ''}，R/R ${siRR}:1　<span style="color:var(--bear);font-size:0.72rem">加倉後止損移至 ${fmtPrice(_px(si.newSL))}</span></div>
        <div class="level-price-val" style="color:#a78bfa">${fmtPrice(_px(si.level))}</div>
      </div>`;
    }).join('')}
    <div class="level-row level-tp2" style="border-left:3px solid rgba(34,197,94,.6)">
      <div class="level-tag">🏁 最終止盈</div>
      <div class="level-desc">${ltTPReason}${_ltFinalR ? `　<span style="color:#22c55e;font-weight:700;font-size:0.78rem">最終 ${_ltFinalR}R</span>` : ''}</div>
      <div class="level-price-val" style="color:var(--bull)">${fmtPrice(_px(ltTP))}</div>
    </div>
    ${ltPartialTP ? `<div class="level-row" style="border-left:3px solid rgba(251,191,36,.6)">
      <div class="level-tag">🎯 部分止盈（3R）</div>
      <div class="level-desc">建議在此位置減少50%倉位</div>
      <div class="level-price-val" style="color:#fbbf24">${fmtPrice(_px(ltPartialTP))}</div>
    </div>` : ''}
    <div class="level-row level-sl">
      <div class="level-tag">🛑 初始止損</div>
      <div class="level-desc">${slReason}</div>
      <div class="level-price-val">${fmtPrice(_px(sl))}</div>
    </div>
  </div>
  <div class="setup-rules">
    <div class="rules-title">🏆 長線加倉操作守則</div>
    <div class="rule-item">✦ 初始倉位 <strong>2~3%</strong>，每次加倉追加 <strong>1~2%</strong>，${_aiScaleCount}次加倉合計上限 <strong>${_aiScaleCount <= 1 ? '4~5' : _aiScaleCount === 2 ? '6~7' : '8~9'}%</strong></div>
    <div class="rule-item">✦ 進場後立即設止損（<strong style="color:var(--bear)">${fmtPrice(_px(sl))}</strong>）；每次加倉確認後止損往前調至各加倉行顯示的位置（鎖住 30% 增量利潤，不讓大幅回吐）</div>
    <div class="rule-item">✦ 最後一次加倉後止損接近保本位，確保整體持倉不虧損</div>
    ${ltPartialTP ? `<div class="rule-item">✦ 🎯 部分止盈（3R）：<strong style="color:#fbbf24">${fmtPrice(_px(ltPartialTP))}</strong> — 建議在此位置減少50%倉位，其餘持倉至最終止盈</div>` : ''}
    <div class="rule-item">✦ 全倉持有至最終止盈（<strong style="color:${dirColor}">${fmtPrice(_px(ltTP))}</strong>），中途不提前止盈</div>
    ${deriv ? `<div class="rule-item">✦ 資金費率 <strong style="color:${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? (Math.abs(deriv.fundingRate) > 0.003 ? (deriv.fundingRate < 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text3)') : 'var(--text3)'}">${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? ((deriv.fundingRate*100).toFixed(4)+'%') : '--'}</strong>　Taker 買賣比 <strong style="color:${deriv.takerBuySell > 1.05 ? 'var(--bull)' : deriv.takerBuySell < 0.95 ? 'var(--bear)' : 'var(--text3)'}">${deriv.takerBuySell?.toFixed(2)}</strong></div>` : ''}
  </div>
  ` : `
  <!-- ═══ 短線單：TP1 / TP2 ═══ -->
  <div class="setup-levels">
    <div class="level-row level-entry">
      <div class="level-tag">📍 進場</div>
      <div class="level-desc">${entryReasons.join('　')}${_tp2R ? `　<span style="font-size:0.72rem;color:#4ade80;font-weight:600">預期最終 ${_tp2R}R</span>` : ''}</div>
      <div class="level-price-val">${fmtPrice(_px(entry))}</div>
    </div>
    <div class="level-row level-tp1">
      <div class="level-tag">🎯 止盈1</div>
      <div class="level-desc">${tp1Reason}${_tp1R ? `　<span style="color:#f59e0b;font-size:0.75rem">${_tp1R}R</span>` : ''}</div>
      <div class="level-price-val">${fmtPrice(_px(tp1))}</div>
    </div>
    <div class="level-row level-tp2">
      <div class="level-tag">🚀 止盈2</div>
      <div class="level-desc">${tp2Reason}${_tp2R ? `　<span style="color:#22c55e;font-weight:700;font-size:0.78rem">最終 ${_tp2R}R</span>` : ''}</div>
      <div class="level-price-val">${fmtPrice(_px(tp2))}</div>
    </div>
    <div class="level-row level-sl">
      <div class="level-tag">🛑 止損</div>
      <div class="level-desc">${slReason}</div>
      <div class="level-price-val">${fmtPrice(_px(sl))}</div>
    </div>
  </div>
  <div class="setup-rules">
    <div class="rules-title">⚡ 短線操作守則</div>
    <div class="rule-item">✦ 單筆倉位最多佔資金 <strong>3~5%</strong>，虧損不超過資金的 <strong>0.5~1%</strong></div>
    <div class="rule-item">✦ 進場後立即掛好止損單，不根據情緒調整止損</div>
    <div class="rule-item">✦ 到達止盈1（<strong style="color:${dirColor}">${fmtPrice(_px(tp1))}</strong>）即出 60%，剩餘移至成本</div>
    <div class="rule-item">✦ 若 15m K棒轉向且成交量放大，不等止損主動離場</div>
    ${deriv ? `<div class="rule-item">✦ 資金費率 <strong style="color:${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? (Math.abs(deriv.fundingRate) > 0.003 ? (deriv.fundingRate < 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text3)') : 'var(--text3)'}">${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? ((deriv.fundingRate*100).toFixed(4)+'%') : '--'}</strong>　Taker 買賣比 <strong style="color:${deriv.takerBuySell > 1.05 ? 'var(--bull)' : deriv.takerBuySell < 0.95 ? 'var(--bear)' : 'var(--text3)'}">${deriv.takerBuySell?.toFixed(2)}</strong></div>` : ''}
  </div>
  `; })()}

  <!-- ═══ AI 風險評估 ═══ -->
  <div class="setup-risk-card" style="margin:10px 0;padding:14px 16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-left:3px solid ${_risk.levelColor};border-radius:10px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:0.78rem;font-weight:600;color:var(--text2);letter-spacing:.5px">🛡️ AI 風險評估</span>
      <span style="font-size:0.68rem;color:var(--text3);margin-left:6px">（僅供參考，不影響進場訊號）</span>
      <span style="font-size:0.72rem;font-weight:700;color:${_risk.levelColor};background:${_risk.levelColor}22;padding:2px 8px;border-radius:20px">${_risk.level}</span>
    </div>
    <!-- 風險分數進度條 -->
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:0.68rem;color:var(--text3)">風險分數</span>
        <span style="font-size:0.72rem;font-weight:700;color:${_risk.levelColor}">${_risk.score} / 100</span>
      </div>
      <div style="height:5px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${_risk.score}%;background:${_risk.levelColor};border-radius:3px;transition:width .4s"></div>
      </div>
    </div>
    <!-- 風險因素 -->
    <div style="margin-bottom:8px">
      <div style="font-size:0.68rem;color:var(--text3);margin-bottom:4px">⚠️ 風險因素</div>
      ${_risk.factors.map(f => `<div style="font-size:0.72rem;color:var(--text2);padding:2px 0;line-height:1.5">• ${f}</div>`).join('')}
    </div>
    <!-- AI 建議 -->
    <div>
      <div style="font-size:0.68rem;color:var(--text3);margin-bottom:4px">💡 AI 建議</div>
      ${_risk.recs.map(r => `<div style="font-size:0.72rem;color:#a5f3fc;padding:2px 0;line-height:1.5">→ ${r}</div>`).join('')}
    </div>
  </div>

  ${(() => { try {
    // ── AI 交易決策三層邏輯面板 ──
    const { defenseChecks = [] } = learnResult || {};
    const failChecks  = defenseChecks.filter(c => !c.pass && c.type !== 'sugg_ref');
    const passChecks  = defenseChecks.filter(c =>  c.pass && c.type !== 'sugg_ref');
    const refChecks   = defenseChecks.filter(c => c.type === 'sugg_ref' && !c.pass);
    const typeLabel = { rule: '規則', rule_ref: '參考', sugg_ref: '改進建議', sugg_required: '必須條件', memory: '止損記憶', suggestion: '改進建議' };
    const typeColor = { rule: '#818cf8', rule_ref: '#64748b', sugg_ref: '#34d399', sugg_required: '#ef4444', memory: '#f59e0b', suggestion: '#34d399' };

    // 各層狀態顏色
    const l1Warn   = macroOpposePenalty > 0 || hardAdxPenalty > 0;
    const l1Color  = l1Warn ? '#f59e0b' : '#22c55e';
    const l1Icon   = l1Warn ? '⚠️' : '✅';
    const l2Status = bigTrendBlocked ? 'block' : bigTrend === 'mixed' ? 'warn' : 'pass';
    const l2Color  = l2Status === 'block' ? '#ef4444' : l2Status === 'warn' ? '#f59e0b' : '#22c55e';
    const l2Icon   = l2Status === 'block' ? '🚫' : l2Status === 'warn' ? '⚠️' : '✅';
    const l3RulePen = failChecks.filter(c => c.type === 'rule').reduce((s, c) => s + (c.penalty || 0), 0);
    const l3Status = hardBlocked ? 'block' : (l3RulePen > 0 || learnPenalty > 0) ? 'warn' : 'pass';
    const l3Color  = l3Status === 'block' ? '#ef4444' : l3Status === 'warn' ? '#f59e0b' : '#22c55e';
    const l3Icon   = l3Status === 'block' ? '🚫' : l3Status === 'warn' ? '⚠️' : '✅';

    // 信心分數顏色輔助
    const cColor = v => v >= 85 ? '#22c55e' : v >= 80 ? '#4ade80' : v >= 70 ? '#f59e0b' : '#ef4444';

    const statsHtml = aiReady
      ? `<span class="setup-ai-stats">勝率 <strong>${profile.winRate}%</strong>（${profile.wins}勝 / ${profile.losses}敗，共 ${profile.closed} 筆）</span>`
      : `<span class="setup-ai-stats" style="color:var(--text3)">歷史數據不足（< 3 筆）</span>`;

    return `<div class="setup-ai-panel">
      <div class="setup-ai-header">
        <span class="setup-ai-title">🤖 AI 交易決策三層邏輯</span>
        ${statsHtml}
      </div>

      <!-- 風控分流程條 -->
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:0.74rem;background:rgba(255,255,255,.03);border-radius:8px;padding:7px 10px;margin-bottom:10px">
        <span style="color:var(--text3);font-size:0.7rem">滿分</span>
        <span style="font-weight:700;color:#22c55e">100 分</span>
        ${learnPenalty > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">止損風控 -${Math.min(45, learnPenalty)}</span>` : ''}
        <span style="color:var(--text3)">→</span>
        <span style="color:var(--text3);font-size:0.7rem">風控分</span>
        <span style="font-weight:700;font-size:0.85rem;color:${l2Status === 'block' ? '#ef4444' : cColor(finalConf)}">${l2Status === 'block' ? '❌ 封鎖' : finalConf + ' 分'}</span>
      </div>

      <!-- 第①層：基本規則 + 宏觀分析（含週/日 AI 預測） -->
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:8px;margin-bottom:7px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(255,255,255,.04)">
          <span style="font-size:0.88rem">${l1Icon}</span>
          <span style="font-size:0.78rem;font-weight:600;color:var(--text1);flex:1">① 基本規則 + 宏觀 + AI 趨勢</span>
          <span style="font-size:0.72rem;color:${l1Color}">
            ${rawConf}% → <strong>${macroConf}%</strong>
            ${(hardAdxPenalty + macroOpposePenalty + aiTrendPenalty) > 0 ? `（-${hardAdxPenalty + macroOpposePenalty + aiTrendPenalty}%）` : ''}
          </span>
        </div>
        <div style="padding:7px 12px;font-size:0.73rem;line-height:1.6">
          ${hardAdxPenalty > 0
            ? `<div style="color:#f59e0b">⚡ ADX ${adxVal}${adxVal < 18 ? '（< 18，震盪過弱）' : '（< 22，趨勢偏弱）'}，技術信心 -${hardAdxPenalty}%</div>`
            : `<div style="color:#22c55e">✓ ADX ${adxVal} 趨勢強度正常，無扣分</div>`
          }
          ${macroReasons.length
            ? macroReasons.map(r => `<div style="color:#f59e0b;margin-top:2px">⚠️ ${r}</div>`).join('')
            : `<div style="color:#22c55e;margin-top:2px">✓ 宏觀環境無明顯逆風，無扣分</div>`
          }
          ${aiTrendReasons.map(r => {
            const isBad = r.includes('逆向') || r.includes('逆風');
            return `<div style="color:${isBad ? 'var(--bear)' : 'var(--text3)'};margin-top:2px">${isBad ? '⚠️' : '✓'} ${r}</div>`;
          }).join('')}
          ${flipRisks.length ? `
            <div style="margin-top:5px;padding:5px 8px;background:rgba(245,158,11,.06);border-radius:5px">
              ${flipRisks.map(f => `<div style="color:#f59e0b">⚡ ${f.timeLabel} ${f.name}：${f.riskDesc}</div>`).join('')}
            </div>` : ''}
        </div>
      </div>

      <!-- 第②層：大時間框架一致性 -->
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:8px;margin-bottom:7px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(255,255,255,.04)">
          <span style="font-size:0.88rem">${l2Icon}</span>
          <span style="font-size:0.78rem;font-weight:600;color:var(--text1);flex:1">② 大時間框架一致性</span>
          <span style="font-size:0.72rem;font-weight:600;color:${l2Color}">${
            l2Status === 'block' ? '4H+日線雙確認逆勢 🚫 嚴格攔截'
            : l2Status === 'warn' ? '趨勢中性 / 分歧 ⚠️ 謹慎操作'
            : '4H+日線雙確認同向 ✅ 全部通過'
          }</span>
        </div>
        <div style="padding:7px 12px;font-size:0.73rem;line-height:1.6">
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:4px">
            <span style="color:${h4?.signal?.includes('bull') ? 'var(--bull)' : h4?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)'}">
              4H ${h4TrendLabel}${h4?.rsi != null ? ` RSI ${h4.rsi}` : ''}
            </span>
            <span style="color:${d1sig_?.signal?.includes('bull') ? 'var(--bull)' : d1sig_?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)'}">
              日線 ${d1TrendLabel}${d1sig_?.rsi != null ? ` RSI ${d1sig_.rsi}` : ''}
            </span>
          </div>
          ${bigTrendBlocked
            ? `<div style="color:var(--bear)">🚫 ${bigTrendBlockReason}，嚴格執行不進場</div>`
            : bigTrend === 'mixed'
              ? `<div style="color:#f59e0b">⚠️ 4H / 日線方向未完全一致（單邊確認或分歧），可進場但建議降低倉位、謹慎操作</div>`
              : `<div style="color:#22c55e">✅ 4H 與日線雙雙確認${isLong ? '偏多' : '偏空'}，大小週期方向一致，建議交易</div>`
          }
        </div>
      </div>

      <!-- 第③層：AI 學習（止損歷史模式與改進建議參考） -->
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(255,255,255,.04)">
          <span style="font-size:0.88rem">${l3Icon}</span>
          <span style="font-size:0.78rem;font-weight:600;color:var(--text1);flex:1">③ AI 學習（止損模式與改進建議）</span>
          <span style="font-size:0.72rem;color:${l3Color}">${
            hardBlocked ? `❌ 硬性攔截（${blockReasons.length}項觸發）`
            : learnPenalty > 0 ? `AI風控扣分 -${learnPenalty}%`
            : refChecks.length > 0 ? `${refChecks.length} 項改進建議`
            : '✓ 無相關歷史模式'
          }</span>
        </div>
        <div style="padding:7px 12px;font-size:0.73rem;line-height:1.6">
          ${!aiReady
            ? `<div style="color:var(--text3)">歷史交易 < 3 筆，AI 學習模式暫不啟用，以人工判斷為主</div>`
            : ''
          }
          ${hardBlocked
            ? blockReasons.map(r => `<div style="color:var(--bear);margin-bottom:2px">🚫 ${r}</div>`).join('')
            : ''
          }
          ${(failChecks.length || passChecks.length || refChecks.length) ? `
            <div class="ai-defense-list" style="margin-top:${aiReady ? '0' : '4px'}">
              ${failChecks.map(c => `
                <div class="ai-defense-item ai-defense-fail">
                  <span class="ai-defense-type" style="color:${typeColor[c.type] || '#aaa'}">${typeLabel[c.type] || c.type}</span>
                  <span class="ai-defense-text">${c.label}</span>
                  <span class="ai-defense-meta">${c.count}次 / -${c.penalty}%</span>
                </div>`).join('')}
              ${passChecks.slice(0, 3).map(c => `
                <div class="ai-defense-item ai-defense-pass">
                  <span class="ai-defense-type" style="color:${typeColor[c.type] || '#aaa'}">${typeLabel[c.type] || c.type}</span>
                  <span class="ai-defense-text">${c.label}</span>
                  <span class="ai-defense-meta">${c.count}次 ✓</span>
                </div>`).join('')}
              ${refChecks.map(c => {
                const isSugg = c.type === 'sugg_ref';
                return `<div class="ai-defense-item" style="background:${isSugg ? 'rgba(52,211,153,.06)' : 'rgba(100,116,139,.08)'};border-color:${isSugg ? 'rgba(52,211,153,.2)' : 'rgba(100,116,139,.2)'}">
                  <span class="ai-defense-type" style="color:${isSugg ? '#34d399' : typeColor.rule_ref}">${isSugg ? '改進建議' : '歷史模式'}</span>
                  <span class="ai-defense-text" style="color:${isSugg ? 'var(--text1)' : 'var(--text2)'}">${c.label}</span>
                  <span class="ai-defense-meta" style="color:var(--text3)">${c.count}次 · 僅參考</span>
                </div>`;
              }).join('')}
            </div>`
            : (aiReady ? `<div style="color:#22c55e">✓ 無相關歷史止損模式，分析通過</div>` : '')
          }
          ${(aiReady && profile.bestConditions?.length) ? `
            <div class="setup-ai-bests" style="margin-top:6px">
              ${profile.bestConditions.map(c => `<div class="setup-ai-best-item">📈 ${c.label}：${c.value}</div>`).join('')}
            </div>` : ''}
        </div>
      </div>
    </div>`;
  } catch(e) { console.warn('[buildTradeSetup] AI panel render error:', e); return ''; } })()}
  ${_erPanelHtml}`;
}

/* ── 局勢重點（純本地指標合成，無外部 API）───────────────────── */
/* ── 儀表板市場大方向 ─────────────────────────────────────── */
/* ── 宏觀綜合方向（與大方向進度條完全一致）──────────────────
   返回 'bull' | 'slight_bull' | 'neutral' | 'slight_bear' | 'bear'
   用於 recordSignalsFromScan 及 updateOpenTrades 的封鎖判斷，
   確保持倉邏輯與 UI 顯示的大方向完全對齊。
   ─────────────────────────────────────────────────────────── */

// 資金流動事件偏向計算（供大方向、宏觀評分、交易建議共用）
// 返回 { bull, bear, events[] }  —— events 含 name/flow/isActive/daysUntil/conf/isAI/bull/bear
function getCapitalFlowBias() {
  const fg  = (typeof _macroCache !== 'undefined') ? _macroCache?.fg  : null;
  const mkt = (typeof _macroCache !== 'undefined') ? _macroCache : null;
  const now = Date.now(), MS_DAY = 86400000;
  let bull = 0, bear = 0;
  const events = [];
  for (const ev of CAPITAL_FLOW_EVENTS) {
    const startMs = new Date(ev.startDate + 'T00:00:00').getTime();
    const endMs   = new Date(ev.endDate   + 'T00:00:00').getTime() + MS_DAY - 1;
    const isActive  = now >= startMs && now <= endMs;
    const daysUntil = (startMs - now) / MS_DAY;
    if (!isActive && (daysUntil < 0 || daysUntil > 5)) continue;
    const pred   = computeCapitalFlowAIPred(ev, fg, mkt);
    const flow   = pred.flow;
    // 距離衰減：進行中 weight=1.0；5天後 weight=0.5，1天後 weight=0.9
    const weight = isActive ? 1.0 : Math.max(0.5, 1 - daysUntil * 0.1);
    let b = 0, be = 0;
    if      (flow === 'inflow')         { b  = 1.5 * weight; }
    else if (flow === 'slight_inflow')  { b  = 0.8 * weight; }
    else if (flow === 'outflow')        { be = 1.5 * weight; }
    else if (flow === 'slight_outflow') { be = 0.8 * weight; }
    bull += b; bear += be;
    events.push({ name: ev.name, type: ev.type, flow, isActive,
      daysUntil: Math.round(daysUntil), conf: pred.conf, isAI: pred.isAI, bull: b, bear: be });
  }
  return { bull, bear, events };
}

function computeMacroNetDir(fg, gm) {
  const fgVal   = fg ? parseInt(fg.value) : null;
  const chg     = gm?.marketCapChange || 0;
  const dom     = gm?.btcDominance   || 50;
  const ethDom  = gm?.ethDominance   || 0;
  const totalVol    = gm?.totalVolume    || 0;
  const totalMktCap = gm?.totalMarketCap || 0;
  let bull = 0, bear = 0, confidence = 0;

  // 恐慌貪婪（加強權重）
  if (fgVal !== null) {
    if (fgVal >= 70) { bull += 2; confidence += 1; }
    else if (fgVal >= 60) { bull++; confidence += 0.5; }
    else if (fgVal <= 30) { bear += 2; confidence += 1; }
    else if (fgVal <= 40) { bear++; confidence += 0.5; }
  }

  // 市值變化（加成交量換手確認）
  if (chg > 3) { bull += 2; confidence += 0.4; }
  else if (chg > 1) { bull++; }
  else if (chg < -3) { bear += 2; confidence += 0.4; }
  else if (chg < -1) { bear++; }

  // 成交量/市值換手率（市場活躍度）
  if (totalVol > 0 && totalMktCap > 0) {
    const _vt = totalVol / totalMktCap;
    if (_vt > 0.12) { bull += 0.5; confidence += 0.3; }
    else if (_vt < 0.04) { bear += 0.5; }
  }

  // BTC 主導（山寨季判斷）
  if (dom > 58) { bear++; }
  else if (dom < 42) { bull++; confidence += 0.5; }

  // ETH 主導（山寨輪動訊號）
  if (ethDom > 0 && dom < 52 && ethDom < 14) { bull += 0.5; confidence += 0.3; }

  // 本週 / 今日 AI 走勢
  const wb = computeWeeklyAIBias(fg, gm);
  const tb = computeTodayAIBias(fg, gm);
  const addBias = (bias, bullW, bearW, conf_boost) => {
    if      (bias === 'strong_bull') { bull += bullW; confidence += conf_boost; }
    else if (bias === 'bull')        { bull += (bullW * 0.6); confidence += (conf_boost * 0.4); }
    else if (bias === 'slight_bull') { bull += (bullW * 0.3); }
    else if (bias === 'strong_bear') { bear += bearW; confidence += conf_boost; }
    else if (bias === 'bear')        { bear += (bearW * 0.6); confidence += (conf_boost * 0.4); }
    else if (bias === 'slight_bear') { bear += (bearW * 0.3); }
  };
  addBias(wb.bias, 2, 2, 1);
  addBias(tb.bias, 2, 2, 0.8);

  // 資金流動事件
  try {
    const _cf = getCapitalFlowBias();
    bull += _cf.bull;
    bear += _cf.bear;
  } catch(_e) {}

  // 大盤走勢：幣種掃描聚合指標
  try {
    const coinData = (typeof state !== 'undefined' && state.data) ? state.data : [];
    if (coinData.length > 0) {
      // 巨鯨動向
      const whaleB = coinData.filter(c => c.whaleData?.bias === 'bull').length;
      const whaleR = coinData.filter(c => c.whaleData?.bias === 'bear').length;
      const whaleT = whaleB + whaleR;
      if (whaleT > 0) {
        const wp = whaleB / whaleT;
        if (wp > 0.65) { bull += 1; confidence += 0.5; }
        else if (wp < 0.35) { bear += 1; confidence += 0.5; }
      }
      // EMA200 上方比例（長線牛熊結構）
      const e200B = coinData.filter(c => { const p = parseFloat(c.price); const e = parseFloat(c.ema200); return p > 0 && e > 0 && p > e; }).length;
      const e200P = e200B / coinData.length;
      if (e200P >= 0.65) { bull += 1; confidence += 0.5; }
      else if (e200P <= 0.30) { bear += 1; confidence += 0.5; }
      else if (e200P >= 0.55) { bull += 0.3; }
      else if (e200P <= 0.40) { bear += 0.3; }
      // 聚合資金費率（正費率偏高 = 多頭過熱）
      const frList = coinData.filter(c => c.derivData?.fundingRate != null).map(c => c.derivData.fundingRate);
      if (frList.length >= 3) {
        const avgFr = frList.reduce((a, b) => a + b, 0) / frList.length;
        if (avgFr > 0.003) { bear += 0.8; }
        else if (avgFr > 0.001) { bull += 0.3; }
        else if (avgFr < -0.002) { bull += 1; confidence += 0.4; }
        else if (avgFr < 0) { bear += 0.2; }
      }
      // 聚合多空比
      const lsList = coinData.filter(c => c.derivData?.lsRatio != null).map(c => c.derivData.lsRatio);
      if (lsList.length >= 3) {
        const avgLs = lsList.reduce((a, b) => a + b, 0) / lsList.length;
        if (avgLs > 1.3) { bull += 0.5; confidence += 0.3; }
        else if (avgLs < 0.8) { bear += 0.5; confidence += 0.3; }
      }
      // BTC 龍頭 EMA200 位置
      const btcCoin = coinData.find(c => c.symbol === 'BTC/USDT');
      if (btcCoin) {
        const bp = parseFloat(btcCoin.price) || 0;
        const be200 = parseFloat(btcCoin.ema200) || 0;
        if (be200 > 0 && bp > be200 * 1.03) { bull += 0.5; confidence += 0.3; }
        else if (be200 > 0 && bp < be200 * 0.97) { bear += 0.5; }
      }
    }
  } catch(_we) {}

  // 多維度同向協同提升
  const syncBoost = confidence >= 3 ? 1 : (confidence >= 2 ? 0.5 : 0);
  const bullAdj = bull + syncBoost;
  const bearAdj = bear + syncBoost;

  if      (bullAdj > bearAdj + 4) return 'strong_bull';
  else if (bullAdj > bearAdj + 2) return 'bull';
  else if (bearAdj > bullAdj + 4) return 'strong_bear';
  else if (bearAdj > bullAdj + 2) return 'bear';
  else if (bullAdj > bearAdj + 0.5) return 'slight_bull';
  else if (bearAdj > bullAdj + 0.5) return 'slight_bear';
  return 'neutral';
}

function buildMarketOutlook(fg, global) {
  const fgVal   = fg ? parseInt(fg.value) : null;
  const fgZh    = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fg?.value_classification] || '';
  const chg     = global?.marketCapChange || 0;
  const dom     = global?.btcDominance   || 50;
  const ethDom  = global?.ethDominance   || 0;
  const totalVol    = global?.totalVolume    || 0;
  const totalMktCap = global?.totalMarketCap || 0;

  let bullPts = 0, bearPts = 0;
  const bullArgs = [], bearArgs = [];

  // 恐慌貪婪
  if (fgVal !== null) {
    if (fgVal >= 60)      { bullPts++; bullArgs.push(`恐慌貪婪 ${fgVal}（${fgZh}），市場情緒偏多`); }
    else if (fgVal <= 40) { bearPts++; bearArgs.push(`恐慌貪婪 ${fgVal}（${fgZh}），市場情緒偏空`); }
    else                  { bullArgs.push(`恐慌貪婪 ${fgVal}（中性），情緒平衡`); }
  }
  // 市值變化
  if (chg > 2)       { bullPts += 2; bullArgs.push(`加密總市值 24h +${chg.toFixed(2)}%，資金積極流入`); }
  else if (chg > 0)  { bullPts++;    bullArgs.push(`加密總市值 24h +${chg.toFixed(2)}%，小幅成長`); }
  else if (chg < -2) { bearPts += 2; bearArgs.push(`加密總市值 24h ${chg.toFixed(2)}%，資金明顯流出`); }
  else if (chg < 0)  { bearPts++;    bearArgs.push(`加密總市值 24h ${chg.toFixed(2)}%，輕微回調`); }
  // 成交量/市值換手率
  if (totalVol > 0 && totalMktCap > 0) {
    const _bmoVT = totalVol / totalMktCap;
    if (_bmoVT > 0.12)      { bullPts++; bullArgs.push(`成交量換手率 ${(_bmoVT*100).toFixed(1)}%（活躍），市場交投熱絡，動能充足`); }
    else if (_bmoVT > 0.07) { bullPts += 0.5; bullArgs.push(`成交量換手率 ${(_bmoVT*100).toFixed(1)}%（正常），市場活躍度健康`); }
    else if (_bmoVT < 0.04) { bearPts++; bearArgs.push(`成交量換手率 ${(_bmoVT*100).toFixed(1)}%（低迷），市場交投冷清，動能不足`); }
  }
  // BTC 主導
  if (dom > 56)      { bearPts++; bearArgs.push(`BTC 主導 ${dom.toFixed(1)}%（偏高），山寨資金分散難度大`); }
  else if (dom < 44) { bullPts++; bullArgs.push(`BTC 主導 ${dom.toFixed(1)}%（偏低），山寨季資金活躍`); }
  else               { bullArgs.push(`BTC 主導 ${dom.toFixed(1)}%（均衡），多空資金分布合理`); }
  // ETH 主導率（山寨輪動訊號）
  if (ethDom > 0) {
    if (dom < 52 && ethDom < 14) { bullPts++; bullArgs.push(`ETH 主導 ${ethDom.toFixed(1)}%（偏低），BTC+ETH 聚集度低，資金廣泛輪動至山寨幣`); }
    else if (ethDom > 20) { bearPts += 0.5; bearArgs.push(`ETH 主導 ${ethDom.toFixed(1)}%（偏高），資金集中頭部，山寨輪動有限`); }
    else { bullArgs.push(`ETH 主導 ${ethDom.toFixed(1)}%（均衡）`); }
  }
  // 大盤走勢：幣種掃描聚合指標
  const _bmoCoins = (typeof state !== 'undefined' && state.data) ? state.data : [];
  if (_bmoCoins.length > 0) {
    // BTC 龍頭 EMA200 位置（大盤方向最重要信號）
    const _btcCoin = _bmoCoins.find(c => c.symbol === 'BTC/USDT');
    if (_btcCoin) {
      const _bp = parseFloat(_btcCoin.price) || 0;
      const _be200 = parseFloat(_btcCoin.ema200) || 0;
      const _be50  = parseFloat(_btcCoin.ema50)  || 0;
      if (_be200 > 0 && _bp > _be200 * 1.05) {
        bullPts += 1.5; bullArgs.push(`BTC 在 EMA200 上方 ${((_bp/_be200-1)*100).toFixed(1)}%，龍頭長線多頭結構`);
      } else if (_be200 > 0 && _bp > _be200 * 1.00) {
        bullPts++;      bullArgs.push(`BTC 在 EMA200 上方，長線多頭趨勢維持`);
      } else if (_be200 > 0 && _bp < _be200 * 0.95) {
        bearPts += 1.5; bearArgs.push(`BTC 跌破 EMA200 ${((_be200/_bp-1)*100).toFixed(1)}%，龍頭長線熊市信號`);
      } else if (_be200 > 0 && _bp < _be200) {
        bearPts++;      bearArgs.push(`BTC 跌破 EMA200 長線壓力，結構偏弱`);
      }
      if (_be50 > 0 && _bp > _be50 * 1.02) { bullPts += 0.5; bullArgs.push(`BTC 在 EMA50 上方，中期動能向上`); }
      else if (_be50 > 0 && _bp < _be50 * 0.98) { bearPts += 0.5; bearArgs.push(`BTC 跌破 EMA50，中期動能轉弱`); }
    }
    // EMA200 上方比例（市場寬度，長線牛熊）
    const _e200Bull = _bmoCoins.filter(c => { const p = parseFloat(c.price); const e = parseFloat(c.ema200); return p > 0 && e > 0 && p > e; }).length;
    const _e200Pct  = Math.round(_e200Bull / _bmoCoins.length * 100);
    if (_e200Pct >= 65) { bullPts++; bullArgs.push(`${_e200Pct}% 幣種在 EMA200 上方，長線牛市結構廣泛確立`); }
    else if (_e200Pct >= 50) { bullPts += 0.5; bullArgs.push(`${_e200Pct}% 幣種在 EMA200 上方，長線結構偏多`); }
    else if (_e200Pct <= 30) { bearPts++; bearArgs.push(`${_e200Pct}% 幣種在 EMA200 上方，長線熊市結構主導`); }
    else if (_e200Pct <= 45) { bearPts += 0.5; bearArgs.push(`${_e200Pct}% 幣種在 EMA200 上方，長線結構偏弱`); }
    // EMA50 上方比例（市場寬度，中期趨勢）
    const _e50Bull = _bmoCoins.filter(c => { const p = parseFloat(c.price); const e = parseFloat(c.ema50); return p > 0 && e > 0 && p > e; }).length;
    const _e50Pct  = Math.round(_e50Bull / _bmoCoins.length * 100);
    if (_e50Pct >= 65) { bullPts += 0.5; bullArgs.push(`${_e50Pct}% 幣種在 EMA50 上方，中期趨勢整體偏多`); }
    else if (_e50Pct <= 35) { bearPts += 0.5; bearArgs.push(`${_e50Pct}% 幣種在 EMA50 上方，中期趨勢整體偏弱`); }
    // 聚合資金費率（衍生品市場情緒）
    const _frCoins = _bmoCoins.filter(c => c.derivData?.fundingRate != null);
    if (_frCoins.length >= 3) {
      const _avgFr = _frCoins.reduce((s, c) => s + c.derivData.fundingRate, 0) / _frCoins.length;
      if (_avgFr > 0.005) { bearPts += 1.5; bearArgs.push(`資金費率均值 ${(_avgFr*100).toFixed(4)}%（極度偏高），多頭嚴重過熱，強烈看空警告`); }
      else if (_avgFr > 0.003) { bearPts++; bearArgs.push(`資金費率均值 ${(_avgFr*100).toFixed(4)}%（偏高），多頭槓桿積累，回調風險升高`); }
      else if (_avgFr > 0.001) { bullPts += 0.5; bullArgs.push(`資金費率均值 ${(_avgFr*100).toFixed(4)}%（健康偏多），多頭持倉主導`); }
      else if (_avgFr < -0.003) { bullPts += 1.5; bullArgs.push(`資金費率均值 ${(_avgFr*100).toFixed(4)}%（極端負費率），空頭大量積累，向上軋空風險極高`); }
      else if (_avgFr < -0.001) { bullPts++; bullArgs.push(`資金費率均值 ${(_avgFr*100).toFixed(4)}%（負費率），空頭過熱，多頭反彈機會`); }
      else { bullArgs.push(`資金費率均值 ${(_avgFr*100).toFixed(4)}%（中性），衍生品市場無明顯偏向`); }
    }
    // 聚合多空比（lsRatio）
    const _lsCoins = _bmoCoins.filter(c => c.derivData?.lsRatio != null);
    if (_lsCoins.length >= 3) {
      const _avgLs = _lsCoins.reduce((s, c) => s + c.derivData.lsRatio, 0) / _lsCoins.length;
      if (_avgLs > 1.4) { bullPts++; bullArgs.push(`多空比均值 ${_avgLs.toFixed(2)}（多頭主導），持倉結構整體偏多`); }
      else if (_avgLs > 1.1) { bullPts += 0.5; bullArgs.push(`多空比均值 ${_avgLs.toFixed(2)}，多方小幅佔優`); }
      else if (_avgLs < 0.75) { bearPts++; bearArgs.push(`多空比均值 ${_avgLs.toFixed(2)}（空頭主導），持倉結構整體偏空`); }
      else if (_avgLs < 0.9) { bearPts += 0.5; bearArgs.push(`多空比均值 ${_avgLs.toFixed(2)}，空方小幅佔優`); }
    }
    // 巨鯨動向
    const _whlB = _bmoCoins.filter(c => c.whaleData?.bias === 'bull').length;
    const _whlR = _bmoCoins.filter(c => c.whaleData?.bias === 'bear').length;
    const _whlT = _whlB + _whlR;
    if (_whlT > 0) {
      const _wPct = Math.round(_whlB / _whlT * 100);
      if (_wPct >= 65) { bullPts++; bullArgs.push(`巨鯨持倉 ${_wPct}% 偏多，主力資金整體看漲`); }
      else if (_wPct <= 35) { bearPts++; bearArgs.push(`巨鯨持倉 ${100-_wPct}% 偏空，主力資金整體撤退`); }
    }
  }

  // ── 本週 / 今日 AI 走勢（納入大方向計分）──
  const wbData = computeWeeklyAIBias(fg, global);
  const tbData = computeTodayAIBias(fg, global);
  if (wbData.bias === 'strong_bull') { bullPts += 2; bullArgs.push(`本週AI走勢：${wbData.biasLabel}（信心 ${wbData.conf}%）`); }
  else if (wbData.bias === 'bull')   { bullPts++;    bullArgs.push(`本週AI走勢：${wbData.biasLabel}（信心 ${wbData.conf}%）`); }
  else if (wbData.bias === 'slight_bull') { bullPts += 0.5; bullArgs.push(`本週AI走勢：${wbData.biasLabel}（信心 ${wbData.conf}%）`); }
  else if (wbData.bias === 'strong_bear') { bearPts += 2; bearArgs.push(`本週AI走勢：${wbData.biasLabel}（信心 ${wbData.conf}%）`); }
  else if (wbData.bias === 'bear')   { bearPts++;    bearArgs.push(`本週AI走勢：${wbData.biasLabel}（信心 ${wbData.conf}%）`); }
  else if (wbData.bias === 'slight_bear') { bearPts += 0.5; bearArgs.push(`本週AI走勢：${wbData.biasLabel}（信心 ${wbData.conf}%）`); }

  if (tbData.bias === 'strong_bull') { bullPts += 2; bullArgs.push(`今日AI走勢：${tbData.biasLabel}（信心 ${tbData.conf}%）`); }
  else if (tbData.bias === 'bull')   { bullPts++;    bullArgs.push(`今日AI走勢：${tbData.biasLabel}（信心 ${tbData.conf}%）`); }
  else if (tbData.bias === 'slight_bull') { bullPts += 0.5; bullArgs.push(`今日AI走勢：${tbData.biasLabel}（信心 ${tbData.conf}%）`); }
  else if (tbData.bias === 'strong_bear') { bearPts += 2; bearArgs.push(`今日AI走勢：${tbData.biasLabel}（信心 ${tbData.conf}%）`); }
  else if (tbData.bias === 'bear')   { bearPts++;    bearArgs.push(`今日AI走勢：${tbData.biasLabel}（信心 ${tbData.conf}%）`); }
  else if (tbData.bias === 'slight_bear') { bearPts += 0.5; bearArgs.push(`今日AI走勢：${tbData.biasLabel}（信心 ${tbData.conf}%）`); }

  // 資金流動事件（進行中或 5 天內開始）
  try {
    const CF_TYPE_ICON = { conference:'🏛', holiday_asia:'🏮', holiday_us:'🇺🇸', holiday_global:'🌍', sports:'⚽', economic:'📊', crypto_event:'🔗' };
    const _cfData = getCapitalFlowBias();
    for (const ev of _cfData.events) {
      const icon     = CF_TYPE_ICON[ev.type] || '💹';
      const aiTag    = ev.isAI ? 'AI預測 ' : '';
      const timeStr  = ev.isActive ? '進行中' : `${ev.daysUntil}天後`;
      if (ev.bull > 0) {
        bullPts += ev.bull;
        bullArgs.push(`${icon}${ev.name}（${timeStr}）：${aiTag}${ev.flow === 'inflow' ? '資金流入' : '輕微流入'}，利好市場情緒（信心 ${ev.conf}%）`);
      } else if (ev.bear > 0) {
        bearPts += ev.bear;
        bearArgs.push(`${icon}${ev.name}（${timeStr}）：${aiTag}${ev.flow === 'outflow' ? '資金流出' : '輕微流出'}，資金可能分流（信心 ${ev.conf}%）`);
      }
    }
  } catch(_e) {}

  // 動態宏觀背景（根據即時 FG、市值變化與 BTC 主導率計算）
  if (fgVal !== null) {
    if (fgVal >= 65)
      bullArgs.push(`市場情緒持續偏多（貪婪 ${fgVal}），ETF 機構配置需求活躍，底部支撐力道強`);
    else if (fgVal >= 50)
      bullArgs.push(`市場情緒平穩（恐貪 ${fgVal}），風險偏好維持，主力資金未見系統性撤退`);
    else if (fgVal >= 35)
      bearArgs.push(`情緒轉謹慎（恐貪 ${fgVal}），主力觀望氣氛重，短線催化劑缺乏`);
    else
      bearArgs.push(`市場深度恐慌（恐貪 ${fgVal}），負面情緒主導，籌碼換手壓力仍在消化`);
  }
  if (chg > 1.5)
    bullArgs.push('加密生態鏈上資金持續流入，活躍地址與交易量同步擴張，多頭動能充足');
  else if (chg >= 0)
    bullArgs.push('市場溫和淨流入，加密生態穩步成長，等待宏觀催化劑強化上行趨勢');
  else if (chg < -1.5)
    bearArgs.push('資金外流明顯，宏觀不確定性壓制風險偏好，鏈上活躍度同步下滑');
  else
    bearArgs.push('全球貨幣政策路徑仍有分歧，高利率預期對風險資產持續構成壓制');

  // 即將公佈重要數據（動態，未來 7 天）
  const _upcomingEvs = (() => { try { return getWeeklyEconEvents(); } catch(_) { return []; } })();
  let events;
  if (_upcomingEvs.length) {
    events = _upcomingEvs.slice(0, 6).map(ev => ({
      date:   `${ev.eventTime.getMonth()+1}/${ev.eventTime.getDate()}`,
      label:  ev.name,
      impact: ev.impact || 'medium',
    }));
  } else {
    const _fd = n => { const nd = new Date(); nd.setDate(nd.getDate()+n); return `${nd.getMonth()+1}/${nd.getDate()}`; };
    events = [
      { date: _fd(1), label: '初請失業金人數（每週四 20:30）', impact: 'medium' },
      { date: _fd(2), label: 'NFP 非農就業（月初第1個週五）', impact: 'high' },
      { date: _fd(7), label: 'CPI 消費者物價指數（每月中旬）', impact: 'high' },
      { date: _fd(14), label: 'FOMC 利率決策（每6週）', impact: 'high' },
      { date: _fd(3), label: 'EIA 原油庫存（每週三 22:30）', impact: 'medium' },
    ];
  }

  // 動態 AI 宏觀預測項目（依即時數據生成，取代靜態卡片）
  const _predItems = [];
  if (fgVal !== null) {
    if (fgVal >= 70)
      _predItems.push({ event: `情緒過熱警示（恐貪 ${fgVal}，極度貪婪）`, conf: 76, dir: 'bear',
        text: `偏空 — 歷史上 FG > 70 後常出現 10-20% 修正，建議控制倉位，逢強減倉` });
    else if (fgVal >= 55)
      _predItems.push({ event: `情緒健康偏多（恐貪 ${fgVal}，貪婪）`, conf: 71, dir: 'bull',
        text: `偏多 — 貪婪區通常對應牛市中段，短線仍有上行空間，可順多方向逢回測佈局` });
    else if (fgVal <= 30)
      _predItems.push({ event: `恐慌底部吸籌機會（恐貪 ${fgVal}）`, conf: 68, dir: 'bull',
        text: `偏多 — 歷史上極度恐慌通常為短線底部，可等趨勢確認後分批進場` });
    else
      _predItems.push({ event: `市場中性觀望（恐貪 ${fgVal}）`, conf: 58, dir: 'neutral',
        text: `中性 — 情緒無明確多空信號，建議以技術面為主要進出依據` });
  }
  const _wbConf = parseInt(wbData?.conf) || 60;
  if (wbData.bias === 'strong_bull' || wbData.bias === 'bull' || wbData.bias === 'slight_bull')
    _predItems.push({ event: `本週宏觀走勢：${wbData.biasLabel}`, conf: _wbConf, dir: 'bull',
      text: `偏多 — 多因子週線 AI 研判多方佔優，建議順多方向操作，逢低佈局` });
  else if (wbData.bias === 'strong_bear' || wbData.bias === 'bear' || wbData.bias === 'slight_bear')
    _predItems.push({ event: `本週宏觀走勢：${wbData.biasLabel}`, conf: _wbConf, dir: 'bear',
      text: `偏空 — 週線 AI 研判空方主導，建議減少多頭曝險，等待市場轉向確認` });
  else
    _predItems.push({ event: `本週宏觀走勢：中性震盪`, conf: _wbConf, dir: 'neutral',
      text: `中性震盪 — 多空訊號分歧，本週市場可能持續整理，等待關鍵突破確認後操作` });
  if (dom > 56)
    _predItems.push({ event: `BTC 主導率偏高（${dom.toFixed(1)}%）`, conf: 72, dir: 'bear',
      text: `不利山寨 — 資金集中於 BTC，山寨季尚未啟動，BTC 相對強勢優先` });
  else if (dom < 44)
    _predItems.push({ event: `山寨季信號（BTC 主導 ${dom.toFixed(1)}%）`, conf: 70, dir: 'bull',
      text: `偏多（山寨）— 主導率下行代表資金廣泛輪動至山寨幣，多標的輪動機會增加` });
  else
    _predItems.push({ event: `BTC 主導率均衡（${dom.toFixed(1)}%）`, conf: 62, dir: 'neutral',
      text: `均衡格局 — BTC 與山寨同步，依各別技術面操作，無明顯輪動方向` });
  if (chg > 2)
    _predItems.push({ event: `市值資金淨流入（+${chg.toFixed(2)}%）`, conf: 74, dir: 'bull',
      text: `偏多 — 24h 市值顯著上漲，場內資金活躍，多頭動能充足，適合順勢操作` });
  else if (chg < -2)
    _predItems.push({ event: `市值資金外流（${chg.toFixed(2)}%）`, conf: 74, dir: 'bear',
      text: `偏空 — 24h 市值明顯下跌，資金淨流出加速，應減少多頭曝險` });
  // 大盤走勢衍生品數據AI預測
  try {
    const _piCoins = (typeof state !== 'undefined' && state.data) ? state.data : [];
    // EMA200 市場寬度
    const _piE200 = _piCoins.filter(c => { const p=parseFloat(c.price); const e=parseFloat(c.ema200); return p>0&&e>0&&p>e; }).length;
    const _piE200P = _piCoins.length ? Math.round(_piE200/_piCoins.length*100) : 0;
    if (_piE200P >= 65)
      _predItems.push({ event: `市場寬度（EMA200上方 ${_piE200P}%）`, conf: 73, dir: 'bull',
        text: `偏多 — ${_piE200P}% 幣種在長線均線上方，牛市結構廣泛確立，非個別強勢幣，整體市場健康` });
    else if (_piE200P <= 30)
      _predItems.push({ event: `市場寬度惡化（EMA200上方僅 ${_piE200P}%）`, conf: 75, dir: 'bear',
        text: `偏空 — ${_piE200P}% 幣種跌破長線均線，熊市結構廣泛確立，系統性風險上升` });
    // 聚合資金費率預測
    const _piFrCoins = _piCoins.filter(c => c.derivData?.fundingRate != null);
    if (_piFrCoins.length >= 3) {
      const _piAvgFr = _piFrCoins.reduce((s,c)=>s+c.derivData.fundingRate,0)/_piFrCoins.length;
      if (_piAvgFr > 0.004)
        _predItems.push({ event: `衍生品過熱警告（費率 ${(_piAvgFr*100).toFixed(4)}%）`, conf: 78, dir: 'bear',
          text: `偏空 — 聚合資金費率過高（>0.04%），歷史上此水準後常出現清算瀑布，多頭應大幅降倉或等待費率回落` });
      else if (_piAvgFr < -0.002)
        _predItems.push({ event: `空頭過熱（費率 ${(_piAvgFr*100).toFixed(4)}%）`, conf: 72, dir: 'bull',
          text: `偏多 — 負資金費率代表空頭大量積累，軋空行情風險高，可尋找做多機會` });
    }
  } catch(_piE) {}
  const _nextHigh = _upcomingEvs.find(ev => ev.impact === 'high' && ev.eventTime.getTime() > Date.now());
  if (_nextHigh) {
    const _dLeft  = Math.ceil((_nextHigh.eventTime.getTime() - Date.now()) / 86400000);
    const _dLabel = _dLeft <= 0 ? '今日' : _dLeft === 1 ? '明日' : `${_dLeft}天後`;
    const _nhDir  = _nextHigh.aiDir || 'neutral';
    _predItems.push({ event: `${_nextHigh.name}（${_dLabel}）`, conf: _nextHigh.aiConf || 63, dir: _nhDir,
      text: `${_nhDir === 'bull' ? '偏多' : _nhDir === 'bear' ? '偏空' : '中性'} — ${_nextHigh.aiMarketImpact || _nextHigh.bullIf || '請等數據公布後依實際反應方向操作，事前建議降低倉位'}` });
  } else {
    _predItems.push({ event: 'M2 全球流動性週期影響', conf: 67, dir: 'bull',
      text: '偏多 — M2 貨幣供給成長歷史上與加密牛市高度正相關（滯後 ~3 個月），流動性擴張期加密整體偏多' });
  }
  const _pcc = { bull: '#22c55e', bear: '#ef4444', neutral: '#f59e0b' };
  const _predHtml = _predItems.slice(0, 7).map(p => {
    const _pc = _pcc[p.dir] || '#f59e0b';
    return `<div class="macro-pred-item">
          <div class="macro-pred-header">
            <span class="macro-pred-event">${p.event}</span>
            <span class="macro-pred-conf" style="color:${_pc}">信心 ${p.conf}%</span>
          </div>
          <div class="macro-pred-impact${p.dir === 'bull' ? ' bull' : p.dir === 'bear' ? ' bear' : ''}">${p.dir === 'bull' ? '📈' : p.dir === 'bear' ? '📉' : '📊'} 預期衝擊：${p.text}</div>
        </div>`;
  }).join('');

  const total = bullPts + bearPts || 1;
  const bullW = Math.round(bullPts / total * 100);
  const bearW = 100 - bullW;
  let bias, bColor, bIcon;
  if      (bullPts > bearPts + 3)  { bias = '強烈看多'; bColor = 'var(--bull)';     bIcon = '▲▲'; }
  else if (bullPts > bearPts + 1)  { bias = '偏多';    bColor = 'var(--bull)';     bIcon = '▲'; }
  else if (bearPts > bullPts + 3)  { bias = '強烈看空'; bColor = 'var(--bear)';     bIcon = '▼▼'; }
  else if (bearPts > bullPts + 1)  { bias = '偏空';    bColor = 'var(--bear)';     bIcon = '▼'; }
  else if (bullPts > bearPts)      { bias = '中性偏多'; bColor = 'var(--neutral)';  bIcon = '◆'; }
  else if (bearPts > bullPts)      { bias = '中性偏空'; bColor = 'var(--neutral)';  bIcon = '◆'; }
  else                              { bias = '中性';    bColor = 'var(--neutral)';  bIcon = '◆'; }

  return `<div class="outlook-header">
      <span class="outlook-title">🌐 加密市場大方向</span>
      <span class="outlook-bias" style="color:${bColor}">${bIcon} ${bias}</span>
    </div>
    <div class="outlook-bar-wrap">
      <span class="outlook-bar-lbl" style="color:var(--bull)">多方</span>
      <div class="outlook-bar">
        <div style="width:${bullW}%;height:100%;background:var(--bull);border-radius:4px 0 0 4px"></div>
        <div style="width:${bearW}%;height:100%;background:var(--bear);border-radius:0 4px 4px 0"></div>
      </div>
      <span class="outlook-bar-lbl" style="color:var(--bear)">空方</span>
    </div>
    <div class="outlook-body">
      <div class="outlook-col">
        <div class="outlook-col-title" style="color:var(--bull)">📈 多方論點</div>
        ${bullArgs.map(a => `<div class="outlook-arg">• ${a}</div>`).join('')}
      </div>
      <div class="outlook-col">
        <div class="outlook-col-title" style="color:var(--bear)">📉 空方論點</div>
        ${bearArgs.map(a => `<div class="outlook-arg">• ${a}</div>`).join('')}
      </div>
    </div>
    ${(() => { try {
      // ── 大盤走勢儀表板（市場寬度 + 衍生品聚合）──
      const _dCoins = (typeof state !== 'undefined' && state.data) ? state.data : [];
      if (!_dCoins.length) return '';
      const _dFmt = v => (v >= 1e9 ? (v/1e9).toFixed(2)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v.toFixed(0));
      const _btcC = _dCoins.find(c => c.symbol === 'BTC/USDT');
      const _btcP = _btcC ? parseFloat(_btcC.price) || 0 : 0;
      const _btcE200 = _btcC ? parseFloat(_btcC.ema200) || 0 : 0;
      const _btcScore = _btcC ? (_btcC.score || 50) : 50;
      const _btcClr = _btcC && _btcP > _btcE200 * 1.01 ? 'var(--bull)' : _btcC && _btcP < _btcE200 * 0.99 ? 'var(--bear)' : 'var(--text2)';
      const _e200B = _dCoins.filter(c => { const p = parseFloat(c.price); const e = parseFloat(c.ema200); return p>0&&e>0&&p>e; }).length;
      const _e50B  = _dCoins.filter(c => { const p = parseFloat(c.price); const e = parseFloat(c.ema50);  return p>0&&e>0&&p>e; }).length;
      const _e200P = Math.round(_e200B/_dCoins.length*100);
      const _e50P  = Math.round(_e50B/_dCoins.length*100);
      const _e200C = _e200P>=55?'var(--bull)':_e200P<=40?'var(--bear)':'#f59e0b';
      const _e50C  = _e50P>=55?'var(--bull)':_e50P<=40?'var(--bear)':'#f59e0b';
      const _frCoinsD = _dCoins.filter(c => c.derivData?.fundingRate != null);
      const _avgFrD = _frCoinsD.length>=3 ? _frCoinsD.reduce((s,c)=>s+c.derivData.fundingRate,0)/_frCoinsD.length : null;
      const _frClr = _avgFrD != null ? (_avgFrD > 0.003?'var(--bear)':_avgFrD<-0.001?'var(--bull)':'var(--text2)') : 'var(--text3)';
      const _lsCoinsD = _dCoins.filter(c => c.derivData?.lsRatio != null);
      const _avgLsD = _lsCoinsD.length>=3 ? _lsCoinsD.reduce((s,c)=>s+c.derivData.lsRatio,0)/_lsCoinsD.length : null;
      const _lsClr = _avgLsD != null ? (_avgLsD>1.2?'var(--bull)':_avgLsD<0.85?'var(--bear)':'var(--text2)') : 'var(--text3)';
      const _vtD = totalVol>0&&totalMktCap>0 ? totalVol/totalMktCap : 0;
      const _vtC = _vtD>0.1?'var(--bull)':_vtD<0.04?'var(--bear)':'var(--text2)';
      const _ethDomTxt = ethDom>0 ? `ETH ${ethDom.toFixed(1)}%` : '';
      return `<div style="background:rgba(16,24,39,.7);border:1px solid rgba(99,102,241,.2);border-radius:10px;padding:12px 14px;margin-bottom:10px">
        <div style="font-size:0.78rem;font-weight:700;color:var(--text2);margin-bottom:10px">📊 大盤走勢儀表板</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:0.73rem">
          ${_btcC ? `<div style="background:rgba(255,255,255,.03);border-radius:7px;padding:7px 10px">
            <div style="color:var(--text3);font-size:0.67rem;margin-bottom:3px">₿ BTC 龍頭位置</div>
            <div style="color:${_btcClr};font-weight:600">${_btcE200>0?(_btcP>_btcE200?'▲ EMA200上方':'▼ EMA200下方'):'—'}
              ${_btcE200>0?`<span style="color:var(--text3);font-size:0.67rem;margin-left:4px">${(Math.abs(_btcP/_btcE200-1)*100).toFixed(1)}%</span>`:''}
            </div>
            <div style="color:var(--text3);font-size:0.67rem;margin-top:2px">技術評分 ${_btcScore}</div>
          </div>` : ''}
          <div style="background:rgba(255,255,255,.03);border-radius:7px;padding:7px 10px">
            <div style="color:var(--text3);font-size:0.67rem;margin-bottom:3px">📈 EMA200 上方（長線）</div>
            <div style="color:${_e200C};font-weight:600">${_e200P}%<span style="color:var(--text3);font-size:0.67rem;margin-left:4px">${_e200B}/${_dCoins.length} 幣種</span></div>
            <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px;margin-top:4px;overflow:hidden">
              <div style="width:${_e200P}%;height:100%;background:${_e200C};border-radius:2px"></div>
            </div>
          </div>
          <div style="background:rgba(255,255,255,.03);border-radius:7px;padding:7px 10px">
            <div style="color:var(--text3);font-size:0.67rem;margin-bottom:3px">📈 EMA50 上方（中線）</div>
            <div style="color:${_e50C};font-weight:600">${_e50P}%<span style="color:var(--text3);font-size:0.67rem;margin-left:4px">${_e50B}/${_dCoins.length} 幣種</span></div>
            <div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px;margin-top:4px;overflow:hidden">
              <div style="width:${_e50P}%;height:100%;background:${_e50C};border-radius:2px"></div>
            </div>
          </div>
          ${_avgFrD != null ? `<div style="background:rgba(255,255,255,.03);border-radius:7px;padding:7px 10px">
            <div style="color:var(--text3);font-size:0.67rem;margin-bottom:3px">💰 聚合資金費率</div>
            <div style="color:${_frClr};font-weight:600">${(_avgFrD*100).toFixed(4)}%
              <span style="font-size:0.66rem;color:var(--text3);margin-left:4px">${_avgFrD>0.003?'過熱警告':_avgFrD>0.001?'健康偏多':_avgFrD<-0.001?'空頭積累':'中性'}</span>
            </div>
          </div>` : ''}
          ${_avgLsD != null ? `<div style="background:rgba(255,255,255,.03);border-radius:7px;padding:7px 10px">
            <div style="color:var(--text3);font-size:0.67rem;margin-bottom:3px">⚖️ 聚合多空比</div>
            <div style="color:${_lsClr};font-weight:600">${_avgLsD.toFixed(2)}:1
              <span style="font-size:0.66rem;color:var(--text3);margin-left:4px">${_avgLsD>1.2?'多頭主導':_avgLsD<0.85?'空頭主導':'均衡'}</span>
            </div>
          </div>` : ''}
          ${_vtD > 0 ? `<div style="background:rgba(255,255,255,.03);border-radius:7px;padding:7px 10px">
            <div style="color:var(--text3);font-size:0.67rem;margin-bottom:3px">🔄 成交量換手率</div>
            <div style="color:${_vtC};font-weight:600">${(_vtD*100).toFixed(2)}%
              <span style="font-size:0.66rem;color:var(--text3);margin-left:4px">${_vtD>0.1?'活躍':_vtD>0.06?'正常':'低迷'}</span>
            </div>
          </div>` : ''}
          ${_ethDomTxt ? `<div style="background:rgba(255,255,255,.03);border-radius:7px;padding:7px 10px">
            <div style="color:var(--text3);font-size:0.67rem;margin-bottom:3px">Ξ BTC/ETH 主導</div>
            <div style="color:var(--text2);font-weight:600">BTC ${dom.toFixed(1)}% / ${_ethDomTxt}
              <span style="font-size:0.66rem;color:var(--text3);margin-left:4px">${dom<44&&ethDom<14?'山寨季信號':dom>56?'BTC主導':'均衡'}</span>
            </div>
          </div>` : ''}
        </div>
      </div>`;
    } catch(_e) { return ''; } })()}
    ${buildWeeklyAIOutlook(fg, global)}
    ${buildTodayAIBiasHtml(fg, global)}
    <div class="outlook-events">
      <div class="outlook-events-title">📅 即將公佈重要數據</div>
      <div class="outlook-events-list">
        ${events.map(e => `<div class="outlook-event${e.impact === 'high' ? ' outlook-event-high' : ''}">
          <span class="outlook-event-date">${e.date}</span>${e.label}</div>`).join('')}
      </div>
    </div>
    ${buildTodayEconWidget()}
    <div class="macro-ai-preds">
      <div class="macro-ai-title">🤖 AI 宏觀預測分析</div>
      <div class="macro-ai-subtitle">根據歷史規律、Fed政策路徑及市場反應模式推算</div>
      <div style="background:rgba(255,255,255,.05);border-left:3px solid ${bColor};border-radius:0 8px 8px 0;padding:10px 14px;margin:10px 0 14px">
        <div style="font-size:0.7rem;color:var(--text3);margin-bottom:4px">🤖 AI 綜合研判</div>
        <div style="font-size:1.25rem;font-weight:800;color:${bColor};margin-bottom:6px">${bIcon} ${bias}</div>
        <div style="font-size:0.76rem;color:var(--text2);line-height:1.6">${
          (bias === '強烈看多')
            ? `綜合恐慌貪婪指數、加密市值動向、BTC主導率及AI多維預測，整體宏觀環境強烈偏多。多頭動能充足，操作建議：順多方向，在關鍵支撐回測時積極佈局。`
          : (bias === '偏多')
            ? `整合多項宏觀指標，整體環境偏向多方，多頭力道略佔優。操作建議：可逢回測佈局多單，控制倉位並注意宏觀風險事件。`
          : (bias === '中性偏多')
            ? `宏觀數據整體略偏多，但多空訊號分歧，建議輕倉做多並設嚴格止損，等待趨勢進一步確立再加碼。`
          : (bias === '強烈看空')
            ? `綜合多項宏觀指標，市場環境空頭主導，整體結構偏空。操作建議：保守觀望為主，避免逆勢追多，等待明確企穩訊號。`
          : (bias === '偏空')
            ? `整合宏觀數據，整體偏空格局，賣壓較買盤更大。操作建議：減少多頭曝險，以防守為主，等待市場轉變確認後再行動。`
          : (bias === '中性偏空')
            ? `宏觀指標略偏空，但訊號強度不足，建議謹慎操作，優先觀望，以技術面訊號輔助判斷方向。`
          : `各項宏觀指標分歧，市場目前無明確多空方向。建議以技術面為主、宏觀為輔，等待關鍵突破確認後再操作。`
        }</div>
      </div>
      <div class="macro-ai-pred-list">
        ${_predHtml}
      </div>
    </div>`;
}

function fmt12h(h, m) {
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${period}`;
}

/* ── AI 預測自學習系統（靜默，不對外顯示）──────────────────────── */
const _BIAS_LEARN_KEY = 'ai_bias_learning';

function _loadBiasLearning() {
  try {
    const raw = localStorage.getItem(_BIAS_LEARN_KEY);
    if (!raw) return { weeklyPred: null, dailyPred: null, weights: {} };
    const d = JSON.parse(raw);
    return { weeklyPred: d.weeklyPred || null, dailyPred: d.dailyPred || null, weights: d.weights || {} };
  } catch(e) { return { weeklyPred: null, dailyPred: null, weights: {} }; }
}

function _saveBiasLearning(data) {
  try { localStorage.setItem(_BIAS_LEARN_KEY, JSON.stringify(data)); } catch(e) {}
}

// Get weight value clamped to [0.5, 1.5]; default 1.0
function _getBiasWeight(weights, key) {
  const w = weights[key];
  return (w != null && isFinite(w)) ? Math.max(0.5, Math.min(1.5, w)) : 1.0;
}

// Silently adjust factor weights based on prediction outcome
// factorVotes: { fg: ±n, mktChg: ±n, btcDom: ±n, techScan: ±n }
// positive vote = voted bullish, negative = voted bearish
function _adjustBiasWeights(weights, predBias, actualMktChg, factorVotes, prefix) {
  const predBull = predBias.includes('bull');
  const predBear = predBias.includes('bear');
  if (!predBull && !predBear) return weights; // neutral: nothing to learn
  const actualBull = actualMktChg > 0.8;
  const actualBear = actualMktChg < -0.8;
  if (!actualBull && !actualBear) return weights; // outcome ambiguous: skip
  const wrong   = (predBull && actualBear) || (predBear && actualBull);
  const correct = (predBull && actualBull) || (predBear && actualBear);
  const newWeights = { ...weights };
  const allKeys = [`${prefix}_fg`, `${prefix}_mktChg`, `${prefix}_btcDom`, `${prefix}_techScan`];
  // Gentle decay toward 1.0 for all weights each evaluation cycle
  allKeys.forEach(k => {
    const w = _getBiasWeight(newWeights, k);
    newWeights[k] = w + (1.0 - w) * 0.08;
  });
  if (wrong) {
    // Penalise factors that pushed prediction in the wrong direction
    Object.entries(factorVotes).forEach(([factor, vote]) => {
      if (!vote) return;
      const key = `${prefix}_${factor}`;
      const factorWrong = (predBull && vote > 0) || (predBear && vote < 0);
      if (factorWrong) {
        const w = _getBiasWeight(newWeights, key);
        newWeights[key] = Math.max(0.5, w - 0.10 * Math.min(2, Math.abs(vote)));
      }
    });
  } else if (correct) {
    // Lightly reinforce factors that were correct
    Object.entries(factorVotes).forEach(([factor, vote]) => {
      if (!vote) return;
      const key = `${prefix}_${factor}`;
      const factorRight = (predBull && vote > 0) || (predBear && vote < 0);
      if (factorRight) {
        const w = _getBiasWeight(newWeights, key);
        newWeights[key] = Math.min(1.5, w + 0.03);
      }
    });
  }
  return newWeights;
}

/* ── 本週 AI 走勢預測資料層（禮拜日 8:00 刷新一次，整週有效）──────── */
const _WEEKLY_BIAS_CACHE_KEY = 'weekly_bias_cache_v3';

/** 計算「本週起始時間」= 最近一個禮拜日的 08:00（本地時間）*/
function _getThisWeekSunday8am() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const sun = new Date(now);
  sun.setDate(now.getDate() - day);   // 退回到本週日
  sun.setHours(8, 0, 0, 0);
  // 若今天是禮拜日但還未到 8am，退到上週日
  if (day === 0 && now < sun) sun.setDate(sun.getDate() - 7);
  return sun.getTime();
}

function computeWeeklyAIBias(fg, globalMkt) {
  const fgValNow  = fg ? parseInt(fg.value) : null;
  const mktChgNow = globalMkt?.marketCapChange || 0;

  // ── 週方向快取（週日08:00起有效）：方向鎖定一週，風控分每次重新計算 ──
  let _lockedWeeklyCache = null; // 只鎖方向 (bias)，不鎖風控分
  try {
    const cached = JSON.parse(localStorage.getItem(_WEEKLY_BIAS_CACHE_KEY) || 'null');
    if (cached && cached.result && cached.timestamp) {
      const weekStart = _getThisWeekSunday8am();
      if (cached.timestamp >= weekStart) {
        _lockedWeeklyCache = cached; // 有效：方向本週固定，但風控分需每天重算
      }
    }
  } catch(e) {}

  // ── 每次重新計算風控分（conf 隨當天市場數據更新）──
  const learn = _loadBiasLearning();
  let weights = learn.weights || {};
  try {
    const prev = learn.weeklyPred;
    if (prev && prev.timestamp) {
      const ageDays = (Date.now() - prev.timestamp) / 86400000;
      if (ageDays >= 5) {
        weights = _adjustBiasWeights(weights, prev.bias, mktChgNow, prev.factorVotes || {}, 'weekly');
      }
    }
  } catch(e) {}

  const btcDom = globalMkt?.btcDominance || 50;
  let macroBull = 0, macroBear = 0;
  const factors = [];
  const factorVotes = {};

  const wFg   = _getBiasWeight(weights, 'weekly_fg');
  const wMkt  = _getBiasWeight(weights, 'weekly_mktChg');
  const wBtc  = _getBiasWeight(weights, 'weekly_btcDom');
  const wTech = _getBiasWeight(weights, 'weekly_techScan');

  // ① 恐慌貪婪
  if (fgValNow != null) {
    let v = 0;
    if (fgValNow >= 65)      { v =  2; macroBull += 2 * wFg; factors.push(`恐貪 ${fgValNow}（極度貪婪），本週情緒強多`); }
    else if (fgValNow >= 55) { v =  1; macroBull += 1 * wFg; factors.push(`恐貪 ${fgValNow}（貪婪），情緒偏多`); }
    else if (fgValNow <= 35) { v = -2; macroBear += 2 * wFg; factors.push(`恐貪 ${fgValNow}（極度恐慌），本週情緒偏空`); }
    else if (fgValNow <= 45) { v = -1; macroBear += 1 * wFg; factors.push(`恐貪 ${fgValNow}（恐慌），情緒偏空`); }
    else                     {         factors.push(`恐貪 ${fgValNow}（中性），情緒均衡`); }
    factorVotes.fg = v;
  }
  // ② 市值變化（24h 趨勢，±2% 才計分）
  if (mktChgNow > 2)       { factorVotes.mktChg =  2; macroBull += 2 * wMkt; factors.push(`加密市值 +${mktChgNow.toFixed(1)}%，資金積極流入`); }
  else if (mktChgNow > 0)  { factorVotes.mktChg =  1; macroBull += 1 * wMkt; factors.push(`加密市值 +${mktChgNow.toFixed(1)}%，小幅成長`); }
  else if (mktChgNow < -2) { factorVotes.mktChg = -2; macroBear += 2 * wMkt; factors.push(`加密市值 ${mktChgNow.toFixed(1)}%，資金明顯流出`); }
  else if (mktChgNow < 0)  { factorVotes.mktChg = -1; macroBear += 1 * wMkt; factors.push(`加密市值 ${mktChgNow.toFixed(1)}%，輕微回調`); }
  else                     { factorVotes.mktChg =  0; }
  // ③ BTC 主導率
  if (btcDom > 58)      { factorVotes.btcDom = -1; macroBear += 1 * wBtc; factors.push(`BTC主導 ${btcDom.toFixed(1)}%（高位），山寨承壓`); }
  else if (btcDom < 44) { factorVotes.btcDom =  1; macroBull += 1 * wBtc; factors.push(`BTC主導 ${btcDom.toFixed(1)}%（低位），山寨季升溫`); }
  else                  { factorVotes.btcDom =  0; }
  // ④ 技術面掃描（分佈快照）
  const coins = (typeof state !== 'undefined' && state.data) ? state.data : [];
  if (coins.length) {
    const techBull    = coins.filter(c => c.score >= 70).length;
    const techBear    = coins.filter(c => c.score <= 30).length;
    const techBullPct = Math.round(techBull / coins.length * 100);
    const techBearPct = Math.round(techBear / coins.length * 100);
    if      (techBullPct > 40) { factorVotes.techScan =  2; macroBull += 2 * wTech; factors.push(`技術面 ${techBullPct}% 幣種看漲，多頭佔優`); }
    else if (techBullPct > 25) { factorVotes.techScan =  1; macroBull += 1 * wTech; factors.push(`技術面 ${techBullPct}% 幣種偏強`); }
    else if (techBearPct > 40) { factorVotes.techScan = -2; macroBear += 2 * wTech; factors.push(`技術面 ${techBearPct}% 幣種看跌，空頭佔優`); }
    else if (techBearPct > 25) { factorVotes.techScan = -1; macroBear += 1 * wTech; factors.push(`技術面 ${techBearPct}% 幣種偏弱`); }
    else                       { factorVotes.techScan =  0; factors.push(`技術面多空均衡（看漲 ${techBullPct}% / 看跌 ${techBearPct}%）`); }
  }
  // ⑤ 週線多空分佈（幣種週線信號統計）
  const wWkSig = _getBiasWeight(weights, 'weekly_wkSignal');
  if (coins.length) {
    const wkBull = coins.filter(c => c.weeklySignal?.includes('bull')).length;
    const wkBear = coins.filter(c => c.weeklySignal?.includes('bear')).length;
    const wkBullPct = Math.round(wkBull / coins.length * 100);
    const wkBearPct = Math.round(wkBear / coins.length * 100);
    if      (wkBullPct > 45) { factorVotes.wkSignal =  2; macroBull += 2 * wWkSig; factors.push(`週線 ${wkBullPct}% 幣種多頭排列，市場結構強勢`); }
    else if (wkBullPct > 28) { factorVotes.wkSignal =  1; macroBull += 1 * wWkSig; factors.push(`週線 ${wkBullPct}% 幣種偏多`); }
    else if (wkBearPct > 45) { factorVotes.wkSignal = -2; macroBear += 2 * wWkSig; factors.push(`週線 ${wkBearPct}% 幣種空頭排列，市場結構偏弱`); }
    else if (wkBearPct > 28) { factorVotes.wkSignal = -1; macroBear += 1 * wWkSig; factors.push(`週線 ${wkBearPct}% 幣種偏空`); }
    else                     { factorVotes.wkSignal =  0; factors.push(`週線多空均衡（多頭 ${wkBullPct}% / 空頭 ${wkBearPct}%）`); }
  }
  // ⑥ 市場RSI狀態（超買/超賣分佈）
  const wRsiW = _getBiasWeight(weights, 'weekly_rsi');
  if (coins.length) {
    const rsiOBW = coins.filter(c => (parseFloat(c.rsi)||50) > 70).length;
    const rsiOSW = coins.filter(c => (parseFloat(c.rsi)||50) < 30).length;
    const rsiOBPct = Math.round(rsiOBW / coins.length * 100);
    const rsiOSPct = Math.round(rsiOSW / coins.length * 100);
    if      (rsiOBPct > 30) { factorVotes.rsiW = -1; macroBear += 1 * wRsiW; factors.push(`${rsiOBPct}% 幣種 RSI 超買（>70），市場過熱風險`); }
    else if (rsiOSPct > 25) { factorVotes.rsiW =  1; macroBull += 1 * wRsiW; factors.push(`${rsiOSPct}% 幣種 RSI 超賣（<30），超賣反彈機會`); }
    else                    { factorVotes.rsiW =  0; }
  }
  // ⑦ 籌碼資金流向（Taker 買賣比聚合均值）
  const wChipsW = _getBiasWeight(weights, 'weekly_chips');
  const _wDrvCoins = coins.filter(c => c.derivData?.takerBuySell != null);
  if (_wDrvCoins.length >= 3) {
    const avgTkrW = _wDrvCoins.reduce((s, c) => s + c.derivData.takerBuySell, 0) / _wDrvCoins.length;
    if      (avgTkrW > 1.10) { factorVotes.chipsW =  2; macroBull += 2 * wChipsW; factors.push(`市場 Taker 買賣比 ${avgTkrW.toFixed(2)}（買方主導），資金積極流入`); }
    else if (avgTkrW > 1.03) { factorVotes.chipsW =  1; macroBull += 1 * wChipsW; factors.push(`Taker 比 ${avgTkrW.toFixed(2)}，買方略佔優`); }
    else if (avgTkrW < 0.90) { factorVotes.chipsW = -2; macroBear += 2 * wChipsW; factors.push(`市場 Taker 買賣比 ${avgTkrW.toFixed(2)}（賣方主導），資金明顯流出`); }
    else if (avgTkrW < 0.97) { factorVotes.chipsW = -1; macroBear += 1 * wChipsW; factors.push(`Taker 比 ${avgTkrW.toFixed(2)}，賣方略佔優`); }
    else                     { factorVotes.chipsW =  0; }
  }
  // ⑧ 巨鯨動向（多空持倉分佈）
  const wWhaleW = _getBiasWeight(weights, 'weekly_whale');
  const _wWhlCoins = coins.filter(c => c.whaleData?.bias);
  if (_wWhlCoins.length >= 3) {
    const whlBull = _wWhlCoins.filter(c => c.whaleData.bias === 'bull').length;
    const whlBear = _wWhlCoins.filter(c => c.whaleData.bias === 'bear').length;
    const whlBullPct = Math.round(whlBull / _wWhlCoins.length * 100);
    const whlBearPct = Math.round(whlBear / _wWhlCoins.length * 100);
    if      (whlBullPct > 55) { factorVotes.whaleW =  1; macroBull += 1 * wWhaleW; factors.push(`巨鯨 ${whlBullPct}% 偏多，主力資金看漲`); }
    else if (whlBearPct > 55) { factorVotes.whaleW = -1; macroBear += 1 * wWhaleW; factors.push(`巨鯨 ${whlBearPct}% 偏空，主力資金撤退`); }
    else                      { factorVotes.whaleW =  0; }
  }

  // ⑨ MACD 動能多空分佈（正值 = 上行動能，負值 = 下行動能）
  const wMacdW = _getBiasWeight(weights, 'weekly_macdDist');
  if (coins.length) {
    const _wMacdBull = coins.filter(c => (parseFloat(c.macdHist)||0) > 0).length;
    const _wMacdBullPct = Math.round(_wMacdBull / coins.length * 100);
    if (_wMacdBullPct > 62) {
      factorVotes.macdDistW = 1; macroBull += 1 * wMacdW;
      factors.push(`${_wMacdBullPct}% 幣種 MACD 動能向上，本週多頭動能佔優`);
    } else if (_wMacdBullPct < 38) {
      factorVotes.macdDistW = -1; macroBear += 1 * wMacdW;
      factors.push(`${100-_wMacdBullPct}% 幣種 MACD 動能向下，本週空頭動能佔優`);
    } else { factorVotes.macdDistW = 0; }
  }
  // ⑩ ADX 趨勢確立率（≥25 = 趨勢市場，低 = 震盪）— 提升權重
  const wAdxDistW = _getBiasWeight(weights, 'weekly_adxDist');
  if (coins.length) {
    const _wAdxTrend = coins.filter(c => (parseFloat(c.adx)||0) >= 25).length;
    const _wAdxPct   = Math.round(_wAdxTrend / coins.length * 100);
    if (_wAdxPct > 65) {
      factorVotes.adxDistW = 2; macroBull += 1.5 * wAdxDistW;  // 趨勢確立度高 → 加強信號
      factors.push(`${_wAdxPct}% 幣種趨勢確立（ADX ≥25），本週市場方向性極強，利好趨勢交易`);
    } else if (_wAdxPct > 50) {
      factorVotes.adxDistW = 1; macroBull += 0.8 * wAdxDistW;
      factors.push(`${_wAdxPct}% 幣種趨勢確立，本週市場方向性明確`);
    } else if (_wAdxPct < 28) {
      factorVotes.adxDistW = -1; macroBear += 0.8 * wAdxDistW;
      factors.push(`僅 ${_wAdxPct}% 幣種趨勢確立，本週市場普遍震盪，方向不明確`);
    } else { factorVotes.adxDistW = 0; }
  }
  // ⑪ 足跡圖 Delta 聚合 + 背離檢查（市場微觀結構，未公開訊息指標）
  const _wFpEntries = Object.values(_footprintCache).filter(fp => fp && fp.deltaDir !== 'neutral');
  if (_wFpEntries.length >= 1) {
    const wFpW = _getBiasWeight(weights, 'weekly_fpDelta');
    const fpBN = _wFpEntries.filter(fp => fp.deltaDir === 'bull').length;
    const fpSN = _wFpEntries.filter(fp => fp.deltaDir === 'bear').length;
    const fpT  = _wFpEntries.length;
    const fpBPct = Math.round(fpBN / fpT * 100);
    const fpSPct = Math.round(fpSN / fpT * 100);
    const fpDivN = _wFpEntries.filter(fp => fp.deltaDiv).length;
    const fpDivRatio = fpDivN / fpT;

    // 強勢單向 + 低背離 = 高信心
    if (fpBPct >= 75 && fpDivRatio < 0.2) {
      factorVotes.fpW =  3; macroBull += 2.5 * wFpW;
      factors.push(`足跡圖強勢買盤 ${fpBPct}% + 低背離，本週資金高度積極流入（${fpBN}/${fpT}），市場結構強勢`);
    } else if (fpBPct >= 70) {
      factorVotes.fpW =  2; macroBull += 2 * wFpW;
      factors.push(`足跡圖 ${fpBPct}% 幣種主動買盤主導，本週資金積極流入（${fpBN}/${fpT}）`);
    } else if (fpBPct >= 55) {
      factorVotes.fpW =  1; macroBull += 1 * wFpW;
      factors.push(`足跡圖多數 Delta 偏多（${fpBPct}%），買方小幅佔優`);
    } else if (fpSPct >= 75 && fpDivRatio < 0.2) {
      factorVotes.fpW = -3; macroBear += 2.5 * wFpW;
      factors.push(`足跡圖強勢賣盤 ${fpSPct}% + 低背離，本週資金高度撤離（${fpSN}/${fpT}），市場結構弱勢`);
    } else if (fpSPct >= 70) {
      factorVotes.fpW = -2; macroBear += 2 * wFpW;
      factors.push(`足跡圖 ${fpSPct}% 幣種主動賣盤主導，本週資金撤離（${fpSN}/${fpT}）`);
    } else if (fpSPct >= 55) {
      factorVotes.fpW = -1; macroBear += 1 * wFpW;
      factors.push(`足跡圖多數 Delta 偏空（${fpSPct}%），賣方小幅佔優`);
    } else {
      factorVotes.fpW = 0;
    }
    // 背離警告：高背離 = 市場轉折訊號
    if (fpDivRatio >= 0.35) {
      macroBear += 0.8;
      factors.push(`⚠️ 足跡圖 ${(fpDivRatio*100).toFixed(0)}% 背離，本週出現拉鋸局面，後續轉向風險高`);
    }
  }
  // ⑫ 週度市場微結構質量（Tick 品質聚合 + VWAP 偏離）
  const _wMsqEntries = Object.values(_footprintCache).filter(fp => fp && fp.microstructureQuality != null);
  if (_wMsqEntries.length >= 1) {
    const wMsqW = _getBiasWeight(weights, 'weekly_microstructure');
    const avgMsqW = _wMsqEntries.reduce((s, fp) => s + fp.microstructureQuality, 0) / _wMsqEntries.length;
    const highNoiseW = _wMsqEntries.filter(fp => fp.bidAskBounceScore > 65).length / _wMsqEntries.length;
    if (avgMsqW >= 70 && highNoiseW < 0.2) {
      factorVotes.msqW = 1; macroBull += 1 * wMsqW;
      factors.push(`市場微結構質量良好（均${avgMsqW.toFixed(0)}分），本週 Tick 訂單流一致性強，訊號可靠性高`);
    } else if (highNoiseW > 0.5) {
      factorVotes.msqW = -1; macroBear += 1 * wMsqW;
      factors.push(`本週市場微結構噪音偏高（${(highNoiseW*100).toFixed(0)}% 幣種 Bid-Ask Bounce），信心折扣`);
    } else { factorVotes.msqW = 0; }
  }

  // ⑤ 本週重大事件風險
  const weekEvents = getWeeklyEconEvents().filter(ev => ev.impact === 'high');
  const highRisk   = weekEvents.length >= 2;
  if (weekEvents.length >= 3) { macroBear += 1; }  // 多重高風險事件 → 輕微空方壓力
  const riskNote = weekEvents.length
    ? `本週 ${weekEvents.length} 項高影響數據（${weekEvents.map(e=>e.name.slice(0,10)).join('、')}），注意波動風險`
    : '本週無重大高影響數據，行情以技術面為主';

  const totalScore = macroBull - macroBear;
  const absScore   = Math.abs(totalScore);
  // 若本週已有快取方向 → 鎖定方向不變；風控分始終用當天最新數據計算
  const freshBias  = totalScore >= 4 ? 'strong_bull' : totalScore >= 2 ? 'bull'
                   : totalScore <= -4 ? 'strong_bear' : totalScore <= -2 ? 'bear' : 'neutral';
  const bias       = _lockedWeeklyCache ? _lockedWeeklyCache.result.bias : freshBias;
  const biasLabel  = { strong_bull:'▲▲ 強勢偏多', bull:'▲ 偏多', strong_bear:'▼▼ 強勢偏空', bear:'▼ 偏空', neutral:'◆ 震盪中性' }[bias];
  const biasColor  = bias.includes('bull') ? 'var(--bull)' : bias.includes('bear') ? 'var(--bear)' : 'var(--text2)';
  // 風控分根據當天最新市場數據計算（每天更新）
  const conf       = Math.min(92, 50 + absScore * 10 + (bias.includes('strong') ? 8 : 0) + (fgValNow != null ? 5 : 0));
  const confColor  = conf >= 60 ? 'var(--bull)' : conf >= 50 ? '#f0a500' : 'var(--text3)';

  const _wTopFacts = factors.slice(0, 2).map(f => f.split('，')[0]).join('；');
  const aiOpinion = bias === 'strong_bull'
    ? `綜合市場情緒、週線技術面、籌碼流向及巨鯨動向，AI 研判本週市場多頭動能強勁，整體結構有利做多，高風險數據公布前注意倉位管理。`
    : bias === 'bull'
    ? `整合多維度市場數據（情緒/技術/籌碼/主力），AI 研判本週整體偏多，多方力道佔優，可考慮逢回測佈局多單，注意大方向風險。`
    : bias === 'strong_bear'
    ? `宏觀逆風加技術面空頭排列，AI 研判本週市場空頭主導，整體結構偏空，建議保守觀望或輕倉做空，避免逆勢追多。`
    : bias === 'bear'
    ? `整合多維度數據，AI 研判本週整體偏空，空方壓力較大，建議減少多頭曝險，等待市場企穩訊號後再操作。`
    : `各項指標分歧，AI 研判本週市場缺乏明確方向，多空力量相當，建議以觀望為主，等待突破訊號確立後再操作。`;

  const result = { bias, biasLabel, biasColor, conf, confColor, factors, riskNote, highRisk, weekEvents, rangeMode: bias === 'neutral', aiOpinion };

  // ── 學習記錄 + 寫入快取（方向戳記保留週日時間戳；風控分每次刷新）──
  try {
    learn.weeklyPred = { bias, factorVotes, mktChgAtTime: mktChgNow, timestamp: Date.now() };
    learn.weights = weights;
    _saveBiasLearning(learn);
    // 保留原本週日時間戳（使方向判定週期不重置），風控分已更新於 result.conf
    const _cacheTs = _lockedWeeklyCache ? _lockedWeeklyCache.timestamp : Date.now();
    localStorage.setItem(_WEEKLY_BIAS_CACHE_KEY, JSON.stringify({
      result,
      timestamp: _cacheTs,
      fgVal: fgValNow,
      mktChg: mktChgNow,
    }));
  } catch(e) {}

  return result;
}

/* ── 本週 AI 走勢 UI Widget（使用 computeWeeklyAIBias 快取結果）── */
function buildWeeklyAIOutlook(fg, globalMkt) {
  const d = computeWeeklyAIBias(fg, globalMkt);
  const { biasLabel, biasColor, conf: confScore, confColor, factors, riskNote, highRisk } = d;
  // 每次從 bias 重新生成（避免舊快取無此欄位）
  const aiOpinion = d.bias === 'strong_bull'
    ? `綜合市場情緒、週線技術面、籌碼流向及巨鯨動向，AI 研判本週市場多頭動能強勁，整體結構有利做多，高風險數據公布前注意倉位管理。`
    : d.bias === 'bull'
    ? `整合多維度市場數據（情緒/技術/籌碼/主力），AI 研判本週整體偏多，多方力道佔優，可考慮逢回測佈局多單，注意大方向風險。`
    : d.bias === 'strong_bear'
    ? `宏觀逆風加技術面空頭排列，AI 研判本週市場空頭主導，整體結構偏空，建議保守觀望或輕倉做空，避免逆勢追多。`
    : d.bias === 'bear'
    ? `整合多維度數據，AI 研判本週整體偏空，空方壓力較大，建議減少多頭曝險，等待市場企穩訊號後再操作。`
    : `各項指標分歧，AI 研判本週市場缺乏明確方向，多空力量相當，建議以觀望為主，等待突破訊號確立後再操作。`;

  const factorsHtml = factors.slice(0, 6).map(f => {
    const isBull = f.includes('偏多') || f.includes('看漲') || f.includes('淨流入') || f.includes('積極') || f.includes('動能升溫') || f.includes('多頭');
    const isBear = f.includes('偏空') || f.includes('看跌') || f.includes('流出') || f.includes('空頭') || f.includes('過熱') || f.includes('受壓');
    const clr    = isBull ? 'var(--bull)' : isBear ? 'var(--bear)' : 'var(--text2)';
    return `<div style="font-size:0.73rem;color:${clr};padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)">${isBull ? '▲' : isBear ? '▼' : '—'} ${f}</div>`;
  }).join('');

  // ── 本週已公布的重大數據（本週日之後，已過去）──
  const now = new Date();
  const weekStart = _getThisWeekSunday8am();
  const allWeekEvs = (() => {
    try {
      const evs = [];
      for (let d = 0; d <= 6; d++) {
        getUpcomingEconEvents(d).forEach(ev => {
          if (ev.impact === 'high' && ev.eventTime.getTime() >= weekStart && ev.eventTime.getTime() <= Date.now())
            evs.push(ev);
        });
      }
      return evs.sort((a, b) => a.eventTime - b.eventTime);
    } catch(e) { return []; }
  })();
  const pastEventsHtml = allWeekEvs.length
    ? `<div style="margin:8px 0 4px;font-size:0.68rem;font-weight:700;color:var(--text3);letter-spacing:.4px">📅 本週已公布重大數據</div>` +
      allWeekEvs.map(ev => {
        const dt = `${ev.eventTime.getMonth()+1}/${ev.eventTime.getDate()} ${String(ev.eventTime.getHours()).padStart(2,'0')}:${String(ev.eventTime.getMinutes()).padStart(2,'0')}`;
        return `<div style="font-size:0.72rem;color:var(--text3);padding:2px 0">📊 ${dt} ${ev.name}</div>`;
      }).join('')
    : '';

  // ── 顯示週期：本週日 → 下週日 ──
  const thisSun = new Date(weekStart);
  const nextSun = new Date(weekStart + 7 * 86400000);
  const fmt = d => `${d.getMonth()+1}/${d.getDate()}`;
  const weekRange = `${fmt(thisSun)}（日）→ ${fmt(nextSun)}（日）`;

  // 預測建立時間
  let createdAt = '—';
  try {
    const cached = JSON.parse(localStorage.getItem(_WEEKLY_BIAS_CACHE_KEY) || 'null');
    if (cached?.timestamp) createdAt = new Date(cached.timestamp).toLocaleString('zh-TW', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch(e) {}

  return `<div style="background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.18);border-radius:12px;padding:14px 16px;margin-bottom:10px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <span style="font-size:0.82rem;font-weight:700;color:var(--text2)">🤖 AI 本週走勢預測</span>
      <span style="font-size:0.7rem;color:var(--text3)" title="每週日 8:00 刷新">🔄 週日 8:00 更新</span>
    </div>
    ${aiOpinion ? `<div style="font-size:0.74rem;color:var(--text2);background:rgba(255,255,255,.05);border-left:3px solid ${biasColor};border-radius:0 7px 7px 0;padding:8px 12px;margin-bottom:10px;line-height:1.55">🤖 ${aiOpinion}</div>` : ''}
    <div style="font-size:0.68rem;color:var(--text3);margin-bottom:10px">📅 預測週期：${weekRange}　建立：${createdAt}</div>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
      <div style="font-size:1.4rem;font-weight:800;color:${biasColor}">${biasLabel}</div>
      <div>
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:3px">AI 風控分</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:80px;height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden">
            <div style="width:${confScore}%;height:100%;background:${confColor};border-radius:3px"></div>
          </div>
          <span style="font-size:0.8rem;font-weight:700;color:${confColor}">${confScore}%</span>
        </div>
      </div>
    </div>
    <div style="margin-bottom:8px">${factorsHtml}</div>
    ${pastEventsHtml}
    <div style="font-size:0.72rem;color:#f59e0b;background:rgba(245,158,11,.07);border-radius:7px;padding:6px 10px;margin-top:8px">
      ⚠️ ${riskNote}
    </div>
  </div>`;
}

/* ── 今日 AI 多空預測（資料層，供 widget 和 Telegram 共用）────── */
function computeTodayAIBias(fg, globalMkt) {
  // ── Load learning state & evaluate previous prediction ──
  const learn = _loadBiasLearning();
  let weights = learn.weights || {};
  const mktChg = globalMkt?.marketCapChange || 0;
  try {
    const prev = learn.dailyPred;
    if (prev && prev.timestamp) {
      const ageHours = (Date.now() - prev.timestamp) / 3600000;
      if (ageHours >= 20) { // 20+ hours old → evaluate yesterday's call
        weights = _adjustBiasWeights(weights, prev.bias, mktChg, prev.factorVotes || {}, 'daily');
      }
    }
  } catch(e) {}

  const fgVal  = fg ? parseInt(fg.value) : null;
  const btcDom = globalMkt?.btcDominance || 50;
  let bull = 0, bear = 0;
  const reasons = [];
  const factorVotes = {};

  const wFg   = _getBiasWeight(weights, 'daily_fg');
  const wMkt  = _getBiasWeight(weights, 'daily_mktChg');
  const wBtc  = _getBiasWeight(weights, 'daily_btcDom');
  const wTech = _getBiasWeight(weights, 'daily_techScan');

  // ① 恐慌貪婪（今日情緒）
  if (fgVal != null) {
    let v = 0;
    if (fgVal >= 65)      { v =  2; bull += 2 * wFg; reasons.push(`恐貪 ${fgVal}（極度貪婪），今日情緒強勢偏多`); }
    else if (fgVal >= 55) { v =  1; bull += 1 * wFg; reasons.push(`恐貪 ${fgVal}（貪婪），情緒偏多`); }
    else if (fgVal <= 35) { v = -2; bear += 2 * wFg; reasons.push(`恐貪 ${fgVal}（極度恐慌），今日情緒偏空`); }
    else if (fgVal <= 45) { v = -1; bear += 1 * wFg; reasons.push(`恐貪 ${fgVal}（恐慌），情緒偏空`); }
    else                  {                           reasons.push(`恐貪 ${fgVal}（中性），情緒均衡`); }
    factorVotes.fg = v;
  }
  // ② 市值變化（24h）
  if (mktChg > 2)       { factorVotes.mktChg =  2; bull += 2 * wMkt; reasons.push(`加密市值 +${mktChg.toFixed(1)}%，今日買盤積極`); }
  else if (mktChg > 0)  { factorVotes.mktChg =  1; bull += 1 * wMkt; reasons.push(`加密市值 +${mktChg.toFixed(1)}%，小幅成長`); }
  else if (mktChg < -2) { factorVotes.mktChg = -2; bear += 2 * wMkt; reasons.push(`加密市值 ${mktChg.toFixed(1)}%，今日賣壓明顯`); }
  else if (mktChg < 0)  { factorVotes.mktChg = -1; bear += 1 * wMkt; reasons.push(`加密市值 ${mktChg.toFixed(1)}%，輕微回調`); }
  else                  { factorVotes.mktChg =  0; }
  // ③ BTC 主導率
  if (btcDom > 58)      { factorVotes.btcDom = -1; bear += 1 * wBtc; reasons.push(`BTC主導 ${btcDom.toFixed(1)}%，山寨資金分散受壓`); }
  else if (btcDom < 44) { factorVotes.btcDom =  1; bull += 1 * wBtc; reasons.push(`BTC主導 ${btcDom.toFixed(1)}%，山寨季資金活躍`); }
  else                  { factorVotes.btcDom =  0; }
  // ④ 技術面掃描（state.data）
  const coins = (typeof state !== 'undefined' && state.data) ? state.data : [];
  if (coins.length) {
    const techBull    = coins.filter(c => c.score >= 65).length;
    const techBear    = coins.filter(c => c.score <= 35).length;
    const techBullPct = Math.round(techBull / coins.length * 100);
    const techBearPct = Math.round(techBear / coins.length * 100);
    if (techBullPct > 40)      { factorVotes.techScan =  2; bull += 2 * wTech; reasons.push(`技術面 ${techBullPct}% 幣種看漲，多頭動能佔優`); }
    else if (techBullPct > 25) { factorVotes.techScan =  1; bull += 1 * wTech; reasons.push(`技術面 ${techBullPct}% 幣種偏強`); }
    else if (techBearPct > 40) { factorVotes.techScan = -2; bear += 2 * wTech; reasons.push(`技術面 ${techBearPct}% 幣種看跌，空頭佔優`); }
    else if (techBearPct > 25) { factorVotes.techScan = -1; bear += 1 * wTech; reasons.push(`技術面 ${techBearPct}% 幣種偏弱`); }
    else                       { factorVotes.techScan =  0; reasons.push(`技術面多空均衡（看漲 ${techBullPct}% / 看跌 ${techBearPct}%）`); }
  }
  // ⑤ 日線多空分佈（幣種日線信號統計）
  const wDySig = _getBiasWeight(weights, 'daily_daySignal');
  if (coins.length) {
    const dyBull = coins.filter(c => c.dailySignal?.includes('bull')).length;
    const dyBear = coins.filter(c => c.dailySignal?.includes('bear')).length;
    const dyBullPct = Math.round(dyBull / coins.length * 100);
    const dyBearPct = Math.round(dyBear / coins.length * 100);
    if      (dyBullPct > 45) { factorVotes.daySignal =  2; bull += 2 * wDySig; reasons.push(`日線 ${dyBullPct}% 幣種多頭，今日多方佔優`); }
    else if (dyBullPct > 28) { factorVotes.daySignal =  1; bull += 1 * wDySig; reasons.push(`日線 ${dyBullPct}% 幣種偏多`); }
    else if (dyBearPct > 45) { factorVotes.daySignal = -2; bear += 2 * wDySig; reasons.push(`日線 ${dyBearPct}% 幣種空頭，今日空方佔優`); }
    else if (dyBearPct > 28) { factorVotes.daySignal = -1; bear += 1 * wDySig; reasons.push(`日線 ${dyBearPct}% 幣種偏空`); }
    else                     { factorVotes.daySignal =  0; reasons.push(`日線多空均衡（多頭 ${dyBullPct}% / 空頭 ${dyBearPct}%）`); }
  }
  // ⑥ 今日RSI極端讀數
  const wRsiD = _getBiasWeight(weights, 'daily_rsi');
  if (coins.length) {
    const rsiOBD = coins.filter(c => (parseFloat(c.rsi)||50) > 70).length;
    const rsiOSD = coins.filter(c => (parseFloat(c.rsi)||50) < 30).length;
    const rsiOBPct = Math.round(rsiOBD / coins.length * 100);
    const rsiOSPct = Math.round(rsiOSD / coins.length * 100);
    if      (rsiOBPct > 35) { factorVotes.rsiD = -1; bear += 1 * wRsiD; reasons.push(`${rsiOBPct}% 幣種 RSI 超買，短線過熱壓力`); }
    else if (rsiOSPct > 30) { factorVotes.rsiD =  1; bull += 1 * wRsiD; reasons.push(`${rsiOSPct}% 幣種 RSI 超賣，超賣反彈動能`); }
    else                    { factorVotes.rsiD =  0; }
  }
  // ⑦ 籌碼流向（Taker 買賣比聚合）
  const wChipsD = _getBiasWeight(weights, 'daily_chips');
  const _dDrvCoins = coins.filter(c => c.derivData?.takerBuySell != null);
  if (_dDrvCoins.length >= 3) {
    const avgTkrD = _dDrvCoins.reduce((s, c) => s + c.derivData.takerBuySell, 0) / _dDrvCoins.length;
    if      (avgTkrD > 1.08) { factorVotes.chipsD =  2; bull += 2 * wChipsD; reasons.push(`Taker 買賣比 ${avgTkrD.toFixed(2)}，今日買盤主導`); }
    else if (avgTkrD > 1.02) { factorVotes.chipsD =  1; bull += 1 * wChipsD; reasons.push(`Taker 比 ${avgTkrD.toFixed(2)}，買方小幅佔優`); }
    else if (avgTkrD < 0.92) { factorVotes.chipsD = -2; bear += 2 * wChipsD; reasons.push(`Taker 買賣比 ${avgTkrD.toFixed(2)}，今日賣盤主導`); }
    else if (avgTkrD < 0.98) { factorVotes.chipsD = -1; bear += 1 * wChipsD; reasons.push(`Taker 比 ${avgTkrD.toFixed(2)}，賣方小幅佔優`); }
    else                     { factorVotes.chipsD =  0; }
  }
  // ⑧ 動能分佈（多空動能比例）
  const wMomD = _getBiasWeight(weights, 'daily_momentum');
  if (coins.length) {
    const momBull = coins.filter(c => (parseFloat(c.momentum)||0) > 0).length;
    const momBullPct = Math.round(momBull / coins.length * 100);
    if      (momBullPct > 60) { factorVotes.momentum =  1; bull += 1 * wMomD; reasons.push(`${momBullPct}% 幣種動能向上，上行力道確認`); }
    else if (momBullPct < 40) { factorVotes.momentum = -1; bear += 1 * wMomD; reasons.push(`${100-momBullPct}% 幣種動能向下，下行壓力增加`); }
    else                      { factorVotes.momentum =  0; }
  }

  // ⑨ MACD 動能分佈（今日動能多空格局）
  const wMacdD = _getBiasWeight(weights, 'daily_macdDist');
  if (coins.length) {
    const _dMacdBull = coins.filter(c => (parseFloat(c.macdHist)||0) > 0).length;
    const _dMacdBullPct = Math.round(_dMacdBull / coins.length * 100);
    if (_dMacdBullPct > 62) {
      factorVotes.macdDistD = 1; bull += 1 * wMacdD;
      reasons.push(`${_dMacdBullPct}% 幣種 MACD 動能向上，今日多頭動能佔優`);
    } else if (_dMacdBullPct < 38) {
      factorVotes.macdDistD = -1; bear += 1 * wMacdD;
      reasons.push(`${100-_dMacdBullPct}% 幣種 MACD 動能向下，今日空頭動能佔優`);
    } else { factorVotes.macdDistD = 0; }
  }
  // ⑩ ADX 趨勢確立率（高 = 方向確定性強）
  const wAdxDistD = _getBiasWeight(weights, 'daily_adxDist');
  if (coins.length) {
    const _dAdxTrend = coins.filter(c => (parseFloat(c.adx)||0) >= 25).length;
    const _dAdxPct   = Math.round(_dAdxTrend / coins.length * 100);
    if (_dAdxPct > 55) {
      factorVotes.adxDistD = 1; bull += 0.5 * wAdxDistD;
      reasons.push(`${_dAdxPct}% 幣種趨勢確立，今日市場方向性強`);
    } else if (_dAdxPct < 28) {
      factorVotes.adxDistD = -1; bear += 0.5 * wAdxDistD;
      reasons.push(`僅 ${_dAdxPct}% 幣種趨勢確立，今日震盪為主，訊號可靠性低`);
    } else { factorVotes.adxDistD = 0; }
  }
  // ⑪ 足跡圖累積 Delta 聚合（以已緩存的幣種足跡圖推算今日流向）
  const _fpEntries = Object.values(_footprintCache).filter(fp => fp && fp.deltaDir !== 'neutral');
  if (_fpEntries.length >= 1) {
    const wFpD = _getBiasWeight(weights, 'daily_fpDelta');
    const fpBullN = _fpEntries.filter(fp => fp.deltaDir === 'bull').length;
    const fpBearN = _fpEntries.filter(fp => fp.deltaDir === 'bear').length;
    const fpTotal = _fpEntries.length;
    const fpBullPct = Math.round(fpBullN / fpTotal * 100);
    const fpBearPct = Math.round(fpBearN / fpTotal * 100);
    const fpDivN = _fpEntries.filter(fp => fp.deltaDiv).length;
    if (fpBullPct >= 70) {
      factorVotes.fpDelta = 2; bull += 2 * wFpD;
      reasons.push(`足跡圖 ${fpBullPct}% 幣種 Delta 偏多，今日主動買盤主導（${fpBullN}/${fpTotal}幣種）`);
    } else if (fpBullPct >= 55) {
      factorVotes.fpDelta = 1; bull += 1 * wFpD;
      reasons.push(`足跡圖多數幣種 Delta 偏多（${fpBullPct}%），買盤小幅佔優`);
    } else if (fpBearPct >= 70) {
      factorVotes.fpDelta = -2; bear += 2 * wFpD;
      reasons.push(`足跡圖 ${fpBearPct}% 幣種 Delta 偏空，今日賣盤主導（${fpBearN}/${fpTotal}幣種）`);
    } else if (fpBearPct >= 55) {
      factorVotes.fpDelta = -1; bear += 1 * wFpD;
      reasons.push(`足跡圖多數幣種 Delta 偏空（${fpBearPct}%），賣盤小幅佔優`);
    } else {
      factorVotes.fpDelta = 0;
    }
    if (fpDivN >= Math.ceil(fpTotal * 0.5)) {
      bear += 0.5;
      reasons.push(`足跡圖偵測 ${fpDivN} 幣種 Delta 背離，趨勢動能可疑`);
    }
  }
  // ⑫ 市場微結構質量（Tick 品質 + VWAP 偏離聚合）
  const _fpMsqEntries = Object.values(_footprintCache).filter(fp => fp && fp.microstructureQuality != null);
  if (_fpMsqEntries.length >= 1) {
    const wMsq = _getBiasWeight(weights, 'daily_microstructure');
    const avgMsq = _fpMsqEntries.reduce((s, fp) => s + fp.microstructureQuality, 0) / _fpMsqEntries.length;
    const highNoiseFps = _fpMsqEntries.filter(fp => fp.bidAskBounceScore > 65).length;
    const highNoiseRatio = highNoiseFps / _fpMsqEntries.length;
    if (avgMsq >= 70 && highNoiseRatio < 0.2) {
      factorVotes.microstructure = 1; bull += 1 * wMsq;
      reasons.push(`市場微結構質量良好（平均 ${avgMsq.toFixed(0)} 分），Tick 訂單流方向一致，訊號可靠性高`);
    } else if (highNoiseRatio > 0.5) {
      factorVotes.microstructure = -1; bear += 1 * wMsq;
      reasons.push(`⚠️ ${(highNoiseRatio*100).toFixed(0)}% 幣種 Tick 存在 Bid-Ask Bounce 高噪音，市場微結構不穩定，訊號可靠性下降`);
    } else {
      factorVotes.microstructure = 0;
    }
    // VWAP 偏離聚合：多數幣種偏離 VWAP > 1.5% → 均值回歸風險
    const fpWithVwap = _fpMsqEntries.filter(fp => fp.vwap && fp.lastClose);
    if (fpWithVwap.length >= 2) {
      const aboveVwap = fpWithVwap.filter(fp => fp.lastClose > fp.vwap * 1.015).length;
      const belowVwap = fpWithVwap.filter(fp => fp.lastClose < fp.vwap * 0.985).length;
      const abovePct = Math.round(aboveVwap / fpWithVwap.length * 100);
      const belowPct = Math.round(belowVwap / fpWithVwap.length * 100);
      if (abovePct > 60) {
        bear += 0.5;
        reasons.push(`${abovePct}% 幣種顯著偏離 VWAP 向上（>1.5%），均值回歸風險，追漲謹慎`);
      } else if (belowPct > 60) {
        bull += 0.5;
        reasons.push(`${belowPct}% 幣種顯著偏離 VWAP 向下（>1.5%），超賣反彈機會，可關注做多`);
      }
    }
  }

  // ⑤ 今日高影響數據事件 + 政策訊息（最關鍵因素，加強預測精度）
  const todayEvs = getTodayEconEvents();
  const highEvs  = todayEvs.filter(ev => ev.impact === 'high');
  const nowMs    = Date.now();
  // 分為「即將（<1小時）」「臨近（1-6小時）」「較遠（>6小時）」
  const imminent = [], near = [], far = [];
  highEvs.forEach(ev => {
    const mins = (ev.eventTime.getTime() - nowMs) / 60000;
    if (mins > -120 && mins < 720) {
      if (mins > -30 && mins < 60) imminent.push({ ...ev, mins });      // <1小時：高風險
      else if (mins >= 60 && mins < 360) near.push({ ...ev, mins });    // 1-6小時：中風險
      else far.push({ ...ev, mins });
    }
  });

  // 即將公布 = 不確定性極高，大幅減少今日信心
  imminent.forEach(ev => {
    bear += 1.0;  // 加強扣分
    const timeLabel = ev.mins < 0 ? '已公布' : `${Math.round(ev.mins)}分鐘後`;
    reasons.push(`🚨 <b>${ev.name}（${timeLabel}）</b>：${ev.aiPred ? `預測 ${ev.aiPred}（信心 ${ev.aiConf}%）` : '極高風險，建議觀望'}`);
  });

  // 臨近公布 = 中等不確定
  near.forEach(ev => {
    bear += 0.5;
    const timeLabel = `${(ev.mins / 60).toFixed(0)}小時後`;
    reasons.push(`⚠️ ${ev.name}（${timeLabel}）：${ev.aiPred || '高影響數據待公布'}`);
  });

  // 較遠或已公布 = 監測作用，不扣分
  const relevantHighEvs = imminent.concat(near);

  const score    = bull - bear;
  const absScore = Math.abs(score);
  const bias = score >= 2 ? 'bull' : score <= -2 ? 'bear'
             : score > 0 ? 'slight_bull' : score < 0 ? 'slight_bear' : 'neutral';
  const biasLabel = { bull:'▲ 偏多', bear:'▼ 偏空', slight_bull:'▲ 小幅偏多', slight_bear:'▼ 小幅偏空', neutral:'◆ 中性觀望' }[bias];
  const biasColor = bias.includes('bull') ? 'var(--bull)' : bias.includes('bear') ? 'var(--bear)' : 'var(--text3)';
  // 提升日預測區分度：強信號提升 +6，加上高影響事件扣分
  const conf = Math.max(30, Math.min(88, 45 + absScore * 10 + (bias !== 'neutral' && bias.includes !== 'slight' ? 6 : 0) + (fgVal != null ? 4 : 0) - relevantHighEvs.length * 5));
  const confColor = conf >= 65 ? 'var(--bull)' : conf >= 50 ? '#f0a500' : 'var(--text3)';
  const riskNote = relevantHighEvs.length > 0
    ? `今日 ${relevantHighEvs.length} 項高影響數據（${relevantHighEvs.map(ev => { const m = (ev.eventTime.getTime()-nowMs)/60000; return ev.name + (m < 0 ? '已公布' : m < 60 ? `${Math.round(m)}分後` : `${(m/60).toFixed(1)}h後`); }).join('、')}），建議等公布後確認方向再操作`
    : '今日無近期高影響數據，技術面主導，可依訊號正常操作';

  // ── Persist current prediction for future self-evaluation ──
  try {
    learn.dailyPred = { bias, factorVotes, mktChgAtTime: mktChg, timestamp: Date.now() };
    learn.weights = weights;
    _saveBiasLearning(learn);
  } catch(e) {}

  const aiOpinion = (bias === 'bull' || bias === 'slight_bull')
    ? `整合今日情緒、技術面、籌碼及動能數據，AI 研判今日市場${bias === 'bull' ? '明確偏多' : '小幅偏多'}，買方力道佔優，可關注做多機會。`
    : (bias === 'bear' || bias === 'slight_bear')
    ? `整合今日多維數據，AI 研判今日市場${bias === 'bear' ? '明確偏空' : '小幅偏空'}，賣方壓力較大，建議謹慎操作，控制多頭倉位。`
    : `今日多項指標中性，AI 研判市場無明確方向，建議觀望，等待日線/4H訊號確立後再操作。`;

  return { bias, biasLabel, biasColor, conf, confColor, reasons, highEvs, riskNote, rangeMode: bias === 'neutral' || bias === 'slight_bull' || bias === 'slight_bear', aiOpinion };
}

function buildTodayAIBiasHtml(fg, globalMkt) {
  const _td = computeTodayAIBias(fg, globalMkt);
  const { biasLabel, biasColor, conf, confColor, reasons, riskNote } = _td;
  // 每次從 bias 重新生成（確保不依賴快取欄位）
  const aiOpinion = (_td.bias === 'bull' || _td.bias === 'slight_bull')
    ? `整合今日情緒、技術面、籌碼及動能數據，AI 研判今日市場${_td.bias === 'bull' ? '明確偏多' : '小幅偏多'}，買方力道佔優，可關注做多機會。`
    : (_td.bias === 'bear' || _td.bias === 'slight_bear')
    ? `整合今日多維數據，AI 研判今日市場${_td.bias === 'bear' ? '明確偏空' : '小幅偏空'}，賣方壓力較大，建議謹慎操作，控制多頭倉位。`
    : `今日多項指標中性，AI 研判市場無明確方向，建議觀望，等待日線/4H訊號確立後再操作。`;
  const reasonsHtml = reasons.slice(0, 5).map(r => {
    const isBull = /偏多|看漲|積極|多頭|活躍/.test(r);
    const isBear = /偏空|看跌|流出|空頭|承壓|受壓|賣壓/.test(r);
    const clr = isBull ? 'var(--bull)' : isBear ? 'var(--bear)' : 'var(--text2)';
    return `<div style="font-size:0.73rem;color:${clr};padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)">${isBull ? '▲' : isBear ? '▼' : '—'} ${r}</div>`;
  }).join('');
  return `<div style="background:rgba(34,197,94,.05);border:1px solid rgba(34,197,94,.18);border-radius:12px;padding:14px 16px;margin-bottom:10px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:0.82rem;font-weight:700;color:var(--text2)">📅 今日 AI 多空預測</span>
      <span style="font-size:0.72rem;color:var(--text3)">${new Date().toLocaleDateString('zh-TW',{month:'2-digit',day:'2-digit'})}</span>
    </div>
    ${aiOpinion ? `<div style="font-size:0.74rem;color:var(--text2);background:rgba(255,255,255,.05);border-left:3px solid ${biasColor};border-radius:0 7px 7px 0;padding:8px 12px;margin-bottom:12px;line-height:1.55">🤖 ${aiOpinion}</div>` : ''}
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
      <div style="font-size:1.4rem;font-weight:800;color:${biasColor}">${biasLabel}</div>
      <div>
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:3px">AI 風控分</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:80px;height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden">
            <div style="width:${conf}%;height:100%;background:${confColor};border-radius:3px"></div>
          </div>
          <span style="font-size:0.8rem;font-weight:700;color:${confColor}">${conf}%</span>
        </div>
      </div>
    </div>
    <div style="margin-bottom:10px">${reasonsHtml}</div>
    <div style="font-size:0.72rem;color:#f59e0b;background:rgba(245,158,11,.07);border-radius:7px;padding:6px 10px">⚠️ ${riskNote}</div>
  </div>`;
}

function getNthWeekdayOfMonth(year, month, weekday, n) {
  // Returns the date of the n-th occurrence of weekday in given month (month: 0-indexed)
  const date = new Date(year, month, 1);
  let count = 0;
  while (date.getMonth() === month) {
    if (date.getDay() === weekday) {
      count++;
      if (count === n) return new Date(date);
    }
    date.setDate(date.getDate() + 1);
  }
  return null;
}

function getMonthEconEvents(year, month) {
  // month: 0-indexed
  const events = [];
  for (const ev of MONTHLY_DATA_SCHEDULE) {
    const date = getNthWeekdayOfMonth(year, month, ev.dayOfWeek, ev.weekOfMonth);
    if (!date) continue;
    const eventTime = new Date(date);
    eventTime.setHours(ev.twHour, ev.twMin, 0, 0);
    const daysFromNow = Math.round((eventTime - new Date()) / 86400000);
    events.push({ ...ev, eventTime, type: 'monthly', date, daysFromNow });
  }
  // Also include weekly events for the same month
  // Find all days in the month, check WEEKLY_DATA_SCHEDULE
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const ev of WEEKLY_DATA_SCHEDULE) {
      if (ev.dayOfWeek === dow) {
        const eventTime = new Date(d);
        eventTime.setHours(ev.twHour, ev.twMin, 0, 0);
        const daysFromNow = Math.round((eventTime - new Date()) / 86400000);
        events.push({ ...ev, eventTime, type: 'weekly', date: new Date(d), daysFromNow });
      }
    }
  }
  return events.sort((a, b) => a.eventTime - b.eventTime);
}

function getEconActualValue(eventName, dateStr) {
  const key = `econ_actual_${eventName}_${dateStr}`;
  return localStorage.getItem(key) || '';
}

function setEconActualValue(eventName, dateStr, value) {
  const key = `econ_actual_${eventName}_${dateStr}`;
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

// 已公布的實際數值（以 "事件名稱_dateKey" 為索引，dateKey 格式：year-month0indexed-day）
// 資料來源：BLS / EIA / Census Bureau / Federal Reserve / ADP Research
const KNOWN_ACTUALS = {
  // ── 2026 年 5 月公布的月度數據（4 月份數據）─────────────────────
  // NFP：+115K（預期+60K）→ 就業強勁，降息延後，加密短線承壓
  '美國非農就業報告（NFP）_2026-4-1':   '+115K（預期+60K，遠超預期；失業率維持4.3%，時薪年增3.6%）',
  // ADP：+109K（預期+99K）→ 就業強勁，加密偏空
  'ADP 就業人數_2026-4-6':              '+109K（預期+99K，勝出；服務業+94K為主力）',
  // CPI：+3.8% YoY（預期3.7%）→ 通膨高於預期，鷹派，加密偏空
  '美國消費者物價指數（CPI）_2026-4-12': '+3.8% YoY / +0.6% MoM（預期3.7%，高於預期；油價+3.8%為主因）',
  // PPI：+6.0% YoY（最大年增幅）→ 生產端通膨壓力大，加密偏空
  '美國生產者物價指數（PPI）_2026-4-13': '+6.0% YoY / +1.4% MoM（2022年12月來最大年增幅，高於預期）',
  // 零售銷售：+0.5% MoM（符合預期）→ 通膨推升名目值，實際消費疲弱，中性
  '美國零售銷售_2026-4-19':             '+0.5% MoM / +4.9% YoY（符合預期；扣除油站後實際消費疲軟）',

  // ── EIA 原油庫存（每週三 22:30 台灣時間）────────────────────────
  // 去庫存（負值）= 能源需求增 = 通膨升溫 = 對加密中性略偏多
  // 增庫存（正值）= 供過於求 = 通縮壓力 = 風險情緒下行 = 加密偏空
  'EIA 原油庫存_2026-4-6':  '-2.314M 桶（週截至4/30；低於預期-3.3M；去庫存幅度不如預期，偏中性）',
  'EIA 原油庫存_2026-4-13': '-4.306M 桶（週截至5/8；大幅超越預期-2.1M；庫存快速去化，能源通膨升溫）',
  'EIA 原油庫存_2026-4-20': '+5.5M 桶（週截至5/15；意外大幅增庫存，遠超市場預期；通縮壓力加劇）',
  'EIA 原油庫存_2026-4-27': '（紀念日假期延至5/28週四公布；數據請於今日稍晚確認）',

  // ── FOMC 紀要（每6~8週發布一次，非每週；其餘週標注無發布）────────
  'FOMC 紀要_2026-4-6':  '（本週無FOMC紀要；4/28-29會議紀要定於5/20發布）',
  'FOMC 紀要_2026-4-13': '（本週無FOMC紀要）',
  // 5/20 為真正的FOMC紀要發布日（4/28-29會議）
  // 鷹派：4名官員異議 → 年內降息預期大幅下修 → 加密強烈偏空
  'FOMC 紀要_2026-4-20': '鷹派傾向：4名官員異議（1票主張降息、3票反對寬鬆偏向），年內降息預期大幅下修，委員憂慮伊朗戰爭推升油價通膨，維持高利率展望',
  'FOMC 紀要_2026-4-27': '（本週無FOMC紀要；下次6月FOMC會議）',

  // ── 美國初請失業金人數（每週四 20:30 台灣時間）──────────────────
  // 注意反向邏輯：低於預期 = 就業強勁 = 鷹派 = 加密短線承壓
  //              高於預期 = 就業疲軟 = 降息預期升 = 加密偏多
  '美國初請失業金人數_2026-4-7':  '200K（週截至5/2；低於預期205K，4週均值觸近年低；就業市場強勁）',
  '美國初請失業金人數_2026-4-14': '212K（週截至5/9；高於前值200K；就業市場略轉弱）',
  '美國初請失業金人數_2026-4-21': '209K（週截至5/16；4週均值202.5K；低於預期210K，就業仍穩健）',
  '美國初請失業金人數_2026-4-28': '209K（週截至5/22；前值209K；維持低位，就業市場穩健）',
};

const BLS_SERIES_MAP = {
  '美國非農就業報告（NFP）':  { id: 'CES0000000001', type: 'monthly_change', multiplier: 1/1000, unit: 'K', dp: 0 },
  '美國消費者物價指數（CPI）': { id: 'CUUR0000SA0',  type: 'yoy_pct', unit: '%', dp: 1 },
  '美國生產者物價指數（PPI）': { id: 'WPU000000000', type: 'yoy_pct', unit: '%', dp: 1 },
};

const _econFetchFailed = new Set(); // 追蹤 BLS 抓取失敗的事件，避免無限 Loading

function analyzeFOMCText(text) {
  const lc = text.toLowerCase();

  const hawkKws = ['higher for longer','rate increase','raise rates','tighten','restrictive',
    'inflation elevated','above 2 percent','above target','quantitative tightening',
    'balance sheet reduction','hike','hiking','hawkish','keep rates high','strong labor'];
  const doveKws = ['rate cut','lower rates','easing','accommodative','dovish','pause',
    'below target','cooling','reduction in rates','quantitative easing','cut rates',
    'slow the pace','slower growth','labor market softening'];
  const holdKws = ['maintain','unchanged','hold','data dependent','patient','monitor','cautious'];

  let hawkScore = 0, doveScore = 0;
  const matchedHawk = [], matchedDove = [];
  for (const kw of hawkKws) { if (lc.includes(kw)) { hawkScore++; matchedHawk.push(kw); } }
  for (const kw of doveKws) { if (lc.includes(kw)) { doveScore++; matchedDove.push(kw); } }
  let holdScore = 0;
  for (const kw of holdKws) { if (lc.includes(kw)) holdScore++; }

  // Extract rate level (e.g. "5.25 percent" or "4.5%")
  const rateMatch = text.match(/(\d+\.?\d*)\s*(?:percent|%)/i);
  const rateStr = rateMatch ? ` 利率 ${rateMatch[1]}%` : '';

  // Extract up to 3 key sentences containing signal keywords
  const allKws = [...hawkKws, ...doveKws, 'inflation', 'interest rate', 'employment', 'economy', 'target', 'growth'];
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 30 && s.length < 220);
  const keySentences = [];
  for (const s of sentences) {
    if (keySentences.length >= 3) break;
    if (allKws.some(kw => s.toLowerCase().includes(kw))) keySentences.push(s);
  }

  // Determine stance
  let stance, emoji, impact;
  if (hawkScore > doveScore + 1) {
    stance = '鷹派'; emoji = '🔴';
    impact = '偏空 ── 高利率持續壓制風險資產，加密流動性收緊';
  } else if (doveScore > hawkScore) {
    stance = '鴿派'; emoji = '🟢';
    impact = '偏多 ── 降息/寬鬆釋放流動性，有利加密等風險資產';
  } else if (holdScore > 0) {
    stance = '按兵不動'; emoji = '⚪';
    impact = '中性 ── 政策維持不變，加密短線觀望震盪';
  } else {
    stance = '中性'; emoji = '⚪';
    impact = '中性 ── 方向不明，加密市場短期波動';
  }

  let out = `${emoji} ${stance}${rateStr}（鷹×${hawkScore} 鴿×${doveScore}）\n`;
  out    += `📊 多空影響：${impact}\n`;
  if (keySentences.length > 0) {
    out += `📌 關鍵摘句：\n`;
    for (const s of keySentences) out += `• ${s.slice(0, 90)}${s.length > 90 ? '…' : ''}\n`;
  }
  return out.trim();
}

async function autoFetchEconActual(eventName, dateKey) {
  const lookupKey = `${eventName}_${dateKey}`;

  // 1. 優先使用已知實際值（最可靠，無需網路）
  if (KNOWN_ACTUALS[lookupKey]) {
    const v = KNOWN_ACTUALS[lookupKey];
    setEconActualValue(eventName, dateKey, v);
    return v;
  }

  // 2. 本地快取
  const cacheKey = `econ_bls_cache_${lookupKey}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;

  // 3. BLS API（嘗試多個 CORS 代理，任一成功即用）
  const mapping = BLS_SERIES_MAP[eventName];
  if (!mapping) { _econFetchFailed.add(lookupKey); return null; }

  const blsUrl = `https://api.bls.gov/publicAPI/v1/timeseries/data/${mapping.id}`;
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(blsUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(blsUrl)}`,
  ];
  for (const proxyUrl of proxies) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(proxyUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const rows = json?.Results?.series?.[0]?.data;
      if (!rows || rows.length < 2) continue;
      let display;
      if (mapping.type === 'monthly_change') {
        const change = (parseFloat(rows[0].value) - parseFloat(rows[1].value)) * mapping.multiplier;
        display = `${change >= 0 ? '+' : ''}${change.toFixed(mapping.dp)}${mapping.unit}`;
      } else {
        const latest = rows[0];
        const prevYear = rows.find(r => r.periodName === latest.periodName && r.year === String(parseInt(latest.year) - 1));
        if (!prevYear) continue;
        const yoy = (parseFloat(latest.value) / parseFloat(prevYear.value) - 1) * 100;
        display = `${yoy >= 0 ? '+' : ''}${yoy.toFixed(mapping.dp)}${mapping.unit}`;
      }
      localStorage.setItem(cacheKey, display);
      setTimeout(() => localStorage.removeItem(cacheKey), 6 * 3600 * 1000);
      return display;
    } catch(e) { /* try next proxy */ }
  }
  // FOMC 紀要：抓聯準會 RSS → 取得最新聲明文字 → AI 分析多空影響
  if (eventName === 'FOMC 紀要') {
    const fedRssUrl = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
    const rssProxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(fedRssUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(fedRssUrl)}`,
    ];
    for (const proxyUrl of rssProxies) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const res = await fetch(proxyUrl, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const xmlText = await res.text();
        // Extract first item's title + description from RSS
        const titleMatch = xmlText.match(/<item[^>]*>[\s\S]*?<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
        const descMatch  = xmlText.match(/<item[^>]*>[\s\S]*?<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
        const linkMatch  = xmlText.match(/<item[^>]*>[\s\S]*?<link[^>]*>([\s\S]*?)<\/link>/);
        const title = (titleMatch?.[1] || '').trim();
        const desc  = (descMatch?.[1]  || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!title && !desc) continue;
        const docText = `${title}\n\n${desc}`;
        const analysis = analyzeFOMCText(docText);
        const display = `📰 ${title.slice(0, 50)}\n${analysis}`;
        localStorage.setItem(cacheKey, display);
        setTimeout(() => localStorage.removeItem(cacheKey), 6 * 3600 * 1000);
        setEconActualValue(eventName, dateKey, display);
        return display;
      } catch(e) { /* try next proxy */ }
    }
    // Final fallback: get Fed Funds Rate direction from FRED
    const fredUrl = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS';
    const fredProxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(fredUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(fredUrl)}`,
    ];
    for (const proxyUrl of fredProxies) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(proxyUrl, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const csv = await res.text();
        const lines = csv.trim().split('\n').slice(1).filter(l => l.trim());
        if (lines.length < 2) continue;
        const rows = lines.map(l => { const [d, v] = l.split(','); return { date: d?.trim(), value: parseFloat(v) }; }).filter(r => !isNaN(r.value));
        if (rows.length < 2) continue;
        const latest = rows[rows.length - 1];
        const prev   = rows[rows.length - 2];
        const diff   = +(latest.value - prev.value).toFixed(2);
        let display;
        if (diff > 0.1)       display = `升息至 ${latest.value}%（鷹派，加密偏空；前值 ${prev.value}%）`;
        else if (diff < -0.1) display = `降息至 ${latest.value}%（鴿派，加密偏多；前值 ${prev.value}%）`;
        else                  display = `維持 ${latest.value}%（不動，中性；前值 ${prev.value}%）`;
        localStorage.setItem(cacheKey, display);
        setTimeout(() => localStorage.removeItem(cacheKey), 6 * 3600 * 1000);
        setEconActualValue(eventName, dateKey, display);
        return display;
      } catch(e) { /* try next proxy */ }
    }
  }

  _econFetchFailed.add(lookupKey);
  return null;
}

function generateActualValueAnalysis(ev, actualVal) {
  if (!actualVal) return '';
  // 佔位值（無紀要/待確認）：僅顯示 info 提示，不做方向分析
  const isPlaceholder = actualVal.includes('待確認') || actualVal.includes('無FOMC') ||
                        actualVal.includes('稍晚公布') || actualVal.includes('未查得') ||
                        actualVal.includes('定於') || actualVal.includes('假期延');
  if (isPlaceholder) {
    return `<div style="margin-top:6px;font-size:0.71rem;color:var(--text3);padding:6px 10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:6px">ℹ️ ${actualVal}</div>`;
  }

  const pred   = ev.aiPred   || '';
  const impact = ev.aiMarketImpact || '';
  const av = actualVal;
  const avL = av.toLowerCase();

  let isBear = false, isBull = false, bearReason = '', bullReason = '';

  if (ev.name.includes('失業金') || ev.name.includes('初請')) {
    // ⚠️ 反向邏輯：低於預期 = 就業強勁 = 降息預期降 = 加密承壓（偏空）
    isBear = avL.includes('低於') || avL.includes('強勁') || avL.includes('承壓') || avL.includes('鷹派');
    isBull = avL.includes('高於') || avL.includes('轉弱') || avL.includes('疲軟') || avL.includes('降息預期升');
    bearReason = '就業強勁 → 聯準會維持鷹派 → 加密短線承壓';
    bullReason = '就業轉弱 → 降息預期升溫 → 加密偏多';
  } else if (ev.name.includes('NFP') || ev.name.includes('非農') || ev.name.includes('ADP')) {
    // 就業增加超預期 = 鷹派 = 加密偏空
    isBear = avL.includes('勝出') || avL.includes('高於') || avL.includes('遠超') || avL.includes('強勁');
    isBull = avL.includes('低於') || avL.includes('疲軟') || avL.includes('未達');
    bearReason = '就業超預期 → 聯準會降息延後 → 加密短線承壓';
    bullReason = '就業低於預期 → 降息預期升溫 → 加密偏多';
  } else if (ev.name.includes('CPI') || ev.name.includes('PPI') || ev.name.includes('物價')) {
    isBear = avL.includes('高於') || avL.includes('超預期') || avL.includes('升溫') || avL.includes('升幅');
    isBull = avL.includes('低於') || avL.includes('降溫') || avL.includes('回落') || avL.includes('符合');
    bearReason = '通膨高於預期 → 高利率延長 → 加密承壓';
    bullReason = '通膨降溫 → 降息預期升 → 加密偏多';
  } else if (ev.name.includes('零售')) {
    // 零售數據：強勁消費 → 經濟好 → 可能鷹派；但也可通膨驅動（名目 vs 實質）
    isBull = avL.includes('低於') || avL.includes('疲軟') || avL.includes('疲弱');
    isBear = avL.includes('高於') || avL.includes('強勁') || avL.includes('超預期');
    bearReason = '消費強勁 → 聯準會維持緊縮 → 加密中性偏空';
    bullReason = '消費疲軟 → 降息預期升 → 加密偏多';
  } else if (ev.name.includes('EIA') || ev.name.includes('原油')) {
    const numMatch = av.match(/([+-]?\d+\.?\d*)\s*M?\s*桶/);
    if (numMatch) {
      const n = parseFloat(numMatch[1]);
      isBull = n < 0;   // 去庫存 → 能源需求增 → 通膨升 → 中性略偏多
      isBear = n > 0;   // 增庫存 → 供過於求 → 通縮壓力 → 風險情緒轉差
    }
    bearReason = '原油庫存增加 → 供過於求 → 通縮壓力 → 風險情緒下行';
    bullReason = '原油去庫存 → 能源需求增 → 通膨預期升溫 → 中性偏多';
  } else if (ev.name.includes('FOMC')) {
    isBear = avL.includes('鷹派') || avL.includes('維持高利率') || avL.includes('通膨') || avL.includes('異議');
    isBull = avL.includes('鴿派') || avL.includes('降息') || (avL.includes('寬鬆') && !avL.includes('反對寬鬆'));
    bearReason = 'FOMC鷹派 → 高利率維持 → 流動性緊縮 → 加密承壓';
    bullReason = 'FOMC鴿派 → 降息預期升 → 流動性增加 → 加密偏多';
  } else {
    isBear = avL.includes('高於') || avL.includes('超預期');
    isBull = avL.includes('低於') || avL.includes('降溫');
  }

  const dirLabel = isBear ? '🔴 偏空（Bearish）' : isBull ? '🟢 偏多（Bullish）' : '⚪ 中性（Neutral）';
  const dirColor = isBear ? 'var(--bear)' : isBull ? 'var(--bull)' : 'var(--text3)';
  const dirReason = isBear ? bearReason : isBull ? bullReason : '影響有限，等待更多數據確認方向';

  // 提取數值部分（括號前）和備注（括號內）
  const mainVal = av.split('（')[0].trim();
  const detailVal = av.includes('（') ? av.slice(av.indexOf('（') + 1).replace(/\）?$/, '') : '';

  return `<div style="margin-top:8px;padding:10px 12px;background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.18);border-radius:8px">
    <div style="font-size:0.72rem;font-weight:700;color:var(--accent);margin-bottom:7px">📊 AI 市場影響分析</div>
    ${pred ? `<div style="font-size:0.71rem;color:var(--text3);margin-bottom:5px">🤖 AI 預測：${pred}</div>` : ''}
    <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:5px;flex-wrap:wrap">
      <span style="font-size:0.73rem;font-weight:700;color:var(--accent)">實際：${mainVal}</span>
      ${detailVal ? `<span style="font-size:0.7rem;color:var(--text3)">${detailVal}</span>` : ''}
    </div>
    <div style="font-size:0.73rem;font-weight:700;color:${dirColor};margin-bottom:4px">${dirLabel}</div>
    <div style="font-size:0.71rem;color:var(--text2);margin-bottom:${impact ? '5px' : '0'}">${dirReason}</div>
    ${impact ? `<div style="font-size:0.71rem;color:var(--text3);border-top:1px solid rgba(255,255,255,.07);padding-top:5px">💡 ${impact}</div>` : ''}
  </div>`;
}

function buildTodayEconWidget() {
  const now = Date.now();
  const today = new Date();
  const curYear  = today.getFullYear();
  const curMonth = today.getMonth(); // 0-indexed

  // Build event HTML (reused for both months)
  const buildEventHtml = (ev) => {
    const impactColor = ev.impact === 'high' ? 'var(--bear)' : ev.impact === 'medium' ? '#f0a500' : 'var(--bull)';
    const impactLabel = ev.impact === 'high' ? '🔴 高影響' : ev.impact === 'medium' ? '🟡 中影響' : '🟢 低影響';
    const timeStr     = fmt12h(ev.twHour, ev.twMin);
    const published   = ev.eventTime.getTime() < now;
    const minsUntil   = (ev.eventTime.getTime() - now) / 60000;
    const dateLabel   = `${ev.eventTime.getMonth()+1}/${ev.eventTime.getDate()}`;
    const timeStatus  = published
      ? `<span class="econ-status econ-status-done">已公布</span>`
      : minsUntil < 60
      ? `<span class="econ-status econ-status-soon">⚡ ${Math.round(minsUntil)}分後</span>`
      : minsUntil < 1440
      ? `<span class="econ-status econ-status-later">${Math.round(minsUntil/60)}h後</span>`
      : `<span class="econ-status econ-status-later">${dateLabel}</span>`;
    const confColor  = (ev.aiConf||0) >= 70 ? 'var(--bull)' : (ev.aiConf||0) >= 55 ? '#f0a500' : 'var(--text3)';
    const _aDir      = ev.aiDir || 'neutral';
    const _aDirLabel = _aDir === 'bull' ? '▲ 偏多' : _aDir === 'bear' ? '▼ 偏空' : '◆ 中性';
    const _aDirColor = _aDir === 'bull' ? 'var(--bull)' : _aDir === 'bear' ? 'var(--bear)' : '#f59e0b';
    const aiSection  = ev.aiPred ? `
      <div class="econ-ai-block">
        <div class="econ-ai-row">
          <span class="econ-ai-label">🤖 AI 預測值</span>
          <span class="econ-ai-val">${ev.aiPred}</span>
          <span class="econ-ai-conf" style="color:${confColor}">信心 ${ev.aiConf}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin:4px 0 3px">
          <span style="font-size:0.68rem;color:var(--text3)">預測方向</span>
          <span style="font-size:0.75rem;font-weight:700;color:${_aDirColor}">${_aDirLabel}</span>
          ${published ? '<span style="font-size:0.65rem;color:var(--text3);padding:1px 5px;border-radius:4px;background:rgba(255,255,255,.06)">公布前預測</span>' : ''}
        </div>
        ${ev.aiDirReason ? `<div style="font-size:0.71rem;color:var(--text2);line-height:1.5;margin-bottom:4px">📌 ${ev.aiDirReason}</div>` : ''}
        ${ev.aiMarketImpact ? `<div class="econ-ai-impact">💡 ${ev.aiMarketImpact}</div>` : ''}
      </div>` : (ev.aiMarketImpact ? `<div class="econ-ai-block"><div class="econ-ai-impact">💡 ${ev.aiMarketImpact}</div></div>` : '');
    const dateKey = `${ev.eventTime.getFullYear()}-${ev.eventTime.getMonth()}-${ev.eventTime.getDate()}`;
    const actualVal = published ? getEconActualValue(ev.name, dateKey) : '';
    const hasBLS = !!BLS_SERIES_MAP[ev.name] || ev.name === 'FOMC 紀要' || !!KNOWN_ACTUALS[`${ev.name}_${dateKey}`];
    const fetchFailed = _econFetchFailed.has(`${ev.name}_${dateKey}`);
    if (published && !actualVal && hasBLS && !fetchFailed) {
      autoFetchEconActual(ev.name, dateKey).then(v => {
        const _econEl = document.getElementById('econMonthWidget');
        if (_econEl) _econEl.outerHTML = buildTodayEconWidget();
      });
    }
    const actualSection = published ? `
      <div style="margin-top:8px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:0.7rem;color:var(--text3)">實際公布值：</span>
          ${actualVal
            ? `<span style="font-size:0.78rem;font-weight:700;color:var(--accent)">${actualVal}</span>
               <button onclick="(function(){localStorage.removeItem('econ_actual_${ev.name}_${dateKey}');localStorage.removeItem('econ_bls_cache_${ev.name}_${dateKey}');const _el=document.getElementById('econMonthWidget');if(_el)_el.outerHTML=buildTodayEconWidget()})()" style="font-size:0.65rem;padding:1px 5px;border-radius:4px;border:1px solid rgba(255,255,255,.15);background:transparent;color:var(--text3);cursor:pointer">清除</button>`
            : (hasBLS && !fetchFailed)
              ? `<span style="font-size:0.72rem;color:var(--text3)">🔄 自動抓取中...</span>`
              : `<input type="text" placeholder="輸入實際值..."
                  style="font-size:0.73rem;padding:3px 8px;border-radius:6px;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.07);color:var(--text1);width:120px"
                  onchange="(function(v){setEconActualValue('${ev.name}','${dateKey}',v);const _el=document.getElementById('econMonthWidget');if(_el)_el.outerHTML=buildTodayEconWidget()})(this.value)"
                />`
          }
        </div>
        ${actualVal ? generateActualValueAnalysis(ev, actualVal) : ''}
      </div>` : '';
    return `<div class="econ-event-row">
      <div class="econ-event-time">
        <span class="econ-time-val">${timeStr}</span>${timeStatus}
        <span style="font-size:0.68rem;color:${impactColor};margin-top:2px;display:block">${impactLabel}</span>
      </div>
      <div class="econ-event-info">
        <div class="econ-name"><span style="color:${impactColor};margin-right:4px">●</span>${ev.name}</div>
        <div class="econ-desc">${ev.description}</div>
        <div class="econ-scenarios">
          <span class="econ-bull">📈 ${ev.bullIf}</span>
          <span class="econ-bear">📉 ${ev.bearIf}</span>
        </div>
        ${aiSection}
        ${actualSection}
      </div>
    </div>`;
  };

  // Build month panel content (grouped by date)
  const buildMonthPanel = (year, month, isActive) => {
    const events = getMonthEconEvents(year, month);
    if (!events.length) {
      return `<div style="color:var(--text3);padding:16px;text-align:center">本月無重要數據</div>`;
    }
    // Group by date string
    const groups = {};
    for (const ev of events) {
      const key = `${ev.eventTime.getFullYear()}-${ev.eventTime.getMonth()}-${ev.eventTime.getDate()}`;
      if (!groups[key]) {
        const dayNames = ['週日','週一','週二','週三','週四','週五','週六'];
        groups[key] = {
          label: `${ev.eventTime.getMonth()+1}/${ev.eventTime.getDate()} ${dayNames[ev.eventTime.getDay()]}`,
          events: [],
          isPast: ev.eventTime.getTime() < now,
        };
      }
      groups[key].events.push(ev);
    }
    const dayKeys = Object.keys(groups);
    const defaultKey = dayKeys.find(k => !groups[k].isPast) || dayKeys[0];
    const mId = `econ-m-${year}-${month}`;
    const tabsHtml = dayKeys.map(k => {
      const g = groups[k];
      const isAct = k === defaultKey;
      const highCount = g.events.filter(e => e.impact === 'high').length;
      const dot = highCount ? '<span class="econ-tab-dot high"></span>' : '';
      const pastStyle = g.isPast ? 'opacity:0.5;' : '';
      return `<button class="econ-day-tab${isAct ? ' active' : ''}" style="${pastStyle}"
        onclick="(function(btn){
          document.querySelectorAll('#${mId} .econ-day-tab').forEach(b=>b.classList.remove('active'));
          document.querySelectorAll('#${mId} .econ-day-panel').forEach(p=>p.style.display='none');
          btn.classList.add('active');
          document.getElementById('${mId}-p-${k}').style.display='block';
        })(this)">
        ${dot}${g.label}<span class="econ-tab-cnt">${g.events.length}</span>
      </button>`;
    }).join('');
    const panelsHtml = dayKeys.map(k => {
      const g = groups[k];
      const content = g.events.map(buildEventHtml).join('<div class="econ-divider"></div>');
      return `<div id="${mId}-p-${k}" class="econ-day-panel" style="display:${k === defaultKey ? 'block' : 'none'}">${content}</div>`;
    }).join('');
    return `<div id="${mId}"><div class="econ-day-tabs" style="flex-wrap:wrap">${tabsHtml}</div>${panelsHtml}</div>`;
  };

  // Two months: current and next
  const months = [
    { year: curYear, month: curMonth },
    { year: curMonth === 11 ? curYear + 1 : curYear, month: (curMonth + 1) % 12 },
  ];
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const widgetId = 'econMonthWidget';

  const monthTabsHtml = months.map((m, i) => {
    const label = `${m.year} ${monthNames[m.month]}`;
    const events = getMonthEconEvents(m.year, m.month);
    const highCnt = events.filter(e => e.impact === 'high').length;
    return `<button class="econ-month-btn${i === 0 ? ' active' : ''}"
      onclick="(function(btn){
        document.querySelectorAll('#${widgetId} .econ-month-btn').forEach(b=>b.classList.remove('active'));
        document.querySelectorAll('#${widgetId} .econ-month-panel').forEach(p=>p.style.display='none');
        btn.classList.add('active');
        document.getElementById('${widgetId}-panel-${i}').style.display='block';
      })(this)">
      ${label} <span style="font-size:0.68rem;color:var(--bear)">🔴${highCnt}</span>
    </button>`;
  }).join('');

  const monthPanelsHtml = months.map((m, i) =>
    `<div id="${widgetId}-panel-${i}" class="econ-month-panel" style="display:${i === 0 ? 'block' : 'none'}">${buildMonthPanel(m.year, m.month, i === 0)}</div>`
  ).join('');

  const totalHighEvents = months.reduce((sum, m) => sum + getMonthEconEvents(m.year, m.month).filter(e => e.impact === 'high').length, 0);

  return `<div id="${widgetId}" class="econ-today-section">
    <div class="econ-today-header">
      <span class="econ-today-title">📅 本月重要數據</span>
      <span class="econ-today-count">${totalHighEvents} 項高影響</span>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">${monthTabsHtml}</div>
    ${monthPanelsHtml}
  </div>`;
}

// AI 新聞處理：從英文標題+內容生成中文標題、重點摘要、市場影響
function aiProcessNews(title, body) {
  const text = ((title || '') + ' ' + (body || '')).toLowerCase();

  // 偵測主體
  const subject =
    (text.includes('bitcoin') || text.includes(' btc ') || text.startsWith('btc')) ? '比特幣' :
    (text.includes('ethereum') || text.includes(' eth ')) ? '以太坊' :
    (text.includes('solana') || text.includes(' sol ')) ? 'Solana' :
    (text.includes('ripple') || text.includes(' xrp ')) ? 'XRP' :
    (text.includes('bnb') || text.includes('binance')) ? 'BNB/Binance' :
    (text.includes('dogecoin') || text.includes('doge')) ? 'Dogecoin' :
    '加密市場';

  // 生成中文標題
  let zhTitle =
    (text.includes('etf') && (text.includes('inflow') || text.includes('record') || text.includes('billion'))) ? `${subject} ETF 資金創新高，機構持續買入` :
    (text.includes('etf') && (text.includes('outflow') || text.includes('exit'))) ? `${subject} ETF 出現資金流出，市場情緒轉謹慎` :
    (text.includes('etf') && text.includes('approv')) ? `${subject} ETF 獲得監管批准，里程碑式進展` :
    (text.includes('hack') || text.includes('exploit') || text.includes('stolen')) ? `⚠️ 加密協議遭受攻擊，安全事件警報` :
    (text.includes('ban') || text.includes('prohibited') || text.includes('restrict')) ? `監管收緊：${subject}交易面臨新限制` :
    (text.includes('sec') && (text.includes('lawsuit') || text.includes('charge'))) ? `SEC 對${subject}採取執法行動` :
    (text.includes('sec') && (text.includes('approv') || text.includes('clear'))) ? `SEC 批准${subject}相關申請，監管明朗化` :
    (text.includes('fed') || text.includes('federal reserve') || text.includes('rate cut')) ? `聯準會政策動向對${subject}市場影響` :
    (text.includes('inflation') || text.includes('cpi') || text.includes('pce')) ? `通膨數據出爐，${subject}市場情緒受影響` :
    (text.includes('institutional') || text.includes('microstrategy') || text.includes('fund bought')) ? `機構大戶加碼${subject}，籌碼持續集中` :
    (text.includes('partnership') || text.includes('integration') || text.includes('adoption')) ? `${subject}迎來重要採用進展，生態持續擴張` :
    (text.includes('surge') || text.includes('rally') || text.includes('all-time high')) ? `${subject}強勁突破，多頭動能顯著升溫` :
    (text.includes('crash') || text.includes('plunge') || text.includes('collapse')) ? `${subject}急速下挫，市場信心受到衝擊` :
    (text.includes('liquidation') || text.includes('liquidated')) ? `市場槓桿快速清算，${subject}短線劇烈波動` :
    (text.includes('halving') || text.includes('mining')) ? `${subject}挖礦/減半機制出現新動態` :
    (text.includes('stablecoin') || text.includes('usdt') || text.includes('usdc')) ? `穩定幣市場動態，流動性出現變化` :
    (text.includes('layer 2') || text.includes('l2') || text.includes('scaling')) ? `${subject}擴容升級取得重要進展` :
    (text.includes('defi') || text.includes('decentralized')) ? `DeFi 生態出現重要事件` :
    (text.includes('nft') || text.includes('non-fungible')) ? `NFT 市場動態，交易量出現明顯變化` :
    (text.includes('whale') || text.includes('wallets moved') || text.includes('large transfer')) ? `${subject}巨鯨大額移倉，鏈上動向引發市場關注` :
    (text.includes('scam') || text.includes('fraud') || text.includes('rug pull') || text.includes('arrest')) ? `⚠️ 加密詐騙/執法事件：${subject}市場安全警示` :
    (text.includes('volume') || text.includes('trading activity')) ? `${subject}交易量出現顯著變動，市場熱度值得追蹤` :
    (text.includes('listing') || text.includes('listed on') || text.includes('delisted')) ? `交易所上架/下架動態，${subject}流動性出現變化` :
    (text.includes('analyst') || text.includes('predict') || text.includes('forecast') || text.includes('target')) ? `分析師看法：${subject}走勢預測出現新觀點` :
    (text.includes('memecoin') || text.includes('meme coin') || text.includes('meme token')) ? `迷因幣熱潮持續，社群情緒推動短線行情` :
    (text.includes('altcoin') || text.includes('alt season') || text.includes('alts')) ? `山寨幣輪動訊號出現，資金流向值得關注` :
    (text.includes('network') || text.includes('mainnet') || text.includes('testnet') || text.includes('upgrade')) ? `${subject}網絡/協議出現重要更新動態` :
    (text.includes('tokeniz') || text.includes('rwa') || text.includes('real world')) ? `真實資產代幣化（RWA）趨勢加速，鏈上金融採用擴張` :
    (text.includes('staking') || text.includes('validator') || text.includes('yield')) ? `${subject}質押/收益機制出現新動態，場內資金留存變化` :
    `${subject} 最新市場動態`;

  // 生成重點摘要（2條）
  const points = [];
  if (text.includes('etf')) points.push('ETF 相關資金流向動態值得密切追蹤，機構配置方向影響短線');
  if (text.includes('institutional') || text.includes('wall street') || text.includes('microstrategy')) points.push('傳統金融機構持續進場布局，加密資產機構化程度加深');
  if (text.includes('regulation') || text.includes('sec') || text.includes('legislation') || text.includes('bill')) points.push('監管環境變化將直接影響市場合規預期與流動性');
  if (text.includes('fed') || text.includes('rate') || text.includes('inflation') || text.includes('fomc') || text.includes('pivot')) points.push('宏觀貨幣政策走向牽動整體風險資產情緒，加密與股市同步');
  if (text.includes('hack') || text.includes('exploit') || text.includes('stolen')) points.push('安全事件引發市場恐慌，相關資金短線外流，信心修復需時');
  if (text.includes('adoption') || text.includes('partnership') || text.includes('integration')) points.push('採用率提升強化鏈上生態，有助長線基本面估值支撐');
  if (text.includes('liquidation')) points.push('高槓桿倉位被迫清算，價格波動幅度放大，需防連鎖反應');
  if (text.includes('upgrade') || text.includes('protocol') || text.includes('mainnet')) points.push('技術升級提升網絡效能，有望帶動鏈上活動與用戶採用');
  if (text.includes('record') || text.includes('all-time')) points.push('歷史新高附近通常出現獲利了結賣壓，注意阻力與回調');
  if (text.includes('defi') || text.includes('tvl')) points.push('DeFi 總鎖倉量變化反映市場資金偏好與流動性狀況');
  if (text.includes('rwa') || text.includes('real world asset') || text.includes('tokeniz')) points.push('RWA 代幣化趨勢持續吸引機構資金，加速鏈上金融採用');
  if (text.includes('tariff') || text.includes('sanction') || text.includes('geopolit') || text.includes('war')) points.push('地緣政治風險升溫，加密資產作為避險資產的角色受到關注');
  if (text.includes('staking') || text.includes('restaking') || text.includes('yield')) points.push('質押收益率動態影響場內資金留存意願，流動性池規模變化');
  if (text.includes('ai') && (text.includes('token') || text.includes('agent') || text.includes('model'))) points.push('AI 敘事持續帶動相關代幣輪動，技術熱度支撐短線上行');
  if (text.includes('nft') || text.includes('gaming') || text.includes('metaverse')) points.push('Web3 應用層敘事輪動，NFT 與遊戲資產的市場熱度值得觀察');
  if (text.includes('treasury') || text.includes('reserve') || text.includes('sovereign')) points.push('主權/企業資金持有加密資產趨勢確立，供應端持續收縮');

  // 若關鍵詞不足，從 body 提取首句
  if (points.length < 2 && body && body.length > 40) {
    const firstSent = body.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).find(s => s.length > 30 && s.length < 160);
    if (firstSent) points.push(firstSent.trim());
  }
  if (points.length === 0) points.push('加密市場持續受到宏觀環境與監管動態雙重影響，短線需關注外部催化劑');

  // 市場影響分析（擴充關鍵詞覆蓋）
  const bullKw = ['etf', 'institutional', 'approval', 'approved', 'bullish', 'surge', 'rally',
    'adoption', 'inflow', 'halving', 'upgrade', 'partnership', 'launch', 'record', 'milestone',
    'breakout', 'accumulate', 'investment', 'fund', 'all-time', 'bitcoin reserve', 'rate cut',
    'dovish', 'pivot', 'mainnet', 'rwa', 'tokeniz', 'restaking', 'treasury', 'reserve',
    'whale bought', 'buy the dip', 'accumulation', 'inflows', 'network growth', 'adoption surge'];
  const bearKw = ['hack', 'ban', 'lawsuit', 'crash', 'bubble', 'scam', 'fraud', 'bearish',
    'drop', 'plunge', 'outflow', 'liquidation', 'penalty', 'investigation', 'exploit',
    'rug pull', 'bankrupt', 'seized', 'delisted', 'restrict', 'charge', 'crackdown',
    'hawkish', 'recession', 'tariff', 'sanction', 'sell-off', 'dump', 'slump', 'downgrade',
    'rejected', 'ban crypto', 'exchange hacked', 'frozen', 'insolvency', 'de-peg'];
  let bs = 0, rs = 0;
  bullKw.forEach(k => { if (text.includes(k)) bs++; });
  bearKw.forEach(k => { if (text.includes(k)) rs++; });

  let sentiment, conf, label, color, impact;
  if (bs > rs) {
    sentiment = 'bull'; conf = Math.min(86, 52 + bs * 6); label = '偏多'; color = 'var(--bull)';
    impact = bs >= 4
      ? `強烈利多：機構情緒高漲，${subject}多頭動能顯著增強，上行突破機率升高，可逢回測積極佈局`
      : bs >= 2
      ? `利多信號明確，市場情緒改善，${subject}短線受到支撐，注意成交量確認是否同步`
      : `輕微利多，${subject}短線情緒小幅回暖，方向偏多但動能需進一步確認`;
  } else if (rs > bs) {
    sentiment = 'bear'; conf = Math.min(86, 52 + rs * 6); label = '偏空'; color = 'var(--bear)';
    impact = rs >= 4
      ? `強烈利空：風險情緒明顯惡化，${subject}下行壓力加劇，建議收緊止損、降低曝險`
      : rs >= 2
      ? `利空壓力偏重，市場情緒謹慎，${subject}短線注意下行風險，避免過度追多`
      : `輕微利空，${subject}短線震盪機率上升，觀望為主，等待情緒穩定後再操作`;
  } else {
    sentiment = 'neutral'; conf = 50; label = '中性'; color = 'var(--text3)';
    impact = `消息面多空抵消，市場等待更明確方向，${subject}短線維持盤整，建議以技術面為主`;
  }

  return { zhTitle, points: points.slice(0, 2), sentiment, conf, label, color, impact };
}

function buildNewsWidget(items) {
  const recent = items || [];
  if (!recent.length) return '';

  const sentimentLabel = { bull: '偏多', bear: '偏空', neutral: '中性' };
  const sentimentColor = { bull: 'var(--bull)', bear: 'var(--bear)', neutral: 'var(--text3)' };

  // ── 整合多空判斷 ──
  const _nBull = recent.filter(i => i.sentiment === 'bull').length;
  const _nBear = recent.filter(i => i.sentiment === 'bear').length;
  const _nOverall = _nBull > _nBear + 1 ? 'bull' : _nBear > _nBull + 1 ? 'bear' : 'neutral';
  const _nIcon    = _nOverall === 'bull' ? '▲' : _nOverall === 'bear' ? '▼' : '◆';
  const _nLabel   = sentimentLabel[_nOverall];
  const _nColor   = sentimentColor[_nOverall];
  const _nBullConf = _nBull > 0 ? Math.round(recent.filter(i=>i.sentiment==='bull').reduce((a,i)=>a+(i.conf??50),0)/_nBull) : 0;
  const _nBearConf = _nBear > 0 ? Math.round(recent.filter(i=>i.sentiment==='bear').reduce((a,i)=>a+(i.conf??50),0)/_nBear) : 0;
  const _nTot = recent.length || 1;
  const _nOpinion = _nOverall === 'bull'
    ? `近期 ${_nTot} 則新聞中 ${_nBull} 則偏多（平均信心 ${_nBullConf}%），機構買入、採用擴張及監管利好訊號居多，短線情緒偏多，可逢回測積極佈局。`
    : _nOverall === 'bear'
    ? `近期 ${_nTot} 則新聞中 ${_nBear} 則偏空（平均信心 ${_nBearConf}%），監管風險、宏觀逆風及市場恐慌訊號較集中，短線情緒偏空，建議降低多頭曝險。`
    : `近期 ${_nTot} 則新聞多空訊號分歧（多 ${_nBull} 空 ${_nBear}），觀點分散，建議以技術面與鏈上數據為主要操作依據，等待明確方向。`;
  const _newsSummaryHtml = `<div style="background:rgba(255,255,255,.05);border-left:3px solid ${_nColor};border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:12px">
    <div style="font-size:0.7rem;color:var(--text3);margin-bottom:4px">🤖 新聞整合研判</div>
    <div style="font-size:1.25rem;font-weight:800;color:${_nColor};margin-bottom:6px">${_nIcon} ${_nLabel}</div>
    <div style="font-size:0.76rem;color:var(--text2);line-height:1.6">${_nOpinion}</div>
  </div>`;

  const newsHtml = recent.slice(0, 8).map(item => {
    const sent     = item.sentiment || 'neutral';
    const sentClass = sent === 'bull' ? 'bullish' : sent === 'bear' ? 'bearish' : '';
    const color    = sentimentColor[sent] || 'var(--text3)';
    const label    = sentimentLabel[sent] || '中性';
    const conf     = item.conf ?? 50;
    const confColor = conf >= 60 ? 'var(--bull)' : conf >= 50 ? '#f0a500' : 'var(--text3)';
    const timeAgo  = item.publishedAt ? (() => {
      const ts = typeof item.publishedAt === 'number' ? item.publishedAt : new Date(item.publishedAt).getTime();
      if (isNaN(ts)) return '';
      const m = Math.round((Date.now() - ts) / 60000);
      return m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.round(m/60)} 小時前` : `${Math.round(m/1440)} 天前`;
    })() : '';
    const _orig = item.originalTitle || '';
    const _zhTitle = item.zhTitle || '';
    const pointsHtml = (item.points || []).map(p => `<div class="news-point">• ${p}</div>`).join('');
    const tag = item.url ? 'a' : 'div';
    const tagOpen  = item.url ? `<a class="news-item ${sentClass}" href="${item.url}" target="_blank" rel="noopener">` : `<div class="news-item ${sentClass}">`;
    const tagClose = item.url ? '</a>' : '</div>';
    return `${tagOpen}
      <div class="news-ai-title">${_orig || _zhTitle}</div>
      ${_orig && _zhTitle && (_zhTitle.match(/[一-鿿]/g) || []).length >= 4 ? `<div style="font-size:0.78rem;color:#a78bfa;margin-top:3px;line-height:1.4">${_zhTitle}</div>` : ''}
      ${pointsHtml ? `<div class="news-keypoints">${pointsHtml}</div>` : ''}
      <div class="news-meta">
        <span>${item.source || ''}</span>
        ${timeAgo ? `<span>${timeAgo}</span>` : ''}
        <span class="news-sent ${sentClass}" style="margin-left:auto">${label}</span>
      </div>
      ${item.impact ? `<div class="news-ai-analysis">
        <span class="news-ai-label">🤖 市場影響</span>
        <span style="color:${color}">${item.impact}</span>
        <span class="news-ai-conf" style="color:${confColor}">信心 ${conf}%</span>
      </div>` : ''}
    ${tagClose}`;
  }).join('');

  return `<div class="outlook-header" style="margin-bottom:10px">
    <span class="outlook-title">🤖 AI 財經新聞重點</span>
    <span class="outlook-bias" style="color:var(--text3);font-size:0.78rem">AI 自動分析</span>
  </div>
  ${_newsSummaryHtml}
  ${newsHtml}`;
}

function renderErDashboardWidget() {
  const el = document.getElementById('er-dashboard-body');
  if (!el) return;
  const cache = (typeof _tradeSetupCache !== 'undefined' && _tradeSetupCache) ? _tradeSetupCache : {};
  const rows = ['BTC/USDT', 'ETH/USDT'].map(sym => {
    const er = cache[sym]?.extremeRev;
    if (!er) return `<div style="color:var(--text3);font-size:0.82rem;padding:4px 0">📊 <b>${sym}</b> — 反轉數據計算中…</div>`;
    if (!er.direction) {
      return `<div style="font-size:0.82rem;padding:4px 0;color:var(--text2)">📊 <b>${sym}</b> — 無顯著反轉訊號（頂部 ${er.topScore||0} / 底部 ${er.bottomScore||0}）</div>`;
    }
    const isTop = er.direction === 'top';
    const icon = isTop ? '📉' : '📈';
    const zh = isTop ? '頂部' : '底部';
    const conf = er.confidence || 0;
    const barColor = conf >= 98 ? 'var(--bear)' : conf >= 85 ? '#f59e0b' : 'var(--bull)';
    const status = conf >= 98
      ? `<span style="color:var(--bear)">⚡ 已達 98% 門檻，可考慮反向${isTop ? '做空' : '做多'}</span>`
      : conf >= 85
        ? `<span style="color:#f59e0b">⚠️ 潛在反轉（距門檻 ${98 - conf} 分）</span>`
        : `<span style="color:var(--text3)">🔭 早期觀察（距門檻 ${98 - conf} 分）</span>`;
    const topSigs = (er.signals || []).slice().sort((a,b)=>(b.pts||0)-(a.pts||0)).slice(0,2)
      .map(s=>`<span style="font-size:0.71rem;color:var(--text3)">• ${s.label}（+${s.pts}）</span>`).join(' ');
    return `<div style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
        <span style="font-weight:700;font-size:0.85rem">${icon} ${sym} — ${zh}反轉</span>
        <span style="font-weight:800;font-size:0.9rem;color:${barColor}">${conf}/100</span>
      </div>
      <div style="background:rgba(255,255,255,.06);border-radius:4px;height:5px;margin-bottom:4px">
        <div style="width:${conf}%;height:100%;background:${barColor};border-radius:4px"></div>
      </div>
      <div style="margin-bottom:3px">${status}</div>
      ${topSigs ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${topSigs}</div>` : ''}
    </div>`;
  });
  const lastTime = Math.max(
    cache['BTC/USDT']?.extremeRevTime || 0,
    cache['ETH/USDT']?.extremeRevTime || 0
  );
  const timeStr = lastTime
    ? new Date(lastTime).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    : '—';
  const _erPatHtml = (() => { try {
    const _pLines = ['BTC/USDT', 'ETH/USDT'].map(sym => {
      const cp = cache[sym]?.chartPat;
      if (!cp || !cp.patterns.length)
        return `<div style="font-size:0.78rem;color:var(--text3)">📐 <b>${sym.replace('/USDT','')}</b> — 無明顯形態</div>`;
      const confirmed = cp.patterns.filter(p => p.status !== 'forming');
      const forming   = cp.patterns.filter(p => p.status === 'forming');
      const parts = [
        ...confirmed.slice(0, 2).map(p => {
          const clr = p.aligned === true ? 'var(--bull)' : p.aligned === false ? 'var(--bear)' : '#f59e0b';
          return `<span style="color:${clr};font-size:0.72rem">${p.emoji} ${p.name}</span>`;
        }),
        ...forming.slice(0, 1).map(p => `<span style="color:#f59e0b;font-size:0.72rem">${p.emoji} ${p.name} 🔄</span>`)
      ];
      return `<div style="margin-bottom:4px"><span style="font-size:0.8rem;font-weight:700">📐 ${sym.replace('/USDT','')}</span>　${parts.join('　')}</div>`;
    });
    return `<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)">
      <div style="font-size:0.73rem;font-weight:700;color:#fbbf24;margin-bottom:5px">📐 技術圖形識別（4H）</div>
      ${_pLines.join('')}
    </div>`;
  } catch(_e) { return ''; } })();

  el.innerHTML = `
    <div class="outlook-header">
      <span class="outlook-title">🔄 頂/底反轉可能性</span>
      <span class="outlook-bias" style="color:var(--text3);font-size:0.78rem">最後更新 ${timeStr}</span>
    </div>
    <div style="padding:4px 0">${rows.join('')}</div>
    <div style="font-size:0.71rem;color:var(--text3);margin-top:6px">台灣時間 00 / 06 / 12 / 18 時自動更新（BTC / ETH）</div>
    ${_erPatHtml}`;
}

async function loadDashboardMacro() {
  const el = document.getElementById('market-outlook-body');
  let fg = null, global = null;
  try {
    [fg, global] = await Promise.all([fetchFearGreed(), fetchGlobalMarket()]);
    if (el) el.innerHTML = buildMarketOutlook(fg, global);
  } catch {
    if (el) el.innerHTML = '<div style="color:var(--text3);padding:12px;font-size:0.82rem">宏觀數據暫時無法獲取</div>';
  }
  renderErDashboardWidget();
  loadDashboardNews();
}

function renderDailyBriefCard(fg, mkt) {
  const el = document.getElementById('daily-brief-body');
  if (!el) return;
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const fgVal = fg ? parseInt(fg.value) : null;
  const fgZh = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fg?.value_classification] || '';
  const mktChg = mkt?.marketCapChange != null ? mkt.marketCapChange : null;
  const btcDom = mkt?.btcDominance   != null ? mkt.btcDominance   : null;

  const tlog = loadTradeLog();
  const yStart = new Date(now); yStart.setDate(yStart.getDate() - 1); yStart.setHours(0,0,0,0);
  const yEnd   = new Date(now); yEnd.setDate(yEnd.getDate() - 1);     yEnd.setHours(23,59,59,999);
  const yClosed = tlog.filter(t => t.status === 'closed' && t.exitTime >= yStart.getTime() && t.exitTime <= yEnd.getTime());
  const yrTP = yClosed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
  const yrSL = yClosed.filter(t => t.outcome === 'sl'  || t.outcome === 'be').length;
  const totalR = yClosed.reduce((s, t) => s + parseFloat(t.pnlR || 0), 0);
  const wr = yClosed.length > 0 ? Math.round(yrTP / yClosed.length * 100) : null;

  let wbLabel = '--', tbLabel = '--';
  try { wbLabel = computeWeeklyAIBias(fg, mkt).biasLabel || '--'; } catch(e) {}
  try { tbLabel = computeTodayAIBias(fg, mkt).biasLabel || '--'; } catch(e) {}

  const highEvs = getTodayEconEvents().filter(e => e.impact === 'high');
  const chgColor = mktChg != null ? (mktChg >= 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text2)';

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-weight:700;font-size:0.9rem">📊 每日市場簡報</span>
      <span style="color:var(--text3);font-size:0.78rem">${dateStr}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
      <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px">恐慌貪婪</div>
        <div style="font-weight:700;font-size:0.9rem">${fgVal != null ? fgVal : '--'}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${fgZh}</span></div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px">加密市值 24h</div>
        <div style="font-weight:700;font-size:0.9rem;color:${chgColor}">${mktChg != null ? (mktChg >= 0 ? '+' : '') + mktChg.toFixed(2) + '%' : '--'}</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px">BTC 主導</div>
        <div style="font-weight:700;font-size:0.9rem">${btcDom != null ? btcDom.toFixed(1) + '%' : '--'}</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px">本週 AI 走勢</div>
        <div style="font-weight:600;font-size:0.82rem">${wbLabel}</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px">今日 AI 走勢</div>
        <div style="font-weight:600;font-size:0.82rem">${tbLabel}</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px">昨日盈虧</div>
        <div style="font-weight:600;font-size:0.78rem">${yClosed.length > 0 ? `勝率 ${wr}% · ${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)} R` : '無結算'}</div>
      </div>
    </div>
    ${highEvs.length > 0 ? `<div style="margin-bottom:8px">
      <div style="font-size:0.78rem;font-weight:600;margin-bottom:4px;color:var(--text2)">🔴 今日重大數據</div>
      ${highEvs.map(ev => `<div style="display:flex;justify-content:space-between;font-size:0.78rem;padding:2px 0;color:var(--text3)">
        <span>${ev.name}</span>
        <span>${ev.twHour}:${String(ev.twMin).padStart(2,'0')}</span>
      </div>`).join('')}
    </div>` : ''}
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn-ghost" onclick="manualSendDailyBriefing()" style="font-size:0.76rem;padding:4px 10px">📨 發送至 Telegram</button>
    </div>
  `;
}

async function manualSendDailyBriefing() {
  const s = loadSettings();
  if (!s.tgToken || !s.tgChatId) { showToast('請先在設定中填入 Telegram Bot Token 和 Chat ID', 'error'); return; }
  showToast('正在發送每日市場簡報...', 'info');
  const ok = await sendDailyBriefing();
  if (ok) {
    showToast('每日市場簡報已發送至 Telegram ✅', 'success');
  } else {
    showToast('發送失敗，請確認 Telegram Bot Token 和 Chat ID 是否正確', 'error');
  }
}

const _INSIGHT_THEMES = [
  { title: 'Bitcoin ETF institutional inflow record billion fund bought wall street', body: 'bitcoin etf institutional investors fund bought record inflow approval milestone wall street adoption', tag: 'BTC' },
  { title: 'Federal Reserve rate cut expectations inflation cpi bitcoin rally surge bullish', body: 'federal reserve rate cut inflation cpi pce bitcoin surge bullish adoption institutional fund record', tag: '總經' },
  { title: 'Bitcoin halving mining supply scarcity long-term accumulate institutional', body: 'bitcoin halving mining supply scarcity institutional accumulate long-term investment record', tag: 'BTC' },
  { title: 'Ethereum layer 2 scaling upgrade launch adoption partnership integration', body: 'ethereum layer 2 l2 scaling upgrade adoption integration partnership milestone record launch', tag: 'ETH' },
  { title: 'SEC regulation crypto legislation approval clarity compliance framework', body: 'sec regulation legislation approval clear compliance framework institutional adoption approved', tag: '監管' },
  { title: 'DeFi protocol TVL growth upgrade launch decentralized ecosystem', body: 'defi tvl growth protocol upgrade launch adoption integration milestone record decentralized', tag: 'DeFi' },
  { title: 'Crypto market liquidation leverage correction plunge bearish risk', body: 'liquidation leverage crash drop plunge bearish correction bear investigation restrict', tag: '風險' },
  { title: 'Institutional adoption corporate bitcoin reserve treasury microstrategy investment', body: 'institutional adoption partnership bitcoin reserve corporate treasury microstrategy fund bought investment milestone', tag: '機構' },
  { title: 'Stablecoin USDT USDC supply growth market liquidity adoption flow', body: 'stablecoin usdt usdc liquidity flow market supply growth adoption integration', tag: '穩定幣' },
  { title: 'Altcoin season rotation Bitcoin dominance breakout rally surge', body: 'altcoin season rotation bitcoin dominance surge rally breakout adoption institutional record', tag: '山寨' },
  { title: 'Solana ecosystem growth DeFi adoption launch partnership upgrade', body: 'solana sol adoption defi launch upgrade integration partnership record milestone growth', tag: 'SOL' },
  { title: 'Crypto exchange volume surge record liquidity market activity', body: 'exchange volume surge record liquidity market activity institutional adoption inflow', tag: '交易所' },
  { title: 'Real world assets RWA tokenization institutional blockchain adoption launch', body: 'real world assets rwa tokenization institutional blockchain adoption launch fund investment milestone record', tag: 'RWA' },
  { title: 'AI tokens artificial intelligence crypto NEAR FET ICP launch adoption surge', body: 'artificial intelligence ai tokens near fet icp adoption launch integration partnership surge rally record', tag: 'AI幣' },
  { title: 'Bitcoin layer 2 Lightning Network Stacks scaling upgrade adoption', body: 'bitcoin layer 2 lightning network stacks scaling upgrade adoption integration milestone launch record', tag: 'BTC L2' },
  { title: 'Restaking EigenLayer liquid staking protocol TVL growth yield', body: 'restaking eigenlayer liquid staking lrt protocol tvl growth yield adoption launch milestone record', tag: '再質押' },
  { title: 'Geopolitical risk trade tariff war sanctions inflation hedge bitcoin safe haven', body: 'geopolitical risk trade tariff war sanctions inflation hedge bitcoin safe haven gold alternative institutional', tag: '地緣' },
  { title: 'NFT gaming metaverse comeback volume surge adoption record launch', body: 'nft gaming metaverse virtual comeback volume surge record launch adoption institutional integration', tag: 'NFT/遊戲' },
];

function aiGenerateMarketInsights() {
  const d = new Date();
  const daySeed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const hourSlot = Math.floor(d.getHours() / 6); // 每6小時換一批

  const shuffled = _INSIGHT_THEMES
    .map((t, i) => ({ ...t, _s: Math.abs((daySeed + hourSlot * 31 + i * 1664525 + 1013904223) & 0x7fffffff) }))
    .sort((a, b) => a._s - b._s)
    .slice(0, 6);

  return shuffled.map(theme => {
    const ai = aiProcessNews(theme.title, theme.body);
    return {
      zhTitle:     ai.zhTitle,
      points:      ai.points,
      impact:      ai.impact,
      sentiment:   ai.sentiment,
      conf:        ai.conf,
      source:      `🤖 AI · ${theme.tag}`,
      publishedAt: null,
    };
  });
}

// 真實新聞情緒快取（供極端反轉「公開輿論」分析使用）
let _newsSentimentCache = [];

async function loadDashboardNews() {
  const el = document.getElementById('news-body');
  // 先顯示本地 AI 新聞（即時可見，不等待網路）
  if (el) el.innerHTML = buildNewsWidget(aiGenerateMarketInsights());
  // 非同步拉取真實新聞：無論容器是否存在都抓取（極端反轉「公開輿論」分析依賴此快取）
  try {
    const realItems = await fetchCryptoNews();
    if (realItems && realItems.length >= 3) {
      const _3mAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const _filtered = realItems.filter(it => !it.publishedAt || it.publishedAt >= _3mAgo);
      const _toProcess = _filtered.length >= 3 ? _filtered : realItems;
      const processed = _toProcess.map(item => {
        const ai = aiProcessNews(item.title, item.body);
        return {
          ...ai,
          originalTitle: item.title,
          url:           item.url,
          source:        `📰 ${item.source}`,
          publishedAt:   item.publishedAt,
        };
      });
      _newsSentimentCache = processed;
      // 確認容器仍存在（用戶可能已切換頁面）
      const elNow = document.getElementById('news-body');
      if (elNow) elNow.innerHTML = buildNewsWidget(processed);
    }
  } catch(e) {
    console.warn('[loadDashboardNews] 真實新聞載入失敗:', e?.message);
  }
  const cfEl = document.getElementById('capital-flow-body');
  if (cfEl) cfEl.innerHTML = buildCapitalFlowEventsWidget();
}

/* ── 籌碼分佈 / 巨鯨 / 成交量AI 面板 ────────────────────────── */
function buildVPPanel(coin, mtfData, whale) {
  const vp1h  = mtfData['1h']?.vp;
  const volAI = mtfData['1h']?.volAI;
  const wPat  = analyzeWhalePattern(whale);
  const price = parseFloat(coin.price) || 0;

  /* ── 籌碼分佈視覺圖 ── */
  let vpHtml = '';
  if (vp1h) {
    const maxVol = Math.max(...vp1h.buckets.map(b => b.vol));
    const barsHtml = [...vp1h.buckets].reverse().map(b => {
      const widthPct = Math.round((b.vol / maxVol) * 100);
      const isPOC   = Math.abs(b.mid - vp1h.poc) < vp1h.bucketSize * 0.6;
      const inVA    = b.mid >= vp1h.val && b.mid <= vp1h.vah;
      const isHVN   = vp1h.hvns.some(h => Math.abs(h - b.mid) < vp1h.bucketSize * 0.7);
      const isLVN   = !isHVN && vp1h.lvns.some(l => Math.abs(l - b.mid) < vp1h.bucketSize * 0.7);
      const isPrice = price >= b.low && price <= b.high;
      const barCls  = isPOC ? 'vp-bar vp-poc' : inVA ? 'vp-bar vp-va' : isHVN ? 'vp-bar vp-hvn' : isLVN ? 'vp-bar vp-lvn' : 'vp-bar';
      return `<div class="vp-row${isPrice ? ' vp-price-row' : ''}">
        <div class="vp-price-lbl">${fmtPrice(b.mid)}${isPOC ? ' <span class="vp-poc-tag">POC</span>' : ''}</div>
        <div class="vp-bar-wrap"><div class="${barCls}" style="width:${widthPct}%"></div>${isPrice ? '<span class="vp-cur-marker">◀</span>' : ''}</div>
      </div>`;
    }).join('');

    const distSign  = vp1h.distToPOC >= 0 ? '+' : '';
    const distColor = Math.abs(vp1h.distToPOC) < 1 ? 'var(--neutral)' : vp1h.priceAbovePOC ? 'var(--bull)' : 'var(--bear)';

    vpHtml = `<div class="vp-section">
      <div class="vp-header">
        <span class="vp-sub-title" style="margin-bottom:0">📊 籌碼分佈（1h Volume Profile）</span>
        <span class="vp-dist" style="color:${distColor}">距POC ${distSign}${vp1h.distToPOC}%</span>
      </div>
      <div class="vp-info-chips">
        <span class="vp-chip vp-chip-poc">🎯 POC: ${fmtPrice(vp1h.poc)}</span>
        <span class="vp-chip vp-chip-vah">▲ VAH: ${fmtPrice(vp1h.vah)}</span>
        <span class="vp-chip vp-chip-val">▼ VAL: ${fmtPrice(vp1h.val)}</span>
        <span class="vp-chip">現價${vp1h.priceAbovePOC ? '在POC上方' : '在POC下方'}</span>
      </div>
      <div class="vp-chart">${barsHtml}</div>
      <div class="vp-legend">
        <span class="vp-legend-item"><span class="vp-legend-dot" style="background:var(--neutral)"></span>POC</span>
        <span class="vp-legend-item"><span class="vp-legend-dot" style="background:rgba(0,212,255,.45)"></span>VA 70%</span>
        <span class="vp-legend-item"><span class="vp-legend-dot" style="background:rgba(0,230,118,.55)"></span>HVN</span>
        <span class="vp-legend-item"><span class="vp-legend-dot" style="background:rgba(255,23,68,.35)"></span>LVN</span>
      </div>
    </div>`;
  }

  /* ── 巨鯨介入偵測 ── */
  let whaleHtml = '';
  {
    // 判斷是否有巨鯨介入（現貨大單 or 合約 Taker 明確偏向）
    const spotInvolved  = wPat && wPat.pattern !== 'neutral';
    const fw            = whale?.futuresWhale;
    const futInvolved   = fw && fw.takerBias !== 'neutral';
    const isInvolved    = spotInvolved || futInvolved;

    // AI 巨鯨綜合判斷
    const wSpotDir  = wPat ? (wPat.pattern === 'accumulation' || wPat.pattern === 'light_buy' ? 'bull'
                            : wPat.pattern === 'distribution' || wPat.pattern === 'light_sell' ? 'bear' : 'neutral') : 'neutral';
    const wFutDir   = fw ? (fw.takerBias === 'bull' ? 'bull' : fw.takerBias === 'bear' ? 'bear' : 'neutral') : 'neutral';
    const wConsistent = wSpotDir === wFutDir;
    const wBothNeutral = wSpotDir === 'neutral' && wFutDir === 'neutral';
    let wAIVerdict = 'neutral', wAILabel = '◆ 無明顯訊號', wAIColor = 'var(--text3)';
    if (!wBothNeutral) {
      if (wConsistent && wSpotDir === 'bull') { wAIVerdict = 'strong_bull'; wAILabel = '✅ 現貨+期貨同步積累，強力多頭信號'; wAIColor = 'var(--bull)'; }
      else if (wConsistent && wSpotDir === 'bear') { wAIVerdict = 'strong_bear'; wAILabel = '❌ 現貨+期貨同步派發，強力空頭信號'; wAIColor = 'var(--bear)'; }
      else if (!wConsistent && wSpotDir !== 'neutral' && wFutDir !== 'neutral') { wAIVerdict = 'conflict'; wAILabel = '⚠️ 現貨/期貨巨鯨方向分歧，謹慎操作'; wAIColor = '#f59e0b'; }
      else if (wSpotDir === 'bull' || wFutDir === 'bull') { wAIVerdict = 'bull'; wAILabel = '↑ 單邊積累跡象（多頭）'; wAIColor = 'var(--bull)'; }
      else if (wSpotDir === 'bear' || wFutDir === 'bear') { wAIVerdict = 'bear'; wAILabel = '↓ 單邊派發跡象（空頭）'; wAIColor = 'var(--bear)'; }
    }
    const _wTlog = (() => { try { return loadTradeLog(); } catch(_) { return []; } })();
    const _wActiveTrade = _wTlog.find(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending'));
    const direction = _wActiveTrade ? _wActiveTrade.direction : (wAIVerdict === 'bull' || wAIVerdict === 'strong_bull' ? 'long' : wAIVerdict === 'bear' || wAIVerdict === 'strong_bear' ? 'short' : 'long');
    const wAIAligned = (direction === 'long' && (wAIVerdict === 'bull' || wAIVerdict === 'strong_bull'))
                    || (direction === 'short' && (wAIVerdict === 'bear' || wAIVerdict === 'strong_bear'));
    const wAIOpposed = (direction === 'long' && (wAIVerdict === 'bear' || wAIVerdict === 'strong_bear'))
                    || (direction === 'short' && (wAIVerdict === 'bull' || wAIVerdict === 'strong_bull'));

    // 方向：以現貨大單為主，無則看合約 Taker
    const whaleDirBias  = wPat?.pattern === 'accumulation' || wPat?.pattern === 'light_buy'  ? 'bull'
                        : wPat?.pattern === 'distribution' || wPat?.pattern === 'light_sell' ? 'bear'
                        : fw?.takerBias || 'neutral';
    const whaleDirClr   = whaleDirBias === 'bull' ? 'var(--bull)' : whaleDirBias === 'bear' ? 'var(--bear)' : 'var(--text3)';
    const whaleDirLabel = whaleDirBias === 'bull' ? '多方介入' : whaleDirBias === 'bear' ? '空方介入' : '方向不明';

    // 掛單均價（api.js 追蹤的大單平均成交價）
    const buyAvg  = whale?.bigBuyAvgPrice;
    const sellAvg = whale?.bigSellAvgPrice;
    const buyAvgStr  = buyAvg  ? `$${fmtPrice(buyAvg)}`  : null;
    const sellAvgStr = sellAvg ? `$${fmtPrice(sellAvg)}` : null;

    // 合約數據
    const takerBias    = fw?.takerBias    || 'neutral';
    const takerBuyPct  = fw?.takerBuyPct  || '—';
    const takerSellPct = fw?.takerSellPct || '—';
    const oiChange     = fw?.oiChange;
    const oiChangeStr  = oiChange != null ? oiChange.toFixed(2) : null;
    const oiTrendLabel = fw?.oiTrend === 'increasing' ? '持倉增加' : fw?.oiTrend === 'decreasing' ? '持倉減少' : null;

    const involvedTag = isInvolved
      ? `<span style="font-weight:700;color:${whaleDirClr}">✅ 是（${whaleDirLabel}）</span>`
      : `<span style="color:var(--text3)">❌ 否</span>`;

    const priceHtml = isInvolved && (buyAvgStr || sellAvgStr) ? `
      <div class="vp-whale-stats" style="margin-top:4px">
        <span style="font-size:0.72rem;color:var(--text3)">掛單均價：</span>
        ${buyAvgStr  ? `<span class="vp-chip" style="color:var(--bull)">多方 ${buyAvgStr}</span>`   : ''}
        ${sellAvgStr ? `<span class="vp-chip" style="color:var(--bear)">空方 ${sellAvgStr}</span>`  : ''}
      </div>` : '';

    const spotStatsHtml = wPat ? `
      <div class="vp-whale-stats" style="margin-top:4px">
        <span style="font-size:0.72rem;color:var(--text3)">現貨大單：</span>
        <span class="vp-chip" style="color:var(--bull)">買 ${wPat.buyPct.toFixed(1)}%（${wPat.bigBuyCount}筆）</span>
        <span class="vp-chip" style="color:var(--bear)">賣 ${wPat.sellPct}%（${wPat.bigSellCount}筆）</span>
      </div>` : '';

    const futStatsHtml = fw ? `
      <div class="vp-whale-stats" style="margin-top:4px">
        <span style="font-size:0.72rem;color:var(--text3)">合約Taker：</span>
        <span class="vp-chip" style="color:${takerBias === 'bull' ? 'var(--bull)' : takerBias === 'bear' ? 'var(--bear)' : 'var(--text2)'}">買 ${takerBuyPct}% / 賣 ${takerSellPct}%</span>
        ${oiChangeStr !== null ? `<span class="vp-chip" style="color:${oiChange > 0 ? 'var(--bull)' : oiChange < 0 ? 'var(--bear)' : 'var(--text2)'}">OI ${oiChange > 0 ? '+' : ''}${oiChangeStr}%</span>` : ''}
        ${oiTrendLabel ? `<span class="vp-chip" style="color:var(--text3)">${oiTrendLabel}</span>` : ''}
      </div>` : '';

    whaleHtml = `<div class="vp-whale-section">
      <div class="vp-sub-title">🐋 巨鯨介入偵測</div>
      <div style="display:flex;align-items:center;gap:8px;margin:6px 0">
        <span style="font-size:0.8rem;color:var(--text2)">巨鯨介入：</span>${involvedTag}
      </div>
        <div style="margin-top:6px;padding:5px 8px;background:rgba(255,255,255,.03);border-radius:6px;font-size:0.73rem">
          <span style="color:var(--text3)">AI 研判：</span><span style="color:${wAIColor}">${wAILabel}</span>
          ${wAIAligned ? `<span style="color:var(--bull);margin-left:8px;font-size:0.7rem">▲ 與${direction === 'long' ? '多' : '空'}單方向一致</span>` : ''}
          ${wAIOpposed ? `<span style="color:var(--bear);margin-left:8px;font-size:0.7rem">▼ 與${direction === 'long' ? '多' : '空'}單方向相悖</span>` : ''}
        </div>
      ${priceHtml}${spotStatsHtml}${futStatsHtml}
      ${!whale && !wPat ? '<div style="color:var(--text3);font-size:0.8rem;padding:4px 0">現貨 / 合約數據載入中，稍後重試...</div>' : ''}
    </div>`;
  }

  /* ── 成交量 AI 分析 ── */
  let volAIHtml = '';
  if (volAI) {
    const trendInfo = { rising: { label: '量能上升 📈', color: 'var(--bull)' }, falling: { label: '量能萎縮 📉', color: 'var(--bear)' }, flat: { label: '量能平穩 ➡', color: 'var(--text2)' } }[volAI.volTrend] || { label: '量能平穩', color: 'var(--text2)' };
    const biasInfo  = { bull: { label: '買盤主導', color: 'var(--bull)' }, bear: { label: '賣盤主導', color: 'var(--bear)' }, neutral: { label: '多空均衡', color: 'var(--text2)' } }[volAI.bias] || { label: '多空均衡', color: 'var(--text2)' };
    const sigs = [];
    if (volAI.isSpike)                            sigs.push(`<span class="vp-vol-sig vp-vol-spike">🔥 成交量暴增 ${volAI.volRatio}x 均量</span>`);
    else if (volAI.isHighVol)                     sigs.push(`<span class="vp-vol-sig vp-vol-high">📶 放量 ${volAI.volRatio}x 均量</span>`);
    else                                          sigs.push(`<span class="vp-vol-sig" style="color:var(--text3)">成交量 ${volAI.volRatio}x 均量（正常）</span>`);
    if (volAI.isClimax)   sigs.push(`<span class="vp-vol-sig vp-vol-climax">⚡ 頂底量（高量小實體，潛在反轉）</span>`);
    if (volAI.isBreakout) sigs.push(`<span class="vp-vol-sig vp-vol-break">💥 連續放量突破（近3根），5日 ${volAI.priceChg5 >= 0 ? '+' : ''}${volAI.priceChg5}%</span>`);
    if (volAI.divergence === 'bullish_div') sigs.push(`<span class="vp-vol-sig vp-vol-bdiv">↑ 看漲背離：量跌價跌，下跌動能衰竭</span>`);
    if (volAI.divergence === 'bearish_div') sigs.push(`<span class="vp-vol-sig vp-vol-brdiv">↓ 看跌背離：量跌價漲，上漲動能不足</span>`);
    volAIHtml = `<div class="vp-volai-section">
      <div class="vp-sub-title">📉 成交量 AI 分析（1h）</div>
      <div class="vp-volai-chips">
        <span class="vp-chip" style="color:${trendInfo.color}">${trendInfo.label}</span>
        <span class="vp-chip" style="color:${biasInfo.color}">${biasInfo.label}</span>
        <span class="vp-chip" style="color:var(--text2)">上漲量比 ${Math.round(volAI.upVolRatio * 100)}%</span>
        <span class="vp-chip" style="color:var(--text2)">5日漲幅 ${volAI.priceChg5 >= 0 ? '+' : ''}${volAI.priceChg5}%</span>
      </div>
      <div class="vp-vol-signals">${sigs.join('')}</div>
    </div>`;
  }

  /* ── AI 綜合敘述 ── */
  let narrative = '';
  if (vp1h || wPat || volAI) {
    const parts = [];
    if (vp1h)  parts.push(vp1h.priceAbovePOC ? `籌碼密集區 POC $${fmtPrice(vp1h.poc)} 提供支撐，VAH $${fmtPrice(vp1h.vah)} 為上方壓力` : `現價低於 POC $${fmtPrice(vp1h.poc)}，VAL $${fmtPrice(vp1h.val)} 為關鍵支撐`);
    if (wPat && wPat.pattern !== 'neutral')  parts.push(wPat.label + `（${wPat.strength}%強度）`);
    if (volAI && (volAI.isBreakout || volAI.isSpike || volAI.isClimax || volAI.divergence))
      parts.push(volAI.isBreakout ? '成交量放大確認突破' : volAI.isClimax ? '頂底量提示注意反轉' : volAI.divergence === 'bullish_div' ? '看漲背離出現' : volAI.divergence === 'bearish_div' ? '看跌背離需謹慎' : `量能${volAI.volRatio}x`);
    if (parts.length) narrative = `<div class="vp-narr-summary">🤖 ${parts.join('；')}。</div>`;
  }

  return `<div class="vp-panel">${narrative}${vpHtml}${whaleHtml}${volAIHtml}</div>`;
}

/* ── 宏觀市場環境面板 ─────────────────────────────────────── */
function buildMacroPanel(global, halving, fg) {

  /* ── 頂部數據卡 ── */
  const fmtTrillion = v => v >= 1e12 ? (v/1e12).toFixed(2)+'兆'
    : v >= 1e9 ? (v/1e9).toFixed(1)+'億' : '--';
  const chgColor = v => v > 0 ? 'var(--bull)' : v < 0 ? 'var(--bear)' : 'var(--text3)';

  const metrics = [];
  if (global) {
    metrics.push({
      label: '加密總市值',
      val:   global.totalMarketCap ? '$' + fmtTrillion(global.totalMarketCap) : '--',
      sub:   global.marketCapChange != null
        ? `<span style="color:${chgColor(global.marketCapChange)}">${global.marketCapChange > 0 ? '+' : ''}${global.marketCapChange}% 24h</span>`
        : '',
      icon: '🌐',
    });
    metrics.push({
      label: 'BTC 市值佔比',
      val:   global.btcDominance != null ? global.btcDominance + '%' : '--',
      sub:   global.btcDominance > 55 ? '<span style="color:var(--neutral)">高主導→幣圈避險</span>'
           : global.btcDominance < 45 ? '<span style="color:var(--bull)">低主導→山寨季潛力</span>'
           : '<span style="color:var(--text3)">中性</span>',
      icon: '₿',
    });
    metrics.push({
      label: '24h 總交易量',
      val:   global.totalVolume ? '$' + fmtTrillion(global.totalVolume) : '--',
      sub:   `${global.activeCryptos?.toLocaleString() || '--'} 個活躍幣種`,
      icon: '📊',
    });
  }
  if (halving) {
    metrics.push({
      label: '下次比特幣減半',
      val:   halving.daysLeft != null ? halving.daysLeft + ' 天' : '--',
      sub:   `區塊 ${halving.nextHalving?.toLocaleString() || '--'}（剩 ${halving.blocksLeft?.toLocaleString() || '--'} 個）`,
      icon: '✂️',
    });
  }
  if (fg) {
    const fgVal = parseInt(fg.value);
    const fgZh  = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fg.value_classification] || fg.value_classification;
    const fgClr = fgVal >= 75 ? 'var(--bear)' : fgVal >= 55 ? '#ff6d00' : fgVal <= 25 ? 'var(--bull)' : fgVal <= 45 ? 'var(--sbull)' : 'var(--neutral)';
    metrics.push({
      label: '恐慌貪婪指數',
      val:   `<span style="color:${fgClr}">${fgVal}</span>`,
      sub:   `<span style="color:${fgClr}">${fgZh}</span>`,
      icon: '🧭',
    });
  }

  /* ── 宏觀影響因素說明卡 ── */
  const factors = [
    {
      icon: '🏛️', title: '聯準會（Fed）利率政策',
      color: '#7c83fd',
      desc: '降息→流動性寬鬆，加密幣利多；升息→資金緊縮，加密幣承壓。密切關注 FOMC 會議紀錄與 CME FedWatch 利率期貨。',
      link: 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html',
      linkTx: 'CME FedWatch →',
    },
    {
      icon: '💵', title: '美元指數（DXY）',
      color: '#64b5f6',
      desc: 'DXY 上漲→美元強勢，壓制比特幣等風險資產；DXY 下跌→美元弱勢，通常利多加密市場。與 BTC 呈高度負相關。',
      link: 'https://www.tradingview.com/chart/?symbol=TVC:DXY',
      linkTx: 'DXY 走勢圖 →',
    },
    {
      icon: '📈', title: '比特幣現貨 ETF 資金流',
      color: '#ffd740',
      desc: '2024年1月通過後，貝萊德（iShares）等機構每日 ETF 淨流入/流出量成為市場領先指標，反映華爾街機構態度。',
      link: 'https://farside.co.uk/bitcoin-etf-flow-all-data/',
      linkTx: 'ETF 資金流數據 →',
    },
    {
      icon: '🏦', title: '美國通膨數據（CPI）',
      color: '#ff6d00',
      desc: 'CPI 高於預期→市場預期升息，加密幣重挫；CPI 低於預期→降息預期升溫，加密幣走強。每月第二週公布。',
      link: 'https://www.bls.gov/cpi/',
      linkTx: 'CPI 報告 →',
    },
    {
      icon: '⚖️', title: '監管政策動向',
      color: '#ef5350',
      desc: 'SEC、CFTC 對交易所與穩定幣的態度、各國政府的禁令或合法化政策，直接影響資金進場門檻與市場信心。',
      link: 'https://www.sec.gov/spotlight/cybersecurity',
      linkTx: 'SEC 最新動態 →',
    },
    {
      icon: '🌍', title: '地緣政治風險',
      color: '#aaa',
      desc: '地緣衝突初期加密幣可能隨風險資產下跌，但若被視為「數位黃金」，可能在後期轉為避險買盤。觀察 VIX 恐慌指數。',
      link: 'https://www.tradingview.com/chart/?symbol=CBOE:VIX',
      linkTx: 'VIX 恐慌指數 →',
    },
  ];

  /* ── 宏觀總結訊號 ── */
  let macroSignal = '', macroColor = 'var(--neutral)';
  if (global) {
    const chg = global.marketCapChange || 0;
    const dom = global.btcDominance || 50;
    if (chg > 3 && dom < 55)       { macroSignal = '加密市場整體強勢，山寨幣機會較大'; macroColor = 'var(--bull)'; }
    else if (chg > 1)               { macroSignal = '市場小幅回暖，風險偏好略升'; macroColor = 'var(--sbull)'; }
    else if (chg < -3 && dom > 55)  { macroSignal = '市場整體下跌，資金避險流向 BTC'; macroColor = 'var(--bear)'; }
    else if (chg < -1)              { macroSignal = '市場偏弱，謹慎操作'; macroColor = 'var(--sbear)'; }
    else if (dom > 60)              { macroSignal = 'BTC 主導強，山寨幣表現分化'; macroColor = 'var(--neutral)'; }
    else                            { macroSignal = '市場橫盤整理，等待方向選擇'; macroColor = 'var(--neutral)'; }
  }

  return `
  ${metrics.length ? `<div class="macro-metrics">
    ${metrics.map(m => `
      <div class="macro-metric-card">
        <div class="macro-metric-icon">${m.icon}</div>
        <div class="macro-metric-label">${m.label}</div>
        <div class="macro-metric-val">${m.val}</div>
        <div class="macro-metric-sub">${m.sub}</div>
      </div>
    `).join('')}
  </div>` : ''}
  ${macroSignal ? `<div class="macro-signal-bar" style="border-color:${macroColor};color:${macroColor}">
    📡 宏觀訊號：${macroSignal}
  </div>` : ''}
  <div class="macro-factors-title">影響加密市場的六大宏觀因素</div>
  <div class="macro-factors-grid">
    ${factors.map(f => `
      <div class="macro-factor-card" style="border-top:2px solid ${f.color}20;border-left:1px solid ${f.color}15">
        <div class="macro-factor-hdr">
          <span class="macro-factor-icon" style="color:${f.color}">${f.icon}</span>
          <span class="macro-factor-title" style="color:${f.color}">${f.title}</span>
        </div>
        <div class="macro-factor-desc">${f.desc}</div>
        <a href="${f.link}" target="_blank" rel="noopener" class="macro-factor-link">${f.linkTx}</a>
      </div>
    `).join('')}
  </div>`;
}

function buildSituationSummary(coin, mtfData, deriv, fearGreed, globalMkt, whale) {
  const price = parseFloat(coin.price) || 0;
  const tfLabels = { '15m': '15分', '1h': '1小時', '4h': '4小時', '1d': '日線' };
  const sigs = ['15m','1h','4h','1d'].map(tf => ({ tf, d: mtfData[tf]?.signal })).filter(x => x.d);
  const bullTFs = sigs.filter(x => x.d.signal.includes('bull')).map(x => tfLabels[x.tf]);
  const bearTFs = sigs.filter(x => x.d.signal.includes('bear')).map(x => tfLabels[x.tf]);
  const vBreakTFs = sigs.filter(x => (x.d.bullBreak || x.d.bearBreak) && x.d.isHighVol).map(x => tfLabels[x.tf]);

  const points = [];

  // 1. 趨勢方向
  if (bullTFs.length >= bearTFs.length + 2) {
    points.push({ icon: '📈', color: 'var(--bull)', label: '趨勢', text: `多頭佔優，${bullTFs.join('、')} 看漲${bearTFs.length ? `（${bearTFs.join('、')} 仍偏空，注意分歧）` : '，方向一致'}` });
  } else if (bearTFs.length >= bullTFs.length + 2) {
    points.push({ icon: '📉', color: 'var(--bear)', label: '趨勢', text: `空頭主導，${bearTFs.join('、')} 看跌${bullTFs.length ? `（${bullTFs.join('、')} 有支撐）` : '，趨勢較強'}` });
  } else {
    points.push({ icon: '🔄', color: 'var(--neutral)', label: '趨勢', text: `多空分歧（看漲: ${bullTFs.join('、') || '無'}；看跌: ${bearTFs.join('、') || '無'}），等待方向選擇` });
  }

  // 2. 突破信號
  if (vBreakTFs.length > 0) {
    const dir = sigs.find(x => (x.d.bullBreak || x.d.bearBreak) && x.d.isHighVol)?.d.bullBreak ? '多方' : '空方';
    points.push({ icon: '⚡', color: dir === '多方' ? 'var(--bull)' : 'var(--bear)', label: '突破', text: `${vBreakTFs.join('、')} 出現帶量實體K棒突破，${dir}信號有效，可信度高` });
  }

  // 3. 動能（RSI + ADX）
  const rsi = coin.rsi, adx = coin.adx;
  let moColor = 'var(--text2)', moText = '';
  if (rsi > 70)      { moColor = 'var(--bear)';    moText = `RSI ${rsi} 超買，短線注意回撤壓力`; }
  else if (rsi > 58) { moColor = 'var(--bull)';    moText = `RSI ${rsi} 偏強，多頭動能充足`; }
  else if (rsi < 30) { moColor = 'var(--bull)';    moText = `RSI ${rsi} 超賣，可觀察止跌信號`; }
  else if (rsi < 42) { moColor = 'var(--bear)';    moText = `RSI ${rsi} 偏弱，空頭佔據主動`; }
  else               { moColor = 'var(--neutral)'; moText = `RSI ${rsi} 中性`; }
  moText += `　ADX ${adx}（${adx > 35 ? '趨勢強勁' : adx > 25 ? '趨勢確立' : adx > 18 ? '趨勢初現' : '震盪無趨勢'}）`;
  points.push({ icon: '💫', color: moColor, label: '動能', text: moText });

  // 4. 衍生品（若有數據）
  if (deriv) {
    const fr = deriv?.fundingRate ?? 0;
    const ts = deriv.takerBuySell;
    const tl = deriv.topLongRatio;
    let derivText = '';
    derivText += `資金費率 <strong style="color:${fr < -0.002 ? 'var(--bull)' : fr > 0.002 ? 'var(--bear)' : 'var(--text2)'}">${(fr*100).toFixed(4)}%</strong>`;
    if (tl != null) derivText += `　頂級交易員多頭 <strong style="color:${tl > 0.55 ? 'var(--bull)' : tl < 0.45 ? 'var(--bear)' : 'var(--text2)'}">${(tl*100).toFixed(1)}%</strong>`;
    if (ts != null) derivText += `　Taker 買賣比 <strong style="color:${ts > 1.1 ? 'var(--bull)' : ts < 0.9 ? 'var(--bear)' : 'var(--text2)'}">${ts.toFixed(2)}</strong>`;
    const derivBull = (fr < -0.002 ? 1 : 0) + (tl > 0.55 ? 1 : 0) + (ts > 1.1 ? 1 : 0);
    const derivBear = (fr > 0.002 ? 1 : 0) + (tl < 0.45 ? 1 : 0) + (ts < 0.9 ? 1 : 0);
    const derivIcon = derivBull > derivBear ? '🟢' : derivBear > derivBull ? '🔴' : '⚪';
    points.push({ icon: derivIcon, color: 'var(--blue)', label: '合約', text: derivText });
  }

  // 5. 市場情緒（F&G）
  if (fearGreed) {
    const v  = parseInt(fearGreed.value);
    const zh = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fearGreed.value_classification] || fearGreed.value_classification;
    const fc = v >= 75 ? 'var(--bear)' : v >= 55 ? '#ff6d00' : v <= 25 ? 'var(--bull)' : v <= 45 ? 'var(--sbull)' : 'var(--neutral)';
    const advice = v >= 75 ? '市場過熱，短線謹慎追多' : v >= 55 ? '情緒偏樂觀，注意過熱' : v <= 25 ? '市場恐慌，逢低機會但波動大' : v <= 45 ? '情緒低迷，等待企穩' : '情緒中性，以技術為主';
    points.push({ icon: '🧭', color: fc, label: '情緒', text: `恐慌貪婪指數 <strong style="color:${fc}">${v}（${zh}）</strong>　${advice}` });
  }

  // 6. 宏觀環境（若有全球市場數據）
  if (globalMkt) {
    const chg = globalMkt.marketCapChange || 0;
    const dom = globalMkt.btcDominance || 50;
    const chgColor = chg > 0 ? 'var(--bull)' : chg < 0 ? 'var(--bear)' : 'var(--text3)';
    const macroIcon = chg > 2 ? '🌐' : chg < -2 ? '⚠️' : '🔵';
    const macroClr  = chg > 2 ? 'var(--bull)' : chg < -2 ? 'var(--bear)' : 'var(--neutral)';
    const macroTx   = `加密總市值 24h <strong style="color:${chgColor}">${chg > 0 ? '+' : ''}${chg}%</strong>　BTC 主導 <strong>${dom}%</strong>`
      + (dom > 58 ? '（資金避險流向BTC，山寨幣承壓）' : dom < 45 ? '（山寨季潛力，資金擴散）' : '');
    points.push({ icon: macroIcon, color: macroClr, label: '宏觀', text: macroTx });
  }

  // 7. 短線關鍵位
  const h1sig = mtfData['1h']?.signal;
  const swH   = h1sig?.swingHigh;
  const swL   = h1sig?.swingLow;
  if (swH && swL) {
    const posColor = price >= swH * 0.998 ? 'var(--bull)' : price <= swL * 1.002 ? 'var(--bear)' : 'var(--text2)';
    points.push({ icon: '📌', color: posColor, label: '關鍵位', text: `1h 壓力 <strong>${fmtPrice(swH)}</strong>　支撐 <strong>${fmtPrice(swL)}</strong>　現價 ${price >= swH * 0.998 ? '<span style="color:var(--bull)">貼近壓力，注意突破或反轉</span>' : price <= swL * 1.002 ? '<span style="color:var(--bear)">貼近支撐，注意守位或跌破</span>' : '位於震盪區間內'}` });
  }

  // 8. 巨鯨資金流向（有效訊號才顯示）
  if (whale && whale.total > 0 && (whale.bigBuyCount + whale.bigSellCount) >= 3) {
    const notable = whale.buyPct > 65 || whale.buyPct < 35;
    if (notable) {
      const isBullWhale = whale.bias === 'bull';
      const wColor = isBullWhale ? 'var(--bull)' : 'var(--bear)';
      const wIcon  = isBullWhale ? '🐋' : '🦈';
      const netM   = Math.abs(whale.netFlow / 1e6).toFixed(1);
      const wText  = isBullWhale
        ? `大額買單佔 <strong style="color:var(--bull)">${whale.buyPct}%</strong>（${whale.bigBuyCount} 筆），淨買超 <strong>$${netM}M</strong>，機構資金入場跡象`
        : `大額賣單佔 <strong style="color:var(--bear)">${(100 - whale.buyPct).toFixed(1)}%</strong>（${whale.bigSellCount} 筆），淨賣超 <strong>$${netM}M</strong>，大戶出貨跡象`;
      points.push({ icon: wIcon, color: wColor, label: '鯨魚', text: wText });
    }
  }

  // 9. 籌碼分佈（Volume Profile）
  const vp1h = mtfData['1h']?.vp;
  if (vp1h) {
    const poc = fmtPrice(vp1h.poc);
    const abv = vp1h.priceAbovePOC;
    const dist = Math.abs(vp1h.distToPOC);
    const vpColor = abv ? 'var(--bull)' : 'var(--bear)';
    const posDesc = abv
      ? `現價在籌碼密集區 POC <strong>$${poc}</strong> 上方 ${dist}%，短線籌碼較輕，VAH 壓力 <strong>${fmtPrice(vp1h.vah)}</strong>`
      : `現價在籌碼密集區 POC <strong>$${poc}</strong> 下方 ${dist}%，下方 VAL 支撐 <strong>${fmtPrice(vp1h.val)}</strong>`;
    points.push({ icon: '📦', color: vpColor, label: '籌碼', text: posDesc });
  }

  // 10. 成交量 AI
  const volAI = mtfData['1h']?.volAI;
  if (volAI) {
    const sigs = [];
    if (volAI.isBreakout)                           sigs.push('連續放量突破確認');
    if (volAI.isSpike)                              sigs.push(`成交量暴增 ${volAI.volRatio}x 均量`);
    else if (volAI.isHighVol)                       sigs.push(`放量 ${volAI.volRatio}x 均量`);
    if (volAI.isClimax)                             sigs.push('頂底量（可能反轉）');
    if (volAI.divergence === 'bullish_div')         sigs.push('看漲背離（量跌價跌）');
    else if (volAI.divergence === 'bearish_div')    sigs.push('看跌背離（量跌價漲）');
    const biasText  = volAI.bias === 'bull' ? '買盤主導' : volAI.bias === 'bear' ? '賣盤主導' : '多空均衡';
    const trendText = volAI.volTrend === 'rising' ? '量能上升📈' : volAI.volTrend === 'falling' ? '量能萎縮📉' : '量能平穩';
    const volColor  = volAI.bias === 'bull' ? 'var(--bull)' : volAI.bias === 'bear' ? 'var(--bear)' : 'var(--text2)';
    const volText   = `${biasText}，${trendText}（${volAI.volRatio}x）${sigs.length ? '　' + sigs.join('，') : ''}`;
    points.push({ icon: '📊', color: volColor, label: '成交量', text: volText });
  }

  return `<div class="situation-list">
    ${points.map(p => `
      <div class="situation-item">
        <span class="situ-icon">${p.icon}</span>
        <div class="situ-content">
          <span class="situ-label" style="color:${p.color}">${p.label}</span>
          <span class="situ-text">${p.text}</span>
        </div>
      </div>
    `).join('')}
  </div>`;
}

/* ── 多週期分析表 ─────────────────────────────────────────── */
function buildMTFTable(mtfData) {
  const tfs = [
    { key: '15m', label: '15分' }, { key: '1h', label: '1小時' },
    { key: '4h', label: '4小時' }, { key: '1d', label: '日線' },
    { key: '1w', label: '週線' },  { key: '1M', label: '月線' },
  ];
  const sigLabel = {
    strong_bull: '<span class="text-bull">強勢看漲 ▲▲</span>',
    bull_break:  '<span class="text-bull">帶量突破 ▲</span>',
    bull:        '<span class="text-bull">偏多 ↑</span>',
    neutral:     '<span class="text-neutral">中性 ◆</span>',
    bear:        '<span class="text-bear">偏空 ↓</span>',
    bear_break:  '<span class="text-bear">帶量跌破 ▼</span>',
    strong_bear: '<span class="text-bear">強勢看跌 ▼▼</span>',
  };
  let bullCount = 0, bearCount = 0;
  const rows = tfs.map(({ key, label }) => {
    const d = mtfData[key];
    if (!d || !d.signal) return `<tr><td class="mtf-tf">${label}</td><td colspan="5" style="color:var(--text3)">數據不足</td></tr>`;
    const s = d.signal;
    if (s.signal.includes('bull')) bullCount++;
    if (s.signal.includes('bear')) bearCount++;
    const breakCell = s.bullBreak ? '<span class="text-bull">✅ 實體貫穿高點</span>'
      : s.bearBreak ? '<span class="text-bear">✅ 實體貫穿低點</span>'
      : '<span style="color:var(--text3)">—</span>';
    const volCell = s.isHighVol
      ? `<span class="text-bull">${s.volRatio}x ▲放量</span>`
      : `<span style="color:var(--text3)">${s.volRatio}x</span>`;
    return `<tr>
      <td class="mtf-tf">${label}</td>
      <td>${sigLabel[s.signal] || '--'}</td>
      <td style="color:${rsiColor(s.rsi)}">${s.rsi}</td>
      <td>${breakCell}</td>
      <td>${volCell}</td>
      <td style="font-size:0.72rem;color:var(--text3)">${fmtPrice(s.swingHigh)}<br>${fmtPrice(s.swingLow)}</td>
    </tr>`;
  }).join('');
  const badge = document.getElementById('mtf-badge');
  if (badge) {
    const txt = bullCount >= 3 ? '多頭主導' : bearCount >= 3 ? '空頭主導' : '多空分歧';
    const clr = bullCount >= 3 ? 'var(--bull)' : bearCount >= 3 ? 'var(--bear)' : 'var(--neutral)';
    const bg  = bullCount >= 3 ? 'rgba(0,230,118,0.12)' : bearCount >= 3 ? 'rgba(255,29,68,0.12)' : 'rgba(255,215,64,0.12)';
    badge.textContent = txt; badge.style.color = clr; badge.style.background = bg;
  }
  return `<div class="mtf-wrap"><table class="mtf-table">
    <thead><tr>
      <th>週期</th><th>信號</th><th>RSI</th><th>K棒突破</th><th>成交量/均量</th><th>高點 / 低點</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ── 訂單流面板 ───────────────────────────────────────────── */
/* ── 市場足跡圖面板 ──────────────────────────────────────── */
function buildFootprintPanel(fp, coin) {
  if (!fp) return '<div class="adv-loading">足跡圖資料不可用</div>';

  const cur = parseFloat(coin?.price) || fp.lastClose;
  const fmtP = v => parseFloat(v).toPrecision(5).replace(/\.?0+$/, '');
  const fmtQ = v => v >= 1e6 ? (v/1e6).toFixed(2)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : v.toFixed(0);

  // ── 摘要指標 ──
  const dirClr  = fp.deltaDir === 'bull' ? 'var(--bull)' : fp.deltaDir === 'bear' ? 'var(--bear)' : 'var(--neutral)';
  const dirTx   = fp.deltaDir === 'bull' ? '▲ 買盤主導' : fp.deltaDir === 'bear' ? '▼ 賣盤主導' : '◆ 買賣均衡';
  const divClr  = fp.deltaDiv ? 'var(--bear)' : 'var(--bull)';
  const divTx   = fp.deltaDiv ? '⚡ 背離（趨勢警示）' : '✅ 同向（趨勢健康）';
  const absText = fp.absorption ? '✅ 偵測到吸籌（賣壓被買盤吸收）' : '—';
  const pocDist = cur ? Math.abs(cur - fp.poc) / cur * 100 : 0;
  const pocClr  = pocDist < 0.5 ? 'var(--bull)' : 'var(--text2)';

  // ── VWAP 偏離 ──
  const vwapDev = (fp.vwap && cur) ? ((cur - fp.vwap) / fp.vwap * 100) : null;
  const vwapClr = vwapDev == null ? 'var(--text3)'
    : Math.abs(vwapDev) < 0.3 ? '#22c55e'
    : Math.abs(vwapDev) < 1.0 ? '#f59e0b' : '#ef4444';

  // ── 市場微結構質量 ──
  const msq = fp.microstructureQuality ?? 50;
  const msqClr = msq >= 70 ? '#22c55e' : msq >= 45 ? '#f59e0b' : '#ef4444';
  const msqLabel = msq >= 70 ? '高（方向一致，訊號可靠）'
    : msq >= 45 ? '中（有噪音，謹慎操作）'
    : '低（Bid-Ask Bounce 嚴重，慎用訊號）';

  // ── 足跡K棒雙欄視圖（買/賣量並排）──
  const dispCandles = fp.candles.slice(-12);
  const maxTotal = Math.max(...dispCandles.map(c => c.total || 1), 1);
  const bars = dispCandles.map(c => {
    const buyH  = Math.max(4, (c.buyVol  / maxTotal) * 100);
    const sellH = Math.max(4, (c.sellVol / maxTotal) * 100);
    const ratio = c.total > 0 ? c.buyVol / c.total : 0.5;
    const ratioClr = ratio > 0.55 ? '#22c55e' : ratio < 0.45 ? '#ef4444' : '#94a3b8';
    const time = new Date(c.ts).toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', hour12:false });
    const dSign = c.delta >= 0 ? '+' : '';
    return `<div class="fp-bar-wrap" style="display:flex;flex-direction:column;align-items:center;gap:1px" title="${time}｜買:${fmtQ(c.buyVol)} 賣:${fmtQ(c.sellVol)} Δ${dSign}${fmtQ(c.delta)}">
      <div style="display:flex;align-items:flex-end;gap:1px;height:50px">
        <div style="width:8px;background:#22c55e;border-radius:2px 2px 0 0;height:${buyH}%;opacity:0.85" title="買 ${fmtQ(c.buyVol)}"></div>
        <div style="width:8px;background:#ef4444;border-radius:2px 2px 0 0;height:${sellH}%;opacity:0.85" title="賣 ${fmtQ(c.sellVol)}"></div>
      </div>
      <div style="font-size:0.58rem;color:${ratioClr}">${Math.round(ratio*100)}%</div>
      <div class="fp-bar-lbl" style="color:${c.delta>=0?'#22c55e':'#ef4444'};font-size:0.58rem">${dSign}${fmtQ(c.delta)}</div>
    </div>`;
  }).join('');

  // ── 累積 Delta 趨勢線（文字版）──
  let cumArr = [], s = 0;
  dispCandles.forEach(c => { s += c.delta; cumArr.push(s); });
  const cumFirst = cumArr[0] || 0, cumLast = cumArr[cumArr.length - 1] || 0;
  const cumTrend = cumLast > cumFirst * 1.02 ? '↗ 持續上升' : cumLast < cumFirst * 0.98 ? '↘ 持續下滑' : '→ 橫盤震盪';
  const cumTrClr = cumLast > cumFirst ? 'var(--bull)' : cumLast < cumFirst ? 'var(--bear)' : 'var(--neutral)';

  // ── 高量成交區（Top 5 買/賣優勢價位）──
  const buyRows  = fp.highBuyLevels.slice(0, 5).map(lv =>
    `<div class="fp-lvl-row"><span style="color:var(--bull)">▲ $${fmtP(lv.price)}</span><span class="fp-lvl-delta">+${fmtQ(lv.delta)}</span></div>`).join('');
  const sellRows = fp.highSellLevels.slice(0, 5).map(lv =>
    `<div class="fp-lvl-row"><span style="color:var(--bear)">▼ $${fmtP(lv.price)}</span><span class="fp-lvl-delta">${fmtQ(lv.delta)}</span></div>`).join('');

  return `
  <div class="fp-summary">
    <div class="fp-sum-item">
      <div class="fp-sum-label">Delta 方向</div>
      <div class="fp-sum-val" style="color:${dirClr}">${dirTx}</div>
    </div>
    <div class="fp-sum-item">
      <div class="fp-sum-label">價格 vs Delta</div>
      <div class="fp-sum-val" style="color:${divClr}">${divTx}</div>
    </div>
    <div class="fp-sum-item">
      <div class="fp-sum-label">成交量控制點（POC）</div>
      <div class="fp-sum-val" style="color:${pocClr}">$${fmtP(fp.poc)} <span style="font-size:0.7rem;color:var(--text3)">距現價 ${pocDist.toFixed(2)}%</span></div>
    </div>
    <div class="fp-sum-item">
      <div class="fp-sum-label">吸籌偵測</div>
      <div class="fp-sum-val">${absText}</div>
    </div>
    ${fp.vwap ? `<div class="fp-sum-item">
      <div class="fp-sum-label">VWAP（量加權均價）</div>
      <div class="fp-sum-val" style="color:${vwapClr}">$${fmtP(fp.vwap)}${vwapDev != null ? ` <span style="font-size:0.7rem">${vwapDev > 0 ? '+' : ''}${vwapDev.toFixed(2)}%</span>` : ''}</div>
    </div>` : ''}
    <div class="fp-sum-item">
      <div class="fp-sum-label">市場微結構質量</div>
      <div class="fp-sum-val" style="color:${msqClr}">${msq}分　${msqLabel}</div>
    </div>
    ${fp.takerBuyRatio != null ? `<div class="fp-sum-item">
      <div class="fp-sum-label">Taker 買盤佔比</div>
      <div class="fp-sum-val" style="color:${fp.takerBuyRatio>0.52?'#22c55e':fp.takerBuyRatio<0.48?'#ef4444':'var(--text3)'}">${(fp.takerBuyRatio*100).toFixed(1)}% 買 / ${((1-fp.takerBuyRatio)*100).toFixed(1)}% 賣</div>
    </div>` : ''}
  </div>

  <div class="fp-section-title">5分鐘足跡圖（藍=買量 / 紅=賣量，近 12 根）</div>
  <div style="font-size:0.68rem;color:var(--text3);margin:-4px 0 6px">每根K棒顯示：🟢買方成交量 vs 🔴賣方成交量，下方百分比為買盤佔比｜<span style="color:#f59e0b">快進快出信號另採 1m 資料偵測</span></div>
  <div class="fp-bars-area" style="align-items:flex-end;gap:4px">${bars}</div>
  <div class="fp-cum-row">
    累積 Delta：<span style="color:${cumTrClr}">${cumTrend}</span>
    <span style="color:var(--text3);font-size:0.72rem;margin-left:8px">近5根：${fp.recentDelta >= 0 ? '+' : ''}${fmtQ(fp.recentDelta)}</span>
  </div>

  ${fp.bidAskBounceScore != null ? `<div style="margin:8px 0 4px;padding:7px 10px;border-radius:8px;background:rgba(${msq>=70?'34,197,94':msq>=45?'245,158,11':'239,68,68'},.07);border:1px solid rgba(${msq>=70?'34,197,94':msq>=45?'245,158,11':'239,68,68'},.18)">
    <div style="font-size:0.72rem;font-weight:600;color:${msqClr};margin-bottom:3px">📊 市場微結構分析（Tick 品質）</div>
    <div style="font-size:0.7rem;color:var(--text2)">Bid-Ask Bounce 噪音指數：<strong style="color:${fp.bidAskBounceScore<30?'#22c55e':fp.bidAskBounceScore<60?'#f59e0b':'#ef4444'}">${fp.bidAskBounceScore}%</strong>
      <span style="color:var(--text3);margin-left:6px">${fp.bidAskBounceScore < 30 ? '低噪音，訊號可信度高' : fp.bidAskBounceScore < 60 ? '中等噪音，訊號需配合其他確認' : '高噪音（可能為Bid-Ask Bounce），訊號可靠性低'}</span></div>
    ${fp.vwap && vwapDev != null ? `<div style="font-size:0.7rem;color:var(--text2);margin-top:3px">VWAP 偏離：<strong style="color:${vwapClr}">${vwapDev > 0 ? '+' : ''}${vwapDev.toFixed(2)}%</strong>
      <span style="color:var(--text3);margin-left:6px">${Math.abs(vwapDev) < 0.3 ? '極近VWAP（最佳進場區）' : Math.abs(vwapDev) < 1.0 ? `偏離${vwapDev > 0 ? '偏高' : '偏低'}，可等回測VWAP($${fmtP(fp.vwap)})` : `嚴重偏離VWAP，均值回歸風險${vwapDev > 0 ? '向下' : '向上'}`}</span></div>` : ''}
  </div>` : ''}

  <div class="fp-levels-grid">
    <div class="fp-lvl-col">
      <div class="fp-lvl-hdr" style="color:var(--bull)">強買壓區（主動買入集中）</div>
      ${buyRows || '<div style="color:var(--text3);font-size:0.76rem">無顯著買壓集中</div>'}
    </div>
    <div class="fp-lvl-col">
      <div class="fp-lvl-hdr" style="color:var(--bear)">強賣壓區（主動賣出集中）</div>
      ${sellRows || '<div style="color:var(--text3);font-size:0.76rem">無顯著賣壓集中</div>'}
    </div>
  </div>`;
}

/* ── 爆倉地圖熱力圖 ─────────────────────────────────────────── */
function buildLiquidationPanel(liqData, coin, mtfData) {
  const price = parseFloat(coin.price) || 0;
  if (!price) return '<div class="adv-loading">價格數據不可用</div>';

  let longLiqs  = liqData?.longLiqs  || [];
  let shortLiqs = liqData?.shortLiqs || [];

  // If no real data, generate estimated levels from current price
  if (!longLiqs.length && !shortLiqs.length) {
    const leverages = [3, 5, 10, 20, 50, 100];
    longLiqs  = leverages.map(lev => ({ price: price / (1 + 1 / lev), strength: 1000 / lev, leverage: lev }));
    shortLiqs = leverages.map(lev => ({ price: price / (1 - 1 / lev), strength: 1000 / lev, leverage: lev }));
  }

  const range = price * 0.20;
  const nearLongLiqs  = longLiqs.filter(l  => Math.abs(l.price - price) <= range).sort((a, b) => b.price - a.price);
  const nearShortLiqs = shortLiqs.filter(s => Math.abs(s.price - price) <= range).sort((a, b) => a.price - b.price);

  const allNear = [
    ...nearLongLiqs.map(l  => ({ ...l, type: 'long'  })),
    ...nearShortLiqs.map(s => ({ ...s, type: 'short' })),
  ].sort((a, b) => a.price - b.price);

  const maxStr = allNear.reduce((m, l) => Math.max(m, l.strength || 1), 1);
  const fmtP = v => fmtPrice(v);
  const pct  = v => ((v / maxStr) * 100).toFixed(0);

  // Nearest key levels
  const nearestShortLiqAbove = nearShortLiqs.filter(s => s.price > price)[0];
  const nearestLongLiqBelow  = nearLongLiqs.filter(l  => l.price < price)[0];

  const keyLevelHtml = [
    nearestShortLiqAbove ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span style="color:#ef4444;font-size:0.8rem;font-weight:700">空單爆倉牆</span>
      <span style="color:#f87171;font-weight:700">${fmtP(nearestShortLiqAbove.price)}</span>
      <span style="font-size:0.72rem;color:var(--text3)">${nearestShortLiqAbove.leverage ? `${nearestShortLiqAbove.leverage}x` : ''}（壓力 / Short Squeeze 目標）</span>
    </div>` : '',
    nearestLongLiqBelow ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span style="color:#22c55e;font-size:0.8rem;font-weight:700">多單爆倉牆</span>
      <span style="color:#4ade80;font-weight:700">${fmtP(nearestLongLiqBelow.price)}</span>
      <span style="font-size:0.72rem;color:var(--text3)">${nearestLongLiqBelow.leverage ? `${nearestLongLiqBelow.leverage}x` : ''}（支撐 / Long Squeeze 目標）</span>
    </div>` : '',
  ].filter(Boolean).join('');

  // Bar rows
  const barRows = allNear.map(l => {
    const isShort = l.type === 'short';
    const color   = isShort ? 'rgba(239,68,68,.7)' : 'rgba(34,197,94,.7)';
    const bgColor = isShort ? 'rgba(239,68,68,.1)' : 'rgba(34,197,94,.1)';
    const label   = isShort ? '空單爆倉牆' : '多單爆倉牆';
    const distPct = (((l.price - price) / price) * 100).toFixed(2);
    const isCurrent = Math.abs(l.price - price) / price < 0.002;
    return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;padding:2px 0;${isCurrent ? 'border-top:1px dashed rgba(251,191,36,.5);border-bottom:1px dashed rgba(251,191,36,.5)' : ''}">
      <span style="font-size:0.68rem;color:var(--text3);min-width:72px;text-align:right">${fmtP(l.price)}</span>
      <div style="flex:1;height:14px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${pct(l.strength)}%;background:${color};border-radius:3px;transition:width 0.3s"></div>
      </div>
      <span style="font-size:0.67rem;min-width:55px;color:${isShort ? '#f87171' : '#4ade80'}">${label}</span>
      <span style="font-size:0.67rem;color:var(--text3);min-width:42px">${distPct > 0 ? '+' : ''}${distPct}%</span>
    </div>`;
  }).join('');

  const source = liqData?.source || 'estimated';
  const sourceLabel = source === 'coinglass' ? 'CoinGlass 實時' : '估算（基於常見槓桿倍數）';

  return `<div style="padding:4px 0">
    ${keyLevelHtml ? `<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 13px;margin-bottom:10px">
      <div style="font-size:0.74rem;font-weight:700;color:var(--text2);margin-bottom:7px">🔑 關鍵爆倉位</div>
      ${keyLevelHtml}
    </div>` : ''}
    <div style="font-size:0.73rem;font-weight:700;color:var(--text2);margin-bottom:6px">
      爆倉熱力圖（±20%範圍）
      <span style="font-weight:400;color:var(--text3);font-size:0.68rem;margin-left:6px">資料：${sourceLabel}</span>
    </div>
    ${allNear.length ? `<div style="max-height:280px;overflow-y:auto">${barRows}</div>` : '<div style="color:var(--text3);font-size:0.78rem">±20%範圍內無顯著爆倉位</div>'}
    <div style="margin-top:8px;font-size:0.7rem;color:var(--text3)">
      🟢 多單爆倉牆 = 做多者被強平的價格（下方支撐，Long Squeeze 觸發點）<br>
      🔴 空單爆倉牆 = 做空者被強平的價格（上方壓力，Short Squeeze 觸發點）
    </div>
  </div>`;
}

function buildOrderFlowPanel(coin, of15m) {
  if (!of15m) return '<div class="adv-loading">訂單流數據不可用</div>';

  // CVD 標籤：結合整體趨勢與近期 Delta，避免方向矛盾
  let cvdColor, cvdTx;
  const recentBull = of15m.recentDeltaSum >= 0;
  if (of15m.cvdTrend === 'bull' && recentBull) {
    cvdColor = 'var(--bull)';   cvdTx = '↑ 持續上升，買盤主導';
  } else if (of15m.cvdTrend === 'bull' && !recentBull) {
    cvdColor = 'var(--neutral)'; cvdTx = '↗ 整體偏升，但近期轉為賣出';
  } else if (of15m.cvdTrend === 'bear' && !recentBull) {
    cvdColor = 'var(--bear)';   cvdTx = '↓ 持續下降，賣盤主導';
  } else {
    cvdColor = 'var(--neutral)'; cvdTx = '↘ 整體偏降，但近期轉為買入';
  }

  const volColor = of15m.volRatio >= 1.5 ? 'var(--bull)' : of15m.volRatio >= 1 ? 'var(--neutral)' : 'var(--text3)';
  const volTx    = of15m.volRatio >= 1.5 ? '顯著放量 🔥' : of15m.volRatio >= 1 ? '正常量' : '縮量';
  const dColor   = recentBull ? 'var(--bull)' : 'var(--bear)';
  const dIcon    = recentBull ? '▲' : '▼';

  // 資金流向判斷：三個指標多數決（buyPct + 近期Delta + CVD趨勢）
  const bBuy  = of15m.buyPct >= 55;
  const bDelta = recentBull;
  const bCVD  = of15m.cvdTrend === 'bull';
  const bullCount = (bBuy ? 1 : 0) + (bDelta ? 1 : 0) + (bCVD ? 1 : 0);
  const bearCount = 3 - bullCount;

  let pressureTx, pClr;
  if (bullCount === 3) {
    pressureTx = '三項指標一致看多，主動買盤主導'; pClr = 'var(--bull)';
  } else if (bearCount === 3) {
    pressureTx = '三項指標一致看空，主動賣盤主導'; pClr = 'var(--bear)';
  } else if (bullCount === 2) {
    const conf = bBuy ? '買賣壓' : bDelta ? '近期Delta' : 'CVD';
    pressureTx = `多方佔優（${conf}偏多），但有分歧`; pClr = 'var(--sbull)';
  } else {
    const conf = !bBuy ? '買賣壓' : !bDelta ? '近期Delta' : 'CVD';
    pressureTx = `空方佔優（${conf}偏空），但有分歧`; pClr = 'var(--sbear)';
  }

  return `<div class="of-grid">
    <div class="of-block">
      <div class="of-label">買賣方壓力（近20根K棒）</div>
      <div class="of-bar-wrap"><div class="of-bar-buy" style="width:${of15m.buyPct}%"></div></div>
      <div class="of-pcts"><span class="text-bull">${of15m.buyPct}% 買方</span><span class="text-bear">${of15m.sellPct}% 賣方</span></div>
    </div>
    <div class="of-block">
      <div class="of-label">累積成交量差（CVD）</div>
      <div class="of-stat" style="color:${cvdColor}">${cvdTx}</div>
      <div class="of-sub">近10根淨Delta：<span style="color:${dColor}">${dIcon} ${fmtVolume(Math.abs(of15m.recentDeltaSum))}</span></div>
    </div>
    <div class="of-block">
      <div class="of-label">成交量 vs 均量（20期）</div>
      <div class="of-stat" style="color:${volColor}">${of15m.volRatio}x ${volTx}</div>
      <div class="of-sub">近20根大K棒：<span style="color:var(--neutral)">${of15m.bigCandles} 根</span></div>
    </div>
    <div class="of-block">
      <div class="of-label">資金流向判斷
        <span style="font-size:0.7rem;color:var(--text3);font-weight:400;margin-left:4px">（買賣壓 / 近期Delta / CVD 三項多數決）</span>
      </div>
      <div class="of-stat" style="color:${pClr}">${pressureTx}</div>
    </div>
  </div>`;
}

/* ── AI 市場分析 ──────────────────────────────────────────── */
function generateAIAnalysis(coin, mtfData, fearGreed) {
  const tfLabels = { '15m': '15分鐘', '1h': '1小時', '4h': '4小時', '1d': '日線' };
  const sigs    = ['15m','1h','4h','1d'].map(tf => ({ tf, d: mtfData[tf]?.signal })).filter(x => x.d);
  const bullTFs = sigs.filter(x => x.d.signal.includes('bull')).map(x => tfLabels[x.tf]);
  const bearTFs = sigs.filter(x => x.d.signal.includes('bear')).map(x => tfLabels[x.tf]);
  const breaks  = sigs.filter(x => x.d.bullBreak || x.d.bearBreak);
  const vBreaks = breaks.filter(x => x.d.isHighVol);

  // ── 讀取 AI 風控快取（由 buildTradeSetup 計算後存入）──
  const cached       = _tradeSetupCache[coin.symbol];
  const riskBlocked  = cached?.hardBlocked     || false;
  const blockReasons = cached?.blockReasons    || [];
  const learnWarn    = cached?.learnWarnings   || [];
  const defChecks    = cached?.defenseChecks   || [];
  const learnPen     = cached?.learnPenalty    || 0;
  const adxPen       = cached?.hardAdxPenalty  || 0;
  const macroPen     = cached?.macroOpposePenalty || 0;
  const aiPen        = cached?.aiTrendPenalty  || 0;
  const finalConf    = cached?.finalConf       ?? cached?.conf;
  const rawConf      = cached?.rawConf;
  const tradeDir     = cached?.direction;      // 'long' | 'short' | 'wait'
  // 風險評估
  const riskScore    = cached?.riskScore   ?? null;
  const riskLevel    = cached?.riskLevel   ?? '';
  const riskFactors  = cached?.riskFactors ?? [];
  const riskRecs     = cached?.riskRecs    ?? [];

  let p1;
  if (bullTFs.length >= bearTFs.length + 2)
    p1 = `📈 多週期分析顯示 <strong>${coin.symbol}</strong> 整體偏多。${bullTFs.length ? `在 <strong>${bullTFs.join('、')}</strong> 週期均呈現看漲信號` : ''}${bearTFs.length ? `，但 <strong>${bearTFs.join('、')}</strong> 存在偏空壓力，注意短線回調風險。` : '，多頭方向較一致。'}`;
  else if (bearTFs.length >= bullTFs.length + 2)
    p1 = `📉 多週期分析顯示 <strong>${coin.symbol}</strong> 整體偏空。${bearTFs.length ? `在 <strong>${bearTFs.join('、')}</strong> 週期呈現看跌信號` : ''}${bullTFs.length ? `，但 <strong>${bullTFs.join('、')}</strong> 存在支撐。` : '，空頭趨勢較強勢。'}`;
  else
    p1 = `🔄 <strong>${coin.symbol}</strong> 多空信號分歧（看漲: ${bullTFs.join('、') || '無'}；看跌: ${bearTFs.join('、') || '無'}），建議等待方向性突破確認後再行操作。`;

  let p2 = '';
  if (vBreaks.length > 0) {
    const dir = vBreaks[0].d.bullBreak ? '高點' : '低點';
    p2 = `⚡ <strong>帶量突破</strong>：<strong>${vBreaks.map(x => tfLabels[x.tf]).join('、')}</strong> 週期出現實體K棒貫穿${dir}且伴隨顯著放量，信號有效性高。`;
  } else if (breaks.length > 0) {
    const dir = breaks[0].d.bullBreak ? '高點' : '低點';
    p2 = `⚠️ <strong>${breaks.map(x => tfLabels[x.tf]).join('、')}</strong> 出現K棒突破${dir}但量能未顯著放大，需等待量能配合確認有效性。`;
  }

  let p3 = '';
  if (fearGreed) {
    const v  = parseInt(fearGreed.value);
    const zh = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fearGreed.value_classification] || fearGreed.value_classification;
    const c  = v >= 75 ? 'var(--bear)' : v >= 55 ? '#ff6d00' : v <= 25 ? 'var(--bull)' : v <= 45 ? '#69f0ae' : 'var(--neutral)';
    if (v >= 75)      p3 = `📊 市場情緒指數 <strong style="color:${c}">${v}（${zh}）</strong>：極度貪婪，歷史上此區間往往面臨較大回調壓力，建議不追高、分批止盈。`;
    else if (v >= 55) p3 = `📊 市場情緒指數 <strong style="color:${c}">${v}（${zh}）</strong>：情緒偏貪婪，整體趨樂觀，注意過熱風險。`;
    else if (v <= 25) p3 = `📊 市場情緒指數 <strong style="color:${c}">${v}（${zh}）</strong>：極度恐慌，歷史上往往為中長線較佳布局區域，短期波動仍大，建議分批布局。`;
    else if (v <= 45) p3 = `📊 市場情緒指數 <strong style="color:${c}">${v}（${zh}）</strong>：情緒偏恐慌，可觀察底部止跌信號。`;
    else              p3 = `📊 市場情緒指數 <strong style="color:var(--neutral)">${v}（${zh}）</strong>：情緒中性，多空分歧，以技術信號為主要參考。`;
  }

  const rsi = coin.rsi, adx = coin.adx;
  let p4;
  const h1Swing = mtfData['1h']?.signal?.swingHigh;
  const h1Low   = mtfData['1h']?.signal?.swingLow;
  // 風險等級對操作強度的調節詞
  const riskTag = riskScore !== null
    ? (riskScore >= 75 ? '⛔ 極高風險，強烈建議觀望'
    : riskScore >= 60 ? '⚠️ 高風險，大幅縮倉謹慎操作'
    : riskScore >= 28 ? '🟡 中風險，適度降低倉位'
    : '🟢 低風險，可正常倉位操作')
    : '';
  // 整合 AI 風控狀態與風險評估到操作建議
  if (riskBlocked) {
    p4 = `🚫 <strong>操作建議</strong>：AI 風控硬性攔截（${blockReasons[0]?.slice(0, 60) || '歷史止損條件觸發'}），本次不建議進場，等待市場條件改善。`;
  } else if (tradeDir === 'wait') {
    p4 = `⏸ <strong>操作建議</strong>：當前信號不足或條件受限（風控分 ${finalConf ?? '--'} 分），建議觀望，等待更強確認信號。${riskTag ? ` ${riskTag}。` : ''}`;
  } else if (rsi > 70 && adx > 30) {
    p4 = `⚠️ <strong>操作建議</strong>：RSI 超買（${rsi}）且趨勢強勁（ADX ${adx}），不宜追高，等待回調至 EMA20（${fmtPrice(coin.ema20)}）附近再考慮介入，設置嚴格止損。${riskTag ? ` 風險評估：${riskTag}。` : ''}`;
  } else if (rsi < 30 && adx > 25) {
    p4 = `💡 <strong>操作建議</strong>：RSI 超賣（${rsi}），若出現帶量反彈K棒可輕倉試多，止損設於近期低點下方。${riskTag ? ` 風險評估：${riskTag}。` : ''}`;
  } else if (bullTFs.length > bearTFs.length && adx > 22) {
    p4 = `✅ <strong>操作建議</strong>：多頭趨勢中（ADX ${adx}），可在回撤至 EMA20（${fmtPrice(coin.ema20)}）附近結合訂單流確認後介入，風險收益比較佳。${riskTag ? ` 風險評估：${riskTag}。` : ''}`;
  } else if (bearTFs.length > bullTFs.length && adx > 22) {
    p4 = `📉 <strong>操作建議</strong>：空頭趨勢中（ADX ${adx}），避免逆勢做多，等待 RSI 底部背離或帶量止跌K棒信號出現後再考慮布局。${riskTag ? ` 風險評估：${riskTag}。` : ''}`;
  } else {
    p4 = `🔄 <strong>操作建議</strong>：市場震盪（ADX ${adx}），建議降低倉位，等待帶量突破關鍵${h1Swing ? `高點（${fmtPrice(h1Swing)}）或低點（${fmtPrice(h1Low)}）` : 'K棒高低點'}後再行跟進。${riskTag ? ` 風險評估：${riskTag}。` : ''}`;
  }

  // ── 風險評估整合段落（只在有 buildTradeSetup 快取時顯示）──
  let p6 = '';
  if (riskScore !== null && riskFactors.length > 0) {
    const riskColor = riskScore >= 75 ? '#ef4444' : riskScore >= 60 ? '#f97316' : riskScore >= 28 ? '#f59e0b' : '#22c55e';
    const factorItems = riskFactors.slice(0, 3).map(f => `<li>${f}</li>`).join('');
    const recItems    = riskRecs.slice(0, 3).map(r => `<li style="color:#a5f3fc">${r}</li>`).join('');
    p6 = `<div style="background:${riskColor}11;border-left:3px solid ${riskColor};padding:8px 12px;border-radius:0 6px 6px 0;margin-top:4px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <strong style="color:${riskColor}">🛡️ AI 風險評估：${riskLevel}（${riskScore}/100）</strong>
      </div>
      <ul style="margin:0 0 4px 16px;font-size:0.82em;color:var(--text2)">${factorItems}</ul>
      ${recItems ? `<ul style="margin:4px 0 0 16px;font-size:0.82em">${recItems}</ul>` : ''}
    </div>`;
  }

  // ── 足跡圖分析段落 ──
  let pFP = '';
  const _fpAI = _footprintCache[coin.symbol];
  if (_fpAI) {
    try {
      const _fpDir   = _fpAI.deltaDir   || 'neutral';
      const _fpDiv   = _fpAI.deltaDiv   === true;
      const _fpAbs   = _fpAI.absorption === true;
      const _fpRecDelta = _fpAI.recentDelta || 0;
      const _fpDirLabel = _fpDir === 'bull' ? '看漲' : _fpDir === 'bear' ? '看跌' : '中性';
      const _fpDirColor = _fpDir === 'bull' ? '#22c55e' : _fpDir === 'bear' ? '#ef4444' : 'var(--text3)';
      let _fpText = `足跡圖顯示訂單流方向 <strong style="color:${_fpDirColor}">${_fpDirLabel}</strong>`;
      if (_fpAbs)  _fpText += `，偵測到主力吸籌/出貨（Absorption）行為`;
      if (_fpDiv)  _fpText += `，<strong style="color:#f59e0b">Delta 背離警告</strong>（價格與訂單流方向不一致，動能可能衰竭）`;
      if (_fpRecDelta > 0) _fpText += `，近期 Delta 正值（${_fpRecDelta > 0 ? '+' : ''}${_fpRecDelta.toFixed ? _fpRecDelta.toFixed(0) : _fpRecDelta}），買壓確認`;
      else if (_fpRecDelta < 0) _fpText += `，近期 Delta 負值（${_fpRecDelta.toFixed ? _fpRecDelta.toFixed(0) : _fpRecDelta}），賣壓確認`;
      pFP = `<div style="background:rgba(99,102,241,.06);border-left:3px solid rgba(99,102,241,.4);padding:7px 10px;border-radius:0 6px 6px 0;margin-top:4px">
        <strong style="color:#818cf8">📊 足跡圖分析</strong>：${_fpText}。
      </div>`;
    } catch(_fpe) {}
  }

  // ── 爆倉地圖分析段落 ──
  let pLiq = '';
  const _liqAI = _liquidationCache[coin.symbol];
  if (_liqAI && (_liqAI.longLiqs?.length || _liqAI.shortLiqs?.length)) {
    try {
      const _curP = parseFloat(coin.price) || 0;
      const _range = _curP * 0.20;
      const _nearLong  = (_liqAI.longLiqs  || []).filter(l => Math.abs(l.price - _curP) <= _range).sort((a, b) => b.strength - a.strength)[0];
      const _nearShort = (_liqAI.shortLiqs || []).filter(l => Math.abs(l.price - _curP) <= _range).sort((a, b) => b.strength - a.strength)[0];
      const _liqParts = [];
      if (_nearLong)  _liqParts.push(`多單爆倉牆 <strong style="color:#22c55e">$${fmtPrice(_nearLong.price)}</strong>（多空擠壓支撐位）`);
      if (_nearShort) _liqParts.push(`空單爆倉牆 <strong style="color:#ef4444">$${fmtPrice(_nearShort.price)}</strong>（空頭擠壓目標位）`);
      // Combined insight
      const _fpForLiq = _footprintCache[coin.symbol];
      let _sqInsight = '';
      if (_nearShort && _nearShort.price > _curP && _fpForLiq?.deltaDir === 'bull') {
        _sqInsight = `　⚡ <strong>Short Squeeze 潛力</strong>：空單爆倉牆在上方 + 足跡訂單流看漲，存在短期擠壓行情機會。`;
      } else if (_nearLong && _nearLong.price < _curP && _fpForLiq?.deltaDir === 'bear') {
        _sqInsight = `　⚡ <strong>Long Squeeze 潛力</strong>：多單爆倉牆在下方 + 足跡訂單流看跌，存在向下擠壓行情機會。`;
      }
      if (_liqParts.length) {
        pLiq = `<div style="background:rgba(239,68,68,.06);border-left:3px solid rgba(239,68,68,.35);padding:7px 10px;border-radius:0 6px 6px 0;margin-top:4px">
          <strong style="color:#f87171">💥 爆倉地圖</strong>：${_liqParts.join('；')}。${_sqInsight}
        </div>`;
      }
    } catch(_liqe) {}
  }

  // ── 頂級交易員視角 ──
  let pTopTrader = '';
  try {
    const _ttFP   = _footprintCache[coin.symbol];
    const _ttLiq  = _liquidationCache[coin.symbol];
    const _ttSetup = cached || {};
    const _ttPrice = parseFloat(coin.price) || 0;
    const _ttDir   = tradeDir || (bullTFs.length > bearTFs.length ? 'long' : bearTFs.length > bullTFs.length ? 'short' : null);
    if (_ttDir && _ttDir !== 'wait') {
      const _isLong = _ttDir === 'long';
      const _ttParts = [];
      // MTF 觀點
      const _ttMtfAlign = _isLong ? bullTFs.length : bearTFs.length;
      if (_ttMtfAlign >= 3) _ttParts.push(`多週期（${(_isLong ? bullTFs : bearTFs).join('、')}）同向確認，Smart Money 方向明確`);
      else if (_ttMtfAlign >= 2) _ttParts.push(`${_ttMtfAlign}個週期確認，趨勢方向成立但需進一步確認`);
      // 足跡訂單流
      if (_ttFP) {
        const _ttFPLabel = _ttFP.deltaDir === 'bull' ? '主動買盤主導' : _ttFP.deltaDir === 'bear' ? '主動賣盤主導' : '訂單流中性';
        _ttParts.push(`足跡訂單流 ${_ttFPLabel}${_ttFP.absorption ? '，主力吸籌跡象' : ''}`);
      }
      // ICT 結構
      if (_ttSetup.orderBlock) _ttParts.push(`ICT Order Block 在進場區附近（$${fmtPrice(_ttSetup.orderBlock.high || _ttSetup.orderBlock.low)}），結構支撐有效`);
      if (_ttSetup.fvg && !_ttSetup.fvg.filled) _ttParts.push(`FVG 缺口尚未回補，趨勢延續動能強`);
      // 爆倉牆
      if (_ttLiq) {
        const _ttRange = _ttPrice * 0.15;
        const _sqWall = _isLong
          ? (_ttLiq.shortLiqs || []).find(l => l.price > _ttPrice && l.price <= _ttPrice + _ttRange)
          : (_ttLiq.longLiqs  || []).find(l => l.price < _ttPrice && l.price >= _ttPrice - _ttRange);
        if (_sqWall) _ttParts.push(`${_isLong ? '空單爆倉牆' : '多單爆倉牆'}（$${fmtPrice(_sqWall.price)}）在進場方向前方，擠壓行情有利`);
      }
      // 巨鯨 + CVD
      const _ttWhale = coin.whaleData;
      if (_ttWhale) {
        const _ttWLabel = _ttWhale.bias === 'bull' ? '巨鯨大幅淨買入' : _ttWhale.bias === 'bear' ? '巨鯨大幅淨賣出' : '巨鯨動向中性';
        _ttParts.push(_ttWLabel);
      }
      if (_ttParts.length >= 2) {
        pTopTrader = `<div style="background:rgba(251,191,36,.05);border:1px solid rgba(251,191,36,.2);border-radius:8px;padding:10px 13px;margin-top:6px">
          <div style="font-weight:700;color:#fbbf24;margin-bottom:5px">👑 頂級交易員視角</div>
          <div style="font-size:0.84rem;line-height:1.8;color:var(--text2)">
            從機構視角分析 <strong>${coin.symbol}</strong>：${_ttParts.join('；')}。
            ${_ttSetup.conf >= 80 ? `<br>風控分 <strong style="color:#22c55e">${_ttSetup.conf} 分</strong>，具備高確信度進場條件。` : _ttSetup.conf >= 60 ? `<br>風控分 <strong style="color:#f59e0b">${_ttSetup.conf} 分</strong>，達入場門檻，控倉保守進場。` : ''}
          </div>
        </div>`;
      }
    }
  } catch(_tte) {}

  // ── 風控扣分整合段落（ADX + 宏觀 + AI趨勢 + AI風控規則）──
  let p5 = '';
  const totalPen = adxPen + macroPen + aiPen + learnPen;
  if (riskBlocked) {
    const brList = blockReasons.slice(0, 2).map(r => `<li>${r}</li>`).join('');
    p5 = `<div style="background:rgba(239,68,68,.08);border-left:3px solid #ef4444;padding:7px 10px;border-radius:0 6px 6px 0;margin-top:4px">
      <strong style="color:#ef4444">🚫 AI 風控：硬性攔截</strong>
      <ul style="margin:4px 0 0 16px;font-size:0.82em;color:var(--text2)">${brList}</ul>
    </div>`;
  } else if (totalPen > 0) {
    const penDetail = [
      adxPen   > 0 ? `ADX 過低 -${adxPen}%` : '',
      macroPen > 0 ? `宏觀逆風 -${macroPen}%` : '',
      aiPen    > 0 ? `AI趨勢逆向 -${aiPen}%` : '',
      learnPen > 0 ? `AI風控規則 -${learnPen}%` : '',
    ].filter(Boolean).join('　');
    p5 = `<div style="background:rgba(245,158,11,.08);border-left:3px solid #f59e0b;padding:7px 10px;border-radius:0 6px 6px 0;margin-top:4px">
      <strong style="color:#f59e0b">⚠️ 風控扣分 -${totalPen}%</strong>
      ${rawConf != null ? `<span style="color:var(--text3);font-size:0.8em;margin-left:6px">${rawConf}% → 最終 ${finalConf ?? '--'}%</span>` : ''}
      <div style="font-size:0.8em;color:var(--text3);margin-top:2px">${penDetail}</div>
    </div>`;
  } else if (cached) {
    p5 = `<div style="font-size:0.8em;color:#22c55e;margin-top:4px">✅ 風控通過：無扣分，風控分 ${finalConf ?? '--'} 分</div>`;
  }

  // ── ICT / SMC / SNR + 圖形偵測 AI 分析段落 ──
  let pICT = '';
  try {
    const _ictC     = cached || {};
    const _raw1hAI  = mtfData['1h']?.raw;
    const _raw4hAI  = mtfData['4h']?.raw;
    const _isLongAI = (cached?.direction || '') !== 'short';

    // Read from cache; fall back to direct computation when cache is empty
    const _kzAI  = _ictC.killZone  || (typeof computeKillZone === 'function' ? computeKillZone() : null);
    let _obAI    = _ictC.orderBlock  || null;
    let _ob4AI   = _ictC.orderBlock4h || null;
    let _fvgAI   = _ictC.fvg  || null;
    let _fv4AI   = _ictC.fvg4h || null;
    let _pdAI    = _ictC.premiumDiscount || null;
    const _bonAI = _ictC.ictBonus || 0;
    let _cpAI    = _ictC.chartPat  || null;
    const _bkAI  = _ictC.breakoutCheck || null;

    if (!_obAI  && _raw1hAI?.length >= 5  && typeof detectOrderBlocks   === 'function') _obAI   = detectOrderBlocks(_raw1hAI, _isLongAI);
    if (!_fvgAI && _raw1hAI?.length >= 5  && typeof detectFairValueGaps === 'function') _fvgAI  = detectFairValueGaps(_raw1hAI, _isLongAI);
    if (!_pdAI  && _raw1hAI?.length >= 5  && typeof computePremiumDiscount === 'function') _pdAI = computePremiumDiscount(_raw1hAI);
    if (!_ob4AI && _raw4hAI?.length >= 5  && typeof detectOrderBlocks   === 'function') _ob4AI  = detectOrderBlocks(_raw4hAI, _isLongAI);
    if (!_fv4AI && _raw4hAI?.length >= 5  && typeof detectFairValueGaps === 'function') _fv4AI  = detectFairValueGaps(_raw4hAI, _isLongAI);
    if (!_cpAI  && _raw4hAI?.length >= 30 && typeof detectChartPatterns === 'function') _cpAI   = detectChartPatterns(_raw4hAI, _isLongAI);
    if (!_cpAI) _cpAI = { patterns: [], score: 0, aligned: [], opposing: [], neutral: [] };

    const _ictParts = [];

    // Kill Zone
    if (_kzAI) {
      const _kzClue = _kzAI.quality === 'high' ? `🟢 現處 <strong>${_kzAI.name}</strong>（${_kzAI.desc}），是 ICT 黃金進場窗口`
                    : _kzAI.quality === 'medium' ? `🟡 現處 <strong>${_kzAI.name}</strong>（${_kzAI.desc}），波動適中可留意`
                    : `⚪ 現處 <strong>${_kzAI.name}</strong>，非主力時段，信號參考性降低`;
      _ictParts.push(_kzClue);
    }

    // Order Blocks
    const _obParts = [];
    if (_obAI)  _obParts.push(`1H ${_obAI.label} $${fmtPrice(_obAI.low)}–$${fmtPrice(_obAI.high)}${_obAI.priceInOB ? '（✅ 價格在 OB 內，機構支撐/壓力明顯）' : ''}`);
    if (_ob4AI) _obParts.push(`4H ${_ob4AI.label} $${fmtPrice(_ob4AI.low)}–$${fmtPrice(_ob4AI.high)}${_ob4AI.priceInOB ? '（✅ 4H OB 支撐確認）' : ''}`);
    if (_obParts.length) _ictParts.push(`📦 訂單塊：${_obParts.join('；')}`);

    // FVG
    const _fvgParts = [];
    if (_fvgAI)  _fvgParts.push(`1H FVG $${fmtPrice(_fvgAI.low)}–$${fmtPrice(_fvgAI.high)}（${_fvgAI.filled ? '已回補' : '⚡ 未回補，為潛在回撤目標'}）`);
    if (_fv4AI)  _fvgParts.push(`4H FVG $${fmtPrice(_fv4AI.low)}–$${fmtPrice(_fv4AI.high)}（${_fv4AI.filled ? '已回補' : '⚡ 未回補'}）`);
    if (_fvgParts.length) _ictParts.push(`📊 FVG 缺口：${_fvgParts.join('；')}`);

    // Premium / Discount
    if (_pdAI) {
      const _pdClue = (_isLongAI && _pdAI.idealForLong) ? `⚖️ 價格位於折扣區（${_pdAI.pctInRange.toFixed(0)}% 位置），SMC 最佳多頭進場位`
                    : (!_isLongAI && _pdAI.idealForShort) ? `⚖️ 價格位於溢價區（${_pdAI.pctInRange.toFixed(0)}% 位置），SMC 最佳空頭進場位`
                    : `⚖️ 當前位置 ${_pdAI.zoneLabel}（${_pdAI.pctInRange.toFixed(0)}%），均衡點 $${fmtPrice(_pdAI.equilibrium)}`;
      _ictParts.push(_pdClue);
    }

    // ICT Bonus
    if (_bonAI > 0) _ictParts.push(`✨ ICT/SMC 結構加成 +${_bonAI}%，機構結構對齊`);

    // Chart Patterns
    const _cpParts = [];
    if (_cpAI.aligned.length > 0)   _cpParts.push(`✅ 同向形態：${_cpAI.aligned.slice(0,2).map(p => `${p.emoji}${p.name}（${p.status === 'forming' ? '形成中' : '已確認'}）`).join('、')}`);
    if (_cpAI.opposing.length > 0)  _cpParts.push(`❌ 逆向警告：${_cpAI.opposing.slice(0,2).map(p => `${p.emoji}${p.name}`).join('、')}`);
    if (_cpAI.neutral.length > 0 && _cpAI.aligned.length === 0) _cpParts.push(`⚠️ 中性形態：${_cpAI.neutral.slice(0,2).map(p => `${p.emoji}${p.name}`).join('、')}，等待突破`);
    if (_bkAI && !_bkAI.confirmed && _bkAI.warn) _cpParts.push(`⚡ 突破確認不足：${_bkAI.warn}`);
    if (_cpAI.patterns.length === 0) _cpParts.push('目前 4H 無明顯技術形態，等待訊號成形');

    if (_ictParts.length || _cpParts.length) {
      pICT = `<div style="background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.2);border-radius:8px;padding:10px 13px;margin-top:6px">
        <div style="font-weight:700;color:#a78bfa;margin-bottom:6px;font-size:0.88rem">🧠 ICT / SMC / SNR 智能分析</div>
        ${_ictParts.length ? `<div style="font-size:0.84rem;line-height:2;color:var(--text2)">${_ictParts.map(p => `<div>${p}</div>`).join('')}</div>` : ''}
        ${_cpParts.length ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08)">
          <div style="font-weight:600;color:#fbbf24;margin-bottom:4px;font-size:0.84rem">📐 技術圖形偵測（4H）</div>
          <div style="font-size:0.84rem;line-height:2;color:var(--text2)">${_cpParts.map(p => `<div>${p}</div>`).join('')}</div>
        </div>` : ''}
      </div>`;
    }
  } catch(_icte) {}

  return `<div class="ai-analysis-body">
    <div class="ai-para">${p1}</div>
    ${p2 ? `<div class="ai-para">${p2}</div>` : ''}
    ${p3 ? `<div class="ai-para">${p3}</div>` : ''}
    <div class="ai-para">${p4}</div>
    ${pFP  ? `<div class="ai-para">${pFP}</div>`  : ''}
    ${pLiq ? `<div class="ai-para">${pLiq}</div>` : ''}
    ${pTopTrader ? `<div class="ai-para">${pTopTrader}</div>` : ''}
    ${pICT ? `<div class="ai-para">${pICT}</div>` : ''}
    ${p6 ? `<div class="ai-para">${p6}</div>` : ''}
    ${p5 ? `<div class="ai-para">${p5}</div>` : ''}
  </div>`;
}


/* ── ICT / SMC / SNR + 圖形識別面板（獨立渲染，置於多週期信號分析下）── */
function buildICTSMRPanel(symbol, coin, mtfData) {
  try {
    const setup = _tradeSetupCache[symbol];
    if (!setup) return '';
    const isLong       = setup.direction !== 'short';
    const _kz          = setup.killZone;
    const _ictOB       = setup.orderBlock;
    const _ictOB4h     = setup.orderBlock4h;
    const _ictFVG      = setup.fvg;
    const _ictFVG4h    = setup.fvg4h;
    const _ictPD       = setup.premiumDiscount;
    const _ictBonus    = setup.ictBonus || 0;
    const _chartPat    = setup.chartPat || { patterns: [], score: 0, aligned: [], opposing: [], neutral: [] };
    const _brkChk      = setup.breakoutCheck || { confirmed: true, warn: '' };
    const vp1h         = mtfData['1h']?.vp;
    const bb1h_        = mtfData['1h']?.bb;

    const ictHtml = (() => { try {
      const _kzSection = _kz ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">⏰ 獵殺時段</span>
      <span style="color:${_kz.quality === 'high' ? '#22c55e' : _kz.quality === 'medium' ? '#f59e0b' : 'var(--text3)'};font-weight:600">${_kz.emoji} ${_kz.name}</span>
      <span style="color:var(--text3);font-size:0.72rem">${_kz.desc}</span>
      ${_kz.quality === 'high' ? `<span style="background:rgba(34,197,94,.15);color:#22c55e;border-radius:4px;padding:1px 6px;font-size:0.7rem">黃金窗口</span>` : ''}
    </div>` : '';
      return `<div style="background:rgba(16,24,39,.7);border:1px solid rgba(99,102,241,.2);border-radius:10px;padding:10px 14px;margin-bottom:10px;font-size:0.77rem">
    <div style="font-weight:700;color:#a78bfa;margin-bottom:7px;font-size:0.8rem">🧠 ICT / SMC / SNR 智能分析</div>
    ${_kzSection}
    ${(_ictOB || _ictOB4h) ? `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">📦 訂單塊</span>
      <div>
        ${_ictOB ? `<div style="color:${_ictOB.priceInOB ? '#22c55e' : '#f59e0b'}">1H ${_ictOB.label}　$${fmtPrice(_ictOB.low)} – $${fmtPrice(_ictOB.high)}${_ictOB.priceInOB ? ' ✅ 價格在 OB 內' : ''}</div>` : ''}
        ${_ictOB4h ? `<div style="color:${_ictOB4h.priceInOB ? '#22c55e' : '#f59e0b'}">4H ${_ictOB4h.label}　$${fmtPrice(_ictOB4h.low)} – $${fmtPrice(_ictOB4h.high)}${_ictOB4h.priceInOB ? ' ✅ 價格在 OB 內' : ''}</div>` : ''}
      </div>
    </div>` : `<div style="color:var(--text3);margin-bottom:6px">📦 訂單塊　<span style="opacity:.6">當前範圍無明顯 OB</span></div>`}
    ${(_ictFVG || _ictFVG4h) ? `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">📊 FVG 缺口</span>
      <div>
        ${_ictFVG ? `<div style="color:${_ictFVG.filled ? 'var(--text3)' : '#a78bfa'}">1H　$${fmtPrice(_ictFVG.low)} – $${fmtPrice(_ictFVG.high)}（${(_ictFVG.size).toFixed(2)}%）${_ictFVG.filled ? '已回補' : '⚡ 未回補'}</div>` : ''}
        ${_ictFVG4h ? `<div style="color:${_ictFVG4h.filled ? 'var(--text3)' : '#a78bfa'}">4H　$${fmtPrice(_ictFVG4h.low)} – $${fmtPrice(_ictFVG4h.high)}（${(_ictFVG4h.size).toFixed(2)}%）${_ictFVG4h.filled ? '已回補' : '⚡ 未回補'}</div>` : ''}
      </div>
    </div>` : `<div style="color:var(--text3);margin-bottom:6px">📊 FVG 缺口　<span style="opacity:.6">近期無明顯缺口</span></div>`}
    ${_ictPD ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">⚖️ 價格位置</span>
      <span style="color:${_ictPD.idealForLong ? '#22c55e' : _ictPD.idealForShort ? '#ef4444' : '#f59e0b'};font-weight:600">${_ictPD.icon} ${_ictPD.zoneLabel}（${_ictPD.pctInRange.toFixed(0)}% 位置）</span>
      <span style="color:var(--text3);font-size:0.72rem">均衡點 $${fmtPrice(_ictPD.equilibrium)}</span>
      ${(isLong && _ictPD.idealForLong) || (!isLong && _ictPD.idealForShort) ? `<span style="background:rgba(34,197,94,.15);color:#22c55e;border-radius:4px;padding:1px 6px;font-size:0.7rem">SMC 最佳進場</span>` : ''}
    </div>` : ''}
    <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
      <span style="color:var(--text3);min-width:70px">🎯 關鍵 S/R</span>
      <div style="color:var(--text2);font-size:0.72rem;line-height:1.8">
        ${parseFloat(coin.ema200) > 0 ? `EMA200 $${fmtPrice(parseFloat(coin.ema200))}　` : ''}${parseFloat(coin.ema50) > 0 ? `EMA50 $${fmtPrice(parseFloat(coin.ema50))}　` : ''}${vp1h?.poc ? `POC $${fmtPrice(vp1h.poc)}　` : ''}${bb1h_?.upper ? `BB上 $${fmtPrice(bb1h_.upper)}　BB下 $${fmtPrice(bb1h_.lower)}` : ''}
      </div>
    </div>
    ${(() => { try {
      const _fp = _footprintCache[coin.symbol];
      if (!_fp) return '';
      const _fmtFP = v => parseFloat(v).toPrecision(4).replace(/\.?0+$/, '');
      const _dirClr = _fp.deltaDir === 'bull' ? '#22c55e' : _fp.deltaDir === 'bear' ? '#ef4444' : 'var(--text3)';
      const _dirTx  = _fp.deltaDir === 'bull' ? '▲ 買盤主導' : _fp.deltaDir === 'bear' ? '▼ 賣盤主導' : '◆ 均衡';
      const _divWarn = _fp.deltaDiv ? ` <span style="background:rgba(239,68,68,.15);color:#ef4444;padding:1px 5px;border-radius:3px;font-size:0.68rem">⚡ Delta 背離</span>` : '';
      return `<div style="display:flex;align-items:flex-start;gap:8px">
        <span style="color:var(--text3);min-width:70px">📈 足跡圖</span>
        <div style="font-size:0.72rem;line-height:1.8">
          <span style="color:${_dirClr}">${_dirTx}</span>${_divWarn}
          &nbsp;&nbsp;POC $${_fmtFP(_fp.poc)}
          ${_fp.absorption ? '　<span style="color:#22c55e;font-size:0.68rem">🔵 吸籌</span>' : ''}
        </div>
      </div>`;
    } catch(_fpe) { return ''; } })()}
    ${_ictBonus > 0 ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06);color:#22c55e;font-size:0.72rem">✨ ICT/SMC 信心加成 <strong>+${_ictBonus}%</strong></div>` : ''}
  </div>`;
    } catch(_ie) { return ''; } })();

    const cpHtml = (() => { try {
      const _cpRows = _chartPat.patterns.length
        ? _chartPat.patterns.map(p => {
            const clr = p.aligned === true ? '#22c55e' : p.aligned === false ? '#ef4444' : '#f59e0b';
            const tag = p.aligned === true ? '✅ 同向' : p.aligned === false ? '❌ 逆向' : '⚠️ 中性';
            const stateTag = p.status === 'forming'
              ? `<span style="font-size:0.66rem;color:#f59e0b;margin-left:3px">🔄 形成中</span>`
              : `<span style="font-size:0.66rem;color:#22c55e;margin-left:3px">✅ 已確認</span>`;
            return `<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:4px">
          <span style="color:${clr};font-size:0.7rem;white-space:nowrap;min-width:44px">${tag}</span>
          <div style="font-size:0.72rem;line-height:1.5">
            <span style="color:var(--text1)">${p.emoji} ${p.name}</span>${stateTag}
            <span style="color:var(--text3);font-size:0.68rem">　${p.desc}</span>
          </div>
        </div>`;
          }).join('')
        : `<div style="font-size:0.72rem;color:var(--text3)">目前 4H 圖表無明顯技術形態，待形成中訊號</div>`;
      const _bwarn = (!_brkChk.confirmed && _brkChk.warn)
        ? `<div style="margin-top:6px;padding:5px 8px;background:rgba(239,68,68,.08);border-left:2px solid #ef4444;border-radius:4px;font-size:0.7rem;color:#ef4444">⚡ 突破確認不足：${_brkChk.warn}</div>`
        : '';
      return `<div style="background:rgba(16,24,39,.7);border:1px solid rgba(251,191,36,.2);border-radius:10px;padding:10px 14px;margin-bottom:10px;font-size:0.77rem">
    <div style="font-weight:700;color:#fbbf24;margin-bottom:7px;font-size:0.8rem">📐 技術圖形識別（4H）</div>
    ${_cpRows}
    ${_bwarn}
    ${_chartPat.score > 0 ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06);color:#22c55e;font-size:0.72rem">✨ 圖形評分加成 <strong>+${Math.min(2,_chartPat.score)} 分</strong></div>` : ''}
  </div>`;
    } catch(_ce) { return ''; } })();

    return ictHtml + cpHtml;
  } catch(_e) { return ''; }
}

/* ── 幣種詳情（async）────────────────────────────────────── */
async function renderCoinDetail(symbol) {
  const coin = state.data.find(d => d.symbol === symbol);
  if (!coin) return;

  const base = symbol.replace('/USDT','');

  document.getElementById('coin-avatar').textContent  = base.slice(0, 3);
  document.getElementById('coin-name').textContent    = symbol;
  document.getElementById('coin-price').textContent   = fmtPrice(coin.price);
  document.getElementById('coin-price-sub').textContent = 'USDT';

  const trendChip = document.getElementById('coin-trend-chip');
  trendChip.textContent = trendArrow(coin.trend) + ' ' + coin.trend;
  trendChip.className   = `coin-trend-chip trend-badge ${trendClass(coin.trend)}`;

  // 评分
  const scoreEl = document.getElementById('m-score');
  scoreEl.textContent = coin.score;
  scoreEl.style.color = scoreColor(coin.score);
  const fill = document.getElementById('score-fill');
  fill.style.width      = coin.score + '%';
  fill.style.background = `linear-gradient(90deg,${scoreColor(coin.score)},${scoreColorBright(coin.score)})`;

  // RSI
  document.getElementById('m-rsi').textContent = coin.rsi;
  document.getElementById('m-rsi').style.color = rsiColor(coin.rsi);
  setTag('rsi-tag', rsiLabel(coin.rsi), rsiColor(coin.rsi));

  // ADX
  document.getElementById('m-adx').textContent = coin.adx;
  setTag('adx-tag', adxLabel(coin.adx), adxColor(coin.adx));

  // 成交量
  document.getElementById('m-vol').textContent = coin.volumeStrength;
  setTag('vol-tag', fmtVolume(coin.volume), 'var(--text3)');

  // EMA
  const p    = parseFloat(coin.price) || 0;
  const e20  = parseFloat(coin.ema20)  || 0;
  const e50  = parseFloat(coin.ema50)  || 0;
  const e200 = parseFloat(coin.ema200) || 0;

  document.getElementById('ema20').textContent  = fmtPrice(e20);
  document.getElementById('ema50').textContent  = fmtPrice(e50);
  document.getElementById('ema200').textContent = fmtPrice(e200);

  setSig('ema20-sig',  p > e20  ? '價格高於EMA20' : '價格低於EMA20',  p > e20);
  setSig('ema50-sig',  p > e50  ? '價格高於EMA50' : '價格低於EMA50',  p > e50);
  setSig('ema200-sig', p > e200 ? '高於長期均線'   : '低於長期均線',   p > e200);

  // 整合分析概覽
  const qa = document.getElementById('a-quick');
  if (qa) qa.innerHTML = buildQuickAnalysis(coin);

  // 风险
  const { level, desc, pct, cls } = buildRisk(coin);
  const rbadge = document.getElementById('risk-badge');
  rbadge.textContent = level;
  rbadge.className   = `risk-badge ${cls}`;
  const rbar = document.getElementById('risk-bar');
  rbar.style.width = pct + '%';
  rbar.style.background = cls === 'risk-low' ? 'var(--bull)' : cls === 'risk-medium' ? 'var(--neutral)' : cls === 'risk-high' ? '#ff6d00' : 'var(--bear)';
  document.getElementById('risk-desc').textContent = desc;

  setTimeout(() => loadTradingViewChart(symbol, tfToTV(state.timeframe)), 50);

  // 重置所有異步區塊
  const setL = id => { const e = document.getElementById(id); if (e) e.innerHTML = '<div class="adv-loading">載入中...</div>'; };
  setL('macro-body'); setL('deriv-body'); setL('setup-body'); setL('mtf-body'); setL('of-body'); setL('fp-body'); setL('liq-body'); setL('ai-body'); setL('vp-body'); setL('situation-body');
  const badge = document.getElementById('mtf-badge');
  if (badge) badge.textContent = '';

  // 並行獲取：多週期 + 恐慌貪婪 + 衍生品 + 宏觀市場 + 減半資訊 + 巨鯨偵測 + 足跡圖 + 爆倉地圖
  const [mtfData, fearGreed, deriv, globalMkt, halving, whale, fpData, liqData] = await Promise.all([
    fetchMTFKlines(symbol),
    fetchFearGreed(),
    fetchDerivativesData(symbol),
    fetchGlobalMarket(),
    fetchHalvingInfo(),
    fetchWhaleTrades(symbol),
    fetchFootprintData(symbol),
    fetchLiquidationMap(symbol),
    refreshPionexPrices(),
  ]);

  // 足跡圖緩存（供 AI 分析函數讀取）
  if (fpData) _footprintCache[symbol] = fpData;

  // 爆倉地圖緩存（供 AI 分析函數讀取）
  if (liqData) {
    // 若為 estimated 來源，用當前價格生成估算數據
    if (liqData.source === 'estimated' && liqData.leverages) {
      const _liqPrice = parseFloat(coin.price) || 0;
      if (_liqPrice > 0) {
        const _longLiqs = liqData.leverages.map(lev => ({
          price: _liqPrice / (1 + 1 / lev),
          strength: 1 / lev * 1000, // normalized strength
          leverage: lev,
        }));
        const _shortLiqs = liqData.leverages.map(lev => ({
          price: _liqPrice / (1 - 1 / lev),
          strength: 1 / lev * 1000,
          leverage: lev,
        }));
        _liquidationCache[symbol] = { longLiqs: _longLiqs, shortLiqs: _shortLiqs, source: 'estimated' };
      }
    } else {
      _liquidationCache[symbol] = liqData;
    }
  }

  // 緩存宏觀數據供後台使用（宏觀詳情僅在9AM簡報和幣種分析頁顯示）
  if (globalMkt || fearGreed) _macroCache = { ...(globalMkt || {}), fg: fearGreed };

  // 各區塊獨立渲染：每個區塊用自己的 try-catch，確保一個出錯不影響其他
  const setSafe = (id, buildFn) => {
    const e = document.getElementById(id);
    if (!e) return;
    try {
      const html = buildFn();
      e.innerHTML = (html != null && html !== '') ? html
        : '<div class="adv-loading">⚠️ 無資料可顯示</div>';
    } catch (err) {
      console.error(`[renderCoinDetail] ${id} 渲染失敗:`, err);
      // 顯示錯誤類型幫助除錯（不顯示完整 stack，避免資安問題）
      const errMsg = err instanceof TypeError ? `TypeError: ${String(err.message).slice(0,80)}`
                   : err instanceof ReferenceError ? `ReferenceError: ${String(err.message).slice(0,80)}`
                   : `Error: ${String(err.message || err).slice(0, 80)}`;
      e.innerHTML = `<div class="adv-loading" style="color:var(--bear)">⚠️ 載入失敗，請重新整理<br><span style="font-size:0.78rem;color:#f87171;font-weight:600;word-break:break-all">${errMsg}</span></div>`;
    }
  };

  setSafe('macro-body',     () => buildMacroPanel(globalMkt, halving, fearGreed));
  setSafe('deriv-body',     () => buildDerivativesPanel(deriv));
  setSafe('setup-body',     () => buildTradeSetup(coin, mtfData, deriv, globalMkt, whale, fearGreed));
  setSafe('mtf-body',       () => buildMTFTable(mtfData));

  // ICT panel removed — analysis now lives inside generateAIAnalysis (ai-body)
  const _ictSection = document.getElementById('ict-section');
  if (_ictSection) _ictSection.style.display = 'none';

  setSafe('of-body',        () => buildOrderFlowPanel(coin, mtfData['15m']?.orderFlow || null));
  setSafe('fp-body',        () => buildFootprintPanel(_footprintCache[symbol], coin));
  setSafe('liq-body',       () => buildLiquidationPanel(_liquidationCache[symbol], coin, mtfData));
  setSafe('ai-body',        () => generateAIAnalysis(coin, mtfData, fearGreed));
  setSafe('vp-body',        () => buildVPPanel(coin, mtfData, whale));
  setSafe('situation-body', () => buildSituationSummary(coin, mtfData, deriv, fearGreed, globalMkt, whale));

  // 14因子 AI 風險評估（宏觀資料就緒後渲染，確保準確度）
  const _frEl = document.getElementById('full-risk-body');
  if (_frEl) {
    try {
      const _frLSetup = computeSimpleSetup(coin, true);
      const _frSSetup = computeSimpleSetup(coin, false);
      const _frLong   = computeFullRisk(coin, _frLSetup, true);
      const _frShort  = computeFullRisk(coin, _frSSetup, false);
      _frEl.innerHTML = buildFullRiskCard(_frLong, '📈 做多') + buildFullRiskCard(_frShort, '📉 做空');
    } catch(_fe) {
      console.warn('[full-risk]', _fe);
      _frEl.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:8px">14因子評估暫時無法載入</div>';
    }
  }
}

function setTag(id, text, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
  const rgba = hexToRgba(color, 0.12);
  el.style.background = rgba || 'rgba(255,255,255,0.06)';
}

function setSig(id, text, bullish) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = bullish ? 'var(--bull)' : 'var(--bear)';
}

function hexToRgba(color, alpha) {
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return null;
}

/* ── TradingView 图表 ───────────────────────────────────────── */
function loadTradingViewChart(symbol, interval) {
  const container = document.getElementById('tv-chart-container');
  if (!container) return;

  // 正確銷毀舊 widget，避免殘留佔用容器
  if (state.tvWidget) {
    try { state.tvWidget.remove(); } catch {}
    state.tvWidget = null;
  }
  container.innerHTML = '';

  const base     = symbol.replace('/USDT','').replace('/','').toUpperCase();
  const tvSymbol = 'BINANCE:' + base + 'USDT';
  const ivl      = interval || '15';

  // 4 秒後若 widget 未渲染 canvas，自動切換到 iframe 備援
  const fallbackTimer = setTimeout(() => {
    if (!container.querySelector('canvas,iframe')) {
      renderFallbackChart(container, symbol, ivl);
    }
  }, 4000);

  if (typeof TradingView !== 'undefined') {
    try {
      state.tvWidget = new TradingView.widget({
        container_id: 'tv-chart-container',
        autosize:     true,
        height:       700,
        symbol:       tvSymbol,
        interval:     ivl,
        timezone:     'Asia/Taipei',
        theme:        'dark',
        style:        '1',
        locale:       'zh_TW',
        toolbar_bg:   '#0d1017',
        enable_publishing:   false,
        allow_symbol_change: true,
        hide_top_toolbar:    false,
        hide_side_toolbar:   false,
        withdateranges:      true,
        save_image:          false,
        studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
        overrides: {
          'paneProperties.background':                '#0d1017',
          'paneProperties.backgroundType':            'solid',
          'scalesProperties.textColor':               '#94a3b8',
          'mainSeriesProperties.candleStyle.upColor':          '#00e676',
          'mainSeriesProperties.candleStyle.downColor':        '#ff1744',
          'mainSeriesProperties.candleStyle.borderUpColor':    '#00e676',
          'mainSeriesProperties.candleStyle.borderDownColor':  '#ff1744',
          'mainSeriesProperties.candleStyle.wickUpColor':      '#00e676',
          'mainSeriesProperties.candleStyle.wickDownColor':    '#ff1744',
        },
        loading_screen: { backgroundColor: '#0d1017', foregroundColor: '#00d4ff' },
        onChartReady: () => clearTimeout(fallbackTimer),
      });
    } catch(e) {
      clearTimeout(fallbackTimer);
      renderFallbackChart(container, symbol, ivl);
    }
  } else {
    clearTimeout(fallbackTimer);
    renderFallbackChart(container, symbol, ivl);
  }
}

function renderFallbackChart(container, symbol, interval) {
  const base = symbol.replace('/USDT','').replace('/','').toUpperCase();
  const ivl  = interval || '15';
  // s.tradingview.com/widgetembed 是官方 CDN 嵌入端點，比 www 更可靠
  const src = `https://s.tradingview.com/widgetembed/?symbol=BINANCE%3A${base}USDT` +
    `&interval=${ivl}&theme=dark&style=1&locale=zh_TW` +
    `&hidesidetoolbar=0&hidetoptoolbar=0&saveimage=0&withdateranges=1` +
    `&studies=RSI%40tv-basicstudies%2CMACD%40tv-basicstudies`;
  container.innerHTML = `
    <iframe src="${src}"
      style="width:100%;height:700px;border:none;border-radius:8px"
      frameborder="0" allowfullscreen scrolling="no"
    ></iframe>`;
}

/* ── 分析内容构建 ───────────────────────────────────────────── */
/* ── 整合快速分析（趨勢 + 動量 + 強度 合一）─────────────────── */
function buildQuickAnalysis(coin) {
  const p   = parseFloat(coin.price)  || 0;
  const e20 = parseFloat(coin.ema20)  || p;
  const e50 = parseFloat(coin.ema50)  || p;
  const e200= parseFloat(coin.ema200) || p;

  const emaAlign = p > e20 && e20 > e50 && e50 > e200 ? '多頭排列 ↑'
                 : p < e20 && e20 < e50 && e50 < e200 ? '空頭排列 ↓'
                 : '混合排列';
  const emaColor = emaAlign.includes('多') ? 'var(--bull)' : emaAlign.includes('空') ? 'var(--bear)' : 'var(--neutral)';

  const rsiSig  = coin.rsi > 70 ? '⚠ 超買'
                : coin.rsi < 30 ? '⚠ 超賣'
                : coin.rsi > 55 ? '偏強'
                : coin.rsi < 45 ? '偏弱'
                : '中性';
  const macdSig  = coin.macdHist > 0 ? '看漲 ▲' : coin.macdHist < 0 ? '看跌 ▼' : '中性';
  const macdColor= coin.macdHist > 0 ? 'var(--bull)' : coin.macdHist < 0 ? 'var(--bear)' : 'var(--text3)';
  const momColor = parseFloat(coin.momentum) >= 0 ? 'var(--bull)' : 'var(--bear)';

  const items = [
    { lbl: '趨勢',   val: coin.trend,  color: scoreColor(coin.score) },
    { lbl: 'RSI',    val: `${coin.rsi}　${rsiSig}`,  color: rsiColor(coin.rsi) },
    { lbl: 'ADX',    val: `${coin.adx}　${adxLabel(coin.adx)}`, color: adxColor(coin.adx) },
    { lbl: '均線',   val: emaAlign, color: emaColor },
    { lbl: '動量',   val: `${parseFloat(coin.momentum) >= 0 ? '+' : ''}${coin.momentum}`, color: momColor },
    { lbl: 'MACD',   val: macdSig,  color: macdColor },
    { lbl: '成交量', val: coin.volumeStrength, color: coin.volumeStrength === '高' ? 'var(--blue)' : 'var(--text2)' },
    { lbl: '評分',   val: `${coin.score} / 100`, color: scoreColor(coin.score) },
  ];

  return `<div class="qa-grid">${items.map(it =>
    `<div class="qa-item">
      <span class="qa-lbl">${it.lbl}</span>
      <span class="qa-val" style="color:${it.color}">${it.val}</span>
    </div>`
  ).join('')}</div>`;
}

function buildTrendAnalysis(coin) {
  const e20 = parseFloat(coin.ema20), e50 = parseFloat(coin.ema50), e200 = parseFloat(coin.ema200);
  const p   = coin.price;
  const isBull = coin.score >= 60, isBear = coin.score < 40;

  const macdColor = coin.macdHist > 0 ? 'var(--bull)' : coin.macdHist < 0 ? 'var(--bear)' : 'var(--text3)';
  const rows = [
    ['整體趨勢',   `<span style="color:${scoreColor(coin.score)}">${coin.trend}</span>`],
    ['趨勢評分',   `<span style="color:${scoreColor(coin.score)}">${coin.score} / 100</span>`],
    ['均線排列',   p > e20 && e20 > e50 && e50 > e200
                     ? '<span class="text-bull">多頭排列 ↑</span>'
                     : p < e20 && e20 < e50 && e50 < e200
                     ? '<span class="text-bear">空頭排列 ↓</span>'
                     : '<span class="text-neutral">信號混合</span>'],
    ['MACD 柱',    coin.macdHist !== undefined
                     ? `<span style="color:${macdColor}">${coin.macdHist > 0 ? '+' : ''}${coin.macdHist?.toFixed ? coin.macdHist.toFixed(6) : coin.macdHist}</span>`
                     : '--'],
    ['信號匯總',   isBull ? '<span class="text-bull">偏多 — 動量支持上行</span>'
                          : isBear ? '<span class="text-bear">偏空 — 動量支持下行</span>'
                          : '<span class="text-neutral">等待更清晰的方向性信號</span>'],
  ];
  return buildRows(rows);
}

function buildSupportResistance(coin) {
  const p  = parseFloat(coin.price) || 0;
  if (!p) return buildRows([['支撐位', '--'], ['阻力位', '--']]);
  const s1 = p * 0.965;
  const s2 = p * 0.93;
  const r1 = p * 1.035;
  const r2 = p * 1.07;
  const rows = [
    ['支撐位 1', `<span style="color:var(--bull)">${fmtPrice(s1)}</span>`],
    ['支撐位 2', `<span style="color:var(--bull)">${fmtPrice(s2)}</span>`],
    ['阻力位 1', `<span style="color:var(--bear)">${fmtPrice(r1)}</span>`],
    ['阻力位 2', `<span style="color:var(--bear)">${fmtPrice(r2)}</span>`],
    ['區間寬度', `${((r1 - s1) / p * 100).toFixed(1)}%`],
  ];
  return buildRows(rows);
}

function buildMomentumAnalysis(coin) {
  const rows = [
    ['RSI (14)',  `<span style="color:${rsiColor(coin.rsi)}">${coin.rsi} — ${rsiLabel(coin.rsi)}</span>`],
    ['動量值',    `<span style="color:${coin.momentum >= 0 ? 'var(--bull)' : 'var(--bear)'}">
                    ${coin.momentum >= 0 ? '+' : ''}${coin.momentum}</span>`],
    ['訊號',      coin.rsi > 70 ? '<span class="text-bear">超買 — 存在回調風險</span>'
                 : coin.rsi < 30 ? '<span class="text-bull">超賣 — 存在反彈機會</span>'
                 : coin.rsi > 55 ? '<span class="text-bull">看漲動量積累中</span>'
                 : coin.rsi < 45 ? '<span class="text-bear">看跌動量積累中</span>'
                 : '<span class="text-neutral">處於中性區域</span>'],
    ['背離',      '未檢測到明顯背離'],
  ];
  return buildRows(rows);
}

function buildStrengthAnalysis(coin) {
  const rows = [
    ['ADX',        `<span style="color:${adxColor(coin.adx)}">${coin.adx} — ${adxLabel(coin.adx)}</span>`],
    ['成交量',     `<span class="${coin.volumeStrength === '高' ? 'text-blue' : 'text-neutral'}">${coin.volumeStrength}</span>`],
    ['趨勢強度',   coin.adx > 30 ? '<span class="text-bull">強勢趨勢進行中</span>'
                 : coin.adx > 20 ? '<span class="text-neutral">中等趨勢形成中</span>'
                 : '<span class="text-bear">弱勢或震盪市場</span>'],
    ['24小時成交量', fmtVolume(coin.volume)],
  ];
  return buildRows(rows);
}

function buildFullRiskCard(fr, label) {
  const barColor = fr.levelColor;
  let factorsHtml = '';
  for (const f of fr.factors) {
    const dot = fr.score >= 60 ? '#f97316' : fr.score >= 28 ? '#f59e0b' : '#22c55e';
    factorsHtml += '<div style="display:flex;align-items:flex-start;gap:6px;margin:3px 0;font-size:0.78rem;color:var(--text2)">'
      + '<span style="color:' + dot + ';flex-shrink:0">●</span>'
      + '<span>' + f + '</span></div>';
  }
  let recsHtml = '';
  for (let i = 0; i < Math.min(2, fr.recs.length); i++) {
    recsHtml += '<div style="margin:2px 0">💡 ' + fr.recs[i] + '</div>';
  }
  const recBlock = recsHtml
    ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);font-size:0.74rem;color:var(--text3)">' + recsHtml + '</div>'
    : '';
  return '<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
    + '<span style="font-size:0.8rem;font-weight:600;color:var(--text2)">' + label + ' · 14因子評估</span>'
    + '<span style="font-size:0.78rem;font-weight:700;color:' + barColor + ';background:' + barColor + '22;padding:2px 8px;border-radius:20px">' + fr.level + '（' + fr.score + '/100）</span>'
    + '</div>'
    + '<div style="background:var(--bg);border-radius:4px;height:6px;margin-bottom:10px;overflow:hidden">'
    + '<div style="height:100%;width:' + fr.score + '%;background:' + barColor + ';border-radius:4px;transition:width .4s"></div>'
    + '</div>'
    + factorsHtml + recBlock + '</div>';
}

function buildRisk(coin) {
  const rsiRisk  = coin.rsi > 70 || coin.rsi < 30 ? 30 : 0;
  const scoreRisk= coin.score > 85 || coin.score < 15 ? 20 : coin.score > 75 || coin.score < 25 ? 10 : 0;
  const adxRisk  = coin.adx > 40 ? 15 : 0;
  const total    = Math.min(100, 20 + rsiRisk + scoreRisk + adxRisk);

  let level, desc, cls;
  if (total < 30) {
    level = '低風險'; cls = 'risk-low';
    desc  = '市場狀況穩定，波動適中。在正常參數範圍內配置倉位是合適的。';
  } else if (total < 55) {
    level = '中等風險'; cls = 'risk-medium';
    desc  = '風險偏高但可控。建議適當減小倉位並設置更嚴格的止損位置。';
  } else if (total < 75) {
    level = '高風險'; cls = 'risk-high';
    desc  = '高波動性環境。RSI 或趨勢評分處於極端區間，建議謹慎操作，嚴格執行風險管理策略。';
  } else {
    level = '極高風險'; cls = 'risk-extreme';
    desc  = '偵測到極端市場條件。RSI 嚴重超買或超賣，請避免重倉操作，耐心等待市場整理後再行介入。';
  }
  return { level, desc, pct: total, cls };
}

function buildRows(rows) {
  return rows.map(([key, val]) => `
    <div class="analysis-row">
      <span class="analysis-row-key">${key}</span>
      <span class="analysis-row-val">${val}</span>
    </div>
  `).join('');
}

/* ── 自定義幣種管理 ─────────────────────────────────────────── */
async function addCustomPair() {
  const input = document.getElementById('add-pair-input');
  const raw   = (input?.value || '').trim().toUpperCase().replace(/\/USDT$/, '');
  if (!raw) return;

  const sym    = raw + '/USDT';
  const binSym = raw + 'USDT';
  const pairs  = loadPairs();

  if (pairs.find(p => p.s === sym)) {
    showToast(`${sym} 已在清單中`, 'error'); return;
  }

  showToast('正在驗證幣種...', 'info');
  let spotPrice = 0;
  for (const host of BINANCE_HOSTS) {
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), 5000);
      const res  = await fetch(`${host}/api/v3/ticker/price?symbol=${binSym}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 400) break;
      if (res.ok) { spotPrice = parseFloat((await res.json()).price) || 0; break; }
    } catch { continue; }
  }

  if (!spotPrice) {
    showToast(`找不到 ${sym}，請確認幣安是否有此交易對`, 'error'); return;
  }

  pairs.push({ s: sym, p: spotPrice });
  savePairs(pairs);
  if (input) input.value = '';
  renderPairsList();
  showToast(`已新增 ${sym}`, 'success');
  triggerRescan();
}

/* ── 刪除幣種時一併清除所有相關數據 ──────────────────────────── */
function purgeSymbolData(symbol) {
  // 交易記錄（持倉 + 已結束）
  const tlog = loadTradeLog().filter(t => t.symbol !== symbol);
  saveTradeLog(tlog);
  invalidateLearnCache();

  // 通知冷卻快取
  const cache = JSON.parse(localStorage.getItem(SIGNAL_CACHE_KEY) || '{}');
  delete cache[symbol];
  localStorage.setItem(SIGNAL_CACHE_KEY, JSON.stringify(cache));

  // 交易設置快取
  delete _tradeSetupCache[symbol];

  // 當前掃描數據（儀表板）
  state.data     = state.data.filter(d => d.symbol !== symbol);
  state.filtered = (state.filtered || []).filter(d => d.symbol !== symbol);
}

function removePairFromList(symbol) {
  const hasTrades = loadTradeLog().some(t => t.symbol === symbol);
  if (hasTrades) {
    if (!confirm(`確定要移除 ${symbol}？\n這將同時清除該幣種在儀表板、持倉中及交易結果中的所有相關數據。`)) return;
  }
  removePairBySymbol(symbol);
  purgeSymbolData(symbol);
  renderPairsList();
  applyFilters();
  renderAll();
  if (state.currentPage === 'positions') renderPositionsPage();
  if (state.currentPage === 'tradelog')  renderTradeLogPage();
  showToast(`已移除 ${symbol} 及相關數據`, 'info');
}

function resetCustomPairs() {
  resetToDefaultPairs();
  renderPairsList();
  showToast('已重置為默認幣種清單', 'info');
  triggerRescan();
}

function clearAllPairs() {
  if (!confirm('確定要清空所有追蹤幣種嗎？\n這將同時清除儀表板、持倉中及交易結果中所有相關數據。')) return;
  loadPairs().forEach(p => purgeSymbolData(p.s));
  savePairs([]);
  renderPairsList();
  applyFilters();
  renderAll();
  if (state.currentPage === 'positions') renderPositionsPage();
  if (state.currentPage === 'tradelog')  renderTradeLogPage();
  showToast('已清空所有幣種及相關數據', 'info');
}

function triggerRescan() {
  if (state.scanning) return;
  state.scanning = true;
  updateScanProgress(0);
  fetchMarketData(state.timeframe).then(({ data, source }) => {
    state.data = data; state.dataSource = source;
    state.scanning = false; hideScanBar();
    applyFilters(); renderAll(); checkApiStatus();
    recordSignalsFromScan(data);
    updateOpenTrades(data);
    checkAndSendAlerts(data);
  });
}

/* ── 交易記錄 ────────────────────────────────────────────────── */
const TRADE_LOG_KEY     = 'csp_trade_log';
const SIGNAL_COOLDOWN   = 2 * 60 * 60 * 1000; // 同一幣種+方向 2 小時內不重複記錄

function loadTradeLog() { try { return JSON.parse(localStorage.getItem(TRADE_LOG_KEY) || '[]'); } catch(e) { return []; } }
function saveTradeLog(log) { localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(log)); }

/* ── 取消冷卻記錄（取代 cancelled 狀態的 trade，以便從持倉中刪除）*/
const CANCEL_COOLDOWN_KEY = 'csp_cancel_cooldowns';
function loadCancelCooldowns() { try { return JSON.parse(localStorage.getItem(CANCEL_COOLDOWN_KEY) || '[]'); } catch(e) { return []; } }
function saveCancelCooldowns(list) { localStorage.setItem(CANCEL_COOLDOWN_KEY, JSON.stringify(list)); }
function addCancelCooldown(trade, reason) {
  const cutoff = Date.now() - SIGNAL_COOLDOWN;
  const all = loadCancelCooldowns().filter(c => (c.cancelTime || 0) > cutoff);
  all.unshift({ symbol: trade.symbol, direction: trade.direction, cancelTime: Date.now(), cancelReason: reason || '', entry: trade.entry, tp1: trade.tp1, sl: trade.sl });
  saveCancelCooldowns(all);
}

/* 判斷是否在冷卻期（防止同一進場機會被重複記錄）*/
function inCooldown(tlog, symbol, direction) {
  const now = Date.now();
  const sameDir = tlog.some(t =>
    t.symbol === symbol &&
    t.direction === direction &&
    (t.status === 'open' || t.status === 'pending') &&
    (now - (t.timestamp || 0)) < SIGNAL_COOLDOWN
  );
  const cancelledRecently = loadCancelCooldowns().some(c =>
    c.symbol === symbol && c.direction === direction &&
    (now - (c.cancelTime || 0)) < SIGNAL_COOLDOWN
  );
  const anyOpen = tlog.some(t =>
    t.symbol === symbol &&
    t.direction !== 'wait' &&
    (t.status === 'open' || t.status === 'pending')
  );
  return sameDir || cancelledRecently || anyOpen;
}

/* ── Telegram 訊息建構（buildTradeSetup / checkAndSendAlerts / recordSignalsFromScan 共用）── */
function buildTelegramText(coin, direction, setup, macroCache, siteUrl, opts) {
  const isLong    = direction === 'long';
  const _fmt  = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
  const _pct  = (a, b) => b ? ((Math.abs(a - b) / Math.abs(b)) * 100).toFixed(2) : '0.00';
  const _esc  = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const _sym  = coin.symbol.replace('/USDT', '');
  const _dirLabel  = isLong ? '▲ 做多（Long）' : '▼ 做空（Short）';
  const canScaleIn = !!(setup.canScaleIn || setup.isLongTerm);
  const _price = parseFloat(coin.price) || 1;
  const _pSym  = (coin.symbol || '').replace('/', '').toUpperCase();
  const _px    = v => { try { return toPionex(_pSym, _price, v); } catch(e) { return v.toFixed(4); } };

  // ── AI 週/日趨勢（優先從 macroCache 即時計算，fallback 用 setup 存儲值）──
  let wBias = 'neutral', wBiasLabel = setup.weeklyBias || '', wBiasConf = setup.weeklyConf || 0;
  let tBias = 'neutral', tBiasLabel = setup.todayBias  || '', tBiasConf = setup.todayConf  || 0;
  if (macroCache) {
    try {
      const _wb = computeWeeklyAIBias(macroCache.fg, macroCache);
      const _tb = computeTodayAIBias(macroCache.fg, macroCache);
      wBias = _wb.bias; if (_wb.biasLabel) { wBiasLabel = _wb.biasLabel; wBiasConf = _wb.conf || 0; }
      tBias = _tb.bias; if (_tb.biasLabel) { tBiasLabel = _tb.biasLabel; tBiasConf = _tb.conf || 0; }
    } catch(_e) {}
  }

  // ── AI 訊號品質等級 ──
  const _sqGradeTG = setup.sqGrade || '?';
  const _sqScoreTG = setup.sqScore ?? '—';
  const _sqLabelMap = { SSS:'神級訊號', SS:'完美訊號', S:'頂級訊號', A:'優質訊號', B:'良好訊號', C:'一般訊號', D:'訊號偏弱' };
  const _sqLabelTG = setup.sqGradeLabel || _sqLabelMap[_sqGradeTG] || '—';
  const _sqEmoji   = { SSS:'👑', SS:'💎', S:'🏆', A:'🥇', B:'🥈', C:'🥉', D:'⚠️' }[_sqGradeTG] || '📊';
  const _sqLine    = `${_sqEmoji} AI 訊號品質：<b>${_sqGradeTG} 級 — ${_sqLabelTG}</b>（21因子評分 ${_sqScoreTG} 分）`;

  // ── 風控分扣分明細（止損風控 + 風險評估扣分，在 _riskScore 已知後補充）──
  const _learnPenTg = Math.min(45, setup.learnPenalty || 0);
  const _penLines = [];
  if (_learnPenTg > 0) {
    _penLines.push(`   止損風控扣分 -${_learnPenTg} 分`);
  }

  // ── 各方向確認（短線：日/4H/1H/15m；長線加週線）──
  const _sigCheck = (sig, isLong_) => {
    if (!sig) return '⚪ —';
    const bull = sig.includes('bull');
    const bear = sig.includes('bear');
    if (isLong_) return bull ? '✅ 偏多' : bear ? '❌ 偏空' : '⚪ 中性';
    else         return bear ? '✅ 偏空' : bull ? '❌ 偏多' : '⚪ 中性';
  };
  const _15mSig = coin.signal15m || (isLong ? ((coin.score||50) >= 55 ? 'bull' : '') : ((coin.score||50) <= 45 ? 'bear' : ''));
  const _dirLines = [];
  if (canScaleIn) _dirLines.push(`   週線：${_sigCheck(coin.weeklySignal, isLong)}`);
  _dirLines.push(`   日線：${_sigCheck(coin.dailySignal, isLong)}`);
  _dirLines.push(`   4H：${_sigCheck(coin.h4Signal, isLong)}`);
  _dirLines.push(`   1H：${_sigCheck(coin.h1Signal, isLong)}`);
  _dirLines.push(`   15m：${_sigCheck(_15mSig, isLong)}`);

  // ── 本週/日 AI 預測 ──
  const _wLine = wBiasLabel ? `📈 本週預測：${_esc(wBiasLabel)}（信心 ${wBiasConf}%）` : '';
  const _tLine = tBiasLabel ? `📅 今日預測：${_esc(tBiasLabel)}（信心 ${tBiasConf}%）` : '';
  const _biasBlock = [_wLine, _tLine].filter(Boolean).join('\n');

  // ── 價格 ──
  const _tp1Pct  = _pct(setup.tp1, setup.entry);
  const _tp2Pct  = setup.tp2 ? _pct(setup.tp2, setup.entry) : null;
  const _slPct   = _pct(setup.sl, setup.entry);
  const _tp1Sign = isLong ? '+' : '-';
  const _slSign  = isLong ? '-' : '+';
  const _rr1 = setup.rr1 != null ? setup.rr1 : (() => {
    const risk = Math.abs((setup.entry || 0) - (setup.sl || 0));
    return risk > 0 ? (Math.abs((setup.tp1 || 0) - (setup.entry || 0)) / risk).toFixed(2) : '?';
  })();
  const _rr2 = setup.rr2 != null ? setup.rr2 : (setup.tp2 ? (() => {
    const risk = Math.abs((setup.entry || 0) - (setup.sl || 0));
    return risk > 0 ? (Math.abs((setup.tp2 || 0) - (setup.entry || 0)) / risk).toFixed(2) : null;
  })() : null);

  // ── 時間戳 & 標籤 ──
  const _now  = new Date();
  const _ts   = _now.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) +
                ' ' + _now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const _tags = `#${_sym.toLowerCase()} #crypto #${isLong ? 'long' : 'short'}`;

  // ── Kill Zone ──
  let _kzLine = '';
  try {
    const _kzTg = computeKillZone();
    _kzLine = `🕐 Kill Zone：${_kzTg.emoji} ${_kzTg.name}${_kzTg.quality === 'high' ? ' ✅ 黃金進場窗口' : ''}`;
  } catch(_e) {}

  // ── ICT 結構（從快取讀取）──
  const _ictCache = (typeof _tradeSetupCache !== 'undefined' && _tradeSetupCache[coin.symbol]) || {};
  const _ictLines = [];
  if (_ictCache.orderBlock?.priceInOB)  _ictLines.push(`   ⚡ ${_ictCache.orderBlock.label} 訂單塊確認`);
  if (_ictCache.fvg && !_ictCache.fvg.filled) _ictLines.push(`   📊 FVG 缺口 $${_fmt(_px(parseFloat(_ictCache.fvg.mid)))} 未回補`);
  if (_ictCache.premiumDiscount) {
    const _pd = _ictCache.premiumDiscount;
    if ((isLong && _pd.idealForLong) || (!isLong && _pd.idealForShort))
      _ictLines.push(`   ⚖️ ${_pd.icon} ${_pd.zoneLabel}（${_pd.pctInRange.toFixed(0)}%）SMC 最佳位`);
  }
  const _ictBlock = _ictLines.length ? '\n' + _ictLines.join('\n') : '';

  // ── 極端頂/底反轉可能性 ──
  let _revBlock = '';
  try {
    const _er = setup.extremeRev || _ictCache.extremeRev;
    if (_er && _er.confidence >= 60) {
      const _erIsTop  = _er.direction === 'top';
      const _erIcon   = _erIsTop ? '📉' : '📈';
      const _erDirZh  = _erIsTop ? '頂部' : '底部';
      const _erStatus = _er.confidence >= 98
        ? `⚡ <b>已達 98% 門檻，可考慮反向${_erIsTop ? '做空' : '做多'}</b>`
        : _er.confidence >= 85
          ? `⚠️ 潛在反轉（距 98% 門檻還差 ${98 - _er.confidence} 分）`
          : `🔭 早期觀察（距門檻 ${98 - _er.confidence} 分）`;
      const _erTop3 = (_er.signals || [])
        .slice().sort((a, b) => (b.pts || 0) - (a.pts || 0)).slice(0, 3)
        .map(s => `   • ${_esc(s.label)}（+${s.pts}）`).join('\n');
      _revBlock = `\n${_erIcon} <b>${_erDirZh}反轉可能性：${_er.confidence}/100</b>\n   ${_erStatus}\n${_erTop3}\n`;
      if (_er.confidence >= 85) {
        const _erAgainst = (_erIsTop && isLong) || (!_erIsTop && !isLong);
        if (_erAgainst) _revBlock += `   ⚠️ 反轉方向與本單${isLong ? '做多' : '做空'}相反，建議減倉或提前止盈\n`;
      }
    }
  } catch(_e) {}

  // ── 風險警示 ──
  const _riskScore = setup.riskScore || _ictCache.riskScore || 0;
  const _riskLevel = setup.riskLevel || _ictCache.riskLevel || '低風險';
  const _riskRecs  = setup.riskRecs  || _ictCache.riskRecs  || [];
  // 風險評估扣分 → 加入扣分明細
  const _riskPenTg = setup.riskPenalty != null ? setup.riskPenalty : calcRiskPenalty(_riskScore);
  if (_riskPenTg > 0) _penLines.push(`   風險評估扣分 -${_riskPenTg} 分（${_riskLevel} ${_riskScore}/100）`);
  let _riskBanner = '';
  if (_riskScore >= 28) {
    const _riskEmoji = _riskScore >= 75 ? '🚨🚨🚨' : _riskScore >= 60 ? '⛔⛔' : '⚠️';
    const _riskHdr   = _riskScore >= 75 ? '極高風險警示' : _riskScore >= 60 ? '高風險警示' : '中風險提示';
    const _recLine   = _riskRecs[0] ? `\n   ▸ ${_esc(_riskRecs[0])}` : '';
    const _rec2      = _riskRecs[1] ? `\n   ▸ ${_esc(_riskRecs[1])}` : '';
    _riskBanner = `\n${_riskEmoji} <b>${_riskHdr}（${_riskScore}/100）</b>：${_esc(_riskLevel)}${_recLine}${_rec2}\n`;
  }

  // ── 長線加倉計劃 ──
  let _scaleBlock = '';
  if (canScaleIn) {
    const _ltRisk    = Math.abs((setup.entry || 0) - (setup.sl || 0)) || ((setup.entry || 1) * 0.015);
    const _ltTPEst   = isLong ? (setup.entry || 0) + _ltRisk * 8 : (setup.entry || 0) - _ltRisk * 8;
    const _ltRR      = (_ltRisk > 0 ? Math.abs(_ltTPEst - (setup.entry || 0)) / _ltRisk : 0).toFixed(1);
    const _ltPct     = _pct(_ltTPEst, setup.entry);
    const _scaleN    = 2;
    const _totalMove = Math.abs(_ltTPEst - (setup.entry || 0));
    const _scaleEmojis = ['🥇', '🥈', '🥉'];
    const _scaleLines  = Array.from({ length: _scaleN }, (_, i) => {
      const n   = i + 1;
      const lvl = isLong
        ? (setup.entry || 0) + _totalMove * (n / (_scaleN + 1))
        : (setup.entry || 0) - _totalMove * (n / (_scaleN + 1));
      return `   ${_scaleEmojis[i]} 加倉${n}：$${_fmt(_px(lvl))}`;
    }).join('\n');
    _scaleBlock = `\n🏁 <b>最終止盈：$${_fmt(_px(Math.max(0, _ltTPEst)))}</b>  (${_tp1Sign}${_ltPct}% | R:R ${_ltRR}:1)\n` +
                  `\n💰 <b>加倉計劃</b>（${_scaleN} 次）\n${_scaleLines}\n`;
  }

  // ── 價格區塊 ──
  const _hdrDefault = canScaleIn ? '💎 <b>加密掃描 Pro — 長線單信號</b>' : '🚨 <b>加密掃描 Pro — 短線單信號</b>';
  const _hdr = (opts && opts.headerOverride) ? opts.headerOverride : _hdrDefault;
  const _priceLines = canScaleIn
    ? (`📍 <b>進場：$${_fmt(_px(setup.entry))}</b>\n` +
       `🛑 <b>止損：$${_fmt(_px(setup.sl))}</b>  (${_slSign}${_slPct}%)` +
       _scaleBlock)
    : (`📍 <b>進場：$${_fmt(_px(setup.entry))}</b>\n` +
       `🛑 <b>止損：$${_fmt(_px(setup.sl))}</b>  (${_slSign}${_slPct}%)\n` +
       `🎯 <b>止盈一：$${_fmt(_px(setup.tp1))}</b>  (${_tp1Sign}${_tp1Pct}% | R:R ${_rr1}:1)\n` +
       (_rr2 && setup.tp2 ? `🚀 <b>止盈二：$${_fmt(_px(setup.tp2))}</b>  (${_tp1Sign}${_tp2Pct}% | R:R ${_rr2}:1)\n` : ''));

  // ── 組合輸出（新格式）──
  // 順序：方向+幣種 → 時間 → KZ → 品質 → 風控分 → 價格 → [加倉] → 方向確認 → 本週/日預測 → 扣分項 → [風險] → [反轉]
  return `${_hdr}\n` +
    `${_dirLabel}：<b>${coin.symbol}</b>\n` +
    `⏰ ${_ts}\n` +
    (_kzLine ? `${_kzLine}${_ictBlock}\n` : '') +
    `${_sqLine}\n` +
    `📶 風控分：<b>${setup.conf} 分</b>${setup.conf < 60 ? '（⚠️ 低於門檻 60 分）' : ''}\n` +
    `\n${_priceLines}\n` +
    (_biasBlock ? `\n${_biasBlock}\n` : '') +
    (_penLines.length ? `\n🛡️ <b>風控扣分明細</b>\n${_penLines.join('\n')}\n` : '') +
    _riskBanner +
    _revBlock +
    `\n${_tags}\n` +
    `🔗 <a href="${siteUrl}">查看 ${_sym} 詳細分析 →</a>`;
}

/* ── 從掃描數據自動記錄交易信號 ──────────────────────────────── */
async function recordSignalsFromScan(data) {
  const tlog = loadTradeLog();
  // 記錄本次掃描開始前已存在的掛單 ID，SQ 監控只處理這些（不重複驗證剛建立的掛單）
  const _existingTradeIds = new Set(tlog.map(t => t.id));
  let changed = false;

  // ── 預先計算宏觀方向（使用與大方向進度條完全一致的多因子評分）──
  let macroNetDir = 'neutral';  // 預設：無快取時全放行
  let wBias = 'neutral', tBias = 'neutral';
  let wBiasLabel = '', wBiasConf = 0, tBiasLabel = '', tBiasConf = 0;
  let wBiasOpinion = '', tBiasOpinion = '';
  let wbRangeMode = false, tbRangeMode = false;  // 本週/今日預測是否為中性/震盪
  let macroPenLong = 0, macroPenShort = 0;
  if (_macroCache) {
    try {
      const fg = _macroCache.fg;
      const gm = _macroCache;
      macroNetDir = computeMacroNetDir(fg, gm);  // 與 UI 大方向完全對齊
      const wb = computeWeeklyAIBias(fg, gm);
      const tb = computeTodayAIBias(fg, gm);
      wBias = wb.bias;
      tBias = tb.bias;
      wBiasLabel   = wb.biasLabel  || '';
      wBiasConf    = wb.conf       || 0;
      wBiasOpinion = wb.aiOpinion  || '';
      tBiasLabel   = tb.biasLabel  || '';
      tBiasConf    = tb.conf       || 0;
      tBiasOpinion = tb.aiOpinion  || '';
      wbRangeMode  = wb.rangeMode  || false;
      tbRangeMode  = tb.rangeMode  || false;

      // 計算宏觀逆風扣分
      const fgVal  = fg ? parseInt(fg.value || '50') : 50;
      const chgVal = gm?.marketCapChange || 0;
      const domVal = gm?.btcDominance   || 50;

      let againstLong = 0;
      if (chgVal < -2) againstLong++;
      if (domVal > 58) againstLong++;
      if (fgVal  < 30) againstLong++;
      if (fgVal  > 75) againstLong += 0.5;
      macroPenLong = againstLong >= 3 ? 12 : againstLong >= 2 ? 8 : againstLong >= 1 ? 3 : 0;

      let againstShort = 0;
      if (chgVal > 2)  againstShort++;
      if (domVal < 44) againstShort++;
      if (fgVal  > 70) againstShort++;
      if (fgVal  < 25) againstShort += 0.5;
      macroPenShort = againstShort >= 3 ? 12 : againstShort >= 2 ? 8 : againstShort >= 1 ? 3 : 0;

      // AI 走勢方向扣分（附加於宏觀扣分之上，上限 15 避免全面封鎖）
      if (wBias.includes('bear')) macroPenLong  += wBias.includes('strong') ? 6 : 3;
      if (tBias.includes('bear')) macroPenLong  += 4;
      if (wBias.includes('bull')) macroPenShort += wBias.includes('strong') ? 6 : 3;
      if (tBias.includes('bull')) macroPenShort += 4;
      // 總扣分上限：不超過 18，確保強信號（score ≥ 80）在逆風中仍可通過
      macroPenLong  = Math.min(18, macroPenLong);
      macroPenShort = Math.min(18, macroPenShort);
    } catch(e) { /* 宏觀計算失敗 → 維持 neutral，允許記錄 */ }
  }

  // ── 方向封鎖：僅在「宏觀 strong_bear/bull」或「週線 strong_bear/bull（最高等級）」才全局硬封鎖 ──
  // slight_bear / bear 等中弱信號不封鎖全局，改為在個別長線單的週向對齊條件中處理
  const blockLong  = macroNetDir === 'strong_bear' || wBias === 'strong_bear';
  const blockShort = macroNetDir === 'strong_bull' || wBias === 'strong_bull';

  // ── 全中性輔助判定（用於迴圈內按幣種條件判斷）──
  const _wNeutral = !wBias.includes('bull') && !wBias.includes('bear') || wbRangeMode;
  const _tNeutral = !tBias.includes('bull') && !tBias.includes('bear') || tbRangeMode;

  // ══════════════════════════════════════════════════════════════
  // 統一掃描迴圈 ── 邏輯與 buildTradeSetup 記錄時完全一致
  // 條件：幣種有明確方向（score ≠ 50）+ 無活躍倉位 + 無冷卻 + 風控分 ≥ 50% + SQ 評分 B+
  // 長線升級：日線 + 週線均同向 → canScaleIn=true
  // ══════════════════════════════════════════════════════════════
  for (const coin of data) {
    if (coin.score === 50) continue;
    const isLong    = coin.score > 50;
    const direction = isLong ? 'long' : 'short';

    // 強烈宏觀硬封鎖（與 buildTradeSetup macroBlockedForRecord 完全一致）
    if (isLong  && blockLong)  continue;
    if (!isLong && blockShort) continue;

    // 已有活躍倉位或在冷卻期 → 跳過
    const hasOpen = tlog.some(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending'));
    if (hasOpen) continue;
    if (inCooldown(tlog, coin.symbol, direction)) continue;

    // 今日 AI 反向 → 無論信心度一律封鎖；週預測信心<70 僅作參考
    if (isLong  && (tBias === 'bear' || tBias === 'strong_bear')) continue;
    if (!isLong && (tBias === 'bull' || tBias === 'strong_bull')) continue;

    // 計算交易設置（與 buildTradeSetup 使用相同的 computeSimpleSetup）
    const setup = computeSimpleSetup(coin, isLong);
    if (setup.hardBlocked) continue;
    if (setup.rrBlocked)   continue;  // R/R < 1.3 → 硬性封鎖
    // 風控分最低門檻（100 分制，與幣種詳情頁一致）
    if ((setup.conf || 0) < 60) continue;
    // 週預測信心≥70 且強衝突（週強多+日強空 或 週強空+日強多）→ 硬封鎖；信心<70 僅作參考
    const wkStrong = wBias.includes('strong'), dyStrong = tBias.includes('strong');
    if (wBiasConf >= 70 && wkStrong && dyStrong && ((isLong && tBias === 'bear') || (!isLong && tBias === 'bull'))) continue;

    // 完整風險評估（14 因子）
    let _scanRisk = { score: 0, level: '低風險', levelColor: '#22c55e', factors: [], recs: [] };
    try {
      _scanRisk = computeFullRisk(coin, setup, isLong);
      if (!_tradeSetupCache[coin.symbol]) _tradeSetupCache[coin.symbol] = {};
      Object.assign(_tradeSetupCache[coin.symbol], {
        riskScore: _scanRisk.score, riskLevel: _scanRisk.level,
        riskFactors: _scanRisk.factors, riskRecs: _scanRisk.recs,
      });
    } catch(_re) { console.warn('[risk]', coin.symbol, _re); }
    // 風險評估扣分（比例制）：扣後風控分低於 60 → 跳過
    const _scanRiskPen = calcRiskPenalty(_scanRisk.score);
    if (Math.max(0, (setup.conf || 0) - _scanRiskPen) < 60) continue;

    // ── 長線升級判斷：週線+日線+4H+15m 四週期同向 → 長線單；日線+4H+1H+15m → 短線單 ──
    let canScaleIn = setup.isLongTerm === true;

    // R/R 門檻：多空皆 ≥1.3
    const _scanRR = setup.rr1 || 0;
    if (parseFloat(_scanRR) < 1.3) continue;
    // 長線單：週預測信心≥70 時週向須對齊（信心<70 僅作參考）
    if (canScaleIn && wBiasConf >= 70) {
      const _wkAligned = isLong ? wBias.includes('bull') : wBias.includes('bear');
      if (!_wkAligned) continue;
    }


    // ── 補充抓取掃描情境缺少的非同步資料（讓 SQ 評分與幣種詳情頁完全一致）──
    // 使用 5 分鐘快取避免每 15s 輪掃時重複請求
    const _sfNow = Date.now();
    const _sfCached = _scanFetchCache[coin.symbol];
    if (!_sfCached || (_sfNow - _sfCached.ts) > 5 * 60 * 1000) {
      try {
        const [_sfDeriv, _sfWhale, _sfFP, _sfLiq, _sfMTF] = await Promise.all([
          fetchDerivativesData(coin.symbol),
          fetchWhaleTrades(coin.symbol),
          fetchFootprintData(coin.symbol),
          fetchLiquidationMap(coin.symbol),
          fetchMTFKlines(coin.symbol),
        ]);
        if (_sfDeriv) coin.derivData = _sfDeriv;
        if (_sfWhale) coin.whaleData = _sfWhale;
        if (_sfFP)    _footprintCache[coin.symbol] = _sfFP;
        if (_sfLiq) {
          // 與幣種詳情頁相同的爆倉地圖後處理
          if (_sfLiq.source === 'estimated' && _sfLiq.leverages) {
            const _p = parseFloat(coin.price) || 0;
            if (_p > 0) {
              _liquidationCache[coin.symbol] = {
                longLiqs:  _sfLiq.leverages.map(lev => ({ price: _p / (1 + 1 / lev), strength: 1 / lev * 1000, leverage: lev })),
                shortLiqs: _sfLiq.leverages.map(lev => ({ price: _p / (1 - 1 / lev), strength: 1 / lev * 1000, leverage: lev })),
                source: 'estimated',
              };
            }
          } else {
            _liquidationCache[coin.symbol] = _sfLiq;
          }
        }
        // ICT 結構 + 圖形確認（需要多週期 K 線）→ 寫入 _tradeSetupCache 供 SQ ⑥⑯ 使用
        if (_sfMTF) {
          const _sfR1h = _sfMTF['1h']?.rawCandles;
          const _sfR4h = _sfMTF['4h']?.rawCandles;
          let _sfOB = null, _sfFVG = null, _sfOB4h = null, _sfFVG4h = null, _sfPat = null;
          try {
            if (_sfR1h?.length >= 5 && typeof detectOrderBlocks   === 'function') _sfOB   = detectOrderBlocks(_sfR1h, isLong);
            if (_sfR1h?.length >= 5 && typeof detectFairValueGaps === 'function') _sfFVG  = detectFairValueGaps(_sfR1h, isLong);
            if (_sfR4h?.length >= 5 && typeof detectOrderBlocks   === 'function') _sfOB4h = detectOrderBlocks(_sfR4h, isLong);
            if (_sfR4h?.length >= 5 && typeof detectFairValueGaps === 'function') _sfFVG4h= detectFairValueGaps(_sfR4h, isLong);
            if (_sfR4h?.length >= 30 && typeof detectChartPatterns === 'function') _sfPat = detectChartPatterns(_sfR4h, isLong);
          } catch(_ice) {}
          if (!_tradeSetupCache[coin.symbol]) _tradeSetupCache[coin.symbol] = {};
          Object.assign(_tradeSetupCache[coin.symbol], {
            orderBlock: _sfOB, fvg: _sfFVG,
            orderBlock4h: _sfOB4h, fvg4h: _sfFVG4h,
            chartPat: _sfPat,
            killZone: typeof computeKillZone === 'function' ? computeKillZone() : null,
          });
        }
        _scanFetchCache[coin.symbol] = { ts: _sfNow };
      } catch(_fe) { /* API 失敗時繼續評分，缺項因子不得分 */ }
    }

    // MACD 方向（僅供 SQ 評分使用）
    const _scanMacd    = parseFloat(coin.macdHist) || 0;
    const _macdAligned = isLong ? _scanMacd > 0 : _scanMacd < 0;

    // ── 完整版訊號品質評分（4H+15m 硬性條件 + 其餘時框加分，等級門檻 SSS≥20/SS≥17/S≥15/A≥9/B≥6/C≥3/D<3）──
    let _scanSqScore = 0;
    const _scanSqFactors = [];

    // ① 硬性條件：4H + 15m 雙雙同向（不符合直接跳過，不進入 SQ 評分）
    const _ssH4Ok  = isLong ? (coin.h4Signal  ||'').includes('bull') : (coin.h4Signal  ||'').includes('bear');
    const _ss15mSig = coin.signal15m || (isLong ? ((coin.score||50) >= 55 ? 'bull' : '') : ((coin.score||50) <= 45 ? 'bear' : ''));
    const _ss15mOk  = isLong ? _ss15mSig.includes('bull') : _ss15mSig.includes('bear');
    const _ssDayOk = isLong ? (coin.dailySignal ||'').includes('bull') : (coin.dailySignal ||'').includes('bear');
    if (!_ssH4Ok || !_ss15mOk) continue; // 硬性條件未達標 → 跳過
    if (canScaleIn && !_ssDayOk) continue; // 長線單額外需日線同向（canScaleIn 已保證此條件，這是防禦性檢查）
    _scanSqFactors.push(canScaleIn ? '✅ 日線+4H+15m 三確認（長線硬性條件）' : '✅ 4H+15m 雙確認（短線硬性條件）');
    // 其餘時框同向加分（1H / 日線 / 週線）— max +3
    const _ssWkOk  = isLong ? (coin.weeklySignal||'').includes('bull') : (coin.weeklySignal||'').includes('bear');
    const _ssH1Ok  = isLong ? (coin.h1Signal    ||'').includes('bull') : (coin.h1Signal    ||'').includes('bear');
    if (_ssDayOk)      { _scanSqScore += 1; _scanSqFactors.push('✅ 日線同向 +1'); }
    else if (isLong ? (coin.dailySignal||'').includes('bear') : (coin.dailySignal||'').includes('bull'))
                       { _scanSqScore -= 1; _scanSqFactors.push('❌ 日線逆向 -1'); }
    else               { _scanSqFactors.push('⬜ 日線中性'); }
    if (_ssWkOk)       { _scanSqScore += 1; _scanSqFactors.push('✅ 週線同向 +1'); }
    else if (isLong ? (coin.weeklySignal||'').includes('bear') : (coin.weeklySignal||'').includes('bull'))
                       { _scanSqScore -= 1; _scanSqFactors.push('❌ 週線逆向 -1'); }
    else               { _scanSqFactors.push('⬜ 週線中性'); }
    if (_ssH1Ok) { _scanSqScore += 1; _scanSqFactors.push('✅ 1H 同向 +1'); }
    else         { _scanSqFactors.push('⬜ 1H 中性/逆向'); }
    // MACD +1
    if (_macdAligned) { _scanSqScore += 1; _scanSqFactors.push('✅ MACD 同向 +1'); }

    // ② 本週 AI ±1
    if (isLong ? wBias.includes('bull') : wBias.includes('bear')) { _scanSqScore += 1; _scanSqFactors.push(`✅ 本週AI同向（${wBiasLabel}）+1`); }
    else if (isLong ? wBias.includes('bear') : wBias.includes('bull')) { _scanSqScore -= 1; _scanSqFactors.push(`❌ 本週AI逆向（${wBiasLabel}）-1`); }
    else { _scanSqFactors.push(`⚠️ 本週AI中性（${wBiasLabel || '—'}）`); }

    // ③ 今日 AI ±1
    if (isLong ? tBias.includes('bull') : tBias.includes('bear')) { _scanSqScore += 1; _scanSqFactors.push(`✅ 今日AI同向（${tBiasLabel}）+1`); }
    else if (isLong ? tBias.includes('bear') : tBias.includes('bull')) { _scanSqScore -= 1; _scanSqFactors.push(`❌ 今日AI逆向（${tBiasLabel}）-1`); }
    else { _scanSqFactors.push(`⚠️ 今日AI中性（${tBiasLabel || '—'}）`); }

    // ④ 宏觀環境 ±2
    if (_macroCache) try {
      const _ssFg   = _macroCache.fg;
      const _ssFgV  = parseInt(_ssFg?.value || '50');
      const _ssNet  = computeMacroNetDir(_ssFg, _macroCache);
      const _ssMOk  = isLong ? _ssNet.includes('bull') : _ssNet.includes('bear');
      const _ssMOpp = isLong ? _ssNet.includes('bear') : _ssNet.includes('bull');
      const _ssFgN  = _ssFgV >= 40 && _ssFgV <= 60;
      let _ssMacPts = 0;
      if (_ssMOk)  _ssMacPts += 1;
      if (_ssFgN && !_ssMOpp) _ssMacPts += 1;
      if (_ssMOpp) _ssMacPts -= 2;
      _scanSqScore += Math.max(-2, Math.min(2, _ssMacPts));
      if (_ssMacPts >= 2)       _scanSqFactors.push(`✅ 宏觀環境同向（F&G ${_ssFgV}）+2`);
      else if (_ssMacPts === 1) _scanSqFactors.push(`⚠️ 宏觀環境部分支持（F&G ${_ssFgV}）+1`);
      else if (_ssMacPts < 0)   _scanSqFactors.push(`❌ 宏觀環境逆風（${_ssNet}）`);
      else                      _scanSqFactors.push(`⬜ 宏觀環境中性（F&G ${_ssFgV}）`);
    } catch(_e) {}

    // ⑤ 足跡圖 Delta ±1 + 市場微結構 ±1
    const _ssFP = _footprintCache[coin.symbol];
    if (_ssFP) {
      if (_ssFP.deltaDiv) { _scanSqScore -= 1; _scanSqFactors.push('⚡ 足跡圖 Delta 背離 -1'); }
      else if (isLong ? (_ssFP.deltaDir === 'bull') : (_ssFP.deltaDir === 'bear')) { _scanSqScore += 1; _scanSqFactors.push('✅ 足跡圖 Delta 確認 +1'); }
      else if (isLong ? (_ssFP.deltaDir === 'bear') : (_ssFP.deltaDir === 'bull')) { _scanSqScore -= 1; _scanSqFactors.push('❌ 足跡圖 Delta 逆向 -1'); }
      else { _scanSqFactors.push('⬜ 足跡圖 Delta 中性'); }
      if ((_ssFP.microstructureQuality || 0) >= 7) { _scanSqScore += 1; _scanSqFactors.push(`✅ 市場微結構優質（${_ssFP.microstructureQuality}分）+1`); }
      else if ((_ssFP.microstructureQuality || 0) <= 3) { _scanSqScore -= 1; _scanSqFactors.push(`❌ 市場微結構偏弱（${_ssFP.microstructureQuality}分）-1`); }
    }

    // ⑦ ADX ±1
    const _ssAdx = parseFloat(coin.adx) || 20;
    if (_ssAdx >= 28) { _scanSqScore += 1; _scanSqFactors.push(`✅ ADX ${_ssAdx} 趨勢確立 +1`); }
    else if (_ssAdx >= 22) { _scanSqFactors.push(`⚠️ ADX ${_ssAdx} 趨勢偏弱`); }
    else { _scanSqScore -= 1; _scanSqFactors.push(`❌ ADX ${_ssAdx} 趨勢過弱 -1`); }

    // ⑧ Taker 訂單流 ±1
    try {
      const _ssTkr = coin.derivData?.takerBuySell ?? 1;
      if (isLong ? _ssTkr >= 1.08 : _ssTkr <= 0.92) { _scanSqScore += 1; _scanSqFactors.push(`✅ 訂單流同向（Taker ${_ssTkr.toFixed(2)}）+1`); }
      else if (isLong ? _ssTkr < 0.88 : _ssTkr > 1.12) { _scanSqScore -= 1; _scanSqFactors.push(`❌ 訂單流逆向（Taker ${_ssTkr.toFixed(2)}）-1`); }
      else { _scanSqFactors.push(`⬜ 訂單流中性（Taker ${_ssTkr.toFixed(2)}）`); }
    } catch(_e) {}

    // ⑨ 巨鯨籌碼 ±1
    try {
      const _ssWhl = coin.whaleData;
      if (_ssWhl) {
        if (isLong ? (_ssWhl.bias === 'bull' && (_ssWhl.bigBuyCount  ||0) >= 2)
                   : (_ssWhl.bias === 'bear' && (_ssWhl.bigSellCount ||0) >= 2))
          { _scanSqScore += 1; _scanSqFactors.push(`✅ 巨鯨${isLong?'買入':'賣出'}同向 +1`); }
        else if (isLong ? (_ssWhl.bias === 'bear' && (_ssWhl.bigSellCount||0) >= 3)
                        : (_ssWhl.bias === 'bull' && (_ssWhl.bigBuyCount ||0) >= 3))
          { _scanSqScore -= 1; _scanSqFactors.push(`❌ 巨鯨${isLong?'賣出':'買入'}逆向 -1`); }
      }
    } catch(_e) {}

    // ⑩ 成交量 ±1
    const _ssVol = coin.volumeStrength || '';
    if (_ssVol.includes('強') || _ssVol === 'high') { _scanSqScore += 1; _scanSqFactors.push('✅ 成交量放大同向 +1'); }
    else if (_ssVol.includes('弱') || _ssVol === 'low') { _scanSqScore -= 1; _scanSqFactors.push('❌ 成交量萎縮 -1'); }

    // ⑪ BB走軌 ±1
    try {
      const _ssBB = coin.bb;
      if (_ssBB) {
        if (isLong ? _ssBB.walkingBull : _ssBB.walkingBear) { _scanSqScore += 1; _scanSqFactors.push(`✅ BB${isLong?'多':'空'}頭走軌確認 +1`); }
        else if (isLong ? _ssBB.walkingBear : _ssBB.walkingBull) { _scanSqScore -= 1; _scanSqFactors.push(`❌ BB逆向走軌 -1`); }
      }
    } catch(_e) {}

    // ⑫ 技術面 ±1
    if (setup.techPenalty === 0) { _scanSqScore += 1; _scanSqFactors.push('✅ 技術面無逆風 +1'); }
    else if (setup.techPenalty >= 12) { _scanSqScore -= 1; _scanSqFactors.push(`❌ 技術面逆風（-${setup.techPenalty}%）-1`); }

    // ⑬ R/R ±1
    const _sqRRScan = parseFloat(setup.rr1) || 0;
    if (_sqRRScan >= 2.0) { _scanSqScore += 1; _scanSqFactors.push(`✅ R/R ${_sqRRScan.toFixed(1)}:1 優良 +1`); }
    else if (_sqRRScan >= 1.3) { _scanSqFactors.push(`⚠️ R/R ${_sqRRScan.toFixed(1)}:1（可接受）`); }
    else { _scanSqScore -= 1; _scanSqFactors.push(`❌ R/R ${_sqRRScan.toFixed(1)}:1 不足 -1`); }

    // ⑭ 風控分數 +2/+1/-1
    if (_scanRisk.score <= 20)      { _scanSqScore += 2; _scanSqFactors.push(`✅ 風控優良（${_scanRisk.score}分）+2`); }
    else if (_scanRisk.score <= 40) { _scanSqScore += 1; _scanSqFactors.push(`✅ 風控良好（${_scanRisk.score}分）+1`); }
    else if (_scanRisk.score <= 54) { _scanSqFactors.push(`⚠️ 風控中等（${_scanRisk.score}分）`); }
    else                             { _scanSqScore -= 1; _scanSqFactors.push(`❌ 風控偏高（${_scanRisk.score}分）-1`); }

    // ⑮ 止損學習懲罰 -1
    try {
      const _ssLearn = applyLearnAdjustment(direction, parseFloat(coin.rsi)||50, _ssAdx, { slType:'atr', skipAdxRule:true });
      if ((_ssLearn.penalty || 0) >= 20) { _scanSqScore -= 1; _scanSqFactors.push('❌ 止損AI警告（歷史高懲罰）-1'); }
    } catch(_e) {}

    // ⑰ AI新聞 ±1
    try {
      const _ssIns = aiGenerateMarketInsights();
      const _ssBear = _ssIns.filter(i => i.sentiment === 'bearish' || i.sentiment === 'bear').length;
      const _ssBull = _ssIns.filter(i => i.sentiment === 'bullish' || i.sentiment === 'bull').length;
      if (_ssBear + _ssBull > 0) {
        if (isLong ? _ssBull > _ssBear : _ssBear > _ssBull) { _scanSqScore += 1; _scanSqFactors.push('✅ AI新聞利多/空 +1'); }
        else if (isLong ? _ssBear > _ssBull : _ssBull > _ssBear) { _scanSqScore -= 1; _scanSqFactors.push('❌ AI新聞逆向 -1'); }
      }
    } catch(_e) {}

    // ⑱ 爆倉擠壓牆 +1
    try {
      const _ssLiq = _liquidationCache[coin.symbol];
      const _ssCurP = parseFloat(coin.price) || 0;
      if (_ssLiq && _ssCurP > 0) {
        const _ssWall = isLong
          ? (_ssLiq.shortLiqs || []).find(l => l.price > _ssCurP && l.price <= _ssCurP * 1.12)
          : (_ssLiq.longLiqs  || []).find(l => l.price < _ssCurP && l.price >= _ssCurP * 0.88);
        if (_ssWall) { _scanSqScore += 1; _scanSqFactors.push('✅ 爆倉擠壓牆 +1'); }
      }
    } catch(_e) {}

    // ⑲ 重要數據事件 -1/-2
    try {
      const _ssEvs = getTodayEconEvents().filter(ev => {
        const mins = (ev.eventTime.getTime() - Date.now()) / 60000;
        return ev.impact === 'high' && mins >= -30 && mins <= 90;
      });
      if (_ssEvs.length >= 2) { _scanSqScore -= 2; _scanSqFactors.push(`❌ 多個重要事件即將公布 -2`); }
      else if (_ssEvs.length === 1) { _scanSqScore -= 1; _scanSqFactors.push(`❌ 重要事件即將公布 -1`); }
    } catch(_e) {}

    // ⑳ 資金流動 ±1
    try {
      const _ssCF = getCapitalFlowBias();
      const _ssCFOpp = (_ssCF.events || []).filter(ev => isLong ? ev.bear > 0 : ev.bull > 0).length;
      const _ssCFOk  = (_ssCF.events || []).filter(ev => isLong ? ev.bull > 0 : ev.bear > 0).length;
      if (_ssCFOk > 0 && _ssCFOpp === 0) { _scanSqScore += 1; _scanSqFactors.push('✅ 資金流動同向 +1'); }
      else if (_ssCFOpp >= 2) { _scanSqScore -= 1; _scanSqFactors.push('❌ 資金流動逆向 -1'); }
    } catch(_e) {}

    // ⑥ ICT 結構（使用 _tradeSetupCache 快取）+2
    try {
      const _ssIctC = _tradeSetupCache[coin.symbol];
      if (_ssIctC && (_ssIctC.orderBlock !== undefined || _ssIctC.orderBlock4h !== undefined)) {
        let _ssIctCnt = 0;
        if (_ssIctC.orderBlock?.priceInOB || _ssIctC.orderBlock4h?.priceInOB) _ssIctCnt++;
        if ((_ssIctC.fvg && !_ssIctC.fvg.filled) || (_ssIctC.fvg4h && !_ssIctC.fvg4h.filled)) _ssIctCnt++;
        if (_ssIctCnt > 0) { _scanSqScore += Math.min(2, _ssIctCnt); _scanSqFactors.push(`✅ ICT 結構確認 +${Math.min(2,_ssIctCnt)}`); }
      }
    } catch(_e) {}

    // ⑯ 圖形確認（使用 _tradeSetupCache 快取）±2
    try {
      const _ssPat = _tradeSetupCache[coin.symbol]?.chartPat;
      if (_ssPat) {
        if ((_ssPat.score || 0) > 0) { _scanSqScore += Math.min(2, _ssPat.score); _scanSqFactors.push(`✅ 圖形確認（${_ssPat.aligned?.length||0}種）+${Math.min(2,_ssPat.score)}`); }
        if ((_ssPat.opposing?.length || 0) > 0) { _scanSqScore -= Math.min(2, _ssPat.opposing.length); _scanSqFactors.push(`❌ 逆向圖形警告 -${Math.min(2,_ssPat.opposing.length)}`); }
      }
    } catch(_e) {}

    // 分數 floor 0，等級門檻與 buildTradeSetup 完全一致（4H+15m 改硬性條件後 max ≈ 27 分）
    _scanSqScore = Math.max(0, _scanSqScore);
    const _scanSqGrade = _scanSqScore >= 20 ? 'SSS'
                       : _scanSqScore >= 17 ? 'SS'
                       : _scanSqScore >= 15 ? 'S'
                       : _scanSqScore >= 9  ? 'A'
                       : _scanSqScore >= 6  ? 'B'
                       : _scanSqScore >= 3  ? 'C' : 'D';
    const _scanSqLabel = { SSS:'神級訊號', SS:'完美訊號', S:'頂級訊號', A:'優質訊號', B:'良好訊號', C:'一般訊號', D:'訊號偏弱' }[_scanSqGrade];
    // 長線單 S 以上；短線單 A 以上（與 buildTradeSetup + SQ 監控完全一致）
    // 若長線單 SQ 未達 S 級但達 A 級，降格為短線單繼續建單
    if (canScaleIn && !['SSS','SS','S'].includes(_scanSqGrade)) {
      if (!['SSS','SS','S','A'].includes(_scanSqGrade)) continue; // 短線也不達標 → 跳過
      canScaleIn = false; // 降格為短線單
      _scanSqFactors.push(`⚠️ 長線單訊號品質 ${_scanSqGrade}（${_scanSqScore}分）未達 S 級（15分），已降格為短線單`);
    } else if (!canScaleIn && !['SSS','SS','S','A'].includes(_scanSqGrade)) {
      continue; // 短線單也不達標
    }

    // 短線單趨勢預檢：若趨勢已反向，建單後 updateOpenTrades 的 trendReversed 會立即取消，
    // 預先攔截，避免同秒建立後馬上取消（與 updateOpenTrades trendReversed 判斷完全一致）
    if (!canScaleIn) {
      const _preTrendReversed = isLong ? coin.trend?.includes('看跌') : coin.trend?.includes('看漲');
      if (_preTrendReversed) continue;
    }

    // 防競態：async fetch 期間 checkAndSendAlerts 可能已建立同幣種掛單，重新讀取確認
    const _freshTlog = loadTradeLog();
    if (_freshTlog.some(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending'))) continue;

    const newTrade = {
      id: `${coin.symbol}-${Date.now()}`,
      symbol: coin.symbol, direction,
      timestamp: Date.now(),
      entryPrice: parseFloat(coin.price) || 0,
      entry: setup.entry, sl: setup.sl, tp1: setup.tp1, tp2: setup.tp2,
      entryReason: setup.entryReason, slReason: setup.slReason,
      tp1Reason: setup.tp1Reason, tp2Reason: setup.tp2Reason,
      rsi: parseFloat(coin.rsi) || 50,
      adx: parseFloat(coin.adx) || 20,
      score: coin.score, trend: coin.trend,
      conf: Math.max(0, (setup.conf || 0) - (_scanRiskPen || 0)), rawConf: setup.rawConf,
      riskPenalty: _scanRiskPen || 0,
      hardAdxPenalty: setup.hardAdxPenalty || 0,
      learnPenalty: setup.learnPenalty || 0,
      macroPenalty: setup.macroPenalty || 0,
      aiTrendPenalty: setup.aiTrendPenalty || 0,
      techPenalty: setup.techPenalty || 0,
      chipsPenalty: setup.chipsPenalty || 0,
      dirPenalty: setup.dirPenalty || 0,
      bbPenalty: setup.bbPenalty || 0,
      entryWhaleBias:     coin.whaleData?.bias || null,
      entryMTFAlign:      (() => {
        let _mAlign = 0;
        if (isLong ? (coin.weeklySignal || '').includes('bull') : (coin.weeklySignal || '').includes('bear')) _mAlign++;
        if (isLong ? (coin.dailySignal  || '').includes('bull') : (coin.dailySignal  || '').includes('bear')) _mAlign++;
        if (isLong ? (coin.h4Signal     || '').includes('bull') : (coin.h4Signal     || '').includes('bear')) _mAlign++;
        if (isLong ? (coin.h1Signal     || '').includes('bull') : (coin.h1Signal     || '').includes('bear')) _mAlign++;
        if (setup.isLongTerm || setup.isShortTerm) _mAlign++;
        return _mAlign;
      })(),
      entryAbovePOC:      null,
      entryVolDivergence: null,
      entryVolBreakout:   false,
      entryMacdHist:      parseFloat(coin.macdHist) || 0,
      entryVolStrength:   coin.volumeStrength || '',
      entryH4Aligned:     _ssH4Ok,
      entryH1Aligned:     isLong ? !!(coin.h1Signal||'').includes('bull') : !!(coin.h1Signal||'').includes('bear'),
      entryBBWalkingBear: !!(coin.bb?.walkingBear),
      entryBBWalkingBull: !!(coin.bb?.walkingBull),
      entryWeeklyAgainst: isLong ? (coin.weeklySignal||'').includes('bear') : (coin.weeklySignal||'').includes('bull'),
      entryScoreStrength: (() => { const s = isLong ? coin.score : 100 - coin.score; return s >= 75 ? 'strong' : s >= 65 ? 'medium' : 'weak'; })(),
      entryKillZone:      (() => { const h = new Date().getUTCHours(); return h >= 7 && h < 11 ? 'london' : h >= 13 && h < 17 ? 'ny' : h >= 0 && h < 4 ? 'asia' : 'other'; })(),
      status: 'pending', outcome: null, tp1Hit: false,
      entryTime: null,
      exitPrice: null, exitTime: null, pnlR: null, analysis: null,
      refined: false,
      tradeType: 'directional',
      longTermBias: null, canScaleIn,
      scaleIns: [], peakPrice: null,
      sqGrade: _scanSqGrade, sqScore: _scanSqScore, sqGradeLabel: _scanSqLabel, sqFactors: _scanSqFactors,
    };
    // 若現價已超過進場位 0.3%，標記為等待回踩
    const _scanCurPrice = parseFloat(coin.price) || 0;
    if (_scanCurPrice > 0 && newTrade.entry > 0) {
      const _pastEntry = isLong
        ? _scanCurPrice > newTrade.entry * 1.003   // 多單：現價已漲過進場位 0.3%
        : _scanCurPrice < newTrade.entry * 0.997;  // 空單：現價已跌過進場位 0.3%
      if (_pastEntry) newTrade.note = '等待回踩確認進場';
    }
    _freshTlog.unshift(newTrade);
    // 立即存檔：防止同批掃描中下一幣種的 _freshTlog 讀取到舊狀態而覆蓋本次建單
    saveTradeLog(_freshTlog);
    // 同步回 tlog 供後續 SQ 監控迴圈使用（splice 保留同一陣列引用）
    tlog.splice(0, tlog.length, ..._freshTlog);
    changed = true;
    const _tLabel = canScaleIn ? '長線單' : '短線單';
    const _tIcon  = canScaleIn ? '💎' : '📡';
    try { if (typeof showToast === 'function') showToast(`${_tIcon} ${_tLabel}：${coin.symbol} ${isLong ? '▲做多' : '▼做空'} 風控分 ${setup.conf} 分，已加入持倉`, 'success'); } catch(_te) {}
    // 建單即時發送 Telegram（條件在掃描時已完整驗證，不需延遲）
    try {
      const _scanNs = loadSettings();
      if (_scanNs.notifTelegram && _scanNs.tgToken && _scanNs.tgChatId) {
        const _scanTgSetup = Object.assign({}, newTrade, setup,
          { riskScore: _scanRisk.score, riskLevel: _scanRisk.level, riskRecs: _scanRisk.recs,
            conf: newTrade.conf, riskPenalty: _scanRiskPen,
            canScaleIn, isLongTerm: canScaleIn }); // 以建單後值覆蓋 setup，避免 SQ 降格後 isLongTerm 顯示錯標題
        sendTelegramMessage(_scanNs.tgToken, _scanNs.tgChatId,
          buildTelegramText(coin, direction, _scanTgSetup, _macroCache,
            typeof window !== 'undefined' ? window.location.origin + window.location.pathname : ''));
        newTrade.telegramSent = true;
      }
    } catch(_scanTe) { console.warn('[recordSignalsFromScan tg]', _scanTe); }
  }

  // ── 訊號品質持續監控：掛單未進場前每次掃描用完整 21 因子重新評估，低於 A 級自動取消 ──
  // 等級門檻：SSS≥20 / SS≥17 / S≥15 / A≥9 / B≥6 / C≥3 / D<3（與建單評分完全一致）
  // ICT結構和圖形確認需要異步 MTF Kline，其餘 ~18 個因子均可從掃描快取即時取得
  const _sqCancelIds = new Set();
  for (const trade of tlog) {
    if (trade.status !== 'pending' || trade.entryTime) continue;
    if (trade.tradeType === 'range') continue;
    // 本次掃描新建立的掛單已在建單時完整驗證，不需在同一輪掃描內再次 SQ 審查
    if (!_existingTradeIds.has(trade.id)) continue;
    // pendingNotify = true 代表從幣種詳情頁建單、Telegram 尚未發送，同樣跳過
    if (trade.pendingNotify) continue;
    const _sqCoin = data ? data.find(d => d.symbol === trade.symbol) : null;
    if (!_sqCoin) continue;
    const _sqIsLong = trade.direction === 'long';

    let _sqRC = 0;  // recheck score

    // ① 其餘時框同向（1H / 日線 / 週線）— 4H+15m 為進場硬性條件，監控階段改以反向扣分
    const _rcH4Rev  = _sqIsLong ? (_sqCoin.h4Signal    ||'').includes('bear') : (_sqCoin.h4Signal    ||'').includes('bull');
    const _rc15mSig = _sqCoin.signal15m || '';
    const _rc15mRev = _sqIsLong ? _rc15mSig.includes('bear') : _rc15mSig.includes('bull');
    if (_rcH4Rev)  _sqRC -= 1; // 4H 反向 -1
    if (_rc15mRev) _sqRC -= 1; // 15m 反向 -1
    const _rcDyOk  = _sqIsLong ? (_sqCoin.dailySignal ||'').includes('bull') : (_sqCoin.dailySignal ||'').includes('bear');
    const _rcDyOpp = _sqIsLong ? (_sqCoin.dailySignal ||'').includes('bear') : (_sqCoin.dailySignal ||'').includes('bull');
    const _rcWkOk  = _sqIsLong ? (_sqCoin.weeklySignal||'').includes('bull') : (_sqCoin.weeklySignal||'').includes('bear');
    const _rcWkOpp = _sqIsLong ? (_sqCoin.weeklySignal||'').includes('bear') : (_sqCoin.weeklySignal||'').includes('bull');
    const _rcH1Ok  = _sqIsLong ? (_sqCoin.h1Signal    ||'').includes('bull') : (_sqCoin.h1Signal    ||'').includes('bear');
    if (_rcDyOk)  _sqRC += 1; else if (_rcDyOpp) _sqRC -= 1;
    if (_rcWkOk)  _sqRC += 1; else if (_rcWkOpp) _sqRC -= 1;
    if (_rcH1Ok)  _sqRC += 1;

    // ① 延伸：MACD 同向 +1
    const _rcMacd = parseFloat(_sqCoin.macdHist) || 0;
    if (_sqIsLong ? _rcMacd > 0 : _rcMacd < 0) _sqRC += 1;

    // ② 本週 AI 同向 ±1
    if (_sqIsLong ? wBias.includes('bull') : wBias.includes('bear')) _sqRC += 1;
    else if (_sqIsLong ? wBias.includes('bear') : wBias.includes('bull')) _sqRC -= 1;

    // ③ 今日 AI 同向 ±1
    if (_sqIsLong ? tBias.includes('bull') : tBias.includes('bear')) _sqRC += 1;
    else if (_sqIsLong ? tBias.includes('bear') : tBias.includes('bull')) _sqRC -= 1;

    // ④ 宏觀環境 ±2（與 buildTradeSetup 一致）
    if (_macroCache) try {
      const _rcFg  = _macroCache.fg;
      const _rcFgV = parseInt(_rcFg?.value || '50');
      const _rcNetDir = computeMacroNetDir(_rcFg, _macroCache);
      const _rcMacOk  = _sqIsLong ? _rcNetDir.includes('bull') : _rcNetDir.includes('bear');
      const _rcMacOpp = _sqIsLong ? _rcNetDir.includes('bear') : _rcNetDir.includes('bull');
      const _rcFgNtrl = _rcFgV >= 40 && _rcFgV <= 60;
      let _rcMacPts = 0;
      if (_rcMacOk)  _rcMacPts += 1;
      if (_rcFgNtrl && !_rcMacOpp) _rcMacPts += 1;
      if (_rcMacOpp) _rcMacPts -= 2;
      _sqRC += Math.max(-2, Math.min(2, _rcMacPts));
    } catch(_e) {}

    // ⑤ 足跡圖 Delta ±1
    const _rcFP = _footprintCache[_sqCoin.symbol];
    if (_rcFP) {
      if (_rcFP.deltaDiv) _sqRC -= 1;
      else if (_sqIsLong ? (_rcFP.deltaDir === 'bull') : (_rcFP.deltaDir === 'bear')) _sqRC += 1;
      else if (_sqIsLong ? (_rcFP.deltaDir === 'bear') : (_rcFP.deltaDir === 'bull')) _sqRC -= 1;
      // ㉑ 市場微結構品質 ±1
      if ((_rcFP.microstructureQuality || 0) >= 7) _sqRC += 1;
      else if ((_rcFP.microstructureQuality || 0) <= 3) _sqRC -= 1;
    }

    // ⑦ ADX ±1
    const _rcAdx = parseFloat(_sqCoin.adx) || 20;
    if (_rcAdx >= 28) _sqRC += 1;
    else if (_rcAdx < 20) _sqRC -= 1;

    // ⑧ 訂單流 Taker ±1（from derivData）
    try {
      const _rcTkr = _sqCoin.derivData?.takerBuySell ?? 1;
      if (_sqIsLong ? _rcTkr >= 1.08 : _rcTkr <= 0.92) _sqRC += 1;
      else if (_sqIsLong ? _rcTkr < 0.88 : _rcTkr > 1.12) _sqRC -= 1;
    } catch(_e) {}

    // ⑨ 巨鯨籌碼 ±1（from whaleData）
    try {
      const _rcWhl = _sqCoin.whaleData;
      if (_rcWhl) {
        if (_sqIsLong ? (_rcWhl.bias === 'bull' && (_rcWhl.bigBuyCount  ||0) >= 2)
                      : (_rcWhl.bias === 'bear' && (_rcWhl.bigSellCount ||0) >= 2)) _sqRC += 1;
        else if (_sqIsLong ? (_rcWhl.bias === 'bear' && (_rcWhl.bigSellCount||0) >= 3)
                           : (_rcWhl.bias === 'bull' && (_rcWhl.bigBuyCount ||0) >= 3)) _sqRC -= 1;
      }
    } catch(_e) {}

    // ⑩ 成交量 ±1
    const _rcVol = _sqCoin.volumeStrength || '';
    if (_rcVol.includes('強') || _rcVol === 'high') _sqRC += 1;
    else if (_rcVol.includes('弱') || _rcVol === 'low') _sqRC -= 1;

    // ⑪ BB走軌 ±1（from coin.bb）
    try {
      const _rcBB = _sqCoin.bb;
      if (_rcBB) {
        if (_sqIsLong ? _rcBB.walkingBull : _rcBB.walkingBear) _sqRC += 1;
        else if (_sqIsLong ? _rcBB.walkingBear : _rcBB.walkingBull) _sqRC -= 1;
      }
    } catch(_e) {}

    // ⑫ 技術面逆風 ±1
    const _rcSetup = (() => { try { return computeSimpleSetup(_sqCoin, _sqIsLong); } catch(_e) { return null; } })();
    if (_rcSetup) {
      if (_rcSetup.techPenalty === 0) _sqRC += 1;
      else if (_rcSetup.techPenalty >= 12) _sqRC -= 1;

      // ⑬ R/R ±1
      const _rcRR = parseFloat(_rcSetup.rr1) || 0;
      if (_rcRR >= 2.0) _sqRC += 1;
      else if (_rcRR < 1.3) _sqRC -= 1;
    }

    // ⑭ 風控分數 +2/+1/-1
    try {
      if (_rcSetup) {
        const _rcRisk = computeFullRisk(_sqCoin, _rcSetup, _sqIsLong);
        if (_rcRisk.score <= 20)      _sqRC += 2;
        else if (_rcRisk.score <= 40) _sqRC += 1;
        else if (_rcRisk.score >= 55) _sqRC -= 1;
      }
    } catch(_e) {}

    // ⑮ 止損學習懲罰 -1（嚴重時）
    try {
      const _rcLearn = applyLearnAdjustment(trade.direction, parseFloat(_sqCoin.rsi)||50, _rcAdx, { slType:'atr', skipAdxRule:true });
      if ((_rcLearn.penalty || 0) >= 20) _sqRC -= 1;
    } catch(_e) {}

    // ⑰ AI新聞情緒 ±1
    try {
      const _rcIns = aiGenerateMarketInsights();
      const _rcBear = _rcIns.filter(i => i.sentiment === 'bearish' || i.sentiment === 'bear').length;
      const _rcBull = _rcIns.filter(i => i.sentiment === 'bullish' || i.sentiment === 'bull').length;
      if (_rcBear + _rcBull > 0) {
        if (_sqIsLong ? _rcBull > _rcBear : _rcBear > _rcBull) _sqRC += 1;
        else if (_sqIsLong ? _rcBear > _rcBull : _rcBull > _rcBear) _sqRC -= 1;
      }
    } catch(_e) {}

    // ⑱ 爆倉擠壓牆 +1
    try {
      const _rcLiq = _liquidationCache[_sqCoin.symbol];
      const _rcCurP = parseFloat(_sqCoin.price) || 0;
      if (_rcLiq && _rcCurP > 0) {
        const _rcWall = _sqIsLong
          ? (_rcLiq.shortLiqs || []).find(l => l.price > _rcCurP && l.price <= _rcCurP * 1.12)
          : (_rcLiq.longLiqs  || []).find(l => l.price < _rcCurP && l.price >= _rcCurP * 0.88);
        if (_rcWall) _sqRC += 1;
      }
    } catch(_e) {}

    // ⑲ 重要數據事件 -1/-2
    try {
      const _rcEvs = getTodayEconEvents().filter(ev => {
        const mins = (ev.eventTime.getTime() - Date.now()) / 60000;
        return ev.impact === 'high' && mins >= -30 && mins <= 90;
      });
      if (_rcEvs.length >= 2) _sqRC -= 2;
      else if (_rcEvs.length === 1) _sqRC -= 1;
    } catch(_e) {}

    // ⑳ 資金流動 ±1
    try {
      const _rcCF = getCapitalFlowBias();
      const _rcCFOpp = (_rcCF.events || []).filter(ev => _sqIsLong ? ev.bear > 0 : ev.bull > 0).length;
      const _rcCFOk  = (_rcCF.events || []).filter(ev => _sqIsLong ? ev.bull > 0 : ev.bear > 0).length;
      if (_rcCFOk > 0 && _rcCFOpp === 0) _sqRC += 1;
      else if (_rcCFOpp >= 2) _sqRC -= 1;
    } catch(_e) {}

    // ⑥ ICT 結構（OB/FVG）— 使用 _tradeSetupCache 快取；背景 backgroundSQMonitorICT 定期刷新 — max +2
    try {
      const _rcIctC = _tradeSetupCache[_sqCoin.symbol];
      if (_rcIctC && (_rcIctC.orderBlock !== undefined || _rcIctC.orderBlock4h !== undefined)) {
        let _rcIctCnt = 0;
        if (_rcIctC.orderBlock?.priceInOB || _rcIctC.orderBlock4h?.priceInOB) _rcIctCnt++;
        if ((_rcIctC.fvg && !_rcIctC.fvg.filled) || (_rcIctC.fvg4h && !_rcIctC.fvg4h.filled)) _rcIctCnt++;
        _sqRC += Math.min(2, _rcIctCnt);
      }
    } catch(_e) {}

    // ⑯ 圖形確認（4H K棒）— 使用 _tradeSetupCache 快取 — max +2，逆向圖形扣分
    try {
      const _rcPat = _tradeSetupCache[_sqCoin.symbol]?.chartPat;
      if (_rcPat) {
        _sqRC += Math.min(2, Math.max(0, _rcPat.score || 0));
        if ((_rcPat.opposing?.length || 0) > 0) _sqRC -= Math.min(2, _rcPat.opposing.length);
      }
    } catch(_e) {}

    // 分數 floor 0，使用與 buildTradeSetup 完全相同的等級門檻（4H+15m 改硬性條件後 max ≈ 27 分）
    _sqRC = Math.max(0, _sqRC);
    const _rcGrade = _sqRC >= 20 ? 'SSS'
                   : _sqRC >= 17 ? 'SS'
                   : _sqRC >= 15 ? 'S'
                   : _sqRC >= 9  ? 'A'
                   : _sqRC >= 6  ? 'B'
                   : _sqRC >= 3  ? 'C' : 'D';
    const _rcGradeLabel = { SSS:'神級', SS:'完美', S:'頂級', A:'優質', B:'良好', C:'一般', D:'偏弱' }[_rcGrade];

    // 長線單門檻 S；短線單門檻 A（與 buildTradeSetup 一致）
    // 長線單 SQ 降至 A 級（≥A <S）→ 降級為短線單繼續持有；< A 才取消
    const _rcMinGrades = trade.canScaleIn ? ['SSS','SS','S'] : ['SSS','SS','S','A'];
    if (!_rcMinGrades.includes(_rcGrade)) {
      if (trade.canScaleIn && _rcGrade === 'A') {
        // 長線 → 短線降級
        trade.canScaleIn = false;
        trade.sqGrade = _rcGrade; trade.sqScore = _sqRC;
        trade.pendingNotify = false;  // 防止 updateOpenTrades 在降級後再次發送信號通知
        changed = true;
        const _downgradeReason = `訊號品質降至 ${_rcGrade} 級（${_sqRC}分），由長線單降級為短線單繼續監控`;
        try { sendCancelTelegramNotification(trade, _downgradeReason); } catch(_n) {}
        try { if (typeof showToast === 'function') showToast(`⚠️ ${trade.symbol} SQ 降至 A 級，長線單降格為短線單`, 'warning'); } catch(_t) {}
      } else {
        const _sqCancelReason = `訊號品質降至 ${_rcGrade} 級（${_rcGradeLabel}訊號，評分 ${_sqRC}分），低於${trade.canScaleIn ? 'S' : 'A'} 級要求，自動取消掛單`;
        addCancelCooldown(trade, _sqCancelReason);
        _sqCancelIds.add(trade.id);
        changed = true;
        trade.sqGrade = _rcGrade; trade.sqScore = _sqRC;
        try { sendCancelTelegramNotification(trade, _sqCancelReason); } catch(_n) {}
        try { if (typeof showToast === 'function') showToast(`⚠️ ${trade.symbol} 訊號品質降至 ${_rcGrade} 級（${_sqRC}分），自動取消掛單`, 'warning'); } catch(_t) {}
      }
    } else {
      // SQ 通過 → 繼續監控 ② 風控分 ③ 風險評估
      if (!_sqCancelIds.has(trade.id)) {
        // ② 風控分（止損風控 + 風險評估扣分）< 60 → 取消
        // 優先使用快取中的新鮮 learnPenalty（由 buildTradeSetup 更新），避免建單時的舊值影響計算
        const _rcCachedLp = _tradeSetupCache[_sqCoin.symbol]?.learnPenalty;
        const _rcLearnPen = _rcCachedLp != null ? _rcCachedLp : (trade.learnPenalty || 0);
        let _rcRiskPen = 0;
        try {
          // 傳入 pre-risk conf（還原風險扣分前的風控分），避免循環依賴
          const _rcPreRiskConf = Math.min(100, (trade.conf || 60) + (trade.riskPenalty || 0));
          const _rcRisk = computeFullRisk(_sqCoin, { ...trade, conf: _rcPreRiskConf }, _sqIsLong);
          _rcRiskPen = calcRiskPenalty(_rcRisk.score);
          // 更新 trade 上的風險記錄（供 Telegram 明細使用）
          if (trade.riskScore !== _rcRisk.score || trade.riskLevel !== _rcRisk.level) {
            trade.riskScore = _rcRisk.score; trade.riskLevel = _rcRisk.level; changed = true;
          }
          trade.riskPenalty = _rcRiskPen;
        } catch(_rcRiskE) {}
        const _rcConf = Math.max(0, 100 - Math.min(45, _rcLearnPen) - _rcRiskPen);
        if (_rcConf < 60) {
          const _riskDesc = _rcRiskPen > 0 ? `，風險評估扣分 -${_rcRiskPen}（${trade.riskLevel || ''} ${trade.riskScore || 0}/100）` : '';
          const _confCancel = `風控分降至 ${_rcConf} 分（止損風控 -${_rcLearnPen}${_riskDesc}），低於 60 分門檻，自動取消掛單`;
          addCancelCooldown(trade, _confCancel);
          _sqCancelIds.add(trade.id);
          changed = true;
          try { sendCancelTelegramNotification(trade, _confCancel); } catch(_n) {}
          try { if (typeof showToast === 'function') showToast(`⚠️ ${trade.symbol} 風控分 ${_rcConf}分 < 60，自動取消掛單`, 'warning'); } catch(_t) {}
        }
        if (!_sqCancelIds.has(trade.id)) {
          if (Math.abs((trade.conf || 0) - _rcConf) >= 1) {
            trade.conf = _rcConf;
            changed = true;
          }
          if (_rcCachedLp != null && (trade.learnPenalty || 0) !== _rcCachedLp) {
            trade.learnPenalty = _rcCachedLp;
            changed = true;
          }
        }
      }
      if (!_sqCancelIds.has(trade.id) && (trade.sqGrade !== _rcGrade || trade.sqScore !== _sqRC)) {
        trade.sqGrade = _rcGrade; trade.sqScore = _sqRC;
        changed = true;
      }
    }
  }
  if (_sqCancelIds.size > 0) {
    const _before = tlog.length;
    tlog.splice(0, tlog.length, ...tlog.filter(t => !_sqCancelIds.has(t.id)));
    console.log(`[SQ-monitor] 取消 ${_before - tlog.length} 筆訊號品質不足掛單（18因子完整評估）`);
  }

  if (changed) {
    if (tlog.length > 500) tlog.splice(500);
    saveTradeLog(tlog);
  }
  // 背景檢測新建短線單是否符合長線條件（異步，不阻塞掃描）
  if (changed) setTimeout(() => backgroundRefineNewTrades().catch(e => console.warn('[bg-refine]', e)), 2000);
  // 背景刷新掛單的 ICT 結構 + 圖形確認快取（每 30 分鐘最多一次），讓 SQ 監控可涵蓋 ⑥⑯ 兩因子
  setTimeout(() => backgroundSQMonitorICT().catch(e => console.warn('[bg-ict]', e)), 5000);
}
/* ── 背景精煉：為新建短線單自動檢測長線條件 ─────────────────── */
async function backgroundRefineNewTrades() {
  const tlog = loadTradeLog();
  const now  = Date.now();
  // 僅對 5 分鐘內新建的、尚未精煉的定向掛單進行長線檢測
  const toRefine = tlog.filter(t =>
    t.status === 'pending' &&
    t.tradeType === 'directional' &&
    !t.refined &&
    (now - (t.timestamp || 0)) < 5 * 60 * 1000
  );
  if (!toRefine.length) return;

  for (const trade of toRefine.slice(0, 3)) { // 每次最多 3 筆，避免 API 負荷
    try {
      const mtfData  = await fetchMTFKlines(trade.symbol);
      const direction = trade.direction;
      const isLong    = direction === 'long';

      // 長線偏向計算（與 buildTradeSetup/computeLongTermBias 邏輯一致）
      const ltBias = computeLongTermBias(mtfData);
      const m15SigBg = mtfData['15m']?.signal;
      const h1SigBg  = mtfData['1h']?.signal;
      const h4SigBg  = mtfData['4h']?.signal;
      const d1SigBg  = mtfData['1d']?.signal;
      const w1SigBg  = mtfData['1w']?.signal;
      const m15OkBg = isLong ? m15SigBg?.signal?.includes('bull') : m15SigBg?.signal?.includes('bear');
      const h1OkBg  = isLong ? h1SigBg?.signal?.includes('bull')  : h1SigBg?.signal?.includes('bear');
      const h4OkBg  = isLong ? h4SigBg?.signal?.includes('bull')  : h4SigBg?.signal?.includes('bear');
      const d1OkBg  = isLong ? d1SigBg?.signal?.includes('bull')  : d1SigBg?.signal?.includes('bear');
      const w1OkBg  = isLong ? w1SigBg?.signal?.includes('bull')  : w1SigBg?.signal?.includes('bear');
      let ltBull = 0, ltBear = 0;
      const ltW = { '1d': 1, '1w': 3, '1M': 4 };
      for (const [tf, w] of Object.entries(ltW)) {
        const sig = mtfData[tf]?.signal;
        if (!sig) continue;
        if (sig.signal?.includes('bull')) ltBull += w;
        if (sig.signal?.includes('bear')) ltBear += w;
        const rsi = sig.rsi || 50;
        if (rsi < 42) ltBull += w * 0.4;
        if (rsi > 58) ltBear += w * 0.4;
      }
      const ltRaw  = ltBias === 'long' ? ltBull : ltBias === 'short' ? ltBear : 0;
      const ltConf = ltBias !== 'neutral' ? Math.round(Math.min(95, 55 + ltRaw * 8)) : 0;
      // 長線單升級：五週期（15m+1H+4H+日+週）同向 + 長線信心 ≥ 85%
      // 額外限制：建單時 SQ 須已達 S 級，否則監控迴圈因 SQ=A 不足長線門檻會立即降格
      const _bgSqOkForLT = ['SSS','SS','S'].includes(trade.sqGrade || 'D');
      const canScaleIn = !!(_bgSqOkForLT && m15OkBg && h1OkBg && h4OkBg && d1OkBg && w1OkBg && ltConf >= 85);

      const tlogEdit = loadTradeLog();
      const idx = tlogEdit.findIndex(t => t.id === trade.id);
      if (idx < 0) continue;

      const _wasLongTermAlready = tlogEdit[idx].canScaleIn === true; // already notified as long-term in scan
      tlogEdit[idx].longTermBias = ltBias;
      tlogEdit[idx].canScaleIn   = canScaleIn;
      tlogEdit[idx].ltConf       = ltConf;
      tlogEdit[idx].refined      = true;

      if (canScaleIn) {
        const price  = tlogEdit[idx].entryPrice || tlogEdit[idx].entry || 0;
        const atr    = price * 0.013;
        const origRisk = Math.abs(tlogEdit[idx].entry - tlogEdit[idx].sl) || atr;
        const d1sig   = mtfData['1d']?.signal;
        const ltRes   = isLong
          ? (d1sig?.resistance || price * 1.12)
          : (d1sig?.support    || price * 0.88);
        const ltTP = isLong
          ? Math.min(price * 1.35, ltRes)
          : Math.max(price * 0.65, ltRes);
        const _bgRRraw = origRisk > 0 ? Math.abs(ltTP - tlogEdit[idx].entry) / origRisk : 0;
        const _bgLtTPReason = isLong
          ? `日線關鍵壓力 ${ltTP.toPrecision(6).replace(/\.?0+$/,'')}，R/R ${_bgRRraw.toFixed(1)}:1，全倉長線目標`
          : `日線關鍵支撐 ${ltTP.toPrecision(6).replace(/\.?0+$/,'')}，R/R ${_bgRRraw.toFixed(1)}:1，全倉長線目標`;
        // AI 自行判斷加倉次數（與 buildTradeSetup 邏輯一致）
        const _bgScaleCount = (ltConf >= 90 && _bgRRraw >= 5.0) ? 3
                            : (ltConf >= 87 && _bgRRraw >= 4.0) ? 2
                            : 1;
        const _bgScaleReason = _bgScaleCount === 3 ? `長線風控分 ${ltConf} 分、R/R ${_bgRRraw.toFixed(1)}:1，建議 3 次加倉`
                             : _bgScaleCount === 2 ? `長線風控分 ${ltConf} 分、R/R ${_bgRRraw.toFixed(1)}:1，建議 2 次加倉`
                             : `長線風控分 ${ltConf} 分，建議 1 次加倉（保守佈局）`;
        const totalMove = Math.abs(ltTP - tlogEdit[idx].entry);
        const bgScaleInLevels = Array.from({ length: _bgScaleCount }, (_, i) => i + 1).map(n => {
          const raw = isLong
            ? tlogEdit[idx].entry + totalMove * (n / (_bgScaleCount + 1))
            : tlogEdit[idx].entry - totalMove * (n / (_bgScaleCount + 1));
          const prevLevel = n === 1
            ? tlogEdit[idx].entry
            : (isLong
              ? tlogEdit[idx].entry + totalMove * ((n - 1) / (_bgScaleCount + 1))
              : tlogEdit[idx].entry - totalMove * ((n - 1) / (_bgScaleCount + 1)));
          // 止損往前調：鎖住 30% 增量利潤
          const incGain = Math.abs(raw - prevLevel);
          const newSL   = isLong ? prevLevel + incGain * 0.30 : prevLevel - incGain * 0.30;
          return { level: raw, newSL };
        });
        tlogEdit[idx].ltTP           = ltTP;
        tlogEdit[idx].ltTPReason     = _bgLtTPReason;
        tlogEdit[idx].maxScaleIns    = _bgScaleCount;
        tlogEdit[idx].aiScaleReason  = _bgScaleReason;
        tlogEdit[idx].scaleInTargets = bgScaleInLevels.map(s => s.level);
        tlogEdit[idx].scaleInNewSLs  = bgScaleInLevels.map(s => s.newSL);
        // 發送長線升級通知（僅在從短線升級為長線時才發送；已是長線單時掃描通知已覆蓋，不重複通知）
        if (!_wasLongTermAlready) {
          try {
            const s = loadSettings();
            if (s.notifTelegram && s.tgToken && s.tgChatId) {
              const _bgCoin = {
                symbol: tlogEdit[idx].symbol,
                price: tlogEdit[idx].entryPrice || tlogEdit[idx].entry || 0,
                score: tlogEdit[idx].score || 50,
                weeklySignal: mtfData['1w']?.signal?.signal || '',
                dailySignal:  mtfData['1d']?.signal?.signal || '',
                h4Signal:     mtfData['4h']?.signal?.signal || '',
                h1Signal:     mtfData['1h']?.signal?.signal || '',
                signal15m:    mtfData['15m']?.signal?.signal || '',
                rsi: tlogEdit[idx].rsi || 50,
                adx: tlogEdit[idx].adx || 20,
              };
              const _bgUpSetup = Object.assign({}, _tradeSetupCache?.[tlogEdit[idx].symbol] || {}, {
                entry: tlogEdit[idx].entry, sl: tlogEdit[idx].sl,
                tp1: ltTP, tp2: ltTP, conf: tlogEdit[idx].conf || 60,
                canScaleIn: true, ltConf, longTermBias: ltBias,
                maxScaleIns: _bgScaleCount, aiScaleReason: _bgScaleReason,
                scaleInTargets: bgScaleInLevels.map(s_ => s_.level),
                scaleInNewSLs: bgScaleInLevels.map(s_ => s_.newSL),
                sqGrade: tlogEdit[idx].sqGrade, sqScore: tlogEdit[idx].sqScore,
                sqGradeLabel: tlogEdit[idx].sqGradeLabel,
              });
              sendTelegramMessage(s.tgToken, s.tgChatId,
                buildTelegramText(_bgCoin, tlogEdit[idx].direction, _bgUpSetup, _macroCache,
                  window.location.origin + window.location.pathname,
                  { headerOverride: '🔼 <b>加密掃描 Pro — 長線單升級信號</b>' }
                )
              );
            }
          } catch(e) {}
        }
      } else if (_wasLongTermAlready) {
        // 長線 → 短線降格：MTF 多時框架對齊條件不再成立
        tlogEdit[idx].ltTP = null;
        try {
          const s = loadSettings();
          if (s.notifTelegram && s.tgToken && s.tgChatId) {
            const _bgCoin = {
              symbol: tlogEdit[idx].symbol,
              price: tlogEdit[idx].entryPrice || tlogEdit[idx].entry || 0,
              score: tlogEdit[idx].score || 50,
              weeklySignal: mtfData['1w']?.signal?.signal || '',
              dailySignal:  mtfData['1d']?.signal?.signal || '',
              h4Signal:     mtfData['4h']?.signal?.signal || '',
              h1Signal:     mtfData['1h']?.signal?.signal || '',
              signal15m:    mtfData['15m']?.signal?.signal || '',
              rsi: tlogEdit[idx].rsi || 50,
              adx: tlogEdit[idx].adx || 20,
            };
            const _bgDgSetup = Object.assign({}, _tradeSetupCache?.[tlogEdit[idx].symbol] || {}, {
              entry: tlogEdit[idx].entry, sl: tlogEdit[idx].sl,
              tp1: tlogEdit[idx].tp1, tp2: tlogEdit[idx].tp2,
              conf: tlogEdit[idx].conf || 60, canScaleIn: false,
              sqGrade: tlogEdit[idx].sqGrade, sqScore: tlogEdit[idx].sqScore,
              sqGradeLabel: tlogEdit[idx].sqGradeLabel,
            });
            sendTelegramMessage(s.tgToken, s.tgChatId,
              buildTelegramText(_bgCoin, tlogEdit[idx].direction, _bgDgSetup, _macroCache,
                window.location.origin + window.location.pathname,
                { headerOverride: '⬇️ <b>加密掃描 Pro — 降級短線單信號</b>' }
              )
            );
          }
        } catch(e) {}
      }

      saveTradeLog(tlogEdit);
    } catch(e) {
      console.warn('[backgroundRefine]', trade.symbol, e);
    }
  }
}
/* ── 背景 ICT/圖形快取刷新：為掛單定期抓取 MTF Klines，確保 SQ 監控含 ⑥+⑯ 兩因子 ─── */
const _sqIctRefreshTs = {};  // { [symbol]: lastRefreshMs }
const _SQ_ICT_INTERVAL = 30 * 60 * 1000;  // 每 30 分鐘刷新一次

async function backgroundSQMonitorICT() {
  const tlog = loadTradeLog();
  const now  = Date.now();
  const pending = tlog.filter(t =>
    t.status === 'pending' &&
    !t.entryTime &&
    t.tradeType !== 'range' &&
    (now - (_sqIctRefreshTs[t.symbol] || 0)) > _SQ_ICT_INTERVAL
  );
  if (!pending.length) return;

  for (const trade of pending.slice(0, 4)) {
    try {
      const mtfData = await fetchMTFKlines(trade.symbol);
      const isLong  = trade.direction === 'long';
      const raw1h   = mtfData['1h']?.raw || [];
      const raw4h   = mtfData['4h']?.raw || [];

      let ictOB = null, ictFVG = null, ictOB4h = null, ictFVG4h = null;
      if (raw1h.length >= 5 && typeof detectOrderBlocks   === 'function') ictOB   = detectOrderBlocks(raw1h,   isLong);
      if (raw1h.length >= 5 && typeof detectFairValueGaps === 'function') ictFVG  = detectFairValueGaps(raw1h, isLong);
      if (raw4h.length >= 5 && typeof detectOrderBlocks   === 'function') ictOB4h  = detectOrderBlocks(raw4h,  isLong);
      if (raw4h.length >= 5 && typeof detectFairValueGaps === 'function') ictFVG4h = detectFairValueGaps(raw4h, isLong);

      let chartPat = { patterns: [], score: 0, aligned: [], opposing: [], neutral: [] };
      if (raw4h.length >= 10 && typeof detectChartPatterns === 'function') {
        chartPat = detectChartPatterns(raw4h, isLong);
      }

      // 更新 _tradeSetupCache — 下一輪同步 SQ 監控會自動帶入這兩個因子
      if (!_tradeSetupCache[trade.symbol]) _tradeSetupCache[trade.symbol] = {};
      Object.assign(_tradeSetupCache[trade.symbol], {
        orderBlock: ictOB, fvg: ictFVG,
        orderBlock4h: ictOB4h, fvg4h: ictFVG4h,
        chartPat,
      });
      _sqIctRefreshTs[trade.symbol] = now;
      console.log(`[bg-ict] ${trade.symbol} ICT/圖形快取已刷新（OB:${!!(ictOB?.priceInOB||ictOB4h?.priceInOB)} FVG:${!!(ictFVG&&!ictFVG.filled||ictFVG4h&&!ictFVG4h.filled)} 圖形分:${chartPat.score}）`);
    } catch(_e) {
      console.warn('[bg-ict]', trade.symbol, _e);
    }
  }
}
/* ── 自動掃描長線/短線狀態監控（不依賴手動開啟幣種詳情）──────── */
const _ltMonitorTimestamps = {};          // { [symbol]: lastCheckMs }
const _LT_MONITOR_INTERVAL = 30 * 60 * 1000; // 每 30 分鐘最多檢查一次

async function backgroundMonitorLongTermStatus() {
  const tlog = loadTradeLog();
  const now  = Date.now();
  const targets = tlog.filter(t =>
    (t.status === 'pending' || t.status === 'active') &&
    t.tradeType === 'directional'
  );
  if (!targets.length) return;

  // 僅處理距離上次檢查超過 30 分鐘的幣種
  const toCheck = targets.filter(t => {
    const last = _ltMonitorTimestamps[t.symbol] || 0;
    return (now - last) >= _LT_MONITOR_INTERVAL;
  }).slice(0, 3); // 每批最多 3 筆，避免 API 負荷

  if (!toCheck.length) return;

  for (const trade of toCheck) {
    _ltMonitorTimestamps[trade.symbol] = now;
    try {
      const mtfData = await fetchMTFKlines(trade.symbol);
      const isLong  = trade.direction === 'long';
      const m15Sig  = mtfData['15m']?.signal;
      const h1Sig   = mtfData['1h']?.signal;
      const h4Sig   = mtfData['4h']?.signal;
      const d1Sig   = mtfData['1d']?.signal;
      const w1Sig   = mtfData['1w']?.signal;
      const m15Ok   = isLong ? m15Sig?.signal?.includes('bull') : m15Sig?.signal?.includes('bear');
      const h1Ok    = isLong ? h1Sig?.signal?.includes('bull')  : h1Sig?.signal?.includes('bear');
      const h4Ok    = isLong ? h4Sig?.signal?.includes('bull')  : h4Sig?.signal?.includes('bear');
      const d1Ok    = isLong ? d1Sig?.signal?.includes('bull')  : d1Sig?.signal?.includes('bear');
      const w1Ok    = isLong ? w1Sig?.signal?.includes('bull')  : w1Sig?.signal?.includes('bear');
      // 長線風控分（與 buildTradeSetup 一致）
      let _ltBull = 0, _ltBear = 0;
      for (const [tf, w] of Object.entries({ '1d': 1, '1w': 3, '1M': 4 })) {
        const sig = mtfData[tf]?.signal;
        if (!sig) continue;
        if (sig.signal?.includes('bull')) _ltBull += w;
        if (sig.signal?.includes('bear')) _ltBear += w;
        const rsi = sig.rsi || 50;
        if (rsi < 42) _ltBull += w * 0.4;
        if (rsi > 58) _ltBear += w * 0.4;
      }
      const _monLtBias = computeLongTermBias(mtfData);
      const _monLtRaw  = _monLtBias === 'long' ? _ltBull : _monLtBias === 'short' ? _ltBear : 0;
      const _monLtConf = _monLtBias !== 'neutral' ? Math.round(Math.min(95, 55 + _monLtRaw * 8)) : 0;
      // 五週期同向（15m+1H+4H+日+週）+ 長線信心 ≥ 85% + SQ ≥ S 級
      // SQ = A 不允許升格為長線，避免升格後立即被 SQ 監控降格
      const canScaleInNow = !!(m15Ok && h1Ok && h4Ok && d1Ok && w1Ok && _monLtConf >= 85
        && ['SSS','SS','S'].includes(trade.sqGrade || 'D'));

      const tlogEdit = loadTradeLog();
      const idx = tlogEdit.findIndex(t => t.id === trade.id);
      if (idx < 0) continue;

      const wasLT = tlogEdit[idx].canScaleIn === true;
      if (wasLT === canScaleInNow) continue; // 狀態未改變，跳過

      // 構建 coin 物件（供 buildTelegramText 使用）
      const _monCoin = {
        symbol: trade.symbol,
        price: trade.entryPrice || trade.entry || 0,
        score: trade.score || 50,
        weeklySignal: mtfData['1w']?.signal?.signal || '',
        dailySignal:  mtfData['1d']?.signal?.signal || '',
        h4Signal:     mtfData['4h']?.signal?.signal || '',
        h1Signal:     mtfData['1h']?.signal?.signal || '',
        signal15m:    mtfData['15m']?.signal?.signal || '',
        rsi: trade.rsi || 50,
        adx: trade.adx || 20,
      };

      if (wasLT && !canScaleInNow) {
        // ── 長線 → 短線降格 ──
        tlogEdit[idx].canScaleIn = false;
        tlogEdit[idx].ltTP       = null;
        saveTradeLog(tlogEdit);
        try {
          const s = loadSettings();
          if (s.notifTelegram && s.tgToken && s.tgChatId) {
            const _monDgSetup = Object.assign({}, _tradeSetupCache?.[trade.symbol] || {}, {
              entry: trade.entry, sl: trade.sl,
              tp1: trade.tp1, tp2: trade.tp2,
              conf: trade.conf || 60, canScaleIn: false,
              sqGrade: trade.sqGrade, sqScore: trade.sqScore,
              sqGradeLabel: trade.sqGradeLabel,
            });
            sendTelegramMessage(s.tgToken, s.tgChatId,
              buildTelegramText(_monCoin, trade.direction, _monDgSetup, _macroCache,
                window.location.origin + window.location.pathname,
                { headerOverride: '⬇️ <b>加密掃描 Pro — 降級短線單信號</b>' }
              )
            );
          }
        } catch(e) {}
        console.info('[ltMonitor] 降格', trade.symbol);

      } else if (!wasLT && canScaleInNow) {
        // ── 短線 → 長線升格 ──
        const ltBias  = _monLtBias;
        const ltConf  = _monLtConf;

        const price    = parseFloat(trade.entryPrice || trade.entry) || 0;
        const atr      = price * 0.013;
        const origRisk = Math.abs((trade.entry || 0) - (trade.sl || 0)) || atr;
        const d1sig    = mtfData['1d']?.signal;
        const ltRes    = isLong ? (d1sig?.resistance || price * 1.12) : (d1sig?.support || price * 0.88);
        const ltTP     = isLong ? Math.min(price * 1.35, ltRes) : Math.max(price * 0.65, ltRes);
        const ltRRraw  = origRisk > 0 ? Math.abs(ltTP - (trade.entry || 0)) / origRisk : 0;

        const _bgScaleCount  = (ltConf >= 90 && ltRRraw >= 5.0) ? 3
                             : (ltConf >= 87 && ltRRraw >= 4.0) ? 2 : 1;
        const _bgScaleReason = _bgScaleCount === 3 ? `長線風控分 ${ltConf} 分、R/R ${ltRRraw.toFixed(1)}:1，建議 3 次加倉`
                             : _bgScaleCount === 2 ? `長線風控分 ${ltConf} 分、R/R ${ltRRraw.toFixed(1)}:1，建議 2 次加倉`
                             : `長線風控分 ${ltConf} 分，建議 1 次加倉（保守佈局）`;

        tlogEdit[idx].canScaleIn    = true;
        tlogEdit[idx].ltTP          = ltTP;
        tlogEdit[idx].ltConf        = ltConf;
        tlogEdit[idx].longTermBias  = ltBias;
        tlogEdit[idx].maxScaleIns   = _bgScaleCount;
        tlogEdit[idx].aiScaleReason = _bgScaleReason;
        saveTradeLog(tlogEdit);

        try {
          const s = loadSettings();
          if (s.notifTelegram && s.tgToken && s.tgChatId) {
            const _monUpSetup = Object.assign({}, _tradeSetupCache?.[trade.symbol] || {}, {
              entry: trade.entry, sl: trade.sl,
              tp1: ltTP, tp2: ltTP,
              conf: trade.conf || 60, canScaleIn: true,
              ltConf, longTermBias: ltBias,
              maxScaleIns: _bgScaleCount, aiScaleReason: _bgScaleReason,
              sqGrade: trade.sqGrade, sqScore: trade.sqScore,
              sqGradeLabel: trade.sqGradeLabel,
            });
            sendTelegramMessage(s.tgToken, s.tgChatId,
              buildTelegramText(_monCoin, trade.direction, _monUpSetup, _macroCache,
                window.location.origin + window.location.pathname,
                { headerOverride: '🔼 <b>加密掃描 Pro — 長線單升級信號</b>' }
              )
            );
          }
        } catch(e) {}
        console.info('[ltMonitor] 升格', trade.symbol);
      }
    } catch(e) {
      console.warn('[ltMonitor]', trade.symbol, e);
    }
  }
}

function updateOpenTrades(data) {
  const tlog = loadTradeLog();
  let changed = false;
  const cancelledSymbols = new Set(); // 本次週期被取消的幣種
  const toDeleteIds = new Set();      // 取消後立即從 tlog 刪除的 trade id
  const tp1Hits = []; // trades that just reached TP1 this cycle

  // ── 清除殘留的 direction='wait' 無效掛單（直接刪除，不留冷卻記錄）──
  for (const trade of tlog) {
    if (trade.status === 'pending' && trade.direction === 'wait') {
      toDeleteIds.add(trade.id);
      changed = true;
    }
  }

  // ── 修復舊版 bug 留下的 tp1=null 掛單（確保止盈一永遠有有效值）──
  for (const trade of tlog) {
    if (trade.status !== 'pending' || trade.tp1) continue;
    if (!trade.entry || !trade.sl) continue;
    const _r = Math.abs(trade.entry - trade.sl);
    if (_r <= 0) continue;
    const _isL = trade.direction === 'long';
    trade.tp1 = _isL ? trade.entry + _r * 1.5 : trade.entry - _r * 1.5;
    if (!trade.tp2) trade.tp2 = _isL ? trade.entry + _r * 2.5 : trade.entry - _r * 2.5;
    changed = true;
  }

  // ── 宏觀方向反轉：取消方向衝突的未入場掛單 ──
  // 條件 A：本週 + 今日 AI 均明確反向（嚴格雙確認）
  // 條件 B：綜合宏觀方向極端反向（strong_bear/strong_bull）才取消，mild bear 由信心扣分處理
  // 震盪單（tradeType='range'）不依賴方向，豁免
  if (_macroCache) {
    try {
      const wb2 = computeWeeklyAIBias(_macroCache.fg, _macroCache);
      const tb2 = computeTodayAIBias(_macroCache.fg, _macroCache);
      const bothClearBear = (wb2.bias === 'bear' || wb2.bias === 'strong_bear')
                         && (tb2.bias === 'bear' || tb2.bias === 'strong_bear');
      const bothClearBull = (wb2.bias === 'bull' || wb2.bias === 'strong_bull')
                         && (tb2.bias === 'bull' || tb2.bias === 'strong_bull');
      // 條件 B：只有極端大方向（strong）才直接取消，mild bear 由 freshConf 扣分處理
      const macroNetDir2 = computeMacroNetDir(_macroCache.fg, _macroCache);
      const macroClearBear = macroNetDir2 === 'strong_bear';
      const macroClearBull = macroNetDir2 === 'strong_bull';
      for (const trade of tlog) {
        if (trade.status !== 'pending' || trade.entryTime) continue;
        if (trade.tradeType === 'range') continue;
        const cancelLong  = trade.direction === 'long'  && (bothClearBear || macroClearBear);
        const cancelShort = trade.direction === 'short' && (bothClearBull || macroClearBull);
        if (cancelLong || cancelShort) {
          const macroLabel = { strong_bear:'強烈看空', bear:'偏空', strong_bull:'強烈看多', bull:'偏多' }[macroNetDir2] || macroNetDir2;
          const reason = (cancelLong && macroClearBear) || (cancelShort && macroClearBull)
            ? `宏觀大方向${macroLabel}，取消逆勢${trade.direction === 'long' ? '多' : '空'}單掛單`
            : '本週 + 今日 AI 均明確反向，取消未入場掛單';
          addCancelCooldown(trade, reason);
          toDeleteIds.add(trade.id);
          changed = true;
          cancelledSymbols.add(trade.symbol);
          sendCancelTelegramNotification(trade, reason);
        }
      }
    } catch(e) {}
  }

  // ── 風控分崩跌取消：動態計算 freshConf，低於 50% 時自動撤單（所有類型含震盪單）──
  for (const trade of tlog) {
    if (trade.status !== 'pending' || trade.entryTime) continue;
    const baseConf   = trade.rawConf || trade.conf || 100;
    const _adxPen    = trade.hardAdxPenalty || 0;

    // 取得最新幣種資料（RSI/ADX 供學習規則重算用）
    const _fCoin = data ? data.find(d => d.symbol === trade.symbol) : null;
    const _curRsi = parseFloat(_fCoin?.rsi) || parseFloat(trade.rsi) || 50;
    const _curAdx = parseFloat(_fCoin?.adx) || parseFloat(trade.adx) || 20;

    // 重新執行學習規則扣分（反映最新止損紀錄，不使用建單時的靜態值）
    let _learnPen = trade.learnPenalty || 0;
    try {
      const _lrFresh = applyLearnAdjustment(trade.direction, _curRsi, _curAdx, { slType: 'atr', skipAdxRule: true });
      _learnPen = _lrFresh.penalty || 0;
    } catch(_le) { /* 保留靜態值 */ }

    const _isL = trade.direction === 'long';
    let freshConf = baseConf;
    if (_macroCache) {
      try {
        const _fg  = _macroCache.fg, _gm = _macroCache;
        const _fgV = parseInt(_fg?.value || '50');
        const _chg = _gm?.marketCapChange || 0;
        const _dom = _gm?.btcDominance   || 50;
        let _agt = 0;
        if (_isL) {
          if (_chg < -2) _agt++;
          if (_dom > 58) _agt++;
          if (_fgV < 30) _agt++;
          if (_fgV > 75) _agt += 0.5;
        } else {
          if (_chg > 2)  _agt++;
          if (_dom < 44) _agt++;
          if (_fgV > 70) _agt++;
          if (_fgV < 25) _agt += 0.5;
        }
        let _macP = _agt >= 3 ? 22 : _agt >= 2 ? 15 : _agt >= 1 ? 8 : 0;
        // ADX 不列入 freshConf：建單時 ADX 是靜態品質過濾，不應在每次刷新時重複扣分
        const _fBigDir = computeMacroNetDir(_fg, _gm);  // 提前計算，供 AI 趨勢扣分判斷使用
        const _fBdAg = (_isL && _fBigDir.includes('bear')) || (!_isL && _fBigDir.includes('bull'));
        const _fMacroAligned = (!_isL && _fBigDir.includes('bear')) || (_isL && _fBigDir.includes('bull'));
        const _wb  = computeWeeklyAIBias(_fg, _gm);
        const _tb  = computeTodayAIBias(_fg, _gm);
        const _wOp   = _isL ? _wb.bias.includes('bear') : _wb.bias.includes('bull');
        const _tOp   = _isL ? _tb.bias.includes('bear') : _tb.bias.includes('bull');
        const _wNeut = _wb.bias === 'neutral';
        const _tNeut = _tb.bias === 'neutral';
        // 宏觀大方向與交易方向一致時，AI事件預測逆向不扣分（宏觀優先）
        const _aiP = _fMacroAligned ? 0 :
          ((_wOp ? (_wb.bias.includes('strong') ? 10 : 6) : _wNeut ? 3 : 0) + (_tOp ? 7 : _tNeut ? 2 : 0));
        // 大方向分歧補扣
        if (_fBdAg) {
          const _fBdMin = (_fBigDir === 'slight_bear' || _fBigDir === 'slight_bull') ? 4 : 9;
          if (_macP < _fBdMin) _macP = _fBdMin;
        }
        // 動態技術面 + 籌碼面扣分（依最新掃描數據重算）
        let _techP = 0, _chipsP = 0;
        if (_fCoin) {
          if (_isL) {
            if (_curRsi > 78)      _techP += 8;
            else if (_curRsi > 70) _techP += 5;
          } else {
            if (_curRsi < 22)      _techP += 8;
            else if (_curRsi < 30) _techP += 5;
          }
          const _fMacd = parseFloat(_fCoin.macdHist) || 0;
          if (_isL  && _fMacd < 0) _techP += 4;
          if (!_isL && _fMacd > 0) _techP += 4;
          const _fVol = _fCoin.volumeStrength || '';
          if (_fVol === '低' || _fVol.includes('弱')) _techP += 4;
          _techP = Math.min(18, _techP);
          const _fDrv = _fCoin.derivData;
          if (_fDrv) {
            const _fTkr = _fDrv.takerBuySell ?? 1;
            if (_isL  && _fTkr < 0.80)       _chipsP += 6;
            else if (_isL  && _fTkr < 0.88)  _chipsP += 4;
            else if (!_isL && _fTkr > 1.20)  _chipsP += 6;
            else if (!_isL && _fTkr > 1.12)  _chipsP += 4;
          }
          const _fWhl = _fCoin.whaleData;
          if (_fWhl) {
            if (_isL  && _fWhl.bias === 'bear' && (_fWhl.bigSellCount || 0) >= 3) _chipsP += 5;
            if (!_isL && _fWhl.bias === 'bull' && (_fWhl.bigBuyCount  || 0) >= 3) _chipsP += 5;
          }
          _chipsP = Math.min(12, _chipsP);
        }
        // 4H+日線逆向動態扣分（與 buildTradeSetup techPenalty 的方向扣分一致：4H +4，日線 +5）
        let _dirP = 0;
        if (_fCoin) {
          const _fH4Sig = (_fCoin.h4Signal    || '');
          const _fDySig = (_fCoin.dailySignal || '');
          if (_isL) {
            if (_fH4Sig.includes('bear')) _dirP += 4;
            if (_fDySig.includes('bear') && !_fDySig.includes('neutral')) _dirP += 5;
          } else {
            if (_fH4Sig.includes('bull')) _dirP += 4;
            if (_fDySig.includes('bull') && !_fDySig.includes('neutral')) _dirP += 5;
          }
          _dirP = Math.min(12, _dirP);
        }
        // 資金流動事件動態扣分（與 buildTradeSetup macroOpposePenalty 的資金流扣分一致：high 5，normal 3，中性 2，cap 10）
        let _cfP = 0;
        try {
          const _cfB = getCapitalFlowBias();
          for (const ev of _cfB.events) {
            if (_isL  && ev.bear > 0) _cfP += ev.bear >= 1.2 ? 5 : 3;
            else if (!_isL && ev.bull > 0) _cfP += ev.bull >= 1.2 ? 5 : 3;
            else if (ev.bull === 0 && ev.bear === 0) _cfP += 2;
          }
          _cfP = Math.min(10, _cfP);
        } catch(_e) {}
        // 風控分：純粹止損風控扣分（ADX/技術/籌碼/宏觀由 SQ 因子處理）
        const _cLearnDrag = Math.min(45, _learnPen);
        freshConf = Math.max(0, Math.round(100 - _cLearnDrag));
        const _rawFreshConf = freshConf;
        // 同步持倉頁面顯示：將 trade.conf 更新為即時計算值，無需點入幣種詳情
        if (trade.conf !== freshConf) { trade.conf = freshConf; changed = true; }
        // 風控分跌破取消門檻 → 自動取消掃描粗估單
        if (freshConf < 60 && !trade.entryTime) {
          const _confReason = `風控分跌至 ${freshConf} 分，低於門檻 60 分（止損風控扣分累積）`;
          addCancelCooldown(trade, _confReason);
          toDeleteIds.add(trade.id);
          cancelledSymbols.add(trade.symbol);
          changed = true;
          sendCancelTelegramNotification(trade, _confReason);
        }
      } catch(_e) {}
    } else {
      // 無宏觀快取時：純止損風控扣分（100 分制）
      const _cLD = Math.min(45, _learnPen);
      freshConf = Math.max(0, Math.round(100 - _cLD));
      if (trade.conf !== freshConf) { trade.conf = freshConf; changed = true; }
      if (freshConf < 60 && !trade.entryTime) {
        const _confReason = `風控分跌至 ${freshConf} 分，低於門檻 60 分（止損風控扣分累積）`;
        addCancelCooldown(trade, _confReason);
        toDeleteIds.add(trade.id);
        cancelledSymbols.add(trade.symbol);
        changed = true;
        sendCancelTelegramNotification(trade, _confReason);
      }
    }
    // 風險評估升至高風險（≥60）→ 取消未入場掛單（獨立於風控分，任何時候高風險均取消）
    if (!toDeleteIds.has(trade.id) && !trade.entryTime && _fCoin) {
      try {
        const _frSetup = computeSimpleSetup(_fCoin, _isL);
        const _frRisk  = computeFullRisk(_fCoin, _frSetup, _isL);
        if (_frRisk.score >= 60) {
          const _frReason = `AI 風險評估升至${_frRisk.level}（${_frRisk.score}/100）：${(_frRisk.factors || []).slice(0, 2).join('、')}`;
          addCancelCooldown(trade, _frReason);
          toDeleteIds.add(trade.id);
          cancelledSymbols.add(trade.symbol);
          changed = true;
          sendCancelTelegramNotification(trade, _frReason);
        }
      } catch(_frErr) { console.warn('[risk-cancel]', trade.symbol, _frErr); }
    }
  }

  for (const trade of tlog) {
    if (trade.status === 'pending') {
      const coin = data.find(d => d.symbol === trade.symbol);
      // 震盪單：影線區域失效快（2小時）；定向短線單：4小時等待回踩；長線單（canScaleIn=true）：24小時有效
      const isLongTermTrade = trade.canScaleIn === true;
      const expiryMs = isLongTermTrade ? SIGNAL_COOLDOWN * 12 : SIGNAL_COOLDOWN * 2;
      if (!coin || Date.now() - (trade.timestamp || 0) > expiryMs) {
        trade.status = 'expired'; changed = true; continue;
      }
      const cur    = parseFloat(coin.price) || 0;
      const isLong = trade.direction === 'long';
      const entry  = trade.entry;

      // ── 進場前信號有效性檢查：趨勢反轉或評分跌破門檻則取消掛單 ──
      const nowScore = parseFloat(coin.score) || 50;
      // 趨勢反轉判斷（長線單跳過）
      const trendReversed = !isLongTermTrade && (isLong
        ? coin.trend?.includes('看跌')
        : coin.trend?.includes('看漲'));
      // 評分方向反轉判斷：與 recordSignalsFromScan 建立方向門檻完全一致（score>50=多，score<50=空）
      // 僅在方向真正反轉時取消，避免 score 落在 46-49 或 51-54 的正常弱信號被誤判為失效
      const scoreFailed = isLong ? nowScore < 50 : nowScore > 50;
      // 信號轉弱（長線單跳過；短線單以 scoreFailed 為主，避免評分短暫波動觸發過早取消）
      // 注意：signalWeak 門檻從 68 移除，改為只在 trendReversed 或 scoreFailed 時才取消
      const signalWeak = false; // 已廢棄：原 nowScore < 68 會讓剛建立的掛單立即被取消（建立門檻75 vs 取消門檻68）
      // 精煉單（幣種詳情頁建立，refined=true）保留至自然到期或 SL/TP 觸發；
      // 掃描粗略單（refined=false）才依趨勢/評分自動取消
      if (!trade.refined && (trendReversed || scoreFailed || signalWeak)) {
        const reasons = [];
        if (trendReversed) reasons.push(`趨勢已反轉（${coin.trend}）`);
        if (scoreFailed)   reasons.push(`評分跌至 ${nowScore}，信號失效`);
        const cancelReason = reasons.join('；') || `市場條件轉弱（評分 ${nowScore}，趨勢 ${coin.trend}）`;
        addCancelCooldown(trade, cancelReason);
        toDeleteIds.add(trade.id);
        changed = true;
        cancelledSymbols.add(trade.symbol);
        sendCancelTelegramNotification(trade, cancelReason);
        continue;
      }

      // ── 進場前已突破止損位 → 立即取消（風控執行）──
      const sl = trade.sl;
      if (sl && ((isLong && cur < sl) || (!isLong && cur > sl))) {
        const _slReason = `進場前價格已${isLong ? '跌破' : '突破'}止損位 $${sl}（現價 $${cur.toPrecision(6)}）`;
        addCancelCooldown(trade, _slReason);
        toDeleteIds.add(trade.id);
        changed = true;
        cancelledSymbols.add(trade.symbol);
        sendCancelTelegramNotification(trade, _slReason);
        continue;
      }

      // ── 未回踩進場，價格已飛越止盈位 → 取消並通知（機會已過）──
      const { tp1, tp2 } = trade;
      // 長線單：使用部分止盈位（3R）作為飛越門檻，避免因最終止盈太遠而無法觸發取消
      const flyOverTP = (trade.canScaleIn && trade.ltPartialTP) ? trade.ltPartialTP : tp1;
      const missedTP = (isLong && cur >= flyOverTP) || (!isLong && cur <= flyOverTP);
      if (missedTP) {
        const hitTP2   = (isLong && cur >= tp2) || (!isLong && cur <= tp2);
        const hitLevel = hitTP2 ? '止盈二' : '止盈一';
        const fmt      = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
        const cancelReason = `價格未回踩進場直接飛越${hitLevel}（$${fmt(isLong ? tp1 : tp1)}），掛單失效`;
        addCancelCooldown(trade, cancelReason);
        toDeleteIds.add(trade.id);
        changed = true;
        cancelledSymbols.add(trade.symbol);
        // 瀏覽器通知
        const s = loadSettings();
        if (s.notifBrowser) {
          sendBrowserNotification(
            `⚡ 未進場飛越${hitLevel}：${trade.symbol}`,
            `${trade.direction === 'long' ? '做多' : '做空'} 進場 $${fmt(trade.entry)} → ${hitLevel} $${fmt(hitTP2 ? tp2 : tp1)} 已過`,
            `missed-${trade.id}`
          );
        }
        sendMissedEntryNotification(trade, hitLevel, hitTP2 ? tp2 : tp1);
        continue;
      }

      // 進場確認：訊號後等 2 分鐘，確保 Telegram 通知已送達且有足夠時間觀察回踩
      // 設計：T=0 訊號出現 → T<120s 觀察期（不入場）→ T≥120s 等回踩確認
      const MIN_PENDING_SECS = 120; // 2 分鐘最低觀察期
      const tradeAge = (Date.now() - (trade.timestamp || 0)) / 1000;
      if (tradeAge < MIN_PENDING_SECS) continue; // 太新，跳過進場確認

      // 多頭：現價降至進場價附近（0.5% 容差）
      // 空頭：現價升至進場價附近（0.5% 容差）
      const touched = isLong ? cur <= entry * 1.005 : cur >= entry * 0.995;
      if (touched) {
        trade.status    = 'open';
        trade.entryTime = Date.now();
        changed = true;
      }
      continue;
    }

    if (trade.status !== 'open') continue;
    const coin = data.find(d => d.symbol === trade.symbol);
    if (!coin) continue;
    const cur = parseFloat(coin.price) || 0;
    if (!cur) continue;
    const { entry, sl, tp1, tp2, direction } = trade;
    // baseSl：原始止損（止盈一後 sl 移至成本，用 baseSl 保持 R 計算正確）
    const baseRisk = Math.abs(entry - (trade.baseSl ?? sl)) || Math.abs(entry - sl) || 1;
    const isLong = direction === 'long';
    let outcome = null;
    if (isLong) {
      if (cur >= tp2) {
        outcome = 'tp2';
      } else if (cur >= tp1 && !trade.tp1Hit) {
        if (!trade.baseSl) trade.baseSl = sl; // 保存原始止損
        trade.tp1Hit = true; trade.sl = entry; changed = true; // 止損自動移至成本
        tp1Hits.push({ trade, coin, cur });
      } else if (trade.tp1Hit && cur <= entry) {
        // TP1已觸及後跌回成本 → 自動保本出場
        outcome = 'be';
      } else if (cur <= sl) {
        outcome = 'sl';
      }
    } else {
      if (cur <= tp2) {
        outcome = 'tp2';
      } else if (cur <= tp1 && !trade.tp1Hit) {
        if (!trade.baseSl) trade.baseSl = sl; // 保存原始止損
        trade.tp1Hit = true; trade.sl = entry; changed = true; // 止損自動移至成本
        tp1Hits.push({ trade, coin, cur });
      } else if (trade.tp1Hit && cur >= entry) {
        // TP1已觸及後漲回成本 → 自動保本出場
        outcome = 'be';
      } else if (cur >= sl) {
        outcome = 'sl';
      }
    }
    if (outcome) {
      trade.status   = 'closed';
      trade.outcome  = outcome;
      trade.exitTime = Date.now();
      if (outcome === 'tp2') {
        trade.exitPrice = tp2;
        trade.pnlR = ((Math.abs(tp2 - entry) / baseRisk)).toFixed(2);
      } else if (outcome === 'tp1') {
        trade.exitPrice = tp1;
        trade.pnlR = ((Math.abs(tp1 - entry) / baseRisk)).toFixed(2);
      } else if (outcome === 'be') {
        trade.exitPrice = entry;
        trade.pnlR = '0.0';
      } else {
        trade.exitPrice = sl;
        trade.pnlR = '-1.0';
      }
      if (outcome === 'sl' || outcome === 'be') {
        trade.analysis = generateTradeAnalysis(trade);
      }
      archiveExpiredToMemory([trade]); // 立即存入 AI 記憶，不等月底清理
      changed = true;
      continue;
    }

    // ── 加倉邏輯 ──
    if (!trade.scaleIns) { trade.scaleIns = []; changed = true; }
    const MAX_SCALE_INS  = trade.maxScaleIns || 3;
    const confirmedSIs   = trade.scaleIns.filter(s => s.status === 'open');
    const pendingSI      = trade.scaleIns.find(s => s.status === 'pending');

    // 處理現有等待確認的加倉
    if (pendingSI) {
      if (Date.now() - pendingSI.timestamp > 2 * 60 * 60 * 1000) {
        pendingSI.status = 'expired'; changed = true;
      } else {
        // 步驟1：等回踩觸及進場位（多頭：現價 ≤ 進場位；空頭：現價 ≥ 進場位）
        if (!pendingSI.touched) {
          const touchedLevel = isLong ? cur <= pendingSI.entryLevel : cur >= pendingSI.entryLevel;
          if (touchedLevel) { pendingSI.touched = true; changed = true; }
        }
        // 步驟2：回踩到位後等反彈確認（多頭反彈 0.3%；空頭回落 0.3%）才進場
        const bounceConfirm = pendingSI.touched && (
          isLong  ? cur >= pendingSI.entryLevel * 1.003
                  : cur <= pendingSI.entryLevel * 0.997
        );
        if (bounceConfirm) {
          pendingSI.status     = 'open';
          pendingSI.entryTime  = Date.now();
          pendingSI.entryPrice = cur;
          changed = true;

          // ── 止損往前調（ATR 導向）：移至前一進場位附近，以波動率給緩衝區間 ──
          // 邏輯：前一進場位是新的「成本底線」，ATR 緩衝讓正常回調不觸發止損
          const confirmedBefore = trade.scaleIns.filter(s => s.status === 'open' && s !== pendingSI);
          const prevEntry = confirmedBefore.length > 0
            ? (confirmedBefore.at(-1).entryPrice || confirmedBefore.at(-1).entryLevel)
            : trade.entry;
          // ATR 估算（用進場時保存的 ADX 推算現在波動率）
          const _siAdx = trade.adx || 20;
          const _siAtr = cur * (_siAdx > 35 ? 0.018 : _siAdx > 25 ? 0.013 : 0.009);
          // SL 錨定在前一進場位，再往有利方向加 0.8 ATR 緩衝（避免正常回調觸發）
          const candidateSL = isLong
            ? prevEntry + _siAtr * 0.8
            : prevEntry - _siAtr * 0.8;
          const slMoved = isLong ? candidateSL > trade.sl : candidateSL < trade.sl;
          const oldSL   = trade.sl;
          if (slMoved) { trade.sl = candidateSL; changed = true; }

          sendScaleInTelegramNotification(trade, pendingSI, slMoved ? oldSL : null, slMoved ? trade.sl : null);

          // 達到最大加倉數後確保止損不低於保本位
          const nowConfirmed = trade.scaleIns.filter(s => s.status === 'open').length;
          if (nowConfirmed >= MAX_SCALE_INS) {
            const protectedSL = isLong
              ? Math.max(trade.sl, trade.entry * 1.001)
              : Math.min(trade.sl, trade.entry * 0.999);
            if (isLong ? protectedSL > trade.sl : protectedSL < trade.sl) {
              trade.sl = protectedSL;
              changed = true;
            }
          }
        }
      }
    } else if (confirmedSIs.length < MAX_SCALE_INS && (trade.canScaleIn !== false)) {
      // 追蹤峰值價格
      if (trade.peakPrice == null) { trade.peakPrice = cur; changed = true; }
      const newPeak = isLong ? Math.max(trade.peakPrice, cur) : Math.min(trade.peakPrice, cur);
      if (newPeak !== trade.peakPrice) { trade.peakPrice = newPeak; changed = true; }

      const inProfit   = isLong ? cur > trade.entry * 1.003 : cur < trade.entry * 0.997;
      const peakRef    = trade.peakPrice || trade.entry;
      const fromPeak   = peakRef > 0
        ? Math.abs(peakRef - cur) / peakRef
        : 0;
      const lastSIAt   = confirmedSIs.at(-1)?.entryTime ?? trade.entryTime ?? trade.timestamp ?? 0;
      const hasTimeGap = Date.now() - lastSIAt > 60 * 60 * 1000; // 最少 1 小時間隔

      if (inProfit && fromPeak > 0.008 && hasTimeGap) {
        const siNum   = confirmedSIs.length + 1;
        const origRisk = Math.abs(trade.entry - trade.sl) || 1;
        trade.scaleIns.push({
          id: `${trade.id}-si${siNum}`,
          seqNum: siNum,
          timestamp: Date.now(),
          entryLevel: cur,
          sl: isLong ? cur - origRisk * 0.7 : cur + origRisk * 0.7,
          tp1: trade.tp1,
          tp2: trade.tp2,
          status: 'pending',
          entryTime: null,
          entryPrice: null,
          touched: true, // 建立時現價即為回踩位，標記已觸及，等待反彈確認進場
          conf: trade.conf || 0,
        });
        changed = true;
      }
    }
  }
  // 發送延遲通知：只有通過所有取消檢查的新訊號才推送 Telegram + 瀏覽器通知
  const _pendingNotify = tlog.filter(t => t.pendingNotify === true && !toDeleteIds.has(t.id));
  if (_pendingNotify.length > 0) {
    try {
      const _ns = loadSettings();
      for (const _pnt of _pendingNotify) {
        const _pntCoin = data?.find(d => d.symbol === _pnt.symbol) || { symbol: _pnt.symbol, price: _pnt.entryPrice };

        // 發通知前重算風控分，防止「建單→立即取消」的情況：
        // checkAndSendAlerts 建單時 learnPenalty/risk 可能較低，發通知時重算若已不足 60 分則靜默取消
        try {
          const _pntPreRiskConf = Math.min(100, (_pnt.conf || 60) + (_pnt.riskPenalty || 0));
          const _pntFR = computeFullRisk(_pntCoin, { ..._pnt, conf: _pntPreRiskConf }, _pnt.direction === 'long');
          const _pntRP = calcRiskPenalty(_pntFR.score);
          const _pntLP = _pnt.learnPenalty || 0;
          const _pntFC = Math.max(0, 100 - Math.min(45, _pntLP) - _pntRP);
          _pnt.riskScore   = _pntFR.score;
          _pnt.riskLevel   = _pntFR.level;
          _pnt.riskPenalty = _pntRP;
          _pnt.conf        = _pntFC;
          if (_pntFC < 60) {
            _pnt.pendingNotify = false;
            toDeleteIds.add(_pnt.id);
            changed = true;
            continue;
          }
        } catch (_pntRE) {}

        // 交易通過最新風控分≥60 驗證，推送通知
        // Telegram 通知
        if (_ns.notifTelegram && _ns.tgToken && _ns.tgChatId) {
          try {
            const _tgSetup = Object.assign({}, _pnt, _pnt._notifyRisk || {});
            sendTelegramMessage(_ns.tgToken, _ns.tgChatId,
              buildTelegramText(_pntCoin, _pnt.direction, _tgSetup, _macroCache, window.location.origin + window.location.pathname));
            _pnt.telegramSent = true;
          } catch(_e) { console.warn('[deferred-notify tg]', _pnt.symbol, _e); }
        }
        // 瀏覽器通知（Telegram 未設定時也能收到）
        if (_ns.notifBrowser) {
          try {
            const _bDir  = _pnt.direction === 'long' ? '▲做多' : '▼做空';
            const _bConf = _pnt.conf || 0;
            const _bGrade = _pnt.sqGrade || '';
            const _bLabel = _pnt.canScaleIn ? '💎長線單' : '📡短線單';
            sendBrowserNotification(
              `${_bLabel} 新掛單：${_pnt.symbol} ${_bDir}`,
              `信心 ${_bConf}%　SQ ${_bGrade}　進場 ${_pnt.entry || ''}`,
              `csp-pending-${_pnt.symbol}`
            );
          } catch(_be) {}
        }
        _pnt.pendingNotify  = false;
        _pnt.telegramSent   = true;  // 標記已通知，後續取消才能正確發送取消 Telegram
        delete _pnt._notifyRisk;
        try {
          const _pntLabel = _pnt.canScaleIn ? '💎長線單' : '📡短線單';
          const _pntDir   = _pnt.direction === 'long' ? '▲做多' : '▼做空';
          if (typeof showToast === 'function') showToast(`${_pntLabel}：${_pnt.symbol} ${_pntDir} 風控分 ${_pnt.conf || 0} 分，已加入持倉`, 'success');
        } catch(_pntTE) {}
        changed = true;
      }
    } catch(_pne) {}
  }

  if (toDeleteIds.size > 0) {
    tlog.splice(0, tlog.length, ...tlog.filter(t => !toDeleteIds.has(t.id)));
    changed = true;
  }
  if (changed) { saveTradeLog(tlog); invalidateLearnCache(); }
  if (tp1Hits.length > 0) sendTP1Notifications(tp1Hits);
  return cancelledSymbols;
}

async function sendTP1Notifications(hits) {
  const s = loadSettings();
  if (!s.notifBrowser && !s.notifTelegram) return;
  for (const { trade, coin, cur } of hits) {
    const dir = trade.direction === 'long' ? '做多' : '做空';
    const rr  = (Math.abs(trade.tp1 - trade.entry) / (Math.abs(trade.entry - trade.sl) || 1)).toFixed(1);
    if (s.notifBrowser) {
      sendBrowserNotification(
        `🎯 止盈一達到：${trade.symbol}`,
        `${dir} | 止損已自動移至成本 $${trade.entry}，等待止盈二`,
        `tp1-${trade.id}`
      );
    }
    if (s.notifTelegram && s.tgToken && s.tgChatId) {
      const fmt = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
      const msg =
        `🎯 <b>止盈一已達到！止損已自動保本</b>\n\n` +
        `💎 <b>${trade.symbol}</b>  ${trade.direction === 'long' ? '▲ 做多' : '▼ 做空'}\n\n` +
        `✅ 止盈一：<b>$${fmt(trade.tp1)}</b>\n` +
        `📍 進場價：$${fmt(trade.entry)}\n` +
        `💰 現價：$${fmt(cur)}\n` +
        `📊 獲利幅度：<b>+${rr}R</b>\n\n` +
        `🔒 止損已自動移至成本價 <b>$${fmt(trade.entry)}</b>，持倉等待止盈二 $${fmt(trade.tp2)}`;
      const siteUrl = window.location.origin + window.location.pathname;
      msg += `\n\n🔗 <a href="${siteUrl}">查看 ${trade.symbol.replace('/USDT','').replace('USDT','')} 詳細分析 →</a>`;
      sendTelegramMessage(s.tgToken, s.tgChatId, msg);
    }
  }
}

const _CANCEL_TG_DEDUP_KEY = 'csp_cancel_tg_dedup';
const _CANCEL_TG_DEDUP_TTL = 20 * 60 * 1000;
function _hasCancelTgSent(symbol, direction) {
  try {
    const c = JSON.parse(localStorage.getItem(_CANCEL_TG_DEDUP_KEY) || '{}');
    const k = symbol.replace('/USDT','') + '_' + direction;
    return (c[k] || 0) > Date.now() - _CANCEL_TG_DEDUP_TTL;
  } catch { return false; }
}
function _markCancelTgSent(symbol, direction) {
  try {
    const c = JSON.parse(localStorage.getItem(_CANCEL_TG_DEDUP_KEY) || '{}');
    c[symbol.replace('/USDT','') + '_' + direction] = Date.now();
    localStorage.setItem(_CANCEL_TG_DEDUP_KEY, JSON.stringify(c));
  } catch {}
}

function sendCancelTelegramNotification(trade, reason) {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;
  if (!trade.telegramSent) return; // 建單通知尚未送出 → 跳過取消通知（用戶從未看過此單）
  if (_hasCancelTgSent(trade.symbol, trade.direction)) return;
  _markCancelTgSent(trade.symbol, trade.direction);
  const fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
  const esc = str => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sym     = trade.symbol.replace('/USDT', '');
  const isLong  = trade.direction === 'long';
  const dirLabel = isLong ? '▲ 做多（Long）' : '▼ 做空（Short）';
  const siteUrl = window.location.origin + window.location.pathname;
  const now = new Date();
  const ts   = now.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) + ' ' +
               now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  // 降級通知 vs 取消通知（降級 = 長線單降為短線單，仍繼續持有）
  const isDowngrade = (reason || '').includes('降級為短線單');
  const tags = isDowngrade
    ? `#${sym.toLowerCase()} #${isLong ? 'long' : 'short'} #降級`
    : `#${sym.toLowerCase()} #${isLong ? 'long' : 'short'} #取消`;

  // ── 風控分顯示（與信號通知一致，直接顯示 freshConf）──
  const rawConf   = trade.rawConf || 0;
  const freshConf = trade.conf    || 0;
  const confDrop  = Math.max(0, rawConf - freshConf); // 供 macro bullets 條件判斷用
  const confLine  = `📶 風控分：${freshConf} 分`;

  // ── 取消/降級原因 bullets ──
  const bullets = [];
  // 實際觸發原因（主要，永遠顯示）
  bullets.push(esc(reason));

  const hasMacro = typeof _macroCache !== 'undefined' && _macroCache;

  if (hasMacro && confDrop > 1) {
    try {
      const _fg = _macroCache.fg;
      const _gm = _macroCache;
      const fgV = _fg ? parseInt(_fg.value) : null;
      const dom = _gm.btcDominance   || 0;
      const chg = _gm.marketCapChange || 0;
      let against = 0;
      if (isLong) {
        if (chg < -2) against++;
        if (dom > 58) against++;
        if (fgV != null && fgV < 30) against++;
        if (fgV != null && fgV > 75) against += 0.5;
      } else {
        if (chg > 2)  against++;
        if (dom < 44) against++;
        if (fgV != null && fgV > 70) against++;
        if (fgV != null && fgV < 25) against += 0.5;
      }
      let macroPen = against >= 3 ? 18 : against >= 2 ? 12 : against >= 1 ? 5 : 0;
      const bigDir  = computeMacroNetDir(_fg, _gm);
      const bdAg    = (isLong && bigDir.includes('bear')) || (!isLong && bigDir.includes('bull'));
      if (bdAg) { const bdMin = (bigDir === 'slight_bear' || bigDir === 'slight_bull') ? 3 : 7; if (macroPen < bdMin) macroPen = bdMin; }
      if (macroPen > 0) {
        const why = [];
        if (isLong) {
          if (dom > 58) why.push(`BTC主導率偏高 ${dom.toFixed(1)}%`);
          if (chg < -2) why.push(`市值下跌 ${chg.toFixed(1)}%`);
          if (fgV != null && fgV < 30) why.push(`恐貪指數偏低 ${fgV}`);
        } else {
          if (dom < 44) why.push(`BTC主導率偏低 ${dom.toFixed(1)}%`);
          if (chg > 2)  why.push(`市值上漲 ${chg.toFixed(1)}%`);
          if (fgV != null && fgV > 70) why.push(`恐貪指數偏高 ${fgV}`);
        }
        bullets.push(`宏觀環境逆風 -${macroPen}%${why.length ? `（${why.join('；')}）` : ''}`);
      }
      const wb = computeWeeklyAIBias(_fg, _gm);
      const tb = computeTodayAIBias(_fg, _gm);
      const wOp   = isLong ? (wb.bias||'').includes('bear') : (wb.bias||'').includes('bull');
      const tOp   = isLong ? (tb.bias||'').includes('bear') : (tb.bias||'').includes('bull');
      const wNeut = (wb.bias||'') === 'neutral';
      const tNeut = (tb.bias||'') === 'neutral';
      if (wOp) {
        const wPen = (wb.bias||'').includes('strong') ? 10 : 6;
        bullets.push(`本週AI預測 ${esc(wb.biasLabel||'')}，${isLong ? '與做多逆向' : '與做空逆向'}，扣 ${wPen}%`);
      } else if (wNeut) {
        bullets.push(`本週AI預測震盪中性，方向不明，扣 3%`);
      }
      if (tOp) {
        bullets.push(`今日AI預測 ${esc(tb.biasLabel||'')}，${isLong ? '多頭今日逆風' : '空頭今日逆風'}，扣 7%`);
      } else if (tNeut) {
        bullets.push(`今日AI預測中性，方向不確定，扣 2%`);
      }
      // 資金流動事件
      try {
        const _cfC = getCapitalFlowBias();
        for (const ev of _cfC.events) {
          if (isLong  && ev.bear > 0) { const p = ev.bear >= 1.2 ? 5 : 3; bullets.push(`💹 ${ev.name}：資金流出逆風 -${p}%`); }
          else if (!isLong && ev.bull > 0) { const p = ev.bull >= 1.2 ? 5 : 3; bullets.push(`💹 ${ev.name}：資金流入逆風 -${p}%`); }
          else if (ev.bull === 0 && ev.bear === 0) { bullets.push(`💹 ${ev.name}：資金方向中性 -2%`); }
        }
      } catch(_e) {}
    } catch (e) {}
  }

  // 學習記憶扣分 + 詳細建議
  const learnPen = trade.learnPenalty || 0;
  if (learnPen > 0) {
    bullets.push(`止損歷史記憶觸發 -${learnPen}%`);
    try {
      const lr = applyLearnAdjustment(trade.direction, trade.rsi || 50, trade.adx || 20, { skipAdxRule: true });
      (lr.warnings || []).slice(0, 3).forEach(w => bullets.push(`  ↳ ${esc(w)}`));
    } catch (e) {}
  }

  // 注意：ADX 不影響風控分（conf 公式只扣止損風控），不在此顯示

  const reasonsBlock = bullets.map(b => `  • ${b}`).join('\n');
  const titleLine   = isDowngrade ? `⚠️ <b>交易降級通知</b>` : `🚫 <b>交易建議已取消</b>`;
  const reasonLabel = isDowngrade ? `📋 <b>降級原因</b>` : `📋 <b>取消原因</b>`;
  const msg =
    `${titleLine}\n\n` +
    `${dirLabel}：<b>${trade.symbol}</b>\n` +
    `${confLine}\n\n` +
    `${reasonLabel}\n${reasonsBlock}\n\n` +
    `⏰ ${ts}\n` +
    `${tags}\n\n` +
    `🔗 <a href="${siteUrl}">查看 ${sym} 詳細分析 →</a>`;
  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
}

function sendMissedEntryNotification(trade, hitLevel, hitPrice) {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;
  if (_hasCancelTgSent(trade.symbol, trade.direction)) return;
  _markCancelTgSent(trade.symbol, trade.direction);
  const fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
  const sym  = trade.symbol.replace('/USDT', '').replace('USDT', '');
  const dir  = trade.direction === 'long' ? '▲ 做多' : '▼ 做空';
  const isLong = trade.direction === 'long';
  const siteUrl = window.location.origin + window.location.pathname;
  const msg =
    `⚡ <b>未進場已飛越${hitLevel}！</b>\n\n` +
    `💎 <b>${trade.symbol}</b>  ${dir}\n\n` +
    `📍 原掛單進場：$${fmt(trade.entry)}\n` +
    `🎯 ${hitLevel}：$${fmt(hitPrice)}\n` +
    `💰 現價：$${fmt(isLong ? hitPrice : hitPrice)}\n\n` +
    `ℹ️ 價格未回踩進場位，直接突破${hitLevel}，本次掛單已自動取消。\n` +
    `若仍看好方向，可重新評估${isLong ? '追多' : '追空'}機會。\n\n` +
    `🔗 <a href="${siteUrl}">查看 ${sym} 最新分析 →</a>`;
  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
}

function sendScaleInTelegramNotification(trade, scaleIn, oldSL = null, newSL = null) {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;
  const fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
  const sym = trade.symbol.replace('/USDT', '');
  const dir = trade.direction === 'long' ? '▲ 做多' : '▼ 做空';
  const siteUrl = window.location.origin + window.location.pathname;
  const slLine = (oldSL != null && newSL != null)
    ? `🔒 止損已上移：$${fmt(oldSL)} → <b>$${fmt(newSL)}</b>（上一進場位 + 波動緩衝）\n`
    : `🛑 現行止損：<b>$${fmt(trade.sl)}</b>\n`;
  const ltTarget = trade.ltTP || scaleIn.tp2 || scaleIn.tp1;
  const msg =
    `📈 <b>加倉確認通知 #${scaleIn.seqNum}</b>\n\n` +
    `💎 <b>${trade.symbol}</b>  ${dir}\n\n` +
    `📍 加倉進場位：<b>$${fmt(scaleIn.entryPrice || scaleIn.entryLevel)}</b>\n` +
    `${slLine}` +
    `🏁 長線最終目標：<b>$${fmt(ltTarget)}</b>\n\n` +
    `📊 原始進場：$${fmt(trade.entry)}\n` +
    `🔔 已加倉 ${scaleIn.seqNum}/${trade.maxScaleIns || 3} 次\n\n` +
    `🔗 <a href="${siteUrl}">查看 ${sym} 詳細分析 →</a>`;
  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
  // 加倉後止損已調整 → 寫入 AI 追蹤止損快取，避免同一位置重複通知
  if (newSL != null) {
    try {
      const _slCache = JSON.parse(localStorage.getItem('csp_sl_adjust_alert') || '{}');
      const _slKey = Math.round(newSL * 100);
      _slCache[`${trade.id}_trail_${_slKey}`] = true;
      _slCache[`${trade.id}_be_${_slKey}`] = true;
      localStorage.setItem('csp_sl_adjust_alert', JSON.stringify(_slCache));
    } catch(_e) {}
  }
}

/* ── 每日早晨市場簡報 ─────────────────────────────────────────── */
const DAILY_BRIEF_KEY = 'csp_daily_brief_date';

// 每週經濟日曆（靜態重點事件，0=週日 … 6=週六）
const WEEKLY_ECON_EVENTS = {
  0: ['無重大數據（週末效應，波動偏低）'],
  1: ['美聯儲官員講話（可能）', '歐元區 PMI 製造業終值'],
  2: ['美國 JOLTS 職位空缺（月初）', '美聯儲消費者信心指數'],
  3: ['ADP 就業人數 20:15', 'ISM 非製造業 PMI', 'EIA 原油庫存 22:30', 'FOMC 紀要（隔週）'],
  4: ['美國初請失業金人數 20:30', 'ECB 利率決議（隔月）', '美聯儲官員講話'],
  5: ['非農就業報告 NFP 20:30（月初第一個週五）', 'Michigan 消費者信心指數 22:00', 'ISM 製造業 PMI（月初）'],
  6: ['無重大數據（週末）'],
};

function startDailyBriefingCheck() {
  // 開啟 App 時立即補發（若今日 9 點後尚未發送）
  (async () => {
    const now   = new Date();
    const today = now.toDateString();
    if (now.getHours() >= 9) {
      const lastSent = localStorage.getItem(DAILY_BRIEF_KEY);
      if (lastSent !== today) {
        localStorage.setItem(DAILY_BRIEF_KEY, today);
        await sendDailyBriefing();
      }
    }
  })().catch(e => console.warn('[daily-brief-init]', e));
  // 每分鐘持續監聽，準時 9 點觸發
  setInterval(() => {
    const now   = new Date();
    const hour  = now.getHours();
    const today = now.toDateString();
    if (hour !== 9) return;
    const lastSent = localStorage.getItem(DAILY_BRIEF_KEY);
    if (lastSent === today) return;
    localStorage.setItem(DAILY_BRIEF_KEY, today);
    sendDailyBriefing().catch(e => console.warn('[daily-brief]', e));
  }, 60 * 1000);
}

async function sendDailyBriefing() {
  const s = loadSettings();
  if (!s.tgToken || !s.tgChatId) return false;  // only need token+chatId, not toggle
  try {
    const [fg, globalMkt] = await Promise.allSettled([fetchFearGreed(), fetchGlobalMarket()]);
    const fgData  = fg.status === 'fulfilled' ? fg.value : null;
    const mktData = globalMkt.status === 'fulfilled' ? globalMkt.value : null;
    let msg = buildDailyBriefingMsg(fgData, mktData);
    if (msg.length > 4000) msg = msg.slice(0, 3980) + '\n…（訊息過長已截斷）';
    const ok = await sendTelegramMessage(s.tgToken, s.tgChatId, msg);
    return ok;
  } catch { return false; }
}

function buildDailyBriefingMsg(fg, mkt) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit', weekday:'short' });
  const fgVal   = fg ? parseInt(fg.value) : null;
  const fgZh    = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fg?.value_classification] || '';
  const fgPrev  = fg?.previous_close ? parseInt(fg.previous_close) : null;
  const fgDiff  = (fgVal != null && fgPrev != null) ? (fgVal - fgPrev) : null;

  const mktChg  = mkt?.marketCapChange != null ? mkt.marketCapChange.toFixed(2) : null;
  const btcDom  = mkt?.btcDominance != null ? mkt.btcDominance.toFixed(1) : null;

  // 昨日市場回顧
  const yesterdaySection = (() => {
    const parts = [];
    if (fgPrev != null) parts.push(`• 昨日恐貪指數：${fgPrev}（${fgDiff != null ? (fgDiff >= 0 ? `今日升至 ${fgVal} ▲${fgDiff}` : `今日降至 ${fgVal} ▼${Math.abs(fgDiff)}`) : ''}）`);
    if (mktChg != null) parts.push(`• 加密市值 24h 變化：${parseFloat(mktChg) >= 0 ? '+' : ''}${mktChg}%`);
    return parts.length ? parts.join('\n') : '• 數據獲取中…';
  })();

  // 昨日盈虧報告（精簡版：勝率 + 止盈/止損筆數 + 總盈虧）
  const yesterdayPnlSection = (() => {
    const tlog = loadTradeLog();
    const yStart = new Date(now); yStart.setDate(yStart.getDate() - 1); yStart.setHours(0,0,0,0);
    const yEnd   = new Date(now); yEnd.setDate(yEnd.getDate() - 1);     yEnd.setHours(23,59,59,999);
    const yClosed = tlog.filter(t => t.status === 'closed' && t.exitTime >= yStart.getTime() && t.exitTime <= yEnd.getTime());
    if (!yClosed.length) return '• 昨日無結算交易';
    const tp  = yClosed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
    const sl  = yClosed.filter(t => t.outcome === 'sl' || t.outcome === 'be').length;
    const wr  = yClosed.length > 0 ? Math.round(tp / yClosed.length * 100) : 0;
    const totalR = yClosed.reduce((s, t) => s + parseFloat(t.pnlR || 0), 0);
    return [
      `• 勝率：${wr}%　止盈 ${tp} 筆　止損 ${sl} 筆`,
      `• 總盈虧：${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)} R`,
    ].join('\n');
  })();

  // 加密市場大方向（文字版）
  const marketDirSection = (() => {
    let bullPts = 0, bearPts = 0;
    const args = [];
    if (fgVal != null) {
      if (fgVal >= 60)      { bullPts++; args.push(`• 恐貪 ${fgVal}（${fgZh}），情緒偏多`); }
      else if (fgVal <= 40) { bearPts++; args.push(`• 恐貪 ${fgVal}（${fgZh}），情緒偏空`); }
      else                  { args.push(`• 恐貪 ${fgVal}（中性），多空均衡`); }
    }
    if (mktChg != null) {
      const chg = parseFloat(mktChg);
      if (chg > 2)       { bullPts += 2; args.push(`• 市值 +${mktChg}%，資金積極流入`); }
      else if (chg > 0)  { bullPts++;    args.push(`• 市值 +${mktChg}%，小幅成長`); }
      else if (chg < -2) { bearPts += 2; args.push(`• 市值 ${mktChg}%，資金明顯流出`); }
      else if (chg < 0)  { bearPts++;    args.push(`• 市值 ${mktChg}%，輕微回調`); }
    }
    if (btcDom != null) {
      const dom = parseFloat(btcDom);
      if (dom > 56)      { bearPts++; args.push(`• BTC 主導 ${btcDom}%，山寨資金分散難`); }
      else if (dom < 44) { bullPts++; args.push(`• BTC 主導 ${btcDom}%，山寨季資金活躍`); }
      else               { args.push(`• BTC 主導 ${btcDom}%，均衡格局`); }
    }
    const bias = bullPts > bearPts + 1 ? '▲ 偏多' : bearPts > bullPts + 1 ? '▼ 偏空' : '◆ 中性偏多';
    return `${bias}\n${args.join('\n') || '• 數據更新中'}`;
  })();

  // 宏觀 AI 預測摘要（每季固定重點，每月人工更新）
  const macroPredSection = [
    '• 美聯儲維持利率（6月）：信心 82%，預期偏多 BTC +3%~8%',
    '• CPI 2.4%~2.6%（5月）：信心 71%，低於 2.4% 偏多，高於 2.7% 承壓',
    '• BTC ETF 持續淨流入：信心 78%，每日 3~8 億美元提供底部支撐',
    '• 全球流動性擴張：信心 74%，M2 增長歷史上與加密牛市高度相關',
  ].join('\n');

  // HTML-escape helper（避免 < > & 破壞 Telegram HTML 解析）
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // 今日重要數據公布（含 AI 預測多空方向 + 信心值）
  const todayEconEvents = getTodayEconEvents();
  const eventSection = todayEconEvents.length
    ? todayEconEvents.map(ev => {
        const timeStr = `${ev.twHour}:${String(ev.twMin).padStart(2,'0')}`;
        const impactTag = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢';
        const isPublished = ev.eventTime && ev.eventTime.getTime() < Date.now();
        if (isPublished) {
          const dkY = ev.eventTime.getFullYear(), dkM = ev.eventTime.getMonth(), dkD = ev.eventTime.getDate();
          const actualVal = getEconActualValue(ev.name, `${dkY}-${dkM}-${dkD}`);
          const { dirLabel: aDir, dirReason: aReason } = actualVal ? _econDirText(ev, actualVal) : {};
          const actualLine  = actualVal ? `   📌 <b>公布值：${esc(actualVal)}</b>` : '   📌 公布值：尚未取得';
          const dirLine2    = aDir ? `   ${aDir}` : '';
          const reasonLine2 = aReason ? `   💬 ${esc(aReason)}` : '';
          return `${impactTag} <b>${esc(ev.name)}</b>（${timeStr} 已公布）\n${actualLine}${dirLine2 ? '\n'+dirLine2 : ''}${reasonLine2 ? '\n'+reasonLine2 : ''}`;
        }
        const aDirLabel = (ev.aiDir === 'bull') ? '▲ 偏多' : (ev.aiDir === 'bear') ? '▼ 偏空' : '◆ 中性';
        const aiLine    = ev.aiPred
          ? `   🤖 AI 預測值：${esc(ev.aiPred)}（信心 ${ev.aiConf}%）`
          : '';
        const aiDirLine = ev.aiDir
          ? `   📊 預測方向：${aDirLabel}`
          : '';
        const aiReason  = ev.aiDirReason
          ? `   📌 ${esc(ev.aiDirReason)}`
          : '';
        return `${impactTag} <b>${esc(ev.name)}</b>（台灣時間 ${timeStr}）${aiLine ? '\n'+aiLine : ''}${aiDirLine ? '\n'+aiDirLine : ''}${aiReason ? '\n'+aiReason : ''}`;
      }).join('\n\n')
    : '⏰ 今日無重大預定數據';

  // ── 本週 AI 走勢預測（文字版）──
  let weeklyAISection = '數據計算中…';
  try {
    const wb = computeWeeklyAIBias(fg, mkt);
    const topFactors = (wb.factors || []).slice(0, 4).map(f => `   • ${f}`).join('\n');
    weeklyAISection = `${wb.biasLabel}（信心 ${wb.conf}%）${topFactors ? '\n' + topFactors : ''}\n   ⚠️ ${wb.riskNote || ''}`;
  } catch (e) { weeklyAISection = '（計算失敗）'; }

  // ── 今日 AI 多空預測（文字版）──
  let todayAISection = '數據計算中…';
  try {
    const tb = computeTodayAIBias(fg, mkt);
    const topReasons = (tb.reasons || []).slice(0, 4).map(r => `   • ${r}`).join('\n');
    todayAISection = `${tb.biasLabel}（信心 ${tb.conf}%）${topReasons ? '\n' + topReasons : ''}\n   ⚠️ ${tb.riskNote || ''}`;
    // 數據翻轉風險
    const nowMs = Date.now();
    const flips = (tb.highEvs || []).filter(ev => {
      const m = (ev.eventTime.getTime() - nowMs) / 60000;
      return m > -60 && m < 720;
    });
    if (flips.length) {
      todayAISection += '\n\n   ⚡ <b>數據翻轉風險</b>\n' + flips.map(ev => {
        const m = (ev.eventTime.getTime() - nowMs) / 60000;
        const tl = m < 0 ? '剛公布' : m < 60 ? `${Math.round(m)}分鐘後` : `${(m/60).toFixed(1)}小時後`;
        return `   🕐 ${tl} ${esc(ev.name)}${ev.aiPred ? `：AI預測 ${esc(ev.aiPred)}（信心 ${ev.aiConf}%）` : ''}`;
      }).join('\n');
    }
  } catch (e) { todayAISection = '（計算失敗）'; }

  // ── 極端頂/底反轉可能性（僅顯示 BTC / ETH 兩大主流幣）──
  const reversalSection = (() => {
    try {
      const cache = (typeof _tradeSetupCache !== 'undefined' && _tradeSetupCache) ? _tradeSetupCache : {};
      const lines = ['BTC/USDT', 'ETH/USDT'].map(sym => {
        const er = cache[sym]?.extremeRev;
        if (!er) return `📊 <b>${esc(sym)}</b> 反轉數據計算中…`;
        if (!er.direction) {
          return `📊 <b>${esc(sym)}</b> 無顯著反轉訊號（頂部 ${er.topScore || 0} / 底部 ${er.bottomScore || 0}）`;
        }
        const isTop  = er.direction === 'top';
        const icon   = isTop ? '📉' : '📈';
        const zh     = isTop ? '頂部' : '底部';
        const status = er.confidence >= 98
          ? `⚡ 已達 98% 門檻，可考慮反向${isTop ? '做空' : '做多'}`
          : er.confidence >= 85
            ? `⚠️ 潛在反轉（距 98% 門檻還差 ${98 - er.confidence} 分）`
            : `🔭 早期觀察（距門檻 ${98 - er.confidence} 分）`;
        const topSig = (er.signals || []).slice().sort((a, b) => (b.pts || 0) - (a.pts || 0))[0];
        return `${icon} <b>${esc(sym)}</b> ${zh}反轉 ${er.confidence}/100\n   ${status}${topSig ? `\n   • ${esc(topSig.label)}（+${topSig.pts}）` : ''}`;
      });
      return lines.join('\n');
    } catch(e) { return '• 反轉掃描暫無數據'; }
  })();

  const chartPatSection = (() => { try {
    const _cpCache = (typeof _tradeSetupCache !== 'undefined' && _tradeSetupCache) ? _tradeSetupCache : {};
    const lines = ['BTC/USDT', 'ETH/USDT'].map(sym => {
      const cp = _cpCache[sym]?.chartPat;
      if (!cp || !cp.patterns.length) return `📐 ${sym.replace('/USDT','')} — 無明顯形態`;
      const confirmed = cp.patterns.filter(p => p.status !== 'forming').slice(0, 2);
      const forming   = cp.patterns.filter(p => p.status === 'forming').slice(0, 1);
      const parts = [
        ...confirmed.map(p => `${p.emoji} ${p.name}（${p.aligned === true ? '同向' : p.aligned === false ? '逆向' : '中性'}）`),
        ...forming.map(p => `${p.emoji} ${p.name} 🔄形成中`)
      ];
      return `📐 ${sym.replace('/USDT','')} — ${parts.join('  |  ')}`;
    });
    return lines.join('\n');
  } catch(_e) { return '• 圖形數據暫無'; } })();

  return `📊 <b>每日市場簡報</b> ${dateStr}\n\n` +
    `🔄 <b>頂/底反轉可能性</b>\n${reversalSection}\n\n` +
    `📐 <b>技術圖形識別（BTC / ETH 4H）</b>\n${chartPatSection}\n\n` +
    `📅 <b>昨日市場回顧</b>\n${yesterdaySection}\n\n` +
    `💰 <b>昨日盈虧報告</b>\n${yesterdayPnlSection}\n\n` +
    `🌐 <b>加密市場大方向</b>\n${marketDirSection}\n\n` +
    `📈 <b>本週 AI 走勢預測</b>\n${weeklyAISection}\n\n` +
    `📅 <b>今日 AI 多空預測</b>\n${todayAISection}\n\n` +
    `🤖 <b>宏觀 AI 預測</b>\n${macroPredSection}\n\n` +
    `📆 <b>今日重要數據</b>\n${eventSection}\n\n` +
    (() => { try { const cf = buildCapitalFlowTelegramSection(fg, mkt); return `💹 <b>資金流動事件提醒</b>\n${cf || '• 本月無近期資金流動事件'}\n\n`; } catch { return ''; } })() +
    `<i>🤖 由 AI 自動分析生成 · 僅供參考，不構成投資建議</i>`;
}

/* ── 台灣時間重要數據預警系統 ─────────────────────────────────── */
// 每週固定時程（台灣時間 UTC+8）
// 格式：{ name, dayOfWeek (0=日…6=六), twHour, twMin, prevKey, description, impact }
const WEEKLY_DATA_SCHEDULE = [
  { name: '美國初請失業金人數', dayOfWeek: 4, twHour: 20, twMin: 30, prevKey: 'usJobless',
    description: '衡量每週新增失業人數，數字越低代表勞動市場越強勁', impact: 'medium',
    bullIf: '< 預期（就業強勁 → 聯準會鷹派 → 美元走強，加密短線承壓）',
    bearIf: '> 預期（就業疲軟 → 降息預期升溫 → 加密可能反應偏多）',
    aiPred: '218K～228K', aiConf: 72, aiDir: 'neutral',
    aiDirReason: '預測落在 210K～240K 中性區間，對加密影響有限，偏中性震盪',
    aiMarketImpact: '低於 210K 美元走強加密承壓；高於 240K 降息預期升加密偏多' },
  { name: 'EIA 原油庫存', dayOfWeek: 3, twHour: 22, twMin: 30, prevKey: 'eiaOil',
    description: '美國原油庫存週報，影響通膨預期與風險情緒', impact: 'low',
    bullIf: '庫存大幅下降（通膨預期升溫，加密有時跟漲）',
    bearIf: '庫存大幅增加（通縮壓力，風險情緒轉差）',
    aiPred: '-0.5M ～ -2.0M 桶（小幅去庫存）', aiConf: 57, aiDir: 'neutral',
    aiDirReason: '小幅去庫存，影響加密有限，對方向性判斷影響不大',
    aiMarketImpact: '對加密影響有限，若大幅去庫存 >3M 可能帶動通膨預期升溫' },
  { name: 'FOMC 紀要', dayOfWeek: 3, twHour: 2, twMin: 0, prevKey: 'fomc',
    description: '聯準會政策會議紀要，揭示利率決策討論細節', impact: 'high',
    bullIf: '鴿派傾向（降息預期升溫）→ 加密強烈看多',
    bearIf: '鷹派傾向（維持高利率）→ 加密短線承壓',
    aiPred: '維持謹慎，無明確降息時程信號', aiConf: 78, aiDir: 'bear',
    aiDirReason: '鷹派基調維持，無降息時程信號 → 美元偏強，加密短線偏空壓力',
    aiMarketImpact: '若出現年底降息暗示可強勁反彈；維持鷹派則短線震盪偏空' },
];

// 每月重要數據（以月份某一週某一天的方式描述）
const MONTHLY_DATA_SCHEDULE = [
  { name: '美國非農就業報告（NFP）', weekOfMonth: 1, dayOfWeek: 5, twHour: 20, twMin: 30,
    prevKey: 'usNFP', impact: 'high',
    description: '最重要的就業數據，直接影響聯準會利率決策',
    bullIf: '< 預期（降息預期升） → 加密大幅上漲機率高',
    bearIf: '> 預期（鷹派預期） → 美元走強，加密承壓',
    aiPred: '170K～200K（前值 175K，維持緩降趨勢）', aiConf: 63, aiDir: 'neutral',
    aiDirReason: '勞市溫和放緩，落在 150K～220K 中性區，降息時程不受明顯影響，加密偏中性',
    aiMarketImpact: '低於 150K 加密強勁反彈；高於 220K 美元走強短線承壓' },
  { name: '美國消費者物價指數（CPI）', weekOfMonth: 2, dayOfWeek: 2, twHour: 20, twMin: 30,
    prevKey: 'usCPI', impact: 'high',
    description: '通膨指標，聯準會最重視的數據之一',
    bullIf: '< 預期（通膨降溫）→ 降息預期升溫，加密偏多',
    bearIf: '> 預期（通膨持續）→ 高利率預期延續，加密偏空',
    aiPred: '2.3%～2.5% YoY（前值 2.4%，通膨緩慢降溫）', aiConf: 71, aiDir: 'bull',
    aiDirReason: '通膨持續降溫（低於前值 2.4%），降息預期溫和升溫，加密偏多',
    aiMarketImpact: '低於 2.2% 加密大漲機率高；高於 2.7% 市場恐慌拋售' },
  { name: '美國生產者物價指數（PPI）', weekOfMonth: 2, dayOfWeek: 3, twHour: 20, twMin: 30,
    prevKey: 'usPPI', impact: 'medium',
    description: '生產端通膨先行指標',
    bullIf: '< 預期（生產端通縮）→ CPI 後續下行空間大，偏多',
    bearIf: '> 預期（成本壓力增）→ 通膨預期升，偏空',
    aiPred: '2.0%～2.3% YoY（持續回落趨勢）', aiConf: 64, aiDir: 'bull',
    aiDirReason: '生產成本持續回落，CPI 後續下行空間加大，對加密中性偏多',
    aiMarketImpact: '下行趨勢持續對加密中性偏多；若回升超 2.5% 則承壓' },
  { name: '美國零售銷售', weekOfMonth: 3, dayOfWeek: 2, twHour: 20, twMin: 30,
    prevKey: 'usRetail', impact: 'medium',
    description: '消費支出指標，反映經濟成長動能',
    bullIf: '< 預期（消費疲軟）→ 降息預期升，加密偏多',
    bearIf: '> 預期（消費強勁）→ 高利率預期持續，加密承壓',
    aiPred: '+0.2%～+0.4% MoM（消費趨緩但未惡化）', aiConf: 60, aiDir: 'bull',
    aiDirReason: '消費溫和趨緩，低於強勁門檻，符合降息預期維持，加密輕微偏多',
    aiMarketImpact: '消費趨緩符合降息預期，短線加密輕微偏多' },
  { name: 'ADP 就業人數', weekOfMonth: 1, dayOfWeek: 3, twHour: 20, twMin: 15,
    prevKey: 'usADP', impact: 'medium',
    description: 'NFP 前瞻指標，為非農數據的早期信號',
    bullIf: '< 預期 → 降息預期升，加密偏多',
    bearIf: '> 預期 → 就業強勁，鷹派預期延續',
    aiPred: '165K～185K（接近NFP預測，勞市溫和放緩）', aiConf: 63, aiDir: 'neutral',
    aiDirReason: '就業溫和放緩，未達強烈降息觸發門檻，可作為 NFP 方向性參考',
    aiMarketImpact: '低於 150K 加密情緒明顯升溫；可作為 NFP 方向性參考' },
];

const ECON_ALERT_KEY = 'csp_econ_alert_sent';

function startEconCalendarCheck() {
  // 每分鐘檢查一次：公布前預警 + 公布後 AI 分析
  setInterval(() => {
    checkUpcomingEconEvents().catch(e => console.warn('[econ-upcoming]', e));
    checkPostEventAnalysis().catch(e => console.warn('[econ-post]', e));
  }, 60 * 1000);
}

/* 取得「今日」或（無今日事件時）未來 7 天內的即將公布數據 */
function getTodayEconEvents() {
  return getUpcomingEconEvents(0); // 今日優先
}

function getUpcomingEconEvents(extraDays = 0) {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const targetDate = new Date(base);
  targetDate.setDate(base.getDate() + extraDays);

  const dayOfWeek   = targetDate.getDay();
  const weekOfMonth = Math.ceil(targetDate.getDate() / 7);
  const events = [];

  WEEKLY_DATA_SCHEDULE.forEach(ev => {
    if (ev.dayOfWeek === dayOfWeek) {
      const eventTime = new Date(targetDate);
      eventTime.setHours(ev.twHour, ev.twMin, 0, 0);
      events.push({ ...ev, eventTime, type: 'weekly', daysAhead: extraDays });
    }
  });

  MONTHLY_DATA_SCHEDULE.forEach(ev => {
    const weekMatch = Math.abs(weekOfMonth - ev.weekOfMonth) <= 1;
    if (ev.dayOfWeek === dayOfWeek && weekMatch) {
      const eventTime = new Date(targetDate);
      eventTime.setHours(ev.twHour, ev.twMin, 0, 0);
      events.push({ ...ev, eventTime, type: 'monthly', daysAhead: extraDays });
    }
  });

  return events;
}

/* 取得未來 7 天的所有即將公布數據（今天若無事件則向後找） */
function getWeeklyEconEvents() {
  const allEvents = [];
  for (let d = 0; d <= 6; d++) {
    const evs = getUpcomingEconEvents(d);
    evs.forEach(ev => allEvents.push(ev));
  }
  // 排除已公布超過 2 小時的今日事件
  return allEvents.filter(ev => {
    const minsAgo = (Date.now() - ev.eventTime.getTime()) / 60000;
    return minsAgo < 120; // 未公布或剛公布 2 小時內
  }).sort((a, b) => a.eventTime - b.eventTime);
}

async function checkUpcomingEconEvents() {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;

  const now = Date.now();
  const events = getTodayEconEvents();
  const sentToday = JSON.parse(localStorage.getItem(ECON_ALERT_KEY) || '{}');
  const todayKey  = new Date().toDateString();

  for (const ev of events) {
    const eventTs  = ev.eventTime.getTime();
    const alertKey = `${todayKey}_${ev.name}`;
    // 距離公布時間 55~65 分鐘內發送（避免重複）
    const minsUntil = (eventTs - now) / 60000;
    if (minsUntil < 55 || minsUntil > 65) continue;
    if (sentToday[alertKey]) continue;
    sentToday[alertKey] = true;
    localStorage.setItem(ECON_ALERT_KEY, JSON.stringify(sentToday));
    // 保存公布前的市場快照，用於公布後對比實際反應
    if (_macroCache) {
      const snapKey = `${todayKey}_snap_${ev.name}`;
      localStorage.setItem(snapKey, JSON.stringify({
        marketCapChange: _macroCache.marketCapChange ?? null,
        btcDominance:    _macroCache.btcDominance ?? null,
        fg: _macroCache.fg?.value ? parseInt(_macroCache.fg.value) : null,
        savedAt: Date.now(),
      }));
    }
    sendEconEventAlert(ev, s);
  }
}

function sendEconEventAlert(ev, s) {
  const impactEmoji = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢';
  const twTime = `${String(ev.twHour).padStart(2,'0')}:${String(ev.twMin).padStart(2,'0')} TW`;
  const tlog   = loadTradeLog();
  const openTrades = tlog.filter(t => t.status === 'open');

  // 讀取發送前剛保存的快照，用於生成動態建議語境
  const todayKey = new Date().toDateString();
  const snapKey  = `${todayKey}_snap_${ev.name}`;
  const snap     = JSON.parse(localStorage.getItem(snapKey) || 'null');
  const _fgSnap  = snap?.fg ?? null;
  const _chgSnap = snap?.marketCapChange ?? null;
  const _domSnap = snap?.btcDominance ?? null;

  // 動態語境說明
  const _fgCtx = _fgSnap != null
    ? (_fgSnap >= 70 ? `（恐貪 ${_fgSnap}，極度貪婪，獲利了結賣壓風險高）`
       : _fgSnap >= 55 ? `（恐貪 ${_fgSnap}，貪婪區，情緒較脆弱易反轉）`
       : _fgSnap <= 30 ? `（恐貪 ${_fgSnap}，極度恐慌，佳數據可觸發急速反彈）`
       : _fgSnap <= 45 ? `（恐貪 ${_fgSnap}，恐慌區，市場敏感性高）`
       : '') : '';
  const _mktCtx = _chgSnap != null
    ? (_chgSnap > 2 ? '，近24h市場強勢上漲' : _chgSnap < -2 ? '，近24h市場疲弱下跌' : '') : '';
  const _altCtx = _domSnap != null && _domSnap < 45 ? '（目前山寨季格局，山寨反應可能更劇烈）' : '';
  const _aiDirCtx = ev.aiDir
    ? (ev.aiDir === 'bull' ? '，AI預測偏多，若數據符合預測方向可順勢跟進'
       : ev.aiDir === 'bear' ? '，AI預測偏空，若數據符合預測方向可考慮防守或空單'
       : '') : '';

  const tradeNote = openTrades.length
    ? `\n⚠️ 目前持有 ${openTrades.length} 筆倉位，數據公布前建議確認止損位置`
    : '\n✅ 目前無持倉，數據後方向確認再進場機會較佳';

  const aDirLabel = (ev.aiDir === 'bull') ? '▲ 偏多' : (ev.aiDir === 'bear') ? '▼ 偏空' : '◆ 中性';
  const aiSection = ev.aiPred
    ? `\n🤖 <b>AI 預測</b>\n` +
      `• 預測值：${ev.aiPred}（信心 ${ev.aiConf || '--'}%）\n` +
      `• 預測方向：${aDirLabel}\n` +
      (ev.aiDirReason ? `• 原因：${ev.aiDirReason}\n` : '')
    : '';

  const msg =
    `${impactEmoji} <b>重要數據即將公布（約1小時後）</b>\n\n` +
    `📊 <b>${ev.name}</b>\n` +
    `⏰ 台灣時間：<b>${twTime}</b>\n` +
    `📝 說明：${ev.description}\n\n` +
    `📈 若數據優於預期：${ev.bullIf}\n` +
    `📉 若數據差於預期：${ev.bearIf}` +
    aiSection +
    `\n🎯 <b>盤面影響分析</b>\n` +
    `• 數據公布前 30 分鐘通常出現方向性試探${_fgCtx}\n` +
    `• 公布後 5~15 分鐘為高波動期${_mktCtx}，避免追入${_altCtx}\n` +
    `• 公布後 1 小時若延續方向且首根確認K棒收線${_aiDirCtx}可考慮跟進` +
    tradeNote;
  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
}

/* ── 數據公布後 AI 影響分析 ─────────────────────────────────── */
async function checkPostEventAnalysis() {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;

  const now       = Date.now();
  const todayKey  = new Date().toDateString();
  const postKey   = 'csp_post_event_analysis';
  const postSent  = JSON.parse(localStorage.getItem(postKey) || '{}');
  const events    = getTodayEconEvents();

  for (const ev of events) {
    const eventMs   = ev.eventTime.getTime();
    const minsAfter = (now - eventMs) / 60000;
    // 公布後 25~50 分鐘內發送一次分析（市場方向已初步穩定）
    if (minsAfter < 25 || minsAfter > 50) continue;
    const key = `${todayKey}_post_${ev.name}`;
    if (postSent[key]) continue;
    postSent[key] = true;
    localStorage.setItem(postKey, JSON.stringify(postSent));

    // 讀取發送公布前快照（進場前保存）與當前數據，對比市場實際反應
    const snapKey  = `${todayKey}_snap_${ev.name}`;
    const snap     = JSON.parse(localStorage.getItem(snapKey) || 'null');
    const [fgRes, mktRes] = await Promise.allSettled([fetchFearGreed(), fetchGlobalMarket()]);
    const fgNow  = fgRes.status  === 'fulfilled' ? fgRes.value  : null;
    const mktNow = mktRes.status === 'fulfilled' ? mktRes.value : null;

    sendPostEventAnalysis(ev, s, snap, fgNow, mktNow);
  }
}

function _econDirText(ev, actualVal) {
  const avL = (actualVal || '').toLowerCase();
  let isBear = false, isBull = false, bearReason = '', bullReason = '';
  if (ev.name.includes('失業金') || ev.name.includes('初請')) {
    isBear = avL.includes('低於') || avL.includes('強勁') || avL.includes('承壓') || avL.includes('鷹派');
    isBull = avL.includes('高於') || avL.includes('轉弱') || avL.includes('疲軟') || avL.includes('降息預期升');
    bearReason = '就業強勁 → 聯準會維持鷹派 → 加密短線承壓';
    bullReason = '就業轉弱 → 降息預期升溫 → 加密偏多';
  } else if (ev.name.includes('NFP') || ev.name.includes('非農') || ev.name.includes('ADP')) {
    isBear = avL.includes('勝出') || avL.includes('高於') || avL.includes('遠超') || avL.includes('強勁');
    isBull = avL.includes('低於') || avL.includes('疲軟') || avL.includes('未達');
    bearReason = '就業超預期 → 聯準會降息延後 → 加密短線承壓';
    bullReason = '就業低於預期 → 降息預期升溫 → 加密偏多';
  } else if (ev.name.includes('CPI') || ev.name.includes('PPI') || ev.name.includes('物價')) {
    isBear = avL.includes('高於') || avL.includes('超預期') || avL.includes('升溫') || avL.includes('升幅');
    isBull = avL.includes('低於') || avL.includes('降溫') || avL.includes('回落') || avL.includes('符合');
    bearReason = '通膨高於預期 → 高利率延長 → 加密承壓';
    bullReason = '通膨降溫 → 降息預期升 → 加密偏多';
  } else if (ev.name.includes('零售')) {
    isBull = avL.includes('低於') || avL.includes('疲軟') || avL.includes('疲弱');
    isBear = avL.includes('高於') || avL.includes('強勁') || avL.includes('超預期');
    bearReason = '消費強勁 → 聯準會維持緊縮 → 加密中性偏空';
    bullReason = '消費疲軟 → 降息預期升 → 加密偏多';
  } else if (ev.name.includes('EIA') || ev.name.includes('原油')) {
    const nm = actualVal.match(/([+-]?\d+\.?\d*)\s*M?\s*桶/);
    if (nm) { const n = parseFloat(nm[1]); isBull = n < 0; isBear = n > 0; }
    bearReason = '原油庫存增加 → 供過於求 → 通縮壓力 → 風險情緒下行';
    bullReason = '原油去庫存 → 能源需求增 → 通膨預期升溫 → 中性偏多';
  } else if (ev.name.includes('FOMC')) {
    isBear = avL.includes('鷹派') || avL.includes('維持高利率') || avL.includes('通膨') || avL.includes('異議');
    isBull = avL.includes('鴿派') || avL.includes('降息') || (avL.includes('寬鬆') && !avL.includes('反對寬鬆'));
    bearReason = 'FOMC鷹派 → 高利率維持 → 流動性緊縮 → 加密承壓';
    bullReason = 'FOMC鴿派 → 降息預期升 → 流動性增加 → 加密偏多';
  } else {
    isBear = avL.includes('高於') || avL.includes('超預期');
    isBull = avL.includes('低於') || avL.includes('降溫');
  }
  const dirLabel  = isBear ? '🔴 偏空（Bearish）' : isBull ? '🟢 偏多（Bullish）' : '⚪ 中性（Neutral）';
  const dirReason = isBear ? bearReason : isBull ? bullReason : '影響有限，等待更多數據確認方向';
  return { dirLabel, dirReason, isBull, isBear };
}

function sendPostEventAnalysis(ev, s, snap, fgNow, mktNow) {
  const impactEmoji = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢';

  // ── 判斷市場實際反應（偏多/偏空）──────────────────────────────
  const mktChgNow  = mktNow?.marketCapChange ?? null;
  const fgValNow   = fgNow  ? parseInt(fgNow.value) : null;
  const domNow     = mktNow?.btcDominance   ?? null;

  // 快照對比資料
  const snapChg  = snap?.marketCapChange ?? null;
  const snapFg   = snap?.fg              ?? null;
  const snapDom  = snap?.btcDominance    ?? null;
  const chgDelta = (mktChgNow != null && snapChg != null) ? (mktChgNow - snapChg) : null;
  const fgDelta  = (fgValNow  != null && snapFg  != null) ? (fgValNow  - snapFg)  : null;
  const domDelta = (domNow    != null && snapDom  != null) ? (domNow    - snapDom)  : null;

  // 用最近1小時的市值變化量作為方向指標
  const reactionPct = chgDelta ?? mktChgNow ?? 0;

  let biasIcon, biasLabel, biasDetail;
  if (reactionPct > 1.5) {
    biasIcon  = '🟢'; biasLabel = '偏多（Bullish）';
    biasDetail = `市場在數據公布後上漲 +${reactionPct.toFixed(2)}%，反應正面，多頭佔優`;
  } else if (reactionPct > 0.4) {
    biasIcon  = '🟡'; biasLabel = '輕微偏多';
    biasDetail = `市場小幅上漲 +${reactionPct.toFixed(2)}%，方向偏多但動能有限，等待確認`;
  } else if (reactionPct < -1.5) {
    biasIcon  = '🔴'; biasLabel = '偏空（Bearish）';
    biasDetail = `市場在數據公布後下跌 ${reactionPct.toFixed(2)}%，反應負面，空頭佔優`;
  } else if (reactionPct < -0.4) {
    biasIcon  = '🟡'; biasLabel = '輕微偏空';
    biasDetail = `市場小幅下跌 ${reactionPct.toFixed(2)}%，方向偏空但幅度有限，等待確認`;
  } else {
    biasIcon  = '⚪'; biasLabel = '中性（等待方向）';
    biasDetail = `市場變動幅度小（${reactionPct.toFixed(2)}%），正在消化數據，尚無明確方向`;
  }

  // 多維輔助指標對比
  const isBull = biasLabel.includes('多');
  const isBear = biasLabel.includes('空');
  const fgLine = fgValNow != null
    ? `💡 恐貪指數：${fgValNow}${fgDelta != null ? (fgDelta > 0 ? ` ▲+${fgDelta}` : fgDelta < 0 ? ` ▼${fgDelta}` : '') : ''}${isBull && fgValNow > 55 ? '，情緒同步偏多，多頭信號強化' : isBear && fgValNow < 45 ? '，情緒同步偏空，空頭信號強化' : fgValNow > 70 ? '，極度貪婪，注意獲利了結風險' : '，情緒中性，方向信號待確認'}`
    : '';
  const domLine = domNow != null
    ? `📊 BTC 主導率：${domNow.toFixed(1)}%${domDelta != null ? (domDelta > 0.5 ? ` ▲+${domDelta.toFixed(1)}%（資金集中 BTC，山寨受壓）` : domDelta < -0.5 ? ` ▼${domDelta.toFixed(1)}%（資金輪動山寨，山寨偏多）` : '（穩定）') : ''}`
    : '';

  // AI 預測 vs 實際方向吻合度
  const _aiMatchLine = ev.aiDir && reactionPct !== 0
    ? (() => {
        const _match = (ev.aiDir === 'bull' && reactionPct > 0.4) || (ev.aiDir === 'bear' && reactionPct < -0.4);
        const _aiLabel = ev.aiDir === 'bull' ? '偏多' : ev.aiDir === 'bear' ? '偏空' : '中性';
        const _actLabel = reactionPct > 0.4 ? '偏多' : reactionPct < -0.4 ? '偏空' : '中性';
        return `${_match ? '✅' : '❌'} AI 預測（${_aiLabel}）vs 實際（${_actLabel}）：${_match ? '方向吻合，可信度提升' : '方向不符，本次預測誤差，系統將學習修正'}`;
      })()
    : '';

  // 操作建議
  const tradeRec = reactionPct > 1.5
    ? '📌 操作建議：方向確認偏多，等首根 15m 確認K棒收線後可考慮順多，止損設在近期低點'
    : reactionPct < -1.5
    ? '📌 操作建議：方向確認偏空，等首根 15m 確認K棒收線後可考慮空單或清多減倉，止損設在近期高點'
    : Math.abs(reactionPct) < 0.4
    ? '📌 操作建議：市場仍在消化數據，暫時觀望，等待 1 小時後方向更明確再行動'
    : '📌 操作建議：方向尚未明確確立，建議半倉試探或繼續觀望，等趨勢延續信號再加碼';

  // 實際公布值（從本地快取讀取）
  const _dkY = ev.eventTime.getFullYear(), _dkM = ev.eventTime.getMonth(), _dkD = ev.eventTime.getDate();
  const actualPublished = getEconActualValue(ev.name, `${_dkY}-${_dkM}-${_dkD}`);
  const isPlaceholderVal = actualPublished && (
    actualPublished.includes('待確認') || actualPublished.includes('無FOMC') ||
    actualPublished.includes('稍晚公布') || actualPublished.includes('未查得') ||
    actualPublished.includes('定於') || actualPublished.includes('假期延'));
  const { dirLabel: _actualDirLabel, dirReason: _actualDirReason } =
    (actualPublished && !isPlaceholderVal) ? _econDirText(ev, actualPublished) : {};

  const actualSection = actualPublished
    ? `📌 <b>實際公布值：${actualPublished}</b>\n` +
      (_actualDirLabel ? `${_actualDirLabel}\n` : '') +
      (_actualDirReason ? `💬 ${_actualDirReason}\n` : '')
    : '';

  const valueRef = ev.aiPred
    ? `🤖 AI 預測值（事前）：${ev.aiPred}（信心 ${ev.aiConf || '--'}%）\n`
    : '';

  const supportLines = [fgLine, domLine, _aiMatchLine].filter(Boolean).join('\n');

  const msg =
    `${impactEmoji} <b>數據公布後 AI 盤面影響分析</b>\n\n` +
    `📊 <b>${ev.name}</b>\n` +
    (valueRef ? valueRef : '') +
    (actualSection ? '\n' + actualSection : '') +
    `\n${biasIcon} <b>市場反應：${biasLabel}</b>\n` +
    `${biasDetail}\n` +
    (supportLines ? supportLines + '\n' : '') +
    `\n🤖 <b>AI 分析</b>\n${ev.aiMarketImpact || '請依市場實際反應方向操作，等首根確認K棒收線後再決策。'}\n\n` +
    tradeRec + '\n\n' +
    (ev.bullIf ? `📈 偏多情境：${ev.bullIf}\n` : '') +
    (ev.bearIf ? `📉 偏空情境：${ev.bearIf}` : '');

  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
}

function analyzeTrailingStopAI(coin, isLong, cur, atr, currentPnlR, entry, risk) {
  const rsi    = parseFloat(coin.rsi)      || 50;
  const macd   = parseFloat(coin.macdHist) || 0;
  const adx    = parseFloat(coin.adx)      || 20;
  const volStr = coin.volumeStrength || '';
  const whale  = coin.whaleData || {};
  const deriv  = coin.derivData  || {};
  const tkr    = typeof deriv.takerBuySell === 'number' ? deriv.takerBuySell : 1.0;

  let adj = 0;
  const sigs = []; // { icon, text, delta }

  // ── 技術面 ──
  if (isLong) {
    if      (rsi > 78) { adj -= 0.5; sigs.push({ icon:'⚠️', text:`RSI ${rsi} 嚴重超買，上行動能衰竭`, delta:-0.5 }); }
    else if (rsi > 72) { adj -= 0.3; sigs.push({ icon:'⚠️', text:`RSI ${rsi} 超買，動能趨緩`, delta:-0.3 }); }
    else if (rsi < 55) { adj += 0.3; sigs.push({ icon:'✅', text:`RSI ${rsi} 多頭健康區，趨勢延續`, delta:+0.3 }); }
    if      (macd < 0) { adj -= 0.4; sigs.push({ icon:'⚠️', text:`MACD 柱狀轉負，多頭動能減弱`, delta:-0.4 }); }
    else if (macd > 0) { adj += 0.2; sigs.push({ icon:'✅', text:`MACD 柱狀正值，多頭延續`, delta:+0.2 }); }
  } else {
    if      (rsi < 22) { adj -= 0.5; sigs.push({ icon:'⚠️', text:`RSI ${rsi} 嚴重超賣，下行動能衰竭`, delta:-0.5 }); }
    else if (rsi < 28) { adj -= 0.3; sigs.push({ icon:'⚠️', text:`RSI ${rsi} 超賣，空頭動能趨緩`, delta:-0.3 }); }
    else if (rsi > 45) { adj += 0.3; sigs.push({ icon:'✅', text:`RSI ${rsi} 空頭健康區，趨勢延續`, delta:+0.3 }); }
    if      (macd > 0) { adj -= 0.4; sigs.push({ icon:'⚠️', text:`MACD 柱狀轉正，空頭動能減弱`, delta:-0.4 }); }
    else if (macd < 0) { adj += 0.2; sigs.push({ icon:'✅', text:`MACD 柱狀負值，空頭延續`, delta:+0.2 }); }
  }
  if      (adx > 40) { adj += 0.4; sigs.push({ icon:'✅', text:`ADX ${adx} 強勢趨勢確認`, delta:+0.4 }); }
  else if (adx > 28) { adj += 0.2; sigs.push({ icon:'✅', text:`ADX ${adx} 趨勢有效`, delta:+0.2 }); }
  else if (adx < 20) { adj -= 0.4; sigs.push({ icon:'⚠️', text:`ADX ${adx} 趨勢弱化，震盪風險高`, delta:-0.4 }); }
  if      (volStr === '高' || volStr.includes('強')) { adj += 0.2; sigs.push({ icon:'✅', text:`成交量${volStr}，趨勢確認`, delta:+0.2 }); }
  else if (volStr === '低' || volStr.includes('弱')) { adj -= 0.3; sigs.push({ icon:'⚠️', text:`成交量${volStr}，動能不足`, delta:-0.3 }); }

  // ── 籌碼面 ──
  if (isLong) {
    if (whale.bias === 'bear' && (whale.bigSellCount || 0) >= 2) {
      adj -= 0.5; sigs.push({ icon:'🐳', text:`巨鯨持續出貨（${whale.bigSellCount}筆大賣），多頭逆風`, delta:-0.5 });
    } else if (whale.bias === 'bull' && (whale.bigBuyCount || 0) >= 2) {
      adj += 0.3; sigs.push({ icon:'🐳', text:`巨鯨持續吸籌（${whale.bigBuyCount}筆大買），多頭支撐`, delta:+0.3 });
    }
    if      (tkr < 0.80) { adj -= 0.4; sigs.push({ icon:'📊', text:`主動賣盤主導（Taker ${tkr.toFixed(2)}），空方施壓`, delta:-0.4 }); }
    else if (tkr > 1.20) { adj += 0.3; sigs.push({ icon:'📊', text:`主動買盤主導（Taker ${tkr.toFixed(2)}），多方強勢`, delta:+0.3 }); }
  } else {
    if (whale.bias === 'bull' && (whale.bigBuyCount || 0) >= 2) {
      adj -= 0.5; sigs.push({ icon:'🐳', text:`巨鯨持續吸籌（${whale.bigBuyCount}筆大買），空頭逆風`, delta:-0.5 });
    } else if (whale.bias === 'bear' && (whale.bigSellCount || 0) >= 2) {
      adj += 0.3; sigs.push({ icon:'🐳', text:`巨鯨持續出貨（${whale.bigSellCount}筆大賣），空頭支撐`, delta:+0.3 });
    }
    if      (tkr > 1.20) { adj -= 0.4; sigs.push({ icon:'📊', text:`主動買盤主導（Taker ${tkr.toFixed(2)}），多方反壓空頭`, delta:-0.4 }); }
    else if (tkr < 0.80) { adj += 0.3; sigs.push({ icon:'📊', text:`主動賣盤主導（Taker ${tkr.toFixed(2)}），空方強勢`, delta:+0.3 }); }
  }

  // ── 足跡圖 Delta（移動止損參考）──
  const _fpTSA = _footprintCache[coin.symbol];
  if (_fpTSA) {
    const _fpTSMatch = isLong ? (_fpTSA.deltaDir === 'bull') : (_fpTSA.deltaDir === 'bear');
    const _fpTSOpp   = isLong ? (_fpTSA.deltaDir === 'bear') : (_fpTSA.deltaDir === 'bull');
    if (_fpTSA.deltaDiv) {
      adj -= 0.4; sigs.push({ icon:'⚡', text:`足跡圖 Delta 背離，趨勢動能警告`, delta:-0.4 });
    } else if (_fpTSMatch) {
      adj += 0.3; sigs.push({ icon:'📊', text:`足跡圖 Delta 同向確認（${isLong ? '買盤' : '賣盤'}主導）`, delta:+0.3 });
    } else if (_fpTSOpp) {
      adj -= 0.3; sigs.push({ icon:'📊', text:`足跡圖 Delta 逆向（${isLong ? '賣盤' : '買盤'}主導），動能轉弱`, delta:-0.3 });
    }
    if (_fpTSA.absorption && isLong) {
      adj += 0.2; sigs.push({ icon:'🔄', text:`足跡圖買方吸收信號，持倉支撐有效`, delta:+0.2 });
    }
  }

  // ── 多時間框架 ──
  const h4ok = isLong ? (coin.h4Signal||'').includes('bull') : (coin.h4Signal||'').includes('bear');
  const d1ok = isLong ? (coin.dailySignal||'').includes('bull') : (coin.dailySignal||'').includes('bear');
  const wkOk = isLong ? (coin.weeklySignal||'').includes('bull') : (coin.weeklySignal||'').includes('bear');
  const tfN  = (h4ok?1:0) + (d1ok?1:0) + (wkOk?1:0);
  if      (tfN >= 3) { adj += 0.4; sigs.push({ icon:'✅', text:`4H+日線+週線三框同向，趨勢強勁`, delta:+0.4 }); }
  else if (tfN === 2) { adj += 0.2; sigs.push({ icon:'✅', text:`雙時框同向，趨勢有效`, delta:+0.2 }); }
  else if (tfN === 0) { adj -= 0.4; sigs.push({ icon:'⚠️', text:`多時框均已轉向，趨勢衰竭警示`, delta:-0.4 }); }

  // ── 宏觀基本面 ──
  if (_macroCache) {
    try {
      const fgV  = _macroCache.fg ? parseInt(_macroCache.fg.value || '50') : 50;
      const chgV = _macroCache.marketCapChange || 0;
      const domV = _macroCache.btcDominance   || 50;
      if (isLong) {
        if (fgV > 65 && chgV > 1) {
          adj += 0.3; sigs.push({ icon:'🌐', text:`宏觀偏多（F&G ${fgV}，市值 +${chgV.toFixed(1)}%）`, delta:+0.3 });
        } else if (fgV < 35 || chgV < -2) {
          adj -= 0.3; sigs.push({ icon:'🌐', text:`宏觀偏空（F&G ${fgV}，市值 ${chgV.toFixed(1)}%），多頭逆風`, delta:-0.3 });
        }
        if      (domV < 44) { adj += 0.2; sigs.push({ icon:'🌐', text:`BTC主導率 ${domV.toFixed(1)}%，山寨幣資金活躍`, delta:+0.2 }); }
        else if (domV > 57) { adj -= 0.2; sigs.push({ icon:'🌐', text:`BTC主導率 ${domV.toFixed(1)}%，資金集中BTC`, delta:-0.2 }); }
      } else {
        if (fgV < 35 && chgV < -1) {
          adj += 0.3; sigs.push({ icon:'🌐', text:`宏觀偏空（F&G ${fgV}，市值 ${chgV.toFixed(1)}%）`, delta:+0.3 });
        } else if (fgV > 65 || chgV > 2) {
          adj -= 0.3; sigs.push({ icon:'🌐', text:`宏觀偏多（F&G ${fgV}），空頭逆風`, delta:-0.3 });
        }
      }
    } catch(_e) {}
  }

  // ── 足跡圖訊號 ──
  const fp = _footprintCache[coin.symbol] || null;
  if (fp) {
    try {
      // Delta 背離：趨勢方向與 Delta 方向相反 → 動能可疑，縮短緩衝
      if (fp.deltaDiv) {
        adj -= 0.5;
        sigs.push({ icon:'📊', text:`足跡 Delta 背離（價格${fp.priceDir === 'bull' ? '上漲' : '下跌'}但Delta ${fp.deltaDir === 'bull' ? '偏多' : '偏空'}），趨勢動能存疑`, delta:-0.5 });
      }
      // Delta 同向：趨勢與 Delta 一致 → 趨勢可信
      else if (fp.deltaDir !== 'neutral' && fp.priceDir !== 'neutral') {
        const ok = (isLong && fp.deltaDir === 'bull') || (!isLong && fp.deltaDir === 'bear');
        if (ok) { adj += 0.3; sigs.push({ icon:'📊', text:`足跡 Delta 同向（${fp.deltaDir === 'bull' ? '買盤' : '賣盤'}主導），趨勢動能充足`, delta:+0.3 }); }
        else    { adj -= 0.3; sigs.push({ icon:'📊', text:`足跡 Delta 反向（${fp.deltaDir === 'bull' ? '買盤' : '賣盤'}主導），逆勢操作需謹慎`, delta:-0.3 }); }
      }
      // POC 距現價過近 → 強力支撐/阻力，不需要大緩衝
      const pocDist = Math.abs(cur - fp.poc) / atr;
      if (pocDist < 1.5) {
        adj -= 0.3;
        sigs.push({ icon:'📌', text:`POC $${parseFloat(fp.poc).toPrecision(4)} 緊貼現價（${pocDist.toFixed(1)} ATR），成交密集阻力`, delta:-0.3 });
      } else if (pocDist < 3.5) {
        const pocBelowLong  = isLong  && fp.poc < cur;
        const pocAboveShort = !isLong && fp.poc > cur;
        if (pocBelowLong || pocAboveShort) {
          adj += 0.2; sigs.push({ icon:'📌', text:`POC $${parseFloat(fp.poc).toPrecision(4)} 在有利方向（${pocDist.toFixed(1)} ATR），支撐穩固`, delta:+0.2 });
        }
      }
      // 近期吸籌：賣壓被承接，多頭強支撐 → 可寬放止損
      if (fp.absorption && isLong) {
        adj += 0.3; sigs.push({ icon:'🔵', text:`足跡偵測到吸籌訊號（賣盤被買盤吸收），多頭支撐強`, delta:+0.3 });
      }
    } catch(_e) {}
  }

  // ── ICT 關鍵結構（OB / FVG）──
  let keyLevel = null, keyLevelText = '';
  try {
    const ict = _tradeSetupCache[coin.symbol] || {};
    if (ict.orderBlock?.priceInOB) {
      const obLvl = isLong ? ict.orderBlock.low : ict.orderBlock.high;
      if (obLvl != null) {
        const dist = Math.abs(cur - obLvl) / atr;
        if (dist < 5) { keyLevel = obLvl; keyLevelText = `訂單塊（OB）$${parseFloat(obLvl).toPrecision(5).replace(/\.?0+$/,'')}，距現價 ${dist.toFixed(1)} ATR`; }
      }
    }
    if (!keyLevel && ict.fvg && !ict.fvg.filled && ict.fvg.mid) {
      const dist = Math.abs(cur - ict.fvg.mid) / atr;
      if (dist < 6) { keyLevel = ict.fvg.mid; keyLevelText = `FVG 缺口 $${parseFloat(ict.fvg.mid).toPrecision(5).replace(/\.?0+$/,'')}，距現價 ${dist.toFixed(1)} ATR`; }
    }
  } catch(_e) {}

  const baseMult  = currentPnlR >= 5.0 ? 2.0 : currentPnlR >= 3.5 ? 2.5 : 3.0;
  const finalMult = parseFloat(Math.max(1.5, Math.min(4.5, baseMult + adj)).toFixed(1));

  // 只保留影響最大的前 6 條信號（避免訊息過長）
  const topSigs = [...sigs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6);
  return { baseMult, finalMult, adj: adj.toFixed(1), signals: topSigs, keyLevel, keyLevelText };
}

function checkPostDataReversal(data) {
  const tlog = loadTradeLog();
  const openTrades = tlog.filter(t => t.status === 'open');
  if (!openTrades.length) return;
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;

  const alertKey  = 'csp_sl_adjust_alert';
  const sentAlerts = JSON.parse(localStorage.getItem(alertKey) || '{}');
  const now = Date.now();

  for (const trade of openTrades) {
    const coin = data.find(d => d.symbol === trade.symbol);
    if (!coin) continue;
    const cur   = parseFloat(coin.price) || 0;
    const entry = trade.entry || 0;
    const sl    = trade.sl;
    if (!cur || !entry || !sl) continue;
    const isLong = trade.direction === 'long';

    // ATR 估算（依 ADX 水平推算波動率）
    const adx = parseFloat(coin.adx) || 20;
    const atr = cur * (adx > 35 ? 0.018 : adx > 25 ? 0.013 : 0.009);
    const risk = Math.abs(entry - sl) || atr;

    // 浮動盈虧（R）
    const currentPnlR = isLong ? (cur - entry) / risk : (entry - cur) / risk;

    let suggestNewSl = null;
    let alertType    = '';
    let alertTitle   = '';
    let alertDetail  = '';

    // Case 1: TP1 已觸及 + SL 尚未移至成本價 → 建議保本止損
    if (trade.tp1Hit && ((isLong && sl < entry * 0.9995) || (!isLong && sl > entry * 1.0005))) {
      suggestNewSl = entry;
      alertType  = 'be';
      alertTitle = '🎯 AI 偵測：TP1已觸及，建議移止損至成本價';
      alertDetail = `TP1 已觸及，浮盈 ${currentPnlR.toFixed(2)} R。移動止損至進場成本可確保此筆交易不虧損。`;
    }
    // Case 2: 盈利超過 2R → AI 全面分析後建議追蹤止損
    else if (currentPnlR >= 2.0) {
      const _ai    = analyzeTrailingStopAI(coin, isLong, cur, atr, currentPnlR, entry, risk);
      const minFloor = isLong ? entry + risk * 0.5 : entry - risk * 0.5;
      suggestNewSl = isLong
        ? Math.max(minFloor, cur - atr * _ai.finalMult)
        : Math.min(minFloor, cur + atr * _ai.finalMult);
      const slImprovement = isLong ? suggestNewSl - sl : sl - suggestNewSl;
      if (slImprovement < atr) { suggestNewSl = null; }
      else {
        alertType  = 'trail';
        alertTitle = `🚀 AI 偵測：盈利 ${currentPnlR.toFixed(1)}R，建議追蹤止損`;
        alertDetail = _ai;  // 傳遞分析物件，供後面組訊息用
      }
    }

    if (!suggestNewSl) continue;

    // 同一止損位不重複通報（以四捨五入到 0.01 的止損價為 key）
    const _slKey = Math.round(suggestNewSl * 100);
    const alertId = `${trade.id}_${alertType}_${_slKey}`;
    if (sentAlerts[alertId]) continue;
    sentAlerts[alertId] = true;
    localStorage.setItem(alertKey, JSON.stringify(sentAlerts));

    const _slPxSym = (trade.symbol || '').replace('/', '').toUpperCase();
    const _slPx = v => { try { return toPionex(_slPxSym, cur || 1, v); } catch(e) { return v.toFixed(4); } };
    const fmt     = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
    const dir     = isLong ? '▲ 多' : '▼ 空';
    const pnlSign = currentPnlR >= 0 ? '+' : '';
    const slMove  = isLong
      ? (suggestNewSl > sl ? `⬆ 上移 ${fmt(_slPx(sl))} → ${fmt(_slPx(suggestNewSl))}` : `${fmt(_slPx(sl))} → ${fmt(_slPx(suggestNewSl))}`)
      : (suggestNewSl < sl ? `⬇ 下移 ${fmt(_slPx(sl))} → ${fmt(_slPx(suggestNewSl))}` : `${fmt(_slPx(sl))} → ${fmt(_slPx(suggestNewSl))}`);

    const _atrFmt = (atr * 100 / cur).toFixed(2);

    // ── 組合 Telegram 訊息 ──
    let analysisBlock = '';
    if (alertType === 'trail' && alertDetail && typeof alertDetail === 'object') {
      const _ai = alertDetail;
      const sigLines = _ai.signals.map(s =>
        `   ${s.icon} ${s.text}  ${s.delta > 0 ? '+' : ''}${s.delta.toFixed(1)}`
      ).join('\n');
      const adjSign = parseFloat(_ai.adj) >= 0 ? '+' : '';
      analysisBlock =
        `🔍 <b>AI 止損位分析</b>（技術 ＋ 籌碼 ＋ 基本面）\n` +
        `${sigLines || '   • 無顯著信號'}\n` +
        `   🧮 基礎 ${_ai.baseMult} ATR ${adjSign}${_ai.adj} → <b>${_ai.finalMult} ATR 緩衝</b>\n` +
        (_ai.keyLevelText ? `   📌 關鍵結構：${_ai.keyLevelText}\n` : '') +
        `\n`;
      alertDetail = `盈利 ${currentPnlR.toFixed(2)} R｜${_ai.finalMult} ATR 緩衝區，保留空間讓行情發展`;
    }

    const msg =
      `${alertTitle}\n\n` +
      `💎 <b>${trade.symbol}</b> ${dir}\n\n` +
      `📍 進場：$${fmt(_slPx(entry))}\n` +
      `🛑 <b>建議止損調整</b>\n` +
      `   ${slMove}\n` +
      `   新止損：<b>$${fmt(_slPx(suggestNewSl))}</b>\n\n` +
      `💰 現價：$${fmt(_slPx(cur))}\n` +
      `📊 浮動盈虧：<b>${pnlSign}${currentPnlR.toFixed(2)} R</b>\n` +
      `📉 ATR 波動率：${_atrFmt}%\n\n` +
      `${analysisBlock}` +
      `🔗 <a href="${window.location.origin + window.location.pathname}">查看 ${trade.symbol.replace('/USDT','')} 詳細分析 →</a>`;
    sendTelegramMessage(s.tgToken, s.tgChatId, msg);
  }
}

/* ── AI 學習系統 ─────────────────────────────────────────────── */
let _learnCache = null;
function invalidateLearnCache() { _learnCache = null; }

/* ── AI 持久記憶（localStorage）─────────────────────────────── */
const AI_MEMORY_KEY = 'csp_ai_memory';

function loadAIMemory() {
  try {
    const raw = localStorage.getItem(AI_MEMORY_KEY);
    return raw ? JSON.parse(raw) : { version: 1, rules: {}, issues: {}, bestConditions: [], cumStats: { totalClosed: 0, totalWins: 0, totalLosses: 0 } };
  } catch { return { version: 1, rules: {}, issues: {}, bestConditions: [], cumStats: { totalClosed: 0, totalWins: 0, totalLosses: 0 } }; }
}

function saveAIMemory(mem) {
  mem.updatedAt = Date.now();
  localStorage.setItem(AI_MEMORY_KEY, JSON.stringify(mem));
}

function mergeRulesIntoMemory(freshRules, freshIssues, freshBest, freshStats) {
  const mem = loadAIMemory();
  const now = Date.now();

  // ── 標記所有舊規則為未激活，然後重新激活有數據的規則 ──
  for (const k of Object.keys(mem.rules)) {
    if (!mem.rules[k].imported) mem.rules[k].active = false;
  }

  for (const rule of freshRules) {
    const existing = mem.rules[rule.condition];
    if (existing) {
      // 若匯入規則的樣本數更多，保留匯入的統計數據
      const keepImportedStats = existing.imported && (existing.total || 0) > (rule.total || 0);
      mem.rules[rule.condition] = {
        ...rule, active: true,
        firstDetected: existing.firstDetected,
        lastUpdated: now,
        occurrences: (existing.occurrences || 1) + 1,
        ...(keepImportedStats ? { total: existing.total, rate: existing.rate, imported: true } : {}),
      };
    } else {
      mem.rules[rule.condition] = {
        ...rule, active: true,
        firstDetected: now, lastUpdated: now, occurrences: 1,
      };
    }
  }

  // ── 累積個別問題統計（永遠只增不減）──
  for (const { text, suggestion, count } of freshIssues) {
    if (!mem.issues[text]) {
      mem.issues[text] = { text, suggestion, count: 0, firstDetected: now, lastSeen: now };
    }
    // 只在新一輪分析中出現才增加計數（避免重複累加）
    const prev = mem.issues[text].countAtLastUpdate || 0;
    if (count > prev) {
      mem.issues[text].count += (count - prev);
    }
    mem.issues[text].countAtLastUpdate = count;
    mem.issues[text].lastSeen = now;
  }

  // ── 更新最佳條件與累積統計 ──
  if (freshBest.length) mem.bestConditions = freshBest.map(b => ({ ...b, updatedAt: now }));
  if (freshStats.closed > (mem.cumStats.totalClosed || 0)) {
    mem.cumStats = {
      totalClosed:  freshStats.closed,
      totalWins:    freshStats.wins,
      totalLosses:  freshStats.losses,
    };
  }

  saveAIMemory(mem);
  return mem;
}

/* ── 每月自動清理交易記錄（保留 AI 記憶）────────────────────── */
function archiveExpiredToMemory(trades) {
  if (!trades.length) return;
  const mem = loadAIMemory();
  const now = Date.now();

  // ── 已歸檔 ID 集合，防止同一筆交易重複計入統計 ──
  if (!mem.archivedIds) mem.archivedIds = [];
  const archivedSet = new Set(mem.archivedIds);
  const newTrades = trades.filter(t => t.id && !archivedSet.has(t.id));
  if (!newTrades.length) return; // 全部已歸檔，避免重複

  const lossT = newTrades.filter(t => t.outcome === 'sl' || t.outcome === 'be');
  const winT  = newTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');

  // ── 累計止損問題統計（每筆只計一次）──
  const issueMap = {};
  lossT.forEach(t => {
    if (!t.analysis) t.analysis = generateTradeAnalysis(t);
    (t.analysis.issues || []).forEach((iss, i) => {
      if (!issueMap[iss]) issueMap[iss] = { text: iss, suggestion: (t.analysis.suggestions || [])[i] || '', count: 0 };
      issueMap[iss].count++;
    });
  });
  for (const [text, d] of Object.entries(issueMap)) {
    if (!mem.issues[text]) mem.issues[text] = { text, suggestion: d.suggestion, count: 0, firstDetected: now, lastSeen: now };
    mem.issues[text].count += d.count;
    mem.issues[text].lastSeen = now;
  }

  // ── 累積統計（永遠只增不減）──
  mem.cumStats.totalClosed  = (mem.cumStats.totalClosed  || 0) + newTrades.length;
  mem.cumStats.totalWins    = (mem.cumStats.totalWins    || 0) + winT.length;
  mem.cumStats.totalLosses  = (mem.cumStats.totalLosses  || 0) + lossT.length;

  // ── 記錄已歸檔 ID（最多保留最新 2000 個，防止無限增長）──
  const allArchived = [...archivedSet, ...newTrades.map(t => t.id)];
  mem.archivedIds = allArchived.slice(-2000);

  saveAIMemory(mem);
}

function monthlyTradePrune() {
  const tlog = loadTradeLog();
  const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const keep = [], expired = [];
  for (const t of tlog) {
    if (t.status === 'open') { keep.push(t); continue; }
    (now - (t.exitTime || t.timestamp || 0)) < ONE_MONTH ? keep.push(t) : expired.push(t);
  }
  if (!expired.length) return;
  archiveExpiredToMemory(expired); // 歸檔後才刪除
  saveTradeLog(keep);
  invalidateLearnCache();
  console.log(`[AI] 已歸檔 ${expired.length} 筆超過一個月的交易記錄到 AI 記憶`);
}

function computeLearnProfile() {
  const closed = loadTradeLog().filter(t => t.status === 'closed');
  if (closed.length < 2) return { ready: false, closed: closed.length };

  const losses = closed.filter(t => t.outcome === 'sl' || t.outcome === 'be');
  const wins   = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');

  // ── 區間分析 helper ──
  const zoneStats = (arr, field, ranges) =>
    ranges.map(z => {
      const inZone    = arr.filter(t => (t[field] || 0) >= z.min && (t[field] || 0) < z.max);
      const lossZone  = inZone.filter(t => t.outcome === 'sl' || t.outcome === 'be');
      return { ...z, total: inZone.length, lossCount: lossZone.length,
        lossRate: inZone.length >= 2 ? lossZone.length / inZone.length : null };
    });

  const rsiZones = [
    { label: '< 30', min: 0,  max: 30  },
    { label: '30–45', min: 30, max: 45 },
    { label: '45–55', min: 45, max: 55 },
    { label: '55–65', min: 55, max: 65 },
    { label: '65–75', min: 65, max: 75 },
    { label: '> 75',  min: 75, max: 200},
  ];
  const adxZones = [
    { label: '< 15',  min: 0,  max: 15  },
    { label: '15–20', min: 15, max: 20  },
    { label: '20–30', min: 20, max: 30  },
    { label: '30–40', min: 30, max: 40  },
    { label: '> 40',  min: 40, max: 200 },
  ];
  const confZones = [
    { label: '60–65%', min: 60, max: 65 },
    { label: '65–70%', min: 65, max: 70 },
    { label: '70–80%', min: 70, max: 80 },
    { label: '> 80%',  min: 80, max: 100},
  ];

  const rsiStats  = zoneStats(closed, 'rsi', rsiZones);
  const adxStats  = zoneStats(closed, 'adx', adxZones);
  const confStats = zoneStats(closed, 'conf', confZones);

  // ── 方向性特定條件 ──
  const longClosed  = closed.filter(t => t.direction === 'long');
  const shortClosed = closed.filter(t => t.direction === 'short');
  const longLosses  = longClosed.filter(t => t.outcome === 'sl' || t.outcome === 'be');
  const shortLosses = shortClosed.filter(t => t.outcome === 'sl' || t.outcome === 'be');

  const check = (cond, subLoss, subAll, penaltyConf, warnTpl) => {
    if (subAll.length < 2) return null;
    const rate = subLoss.length / subAll.length;
    if (rate < 0.05) return null; // AI 目標勝率 95%+，止損率 > 5% 即觸發規則
    const scaledPenalty = rate >= 0.6 ? penaltyConf + 15 : rate >= 0.4 ? penaltyConf + 5 : penaltyConf;
    return { condition: cond, lossCount: subLoss.length, total: subAll.length,
      rate, penaltyConf: scaledPenalty, warning: warnTpl(Math.round(rate * 100)) };
  };

  const rules = [
    check('long_high_rsi',
      longLosses.filter(t => (t.rsi||50) > 65),
      longClosed.filter(t => (t.rsi||50) > 65),
      15, r => `RSI > 65 做多歷史止損率 ${r}%，建議留意動能過熱`),
    check('short_low_rsi',
      shortLosses.filter(t => (t.rsi||50) < 35),
      shortClosed.filter(t => (t.rsi||50) < 35),
      15, r => `RSI < 35 做空歷史止損率 ${r}%，建議留意超賣反彈`),
    check('low_adx',
      losses.filter(t => (t.adx||20) < 20),
      closed.filter(t => (t.adx||20) < 20),
      10, r => `ADX < 20 震盪市止損率 ${r}%，建議等趨勢確立再進`),
    check('long_high_score_rsi',
      longLosses.filter(t => (t.rsi||50) > 72),
      longClosed.filter(t => (t.rsi||50) > 72),
      20, r => `RSI > 72 超買做多止損率 ${r}%，建議等回調再入`),
    check('short_oversold',
      shortLosses.filter(t => (t.rsi||50) < 28),
      shortClosed.filter(t => (t.rsi||50) < 28),
      20, r => `RSI < 28 超賣做空止損率 ${r}%，建議等反彈後再追空`),
    // VP 位置規則
    check('long_below_poc',
      longLosses.filter(t => t.entryAbovePOC === false),
      longClosed.filter(t => t.entryAbovePOC === false && t.entryAbovePOC !== null),
      12, r => `POC 下方做多止損率 ${r}%，建議等突破籌碼密集區`),
    check('short_above_poc',
      shortLosses.filter(t => t.entryAbovePOC === true),
      shortClosed.filter(t => t.entryAbovePOC === true && t.entryAbovePOC !== null),
      12, r => `POC 上方做空止損率 ${r}%，建議等跌破籌碼密集區`),
    // 巨鯨方向規則
    check('whale_against_long',
      longLosses.filter(t => t.entryWhaleBias === 'bear'),
      longClosed.filter(t => t.entryWhaleBias === 'bear'),
      15, r => `巨鯨偏空時做多止損率 ${r}%，建議順應主力方向`),
    check('whale_against_short',
      shortLosses.filter(t => t.entryWhaleBias === 'bull'),
      shortClosed.filter(t => t.entryWhaleBias === 'bull'),
      15, r => `巨鯨偏多時做空止損率 ${r}%，建議順應主力方向`),
    // 成交量規則
    check('bearish_div_long',
      longLosses.filter(t => t.entryVolDivergence === 'bearish_div'),
      longClosed.filter(t => t.entryVolDivergence === 'bearish_div'),
      15, r => `看跌背離做多止損率 ${r}%，建議量價背離時謹慎追多`),
    // 多週期共振
    check('low_mtf_align',
      losses.filter(t => (t.entryMTFAlign || 0) <= 1),
      closed.filter(t => t.entryMTFAlign != null && t.entryMTFAlign <= 1),
      10, r => `僅1個週期對齊入場止損率 ${r}%，建議等多週期共振`),
    check('low_conf_entry',
      losses.filter(t => (t.conf || 0) >= 60 && (t.conf || 0) < 68),
      closed.filter(t => (t.conf || 0) >= 60 && (t.conf || 0) < 68),
      12, r => `信心 60-68% 勉強進場止損率 ${r}%，建議等信心 ≥ 68% 再進`),
    // MACD 方向規則（基於實際交易記錄學習）
    check('macd_against_long',
      longLosses.filter(t => (t.entryMacdHist || 0) < 0),
      longClosed.filter(t => t.entryMacdHist != null && t.entryMacdHist < 0),
      12, r => `MACD 負值做多止損率 ${r}%，建議等 MACD 柱狀轉正再進場`),
    check('macd_against_short',
      shortLosses.filter(t => (t.entryMacdHist || 0) > 0),
      shortClosed.filter(t => t.entryMacdHist != null && t.entryMacdHist > 0),
      12, r => `MACD 正值做空止損率 ${r}%，建議等 MACD 柱狀轉負再進場`),
    // 成交量弱進場規則
    check('low_vol_long',
      longLosses.filter(t => t.entryVolStrength === '低' || String(t.entryVolStrength||'').includes('弱')),
      longClosed.filter(t => t.entryVolStrength === '低' || String(t.entryVolStrength||'').includes('弱')),
      10, r => `低量做多止損率 ${r}%，建議等放量確認再進場`),
    check('low_vol_short',
      shortLosses.filter(t => t.entryVolStrength === '低' || String(t.entryVolStrength||'').includes('弱')),
      shortClosed.filter(t => t.entryVolStrength === '低' || String(t.entryVolStrength||'').includes('弱')),
      10, r => `低量做空止損率 ${r}%，建議等放量確認再進場`),
    // 4H 方向規則
    check('h4_against_long',
      longLosses.filter(t => t.entryH4Aligned === false),
      longClosed.filter(t => t.entryH4Aligned != null && t.entryH4Aligned === false),
      15, r => `4H逆向做多止損率 ${r}%，建議等4H方向確認`),
    check('h4_against_short',
      shortLosses.filter(t => t.entryH4Aligned === false),
      shortClosed.filter(t => t.entryH4Aligned != null && t.entryH4Aligned === false),
      15, r => `4H逆向做空止損率 ${r}%，建議等4H方向確認`),
    // 訊號強度規則
    check('weak_score_long',
      longLosses.filter(t => (t.entryScoreStrength || '') === 'weak'),
      longClosed.filter(t => t.entryScoreStrength === 'weak'),
      12, r => `弱評分（51-64分）做多止損率 ${r}%，建議等評分更強再進場`),
    check('weak_score_short',
      shortLosses.filter(t => (t.entryScoreStrength || '') === 'weak'),
      shortClosed.filter(t => t.entryScoreStrength === 'weak'),
      12, r => `弱評分做空止損率 ${r}%，建議等評分更強再進場`),
    // 時段分析
    check('asia_session_loss',
      losses.filter(t => t.entryKillZone === 'asia'),
      closed.filter(t => t.entryKillZone === 'asia'),
      8, r => `亞洲時段進場止損率 ${r}%，流動性低需謹慎`),
  ].filter(Boolean);

  // ── 最佳進場條件（從盈利交易學習）──
  const bestConditions = [];
  if (wins.length >= 3) {
    const avgWinRsi = wins.reduce((s,t) => s+(t.rsi||50), 0) / wins.length;
    const avgWinAdx = wins.reduce((s,t) => s+(t.adx||20), 0) / wins.length;
    const avgLossRsi = losses.length ? losses.reduce((s,t) => s+(t.rsi||50), 0) / losses.length : null;
    const avgLossAdx = losses.length ? losses.reduce((s,t) => s+(t.adx||20), 0) / losses.length : null;
    bestConditions.push({ label: '最佳 RSI 區間', value: `${Math.round(avgWinRsi)}（盈利平均）${avgLossRsi ? '，止損平均 ' + Math.round(avgLossRsi) : ''}` });
    bestConditions.push({ label: '最佳 ADX 強度', value: `${Math.round(avgWinAdx)}（盈利平均）${avgLossAdx ? '，止損平均 ' + Math.round(avgLossAdx) : ''}` });
    // 分析巨鯨對齊時的勝率
    const whaleAlignedWins   = wins.filter(t => (t.direction === 'long' && t.entryWhaleBias === 'bull') || (t.direction === 'short' && t.entryWhaleBias === 'bear'));
    const whaleAlignedClosed = closed.filter(t => (t.direction === 'long' && t.entryWhaleBias === 'bull') || (t.direction === 'short' && t.entryWhaleBias === 'bear'));
    if (whaleAlignedClosed.length >= 3) {
      const wr = (whaleAlignedWins.length / whaleAlignedClosed.length * 100).toFixed(0);
      bestConditions.push({ label: '巨鯨順向勝率', value: `${wr}%（${whaleAlignedWins.length}/${whaleAlignedClosed.length} 筆）` });
    }
    const breakoutWins   = wins.filter(t => t.entryVolBreakout);
    const breakoutClosed = closed.filter(t => t.entryVolBreakout);
    if (breakoutClosed.length >= 3) {
      const wr = (breakoutWins.length / breakoutClosed.length * 100).toFixed(0);
      bestConditions.push({ label: '放量突破勝率', value: `${wr}%（${breakoutWins.length}/${breakoutClosed.length} 筆）` });
    }
    const mtfAlignWins   = wins.filter(t => (t.entryMTFAlign || 0) >= 3);
    const mtfAlignClosed = closed.filter(t => (t.entryMTFAlign || 0) >= 3);
    if (mtfAlignClosed.length >= 3) {
      const wr = (mtfAlignWins.length / mtfAlignClosed.length * 100).toFixed(0);
      bestConditions.push({ label: '三週期共振勝率', value: `${wr}%（${mtfAlignWins.length}/${mtfAlignClosed.length} 筆）` });
    }
  }

  // ── 收集個別問題統計（用於傳給記憶層）──
  const freshIssues = [];
  if (losses.length > 0) {
    const issueMap = {};
    losses.forEach(t => {
      if (!t.analysis) return;
      t.analysis.issues.forEach((iss, i) => {
        if (!issueMap[iss]) issueMap[iss] = { text: iss, suggestion: t.analysis.suggestions[i] || '', count: 0 };
        issueMap[iss].count++;
      });
    });
    freshIssues.push(...Object.values(issueMap));
  }

  // ── 合併到持久記憶 ──
  const mem = mergeRulesIntoMemory(
    rules, freshIssues, bestConditions,
    { closed: closed.length, wins: wins.length, losses: losses.length }
  );

  return {
    ready: true, closed: closed.length,
    wins: wins.length, losses: losses.length,
    winRate: (wins.length / closed.length * 100).toFixed(1),
    rsiStats, adxStats, confStats,
    rules, bestConditions, mem,
  };
}

function getLearnProfile() {
  if (!_learnCache) {
    try {
      _learnCache = computeLearnProfile();
    } catch(e) {
      console.warn('[getLearnProfile] computeLearnProfile 失敗，使用空白 profile:', e);
      _learnCache = { ready: false, closed: 0, rules: [], winRate: 50, wins: 0, losses: 0, bestConditions: [] };
    }
    // 若現有交易不足，嘗試從記憶中載入規則作為後備
    if (_learnCache && !_learnCache.ready) {
      try {
        const mem = loadAIMemory();
        const memRules = Object.values(mem.rules || {}).filter(r => (r.active || r.imported || r.occurrences >= 2) && (r.total || 0) >= 3 && r.warning != null);
        if (memRules.length > 0) {
          _learnCache = { ..._learnCache, ready: true, fromMemory: true, rules: memRules, mem, bestConditions: mem.bestConditions || [] };
        }
      } catch(e) {}
    }
    // 無論有無即時交易，已匯入的記憶規則都要顯示（合併而非替代）
    if (_learnCache) {
      try {
        const mem = loadAIMemory();
        const importedRules = Object.values(mem.rules || {}).filter(r => r.imported && (r.total || 0) >= 3 && r.warning != null);
        if (importedRules.length > 0) {
          const existingConds = new Set((_learnCache.rules || []).map(r => r.condition));
          const newRules = importedRules.filter(r => !existingConds.has(r.condition));
          if (newRules.length > 0) {
            _learnCache = { ..._learnCache, rules: [...(_learnCache.rules || []), ...newRules] };
          }
        }
      } catch(e) {}
    }
  }
  return _learnCache || { ready: false, closed: 0, rules: [], winRate: 50, wins: 0, losses: 0, bestConditions: [] };
}

/* 逐條規則扣分表（共用：風控計算 applyLearnAdjustment + UI 顯示 buildAILearnPanel）
   同一組止損率門檻：≥50筆維持標準扣分，20-49筆稍低，3-19筆輕度扣分 */
function computeRulePenalty(total, rate) {
  const _t = total || 0, _r = rate || 0;
  if (_t >= 50) {
    if (_r >= 0.90) return 12;
    if (_r >= 0.80) return  8;
    if (_r >= 0.70) return  5;
    if (_r >= 0.60) return  3;
    if (_r >= 0.50) return  2;
    if (_r >= 0.30) return  1;
    return 0;
  }
  if (_t >= 20) {
    if (_r >= 0.90) return 10;
    if (_r >= 0.80) return  6;
    if (_r >= 0.70) return  4;
    if (_r >= 0.60) return  2;
    if (_r >= 0.50) return  1;
    return 0;
  }
  return Math.max(1, Math.min(6, Math.round(_r * 8)));
}

function applyLearnAdjustment(direction, rsi, adx, ctx = {}) {
  const profile = getLearnProfile();
  const _aiMem  = profile.mem || loadAIMemory();
  let penalty = 0;
  const warnings = [];
  const blockReasons = [];   // 硬封鎖原因
  const defenseChecks = [];  // 所有防線審查項目（供 UI 顯示）

  // ── 歷史止損率風控（總體，含歸檔記憶；滿 20 筆起生效）──
  const _cumStats   = _aiMem.cumStats || {};
  const _totClosed  = Math.max(profile.closed || 0, _cumStats.totalClosed || 0);
  const _totLosses  = Math.max(profile.losses || 0, _cumStats.totalLosses || 0);
  if (profile.ready && _totClosed >= 20) {
    const _slRate = _totLosses / _totClosed;
    const _slPct  = (_slRate * 100).toFixed(1);
    if (_totClosed >= 50 && _slRate >= 0.95) {
      // ≥50 筆 + 止損率 ≥ 95%：直接硬封鎖
      blockReasons.push(`🚫 歷史止損率 ${_slPct}%（${_totLosses}/${_totClosed} 筆），超過 95% 封鎖門檻，AI 風控攔截直到勝率改善`);
    } else {
      // 按止損率分級扣分（同一組門檻，≥50筆維持原扣分，20-49筆稍低）
      let _slPen = 0;
      if (_totClosed >= 50) {
        // ≥50筆：標準扣分（止損率30%起生效；加入風險評估扣分後稍微調低避免過度扣分）
        if (_slRate > 0.90)      _slPen = 24;
        else if (_slRate > 0.80) _slPen = 20;
        else if (_slRate > 0.70) _slPen = 14;
        else if (_slRate > 0.60) _slPen =  7;
        else if (_slRate > 0.50) _slPen =  3;
        else if (_slRate > 0.30) _slPen =  1;
      } else {
        // 20-49筆：同一組門檻，扣分稍低（樣本較少，參考性較弱）
        if (_slRate > 0.90)      _slPen = 17;
        else if (_slRate > 0.80) _slPen = 12;
        else if (_slRate > 0.70) _slPen =  8;
        else if (_slRate > 0.60) _slPen =  4;
        else if (_slRate > 0.50) _slPen =  2;
        else if (_slRate > 0.30) _slPen =  0;
      }
      if (_slPen > 0) {
        penalty += _slPen;
        defenseChecks.push({ type: 'slRate', label: `歷史止損率 ${_slPct}%（${_totClosed} 筆樣本）`, count: _totClosed, pass: false, penalty: _slPen });
      }
    }
  }

  // ── 防線比對 helper ──
  const addCheck = (type, label, count, fail, pen, block = false) => {
    const safeLabel = (label != null ? String(label) : '');  // 防止 undefined/null 導致 .slice() throw
    const safePen   = (typeof pen === 'number' && isFinite(pen)) ? pen : 0;  // 防止 undefined/NaN 導致 penalty = NaN
    if (fail) {
      penalty += safePen;
      if (type !== 'suggestion') warnings.push(safeLabel || String(label));
      else warnings.push(`💡 改進建議未滿足：「${safeLabel.slice(0, 40)}」（歷史止損 ${count} 次，扣 ${safePen} 分）`);
      if (block) blockReasons.push(`🚫 AI最終防線：「${safeLabel.slice(0, 45)}」累計 ${count} 次/筆，已列入永久風控攔截`);
    }
    // 只收錄有足夠數據或有觸發的項目（止損記憶需 5 次以上才顯示）
    if (fail || (type !== 'memory' && count >= 3) || (type === 'memory' && count >= 5)) {
      defenseChecks.push({ type, label: safeLabel.slice(0, 55), count, pass: !fail, penalty: fail ? safePen : 0 });
    }
  };

  // ① 結構化規則（歷史止損統計規則，含匯入 AI 記憶）
  // 合併 profile.rules（即時交易記錄）與 _aiMem.rules（含匯入規則），取樣本數較多者
  const _effectiveRules = [...(profile.rules || [])];
  for (const [_mCond, _mRule] of Object.entries(_aiMem.rules || {})) {
    if (!_mRule.imported) continue;
    const _ei = _effectiveRules.findIndex(r => r.condition === _mCond);
    if (_ei === -1) {
      _effectiveRules.push({ condition: _mCond, total: _mRule.total, rate: _mRule.rate, warning: _mRule.warning });
    } else if ((_mRule.total || 0) > (_effectiveRules[_ei].total || 0)) {
      _effectiveRules[_ei] = { ..._effectiveRules[_ei], total: _mRule.total, rate: _mRule.rate };
    }
  }
  if (profile.ready && _effectiveRules.length) {
    for (const rule of _effectiveRules) {
      const match =
        (rule.condition === 'long_high_rsi'       && direction === 'long'  && rsi > 65) ||
        (rule.condition === 'short_low_rsi'        && direction === 'short' && rsi < 35) ||
        // low_adx 由 hardAdxPenalty（buildTradeSetup/computeSimpleSetup）單獨處理，避免雙重扣分
        (rule.condition === 'low_adx'              && !ctx.skipAdxRule && adx < 20) ||
        (rule.condition === 'long_high_score_rsi'  && direction === 'long'  && rsi > 72) ||
        (rule.condition === 'short_oversold'       && direction === 'short' && rsi < 28) ||
        (rule.condition === 'long_below_poc'       && direction === 'long'  && ctx.abovePOC === false) ||
        (rule.condition === 'short_above_poc'      && direction === 'short' && ctx.abovePOC === true) ||
        (rule.condition === 'whale_against_long'   && direction === 'long'  && ctx.whaleBias === 'bear') ||
        (rule.condition === 'whale_against_short'  && direction === 'short' && ctx.whaleBias === 'bull') ||
        (rule.condition === 'bearish_div_long'     && direction === 'long'  && ctx.volDivergence === 'bearish_div') ||
        (rule.condition === 'low_mtf_align'        && (ctx.mtfAlign ?? 99) <= 1) ||
        (rule.condition === 'low_conf_entry' && (ctx.conf || 0) >= 60 && (ctx.conf || 0) < 68) ||
        (rule.condition === 'macd_against_long'  && direction === 'long'  && (parseFloat(ctx.macdHist) || 0) < 0) ||
        (rule.condition === 'macd_against_short' && direction === 'short' && (parseFloat(ctx.macdHist) || 0) > 0) ||
        (rule.condition === 'low_vol_long'    && direction === 'long'  && (ctx.volWeak === true)) ||
        (rule.condition === 'low_vol_short'   && direction === 'short' && (ctx.volWeak === true)) ||
        (rule.condition === 'h4_against_long'  && direction === 'long'  && ctx.h4Aligned === false) ||
        (rule.condition === 'h4_against_short' && direction === 'short' && ctx.h4Aligned === false) ||
        (rule.condition === 'weak_score_long'      && direction === 'long'  && ctx.scoreStrength === 'weak') ||
        (rule.condition === 'weak_score_short'     && direction === 'short' && ctx.scoreStrength === 'weak') ||
        (rule.condition === 'asia_session_loss'    && ctx.killZone === 'asia') ||
        (rule.condition === 'weekly_against_long'  && direction === 'long'  && ctx.weeklyAgainst === true) ||
        (rule.condition === 'weekly_against_short' && direction === 'short' && ctx.weeklyAgainst === true) ||
        (rule.condition === 'bb_against_long'      && direction === 'long'  && ctx.bbWalkingBear === true) ||
        (rule.condition === 'bb_against_short'     && direction === 'short' && ctx.bbWalkingBull === true) ||
        (rule.condition === 'no_h1_align_long'     && direction === 'long'  && ctx.h1Aligned === false) ||
        (rule.condition === 'no_h1_align_short'    && direction === 'short' && ctx.h1Aligned === false);
      const _rTotal = rule.total || 0;
      const _rRate  = rule.rate  || 0;
      if (_rTotal >= 3) {
        const _rLabel = (rule.warning || '').replace(/，AI 已下調信心/g, '').slice(0, 55);
        if (match) {
          if (_rTotal >= 50 && _rRate >= 0.95) {
            // 50筆以上且止損率≥95%：硬封鎖
            blockReasons.push(`🚫 AI規則封鎖：「${_rLabel}」歷史止損率 ${(_rRate * 100).toFixed(0)}%（${_rTotal} 筆），AI 風控攔截`);
            defenseChecks.push({ type: 'rule', label: _rLabel, count: _rTotal, pass: false, penalty: 0, rate: _rRate, blocked: true });
          } else {
            const _rPen = computeRulePenalty(_rTotal, _rRate);
            penalty += _rPen;
            defenseChecks.push({ type: 'rule', label: _rLabel, count: _rTotal, pass: false, penalty: _rPen, rate: _rRate });
          }
        } else {
          defenseChecks.push({ type: 'rule', label: _rLabel, count: _rTotal, pass: true, penalty: 0, rate: _rRate });
        }
      }
    }
  }

  // ② 止損原因記憶（次數過多才納入風控防線，閾值 10 次以上）
  const mem = _aiMem;
  if (mem.issues) {
    for (const issue of Object.values(mem.issues)) {
      const cnt = issue.count || 0;
      if (cnt < 5) continue; // 低於5次不列入風控
      const t = issue.text || '';
      const s = issue.suggestion || '';

      // ③ 改進建議：作為 AI 交易建議的參考資訊，不扣信心分
      if (cnt >= 5 && s) {
        const suggViolated =
          (s.includes('RSI') && (s.includes('50-55') || s.includes('50 以下') || s.includes('回落')) && direction === 'long'  && rsi > 60) ||
          (s.includes('RSI') && (s.includes('45-50') || s.includes('50 以上') || s.includes('回升')) && direction === 'short' && rsi < 40) ||
          (s.includes('ADX') && (s.includes('20') || s.includes('22')) && adx < 22) ||
          (s.includes('掃蕩') && s.includes('確認') && ctx.slType === 'po3') ||
          (s.includes('ATR') && (s.includes('倍數') || s.includes('更大')) && ctx.slType === 'atr') ||
          (s.includes('更低一層') && ctx.slType === 'structural') ||
          (s.includes('評分') && s.includes('65') && direction === 'long'  && (ctx.score || 100) < 65) ||
          (s.includes('評分') && s.includes('35') && direction === 'short' && (ctx.score || 0)   > 35) ||
          (s.includes('POC') && s.includes('突破') && direction === 'long'  && ctx.abovePOC === false) ||
          (s.includes('POC') && s.includes('跌破') && direction === 'short' && ctx.abovePOC === true) ||
          (s.includes('巨鯨') && direction === 'long'  && ctx.whaleBias === 'bear') ||
          (s.includes('巨鯨') && direction === 'short' && ctx.whaleBias === 'bull') ||
          (s.includes('主力') && direction === 'long'  && ctx.whaleBias === 'bear') ||
          (s.includes('主力') && direction === 'short' && ctx.whaleBias === 'bull') ||
          (s.includes('量能') && s.includes('確認') && ctx.volDivergence === 'bearish_div' && direction === 'long') ||
          (s.includes('多週期') && (ctx.mtfAlign ?? 99) <= 1) ||
          ((s.includes('週期') && s.includes('信號一致')) && (ctx.mtfAlign ?? 99) <= 1);
        if (cnt >= 100) {
          // 止損原因出現 ≥100 次：AI 判定改進方法為必須條件，違反直接扣信心分
          if (suggViolated) {
            const _sgPen = 10;
            penalty += _sgPen;
            warnings.push(`🔒 必須條件未滿足（歷史止損 ${cnt} 次教訓）：${s.slice(0, 50)}，扣 ${_sgPen} 分`);
            defenseChecks.push({ type: 'sugg_required', label: s.slice(0, 55), count: cnt, pass: false, penalty: _sgPen });
          } else {
            defenseChecks.push({ type: 'sugg_required', label: s.slice(0, 55), count: cnt, pass: true, penalty: 0 });
          }
        } else {
          // < 100 次：改進建議僅作為 AI 交易建議參考，不影響信心評分
          defenseChecks.push({ type: 'sugg_ref', label: s.slice(0, 55), count: cnt, pass: !suggViolated, penalty: 0 });
        }
      }
    }
  }

  const hardBlocked = blockReasons.length > 0;
  return { penalty, warnings, hardBlocked, blockReasons, defenseChecks };
}

/* ── 止損/保本交易學習分析 ────────────────────────────────────── */
function generateTradeAnalysis(trade) {
  const issues = [], suggestions = [];
  const isLong    = trade.direction === 'long';
  const slReason  = trade.slReason  || '';
  const entryReason = trade.entryReason || '';
  const outcome   = trade.outcome;

  // ── 止損原因分析（最直接的風控依據）──────────────────────────
  if (outcome === 'sl' || outcome === 'be') {
    // 結構性止損失守
    if (slReason.includes('支撐結構') || slReason.includes('壓力結構')) {
      const side = isLong ? '支撐結構' : '壓力結構';
      issues.push(`止損設於${side}，${side}失守代表市場結構轉弱，此類止損本身設置合理但結構已被打破`);
      suggestions.push(`${side}破位後應立即離場，不要等待反彈，下次可在${isLong ? '更低' : '更高'}一層結構設止損`);
    }
    // PO3 / 掃蕩型止損
    if (slReason.includes('PO3') || slReason.includes('掃蕩')) {
      issues.push('止損設於 PO3/掃蕩結構位，該位置被突破通常代表主力完成吸籌後反向洗盤，或信號本身為誘多/誘空');
      suggestions.push('PO3 結構失守後需重新評估主力意圖，下次等掃蕩確認方向後再進場，避免在掃蕩前入場');
    }
    // ATR / 百分比止損（只針對純 ATR 止損，排除已由結構/PO3 覆蓋的情形）
    if (!slReason.includes('PO3') && !slReason.includes('掃蕩') &&
        !slReason.includes('支撐結構') && !slReason.includes('壓力結構') &&
        (slReason.includes('ATR') || slReason.includes('結構止損') || slReason.includes('動能失效'))) {
      issues.push(`止損以 ATR/百分比設置，觸發代表市場波動超出預期範圍（進場時 ATR 或波動估算可能不足）`);
      suggestions.push('波動大時應使用更大的 ATR 倍數或調整倉位大小，避免被正常波動震出');
    }
    // 進場原因回顧（止損後的逆向分析）
    if (entryReason.includes('RSI') && (isLong ? trade.rsi > 65 : trade.rsi < 35)) {
      issues.push(`進場依據含 RSI ${trade.rsi}，${isLong ? '偏高進場' : '偏低進場'}後被止損，動能判斷失準`);
      suggestions.push(`${isLong ? 'RSI > 65' : 'RSI < 35'} 時順勢追入風險較高，建議在 RSI ${isLong ? '回落至 50-55' : '回升至 45-50'} 後等確認再入場`);
    }
    // 進場原因回顧（止損後的逆向分析：僅在有明確進場條件描述時才分析）
    if ((entryReason.includes('多頭信號') || entryReason.includes('空頭信號')) &&
        !entryReason.includes('15m/1h 多頭信號共振') && !entryReason.includes('15m/1h 空頭信號共振')) {
      issues.push(`進場依據為${isLong ? '多頭' : '空頭'}信號共振，止損觸發說明信號出現假突破或方向判斷錯誤`);
      suggestions.push('信號共振後需等待 K 棒收線確認，不要在信號剛出現時立即入場');
    }
  }

  // ── 技術指標問題 ────────────────────────────────────────────
  if (isLong) {
    if (trade.rsi > 60) {
      issues.push(`RSI 進場時 ${trade.rsi} 偏高，多頭追入有回調風險`);
      suggestions.push('下次等 RSI 回落至 50 以下再考慮多頭進場');
    }
    if (trade.adx < 20) {
      issues.push(`ADX ${trade.adx} 過低，趨勢不明確，震盪盤容易觸發止損`);
      suggestions.push('確保 ADX > 20 再進場，低 ADX 環境下縮小止損或不入場');
    }
    if (trade.score < 65) {
      issues.push(`評分 ${trade.score} 偏低，信號強度有限`);
      suggestions.push('多頭信號需評分 65 以上再操作');
    }
  } else {
    if (trade.rsi < 40) {
      issues.push(`RSI 進場時 ${trade.rsi} 偏低，空頭追入有反彈風險`);
      suggestions.push('下次等 RSI 回升至 50 以上再考慮空頭進場');
    }
    if (trade.adx < 20) {
      issues.push(`ADX ${trade.adx} 過低，趨勢不明確，震盪盤容易觸發止損`);
      suggestions.push('確保 ADX > 20 再進場，低 ADX 環境下縮小止損或不入場');
    }
    if (trade.score > 35) {
      issues.push(`評分 ${trade.score} 偏高，空頭信號強度有限`);
      suggestions.push('空頭信號需評分 35 以下再操作');
    }
  }

  // ── 籌碼 / 巨鯨 / 成交量 ────────────────────────────────────
  if (trade.entryAbovePOC === false && isLong) {
    issues.push('做多入場在籌碼密集區(POC)下方，上方賣壓較重');
    suggestions.push('做多時確保現價突破 POC 站穩，等待籌碼轉換後再進場');
  }
  if (trade.entryAbovePOC === true && !isLong) {
    issues.push('做空入場在籌碼密集區(POC)上方，下方承接較強');
    suggestions.push('做空時確保現價跌破 POC 且無強力承接，再考慮入場');
  }
  if (trade.entryWhaleBias === 'bear' && isLong) {
    issues.push('入場時巨鯨主力資金偏向賣出，與做多方向相反，止損被主力行為推動');
    suggestions.push('機構資金方向比技術信號更優先，巨鯨看空時避免做多');
  }
  if (trade.entryWhaleBias === 'bull' && !isLong) {
    issues.push('入場時巨鯨主力資金偏向買入，與做空方向相反，止損被主力行為推動');
    suggestions.push('機構資金方向比技術信號更優先，巨鯨看多時避免做空');
  }
  if (trade.entryVolDivergence === 'bearish_div' && isLong) {
    issues.push('入場時出現成交量看跌背離（量跌價漲），上漲動能不足，止損觸發印證背離有效');
    suggestions.push('量價背離時謹慎追多，等待量能重新放大再確認方向');
  }
  if ((trade.entryMTFAlign || 0) <= 1 && trade.entryMTFAlign != null) {
    issues.push(`僅 ${trade.entryMTFAlign} 個週期方向對齊，多空信號分歧較大，止損觸發可能來自高週期反壓`);
    suggestions.push('等待至少 2-3 個週期（15m、1h、4h）信號一致再入場');
  }

  // ── MACD 方向分析 ─────────────────────────────────────────────
  if (isLong && (trade.entryMacdHist || 0) < 0) {
    issues.push(`進場時 MACD 柱狀線為負值（${(trade.entryMacdHist||0).toFixed(5)}），多頭動能仍在下行中`);
    suggestions.push('MACD 柱狀線轉正才進多，逆向 MACD 進場止損率顯著偏高');
  }
  if (!isLong && (trade.entryMacdHist || 0) > 0) {
    issues.push(`進場時 MACD 柱狀線為正值，空頭動能仍在上行中`);
    suggestions.push('MACD 柱狀線轉負才進空，逆向 MACD 進場止損率顯著偏高');
  }

  // ── 4H 方向確認分析 ───────────────────────────────────────────
  if (trade.entryH4Aligned === false) {
    issues.push(`進場時 4H 信號與${isLong ? '做多' : '做空'}方向不一致，缺少中期趨勢確認`);
    suggestions.push('4H 信號必須同方向才進場，4H 逆向時止損率明顯偏高');
  }

  // ── Kill Zone 時段分析 ────────────────────────────────────────
  if (trade.entryKillZone === 'other') {
    issues.push('進場時間不在高品質 Kill Zone（非倫敦 UTC 7-11 / 紐約 UTC 13-17）');
    suggestions.push('選擇倫敦或紐約開盤時段進場，流動性充裕，假突破率低，勝率更高');
  }

  // ── BB 走軌分析 ───────────────────────────────────────────────
  if (isLong && trade.entryBBWalkingBear) {
    issues.push('進場時布林通道空頭走軌（連續貼近下軌），趨勢強勢向下，逆向做多');
    suggestions.push('BB 空頭走軌期間避免做多，等待走軌結束（價格回到中軌附近）後再評估多單');
  }
  if (!isLong && trade.entryBBWalkingBull) {
    issues.push('進場時布林通道多頭走軌（連續貼近上軌），趨勢強勢向上，逆向做空');
    suggestions.push('BB 多頭走軌期間避免做空，等待走軌結束後再評估空單');
  }

  // ── 週線信號分析 ──────────────────────────────────────────────
  if (isLong && trade.entryWeeklyAgainst) {
    issues.push('週線信號偏空，大週期趨勢仍在下行，做多方向逆大趨勢');
    suggestions.push('週線信號是最重要的過濾條件，週線偏空時多單止損率大幅偏高，需等週線轉向');
  }
  if (!isLong && trade.entryWeeklyAgainst) {
    issues.push('週線信號偏多，大週期趨勢仍在上行，做空方向逆大趨勢');
    suggestions.push('週線偏多時空單止損率大幅偏高，需等週線信號轉向後再做空');
  }

  // ── 訊號品質分析 ──────────────────────────────────────────────
  if (trade.sqGrade === 'C' || trade.sqGrade === 'D') {
    const _sqL = trade.sqGradeLabel || (trade.sqGrade === 'C' ? '一般訊號' : '訊號偏弱');
    issues.push(`進場訊號品質 ${trade.sqGrade} 級（${_sqL}，評分 ${trade.sqScore ?? '—'} 分），多時框確認不足`);
    suggestions.push('訊號品質需達 B 級以上（多時框對齊 ≥5/9 分）才進場，低品質訊號止損率明顯偏高');
  }

  // ── AI 學習規則違反確認（交叉比對歷史止損模式）────────────────
  const profile = getLearnProfile();
  if (profile.ready && profile.rules.length) {
    const rsi = trade.rsi || 50;
    const adx = trade.adx || 20;
    const violatedRules = profile.rules.filter(rule => {
      switch (rule.condition) {
        case 'long_high_rsi':       return isLong  && rsi > 65;
        case 'short_low_rsi':       return !isLong && rsi < 35;
        case 'low_adx':             return adx < 20;
        case 'long_high_score_rsi': return isLong  && rsi > 72;
        case 'short_oversold':      return !isLong && rsi < 28;
        case 'long_below_poc':      return isLong  && trade.entryAbovePOC === false;
        case 'short_above_poc':     return !isLong && trade.entryAbovePOC === true;
        case 'whale_against_long':  return isLong  && trade.entryWhaleBias === 'bear';
        case 'whale_against_short': return !isLong && trade.entryWhaleBias === 'bull';
        case 'bearish_div_long':    return isLong  && trade.entryVolDivergence === 'bearish_div';
        case 'low_mtf_align':       return (trade.entryMTFAlign ?? 99) <= 1;
        case 'macd_against_long':   return isLong  && (trade.entryMacdHist || 0) < 0;
        case 'macd_against_short':  return !isLong && (trade.entryMacdHist || 0) > 0;
        case 'h4_against_long':     return isLong  && trade.entryH4Aligned === false;
        case 'h4_against_short':    return !isLong && trade.entryH4Aligned === false;
        case 'weekly_against_long': return isLong  && trade.entryWeeklyAgainst === true;
        case 'weekly_against_short': return !isLong && trade.entryWeeklyAgainst === true;
        case 'bb_against_long':     return isLong  && trade.entryBBWalkingBear === true;
        case 'bb_against_short':    return !isLong && trade.entryBBWalkingBull === true;
        case 'no_h1_align_long':    return isLong  && trade.entryH1Aligned === false;
        case 'no_h1_align_short':   return !isLong && trade.entryH1Aligned === false;
        default: return false;
      }
    });
    violatedRules.forEach(rule => {
      issues.push(`❌ 違反AI學習規則：${rule.warning}（歷史止損率 ${Math.round(rule.rate*100)}%，${rule.total} 筆樣本）`);
      suggestions.push('此條件已被AI標記為高風險模式，下次入場前應確認此風險規則是否仍成立');
    });
  }

  if (issues.length === 0) {
    issues.push('技術指標條件尚可，止損可能受宏觀環境或突發事件影響');
    suggestions.push('建議同步確認宏觀市場環境與重大新聞後再入場');
  }
  return { issues, suggestions };
}

/* ── AI 學習面板渲染 ──────────────────────────────────────────── */
function buildAILearnPanel(closed) {
  const profile   = getLearnProfile();
  const mem       = profile.mem || loadAIMemory();
  const fmtDate   = ts => ts ? new Date(ts).toLocaleDateString('zh-TW', { month:'2-digit', day:'2-digit' }) : '';
  const isFromMem = !!profile.fromMemory;
  const cumClosed = Math.max(mem.cumStats?.totalClosed || 0, profile.closed || 0);
  const winRateNum = profile.fromMemory
    ? ((mem.cumStats.totalWins / (mem.cumStats.totalClosed || 1)) * 100)
    : parseFloat(profile.winRate || 0);
  const winRate = winRateNum.toFixed(1);
  const winRateColor = winRateNum >= 95 ? 'var(--bull)' : winRateNum >= 80 ? '#f59e0b' : 'var(--bear)';

  // ── 目前的風控規則（含記憶）──
  const rules = profile.rules || [];
  const rulesHtml = rules.length
    ? rules.map(r => {
        const fd = r.firstDetected ? `首次發現 ${fmtDate(r.firstDetected)}` : '';
        const occ = (r.occurrences || 0) > 1 ? `· 出現 ${r.occurrences} 次` : '';
        const memBadge = !r.active ? `<span class="ai-mem-badge">記憶</span>` : '';
        const _blocked = (r.total || 0) >= 50 && (r.rate || 0) >= 0.95;
        const _pen = computeRulePenalty(r.total, r.rate);
        const _penHtml = _blocked
          ? `<span style="color:var(--bear);font-weight:700">🚫 觸發封鎖</span>`
          : `<span style="color:#f59e0b">觸發扣 -${_pen} 分</span>`;
        return `<div class="ai-rule-item">
          <div class="ai-rule-cond">⚡ ${r.warning} ${memBadge}</div>
          <div class="ai-rule-stats">樣本 ${r.total} 筆 · 止損率 <strong style="color:var(--bear)">${Math.round(r.rate*100)}%</strong> · ${_penHtml}${fd ? ' · ' + fd : ''}${occ ? ' ' + occ : ''}</div>
        </div>`;
      }).join('')
    : `<div class="ai-learn-ok">✅ 目前無高風險模式，歷史條件均衡</div>`;

  // ── RSI / ADX 熱力圖（僅有實際數據時才渲染）──
  const makeZoneBar = stats => (stats || []).filter(z => z.total > 0).map(z => {
    const lr  = z.lossRate;
    const clr = lr === null ? 'var(--text3)' : lr > 0.05 ? (lr > 0.2 ? 'var(--bear)' : '#f59e0b') : 'var(--bull)';
    return `<div class="ai-zone-cell" style="border-color:${clr}20">
      <div class="ai-zone-label">${z.label}</div>
      <div class="ai-zone-rate" style="color:${clr}">${lr === null ? '—' : Math.round(lr*100)+'%'}</div>
      <div class="ai-zone-count">${z.total}筆</div>
    </div>`;
  }).join('');
  const rsiBar = makeZoneBar(profile.rsiStats);
  const adxBar = makeZoneBar(profile.adxStats);

  // ── 最佳進場條件 ──
  const bestHtml = (profile.bestConditions || []).map(b =>
    `<div class="ai-best-item"><span class="ai-best-lbl">${b.label}</span><span class="ai-best-val">${b.value}</span></div>`
  ).join('');

  // ── 累積問題記錄（永遠從記憶中讀，不因重置消失）──
  const memIssues = Object.values(mem.issues || {}).sort((a,b) => b.count - a.count).slice(0, 5);
  const issuesHtml = memIssues.length
    ? `<div class="ai-learn-section">
        <div class="ai-section-title">📋 過往止損原因記錄（永久保存，跨月累積）</div>
        ${memIssues.map(iss => {
          const _enforced = (iss.count || 0) >= 100 && iss.suggestion;
          return `
          <div class="ai-issue-row">
            <div class="ai-issue-txt">⚠️ ${iss.text}<span class="ai-issue-cnt">×${iss.count}</span>${_enforced ? `<span style="background:rgba(239,68,68,.15);color:#ef4444;border-radius:4px;padding:1px 6px;font-size:0.68rem;margin-left:6px">🔒 必須條件</span>` : ''}${iss.firstDetected ? `<span class="ai-mem-date">首次 ${fmtDate(iss.firstDetected)}</span>` : ''}</div>
            ${iss.suggestion ? `<div class="ai-sugg-txt">→ ${iss.suggestion}${_enforced ? '（已納入交易分析條件，違反扣 10 分）' : ''}</div>` : ''}
          </div>`; }).join('')}
      </div>`
    : `<div class="ai-learn-section">
        <div class="ai-section-title">📋 過往止損原因記錄（永久保存）</div>
        <div style="color:var(--text3);font-size:0.82rem;padding:6px 0">尚無止損記錄。每次止損後 AI 會自動分析原因並永久記憶。</div>
      </div>`;

  const notReadyNote = !profile.ready ? `<div class="ai-learn-section">
    <div style="color:var(--text3);font-size:0.82rem">
      目前交易記錄不足（${profile.closed || 0}/3 筆），部分分析數據尚無法計算。<br>
      <strong style="color:var(--accent)">AI 記憶中的止損經驗已持續套用至交易建議。</strong>
    </div>
  </div>` : '';

  return `<div class="ai-learn-card">
    <div class="ai-learn-header">
      🤖 AI 學習引擎${isFromMem ? ' <span class="ai-mem-badge">記憶模式</span>' : ''}
      <span class="ai-learn-sub">累積 ${cumClosed} 筆 · 勝率 <strong style="color:${winRateColor}">${winRate}%</strong>${mem.updatedAt ? ' · 更新 ' + fmtDate(mem.updatedAt) : ''}</span>
    </div>

    <div class="ai-goal-bar">
      <span class="ai-goal-lbl">🎯 AI 目標勝率</span>
      <div class="ai-goal-track">
        <div class="ai-goal-fill" style="width:${Math.min(winRateNum,100)}%;background:${winRateColor}"></div>
        <div class="ai-goal-mark95"></div>
      </div>
      <span class="ai-goal-pct" style="color:${winRateColor}">${winRate}%</span>
      <span class="ai-goal-target">目標 95%</span>
    </div>

    ${notReadyNote}

    <div class="ai-learn-section">
      <div class="ai-section-title">📋 AI 風控規則（觸發時自動扣減風控分）</div>
      ${rulesHtml}
    </div>

    ${bestHtml ? `<div class="ai-learn-section">
      <div class="ai-section-title">🏆 盈利交易最佳條件</div>
      ${bestHtml}
    </div>` : ''}

    ${rsiBar ? `<div class="ai-learn-section">
      <div class="ai-section-title">📊 RSI 止損率分佈（目標每區 &lt; 20%）</div>
      <div class="ai-zone-row">${rsiBar}</div>
    </div>` : ''}

    ${adxBar ? `<div class="ai-learn-section">
      <div class="ai-section-title">📊 ADX 止損率分佈</div>
      <div class="ai-zone-row">${adxBar}</div>
    </div>` : ''}

    ${issuesHtml}
  </div>`;
}

/* ── 持倉中頁面渲染 ───────────────────────────────────────────── */
let _posTab = 'all';

function setPosTab(tab) {
  _posTab = tab;
  document.querySelectorAll('.pos-tab-btn').forEach(b => b.classList.toggle('pos-tab-active', b.dataset.tab === tab));
  filterPositionCards(document.getElementById('pos-search-input')?.value || '');
  updatePosTabSummary();
  // 未進場分頁：顯示/隱藏（全部分頁同樣顯示等待進場區塊）
  const pendingContainer = document.getElementById('pos-pending-container');
  const pendingHdr       = document.getElementById('pos-pending-section-hdr');
  const mainList = document.getElementById('pos-list-container');
  const posSearch = document.getElementById('pos-search-input');
  // 讀取 pending 數量（從 data attribute 取得，不需重新查詢 tlog）
  const summaryEl = document.getElementById('pos-tab-summary');
  const pendingCnt = parseInt(summaryEl?.dataset?.pendingCount || '0');
  const showPendingTab = tab === 'pending';
  const showPendingInAll = tab === 'all' && pendingCnt > 0;
  if (pendingContainer) pendingContainer.style.display = (showPendingTab || showPendingInAll) ? '' : 'none';
  if (pendingHdr)       pendingHdr.style.display       = showPendingInAll ? '' : 'none';
  if (mainList)  mainList.style.display  = showPendingTab ? 'none' : '';
  if (posSearch) posSearch.style.display = showPendingTab ? 'none' : '';
}

function updatePosTabSummary() {
  const el = document.getElementById('pos-tab-summary');
  if (!el) return;
  const d = el.dataset;
  if (_posTab === 'profit') {
    const cnt = parseInt(d.profitCount) || 0;
    const r   = parseFloat(d.profitR)   || 0;
    el.innerHTML = cnt > 0
      ? `<div class="pos-tab-stat pos-tab-stat-bull">
           <span>📈 盈利中 <strong>${cnt} 筆</strong></span>
           <span>合計未實現獲利 <strong>+${r.toFixed(2)} R</strong></span>
         </div>`
      : `<div class="pos-tab-stat" style="color:var(--text3)">目前沒有盈利中的持倉</div>`;
  } else if (_posTab === 'loss') {
    const cnt = parseInt(d.lossCount) || 0;
    const r   = parseFloat(d.lossR)   || 0;
    el.innerHTML = cnt > 0
      ? `<div class="pos-tab-stat pos-tab-stat-bear">
           <span>📉 虧損中 <strong>${cnt} 筆</strong></span>
           <span>合計未實現虧損 <strong>${r.toFixed(2)} R</strong></span>
         </div>`
      : `<div class="pos-tab-stat" style="color:var(--text3)">目前沒有虧損中的持倉</div>`;
  } else if (_posTab === 'pending') {
    const cnt = parseInt(d.pendingCount) || 0;
    el.innerHTML = cnt > 0
      ? `<div class="pos-tab-stat" style="color:var(--neutral)">⏳ 等待進場 <strong>${cnt} 筆</strong>，尚未計入持倉</div>`
      : `<div class="pos-tab-stat" style="color:var(--text3)">目前沒有待確認的交易建議</div>`;
  } else {
    el.innerHTML = '';
  }
}

function renderPositionsPage() {
  const container = document.getElementById('positions-content');
  if (!container) return;

  const tlog    = loadTradeLog();
  const open    = tlog.filter(t => t.status === 'open' && t.entry);
  const pending = tlog.filter(t => t.status === 'pending' && t.entry);
  if (open.length === 0 && pending.length === 0) {
    container.innerHTML = `
      <div class="page-header"><div>
        <h1 class="page-title">持倉中</h1>
        <p class="page-subtitle">目前進行中的交易推薦</p>
      </div></div>
      <div class="pos-empty">目前沒有進行中的交易推薦<br><span style="font-size:0.83rem;color:var(--text3)">掃描到風控分 ≥ 60 分的訊號時會自動出現</span></div>`;
    return;
  }

  // 計算整體未實現統計
  let totalUnrealR = 0, totalRisk = 0, hasPrice = 0;
  let profitCount = 0, lossCount = 0, profitTotalR = 0, lossTotalR = 0;
  const cards = open.map(t => {
    const cur = parseFloat((state.data.find(d => d.symbol === t.symbol) || {}).price) || 0;
    const entry   = t.entry   || 0;
    const sl      = t.sl      || 0;
    const tp1     = t.tp1     || 0;
    const tp2     = t.tp2     || 0;
    const risk    = Math.abs(entry - (t.baseSl ?? sl)) || 1;
    const isLong  = t.direction === 'long';
    const _tpxSym = (t.symbol || '').replace('/', '').toUpperCase();
    const _tpx = v => { try { return toPionex(_tpxSym, cur || 1, v); } catch(e) { return v.toFixed(4); } };

    let unrealR   = null, unrealPct = null, priceClr = 'var(--text2)';
    if (cur && entry) {
      const move   = isLong ? cur - entry : entry - cur;
      unrealR      = move / risk;
      unrealPct    = ((isLong ? cur - entry : entry - cur) / entry * 100);
      priceClr     = unrealR > 0 ? 'var(--bull)' : unrealR < 0 ? 'var(--bear)' : 'var(--text2)';
      totalUnrealR += unrealR;
      totalRisk    += risk;
      hasPrice++;
      if (unrealR > 0) { profitCount++; profitTotalR += unrealR; }
      else             { lossCount++;   lossTotalR  += unrealR; }
    } else {
      // 無即時價格 → 歸入虧損中，確保分類加總 = 全部
      lossCount++;
    }

    const conf      = t.conf != null ? t.conf : Math.min(90, t.score || 60);
    const confClr   = conf >= 60 ? 'var(--bull)' : conf >= 50 ? '#ff6d00' : 'var(--text3)';
    const isLongTermOpen = t.canScaleIn === true;
    const dirLabel  = isLong ? '▲ 做多' : '▼ 做空';
    const dirColor  = isLong ? 'var(--bull)' : 'var(--bear)';
    const rangeBadge = '';
    const ltBadgeOpen = isLongTermOpen
      ? `<span style="display:inline-flex;align-items:center;gap:3px;margin-left:7px;padding:2px 7px;border-radius:20px;font-size:0.7rem;font-weight:700;background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.4);color:#4ade80;vertical-align:middle">〔長線單〕</span>`
      : '';
    const shortTermBadgeOpen = !isLongTermOpen
      ? `<span style="display:inline-flex;align-items:center;gap:3px;margin-left:7px;padding:2px 7px;border-radius:20px;font-size:0.7rem;font-weight:700;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.35);color:#fbbf24;vertical-align:middle">⚡ 短線</span>`
      : '';

    // 進度條
    let progressHtml = '';
    if (cur && entry && sl) {
      if (isLongTermOpen) {
        // ── 長線單：SL → 進場 → 加倉1~N → 最終TP ──
        const finalTP    = t.ltTP || tp2;
        const siTargets  = t.scaleInTargets || [];
        const sisDone    = (t.scaleIns || []).filter(s => s.status === 'open');
        if (finalTP) {
          const rangeTotal = isLong ? (finalTP - sl) : (sl - finalTP);
          if (rangeTotal > 0) {
            const toP = v => Math.max(0, Math.min(100, (isLong ? (v - sl) : (sl - v)) / rangeTotal * 100));
            const curPct   = toP(cur);
            const entryPct = toP(entry);
            const firstSIPct = siTargets.length ? toP(siTargets[0]) : null;
            const fillClr  = curPct < entryPct ? 'var(--bear)'
                           : (firstSIPct !== null && curPct >= firstSIPct) ? '#22c55e' : 'var(--bull)';
            const siLines = siTargets.map((lv, i) => {
              const p   = toP(lv);
              const clr = i < sisDone.length ? '#22c55e' : 'rgba(167,139,250,.75)';
              return `<div style="position:absolute;top:-4px;bottom:-4px;left:${p}%;width:2px;background:${clr};border-radius:1px;transform:translateX(-50%)"></div>`;
            }).join('');
            // Build label list and stagger rows when labels are closer than 12%
            const _ltL = [
              { pct: 0,       text: 'SL', color: 'var(--bear)',  pos: 'left:0' },
              { pct: entryPct,text: '進場', color: 'var(--text3)', pos: `left:${entryPct}%;transform:translateX(-50%)` },
              ...siTargets.map((lv, i) => {
                const p   = toP(lv);
                const clr = i < sisDone.length ? '#22c55e' : '#a78bfa';
                return { pct: p, text: `加${i+1}`, color: clr, pos: `left:${p}%;transform:translateX(-50%)` };
              }),
              { pct: 100, text: 'TP', color: '#22c55e', pos: 'right:0' },
            ];
            const _ltR = _ltL.map(() => 0);
            for (let i = 1; i < _ltL.length; i++) if (_ltL[i].pct - _ltL[i-1].pct < 12) _ltR[i] = (_ltR[i-1] + 1) % 2;
            const _ltHas2 = _ltR.some(r => r === 1);
            const _ltLabelHtml = _ltL.map((l, i) =>
              `<span style="position:absolute;top:${_ltR[i] * 13}px;${l.pos};color:${l.color};white-space:nowrap">${l.text}</span>`
            ).join('');
            progressHtml = `
              <div class="pos-progress-wrap" style="margin:10px 0 6px">
                <div style="position:relative;height:8px;background:rgba(255,255,255,.08);border-radius:4px;margin-bottom:${_ltHas2 ? 30 : 18}px">
                  <div style="position:absolute;inset:0;width:${curPct}%;background:${fillClr};border-radius:4px;transition:width .4s;max-width:100%"></div>
                  <div style="position:absolute;top:-3px;bottom:-3px;left:${entryPct}%;width:2px;background:rgba(255,255,255,.45);border-radius:1px;transform:translateX(-50%)"></div>
                  ${siLines}
                  <div style="position:absolute;top:12px;left:0;right:0;font-size:0.67rem;pointer-events:none;height:28px">
                    ${_ltLabelHtml}
                  </div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:var(--text3);margin-top:2px">
                  <span style="color:var(--bear)">${fmtPrice(_tpx(sl))}</span>
                  <span style="color:var(--text3)">現價 <b style="color:${fillClr}">${fmtPrice(_tpx(cur))}</b></span>
                  <span style="color:#22c55e">${fmtPrice(_tpx(finalTP))}</span>
                </div>
              </div>`;
          }
        }
      } else if (tp1 && tp2) {
        // ── 短線單：SL → 進場 → TP1 → TP2 ──
        const rangeTotal = isLong ? (tp2 - sl) : (sl - tp2);
        if (rangeTotal > 0) {
          const toP      = v => Math.max(0, Math.min(100, (isLong ? (v - sl) : (sl - v)) / rangeTotal * 100));
          const curPct   = toP(cur);
          const entryPct = toP(entry);
          const tp1Pct   = toP(tp1);
          const fillClr  = curPct < entryPct ? 'var(--bear)' : curPct >= tp1Pct ? '#22c55e' : 'var(--bull)';
          // Stagger labels that are closer than 12% apart
          const _stL = [
            { pct: 0,       text: 'SL',  color: 'var(--bear)',  pos: 'left:0' },
            { pct: entryPct,text: '進場', color: 'var(--text3)', pos: `left:${entryPct}%;transform:translateX(-50%)` },
            { pct: tp1Pct,  text: 'TP1', color: '#f59e0b',      pos: `left:${tp1Pct}%;transform:translateX(-50%)` },
            { pct: 100,     text: 'TP2', color: '#22c55e',      pos: 'right:0' },
          ];
          const _stR = [0, 0, 0, 0];
          for (let i = 1; i < _stL.length; i++) if (_stL[i].pct - _stL[i-1].pct < 12) _stR[i] = (_stR[i-1] + 1) % 2;
          const _stHas2 = _stR.some(r => r === 1);
          const _stLabelHtml = _stL.map((l, i) =>
            `<span style="position:absolute;top:${_stR[i] * 13}px;${l.pos};color:${l.color};white-space:nowrap">${l.text}</span>`
          ).join('');
          progressHtml = `
            <div class="pos-progress-wrap" style="margin:10px 0 6px">
              <div style="position:relative;height:8px;background:rgba(255,255,255,.08);border-radius:4px;margin-bottom:${_stHas2 ? 30 : 18}px">
                <div style="position:absolute;inset:0;width:${curPct}%;background:${fillClr};border-radius:4px;transition:width .4s;max-width:100%"></div>
                <div style="position:absolute;top:-3px;bottom:-3px;left:${entryPct}%;width:2px;background:rgba(255,255,255,.45);border-radius:1px;transform:translateX(-50%)"></div>
                <div style="position:absolute;top:-4px;bottom:-4px;left:${tp1Pct}%;width:2px;background:#f59e0b;border-radius:1px;transform:translateX(-50%)"></div>
                <div style="position:absolute;top:12px;left:0;right:0;font-size:0.67rem;pointer-events:none;height:28px">
                  ${_stLabelHtml}
                </div>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:var(--text3);margin-top:2px">
                <span style="color:var(--bear)">${fmtPrice(_tpx(sl))}</span>
                <span style="color:var(--text3)">現價 <b style="color:${fillClr}">${fmtPrice(_tpx(cur))}</b></span>
                <span style="color:#22c55e">${fmtPrice(_tpx(tp2))}</span>
              </div>
            </div>`;
        }
      }
    }

    const reasons = (t.entryReasons?.length ? t.entryReasons : (t.entryReason || '').split('，')).filter(Boolean);

    return `<div class="pos-card" data-symbol="${t.symbol}" data-unreal="${unrealR !== null ? unrealR.toFixed(4) : ''}" onclick="navigateTo('coin','${t.symbol}')">
      <div class="pos-card-top">
        <div class="pos-symbol">
          <span class="pos-sym-name">${t.symbol.replace('/USDT','')}<span style="color:var(--text3)">/USDT</span></span>
          <span class="pos-dir" style="color:${dirColor}">${dirLabel}${rangeBadge}${ltBadgeOpen}${shortTermBadgeOpen}${(() => { const _og = t.sqGrade || (conf >= 82 ? 'A' : conf >= 74 ? 'B' : conf >= 65 ? 'C' : 'D'); const _gc = { S:'#f0c040', A:'#22c55e', B:'#60a5fa', C:'#f59e0b', D:'#ef4444' }[_og] || '#9ca3af'; const _ge = { S:'🏆', A:'🥇', B:'🥈', C:'🥉', D:'⚠️' }[_og] || '📊'; const _gl = t.sqGradeLabel || { S:'頂級訊號', A:'優質訊號', B:'良好訊號', C:'一般訊號', D:'訊號偏弱' }[_og] || ''; return `<span style="font-size:0.7rem;font-weight:700;background:${_gc}22;border:1px solid ${_gc}55;color:${_gc};padding:2px 7px;border-radius:20px;margin-left:6px">${_ge} AI ${_og} ${_gl}</span>`; })()}</span>
        </div>
        <div class="pos-unreal ${unrealR !== null ? (unrealR > 0 ? 'pos-unreal-pos' : unrealR < 0 ? 'pos-unreal-neg' : '') : ''}">
          ${unrealR !== null
            ? `${unrealR >= 0 ? '+' : ''}${unrealR.toFixed(2)} R<span class="pos-unreal-pct">${unrealPct >= 0 ? '+' : ''}${unrealPct.toFixed(2)}%</span>`
            : '等待價格更新'}
        </div>
      </div>

      <div class="pos-grid">
        <div class="pos-cell">
          <div class="pos-cell-lbl">現價</div>
          <div class="pos-cell-val" style="color:${priceClr}">${cur ? fmtPrice(_tpx(cur)) : '—'}</div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">進場價</div>
          <div class="pos-cell-val">${fmtPrice(_tpx(entry))}</div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">止損</div>
          <div class="pos-cell-val" style="color:var(--bear)">${fmtPrice(_tpx(sl))}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${entry&&sl ? ((isLong?sl-entry:entry-sl)/entry*100).toFixed(2)+'%' : ''}</span></div>
        </div>
        ${isLongTermOpen ? `
        <div class="pos-cell">
          <div class="pos-cell-lbl">最終目標</div>
          <div class="pos-cell-val" style="color:#22c55e">${fmtPrice(_tpx(t.ltTP || tp2))}${entry&&(t.ltTP||tp2) ? `<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${((isLong?(t.ltTP||tp2)-entry:entry-(t.ltTP||tp2))/entry*100).toFixed(2)}% <span style="color:#22c55e;font-weight:700">${(Math.abs((t.ltTP||tp2)-entry)/risk).toFixed(1)}R</span></span>` : ''}</div>
        </div>
        ${t.maxScaleIns > 0 ? `
        <div class="pos-cell">
          <div class="pos-cell-lbl">已加倉</div>
          <div class="pos-cell-val" style="color:#a78bfa">${(t.scaleIns||[]).filter(s=>s.status==='open').length} / ${t.maxScaleIns}</div>
        </div>` : ''}
        <div class="pos-cell" style="grid-column:span 2">
          <div class="pos-cell-lbl">🛡️ AI 風控分</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="color:${confClr};font-weight:700;font-size:0.95rem">${conf} 分</span>
            ${(t.learnPenalty||0) > 0 ? `<span style="color:#f59e0b;font-size:0.7rem">止損風控 -${Math.min(45,t.learnPenalty||0)} 分</span>` : '<span style="color:#22c55e;font-size:0.7rem">風控通過</span>'}
          </div>
        </div>
        ` : `
        <div class="pos-cell">
          <div class="pos-cell-lbl">止盈一</div>
          <div class="pos-cell-val" style="color:var(--bull)">${fmtPrice(_tpx(tp1))}${entry&&tp1 ? `<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${((isLong?tp1-entry:entry-tp1)/entry*100).toFixed(2)}% <span style="color:#f59e0b;font-weight:700">${(Math.abs(tp1-entry)/risk).toFixed(1)}R</span></span>` : ''}</div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">止盈二</div>
          <div class="pos-cell-val" style="color:#22c55e">${fmtPrice(_tpx(tp2))}${entry&&tp2 ? `<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${((isLong?tp2-entry:entry-tp2)/entry*100).toFixed(2)}% <span style="color:#22c55e;font-weight:700">${(Math.abs(tp2-entry)/risk).toFixed(1)}R</span></span>` : ''}</div>
        </div>
        <div class="pos-cell" style="grid-column:span 3">
          <div class="pos-cell-lbl">🛡️ AI 風控分</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="color:${confClr};font-weight:700;font-size:0.95rem">${conf} 分</span>
            ${(t.learnPenalty||0) > 0 ? `<span style="color:#f59e0b;font-size:0.7rem">止損風控 -${Math.min(45,t.learnPenalty||0)} 分</span>` : '<span style="color:#22c55e;font-size:0.7rem">風控通過</span>'}
          </div>
        </div>
        `}
      </div>

      ${progressHtml}

      ${(() => {
        if (!isLongTermOpen) return '';
        const siTargets = t.scaleInTargets || [];
        if (!siTargets.length) return '';
        const sisDone    = (t.scaleIns || []).filter(s => s.status === 'open');
        const siPending  = (t.scaleIns || []).find(s => s.status === 'pending');
        const finalTP    = t.ltTP || t.tp2;
        const rows = siTargets.map((level, i) => {
          const isDone     = i < sisDone.length;
          const isPending  = !isDone && siPending && i === sisDone.length;
          const actualEntry = isDone ? (sisDone[i]?.entryPrice || sisDone[i]?.entryLevel) : null;
          const movePct    = entry ? (((level - entry) / entry) * 100 * (isLong ? 1 : -1)).toFixed(1) : '—';
          const icon  = isDone ? '✅' : isPending ? '⏳' : '📌';
          const clr   = isDone ? '#22c55e' : isPending ? '#f59e0b' : 'var(--text3)';
          const lbl   = isDone ? `已觸及 @ ${fmtPrice(_tpx(actualEntry))}` : isPending ? '等待確認' : `目標 ${fmtPrice(_tpx(level))}`;
          return `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;${i < siTargets.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,.05)' : ''}">
            <div style="display:flex;align-items:center;gap:6px">
              <span>${icon}</span>
              <span style="font-size:0.78rem;color:${clr};font-weight:600">加倉 ${i + 1}</span>
              <span style="font-size:0.7rem;color:var(--text3)">${isLong ? '+' : '-'}${movePct}%</span>
            </div>
            <span style="font-size:0.78rem;color:${clr}">${lbl}</span>
          </div>`;
        }).join('');
        return `<div style="margin:10px 0 4px;padding:8px 12px;background:rgba(34,197,94,.05);border:1px solid rgba(34,197,94,.2);border-radius:8px">
          <div style="font-size:0.72rem;font-weight:700;color:#4ade80;margin-bottom:6px;letter-spacing:.4px">📈 長線加倉計劃</div>
          ${rows}
          ${finalTP ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0 2px;margin-top:4px;border-top:1px solid rgba(34,197,94,.2)">
            <span style="font-size:0.78rem;color:#4ade80;font-weight:700">🏁 最終目標</span>
            <span style="font-size:0.82rem;font-weight:700;color:#4ade80">${fmtPrice(_tpx(finalTP))}</span>
          </div>` : ''}
        </div>`;
      })()}

      <div class="pos-reasons">
        <div class="pos-reasons-lbl">📍 進場理由</div>
        ${reasons.length ? reasons.map(r => `<span class="pos-reason-chip">${r}</span>`).join('') : '<span style="color:var(--text3);font-size:0.78rem">無詳細原因</span>'}
      </div>

      <div class="pos-footer">
        <span style="color:var(--text3);font-size:0.72rem">信號時間：${fmtDateTime(t.timestamp)} · 進場確認：<strong style="color:var(--bull)">${t.entryTime ? fmtDateTime(t.entryTime) : '—'}</strong></span>
        ${t.tp1Hit ? '<span class="pos-tp1-badge">止盈一已觸及 ✅</span>' : ''}
      </div>
    </div>`;
  }).join('');

  // 統計匯總
  const totalUnrealStr = hasPrice > 0
    ? `${totalUnrealR >= 0 ? '+' : ''}${totalUnrealR.toFixed(2)} R`
    : '—';
  const totalClr = totalUnrealR > 0 ? 'var(--bull)' : totalUnrealR < 0 ? 'var(--bear)' : 'var(--text2)';

  // 保存搜尋狀態，避免定時重繪時打斷使用者輸入
  const _prevSearchEl    = document.getElementById('pos-search-input');
  const _prevSearchVal   = _prevSearchEl?.value || '';
  const _prevSearchFocus = document.activeElement === _prevSearchEl;

  container.innerHTML = `
    <div class="page-header"><div>
      <h1 class="page-title">持倉中</h1>
      <p class="page-subtitle">目前進行中的交易推薦（${open.length} 筆）</p>
    </div></div>

    <div class="pos-summary">
      <div class="pos-sum-card">
        <div class="pos-sum-val">${open.length}</div>
        <div class="pos-sum-lbl">進行中</div>
      </div>
      <div class="pos-sum-card">
        <div class="pos-sum-val" style="color:${totalClr}">${totalUnrealStr}</div>
        <div class="pos-sum-lbl">合計未實現</div>
      </div>
      <div class="pos-sum-card">
        <div class="pos-sum-val" style="color:var(--bull)">${open.filter(t=>t.tp1Hit).length}</div>
        <div class="pos-sum-lbl">止盈一已達</div>
      </div>
    </div>

    <div class="pos-tabs">
      <button class="pos-tab-btn${_posTab==='all'?' pos-tab-active':''}" data-tab="all" onclick="setPosTab('all')">全部 ${open.length + pending.length}</button>
      <button class="pos-tab-btn${_posTab==='profit'?' pos-tab-active':''}" data-tab="profit" onclick="setPosTab('profit')">📈 盈利中 ${profitCount}</button>
      <button class="pos-tab-btn${_posTab==='loss'?' pos-tab-active':''}" data-tab="loss" onclick="setPosTab('loss')">📉 虧損中 ${lossCount}</button>
      <button class="pos-tab-btn${_posTab==='pending'?' pos-tab-active':''}" data-tab="pending" onclick="setPosTab('pending')">⏳ 未進場 ${pending.length}</button>
    </div>

    <div id="pos-tab-summary"
      data-profit-count="${profitCount}"
      data-profit-r="${profitTotalR.toFixed(2)}"
      data-loss-count="${lossCount}"
      data-loss-r="${lossTotalR.toFixed(2)}"
      data-all-count="${open.length + pending.length}"
      data-all-r="${totalUnrealR.toFixed(2)}"
      data-pending-count="${pending.length}">
    </div>

    <input class="pos-search" id="pos-search-input" placeholder="搜尋幣種..." oninput="filterPositionCards(this.value)">
    <div class="pos-list" id="pos-list-container">${cards}</div>
    ${pending.length > 0 ? `<div id="pos-pending-section-hdr" style="display:none;margin:16px 0 6px;padding:8px 12px;border-radius:8px;background:rgba(255,215,64,0.07);border:1px solid rgba(255,215,64,0.18);font-size:0.8rem;font-weight:600;color:#f0a500">⏳ 等待進場（${pending.length} 筆）— 等待現價回踩確認後自動開倉</div>` : ''}
    <div class="pos-list" id="pos-pending-container" style="display:none">
      ${pending.length === 0
        ? '<div class="pos-empty" style="margin-top:12px">目前沒有等待進場的交易建議</div>'
        : pending.map(t => {
            const isLong  = t.direction === 'long';
            const dirClr  = isLong ? 'var(--bull)' : 'var(--bear)';
            const dirLbl  = isLong ? '▲ 等待做多' : '▼ 等待做空';
            const fmt     = v => v ? fmtPrice(v) : '—';
            const isLongTermCard = t.canScaleIn === true;
            const _fbR    = Math.abs((t.entry || 0) - (t.sl || 0));
            const _fbTp1  = t.tp1 || (_fbR > 0 ? (t.direction === 'long' ? (t.entry||0) + _fbR * 1.5 : (t.entry||0) - _fbR * 1.5) : 0);
            const expiry  = t.timestamp ? fmtDateTime(t.timestamp + (isLongTermCard ? SIGNAL_COOLDOWN * 12 : SIGNAL_COOLDOWN * 2)) : '—';
            const cur     = parseFloat((state.data.find(d => d.symbol === t.symbol) || {}).price) || 0;
            const distPct = (cur && t.entry) ? (((cur - t.entry) / t.entry) * 100 * (isLong ? 1 : -1)).toFixed(2) : null;
            const distClr = distPct === null ? 'var(--text3)' : Math.abs(parseFloat(distPct)) <= 0.5 ? 'var(--bull)' : 'var(--text2)';
            const typeLabel = '';
            const ltBadgePend = isLongTermCard
              ? `<span style="font-size:0.72rem;font-weight:700;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.35);color:#4ade80;padding:2px 7px;border-radius:20px;margin-left:6px">〔長線單〕</span>`
              : '';
            const shortTermBadgePend = !isLongTermCard
              ? `<span style="font-size:0.72rem;font-weight:700;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.35);color:#fbbf24;padding:2px 7px;border-radius:20px;margin-left:6px">⚡ 短線</span>`
              : '';
            const pendReasons = (t.entryReasons?.length ? t.entryReasons : (t.entryReason || '').split('，')).filter(Boolean);
            // 最終風控分（t.conf 已是建單時完整扣分後的值，動態更新由 updateOpenTrades 負責）
            const _pConf = t.conf != null ? t.conf : (t.score || 0);
            const _pConfClr = _pConf >= 80 ? 'var(--bull)' : _pConf >= 60 ? '#f59e0b' : 'var(--text3)';
            // 長線單：加倉位
            const _siTargets = t.scaleInTargets || [];
            return `<div class="pos-card" data-symbol="${t.symbol}" data-unreal="" onclick="navigateTo('coin','${t.symbol}')">
              <div class="pos-card-top">
                <div class="pos-symbol">
                  <span class="pos-sym-name">${t.symbol.replace('/USDT','')}<span style="color:var(--text3)">/USDT</span></span>
                  <span class="pos-dir" style="color:${dirClr}">${dirLbl}${typeLabel}${ltBadgePend}${shortTermBadgePend}${(() => { const _pg = t.sqGrade || (_pConf >= 82 ? 'A' : _pConf >= 74 ? 'B' : _pConf >= 65 ? 'C' : 'D'); const _gc = { S:'#f0c040', A:'#22c55e', B:'#60a5fa', C:'#f59e0b', D:'#ef4444' }[_pg] || '#9ca3af'; const _ge = { S:'🏆', A:'🥇', B:'🥈', C:'🥉', D:'⚠️' }[_pg] || '📊'; const _gl = t.sqGradeLabel || { S:'頂級訊號', A:'優質訊號', B:'良好訊號', C:'一般訊號', D:'訊號偏弱' }[_pg] || ''; return `<span style="font-size:0.72rem;font-weight:700;background:${_gc}22;border:1px solid ${_gc}55;color:${_gc};padding:2px 7px;border-radius:20px;margin-left:6px">${_ge} AI ${_pg} ${_gl}</span>`; })()}</span>
                </div>
                <div style="font-size:0.8rem;color:var(--neutral);padding:4px 8px;background:rgba(255,215,64,0.1);border-radius:6px">⏳ 等待回踩</div>
              </div>
              <div class="pos-grid">
                <div class="pos-cell"><div class="pos-cell-lbl">進場位</div><div class="pos-cell-val">${fmt(t.entry)}</div></div>
                <div class="pos-cell"><div class="pos-cell-lbl">現價距進場</div><div class="pos-cell-val" style="color:${distClr}">${distPct !== null ? distPct + '%' : '—'}</div></div>
                <div class="pos-cell"><div class="pos-cell-lbl">止損位</div><div class="pos-cell-val" style="color:var(--bear)">${fmt(t.sl)}</div></div>
                ${isLongTermCard ? `
                <div class="pos-cell"><div class="pos-cell-lbl">最終止盈位</div><div class="pos-cell-val" style="color:#22c55e">${fmt(t.ltTP || t.tp2 || t.tp1)}${_fbR > 0 && (t.ltTP || t.tp2 || t.tp1) ? `<span style="font-size:0.7rem;color:var(--text3);margin-left:3px"><span style="color:#22c55e;font-weight:700">${(Math.abs((t.ltTP || t.tp2 || t.tp1) - (t.entry||0)) / _fbR).toFixed(1)}R</span></span>` : ''}</div></div>
                ` : `
                <div class="pos-cell"><div class="pos-cell-lbl">止盈一</div><div class="pos-cell-val" style="color:var(--bull)">${fmt(_fbTp1)}${_fbR > 0 ? `<span style="font-size:0.7rem;color:var(--text3);margin-left:3px"><span style="color:#f59e0b;font-weight:700">${(Math.abs(_fbTp1 - (t.entry||0)) / _fbR).toFixed(1)}R</span></span>` : ''}</div></div>
                ${(t.tp2 || _fbR > 0) ? (() => { const _pTp2 = t.tp2 || (t.direction === 'long' ? (t.entry||0) + _fbR * 2.5 : (t.entry||0) - _fbR * 2.5); return `<div class="pos-cell"><div class="pos-cell-lbl">止盈二</div><div class="pos-cell-val" style="color:#22c55e">${fmt(_pTp2)}${_fbR > 0 ? `<span style="font-size:0.7rem;color:var(--text3);margin-left:3px"><span style="color:#22c55e;font-weight:700">${(Math.abs(_pTp2 - (t.entry||0)) / _fbR).toFixed(1)}R</span></span>` : ''}</div></div>`; })() : ''}
                `}
                <div class="pos-cell" style="grid-column:span ${isLongTermCard ? 1 : 1}">
                  <div class="pos-cell-lbl">🛡️ AI 風控分</div>
                  <div class="pos-cell-val" style="color:${_pConfClr}">${_pConf} 分</div>
                </div>
                ${isLongTermCard && _siTargets.length ? `
                <div class="pos-cell" style="grid-column:span 2">
                  <div class="pos-cell-lbl">加倉位（AI 建議 ${t.maxScaleIns || _siTargets.length} 次加倉）</div>
                  <div class="pos-cell-val" style="color:#a78bfa">${_siTargets.map((lv, i) => `#${i+1} ${fmt(lv)}`).join('　')}</div>
                </div>
                ` : ''}
              </div>
              ${isLongTermCard && t.aiScaleReason ? `<div style="margin-top:6px;font-size:0.72rem;color:#a78bfa;padding:4px 8px;background:rgba(167,139,250,.08);border-radius:6px">🤖 ${t.aiScaleReason}</div>` : ''}
              ${pendReasons.length ? `<div class="pos-reasons" style="margin-top:8px"><div class="pos-reasons-lbl">📍 進場理由</div>${pendReasons.map(r => `<span class="pos-reason-chip">${r}</span>`).join('')}</div>` : ''}
              <div class="pos-footer">
                <span style="color:var(--text3);font-size:0.72rem">信號時間：${fmtDateTime(t.timestamp)}</span>
                <span style="color:var(--text3);font-size:0.72rem">有效期至：${expiry}</span>
              </div>
            </div>`;
          }).join('')}
    </div>

    <div style="text-align:center;margin-top:16px;font-size:0.75rem;color:var(--text3)">
      點擊任一卡片查看幣種詳情 · 每次掃描自動更新未實現損益
    </div>`;

  // 維持當前分頁篩選狀態與摘要
  if (_posTab !== 'all' && _posTab !== 'pending') filterPositionCards('');
  updatePosTabSummary();
  // 初始化未進場分頁顯示狀態
  const pendingContainer = document.getElementById('pos-pending-container');
  const pendingHdr       = document.getElementById('pos-pending-section-hdr');
  const mainList = document.getElementById('pos-list-container');
  const posSearch = document.getElementById('pos-search-input');
  const showPendingTab = _posTab === 'pending';
  const showPendingInAll = _posTab === 'all' && pending.length > 0;
  if (pendingContainer) pendingContainer.style.display = (showPendingTab || showPendingInAll) ? '' : 'none';
  if (pendingHdr)       pendingHdr.style.display       = showPendingInAll ? '' : 'none';
  if (mainList)  mainList.style.display  = showPendingTab ? 'none' : '';
  if (posSearch) posSearch.style.display = showPendingTab ? 'none' : '';

  // 還原搜尋狀態（防止定時重繪清空使用者正在輸入的搜尋字）
  if (_prevSearchVal && posSearch) {
    posSearch.value = _prevSearchVal;
    filterPositionCards(_prevSearchVal);
  }
  if (_prevSearchFocus && posSearch) {
    posSearch.focus();
    // 將游標移到末尾
    const len = posSearch.value.length;
    posSearch.setSelectionRange(len, len);
  }
}

function filterPositionCards(query) {
  const q = query.trim().toLowerCase();
  const container = document.getElementById('pos-list-container');
  if (!container) return;

  const cards = [...container.querySelectorAll('.pos-card')];
  cards.forEach(card => {
    const sym     = (card.getAttribute('data-symbol') || '').toLowerCase();
    const unrealR = parseFloat(card.getAttribute('data-unreal'));
    const matchSearch = !q || sym.includes(q);
    const matchTab =
      _posTab === 'pending' ||
      _posTab === 'all' ||
      (_posTab === 'profit' && unrealR > 0) ||
      (_posTab === 'loss'   && !(unrealR > 0));
    card.style.display = (matchSearch && matchTab) ? '' : 'none';
  });

  // 虧損中：已虧損（unrealR < 0）排在無價格或平手（NaN/0）前面
  if (_posTab === 'loss') {
    const visible = cards.filter(c => c.style.display !== 'none');
    visible.sort((a, b) => {
      const ra = parseFloat(a.getAttribute('data-unreal'));
      const rb = parseFloat(b.getAttribute('data-unreal'));
      const isLossA = ra < 0, isLossB = rb < 0;
      if (isLossA && !isLossB) return -1;
      if (!isLossA && isLossB) return 1;
      if (isLossA && isLossB) return ra - rb; // 虧最多的在最上面
      return 0;
    });
    visible.forEach(card => container.appendChild(card));
  }
}

/* ── 交易記錄頁面渲染 ─────────────────────────────────────────── */
let _tlFilter = 'all';

function renderTradeLogPage() {
  const container = document.getElementById('tradelog-content');
  if (!container) return;
  const trades  = loadTradeLog();
  const closed  = trades.filter(t => t.status === 'closed');
  const wins    = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
  const losses  = closed.filter(t => t.outcome === 'sl');
  const bes     = closed.filter(t => t.outcome === 'be');
  const winRate = closed.length ? (wins.length / closed.length * 100).toFixed(1) : '0.0';
  const avgWinR = wins.length
    ? (wins.reduce((s, t) => s + parseFloat(t.pnlR || 0), 0) / wins.length).toFixed(2)
    : '--';
  const netR    = closed.length
    ? closed.reduce((s, t) => s + parseFloat(t.pnlR || 0), 0).toFixed(2)
    : '0.0';

  // 只顯示已結束的交易，按篩選器過濾
  let display = closed;
  if (_tlFilter === 'tp') display = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
  if (_tlFilter === 'sl') display = closed.filter(t => t.outcome === 'sl');
  if (_tlFilter === 'be') display = closed.filter(t => t.outcome === 'be');

  const netRNum = parseFloat(netR);
  const statsHtml = `<div class="tl-stats">
    <div class="tl-stat-card">
      <div class="tl-stat-val">${closed.length}</div>
      <div class="tl-stat-lbl">已完成交易</div>
    </div>
    <div class="tl-stat-card">
      <div class="tl-stat-val" style="color:${parseFloat(winRate) >= 50 ? 'var(--bull)' : 'var(--bear)'}">${winRate}%</div>
      <div class="tl-stat-lbl">勝率</div>
    </div>
    <div class="tl-stat-card">
      <div class="tl-stat-val" style="color:var(--bull)">${avgWinR}</div>
      <div class="tl-stat-lbl">平均盈利 R</div>
    </div>
    <div class="tl-stat-card">
      <div class="tl-stat-val ${netRNum > 0 ? 'tl-pnl-pos' : netRNum < 0 ? 'tl-pnl-neg' : 'tl-pnl-zero'}">${netRNum > 0 ? '+' : ''}${netR} R</div>
      <div class="tl-stat-lbl">累計 R</div>
    </div>
    <div class="tl-stat-card">
      <div class="tl-stat-val" style="color:var(--bull)">${wins.length}</div>
      <div class="tl-stat-lbl">止盈</div>
    </div>
    <div class="tl-stat-card">
      <div class="tl-stat-val" style="color:var(--bear)">${losses.length}</div>
      <div class="tl-stat-lbl">止損</div>
    </div>
    <div class="tl-stat-card">
      <div class="tl-stat-val" style="color:var(--text3)">${bes.length}</div>
      <div class="tl-stat-lbl">保本</div>
    </div>
  </div>`;

  // 篩選器（只針對結束的交易）
  const filters = [
    { key: 'all', label: '全部' },
    { key: 'tp',  label: '止盈' },
    { key: 'sl',  label: '止損' },
    { key: 'be',  label: '保本' },
  ];
  const filterHtml = `<div class="tl-filters">
    ${filters.map(f => `<button class="tl-filter-btn${_tlFilter === f.key ? ' active' : ''}" onclick="setTlFilter('${f.key}')">${f.label}</button>`).join('')}
  </div>`;

  // Trade table
  let tableHtml = '';
  if (display.length === 0) {
    tableHtml = `<div class="tl-empty">暫無已結束的交易記錄。系統正在追蹤中，待交易觸及止盈或止損後會自動顯示在此。</div>`;
  } else {
    const rows = display.map(t => {
      const isLongTrade = t.canScaleIn === true || t.isLongTerm === true;
      const dirHtml = t.direction === 'long'
        ? `<span class="tl-dir-long">▲ 多</span>`
        : `<span class="tl-dir-short">▼ 空</span>`;
      const typeTag = isLongTrade
        ? `<span style="display:inline-block;margin-left:4px;font-size:0.65rem;padding:1px 5px;border-radius:10px;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3);color:#4ade80;font-weight:600">長線</span>`
        : `<span style="display:inline-block;margin-left:4px;font-size:0.65rem;padding:1px 5px;border-radius:10px;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);color:#fbbf24;font-weight:600">短線</span>`;

      let statusHtml;
      if (t.status === 'open') {
        statusHtml = `<span class="tl-badge tl-badge-open">進行中</span>`;
      } else if (t.outcome === 'tp2') {
        statusHtml = `<span class="tl-badge tl-badge-tp2">止盈二 ✅</span>`;
      } else if (t.outcome === 'tp1') {
        statusHtml = isLongTrade
          ? `<span class="tl-badge tl-badge-tp2">最終止盈 ✅</span>`
          : `<span class="tl-badge tl-badge-tp1">止盈一 ✅</span>`;
      } else if (t.outcome === 'sl') {
        statusHtml = `<span class="tl-badge tl-badge-sl">止損 ❌</span>`;
      } else {
        statusHtml = `<span class="tl-badge tl-badge-be">保本 ➡️</span>`;
      }

      let pnlHtml = '--';
      if (t.pnlR !== null && t.pnlR !== undefined) {
        const pnl = parseFloat(t.pnlR);
        const cls = pnl > 0 ? 'tl-pnl-pos' : pnl < 0 ? 'tl-pnl-neg' : 'tl-pnl-zero';
        pnlHtml = `<span class="${cls}">${pnl > 0 ? '+' : ''}${t.pnlR} R</span>`;
      }

      const exitTimeHtml = t.exitTime
        ? `<div style="font-size:0.7rem;color:var(--text3);margin-top:2px">結束 ${fmtDateTime(t.exitTime)}</div>` : '';

      // 長線單：最終止盈（ltTP 或 tp1），不顯示 tp2
      const tp1Display = isLongTrade
        ? `<span style="color:#22c55e">${fmtPrice(t.ltTP || t.tp1)}</span>`
        : `<span style="color:var(--bull)">${fmtPrice(t.tp1)}</span>`;
      const tp2Display = isLongTrade ? `<span style="color:var(--text3)">—</span>` : fmtPrice(t.tp2);

      const _tg = t.sqGrade || '?';
      const _tgc = { S:'#f0c040', A:'#22c55e', B:'#60a5fa', C:'#f59e0b', D:'#ef4444' }[_tg] || '#9ca3af';
      const _tge = { S:'🏆', A:'🥇', B:'🥈', C:'🥉', D:'⚠️' }[_tg] || '📊';
      const _tgl = t.sqGradeLabel || { S:'頂級', A:'優質', B:'良好', C:'一般', D:'偏弱' }[_tg] || '';
      const gradeHtml = _tg !== '?' ? `<span style="font-size:0.7rem;font-weight:700;background:${_tgc}22;border:1px solid ${_tgc}55;color:${_tgc};padding:2px 6px;border-radius:12px;white-space:nowrap">${_tge} ${_tg} ${_tgl}</span>` : '—';
      const _exitColor = (t.outcome === 'sl' || t.outcome === 'be') ? 'var(--bear)' : 'var(--bull)';
      const _exitLabel = { tp1:'止盈一觸發', tp2:'止盈二觸發', sl:'止損觸發', be:'保本出場' }[t.outcome] || '';
      const exitPriceHtml = t.exitPrice
        ? `<div style="color:${_exitColor};font-size:0.78rem">${fmtPrice(t.exitPrice)}</div><div style="font-size:0.68rem;color:var(--text3)">${_exitLabel}</div>`
        : '—';
      return `<tr class="tl-row-click" onclick="showTradeDetail('${t.id}')">
        <td style="font-size:0.78rem;min-width:130px">
          <div style="color:var(--text2)">信號 ${fmtDateTime(t.timestamp)}</div>
          ${t.entryTime ? `<div style="font-size:0.7rem;color:var(--bull);margin-top:2px">進場 ${fmtDateTime(t.entryTime)}</div>` : ''}
          ${exitTimeHtml}
        </td>
        <td style="font-weight:600">${t.symbol.replace('/USDT','')}<span style="color:var(--text3)">/USDT</span></td>
        <td>${dirHtml}${typeTag}</td>
        <td>${gradeHtml}</td>
        <td>${fmtPrice(t.entry)}</td>
        <td style="color:var(--bear)">${fmtPrice(t.sl)}</td>
        <td>${tp1Display}</td>
        <td style="color:#22c55e">${tp2Display}</td>
        <td>${exitPriceHtml}</td>
        <td>${statusHtml}</td>
        <td>${pnlHtml}</td>
      </tr>`;
    }).join('');

    tableHtml = `<div class="tl-table-wrap">
      <table class="tl-table">
        <thead><tr>
          <th>時間</th><th>幣種</th><th>方向</th><th>等級</th><th>進場</th><th>止損</th><th>止盈1</th><th>止盈2</th><th>結算價</th><th>現狀</th><th>盈虧 R</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  // AI 學習分析區塊
  const learnHtml = buildAILearnPanel(closed);

  // Bottom action buttons
  const mem = loadAIMemory();
  const memCount = Object.keys(mem.issues || {}).length;
  const memRules = Object.keys(mem.rules || {}).length;
  const clearHtml = `<div class="tl-actions-row">
    <div class="tl-mem-status">
      🧠 AI 記憶已保存 ${memCount} 個止損問題 · ${memRules} 條風控規則
      <span style="color:var(--text3);font-size:0.7rem">（網站更新/清除記錄均不影響）</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-ghost" onclick="exportAIMemory()" style="font-size:0.8rem">📤 匯出 AI 記憶</button>
      <button class="btn-ghost" onclick="importAIMemory()" style="font-size:0.8rem">📥 匯入 AI 記憶</button>
      <button class="tl-clear-btn" onclick="clearTradeLog()">清除記錄</button>
    </div>
  </div>`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">交易記錄</h1>
        <p class="page-subtitle">自動記錄每一個交易信號與結果追蹤</p>
      </div>
    </div>
    ${statsHtml}
    ${filterHtml}
    ${tableHtml}
    ${learnHtml}
    ${clearHtml}
  `;
}

function setTlFilter(f) {
  _tlFilter = f;
  renderTradeLogPage();
}

function clearTradeLog() {
  if (!confirm('確定要清除所有交易記錄嗎？\n\n⚠️ AI 學習記憶（止損原因、優化方案）不受影響，會繼續保留。')) return;
  const closed = loadTradeLog().filter(t => t.status === 'closed');
  if (closed.length) archiveExpiredToMemory(closed); // 清除前先歸檔 AI 記憶
  saveTradeLog([]);
  invalidateLearnCache();
  renderTradeLogPage();
  showToast('交易記錄已清除（AI 記憶已保留）', 'info');
}

/* ── AI 記憶匯出 / 匯入 ─────────────────────────────────────────── */
function exportAIMemory() {
  const mem  = loadAIMemory();
  const json = JSON.stringify(mem, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `csp_ai_memory_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('AI 記憶已匯出', 'success');
}

function importAIMemory() {
  const input = document.createElement('input');
  input.type  = 'file';
  input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!imported.issues && !imported.rules) throw new Error('格式錯誤');
        // 合併而非覆蓋：保留現有記憶並疊加匯入的內容
        const current = loadAIMemory();
        // 合併 issues
        for (const [k, v] of Object.entries(imported.issues || {})) {
          if (!current.issues[k]) { current.issues[k] = v; }
          else { current.issues[k].count = Math.max(current.issues[k].count, v.count); }
        }
        // 合併 rules：匯入樣本數更多時保留匯入的統計數據
        for (const [k, v] of Object.entries(imported.rules || {})) {
          if (!current.rules[k]) {
            current.rules[k] = { ...v, imported: true };
          } else {
            const impTotal = v.total || 0;
            const curTotal = current.rules[k].total || 0;
            if (impTotal > curTotal) {
              current.rules[k] = { ...current.rules[k], total: impTotal, rate: v.rate, warning: v.warning || current.rules[k].warning, imported: true };
            } else {
              current.rules[k] = { ...current.rules[k], imported: true };
            }
          }
        }
        // 取兩者中較大的累積統計
        const ic = imported.cumStats || {};
        current.cumStats.totalClosed  = Math.max(current.cumStats.totalClosed  || 0, ic.totalClosed  || 0);
        current.cumStats.totalWins    = Math.max(current.cumStats.totalWins    || 0, ic.totalWins    || 0);
        current.cumStats.totalLosses  = Math.max(current.cumStats.totalLosses  || 0, ic.totalLosses  || 0);
        saveAIMemory(current);
        invalidateLearnCache();
        renderTradeLogPage();
        showToast('AI 記憶已成功匯入並合併', 'success');
      } catch { showToast('匯入失敗：檔案格式不正確', 'error'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ── 策略報表頁面 ─────────────────────────────────────────────── */
function renderReportPage(year, view, month) {
  const container = document.getElementById('report-content');
  if (!container) return;

  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth();
  if (year  == null) year  = state.reportYear  || currentYear;
  if (view  == null) view  = state.reportView  || 'year';
  if (month == null) month = state.reportMonth != null ? state.reportMonth : currentMonth;
  state.reportYear  = year;
  state.reportView  = view;
  state.reportMonth = month;

  const trades   = loadTradeLog();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearEnd   = new Date(year, 11, 31, 23, 59, 59, 999).getTime();
  const yearTrades = trades.filter(t => {
    if (t.status !== 'closed') return false;
    const ts = t.entryTime || t.timestamp || 0;
    return ts >= yearStart && ts <= yearEnd;
  }).sort((a, b) => (a.exitTime || a.entryTime || a.timestamp || 0) - (b.exitTime || b.entryTime || b.timestamp || 0));

  // Year selector options
  const yearsSet = new Set([currentYear]);
  trades.forEach(t => { const ts = t.entryTime || t.timestamp || 0; if (ts) yearsSet.add(new Date(ts).getFullYear()); });
  const yearOpts = [...yearsSet].sort((a, b) => b - a)
    .map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y} 年</option>`).join('');

  // Tabs HTML
  const tabBar = `
    <div style="display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:0">
      <button onclick="renderReportPage(${year},'year',${month})"
        style="padding:8px 18px;font-size:0.85rem;font-weight:600;border:none;border-radius:8px 8px 0 0;cursor:pointer;
               background:${view==='year'?'rgba(0,212,255,.15)':'transparent'};
               color:${view==='year'?'var(--accent)':'var(--text3)'};
               border-bottom:2px solid ${view==='year'?'var(--accent)':'transparent'}">
        📅 年度報告
      </button>
      <button onclick="renderReportPage(${year},'month',${month})"
        style="padding:8px 18px;font-size:0.85rem;font-weight:600;border:none;border-radius:8px 8px 0 0;cursor:pointer;
               background:${view==='month'?'rgba(0,212,255,.15)':'transparent'};
               color:${view==='month'?'var(--accent)':'var(--text3)'};
               border-bottom:2px solid ${view==='month'?'var(--accent)':'transparent'}">
        📆 月度報告
      </button>
    </div>`;

  container.innerHTML = `
    <div class="page-header" style="margin-bottom:16px">
      <div>
        <h1 class="page-title">📊 策略報表</h1>
        <p class="page-subtitle">${view === 'year' ? '全年交易績效統計分析' : '單月交易明細與統計'}</p>
      </div>
      <select class="setting-select" onchange="renderReportPage(parseInt(this.value),'${view}',${month})" style="padding:6px 14px;font-size:0.85rem;min-width:100px">
        ${yearOpts}
      </select>
    </div>
    ${tabBar}
    <div id="rpt-view-content"></div>
  `;

  const viewEl = document.getElementById('rpt-view-content');
  if (view === 'year') {
    viewEl.innerHTML = _rptBuildYearView(yearTrades, year);
  } else {
    viewEl.innerHTML = _rptBuildMonthView(yearTrades, year, month);
  }
}

function _rptBuildYearView(yearTrades, year) {
  const wins    = yearTrades.filter(t => t.outcome === 'tp2');
  const losses  = yearTrades.filter(t => t.outcome === 'sl');
  const beCount = yearTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'be').length;
  const winRate = yearTrades.length > 0 ? (wins.length / yearTrades.length * 100).toFixed(1) : '--';
  const totalR  = yearTrades.reduce((s, t) => s + parseFloat(t.pnlR || 0), 0);
  const avgR    = yearTrades.length > 0 ? (totalR / yearTrades.length) : null;

  const entryDays = {};
  for (const t of yearTrades) {
    if (!t.entryTime) continue;
    const d = new Date(t.entryTime);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    entryDays[k] = (entryDays[k] || 0) + 1;
  }
  const activeDays   = Object.keys(entryDays).length;
  const enteredCount = yearTrades.filter(t => t.entryTime).length;
  const avgDaily     = activeDays > 0 ? (enteredCount / activeDays).toFixed(2) : '--';

  const currentYear  = new Date().getFullYear();
  const chartData    = _rptBuildCumData(yearTrades, year);
  const chartSvg     = _rptBuildChartSVG(chartData, year, currentYear);
  const barSvg       = _rptBuildBarSVG(yearTrades, year);
  const monthlyRows  = _rptBuildMonthly(yearTrades, year);

  const wrColor    = winRate === '--' ? 'var(--text)' : parseFloat(winRate) >= 60 ? 'var(--bull)' : parseFloat(winRate) >= 40 ? 'var(--text)' : 'var(--bear)';
  const totalRColor = totalR > 0 ? 'var(--bull)' : totalR < 0 ? 'var(--bear)' : 'var(--text)';
  const avgRColor   = avgR != null ? (avgR >= 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text)';

  if (yearTrades.length === 0)
    return `<div style="text-align:center;padding:80px 20px;color:var(--text3);font-size:0.95rem">${year} 年尚無已結算的交易記錄</div>`;

  return `
    <div class="rpt-stats">
      <div class="rpt-stat-card">
        <div class="rpt-stat-val" style="color:${wrColor}">${winRate}${winRate !== '--' ? '%' : ''}</div>
        <div class="rpt-stat-lbl">勝率（止盈二）</div>
      </div>
      <div class="rpt-stat-card">
        <div class="rpt-stat-val">${yearTrades.length}</div>
        <div class="rpt-stat-lbl">總交易筆數</div>
      </div>
      <div class="rpt-stat-card">
        <div class="rpt-stat-val">
          <span style="color:var(--bull)">${wins.length}</span><span style="color:var(--text3);font-weight:400;margin:0 3px">/</span><span style="color:var(--bear)">${losses.length}</span>
        </div>
        <div class="rpt-stat-lbl">獲利 / 止損</div>
      </div>
      <div class="rpt-stat-card">
        <div class="rpt-stat-val">${avgDaily}</div>
        <div class="rpt-stat-lbl">平均每日入場</div>
      </div>
      <div class="rpt-stat-card">
        <div class="rpt-stat-val" style="color:${avgRColor}">${avgR != null ? (avgR >= 0 ? '+' : '') + avgR.toFixed(2) + ' R' : '--'}</div>
        <div class="rpt-stat-lbl">平均每筆獲利</div>
      </div>
      <div class="rpt-stat-card">
        <div class="rpt-stat-val" style="color:${totalRColor}">${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)} R</div>
        <div class="rpt-stat-lbl">全年總獲利</div>
      </div>
    </div>

    <div class="rpt-chart-card">
      <div class="rpt-chart-title">帳戶成長曲線（累計 R，從零起算）</div>
      <div class="rpt-chart-wrap">${chartSvg}</div>
    </div>

    <div class="rpt-chart-card">
      <div class="rpt-chart-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>月度獲利 / 止損分佈</span>
        <span style="font-size:0.75rem;font-weight:400;color:var(--text3)">
          <span style="display:inline-block;width:8px;height:8px;background:var(--bull);border-radius:2px;margin-right:3px"></span>獲利(tp2)
          <span style="display:inline-block;width:8px;height:8px;background:rgba(148,163,184,0.4);border-radius:2px;margin:0 3px 0 8px"></span>保本
          <span style="display:inline-block;width:8px;height:8px;background:var(--bear);border-radius:2px;margin:0 3px 0 8px"></span>止損
        </span>
      </div>
      <div class="rpt-chart-wrap">${barSvg}</div>
    </div>

    <div class="rpt-monthly-card">
      <div class="rpt-chart-title">月度明細</div>
      <div style="overflow-x:auto">
      <table class="rpt-month-tbl">
        <thead><tr>
          <th style="text-align:left">月份</th>
          <th>筆數</th><th>勝率</th><th>獲利/保本/止損</th><th>月盈虧</th><th>累計 R</th>
        </tr></thead>
        <tbody>${monthlyRows}</tbody>
      </table>
      </div>
    </div>`;
}

function _rptBuildMonthView(yearTrades, year, month) {
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const today = new Date();

  // Month selector tabs
  const monthTabs = monthNames.map((mn, m) => {
    const mTrades = yearTrades.filter(t => {
      const ts = t.exitTime || t.entryTime || t.timestamp || 0;
      return ts >= new Date(year, m, 1).getTime() && ts <= new Date(year, m + 1, 0, 23, 59, 59, 999).getTime();
    });
    const hasTrades = mTrades.length > 0;
    const isCur = today.getFullYear() === year && today.getMonth() === m;
    const isActive = m === month;
    return `<button onclick="renderReportPage(${year},'month',${m})"
      style="padding:5px 10px;font-size:0.78rem;font-weight:${isActive?'700':'500'};border:1px solid ${isActive?'var(--accent)':'rgba(255,255,255,.1)'};
             border-radius:6px;cursor:pointer;background:${isActive?'rgba(0,212,255,.12)':'transparent'};
             color:${isActive?'var(--accent)':hasTrades?'var(--text)':'var(--text3)'};white-space:nowrap">
      ${mn}${isCur ? ' ●' : ''}
    </button>`;
  }).join('');

  const mStart  = new Date(year, month, 1).getTime();
  const mEnd    = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
  const mTrades = yearTrades.filter(t => {
    const ts = t.exitTime || t.entryTime || t.timestamp || 0;
    return ts >= mStart && ts <= mEnd;
  }).sort((a, b) => (a.exitTime || a.entryTime || a.timestamp || 0) - (b.exitTime || b.entryTime || b.timestamp || 0));

  const mWins   = mTrades.filter(t => t.outcome === 'tp2');
  const mLosses = mTrades.filter(t => t.outcome === 'sl');
  const mBE     = mTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'be');
  const mR      = mTrades.reduce((s, t) => s + parseFloat(t.pnlR || 0), 0);
  const mWR     = mTrades.length ? (mWins.length / mTrades.length * 100).toFixed(1) : '--';
  const mAvgR   = mTrades.length ? mR / mTrades.length : null;

  const wrColor  = mWR === '--' ? 'var(--text)' : parseFloat(mWR) >= 60 ? 'var(--bull)' : parseFloat(mWR) >= 40 ? 'var(--text)' : 'var(--bear)';
  const mRColor  = mR > 0 ? 'var(--bull)' : mR < 0 ? 'var(--bear)' : 'var(--text)';

  const statsHtml = mTrades.length === 0
    ? `<div style="text-align:center;padding:40px;color:var(--text3);font-size:0.9rem">${year} 年 ${monthNames[month]} 無已結算的交易記錄</div>`
    : `<div class="rpt-stats" style="margin-bottom:16px">
        <div class="rpt-stat-card">
          <div class="rpt-stat-val" style="color:${wrColor}">${mWR}${mWR !== '--' ? '%' : ''}</div>
          <div class="rpt-stat-lbl">勝率（止盈二）</div>
        </div>
        <div class="rpt-stat-card">
          <div class="rpt-stat-val">${mTrades.length}</div>
          <div class="rpt-stat-lbl">總交易筆數</div>
        </div>
        <div class="rpt-stat-card">
          <div class="rpt-stat-val">
            <span style="color:var(--bull)">${mWins.length}</span>
            <span style="color:var(--text3);font-weight:400;margin:0 3px">/</span>
            <span style="color:rgba(148,163,184,0.7)">${mBE.length}</span>
            <span style="color:var(--text3);font-weight:400;margin:0 3px">/</span>
            <span style="color:var(--bear)">${mLosses.length}</span>
          </div>
          <div class="rpt-stat-lbl">獲利 / 保本 / 止損</div>
        </div>
        <div class="rpt-stat-card">
          <div class="rpt-stat-val" style="color:${mRColor}">${mR >= 0 ? '+' : ''}${mR.toFixed(2)} R</div>
          <div class="rpt-stat-lbl">月度總獲利</div>
        </div>
        <div class="rpt-stat-card">
          <div class="rpt-stat-val" style="color:${mAvgR != null ? (mAvgR >= 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text)'}">
            ${mAvgR != null ? (mAvgR >= 0 ? '+' : '') + mAvgR.toFixed(2) + ' R' : '--'}
          </div>
          <div class="rpt-stat-lbl">平均每筆</div>
        </div>
      </div>`;

  const tradeRows = mTrades.length === 0 ? '' : mTrades.map(t => {
    const isLong  = t.direction === 'long';
    const dirClr  = isLong ? 'var(--bull)' : 'var(--bear)';
    const dirTxt  = isLong ? '▲ 多' : '▼ 空';
    const outMap  = { tp2:'止盈二 ✅', tp1:'止盈一 ✅', sl:'止損 ❌', be:'保本 ➡️' };
    const outTxt  = outMap[t.outcome] || '—';
    const pnl     = parseFloat(t.pnlR || 0);
    const pnlClr  = pnl > 0 ? 'var(--bull)' : pnl < 0 ? 'var(--bear)' : 'var(--text3)';
    const entryDt = t.entryTime ? new Date(t.entryTime) : null;
    const exitDt  = t.exitTime  ? new Date(t.exitTime)  : null;
    const fmtDt   = d => d ? `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` : '—';
    return `<tr style="cursor:pointer" onclick="showTradeDetail('${t.id}')">
      <td style="color:${dirClr};font-weight:600">${dirTxt}</td>
      <td style="font-weight:600">${t.symbol || '—'}</td>
      <td style="font-size:0.78rem;color:var(--text2)">${fmtDt(entryDt)}</td>
      <td style="font-size:0.78rem;color:var(--text2)">${fmtDt(exitDt)}</td>
      <td>${outTxt}</td>
      <td style="font-weight:700;color:${pnlClr}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} R</td>
    </tr>`;
  }).join('');

  const tradeTable = mTrades.length > 0 ? `
    <div class="rpt-monthly-card" style="margin-top:16px">
      <div class="rpt-chart-title">${year} 年 ${monthNames[month]} 交易明細（${mTrades.length} 筆，點擊查看詳情）</div>
      <div style="overflow-x:auto">
        <table class="rpt-month-tbl">
          <thead><tr>
            <th>方向</th><th style="text-align:left">幣種</th><th>進場時間</th><th>出場時間</th><th>結果</th><th>盈虧</th>
          </tr></thead>
          <tbody>${tradeRows}</tbody>
        </table>
      </div>
    </div>` : '';

  return `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">${monthTabs}</div>
    ${statsHtml}
    ${tradeTable}`;
}

function _rptBuildCumData(trades, year) {
  const isLeap = new Date(year, 1, 29).getDate() === 29;
  const daysInYear = isLeap ? 366 : 365;
  const yearStart = new Date(year, 0, 1).getTime();
  const now = new Date();
  const isCurrentYear = now.getFullYear() === year;
  const lastDay = isCurrentYear
    ? Math.min(daysInYear, Math.ceil((Date.now() - yearStart) / 86400000) + 1)
    : daysInYear;

  // Map exit date → total pnlR that day
  const byDay = {};
  for (const t of trades) {
    const ts = t.exitTime || t.entryTime || t.timestamp || 0;
    if (!ts) continue;
    const d = new Date(ts);
    if (d.getFullYear() !== year) continue;
    const key = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - yearStart) / 86400000);
    byDay[key] = (byDay[key] || 0) + parseFloat(t.pnlR || 0);
  }

  const data = [];
  let cum = 0;
  for (let day = 0; day < lastDay; day++) {
    if (byDay[day] !== undefined) cum += byDay[day];
    data.push({ day, cumR: cum });
  }
  return data;
}

function _rptBuildChartSVG(data, year, currentYear) {
  const W = 760, H = 180, PL = 48, PR = 16, PT = 12, PB = 28;
  const CW = W - PL - PR, CH = H - PT - PB;
  const isLeap = new Date(year, 1, 29).getDate() === 29;
  const daysInYear = isLeap ? 366 : 365;

  if (data.length < 2) return `<div style="text-align:center;padding:40px;color:var(--text3);font-size:0.85rem">本年尚無足夠數據繪製圖表</div>`;

  const vals = data.map(d => d.cumR);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = maxV - minV || 1;
  const lastDay = data[data.length - 1].day || 1;

  const xS = day  => PL + (day / lastDay) * CW;
  const yS = v    => PT + CH - ((v - minV) / range) * CH;
  const y0 = yS(0);

  // Polyline
  const pts = data.map(d => `${xS(d.day).toFixed(1)},${yS(d.cumR).toFixed(1)}`).join(' ');

  // Area polygon
  const firstX = xS(data[0].day).toFixed(1);
  const lastX  = xS(data[data.length - 1].day).toFixed(1);
  const areaPts = `${firstX},${y0.toFixed(1)} ${pts} ${lastX},${y0.toFixed(1)}`;
  const finalVal = vals[vals.length - 1];
  const lineCol  = finalVal >= 0 ? '#00e676' : '#ff1744';

  // Month grid lines
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const monthGrids = monthNames.map((m, i) => {
    const dayOfYear = [0,31,59,90,120,151,181,212,243,273,304,334][i] + (i > 1 && isLeap ? 1 : 0);
    const x = xS(dayOfYear);
    return `<line x1="${x.toFixed(1)}" y1="${PT}" x2="${x.toFixed(1)}" y2="${PT+CH}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <text x="${(x+3).toFixed(1)}" y="${PT+CH+16}" font-size="8.5" fill="rgba(148,163,184,0.6)">${m}</text>`;
  }).join('');

  // Y-axis labels (4 levels)
  const yLevels = [minV, minV + range*0.25, minV + range*0.5, minV + range*0.75, maxV];
  const yGrid = yLevels.map(v => {
    const y = yS(v).toFixed(1);
    const sign = v > 0 ? '+' : '';
    return `<line x1="${PL}" y1="${y}" x2="${PL+CW}" y2="${y}" stroke="rgba(255,255,255,0.04)" stroke-width="1" stroke-dasharray="3,5"/>
      <text x="${PL-4}" y="${parseFloat(y)+3.5}" font-size="8.5" fill="rgba(148,163,184,0.55)" text-anchor="end">${sign}${v.toFixed(1)}</text>`;
  }).join('');

  // Tooltip-friendly last point marker
  const lx = xS(data[data.length-1].day).toFixed(1);
  const ly = yS(finalVal).toFixed(1);
  const labelAnchor = parseFloat(lx) > W - 80 ? 'end' : 'start';
  const labelOff = labelAnchor === 'end' ? -7 : 7;

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">
    <defs>
      <linearGradient id="rptGrad${year}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${lineCol}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${lineCol}" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    ${yGrid}
    ${monthGrids}
    <line x1="${PL}" y1="${y0.toFixed(1)}" x2="${PL+CW}" y2="${y0.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>
    <polygon points="${areaPts}" fill="url(#rptGrad${year})"/>
    <polyline points="${pts}" fill="none" stroke="${lineCol}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="4" fill="${lineCol}" stroke="var(--bg)" stroke-width="2"/>
    <text x="${parseFloat(lx)+labelOff}" y="${parseFloat(ly)-7}" font-size="10" fill="${lineCol}" font-weight="600" text-anchor="${labelAnchor}">${finalVal >= 0 ? '+' : ''}${finalVal.toFixed(2)} R</text>
  </svg>`;
}

function _rptBuildBarSVG(trades, year) {
  const W = 760, H = 130, PL = 28, PR = 12, PT = 14, PB = 24;
  const CW = W - PL - PR, CH = H - PT - PB;
  const months = ['1','2','3','4','5','6','7','8','9','10','11','12'];
  const yearStart = new Date(year, 0, 1).getTime();

  // Per-month counts
  const data = months.map((_, m) => {
    const mStart = new Date(year, m, 1).getTime();
    const mEnd   = new Date(year, m + 1, 0, 23, 59, 59, 999).getTime();
    const mt = trades.filter(t => { const ts = t.exitTime || t.entryTime || t.timestamp || 0; return ts >= mStart && ts <= mEnd; });
    return {
      win: mt.filter(t => t.outcome === 'tp2').length,
      be:  mt.filter(t => t.outcome === 'tp1' || t.outcome === 'be').length,
      sl:  mt.filter(t => t.outcome === 'sl').length,
    };
  });

  const maxVal = Math.max(1, ...data.map(d => d.win + d.be + d.sl));
  const slotW  = CW / 12;
  const barW   = Math.max(4, slotW * 0.55);
  const gap    = (slotW - barW) / 2;

  const today = new Date();
  const isCurrentYear = today.getFullYear() === year;

  let bars = '';
  data.forEach((d, m) => {
    const x = PL + m * slotW + gap;
    const isFut = isCurrentYear && new Date(year, m) > today;
    const total = d.win + d.be + d.sl;
    if (total === 0) {
      bars += `<text x="${(x + barW/2).toFixed(1)}" y="${PT + CH - 2}" font-size="8" fill="rgba(71,85,105,0.5)" text-anchor="middle">·</text>`;
    } else {
      // Stacked: win (bottom), be (middle), sl (top)
      const winH = (d.win / maxVal) * CH;
      const beH  = (d.be  / maxVal) * CH;
      const slH  = (d.sl  / maxVal) * CH;
      const baseY = PT + CH;
      const alpha = isFut ? '0.3' : '1';
      if (winH > 0) bars += `<rect x="${x.toFixed(1)}" y="${(baseY - winH).toFixed(1)}" width="${barW.toFixed(1)}" height="${winH.toFixed(1)}" fill="var(--bull)" opacity="${alpha}" rx="2"/>`;
      if (beH  > 0) bars += `<rect x="${x.toFixed(1)}" y="${(baseY - winH - beH).toFixed(1)}" width="${barW.toFixed(1)}" height="${beH.toFixed(1)}" fill="rgba(148,163,184,0.4)" opacity="${alpha}" rx="2"/>`;
      if (slH  > 0) bars += `<rect x="${x.toFixed(1)}" y="${(baseY - winH - beH - slH).toFixed(1)}" width="${barW.toFixed(1)}" height="${slH.toFixed(1)}" fill="var(--bear)" opacity="${alpha}" rx="2"/>`;
      // Count label on top
      const topY = baseY - winH - beH - slH - 2;
      if (topY > PT + 2) bars += `<text x="${(x + barW/2).toFixed(1)}" y="${topY.toFixed(1)}" font-size="8" fill="rgba(148,163,184,0.7)" text-anchor="middle">${total}</text>`;
    }
    // Month label
    bars += `<text x="${(x + barW/2).toFixed(1)}" y="${PT + CH + 14}" font-size="8.5" fill="rgba(148,163,184,0.6)" text-anchor="middle">${months[m]}月</text>`;
  });

  // Y-axis reference lines
  const yLines = [0.25, 0.5, 0.75, 1].map(pct => {
    const v = Math.round(maxVal * pct);
    const y = (PT + CH * (1 - pct)).toFixed(1);
    return `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="rgba(255,255,255,0.04)" stroke-width="1" stroke-dasharray="3,5"/>
      <text x="${PL - 3}" y="${parseFloat(y) + 3}" font-size="8" fill="rgba(148,163,184,0.4)" text-anchor="end">${v}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">
    ${yLines}${bars}
  </svg>`;
}

function _rptBuildMonthly(trades, year) {
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const today = new Date();
  let cumR = 0;
  return monthNames.map((mName, m) => {
    const mStart = new Date(year, m, 1).getTime();
    const mEnd   = new Date(year, m + 1, 0, 23, 59, 59, 999).getTime();
    const mt = trades.filter(t => {
      const ts = t.exitTime || t.entryTime || t.timestamp || 0;
      return ts >= mStart && ts <= mEnd;
    });
    const mWin = mt.filter(t => t.outcome === 'tp2').length;
    const mBE  = mt.filter(t => t.outcome === 'tp1' || t.outcome === 'be').length;
    const mSL  = mt.filter(t => t.outcome === 'sl').length;
    const mR   = mt.reduce((s, t) => s + parseFloat(t.pnlR || 0), 0);
    cumR += mR;
    const mWR   = mt.length ? Math.round(mWin / mt.length * 100) : null;
    const isCur = today.getFullYear() === year && today.getMonth() === m;
    const isFut = new Date(year, m) > today;
    const mRC   = mR > 0 ? 'var(--bull)' : mR < 0 ? 'var(--bear)' : 'var(--text3)';
    const cRC   = cumR > 0 ? 'var(--bull)' : cumR < 0 ? 'var(--bear)' : 'var(--text3)';
    const wrStyle = mWR != null ? (mWR >= 60 ? 'color:var(--bull)' : mWR >= 40 ? '' : 'color:var(--bear)') : '';
    const wbLabel = mt.length > 0
      ? `<span style="color:var(--bull)">${mWin}</span><span style="color:var(--text3)"> / </span><span style="color:rgba(148,163,184,0.6)">${mBE}</span><span style="color:var(--text3)"> / </span><span style="color:var(--bear)">${mSL}</span>`
      : '—';
    return `<tr style="${isFut ? 'opacity:0.3;' : ''}${isCur ? 'background:rgba(0,212,255,0.04);' : ''}">
      <td style="font-weight:600">${mName}${isCur ? ' <span style="font-size:0.68rem;color:var(--blue)">本月</span>' : ''}</td>
      <td>${mt.length > 0 ? mt.length : '—'}</td>
      <td style="${wrStyle}">${mWR != null ? mWR + '%' : '—'}</td>
      <td>${wbLabel}</td>
      <td style="color:${mRC}">${mt.length > 0 ? (mR >= 0 ? '+' : '') + mR.toFixed(2) + ' R' : '—'}</td>
      <td style="color:${cRC};font-weight:600">${cumR >= 0 ? '+' : ''}${cumR.toFixed(2)} R</td>
    </tr>`;
  }).join('');
}

/* ── 交易詳情彈窗 ─────────────────────────────────────────────── */
function showTradeDetail(id) {
  const trade = loadTradeLog().find(t => t.id === id);
  if (!trade) return;

  const isLong    = trade.direction === 'long';
  const dirLabel  = isLong ? '▲ 做多' : '▼ 做空';
  const dirColor  = isLong ? 'var(--bull)' : 'var(--bear)';
  const p         = trade.entry || 1;
  const fmt       = v => v != null ? fmtPrice(v) : '--';
  const pctStr    = (a, b) => {
    const d = ((b - a) / Math.abs(a) * 100);
    return (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
  };

  const outcomeMap = { tp2:'止盈二 ✅', tp1:'止盈一 ✅', sl:'止損 ❌', be:'保本 ➡️' };
  const outcomeHtml = trade.outcome
    ? `<span class="tl-badge tl-badge-${trade.outcome}">${outcomeMap[trade.outcome]}</span>`
    : `<span class="tl-badge tl-badge-open">進行中</span>`;

  const pnlNum  = parseFloat(trade.pnlR);
  const pnlHtml = trade.pnlR != null
    ? `<span class="${pnlNum > 0 ? 'tl-pnl-pos' : pnlNum < 0 ? 'tl-pnl-neg' : 'tl-pnl-zero'}">${pnlNum > 0 ? '+' : ''}${trade.pnlR} R</span>`
    : '--';

  const conf      = trade.conf || Math.min(90, trade.score || 50);
  const confColor = conf >= 75 ? 'var(--bull)' : conf >= 60 ? '#ff6d00' : 'var(--text3)';

  const reasons = (trade.entryReasons?.length ? trade.entryReasons : (trade.entryReason || '').split('，')).filter(Boolean);
  const reasonsHtml = reasons.length
    ? reasons.map(r => `<div class="td-reason-item">• ${r}</div>`).join('')
    : '<div class="td-reason-item" style="color:var(--text3)">無詳細原因（快速估算）</div>';

  let learnHtml = '';
  if (trade.analysis && (trade.outcome === 'sl' || trade.outcome === 'be')) {
    const issues = trade.analysis.issues || [];
    const suggs  = trade.analysis.suggestions || [];
    learnHtml = `
      <div class="td-section td-learn">
        <div class="td-section-title">📚 改進分析</div>
        ${issues.map((iss, i) => `
          <div class="td-learn-item">
            <div class="td-learn-issue">⚠️ ${iss}</div>
            ${suggs[i] ? `<div class="td-learn-sugg">→ ${suggs[i]}</div>` : ''}
          </div>
        `).join('')}
      </div>`;
  }

  const html = `
    <div class="td-header">
      <span class="td-symbol">${trade.symbol.replace('/USDT','')}<span style="color:var(--text3);font-size:0.85rem">/USDT</span></span>
      <span class="td-dir" style="color:${dirColor}">${dirLabel}</span>
      <button class="td-close-btn" onclick="closeTradeModal()">✕</button>
    </div>
    <div class="td-conf-row">
      <span style="color:var(--text3);font-size:0.78rem">風控分</span>
      <div class="td-conf-bar"><div style="width:${conf}%;background:${confColor};height:100%;border-radius:4px;transition:width .3s"></div></div>
      <span style="color:${confColor};font-weight:700">${conf}%</span>
      ${conf >= 85 ? '<span style="font-size:0.7rem;color:#22c55e;margin-left:4px">✓ 高信心</span>' : conf >= 60 ? '<span style="font-size:0.7rem;color:#22c55e;margin-left:4px">✓ 達標</span>' : '<span style="font-size:0.7rem;color:#ef4444;margin-left:4px">✗ 未達標</span>'}
    </div>
    <div class="td-grid">
      <div class="td-cell" style="grid-column:span 2">
        <div class="td-cell-lbl">信號時間</div>
        <div class="td-cell-val" style="font-size:0.83rem">${fmtDateTime(trade.timestamp)}</div>
      </div>
      <div class="td-cell" style="grid-column:span 2">
        <div class="td-cell-lbl">進場確認</div>
        <div class="td-cell-val" style="font-size:0.83rem;color:${trade.entryTime ? 'var(--bull)' : 'var(--text3)'}">${trade.entryTime ? fmtDateTime(trade.entryTime) : '—'}</div>
      </div>
      <div class="td-cell" style="grid-column:span 2">
        <div class="td-cell-lbl">結束時間</div>
        <div class="td-cell-val" style="font-size:0.83rem">${trade.exitTime ? fmtDateTime(trade.exitTime) : '進行中'}</div>
      </div>
      <div class="td-cell">
        <div class="td-cell-lbl">進場價</div>
        <div class="td-cell-val">${fmt(trade.entry)}</div>
      </div>
      <div class="td-cell">
        <div class="td-cell-lbl">止損</div>
        <div class="td-cell-val" style="color:var(--bear)">${fmt(trade.sl)}<span class="td-pct">${trade.entry && trade.sl ? pctStr(trade.entry, trade.sl) : ''}</span></div>
      </div>
      <div class="td-cell">
        <div class="td-cell-lbl">止盈一</div>
        <div class="td-cell-val" style="color:var(--bull)">${fmt(trade.tp1)}<span class="td-pct">${trade.entry && trade.tp1 ? pctStr(trade.entry, trade.tp1) : ''}</span></div>
      </div>
      <div class="td-cell">
        <div class="td-cell-lbl">止盈二</div>
        <div class="td-cell-val" style="color:#22c55e">${fmt(trade.tp2)}<span class="td-pct">${trade.entry && trade.tp2 ? pctStr(trade.entry, trade.tp2) : ''}</span></div>
      </div>
      <div class="td-cell">
        <div class="td-cell-lbl">風控分</div>
        <div class="td-cell-val" style="color:${confColor};font-weight:700">${conf}%</div>
      </div>
      <div class="td-cell">
        <div class="td-cell-lbl">交易結果</div>
        <div class="td-cell-val">${outcomeHtml}</div>
      </div>
      <div class="td-cell">
        <div class="td-cell-lbl">盈虧</div>
        <div class="td-cell-val">${pnlHtml}</div>
      </div>
    </div>
    <div class="td-section">
      <div class="td-section-title">📍 進場理由</div>
      ${reasonsHtml}
    </div>
    ${learnHtml}
  `;

  let overlay = document.getElementById('trade-detail-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'trade-detail-overlay';
    overlay.className = 'td-overlay';
    overlay.innerHTML = `<div class="td-modal" id="trade-detail-modal"></div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeTradeModal(); });
    document.body.appendChild(overlay);
  }
  document.getElementById('trade-detail-modal').innerHTML = html;
  overlay.classList.add('td-open');
}

function closeTradeModal() {
  const overlay = document.getElementById('trade-detail-overlay');
  if (overlay) overlay.classList.remove('td-open');
}

function fmtRelTime(ts) {
  if (!ts) return '--';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return '剛剛';
  if (mins < 60) return `${mins}分鐘前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}小時前`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return '昨天';
  return `${days}天前`;
}

function fmtDateTime(ts) {
  if (!ts) return '--';
  const d    = new Date(ts);
  const mm   = d.getMonth() + 1;
  const dd   = d.getDate();
  const h24  = d.getHours();
  const mi   = String(d.getMinutes()).padStart(2, '0');
  const ampm = h24 < 12 ? '上午' : '下午';
  const h12  = h24 % 12 || 12;
  return `${mm}月${dd}日 ${ampm} ${h12}:${mi}`;
}

/* ── 信號偵測與通知發送 ──────────────────────────────────────── */
const SIGNAL_CACHE_KEY = 'csp_signal_cache';

async function checkAndSendAlerts(data) {
  const s = loadSettings();
  if (!s.notifBrowser && !s.notifTelegram) return;

  // 宏觀快取不存在時自動補充（用戶未瀏覽幣種詳情頁時 _macroCache 為 null）
  if (!_macroCache) {
    try {
      const [fg, gm] = await Promise.all([fetchFearGreed(), fetchGlobalMarket()]);
      if (fg || gm) _macroCache = { ...(gm || {}), fg };
    } catch (e) { /* 若 fetch 失敗繼續執行，後續用 null 處理 */ }
  }

  const bullThr = s.notifBullScore || 65;
  const bearThr = s.notifBearScore || 35;
  const prev    = JSON.parse(localStorage.getItem(SIGNAL_CACHE_KEY) || '{}');
  const next    = { ...prev }; // 保留舊記錄，只更新有訊號的幣
  const now     = Date.now();

  for (const coin of data) {
    const isLong  = coin.score >= bullThr && (coin.trend === '強勢看漲' || coin.trend === '看漲');
    const isShort = coin.score <= bearThr && (coin.trend === '強勢看跌' || coin.trend === '看跌');
    if (!isLong && !isShort) continue; // 訊號消失，保留快取讓冷卻期繼續計算

    const dir    = isLong ? 'long' : 'short';
    const cached = prev[coin.symbol];

    // 同一方向且在冷卻期內（2小時）→ 跳過，不重複通知
    if (cached && cached.dir === dir && (now - (cached.sentAt || 0)) < SIGNAL_COOLDOWN) continue;

    // recordSignalsFromScan 已為此幣種/方向建立交易記錄 → 不重複通知
    // 但若掛單存在卻未標記 telegramSent（掃描建立時推送失敗），補發一次
    try {
      const _tlog = loadTradeLog();
      const _existTrade = _tlog.find(t => t.symbol === coin.symbol && t.direction === dir
        && (t.status === 'open' || t.status === 'pending'));
      if (_existTrade) {
        // 若掛單從未成功推送 Telegram（建立時推送失敗），補發一次
        if (!_existTrade.telegramSent && !_existTrade.pendingNotify) {
          try {
            const _ns = loadSettings();
            if (_ns.notifTelegram && _ns.tgToken && _ns.tgChatId) {
              const _rsTgSetup = Object.assign({}, _existTrade, _existTrade._notifyRisk || {});
              sendTelegramMessage(_ns.tgToken, _ns.tgChatId,
                buildTelegramText(coin, dir, _rsTgSetup, _macroCache,
                  window.location.origin + window.location.pathname));
              const _rsTlog = loadTradeLog();
              const _rsIdx = _rsTlog.findIndex(t => t.id === _existTrade.id);
              if (_rsIdx >= 0) { _rsTlog[_rsIdx].telegramSent = true; saveTradeLog(_rsTlog); }
            }
          } catch(_rse) {}
        }
        next[coin.symbol] = { dir, sentAt: now };
        continue;
      }
    } catch(_e) {}

    // 準備 setup（優先用快取，fallback 補上 macro+AI 扣分的完整版本）
    let notifSetup = _tradeSetupCache[coin.symbol] || null;
    // 快取缺少進場價格資料（監控更新覆蓋）→ 重新計算
    if (!notifSetup || !notifSetup.entry) {
      notifSetup = computeSimpleSetup(coin, isLong);
      if (_macroCache) {
        try {
          const fg = _macroCache.fg;
          const gm = _macroCache;
          const wb = computeWeeklyAIBias(fg, gm);
          const tb = computeTodayAIBias(fg, gm);
          notifSetup.weeklyBias    = wb.biasLabel;
          notifSetup.weeklyConf    = wb.conf;
          notifSetup.weeklyRangeMode = wb.rangeMode;
          notifSetup.todayBias     = tb.biasLabel;
          notifSetup.todayConf     = tb.conf;
          notifSetup.todayRangeMode = tb.rangeMode;
          notifSetup.rangeMacroDir = computeMacroNetDir(fg, gm);  // 給 Telegram 判斷謹慎操作
          // flipRisks within 8h
          const nowMs = Date.now();
          notifSetup.flipRisks = (tb.highEvs || []).filter(ev => {
            const m = (ev.eventTime.getTime() - nowMs) / 60000;
            return m > -60 && m < 480;
          }).map(ev => {
            const m = (ev.eventTime.getTime() - nowMs) / 60000;
            const tl = m < 0 ? '剛公布' : m < 60 ? `${Math.round(m)}分鐘後` : `${(m / 60).toFixed(1)}小時後`;
            const riskDesc = isLong
              ? (ev.bearIf ? `若 ${ev.bearIf.slice(0, 50)}，多頭可能轉空` : '高影響數據，方向待確認')
              : (ev.bullIf ? `若 ${ev.bullIf.slice(0, 50)}，空頭可能轉多` : '高影響數據，方向待確認');
            return { name: ev.name, timeLabel: tl, riskDesc, aiPred: ev.aiPred, aiConf: ev.aiConf };
          });
          // AI 趨勢扣分
          const _wkCL = (wb?.conf || 50) < 70;
          const weeklyAligned = (isLong && wb.bias.includes('bull')) || (!isLong && wb.bias.includes('bear'));
          const weeklyOpposed = !_wkCL && !weeklyAligned && wb.bias !== 'neutral';
          const weeklyNeutral = wb.bias === 'neutral';
          const todayAligned  = (isLong && tb.bias.includes('bull')) || (!isLong && tb.bias.includes('bear'));
          const todayOpposed  = !todayAligned && tb.bias !== 'neutral';
          const todayNeutral  = tb.bias === 'neutral';
          let aiTrendPen = 0;
          const aiTrendReasons = [];
          if (_wkCL) {
            aiTrendReasons.push(`本週AI預測信心值 ${wb.conf||50}% 未達 70%，略過週預測`);
          } else if (weeklyOpposed) {
            const pen = wb.bias.includes('strong') ? 8 : 5;
            aiTrendPen += pen;
            aiTrendReasons.push(`本週AI預測 ${wb.biasLabel}，與${isLong ? '做多' : '做空'}逆向，扣 ${pen}%`);
          } else if (weeklyNeutral) {
            aiTrendPen += 2;
            aiTrendReasons.push(`本週AI預測震盪中性，方向不明，扣 2%`);
          }
          if (todayOpposed) {
            aiTrendPen += 5;
            aiTrendReasons.push(`今日AI預測 ${tb.biasLabel}，${isLong ? '多頭' : '空頭'}今日逆風，扣 5%`);
          } else if (todayNeutral) {
            aiTrendPen += 1;
            aiTrendReasons.push(`今日AI預測中性，方向不確定，扣 1%`);
          }
          // 總體市場扣分（簡化版，與 buildTradeSetup 邏輯一致）
          const fgVal  = fg ? parseInt(fg.value || '50') : 50;
          const chgVal = gm?.marketCapChange || 0;
          const domVal = gm?.btcDominance   || 50;
          let against = 0;
          const macroReasons = [];
          if (isLong) {
            if (chgVal < -2)  { against++;    macroReasons.push(`大盤下跌 ${chgVal.toFixed(1)}%`); }
            if (domVal > 58)  { against++;    macroReasons.push(`BTC主導率偏高 ${domVal.toFixed(1)}%`); }
            if (fgVal  < 30)  { against++;    macroReasons.push(`市場恐慌（F&G ${fgVal}）`); }
            if (fgVal  > 75)  { against += 0.5; macroReasons.push(`市場過熱（F&G ${fgVal}）`); }
          } else {
            if (chgVal > 2)   { against++;    macroReasons.push(`大盤上漲 ${chgVal.toFixed(1)}%`); }
            if (domVal < 44)  { against++;    macroReasons.push(`BTC主導率偏低 ${domVal.toFixed(1)}%`); }
            if (fgVal  > 70)  { against++;    macroReasons.push(`市場貪婪（F&G ${fgVal}）`); }
            if (fgVal  < 25)  { against += 0.5; macroReasons.push(`市場極度恐慌（F&G ${fgVal}）`); }
          }
          let macroPen = against >= 3 ? 18 : against >= 2 ? 12 : against >= 1 ? 5 : 0;
          // 宏觀中性或無資料補扣
          if (!gm) {
            macroPen += 3;  // 無資料
          } else if (against === 0) {
            const _bdN = computeMacroNetDir(fg, gm);
            if (_bdN === 'neutral') macroPen += 4;  // 宏觀中性
          }
          // 資金流動事件扣分
          let cfPen = 0;
          const cfReasons = [];
          try {
            const _cfN = getCapitalFlowBias();
            for (const ev of _cfN.events) {
              if (isLong  && ev.bear > 0) { const p = ev.bear >= 1.2 ? 5 : 3; cfPen += p; cfReasons.push(`${ev.name}：資金流出逆風 -${p}%`); }
              else if (!isLong && ev.bull > 0) { const p = ev.bull >= 1.2 ? 5 : 3; cfPen += p; cfReasons.push(`${ev.name}：資金流入逆風 -${p}%`); }
              else if (ev.bull === 0 && ev.bear === 0) { cfPen += 2; cfReasons.push(`${ev.name}：資金方向中性 -2%`); }
            }
            cfPen = Math.min(10, cfPen);
          } catch(_e) {}
          notifSetup.macroOpposePenalty = macroPen;
          notifSetup.aiTrendPenalty     = aiTrendPen;
          notifSetup.aiTrendReasons     = aiTrendReasons;
          notifSetup.macroReasons       = macroReasons;
          notifSetup.capitalFlowPenalty = cfPen;
          notifSetup.capitalFlowReasons = cfReasons;
          // 重新計算 learnPenalty（快取可能過期）
          try {
            const _rsi = parseFloat(coin.rsi) || 50, _adx = parseFloat(coin.adx) || 20;
            const _lrN = applyLearnAdjustment(dir, _rsi, _adx, {
              slType: 'atr', skipAdxRule: true,
              macdHist: parseFloat(coin.macdHist) || 0,
              volWeak: (coin.volumeStrength||'') === '低' || String(coin.volumeStrength||'').includes('弱'),
              h4Aligned: isLong ? (coin.h4Signal||'').includes('bull') : (coin.h4Signal||'').includes('bear'),
              weeklyAgainst: isLong ? (coin.weeklySignal||'').includes('bear') : (coin.weeklySignal||'').includes('bull'),
              h1Aligned: isLong ? !!(coin.h1Signal||'').includes('bull') : !!(coin.h1Signal||'').includes('bear'),
            });
            notifSetup.learnPenalty = _lrN.penalty || 0;
          } catch(_lrE) {}
          // 風控分 = 100 - 止損風控 - 風險評估扣分（比例制）
          const _chkRiskPen = calcRiskPenalty(notifSetup.riskScore || 0);
          notifSetup.riskPenalty = _chkRiskPen;
          notifSetup.conf = Math.max(0, Math.round(100 - Math.min(45, notifSetup.learnPenalty || 0)) - _chkRiskPen);
        } catch (e) { /* macro enrichment failed, keep simple conf */ }
      }
    }

    // ── 快速 SQ 評分（使用掃描快取 + 同步因子，盡量與 recordSignalsFromScan 一致）──
    // 每次都重新計算，避免快取中的舊等級（S→A 條件改變後）導致長線單建立後立即降格
    {
      try {
        let _qSq = 0;
        // ① 硬性條件 4H+15m（不符合不計分），其餘時框同向加分
        const _qH4  = isLong ? (coin.h4Signal ||'').includes('bull') : (coin.h4Signal ||'').includes('bear');
        const _q15m = (() => { const s = coin.signal15m || (isLong ? ((coin.score||50)>=55?'bull':'') : ((coin.score||50)<=45?'bear':'')); return isLong ? s.includes('bull') : s.includes('bear'); })();
        if (_qH4 && _q15m) { // 硬性條件通過才計入 SQ
          const _qDy = isLong ? (coin.dailySignal||'').includes('bull') : (coin.dailySignal||'').includes('bear');
          const _qDyOp = isLong ? (coin.dailySignal||'').includes('bear') : (coin.dailySignal||'').includes('bull');
          const _qWk = isLong ? (coin.weeklySignal||'').includes('bull') : (coin.weeklySignal||'').includes('bear');
          const _qWkOp = isLong ? (coin.weeklySignal||'').includes('bear') : (coin.weeklySignal||'').includes('bull');
          if (_qDy) _qSq += 1; else if (_qDyOp) _qSq -= 1;
          if (_qWk) _qSq += 1; else if (_qWkOp) _qSq -= 1;
          if (isLong ? (coin.h1Signal||'').includes('bull') : (coin.h1Signal||'').includes('bear')) _qSq += 1;
          if (isLong ? (parseFloat(coin.macdHist)||0) > 0 : (parseFloat(coin.macdHist)||0) < 0) _qSq += 1;
        }
        // ②③ AI 週/日偏向（從 notifSetup 已計算的偏向讀取）
        if (_macroCache) {
          try {
            const _qWb = computeWeeklyAIBias(_macroCache.fg, _macroCache);
            const _qTb = computeTodayAIBias(_macroCache.fg, _macroCache);
            if (isLong ? _qWb.bias.includes('bull') : _qWb.bias.includes('bear')) _qSq += 1;
            else if (isLong ? _qWb.bias.includes('bear') : _qWb.bias.includes('bull')) _qSq -= 1;
            if (isLong ? _qTb.bias.includes('bull') : _qTb.bias.includes('bear')) _qSq += 1;
            else if (isLong ? _qTb.bias.includes('bear') : _qTb.bias.includes('bull')) _qSq -= 1;
            // ④ 宏觀環境 ±2
            const _qFgV = parseInt(_macroCache.fg?.value||'50');
            const _qChg = _macroCache.marketCapChange||0;
            const _qDom = _macroCache.btcDominance||50;
            let _qMAg = 0;
            if (isLong) { if (_qChg<-2) _qMAg++; if (_qDom>58) _qMAg++; if (_qFgV<30) _qMAg++; }
            else        { if (_qChg> 2) _qMAg++; if (_qDom<44) _qMAg++; if (_qFgV>70) _qMAg++; }
            let _qMp = _qMAg>=3?-2:_qMAg>=2?-1:0; if (_qMAg===0)_qMp+=1;
            _qSq += Math.max(-2, Math.min(2, _qMp));
          } catch(_e){}
        }
        // ⑤ 足跡 + ㉑ 微結構
        try { const _qFP=_footprintCache[coin.symbol]; if(_qFP){if(_qFP.deltaDiv)_qSq-=1;else if(isLong?_qFP.deltaDir==='bull':_qFP.deltaDir==='bear')_qSq+=1;else if(isLong?_qFP.deltaDir==='bear':_qFP.deltaDir==='bull')_qSq-=1;if((_qFP.microstructureQuality||0)>=7)_qSq+=1;else if((_qFP.microstructureQuality||0)<=3)_qSq-=1;} } catch(_e){}
        // ⑦ ADX ⑩ 成交量 ⑪ BB走軌
        const _qAdx = parseFloat(coin.adx)||20;
        if (_qAdx>=28) _qSq+=1; else if (_qAdx<20) _qSq-=1;
        const _qVol = coin.volumeStrength||'';
        if (_qVol.includes('強')||_qVol==='high') _qSq+=1; else if (_qVol.includes('弱')||_qVol==='low') _qSq-=1;
        try { const _qBB=coin.bb; if(_qBB){if(isLong?_qBB.walkingBull:_qBB.walkingBear)_qSq+=1;else if(isLong?_qBB.walkingBear:_qBB.walkingBull)_qSq-=1;} } catch(_e){}
        // ⑧ 訂單流 Taker ⑨ 巨鯨
        try { const _qTkr=coin.derivData?.takerBuySell??1;if(isLong?_qTkr>=1.08:_qTkr<=0.92)_qSq+=1;else if(isLong?_qTkr<0.88:_qTkr>1.12)_qSq-=1; } catch(_e){}
        try { const _qWhl=coin.whaleData;if(_qWhl){if(isLong?(_qWhl.bias==='bull'&&(_qWhl.bigBuyCount||0)>=2):(_qWhl.bias==='bear'&&(_qWhl.bigSellCount||0)>=2))_qSq+=1;else if(isLong?(_qWhl.bias==='bear'&&(_qWhl.bigSellCount||0)>=3):(_qWhl.bias==='bull'&&(_qWhl.bigBuyCount||0)>=3))_qSq-=1;} } catch(_e){}
        // ⑫⑬ 技術面 + R/R
        if ((notifSetup.techPenalty||0)===0) _qSq+=1; else if ((notifSetup.techPenalty||0)>=12) _qSq-=1;
        const _qRR = parseFloat(notifSetup.rr1)||0;
        if (_qRR>=2.0) _qSq+=1; else if (_qRR<1.3) _qSq-=1;
        // ⑭ 風控分 ⑮ 止損學習
        try { const _qRisk=computeFullRisk(coin,notifSetup,isLong);if(!notifSetup.riskScore){notifSetup.riskScore=_qRisk.score;notifSetup.riskLevel=_qRisk.level;}if(_qRisk.score<=20)_qSq+=2;else if(_qRisk.score<=40)_qSq+=1;else if(_qRisk.score>=55)_qSq-=1; } catch(_e){}
        if ((notifSetup.learnPenalty||0)>=20) _qSq-=1;
        // ⑰ 新聞情緒 ⑱ 爆倉牆 ⑲ 數據事件 ⑳ 資金流
        try { const _qIns=aiGenerateMarketInsights();const _qBr=_qIns.filter(i=>i.sentiment==='bearish'||i.sentiment==='bear').length;const _qBl=_qIns.filter(i=>i.sentiment==='bullish'||i.sentiment==='bull').length;if(_qBr+_qBl>0){if(isLong?_qBl>_qBr:_qBr>_qBl)_qSq+=1;else if(isLong?_qBr>_qBl:_qBl>_qBr)_qSq-=1;} } catch(_e){}
        try { const _qLiq=_liquidationCache[coin.symbol];const _qP=parseFloat(coin.price)||0;if(_qLiq&&_qP>0){const _qW=isLong?(_qLiq.shortLiqs||[]).find(l=>l.price>_qP&&l.price<=_qP*1.12):(_qLiq.longLiqs||[]).find(l=>l.price<_qP&&l.price>=_qP*0.88);if(_qW)_qSq+=1;} } catch(_e){}
        try { const _qEvs=getTodayEconEvents().filter(ev=>{const m=(ev.eventTime.getTime()-Date.now())/60000;return ev.impact==='high'&&m>=-30&&m<=90;});if(_qEvs.length>=2)_qSq-=2;else if(_qEvs.length===1)_qSq-=1; } catch(_e){}
        try { const _qCF=getCapitalFlowBias();const _qCFOpp=(_qCF.events||[]).filter(ev=>isLong?ev.bear>0:ev.bull>0).length;const _qCFOk=(_qCF.events||[]).filter(ev=>isLong?ev.bull>0:ev.bear>0).length;if(_qCFOk>0&&_qCFOpp===0)_qSq+=1;else if(_qCFOpp>=2)_qSq-=1; } catch(_e){}
        // ⑥⑯ ICT 結構 + 圖形確認（從快取讀取）
        try { const _qIctC=_tradeSetupCache[coin.symbol];if(_qIctC){let _qIct=0;if(_qIctC.orderBlock?.priceInOB||_qIctC.orderBlock4h?.priceInOB)_qIct++;if((_qIctC.fvg&&!_qIctC.fvg.filled)||(_qIctC.fvg4h&&!_qIctC.fvg4h.filled))_qIct++;_qSq+=Math.min(2,_qIct);const _qPat=_qIctC.chartPat;if(_qPat){_qSq+=Math.min(2,Math.max(0,_qPat.score||0));if((_qPat.opposing?.length||0)>0)_qSq-=Math.min(2,_qPat.opposing.length);}} } catch(_e){}

        _qSq = Math.max(0, _qSq);
        const _qGrade = _qSq>=20?'SSS':_qSq>=17?'SS':_qSq>=15?'S':_qSq>=9?'A':_qSq>=6?'B':_qSq>=3?'C':'D';
        notifSetup.sqGrade      = _qGrade;
        notifSetup.sqScore      = _qSq;
        notifSetup.sqGradeLabel = {SSS:'神級訊號',SS:'完美訊號',S:'頂級訊號',A:'優質訊號',B:'良好訊號',C:'一般訊號',D:'訊號偏弱'}[_qGrade]||'';
      } catch(_qE) {}
    }

    // AI 風控攔截 或 方向=觀望 或 R/R 不足 → 完全不通知
    if (notifSetup.hardBlocked || notifSetup.direction === 'wait' || notifSetup.rrBlocked) continue;

    // ① SQ 21因子 ≥ A 級（訊號品質門檻，最先判斷）
    const _sqPassGate = ['SSS','SS','S','A'].includes(notifSetup.sqGrade);
    if (!_sqPassGate) continue;

    // ② 風控分 ≥ 60（止損風控 + 風險評估扣完後的最終值）
    const _notifRPen = calcRiskPenalty(notifSetup.riskScore || 0);
    const notifConf = Math.max(0,
      (notifSetup.conf ?? Math.min(90, isLong ? coin.score : 100 - coin.score)) - _notifRPen);
    const rawConfVal = notifSetup.rawConf
      ?? Math.min(90, isLong ? coin.score : 100 - coin.score);
    if (notifConf < 60) continue;

    // 所有條件驗證通過 → 先建立持倉掛單（pendingNotify=true）
    // Telegram 通知由 updateOpenTrades 在確認掛單存活後統一發送，確保建單在前、通知在後
    try {
      const _tlog2 = loadTradeLog();
      const _alreadyIn = _tlog2.some(t => t.symbol === coin.symbol && t.direction === dir
        && (t.status === 'open' || t.status === 'pending'));
      if (!_alreadyIn) {
        // 長線單需 SQ ≥ S；SQ = A 時降格為短線單建單，避免建立後立即被 SQ 監控降格
        const _isLongTermEntry = notifSetup.isLongTerm === true && ['SSS','SS','S'].includes(notifSetup.sqGrade);
        const _newTrade = {
          id: `${coin.symbol}-${Date.now()}`,
          symbol: coin.symbol, direction: dir,
          timestamp: Date.now(),
          entryPrice: parseFloat(coin.price) || 0,
          entry: notifSetup.entry, sl: notifSetup.sl,
          tp1: notifSetup.tp1, tp2: notifSetup.tp2,
          entryReason: notifSetup.entryReason, slReason: notifSetup.slReason,
          tp1Reason: notifSetup.tp1Reason, tp2Reason: notifSetup.tp2Reason,
          rsi: parseFloat(coin.rsi) || 50,
          adx: parseFloat(coin.adx) || 20,
          score: coin.score, trend: coin.trend,
          conf: notifConf, rawConf: notifSetup.rawConf,
          riskPenalty:    _notifRPen,
          hardAdxPenalty: notifSetup.hardAdxPenalty || 0,
          learnPenalty:   notifSetup.learnPenalty   || 0,
          macroPenalty:   notifSetup.macroOpposePenalty || notifSetup.macroPenalty || 0,
          aiTrendPenalty: notifSetup.aiTrendPenalty || 0,
          techPenalty:    notifSetup.techPenalty    || 0,
          chipsPenalty:   notifSetup.chipsPenalty   || 0,
          dirPenalty:     notifSetup.dirPenalty     || 0,
          status: 'pending', outcome: null, tp1Hit: false,
          entryTime: null, exitPrice: null, exitTime: null, pnlR: null, analysis: null,
          refined: false,
          tradeType: notifSetup.tradeType || 'directional',
          longTermBias: null, canScaleIn: _isLongTermEntry,
          scaleIns: [], peakPrice: null,
          sqGrade: notifSetup.sqGrade || null, sqScore: notifSetup.sqScore ?? null,
          sqGradeLabel: notifSetup.sqGradeLabel || null,
          telegramSent: false,
          pendingNotify: true,
          _notifyRisk: {
            weeklyBias: notifSetup.weeklyBias, weeklyConf: notifSetup.weeklyConf,
            todayBias:  notifSetup.todayBias,  todayConf:  notifSetup.todayConf,
            riskScore:  notifSetup.riskScore,  riskLevel:  notifSetup.riskLevel,
            riskRecs:   notifSetup.riskRecs,
            rr1: notifSetup.rr1, rr2: notifSetup.rr2,
            flipRisks: notifSetup.flipRisks,
          },
        };
        _tlog2.unshift(_newTrade);
        saveTradeLog(_tlog2);
        const _tlabel = _isLongTermEntry ? '長線單' : '短線單';
        const _ticon  = _isLongTermEntry ? '💎' : '📡';
        // toast 延遲至 updateOpenTrades pendingNotify 通過風控分重算後再顯示
      }
    } catch(_te) { console.warn('[checkAndSendAlerts] trade create failed', _te); }

    next[coin.symbol] = { dir, sentAt: now };
  }

  localStorage.setItem(SIGNAL_CACHE_KEY, JSON.stringify(next));
  // 同步到 SW IDB，讓後台掃描能讀取最新冷卻狀態
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SYNC_CACHE', cache: next });
  }
}

function calcRiskPenalty(score) {
  if (score < 28) return 0;
  if (score < 60) return Math.max(1, Math.round((score - 27) / 32 * 9));
  if (score < 75) return Math.max(10, Math.round(10 + (score - 59) / 15 * 7));
  return Math.min(25, Math.round(18 + (score - 74) / 26 * 7));
}

function computeFullRisk(coin, params, isLong) {
  const conf               = params.conf               ?? 60;
  const macroOpposePenalty = params.macroPenalty       ?? 0;
  const aiTrendPenalty     = params.aiTrendPenalty     ?? 0;
  const learnPenalty       = params.learnPenalty       ?? 0;
  const techPenalty        = params.techPenalty        ?? 0;
  const chipsPenalty       = params.chipsPenalty       ?? 0;
  const rr1                = parseFloat(params.rr1)   || 0;

  // flipRisks: use explicitly provided OR derive from todayBiasData global
  let flipRisks = params.flipRisks;
  if (!flipRisks) {
    try {
      const nowMs = Date.now();
      flipRisks = (todayBiasData?.highEvs || [])
        .map(ev => ({ ev, mins: (ev.eventTime?.getTime() - nowMs) / 60000 }))
        .filter(({ mins }) => mins > -60 && mins < 480)
        .map(({ ev }) => ({ name: ev.name }));
    } catch(_e) { flipRisks = []; }
  }

  // isRangeMode: use provided OR read from weeklyBiasData (local to buildTradeSetup, may not be in scope)
  let isRangeMode = params.isRangeMode;
  if (isRangeMode === undefined) {
    try { isRangeMode = weeklyBiasData?.rangeMode ?? false; } catch(_) { isRangeMode = false; }
  }

  // bigTrendBlocked: use provided OR estimate from weekly + daily signals
  let bigTrendBlocked = params.bigTrendBlocked;
  if (bigTrendBlocked === undefined) {
    const _wkSig = (coin.weeklySignal || '');
    const _dySig = (coin.dailySignal  || '');
    const _wkOpp = isLong ? _wkSig.includes('bear') : _wkSig.includes('bull');
    const _dyOpp = isLong
      ? _dySig.includes('bear') && !_dySig.includes('neutral')
      : _dySig.includes('bull') && !_dySig.includes('neutral');
    bigTrendBlocked = _wkOpp && _dyOpp;
  }

  let score = 0;
  const factors = [], recs = [];

  // 1. 風控分
  if (conf < 65)      { score += 20; factors.push(`信心偏低（${conf}%）`); recs.push('考慮縮小倉位至正常的 40-50%'); }
  else if (conf < 72) { score += 10; factors.push(`信心中等（${conf}%）`); recs.push('建議倉位不超過正常的 70%'); }

  // 2. ADX 趨勢強度
  const _adx = parseFloat(coin.adx) || 0;
  if (_adx < 18)      { score += 28; factors.push(`ADX ${_adx.toFixed(1)} 極弱，無趨勢`); recs.push('ADX 過低，趨勢不明確，強烈建議觀望'); }
  else if (_adx < 22) { score += 18; factors.push(`ADX ${_adx.toFixed(1)} 偏弱`); recs.push('趨勢動能不足，易被洗出，適合小倉試單'); }
  else if (_adx < 25) { score += 8;  factors.push(`ADX ${_adx.toFixed(1)} 略低`); }

  // 3. 宏觀逆風
  if (macroOpposePenalty > 15)     { score += 22; factors.push('宏觀強逆風'); recs.push('宏觀方向明顯相反，可考慮降低倉位'); }
  else if (macroOpposePenalty > 8) { score += 12; factors.push('宏觀中等逆風'); recs.push('宏觀有逆風，可縮小倉位並設止損'); }
  else if (macroOpposePenalty > 3) { score += 5;  factors.push('宏觀輕微逆風'); }

  // 4. AI 趨勢預測逆向
  if (aiTrendPenalty > 10)     { score += 15; factors.push('AI 趨勢預測逆向'); recs.push('AI 週/日預測與進場方向相反，可謹慎操作'); }
  else if (aiTrendPenalty > 4) { score += 7;  factors.push('AI 趨勢預測輕微逆向'); }

  // 5. AI 風控歷史記憶
  if (learnPenalty > 10)    { score += 18; factors.push('AI 風控記憶觸發'); recs.push('此幣種歷史止損模式頻繁，可等更好進場點'); }
  else if (learnPenalty > 5){ score += 9;  factors.push('AI 風控記憶輕微觸發'); recs.push('歷史有止損記錄，可降低倉位比例'); }

  // 6. R/R 比率
  if (rr1 < 1.2)      { score += 18; factors.push(`R/R 過低（${rr1}:1）`); recs.push('R/R 不足 1.2:1，風險報酬偏低，可評估是否進場'); }
  else if (rr1 < 1.5) { score += 8;  factors.push(`R/R 偏低（${rr1}:1）`); recs.push('R/R 略低，止損設定要精確'); }

  // 7. 即將發布的高影響經濟數據
  if (flipRisks.length >= 3)      { score += 20; factors.push(`${flipRisks.length} 個高衝擊數據即將發布`); recs.push(`${flipRisks.map(r=>r.name).join('、')} 即將公布，可能造成波動，注意風控`); }
  else if (flipRisks.length >= 1) { score += 10; factors.push(`${flipRisks.length} 個高衝擊數據（${flipRisks.map(r=>r.name).join('、')}）`); recs.push('數據公布前後波動大，設好止損'); }

  // 8. 區間模式
  if (isRangeMode) { score += 10; factors.push('目前為區間震盪模式'); recs.push('區間模式可縮短持倉時間，遇壓力/支撐快速獲利了結'); }

  // 9. 4H+日線趨勢對齊
  if (bigTrendBlocked) { score += 15; factors.push('4H+日線趨勢未對齊'); recs.push('大週期趨勢未確認，可謹慎持倉、避免重倉'); }

  // 10. 技術面/籌碼面
  const _tcSum = techPenalty + chipsPenalty;
  if (_tcSum > 12)    { score += 10; factors.push('技術/籌碼逆風'); }
  else if (_tcSum > 5){ score += 5;  factors.push('輕微技術/籌碼逆風'); }

  // 11. 巨鯨方向逆向
  const _whaleBiasR = coin.whaleData?.bias;
  if (_whaleBiasR) {
    if ((isLong && _whaleBiasR === 'bear') || (!isLong && _whaleBiasR === 'bull')) {
      score += 12;
      factors.push(`巨鯨方向逆向（主力${isLong ? '賣出' : '買入'}）`);
      recs.push('主力資金方向與進場方向相反，考慮等巨鯨轉向或縮小倉位');
    }
  }

  // 12. AI 訊號品質
  const _sqGradeR = params.sqGrade;
  if (_sqGradeR === 'D') {
    score += 12; factors.push('AI 訊號品質 D 級');
    recs.push('多時框確認不足，訊號偏弱，建議等更強訊號再進場');
  } else if (_sqGradeR === 'C') {
    score += 6; factors.push('AI 訊號品質 C 級');
    recs.push('訊號品質偏低，可縮小倉位或等待更明確信號');
  }

  // 13. 成交量萎縮（成交量不足時趨勢可靠性下降）
  const _volStrR = (coin.volumeStrength || '');
  if (_volStrR.includes('極低') || (_volStrR.includes('低') && _volStrR.includes('萎'))) {
    score += 8; factors.push('成交量極度萎縮，趨勢可靠性低'); recs.push('量能極低，避免追高殺低，等待放量確認');
  } else if (_volStrR.includes('低') || _volStrR.includes('弱')) {
    score += 4; factors.push('成交量偏低'); recs.push('量能不足，進場倉位適度控制');
  }

  // 14. MACD 動能逆向（僅在 techPenalty 未覆蓋或不顯著時補充）
  const _macdHR = parseFloat(coin.macdHist) || 0;
  const _priceR = parseFloat(coin.price) || 1;
  if ((params.techPenalty || 0) < 5) {
    if (isLong && _macdHR < -_priceR * 0.001) {
      score += 7; factors.push('MACD 動能偏空（柱狀體負值）'); recs.push('MACD 尚未轉多，多頭進場時機需再確認');
    } else if (!isLong && _macdHR > _priceR * 0.001) {
      score += 7; factors.push('MACD 動能偏多（柱狀體正值）'); recs.push('MACD 尚未轉空，空頭進場時機需再確認');
    }
  }

  score = Math.min(100, score);
  const level      = score >= 75 ? '極高風險' : score >= 60 ? '高風險' : score >= 28 ? '中風險' : '低風險';
  const levelColor = score >= 75 ? '#ef4444'  : score >= 60 ? '#f97316' : score >= 28 ? '#f59e0b' : '#22c55e';
  if (factors.length === 0) { factors.push('各項指標正常，無明顯風險'); recs.push('可按計劃正常倉位進場'); }
  if (recs.length === 0) recs.push('各項指標良好，按計劃執行');
  return { score, level, levelColor, factors, recs };
}

function computeSimpleSetup(coin, isLong) {
  const price  = parseFloat(coin.price)  || 1;
  const adx    = parseFloat(coin.adx)    || 20;
  const rsi    = parseFloat(coin.rsi)    || 50;
  const ema20  = parseFloat(coin.ema20)  || price * 0.99;
  const ema50  = parseFloat(coin.ema50)  || 0;
  const ema200 = parseFloat(coin.ema200) || 0;
  const direction = isLong ? 'long' : 'short';

  // ── ATR 估算（ADX 調整波動率）──
  const atrPct = adx > 35 ? 0.018 : adx > 25 ? 0.013 : 0.009;
  const atr    = price * atrPct;

  // ── Kill Zone：高品質時段收緊進場容忍度 ──
  const _kzNow  = computeKillZone();
  const _kzHigh = _kzNow.quality === 'high';   // 倫敦/紐約開盤

  // ── 讀取 ICT/SMC 緩存（若用戶曾看詳情頁則有更精確的 OB/FVG 資料）──
  const _ict = (typeof _tradeSetupCache !== 'undefined' && _tradeSetupCache[coin.symbol]) || {};
  const _ob  = _ict.orderBlock || _ict.orderBlock4h || null;   // Order Block
  const _fvg = _ict.fvg || _ict.fvg4h || null;                 // Fair Value Gap
  const _pd  = _ict.premiumDiscount || null;                    // Premium/Discount

  // ── BB 結構 ──
  const _bb   = coin.bb || null;
  const _bbUp = _bb ? parseFloat(_bb.upper) || 0 : 0;
  const _bbMid= _bb ? parseFloat(_bb.middle)|| 0 : 0;
  const _bbLo = _bb ? parseFloat(_bb.lower) || 0 : 0;

  // ── SMC 型態 ──
  const _pat = coin.patterns || null;

  // ── MTF 多週期確認（5 個時間軸）──
  // 長線單條件：週線 + 日線 + 4H + 15m 均同向
  // 短線單條件：日線 + 4H + 1H + 15m 均同向
  const _wkAligned    = isLong ? (coin.weeklySignal || '').includes('bull') : (coin.weeklySignal || '').includes('bear');
  const _dayAligned   = isLong ? (coin.dailySignal  || '').includes('bull') : (coin.dailySignal  || '').includes('bear');
  const _h4Aligned    = isLong ? (coin.h4Signal     || '').includes('bull') : (coin.h4Signal     || '').includes('bear');
  const _h1Aligned    = isLong ? (coin.h1Signal     || '').includes('bull') : (coin.h1Signal     || '').includes('bear');
  // 15m：來自 coin.signal15m（掃描版），或以 score/trend 估算
  const _15mAligned   = coin.signal15m
    ? (isLong ? coin.signal15m.includes('bull') : coin.signal15m.includes('bear'))
    : (isLong ? (coin.score || 50) >= 55 : (coin.score || 50) <= 45);
  // 組合判斷
  const _isShortTerm = _dayAligned && _h4Aligned && _h1Aligned && _15mAligned; // 短線：4 框同向
  const _isLongTerm  = _isShortTerm && _wkAligned;                              // 長線：短線基礎 + 週線
  const _mtfBothAlign = _isLongTerm || _isShortTerm;
  const _mtfContraWk  = isLong ? (coin.weeklySignal || '').includes('bear') : (coin.weeklySignal || '').includes('bull');
  const _mtfContraDay = isLong ? (coin.dailySignal  || '').includes('bear') : (coin.dailySignal  || '').includes('bull');
  const _mtfContraH4  = isLong ? (coin.h4Signal     || '').includes('bear') : (coin.h4Signal     || '').includes('bull');
  // MTF 止損 buffer：長線雙確認收緊；4H 逆向放寬；週線逆向最寬
  const _mtfSlFactor  = _isLongTerm ? 0.75 : _isShortTerm ? 0.85 : _mtfContraWk ? 1.3 : _mtfContraH4 ? 1.15 : 1.0;

  // ── 前高/前低（4H pivot 優先，其次 OB 邊界，最後 BB 帶）──
  const _h4Hi = parseFloat(coin.h4SwingHigh) || 0;
  const _h4Lo = parseFloat(coin.h4SwingLow)  || 0;
  const _prevHigh = (_h4Hi > price * 1.002) ? _h4Hi
                  : (_ob && _ob.high > 0 && _ob.high > price * 1.002) ? _ob.high
                  : (_bbUp > price * 1.002 ? _bbUp : 0);
  const _prevLow  = (_h4Lo > 0 && _h4Lo < price * 0.998) ? _h4Lo
                  : (_ob && _ob.low  > 0 && _ob.low  < price * 0.998) ? _ob.low
                  : (_bbLo > 0 && _bbLo < price * 0.998 ? _bbLo : 0);

  // ═══════════════════════════════════════════════
  // 1. 進場點：多層優先級（ICT OB → 型態 → EMA50 → BB中軌 → EMA20）
  // ═══════════════════════════════════════════════
  let entry, _entryTag = '';
  if (_ob && _ob.priceInOB && _ob.high > 0 && _ob.low > 0) {
    // ICT OB 內：進場在 OB 50% 位置（最優）
    const _obMid = (_ob.high + _ob.low) / 2;
    entry     = isLong ? Math.min(price, _obMid) : Math.max(price, _obMid);
    _entryTag = 'ob';
  } else if (_pat && (isLong ? _pat.bull2B : _pat.bear2B)) {
    // 2B 型態：假突破後回歸，進在前高/前低附近（略優於純 EMA）
    entry     = isLong ? Math.min(price, ema20 * 1.001) : Math.max(price, ema20 * 0.999);
    _entryTag = '2b';
  } else if (_pat && (isLong ? _pat.bull123 : _pat.bear123)) {
    // 123 型態：突破確認後進場
    entry     = isLong ? Math.max(price, ema20 * 0.999) : Math.min(price, ema20 * 1.001);
    _entryTag = '123';
  } else if (ema50 > 0 && (isLong ? price >= ema50 * 0.998 && price <= ema50 * 1.015 : price <= ema50 * 1.002 && price >= ema50 * 0.985)) {
    // 接近 EMA50（±1.5%）→ S/R 精確進場
    entry     = isLong ? Math.min(price, ema50 * 1.003) : Math.max(price, ema50 * 0.997);
    _entryTag = 'ema50';
  } else if (_bbMid > 0 && Math.abs(price - _bbMid) / price < 0.012) {
    // 接近 BB 中軌（±1.2%）→ 均值回歸進場
    entry     = isLong ? Math.min(price, _bbMid * 1.002) : Math.max(price, _bbMid * 0.998);
    _entryTag = 'bbmid';
  } else {
    // 默認：EMA20 貼合進場（Kill Zone 高品質時更保守）
    const _emaFactor = _kzHigh ? 1.001 : 1.002;
    entry     = isLong ? Math.min(price, ema20 * _emaFactor) : Math.max(price, ema20 * (2 - _emaFactor));
    _entryTag = 'ema20';
  }

  // ═══════════════════════════════════════════════
  // 2. 止損：結構失效點（最小化止損）
  //    優先級：OB 邊界 → EMA 結構 → BB 帶 → ATR（縮小至 1.5×）
  // ═══════════════════════════════════════════════
  let sl, _slTag = '', _slStructure = '';
  // Kill Zone 高品質時段本就可收緊，MTF 雙確認時再乘以 _mtfSlFactor
  const _atrBuf = (_kzHigh ? 0.3 : 0.5) * _mtfSlFactor;
  if (_ob && _ob.priceInOB && _ob.high > 0 && _ob.low > 0) {
    const _buf = atr * _atrBuf;
    sl      = isLong ? _ob.low - _buf : _ob.high + _buf;
    _slTag  = 'ob';
    _slStructure = `OB ${isLong ? '低點' : '高點'} $${_ob[isLong ? 'low' : 'high'].toPrecision(5).replace(/\.?0+$/, '')}`;
  } else if (_pat && (isLong ? _pat.bull2B : _pat.bear2B)) {
    const _buf = atr * (_atrBuf + 0.2);
    sl = isLong ? entry - atr * 1.3 - _buf : entry + atr * 1.3 + _buf;
    _slTag  = '2b';
    _slStructure = `2B 型態假突破點`;
  } else if (_pat && (isLong ? _pat.bull123 : _pat.bear123)) {
    sl = isLong ? entry - atr * 1.4 * _mtfSlFactor : entry + atr * 1.4 * _mtfSlFactor;
    _slTag  = '123';
    _slStructure = `123 型態 P2 結構點`;
  } else if (ema50 > 0 && _entryTag === 'ema50') {
    const _buf = atr * 0.8 * _mtfSlFactor;
    sl = isLong ? ema50 - _buf : ema50 + _buf;
    _slTag  = 'ema50';
    _slStructure = `EMA50 $${ema50.toPrecision(5).replace(/\.?0+$/, '')} 下方`;
  } else if (_bbLo > 0 && isLong && price > _bbLo && entry - _bbLo < atr * 2) {
    sl = _bbLo - atr * 0.3 * _mtfSlFactor;
    _slTag  = 'bblo';
    _slStructure = `BB 下軌 $${_bbLo.toPrecision(5).replace(/\.?0+$/, '')}`;
  } else if (_bbUp > 0 && !isLong && price < _bbUp && _bbUp - entry < atr * 2) {
    sl = _bbUp + atr * 0.3 * _mtfSlFactor;
    _slTag  = 'bbup';
    _slStructure = `BB 上軌 $${_bbUp.toPrecision(5).replace(/\.?0+$/, '')}`;
  } else if (ema20 > 0 && (isLong ? entry > ema20 : entry < ema20)) {
    const _buf = atr * 0.6 * _mtfSlFactor;
    sl = isLong ? ema20 - _buf : ema20 + _buf;
    _slTag  = 'ema20';
    _slStructure = `EMA20 $${ema20.toPrecision(5).replace(/\.?0+$/, '')} 外`;
  } else {
    sl = isLong ? entry - atr * 1.5 * _mtfSlFactor : entry + atr * 1.5 * _mtfSlFactor;
    _slTag  = 'atr';
    _slStructure = `ATR × ${(1.5 * _mtfSlFactor).toFixed(1)}`;
  }

  // ── 止損最小安全距離：至少 0.5% 且不超過 3%（防止止損過緊/過寬）──
  const _minSl = price * 0.005;
  const _maxSl = price * 0.03;
  let   _slDist = Math.abs(entry - sl);
  if (_slDist < _minSl) { sl = isLong ? entry - _minSl : entry + _minSl; _slDist = _minSl; }
  if (_slDist > _maxSl) { sl = isLong ? entry - _maxSl : entry + _maxSl; _slDist = _maxSl; }
  const risk = _slDist;

  // ═══════════════════════════════════════════════
  // 3. 止盈：結構目標（前高/前低 → FVG → EMA層 → BB帶 → 固定 R:R）
  //    大小週期雙確認時允許更遠的波段目標
  // ═══════════════════════════════════════════════
  let tp1, tp2, _tp1Tag = '', _tp2Tag = '';

  // 前高/前低：0.2% buffer 留在結構邊界稍內側
  const _swHigh = _prevHigh > 0 ? _prevHigh * 0.998 : 0;
  const _swLow  = _prevLow  > 0 ? _prevLow  * 1.002 : 0;

  // ══ TP1：最近可達結構（進場價 2.5% 內），優先最快觸及目標 ══
  // 設計原則：TP1 要容易達到（高出場率），不追求最大獲利
  const _tp1Cap = entry * 0.025; // 2.5% 範圍內才算 TP1 近期目標

  // 各候選結構是否在 2.5% 範圍內且優於進場 0.8R
  const _fvgTP1 = _fvg && !_fvg.filled && _fvg.mid > 0 &&
    (isLong ? _fvg.mid > entry + risk * 0.8 && _fvg.mid <= entry + _tp1Cap
            : _fvg.mid < entry - risk * 0.8 && _fvg.mid >= entry - _tp1Cap);
  const _ema50TP1 = ema50 > 0 &&
    (isLong ? ema50 > entry + risk * 0.8 && ema50 <= entry + _tp1Cap
            : ema50 < entry - risk * 0.8 && ema50 >= entry - _tp1Cap);
  const _bbTP1 = isLong
    ? (_bbUp > 0 && _bbUp > entry + risk * 0.8 && _bbUp <= entry + _tp1Cap)
    : (_bbLo > 0 && _bbLo < entry - risk * 0.8 && _bbLo >= entry - _tp1Cap);
  const _prevHTP1 = _swHigh > entry + risk * 0.8 && _swHigh <= entry + _tp1Cap;
  const _prevLTP1 = _swLow > 0 && _swLow < entry - risk * 0.8 && _swLow >= entry - _tp1Cap;

  // 優先順序：FVG缺口（最精確）→ EMA50 → BB對向軌 → 近期前高/低（≤2.5%）→ R:R 1.5 保底
  if (_fvgTP1) {
    tp1 = parseFloat(_fvg.mid); _tp1Tag = 'fvg';
  } else if (isLong && _ema50TP1) {
    tp1 = ema50; _tp1Tag = 'ema50';
  } else if (!isLong && _ema50TP1) {
    tp1 = ema50; _tp1Tag = 'ema50';
  } else if (isLong && _bbTP1) {
    tp1 = _bbUp; _tp1Tag = 'bbup';
  } else if (!isLong && _bbTP1) {
    tp1 = _bbLo; _tp1Tag = 'bblo';
  } else if (isLong && _prevHTP1) {
    tp1 = _swHigh; _tp1Tag = 'prevhigh';
  } else if (!isLong && _prevLTP1) {
    tp1 = _swLow; _tp1Tag = 'prevlow';
  } else {
    tp1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5; _tp1Tag = 'rr';
  }

  // ══ TP2：中期波段目標（前高/低 6% 內優先，再 EMA200，再 R:R 2.5）══
  const _tp2Cap = entry * 0.06; // 最多 6%，避免不切實際的遠期目標
  const _prevHTP2 = _swHigh > tp1 * 1.003 && _swHigh <= entry + _tp2Cap;
  const _prevLTP2 = _swLow > 0 && _swLow < tp1 * 0.997 && _swLow >= entry - _tp2Cap;
  const _tp2MinRisk = _mtfBothAlign ? 2.0 : 1.5;

  if (isLong && _prevHTP2) {
    tp2 = _swHigh; _tp2Tag = 'prevhigh';
  } else if (!isLong && _prevLTP2) {
    tp2 = _swLow; _tp2Tag = 'prevlow';
  } else if (ema200 > 0 && (isLong ? ema200 > entry + risk * _tp2MinRisk : ema200 < entry - risk * _tp2MinRisk)) {
    tp2 = ema200; _tp2Tag = 'ema200';
  } else {
    const _tp2Mult = _mtfBothAlign ? 3.0 : 2.5;
    tp2 = isLong ? entry + risk * _tp2Mult : entry - risk * _tp2Mult; _tp2Tag = 'rr';
  }
  // TP2 至少比 TP1 再遠 30%
  if (isLong  && tp2 < tp1 * 1.003) tp2 = tp1 + Math.abs(tp1 - entry) * 0.5;
  if (!isLong && tp2 > tp1 * 0.997) tp2 = tp1 - Math.abs(entry - tp1) * 0.5;

  // 長線單（_isLongTerm）：估算 8:1 RR 目標並驗證 >= 7:1
  let _isLongTermFinal = _isLongTerm;
  if (_isLongTerm) {
    const _ltTPEst = isLong ? entry + risk * 8 : entry - risk * 8;
    const _ltRRest = risk > 0 ? Math.abs(_ltTPEst - entry) / risk : 0;
    if (_ltRRest < 7) {
      _isLongTermFinal = false; // R/R 不足 7:1，降為短線處理
    }
  }

  // ═══════════════════════════════════════════════
  // 4. 盈虧比檢查：R:R < 1.3 → 觀望，不開倉
  // ═══════════════════════════════════════════════
  const _rrCheck  = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  const rrBlocked = _rrCheck < 1.3;
  const rrReason  = rrBlocked ? `R/R ${_rrCheck.toFixed(2)}:1 低於 1.3，盈虧比不足，建議觀望` : '';

  // ── AI 學習引擎調整（同 buildTradeSetup 相同邏輯）──
  const hardAdxPenalty = adx < 18 ? 18 : adx < 22 ? 10 : 0;
  const _ssVolWeak      = (coin.volumeStrength || '') === '低' || String(coin.volumeStrength||'').includes('弱');
  const _ssH4Aligned    = isLong ? (coin.h4Signal || '').includes('bull') : (coin.h4Signal || '').includes('bear');
  const _ssDirBase      = isLong ? (coin.score || 55) : Math.max(10, 100 - (coin.score || 50));
  const _ssScoreStr     = _ssDirBase >= 75 ? 'strong' : _ssDirBase >= 65 ? 'medium' : 'weak';
  const _ssKillZone     = (() => { const h = new Date().getUTCHours(); return h >= 7 && h < 11 ? 'london' : h >= 13 && h < 17 ? 'ny' : h >= 0 && h < 4 ? 'asia' : 'other'; })();
  const { penalty: learnPenalty, warnings: learnWarn, hardBlocked, blockReasons } = applyLearnAdjustment(direction, rsi, adx, {
    slType:        'atr',
    skipAdxRule:   true,
    macdHist:      parseFloat(coin.macdHist) || 0,
    volWeak:       _ssVolWeak,
    h4Aligned:     _ssH4Aligned,
    scoreStrength: _ssScoreStr,
    killZone:      _ssKillZone,
    weeklyAgainst: isLong ? (coin.weeklySignal||'').includes('bear') : (coin.weeklySignal||'').includes('bull'),
    h1Aligned:     isLong ? !!(coin.h1Signal||'').includes('bull') : !!(coin.h1Signal||'').includes('bear'),
    bbWalkingBear: !!(coin.bb?.walkingBear),
    bbWalkingBull: !!(coin.bb?.walkingBull),
  });
  // rawConf：做多用 score，做空用 100-score（score=30 → 空頭強度70%）
  let rawConf = Math.min(88, _ssDirBase);
  // RSI 確認加成（順向 RSI：做多 RSI < 50，做空 RSI > 50 各 +5；極端加 +8；移除近中性加成）
  if (isLong) {
    if (rsi < 35)       rawConf += 8;
    else if (rsi < 45)  rawConf += 5;
  } else {
    if (rsi > 65)       rawConf += 8;
    else if (rsi > 55)  rawConf += 5;
  }
  // ADX 趨勢強度加成（ADX > 25 確認趨勢）
  if (adx >= 35)      rawConf += 5;
  else if (adx >= 25) rawConf += 3;
  // 趨勢強度加成（強勢看漲/看跌）
  if (coin.trend === '強勢看漲' || coin.trend === '強勢看跌') rawConf += 4;
  // 多週期方向確認加成
  const _sDayAlignTmp = isLong ? (coin.dailySignal  || '').includes('bull') : (coin.dailySignal  || '').includes('bear');
  const _sWkAlignTmp  = isLong ? (coin.weeklySignal || '').includes('bull') : (coin.weeklySignal || '').includes('bear');
  const _sH4AlignTmp  = isLong ? (coin.h4Signal     || '').includes('bull') : (coin.h4Signal     || '').includes('bear');
  const _sH1AlignTmp  = isLong ? (coin.h1Signal     || '').includes('bull') : (coin.h1Signal     || '').includes('bear');
  if (_sDayAlignTmp) rawConf += 5;  // 日線同向
  if (_sWkAlignTmp)  rawConf += 4;  // 週線同向
  if (_sH4AlignTmp)  rawConf += 3;  // 4H 同向加成
  if (_sH1AlignTmp)  rawConf += 2;  // 1H 同向加成
  // MACD 動量方向加成（順向 +3，不額外扣分，_sTechPen 已處理逆向）
  const _ssMacdBonus = parseFloat(coin.macdHist) || 0;
  if (isLong && _ssMacdBonus > 0) rawConf += 3;
  if (!isLong && _ssMacdBonus < 0) rawConf += 3;
  // 成交量充裕加成（高量確認 +2）
  if ((coin.volumeStrength || '') === '高') rawConf += 2;
  rawConf = Math.min(90, rawConf);
  // 宏觀逆風懲罰：六大因子各自獨立扣分（與 buildTradeSetup 一致）
  let _sMacroPen = 0, _sAIPen = 0;
  if (typeof _macroCache !== 'undefined' && _macroCache) {
    try {
      const _sfg = _macroCache.fg, _sgm = _macroCache;
      const _sfgV = parseInt(_sfg?.value || '50');
      const _schg = _sgm?.marketCapChange || 0;
      const _sdom = _sgm?.btcDominance   || 50;
      // ① 宏觀市場（F&G + 市值 + BTC 主導）
      let _sf1Opp = false;
      if (isLong) {
        if (_schg < -2 || _sdom > 58 || _sfgV < 30 || _sfgV > 75) _sf1Opp = true;
      } else {
        if (_schg > 2 || _sdom < 44 || _sfgV > 70 || _sfgV < 25) _sf1Opp = true;
      }
      const _sf1Neut = !_sf1Opp && (_sfgV >= 40 && _sfgV <= 60) && Math.abs(_schg) < 2;
      if (_sf1Opp)       _sMacroPen += 8;
      else if (_sf1Neut) _sMacroPen += 3;
      // ② 加密大方向（computeMacroNetDir）
      const _sBigDir = computeMacroNetDir(_sfg, _sgm);
      const _sBdOpp = (isLong && _sBigDir.includes('bear')) || (!isLong && _sBigDir.includes('bull'));
      if (_sBdOpp) {
        _sMacroPen += (_sBigDir === 'slight_bear' || _sBigDir === 'slight_bull') ? 5 : 9;
      } else if (_sBigDir === 'neutral') {
        _sMacroPen += 4;
      }
      // ⑤ AI 財經新聞
      try {
        const _sIns = aiGenerateMarketInsights();
        const _sBrCnt = _sIns.filter(i => i.sentiment === 'bearish' || i.sentiment === 'bear').length;
        const _sBuCnt = _sIns.filter(i => i.sentiment === 'bullish' || i.sentiment === 'bull').length;
        if (isLong && _sBrCnt > _sBuCnt) _sMacroPen += 3;
        else if (!isLong && _sBuCnt > _sBrCnt) _sMacroPen += 3;
        else if (_sBrCnt > 0 || _sBuCnt > 0) _sMacroPen += 1;
      } catch(_sie) {}
      // 週線/日線 AI 預測（factors ③④）
      const _swb = computeWeeklyAIBias(_sfg, _sgm);
      const _stb = computeTodayAIBias(_sfg, _sgm);
      const _swBias = _swb.bias || '';
      const _stBias = _stb.bias || '';
      // 宏觀大方向與交易方向一致時，AI事件預測逆向不扣分
      const _ssMacroAligned = (!isLong && _sBigDir.includes('bear')) || (isLong && _sBigDir.includes('bull'));
      if (!_ssMacroAligned) {
        const _swOp   = isLong ? _swBias.includes('bear') : _swBias.includes('bull');
        const _stOp   = isLong ? _stBias.includes('bear') : _stBias.includes('bull');
        const _swNeut = _swBias === 'neutral';
        const _stNeut = _stBias === 'neutral';
        if (_swOp)        _sAIPen += _swBias.includes('strong') ? 8 : 5;
        else if (_swNeut) _sAIPen += 2;
        if (_stOp)        _sAIPen += 5;
        else if (_stNeut) _sAIPen += 1;
      }
    } catch(_se) {}
  } else {
    _sMacroPen += 3;  // 無宏觀資料：方向不確定，扣 3%
  }
  // 技術面扣分 (RSI逆向、MACD、成交量)
  let _sTechPen = 0;
  if (isLong) {
    if (rsi > 78)      _sTechPen += 8;
    else if (rsi > 70) _sTechPen += 5;
  } else {
    if (rsi < 22)      _sTechPen += 8;
    else if (rsi < 30) _sTechPen += 5;
  }
  const _ssMacdH = parseFloat(coin.macdHist) || 0;
  if (isLong  && _ssMacdH < 0) _sTechPen += 4;
  if (!isLong && _ssMacdH > 0) _sTechPen += 4;
  const _ssVolStr = coin.volumeStrength || '';
  if (_ssVolStr === '低' || _ssVolStr.includes('弱')) _sTechPen += 4;
  // 多時框同向（4H+日線確認）但成交量仍偏低：突破缺乏放量，假突破風險
  if (_h4Aligned && _dayAligned && (_ssVolStr === '低' || _ssVolStr.includes('弱'))) _sTechPen += 5;
  _sTechPen = Math.min(18, _sTechPen);
  // 籌碼面扣分 (Taker比例、巨鯨)
  let _sChipsPen = 0;
  const _ssDeriv = coin.derivData;
  if (_ssDeriv) {
    const _ssTkr = _ssDeriv.takerBuySell ?? 1;
    if (isLong  && _ssTkr < 0.80)       _sChipsPen += 6;
    else if (isLong  && _ssTkr < 0.88)  _sChipsPen += 4;
    else if (!isLong && _ssTkr > 1.20)  _sChipsPen += 6;
    else if (!isLong && _ssTkr > 1.12)  _sChipsPen += 4;
  }
  const _ssWhale = coin.whaleData;
  if (_ssWhale) {
    if (isLong  && _ssWhale.bias === 'bear' && (_ssWhale.bigSellCount || 0) >= 3) _sChipsPen += 5;
    if (!isLong && _ssWhale.bias === 'bull' && (_ssWhale.bigBuyCount  || 0) >= 3) _sChipsPen += 5;
  }
  _sChipsPen = Math.min(12, _sChipsPen);

  // ── 布林通道型態分析（BB走軌/收窄/背離 + 123法則/2B法則）──
  let _sBBBonus = 0, _sBBPenalty = 0;
  const _sBB = coin.bb;
  const _sPat = coin.patterns;
  if (_sBB) {
    // BB 走軌確認趨勢方向 → +4 信心加成
    if (isLong  && _sBB.walkingBull) _sBBBonus += 4;
    if (!isLong && _sBB.walkingBear) _sBBBonus += 4;
    // BB 收窄蓄力 + 方向一致（中軌上方做多/中軌下方做空）→ +2 加成
    if (_sBB.isSqueezing) {
      if (isLong  && price >= _sBB.middle) _sBBBonus += 2;
      if (!isLong && price <= _sBB.middle) _sBBBonus += 2;
    }
    // BB 背離警告（對手方向）→ 扣分：動能衰竭風險
    if (isLong  && _sBB.bbDivBear) _sBBPenalty += 8;
    if (!isLong && _sBB.bbDivBull) _sBBPenalty += 8;
    // 對手走軌（逆風走軌）→ 扣分
    if (isLong  && _sBB.walkingBear) _sBBPenalty += 7;
    if (!isLong && _sBB.walkingBull) _sBBPenalty += 7;
  }
  // 123法則確認 → +3；2B法則確認 → +3
  if (_sPat) {
    if (isLong  && _sPat.bull123) _sBBBonus += 3;
    if (!isLong && _sPat.bear123) _sBBBonus += 3;
    if (isLong  && _sPat.bull2B)  _sBBBonus += 3;
    if (!isLong && _sPat.bear2B)  _sBBBonus += 3;
  }
  _sBBBonus   = Math.min(6, _sBBBonus);
  _sBBPenalty = Math.min(14, _sBBPenalty);
  rawConf = Math.min(90, rawConf + _sBBBonus);
  // 巨鯨順向加成（方向一致 +4，歷史上順巨鯨勝率顯著更高）
  if (coin.whaleData) {
    const _sWhaleAligned = (isLong && coin.whaleData.bias === 'bull') || (!isLong && coin.whaleData.bias === 'bear');
    if (_sWhaleAligned) rawConf = Math.min(90, rawConf + 4);
  }

  // F2 大方向逆向扣分（週線信號反向）+ F4 日線逆向扣分
  let _sDirPen = 0;
  const _sWkSig = (coin.weeklySignal || '');
  const _sDySig = (coin.dailySignal  || '');
  if (isLong) {
    if (_sWkSig.includes('bear')) _sDirPen += 7;
    if (_sDySig.includes('bear') && !_sDySig.includes('neutral')) _sDirPen += 5;
  } else {
    if (_sWkSig.includes('bull')) _sDirPen += 7;
    if (_sDySig.includes('bull') && !_sDySig.includes('neutral')) _sDirPen += 5;
  }
  _sDirPen = Math.min(14, _sDirPen);

  // 資金流動事件扣分
  let _sCFPen = 0;
  try {
    const _cf = getCapitalFlowBias();
    for (const ev of _cf.events) {
      if (isLong  && ev.bear > 0) _sCFPen += ev.bear >= 1.2 ? 5 : 3;
      else if (!isLong && ev.bull > 0) _sCFPen += ev.bull >= 1.2 ? 5 : 3;
      else if (ev.bull === 0 && ev.bear === 0) _sCFPen += 2;
    }
    _sCFPen = Math.min(10, _sCFPen);
  } catch(_e) {}

  // 風控分：純粹止損風控扣分（ADX/技術/籌碼/宏觀由 SQ 因子處理）
  const _ssLearnDrag = Math.min(45, learnPenalty);
  const conf = Math.max(0, Math.round(100 - _ssLearnDrag));

  // ── 根據 scan 資料欄位動態生成進場理由 ──
  const macdH  = parseFloat(coin.macdHist) || 0;
  const mom    = parseFloat(coin.momentum) || 0;
  const volStr = coin.volumeStrength || '';
  const score  = coin.score || 60;

  const reasons = [];
  if (isLong) {
    // RSI
    if      (rsi < 30) reasons.push(`RSI ${rsi} 超賣區，超賣反彈機會`);
    else if (rsi < 45) reasons.push(`RSI ${rsi} 低位，多頭動能回升`);
    else if (rsi >= 50 && rsi < 65) reasons.push(`RSI ${rsi} 積極偏多，動能尚未過熱`);
    else if (rsi >= 65) reasons.push(`RSI ${rsi} 強勢偏多`);
    // EMA 排列
    if (ema50 > 0 && price > ema20 && ema20 > ema50) reasons.push(`EMA 多頭排列（20 > 50），趨勢向上`);
    else if (price > ema20) reasons.push(`價格站上 EMA20，短線偏多`);
    if (ema200 > 0 && price > ema200) reasons.push(`價格在 EMA200 上方，長線支撐`);
    // MACD
    if      (macdH > 0)  reasons.push(`MACD 柱狀線翻正，動能轉多`);
    else if (macdH < 0 && macdH > -0.0001 * price) reasons.push(`MACD 接近轉正，空頭動能衰減`);
    // 動量
    if (mom > 0) reasons.push(`動量值正值（+${mom}），上行動能確認`);
    // 成交量
    if (volStr === '高') reasons.push(`高量突破，量價齊升確認`);
    else if (volStr === '中') reasons.push(`成交量中等，走勢正常`);
    // ADX
    if      (adx > 35) reasons.push(`ADX ${adx} 強趨勢，追多有效`);
    else if (adx > 22) reasons.push(`ADX ${adx} 趨勢成形`);
    // 評分
    if (score >= 85) reasons.push(`綜合評分 ${score}，強勢看漲信號`);
    else reasons.push(`綜合評分 ${score}，多頭信號確認`);
  } else {
    // RSI
    if      (rsi > 70) reasons.push(`RSI ${rsi} 超買區，超買回落機會`);
    else if (rsi > 55) reasons.push(`RSI ${rsi} 偏高，空頭動能積累`);
    else if (rsi <= 50 && rsi > 35) reasons.push(`RSI ${rsi} 偏弱，下行動能確認`);
    else if (rsi <= 35) reasons.push(`RSI ${rsi} 弱勢偏空`);
    // EMA 排列
    if (ema50 > 0 && price < ema20 && ema20 < ema50) reasons.push(`EMA 空頭排列（20 < 50），趨勢向下`);
    else if (price < ema20) reasons.push(`價格跌破 EMA20，短線偏空`);
    if (ema200 > 0 && price < ema200) reasons.push(`價格在 EMA200 下方，長線壓力`);
    // MACD
    if      (macdH < 0)  reasons.push(`MACD 柱狀線負值，動能轉空`);
    else if (macdH > 0 && macdH < 0.0001 * price) reasons.push(`MACD 接近轉負，多頭動能衰減`);
    // 動量
    if (mom < 0) reasons.push(`動量值負值（${mom}），下行動能確認`);
    // 成交量
    if (volStr === '高') reasons.push(`高量下跌，量價齊跌確認`);
    else if (volStr === '中') reasons.push(`成交量中等，走勢正常`);
    // ADX
    if      (adx > 35) reasons.push(`ADX ${adx} 強趨勢，追空有效`);
    else if (adx > 22) reasons.push(`ADX ${adx} 趨勢成形`);
    // 評分
    if (score <= 15) reasons.push(`綜合評分 ${score}，強勢看跌信號`);
    else reasons.push(`綜合評分 ${score}，空頭信號確認`);
  }

  // ── 布林通道型態說明 ──
  if (_sBB) {
    const bbTags = _sBB.tags || [];
    if (isLong  && _sBB.walkingBull)  reasons.push(`📈 BB多頭走軌：連續貼近上軌，強勢趨勢延續`);
    if (!isLong && _sBB.walkingBear)  reasons.push(`📉 BB空頭走軌：連續貼近下軌，強勢下跌趨勢`);
    if (_sBB.isSqueezing && _sBBBonus > 0) reasons.push(`🔋 BB收窄蓄力：帶寬壓縮，即將爆發突破`);
    if (isLong  && _sBB.bbDivBear)    reasons.push(`⚠️ BB頂背離：新高但收盤未觸上軌，動能衰竭風險`);
    if (!isLong && _sBB.bbDivBull)    reasons.push(`⚠️ BB底背離：新低但收盤未觸下軌，動能衰竭風險`);
    if (isLong  && bbTags.includes('BB下軌觸及')) reasons.push(`布林下軌觸及（%B ${_sBB.pctB.toFixed(2)}），超賣反彈信號`);
    if (!isLong && bbTags.includes('BB上軌觸及')) reasons.push(`布林上軌觸及（%B ${_sBB.pctB.toFixed(2)}），超買壓回信號`);
  }
  // ── 123法則 / 2B法則 型態 ──
  if (_sPat) {
    if (isLong  && _sPat.bull123) reasons.push(`📐 123多頭型態確認：低點抬高後突破中間高點，趨勢反轉確認`);
    if (!isLong && _sPat.bear123) reasons.push(`📐 123空頭型態確認：高點降低後跌破中間低點，下跌確認`);
    if (isLong  && _sPat.bull2B)  reasons.push(`🔄 2B多頭型態：假跌破前低後強力反彈，空頭陷阱解除`);
    if (!isLong && _sPat.bear2B)  reasons.push(`🔄 2B空頭型態：假突破前高後快速回落，多頭陷阱確認`);
  }

  // 把 AI 學習警告加入進場依據
  learnWarn.forEach(w => reasons.push(`⚠️ ${w}`));
  if (hardAdxPenalty > 0) {
    reasons.push(`⚠️ ADX ${adx} 過低（${adx < 18 ? '< 18' : '< 22'}），震盪行情信心下調 ${hardAdxPenalty}%`);
  }

  // ── MTF 多週期確認 / 警告 ──
  if (_isLongTerm) {
    reasons.unshift(isLong
      ? `✅ 週線+日線+4H+1H+15m 五週期同向確認，長線多頭趨勢成立`
      : `✅ 週線+日線+4H+1H+15m 五週期同向確認，長線空頭趨勢成立`);
  } else if (_isShortTerm) {
    reasons.unshift(isLong
      ? `✅ 日線+4H+1H+15m 四週期同向確認，短線多頭趨勢成立`
      : `✅ 日線+4H+1H+15m 四週期同向確認，短線空頭趨勢成立`);
  } else {
    if (_wkAligned)  reasons.unshift(isLong ? `週線偏多確認` : `週線偏空確認`);
    if (_dayAligned) reasons.unshift(isLong ? `日線偏多確認` : `日線偏空確認`);
    if (_h4Aligned)  reasons.unshift(isLong ? `4H 偏多確認` : `4H 偏空確認`);
    if (_mtfContraH4)  reasons.push(`⚠️ 4H 逆向（${isLong ? '偏空' : '偏多'}），不符合短線進場條件`);
    if (_mtfContraWk)  reasons.push(`⚠️ 週線逆向，止損已放寬，謹慎持倉`);
    if (_mtfContraDay && !_mtfContraWk) reasons.push(`⚠️ 日線逆向，需嚴格止損`);
  }
  // R:R 不足警告（僅記錄，實際 blocked 在掃描層已過濾）
  if (rrBlocked) reasons.push(`⚠️ ${rrReason}`);

  // ── 止損說明 ──
  const slPct = ((Math.abs(entry - sl) / price) * 100).toFixed(2);
  let slReason;
  if (_slTag === 'ob') {
    slReason = `ICT Order Block 結構失效點（${_slStructure}），現價 ${isLong ? '下' : '上'}方 ${slPct}%；${_kzHigh ? _kzNow.name + ' Kill Zone 縮緊止損' : 'OB 邊界無效視為趨勢翻轉'}`;
  } else if (_slTag === '2b') {
    slReason = `2B 型態假突破失效點（${_slStructure}），現價 ${isLong ? '下' : '上'}方 ${slPct}%；假突破結束後反向動能強`;
  } else if (_slTag === '123') {
    slReason = `123 型態 P2 結構點失效（${_slStructure}），現價 ${isLong ? '下' : '上'}方 ${slPct}%；P2 破位則型態失效`;
  } else if (_slTag === 'ema50') {
    slReason = `EMA50 動態支撐失效（${_slStructure}），現價 ${isLong ? '下' : '上'}方 ${slPct}%；跌破 EMA50 趨勢中線視為方向翻轉`;
  } else if (_slTag === 'bblo' || _slTag === 'bbup') {
    slReason = `布林${isLong ? '下' : '上'}軌結構失效（${_slStructure}），現價 ${isLong ? '下' : '上'}方 ${slPct}%；收盤突破帶外視為趨勢翻轉`;
  } else if (_slTag === 'ema20') {
    slReason = `EMA20 短線均線失效（${_slStructure}），現價 ${isLong ? '下' : '上'}方 ${slPct}%；${adx > 25 ? 'ADX ' + adx + ' 趨勢確認，跌破均線即止損' : '震盪行情以均線作防守基準'}`;
  } else {
    slReason = `ATR 動態止損（現價 ${isLong ? '下' : '上'}方 ${slPct}%）；ADX ${adx}${adx > 30 ? ' 趨勢強勁' : adx > 22 ? ' 趨勢成形' : ' 偏弱，寬鬆止損'}，波動率 ${(atrPct * 100).toFixed(1)}%`;
  }

  // ── TP 說明 ──
  const _rr1 = risk > 0 ? (Math.abs(tp1 - entry) / risk).toFixed(1) : '–';
  const _rr2 = risk > 0 ? (Math.abs(tp2 - entry) / risk).toFixed(1) : '–';
  const _phSrc = _h4Hi > price * 1.002 ? '4H前高' : (_ob && _ob.high > price * 1.002) ? 'OB上沿' : 'BB上軌';
  const _plSrc = (_h4Lo > 0 && _h4Lo < price * 0.998) ? '4H前低' : (_ob && _ob.low < price * 0.998) ? 'OB下沿' : 'BB下軌';
  const _tp1DescMap = {
    prevhigh: `${_phSrc}結構目標（${_prevHigh > 0 ? '$' + _prevHigh.toPrecision(5).replace(/\.?0+$/, '') : '–'}）`,
    prevlow:  `${_plSrc}結構目標（${_prevLow  > 0 ? '$' + _prevLow.toPrecision(5).replace(/\.?0+$/, '')  : '–'}）`,
    fvg: 'FVG 缺口回補目標', ema50: 'EMA50 動態壓力/支撐',
    bbup: 'BB 上軌結構目標', bblo: 'BB 下軌結構目標', rr: `固定 R/R ${_rr1}:1`,
  };
  const _tp2DescMap = { ema200: 'EMA200 長期均線目標', ext: _isLongTerm ? '長線雙確認延伸目標' : 'MTF 延伸目標', rr: `波段 R/R ${_rr2}:1`, prevhigh: `${_phSrc}波段目標`, prevlow: `${_plSrc}波段目標` };
  const _mtfLabel = _isLongTerm ? '（週/日/4H/1H/15m 五週期確認）'
                  : _isShortTerm ? '（日/4H/1H/15m 四週期確認）'
                  : _mtfContraWk ? '（週線逆向，注意風險）'
                  : _mtfContraH4 ? '（4H逆向）'
                  : _mtfContraDay ? '（日線逆向）' : '';
  const tp1Reason = `${_tp1DescMap[_tp1Tag] || `短線目標 R/R ${_rr1}:1`}${_mtfLabel}，到達後減倉 60%`;
  const tp2Reason = `${_tp2DescMap[_tp2Tag] || `波段目標 R/R ${_rr2}:1`}，剩餘倉位移至成本`;

  return {
    entry, sl, tp1, tp2,
    entryReasons: reasons,                // 陣列版（buildTelegramText 優先使用）
    entryReason:  reasons.join('，'),     // 字串版（相容其他地方）
    slReason, tp1Reason, tp2Reason,
    rr1: _rr1, rr2: _rr2,
    atr, conf, rawConf, hardAdxPenalty, learnPenalty,
    macroPenalty: _sMacroPen, aiTrendPenalty: _sAIPen,
    techPenalty: _sTechPen, chipsPenalty: _sChipsPen,
    bbBonus: _sBBBonus, bbPenalty: _sBBPenalty, dirPenalty: _sDirPen,
    learnWarn,        // 警告字串陣列
    blockReasons,     // 硬封鎖原因陣列
    defenseChecks: [], // computeSimpleSetup 不計算防線審查，回傳空陣列
    learnFiltered: (conf < 60 || hardBlocked) && rawConf >= 60,
    hardBlocked,
    isRangeMode: false,
    flipRisks:   [],
    bigTrendBlocked: (_sWkSig.includes(isLong ? 'bear' : 'bull') && _sDySig.includes(isLong ? 'bear' : 'bull') && !_sDySig.includes('neutral')),
    rrBlocked, rrReason,
    isLongTerm: _isLongTermFinal, isShortTerm: _isShortTerm,
    mtfBothAlign: _mtfBothAlign, mtfContraWk: _mtfContraWk, mtfContraDay: _mtfContraDay, mtfContraH4: _mtfContraH4,
  };
}

function sendBrowserNotification(title, body, tag) {
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, {
      body,
      tag:  tag || 'csp-signal',
      icon: '/favicon.ico',
      requireInteraction: true,
    });
  } catch (e) { console.warn('Notification failed', e); }
}

async function requestBrowserNotifPermission() {
  if (!('Notification' in window)) {
    showToast('此瀏覽器不支援推播通知', 'error'); return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    saveSettings({ notifBrowser: true });
    state.settings = loadSettings();
    updateNotifBtn();
    showToast('瀏覽器通知已啟用 ✓', 'success');
    new Notification('加密掃描 Pro', { body: '交易信號通知已開啟！', tag: 'csp-test' });
  } else {
    saveSettings({ notifBrowser: false });
    state.settings = loadSettings();
    updateNotifBtn();
    showToast('通知權限被拒絕，請在瀏覽器設定中手動允許', 'error');
  }
}

function updateNotifBtn() {
  const btn = document.getElementById('s-notif-browser-btn');
  if (!btn) return;
  const perm = Notification.permission;
  const on   = perm === 'granted' && loadSettings().notifBrowser;
  btn.textContent  = on ? '✓ 已啟用' : perm === 'denied' ? '⚠ 已被封鎖' : '點擊啟用';
  btn.style.background = on ? 'rgba(0,230,118,0.15)' : perm === 'denied' ? 'rgba(255,29,68,0.15)' : '';
  btn.style.color = on ? 'var(--bull)' : perm === 'denied' ? 'var(--bear)' : '';
}

async function testTelegramNotif() {
  const token  = document.getElementById('s-tg-token')?.value.trim();
  const chatId = document.getElementById('s-tg-chatid')?.value.trim();
  if (!token || !chatId) { showToast('請先填入 Token 和 Chat ID', 'error'); return; }
  showToast('正在發送測試訊息...', 'info');
  const ok = await sendTelegramMessage(token, chatId,
    '✅ <b>加密掃描 Pro</b>\n\n測試訊息發送成功！\n交易信號通知已連接。');
  if (ok) {
    saveSettings({ notifTelegram: true, tgToken: token, tgChatId: chatId });
    state.settings = loadSettings();
    showToast('Telegram 測試成功！已儲存設定', 'success');
  } else {
    showToast('發送失敗，請確認 Token 和 Chat ID 是否正確', 'error');
  }
}

function renderPairsList() {
  const list  = document.getElementById('custom-pairs-list');
  const count = document.getElementById('pairs-count');
  if (!list) return;
  const pairs = loadPairs();
  if (count) count.textContent = `共 ${pairs.length} 個交易對`;
  list.innerHTML = pairs.map(p => `
    <div class="pair-chip">
      <span>${p.s}</span>
      <button class="pair-chip-rm" onclick="removePairFromList('${p.s}')" title="移除">×</button>
    </div>
  `).join('');
}

/* ── 设置页面 ───────────────────────────────────────────────── */
function populateSettingsPage() {
  const s = loadSettings();

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
  setVal('s-timeframe', s.timeframe);
  setVal('s-refresh',   String(s.refreshInterval));

  const dark = document.getElementById('s-dark');
  if (dark) dark.checked = s.darkMode !== false;

  const rev = document.getElementById('s-reversals');
  if (rev) rev.checked = s.reversals !== false;

  const apiUrl = document.getElementById('s-api-url');
  if (apiUrl) apiUrl.value = (s.apiUrl || 'http://127.0.0.1:8000') + '/scan';


  const bull = document.getElementById('s-bull-threshold');
  if (bull) { bull.value = s.bullThreshold || 60; document.getElementById('bull-thr-val').textContent = bull.value; }

  const bear = document.getElementById('s-bear-threshold');
  if (bear) { bear.value = s.bearThreshold || 40; document.getElementById('bear-thr-val').textContent = bear.value; }

  // 通知設定
  const tgToken  = document.getElementById('s-tg-token');
  const tgChatId = document.getElementById('s-tg-chatid');
  const tgToggle = document.getElementById('s-tg-toggle');
  const nBullThr = document.getElementById('s-notif-bull-thr');
  const nBearThr = document.getElementById('s-notif-bear-thr');
  if (tgToken)  tgToken.value  = s.tgToken  || '';
  if (tgChatId) tgChatId.value = s.tgChatId || '';
  if (tgToggle) tgToggle.checked = !!s.notifTelegram;
  if (nBullThr) { nBullThr.value = s.notifBullScore || 65; document.getElementById('notif-bull-val').textContent = nBullThr.value; }
  if (nBearThr) { nBearThr.value = s.notifBearScore || 35; document.getElementById('notif-bear-val').textContent = nBearThr.value; }
  updateNotifBtn();

  renderPairsList();
}

function saveAllSettings() {
  const apiRaw = document.getElementById('s-api-url')?.value || 'http://127.0.0.1:8000/scan';
  const patch  = {
    timeframe:       document.getElementById('s-timeframe')?.value        || '15m',
    refreshInterval: parseInt(document.getElementById('s-refresh')?.value) || 60,
    darkMode:        document.getElementById('s-dark')?.checked            ?? true,
    reversals:       document.getElementById('s-reversals')?.checked       ?? true,
    apiUrl:          apiRaw.replace('/scan',''),
    bullThreshold:   parseInt(document.getElementById('s-bull-threshold')?.value) || 60,
    bearThreshold:   parseInt(document.getElementById('s-bear-threshold')?.value) || 40,
    notifTelegram:   document.getElementById('s-tg-toggle')?.checked ?? false,
    tgToken:         document.getElementById('s-tg-token')?.value.trim()  || '',
    tgChatId:        document.getElementById('s-tg-chatid')?.value.trim() || '',
    notifBullScore:  parseInt(document.getElementById('s-notif-bull-thr')?.value) || 65,
    notifBearScore:  parseInt(document.getElementById('s-notif-bear-thr')?.value) || 35,
  };
  state.settings = saveSettings(patch);
  startRefreshCycle();
  syncSettingsToSW(); // 更新後台 SW 的設定
  showToast('设置已成功保存', 'success');
}


function resetAllSettings() {
  localStorage.removeItem('csp_settings');
  state.settings = loadSettings();
  populateSettingsPage();
  showToast('设置已重置为默认值', 'info');
}


function checkApiStatus() {
  const dot = document.getElementById('api-dot');
  const txt = document.getElementById('api-status-txt');
  if (!dot || !txt) return;

  if (state.dataSource === 'api') {
    dot.className   = 'api-dot online';
    txt.textContent = '已连接（本地 API）';
  } else if (state.dataSource === 'binance') {
    dot.className   = 'api-dot online';
    txt.textContent = '币安实时行情';
  } else {
    dot.className   = 'api-dot offline';
    txt.textContent = '演示模式（网络不可用）';
  }
}

function applySettingsToUI() {
  const s = loadSettings();
  state.settings  = s;
  state.timeframe = s.timeframe || '15m';
  document.querySelectorAll('.tf-btn[data-tf]').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === state.timeframe);
  });
}

/* ── 排序 ───────────────────────────────────────────────────── */
function sortTable(tblKey, sortKey, thEl) {
  const ss = state.sortState[tblKey];
  if (ss.key === sortKey) {
    ss.dir = ss.dir === 'asc' ? 'desc' : 'asc';
  } else {
    ss.key = sortKey;
    ss.dir = sortKey === 'score' ? (tblKey === 'bear' ? 'asc' : 'desc') : 'asc';
  }

  const tblId = tblKey === 'bull' ? 'bull-tbl' : tblKey === 'bear' ? 'bear-tbl' : 'ranking-tbl';
  document.querySelectorAll(`#${tblId} th[data-sort]`).forEach(th => th.classList.remove('sort-asc','sort-desc'));
  if (thEl) thEl.classList.add(ss.dir === 'asc' ? 'sort-asc' : 'sort-desc');

  if (tblKey === 'ranking') {
    renderRankingTable();
  } else {
    renderBullBearTables();
  }
}

function sortArr(arr, key, dir) {
  return arr.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'trend') { va = trendOrder(va); vb = trendOrder(vb); }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1  : -1;
    return 0;
  });
}

function trendOrder(t) {
  return { '強勢看漲': 5, '看漲': 4, '中性': 3, '看跌': 2, '強勢看跌': 1 }[t] || 3;
}

/* ── 搜索下拉 ───────────────────────────────────────────────── */
function updateSearchDropdown(query) {
  const dropdown = document.getElementById('search-dropdown');
  if (!dropdown) return;

  const q = query.trim().toUpperCase();
  if (q.length < 1) { dropdown.classList.remove('open'); return; }

  const matches = state.data
    .filter(d => d.symbol.replace('/USDT','').startsWith(q) || d.symbol.replace('/USDT','').includes(q))
    .slice(0, 8);

  if (matches.length === 0) { dropdown.classList.remove('open'); return; }

  dropdown.innerHTML = matches.map(d => `
    <div class="search-item" onclick="navigateTo('coin','${d.symbol}');
      document.getElementById('nav-search-input').value='';
      document.getElementById('search-dropdown').classList.remove('open')">
      <span class="search-item-sym">${d.symbol}</span>
      <span class="search-item-trend trend-badge ${trendClass(d.trend)}" style="font-size:0.72rem;padding:2px 7px">${d.trend}</span>
    </div>
  `).join('');
  dropdown.classList.add('open');
}

/* ── 消息提示 ───────────────────────────────────────────────── */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00e676" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff1744" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]||icons.info}</span><span class="toast-msg">${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* ── 辅助函数 ───────────────────────────────────────────────── */
function scoreColor(s) {
  if (s >= 78) return 'var(--bull)';
  if (s >= 58) return '#69f0ae';
  if (s >= 42) return 'var(--neutral)';
  if (s >= 22) return '#ff6d00';
  return 'var(--bear)';
}
function scoreColorBright(s) {
  if (s >= 58) return '#b2ffd6';
  if (s >= 42) return '#fff3b0';
  return '#ffaaaa';
}

function trendClass(trend) {
  const map = {
    '強勢看漲': 'trend-strong-bullish',
    '看漲':     'trend-bullish',
    '中性':     'trend-neutral',
    '看跌':     'trend-bearish',
    '強勢看跌': 'trend-strong-bearish',
  };
  return map[trend] || 'trend-neutral';
}

function trendArrow(trend) {
  if (trend === '強勢看漲') return '▲▲';
  if (trend === '看漲')     return '▲';
  if (trend === '強勢看跌') return '▼▼';
  if (trend === '看跌')     return '▼';
  return '◆';
}

function rsiColor(rsi) {
  if (rsi > 70) return 'var(--bear)';
  if (rsi > 60) return '#ff6d00';
  if (rsi < 30) return 'var(--bull)';
  if (rsi < 40) return '#69f0ae';
  return 'var(--text2)';
}
function rsiLabel(rsi) {
  if (rsi > 70) return '超买';
  if (rsi > 60) return '看涨';
  if (rsi < 30) return '超卖';
  if (rsi < 40) return '看跌';
  return '中性';
}

function adxColor(adx) {
  if (adx > 40) return 'var(--bull)';
  if (adx > 25) return 'var(--neutral)';
  return 'var(--text3)';
}
function adxLabel(adx) {
  if (adx > 40) return '强势趋势';
  if (adx > 25) return '趋势中';
  return '弱势/震荡';
}

function volClass(v) {
  if (v === '高') return 'high';
  if (v === '低') return 'low';
  return 'medium';
}

function fmtPrice(p) {
  if (p === undefined || p === null) return '--';
  const n = parseFloat(p);
  if (isNaN(n) || n <= 0) return '--';
  if (n >= 10000) return '$' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1000)  return '$' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)     return '$' + n.toFixed(4);
  if (n >= 0.01)  return '$' + n.toFixed(5);
  if (n >= 0.001) return '$' + n.toFixed(6);
  if (n >= 0.0001) return '$' + n.toFixed(7);
  return '$' + n.toFixed(10);
}

function fmtVolume(v) {
  if (!v) return '--';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + '亿';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + '百万';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toString();
}

function formatPrice(p) {
  if (p >= 1000)  return parseFloat(p.toFixed(2));
  if (p >= 1)     return parseFloat(p.toFixed(3));
  if (p >= 0.001) return parseFloat(p.toFixed(5));
  return parseFloat(p.toFixed(8));
}

/* ── 加密市場資金流動事件系統 ───────────────────────────────────── */
const CAPITAL_FLOW_EVENTS = [
  { name: 'FIFA 2026 世界盃', startDate: '2026-06-11', endDate: '2026-07-19', type: 'sports', flow: 'slight_outflow', desc: '全球最大體育賽事，歷史上大型體育賽事期間加密交易量可能下降，博彩與預測市場資金分流' },
  { name: '端午節假期', startDate: '2026-06-19', endDate: '2026-06-21', type: 'holiday_asia', flow: 'slight_outflow', desc: '中國及台灣節假日，亞洲市場交易量輕微下降' },
  { name: '美國獨立日', startDate: '2026-07-04', endDate: '2026-07-04', type: 'holiday_us', flow: 'neutral', desc: '美國假日，市場流動性下降，影響整體市場深度' },
  { name: '美股 Q2 財報季', startDate: '2026-07-08', endDate: '2026-08-14', type: 'economic', flow: 'uncertain', desc: '科技股財報影響市場風險偏好，超預期則有利加密市場情緒' },
  { name: 'EthCC 2026', startDate: '2026-07-14', endDate: '2026-07-17', type: 'conference', flow: 'slight_inflow', desc: '以太坊年度生態大會，ETH 及 DeFi 項目資金關注度提升' },
  { name: '中秋節假期', startDate: '2026-09-12', endDate: '2026-09-14', type: 'holiday_asia', flow: 'slight_outflow', desc: '中華圈傳統節日，亞洲交易員流動性輕微下降' },
  { name: 'Token2049 新加坡', startDate: '2026-09-17', endDate: '2026-09-18', type: 'conference', flow: 'inflow', desc: '亞洲最大加密峰會，東南亞機構資金活躍，市場情緒通常偏多' },
  { name: '中國國慶黃金周', startDate: '2026-10-01', endDate: '2026-10-07', type: 'holiday_asia', flow: 'outflow', desc: '中國七天長假，亞洲市場交易量大幅下降，歷史上此期間波動率可能升高' },
  { name: 'Devcon 2026', startDate: '2026-10-22', endDate: '2026-10-25', type: 'conference', flow: 'slight_inflow', desc: '以太坊核心開發者年會，技術升級公告通常提振 ETH 生態信心' },
  { name: '美國感恩節', startDate: '2026-11-26', endDate: '2026-11-27', type: 'holiday_us', flow: 'neutral', desc: '美國假日，但歷史上感恩節後加密市場有季節性上漲趨勢' },
  { name: '聖誕／跨年假期', startDate: '2026-12-24', endDate: '2027-01-02', type: 'holiday_global', flow: 'slight_outflow', desc: '全球假日季，市場流動性普遍下降，但散戶資金可能在年末重新佈局' },
  { name: '春節 2027（農曆新年）', startDate: '2027-02-06', endDate: '2027-02-15', type: 'holiday_asia', flow: 'outflow', desc: '中華圈最大傳統節日，歷史上春節前後亞洲資金獲利了結，節後資金通常回流' },
];

// 對不確定事件進行 AI 資金流向預測；對確定事件返回已知方向 + 歷史信心值
function computeCapitalFlowAIPred(event, fg, mkt) {
  const baseConf = { conference: 74, holiday_asia: 80, holiday_us: 72, holiday_global: 70, sports: 68, economic: 60, crypto_event: 72 };
  if (event.flow !== 'uncertain') {
    return { flow: event.flow, conf: baseConf[event.type] || 68, reason: null, isAI: false };
  }
  // AI 分析宏觀環境，預測資金流向
  const fgVal = fg ? parseInt(fg.value || '50') : 50;
  const chg   = mkt?.marketCapChange || 0;
  const dom   = mkt?.btcDominance   || 50;
  let bull = 0, bear = 0;
  const reasons = [];

  // 恐貪指數（分段更細）
  if (fgVal >= 70)     { bull += 2.5; reasons.push(`恐貪 ${fgVal}（極度貪婪）資金高度活躍`); }
  else if (fgVal > 60) { bull += 2;   reasons.push(`恐貪 ${fgVal}（貪婪）情緒偏多`); }
  else if (fgVal > 52) { bull += 1;   reasons.push(`恐貪 ${fgVal} 輕微偏多`); }
  else if (fgVal < 25) { bear += 2.5; reasons.push(`恐貪 ${fgVal}（極度恐慌）資金撤退`); }
  else if (fgVal < 38) { bear += 2;   reasons.push(`恐貪 ${fgVal}（恐慌）情緒偏空`); }
  else if (fgVal < 47) { bear += 1;   reasons.push(`恐貪 ${fgVal} 輕微偏空`); }

  // 市值 24h 變化（分段更細）
  if (chg > 3)          { bull += 2.5; reasons.push(`市值 +${chg.toFixed(1)}% 強力資金流入`); }
  else if (chg > 1.5)   { bull += 2;   reasons.push(`市值 +${chg.toFixed(1)}% 資金積極流入`); }
  else if (chg > 0.5)   { bull += 1;   reasons.push(`市值 +${chg.toFixed(1)}% 小幅流入`); }
  else if (chg < -3)    { bear += 2.5; reasons.push(`市值 ${chg.toFixed(1)}% 強力資金流出`); }
  else if (chg < -1.5)  { bear += 2;   reasons.push(`市值 ${chg.toFixed(1)}% 資金明顯外流`); }
  else if (chg < -0.5)  { bear += 1;   reasons.push(`市值 ${chg.toFixed(1)}% 小幅外流`); }

  // BTC 主導率（反映山寨資金偏好）
  if (dom < 42)       { bull += 1;   reasons.push(`BTC 主導 ${dom.toFixed(1)}% 山寨季格局，資金廣泛`); }
  else if (dom < 47)  { bull += 0.5; reasons.push(`BTC 主導 ${dom.toFixed(1)}% 輕微輪動`); }
  else if (dom > 60)  { bear += 1;   reasons.push(`BTC 主導 ${dom.toFixed(1)}% 高度集中，山寨受壓`); }
  else if (dom > 55)  { bear += 0.5; reasons.push(`BTC 主導 ${dom.toFixed(1)}% 偏高`); }

  // 事件類型加成（特定事件類型天生有流入/流出傾向）
  const eventTypeBias = { conference: 0.5, crypto_event: 0.5, holiday_us: -0.3, holiday_global: -0.5 };
  const typeBias = eventTypeBias[event.type] || 0;
  if (typeBias > 0) bull += typeBias;
  else if (typeBias < 0) bear += Math.abs(typeBias);

  const total = bull + bear || 1;
  let flow, conf;
  if (bull >= bear + 2)        { flow = 'inflow';        conf = Math.min(82, Math.round(58 + (bull / total) * 26)); }
  else if (bull >= bear + 0.8) { flow = 'slight_inflow'; conf = Math.min(74, Math.round(54 + (bull / total) * 22)); }
  else if (bear >= bull + 2)   { flow = 'outflow';       conf = Math.min(82, Math.round(58 + (bear / total) * 26)); }
  else if (bear >= bull + 0.8) { flow = 'slight_outflow';conf = Math.min(74, Math.round(54 + (bear / total) * 22)); }
  else                          { flow = 'neutral';       conf = Math.max(50, Math.round(50 - Math.abs(bull - bear) * 2)); }
  return { flow, conf, reason: reasons.slice(0, 2).join('、'), isAI: true };
}

// Telegram 每日報告用：取 5 天內 + 進行中的事件，格式化為 Telegram HTML 文字
function buildCapitalFlowTelegramSection(fg, mkt) {
  const now   = Date.now();
  const MS_DAY = 86400000;
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const FLOW_TXT = {
    inflow:        '↑ 資金流入',
    slight_inflow: '↗ 輕微流入',
    outflow:       '↓ 資金流出',
    slight_outflow:'↘ 輕微流出',
    neutral:       '— 中性',
  };
  const TYPE_ICON = { conference:'🏛', holiday_asia:'🏮', holiday_us:'🇺🇸', holiday_global:'🌍', sports:'⚽', economic:'📊', crypto_event:'🔗' };

  const relevant = CAPITAL_FLOW_EVENTS.map(ev => {
    const start  = new Date(ev.startDate + 'T00:00:00');
    const end    = new Date(ev.endDate   + 'T00:00:00');
    const endMs  = end.getTime() + MS_DAY - 1;
    const startMs = start.getTime();
    const isActive  = now >= startMs && now <= endMs;
    const daysUntil = Math.round((startMs - now) / MS_DAY);
    const daysLeft  = Math.round((endMs - now) / MS_DAY);
    if (isActive || (daysUntil >= 0 && daysUntil <= 10)) {
      return { ...ev, start, end, endMs, isActive, daysUntil, daysLeft };
    }
    return null;
  }).filter(Boolean).sort((a, b) => a.start - b.start);

  if (!relevant.length) return null;

  return relevant.map(ev => {
    const icon = TYPE_ICON[ev.type] || '📌';
    const pred = computeCapitalFlowAIPred(ev, fg, mkt);
    const timeStr = ev.isActive
      ? `進行中，${ev.daysLeft <= 0 ? '今天結束' : `還有 ${ev.daysLeft} 天`}`
      : ev.daysUntil === 0 ? '今天開始' : `${ev.daysUntil} 天後開始`;
    const flowStr = pred.isAI
      ? `AI預測 ${FLOW_TXT[pred.flow] || '—'}（信心 ${pred.conf}%）${pred.reason ? `，${pred.reason}` : ''}`
      : `${FLOW_TXT[pred.flow] || pred.flow}（信心 ${pred.conf}%）`;
    const mktDir = (pred.flow === 'inflow' || pred.flow === 'slight_inflow')
      ? '▲ 偏多'
      : (pred.flow === 'outflow' || pred.flow === 'slight_outflow')
        ? '▼ 偏空'
        : '◆ 中性';
    return `${icon} <b>${esc(ev.name)}</b>（${timeStr}）\n   💹 資金流動：${flowStr}\n   📊 市場方向：${mktDir}`;
  }).join('\n\n');
}

function buildCapitalFlowEventsWidget() {
  const TYPE_ICON = {
    conference:    '🏛️',
    holiday_asia:  '🏮',
    holiday_us:    '🇺🇸',
    holiday_global:'🌍',
    sports:        '⚽',
    economic:      '📊',
    crypto_event:  '🔗',
  };

  const FLOW_META = {
    inflow:        { label: '↑ 資金流入',  bg: 'rgba(34,197,94,.18)',  color: '#4ade80' },
    slight_inflow: { label: '↗ 輕微流入',  bg: 'rgba(34,197,94,.10)',  color: '#86efac' },
    outflow:       { label: '↓ 資金流出',  bg: 'rgba(239,68,68,.18)',  color: '#f87171' },
    slight_outflow:{ label: '↘ 輕微流出',  bg: 'rgba(251,146,60,.18)', color: '#fb923c' },
    uncertain:     { label: '◆ 不確定',    bg: 'rgba(234,179,8,.18)',  color: '#facc15' },
    neutral:       { label: '— 中性',      bg: 'rgba(148,163,184,.15)',color: '#94a3b8' },
  };

  const now    = Date.now();
  const MS_DAY = 86400000;
  const MS_3D  = 3  * MS_DAY;
  const MS_7D  = 7  * MS_DAY;
  const MS_30D = 30 * MS_DAY;
  const MS_90D = 90 * MS_DAY;

  function parseDate(s) { return new Date(s + 'T00:00:00'); }
  function fmtMD(d) { return `${d.getMonth()+1}/${d.getDate()}`; }

  function getStatus(start, end) {
    const s = start.getTime(), e = end.getTime() + MS_DAY - 1;
    if (now >= s && now <= e)         return 'active';
    if (now > e && now - e <= MS_3D)  return 'recent';
    if (now < s && s - now <= MS_7D)  return 'soon';
    if (now < s && s - now <= MS_30D) return 'near';
    if (now < s && s - now <= MS_90D) return 'future';
    return null;
  }

  function timeLabel(start, end) {
    const s = start.getTime(), e = end.getTime() + MS_DAY - 1;
    if (now >= s && now <= e) {
      const d = Math.round((e - now) / MS_DAY);
      return d <= 0 ? '今天結束' : `進行中，${d}天後結束`;
    }
    if (now > e) return `${Math.round((now - e) / MS_DAY)}天前結束`;
    const d = Math.round((s - now) / MS_DAY);
    return d === 0 ? '今天開始' : `${d}天後開始`;
  }

  const fg  = typeof _macroCache !== 'undefined' ? _macroCache?.fg  : null;
  const mkt = typeof _macroCache !== 'undefined' ? _macroCache : null;

  const enriched = CAPITAL_FLOW_EVENTS.map(ev => {
    const start  = parseDate(ev.startDate);
    const end    = parseDate(ev.endDate);
    const status = getStatus(start, end);
    const pred   = computeCapitalFlowAIPred(ev, fg, mkt);
    return { ...ev, start, end, status, pred };
  }).filter(ev => ev.status !== null).sort((a, b) => a.start - b.start);

  const GROUPS = [
    { key: 'active', label: '🔴 進行中' },
    { key: 'soon',   label: '⚡ 即將到來（7天內）' },
    { key: 'near',   label: '📅 近期（30天內）' },
    { key: 'future', label: '🗓 未來三個月' },
    { key: 'recent', label: '🕐 剛結束' },
  ];

  function renderCard(ev) {
    const { pred } = ev;
    const meta     = FLOW_META[pred.flow] || FLOW_META.neutral;
    const origMeta = FLOW_META[ev.flow] || FLOW_META.uncertain;
    const icon     = TYPE_ICON[ev.type] || '📌';
    const isActive = ev.status === 'active';
    const dateStr  = ev.startDate === ev.endDate ? fmtMD(ev.start) : `${fmtMD(ev.start)} – ${fmtMD(ev.end)}`;
    const borderLeft = isActive ? `border-left:3px solid ${meta.color};` : '';
    const bgExtra    = isActive ? 'background:rgba(255,255,255,.055);' : '';
    // Badge: if AI prediction show with confidence, otherwise show known direction
    const badge = pred.isAI
      ? `<span style="font-size:0.66rem;padding:2px 5px;border-radius:4px;background:rgba(99,102,241,.18);color:#a5b4fc;white-space:nowrap">🤖 AI ${meta.label}（${pred.conf}%）</span>`
      : `<span style="font-size:0.68rem;padding:2px 6px;border-radius:4px;background:${meta.bg};color:${meta.color};white-space:nowrap">${meta.label}（${pred.conf}%）</span>`;
    const reasonLine = pred.isAI && pred.reason
      ? `<div style="font-size:0.69rem;color:#a5b4fc;margin-top:2px">🤖 AI依據：${pred.reason}</div>`
      : '';

    return `<div style="background:rgba(255,255,255,.03);${bgExtra}border:1px solid rgba(255,255,255,.07);${borderLeft}border-radius:8px;padding:9px 12px;margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:6px;min-width:0">
          <span style="font-size:1rem;flex-shrink:0">${icon}</span>
          <span style="font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ev.name}</span>
          <span style="font-size:0.75rem;color:var(--text3);white-space:nowrap">${dateStr}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <span style="font-size:0.72rem;color:var(--text3);white-space:nowrap">${timeLabel(ev.start, ev.end)}</span>
          ${badge}
        </div>
      </div>
      <div style="font-size:0.71rem;color:var(--text3);margin-top:3px">${ev.desc}</div>
      ${reasonLine}
    </div>`;
  }

  let body = '';
  for (const grp of GROUPS) {
    const items = enriched.filter(ev => ev.status === grp.key);
    if (!items.length) continue;
    body += `<div style="font-size:0.72rem;color:var(--text3);font-weight:600;margin:10px 0 6px;text-transform:uppercase;letter-spacing:0.05em">${grp.label}</div>`;
    body += items.map(renderCard).join('');
  }

  if (!body) {
    body = `<div style="font-size:0.8rem;color:var(--text3);padding:12px 0">目前 90 天內無重大資金流動事件</div>`;
  }

  return `<div class="outlook-header" style="margin-bottom:10px">
    <span class="outlook-title">📊 加密市場資金流動事件</span>
    <span class="outlook-bias" style="color:var(--text3);font-size:0.78rem">節假日・賽事・會議・總經</span>
  </div>
  ${body}`;
}
// v20260617q
