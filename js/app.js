/* ============================================================
   app.js — 主應用邏輯（繁體中文 + 幣安實時K線版）
   ============================================================ */

/* ── 交易設置緩存（供 Telegram 通知使用）────────────────────── */
const _tradeSetupCache = {};
let   _macroCache      = null;
let   _positionsScanTimer = null;
let   _bgScanTimer     = null;  // 持續背景掃描（每 30 秒，與頁面無關）

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
  } catch (e) {
    console.error('[init] fetchMarketData 失敗，使用空數據', e);
    state.data     = [];
    state.filtered = [];
  }
  // 後續處理獨立保護，不影響 state.data
  try { updateOpenTrades(state.data); } catch(e) { console.error('[init] updateOpenTrades 錯誤:', e); }

  hideLoading();
  hideScanBar();
  renderAll();
  loadDashboardMacro();
  startRefreshCycle();
  startDailyBriefingCheck();
  startEconCalendarCheck();
  bindEvents();
  checkApiStatus();
  // 預載宏觀快取後再執行首次掃描，確保 isRangeMode 依真實宏觀決定
  _prefetchMacroCache().then(() => {
    try { recordSignalsFromScan(state.data); } catch(e) { console.error('[init] recordSignalsFromScan 錯誤:', e); }
  });
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
  }, 30000);

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
  // 最終信心度：由 rawConf 扣除各懲罰計算（與持倉頁一致）
  const conf     = t.rawConf != null
    ? Math.max(0, t.rawConf - (t.hardAdxPenalty||0) - (t.learnPenalty||0) - (t.macroPenalty||0) - (t.aiTrendPenalty||0) - (t.techPenalty||0) - (t.chipsPenalty||0))
    : (t.conf || Math.min(90, t.score || 60));
  const confClr  = conf >= 75 ? 'var(--bull)' : conf >= 60 ? '#ff6d00' : 'var(--text3)';
  const ltBias  = t.longTermBias;
  const isLong_ = t.direction === 'long';
  const isLongTermTrade = t.canScaleIn === true;
  // 長線與短線方向一致才標示〔長線單〕
  const ltTag   = (ltBias === 'long' && isLong_) || (ltBias === 'short' && !isLong_)
                ? ' <span class="lt-tag lt-bull">〔長線單〕</span>'
                : '';

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

  // 進場原因
  const reasons = (t.entryReason || '').split('，').filter(Boolean);
  const reasonsHtml = reasons.map(r => `<div class="level-desc" style="margin-bottom:3px">• ${r}</div>`).join('');

  const fmt = v => v ? fmtPrice(v) : '--';
  const pctStr = (a, b) => {
    if (!a || !b) return '';
    const d = ((b - a) / Math.abs(a) * 100);
    return `<span style="font-size:0.72rem;color:var(--text3);margin-left:4px">${d >= 0 ? '+' : ''}${d.toFixed(2)}%</span>`;
  };

  // 長線單止盈：只顯示最終止盈位（ltTP 或 tp1）；短線單：tp1 + tp2
  const ltFinalTP = t.ltTP || tp1;
  const siTargets = t.scaleInTargets || [];
  const tpRows = isLongTermTrade ? `
    ${siTargets.map((lv, i) => `
    <div class="level-row level-tp1" style="border-left:3px solid rgba(99,102,241,.5)">
      <div class="level-tag">📈 加倉${i+1}</div>
      <div class="level-desc">加倉目標位</div>
      <div class="level-price-val" style="color:#a78bfa">${fmt(lv)}${pctStr(entry, lv)}</div>
    </div>`).join('')}
    <div class="level-row level-tp2" style="border-left:3px solid rgba(34,197,94,.6)">
      <div class="level-tag">🏁 最終止盈</div>
      <div class="level-desc">${t.tp1Reason || '長線最終目標'}</div>
      <div class="level-price-val" style="color:#22c55e">${fmt(ltFinalTP)}${pctStr(entry, ltFinalTP)}</div>
    </div>` : `
    <div class="level-row level-tp1">
      <div class="level-tag">🎯 止盈1</div>
      <div class="level-desc">${t.tp1Reason || '—'}</div>
      <div class="level-price-val">${fmt(tp1)}${pctStr(entry, tp1)}</div>
    </div>
    <div class="level-row" style="border-left:3px solid #22c55e">
      <div class="level-tag">🚀 止盈2</div>
      <div class="level-desc">${t.tp2Reason || '—'}</div>
      <div class="level-price-val">${fmt(tp2)}${pctStr(entry, tp2)}</div>
    </div>`;

  return `
    <div class="setup-verdict ${isLong ? 'verdict-long' : 'verdict-short'}">
      <div class="verdict-dir">
        <span class="verdict-arrow">${isLong ? '▲' : '▼'}</span>
        <span class="verdict-label">${dirLabel}</span>
        ${ltTag}
        <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">持倉進行中</span>
      </div>
      <div class="verdict-conf-wrap">
        <span style="font-size:0.78rem;color:var(--text3)">信心度</span>
        <div class="conf-bar"><div class="conf-fill" style="width:${conf}%;background:${confClr}"></div></div>
        <span style="color:${confClr};font-weight:700;font-size:0.9rem">${conf}%</span>
      </div>
    </div>
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
    <div style="margin-top:10px;font-size:0.72rem;color:var(--text3)">信號時間：${fmtDateTime(t.timestamp)}　進場確認：<strong style="color:var(--bull)">${t.entryTime ? fmtDateTime(t.entryTime) : '—'}</strong></div>`;
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

  return `<div class="pending-banner">
    <div class="pending-icon">⏳</div>
    <div>
      <div class="pending-title" style="color:${dirColor}">${dirLabel}</div>
      <div class="pending-sub">等待現價觸及進場位後自動確認開倉</div>
    </div>
  </div>
  <div class="setup-levels" style="margin-top:10px">
    <div class="level-row level-entry">
      <div class="level-tag">📍 進場位</div>
      <div class="level-desc">${distPct !== null ? `現價距進場位 <span style="color:${distClr}">${distPct > 0 ? '+' : ''}${distPct}%</span>` : '計算中…'}</div>
      <div class="level-price-val">${fmtPrice(entry)}</div>
    </div>
    ${t.canScaleIn ? `
    ${(t.scaleInTargets || []).map((lv, i) => `
    <div class="level-row level-tp1" style="border-left:3px solid rgba(99,102,241,.5)">
      <div class="level-tag">📈 加倉${i+1}</div>
      <div class="level-desc">加倉目標位</div>
      <div class="level-price-val" style="color:#a78bfa">${fmtPrice(lv)}</div>
    </div>`).join('')}
    <div class="level-row level-tp2" style="border-left:3px solid rgba(34,197,94,.6)">
      <div class="level-tag">🏁 最終止盈</div>
      <div class="level-desc">${t.tp1Reason || '長線最終目標'}</div>
      <div class="level-price-val" style="color:#22c55e">${fmtPrice(t.ltTP || tp1)}</div>
    </div>` : `
    <div class="level-row level-tp1">
      <div class="level-tag">🎯 止盈一</div>
      <div class="level-desc">${t.tp1Reason || '短線目標'}</div>
      <div class="level-price-val">${fmtPrice(tp1)}</div>
    </div>
    <div class="level-row level-tp2">
      <div class="level-tag">🚀 止盈二</div>
      <div class="level-desc">${t.tp2Reason || '波段目標'}</div>
      <div class="level-price-val">${fmtPrice(tp2)}</div>
    </div>`}
    <div class="level-row level-sl">
      <div class="level-tag">🛑 止損</div>
      <div class="level-desc">${t.slReason || '結構止損'}</div>
      <div class="level-price-val">${fmtPrice(sl)}</div>
    </div>
  </div>
  <div style="margin-top:10px;font-size:0.72rem;color:var(--text3)">信號時間：${fmtDateTime(t.timestamp)}　有效期至：${fmtDateTime(t.timestamp + SIGNAL_COOLDOWN * 2)}</div>`;
}

