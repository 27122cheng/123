/* ============================================================
   app.js — 主應用邏輯（繁體中文 + 幣安實時K線版）
   ============================================================ */

/* ── 交易設置緩存（供 Telegram 通知使用）────────────────────── */
const _tradeSetupCache = {};
let   _macroCache      = null;

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

  const { data, source } = await fetchMarketData(state.timeframe);
  state.data       = data;
  state.dataSource = source;
  state.filtered   = [...data];
  updateOpenTrades(data);
  recordSignalsFromScan(data);

  hideLoading();
  hideScanBar();
  renderAll();
  loadDashboardMacro();
  startRefreshCycle();
  bindEvents();
  checkApiStatus();
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

  const secs = state.settings.refreshInterval || 60;
  state.countdown = secs;
  updateCountdown();

  state.countdownTimer = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    updateCountdown();
  }, 1000);

  state.refreshTimer = setInterval(async () => {
    if (state.scanning) return; // 上次掃描還沒結束，跳過
    state.countdown = secs;
    state.scanning  = true;
    updateScanProgress(0);
    const { data, source } = await fetchMarketData(state.timeframe);
    state.data       = data;
    state.dataSource = source;
    state.scanning   = false;
    hideScanBar();
    applyFilters();
    renderAll();
    checkAndSendAlerts(data);
    updateOpenTrades(data);
    recordSignalsFromScan(data);
    if (state.currentPage === 'positions') renderPositionsPage();
    const srcLabel = source === 'api' ? '本地 API 實時' : source === 'binance' ? '幣安 K 線實時' : '離線演示數據';
    showToast(`市場數據已刷新（${srcLabel}）`, 'info');
  }, secs * 1000);
}

