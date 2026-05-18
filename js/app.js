/* ==========================================
   STOCK SCANNER PRO - MAIN APPLICATION
   台股/美股技術指標分析
   ========================================== */

const App = (() => {

  // ─── STATE ─────────────────────────────────────────────
  const state = {
    data:          [],
    currentPage:   'dashboard',
    currentTF:     '1D',
    currentMarket: 'TW',
    dashFilter:    'all',
    dashSearch:    '',
    rankFilter:    'all',
    rankSearch:    '',
    sortBullish:   { col: 'score', dir: 'desc' },
    sortBearish:   { col: 'score', dir: 'asc'  },
    sortRanking:   { col: 'score', dir: 'desc' },
    refreshTimer:  null,
    countdown:     null,
    countdownSec:  60,
    settings: {
      timeframe:    '1D',
      refreshMs:    60000,
      apiEndpoint:  '/api/scan',
      darkMode:     true,
      accentColor:  'blue',
      signalAlert:  true,
      reversalAlert: true,
      soundAlert:   false,
    },
    coinDetail: null,
    tvLoaded:   false,
  };

  // ─── COLOUR MAP ────────────────────────────────────────
  const AVATAR_COLORS = [
    ['#00d4ff','#003355'], ['#22c55e','#052e16'], ['#a855f7','#2e1065'],
    ['#f59e0b','#451a03'], ['#ef4444','#450a0a'], ['#06b6d4','#083344'],
    ['#f97316','#431407'], ['#8b5cf6','#1e1b4b'],
  ];

  function avatarColors(sym) {
    let h = 0;
    for (let c of sym) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  // ─── INIT ──────────────────────────────────────────────
  function init() {
    loadSettings();
    bindNav();
    bindGlobalEvents();
    bindMarketTabs();
    navigateTo('dashboard');
    loadData(true);
    startRefresh();
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('ssp_settings') || '{}');
      Object.assign(state.settings, saved);
    } catch {}
    applySettings();
  }

  function applySettings() {
    const s = state.settings;
    state.currentTF = s.timeframe;
    state.countdownSec = s.refreshMs / 1000;
    trySet('settingTimeframe', s.timeframe);
    trySet('settingRefresh', s.refreshMs);
    trySet('settingApi', s.apiEndpoint);
    tryCheck('settingDarkMode', s.darkMode);
    tryCheck('settingSignalAlert', s.signalAlert);
    tryCheck('settingReversalAlert', s.reversalAlert);
    tryCheck('settingSoundAlert', s.soundAlert);
  }

  function trySet(id, val)   { const el = document.getElementById(id); if (el) el.value = val; }
  function tryCheck(id, val) { const el = document.getElementById(id); if (el) el.checked = val; }

  // ─── MARKET TABS ───────────────────────────────────────
  function bindMarketTabs() {
    document.getElementById('marketTabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.market-tab');
      if (!btn) return;
      const m = btn.dataset.market;
      if (!m) return;
      document.querySelectorAll('.market-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentMarket = m;
      loadData(false);
    });
  }

  // ─── DATA LOADING ──────────────────────────────────────
  async function loadData(initial = false) {
    if (initial) showLoader(true);
    rotateRefreshIcon(true);

    const endpoint = state.settings.apiEndpoint;
    let data = await API.fetchData(endpoint, state.currentMarket, state.currentTF);
    const usingMock = !data;
    if (!data) data = API.generateMockData(state.currentMarket, state.currentTF);

    state.data = data;
    render();

    if (initial) {
      setTimeout(() => showLoader(false), 800);
    }
    rotateRefreshIcon(false);
    updateLastUpdated();
    checkAlerts(data, usingMock);
  }

  function checkAlerts(data, usingMock) {
    const strongBuy  = data.filter(d => d.signal === '強力買進').length;
    const strongSell = data.filter(d => d.signal === '強力賣出').length;
    if (!usingMock && state.settings.signalAlert) {
      if (strongBuy  > 5) showToast(`${strongBuy} 支股票出現強力買進訊號`, 'success');
      if (strongSell > 5) showToast(`${strongSell} 支股票出現強力賣出訊號`, 'error');
    }
  }

  // ─── RENDERING ─────────────────────────────────────────
  function render() {
    renderOverviewCards();
    if (state.currentPage === 'dashboard') renderDashboard();
    if (state.currentPage === 'ranking')   renderRanking();
  }

  function getFiltered(filter, search, data) {
    let d = [...data];
    if (filter && filter !== 'all') d = d.filter(c => c.signal === filter);
    if (search) {
      const q = search.trim().toUpperCase();
      d = d.filter(c =>
        c.sym.toUpperCase().includes(q) ||
        (c.name && c.name.includes(search.trim()))
      );
    }
    return d;
  }

  // ─── OVERVIEW CARDS ────────────────────────────────────
  function renderOverviewCards() {
    const d     = state.data;
    const total   = d.length;
    const buyCount  = d.filter(c => c.signal === '買進' || c.signal === '強力買進').length;
    const sellCount = d.filter(c => c.signal === '賣出' || c.signal === '強力賣出').length;
    const neutral   = d.filter(c => c.signal === '觀望').length;

    setText('totalCount',   total);
    setText('bullishCount', buyCount);
    setText('bearishCount', sellCount);
    setText('neutralCount', neutral);

    const bar = (id, count, color) => {
      const el = document.getElementById(id);
      if (el && total > 0) { el.style.width = (count / total * 100) + '%'; el.style.color = color; }
    };
    bar('bullishBar', buyCount,  'var(--red)');
    bar('bearishBar', sellCount, 'var(--green)');
    bar('neutralBar', neutral,   'var(--yellow)');

    // Update subtitle
    const marketLabel = state.currentMarket === 'TW' ? '台股' : state.currentMarket === 'US' ? '美股' : '台股與美股';
    setText('dashboardSubtitle', `已掃描 ${total} 支${marketLabel}股票`);
  }

  function updateLastUpdated() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setText('lastUpdated', timeStr);
  }

  // ─── DASHBOARD ─────────────────────────────────────────
  function renderDashboard() {
    const d        = state.data;
    const filtered = getFiltered(state.dashFilter, state.dashSearch, d);

    const bullish = filtered
      .filter(c => c.signal === '強力買進' || c.signal === '買進')
      .sort((a, b) => b.score - a.score);

    const bearish = filtered
      .filter(c => c.signal === '強力賣出' || c.signal === '賣出')
      .sort((a, b) => a.score - b.score);

    setText('bullishBadge', bullish.length);
    setText('bearishBadge', bearish.length);

    renderTable('bullishTbody', sortData(bullish, state.sortBullish), 'bullish');
    renderTable('bearishTbody', sortData(bearish, state.sortBearish), 'bearish');
    renderReversals(filtered);
  }

  function sortData(data, { col, dir }) {
    return [...data].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (dir === 'asc') return av - bv;
      return bv - av;
    });
  }

  function renderTable(tbodyId, rows, tableKey) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading-cell" style="color:var(--text-muted);font-size:0.82rem;">找不到符合條件的股票</td></tr>';
      return;
    }

    const top = rows.slice(0, 15);
    tbody.innerHTML = top.map((c, i) => `
      <tr onclick="App.openCoin('${c.sym}')">
        <td><span class="rank-num">${i + 1}</span></td>
        <td>${coinCell(c)}</td>
        <td>${scoreCell(c)}</td>
        <td>${signalBadge(c.signal)}</td>
        <td class="price-cell">${priceCell(c)}</td>
        <td>${rsiCell(c.rsi)}</td>
        <td><span class="rank-num" style="color:${c.adx > 25 ? 'var(--accent)' : 'var(--text-muted)'}">${c.adx}</span></td>
        <td>${volBadge(c.volumeStr)}</td>
      </tr>`).join('');
  }

  // ─── RANKING PAGE ──────────────────────────────────────
  function renderRanking() {
    const filtered = getFiltered(state.rankFilter, state.rankSearch, state.data);
    const sorted   = sortData(filtered, state.sortRanking);
    const tbody    = document.getElementById('rankingTbody');
    const footer   = document.getElementById('rankingFooter');

    if (!tbody) return;

    if (!sorted.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading-cell" style="color:var(--text-muted)">找不到結果</td></tr>';
      return;
    }

    tbody.innerHTML = sorted.map((c, i) => `
      <tr onclick="App.openCoin('${c.sym}')">
        <td><span class="rank-num">${i + 1}</span></td>
        <td>${coinCell(c)}</td>
        <td class="price-cell">${priceCell(c)}</td>
        <td>${signalBadge(c.signal)}</td>
        <td>${scoreCell(c)}</td>
        <td>${rsiCell(c.rsi)}</td>
        <td>${volBadge(c.volumeStr)}</td>
        <td><span style="font-family:var(--font-mono);color:${c.adx > 25 ? 'var(--accent)' : 'var(--text-muted)'}">${c.adx}</span></td>
      </tr>`).join('');

    if (footer) {
      const marketLabel = state.currentMarket === 'TW' ? '台股' : state.currentMarket === 'US' ? '美股' : '全部';
      footer.textContent = `顯示 ${sorted.length} / ${state.data.length} 支股票（${marketLabel}）`;
    }
  }

  // ─── REVERSAL DETECTION ────────────────────────────────
  function renderReversals(data) {
    const reversals = data.filter(c => {
      const rsiOversold   = c.rsi < 32 && (c.signal === '賣出' || c.signal === '強力賣出');
      const rsiOverbought = c.rsi > 68 && (c.signal === '買進' || c.signal === '強力買進');
      return rsiOversold || rsiOverbought;
    }).slice(0, 20);

    setText('reversalBadge', reversals.length);
    const grid = document.getElementById('reversalGrid');
    if (!grid) return;

    if (!reversals.length) {
      grid.innerHTML = '<div class="reversal-empty"><i class="fas fa-check-circle" style="color:var(--green)"></i> <span>目前沒有偵測到反轉訊號</span></div>';
      return;
    }

    grid.innerHTML = reversals.map(c => {
      const isBullRev = c.rsi < 32;
      const cls   = isBullRev ? 'reversal-bullish-rev' : 'reversal-bearish-rev';
      const icon  = isBullRev ? '↑' : '↓';
      const label = isBullRev ? '超賣反彈' : '超買回調';
      const col   = isBullRev ? 'var(--red)' : 'var(--green)';
      return `
        <div class="reversal-item ${cls}" onclick="App.openCoin('${c.sym}')">
          <div class="rev-header">
            <span class="rev-sym">${c.sym}</span>
            ${signalBadge(c.signal)}
          </div>
          <div class="rev-price">${c.priceStr}</div>
          <div class="rev-signal" style="color:${col}">${icon} ${label}</div>
          <div class="rev-stats">
            <div class="rev-stat">RSI <span style="color:${col}">${c.rsi}</span></div>
            <div class="rev-stat">ADX <span>${c.adx}</span></div>
            <div class="rev-stat">分數 <span>${c.score}</span></div>
            <div class="rev-stat">成交量 <span>${c.volumeStr}</span></div>
          </div>
        </div>`;
    }).join('');
  }

  // ─── STOCK DETAIL ──────────────────────────────────────
  function renderStockDetail(sym) {
    const coin = state.data.find(c => c.sym === sym);
    if (!coin) { navigateTo('dashboard'); return; }
    state.coinDetail = coin;

    const [fg, bg] = avatarColors(sym);

    // Taiwan: red = up, green = down
    const changeVal  = parseFloat(coin.change1d);
    const isUp       = changeVal >= 0;
    const changeColor = isUp ? 'var(--red)' : 'var(--green)';
    const changeIcon  = isUp ? 'fa-arrow-up' : 'fa-arrow-down';

    const ma20Above  = coin.price > coin.ma20;
    const ma50Above  = coin.price > coin.ma50;
    const ma200Above = coin.price > coin.ma200;

    // Risk level
    let riskLevel, riskClass, riskIcon, riskDesc;
    if (coin.adx > 35 && (coin.rsi > 70 || coin.rsi < 30)) {
      riskLevel = '高風險';  riskClass = 'risk-high';
      riskIcon  = '⚠️'; riskDesc = '強勁動能加上極端RSI — 波動劇烈，需謹慎操作';
    } else if (coin.adx > 20) {
      riskLevel = '中等風險'; riskClass = 'risk-medium';
      riskIcon  = '⚡'; riskDesc = '趨勢活躍，動能中等';
    } else {
      riskLevel = '低風險'; riskClass = 'risk-low';
      riskIcon  = '✅'; riskDesc = '趨勢偏弱 — 盤整震盪階段';
    }

    // Support & Resistance
    const res1 = coin.price * (1 + randLocal(0.03, 0.07));
    const res2 = coin.price * (1 + randLocal(0.08, 0.15));
    const sup1 = coin.price * (1 - randLocal(0.03, 0.07));
    const sup2 = coin.price * (1 - randLocal(0.08, 0.15));

    const trendNarrative = buildTrendNarrative(coin, ma20Above, ma50Above, ma200Above);
    const marketLabel = coin.market === 'TW' ? '台灣證交所' : '美國股市';
    const exchangeInfo = coin.market === 'TW' ? `TWSE • ${state.currentTF}` : `NYSE/NASDAQ • ${state.currentTF}`;

    const content = `
      <!-- Hero -->
      <div class="glass-card coin-hero" style="margin-bottom:16px;">
        <div class="coin-hero-avatar" style="background:${bg};color:${fg};border-color:${fg}44">
          ${sym.substring(0, 4)}
        </div>
        <div class="coin-hero-info">
          <div class="coin-name">${sym}
            <span style="color:var(--text-muted);font-size:1rem;font-weight:400;margin-left:6px">${coin.name}</span>
          </div>
          <div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${signalBadge(coin.signal)}
            <span class="market-badge market-badge-${coin.market}">${coin.market}</span>
            <span style="font-size:0.75rem;color:var(--text-muted)">分數: <b style="color:var(--text-primary);font-family:var(--font-mono)">${coin.score}/100</b></span>
          </div>
        </div>
        <div class="coin-hero-price">
          <div class="price-big">${coin.priceStr}</div>
          <div style="margin-top:4px;font-size:0.82rem;color:${changeColor};font-family:var(--font-mono)">
            <i class="fas ${changeIcon}"></i> ${Math.abs(changeVal)}%
          </div>
          <div class="price-sub">今日漲跌</div>
        </div>
      </div>

      <!-- TradingView Chart -->
      <div class="glass-card chart-card">
        <div class="card-header">
          <div class="card-title-row">
            <i class="fas fa-chart-candlestick" style="color:var(--accent)"></i>
            <h2>K線圖</h2>
          </div>
          <span style="font-size:0.78rem;color:var(--text-muted)">TradingView • ${exchangeInfo}</span>
        </div>
        <div class="chart-wrap">
          <div id="tv_widget_${sym}" class="tv-widget-container"></div>
        </div>
      </div>

      <!-- Key Stats -->
      <div class="coin-stats-grid">
        <div class="stat-card">
          <div class="stat-label">RSI (14)</div>
          <div class="stat-value" style="color:${coin.rsi > 70 ? 'var(--red)' : coin.rsi < 30 ? 'var(--green)' : 'var(--text-primary)'}">${coin.rsi}</div>
          <div class="stat-sub">${coin.rsi > 70 ? '超買區間' : coin.rsi < 30 ? '超賣區間' : '正常區間'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">ADX (14)</div>
          <div class="stat-value" style="color:${coin.adx > 25 ? 'var(--accent)' : 'var(--text-muted)'}">${coin.adx}</div>
          <div class="stat-sub">${coin.adx > 40 ? '趨勢極強' : coin.adx > 25 ? '趨勢明顯' : coin.adx > 15 ? '趨勢偏弱' : '盤整整理'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">技術分數</div>
          <div class="stat-value" style="color:${scoreColor(coin.score)}">${coin.score}<span style="font-size:0.9rem;color:var(--text-muted)">/100</span></div>
          <div class="stat-sub">${coin.signal}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">成交量強度</div>
          <div class="stat-value" style="color:${coin.volumeStr === '高' ? 'var(--accent)' : coin.volumeStr === '中' ? 'var(--yellow)' : 'var(--text-muted)'}">
            ${coin.volumeStr}
          </div>
          <div class="stat-sub">相對成交量: ${coin.volume}/100</div>
        </div>
      </div>

      <!-- Analysis Cards -->
      <div class="coin-analysis-grid">

        <!-- Trend Analysis -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-chart-line" style="color:var(--accent)"></i> 趨勢分析
          </div>
          ${trendNarrative}
        </div>

        <!-- MA Analysis -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-wave-square" style="color:var(--purple)"></i> 移動平均線
          </div>
          <div class="ema-row">
            <span class="ema-label">MA 20</span>
            <span class="ema-value">${API.formatPrice(coin.ma20, coin.market)}</span>
            <span class="ema-status ${ma20Above ? 'ema-above' : 'ema-below'}">${ma20Above ? '站上' : '跌破'}</span>
          </div>
          <div class="ema-row">
            <span class="ema-label">MA 50</span>
            <span class="ema-value">${API.formatPrice(coin.ma50, coin.market)}</span>
            <span class="ema-status ${ma50Above ? 'ema-above' : 'ema-below'}">${ma50Above ? '站上' : '跌破'}</span>
          </div>
          <div class="ema-row">
            <span class="ema-label">MA 200</span>
            <span class="ema-value">${API.formatPrice(coin.ma200, coin.market)}</span>
            <span class="ema-status ${ma200Above ? 'ema-above' : 'ema-below'}">${ma200Above ? '站上' : '跌破'}</span>
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-size:0.78rem;color:var(--text-muted);">
            ${ma20Above && ma50Above && ma200Above
              ? '<span style="color:var(--red)">✓ 股價站上所有均線 — 多頭排列</span>'
              : !ma20Above && !ma50Above && !ma200Above
              ? '<span style="color:var(--green)">✗ 股價跌破所有均線 — 空頭排列</span>'
              : '<span style="color:var(--yellow)">⚡ 均線結構混亂 — 整理盤整階段</span>'}
          </div>
        </div>

        <!-- Support & Resistance -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-layer-group" style="color:var(--yellow)"></i> 支撐與壓力
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">壓力2</span><span class="sr-val" style="color:var(--red)">${API.formatPrice(res2, coin.market)}</span></div>
            <div class="sr-bar" style="background:rgba(239,68,68,0.15);width:85%"></div>
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">壓力1</span><span class="sr-val" style="color:var(--red)">${API.formatPrice(res1, coin.market)}</span></div>
            <div class="sr-bar" style="background:rgba(239,68,68,0.25);width:60%"></div>
          </div>
          <div class="sr-item" style="padding:8px;background:var(--accent-dim);border-radius:6px;border:1px solid var(--border)">
            <div class="sr-level"><span class="sr-label" style="color:var(--accent)">現價</span><span class="sr-val" style="color:var(--accent)">${coin.priceStr}</span></div>
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">支撐1</span><span class="sr-val" style="color:var(--green)">${API.formatPrice(sup1, coin.market)}</span></div>
            <div class="sr-bar" style="background:rgba(34,197,94,0.25);width:65%"></div>
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">支撐2</span><span class="sr-val" style="color:var(--green)">${API.formatPrice(sup2, coin.market)}</span></div>
            <div class="sr-bar" style="background:rgba(34,197,94,0.15);width:40%"></div>
          </div>
        </div>

        <!-- Momentum Analysis -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-gauge-high" style="color:var(--green)"></i> 動能分析
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">RSI (14)</span>
              <span class="mom-val" style="color:${coin.rsi > 70 ? 'var(--red)' : coin.rsi < 30 ? 'var(--green)' : 'var(--accent)'}">${coin.rsi}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${coin.rsi}%;background:${coin.rsi > 70 ? 'var(--red)' : coin.rsi < 30 ? 'var(--green)' : 'var(--accent)'}"></div></div>
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">ADX 趨勢強度</span>
              <span class="mom-val" style="color:var(--accent)">${coin.adx}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${Math.min(coin.adx, 100)}%;background:var(--accent)"></div></div>
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">技術分數</span>
              <span class="mom-val" style="color:${scoreColor(coin.score)}">${coin.score}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${coin.score}%;background:${scoreColor(coin.score)}"></div></div>
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">成交量強度</span>
              <span class="mom-val" style="color:var(--yellow)">${coin.volume}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${coin.volume}%;background:var(--yellow)"></div></div>
          </div>
        </div>

        <!-- Market Strength (full width) -->
        <div class="analysis-card" style="grid-column:1/-1">
          <div class="analysis-card-title">
            <i class="fas fa-signal" style="color:var(--yellow)"></i> 市場強弱
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
            ${strengthMetric('趨勢強度', coin.adx > 25 ? '強' : coin.adx > 15 ? '中等' : '弱', coin.adx > 25 ? 'var(--green)' : coin.adx > 15 ? 'var(--yellow)' : 'var(--red)')}
            ${strengthMetric('買盤壓力', coin.score > 60 ? '強' : coin.score > 40 ? '中' : '弱', coin.score > 60 ? 'var(--green)' : coin.score > 40 ? 'var(--yellow)' : 'var(--red)')}
            ${strengthMetric('成交量', coin.volumeStr, coin.volumeStr === '高' ? 'var(--accent)' : coin.volumeStr === '中' ? 'var(--yellow)' : 'var(--text-muted)')}
            ${strengthMetric('均線排列', ma20Above && ma50Above && ma200Above ? '多頭' : !ma20Above && !ma50Above && !ma200Above ? '空頭' : '混合', ma20Above && ma50Above && ma200Above ? 'var(--red)' : !ma20Above && !ma50Above && !ma200Above ? 'var(--green)' : 'var(--yellow)')}
            ${strengthMetric('動能方向', coin.rsi > 55 ? '正向' : coin.rsi < 45 ? '負向' : '中立', coin.rsi > 55 ? 'var(--red)' : coin.rsi < 45 ? 'var(--green)' : 'var(--yellow)')}
            ${strengthMetric('訊號品質', coin.adx > 30 && coin.volume > 50 ? '強' : coin.adx > 20 ? '中等' : '弱', coin.adx > 30 && coin.volume > 50 ? 'var(--green)' : coin.adx > 20 ? 'var(--yellow)' : 'var(--text-muted)')}
          </div>
        </div>

        <!-- Risk Level (full width) -->
        <div class="analysis-card" style="grid-column:1/-1">
          <div class="analysis-card-title">
            <i class="fas fa-shield-halved" style="color:var(--red)"></i> 風險評估
          </div>
          <div class="risk-level ${riskClass}">
            <span class="risk-icon">${riskIcon}</span>
            <div>
              <div class="risk-title">${riskLevel}</div>
              <div class="risk-desc">${riskDesc}</div>
            </div>
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.7">
            <p><b style="color:var(--text-secondary)">進場參考：</b>
              ${coin.signal === '強力買進'
                ? '強勁多頭動能，可尋找回測MA20的機會進場做多，停損設於近期低點。'
                : coin.signal === '買進'
                ? '多頭趨勢中，等待拉回MA50附近再進場，風險報酬比較佳。'
                : coin.signal === '觀望'
                ? '市場橫盤整理，可等待突破確認後再行操作，建議縮小部位。'
                : coin.signal === '賣出'
                ? '趨勢向下，可於壓力區做空或等待反轉訊號確認後再進多場。'
                : '強勁空頭趨勢，避免做多。可於反彈至MA20時做空，嚴格控管風險。'}
            </p>
          </div>
        </div>
      </div>
    `;

    const container = document.getElementById('coinDetailContent');
    if (container) {
      container.innerHTML = content;
      setTimeout(() => loadTradingView(sym, coin.market, state.currentTF), 200);
    }
  }

  function buildTrendNarrative(coin, ma20Above, ma50Above, ma200Above) {
    const lines = [];
    if (coin.signal === '強力買進') {
      lines.push(`<span style="color:var(--red)">● 強力買進動能。</span>分數 ${coin.score}/100，買盤積極進場。`);
    } else if (coin.signal === '買進') {
      lines.push(`<span style="color:var(--red)">● 買進趨勢</span>，分數 ${coin.score}/100，多方控盤。`);
    } else if (coin.signal === '觀望') {
      lines.push(`<span style="color:var(--yellow)">● 市場整理盤整。</span>分數 ${coin.score}/100，方向不明。`);
    } else if (coin.signal === '賣出') {
      lines.push(`<span style="color:var(--green)">● 賣出趨勢</span>，分數 ${coin.score}/100，空方主導。`);
    } else {
      lines.push(`<span style="color:var(--green)">● 強力賣出動能。</span>分數 ${coin.score}/100，賣壓沉重。`);
    }

    if (coin.rsi > 70) lines.push(`RSI ${coin.rsi} 進入<span style="color:var(--red)">超買區間</span>，短線回調風險提升。`);
    else if (coin.rsi < 30) lines.push(`RSI ${coin.rsi} 進入<span style="color:var(--green)">超賣區間</span>，可能存在反彈機會。`);
    else lines.push(`RSI ${coin.rsi} 位於正常區間，趨勢具延續性。`);

    if (coin.adx > 30) lines.push(`ADX ${coin.adx} 確認<span style="color:var(--accent)">強勁趨勢</span>，動能充足。`);
    else if (coin.adx < 20) lines.push(`ADX ${coin.adx} 顯示<span style="color:var(--yellow)">趨勢偏弱</span>，市場進入盤整。`);

    if (ma20Above && ma50Above) lines.push('股價站上MA20及MA50 — <span style="color:var(--red)">多頭結構</span>。');
    else if (!ma20Above && !ma50Above) lines.push('股價跌破MA20及MA50 — <span style="color:var(--green)">空頭結構</span>。');

    return lines.map(l => `<p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px;line-height:1.6">${l}</p>`).join('');
  }

  function strengthMetric(label, value, color) {
    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px;">
        <div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;font-weight:600;margin-bottom:6px">${label}</div>
        <div style="font-size:0.9rem;font-weight:700;color:${color}">${value}</div>
      </div>`;
  }

  // ─── TV WIDGET ─────────────────────────────────────────
  function loadTradingView(sym, market, timeframe) {
    const tfMap = { '1D': 'D', '1W': 'W', '1M': 'M', '3M': '3M' };
    const interval = tfMap[timeframe] || 'D';
    // TW stocks: TWSE:2330, US stocks: just the symbol
    const tvSym = market === 'TW' ? `TWSE:${sym}` : sym;
    const containerId = `tv_widget_${sym}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    if (window.TradingView) {
      new TradingView.widget({
        autosize:        true,
        height:          480,
        symbol:          tvSym,
        interval,
        timezone:        'Asia/Taipei',
        theme:           'dark',
        style:           '1',
        locale:          'zh_TW',
        toolbar_bg:      '#0a0c12',
        enable_publishing: false,
        withdateranges:  true,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        container_id:    containerId,
        backgroundColor: 'rgba(5,6,8,1)',
        gridColor:       'rgba(255,255,255,0.04)',
        studies:         ['MASimple@tv-scriptstd', 'RSI@tv-scriptstd', 'ADX@tv-scriptstd'],
        overrides: {
          'paneProperties.background':     '#050608',
          'paneProperties.backgroundType': 'solid',
          'scalesProperties.textColor':    '#64748b',
        }
      });
    } else {
      const script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/tv.js';
      script.onload = () => {
        state.tvLoaded = true;
        loadTradingView(sym, market, timeframe);
      };
      document.head.appendChild(script);
    }
  }

  // ─── ANALYSIS PAGE ─────────────────────────────────────
  function initAnalysisSearch() {
    const input       = document.getElementById('analysisSearch');
    const suggestions = document.getElementById('analysisSuggestions');
    if (!input || !suggestions) return;

    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (!q) { suggestions.innerHTML = ''; return; }
      const qUp = q.toUpperCase();
      const matches = state.data.filter(c =>
        c.sym.toUpperCase().includes(qUp) ||
        (c.name && c.name.includes(q))
      ).slice(0, 8);

      if (!matches.length) {
        suggestions.innerHTML = '<div class="suggestion-item" style="color:var(--text-muted);">找不到相符的股票</div>';
        return;
      }

      suggestions.innerHTML = matches.map(c => `
        <div class="suggestion-item" onclick="App.openCoinInAnalysis('${c.sym}')">
          <div class="sug-left">
            ${coinCell(c)}
          </div>
          <div style="text-align:right">
            <div style="font-size:0.78rem;font-family:var(--font-mono)">${c.priceStr}</div>
            ${signalBadge(c.signal)}
          </div>
        </div>`).join('');
    });
  }

  function openCoinInAnalysis(sym) {
    const input       = document.getElementById('analysisSearch');
    const suggestions = document.getElementById('analysisSuggestions');
    if (input) input.value = '';
    if (suggestions) suggestions.innerHTML = '';
    renderAnalysisDetail(sym);
  }

  function renderAnalysisDetail(sym) {
    state.coinDetail = state.data.find(c => c.sym === sym);
    const container = document.getElementById('analysisContent');
    if (!container || !state.coinDetail) return;
    container.innerHTML = '<div id="coinDetailContent"></div>';
    renderStockDetail(sym);
    const detailDiv = document.getElementById('coinDetailContent');
    if (detailDiv) detailDiv.style.animation = 'fadeSlideIn 0.3s ease';
  }

  // ─── SETTINGS ──────────────────────────────────────────
  function initSettings() {
    document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettings);
    document.getElementById('resetSettingsBtn')?.addEventListener('click', resetSettings);
    document.getElementById('testApiBtn')?.addEventListener('click', testApi);
    document.querySelectorAll('.color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.settings.accentColor = btn.dataset.color;
      });
    });
    checkApiStatus();
  }

  function saveSettings() {
    state.settings.timeframe    = document.getElementById('settingTimeframe')?.value  || '1D';
    state.settings.refreshMs    = parseInt(document.getElementById('settingRefresh')?.value || 60000);
    state.settings.apiEndpoint  = document.getElementById('settingApi')?.value || '/api/scan';
    state.settings.darkMode     = document.getElementById('settingDarkMode')?.checked ?? true;
    state.settings.signalAlert  = document.getElementById('settingSignalAlert')?.checked ?? true;
    state.settings.reversalAlert = document.getElementById('settingReversalAlert')?.checked ?? true;
    state.settings.soundAlert   = document.getElementById('settingSoundAlert')?.checked ?? false;
    localStorage.setItem('ssp_settings', JSON.stringify(state.settings));
    applySettings();
    startRefresh();
    showToast('設定已儲存', 'success');
  }

  function resetSettings() {
    localStorage.removeItem('ssp_settings');
    state.settings = {
      timeframe: '1D', refreshMs: 60000,
      apiEndpoint: '/api/scan',
      darkMode: true, accentColor: 'blue',
      signalAlert: true, reversalAlert: true, soundAlert: false,
    };
    applySettings();
    showToast('設定已恢復預設值', 'info');
  }

  async function testApi() {
    const endpoint = document.getElementById('settingApi')?.value;
    const status   = document.getElementById('apiStatus');
    if (status) status.innerHTML = '<span class="pulse-dot"></span> 測試中...';
    const ok = await API.testConnection(endpoint);
    if (status) {
      status.className = 'api-status-badge ' + (ok ? 'connected' : 'error');
      status.innerHTML = ok
        ? '<span class="pulse-dot"></span> 已連線'
        : '<i class="fas fa-circle-xmark"></i> 無法連線';
    }
    showToast(ok ? 'API 連線成功' : 'API 無法連線 — 使用模擬資料', ok ? 'success' : 'error');
  }

  async function checkApiStatus() {
    const endpoint = state.settings.apiEndpoint;
    const status   = document.getElementById('apiStatus');
    const ok = await API.testConnection(endpoint);
    if (status) {
      status.className = 'api-status-badge ' + (ok ? 'connected' : 'error');
      status.innerHTML = ok
        ? '<span class="pulse-dot"></span> 已連線'
        : '<i class="fas fa-circle-xmark"></i> 使用模擬資料';
    }
  }

  // ─── REFRESH ───────────────────────────────────────────
  function startRefresh() {
    clearInterval(state.refreshTimer);
    clearInterval(state.countdown);

    const ms = state.settings.refreshMs;
    if (!ms) return;

    let sec = ms / 1000;
    setText('refreshCountdown', sec + 's');

    state.countdown = setInterval(() => {
      sec--;
      if (sec <= 0) sec = ms / 1000;
      setText('refreshCountdown', sec + 's');
    }, 1000);

    state.refreshTimer = setInterval(() => {
      loadData(false);
    }, ms);
  }

  // ─── NAVIGATION ────────────────────────────────────────
  function navigateTo(page, params = {}) {
    const pages = {
      dashboard: 'dashboardPage',
      ranking:   'rankingPage',
      analysis:  'analysisPage',
      settings:  'settingsPage',
      coin:      'coinPage',
    };

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link, .drawer-link').forEach(l => l.classList.remove('active'));

    const pageId = pages[page];
    if (pageId) {
      const el = document.getElementById(pageId);
      if (el) el.classList.add('active');
    }

    document.querySelectorAll(`[data-page="${page}"]`).forEach(l => l.classList.add('active'));

    state.currentPage = page;
    closeMobileDrawer();

    if (page === 'dashboard') renderDashboard();
    if (page === 'ranking') {
      if (params.filter) {
        state.rankFilter = params.filter;
        syncFilterChips('rankingFilter', params.filter);
      }
      renderRanking();
    }
    if (page === 'analysis') initAnalysisSearch();
    if (page === 'settings') initSettings();
    if (page === 'coin' && params.sym) {
      renderStockDetail(params.sym);
      const backBtn = document.getElementById('coinBackBtn');
      if (backBtn) {
        backBtn.onclick = () => navigateTo(params.from || 'dashboard');
      }
    }

    syncTimeframeButtons(page);
    window.scrollTo(0, 0);
  }

  function syncFilterChips(containerId, filter) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.chip').forEach(c => {
      c.classList.toggle('active', c.dataset.filter === filter || (filter === 'all' && c.dataset.filter === 'all'));
    });
  }

  function syncTimeframeButtons(page) {
    const tfContainers = { dashboard: 'dashboardTF', ranking: 'rankingTF' };
    const cid = tfContainers[page];
    if (!cid) return;
    const container = document.getElementById(cid);
    if (!container) return;
    container.querySelectorAll('.tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === state.currentTF);
    });
  }

  function openCoin(sym, from) {
    navigateTo('coin', { sym, from: from || state.currentPage });
  }

  // ─── EVENT BINDING ─────────────────────────────────────
  function bindNav() {
    document.querySelectorAll('[data-page]').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        navigateTo(link.dataset.page);
      });
    });
  }

  function bindGlobalEvents() {
    // Refresh button
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
      loadData(false);
      showToast('資料已更新', 'info');
    });

    // Mobile toggle
    document.getElementById('mobileToggle')?.addEventListener('click', openMobileDrawer);
    document.getElementById('drawerClose')?.addEventListener('click', closeMobileDrawer);
    document.getElementById('mobileOverlay')?.addEventListener('click', closeMobileDrawer);

    // Dashboard timeframe
    document.getElementById('dashboardTF')?.addEventListener('click', e => {
      const btn = e.target.closest('.tf-btn');
      if (!btn) return;
      setTimeframe(btn.dataset.tf, 'dashboardTF');
    });

    // Ranking timeframe
    document.getElementById('rankingTF')?.addEventListener('click', e => {
      const btn = e.target.closest('.tf-btn');
      if (!btn) return;
      setTimeframe(btn.dataset.tf, 'rankingTF');
    });

    // Dashboard search
    const dashSearch = document.getElementById('dashSearch');
    const clearBtn   = document.getElementById('searchClear');
    dashSearch?.addEventListener('input', () => {
      state.dashSearch = dashSearch.value;
      clearBtn?.classList.toggle('visible', !!dashSearch.value);
      renderDashboard();
    });
    clearBtn?.addEventListener('click', () => {
      if (dashSearch) dashSearch.value = '';
      state.dashSearch = '';
      clearBtn.classList.remove('visible');
      renderDashboard();
    });

    // Dashboard filter
    document.getElementById('dashFilter')?.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#dashFilter .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.dashFilter = chip.dataset.filter;
      renderDashboard();
    });

    // Ranking search
    document.getElementById('rankingSearch')?.addEventListener('input', e => {
      state.rankSearch = e.target.value;
      renderRanking();
    });

    // Ranking filter
    document.getElementById('rankingFilter')?.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#rankingFilter .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.rankFilter = chip.dataset.filter;
      renderRanking();
    });

    // Sorting (event delegation)
    document.addEventListener('click', e => {
      const th = e.target.closest('th.sortable');
      if (!th) return;
      const table = th.dataset.table;
      const col   = th.dataset.col;
      if (!table || !col) return;

      if (table === 'bullish') {
        state.sortBullish = toggleSort(state.sortBullish, col);
        renderDashboard();
      } else if (table === 'bearish') {
        state.sortBearish = toggleSort(state.sortBearish, col);
        renderDashboard();
      } else if (table === 'ranking') {
        state.sortRanking = toggleSort(state.sortRanking, col);
        updateSortHeaders('ranking', state.sortRanking);
        renderRanking();
      }
    });
  }

  function toggleSort(current, col) {
    if (current.col === col) return { col, dir: current.dir === 'desc' ? 'asc' : 'desc' };
    return { col, dir: 'desc' };
  }

  function updateSortHeaders(tableKey, sort) {
    document.querySelectorAll(`[data-table="${tableKey}"]`).forEach(th => {
      th.classList.remove('active-sort');
      const icon = th.querySelector('i');
      if (icon) icon.className = 'fas fa-sort';
      if (th.dataset.col === sort.col) {
        th.classList.add('active-sort');
        if (icon) icon.className = sort.dir === 'desc' ? 'fas fa-sort-down' : 'fas fa-sort-up';
      }
    });
  }

  function setTimeframe(tf, containerId) {
    state.currentTF = tf;
    state.settings.timeframe = tf;
    document.querySelectorAll(`#${containerId} .tf-btn`).forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
    loadData(false);
    showToast(`時間週期切換至 ${tf}`, 'info');
  }

  // ─── MOBILE DRAWER ─────────────────────────────────────
  function openMobileDrawer() {
    document.getElementById('mobileDrawer')?.classList.add('open');
    document.getElementById('mobileOverlay')?.classList.add('open');
  }
  function closeMobileDrawer() {
    document.getElementById('mobileDrawer')?.classList.remove('open');
    document.getElementById('mobileOverlay')?.classList.remove('open');
  }

  // ─── UI HELPERS ────────────────────────────────────────
  function coinCell(c) {
    const [fg, bg] = avatarColors(c.sym);
    const initials = c.sym.substring(0, 4);
    const marketBadge = `<span class="market-badge market-badge-${c.market}">${c.market}</span>`;
    return `
      <div class="coin-cell">
        <div class="coin-avatar" style="background:${bg};color:${fg};border-color:${fg}44">${initials}</div>
        <div>
          <div class="coin-sym">${c.sym} ${marketBadge}</div>
          <div class="coin-pair">${c.name || ''}</div>
        </div>
      </div>`;
  }

  function priceCell(c) {
    const changeVal  = parseFloat(c.change1d);
    const isUp       = changeVal >= 0;
    // Taiwan: red = up, green = down
    const changeColor = isUp ? 'var(--red)' : 'var(--green)';
    const arrow       = isUp ? '▲' : '▼';
    return `<div>
      <div style="font-family:var(--font-mono);font-weight:600">${c.priceStr}</div>
      <div style="font-size:0.68rem;color:${changeColor};font-family:var(--font-mono)">${arrow} ${Math.abs(changeVal)}%</div>
    </div>`;
  }

  function scoreCell(c) {
    const cls = c.signal === '強力買進' ? 'score-strong-bullish'
              : c.signal === '買進'     ? 'score-bullish'
              : c.signal === '觀望'     ? 'score-neutral'
              : c.signal === '賣出'     ? 'score-bearish'
              : 'score-strong-bearish';
    return `
      <div class="score-cell ${cls}">
        <span class="score-val" style="color:${scoreColor(c.score)}">${c.score}</span>
        <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${c.score}%"></div></div>
      </div>`;
  }

  function signalBadge(signal) {
    const clsMap = {
      '強力買進': 'signal-strong-buy',
      '買進':     'signal-buy',
      '觀望':     'signal-watch',
      '賣出':     'signal-sell',
      '強力賣出': 'signal-strong-sell',
    };
    const iconMap = {
      '強力買進': '▲▲', '買進': '▲', '觀望': '—',
      '賣出': '▼', '強力賣出': '▼▼',
    };
    const cls = clsMap[signal] || 'signal-watch';
    return `<span class="trend-badge ${cls}">${iconMap[signal] || ''} ${signal}</span>`;
  }

  function rsiCell(rsi) {
    const cls = rsi > 70 ? 'rsi-high' : rsi < 30 ? 'rsi-low' : 'rsi-mid';
    return `<span class="rsi-cell ${cls}">${rsi}</span>`;
  }

  function volBadge(vol) {
    const cls = vol === '高' ? 'vol-high' : vol === '中' ? 'vol-medium' : 'vol-low';
    return `<span class="vol-badge ${cls}">${vol}</span>`;
  }

  function scoreColor(s) {
    if (s >= 75) return '#f87171';   // strong buy – red-ish (Taiwan: up)
    if (s >= 55) return 'var(--red)';
    if (s >= 40) return 'var(--yellow)';
    if (s >= 25) return 'var(--green)';
    return '#4ade80';                // strong sell – green (Taiwan: down)
  }

  function randLocal(min, max) { return Math.random() * (max - min) + min; }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function showLoader(show) {
    const loader = document.getElementById('pageLoader');
    if (loader) loader.classList.toggle('hidden', !show);
  }

  function rotateRefreshIcon(on) {
    const icon = document.querySelector('#refreshBtn i');
    if (icon) icon.style.animation = on ? 'spin 0.7s linear infinite' : '';
  }

  function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${msg}`;
    container.appendChild(div);
    setTimeout(() => div.remove(), 3200);
  }

  // ─── PUBLIC ────────────────────────────────────────────
  return { init, navigateTo, openCoin, openCoinInAnalysis };

})();

// ─── BOOT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