/* ── 交易建議（支撐壓力 + 訂單流 + RSI 三位一體）────────────── */
function buildTradeSetup(coin, mtfData, deriv, globalMkt, whale, fearGreed) {
  const price = parseFloat(coin.price) || 0;
  if (!price) return '<div class="adv-loading">價格數據不可用</div>';

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
      const hardAdxNow = adxNow < 18 ? 28 : adxNow < 22 ? 14 : 0;
      const vp1hNow  = mtfData['1h']?.vp;
      const mtfAlignNow = ['15m','1h','4h','1d'].filter(tf => {
        const sig = mtfData[tf]?.signal;
        return sig && (isLongNow ? sig.signal?.includes('bull') : sig.signal?.includes('bear'));
      }).length;
      const learnCtxNow = {
        abovePOC:      vp1hNow?.priceAbovePOC ?? null,
        whaleBias:     whale?.bias || null,
        volDivergence: mtfData['1h']?.volAI?.divergence || null,
        mtfAlign:      mtfAlignNow,
        slType:        existingActive.entrySlType || 'atr',
        skipAdxRule:   true,
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
          macroPenNow = against >= 3 ? 18 : against >= 2 ? 12 : against >= 1 ? 5 : 0;
          const wb = computeWeeklyAIBias(fg, gm);
          const tb = computeTodayAIBias(fg, gm);
          const wkAligned = (isLongNow && wb.bias.includes('bull')) || (!isLongNow && wb.bias.includes('bear'));
          const wkOpposed = !wkAligned && wb.bias !== 'neutral';
          const tdAligned = (isLongNow && tb.bias.includes('bull')) || (!isLongNow && tb.bias.includes('bear'));
          const tdOpposed = !tdAligned && tb.bias !== 'neutral';
          if (wkOpposed) { const p = wb.bias.includes('strong') ? 8 : 4; aiTrendPenNow += p; aiTrendReasonsNow.push(`本週 AI ${wb.biasLabel}，逆向 -${p}%`); }
          else aiTrendReasonsNow.push(`本週 AI ${wb.biasLabel}${wkAligned ? ' ✓ 同向' : ''}`);
          if (tdOpposed) { aiTrendPenNow += 5; aiTrendReasonsNow.push(`今日 AI ${tb.biasLabel}，逆風 -5%`); }
          else aiTrendReasonsNow.push(`今日 AI ${tb.biasLabel}${tdAligned ? ' ✓ 同向' : ''}`);
        } catch(e) {}
      }

      const rawConfNow = existingActive.rawConf || Math.max(existingActive.conf || 60, Math.min(90, existingActive.score || 60));
      const freshConf  = Math.max(0, rawConfNow - hardAdxNow - macroPenNow - aiTrendPenNow - learnPenNow);
      if (Math.abs((existingActive.conf || 0) - freshConf) >= 1) {
        const tlogEdit = loadTradeLog();
        const editIdx  = tlogEdit.findIndex(t => t.id === existingActive.id);
        if (editIdx >= 0) {
          tlogEdit[editIdx].conf    = freshConf;
          tlogEdit[editIdx].rawConf = rawConfNow;
          existingActive.conf       = freshConf;
          saveTradeLog(tlogEdit);
        }
      }

      // ── 信心扣分明細面板（附加在持倉/掛單卡片下方）──
      const _cc = v => v >= 85 ? '#22c55e' : v >= 80 ? '#4ade80' : v >= 75 ? '#f59e0b' : '#ef4444';
      const totalPenNow = hardAdxNow + macroPenNow + aiTrendPenNow + learnPenNow;
      const confPanelHtml = `<div style="margin-top:12px;padding:10px 13px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px">
        <div style="font-size:0.74rem;font-weight:700;color:var(--text2);margin-bottom:8px">📊 信心評估（動態更新）</div>
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:0.73rem;margin-bottom:8px;background:rgba(255,255,255,.02);border-radius:6px;padding:6px 8px">
          <span style="color:var(--text3)">原始</span>
          <span style="font-weight:700;color:${_cc(rawConfNow)}">${rawConfNow}%</span>
          ${hardAdxNow > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">ADX -${hardAdxNow}</span>` : ''}
          ${macroPenNow > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">宏觀 -${macroPenNow}</span>` : ''}
          ${aiTrendPenNow > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">AI趨勢 -${aiTrendPenNow}</span>` : ''}
          ${learnPenNow > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">風控 -${learnPenNow}</span>` : ''}
          <span style="color:var(--text3)">= 最終</span>
          <span style="font-weight:700;font-size:0.82rem;color:${_cc(freshConf)}">${freshConf}%</span>
          ${totalPenNow === 0 ? `<span style="font-size:0.7rem;color:#22c55e">（無扣分）</span>` : ''}
        </div>
        <div style="font-size:0.72rem;line-height:1.8">
          ${hardAdxNow > 0
            ? `<div style="color:#f59e0b">⚡ ADX ${adxNow}${adxNow < 18 ? '（< 18，震盪過弱）' : '（< 22，趨勢偏弱）'}，扣 -${hardAdxNow}%</div>`
            : `<div style="color:#22c55e">✓ ADX ${adxNow} 趨勢強度正常，無扣分</div>`}
          ${macroReasonsNow.length
            ? macroReasonsNow.map(r => `<div style="color:#f59e0b">⚠️ ${r}（宏觀逆風，共扣 -${macroPenNow}%）</div>`).join('')
            : `<div style="color:#22c55e">✓ 宏觀環境無明顯逆風，無扣分</div>`}
          ${aiTrendReasonsNow.map(r => `<div style="color:${r.includes('逆') || r.includes('逆風') ? '#f59e0b' : '#22c55e'}">${r.includes('逆') ? '⚠️' : '✓'} ${r}</div>`).join('')}
          ${learnResultNow.hardBlocked
            ? learnResultNow.blockReasons.slice(0, 2).map(r => `<div style="color:var(--bear)">🚫 ${r}</div>`).join('')
            : learnPenNow > 0
              ? `<div style="color:#f59e0b">⚠️ AI 風控：止損歷史記憶觸發，扣 -${learnPenNow}%</div>`
              : `<div style="color:#22c55e">✓ AI 風控：無止損記憶觸發</div>`}
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

  const totalBull = bullScore + derivBullBonus + macroBullBonus + whaleBullBonus + orderFlowBull + volAIBull + vpBull + d1Bull + trapBull + trap4hBull + bbBull;
  const totalBear = bearScore + derivBearBonus + macroBearBonus + whaleBearBonus + orderFlowBear + volAIBear + vpBear + d1Bear + trapBear + trap4hBear + bbBear;

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
  // 信號強度未達 70%（頂級交易員只取高信心設置）一律觀望
  if (direction !== 'wait') {
    const prelimConf = Math.min(90, Math.max(40, 40 + (direction === 'long' ? totalBull : totalBear) * 7));
    if (prelimConf < 70) direction = 'wait';
  }

  // ── 大時間框架趨勢一致性強制篩選 ──────────────────────────────
  // 規則：
  //   ① 4H + 1D 雙雙確認同向 → 全部通過，建議交易
  //   ② 任一中性或方向分歧（含單邊確認）→ 中性趨勢，提示謹慎操作，仍可進場
  //   ③ 4H + 1D 雙雙確認反向 → 嚴格攔截，不建議進場
  const bigBullSig = (h4?.signal?.includes('bull') ? 1 : 0) + (d1sig_?.signal?.includes('bull') ? 1 : 0);
  const bigBearSig = (h4?.signal?.includes('bear') ? 1 : 0) + (d1sig_?.signal?.includes('bear') ? 1 : 0);
  // 需要兩個大時框架同時確認才算趨勢確立；單邊確認或方向分歧均視為中性
  const bigTrend   = bigBullSig >= 2 ? 'bull'
                   : bigBearSig >= 2 ? 'bear' : 'mixed';
  const h4TrendLabel = h4?.signal?.includes('bull') ? '▲ 偏多'
                     : h4?.signal?.includes('bear') ? '▼ 偏空' : '— 中性';
  const d1TrendLabel = d1sig_?.signal?.includes('bull') ? '▲ 偏多'
                     : d1sig_?.signal?.includes('bear') ? '▼ 偏空' : '— 中性';
  let bigTrendBlocked = false, bigTrendBlockReason = '';
  if (direction === 'long' && bigTrend === 'bear') {
    // 4H + 1D 雙雙確認偏空 → 嚴格攔截做多
    direction = 'wait';
    bigTrendBlocked = true;
    bigTrendBlockReason = `4H 與日線雙雙偏空（4h ${h4TrendLabel} / 日線 ${d1TrendLabel}），小週期做多逆大趨勢，嚴格攔截`;
  } else if (direction === 'short' && bigTrend === 'bull') {
    // 4H + 1D 雙雙確認偏多 → 嚴格攔截做空
    direction = 'wait';
    bigTrendBlocked = true;
    bigTrendBlockReason = `4H 與日線雙雙偏多（4h ${h4TrendLabel} / 日線 ${d1TrendLabel}），小週期做空逆大趨勢，嚴格攔截`;
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
  const _pl4h = mtfData['4h']?.pivotLevels || {};
  const _pld1 = mtfData['1d']?.pivotLevels || {};
  const _plw1 = mtfData['1w']?.pivotLevels || {};
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
      _dirAlignMiss = `大方向宏觀/本週/今日預測僅 ${_alignCnt} 個與${_isLongDir ? '多' : '空'}方向一致（需 ≥ 2）`;
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
    // 大時間框架趨勢狀態顯示
    const h4Clr_w = h4?.signal?.includes('bull') ? 'var(--bull)' : h4?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)';
    const d1Clr_w = d1sig_?.signal?.includes('bull') ? 'var(--bull)' : d1sig_?.signal?.includes('bear') ? 'var(--bear)' : 'var(--text3)';
    const bigTrendPanel = `<div style="margin-top:12px;padding:10px 12px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.2);border-radius:9px">
      <div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px">📐 大時間框架趨勢</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span style="font-size:0.73rem;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.05);color:${h4Clr_w};border:1px solid ${h4Clr_w}40">4H ${h4TrendLabel}${h4?.rsi != null ? ' RSI '+h4.rsi : ''}</span>
        <span style="font-size:0.73rem;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.05);color:${d1Clr_w};border:1px solid ${d1Clr_w}40">日線 ${d1TrendLabel}${d1sig_?.rsi != null ? ' RSI '+d1sig_.rsi : ''}</span>
        ${bigTrendBlocked ? `<span style="font-size:0.73rem;color:var(--bear);font-weight:600">❌ 大小方向衝突</span>` : `<span style="font-size:0.73rem;color:#f59e0b">⚠️ 等待大趨勢確認</span>`}
      </div>
    </div>`;
    return `<div class="setup-wait">
      <div class="setup-wait-icon">${bigTrendBlocked ? '🚫' : '⏳'}</div>
      <div class="setup-wait-title">${bigTrendBlocked ? '大小趨勢方向衝突，暫不進場' : '建議觀望，短線方向未明'}</div>
      <ul class="setup-wait-reasons">
        ${reasons.length ? reasons.map(r => `<li>${r}</li>`).join('') : '<li>短線訊號不足，耐心等待 15m/1h 有效突破</li>'}
      </ul>
      ${bigTrendPanel}
      ${!bigTrendBlocked ? `<div class="setup-wait-cond">
        <strong>等待條件：</strong>15m/1h 帶量實體K棒收破
        <span style="color:var(--bull)">${fmtPrice(entryHigh)}</span>（做多）
        或 <span style="color:var(--bear)">${fmtPrice(entryLow)}</span>（做空）
      </div>` : ''}
    </div>`;
  }

  // ── 震盪模式（宏觀+今日AI均為中性）→ 給出震盪交易建議 ──────────
  if (isRangeMode && !bigTrendBlocked) {
    const bb1hPctB  = bb1h_?.pctB ?? 0.5;
    // 判斷震盪方向：BB%B 或 RSI 任一達到極值即可觸發
    let rangeDir = null;
    if      (bb1hPctB >= 0.76 || rsi > 63) rangeDir = 'short';
    else if (bb1hPctB <= 0.24 || rsi < 37) rangeDir = 'long';

    // 方向確認：宏觀、週線AI、今日AI 三者中 2+ 個需與震盪方向同向才執行
    const _rMBull = (_btsNetDir === 'strong_bull' || _btsNetDir === 'bull' || _btsNetDir === 'slight_bull') ? 1 : 0;
    const _rWBull = weeklyBiasData.bias?.includes('bull') ? 1 : 0;
    const _rTBull = todayBiasData.bias?.includes('bull')  ? 1 : 0;
    const _rMBear = (_btsNetDir === 'strong_bear' || _btsNetDir === 'bear' || _btsNetDir === 'slight_bear') ? 1 : 0;
    const _rWBear = weeklyBiasData.bias?.includes('bear') ? 1 : 0;
    const _rTBear = todayBiasData.bias?.includes('bear')  ? 1 : 0;
    if (rangeDir === 'long'  && (_rMBull + _rWBull + _rTBull) < 2) rangeDir = null;
    if (rangeDir === 'short' && (_rMBear + _rWBear + _rTBear) < 2) rangeDir = null;

    if (rangeDir) {
      const rRawConf = Math.min(80, 65 + Math.round(Math.abs(bb1hPctB - 0.5) * 50));
      let rLearnPen = 0, rHardBlocked = false;
      try { ({ penalty: rLearnPen, hardBlocked: rHardBlocked } = applyLearnAdjustment(rangeDir, rsi, coin.adx || 20, {})); } catch(e) {}
      // 宏觀 + AI 逆風扣分（依震盪方向計算）
      const _rIsLongDir = rangeDir === 'long';
      let _rMacroPen = 0, _rAIPen = 0;
      try {
        if (fearGreed || globalMkt) {
          const _rfgV = fearGreed ? parseInt(fearGreed.value || '50') : 50;
          const _rchg = globalMkt?.marketCapChange || 0;
          const _rdom = globalMkt?.btcDominance   || 50;
          let _ragt = 0;
          if (_rIsLongDir) {
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
        const _rwBias = weeklyBiasData.bias || '';
        const _rtBias = todayBiasData.bias  || '';
        const _rwOp = _rIsLongDir ? _rwBias.includes('bear') : _rwBias.includes('bull');
        const _rtOp = _rIsLongDir ? _rtBias.includes('bear') : _rtBias.includes('bull');
        if (_rwOp) _rAIPen += _rwBias.includes('strong') ? 8 : 4;
        if (_rtOp) _rAIPen += 5;
      } catch(_re) {}
      // 最終信心度：ADX不適用震盪單，扣學習+宏觀+AI
      const rConf = Math.max(0, rRawConf - rLearnPen - _rMacroPen - _rAIPen);

      // 門檻檢查：扣完所有分後 < 70% 或 AI 硬封鎖 → 不顯示也不記錄
      if (rConf >= 70 && !rHardBlocked) {
      const rIsLong  = rangeDir === 'long';
      const rIcon    = rIsLong ? '▲' : '▼';
      const rColor   = rIsLong ? 'var(--bull)' : 'var(--bear)';
      // 震盪進場：優先貼近 1H S/R 結構位（精度進場）
      const _rNearSup = supps.find(s => (price - s) < atr * 1.8);
      const _rNearRes = resists.find(r => (r - price) < atr * 1.8);
      const rEntry = rIsLong
        ? (_rNearSup ? Math.min(price, _rNearSup + atr * 0.12) : Math.max(supps[0] || price - atr * 1.2, price - atr * 1.5))
        : (_rNearRes ? Math.max(price, _rNearRes - atr * 0.12) : Math.min(resists[0] || price + atr * 1.2, price + atr * 1.5));
      // D1/4H 引線高低點——震盪止損止盈的主要依據
      const _rWickSupps = [
        ...(_pld1.swingLow    ? [_pld1.swingLow]    : []),
        ...(_pl4h.swingLow    ? [_pl4h.swingLow]    : []),
        ...(_pld1.supports    || []),
        ...(_pl4h.supports    || []),
      ].filter(s => s > 0 && s < price * 0.999).sort((a, b) => b - a);
      const _rWickResists = [
        ...(_pld1.swingHigh   ? [_pld1.swingHigh]   : []),
        ...(_pl4h.swingHigh   ? [_pl4h.swingHigh]   : []),
        ...(_pld1.resistances || []),
        ...(_pl4h.resistances || []),
      ].filter(r => r > price * 1.001).sort((a, b) => a - b);
      // 止損：優先 D1/4H 引線外側，次選 1H 結構，最後 ATR
      const _rSlWick = rIsLong
        ? _rWickSupps.find(s => s < rEntry * 0.998 && s > rEntry - atr * 3)
        : _rWickResists.find(r => r > rEntry * 1.002 && r < rEntry + atr * 3);
      const rSL = rIsLong
        ? (_rSlWick   ? _rSlWick   - atr * 0.20
          : _rNearSup ? _rNearSup  - atr * 0.25
          : rEntry - atr * 0.9)
        : (_rSlWick   ? _rSlWick   + atr * 0.20
          : _rNearRes ? _rNearRes  + atr * 0.25
          : rEntry + atr * 0.9);
      // TP1：優先 D1/4H 引線壓力/支撐，次選 1H S/R
      const _rTP1WickTarget = rIsLong
        ? _rWickResists.find(r => r > rEntry + atr * 0.3 && r <= rEntry + atr * 2.5)
        : _rWickSupps.find(s  => s < rEntry - atr * 0.3 && s >= rEntry - atr * 2.5);
      const _rTP1Target = _rTP1WickTarget || (rIsLong
        ? resists.find(r => r > rEntry + atr * 0.3 && r <= rEntry + atr * 2.0)
        : supps.find(s  => s < rEntry - atr * 0.3 && s >= rEntry - atr * 2.0));
      const rTP1 = _rTP1Target || (rIsLong ? rEntry + atr * 0.8 : rEntry - atr * 0.8);
      // TP2：BB%B 極端或信心 ≥ 70 才延伸；優先 D1/4H 引線
      const _rHasTP2 = Math.abs(bb1hPctB - 0.5) >= 0.27 || rConf >= 70;
      const _rTP2WickTarget = _rHasTP2 ? (rIsLong
        ? _rWickResists.find(r => r > rTP1 + price * 0.003 && r <= rEntry + atr * 3.5)
        : _rWickSupps.find(s  => s < rTP1 - price * 0.003 && s >= rEntry - atr * 3.5)) : null;
      const _rTP2Target = _rHasTP2 ? (_rTP2WickTarget || (rIsLong
        ? resists.find(r => r > rTP1 + price * 0.003 && r <= rEntry + atr * 2.5)
        : supps.find(s  => s < rTP1 - price * 0.003 && s >= rEntry - atr * 2.5))) : null;
      const rTP2 = _rHasTP2
        ? (_rTP2Target || (rIsLong ? rEntry + atr * 1.5 : rEntry - atr * 1.5))
        : null;
      const rRisk = Math.abs(rEntry - rSL) || atr;
      const rRR1  = (Math.abs(rTP1 - rEntry) / rRisk).toFixed(1);
      const rRR2  = rTP2 ? (Math.abs(rTP2 - rEntry) / rRisk).toFixed(1) : null;
      // reason labels
      const _rSlStructLabel = rIsLong
        ? (_rSlWick   ? `D1/4H引線低點 ${fmtPrice(_rSlWick)} 外側`
          : _rNearSup ? `${_htfTfLabel(_rNearSup)}支撐 ${fmtPrice(_rNearSup)} 外側` : 'ATR×0.9')
        : (_rSlWick   ? `D1/4H引線高點 ${fmtPrice(_rSlWick)} 外側`
          : _rNearRes ? `${_htfTfLabel(_rNearRes)}壓力 ${fmtPrice(_rNearRes)} 外側` : 'ATR×0.9');
      const _rSlReason = rIsLong
        ? ((_rSlWick || _rNearSup) ? `跌破${_rSlStructLabel}止損離場` : `震盪範圍外緊湊止損（ATR×0.9，現價下方）`)
        : ((_rSlWick || _rNearRes) ? `突破${_rSlStructLabel}止損離場` : `震盪範圍外緊湊止損（ATR×0.9，現價上方）`);
      const _rTp1Reason = _rTP1Target
        ? `震盪${rIsLong ? '壓力' : '支撐'} ${fmtPrice(_rTP1Target)}（${_rTP1WickTarget ? 'D1/4H引線' : _htfTfLabel(_rTP1Target)+'結構'}），快速止盈 R/R ${rRR1}:1`
        : `震盪快速止盈（ATR×0.8），R/R ${rRR1}:1`;
      const _rTp2Reason = _rHasTP2
        ? (_rTP2Target
          ? `震盪延伸${rIsLong ? '壓力' : '支撐'} ${fmtPrice(_rTP2Target)}（${_rTP2WickTarget ? 'D1/4H引線' : _htfTfLabel(_rTP2Target)}，BB%B極端/高信心）`
          : `震盪延伸目標（ATR×1.5，BB%B極端/高信心）`)
        : null;
      const rEntryReasons = [
        `🔄 震盪交易模式（宏觀+今日AI中性）`,
        rIsLong
          ? `RSI ${rsi}（偏低）${bb1hPctB <= 0.24 ? `，BB%B ${bb1hPctB.toFixed(2)}（近下軌）` : ''}，震盪低點做多${_rNearSup ? `（${_htfTfLabel(_rNearSup)}支撐 ${fmtPrice(_rNearSup)}）` : ''}`
          : `RSI ${rsi}（偏高）${bb1hPctB >= 0.76 ? `，BB%B ${bb1hPctB.toFixed(2)}（近上軌）` : ''}，震盪高點做空${_rNearRes ? `（${_htfTfLabel(_rNearRes)}壓力 ${fmtPrice(_rNearRes)}）` : ''}`,
        `本週 ${weeklyBiasData.biasLabel} ／ 今日 ${todayBiasData.biasLabel}`,
      ];

      // 更新快取（供 Telegram 通知使用）
      _tradeSetupCache[coin.symbol] = {
        direction: rangeDir, tradeType: 'range',
        entry: rEntry, sl: rSL, tp1: rTP1, tp2: rTP2,
        entryReason: rEntryReasons.join('，'),
        entryReasons: [...rEntryReasons],
        slReason: _rSlReason,
        tp1Reason: _rTp1Reason,
        tp2Reason: _rTp2Reason,
        rr1: rRR1, rr2: rRR2, atr, conf: rConf, rawConf: rRawConf,
        learnPenalty: rLearnPen, hardAdxPenalty: 0,
        macroPenalty: _rMacroPen, aiTrendPenalty: _rAIPen,
        weeklyBias: weeklyBiasData.biasLabel, weeklyConf: weeklyBiasData.conf,
        weeklyRangeMode: true,
        todayBias: todayBiasData.biasLabel, todayConf: todayBiasData.conf,
        todayRangeMode: true,
        rangeMacroDir: _btsNetDir,
        bigTrend: 'mixed', bigTrendBlocked: false, h4TrendLabel, d1TrendLabel,
        hardBlocked: false, macroOpposePenalty: _rMacroPen, aiTrendPenalty: _rAIPen,
        flipRisks: [], macroReasons: [], aiTrendReasons: [],
        blockReasons: [], learnWarnings: [], defenseChecks: [],
      };

      // 也寫入交易記錄（震盪掛單）
      const tlogR = loadTradeLog();
      const hasActiveR = tlogR.some(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending'));
      if (!hasActiveR) {
        tlogR.push({
          id: `${coin.symbol}_${Date.now()}`,
          symbol: coin.symbol, direction: rangeDir, tradeType: 'range',
          entry: rEntry, sl: rSL, tp1: rTP1, tp2: rTP2,
          entryReason: rEntryReasons[1],
          slReason: _rSlReason,
          tp1Reason: _rTp1Reason,
          tp2Reason: _rTp2Reason,
          conf: rConf, rawConf: rRawConf, atr,
          learnPenalty: rLearnPen, hardAdxPenalty: 0,
          macroPenalty: _rMacroPen, aiTrendPenalty: _rAIPen,
          status: 'pending', entryTime: null, timestamp: Date.now(),
          score: coin.score, adx: coin.adx, rsi,
          refined: false, scaleIns: [],
        });
        saveTradeLog(tlogR);
      }

      return `<div class="setup-verdict ${rIsLong ? 'verdict-long' : 'verdict-short'}">
        <div class="verdict-dir">
          <span class="verdict-arrow">${rIcon}</span>
          <span class="verdict-label">${rIsLong ? '震盪做多' : '震盪做空'}</span>
          <span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:2px 8px;border-radius:20px;font-size:0.72rem;font-weight:700;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);color:#a5b4fc">🔄 震盪交易</span>
          <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">震盪高低點快進快出</span>
        </div>
        <div class="verdict-conf-wrap">
          <span style="font-size:0.78rem;color:var(--text3)">信心度</span>
          <div class="conf-bar"><div class="conf-fill" style="width:${rConf}%;background:${rColor}"></div></div>
          <span style="color:${rColor};font-weight:700;font-size:0.9rem">${rConf}%</span>
        </div>
        <div style="margin-top:10px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.18);border-radius:10px;padding:10px 12px;font-size:0.8rem">
          <div style="color:var(--text2);font-weight:600;margin-bottom:6px">🔄 震盪行情分析</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px">
            <span style="font-size:0.73rem;color:var(--text3)">宏觀大方向：<b style="color:${_btsNetDir.includes('bull') ? 'var(--bull)' : _btsNetDir.includes('bear') ? 'var(--bear)' : 'var(--text2)'}">${_btsNetDir === 'neutral' ? '◆ 中性' : _btsNetDir === 'slight_bull' ? '↑ 輕偏多' : _btsNetDir === 'slight_bear' ? '↓ 輕偏空' : _btsNetDir.includes('bull') ? '▲ 看漲' : '▼ 看跌'}</b></span>
            <span style="font-size:0.73rem;color:var(--text3)">4H：<b style="color:${_h4Bull_r ? 'var(--bull)' : _h4Bear_r ? 'var(--bear)' : 'var(--text2)'}">${h4TrendLabel}</b></span>
            <span style="font-size:0.73rem;color:var(--text3)">日線：<b style="color:${_dayBull_r ? 'var(--bull)' : _dayBear_r ? 'var(--bear)' : 'var(--text2)'}">${d1TrendLabel}</b></span>
          </div>
          <div style="color:var(--text3);font-size:0.73rem;margin-bottom:4px">本週 AI：<b style="color:var(--text2)">${weeklyBiasData.biasLabel}</b> ／ 今日 AI：<b style="color:var(--text2)">${todayBiasData.biasLabel}</b></div>
          <div style="color:var(--text3);font-size:0.73rem">${rEntryReasons[1]}</div>
        </div>
      </div>
      <div class="setup-levels" style="margin-top:10px">
        <div class="level-row level-entry">
          <div class="level-tag">📍 進場位</div>
          <div class="level-desc">${rIsLong
            ? (_rNearSup ? `${_htfTfLabel(_rNearSup)}支撐 ${fmtPrice(_rNearSup)} 上方確認，震盪低點做多` : '震盪低點附近')
            : (_rNearRes ? `${_htfTfLabel(_rNearRes)}壓力 ${fmtPrice(_rNearRes)} 下方確認，震盪高點做空` : '震盪高點附近')}</div>
          <div class="level-price-val">${fmtPrice(rEntry)}</div>
        </div>
        <div class="level-row level-tp1">
          <div class="level-tag">🎯 快速止盈</div>
          <div class="level-desc">${_rTp1Reason}</div>
          <div class="level-price-val">${fmtPrice(rTP1)}</div>
        </div>
        ${rTP2 ? `<div class="level-row level-tp2">
          <div class="level-tag">🚀 延伸目標</div>
          <div class="level-desc">${_rTp2Reason} R/R ${rRR2}:1</div>
          <div class="level-price-val">${fmtPrice(rTP2)}</div>
        </div>` : ''}
        <div class="level-row level-sl">
          <div class="level-tag">🛑 止損</div>
          <div class="level-desc">${_rSlReason}</div>
          <div class="level-price-val">${fmtPrice(rSL)}</div>
        </div>
      </div>`;
      } // ─── end if (rConf >= 70 && !rHardBlocked) ───
    }
  }

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
  // 長線信心分：85+ 才允許加倉（canScaleIn = true），ltTag 與 layout 保持一致
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

  // 短線單：4H + 日線同向（且非長線單）才顯示 ⚡ 短線標籤
  const h4Sig  = mtfData['4h']?.signal;
  const dayS   = mtfData['1d']?.signal;
  const wkS    = mtfData['1w']?.signal;
  const h4Bull = h4Sig?.signal?.includes('bull');
  const h4Bear = h4Sig?.signal?.includes('bear');
  const dayBullSig = dayS?.signal?.includes('bull');
  const dayBearSig = dayS?.signal?.includes('bear');
  const wkBullSig  = wkS?.signal?.includes('bull');
  const wkBearSig  = wkS?.signal?.includes('bear');
  const is4hDayAligned = isLong ? (h4Bull && dayBullSig) : (h4Bear && dayBearSig);

  // 長線單條件：日線與週線同方向（用戶要求：去除 4H 關鍵位要求，純日線+週線決定）
  const _dayWkAligned = isLong ? (dayBullSig && wkBullSig) : (dayBearSig && wkBearSig);
  const canScaleIn = _dayWkAligned && ltBias === direction && ltConf >= 85;
  const ltTag = canScaleIn ? ' <span class="lt-tag lt-bull">〔長線單〕</span>' : '';
  // 根據類型更新 dirLabel，避免出現「短線做多 〔長線單〕」矛盾文字
  if (canScaleIn) dirLabel = isLong ? '長線做多' : '長線做空';
  else if (!isRangeMode && is4hDayAligned) dirLabel = isLong ? '短線做多' : '短線做空';
  else if (!isRangeMode) dirLabel = isLong ? '做多' : '做空';

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
    if (cvdTrend === 'bull')       entryReasons.push('CVD 上升，買壓持續');
    if (whale?.bias === 'bull' && whale.bigBuyCount >= 3)
      entryReasons.push(`巨鯨大額買入 ${whale.bigBuyCount} 筆（佔大單 ${whale.buyPct}%）`);
    if (vp1h && vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 3)
      entryReasons.push(`籌碼密集區(POC $${fmtPrice(vp1h.poc)})上方，籌碼結構看多`);
    if (vp1h && !vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 1.5)
      entryReasons.push(`逼近POC $${fmtPrice(vp1h.poc)}，籌碼磁吸效應`);
    // Volume AI entry confluence
    const volAI1h = mtfData['1h']?.volAI;
    if (volAI1h) {
      if (volAI1h.isBreakout && volAI1h.bias === 'bull')
        entryReasons.push(`1h連續放量突破（${volAI1h.volRatio}x均量），量價齊升確認`);
      else if (volAI1h.isSpike && volAI1h.bias === 'bull')
        entryReasons.push(`成交量暴增 ${volAI1h.volRatio}x，主動買盤主導`);
      if (volAI1h.divergence === 'bullish_div')
        entryReasons.push('看漲背離（量跌價跌），下跌動能衰竭');
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
    // 基礎技術指標（補充或作為主要進場依據）
    const ema50L  = parseFloat(coin.ema50)  || 0;
    const ema200L = parseFloat(coin.ema200) || 0;
    const macdHL  = parseFloat(coin.macdHist) || 0;
    const momL    = parseFloat(coin.momentum)  || 0;
    const volStrL = coin.volumeStrength || '';
    const adxL    = parseFloat(coin.adx) || 20;
    if (rsi >= 45 && rsi < 65) entryReasons.push(`RSI ${rsi} 積極偏多，動能尚未過熱`);
    else if (rsi >= 65)        entryReasons.push(`RSI ${rsi} 強勢偏多`);
    if (ema50L > 0 && price > m15ema && m15ema > ema50L) entryReasons.push(`EMA 多頭排列（20 > 50），趨勢向上`);
    else if (price > m15ema && !entryReasons.some(r => r.includes('EMA20'))) entryReasons.push(`價格站上 EMA20，短線偏多`);
    if (ema200L > 0 && price > ema200L) entryReasons.push(`價格在 EMA200 上方，長線支撐`);
    if (macdHL > 0)  entryReasons.push(`MACD 柱狀翻正，多頭動能確認`);
    if (momL > 0)    entryReasons.push(`動量正值（+${momL}），上行動能持續`);
    if (volStrL === '高') entryReasons.push(`高量配合，量價齊升確認`);
    if (adxL > 35)   entryReasons.push(`ADX ${adxL} 強趨勢，追多有效`);
    else if (adxL > 22) entryReasons.push(`ADX ${adxL} 趨勢成形`);
    const scoreL = coin.score || 60;
    if (!entryReasons.some(r => r.includes('評分'))) {
      if (scoreL >= 85) entryReasons.push(`綜合評分 ${scoreL}，強勢看漲信號`);
      else              entryReasons.push(`綜合評分 ${scoreL}，多頭信號確認`);
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
    if (cvdTrend === 'bear')       entryReasons.push('CVD 下降，賣壓持續');
    if (whale?.bias === 'bear' && whale.bigSellCount >= 3)
      entryReasons.push(`巨鯨大額賣出 ${whale.bigSellCount} 筆（佔大單 ${(100 - whale.buyPct).toFixed(1)}%）`);
    if (vp1h && !vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 3)
      entryReasons.push(`籌碼密集區(POC $${fmtPrice(vp1h.poc)})下方，籌碼結構看空`);
    if (vp1h && vp1h.priceAbovePOC && Math.abs(vp1h.distToPOC) < 1.5)
      entryReasons.push(`逼近POC $${fmtPrice(vp1h.poc)} 壓力，籌碼磁吸阻力`);
    // Volume AI entry confluence
    const volAI1hShort = mtfData['1h']?.volAI;
    if (volAI1hShort) {
      if (volAI1hShort.isBreakout && volAI1hShort.bias === 'bear')
        entryReasons.push(`1h連續放量突破（${volAI1hShort.volRatio}x均量），量價齊升確認`);
      else if (volAI1hShort.isSpike && volAI1hShort.bias === 'bear')
        entryReasons.push(`成交量暴增 ${volAI1hShort.volRatio}x，主動賣盤主導`);
      if (volAI1hShort.divergence === 'bearish_div')
        entryReasons.push('看跌背離（量跌價漲），上漲動能不足');
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
    // 基礎技術指標（補充或作為主要進場依據）
    const ema50S  = parseFloat(coin.ema50)  || 0;
    const ema200S = parseFloat(coin.ema200) || 0;
    const macdHS  = parseFloat(coin.macdHist) || 0;
    const momS    = parseFloat(coin.momentum)  || 0;
    const volStrS = coin.volumeStrength || '';
    const adxS    = parseFloat(coin.adx) || 20;
    if (rsi <= 50 && rsi > 35) entryReasons.push(`RSI ${rsi} 偏弱，下行動能確認`);
    else if (rsi <= 35)        entryReasons.push(`RSI ${rsi} 弱勢偏空`);
    else if (rsi > 62)         entryReasons.push(`RSI ${rsi} 超買區，回落機會`);
    if (ema50S > 0 && price < m15ema && m15ema < ema50S) entryReasons.push(`EMA 空頭排列（20 < 50），趨勢向下`);
    else if (price < m15ema && !entryReasons.some(r => r.includes('EMA20'))) entryReasons.push(`價格跌破 EMA20，短線偏空`);
    if (ema200S > 0 && price < ema200S) entryReasons.push(`價格在 EMA200 下方，長線壓力`);
    if (macdHS < 0)  entryReasons.push(`MACD 柱狀負值，空頭動能確認`);
    if (momS < 0)    entryReasons.push(`動量負值（${momS}），下行動能持續`);
    if (volStrS === '高') entryReasons.push(`高量配合，量價齊跌確認`);
    if (adxS > 35)   entryReasons.push(`ADX ${adxS} 強趨勢，追空有效`);
    else if (adxS > 22) entryReasons.push(`ADX ${adxS} 趨勢成形`);
    const scoreS = coin.score || 50;
    if (!entryReasons.some(r => r.includes('評分'))) {
      if (scoreS <= 15) entryReasons.push(`綜合評分 ${scoreS}，強勢看跌信號`);
      else              entryReasons.push(`綜合評分 ${scoreS}，空頭信號確認`);
    }
    if (!entryReasons.length) entryReasons.push('15m/1h 空頭信號共振');
  }

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
  const risk = Math.abs(entry - sl) || atr;

  // ── 止盈一：優先 4H/日線 S/R，最低 2:1 R/R ──
  let tp1, tp1Reason;
  const minTP1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
  if (isLong) {
    // 先嘗試 4H/日線壓力，再 fallback 到 1H
    const htfR1 = _htfResists.find(r => r >= minTP1 * 0.99);
    const r1    = htfR1 || resists.find(r => r >= minTP1 * 0.99);
    tp1 = r1 || minTP1;
    const rr1v = ((tp1 - entry) / risk).toFixed(1);
    tp1Reason = r1
      ? `${_htfTfLabel(r1)}壓力 ${fmtPrice(r1)}，R/R ${rr1v}:1，到達後減倉 60%`
      : `短線目標 R/R ${rr1v}:1，到達後減倉 60%`;
  } else {
    const htfS1 = _htfSupps.find(s => s <= minTP1 * 1.01);
    const s1    = htfS1 || supps.find(s => s <= minTP1 * 1.01);
    tp1 = s1 || minTP1;
    const rr1v = ((entry - tp1) / risk).toFixed(1);
    tp1Reason = s1
      ? `${_htfTfLabel(s1)}支撐 ${fmtPrice(s1)}，R/R ${rr1v}:1，到達後減倉 60%`
      : `短線目標 R/R ${rr1v}:1，到達後減倉 60%`;
  }

  // ── 止盈二：優先日線/週線 S/R，最低 3:1 R/R ──
  let tp2, tp2Reason;
  const minTP2 = isLong ? entry + risk * 2.5 : entry - risk * 2.5;
  if (isLong) {
    // 優先週線，再日線/4H，再 1H swing high
    const w1R2  = _w1Resists.find(r => r > tp1 + price * 0.004 && r >= minTP2 * 0.99);
    const htfR2 = w1R2 || _htfResists.find(r => r > tp1 + price * 0.004 && r >= minTP2 * 0.99);
    const r2    = htfR2 || resists.find(r => r > tp1 + price * 0.004 && r >= minTP2 * 0.99);
    tp2 = r2 || Math.max(swHigh, minTP2);
    if (tp2 <= tp1) tp2 = Math.max(tp1 + price * 0.004, minTP2);
    const rr2v = ((tp2 - entry) / risk).toFixed(1);
    tp2Reason = r2
      ? `${_htfTfLabel(r2)}壓力 ${fmtPrice(r2)}，R/R ${rr2v}:1，剩餘倉位移至成本`
      : `擺動高點 ${fmtPrice(swHigh)}，R/R ${rr2v}:1，剩餘倉位移至成本`;
  } else {
    const w1S2  = _w1Supps.find(s => s < tp1 - price * 0.004 && s <= minTP2 * 1.01);
    const htfS2 = w1S2 || _htfSupps.find(s => s < tp1 - price * 0.004 && s <= minTP2 * 1.01);
    const s2    = htfS2 || supps.find(s => s < tp1 - price * 0.004 && s <= minTP2 * 1.01);
    tp2 = s2 || Math.min(swLow, minTP2);
    if (tp2 >= tp1) tp2 = Math.min(tp1 - price * 0.004, minTP2);
    const rr2v = ((entry - tp2) / risk).toFixed(1);
    tp2Reason = s2
      ? `${_htfTfLabel(s2)}支撐 ${fmtPrice(s2)}，R/R ${rr2v}:1，剩餘倉位移至成本`
      : `擺動低點 ${fmtPrice(swLow)}，R/R ${rr2v}:1，剩餘倉位移至成本`;
  }

  // ── 長線單：覆蓋 tp1/tp2 為長線最終止盈，並計算三個加倉位 ──────
  // 觸發條件：ltBias === direction && ltConf >= 85（canScaleIn = true）
  let ltTP = null, ltTPReason = '', scaleInLevels = [], _aiScaleCount = 1, _aiScaleReason = '';
  if (canScaleIn) {
    const minLtTP = isLong ? entry + risk * 4 : entry - risk * 4; // 至少 4:1 R/R
    const maxDist  = price * 0.30; // 長線上限擴展至 30%（週線目標可能較遠）
    if (isLong) {
      const cap     = entry + maxDist;
      // 優先：週線壓力 > 日線/4H 壓力 > 計算值（取最遠的有效結構位）
      const wkCands  = _w1Resists.filter(r => r >= minLtTP && r <= cap);
      const htfCands = _htfResists.filter(r => r >= minLtTP && r <= cap);
      const allCands = [...new Set([...wkCands, ...htfCands, ...resists.filter(r => r >= minLtTP && r <= cap)])].sort((a,b)=>a-b);
      ltTP = allCands.length ? allCands[allCands.length - 1] : Math.min(entry + risk * 5, cap);
      const ltRRv = ((ltTP - entry) / risk).toFixed(1);
      const ltTfLabel = _htfTfLabel(ltTP);
      ltTPReason = `${ltTfLabel}關鍵壓力 ${fmtPrice(ltTP)}，R/R ${ltRRv}:1，全倉長線目標`;
    } else {
      const cap     = entry - maxDist;
      const wkCands  = _w1Supps.filter(s => s <= minLtTP && s >= cap);
      const htfCands = _htfSupps.filter(s => s <= minLtTP && s >= cap);
      const allCands = [...new Set([...wkCands, ...htfCands, ...supps.filter(s => s <= minLtTP && s >= cap)])].sort((a,b)=>b-a);
      ltTP = allCands.length ? allCands[allCands.length - 1] : Math.max(entry - risk * 5, cap);
      const ltRRv = ((entry - ltTP) / risk).toFixed(1);
      const ltTfLabel = _htfTfLabel(ltTP);
      ltTPReason = `${ltTfLabel}關鍵支撐 ${fmtPrice(ltTP)}，R/R ${ltRRv}:1，全倉長線目標`;
    }
    // AI 自行判斷加倉次數（最多 3 次）：依長線信心度和 R/R 決定
    const ltRRraw = risk > 0 ? Math.abs(ltTP - entry) / risk : 0;
    _aiScaleCount = (ltConf >= 90 && ltRRraw >= 5.0) ? 3
                  : (ltConf >= 87 && ltRRraw >= 4.0) ? 2
                  : 1;
    _aiScaleReason = _aiScaleCount === 3 ? `長線信心 ${ltConf}%、R/R ${ltRRraw.toFixed(1)}:1，建議 3 次加倉`
                   : _aiScaleCount === 2 ? `長線信心 ${ltConf}%、R/R ${ltRRraw.toFixed(1)}:1，建議 2 次加倉`
                   : `長線信心 ${ltConf}%，建議 1 次加倉（保守佈局）`;
    // 加倉位：均勻分佈在路程中，並嘗試吸附至附近 ±1.5% S/R
    const totalMove = Math.abs(ltTP - entry);
    scaleInLevels = Array.from({ length: _aiScaleCount }, (_, i) => i + 1).map(n => {
      const raw = isLong ? entry + totalMove * (n / (_aiScaleCount + 1))
                         : entry - totalMove * (n / (_aiScaleCount + 1));
      const nearby = isLong
        ? resists.find(r => r >= raw * 0.985 && r <= raw * 1.015)
        : supps.find(s  => s <= raw * 1.015  && s >= raw * 0.985);
      const level = nearby || raw;
      const prevLevel = n === 1 ? entry : (isLong ? entry + totalMove * ((n - 1) / (_aiScaleCount + 1)) : entry - totalMove * ((n - 1) / (_aiScaleCount + 1)));
      // 止損往前調：鎖住加倉位到前一進場位增量的 30%，避免大幅回吐利潤
      const incGain = Math.abs(level - prevLevel);
      const newSL   = isLong ? prevLevel + incGain * 0.30 : prevLevel - incGain * 0.30;
      return { level, snapped: !!nearby, newSL };
    });
    // 覆蓋 tp1/tp2 → updateOpenTrades TP1 觸發 & 持倉記錄均使用長線最終止盈
    tp1 = ltTP; tp1Reason = ltTPReason;
    tp2 = ltTP; tp2Reason = ltTPReason;
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
  const rawConf  = Math.min(92, Math.max(40, 40 + (activeFactors + h4Conf + rrBonus + levelQualityBonus) * 6));

  // 宏觀環境同步確認：宏觀訊號 + AI新聞 + 預測 + 今日數據事件 綜合評分
  let macroOpposePenalty = 0, macroReasons = [];
  try {
    const _macroResult = (() => {
      const reasons = [];
      let against = 0;

      // ① 宏觀訊號（F&G + 市值 + BTC 主導）
      if (globalMkt || fearGreed) {
        const fgNow  = fearGreed ? parseInt(fearGreed.value || '50') : 50;
        const chgNow = globalMkt?.marketCapChange || 0;
        const domNow = globalMkt?.btcDominance   || 50;
        if (isLong) {
          if (chgNow < -2) { against++;   reasons.push(`市值 ${chgNow.toFixed(1)}% 下跌，多頭逆風`); }
          if (domNow > 58) { against++;   reasons.push(`BTC 主導 ${domNow.toFixed(1)}%（偏高），山寨承壓`); }
          if (fgNow < 30)  { against++;   reasons.push(`恐貪 ${fgNow}（極度恐慌），不宜追多`); }
          if (fgNow > 75)  { against += 0.5; reasons.push(`恐貪 ${fgNow}（極度貪婪），短線追高風險`); }
        } else {
          if (chgNow > 2)  { against++;   reasons.push(`市值 +${chgNow.toFixed(1)}%，空頭逆風`); }
          if (domNow < 44) { against++;   reasons.push(`BTC 主導 ${domNow.toFixed(1)}%（偏低），山寨季偏多`); }
          if (fgNow > 70)  { against++;   reasons.push(`恐貪 ${fgNow}（貪婪），不宜追空`); }
          if (fgNow < 25)  { against += 0.5; reasons.push(`恐貪 ${fgNow}（極恐），逢低布局偏多`); }
        }
      }

      // ② AI 財經新聞偏向分析
      try {
        const topInsight = aiGenerateMarketInsights()[0];
        if (topInsight) {
          const sentiment = topInsight.sentiment || '';
          if (isLong  && (sentiment === 'bearish' || sentiment === 'bear')) { against += 0.5; reasons.push(`AI新聞偏空：${(topInsight.zhTitle||'').slice(0,20)}`); }
          if (!isLong && (sentiment === 'bullish' || sentiment === 'bull')) { against += 0.5; reasons.push(`AI新聞偏多：${(topInsight.zhTitle||'').slice(0,20)}`); }
        }
      } catch(e) {}

      // ③ 今日重要數據事件（高影響 + 未公布且在1小時內）
      try {
        const nearEvents = getTodayEconEvents().filter(ev => {
          const mins = (ev.eventTime.getTime() - Date.now()) / 60000;
          return ev.impact === 'high' && mins >= -15 && mins <= 75;
        });
        if (nearEvents.length > 0) {
          against += 1;
          reasons.push(`高影響數據即將/剛公布：${nearEvents.map(e => e.name).join('、')}，不確定性高`);
        }
      } catch(e) {}

      const total = against;
      const penalty = total >= 3 ? 18 : total >= 2 ? 12 : total >= 1 ? 5 : 0;
      return { macroOpposePenalty: penalty, macroReasons: reasons };
    })();
    macroOpposePenalty = _macroResult.macroOpposePenalty;
    macroReasons       = _macroResult.macroReasons;
  } catch(e) {
    console.warn('[buildTradeSetup] macroOpposePenalty 計算失敗:', e);
  }

  // 大方向分歧補扣：computeMacroNetDir 閾值低於 macroOpposePenalty 閾值，需補齊差距
  // slight_bear for long / slight_bull for short → 最少扣 3%；bear/bull → 最少扣 7%
  if (_btsNetDir) {
    const _bdAgainst = (isLong && _btsNetDir.includes('bear')) || (!isLong && _btsNetDir.includes('bull'));
    if (_bdAgainst) {
      const _bdMin = (_btsNetDir === 'slight_bear' || _btsNetDir === 'slight_bull') ? 3 : 7;
      if (macroOpposePenalty < _bdMin) {
        const _bdAdd = _bdMin - macroOpposePenalty;
        macroOpposePenalty += _bdAdd;
        macroReasons.push(`大方向${_btsNetDir.includes('slight') ? '輕微' : ''}${isLong ? '偏空' : '偏多'}（${_btsNetDir}），補扣 ${_bdAdd}%`);
      }
    }
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
  const weeklyAligned = (isLong && _wBias.includes('bull')) || (!isLong && _wBias.includes('bear'));
  const weeklyNeutral = _wBias === 'neutral' || _wBias === '';
  const weeklyOpposed = !weeklyAligned && !weeklyNeutral;
  const todayAligned  = (isLong && _tBias.includes('bull')) || (!isLong && _tBias.includes('bear'));
  const todayNeutral  = _tBias === 'neutral' || _tBias === '';
  const todayOpposed  = !todayAligned && !todayNeutral;

  // AI 趨勢對照懲罰（避免與 macroOpposePenalty 重複，只計非宏觀因子的差距）
  let aiTrendPenalty = 0;
  const aiTrendReasons = [];
  if (weeklyOpposed) {
    const pen = _wBias.includes('strong') ? 8 : 4;
    aiTrendPenalty += pen;
    aiTrendReasons.push(`本週AI預測 ${weeklyBiasData.biasLabel || _wBias}，與${isLong ? '做多' : '做空'}逆向，扣 ${pen}%`);
  } else if (weeklyNeutral) {
    aiTrendReasons.push(`本週AI預測震盪中性（信心 ${weeklyBiasData.conf || 50}%），無方向加成`);
  } else {
    aiTrendReasons.push(`本週AI預測 ${weeklyBiasData.biasLabel || _wBias}（信心 ${weeklyBiasData.conf || 50}%），與${isLong ? '多' : '空'}方向一致`);
  }
  if (todayOpposed) {
    aiTrendPenalty += 5;
    aiTrendReasons.push(`今日AI預測 ${todayBiasData.biasLabel || _tBias}，${isLong ? '多頭' : '空頭'}今日逆風，扣 5%`);
  } else if (todayNeutral) {
    aiTrendReasons.push(`今日AI預測中性觀望（信心 ${todayBiasData.conf || 50}%），謹慎操作`);
  } else {
    aiTrendReasons.push(`今日AI預測 ${todayBiasData.biasLabel || _tBias}（信心 ${todayBiasData.conf || 50}%），今日方向一致`);
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
    abovePOC: vp1h?.priceAbovePOC ?? null,
    whaleBias: whale?.bias || null,
    volDivergence: mtfData['1h']?.volAI?.divergence || null,
    mtfAlign: entryMTFAlign,
    slType,
    skipAdxRule: true,  // hardAdxPenalty 已單獨扣分，避免 low_adx 規則雙重扣分
  };
  const adxVal = parseFloat(coin.adx) || 20;
  // 硬性 ADX 門檻（不依賴歷史數據，始終生效）
  const hardAdxPenalty = adxVal < 18 ? 28 : adxVal < 22 ? 14 : 0;
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
  // 大時間框架對立扣分（bigTrendBlocked 已攔截雙雙逆勢，這裡處理單邊逆勢）
  if (!bigTrendBlocked) {
    if (h4?.signal?.includes(isLong ? 'bear' : 'bull')) { techPenalty += 4; techPenReasons.push(`4H 方向（${h4TrendLabel}）與${isLong ? '做多' : '做空'}逆勢，中週期阻力，扣 4%`); }
    if (d1sig_?.signal?.includes(isLong ? 'bear' : 'bull')) { techPenalty += 5; techPenReasons.push(`日線方向（${d1TrendLabel}）與${isLong ? '做多' : '做空'}逆勢，大週期阻力，扣 5%`); }
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

  // 合併扣分原因
  techPenReasons.forEach(r => aiTrendReasons.push(`📐 技術面：${r}`));
  chipsPenReasons.forEach(r => aiTrendReasons.push(`🐋 籌碼面：${r}`));

  const conf = Math.max(0, rawConf - learnPenalty - macroOpposePenalty - aiTrendPenalty - hardAdxPenalty - techPenalty - chipsPenalty);
  // 三層分析中間值（供 UI 展示決策流程用）
  const baseConf  = Math.max(0, rawConf - hardAdxPenalty);
  const macroConf = Math.max(0, baseConf - macroOpposePenalty - aiTrendPenalty - techPenalty - chipsPenalty);
  const finalConf = conf;
  // 最終防線：被AI風控硬封鎖 OR 信心低於70% → 觀望
  if (conf < 70 || hardBlocked) direction = 'wait';
  if (learnWarnings.length && direction !== 'wait') {
    learnWarnings.forEach(w => entryReasons.push(`⚠️ ${w}`));
  }
  // 即使是觀望，也記錄最終防線原因供顯示
  if (hardBlocked && direction === 'wait') {
    learnWarnings.forEach(w => entryReasons.push(w));
  }
  // 大趨勢攔截說明
  if (bigTrendBlocked) {
    entryReasons.push(`🚫 ${bigTrendBlockReason}`);
  }

  // 緩存完整設置供 Telegram 通知 + AI 分析使用
  _tradeSetupCache[coin.symbol] = {
    direction,
    entry, sl, tp1, tp2,
    entryReason: entryReasons.join('，'),
    entryReasons: [...entryReasons],   // 陣列原始版，避免逗號分割錯誤
    slReason, tp1Reason, tp2Reason,
    rr1: rr1str, rr2: rr2str, atr, conf,
    longTermBias: ltBias, canScaleIn, ltConf,
    maxScaleIns: canScaleIn ? _aiScaleCount : undefined,
    aiScaleReason: canScaleIn ? _aiScaleReason : undefined,
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

  if (existIdx >= 0) {
    const ex = tlog[existIdx];
    // 若 entry 缺失（舊版資料）或尚未精煉，強制更新完整欄位
    if (!ex.refined || !ex.entry) {
      ex.entry = entry; ex.sl = sl; ex.tp1 = tp1; ex.tp2 = tp2;
      ex.entryReason = entryReasons.join('，');
      ex.slReason = slReason; ex.tp1Reason = tp1Reason; ex.tp2Reason = tp2Reason;
      ex.conf = conf; ex.rawConf = rawConf;
      Object.assign(ex, tradeCtx);
      ex.refined = true;
    }
    ex.conf = conf; ex.rawConf = rawConf;
    ex.hardAdxPenalty = hardAdxPenalty; ex.learnPenalty = learnPenalty;
    ex.macroPenalty = macroOpposePenalty; ex.aiTrendPenalty = aiTrendPenalty;
    ex.techPenalty = techPenalty; ex.chipsPenalty = chipsPenalty;
    ex.longTermBias = ltBias;
    ex.canScaleIn   = canScaleIn;
    ex.is4hDayAligned = is4hDayAligned;
    if (!ex.scaleIns) ex.scaleIns = [];
    if (ex.peakPrice == null) ex.peakPrice = null;
    // 補齊長線加倉計劃（若之前未儲存）
    if (canScaleIn && scaleInLevels.length && !ex.scaleInTargets?.length) {
      ex.scaleInTargets = scaleInLevels.map(s => s.level);
      ex.scaleInNewSLs  = scaleInLevels.map(s => s.newSL);
      ex.maxScaleIns    = _aiScaleCount;
      ex.aiScaleReason  = _aiScaleReason;
      ex.ltTP = ltTP || null;
    }
    saveTradeLog(tlog);
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

    if (direction !== 'wait' && !hasAnyActive && !recentlyCancelled) {
      tlog.unshift({
        id: `${coin.symbol}-${Date.now()}`,
        symbol: coin.symbol, direction,
        timestamp: Date.now(),
        entryPrice: price, entry, sl, tp1, tp2,
        rsi: parseFloat(coin.rsi) || 50,
        adx: parseFloat(coin.adx) || 20,
        score: coin.score, trend: coin.trend, conf, rawConf,
        hardAdxPenalty, learnPenalty, macroPenalty: macroOpposePenalty, aiTrendPenalty, techPenalty, chipsPenalty,
        entryReason: entryReasons.join('，'), slReason, tp1Reason, tp2Reason,
        status: 'pending', outcome: null, tp1Hit: false,
        entryTime: null,
        exitPrice: null, exitTime: null, pnlR: null, analysis: null,
        refined: true,
        longTermBias: ltBias, canScaleIn, ltConf, is4hDayAligned,
        scaleInTargets: canScaleIn && scaleInLevels.length ? scaleInLevels.map(s => s.level) : [],
        scaleInNewSLs:  canScaleIn && scaleInLevels.length ? scaleInLevels.map(s => s.newSL) : [],
        maxScaleIns:    canScaleIn ? _aiScaleCount : undefined,
        aiScaleReason:  canScaleIn ? _aiScaleReason : undefined,
        ltTP: (canScaleIn && ltTP) ? ltTP : null,
        scaleIns: [], peakPrice: null,
        ...tradeCtx,
      });
      if (tlog.length > 500) tlog.splice(500);
      saveTradeLog(tlog);
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
      if (hardAdxPenalty > 0)     deductLines.push(`ADX ${adxVal} 過低（${adxVal < 18 ? '< 18' : '< 22'}），扣 -${hardAdxPenalty}%`);
      if (macroOpposePenalty > 0) deductLines.push(`宏觀環境逆風，扣 -${macroOpposePenalty}%`);
      if (aiTrendPenalty > 0)     deductLines.push(`AI 趨勢預測逆向（本週/今日），扣 -${aiTrendPenalty}%`);
      if (learnPenalty > 0)       deductLines.push(`止損歷史記憶觸發，扣 -${learnPenalty}%`);
    }
    const confFlow = [
      `<span style="color:var(--text3);font-size:0.73rem">原始 ${rawConf}%</span>`,
      hardAdxPenalty > 0     ? `<span style="color:#f59e0b;font-size:0.73rem">→ ADX -${hardAdxPenalty}</span>` : '',
      macroOpposePenalty > 0 ? `<span style="color:#f59e0b;font-size:0.73rem">→ 宏觀 -${macroOpposePenalty}</span>` : '',
      aiTrendPenalty > 0     ? `<span style="color:#f59e0b;font-size:0.73rem">→ AI -${aiTrendPenalty}</span>` : '',
      learnPenalty > 0       ? `<span style="color:#f59e0b;font-size:0.73rem">→ 風控 -${learnPenalty}</span>` : '',
      `<span style="color:var(--text3);font-size:0.73rem">= 最終</span> <span style="font-weight:700;color:${cColor(conf)}">${conf}%</span>`,
    ].filter(Boolean).join(' ');
    return `<div class="setup-wait">
      <div class="setup-wait-icon">${hardBlocked ? '🚫' : '⚠️'}</div>
      <div class="setup-wait-title">${hardBlocked ? '本次不進場（AI 風控封鎖）' : '本次不推薦交易'}</div>
      ${!hardBlocked ? `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:4px 0 6px;font-size:0.73rem">${confFlow}</div>` : ''}
      ${deductLines.length ? `<ul class="setup-wait-reasons">${deductLines.map(r => `<li>${r}</li>`).join('')}</ul>` : ''}
    </div>`;
  }

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
      const pctB = bbStatus1h.pctB;
      const pos  = pctB <= 0.1 ? '下軌觸及 ↑' : pctB <= 0.25 ? '近下軌' : pctB >= 0.9 ? '上軌觸及 ↓' : pctB >= 0.75 ? '近上軌' : '中軌區';
      const clr  = pctB <= 0.25 ? 'var(--bull)' : pctB >= 0.75 ? 'var(--bear)' : 'var(--text2)';
      chips.push(`<span class="setup-macro-chip" style="color:${clr}">📊 BB(1h) ${pos}${(bbStatus1h.tags||[]).includes('BB收窄蓄力') ? ' · 收窄' : ''}</span>`);
    }
    if (bbStatus15m) {
      const pctB = bbStatus15m.pctB;
      const pos  = pctB <= 0.1 ? '下軌' : pctB <= 0.25 ? '近下' : pctB >= 0.9 ? '上軌' : pctB >= 0.75 ? '近上' : '中軌';
      const clr  = pctB <= 0.25 ? 'var(--bull)' : pctB >= 0.75 ? 'var(--bear)' : 'var(--text3)';
      chips.push(`<span class="setup-macro-chip" style="color:${clr}">📊 BB(15m) ${pos}</span>`);
    }
    return chips.length ? `<div class="setup-macro-chips" style="margin-top:6px">${chips.join('')}</div>` : '';
  } catch(e) { return ''; } })();

  return `<div class="setup-verdict ${isLong ? 'verdict-long' : 'verdict-short'}">
    <div class="verdict-dir">
      <span class="verdict-arrow">${dirIcon}</span>
      <span class="verdict-label">${dirLabel}</span>
      ${ltTag}${rangeTagHtml}
      <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">${isRangeMode ? '震盪高低點快進快出' : '15m ~ 1h 時間框架'}</span>
    </div>
    ${conf >= 60 ? `<div class="verdict-conf-wrap">
      <span style="font-size:0.78rem;color:var(--text3)">信心度</span>
      <div class="conf-bar"><div class="conf-fill" style="width:${conf}%;background:${dirColor}"></div></div>
      <span style="color:${dirColor};font-weight:700;font-size:0.9rem">${conf}%</span>
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

  ${macroBlockedForRecord ? `<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:9px;padding:9px 14px;margin-bottom:10px;font-size:0.78rem;color:#f59e0b">⚠️ 宏觀大方向${isLong ? '極端偏空' : '極端偏多'}，信心度已扣分反映，訊號已記入持倉供參考</div>` : ''}
  ${_recordBlockedByCooldown ? (() => { const cancelledT = loadCancelCooldowns().find(c => c.symbol === coin.symbol && c.direction === direction && (Date.now() - (c.cancelTime||0)) < SIGNAL_COOLDOWN); const minsAgo = cancelledT ? Math.round((Date.now() - (cancelledT.cancelTime||0)) / 60000) : 0; const minsLeft = cancelledT ? Math.max(0, Math.round((SIGNAL_COOLDOWN - (Date.now() - (cancelledT.cancelTime||0))) / 60000)) : 0; return `<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:9px;padding:9px 14px;margin-bottom:10px;font-size:0.78rem;color:#f59e0b">⏱ 此幣種 ${direction === 'long' ? '多' : '空'}單 ${minsAgo} 分鐘前被取消（冷卻期還有約 ${minsLeft} 分鐘），<strong>未計入掛單記錄</strong>；冷卻結束後掃描將自動重新評估</div>`; })() : ''}
  ${_recordBlockedByActive ? `<div style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.25);border-radius:9px;padding:9px 14px;margin-bottom:10px;font-size:0.78rem;color:#818cf8">📌 此幣種已有持倉進行中，<strong>未計入掛單記錄</strong>（不重複開倉）</div>` : ''}

  ${canScaleIn && ltTP ? `
  <!-- ═══ 長線單：進場 + 加倉（AI決定次數）+ 最終止盈 ═══ -->
  <div style="font-size:0.73rem;color:#a78bfa;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:7px;padding:7px 11px;margin-bottom:8px">
    🤖 AI 加倉判斷：${_aiScaleReason}
  </div>
  <div class="setup-levels">
    <div class="level-row level-entry">
      <div class="level-tag">📍 進場</div>
      <div class="level-desc">${entryReasons.join('　')}</div>
      <div class="level-price-val">${fmtPrice(entry)}</div>
    </div>
    ${scaleInLevels.map((si, i) => {
      const movePct = ((Math.abs(si.level - entry) / price) * 100).toFixed(1);
      const siRR    = ((Math.abs(si.level - entry) / risk)).toFixed(1);
      return `<div class="level-row level-tp1" style="border-left:3px solid rgba(99,102,241,.5)">
        <div class="level-tag">📈 加倉${i + 1}</div>
        <div class="level-desc">+${movePct}%，趨勢持續確認加碼${si.snapped ? '（貼近結構位）' : ''}，R/R ${siRR}:1　<span style="color:var(--bear);font-size:0.72rem">加倉後止損移至 ${fmtPrice(si.newSL)}</span></div>
        <div class="level-price-val" style="color:#a78bfa">${fmtPrice(si.level)}</div>
      </div>`;
    }).join('')}
    <div class="level-row level-tp2" style="border-left:3px solid rgba(34,197,94,.6)">
      <div class="level-tag">🏁 最終止盈</div>
      <div class="level-desc">${ltTPReason}</div>
      <div class="level-price-val" style="color:var(--bull)">${fmtPrice(ltTP)}</div>
    </div>
    <div class="level-row level-sl">
      <div class="level-tag">🛑 初始止損</div>
      <div class="level-desc">${slReason}</div>
      <div class="level-price-val">${fmtPrice(sl)}</div>
    </div>
  </div>
  <div class="setup-rules">
    <div class="rules-title">🏆 長線加倉操作守則</div>
    <div class="rule-item">✦ 初始倉位 <strong>2~3%</strong>，每次加倉追加 <strong>1~2%</strong>，${_aiScaleCount}次加倉合計上限 <strong>${_aiScaleCount <= 1 ? '4~5' : _aiScaleCount === 2 ? '6~7' : '8~9'}%</strong></div>
    <div class="rule-item">✦ 進場後立即設止損（<strong style="color:var(--bear)">${fmtPrice(sl)}</strong>）；每次加倉確認後止損往前調至各加倉行顯示的位置（鎖住 30% 增量利潤，不讓大幅回吐）</div>
    <div class="rule-item">✦ 最後一次加倉後止損接近保本位，確保整體持倉不虧損</div>
    <div class="rule-item">✦ 全倉持有至最終止盈（<strong style="color:${dirColor}">${fmtPrice(ltTP)}</strong>），中途不提前止盈</div>
    ${deriv ? `<div class="rule-item">✦ 資金費率 <strong style="color:${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? (Math.abs(deriv.fundingRate) > 0.003 ? (deriv.fundingRate < 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text3)') : 'var(--text3)'}">${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? ((deriv.fundingRate*100).toFixed(4)+'%') : '--'}</strong>　Taker 買賣比 <strong style="color:${deriv.takerBuySell > 1.05 ? 'var(--bull)' : deriv.takerBuySell < 0.95 ? 'var(--bear)' : 'var(--text3)'}">${deriv.takerBuySell?.toFixed(2)}</strong></div>` : ''}
  </div>
  ` : `
  <!-- ═══ 短線單：TP1 / TP2 ═══ -->
  <div class="setup-levels">
    <div class="level-row level-entry">
      <div class="level-tag">📍 進場</div>
      <div class="level-desc">${entryReasons.join('　')}</div>
      <div class="level-price-val">${fmtPrice(entry)}</div>
    </div>
    <div class="level-row level-tp1">
      <div class="level-tag">🎯 止盈1</div>
      <div class="level-desc">${tp1Reason}</div>
      <div class="level-price-val">${fmtPrice(tp1)}</div>
    </div>
    <div class="level-row level-tp2">
      <div class="level-tag">🚀 止盈2</div>
      <div class="level-desc">${tp2Reason}</div>
      <div class="level-price-val">${fmtPrice(tp2)}</div>
    </div>
    <div class="level-row level-sl">
      <div class="level-tag">🛑 止損</div>
      <div class="level-desc">${slReason}</div>
      <div class="level-price-val">${fmtPrice(sl)}</div>
    </div>
  </div>
  <div class="setup-rules">
    <div class="rules-title">⚡ 短線操作守則</div>
    <div class="rule-item">✦ 單筆倉位最多佔資金 <strong>3~5%</strong>，虧損不超過資金的 <strong>0.5~1%</strong></div>
    <div class="rule-item">✦ 進場後立即掛好止損單，不根據情緒調整止損</div>
    <div class="rule-item">✦ 到達止盈1（<strong style="color:${dirColor}">${fmtPrice(tp1)}</strong>）即出 60%，剩餘移至成本</div>
    <div class="rule-item">✦ 若 15m K棒轉向且成交量放大，不等止損主動離場</div>
    ${deriv ? `<div class="rule-item">✦ 資金費率 <strong style="color:${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? (Math.abs(deriv.fundingRate) > 0.003 ? (deriv.fundingRate < 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text3)') : 'var(--text3)'}">${(deriv.fundingRate != null && !isNaN(deriv.fundingRate)) ? ((deriv.fundingRate*100).toFixed(4)+'%') : '--'}</strong>　Taker 買賣比 <strong style="color:${deriv.takerBuySell > 1.05 ? 'var(--bull)' : deriv.takerBuySell < 0.95 ? 'var(--bear)' : 'var(--text3)'}">${deriv.takerBuySell?.toFixed(2)}</strong></div>` : ''}
  </div>
  `}

  ${(() => { try {
    // ── AI 交易決策三層邏輯面板 ──
    const { defenseChecks = [] } = learnResult || {};
    const failChecks  = defenseChecks.filter(c => !c.pass);
    const passChecks  = defenseChecks.filter(c =>  c.pass);
    const typeLabel = { rule: '規則', memory: '止損記憶', suggestion: '改進建議' };
    const typeColor = { rule: '#818cf8', memory: '#f59e0b', suggestion: '#34d399' };

    // 各層狀態顏色
    const l1Warn   = macroOpposePenalty > 0 || hardAdxPenalty > 0;
    const l1Color  = l1Warn ? '#f59e0b' : '#22c55e';
    const l1Icon   = l1Warn ? '⚠️' : '✅';
    const l2Status = bigTrendBlocked ? 'block' : bigTrend === 'mixed' ? 'warn' : 'pass';
    const l2Color  = l2Status === 'block' ? '#ef4444' : l2Status === 'warn' ? '#f59e0b' : '#22c55e';
    const l2Icon   = l2Status === 'block' ? '🚫' : l2Status === 'warn' ? '⚠️' : '✅';
    const l3Status = hardBlocked ? 'block' : learnPenalty > 0 ? 'warn' : 'pass';
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

      <!-- 信心分數流程條 -->
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:0.74rem;background:rgba(255,255,255,.03);border-radius:8px;padding:7px 10px;margin-bottom:10px">
        <span style="color:var(--text3);font-size:0.7rem">原始訊號</span>
        <span style="font-weight:700;color:${cColor(rawConf)}">${rawConf}%</span>
        ${hardAdxPenalty > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">ADX -${hardAdxPenalty}</span>` : ''}
        ${macroOpposePenalty > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">宏觀 -${macroOpposePenalty}</span>` : ''}
        ${aiTrendPenalty > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">週/日AI -${aiTrendPenalty}</span>` : ''}
        <span style="color:var(--text3)">→</span>
        <span style="color:var(--text3);font-size:0.7rem">① 後</span>
        <span style="font-weight:700;color:${cColor(macroConf)}">${macroConf}%</span>
        <span style="color:var(--text3)">→</span>
        <span style="color:var(--text3);font-size:0.7rem">② 後</span>
        <span style="font-weight:700;color:${l2Status === 'block' ? '#ef4444' : cColor(macroConf)}">${l2Status === 'block' ? '攔截' : macroConf + '%'}</span>
        ${learnPenalty > 0 ? `<span style="color:var(--text3)">→</span><span style="color:#f59e0b">風控 -${learnPenalty}</span>` : ''}
        <span style="color:var(--text3)">→</span>
        <span style="color:var(--text3);font-size:0.7rem">最終</span>
        <span style="font-weight:700;font-size:0.85rem;color:${l2Status === 'block' ? '#ef4444' : cColor(finalConf)}">${l2Status === 'block' ? '❌' : finalConf + '%'}</span>
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

      <!-- 第③層：AI 風控（止損歷史記憶） -->
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(255,255,255,.04)">
          <span style="font-size:0.88rem">${l3Icon}</span>
          <span style="font-size:0.78rem;font-weight:600;color:var(--text1);flex:1">③ AI 風控（止損歷史記憶）</span>
          <span style="font-size:0.72rem;color:${l3Color}">${
            hardBlocked ? `❌ 硬性攔截（${blockReasons.length}項觸發）`
            : learnPenalty > 0 ? `扣分 -${learnPenalty}%`
            : '✓ 無扣分'
          }</span>
        </div>
        <div style="padding:7px 12px;font-size:0.73rem;line-height:1.6">
          ${!aiReady
            ? `<div style="color:var(--text3)">歷史交易 < 3 筆，AI 止損記憶風控暫不啟用，以人工判斷為主</div>`
            : ''
          }
          ${hardBlocked
            ? blockReasons.map(r => `<div style="color:var(--bear);margin-bottom:2px">🚫 ${r}</div>`).join('')
            : ''
          }
          ${defenseChecks.length ? `
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
            </div>`
            : (aiReady ? `<div style="color:#22c55e">✓ 無歷史止損觸發警告，AI 風控通過</div>` : '')
          }
          ${(aiReady && profile.bestConditions?.length) ? `
            <div class="setup-ai-bests" style="margin-top:6px">
              ${profile.bestConditions.map(c => `<div class="setup-ai-best-item">📈 ${c.label}：${c.value}</div>`).join('')}
            </div>` : ''}
        </div>
      </div>
    </div>`;
  } catch(e) { console.warn('[buildTradeSetup] AI panel render error:', e); return ''; } })()}`;
}

/* ── 局勢重點（純本地指標合成，無外部 API）───────────────────── */
/* ── 儀表板市場大方向 ─────────────────────────────────────── */
/* ── 宏觀綜合方向（與大方向進度條完全一致）──────────────────
   返回 'bull' | 'slight_bull' | 'neutral' | 'slight_bear' | 'bear'
   用於 recordSignalsFromScan 及 updateOpenTrades 的封鎖判斷，
   確保持倉邏輯與 UI 顯示的大方向完全對齊。
   ─────────────────────────────────────────────────────────── */
function computeMacroNetDir(fg, gm) {
  const fgVal = fg ? parseInt(fg.value) : null;
  const chg   = gm?.marketCapChange || 0;
  const dom   = gm?.btcDominance   || 50;
  let bull = 0, bear = 0;

  // 恐慌貪婪
  if (fgVal !== null) {
    if (fgVal >= 60) bull++;
    else if (fgVal <= 40) bear++;
  }
  // 市值變化
  if      (chg > 2)  bull += 2;
  else if (chg > 0)  bull++;
  else if (chg < -2) bear += 2;
  else if (chg < 0)  bear++;
  // BTC 主導
  if      (dom > 56) bear++;
  else if (dom < 44) bull++;

  // 本週 / 今日 AI 走勢
  const wb = computeWeeklyAIBias(fg, gm);
  const tb = computeTodayAIBias(fg, gm);
  const addBias = (bias, bullW, bearW) => {
    if      (bias === 'strong_bull') bull += bullW;
    else if (bias === 'bull')        bull += (bullW * 0.5);
    else if (bias === 'slight_bull') bull += (bullW * 0.25);
    else if (bias === 'strong_bear') bear += bearW;
    else if (bias === 'bear')        bear += (bearW * 0.5);
    else if (bias === 'slight_bear') bear += (bearW * 0.25);
  };
  addBias(wb.bias, 2, 2);
  addBias(tb.bias, 2, 2);

  // 與 buildMarketOutlook 相同的閾值（含強烈層級）
  if      (bull > bear + 3)  return 'strong_bull';
  else if (bull > bear + 1)  return 'bull';
  else if (bear > bull + 3)  return 'strong_bear';
  else if (bear > bull + 1)  return 'bear';
  else if (bull > bear)      return 'slight_bull';
  else if (bear > bull)      return 'slight_bear';
  return 'neutral';
}

function buildMarketOutlook(fg, global) {
  const fgVal = fg ? parseInt(fg.value) : null;
  const fgZh  = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fg?.value_classification] || '';
  const chg   = global?.marketCapChange || 0;
  const dom   = global?.btcDominance   || 50;

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
  // BTC 主導
  if (dom > 56)      { bearPts++; bearArgs.push(`BTC 主導 ${dom.toFixed(1)}%（偏高），山寨資金分散難度大`); }
  else if (dom < 44) { bullPts++; bullArgs.push(`BTC 主導 ${dom.toFixed(1)}%（偏低），山寨季資金活躍`); }
  else               { bullArgs.push(`BTC 主導 ${dom.toFixed(1)}%（均衡），多空資金分布合理`); }

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

  // 靜態宏觀背景（2026 Q2）
  bullArgs.push('比特幣現貨 ETF 持續吸引機構配置資金');
  bullArgs.push('鏈上活躍地址與交易量維持成長趨勢');
  bearArgs.push('美聯儲政策謹慎，市場等待明確降息信號');
  bearArgs.push('全球通脹尚未完全降至目標，降息時程仍有不確定性');

  // 即將公佈事件（2026 Q2/Q3）
  const events = [
    { date: '5/21', label: 'FOMC 會議紀要', impact: 'high' },
    { date: '6/11', label: '美國 CPI（5月）', impact: 'high' },
    { date: '6/18', label: 'FOMC 利率決策', impact: 'high' },
    { date: '7/10', label: '美國 CPI（6月）', impact: 'high' },
    { date: '7/30', label: 'FOMC 利率決策', impact: 'high' },
    { date: '8/14', label: '美國 CPI（7月）', impact: 'high' },
  ];

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
      <div class="macro-ai-pred-list">
        <div class="macro-pred-item">
          <div class="macro-pred-header">
            <span class="macro-pred-event">美聯儲維持利率不變（6月）</span>
            <span class="macro-pred-conf" style="color:#22c55e">信心 82%</span>
          </div>
          <div class="macro-pred-impact bull">📈 預期衝擊：偏多 — 維持不變意味流動性穩定，機構維持風險資產配置，BTC 預計短線 +3% ~ +8%</div>
        </div>
        <div class="macro-pred-item">
          <div class="macro-pred-header">
            <span class="macro-pred-event">美國 CPI 預測 2.4%~2.6%（5月數據）</span>
            <span class="macro-pred-conf" style="color:#f59e0b">信心 71%</span>
          </div>
          <div class="macro-pred-impact">📊 預期衝擊：中性 — 若低於 2.4% 偏多，高於 2.7% 觸發降息延後預期，加密市場承壓</div>
        </div>
        <div class="macro-pred-item">
          <div class="macro-pred-header">
            <span class="macro-pred-event">比特幣 ETF 持續淨流入</span>
            <span class="macro-pred-conf" style="color:#22c55e">信心 78%</span>
          </div>
          <div class="macro-pred-impact bull">📈 預期衝擊：偏多 — 機構配置需求持續，每日淨流入維持 3~8 億美元，提供底部支撐</div>
        </div>
        <div class="macro-pred-item">
          <div class="macro-pred-header">
            <span class="macro-pred-event">美元指數（DXY）走弱趨勢</span>
            <span class="macro-pred-conf" style="color:#22c55e">信心 65%</span>
          </div>
          <div class="macro-pred-impact bull">📈 預期衝擊：偏多 — 美元走弱通常對加密有利，山寨幣受益更明顯</div>
        </div>
        <div class="macro-pred-item">
          <div class="macro-pred-header">
            <span class="macro-pred-event">全球流動性擴張週期</span>
            <span class="macro-pred-conf" style="color:#22c55e">信心 74%</span>
          </div>
          <div class="macro-pred-impact bull">📈 預期衝擊：偏多 — M2 全球貨幣供給增長歷史上與加密牛市高度相關（滯後 ~3個月）</div>
        </div>
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

  // ── 快取命中：快取時間在本週日 08:00 之後 → 整週有效 ──
  try {
    const cached = JSON.parse(localStorage.getItem(_WEEKLY_BIAS_CACHE_KEY) || 'null');
    if (cached && cached.result && cached.timestamp) {
      const weekStart = _getThisWeekSunday8am();
      if (cached.timestamp >= weekStart) {
        return cached.result;
      }
    }
  } catch(e) {}

  // ── 快取過期或宏觀條件有重大變動 → 重新計算 ──
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
  // ⑤ 本週重大事件風險
  const weekEvents = getWeeklyEconEvents().filter(ev => ev.impact === 'high');
  const highRisk   = weekEvents.length >= 2;
  if (weekEvents.length >= 3) { macroBear += 1; }  // 多重高風險事件 → 輕微空方壓力
  const riskNote = weekEvents.length
    ? `本週 ${weekEvents.length} 項高影響數據（${weekEvents.map(e=>e.name.slice(0,10)).join('、')}），注意波動風險`
    : '本週無重大高影響數據，行情以技術面為主';

  const totalScore = macroBull - macroBear;
  const absScore   = Math.abs(totalScore);
  const bias = totalScore >= 3 ? 'strong_bull' : totalScore >= 1 ? 'bull'
             : totalScore <= -3 ? 'strong_bear' : totalScore <= -1 ? 'bear' : 'neutral';
  const biasLabel = { strong_bull:'▲▲ 強勢偏多', bull:'▲ 偏多', strong_bear:'▼▼ 強勢偏空', bear:'▼ 偏空', neutral:'◆ 震盪中性' }[bias];
  const biasColor = bias.includes('bull') ? 'var(--bull)' : bias.includes('bear') ? 'var(--bear)' : 'var(--text2)';
  const conf = Math.min(88, 50 + absScore * 8 + (fgValNow != null ? 5 : 0));
  const confColor = conf >= 70 ? 'var(--bull)' : conf >= 55 ? '#f0a500' : 'var(--text3)';

  const result = { bias, biasLabel, biasColor, conf, confColor, factors, riskNote, highRisk, weekEvents, rangeMode: bias === 'neutral' };

  // ── 學習記錄 + 寫入快取 ──
  try {
    learn.weeklyPred = { bias, factorVotes, mktChgAtTime: mktChgNow, timestamp: Date.now() };
    learn.weights = weights;
    _saveBiasLearning(learn);
    localStorage.setItem(_WEEKLY_BIAS_CACHE_KEY, JSON.stringify({
      result,
      timestamp: Date.now(),
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
    <div style="font-size:0.68rem;color:var(--text3);margin-bottom:10px">📅 預測週期：${weekRange}　建立：${createdAt}</div>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
      <div style="font-size:1.4rem;font-weight:800;color:${biasColor}">${biasLabel}</div>
      <div>
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:3px">AI 信心度</div>
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
  // ⑤ 今日高影響數據事件（最關鍵因素）
  const todayEvs = getTodayEconEvents();
  const highEvs  = todayEvs.filter(ev => ev.impact === 'high');
  const nowMs    = Date.now();
  // 只計算「有效時間窗口」內（2小時前～12小時後）的高影響事件，
  // 避免把數小時前已公布的舊事件也算進 riskNote／conf 扣分
  const relevantHighEvs = highEvs.filter(ev => {
    const mins = (ev.eventTime.getTime() - nowMs) / 60000;
    return mins > -120 && mins < 720;
  });
  highEvs.forEach(ev => {
    const mins = (ev.eventTime.getTime() - nowMs) / 60000;
    if (mins > -120 && mins < 720) {
      bear += 0.5; // 高影響數據帶來不確定性
      const timeLabel = mins < 0 ? '已公布' : mins < 60 ? `${Math.round(mins)}分鐘後` : `${(mins / 60).toFixed(1)}小時後`;
      if (ev.aiPred) {
        reasons.push(`${ev.name}（${timeLabel}）：AI預測 ${ev.aiPred}（信心 ${ev.aiConf}%）`);
      } else {
        reasons.push(`${ev.name}（${timeLabel}）：高影響數據，建議等公布後觀察方向`);
      }
    }
  });

  const score    = bull - bear;
  const absScore = Math.abs(score);
  const bias = score >= 2 ? 'bull' : score <= -2 ? 'bear'
             : score > 0 ? 'slight_bull' : score < 0 ? 'slight_bear' : 'neutral';
  const biasLabel = { bull:'▲ 偏多', bear:'▼ 偏空', slight_bull:'▲ 小幅偏多', slight_bear:'▼ 小幅偏空', neutral:'◆ 中性觀望' }[bias];
  const biasColor = bias.includes('bull') ? 'var(--bull)' : bias.includes('bear') ? 'var(--bear)' : 'var(--text3)';
  // conf 扣分也只計有效時間窗口內的高影響事件（與 riskNote 保持一致）
  const conf = Math.max(30, Math.min(80, 45 + absScore * 8 + (fgVal != null ? 4 : 0) - relevantHighEvs.length * 4));
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

  return { bias, biasLabel, biasColor, conf, confColor, reasons, highEvs, riskNote, rangeMode: bias === 'neutral' || bias === 'slight_bull' || bias === 'slight_bear' };
}

function buildTodayAIBiasHtml(fg, globalMkt) {
  const { biasLabel, biasColor, conf, confColor, reasons, riskNote } = computeTodayAIBias(fg, globalMkt);
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
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
      <div style="font-size:1.4rem;font-weight:800;color:${biasColor}">${biasLabel}</div>
      <div>
        <div style="font-size:0.72rem;color:var(--text3);margin-bottom:3px">AI 信心度</div>
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
    const aiSection  = ev.aiMarketImpact ? `
      <div class="econ-ai-block">
        ${!published && ev.aiPred ? `<div class="econ-ai-row">
          <span class="econ-ai-label">🤖 AI 預測</span>
          <span class="econ-ai-val">${ev.aiPred}</span>
          <span class="econ-ai-conf" style="color:${confColor}">信心 ${ev.aiConf}%</span>
        </div>` : ''}
        <div class="econ-ai-impact">${ev.aiMarketImpact}</div>
      </div>` : '';
    const dateKey = `${ev.eventTime.getFullYear()}-${ev.eventTime.getMonth()}-${ev.eventTime.getDate()}`;
    const actualVal = published ? getEconActualValue(ev.name, dateKey) : '';
    const hasBLS = !!BLS_SERIES_MAP[ev.name] || !!KNOWN_ACTUALS[`${ev.name}_${dateKey}`];
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
    (title.length > 60 ? title.slice(0, 57) + '…' : title);

  // 生成重點摘要（2條）
  const points = [];
  if (text.includes('etf')) points.push('ETF 相關資金流向動態值得密切追蹤');
  if (text.includes('institutional') || text.includes('wall street')) points.push('傳統金融機構持續進場布局加密資產');
  if (text.includes('regulation') || text.includes('sec') || text.includes('legislation')) points.push('監管環境變化將直接影響市場合規方向');
  if (text.includes('fed') || text.includes('rate') || text.includes('inflation')) points.push('宏觀貨幣政策走向牽動整體風險資產情緒');
  if (text.includes('hack') || text.includes('exploit')) points.push('安全事件引發市場恐慌，相關資金短線外流');
  if (text.includes('adoption') || text.includes('partnership')) points.push('採用率提升有助於長線基本面支撐');
  if (text.includes('liquidation')) points.push('高槓桿倉位被迫清算，價格波動幅度放大');
  if (text.includes('upgrade') || text.includes('protocol')) points.push('技術升級提升網絡效能與用戶體驗');
  if (text.includes('record') || text.includes('all-time')) points.push('歷史新高附近容易出現獲利了結賣壓');
  if (text.includes('defi') || text.includes('tvl')) points.push('DeFi 總鎖倉量變化反映市場整體資金動向');

  // 若關鍵詞不足，從 body 提取首句
  if (points.length < 2 && body && body.length > 40) {
    const firstSent = body.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).find(s => s.length > 30 && s.length < 160);
    if (firstSent) points.push(firstSent.trim());
  }
  if (points.length === 0) points.push('加密市場持續受到宏觀環境與監管動態雙重影響');

  // 市場影響分析
  const bullKw = ['etf', 'institutional', 'approval', 'bullish', 'surge', 'rally', 'adoption',
    'inflow', 'halving', 'upgrade', 'partnership', 'launch', 'record', 'milestone',
    'breakout', 'accumulate', 'approved', 'investment', 'fund', 'all-time', 'bitcoin reserve', 'rate cut'];
  const bearKw = ['hack', 'ban', 'lawsuit', 'crash', 'bubble', 'scam', 'fraud', 'bearish',
    'drop', 'plunge', 'outflow', 'liquidation', 'penalty', 'investigation', 'exploit',
    'rug pull', 'bankrupt', 'seized', 'delisted', 'restrict', 'charge', 'crackdown'];
  let bs = 0, rs = 0;
  bullKw.forEach(k => { if (text.includes(k)) bs++; });
  bearKw.forEach(k => { if (text.includes(k)) rs++; });

  let sentiment, conf, label, color, impact;
  if (bs > rs) {
    sentiment = 'bull'; conf = Math.min(84, 52 + bs * 7); label = '偏多'; color = 'var(--bull)';
    impact = bs >= 3
      ? `利多信號明確，機構情緒升溫，${subject}短線上行動能增強，可留意突破機會`
      : `輕微利多，市場情緒小幅改善，${subject}短線受到支撐`;
  } else if (rs > bs) {
    sentiment = 'bear'; conf = Math.min(84, 52 + rs * 7); label = '偏空'; color = 'var(--bear)';
    impact = rs >= 3
      ? `利空壓力較重，風險情緒明顯下降，${subject}短線注意下行風險與止損位置`
      : `輕微利空，市場情緒略顯謹慎，${subject}短線震盪機率上升`;
  } else {
    sentiment = 'neutral'; conf = 50; label = '中性'; color = 'var(--text3)';
    impact = `消息面影響有限，市場等待更明確方向，${subject}短線維持盤整格局`;
  }

  return { zhTitle, points: points.slice(0, 2), sentiment, conf, label, color, impact };
}

function buildNewsWidget(items) {
  const recent = items || [];
  if (!recent.length) return '';

  const sentimentLabel = { bull: '偏多', bear: '偏空', neutral: '中性' };
  const sentimentColor = { bull: 'var(--bull)', bear: 'var(--bear)', neutral: 'var(--text3)' };

  const newsHtml = recent.slice(0, 8).map(item => {
    const sent     = item.sentiment || 'neutral';
    const sentClass = sent === 'bull' ? 'bullish' : sent === 'bear' ? 'bearish' : '';
    const color    = sentimentColor[sent] || 'var(--text3)';
    const label    = sentimentLabel[sent] || '中性';
    const conf     = item.conf ?? 50;
    const confColor = conf >= 70 ? 'var(--bull)' : conf >= 55 ? '#f0a500' : 'var(--text3)';
    const timeAgo  = item.publishedAt ? (() => {
      const m = Math.round((Date.now() - item.publishedAt) / 60000);
      return m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.round(m/60)} 小時前` : `${Math.round(m/1440)} 天前`;
    })() : '';
    const pointsHtml = (item.points || []).map(p => `<div class="news-point">• ${p}</div>`).join('');
    const tag = item.url ? 'a' : 'div';
    const tagOpen  = item.url ? `<a class="news-item ${sentClass}" href="${item.url}" target="_blank" rel="noopener">` : `<div class="news-item ${sentClass}">`;
    const tagClose = item.url ? '</a>' : '</div>';
    return `${tagOpen}
      <div class="news-ai-title">${item.zhTitle || item.title}</div>
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
  ${newsHtml}`;
}

async function loadDashboardMacro() {
  const el = document.getElementById('market-outlook-body');
  if (el) {
    try {
      const [fg, global] = await Promise.all([fetchFearGreed(), fetchGlobalMarket()]);
      // buildMarketOutlook 已內嵌呼叫 buildWeeklyAIOutlook，不需再獨立更新
      el.innerHTML = buildMarketOutlook(fg, global);
    } catch {
      el.innerHTML = '<div style="color:var(--text3);padding:12px;font-size:0.82rem">宏觀數據暫時無法獲取</div>';
    }
  }
  loadDashboardNews();
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

function loadDashboardNews() {
  const el = document.getElementById('news-body');
  if (!el) return;
  el.innerHTML = buildNewsWidget(aiGenerateMarketInsights());
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
  // 整合 AI 風控狀態到操作建議
  if (riskBlocked) {
    p4 = `🚫 <strong>操作建議</strong>：AI 風控硬性攔截（${blockReasons[0]?.slice(0, 60) || '歷史止損條件觸發'}），本次不建議進場，等待市場條件改善。`;
  } else if (tradeDir === 'wait') {
    p4 = `⏸ <strong>操作建議</strong>：當前信號不足或條件受限（信心度 ${finalConf ?? '--'}%），建議觀望，等待更強確認信號。`;
  } else if (rsi > 70 && adx > 30) {
    p4 = `⚠️ <strong>操作建議</strong>：RSI 超買（${rsi}）且趨勢強勁（ADX ${adx}），不宜追高，等待回調至 EMA20（${fmtPrice(coin.ema20)}）附近再考慮介入，設置嚴格止損。`;
  } else if (rsi < 30 && adx > 25) {
    p4 = `💡 <strong>操作建議</strong>：RSI 超賣（${rsi}），若出現帶量反彈K棒可輕倉試多，止損設於近期低點下方。`;
  } else if (bullTFs.length > bearTFs.length && adx > 22) {
    p4 = `✅ <strong>操作建議</strong>：多頭趨勢中（ADX ${adx}），可在回撤至 EMA20（${fmtPrice(coin.ema20)}）附近結合訂單流確認後介入，風險收益比較佳。`;
  } else if (bearTFs.length > bullTFs.length && adx > 22) {
    p4 = `📉 <strong>操作建議</strong>：空頭趨勢中（ADX ${adx}），避免逆勢做多，等待 RSI 底部背離或帶量止跌K棒信號出現後再考慮布局。`;
  } else {
    p4 = `🔄 <strong>操作建議</strong>：市場震盪（ADX ${adx}），建議降低倉位，等待帶量突破關鍵${h1Swing ? `高點（${fmtPrice(h1Swing)}）或低點（${fmtPrice(h1Low)}）` : 'K棒高低點'}後再行跟進。`;
  }

  // ── AI 風控整合段落（有資料才顯示）──
  let p5 = '';
  const totalPen = learnPen + adxPen + macroPen + aiPen;
  if (riskBlocked) {
    const brList = blockReasons.slice(0, 2).map(r => `<li>${r}</li>`).join('');
    p5 = `<div style="background:rgba(239,68,68,.08);border-left:3px solid #ef4444;padding:7px 10px;border-radius:0 6px 6px 0;margin-top:4px">
      <strong style="color:#ef4444">🚫 AI 風控：硬性攔截</strong>
      <ul style="margin:4px 0 0 16px;font-size:0.82em;color:var(--text2)">${brList}</ul>
    </div>`;
  } else if (totalPen > 0 || learnWarn.length > 0) {
    const penDetail = [
      adxPen  > 0 ? `ADX 過低 -${adxPen}%` : '',
      macroPen > 0 ? `宏觀逆風 -${macroPen}%` : '',
      aiPen   > 0 ? `AI趨勢逆向 -${aiPen}%` : '',
      learnPen > 0 ? `止損記憶 -${learnPen}%` : '',
    ].filter(Boolean).join('　');
    const warnList = learnWarn.slice(0, 3).map(w => `<li>${w}</li>`).join('');
    const failChecksHtml = defChecks.filter(c => !c.pass).slice(0, 3)
      .map(c => `<li><span style="color:#f59e0b">${c.label}</span>（歷史 ${c.count} 次，-${c.penalty}%）</li>`).join('');
    p5 = `<div style="background:rgba(245,158,11,.08);border-left:3px solid #f59e0b;padding:7px 10px;border-radius:0 6px 6px 0;margin-top:4px">
      <strong style="color:#f59e0b">⚠️ AI 風控：信心扣分 -${totalPen}%</strong>
      ${rawConf != null ? `<span style="color:var(--text3);font-size:0.8em;margin-left:6px">${rawConf}% → 最終 ${finalConf ?? '--'}%</span>` : ''}
      <div style="font-size:0.8em;color:var(--text3);margin-top:2px">${penDetail}</div>
      ${warnList || failChecksHtml ? `<ul style="margin:4px 0 0 16px;font-size:0.8em;color:var(--text2)">${warnList}${failChecksHtml}</ul>` : ''}
    </div>`;
  } else if (cached) {
    p5 = `<div style="font-size:0.8em;color:#22c55e;margin-top:4px">✅ AI 風控通過：無歷史止損記憶觸發，信心度 ${finalConf ?? '--'}%（原始 ${rawConf ?? '--'}%，無扣分）</div>`;
  }

  return `<div class="ai-analysis-body">
    <div class="ai-para">${p1}</div>
    ${p2 ? `<div class="ai-para">${p2}</div>` : ''}
    ${p3 ? `<div class="ai-para">${p3}</div>` : ''}
    <div class="ai-para">${p4}</div>
    ${p5 ? `<div class="ai-para">${p5}</div>` : ''}
  </div>`;
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
  setL('macro-body'); setL('deriv-body'); setL('setup-body'); setL('mtf-body'); setL('of-body'); setL('ai-body'); setL('vp-body'); setL('situation-body');
  const badge = document.getElementById('mtf-badge');
  if (badge) badge.textContent = '';

  // 並行獲取：多週期 + 恐慌貪婪 + 衍生品 + 宏觀市場 + 減半資訊 + 巨鯨偵測
  const [mtfData, fearGreed, deriv, globalMkt, halving, whale] = await Promise.all([
    fetchMTFKlines(symbol),
    fetchFearGreed(),
    fetchDerivativesData(symbol),
    fetchGlobalMarket(),
    fetchHalvingInfo(),
    fetchWhaleTrades(symbol),
  ]);

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
      e.innerHTML = `<div class="adv-loading" style="color:var(--bear)">⚠️ 載入失敗，請重新整理<br><span style="font-size:0.72rem;color:var(--text3);word-break:break-all">${errMsg}</span></div>`;
    }
  };

  setSafe('macro-body',     () => buildMacroPanel(globalMkt, halving, fearGreed));
  setSafe('deriv-body',     () => buildDerivativesPanel(deriv));
  setSafe('setup-body',     () => buildTradeSetup(coin, mtfData, deriv, globalMkt, whale, fearGreed));
  setSafe('mtf-body',       () => buildMTFTable(mtfData));
  setSafe('of-body',        () => buildOrderFlowPanel(coin, mtfData['15m']?.orderFlow || null));
  setSafe('ai-body',        () => generateAIAnalysis(coin, mtfData, fearGreed));
  setSafe('vp-body',        () => buildVPPanel(coin, mtfData, whale));
  setSafe('situation-body', () => buildSituationSummary(coin, mtfData, deriv, fearGreed, globalMkt, whale));
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
    checkAndSendAlerts(data);
    updateOpenTrades(data);
    recordSignalsFromScan(data);
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
    (t.status === 'open' || t.status === 'pending') &&
    t.entry
  );
  return sameDir || cancelledRecently || anyOpen;
}

/* ── 從掃描數據自動記錄交易信號 ──────────────────────────────── */
function recordSignalsFromScan(data) {
  const tlog = loadTradeLog();
  let changed = false;

  // ── 預先計算宏觀方向（使用與大方向進度條完全一致的多因子評分）──
  let macroNetDir = 'neutral';  // 預設：無快取時全放行
  let wBias = 'neutral', tBias = 'neutral';
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
      wbRangeMode = wb.rangeMode || false;
      tbRangeMode = tb.rangeMode || false;

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

  // ── 方向封鎖（與 buildTradeSetup macroBlockedForRecord 對齊）──
  // 只有極端大方向（strong_bear/strong_bull）才硬封鎖；
  // mild bear/bull 由 computeSimpleSetup conf 扣分過濾（與幣種詳情頁邏輯一致）
  const blockLong  = macroNetDir === 'strong_bear';
  const blockShort = macroNetDir === 'strong_bull';
  // 震盪模式（掃描路徑）：宏觀/週AI/今日AI 三指標中 2+ 個為震盪/中性 → 觸發震盪路徑
  // slight_bull/slight_bear 算震盪（僅 bull/bear/strong 視為有方向性）
  // 4H/日線代理：ADX < 22（在幣種迴圈中逐一確認）
  const _RS_DIR          = ['bull','bear','strong_bull','strong_bear'];
  const _rsMacroNeutral  = !_RS_DIR.includes(macroNetDir);
  const _rsWeeklyNeutral = !_RS_DIR.includes(wBias);
  const _rsTodayNeutral  = !_RS_DIR.includes(tBias);
  const _rsNeutralCnt    = (_rsMacroNeutral ? 1 : 0) + (_rsWeeklyNeutral ? 1 : 0) + (_rsTodayNeutral ? 1 : 0);
  // 無宏觀快取時不觸發震盪模式，避免封鎖所有方向性掃描
  const isRangeMode      = _macroCache ? (_rsNeutralCnt >= 2) : false;
  // 震盪方向限制：三指標中 2+ 個偏空 → 禁多；2+ 個偏多 → 禁空
  const _rsMBear = (macroNetDir === 'strong_bear' || macroNetDir === 'bear' || macroNetDir === 'slight_bear') ? 1 : 0;
  const _rsWBear = wBias.includes('bear') ? 1 : 0;
  const _rsTBear = tBias.includes('bear') ? 1 : 0;
  const _rsMBull = (macroNetDir === 'strong_bull' || macroNetDir === 'bull' || macroNetDir === 'slight_bull') ? 1 : 0;
  const _rsWBull = wBias.includes('bull') ? 1 : 0;
  const _rsTBull = tBias.includes('bull') ? 1 : 0;
  // 震盪方向需要 2+ 個指標同向才允許（與 buildTradeSetup 邏輯對齊）
  const rangeBlockLong  = (_rsMBull + _rsWBull + _rsTBull) < 2;  // 需 2+ 偏多同向
  const rangeBlockShort = (_rsMBear + _rsWBear + _rsTBear) < 2;  // 需 2+ 偏空同向

  // ══════════════════════════════════════════════════
  // Loop 3 ── 震盪單（ADX低 + 影線區 + RSI極值，不受 isRangeMode 限制）
  // ══════════════════════════════════════════════════
  {
    for (const coin of data) {
      const rsiR   = parseFloat(coin.rsi)  || 50;
      const adxR   = parseFloat(coin.adx)  || 25;
      const price  = parseFloat(coin.price) || 0;
      const atr    = parseFloat(coin.atr)   || price * 0.012;

      // ADX < 22：確認真正盤整（代理 4H/日線盤整條件；ADX 22-32 屬弱趨勢非純盤整，不算震盪單）
      if (adxR >= 22) continue;

      const wSupps = Array.isArray(coin.wickSupports)    ? coin.wickSupports    : [];
      const wRess  = Array.isArray(coin.wickResistances) ? coin.wickResistances : [];

      // ── 主要邏輯：利用多次觸碰+收引線的區域定方向 ──────────
      // 中性偏多：現價在「影線支撐區」附近（ATR×2.0），RSI 偏低（< 52）→ 反彈做多
      // 中性偏空：現價在「影線壓力區」附近（ATR×2.0），RSI 偏高（> 48）→ 反壓做空

      let rangeLong = false, rangeShort = false;
      let nearSupp = null, nearRes = null;

      // 找最近影線支撐（在現價下方 ATR×2.0 範圍內）
      for (const z of wSupps) {
        const dist = price - z.level;
        if (dist >= 0 && dist < atr * 2.0) { nearSupp = z; break; }
      }
      // 找最近影線壓力（在現價上方 ATR×2.0 範圍內）
      for (const z of wRess) {
        const dist = z.level - price;
        if (dist >= 0 && dist < atr * 2.0) { nearRes = z; break; }
      }

      // 中性偏多：貼近支撐且 RSI < 52
      if (nearSupp && rsiR < 52) rangeLong = true;
      // 中性偏空：貼近壓力且 RSI > 48（偏高）
      if (nearRes && rsiR > 48 && !rangeLong) rangeShort = true;

      // ── 備用：無明確影線區域 → 用 RSI 震盪位置判斷 ──
      // 震盪市中 RSI 通常在 40~60 之間；42 以下偏低、58 以上偏高
      const hasZones = wSupps.length >= 1 || wRess.length >= 1;
      if (!hasZones) {
        if (rsiR < 42 && adxR < 25) rangeLong  = true;  // 中性偏多
        if (rsiR > 58 && adxR < 25) rangeShort = true;  // 中性偏空
      }

      // 宏觀方向限制：中性偏空不做多，中性偏多不做空
      if (rangeLong  && rangeBlockLong)  continue;
      if (rangeShort && rangeBlockShort) continue;
      if (!rangeLong && !rangeShort) continue;

      const direction = rangeLong ? 'long' : 'short';
      const hasOpen = tlog.some(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending') && t.entry);
      if (hasOpen) continue;
      if (inCooldown(tlog, coin.symbol, direction)) continue;

      // ── TP 設在對向影線區；無影線區時退回 ATR 倍數 ──
      let tp1, tp2;
      if (rangeLong) {
        // TP1 = 最近影線壓力；TP2 = 第二個影線壓力 or TP1 + ATR×0.6
        tp1 = wRess[0]?.level || (price + atr * 0.9);
        tp2 = wRess[1]?.level || (tp1 + atr * 0.6);
      } else {
        // TP1 = 最近影線支撐；TP2 = 第二個影線支撐 or TP1 - ATR×0.6
        tp1 = wSupps[0]?.level || (price - atr * 0.9);
        tp2 = wSupps[1]?.level || (tp1 - atr * 0.6);
      }

      // SL：超出影線區另一側 ATR×0.8 即止損
      const sl = rangeLong
        ? (nearSupp ? nearSupp.level - atr * 0.8 : price - atr * 0.9)
        : (nearRes  ? nearRes.level  + atr * 0.8 : price + atr * 0.9);

      // ── 信心計算（震盪單門檻 75%）──
      // 基礎：有影線區 70，無影線區（備用路徑）65，wicks 只加分不扣分
      const zoneWicks = rangeLong ? (nearSupp?.wicks || 0) : (nearRes?.wicks || 0);
      const hasNearZone = rangeLong ? !!nearSupp : !!nearRes;
      let rawConfR = hasNearZone ? 70 : 65;
      // wicks 次數加成（≥1 次起算，每次 +4，最多 +16）
      rawConfR += Math.min(16, Math.max(0, zoneWicks) * 4);
      // RSI 確認加成：距離 50 越遠越強（最多 +10）
      rawConfR += Math.min(10, Math.abs(rsiR - 50) * 0.5);
      // ADX 越低加成（非趨勢確認）
      if (adxR < 18) rawConfR += 5;
      rawConfR = Math.min(88, rawConfR);

      const { penalty: learnPen, hardBlocked: learnBlock } = applyLearnAdjustment(direction, rsiR, adxR, {});
      // 宏觀 + AI 逆風扣分（macroPenLong/macroPenShort 已包含 AI 趨勢懲罰）
      const macroPenR  = rangeLong ? macroPenLong : macroPenShort;
      // 技術面逆風扣分（震盪路徑）
      let techPenR = 0;
      if (rangeLong  && rsiR > 70) techPenR += 4;
      if (!rangeLong && rsiR < 30) techPenR += 4;
      const _rScanMACD = parseFloat(coin.macdHist) || 0;
      if (rangeLong  && _rScanMACD < 0) techPenR += 3;
      if (!rangeLong && _rScanMACD > 0) techPenR += 3;
      const _rScanVol = coin.volumeStrength || '';
      if (_rScanVol === '低' || _rScanVol.includes('弱')) techPenR += 3;
      techPenR = Math.min(10, techPenR);
      const finalConfR = Math.max(0, rawConfR - learnPen - macroPenR - techPenR);
      if (finalConfR < 70 || learnBlock) continue;  // 震盪單門檻：全部扣分後 ≥ 70

      // ── 進場理由 ──
      const zoneDesc = rangeLong
        ? (nearSupp ? `影線支撐區 $${nearSupp.level.toPrecision(5)}（${nearSupp.wicks} 次觸碰收引線）` : `RSI ${rsiR.toFixed(1)} 超賣`)
        : (nearRes  ? `影線壓力區 $${nearRes.level.toPrecision(5)}（${nearRes.wicks} 次觸碰收引線）` : `RSI ${rsiR.toFixed(1)} 超買`);
      const oppDesc = rangeLong
        ? (wRess[0] ? `影線壓力區 $${wRess[0].level.toPrecision(5)}（${wRess[0].wicks} 次觸碰）` : `ATR 倍數目標`)
        : (wSupps[0] ? `影線支撐區 $${wSupps[0].level.toPrecision(5)}（${wSupps[0].wicks} 次觸碰）` : `ATR 倍數目標`);
      const entryReason = rangeLong
        ? `中性偏多：貼近${zoneDesc}，ADX ${adxR.toFixed(0)} 震盪行情，反彈至${oppDesc}`
        : `中性偏空：貼近${zoneDesc}，ADX ${adxR.toFixed(0)} 震盪行情，反壓至${oppDesc}`;
      const slReason  = rangeLong
        ? `支撐區下方 ATR×0.8（$${sl.toPrecision(5)}），跌破視為支撐失守`
        : `壓力區上方 ATR×0.8（$${sl.toPrecision(5)}），突破視為壓力失守`;
      const tp1Reason = rangeLong
        ? `止盈一：上方影線壓力區 $${tp1.toPrecision(5)}（多次觸碰拒守區域）`
        : `止盈一：下方影線支撐區 $${tp1.toPrecision(5)}（多次觸碰拒守區域）`;
      const tp2Reason = rangeLong
        ? `止盈二：延伸至第二影線壓力區 $${tp2.toPrecision(5)}`
        : `止盈二：延伸至第二影線支撐區 $${tp2.toPrecision(5)}`;

      const risk = Math.abs(price - sl) || atr * 0.9;
      tlog.unshift({
        id: `${coin.symbol}-${Date.now()}`,
        symbol: coin.symbol, direction,
        timestamp: Date.now(),
        entryPrice: price,
        entry: price, sl, tp1, tp2,
        entryReason, slReason, tp1Reason, tp2Reason,
        rr1: Math.abs(tp1 - price) / risk,
        rr2: Math.abs(tp2 - price) / risk,
        rsi: rsiR, adx: adxR,
        score: coin.score, trend: coin.trend,
        conf: Math.round(finalConfR), rawConf: Math.round(rawConfR),
        learnPenalty: Math.round(learnPen), hardAdxPenalty: 0,
        macroPenalty: Math.round(macroPenR), techPenalty: Math.round(techPenR), chipsPenalty: 0,
        status: 'pending', outcome: null, tp1Hit: false,
        entryTime: null,
        exitPrice: null, exitTime: null, pnlR: null, analysis: null,
        refined: false,
        tradeType: 'range',
        wickZoneLevel: rangeLong ? nearSupp?.level : nearRes?.level,
        wickZoneWicks: zoneWicks,
        longTermBias: null, canScaleIn: false,
        scaleIns: [], peakPrice: null,
      });
      changed = true;
      try { if (typeof showToast === 'function') showToast(`📡 新震盪訊號：${coin.symbol} ${direction === 'long' ? '▲做多' : '▼做空'} 信心 ${Math.round(finalConfR)}%，已加入持倉`, 'success'); } catch(_te) {}
    }
  }

  // ══════════════════════════════════════════════════
  // Loop 1 ── 長線單（日線 + 週線同方向，canScaleIn = true）
  // ══════════════════════════════════════════════════
  {
    for (const coin of data) {
      if (coin.score === 50) continue;
      const isLong    = coin.score > 50;
      const direction = isLong ? 'long' : 'short';

      if (isLong  && blockLong)  continue;
      if (!isLong && blockShort) continue;

      // 必須同時有日線與週線 MTF 資料，且兩者同向
      const _ltDayBull = coin.dailySignal?.includes('bull');
      const _ltDayBear = coin.dailySignal?.includes('bear');
      const _ltWkBull  = coin.weeklySignal?.includes('bull');
      const _ltWkBear  = coin.weeklySignal?.includes('bear');
      if (!coin.dailySignal || !coin.weeklySignal) continue;
      const _ltAligned = isLong ? (_ltDayBull && _ltWkBull) : (_ltDayBear && _ltWkBear);
      if (!_ltAligned) continue;

      const hasOpen = tlog.some(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending') && t.entry);
      if (hasOpen) continue;
      if (inCooldown(tlog, coin.symbol, direction)) continue;

      const setup = computeSimpleSetup(coin, isLong);
      if (setup.hardBlocked) continue;
      if (setup.conf < 70) continue;  // 完全扣分後 >= 70% 才進場

      const newTradeLT = {
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
        conf: setup.conf, rawConf: setup.rawConf,
        hardAdxPenalty: setup.hardAdxPenalty || 0,
        learnPenalty: setup.learnPenalty || 0,
        macroPenalty: setup.macroPenalty || 0,
        aiTrendPenalty: setup.aiTrendPenalty || 0,
        techPenalty: setup.techPenalty || 0,
        chipsPenalty: setup.chipsPenalty || 0,
        status: 'pending', outcome: null, tp1Hit: false,
        entryTime: null,
        exitPrice: null, exitTime: null, pnlR: null, analysis: null,
        refined: false,
        tradeType: 'directional',
        longTermBias: null, canScaleIn: true,
        scaleIns: [], peakPrice: null,
      };
      tlog.unshift(newTradeLT);
      changed = true;
      try { if (typeof showToast === 'function') showToast(`📡 長線單：${coin.symbol} ${isLong ? '▲做多' : '▼做空'} 信心 ${setup.conf}%，已加入持倉`, 'success'); } catch(_te) {}
      try {
        const _ns = loadSettings();
        if (_ns.notifTelegram && _ns.tgToken && _ns.tgChatId) {
          const _fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
          const _sym = newTradeLT.symbol.replace('/USDT', '');
          const _dir = isLong ? '▲ 做多' : '▼ 做空';
          const _ci  = newTradeLT.conf >= 85 ? '🟢' : newTradeLT.conf >= 80 ? '🟡' : '🟠';
          sendTelegramMessage(_ns.tgToken, _ns.tgChatId,
            `📡 <b>長線單信號（自動掃描）</b>\n\n` +
            `💎 <b>${newTradeLT.symbol}</b>  ${_dir}\n` +
            `${_ci} 信心度：<b>${newTradeLT.conf}%</b>\n` +
            `📍 建議進場：$${_fmt(newTradeLT.entry)}\n` +
            `🛑 止損：$${_fmt(newTradeLT.sl)}\n` +
            `🎯 長線目標：$${_fmt(newTradeLT.tp1)}\n\n` +
            `📊 RSI ${newTradeLT.rsi} · ADX ${newTradeLT.adx} · 評分 ${newTradeLT.score}\n` +
            `📌 進場理由：${newTradeLT.entryReason || '—'}\n\n` +
            `⚠️ 日線+週線同方向確認，可加倉佈局`
          );
        }
      } catch(_e) {}
    }
  }

  // ══════════════════════════════════════════════════
  // Loop 2 ── 短線單（日線同向 + 周/日AI同向，canScaleIn = false）
  // ══════════════════════════════════════════════════
  {
    for (const coin of data) {
      if (coin.score === 50) continue;  // 完全中性，跳過
      const isLong  = coin.score > 50;
      const direction = isLong ? 'long' : 'short';

      // 方向封鎖：宏觀明確反向 → 跳過
      if (isLong  && blockLong)  continue;
      if (!isLong && blockShort) continue;

      // 三項指標全部主動逆向才跳過（宏觀「輕偏」逆向由扣分處理，不直接封鎖）
      const _dirOppM = (isLong && (macroNetDir === 'bear' || macroNetDir === 'strong_bear')) || (!isLong && (macroNetDir === 'bull' || macroNetDir === 'strong_bull'));
      const _dirOppW = (isLong && wBias.includes('bear'))  || (!isLong && wBias.includes('bull'));
      const _dirOppT = (isLong && tBias.includes('bear'))  || (!isLong && tBias.includes('bull'));
      if (_dirOppM && _dirOppW && _dirOppT) continue;  // 三項全逆向才封鎖

      // 日線同向（優先使用逐幣 dailySignal，無資料時退回趨勢代理）
      const _scanDayBull = coin.dailySignal?.includes('bull');
      const _scanDayBear = coin.dailySignal?.includes('bear');
      const _dailyAligned = coin.dailySignal
        ? (isLong ? _scanDayBull : _scanDayBear)
        : (isLong ? (coin.trend === '強勢看漲' || coin.trend === '看漲')
                  : (coin.trend === '強勢看跌' || coin.trend === '看跌'));
      if (!_dailyAligned) continue;

      // 周/日 AI 預測兩個同向（有宏觀快取時）
      if (_macroCache) {
        const _wAligned = isLong ? wBias.includes('bull') : wBias.includes('bear');
        const _tAligned = isLong ? tBias.includes('bull') : tBias.includes('bear');
        if (!_wAligned || !_tAligned) continue;
      }

      const hasOpen = tlog.some(t => t.symbol === coin.symbol && (t.status === 'open' || t.status === 'pending') && t.entry);
      if (hasOpen) continue;
      if (inCooldown(tlog, coin.symbol, direction)) continue;

      const setup = computeSimpleSetup(coin, isLong);
      if (setup.hardBlocked) continue;
      // 門檻：完全扣分（含宏觀/AI/技術/籌碼）後 >= 70% 才進場
      if (setup.conf < 70) continue;

      // 掃描路徑（短線單），canScaleIn = false
      // 長線單由 Loop 1 獨立處理（日線+週線同向）
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
        conf: setup.conf, rawConf: setup.rawConf,
        hardAdxPenalty: setup.hardAdxPenalty || 0,
        learnPenalty: setup.learnPenalty || 0,
        macroPenalty: setup.macroPenalty || 0,
        aiTrendPenalty: setup.aiTrendPenalty || 0,
        techPenalty: setup.techPenalty || 0,
        chipsPenalty: setup.chipsPenalty || 0,
        status: 'pending', outcome: null, tp1Hit: false,
        entryTime: null,
        exitPrice: null, exitTime: null, pnlR: null, analysis: null,
        refined: false,
        tradeType: 'directional',
        longTermBias: null, canScaleIn: false,
        scaleIns: [], peakPrice: null,
      };
      tlog.unshift(newTrade);
      changed = true;
      try { if (typeof showToast === 'function') showToast(`📡 新訊號：${newTrade.symbol} ${isLong ? '▲做多' : '▼做空'} 信心 ${newTrade.conf}%，已加入持倉`, 'success'); } catch(_te) {}
      // 掃描建單後立即發 Telegram 通知
      try {
        const _ns = loadSettings();
        if (_ns.notifTelegram && _ns.tgToken && _ns.tgChatId) {
          const _fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
          const _sym = newTrade.symbol.replace('/USDT', '');
          const _dir = isLong ? '▲ 做多' : '▼ 做空';
          const _ci  = newTrade.conf >= 85 ? '🟢' : newTrade.conf >= 80 ? '🟡' : '🟠';
          sendTelegramMessage(_ns.tgToken, _ns.tgChatId,
            `📡 <b>新交易信號（自動掃描）</b>\n\n` +
            `💎 <b>${newTrade.symbol}</b>  ${_dir}\n` +
            `${_ci} 信心度：<b>${newTrade.conf}%</b>\n` +
            `📍 建議進場：$${_fmt(newTrade.entry)}\n` +
            `🛑 止損：$${_fmt(newTrade.sl)}\n` +
            `🎯 TP1：$${_fmt(newTrade.tp1)}　TP2：$${_fmt(newTrade.tp2)}\n\n` +
            `📊 RSI ${newTrade.rsi} · ADX ${newTrade.adx} · 評分 ${newTrade.score}\n` +
            `📌 進場理由：${newTrade.entryReason || '—'}\n\n` +
            `⚠️ 此為掃描自動信號，進場前請至幣種詳情頁確認 MTF 分析`
          );
        }
      } catch(_e) {}
    }
  }
  if (changed) {
    if (tlog.length > 500) tlog.splice(500);
    saveTradeLog(tlog);
  }
  // 背景檢測新建短線單是否符合長線條件（異步，不阻塞掃描）
  if (changed) setTimeout(() => backgroundRefineNewTrades(), 2000);
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
      // 用戶需求：日線 AND 週線都確認同方向才算長線單
      const ltBias = computeLongTermBias(mtfData);
      const d1SigBg = mtfData['1d']?.signal;
      const w1SigBg = mtfData['1w']?.signal;
      const d1OkBg  = isLong ? d1SigBg?.signal?.includes('bull') : d1SigBg?.signal?.includes('bear');
      const w1OkBg  = isLong ? w1SigBg?.signal?.includes('bull') : w1SigBg?.signal?.includes('bear');
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
      // 長線單升級：日線 AND 週線都明確確認 + computeLongTermBias 返回同方向 + ltConf 達標
      const canScaleIn = d1OkBg && w1OkBg && ltBias === direction && ltConf >= 82;

      const tlogEdit = loadTradeLog();
      const idx = tlogEdit.findIndex(t => t.id === trade.id);
      if (idx < 0) continue;

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
        // AI 自行判斷加倉次數（與 buildTradeSetup 邏輯一致）
        const _bgRRraw = origRisk > 0 ? Math.abs(ltTP - tlogEdit[idx].entry) / origRisk : 0;
        const _bgScaleCount = (ltConf >= 90 && _bgRRraw >= 5.0) ? 3
                            : (ltConf >= 87 && _bgRRraw >= 4.0) ? 2
                            : 1;
        const _bgScaleReason = _bgScaleCount === 3 ? `長線信心 ${ltConf}%、R/R ${_bgRRraw.toFixed(1)}:1，建議 3 次加倉`
                             : _bgScaleCount === 2 ? `長線信心 ${ltConf}%、R/R ${_bgRRraw.toFixed(1)}:1，建議 2 次加倉`
                             : `長線信心 ${ltConf}%，建議 1 次加倉（保守佈局）`;
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
        tlogEdit[idx].maxScaleIns    = _bgScaleCount;
        tlogEdit[idx].aiScaleReason  = _bgScaleReason;
        tlogEdit[idx].scaleInTargets = bgScaleInLevels.map(s => s.level);
        tlogEdit[idx].scaleInNewSLs  = bgScaleInLevels.map(s => s.newSL);
        // 發送長線升級通知
        try {
          const s = loadSettings();
          if (s.notifTelegram && s.tgToken && s.tgChatId) {
            const fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
            const dirLabel = isLong ? '▲ 做多' : '▼ 做空';
            const confIcon = ltConf >= 90 ? '🟢' : ltConf >= 85 ? '🟡' : '🟠';
            sendTelegramMessage(s.tgToken, s.tgChatId,
              `🏆 <b>長線單升級通知</b>\n\n` +
              `💎 <b>${tlogEdit[idx].symbol}</b>  ${dirLabel}\n` +
              `${confIcon} 長線信心度：<b>${ltConf}%</b>\n` +
              `🏁 長線目標：<b>$${fmt(ltTP)}</b>\n` +
              `📍 進場位：$${fmt(tlogEdit[idx].entry)}\n\n` +
              `🤖 ${_bgScaleReason}`
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

  // ── 信心度崩跌取消：動態計算 freshConf，低於 70% 時自動撤單（所有類型含震盪單）──
  for (const trade of tlog) {
    if (trade.status !== 'pending' || trade.entryTime) continue;
    const baseConf   = trade.rawConf || trade.conf || 100;
    // 靜態懲罰（建單時已計算，後續不重算，但需保留進 freshConf 以正確顯示最終信心度）
    const _adxPen    = trade.hardAdxPenalty || 0;
    const _learnPen  = trade.learnPenalty   || 0;
    let freshConf = baseConf;
    if (_macroCache) {
      try {
        const _fg  = _macroCache.fg, _gm = _macroCache;
        const _fgV = parseInt(_fg?.value || '50');
        const _chg = _gm?.marketCapChange || 0;
        const _dom = _gm?.btcDominance   || 50;
        const _isL = trade.direction === 'long';
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
        let _macP = _agt >= 3 ? 18 : _agt >= 2 ? 12 : _agt >= 1 ? 5 : 0;
        // ADX 不列入 freshConf：建單時 ADX 是靜態品質過濾，不應在每次刷新時重複扣分
        const _wb  = computeWeeklyAIBias(_fg, _gm);
        const _tb  = computeTodayAIBias(_fg, _gm);
        const _wOp = _isL ? _wb.bias.includes('bear') : _wb.bias.includes('bull');
        const _tOp = _isL ? _tb.bias.includes('bear') : _tb.bias.includes('bull');
        const _aiP = (_wOp ? (_wb.bias.includes('strong') ? 8 : 4) : 0) + (_tOp ? 5 : 0);
        // 大方向分歧補扣
        const _fBigDir = computeMacroNetDir(_fg, _gm);
        const _fBdAg = (_isL && _fBigDir.includes('bear')) || (!_isL && _fBigDir.includes('bull'));
        if (_fBdAg) {
          const _fBdMin = (_fBigDir === 'slight_bear' || _fBigDir === 'slight_bull') ? 3 : 7;
          if (_macP < _fBdMin) _macP = _fBdMin;
        }
        // 動態技術面 + 籌碼面扣分（依最新掃描數據重算）
        let _techP = 0, _chipsP = 0;
        const _fCoin = data ? data.find(d => d.symbol === trade.symbol) : null;
        if (_fCoin) {
          const _fRsi = parseFloat(_fCoin.rsi) || 50;
          if (_isL) {
            if (_fRsi > 78)      _techP += 7;
            else if (_fRsi > 70) _techP += 4;
          } else {
            if (_fRsi < 22)      _techP += 7;
            else if (_fRsi < 30) _techP += 4;
          }
          const _fMacd = parseFloat(_fCoin.macdHist) || 0;
          if (_isL  && _fMacd < 0) _techP += 3;
          if (!_isL && _fMacd > 0) _techP += 3;
          const _fVol = _fCoin.volumeStrength || '';
          if (_fVol === '低' || _fVol.includes('弱')) _techP += 3;
          _techP = Math.min(15, _techP);
          const _fDrv = _fCoin.derivData;
          if (_fDrv) {
            const _fTkr = _fDrv.takerBuySell ?? 1;
            if (_isL  && _fTkr < 0.80)       _chipsP += 5;
            else if (_isL  && _fTkr < 0.88)  _chipsP += 3;
            else if (!_isL && _fTkr > 1.20)  _chipsP += 5;
            else if (!_isL && _fTkr > 1.12)  _chipsP += 3;
          }
          const _fWhl = _fCoin.whaleData;
          if (_fWhl) {
            if (_isL  && _fWhl.bias === 'bear' && (_fWhl.bigSellCount || 0) >= 3) _chipsP += 4;
            if (!_isL && _fWhl.bias === 'bull' && (_fWhl.bigBuyCount  || 0) >= 3) _chipsP += 4;
          }
          _chipsP = Math.min(10, _chipsP);
        }
        // 最終信心度 = rawConf - ADX（靜態）- 學習（靜態）- 宏觀（動態）- AI趨勢（動態）- 技術面（動態）- 籌碼面（動態）
        freshConf = Math.max(0, baseConf - _adxPen - _learnPen - _macP - _aiP - _techP - _chipsP);
        // 同步持倉頁面顯示：將 trade.conf 更新為即時計算值，無需點入幣種詳情
        if (trade.conf !== freshConf) { trade.conf = freshConf; changed = true; }
      } catch(_e) {}
    }
    // freshConf 更新僅供顯示，不自動撤單（避免市場短暫波動清空持倉頁面）
  }

  for (const trade of tlog) {
    if (trade.status === 'pending') {
      const coin = data.find(d => d.symbol === trade.symbol);
      // 震盪單：影線區域失效快（2小時）；定向短線單：4小時等待回踩；長線單（canScaleIn=true）：24小時有效
      const isRangeTrade = trade.tradeType === 'range';
      // 長線單必須 canScaleIn===true（代表4H/1D長線偏向+信心>=85）才認定為長線單
      // 注意：longTermBias===direction 僅代表週線順向，不足以判定長線單（會錯誤延長普通定向單的有效期）
      const isLongTermTrade = !isRangeTrade && trade.canScaleIn === true;
      const expiryMs = isRangeTrade ? SIGNAL_COOLDOWN : (isLongTermTrade ? SIGNAL_COOLDOWN * 12 : SIGNAL_COOLDOWN * 2);
      if (!coin || Date.now() - (trade.timestamp || 0) > expiryMs) {
        trade.status = 'expired'; changed = true; continue;
      }
      const cur    = parseFloat(coin.price) || 0;
      const isLong = trade.direction === 'long';
      const entry  = trade.entry;

      // ── 進場前信號有效性檢查：趨勢反轉或評分跌破門檻則取消掛單 ──
      // 震盪單（tradeType='range'）以影線區域為依據，不以趨勢/評分取消
      // （isRangeTrade / isLongTermTrade 已於上方計算）
      const nowScore = parseFloat(coin.score) || 50;
      // 趨勢反轉判斷（震盪單和長線單均跳過）
      const trendReversed = !isRangeTrade && !isLongTermTrade && (isLong
        ? coin.trend?.includes('看跌')
        : coin.trend?.includes('看漲'));
      // 評分跌破取消門檻（長線單寬鬆：多頭<50 / 空頭>50；普通：多頭<55 / 空頭>45）
      // 建單門檻多頭 score>=60、空頭 score<=40，取消門檻需留 5 分緩衝避免建單後立即撤單
      const scoreFailed = !isRangeTrade && (isLong
        ? (isLongTermTrade ? nowScore < 50 : nowScore < 55)
        : (isLongTermTrade ? nowScore > 50 : nowScore > 45));
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
        continue;
      }

      // ── 未回踩進場，價格已飛越止盈位 → 取消並通知（機會已過）──
      const { tp1, tp2 } = trade;
      const missedTP = (isLong && cur >= tp1) || (!isLong && cur <= tp1);
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
        const siTouched = isLong ? cur <= pendingSI.entryLevel * 1.005 : cur >= pendingSI.entryLevel * 0.995;
        if (siTouched) {
          pendingSI.status     = 'open';
          pendingSI.entryTime  = Date.now();
          pendingSI.entryPrice = cur;
          changed = true;

          // ── 止損往前調（每次加倉均執行）：鎖住增量利潤的 30%，不讓利潤大幅回吐 ──
          // 加倉 1 → SL 移至原始進場 + 30% 距離；加倉 2 → SL 移至加倉1進場 + 30% 距離；以此類推
          const confirmedBefore = trade.scaleIns.filter(s => s.status === 'open' && s !== pendingSI);
          const prevEntry = confirmedBefore.length > 0
            ? (confirmedBefore.at(-1).entryPrice || confirmedBefore.at(-1).entryLevel)
            : trade.entry;
          const currentSIEntry = pendingSI.entryPrice || pendingSI.entryLevel;
          const incGain     = Math.abs(currentSIEntry - prevEntry);
          // 止損移至前一進場位 + 30% 增量（鎖住 30% 的移動利潤，不讓回吐超過 70%）
          const candidateSL = isLong
            ? prevEntry + incGain * 0.30
            : prevEntry - incGain * 0.30;
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
          conf: trade.conf || 0,
        });
        changed = true;
      }
    }
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

function sendCancelTelegramNotification(trade, reason) {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;
  const fmt = v => v != null ? parseFloat(v).toPrecision(6).replace(/\.?0+$/, '') : '--';
  const sym = trade.symbol.replace('/USDT', '');
  const dir = trade.direction === 'long' ? '▲ 做多' : '▼ 做空';
  const siteUrl = window.location.origin + window.location.pathname;
  const msg =
    `❌ <b>交易建議已取消</b>\n\n` +
    `💎 <b>${trade.symbol}</b>  ${dir}\n\n` +
    `📍 原進場位：$${fmt(trade.entry)}\n` +
    `🛑 原止損位：$${fmt(trade.sl)}\n\n` +
    `⚠️ 取消原因：${reason}\n\n` +
    `🔗 <a href="${siteUrl}">查看 ${sym} 最新分析 →</a>`;
  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
}

function sendMissedEntryNotification(trade, hitLevel, hitPrice) {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;
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
    ? `🔒 止損已上移：$${fmt(oldSL)} → <b>$${fmt(newSL)}</b>（移至上一進場位）\n`
    : `🛑 現行止損：<b>$${fmt(trade.sl)}</b>\n`;
  const ltTarget = trade.ltTP || scaleIn.tp2 || scaleIn.tp1;
  const siConf = scaleIn.conf || trade.conf || 0;
  const confColor = siConf >= 85 ? '🟢' : siConf >= 75 ? '🟡' : '🔴';
  const msg =
    `📈 <b>加倉確認通知 #${scaleIn.seqNum}</b>\n\n` +
    `💎 <b>${trade.symbol}</b>  ${dir}\n\n` +
    `📍 加倉進場位：<b>$${fmt(scaleIn.entryPrice || scaleIn.entryLevel)}</b>\n` +
    `${slLine}` +
    `🏁 長線最終目標：<b>$${fmt(ltTarget)}</b>\n` +
    `${confColor} 本次加倉信心度：<b>${siConf}%</b>\n\n` +
    `📊 原始進場：$${fmt(trade.entry)}\n` +
    `🔔 已加倉 ${scaleIn.seqNum}/3 次\n\n` +
    `🔗 <a href="${siteUrl}">查看 ${sym} 詳細分析 →</a>`;
  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
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
  // 每分鐘檢查一次，到早上 9 點時發送
  setInterval(async () => {
    const now   = new Date();
    const hour  = now.getHours();
    const today = now.toDateString();
    if (hour !== 9) return;
    const lastSent = localStorage.getItem(DAILY_BRIEF_KEY);
    if (lastSent === today) return;
    localStorage.setItem(DAILY_BRIEF_KEY, today);
    await sendDailyBriefing();
  }, 60 * 1000);
}

async function sendDailyBriefing() {
  const s = loadSettings();
  if (!s.notifTelegram || !s.tgToken || !s.tgChatId) return;
  try {
    const [fg, globalMkt] = await Promise.allSettled([fetchFearGreed(), fetchGlobalMarket()]);
    const fgData  = fg.status === 'fulfilled' ? fg.value : null;
    const mktData = globalMkt.status === 'fulfilled' ? globalMkt.value : null;
    const msg = buildDailyBriefingMsg(fgData, mktData);
    sendTelegramMessage(s.tgToken, s.tgChatId, msg);
  } catch {}
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

  // 今日重要數據公布（含 AI 預測多空方向 + 信心值）
  const todayEconEvents = getTodayEconEvents();
  const eventSection = todayEconEvents.length
    ? todayEconEvents.map(ev => {
        const timeStr = `${ev.twHour}:${String(ev.twMin).padStart(2,'0')}`;
        const impactTag = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢';
        const aiLine = ev.aiPred
          ? `   🤖 AI 預測：${ev.aiPred}（信心 ${ev.aiConf}%）`
          : '';
        const dirLine = ev.bullIf
          ? `   📈 偏多條件：${ev.bullIf.slice(0,60)}`
          : '';
        return `${impactTag} <b>${ev.name}</b>（台灣時間 ${timeStr}）${aiLine ? '\n'+aiLine : ''}${dirLine ? '\n'+dirLine : ''}`;
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
        return `   🕐 ${tl} ${ev.name}${ev.aiPred ? `：AI預測 ${ev.aiPred}（信心 ${ev.aiConf}%）` : ''}`;
      }).join('\n');
    }
  } catch (e) { todayAISection = '（計算失敗）'; }

  return `📊 <b>每日市場簡報</b> ${dateStr}\n\n` +
    `📅 <b>昨日市場回顧</b>\n${yesterdaySection}\n\n` +
    `💰 <b>昨日盈虧報告</b>\n${yesterdayPnlSection}\n\n` +
    `🌐 <b>加密市場大方向</b>\n${marketDirSection}\n\n` +
    `📈 <b>本週 AI 走勢預測</b>\n${weeklyAISection}\n\n` +
    `📅 <b>今日 AI 多空預測</b>\n${todayAISection}\n\n` +
    `🤖 <b>宏觀 AI 預測</b>\n${macroPredSection}\n\n` +
    `📆 <b>今日重要數據</b>\n${eventSection}\n\n` +
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
    aiPred: '218K～228K', aiConf: 72,
    aiMarketImpact: '低於 210K 美元走強加密承壓；高於 240K 降息預期升加密偏多' },
  { name: 'EIA 原油庫存', dayOfWeek: 3, twHour: 22, twMin: 30, prevKey: 'eiaOil',
    description: '美國原油庫存週報，影響通膨預期與風險情緒', impact: 'low',
    bullIf: '庫存大幅下降（通膨預期升溫，加密有時跟漲）',
    bearIf: '庫存大幅增加（通縮壓力，風險情緒轉差）',
    aiPred: '-0.5M ～ -2.0M 桶（小幅去庫存）', aiConf: 57,
    aiMarketImpact: '對加密影響有限，若大幅去庫存 >3M 可能帶動通膨預期升溫' },
  { name: 'FOMC 紀要', dayOfWeek: 3, twHour: 2, twMin: 0, prevKey: 'fomc',
    description: '聯準會政策會議紀要，揭示利率決策討論細節', impact: 'high',
    bullIf: '鴿派傾向（降息預期升溫）→ 加密強烈看多',
    bearIf: '鷹派傾向（維持高利率）→ 加密短線承壓',
    aiPred: '維持謹慎，無明確降息時程信號', aiConf: 78,
    aiMarketImpact: '若出現年底降息暗示可強勁反彈；維持鷹派則短線震盪偏空' },
];

// 每月重要數據（以月份某一週某一天的方式描述）
const MONTHLY_DATA_SCHEDULE = [
  { name: '美國非農就業報告（NFP）', weekOfMonth: 1, dayOfWeek: 5, twHour: 20, twMin: 30,
    prevKey: 'usNFP', impact: 'high',
    description: '最重要的就業數據，直接影響聯準會利率決策',
    bullIf: '< 預期（降息預期升） → 加密大幅上漲機率高',
    bearIf: '> 預期（鷹派預期） → 美元走強，加密承壓',
    aiPred: '170K～200K（前值 175K，維持緩降趨勢）', aiConf: 63,
    aiMarketImpact: '低於 150K 加密強勁反彈；高於 220K 美元走強短線承壓' },
  { name: '美國消費者物價指數（CPI）', weekOfMonth: 2, dayOfWeek: 2, twHour: 20, twMin: 30,
    prevKey: 'usCPI', impact: 'high',
    description: '通膨指標，聯準會最重視的數據之一',
    bullIf: '< 預期（通膨降溫）→ 降息預期升溫，加密偏多',
    bearIf: '> 預期（通膨持續）→ 高利率預期延續，加密偏空',
    aiPred: '2.3%～2.5% YoY（前值 2.4%，通膨緩慢降溫）', aiConf: 71,
    aiMarketImpact: '低於 2.2% 加密大漲機率高；高於 2.7% 市場恐慌拋售' },
  { name: '美國生產者物價指數（PPI）', weekOfMonth: 2, dayOfWeek: 3, twHour: 20, twMin: 30,
    prevKey: 'usPPI', impact: 'medium',
    description: '生產端通膨先行指標',
    bullIf: '< 預期（生產端通縮）→ CPI 後續下行空間大，偏多',
    bearIf: '> 預期（成本壓力增）→ 通膨預期升，偏空',
    aiPred: '2.0%～2.3% YoY（持續回落趨勢）', aiConf: 64,
    aiMarketImpact: '下行趨勢持續對加密中性偏多；若回升超 2.5% 則承壓' },
  { name: '美國零售銷售', weekOfMonth: 3, dayOfWeek: 2, twHour: 20, twMin: 30,
    prevKey: 'usRetail', impact: 'medium',
    description: '消費支出指標，反映經濟成長動能',
    bullIf: '< 預期（消費疲軟）→ 降息預期升，加密偏多',
    bearIf: '> 預期（消費強勁）→ 高利率預期持續，加密承壓',
    aiPred: '+0.2%～+0.4% MoM（消費趨緩但未惡化）', aiConf: 60,
    aiMarketImpact: '消費趨緩符合降息預期，短線加密輕微偏多' },
  { name: 'ADP 就業人數', weekOfMonth: 1, dayOfWeek: 3, twHour: 20, twMin: 15,
    prevKey: 'usADP', impact: 'medium',
    description: 'NFP 前瞻指標，為非農數據的早期信號',
    bullIf: '< 預期 → 降息預期升，加密偏多',
    bearIf: '> 預期 → 就業強勁，鷹派預期延續',
    aiPred: '165K～185K（接近NFP預測，勞市溫和放緩）', aiConf: 63,
    aiMarketImpact: '低於 150K 加密情緒明顯升溫；可作為 NFP 方向性參考' },
];

const ECON_ALERT_KEY = 'csp_econ_alert_sent';

function startEconCalendarCheck() {
  // 每分鐘檢查一次：公布前預警 + 公布後 AI 分析
  setInterval(() => {
    checkUpcomingEconEvents();
    checkPostEventAnalysis();
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
  const tradeNote  = openTrades.length
    ? `\n⚠️ 目前持有 ${openTrades.length} 筆倉位，數據公布前建議確認止損位置`
    : '';

  const msg =
    `${impactEmoji} <b>重要數據即將公布（約1小時後）</b>\n\n` +
    `📊 <b>${ev.name}</b>\n` +
    `⏰ 台灣時間：<b>${twTime}</b>\n` +
    `📝 說明：${ev.description}\n\n` +
    `📈 若數據優於預期：${ev.bullIf}\n` +
    `📉 若數據差於預期：${ev.bearIf}\n\n` +
    `🎯 <b>盤面影響分析</b>\n` +
    `• 數據公布前 30 分鐘通常出現方向性試探\n` +
    `• 公布後 5~15 分鐘為高波動期，避免追入\n` +
    `• 公布後 1 小時若延續方向可考慮跟進${tradeNote}`;
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

function sendPostEventAnalysis(ev, s, snap, fgNow, mktNow) {
  const impactEmoji = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢';

  // ── 判斷市場實際反應（偏多/偏空）──────────────────────────────
  const mktChgNow  = mktNow?.marketCapChange ?? null;
  const fgValNow   = fgNow  ? parseInt(fgNow.value) : null;

  // 與快照比較（快照保存的是1小時前的24h市值變化率）
  const snapChg    = snap?.marketCapChange ?? null;
  const chgDelta   = (mktChgNow != null && snapChg != null) ? (mktChgNow - snapChg) : null;

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

  // F&G 方向輔助佐證
  const fgSupport = fgValNow != null
    ? `\n💡 恐貪指數：${fgValNow}${biasLabel.includes('多') && fgValNow > 55 ? '，情緒同步偏多，多頭信號強化' : biasLabel.includes('空') && fgValNow < 45 ? '，情緒同步偏空，空頭信號強化' : '，情緒中性，方向信號待確認'}`
    : '';

  // 公布數值顯示（AI 預測值作為參考基準）
  const valueRef = ev.aiPred
    ? `📌 AI 預測數值（事前）：${ev.aiPred}（信心 ${ev.aiConf || '--'}%）`
    : '';

  const msg =
    `${impactEmoji} <b>數據公布後 AI 盤面影響分析</b>\n\n` +
    `📊 <b>${ev.name}</b>\n` +
    (valueRef ? valueRef + '\n' : '') +
    `\n${biasIcon} <b>AI 判斷：${biasLabel}</b>\n` +
    `${biasDetail}${fgSupport}\n\n` +
    `🤖 <b>AI 分析</b>\n${ev.aiMarketImpact || '請依市場實際反應方向操作，等首根確認K棒收線後再決策。'}\n\n` +
    (ev.bullIf ? `📈 偏多情境：${ev.bullIf}\n` : '') +
    (ev.bearIf ? `📉 偏空情境：${ev.bearIf}` : '');

  sendTelegramMessage(s.tgToken, s.tgChatId, msg);
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
    // Case 2: 盈利超過 2R → 建議追蹤止損保護利潤
    else if (currentPnlR >= 2.0) {
      suggestNewSl = isLong
        ? Math.max(entry + atr * 0.5, cur - atr * 1.8)
        : Math.min(entry - atr * 0.5, cur + atr * 1.8);
      alertType  = 'trail';
      alertTitle = `🚀 AI 偵測：盈利 ${currentPnlR.toFixed(1)}R，建議追蹤止損`;
      alertDetail = `價格已從進場點移動 ${currentPnlR.toFixed(2)} R，AI 建議上移止損鎖定部分利潤，避免回吐。`;
    }

    if (!suggestNewSl) continue;

    // 每 4 小時最多提醒一次同類型
    const alertId = `${trade.id}_${alertType}_${Math.floor(now / (4 * 60 * 60 * 1000))}`;
    if (sentAlerts[alertId]) continue;
    sentAlerts[alertId] = true;
    localStorage.setItem(alertKey, JSON.stringify(sentAlerts));

    const fmt     = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
    const dir     = isLong ? '▲ 多' : '▼ 空';
    const pnlSign = currentPnlR >= 0 ? '+' : '';
    const slMove  = isLong
      ? (suggestNewSl > sl ? `⬆ 上移 ${fmt(sl)} → ${fmt(suggestNewSl)}` : `${fmt(sl)} → ${fmt(suggestNewSl)}`)
      : (suggestNewSl < sl ? `⬇ 下移 ${fmt(sl)} → ${fmt(suggestNewSl)}` : `${fmt(sl)} → ${fmt(suggestNewSl)}`);

    const msg =
      `${alertTitle}\n\n` +
      `💎 <b>${trade.symbol}</b> ${dir}\n\n` +
      `📍 進場：$${fmt(entry)}\n` +
      `💰 現價：$${fmt(cur)}\n` +
      `📊 浮動盈虧：<b>${pnlSign}${currentPnlR.toFixed(2)} R</b>\n\n` +
      `📝 ${alertDetail}\n\n` +
      `🛑 <b>建議止損調整</b>\n` +
      `   ${slMove}\n` +
      `   新止損：<b>$${fmt(suggestNewSl)}</b>\n\n` +
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
  for (const k of Object.keys(mem.rules)) { mem.rules[k].active = false; }

  for (const rule of freshRules) {
    const existing = mem.rules[rule.condition];
    if (existing) {
      // 保留最早發現時間，更新最新統計數據
      mem.rules[rule.condition] = {
        ...rule, active: true,
        firstDetected: existing.firstDetected,
        lastUpdated: now,
        occurrences: (existing.occurrences || 1) + 1,
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
  if (closed.length < 3) return { ready: false, closed: closed.length };

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
    if (subAll.length < 3) return null;
    const rate = subLoss.length / subAll.length;
    if (rate < 0.20) return null; // AI 目標勝率 80%+，止損率 > 20% 即觸發規則
    const scaledPenalty = rate >= 0.6 ? penaltyConf + 15 : rate >= 0.4 ? penaltyConf + 5 : penaltyConf;
    return { condition: cond, lossCount: subLoss.length, total: subAll.length,
      rate, penaltyConf: scaledPenalty, warning: warnTpl(Math.round(rate * 100)) };
  };

  const rules = [
    check('long_high_rsi',
      longLosses.filter(t => (t.rsi||50) > 65),
      longClosed.filter(t => (t.rsi||50) > 65),
      15, r => `RSI > 65 做多歷史止損率 ${r}%，AI 已下調信心`),
    check('short_low_rsi',
      shortLosses.filter(t => (t.rsi||50) < 35),
      shortClosed.filter(t => (t.rsi||50) < 35),
      15, r => `RSI < 35 做空歷史止損率 ${r}%，AI 已下調信心`),
    check('low_adx',
      losses.filter(t => (t.adx||20) < 20),
      closed.filter(t => (t.adx||20) < 20),
      10, r => `ADX < 20 震盪市止損率 ${r}%，AI 已下調信心`),
    check('long_high_score_rsi',
      longLosses.filter(t => (t.rsi||50) > 72),
      longClosed.filter(t => (t.rsi||50) > 72),
      20, r => `RSI > 72 超買做多止損率 ${r}%，AI 建議等回調`),
    check('short_oversold',
      shortLosses.filter(t => (t.rsi||50) < 28),
      shortClosed.filter(t => (t.rsi||50) < 28),
      20, r => `RSI < 28 超賣做空止損率 ${r}%，AI 建議等反彈後追空`),
    // VP 位置規則
    check('long_below_poc',
      longLosses.filter(t => t.entryAbovePOC === false),
      longClosed.filter(t => t.entryAbovePOC === false && t.entryAbovePOC !== null),
      12, r => `POC 下方做多止損率 ${r}%，AI 建議等突破籌碼密集區`),
    check('short_above_poc',
      shortLosses.filter(t => t.entryAbovePOC === true),
      shortClosed.filter(t => t.entryAbovePOC === true && t.entryAbovePOC !== null),
      12, r => `POC 上方做空止損率 ${r}%，AI 建議等跌破籌碼密集區`),
    // 巨鯨方向規則
    check('whale_against_long',
      longLosses.filter(t => t.entryWhaleBias === 'bear'),
      longClosed.filter(t => t.entryWhaleBias === 'bear'),
      15, r => `巨鯨偏空時做多止損率 ${r}%，AI 建議順應主力方向`),
    check('whale_against_short',
      shortLosses.filter(t => t.entryWhaleBias === 'bull'),
      shortClosed.filter(t => t.entryWhaleBias === 'bull'),
      15, r => `巨鯨偏多時做空止損率 ${r}%，AI 建議順應主力方向`),
    // 成交量規則
    check('bearish_div_long',
      longLosses.filter(t => t.entryVolDivergence === 'bearish_div'),
      longClosed.filter(t => t.entryVolDivergence === 'bearish_div'),
      15, r => `看跌背離做多止損率 ${r}%，AI 建議量價背離時謹慎追多`),
    // 多週期共振
    check('low_mtf_align',
      losses.filter(t => (t.entryMTFAlign || 0) <= 1),
      closed.filter(t => t.entryMTFAlign != null && t.entryMTFAlign <= 1),
      10, r => `僅1個週期對齊入場止損率 ${r}%，AI 建議等多週期共振`),
    // 止損設置類型
    check('po3_sl_type',
      losses.filter(t => t.entrySlType === 'po3'),
      closed.filter(t => t.entrySlType === 'po3'),
      12, r => `PO3/掃蕩型止損歷史觸發率 ${r}%，AI 建議等掃蕩完成後再進場`),
    check('structural_sl_breach',
      losses.filter(t => t.entrySlType === 'structural'),
      closed.filter(t => t.entrySlType === 'structural'),
      10, r => `結構位止損歷史失守率 ${r}%，AI 建議在更低一層結構設止損`),
    check('atr_sl_breach',
      losses.filter(t => t.entrySlType === 'atr'),
      closed.filter(t => t.entrySlType === 'atr'),
      8, r => `ATR止損歷史觸發率 ${r}%，AI 建議在高波動期擴大ATR倍數`),
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
    // 若現有交易不足，仍嘗試載入記憶中的規則
    if (_learnCache && !_learnCache.ready) {
      try {
        const mem = loadAIMemory();
        const memRules = Object.values(mem.rules || {}).filter(r => (r.active || r.occurrences >= 2) && (r.total || 0) >= 3 && r.warning != null);
        if (memRules.length > 0) {
          _learnCache = { ..._learnCache, ready: true, fromMemory: true, rules: memRules, mem, bestConditions: mem.bestConditions || [] };
        }
      } catch(e) {}
    }
  }
  return _learnCache || { ready: false, closed: 0, rules: [], winRate: 50, wins: 0, losses: 0, bestConditions: [] };
}

function applyLearnAdjustment(direction, rsi, adx, ctx = {}) {
  const profile = getLearnProfile();
  let penalty = 0;
  const warnings = [];
  const blockReasons = [];   // 100次以上硬封鎖
  const defenseChecks = [];  // 所有防線審查項目（供 UI 顯示）

  // ── 防線比對 helper ──
  const addCheck = (type, label, count, fail, pen, block = false) => {
    const safeLabel = (label != null ? String(label) : '');  // 防止 undefined/null 導致 .slice() throw
    const safePen   = (typeof pen === 'number' && isFinite(pen)) ? pen : 0;  // 防止 undefined/NaN 導致 penalty = NaN
    if (fail) {
      penalty += safePen;
      if (type !== 'suggestion') warnings.push(safeLabel || String(label));
      else warnings.push(`💡 改進建議未滿足：「${safeLabel.slice(0, 40)}」（歷史止損 ${count} 次，-${safePen}%）`);
      if (block) blockReasons.push(`🚫 AI最終防線：「${safeLabel.slice(0, 45)}」累計 ${count} 次/筆，已列入永久風控攔截`);
    }
    // 只收錄有足夠數據或有觸發的項目（止損記憶需 5 次以上才顯示）
    if (fail || (type !== 'memory' && count >= 3) || (type === 'memory' && count >= 5)) {
      defenseChecks.push({ type, label: safeLabel.slice(0, 55), count, pass: !fail, penalty: fail ? safePen : 0 });
    }
  };

  // ① 結構化規則（歷史止損統計規則）
  if (profile.ready && profile.rules.length) {
    for (const rule of profile.rules) {
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
        (rule.condition === 'po3_sl_type'          && ctx.slType === 'po3') ||
        (rule.condition === 'structural_sl_breach' && ctx.slType === 'structural') ||
        (rule.condition === 'atr_sl_breach'        && ctx.slType === 'atr');
      const isHardBlock = match && (rule.total || 0) >= 100 && (rule.rate || 0) >= 0.6;
      addCheck('rule', rule.warning, rule.total || 0, match, rule.penaltyConf, isHardBlock);
    }
  }

  // ② 止損原因記憶（次數過多才納入風控防線，閾值 10 次以上）
  const mem = (profile.mem) || loadAIMemory();
  if (mem.issues) {
    for (const issue of Object.values(mem.issues)) {
      const cnt = issue.count || 0;
      if (cnt < 5) continue; // 低於5次不列入風控
      const t = issue.text || '';
      const s = issue.suggestion || '';

      // 比對止損原因是否在當前交易中重演
      const matchesCurrent =
        (t.includes('RSI') && t.includes('偏高') && direction === 'long'  && rsi > 65) ||
        (t.includes('RSI') && t.includes('偏低') && direction === 'short' && rsi < 35) ||
        (t.includes('ADX') && t.includes('過低') && adx < 20) ||
        (t.includes('PO3') && ctx.slType === 'po3') ||
        (t.includes('支撐結構') && ctx.slType === 'structural') ||
        (t.includes('巨鯨') && t.includes('賣出') && direction === 'long'  && ctx.whaleBias === 'bear') ||
        (t.includes('巨鯨') && t.includes('買入') && direction === 'short' && ctx.whaleBias === 'bull') ||
        (t.includes('MTF') && (ctx.mtfAlign ?? 99) <= 1) ||
        (t.includes('週期') && (ctx.mtfAlign ?? 99) <= 1);

      if (matchesCurrent) {
        // 分級懲罰：次數越多懲罰越重
        const pen = cnt >= 100 ? 15 : cnt >= 50 ? 12 : cnt >= 20 ? 9 : cnt >= 10 ? 7 : cnt >= 5 ? 4 : 3;
        addCheck('memory', `📚 止損記憶：「${t.slice(0, 35)}」已出現 ${cnt} 次（-${pen}%）`, cnt, true, pen, cnt >= 100);
        continue; // 已納入，不再重複檢查建議
      }

      // ③ 改進建議比對（止損後的改進建議是否未被遵守）
      if (cnt >= 2 && s) {
        const suggViolated =
          (s.includes('RSI') && (s.includes('50-55') || s.includes('回落')) && direction === 'long'  && rsi > 62) ||
          (s.includes('RSI') && (s.includes('45-50') || s.includes('回升')) && direction === 'short' && rsi < 38) ||
          (s.includes('ADX') && s.includes('22') && adx < 22) ||
          (s.includes('掃蕩') && s.includes('確認') && ctx.slType === 'po3') ||
          (s.includes('主力') && direction === 'long'  && ctx.whaleBias === 'bear') ||
          (s.includes('主力') && direction === 'short' && ctx.whaleBias === 'bull') ||
          (s.includes('多週期') && (ctx.mtfAlign ?? 99) <= 1) ||
          (s.includes('更低一層') && ctx.slType === 'structural');
        if (suggViolated) {
          const pen = Math.min(8, Math.ceil(cnt / 3));
          addCheck('suggestion', s, cnt, true, pen, false);
        } else if (cnt >= 5) {
          // 建議存在且本次未違反 → 通過
          addCheck('suggestion', `✔ 已遵守：「${s.slice(0, 40)}」`, cnt, false, 0, false);
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
    // ATR / 百分比止損
    if (slReason.includes('ATR') || slReason.includes('%') || slReason.includes('結構止損')) {
      issues.push(`止損以 ATR/百分比設置，觸發代表市場波動超出預期範圍（進場時 ATR 或波動估算可能不足）`);
      suggestions.push('波動大時應使用更大的 ATR 倍數或調整倉位大小，避免被正常波動震出');
    }
    // 進場原因回顧（止損後的逆向分析）
    if (entryReason.includes('RSI') && (isLong ? trade.rsi > 65 : trade.rsi < 35)) {
      issues.push(`進場依據含 RSI ${trade.rsi}，${isLong ? '偏高進場' : '偏低進場'}後被止損，動能判斷失準`);
      suggestions.push(`${isLong ? 'RSI > 65' : 'RSI < 35'} 時順勢追入風險較高，建議在 RSI ${isLong ? '回落至 50-55' : '回升至 45-50'} 後等確認再入場`);
    }
    if (entryReason.includes('多頭信號') || entryReason.includes('空頭信號')) {
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
        case 'po3_sl_type':         return trade.entrySlType === 'po3';
        case 'structural_sl_breach':return trade.entrySlType === 'structural';
        case 'atr_sl_breach':       return trade.entrySlType === 'atr';
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
  const winRateColor = winRateNum >= 80 ? 'var(--bull)' : winRateNum >= 60 ? '#f59e0b' : 'var(--bear)';

  // ── 目前的風控規則（含記憶）──
  const rules = profile.rules || [];
  const rulesHtml = rules.length
    ? rules.map(r => {
        const fd = r.firstDetected ? `首次發現 ${fmtDate(r.firstDetected)}` : '';
        const occ = (r.occurrences || 0) > 1 ? `· 出現 ${r.occurrences} 次` : '';
        const memBadge = !r.active ? `<span class="ai-mem-badge">記憶</span>` : '';
        return `<div class="ai-rule-item">
          <div class="ai-rule-cond">⚡ ${r.warning} ${memBadge}</div>
          <div class="ai-rule-stats">樣本 ${r.total} 筆 · 止損率 <strong style="color:var(--bear)">${Math.round(r.rate*100)}%</strong> · 下調信心 <strong>${r.penaltyConf}%</strong>${fd ? ' · ' + fd : ''}${occ ? ' ' + occ : ''}</div>
        </div>`;
      }).join('')
    : `<div class="ai-learn-ok">✅ 目前無高風險模式，歷史條件均衡</div>`;

  // ── RSI / ADX 熱力圖（僅有實際數據時才渲染）──
  const makeZoneBar = stats => (stats || []).filter(z => z.total > 0).map(z => {
    const lr  = z.lossRate;
    const clr = lr === null ? 'var(--text3)' : lr > 0.2 ? (lr > 0.4 ? 'var(--bear)' : '#f59e0b') : 'var(--bull)';
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
        ${memIssues.map(iss => `
          <div class="ai-issue-row">
            <div class="ai-issue-txt">⚠️ ${iss.text}<span class="ai-issue-cnt">×${iss.count}</span>${iss.firstDetected ? `<span class="ai-mem-date">首次 ${fmtDate(iss.firstDetected)}</span>` : ''}</div>
            ${iss.suggestion ? `<div class="ai-sugg-txt">→ ${iss.suggestion}</div>` : ''}
          </div>`).join('')}
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
        <div class="ai-goal-mark80"></div>
      </div>
      <span class="ai-goal-pct" style="color:${winRateColor}">${winRate}%</span>
      <span class="ai-goal-target">目標 80%</span>
    </div>

    ${notReadyNote}

    <div class="ai-learn-section">
      <div class="ai-section-title">⚙️ 已學習並套用的風控規則</div>
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
      <div class="pos-empty">目前沒有進行中的交易推薦<br><span style="font-size:0.83rem;color:var(--text3)">掃描到信心度 ≥ 70% 的訊號時會自動出現</span></div>`;
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
    const risk    = Math.abs(entry - sl) || 1;
    const isLong  = t.direction === 'long';

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

    const conf      = t.rawConf != null
      ? Math.max(0, t.rawConf - (t.hardAdxPenalty||0) - (t.learnPenalty||0) - (t.macroPenalty||0) - (t.aiTrendPenalty||0) - (t.techPenalty||0) - (t.chipsPenalty||0))
      : (t.conf || Math.min(90, t.score || 60));
    const confClr   = conf >= 70 ? 'var(--bull)' : conf >= 55 ? '#ff6d00' : 'var(--text3)';
    const isRange   = t.tradeType === 'range';
    const isLongTermOpen = !isRange && t.canScaleIn === true;
    const dirLabel  = isLong ? '▲ 做多' : '▼ 做空';
    const dirColor  = isLong ? 'var(--bull)' : 'var(--bear)';
    const rangeBadge = isRange
      ? `<span style="display:inline-flex;align-items:center;gap:3px;margin-left:7px;padding:2px 7px;border-radius:20px;font-size:0.7rem;font-weight:700;background:rgba(99,102,241,.18);border:1px solid rgba(99,102,241,.4);color:#a5b4fc;vertical-align:middle">🔄 震盪</span>`
      : '';
    const ltBadgeOpen = isLongTermOpen
      ? `<span style="display:inline-flex;align-items:center;gap:3px;margin-left:7px;padding:2px 7px;border-radius:20px;font-size:0.7rem;font-weight:700;background:rgba(34,197,94,.18);border:1px solid rgba(34,197,94,.4);color:#4ade80;vertical-align:middle">〔長線單〕</span>`
      : '';
    const shortTermBadgeOpen = (!isRange && !isLongTermOpen && t.is4hDayAligned !== false)
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
                  <span style="color:var(--bear)">${fmtPrice(sl)}</span>
                  <span style="color:var(--text3)">現價 <b style="color:${fillClr}">${fmtPrice(cur)}</b></span>
                  <span style="color:#22c55e">${fmtPrice(finalTP)}</span>
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
                <span style="color:var(--bear)">${fmtPrice(sl)}</span>
                <span style="color:var(--text3)">現價 <b style="color:${fillClr}">${fmtPrice(cur)}</b></span>
                <span style="color:#22c55e">${fmtPrice(tp2)}</span>
              </div>
            </div>`;
        }
      }
    }

    const reasons = (t.entryReason || '').split('，').filter(Boolean);

    return `<div class="pos-card" data-symbol="${t.symbol}" data-unreal="${unrealR !== null ? unrealR.toFixed(4) : ''}" onclick="navigateTo('coin','${t.symbol}')">
      <div class="pos-card-top">
        <div class="pos-symbol">
          <span class="pos-sym-name">${t.symbol.replace('/USDT','')}<span style="color:var(--text3)">/USDT</span></span>
          <span class="pos-dir" style="color:${dirColor}">${dirLabel}${rangeBadge}${ltBadgeOpen}${shortTermBadgeOpen}</span>
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
          <div class="pos-cell-val" style="color:${priceClr}">${cur ? fmtPrice(cur) : '—'}</div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">進場價</div>
          <div class="pos-cell-val">${fmtPrice(entry)}</div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">止損</div>
          <div class="pos-cell-val" style="color:var(--bear)">${fmtPrice(sl)}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${entry&&sl ? ((isLong?sl-entry:entry-sl)/entry*100).toFixed(2)+'%' : ''}</span></div>
        </div>
        ${isLongTermOpen ? `
        <div class="pos-cell">
          <div class="pos-cell-lbl">最終目標</div>
          <div class="pos-cell-val" style="color:#22c55e">${fmtPrice(t.ltTP || tp2)}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${entry&&(t.ltTP||tp2) ? ((isLong?(t.ltTP||tp2)-entry:entry-(t.ltTP||tp2))/entry*100).toFixed(2)+'%' : ''}</span></div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">已加倉</div>
          <div class="pos-cell-val" style="color:#a78bfa">${(t.scaleIns||[]).filter(s=>s.status==='open').length} / 3</div>
        </div>
        <div class="pos-cell" style="grid-column:span 2">
          <div class="pos-cell-lbl">最終信心度（扣分後）</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="color:${confClr};font-weight:700;font-size:0.95rem">${conf}%</span>
            ${t.rawConf ? `<span style="color:var(--text3);font-size:0.7rem">原始 ${t.rawConf}% → ${[
              t.hardAdxPenalty > 0 ? `ADX -${t.hardAdxPenalty}%` : '',
              t.learnPenalty > 0 ? `風控 -${t.learnPenalty}%` : '',
              t.macroPenalty > 0 ? `宏觀 -${t.macroPenalty}%` : '',
              t.aiTrendPenalty > 0 ? `AI -${t.aiTrendPenalty}%` : '',
              t.techPenalty > 0 ? `技術 -${t.techPenalty}%` : '',
              t.chipsPenalty > 0 ? `籌碼 -${t.chipsPenalty}%` : '',
            ].filter(Boolean).join(' ')}</span>` : ''}
          </div>
        </div>
        ` : `
        <div class="pos-cell">
          <div class="pos-cell-lbl">止盈一</div>
          <div class="pos-cell-val" style="color:var(--bull)">${fmtPrice(tp1)}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${entry&&tp1 ? ((isLong?tp1-entry:entry-tp1)/entry*100).toFixed(2)+'%' : ''}</span></div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">止盈二</div>
          <div class="pos-cell-val" style="color:#22c55e">${fmtPrice(tp2)}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${entry&&tp2 ? ((isLong?tp2-entry:entry-tp2)/entry*100).toFixed(2)+'%' : ''}</span></div>
        </div>
        <div class="pos-cell" style="grid-column:span 3">
          <div class="pos-cell-lbl">最終信心度（扣分後）</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="color:${confClr};font-weight:700;font-size:0.95rem">${conf}%</span>
            ${t.rawConf ? `<span style="color:var(--text3);font-size:0.7rem">原始 ${t.rawConf}% → ${[
              t.hardAdxPenalty > 0 ? `ADX -${t.hardAdxPenalty}%` : '',
              t.learnPenalty > 0 ? `風控 -${t.learnPenalty}%` : '',
              t.macroPenalty > 0 ? `宏觀 -${t.macroPenalty}%` : '',
              t.aiTrendPenalty > 0 ? `AI -${t.aiTrendPenalty}%` : '',
              t.techPenalty > 0 ? `技術 -${t.techPenalty}%` : '',
              t.chipsPenalty > 0 ? `籌碼 -${t.chipsPenalty}%` : '',
            ].filter(Boolean).join(' ')}</span>` : ''}
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
          const lbl   = isDone ? `已觸及 @ ${fmtPrice(actualEntry)}` : isPending ? '等待確認' : `目標 ${fmtPrice(level)}`;
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
            <span style="font-size:0.82rem;font-weight:700;color:#4ade80">${fmtPrice(finalTP)}</span>
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
            const isRange   = t.tradeType === 'range';
            const isLongTermCard = !isRange && t.canScaleIn === true;
            const expiry  = t.timestamp ? fmtDateTime(t.timestamp + (isLongTermCard ? SIGNAL_COOLDOWN * 12 : SIGNAL_COOLDOWN * 2)) : '—';
            const cur     = parseFloat((state.data.find(d => d.symbol === t.symbol) || {}).price) || 0;
            const distPct = (cur && t.entry) ? (((cur - t.entry) / t.entry) * 100 * (isLong ? 1 : -1)).toFixed(2) : null;
            const distClr = distPct === null ? 'var(--text3)' : Math.abs(parseFloat(distPct)) <= 0.5 ? 'var(--bull)' : 'var(--text2)';
            const typeLabel = isRange
              ? `<span style="font-size:0.72rem;font-weight:700;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);color:#a5b4fc;padding:2px 7px;border-radius:20px;margin-left:6px">🔄 震盪</span>`
              : '';
            const ltBadgePend = isLongTermCard
              ? `<span style="font-size:0.72rem;font-weight:700;background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.35);color:#4ade80;padding:2px 7px;border-radius:20px;margin-left:6px">〔長線單〕</span>`
              : '';
            const shortTermBadgePend = (!isRange && !isLongTermCard && t.is4hDayAligned !== false)
              ? `<span style="font-size:0.72rem;font-weight:700;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.35);color:#fbbf24;padding:2px 7px;border-radius:20px;margin-left:6px">⚡ 短線</span>`
              : '';
            const pendReasons = (t.entryReason || '').split('，').filter(Boolean);
            // 最終信心度（與持倉頁開倉卡片相同邏輯：rawConf - 各懲罰項）
            const _pConf = t.rawConf != null
              ? Math.max(0, t.rawConf - (t.hardAdxPenalty||0) - (t.learnPenalty||0) - (t.macroPenalty||0) - (t.aiTrendPenalty||0) - (t.techPenalty||0) - (t.chipsPenalty||0))
              : (t.conf || t.score || 0);
            const _pConfClr = _pConf >= 80 ? 'var(--bull)' : _pConf >= 70 ? '#f59e0b' : 'var(--text3)';
            // 長線單：加倉位
            const _siTargets = t.scaleInTargets || [];
            return `<div class="pos-card" data-symbol="${t.symbol}" data-unreal="" onclick="navigateTo('coin','${t.symbol}')">
              <div class="pos-card-top">
                <div class="pos-symbol">
                  <span class="pos-sym-name">${t.symbol.replace('/USDT','')}<span style="color:var(--text3)">/USDT</span></span>
                  <span class="pos-dir" style="color:${dirClr}">${dirLbl}${typeLabel}${ltBadgePend}${shortTermBadgePend}</span>
                </div>
                <div style="font-size:0.8rem;color:var(--neutral);padding:4px 8px;background:rgba(255,215,64,0.1);border-radius:6px">⏳ 等待回踩</div>
              </div>
              <div class="pos-grid">
                <div class="pos-cell"><div class="pos-cell-lbl">進場位</div><div class="pos-cell-val">${fmt(t.entry)}</div></div>
                <div class="pos-cell"><div class="pos-cell-lbl">現價距進場</div><div class="pos-cell-val" style="color:${distClr}">${distPct !== null ? distPct + '%' : '—'}</div></div>
                <div class="pos-cell"><div class="pos-cell-lbl">止損位</div><div class="pos-cell-val" style="color:var(--bear)">${fmt(t.sl)}</div></div>
                ${isLongTermCard ? `
                <div class="pos-cell"><div class="pos-cell-lbl">最終止盈位</div><div class="pos-cell-val" style="color:#22c55e">${fmt(t.ltTP || t.tp2 || t.tp1)}</div></div>
                ` : `
                <div class="pos-cell"><div class="pos-cell-lbl">止盈一</div><div class="pos-cell-val" style="color:var(--bull)">${fmt(t.tp1)}</div></div>
                ${t.tp2 ? `<div class="pos-cell"><div class="pos-cell-lbl">止盈二</div><div class="pos-cell-val" style="color:#22c55e">${fmt(t.tp2)}</div></div>` : ''}
                `}
                <div class="pos-cell" style="grid-column:span ${isLongTermCard ? 1 : 1}">
                  <div class="pos-cell-lbl">最終信心度</div>
                  <div class="pos-cell-val" style="color:${_pConfClr}">${_pConf}%</div>
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
      const tlRangeBadge = t.tradeType === 'range'
        ? `<span style="font-size:0.65rem;font-weight:700;background:rgba(99,102,241,.18);border:1px solid rgba(99,102,241,.4);color:#a5b4fc;padding:1px 5px;border-radius:10px;margin-left:4px;vertical-align:middle">🔄</span>`
        : '';
      const dirHtml = t.direction === 'long'
        ? `<span class="tl-dir-long">▲ 多${tlRangeBadge}</span>`
        : `<span class="tl-dir-short">▼ 空${tlRangeBadge}</span>`;

      let statusHtml;
      if (t.status === 'open') {
        statusHtml = `<span class="tl-badge tl-badge-open">進行中</span>`;
      } else if (t.outcome === 'tp2') {
        statusHtml = `<span class="tl-badge tl-badge-tp2">止盈二 ✅</span>`;
      } else if (t.outcome === 'tp1') {
        statusHtml = `<span class="tl-badge tl-badge-tp1">止盈一 ✅</span>`;
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

      return `<tr class="tl-row-click" onclick="showTradeDetail('${t.id}')">
        <td style="font-size:0.78rem;min-width:130px">
          <div style="color:var(--text2)">信號 ${fmtDateTime(t.timestamp)}</div>
          ${t.entryTime ? `<div style="font-size:0.7rem;color:var(--bull);margin-top:2px">進場 ${fmtDateTime(t.entryTime)}</div>` : ''}
          ${exitTimeHtml}
        </td>
        <td style="font-weight:600">${t.symbol.replace('/USDT','')}<span style="color:var(--text3)">/USDT</span></td>
        <td>${dirHtml}</td>
        <td>${fmtPrice(t.entry)}</td>
        <td style="color:var(--bear)">${fmtPrice(t.sl)}</td>
        <td style="color:var(--bull)">${fmtPrice(t.tp1)}</td>
        <td style="color:#22c55e">${fmtPrice(t.tp2)}</td>
        <td>${statusHtml}</td>
        <td>${pnlHtml}</td>
      </tr>`;
    }).join('');

    tableHtml = `<div class="tl-table-wrap">
      <table class="tl-table">
        <thead><tr>
          <th>時間</th><th>幣種</th><th>方向</th><th>進場</th><th>止損</th><th>止盈1</th><th>止盈2</th><th>現狀</th><th>盈虧 R</th>
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
        // 合併 rules
        for (const [k, v] of Object.entries(imported.rules || {})) {
          if (!current.rules[k]) current.rules[k] = v;
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

  const reasons = (trade.entryReason || '').split('，').filter(Boolean);
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
      <span style="color:var(--text3);font-size:0.78rem">信心度</span>
      <div class="td-conf-bar"><div style="width:${conf}%;background:${confColor};height:100%;border-radius:4px;transition:width .3s"></div></div>
      <span style="color:${confColor};font-weight:700">${conf}%</span>
      ${conf >= 85 ? '<span style="font-size:0.7rem;color:#22c55e;margin-left:4px">✓ 高信心</span>' : conf >= 70 ? '<span style="font-size:0.7rem;color:#22c55e;margin-left:4px">✓ 達標</span>' : '<span style="font-size:0.7rem;color:#ef4444;margin-left:4px">✗ 未達標</span>'}
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
        <div class="td-cell-lbl">信心度</div>
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

    // 準備 setup（優先用快取，fallback 補上 macro+AI 扣分的完整版本）
    let notifSetup = _tradeSetupCache[coin.symbol] || null;
    if (!notifSetup) {
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
          const weeklyAligned = (isLong && wb.bias.includes('bull')) || (!isLong && wb.bias.includes('bear'));
          const weeklyOpposed = !weeklyAligned && wb.bias !== 'neutral';
          const todayAligned  = (isLong && tb.bias.includes('bull')) || (!isLong && tb.bias.includes('bear'));
          const todayOpposed  = !todayAligned && tb.bias !== 'neutral';
          let aiTrendPen = 0;
          const aiTrendReasons = [];
          if (weeklyOpposed) {
            const pen = wb.bias.includes('strong') ? 8 : 4;
            aiTrendPen += pen;
            aiTrendReasons.push(`本週AI預測 ${wb.biasLabel}，與${isLong ? '做多' : '做空'}逆向，扣 ${pen}%`);
          }
          if (todayOpposed) {
            aiTrendPen += 5;
            aiTrendReasons.push(`今日AI預測 ${tb.biasLabel}，${isLong ? '多頭' : '空頭'}今日逆風，扣 5%`);
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
          const macroPen = against >= 3 ? 18 : against >= 2 ? 12 : against >= 1 ? 5 : 0;
          notifSetup.macroOpposePenalty = macroPen;
          notifSetup.aiTrendPenalty     = aiTrendPen;
          notifSetup.aiTrendReasons     = aiTrendReasons;
          notifSetup.macroReasons       = macroReasons;
          notifSetup.conf = Math.max(0, notifSetup.conf - macroPen - aiTrendPen);
        } catch (e) { /* macro enrichment failed, keep simple conf */ }
      }
    }

    // AI 風控攔截 或 方向=觀望 → 完全不通知
    if (notifSetup.hardBlocked || notifSetup.direction === 'wait') continue;

    // 最終信心度（扣完所有項目後）
    const notifConf = notifSetup.conf
      ?? loadTradeLog().find(t => t.symbol === coin.symbol && t.direction === dir && t.status === 'open')?.conf
      ?? Math.min(90, isLong ? coin.score : 100 - coin.score);

    // 原始信心度（扣分前）
    const rawConfVal = notifSetup.rawConf
      ?? Math.min(90, isLong ? coin.score : 100 - coin.score);

    if (notifConf < 75) continue;  // 扣完分後未過門檻 → 靜默跳過，不通知也不取消

    // 信心度達標 → 完整交易信號通知
    if (s.notifBrowser) {
      sendBrowserNotification(
        `${isLong ? '▲ 做多' : '▼ 做空'} 信號：${coin.symbol}`,
        `評分 ${coin.score} | ${coin.trend} | 現價 $${coin.price}`,
        coin.symbol
      );
    }
    if (s.notifTelegram && s.tgToken && s.tgChatId) {
      sendTelegramMessage(s.tgToken, s.tgChatId,
        buildTelegramText(coin, dir, notifSetup, _macroCache, window.location.origin + window.location.pathname));
    }

    next[coin.symbol] = { dir, sentAt: now };
  }

  localStorage.setItem(SIGNAL_CACHE_KEY, JSON.stringify(next));
  // 同步到 SW IDB，讓後台掃描能讀取最新冷卻狀態
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SYNC_CACHE', cache: next });
  }
}

function computeSimpleSetup(coin, isLong) {
  const price = parseFloat(coin.price) || 1;
  const adx   = parseFloat(coin.adx)   || 20;
  const rsi   = parseFloat(coin.rsi)   || 50;
  const ema20 = parseFloat(coin.ema20) || price * 0.99;
  const atrPct = adx > 35 ? 0.018 : adx > 25 ? 0.013 : 0.009;
  const atr    = price * atrPct;
  const entry  = isLong ? Math.min(price, ema20 * 1.002) : Math.max(price, ema20 * 0.998);
  const sl     = isLong ? entry - atr * 1.8 : entry + atr * 1.8;
  const risk   = Math.abs(entry - sl);
  const tp1    = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
  const tp2    = isLong ? entry + risk * 2.5 : entry - risk * 2.5;
  const direction = isLong ? 'long' : 'short';

  // ── AI 學習引擎調整（同 buildTradeSetup 相同邏輯）──
  const hardAdxPenalty = adx < 18 ? 28 : adx < 22 ? 14 : 0;
  const { penalty: learnPenalty, warnings: learnWarn, hardBlocked, blockReasons } = applyLearnAdjustment(direction, rsi, adx, {
    slType: 'atr', // simple setup 預設使用 ATR 止損
    skipAdxRule: true,  // hardAdxPenalty 已單獨扣分，避免 low_adx 規則雙重扣分
  });
  // rawConf：以 coin.score 為基礎，加入 RSI/ADX/趨勢強度加成
  // 目標：讓 score 68-74 的高品質信號（RSI 確認 + ADX 趨勢強）也能通過 75% 門檻
  let rawConf = Math.min(90, coin.score || 60);
  // RSI 確認加成（順向 RSI：做多 RSI < 50，做空 RSI > 50 各 +3；極端加 +5）
  if (isLong) {
    if (rsi < 35)       rawConf += 8;
    else if (rsi < 45)  rawConf += 5;
    else if (rsi < 52)  rawConf += 2;
  } else {
    if (rsi > 65)       rawConf += 8;
    else if (rsi > 55)  rawConf += 5;
    else if (rsi > 48)  rawConf += 2;
  }
  // ADX 趨勢強度加成（ADX > 25 確認趨勢）
  if (adx >= 35)      rawConf += 5;
  else if (adx >= 25) rawConf += 3;
  // 趨勢強度加成（強勢看漲/看跌）
  if (coin.trend === '強勢看漲' || coin.trend === '強勢看跌') rawConf += 4;
  rawConf = Math.min(90, rawConf);
  // 宏觀逆風懲罰（與 buildTradeSetup 相同邏輯，使用全域 _macroCache）
  let _sMacroPen = 0, _sAIPen = 0;
  if (typeof _macroCache !== 'undefined' && _macroCache) {
    try {
      const _sfg = _macroCache.fg, _sgm = _macroCache;
      const _sfgV = parseInt(_sfg?.value || '50');
      const _schg = _sgm?.marketCapChange || 0;
      const _sdom = _sgm?.btcDominance   || 50;
      let _sagt = 0;
      if (isLong) {
        if (_schg < -2) _sagt++;
        if (_sdom > 58) _sagt++;
        if (_sfgV < 30) _sagt++;
        if (_sfgV > 75) _sagt += 0.5;
      } else {
        if (_schg > 2)  _sagt++;
        if (_sdom < 44) _sagt++;
        if (_sfgV > 70) _sagt++;
        if (_sfgV < 25) _sagt += 0.5;
      }
      _sMacroPen = _sagt >= 3 ? 18 : _sagt >= 2 ? 12 : _sagt >= 1 ? 5 : 0;
      const _swb = computeWeeklyAIBias(_sfg, _sgm);
      const _stb = computeTodayAIBias(_sfg, _sgm);
      const _swBias = _swb.bias || '';
      const _stBias = _stb.bias || '';
      const _swOp = isLong ? _swBias.includes('bear') : _swBias.includes('bull');
      const _stOp = isLong ? _stBias.includes('bear') : _stBias.includes('bull');
      if (_swOp) _sAIPen += _swBias.includes('strong') ? 8 : 4;
      if (_stOp) _sAIPen += 5;
      // 大方向分歧補扣
      const _sBigDir = computeMacroNetDir(_sfg, _sgm);
      const _sBdAgainst = (isLong && _sBigDir.includes('bear')) || (!isLong && _sBigDir.includes('bull'));
      if (_sBdAgainst) {
        const _sBdMin = (_sBigDir === 'slight_bear' || _sBigDir === 'slight_bull') ? 3 : 7;
        if (_sMacroPen < _sBdMin) _sMacroPen = _sBdMin;
      }
    } catch(_se) {}
  }
  // 技術面扣分 (RSI逆向、MACD、成交量)
  let _sTechPen = 0;
  if (isLong) {
    if (rsi > 78)      _sTechPen += 7;
    else if (rsi > 70) _sTechPen += 4;
  } else {
    if (rsi < 22)      _sTechPen += 7;
    else if (rsi < 30) _sTechPen += 4;
  }
  const _ssMacdH = parseFloat(coin.macdHist) || 0;
  if (isLong  && _ssMacdH < 0) _sTechPen += 3;
  if (!isLong && _ssMacdH > 0) _sTechPen += 3;
  const _ssVolStr = coin.volumeStrength || '';
  if (_ssVolStr === '低' || _ssVolStr.includes('弱')) _sTechPen += 3;
  _sTechPen = Math.min(15, _sTechPen);
  // 籌碼面扣分 (Taker比例、巨鯨)
  let _sChipsPen = 0;
  const _ssDeriv = coin.derivData;
  if (_ssDeriv) {
    const _ssTkr = _ssDeriv.takerBuySell ?? 1;
    if (isLong  && _ssTkr < 0.80)       _sChipsPen += 5;
    else if (isLong  && _ssTkr < 0.88)  _sChipsPen += 3;
    else if (!isLong && _ssTkr > 1.20)  _sChipsPen += 5;
    else if (!isLong && _ssTkr > 1.12)  _sChipsPen += 3;
  }
  const _ssWhale = coin.whaleData;
  if (_ssWhale) {
    if (isLong  && _ssWhale.bias === 'bear' && (_ssWhale.bigSellCount || 0) >= 3) _sChipsPen += 4;
    if (!isLong && _ssWhale.bias === 'bull' && (_ssWhale.bigBuyCount  || 0) >= 3) _sChipsPen += 4;
  }
  _sChipsPen = Math.min(10, _sChipsPen);
  const conf = Math.max(0, rawConf - hardAdxPenalty - learnPenalty - _sMacroPen - _sAIPen - _sTechPen - _sChipsPen);

  // ── 根據 scan 資料欄位動態生成進場理由 ──
  const ema50  = parseFloat(coin.ema50)  || 0;
  const ema200 = parseFloat(coin.ema200) || 0;
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

  // 把 AI 學習警告加入進場依據
  learnWarn.forEach(w => reasons.push(`⚠️ ${w}`));
  if (hardAdxPenalty > 0) {
    reasons.push(`⚠️ ADX ${adx} 過低（${adx < 18 ? '< 18' : '< 22'}），震盪行情信心下調 ${hardAdxPenalty}%`);
  }

  // ── 止損說明：說明 ATR 計算依據與市場狀態 ──
  const slPct    = ((Math.abs(entry - sl) / price) * 100).toFixed(2);
  const atrPctFmt = (atrPct * 100).toFixed(1);
  let slReason;
  if (adx > 30) {
    slReason = `ATR × 1.8（現價 ${isLong ? '下' : '上'}方 ${slPct}%）；ADX ${adx} 趨勢強勁，動態止損跟隨波動幅度`;
  } else if (adx > 22) {
    slReason = `ATR × 1.8（現價 ${isLong ? '下' : '上'}方 ${slPct}%）；ADX ${adx} 趨勢成形，標準止損`;
  } else {
    slReason = `ATR × 1.8（現價 ${isLong ? '下' : '上'}方 ${slPct}%）；ADX ${adx} 偏弱，震盪區間寬鬆止損，避免假突破刮損`;
  }
  if (ema20 > 0) {
    const emaGap = ((Math.abs(price - ema20) / price) * 100).toFixed(2);
    slReason += `；EMA20 距現價 ${emaGap}% 作輔助結構參考`;
  }

  return {
    entry, sl, tp1, tp2,
    entryReasons: reasons,                // 陣列版（buildTelegramText 優先使用）
    entryReason:  reasons.join('，'),     // 字串版（相容其他地方）
    slReason,
    tp1Reason: `短線目標 R/R ${(Math.abs(tp1 - entry) / risk).toFixed(1)}:1，到達後減倉 60%`,
    tp2Reason: `波段目標 R/R ${(Math.abs(tp2 - entry) / risk).toFixed(1)}:1，剩餘倉位移至成本`,
    rr1: (Math.abs(tp1 - entry) / risk).toFixed(1),
    rr2: (Math.abs(tp2 - entry) / risk).toFixed(1),
    atr, conf, rawConf, hardAdxPenalty, learnPenalty,
    macroPenalty: _sMacroPen, aiTrendPenalty: _sAIPen,
    techPenalty: _sTechPen, chipsPenalty: _sChipsPen,
    learnWarn,        // 警告字串陣列
    blockReasons,     // 硬封鎖原因陣列
    defenseChecks: [], // computeSimpleSetup 不計算防線審查，回傳空陣列
    learnFiltered: (conf < 70 || hardBlocked) && rawConf >= 70,
    hardBlocked,
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