function updateCountdown() {
  const el = document.getElementById('refresh-countdown');
  if (el) el.textContent = state.countdown + '秒';
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

  // 仪表板搜索
  const dSearch = document.getElementById('dash-search');
  if (dSearch) dSearch.addEventListener('input', () => {
    state.dashSearch = dSearch.value.trim().toUpperCase();
    applyFilters();
    renderDashboardTables();
  });

  // 排名搜索
  const rSearch = document.getElementById('ranking-search');
  if (rSearch) rSearch.addEventListener('input', () => {
    renderRankingTable(rSearch.value.trim().toUpperCase());
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
  if (page === 'ranking') renderRankingTable('');
  if (page === 'settings') populateSettingsPage();
  if (page === 'positions') renderPositionsPage();
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
  renderReversalCards();
  const srcTag = state.dataSource === 'api' ? '本地API'
               : state.dataSource === 'binance' ? '币安实时'
               : '演示数据';
  document.getElementById('last-updated').textContent =
    new Date().toLocaleTimeString('zh-CN') + ' · ' + srcTag;
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

/* ── 仪表板排行表 ───────────────────────────────────────────── */
function renderDashboardTables() {
  const hasFilter   = state.activeFilter !== 'all';
  const hasSearch   = !!state.dashSearch;
  const source      = (hasFilter || hasSearch) ? state.filtered : state.data;
  const unifiedMode = hasSearch || state.activeFilter === '中性';

  const searchWrap = document.getElementById('search-results-wrap');
  const tablesRow  = document.querySelector('.tables-row');

  if (unifiedMode) {
    if (tablesRow)  tablesRow.style.display  = 'none';
    if (searchWrap) searchWrap.style.display = '';

    const titleEl = document.getElementById('search-results-title');
    const cntEl   = document.getElementById('search-results-count');
    const dotEl   = document.getElementById('search-dot');
    if (titleEl) titleEl.textContent = hasSearch ? `「${state.dashSearch}」搜尋結果` : '中性幣種';
    if (cntEl)   cntEl.textContent   = source.length;
    if (dotEl)   dotEl.style.background = hasSearch ? 'var(--blue)' : 'var(--neutral)';

    const tbody = document.getElementById('all-tbody');
    if (tbody) {
      if (source.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:28px">找不到匹配的幣種</td></tr>`;
      } else {
        tbody.innerHTML = sortArr([...source], 'score', 'desc').map(row =>
          buildDashRow(row)
        ).join('');
      }
    }
  } else {
    if (tablesRow)  tablesRow.style.display  = '';
    if (searchWrap) searchWrap.style.display = 'none';

    let bullData = source.filter(d => d.trend === '強勢看漲' || d.trend === '看漲');
    let bearData = source.filter(d => d.trend === '強勢看跌' || d.trend === '看跌');
    bullData = sortArr(bullData, state.sortState.bull.key, state.sortState.bull.dir);
    bearData = sortArr(bearData, state.sortState.bear.key, state.sortState.bear.dir);

    document.getElementById('bull-count').textContent = bullData.length;
    document.getElementById('bear-count').textContent = bearData.length;
    renderTableBody('bull-tbody', bullData);
    renderTableBody('bear-tbody', bearData);
  }
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

/* ── 市场排名表 ─────────────────────────────────────────────── */
function renderRankingTable(search) {
  const tbody = document.getElementById('ranking-tbody');
  if (!tbody) return;

  const rs  = state.sortState.ranking;
  let rows  = sortArr([...state.data], rs.key, rs.dir);
  if (search) rows = rows.filter(d => d.symbol.replace('/USDT','').includes(search));

  tbody.innerHTML = rows.map((row, i) => `
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
        <div class="score-wrap">
          <span style="font-weight:700;color:${scoreColor(row.score)}">${row.score}</span>
          <div class="score-mini-bar" style="min-width:50px">
            <div class="score-mini-fill" style="width:${row.score}%;background:${scoreColor(row.score)}"></div>
          </div>
        </div>
      </td>
      <td style="color:${rsiColor(row.rsi)}">${row.rsi}</td>
      <td style="color:var(--text2);font-size:0.82rem">${fmtVolume(row.volume)}</td>
      <td style="color:${adxColor(row.adx)}">${row.adx}</td>
    </tr>
  `).join('');
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
  const conf     = t.conf || Math.min(90, t.score || 60);
  const confClr  = conf >= 70 ? 'var(--bull)' : conf >= 60 ? '#ff6d00' : 'var(--text3)';

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

  return `
    <div class="setup-verdict ${isLong ? 'verdict-long' : 'verdict-short'}">
      <div class="verdict-dir">
        <span class="verdict-arrow">${isLong ? '▲' : '▼'}</span>
        <span class="verdict-label">${dirLabel}</span>
        <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">持倉進行中</span>
      </div>
      <div class="verdict-conf-wrap">
        <span style="font-size:0.78rem;color:var(--text3)">信號強度</span>
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
      <div class="level-row level-tp1">
        <div class="level-tag">🎯 止盈1</div>
        <div class="level-desc">${t.tp1Reason || '—'}</div>
        <div class="level-price-val">${fmt(tp1)}${pctStr(entry, tp1)}</div>
      </div>
      <div class="level-row" style="border-left:3px solid #22c55e">
        <div class="level-tag">🚀 止盈2</div>
        <div class="level-desc">${t.tp2Reason || '—'}</div>
        <div class="level-price-val">${fmt(tp2)}${pctStr(entry, tp2)}</div>
      </div>
      <div class="level-row level-sl">
        <div class="level-tag">🛑 止損</div>
        <div class="level-desc">${t.slReason || '—'}</div>
        <div class="level-price-val">${fmt(sl)}${pctStr(entry, sl)}</div>
      </div>
    </div>
    ${t.tp1Hit ? '<div style="margin-top:10px;padding:8px 12px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:8px;font-size:0.82rem;color:#22c55e">✅ 止盈一已觸及，建議移動止損至成本價保護利潤</div>' : ''}
    <div style="margin-top:10px;font-size:0.72rem;color:var(--text3)">進場時間：${fmtDateTime(t.timestamp)} · ${fmtRelTime(t.timestamp)}</div>`;
}

/* ── 交易建議（支撐壓力 + 訂單流 + RSI 三位一體）────────────── */
function buildTradeSetup(coin, mtfData, deriv, globalMkt, whale, fearGreed) {
  const price = parseFloat(coin.price) || 0;
  if (!price) return '<div class="adv-loading">價格數據不可用</div>';

  // 若已有進行中的開倉，優先顯示已記錄的設置 + 即時未實現損益
  const existingOpen = loadTradeLog().find(t => t.symbol === coin.symbol && t.status === 'open' && t.entry);
  if (existingOpen) return buildOpenPositionSetup(existingOpen, price);


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

  const totalBull = bullScore + derivBullBonus + macroBullBonus + whaleBullBonus;
  const totalBear = bearScore + derivBearBonus + macroBearBonus + whaleBearBonus;

  let direction = 'wait';
  const primaryBull = (m15?.signal?.includes('bull') ? 1 : 0) + (h1?.signal?.includes('bull') ? 1 : 0);
  const primaryBear = (m15?.signal?.includes('bear') ? 1 : 0) + (h1?.signal?.includes('bear') ? 1 : 0);
  if (primaryBull >= 1 && totalBull >= 3 && totalBull > totalBear + 1) direction = 'long';
  else if (primaryBear >= 1 && totalBear >= 3 && totalBear > totalBull + 1) direction = 'short';

  if (direction === 'long'  && coin.score < 60) direction = 'wait';
  if (direction === 'short' && coin.score > 40) direction = 'wait';
  // 信號強度未達 60% 一律觀望（多空通用）
  if (direction !== 'wait') {
    const prelimConf = Math.min(90, (direction === 'long' ? totalBull : totalBear) * 12);
    if (prelimConf < 60) direction = 'wait';
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

  // 訂單流 & RSI 斜率
  const of15m    = mtfData['15m']?.orderFlow;
  const buyPct   = of15m?.buyPct   || 50;
  const cvdTrend = of15m?.cvdTrend || 'neutral';
  const rsiSlope = h1?.rsiSlope    || 0;
  const rsi      = parseFloat(coin.rsi) || 50;

  if (direction === 'wait') {
    const reasons = [];
    if (primaryBull === 0 && primaryBear === 0) reasons.push('15m/1h 尚未出現明確突破訊號');
    if (coin.adx < 18) reasons.push(`ADX ${coin.adx} 過低，短線震盪不宜追`);
    if (coin.rsi > 72) reasons.push(`RSI ${coin.rsi} 超買，短線追多風險高`);
    if (coin.rsi < 28) reasons.push(`RSI ${coin.rsi} 超賣，短線追空風險高`);
    if (totalBull === totalBear) reasons.push('多空積分相當，等待方向選擇');
    if (coin.score >= 41 && coin.score <= 59) reasons.push(`評分 ${coin.score}，需達 60+ 才推薦做多，40 以下才推薦做空`);
    const entryHigh = resists[0] || swHigh;
    const entryLow  = supps[0]  || swLow;
    return `<div class="setup-wait">
      <div class="setup-wait-icon">⏳</div>
      <div class="setup-wait-title">建議觀望，短線方向未明</div>
      <ul class="setup-wait-reasons">
        ${reasons.length ? reasons.map(r => `<li>${r}</li>`).join('') : '<li>短線訊號不足，耐心等待 15m/1h 有效突破</li>'}
      </ul>
      <div class="setup-wait-cond">
        <strong>等待條件：</strong>15m/1h 帶量實體K棒收破
        <span style="color:var(--bull)">${fmtPrice(entryHigh)}</span>（做多）
        或 <span style="color:var(--bear)">${fmtPrice(entryLow)}</span>（做空）
      </div>
    </div>`;
  }

  const isLong   = direction === 'long';
  const dirColor = isLong ? 'var(--bull)' : 'var(--bear)';
  const dirLabel = isLong ? '短線做多' : '短線做空';
  const dirIcon  = isLong ? '▲' : '▼';

  // ── 進場點 ──
  const m15ema = m15?.ema20 || parseFloat(coin.ema20) || price;
  let entry, entryReasons = [];
  if (isLong) {
    const nearSup = supps[0];
    if (nearSup && (price - nearSup) < atr * 0.8) {
      entry = Math.min(price, nearSup + atr * 0.15);
      entryReasons.push(`1h 結構支撐 ${fmtPrice(nearSup)} 附近確認`);
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
    if (!entryReasons.length)      entryReasons.push('15m/1h 多頭信號共振');
  } else {
    const nearRes = resists[0];
    if (nearRes && (nearRes - price) < atr * 0.8) {
      entry = Math.max(price, nearRes - atr * 0.15);
      entryReasons.push(`1h 結構壓力 ${fmtPrice(nearRes)} 附近確認`);
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
    if (!entryReasons.length)      entryReasons.push('15m/1h 空頭信號共振');
  }

  // ── 止損：結構位 + 緩衝 ──
  let sl, slReason;
  if (isLong) {
    const structSup = supps[0] || (price - atr * 2);
    sl = Math.min(structSup - atr * 0.3, entry - atr * 1.3);
    const slDistPct = ((entry - sl) / price * 100).toFixed(2);
    slReason = supps[0]
      ? `1h 支撐結構 ${fmtPrice(supps[0])} 下方緩衝，-${slDistPct}%，跌破結構反轉`
      : `現價下方 ${slDistPct}%（ATR 止損），動能失效離場`;
  } else {
    const structRes = resists[0] || (price + atr * 2);
    sl = Math.max(structRes + atr * 0.3, entry + atr * 1.3);
    const slDistPct = ((sl - entry) / price * 100).toFixed(2);
    slReason = resists[0]
      ? `1h 壓力結構 ${fmtPrice(resists[0])} 上方緩衝，+${slDistPct}%，突破結構反轉`
      : `現價上方 ${slDistPct}%（ATR 止損），動能失效離場`;
  }
  const risk = Math.abs(entry - sl) || atr;

  // ── 止盈一：最近有意義 S/R，最低 2:1 ──
  let tp1, tp1Reason;
  const minTP1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
  if (isLong) {
    const r1 = resists.find(r => r >= minTP1 * 0.99);
    tp1 = r1 || minTP1;
    const rr1v = ((tp1 - entry) / risk).toFixed(1);
    tp1Reason = r1
      ? `前高壓力 ${fmtPrice(r1)}，R/R ${rr1v}:1，到達後減倉 60%`
      : `短線目標 R/R ${rr1v}:1，到達後減倉 60%`;
  } else {
    const s1 = supps.find(s => s <= minTP1 * 1.01);
    tp1 = s1 || minTP1;
    const rr1v = ((entry - tp1) / risk).toFixed(1);
    tp1Reason = s1
      ? `前低支撐 ${fmtPrice(s1)}，R/R ${rr1v}:1，到達後減倉 60%`
      : `短線目標 R/R ${rr1v}:1，到達後減倉 60%`;
  }

  // ── 止盈二：次遠 S/R 或擺動極值，最低 3:1 ──
  let tp2, tp2Reason;
  const minTP2 = isLong ? entry + risk * 2.5 : entry - risk * 2.5;
  if (isLong) {
    const r2 = resists.find(r => r > tp1 + price * 0.004 && r >= minTP2 * 0.99);
    tp2 = r2 || Math.max(swHigh, minTP2);
    if (tp2 <= tp1) tp2 = Math.max(tp1 + price * 0.004, minTP2);
    const rr2v = ((tp2 - entry) / risk).toFixed(1);
    tp2Reason = r2
      ? `波段壓力 ${fmtPrice(r2)}，R/R ${rr2v}:1，剩餘倉位移至成本`
      : `1h 擺動高點 ${fmtPrice(swHigh)}，R/R ${rr2v}:1，剩餘倉位移至成本`;
  } else {
    const s2 = supps.find(s => s < tp1 - price * 0.004 && s <= minTP2 * 1.01);
    tp2 = s2 || Math.min(swLow, minTP2);
    if (tp2 >= tp1) tp2 = Math.min(tp1 - price * 0.004, minTP2);
    const rr2v = ((entry - tp2) / risk).toFixed(1);
    tp2Reason = s2
      ? `波段支撐 ${fmtPrice(s2)}，R/R ${rr2v}:1，剩餘倉位移至成本`
      : `1h 擺動低點 ${fmtPrice(swLow)}，R/R ${rr2v}:1，剩餘倉位移至成本`;
  }

  const rr1str = ((Math.abs(tp1 - entry) / risk)).toFixed(1);
  const rr2str = ((Math.abs(tp2 - entry) / risk)).toFixed(1);
  const rawConf = Math.min(90, (isLong ? totalBull : totalBear) * 12);

  // 計算入場時的額外背景資料（供 AI 學習使用）
  const entryMTFAlign = ['15m','1h','4h','1d'].filter(tf => {
    const sig = mtfData[tf]?.signal;
    return sig && (isLong ? sig.signal?.includes('bull') : sig.signal?.includes('bear'));
  }).length;
  const tradeCtx = {
    entryAbovePOC:      vp1h?.priceAbovePOC ?? null,
    entryWhaleBias:     whale?.bias || null,
    entryVolBias:       mtfData['1h']?.volAI?.bias || null,
    entryVolBreakout:   mtfData['1h']?.volAI?.isBreakout || false,
    entryVolDivergence: mtfData['1h']?.volAI?.divergence || null,
    entryMTFAlign,
  };

  // AI 學習調整：依歷史止損模式下調信心
  const learnCtx = {
    abovePOC: vp1h?.priceAbovePOC ?? null,
    whaleBias: whale?.bias || null,
    volDivergence: mtfData['1h']?.volAI?.divergence || null,
    mtfAlign: entryMTFAlign,
  };
  const { penalty: learnPenalty, warnings: learnWarnings } = applyLearnAdjustment(direction, rsi, parseFloat(coin.adx) || 20, learnCtx);
  const conf = Math.max(0, rawConf - learnPenalty);
  if (conf < 60) direction = 'wait'; // 學習後信心不足，改觀望
  if (learnWarnings.length && direction !== 'wait') {
    learnWarnings.forEach(w => entryReasons.push(`⚠️ ${w}`));
  }

  // 緩存完整設置供 Telegram 通知使用
  _tradeSetupCache[coin.symbol] = {
    entry, sl, tp1, tp2,
    entryReason: entryReasons.join('，'),
    slReason, tp1Reason, tp2Reason,
    rr1: rr1str, rr2: rr2str, atr, conf,
  };

  // 更新或新增交易記錄（查看詳情時用 S/R 精確版本更新已自動記錄的估算值）
  const tlog = loadTradeLog();
  const existIdx = tlog.findIndex(t => t.symbol === coin.symbol && t.status === 'open' && t.direction === direction);
  if (existIdx >= 0) {
    const ex = tlog[existIdx];
    if (!ex.refined) {
      ex.entry = entry; ex.sl = sl; ex.tp1 = tp1; ex.tp2 = tp2;
      ex.entryReason = entryReasons.join('，');
      ex.slReason = slReason; ex.tp1Reason = tp1Reason; ex.tp2Reason = tp2Reason;
      ex.conf = conf;
      Object.assign(ex, tradeCtx);
      ex.refined = true;
      saveTradeLog(tlog);
    }
  } else if (!inCooldown(tlog, coin.symbol, direction)) {
    tlog.unshift({
      id: `${coin.symbol}-${Date.now()}`,
      symbol: coin.symbol, direction,
      timestamp: Date.now(),
      entryPrice: price, entry, sl, tp1, tp2,
      rsi: parseFloat(coin.rsi) || 50,
      adx: parseFloat(coin.adx) || 20,
      score: coin.score, trend: coin.trend, conf,
      entryReason: entryReasons.join('，'), slReason, tp1Reason, tp2Reason,
      status: 'open', outcome: null, tp1Hit: false,
      exitPrice: null, exitTime: null, pnlR: null, analysis: null,
      refined: true,
      ...tradeCtx,
    });
    if (tlog.length > 500) tlog.splice(500);
    saveTradeLog(tlog);
  }

  // ── 宏觀經濟摘要 ──
  const fgVal  = fearGreed ? parseInt(fearGreed.value) : null;
  const fgZh   = { 'Extreme Fear':'極度恐慌','Fear':'恐慌','Neutral':'中性','Greed':'貪婪','Extreme Greed':'極度貪婪' }[fearGreed?.value_classification] || '';
  const mktChg = globalMkt?.marketCapChange || 0;
  const btcDom = globalMkt?.btcDominance   || 0;
  const fgColor = fgVal != null ? (fgVal < 35 ? 'var(--bear)' : fgVal > 65 ? 'var(--bull)' : 'var(--text2)') : '';
  const macroFavor = (() => {
    if (!fearGreed && !globalMkt) return null;
    let bull = 0, bear = 0;
    if (fgVal != null) { if (fgVal < 35) bull++; else if (fgVal > 65) bear++; }
    if (mktChg > 2) bull++; else if (mktChg < -2) bear++;
    if (btcDom > 58) bear++; else if (btcDom < 44) bull++;
    if (bull > bear) return `宏觀偏多，${isLong ? '順勢' : '逆勢'}`;
    if (bear > bull) return `宏觀偏空，${isLong ? '逆勢需謹慎' : '順勢'}`;
    return '宏觀中性';
  })();

  // ── AI 學習摘要 ──
  const profile = getLearnProfile();
  const aiReady = profile.ready && profile.closed >= 3;

  return `<div class="setup-verdict ${isLong ? 'verdict-long' : 'verdict-short'}">
    <div class="verdict-dir">
      <span class="verdict-arrow">${dirIcon}</span>
      <span class="verdict-label">${dirLabel}</span>
      <span style="font-size:0.72rem;color:var(--text3);margin-left:8px">15m ~ 1h 時間框架</span>
    </div>
    ${conf >= 60 ? `<div class="verdict-conf-wrap">
      <span style="font-size:0.78rem;color:var(--text3)">信號強度</span>
      <div class="conf-bar"><div class="conf-fill" style="width:${conf}%;background:${dirColor}"></div></div>
      <span style="color:${dirColor};font-weight:700;font-size:0.9rem">${conf}%</span>
    </div>` : ''}
  </div>

  ${(fearGreed || globalMkt) ? `<div class="setup-macro-row">
    <div class="setup-macro-title">🌐 宏觀環境參考</div>
    <div class="setup-macro-chips">
      ${fgVal != null ? `<span class="setup-macro-chip" style="color:${fgColor}">🌡 恐貪 ${fgVal}（${fgZh}）</span>` : ''}
      ${mktChg ? `<span class="setup-macro-chip" style="color:${mktChg > 0 ? 'var(--bull)' : 'var(--bear)'}">📈 市值 ${mktChg > 0 ? '+' : ''}${mktChg.toFixed(1)}%</span>` : ''}
      ${btcDom ? `<span class="setup-macro-chip" style="color:${btcDom > 58 ? 'var(--bear)' : btcDom < 44 ? 'var(--bull)' : 'var(--text2)'}">₿ BTC主導 ${btcDom.toFixed(1)}%</span>` : ''}
      ${macroFavor ? `<span class="setup-macro-chip setup-macro-verdict">${macroFavor}</span>` : ''}
    </div>
  </div>` : ''}

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

  ${aiReady ? `<div class="setup-ai-panel">
    <div class="setup-ai-header">
      <span class="setup-ai-title">🤖 AI 歷史學習建議</span>
      <span class="setup-ai-stats">勝率 <strong>${profile.winRate}%</strong>（${profile.wins}勝 / ${profile.losses}敗，共 ${profile.closed} 筆）</span>
    </div>
    ${learnWarnings.length ? `<div class="setup-ai-warns">
      ${learnWarnings.map(w => `<div class="setup-ai-warn-item">⚠️ ${w}</div>`).join('')}
    </div>` : `<div class="setup-ai-ok">✅ 當前條件符合歷史高勝率範圍</div>`}
    ${profile.bestConditions.length ? `<div class="setup-ai-bests">
      ${profile.bestConditions.map(c => `<div class="setup-ai-best-item">📈 ${c.label}：${c.value}</div>`).join('')}
    </div>` : ''}
    ${profile.rules.length ? `<div class="setup-ai-rules">
      ${profile.rules.map(r => `<div class="setup-ai-rule">🔴 ${r.warning}</div>`).join('')}
    </div>` : ''}
  </div>` : ''}`;
}

/* ── 局勢重點（純本地指標合成，無外部 API）───────────────────── */
/* ── 儀表板市場大方向 ─────────────────────────────────────── */
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
  if (chg > 2)       { bullPts += 2; bullArgs.push(`加密總市值 24h +${chg}%，資金積極流入`); }
  else if (chg > 0)  { bullPts++;    bullArgs.push(`加密總市值 24h +${chg}%，小幅成長`); }
  else if (chg < -2) { bearPts += 2; bearArgs.push(`加密總市值 24h ${chg}%，資金明顯流出`); }
  else if (chg < 0)  { bearPts++;    bearArgs.push(`加密總市值 24h ${chg}%，輕微回調`); }
  // BTC 主導
  if (dom > 56)      { bearPts++; bearArgs.push(`BTC 主導 ${dom}%（偏高），山寨資金分散難度大`); }
  else if (dom < 44) { bullPts++; bullArgs.push(`BTC 主導 ${dom}%（偏低），山寨季資金活躍`); }
  else               { bullArgs.push(`BTC 主導 ${dom}%（均衡），多空資金分布合理`); }

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
  if (bullPts > bearPts + 1)      { bias = '偏多'; bColor = 'var(--bull)'; bIcon = '▲'; }
  else if (bearPts > bullPts + 1) { bias = '偏空'; bColor = 'var(--bear)'; bIcon = '▼'; }
  else                             { bias = '中性偏多';  bColor = 'var(--neutral)'; bIcon = '◆'; }

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
    <div class="outlook-events">
      <div class="outlook-events-title">📅 即將公佈重要數據</div>
      <div class="outlook-events-list">
        ${events.map(e => `<div class="outlook-event${e.impact === 'high' ? ' outlook-event-high' : ''}">
          <span class="outlook-event-date">${e.date}</span>${e.label}</div>`).join('')}
      </div>
    </div>
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

async function loadDashboardMacro() {
  const el = document.getElementById('market-outlook-body');
  if (!el) return;
  try {
    const [fg, global] = await Promise.all([fetchFearGreed(), fetchGlobalMarket()]);
    el.innerHTML = buildMarketOutlook(fg, global);
  } catch {
    el.innerHTML = '<div style="color:var(--text3);padding:12px;font-size:0.82rem">宏觀數據暫時無法獲取</div>';
  }
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

  /* ── 巨鯨進退場 ── */
  let whaleHtml = '';
  if (wPat) {
    const netM    = (Math.abs(wPat.netFlow) / 1e6).toFixed(2);
    const netDir  = wPat.netFlow > 0 ? '買' : '賣';
    const narrCls = wPat.pattern === 'accumulation' ? 'vp-narr-bull' : wPat.pattern === 'distribution' ? 'vp-narr-bear' : '';
    const narr    = wPat.pattern === 'accumulation' ? '⚠️ 偵測到機構吸籌跡象，大額買單持續進場，短線或有拉升行情'
      : wPat.pattern === 'distribution' ? '⚠️ 偵測到大戶出貨跡象，大額賣單主導，謹防下行風險'
      : wPat.pattern === 'light_buy'    ? '🔍 溫和吸籌，資金緩步流入，暫無強烈信號'
      : wPat.pattern === 'light_sell'   ? '🔍 溫和出貨，資金緩步流出，注意壓力'
      : '多空均衡，大戶無明確方向';
    whaleHtml = `<div class="vp-whale-section">
      <div class="vp-sub-title">🐋 巨鯨進退場偵測</div>
      <div class="vp-whale-pattern" style="color:${wPat.color}">
        <span class="vp-whale-label">${wPat.label}</span>
        <div class="vp-whale-bar-wrap"><div class="vp-whale-bar" style="width:${wPat.strength}%;background:${wPat.color}"></div></div>
        <span class="vp-whale-pct">${wPat.strength}%</span>
      </div>
      <div class="vp-whale-stats">
        <span class="vp-chip" style="color:var(--bull)">買單 ${wPat.buyPct.toFixed(1)}%（${wPat.bigBuyCount}筆）</span>
        <span class="vp-chip" style="color:var(--bear)">賣單 ${wPat.sellPct}%（${wPat.bigSellCount}筆）</span>
        <span class="vp-chip" style="color:${wPat.netFlow > 0 ? 'var(--bull)' : 'var(--bear)'}">淨${netDir} $${netM}M</span>
      </div>
      <div class="vp-ai-narr ${narrCls}" style="${!narrCls ? 'color:var(--text3)' : ''}">${narr}</div>
    </div>`;
  } else {
    whaleHtml = `<div class="vp-whale-section">
      <div class="vp-sub-title">🐋 巨鯨進退場偵測</div>
      <div style="color:var(--text3);font-size:0.8rem;padding:4px 0">大額交易數據不足，無法判斷</div>
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
  if (rsi > 70 && adx > 30)              p4 = `⚠️ <strong>操作建議</strong>：RSI 超買（${rsi}）且趨勢強勁（ADX ${adx}），不宜追高，等待回調至 EMA20（${fmtPrice(coin.ema20)}）附近再考慮介入，設置嚴格止損。`;
  else if (rsi < 30 && adx > 25)         p4 = `💡 <strong>操作建議</strong>：RSI 超賣（${rsi}），若出現帶量反彈K棒可輕倉試多，止損設於近期低點下方。`;
  else if (bullTFs.length > bearTFs.length && adx > 22) p4 = `✅ <strong>操作建議</strong>：多頭趨勢中（ADX ${adx}），可在回撤至 EMA20（${fmtPrice(coin.ema20)}）附近結合訂單流確認後介入，風險收益比較佳。`;
  else if (bearTFs.length > bullTFs.length && adx > 22) p4 = `📉 <strong>操作建議</strong>：空頭趨勢中（ADX ${adx}），避免逆勢做多，等待 RSI 底部背離或帶量止跌K棒信號出現後再考慮布局。`;
  else                                    p4 = `🔄 <strong>操作建議</strong>：市場震盪（ADX ${adx}），建議降低倉位，等待帶量突破關鍵${h1Swing ? `高點（${fmtPrice(h1Swing)}）或低點（${fmtPrice(h1Low)}）` : 'K棒高低點'}後再行跟進。`;

  return `<div class="ai-analysis-body">
    <div class="ai-para">${p1}</div>
    ${p2 ? `<div class="ai-para">${p2}</div>` : ''}
    ${p3 ? `<div class="ai-para">${p3}</div>` : ''}
    <div class="ai-para">${p4}</div>
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

  // 緩存宏觀數據供 Telegram 通知使用
  if (globalMkt || fearGreed) _macroCache = { ...(globalMkt || {}), fg: fearGreed };

  const set = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };

  set('macro-body',     buildMacroPanel(globalMkt, halving, fearGreed));
  set('deriv-body',     buildDerivativesPanel(deriv));
  set('setup-body',     buildTradeSetup(coin, mtfData, deriv, globalMkt, whale, fearGreed));
  set('mtf-body',       buildMTFTable(mtfData));
  set('of-body',        buildOrderFlowPanel(coin, mtfData['15m']?.orderFlow || null));
  set('ai-body',        generateAIAnalysis(coin, mtfData, fearGreed));
  set('vp-body',        buildVPPanel(coin, mtfData, whale));
  set('situation-body', buildSituationSummary(coin, mtfData, deriv, fearGreed, globalMkt, whale));
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
  container.innerHTML = '';

  const tvSymbol = 'BINANCE:' + symbol.replace('/','');

  if (typeof TradingView !== 'undefined') {
    try {
      state.tvWidget = new TradingView.widget({
        container_id: 'tv-chart-container',
        width:    '100%',
        height:   700,
        symbol:   tvSymbol,
        interval: interval || '15',
        timezone: 'Asia/Shanghai',
        theme:    'dark',
        style:    '1',
        locale:   'zh_CN',
        toolbar_bg: '#0d1017',
        enable_publishing:    false,
        allow_symbol_change:  true,
        hide_top_toolbar:     false,
        hide_side_toolbar:    false,
        withdateranges:       true,
        save_image:           false,
        studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
        overrides: {
          'paneProperties.background':                    '#0d1017',
          'paneProperties.backgroundType':                'solid',
          'scalesProperties.textColor':                   '#94a3b8',
          'mainSeriesProperties.candleStyle.upColor':     '#00e676',
          'mainSeriesProperties.candleStyle.downColor':   '#ff1744',
          'mainSeriesProperties.candleStyle.borderUpColor':   '#00e676',
          'mainSeriesProperties.candleStyle.borderDownColor': '#ff1744',
          'mainSeriesProperties.candleStyle.wickUpColor':     '#00e676',
          'mainSeriesProperties.candleStyle.wickDownColor':   '#ff1744',
        },
      });
    } catch(e) { renderFallbackChart(container, symbol); }
  } else {
    renderFallbackChart(container, symbol);
  }
}

function renderFallbackChart(container, symbol) {
  const base = symbol.replace('/USDT','');
  container.innerHTML = `
    <div style="height:500px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--text3)">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      <div style="text-align:center">
        <div style="font-size:0.95rem;font-weight:600;color:var(--text2);margin-bottom:6px">图表暂不可用</div>
        <div style="font-size:0.8rem">TradingView 脚本未加载，请检查网络连接</div>
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${base}USDT"
           target="_blank" rel="noopener"
           style="display:inline-block;margin-top:14px;padding:8px 18px;background:var(--blue-dim);color:var(--blue);
                  border:1px solid rgba(0,212,255,0.3);border-radius:8px;font-size:0.85rem;font-weight:600;">
          在 TradingView 中打开 ↗
        </a>
      </div>
    </div>
  `;
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

function removePairFromList(symbol) {
  removePairBySymbol(symbol);
  renderPairsList();
  showToast(`已移除 ${symbol}`, 'info');
  triggerRescan();
}

function resetCustomPairs() {
  resetToDefaultPairs();
  renderPairsList();
  showToast('已重置為默認幣種清單', 'info');
  triggerRescan();
}

function clearAllPairs() {
  if (!confirm('確定要清空所有追蹤幣種嗎？清空後需手動重新添加。')) return;
  savePairs([]);
  renderPairsList();
  showToast('已清空所有幣種', 'info');
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

function loadTradeLog() { return JSON.parse(localStorage.getItem(TRADE_LOG_KEY) || '[]'); }
function saveTradeLog(log) { localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(log)); }

/* 判斷是否在冷卻期（防止同一進場機會被重複記錄）*/
function inCooldown(tlog, symbol, direction) {
  const now = Date.now();
  const sameDir = tlog.some(t =>
    t.symbol === symbol &&
    t.direction === direction &&
    (now - (t.timestamp || 0)) < SIGNAL_COOLDOWN
  );
  // Prevent opposite-direction open trades for same symbol
  const anyOpen = tlog.some(t => t.symbol === symbol && t.status === 'open');
  return sameDir || anyOpen;
}

/* ── 從掃描數據自動記錄交易信號 ──────────────────────────────── */
function recordSignalsFromScan(data) {
  const tlog = loadTradeLog();
  let changed = false;
  for (const coin of data) {
    const isLong  = coin.score >= 60 && (coin.trend === '強勢看漲' || coin.trend === '看漲');
    const isShort = coin.score <= 40 && (coin.trend === '強勢看跌' || coin.trend === '看跌');
    if (!isLong && !isShort) continue;
    const direction = isLong ? 'long' : 'short';
    // conf：多頭用評分，空頭用反向評分（100 - score）
    const conf = Math.min(90, isLong ? coin.score : 100 - coin.score);
    if (conf < 60) continue; // 信號強度不足，不記錄
    const hasOpen = tlog.some(t => t.symbol === coin.symbol && t.status === 'open');
    if (hasOpen) continue;
    if (inCooldown(tlog, coin.symbol, direction)) continue;
    const setup = computeSimpleSetup(coin, isLong);
    tlog.unshift({
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
      conf,
      status: 'open', outcome: null, tp1Hit: false,
      exitPrice: null, exitTime: null, pnlR: null, analysis: null,
      refined: false,
    });
    changed = true;
  }
  if (changed) {
    if (tlog.length > 500) tlog.splice(500);
    saveTradeLog(tlog);
  }
}
function updateOpenTrades(data) {
  const tlog = loadTradeLog();
  let changed = false;
  const tp1Hits = []; // trades that just reached TP1 this cycle
  for (const trade of tlog) {
    if (trade.status !== 'open') continue;
    const coin = data.find(d => d.symbol === trade.symbol);
    if (!coin) continue;
    const cur = parseFloat(coin.price) || 0;
    if (!cur) continue;
    const { entry, sl, tp1, tp2, direction } = trade;
    const risk = Math.abs(entry - sl) || 1;
    const isLong = direction === 'long';
    let outcome = null;
    if (isLong) {
      if (cur >= tp2) {
        outcome = 'tp2';
      } else if (cur >= tp1 && !trade.tp1Hit) {
        trade.tp1Hit = true; changed = true;
        tp1Hits.push({ trade, coin, cur });
      } else if (cur <= sl) {
        outcome = trade.tp1Hit ? 'be' : 'sl';
      }
    } else {
      if (cur <= tp2) {
        outcome = 'tp2';
      } else if (cur <= tp1 && !trade.tp1Hit) {
        trade.tp1Hit = true; changed = true;
        tp1Hits.push({ trade, coin, cur });
      } else if (cur >= sl) {
        outcome = trade.tp1Hit ? 'be' : 'sl';
      }
    }
    if (outcome) {
      trade.status   = 'closed';
      trade.outcome  = outcome;
      trade.exitTime = Date.now();
      if (outcome === 'tp2') {
        trade.exitPrice = tp2;
        trade.pnlR = ((Math.abs(tp2 - entry) / risk)).toFixed(2);
      } else if (outcome === 'tp1') {
        trade.exitPrice = tp1;
        trade.pnlR = ((Math.abs(tp1 - entry) / risk)).toFixed(2);
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
    }
  }
  if (changed) { saveTradeLog(tlog); invalidateLearnCache(); }
  if (tp1Hits.length > 0) sendTP1Notifications(tp1Hits);
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
        `${dir} | 進場 $${trade.entry} → TP1 $${trade.tp1} | R/R ${rr}:1`,
        `tp1-${trade.id}`
      );
    }
    if (s.notifTelegram && s.tgToken && s.tgChatId) {
      const fmt = v => parseFloat(v).toPrecision(6).replace(/\.?0+$/, '');
      const msg =
        `🎯 <b>止盈一已達到！</b>\n\n` +
        `💎 <b>${trade.symbol}</b>  ${trade.direction === 'long' ? '▲ 做多' : '▼ 做空'}\n\n` +
        `✅ 止盈一：<b>$${fmt(trade.tp1)}</b>\n` +
        `📍 進場價：$${fmt(trade.entry)}\n` +
        `💰 現價：$${fmt(cur)}\n` +
        `📊 獲利幅度：<b>+${rr}R</b>\n\n` +
        `🔔 建議：移動止損至成本價 <b>$${fmt(trade.entry)}</b>，持倉等待止盈二 $${fmt(trade.tp2)}`;
      const siteUrl = window.location.origin + window.location.pathname;
      msg += `\n\n🔗 <a href="${siteUrl}">查看 ${trade.symbol.replace('/USDT','').replace('USDT','')} 詳細分析 →</a>`;
      sendTelegramMessage(s.tgToken, s.tgChatId, msg);
    }
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
    _learnCache = computeLearnProfile();
    // 若現有交易不足，仍嘗試載入記憶中的規則
    if (!_learnCache.ready) {
      const mem = loadAIMemory();
      const memRules = Object.values(mem.rules).filter(r => r.active || r.occurrences >= 2);
      if (memRules.length > 0) {
        _learnCache = { ..._learnCache, ready: true, fromMemory: true, rules: memRules, mem, bestConditions: mem.bestConditions || [] };
      }
    }
  }
  return _learnCache;
}

function applyLearnAdjustment(direction, rsi, adx, ctx = {}) {
  const profile = getLearnProfile();
  if (!profile.ready || !profile.rules.length) return { penalty: 0, warnings: [] };
  let penalty = 0;
  const warnings = [];
  for (const rule of profile.rules) {
    const match =
      (rule.condition === 'long_high_rsi'       && direction === 'long'  && rsi > 65) ||
      (rule.condition === 'short_low_rsi'        && direction === 'short' && rsi < 35) ||
      (rule.condition === 'low_adx'              && adx < 20) ||
      (rule.condition === 'long_high_score_rsi'  && direction === 'long'  && rsi > 72) ||
      (rule.condition === 'short_oversold'       && direction === 'short' && rsi < 28) ||
      (rule.condition === 'long_below_poc'       && direction === 'long'  && ctx.abovePOC === false) ||
      (rule.condition === 'short_above_poc'      && direction === 'short' && ctx.abovePOC === true) ||
      (rule.condition === 'whale_against_long'   && direction === 'long'  && ctx.whaleBias === 'bear') ||
      (rule.condition === 'whale_against_short'  && direction === 'short' && ctx.whaleBias === 'bull') ||
      (rule.condition === 'bearish_div_long'     && direction === 'long'  && ctx.volDivergence === 'bearish_div') ||
      (rule.condition === 'low_mtf_align'        && (ctx.mtfAlign ?? 99) <= 1);
    if (match) { penalty += rule.penaltyConf; warnings.push(rule.warning); }
  }
  return { penalty, warnings };
}

/* ── 止損/保本交易學習分析 ────────────────────────────────────── */
function generateTradeAnalysis(trade) {
  const issues = [], suggestions = [];
  const isLong = trade.direction === 'long';
  if (isLong) {
    if (trade.rsi > 60) {
      issues.push(`RSI 進場時 ${trade.rsi} 偏高，多頭追入有回調風險`);
      suggestions.push('下次等 RSI 回落至 50 以下再考慮多頭進場');
    }
    if (trade.adx < 20) {
      issues.push(`ADX ${trade.adx} 過低，趨勢不明確`);
      suggestions.push('確保 ADX > 20 再進場，避免震盪市追多');
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
      issues.push(`ADX ${trade.adx} 過低，趨勢不明確`);
      suggestions.push('確保 ADX > 20 再進場，避免震盪市追空');
    }
    if (trade.score > 35) {
      issues.push(`評分 ${trade.score} 偏高，空頭信號強度有限`);
      suggestions.push('空頭信號需評分 35 以下再操作');
    }
  }
  // VP 位置問題
  if (trade.entryAbovePOC === false && isLong) {
    issues.push('做多入場在籌碼密集區(POC)下方，上方賣壓較重');
    suggestions.push('做多時確保現價突破 POC 站穩，等待籌碼轉換後再進場');
  }
  if (trade.entryAbovePOC === true && !isLong) {
    issues.push('做空入場在籌碼密集區(POC)上方，下方承接較強');
    suggestions.push('做空時確保現價跌破 POC 且無強力承接，再考慮入場');
  }
  // 巨鯨方向問題
  if (trade.entryWhaleBias === 'bear' && isLong) {
    issues.push('入場時巨鯨主力資金偏向賣出，與做多方向相反');
    suggestions.push('機構資金方向比技術信號更優先，巨鯨看空時避免做多');
  }
  if (trade.entryWhaleBias === 'bull' && !isLong) {
    issues.push('入場時巨鯨主力資金偏向買入，與做空方向相反');
    suggestions.push('機構資金方向比技術信號更優先，巨鯨看多時避免做空');
  }
  // 成交量背離
  if (trade.entryVolDivergence === 'bearish_div' && isLong) {
    issues.push('入場時出現成交量看跌背離（量跌價漲），上漲動能不足');
    suggestions.push('量價背離時謹慎追多，等待量能重新放大再確認方向');
  }
  // 多週期未共振
  if ((trade.entryMTFAlign || 0) <= 1 && trade.entryMTFAlign != null) {
    issues.push(`僅 ${trade.entryMTFAlign} 個週期方向對齊，多空信號分歧較大`);
    suggestions.push('等待至少 2-3 個週期（15m、1h、4h）信號一致再入場');
  }
  if (issues.length === 0) {
    issues.push('技術指標條件尚可，可能受宏觀或突發新聞影響');
    suggestions.push('建議同步確認宏觀市場環境再入場');
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
function renderPositionsPage() {
  const container = document.getElementById('positions-content');
  if (!container) return;

  const open = loadTradeLog().filter(t => t.status === 'open' && t.entry);
  if (open.length === 0) {
    container.innerHTML = `
      <div class="page-header"><div>
        <h1 class="page-title">持倉中</h1>
        <p class="page-subtitle">目前進行中的交易推薦</p>
      </div></div>
      <div class="pos-empty">目前沒有進行中的交易推薦<br><span style="font-size:0.83rem;color:var(--text3)">掃描到評分 60 以上（做多）或 40 以下（做空）的訊號時會自動出現</span></div>`;
    return;
  }

  // 計算整體未實現統計
  let totalUnrealR = 0, totalRisk = 0, hasPrice = 0;
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
    }

    const conf      = t.conf || Math.min(90, t.score || 60);
    const confClr   = conf >= 70 ? 'var(--bull)' : conf >= 60 ? '#ff6d00' : 'var(--text3)';
    const dirLabel  = isLong ? '▲ 做多' : '▼ 做空';
    const dirColor  = isLong ? 'var(--bull)' : 'var(--bear)';

    // 進度：距離 TP1 / TP2 / SL 的百分比
    let progressHtml = '';
    if (cur && entry && tp1 && sl) {
      const target  = isLong ? tp1 : tp1; // TP1 as first target
      const total   = Math.abs(tp1 - entry);
      const moved   = isLong ? cur - entry : entry - cur;
      const pct     = total > 0 ? Math.max(-100, Math.min(100, moved / total * 100)) : 0;
      const barClr  = pct >= 100 ? '#22c55e' : pct > 0 ? 'var(--bull)' : 'var(--bear)';
      progressHtml = `
        <div class="pos-progress-wrap">
          <div class="pos-progress-labels">
            <span style="color:var(--bear)">SL ${fmtPrice(sl)}</span>
            <span style="color:var(--text3);font-size:0.72rem">進度至止盈一</span>
            <span style="color:var(--bull)">TP1 ${fmtPrice(tp1)}</span>
          </div>
          <div class="pos-progress-bar">
            <div class="pos-progress-fill" style="width:${Math.max(0,pct)}%;background:${barClr}"></div>
          </div>
        </div>`;
    }

    const reasons = (t.entryReason || '').split('，').filter(Boolean);

    return `<div class="pos-card" data-symbol="${t.symbol}" onclick="navigateTo('coin','${t.symbol}')">
      <div class="pos-card-top">
        <div class="pos-symbol">
          <span class="pos-sym-name">${t.symbol.replace('/USDT','')}<span style="color:var(--text3)">/USDT</span></span>
          <span class="pos-dir" style="color:${dirColor}">${dirLabel}</span>
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
        <div class="pos-cell">
          <div class="pos-cell-lbl">止盈一</div>
          <div class="pos-cell-val" style="color:var(--bull)">${fmtPrice(tp1)}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${entry&&tp1 ? ((isLong?tp1-entry:entry-tp1)/entry*100).toFixed(2)+'%' : ''}</span></div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">止盈二</div>
          <div class="pos-cell-val" style="color:#22c55e">${fmtPrice(tp2)}<span style="font-size:0.7rem;color:var(--text3);margin-left:3px">${entry&&tp2 ? ((isLong?tp2-entry:entry-tp2)/entry*100).toFixed(2)+'%' : ''}</span></div>
        </div>
        <div class="pos-cell">
          <div class="pos-cell-lbl">信號強度</div>
          <div class="pos-cell-val" style="color:${confClr}">${conf}%</div>
        </div>
      </div>

      ${progressHtml}

      <div class="pos-reasons">
        <div class="pos-reasons-lbl">📍 進場理由</div>
        ${reasons.length ? reasons.map(r => `<span class="pos-reason-chip">${r}</span>`).join('') : '<span style="color:var(--text3);font-size:0.78rem">無詳細原因</span>'}
      </div>

      <div class="pos-footer">
        <span style="color:var(--text3);font-size:0.72rem">進場時間：${fmtDateTime(t.timestamp)} · ${fmtRelTime(t.timestamp)}</span>
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

    <input class="pos-search" id="pos-search-input" placeholder="搜尋幣種..." oninput="filterPositionCards(this.value)">
    <div class="pos-list" id="pos-list-container">${cards}</div>

    <div style="text-align:center;margin-top:16px;font-size:0.75rem;color:var(--text3)">
      點擊任一卡片查看幣種詳情 · 每次掃描自動更新未實現損益
    </div>`;
}

function filterPositionCards(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#pos-list-container .pos-card').forEach(card => {
    const sym = (card.getAttribute('data-symbol') || '').toLowerCase();
    card.style.display = (!q || sym.includes(q)) ? '' : 'none';
  });
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
      const dirHtml = t.direction === 'long'
        ? `<span class="tl-dir-long">▲ 多</span>`
        : `<span class="tl-dir-short">▼ 空</span>`;

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
          <div style="color:var(--text2)">開單 ${fmtDateTime(t.timestamp)}</div>
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
  const confColor = conf >= 70 ? 'var(--bull)' : conf >= 60 ? '#ff6d00' : 'var(--text3)';

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
      <span style="color:var(--text3);font-size:0.78rem">信號強度</span>
      <div class="td-conf-bar"><div style="width:${conf}%;background:${confColor};height:100%;border-radius:4px;transition:width .3s"></div></div>
      <span style="color:${confColor};font-weight:700">${conf}%</span>
    </div>
    <div class="td-grid">
      <div class="td-cell" style="grid-column:span 2">
        <div class="td-cell-lbl">開單時間</div>
        <div class="td-cell-val" style="font-size:0.83rem">${fmtDateTime(trade.timestamp)}</div>
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

    // 信號強度未達 60% → 不通知
    const notifConf = _tradeSetupCache[coin.symbol]?.conf
      ?? loadTradeLog().find(t => t.symbol === coin.symbol && t.direction === dir && t.status === 'open')?.conf
      ?? Math.min(90, isLong ? coin.score : 100 - coin.score);
    if (notifConf < 60) continue;

    if (s.notifBrowser) {
      sendBrowserNotification(
        `${isLong ? '▲ 做多' : '▼ 做空'} 信號：${coin.symbol}`,
        `評分 ${coin.score} | ${coin.trend} | 現價 $${coin.price}`,
        coin.symbol
      );
    }
    if (s.notifTelegram && s.tgToken && s.tgChatId) {
      const setup = _tradeSetupCache[coin.symbol] || computeSimpleSetup(coin, isLong);
      setup.conf = notifConf; // 使用已解析的精確 conf
      sendTelegramMessage(s.tgToken, s.tgChatId,
        buildTelegramText(coin, dir, setup, _macroCache, window.location.origin + window.location.pathname));
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
  const reasons = isLong
    ? [(rsi < 45 ? `RSI ${rsi} 偏低` : ''), '15m/1h 多頭信號確認'].filter(Boolean)
    : [(rsi > 55 ? `RSI ${rsi} 偏高` : ''), '15m/1h 空頭信號確認'].filter(Boolean);
  return {
    entry, sl, tp1, tp2,
    entryReason: reasons.join('，'),
    slReason:  `現價${isLong ? '下' : '上'}方 ${((Math.abs(entry - sl) / price) * 100).toFixed(2)}%，結構止損`,
    tp1Reason: `短線目標 R/R ${(Math.abs(tp1 - entry) / risk).toFixed(1)}:1，到達後減倉 60%`,
    tp2Reason: `波段目標 R/R ${(Math.abs(tp2 - entry) / risk).toFixed(1)}:1，剩餘倉位移至成本`,
    rr1: (Math.abs(tp1 - entry) / risk).toFixed(1),
    rr2: (Math.abs(tp2 - entry) / risk).toFixed(1),
    atr,
    conf: Math.min(90, coin.score || 60),
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

  const apiKey = document.getElementById('s-api-key');
  if (apiKey) apiKey.value = s.apiKey || '';

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
  const apiKey = document.getElementById('s-api-key')?.value?.trim() || '';
  const patch  = {
    timeframe:       document.getElementById('s-timeframe')?.value        || '15m',
    refreshInterval: parseInt(document.getElementById('s-refresh')?.value) || 60,
    darkMode:        document.getElementById('s-dark')?.checked            ?? true,
    reversals:       document.getElementById('s-reversals')?.checked       ?? true,
    apiUrl:          apiRaw.replace('/scan',''),
    apiKey,
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

function toggleKeyVisibility() {
  const input = document.getElementById('s-api-key');
  const icon  = document.getElementById('key-eye-icon');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  } else {
    input.type = 'password';
    icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
}

function resetAllSettings() {
  localStorage.removeItem('csp_settings');
  state.settings = loadSettings();
  populateSettingsPage();
  showToast('设置已重置为默认值', 'info');
}

async function testApiConnection() {
  const dot = document.getElementById('api-dot');
  const txt = document.getElementById('api-status-txt');
  if (!dot || !txt) return;

  dot.className   = 'api-dot checking';
  txt.textContent = '测试中...';

  const url    = document.getElementById('s-api-url')?.value  || 'http://127.0.0.1:8000/scan';
  const apiKey = document.getElementById('s-api-key')?.value  || '';
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: buildHeaders(apiKey),
    });
    if (res.ok) {
      dot.className   = 'api-dot online';
      txt.textContent = '已连接';
      showToast('API 连接成功，密钥验证通过', 'success');
    } else if (res.status === 401 || res.status === 403) {
      dot.className   = 'api-dot offline';
      txt.textContent = '密钥无效';
      showToast(`认证失败（HTTP ${res.status}），请检查 API 密钥`, 'error');
    } else { throw new Error(`HTTP ${res.status}`); }
  } catch(e) {
    dot.className   = 'api-dot offline';
    txt.textContent = '离线';
    showToast(`API 不可用：${e.message}`, 'error');
  }
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
    renderRankingTable(document.getElementById('ranking-search')?.value?.trim()?.toUpperCase() || '');
  } else {
    renderDashboardTables();
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
