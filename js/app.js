/* ==========================================
   CRYPTO SCANNER PRO - MAIN APPLICATION
   ========================================== */

const App = (() => {

  // ─── STATE ─────────────────────────────────────────────
  const state = {
    data:          [],
    filteredData:  [],
    currentPage:   'dashboard',
    currentTF:     '15m',
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
      timeframe:   '15m',
      refreshMs:   60000,
      apiEndpoint: 'http://127.0.0.1:8000/scan',
      darkMode:    true,
      accentColor: 'blue',
      signalAlert: true,
      reversalAlert: true,
      soundAlert:  false,
    },
    coinDetail: null,
    analysisData: [],
    tvLoaded: false,
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
    navigateTo('dashboard');
    loadData(true);
    startRefresh();
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('csp_settings') || '{}');
      Object.assign(state.settings, saved);
    } catch {}
    applySettings();
  }

  function applySettings() {
    const s = state.settings;
    state.currentTF = s.timeframe;
    state.countdownSec = s.refreshMs / 1000;
    // Sync settings UI
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

  // ─── DATA LOADING ──────────────────────────────────────
  async function loadData(initial = false) {
    if (initial) showLoader(true);
    rotateRefreshIcon(true);

    const endpoint = state.settings.apiEndpoint;
    let data = await API.fetchData(endpoint, state.currentTF);
    const usingMock = !data;
    if (!data) data = API.generateMockData(state.currentTF);

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
    const strongBull = data.filter(d => d.trend === 'Strong Bullish').length;
    const strongBear = data.filter(d => d.trend === 'Strong Bearish').length;
    if (!usingMock && state.settings.signalAlert) {
      if (strongBull > 20) showToast(`${strongBull} coins in Strong Bullish zone`, 'success');
      if (strongBear > 20) showToast(`${strongBear} coins in Strong Bearish zone`, 'error');
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
    if (filter && filter !== 'all') d = d.filter(c => c.trend === filter);
    if (search) {
      const q = search.trim().toUpperCase();
      d = d.filter(c => c.sym.includes(q) || c.symbol.includes(q));
    }
    return d;
  }

  // ─── OVERVIEW CARDS ────────────────────────────────────
  function renderOverviewCards() {
    const d = state.data;
    const total    = d.length;
    const bullish  = d.filter(c => c.trend === 'Bullish' || c.trend === 'Strong Bullish').length;
    const bearish  = d.filter(c => c.trend === 'Bearish' || c.trend === 'Strong Bearish').length;
    const neutral  = d.filter(c => c.trend === 'Neutral').length;

    setText('totalCount',   total);
    setText('bullishCount', bullish);
    setText('bearishCount', bearish);
    setText('neutralCount', neutral);

    // Progress bars
    const bar = (id, count, color) => {
      const el = document.getElementById(id);
      if (el) { el.style.width = (count / total * 100) + '%'; el.style.color = color; }
    };
    bar('bullishBar', bullish, 'var(--green)');
    bar('bearishBar', bearish, 'var(--red)');
    bar('neutralBar', neutral, 'var(--yellow)');
  }

  function updateLastUpdated() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    setText('lastUpdated', timeStr);
  }

  // ─── DASHBOARD ─────────────────────────────────────────
  function renderDashboard() {
    const d = state.data;
    const filtered = getFiltered(state.dashFilter, state.dashSearch, d);

    const bullish = filtered
      .filter(c => c.trend === 'Strong Bullish' || c.trend === 'Bullish')
      .sort((a,b) => b.score - a.score);

    const bearish = filtered
      .filter(c => c.trend === 'Strong Bearish' || c.trend === 'Bearish')
      .sort((a,b) => a.score - b.score);

    setText('bullishBadge', bullish.length);
    setText('bearishBadge', bearish.length);

    renderTable('bullishTbody', sortData(bullish, state.sortBullish), 'bullish');
    renderTable('bearishTbody', sortData(bearish, state.sortBearish), 'bearish');
    renderReversals(filtered);
  }

  function sortData(data, { col, dir }) {
    return [...data].sort((a,b) => {
      const av = a[col], bv = b[col];
      if (dir === 'asc') return av - bv;
      return bv - av;
    });
  }

  function renderTable(tbodyId, rows, tableKey) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading-cell" style="color:var(--text-muted);font-size:0.82rem;">No coins found</td></tr>';
      return;
    }

    const top = rows.slice(0, 15);
    tbody.innerHTML = top.map((c, i) => `
      <tr onclick="App.openCoin('${c.sym}')">
        <td><span class="rank-num">${i+1}</span></td>
        <td>${coinCell(c)}</td>
        <td>${scoreCell(c)}</td>
        <td>${trendBadge(c.trend)}</td>
        <td class="price-cell">${c.priceStr}</td>
        <td>${rsiCell(c.rsi)}</td>
        <td><span class="rank-num">${c.adx}</span></td>
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
      tbody.innerHTML = '<tr><td colspan="8" class="loading-cell" style="color:var(--text-muted)">No results found</td></tr>';
      return;
    }

    tbody.innerHTML = sorted.map((c, i) => `
      <tr onclick="App.openCoin('${c.sym}')">
        <td><span class="rank-num">${i+1}</span></td>
        <td>${coinCell(c)}</td>
        <td class="price-cell">${c.priceStr}</td>
        <td>${trendBadge(c.trend)}</td>
        <td>${scoreCell(c)}</td>
        <td>${rsiCell(c.rsi)}</td>
        <td>${volBadge(c.volumeStr)}</td>
        <td><span style="font-family:var(--font-mono);color:${c.adx>25?'var(--accent)':'var(--text-muted)'}">${c.adx}</span></td>
      </tr>`).join('');

    if (footer) footer.textContent = `Showing ${sorted.length} of ${state.data.length} coins`;
  }

  // ─── REVERSAL DETECTION ────────────────────────────────
  function renderReversals(data) {
    const reversals = data.filter(c => {
      const rsiOversold   = c.rsi < 32 && (c.trend === 'Bearish' || c.trend === 'Strong Bearish');
      const rsiOverbought = c.rsi > 68 && (c.trend === 'Bullish' || c.trend === 'Strong Bullish');
      return rsiOversold || rsiOverbought;
    }).slice(0, 20);

    setText('reversalBadge', reversals.length);
    const grid = document.getElementById('reversalGrid');
    if (!grid) return;

    if (!reversals.length) {
      grid.innerHTML = '<div class="reversal-empty"><i class="fas fa-check-circle" style="color:var(--green)"></i> <span>No reversal signals detected</span></div>';
      return;
    }

    grid.innerHTML = reversals.map(c => {
      const isBullRev = c.rsi < 32;
      const cls   = isBullRev ? 'reversal-bullish-rev' : 'reversal-bearish-rev';
      const icon  = isBullRev ? '↑' : '↓';
      const label = isBullRev ? 'Oversold Reversal' : 'Overbought Reversal';
      const col   = isBullRev ? 'var(--green)' : 'var(--red)';
      return `
        <div class="reversal-item ${cls}" onclick="App.openCoin('${c.sym}')">
          <div class="rev-header">
            <span class="rev-sym">${c.sym}</span>
            ${trendBadge(c.trend)}
          </div>
          <div class="rev-price">${c.priceStr}</div>
          <div class="rev-signal" style="color:${col}">${icon} ${label}</div>
          <div class="rev-stats">
            <div class="rev-stat">RSI <span style="color:${col}">${c.rsi}</span></div>
            <div class="rev-stat">ADX <span>${c.adx}</span></div>
            <div class="rev-stat">Score <span>${c.score}</span></div>
            <div class="rev-stat">Vol <span>${c.volumeStr}</span></div>
          </div>
        </div>`;
    }).join('');
  }

  // ─── COIN DETAIL ───────────────────────────────────────
  function renderCoinDetail(sym) {
    const coin = state.data.find(c => c.sym === sym);
    if (!coin) { navigateTo('dashboard'); return; }
    state.coinDetail = coin;

    const [fg, bg] = avatarColors(sym);
    const isUp   = parseFloat(coin.change24h) >= 0;
    const changeColor = isUp ? 'var(--green)' : 'var(--red)';
    const changeIcon  = isUp ? 'fa-arrow-up' : 'fa-arrow-down';

    const ema20Above  = coin.price > coin.ema20;
    const ema50Above  = coin.price > coin.ema50;
    const ema200Above = coin.price > coin.ema200;

    // Risk level
    let riskLevel, riskClass, riskIcon, riskDesc;
    if (coin.adx > 35 && (coin.rsi > 70 || coin.rsi < 30)) {
      riskLevel = 'High Risk';  riskClass = 'risk-high';
      riskIcon  = '⚠️'; riskDesc = 'Strong momentum with extreme RSI – volatile conditions';
    } else if (coin.adx > 20) {
      riskLevel = 'Medium Risk'; riskClass = 'risk-medium';
      riskIcon  = '⚡'; riskDesc = 'Active trend with moderate strength';
    } else {
      riskLevel = 'Low Risk'; riskClass = 'risk-low';
      riskIcon  = '✅'; riskDesc = 'Weak trend – sideways / consolidating';
    }

    // Support & Resistance
    const res1 = coin.price * (1 + rand(0.03, 0.07));
    const res2 = coin.price * (1 + rand(0.08, 0.15));
    const sup1 = coin.price * (1 - rand(0.03, 0.07));
    const sup2 = coin.price * (1 - rand(0.08, 0.15));

    // Trend narrative
    const trendNarrative = buildTrendNarrative(coin, ema20Above, ema50Above, ema200Above);

    const content = `
      <!-- Hero -->
      <div class="glass-card coin-hero" style="margin-bottom:16px;">
        <div class="coin-hero-avatar" style="background:${bg};color:${fg};border-color:${fg}44">
          ${sym.substring(0,3)}
        </div>
        <div class="coin-hero-info">
          <div class="coin-name">${sym}<span style="color:var(--text-muted);font-size:1rem">/USDT</span></div>
          <div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${trendBadge(coin.trend)}
            <span style="font-size:0.75rem;color:var(--text-muted)">Score: <b style="color:var(--text-primary);font-family:var(--font-mono)">${coin.score}/100</b></span>
          </div>
        </div>
        <div class="coin-hero-price">
          <div class="price-big">${coin.priceStr}</div>
          <div style="margin-top:4px;font-size:0.82rem;color:${changeColor};font-family:var(--font-mono)">
            <i class="fas ${changeIcon}"></i> ${Math.abs(coin.change24h)}%
          </div>
          <div class="price-sub">24h change</div>
        </div>
      </div>

      <!-- TradingView Chart -->
      <div class="glass-card chart-card">
        <div class="card-header">
          <div class="card-title-row">
            <i class="fas fa-chart-candlestick" style="color:var(--accent)"></i>
            <h2>Price Chart</h2>
          </div>
          <span style="font-size:0.78rem;color:var(--text-muted)">TradingView • Binance • ${state.currentTF}</span>
        </div>
        <div class="chart-wrap">
          <div id="tv_widget_${sym}" class="tv-widget-container"></div>
        </div>
      </div>

      <!-- Key Stats -->
      <div class="coin-stats-grid">
        <div class="stat-card">
          <div class="stat-label">RSI (14)</div>
          <div class="stat-value" style="color:${coin.rsi>70?'var(--red)':coin.rsi<30?'var(--green)':'var(--text-primary)'}">${coin.rsi}</div>
          <div class="stat-sub">${coin.rsi>70?'Overbought':coin.rsi<30?'Oversold':'Normal range'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">ADX (14)</div>
          <div class="stat-value" style="color:${coin.adx>25?'var(--accent)':'var(--text-muted)'}">${coin.adx}</div>
          <div class="stat-sub">${coin.adx>40?'Very Strong':coin.adx>25?'Strong trend':coin.adx>15?'Weak trend':'Ranging'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Trend Score</div>
          <div class="stat-value" style="color:${scoreColor(coin.score)}">${coin.score}<span style="font-size:0.9rem;color:var(--text-muted)">/100</span></div>
          <div class="stat-sub">${coin.trend}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Volume Strength</div>
          <div class="stat-value" style="color:${coin.volumeStr==='High'?'var(--accent)':coin.volumeStr==='Medium'?'var(--yellow)':'var(--text-muted)'}">
            ${coin.volumeStr}
          </div>
          <div class="stat-sub">Relative volume: ${coin.volume}/100</div>
        </div>
      </div>

      <!-- Analysis Cards -->
      <div class="coin-analysis-grid">

        <!-- Trend Analysis -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-chart-line" style="color:var(--accent)"></i> Trend Analysis
          </div>
          ${trendNarrative}
        </div>

        <!-- EMA Analysis -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-wave-square" style="color:var(--purple)"></i> Moving Averages
          </div>
          <div class="ema-row">
            <span class="ema-label">EMA 20</span>
            <span class="ema-value">${API.formatPrice(coin.ema20)}</span>
            <span class="ema-status ${ema20Above?'ema-above':'ema-below'}">${ema20Above?'Above':'Below'}</span>
          </div>
          <div class="ema-row">
            <span class="ema-label">EMA 50</span>
            <span class="ema-value">${API.formatPrice(coin.ema50)}</span>
            <span class="ema-status ${ema50Above?'ema-above':'ema-below'}">${ema50Above?'Above':'Below'}</span>
          </div>
          <div class="ema-row">
            <span class="ema-label">EMA 200</span>
            <span class="ema-value">${API.formatPrice(coin.ema200)}</span>
            <span class="ema-status ${ema200Above?'ema-above':'ema-below'}">${ema200Above?'Above':'Below'}</span>
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-size:0.78rem;color:var(--text-muted);">
            ${ema20Above&&ema50Above&&ema200Above
              ? '<span style="color:var(--green)">✓ Price above all EMAs – bullish alignment</span>'
              : !ema20Above&&!ema50Above&&!ema200Above
              ? '<span style="color:var(--red)">✗ Price below all EMAs – bearish alignment</span>'
              : '<span style="color:var(--yellow)">⚡ Mixed EMA structure – consolidation phase</span>'}
          </div>
        </div>

        <!-- Support & Resistance -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-layer-group" style="color:var(--yellow)"></i> Support & Resistance
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">Resistance 2</span><span class="sr-val" style="color:var(--red)">${API.formatPrice(res2)}</span></div>
            <div class="sr-bar" style="background:rgba(239,68,68,0.15);width:85%"></div>
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">Resistance 1</span><span class="sr-val" style="color:var(--red)">${API.formatPrice(res1)}</span></div>
            <div class="sr-bar" style="background:rgba(239,68,68,0.25);width:60%"></div>
          </div>
          <div class="sr-item" style="padding:8px;background:var(--accent-dim);border-radius:6px;border:1px solid var(--border)">
            <div class="sr-level"><span class="sr-label" style="color:var(--accent)">Current Price</span><span class="sr-val" style="color:var(--accent)">${coin.priceStr}</span></div>
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">Support 1</span><span class="sr-val" style="color:var(--green)">${API.formatPrice(sup1)}</span></div>
            <div class="sr-bar" style="background:rgba(34,197,94,0.25);width:65%"></div>
          </div>
          <div class="sr-item">
            <div class="sr-level"><span class="sr-label">Support 2</span><span class="sr-val" style="color:var(--green)">${API.formatPrice(sup2)}</span></div>
            <div class="sr-bar" style="background:rgba(34,197,94,0.15);width:40%"></div>
          </div>
        </div>

        <!-- Momentum Analysis -->
        <div class="analysis-card">
          <div class="analysis-card-title">
            <i class="fas fa-gauge-high" style="color:var(--green)"></i> Momentum Analysis
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">RSI (14)</span>
              <span class="mom-val" style="color:${coin.rsi>70?'var(--red)':coin.rsi<30?'var(--green)':'var(--accent)'}">${coin.rsi}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${coin.rsi}%;background:${coin.rsi>70?'var(--red)':coin.rsi<30?'var(--green)':'var(--accent)'}"></div></div>
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">ADX Strength</span>
              <span class="mom-val" style="color:var(--accent)">${coin.adx}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${Math.min(coin.adx,100)}%;background:var(--accent)"></div></div>
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">Trend Score</span>
              <span class="mom-val" style="color:${scoreColor(coin.score)}">${coin.score}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${coin.score}%;background:${scoreColor(coin.score)}"></div></div>
          </div>
          <div class="mom-row">
            <div class="mom-label-row">
              <span class="mom-label">Volume Strength</span>
              <span class="mom-val" style="color:var(--yellow)">${coin.volume}</span>
            </div>
            <div class="mom-track"><div class="mom-fill" style="width:${coin.volume}%;background:var(--yellow)"></div></div>
          </div>
        </div>

        <!-- Market Strength (full width) -->
        <div class="analysis-card" style="grid-column:1/-1">
          <div class="analysis-card-title">
            <i class="fas fa-signal" style="color:var(--yellow)"></i> Market Strength
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
            ${strengthMetric('Trend Strength', coin.adx > 25 ? 'Strong' : coin.adx > 15 ? 'Moderate' : 'Weak', coin.adx > 25 ? 'var(--green)' : coin.adx > 15 ? 'var(--yellow)' : 'var(--red)')}
            ${strengthMetric('Buy Pressure', coin.score > 60 ? 'High' : coin.score > 40 ? 'Medium' : 'Low', coin.score > 60 ? 'var(--green)' : coin.score > 40 ? 'var(--yellow)' : 'var(--red)')}
            ${strengthMetric('Volume Activity', coin.volumeStr, coin.volumeStr === 'High' ? 'var(--accent)' : coin.volumeStr === 'Medium' ? 'var(--yellow)' : 'var(--text-muted)')}
            ${strengthMetric('EMA Alignment', ema20Above&&ema50Above&&ema200Above ? 'Bullish' : !ema20Above&&!ema50Above&&!ema200Above ? 'Bearish' : 'Mixed', ema20Above&&ema50Above&&ema200Above ? 'var(--green)' : !ema20Above&&!ema50Above&&!ema200Above ? 'var(--red)' : 'var(--yellow)')}
            ${strengthMetric('Momentum', coin.rsi > 55 ? 'Positive' : coin.rsi < 45 ? 'Negative' : 'Neutral', coin.rsi > 55 ? 'var(--green)' : coin.rsi < 45 ? 'var(--red)' : 'var(--yellow)')}
            ${strengthMetric('Signal Quality', coin.adx > 30 && coin.volume > 50 ? 'Strong' : coin.adx > 20 ? 'Moderate' : 'Weak', coin.adx > 30 && coin.volume > 50 ? 'var(--green)' : coin.adx > 20 ? 'var(--yellow)' : 'var(--text-muted)')}
          </div>
        </div>

        <!-- Risk Level (full width) -->
        <div class="analysis-card" style="grid-column:1/-1">
          <div class="analysis-card-title">
            <i class="fas fa-shield-halved" style="color:var(--red)"></i> Risk Assessment
          </div>
          <div class="risk-level ${riskClass}">
            <span class="risk-icon">${riskIcon}</span>
            <div>
              <div class="risk-title">${riskLevel}</div>
              <div class="risk-desc">${riskDesc}</div>
            </div>
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.7">
            <p><b style="color:var(--text-secondary)">Entry considerations:</b>
              ${coin.trend === 'Strong Bullish' ? 'Look for pullbacks to EMA20 for lower-risk entries on the long side.' :
                coin.trend === 'Bullish' ? 'Trend is supportive. Wait for dips toward EMA50 before entry.' :
                coin.trend === 'Neutral' ? 'Market is ranging. Trade breakouts with tight stops and reduce position size.' :
                coin.trend === 'Bearish' ? 'Trend is down. Short entries at resistance or wait for reversal confirmation.' :
                'Strong downtrend. Avoid longs. Short entries on rallies to EMA20 with strict risk management.'}
            </p>
          </div>
        </div>
      </div>
    `;

    const container = document.getElementById('coinDetailContent');
    if (container) {
      container.innerHTML = content;
      setTimeout(() => loadTradingView(sym, state.currentTF), 200);
    }
  }

  function buildTrendNarrative(coin, ema20Above, ema50Above, ema200Above) {
    const lines = [];
    if (coin.trend === 'Strong Bullish') {
      lines.push(`<span style="color:var(--green)">● Strong bullish momentum detected.</span> Score of ${coin.score}/100 indicates high buying pressure.`);
    } else if (coin.trend === 'Bullish') {
      lines.push(`<span style="color:var(--green)">● Bullish trend</span> with score ${coin.score}/100. Buyers are in control.`);
    } else if (coin.trend === 'Neutral') {
      lines.push(`<span style="color:var(--yellow)">● Market is consolidating.</span> Score ${coin.score}/100 – no clear directional bias.`);
    } else if (coin.trend === 'Bearish') {
      lines.push(`<span style="color:var(--red)">● Bearish trend</span> with score ${coin.score}/100. Selling pressure dominant.`);
    } else {
      lines.push(`<span style="color:var(--red)">● Strong bearish momentum.</span> Score ${coin.score}/100 – strong selling pressure.`);
    }

    if (coin.rsi > 70) lines.push(`RSI at ${coin.rsi} is <span style="color:var(--red)">overbought</span> – pullback risk elevated.`);
    else if (coin.rsi < 30) lines.push(`RSI at ${coin.rsi} is <span style="color:var(--green)">oversold</span> – potential bounce opportunity.`);
    else lines.push(`RSI at ${coin.rsi} is in normal range – trend is sustainable.`);

    if (coin.adx > 30) lines.push(`ADX ${coin.adx} confirms a <span style="color:var(--accent)">strong trend</span> – momentum is high.`);
    else if (coin.adx < 20) lines.push(`ADX ${coin.adx} signals a <span style="color:var(--yellow)">weak trend</span> – ranging conditions.`);

    if (ema20Above && ema50Above) lines.push('Price is trading above EMA20 and EMA50 – <span style="color:var(--green)">bullish structure</span>.');
    else if (!ema20Above && !ema50Above) lines.push('Price is below EMA20 and EMA50 – <span style="color:var(--red)">bearish structure</span>.');

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
  function loadTradingView(sym, timeframe) {
    const tfMap = { '5m':'5','15m':'15','1h':'60','4h':'240' };
    const interval = tfMap[timeframe] || '15';
    const tvSym = `BINANCE:${sym}USDT`;
    const containerId = `tv_widget_${sym}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    if (window.TradingView) {
      new TradingView.widget({
        autosize: true,
        height: 480,
        symbol: tvSym,
        interval,
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: '#0a0c12',
        enable_publishing: false,
        withdateranges: true,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        container_id: containerId,
        backgroundColor: 'rgba(5,6,8,1)',
        gridColor: 'rgba(255,255,255,0.04)',
        studies: ['MASimple@tv-scriptstd','RSI@tv-scriptstd','ADX@tv-scriptstd'],
        overrides: {
          'paneProperties.background': '#050608',
          'paneProperties.backgroundType': 'solid',
          'scalesProperties.textColor': '#64748b',
        }
      });
    } else {
      const script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/tv.js';
      script.onload = () => {
        state.tvLoaded = true;
        loadTradingView(sym, timeframe);
      };
      document.head.appendChild(script);
    }
  }

  // ─── ANALYSIS PAGE ─────────────────────────────────────
  function initAnalysisSearch() {
    const input = document.getElementById('analysisSearch');
    const suggestions = document.getElementById('analysisSuggestions');
    if (!input || !suggestions) return;

    input.addEventListener('input', () => {
      const q = input.value.trim().toUpperCase();
      if (!q) { suggestions.innerHTML = ''; return; }
      const matches = state.data.filter(c => c.sym.includes(q) || c.symbol.includes(q)).slice(0, 8);
      suggestions.innerHTML = matches.map(c => `
        <div class="suggestion-item" onclick="App.openCoinInAnalysis('${c.sym}')">
          <div class="sug-left">
            ${coinCell(c)}
          </div>
          <div style="text-align:right">
            <div style="font-size:0.78rem;font-family:var(--font-mono)">${c.priceStr}</div>
            ${trendBadge(c.trend)}
          </div>
        </div>`).join('');
    });
  }

  function openCoinInAnalysis(sym) {
    const input = document.getElementById('analysisSearch');
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
    renderCoinDetail(sym);
    // Repoint since renderCoinDetail writes to #coinDetailContent inside the page
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
    state.settings.timeframe   = document.getElementById('settingTimeframe')?.value  || '15m';
    state.settings.refreshMs   = parseInt(document.getElementById('settingRefresh')?.value || 60000);
    state.settings.apiEndpoint = document.getElementById('settingApi')?.value || 'http://127.0.0.1:8000/scan';
    state.settings.darkMode    = document.getElementById('settingDarkMode')?.checked ?? true;
    state.settings.signalAlert = document.getElementById('settingSignalAlert')?.checked ?? true;
    state.settings.reversalAlert = document.getElementById('settingReversalAlert')?.checked ?? true;
    state.settings.soundAlert  = document.getElementById('settingSoundAlert')?.checked ?? false;
    localStorage.setItem('csp_settings', JSON.stringify(state.settings));
    applySettings();
    startRefresh();
    showToast('Settings saved successfully', 'success');
  }

  function resetSettings() {
    localStorage.removeItem('csp_settings');
    state.settings = {
      timeframe: '15m', refreshMs: 60000,
      apiEndpoint: 'http://127.0.0.1:8000/scan',
      darkMode: true, accentColor: 'blue',
      signalAlert: true, reversalAlert: true, soundAlert: false,
    };
    applySettings();
    showToast('Settings reset to default', 'info');
  }

  async function testApi() {
    const endpoint = document.getElementById('settingApi')?.value;
    const status   = document.getElementById('apiStatus');
    if (status) status.innerHTML = '<span class="pulse-dot"></span> Testing...';
    const ok = await API.testConnection(endpoint);
    if (status) {
      status.className = 'api-status-badge ' + (ok ? 'connected' : 'error');
      status.innerHTML = ok
        ? '<span class="pulse-dot"></span> Connected'
        : '<i class="fas fa-circle-xmark"></i> Unreachable';
    }
    showToast(ok ? 'API connection successful' : 'API unreachable – using mock data', ok ? 'success' : 'error');
  }

  async function checkApiStatus() {
    const endpoint = state.settings.apiEndpoint;
    const status   = document.getElementById('apiStatus');
    const ok = await API.testConnection(endpoint);
    if (status) {
      status.className = 'api-status-badge ' + (ok ? 'connected' : 'error');
      status.innerHTML = ok
        ? '<span class="pulse-dot"></span> Connected'
        : '<i class="fas fa-circle-xmark"></i> Using Mock Data';
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
    const pages = { dashboard:'dashboardPage', ranking:'rankingPage', analysis:'analysisPage', settings:'settingsPage', coin:'coinPage' };

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
      if (params.filter) { state.rankFilter = params.filter; syncFilterChips('rankingFilter', params.filter); }
      renderRanking();
    }
    if (page === 'analysis') initAnalysisSearch();
    if (page === 'settings') initSettings();
    if (page === 'coin' && params.sym) {
      renderCoinDetail(params.sym);
      const backBtn = document.getElementById('coinBackBtn');
      if (backBtn) {
        backBtn.onclick = () => navigateTo(params.from || 'dashboard');
      }
    }

    // Sync timeframe buttons
    syncTimeframeButtons(page);
    window.scrollTo(0, 0);
  }

  function syncFilterChips(containerId, filter) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.chip').forEach(c => {
      c.classList.toggle('active', (c.dataset.filter === filter) || (filter === 'all' && c.dataset.filter === 'all'));
    });
  }

  function syncTimeframeButtons(page) {
    const tfContainers = { dashboard:'dashboardTF', ranking:'rankingTF' };
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
      showToast('Data refreshed', 'info');
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
    showToast(`Timeframe set to ${tf}`, 'info');
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
    return `
      <div class="coin-cell">
        <div class="coin-avatar" style="background:${bg};color:${fg};border-color:${fg}44">${c.sym.substring(0,3)}</div>
        <div>
          <div class="coin-sym">${c.sym}</div>
          <div class="coin-pair">USDT</div>
        </div>
      </div>`;
  }

  function scoreCell(c) {
    const cls = c.trend === 'Strong Bullish' ? 'score-strong-bullish'
              : c.trend === 'Bullish' ? 'score-bullish'
              : c.trend === 'Neutral' ? 'score-neutral'
              : c.trend === 'Bearish' ? 'score-bearish'
              : 'score-strong-bearish';
    return `
      <div class="score-cell ${cls}">
        <span class="score-val" style="color:${scoreColor(c.score)}">${c.score}</span>
        <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${c.score}%"></div></div>
      </div>`;
  }

  function trendBadge(trend) {
    const cls = {
      'Strong Bullish': 'trend-strong-bullish',
      'Bullish':        'trend-bullish',
      'Neutral':        'trend-neutral',
      'Bearish':        'trend-bearish',
      'Strong Bearish': 'trend-strong-bearish',
    }[trend] || 'trend-neutral';
    const icons = {
      'Strong Bullish': '▲▲', 'Bullish': '▲', 'Neutral': '—',
      'Bearish': '▼', 'Strong Bearish': '▼▼',
    };
    return `<span class="trend-badge ${cls}">${icons[trend]||''} ${trend}</span>`;
  }

  function rsiCell(rsi) {
    const cls = rsi > 70 ? 'rsi-high' : rsi < 30 ? 'rsi-low' : 'rsi-mid';
    return `<span class="rsi-cell ${cls}">${rsi}</span>`;
  }

  function volBadge(vol) {
    const cls = vol === 'High' ? 'vol-high' : vol === 'Medium' ? 'vol-medium' : 'vol-low';
    return `<span class="vol-badge ${cls}">${vol}</span>`;
  }

  function scoreColor(s) {
    if (s >= 75) return '#4ade80';
    if (s >= 55) return 'var(--green)';
    if (s >= 40) return 'var(--yellow)';
    if (s >= 25) return 'var(--red)';
    return '#f87171';
  }

  function rand(min, max) { return Math.random() * (max - min) + min; }

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
    const icons = { success:'fa-circle-check', error:'fa-circle-xmark', info:'fa-circle-info' };
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.innerHTML = `<i class="fas ${icons[type]||icons.info}"></i> ${msg}`;
    container.appendChild(div);
    setTimeout(() => div.remove(), 3200);
  }

  // ─── PUBLIC ────────────────────────────────────────────
  return { init, navigateTo, openCoin, openCoinInAnalysis };

})();

// ─── BOOT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
