/* ============================================================
   app.js — Main Application Logic
   ============================================================ */

/* ── State ─────────────────────────────────────────────────── */
const state = {
  data:         [],          // full dataset
  filtered:     [],          // after filter/search
  activeFilter: 'all',
  dashSearch:   '',
  currentPage:  'dashboard',
  currentCoin:  null,
  timeframe:    '15m',
  settings:     {},
  sortState:    { bull: { key: 'score', dir: 'desc' }, bear: { key: 'score', dir: 'asc' }, ranking: { key: 'score', dir: 'desc' } },
  tvWidget:     null,
  refreshTimer: null,
  countdownTimer: null,
  countdown:    60,
  dataSource:   'mock',
};

/* ── Bootstrap ──────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', init);

async function init() {
  state.settings = loadSettings();
  applySettingsToUI();
  animateLoadingBar();

  const { data, source } = await fetchMarketData();
  state.data       = data;
  state.dataSource = source;
  state.filtered   = [...data];

  hideLoading();
  renderAll();
  startRefreshCycle();
  bindEvents();
  checkApiStatus();
}

/* ── Loading ────────────────────────────────────────────────── */
function animateLoadingBar() {
  const bar   = document.getElementById('loading-bar');
  const texts = ['Connecting to markets...', 'Scanning 100 pairs...', 'Calculating signals...', 'Building dashboard...'];
  let p = 0;
  let t = 0;
  const iv = setInterval(() => {
    p = Math.min(p + randBetween(8, 18), 95);
    bar.style.width = p + '%';
    if (t < texts.length) {
      document.getElementById('loading-text').textContent = texts[t++];
    }
  }, 320);
  return iv;
}
function randBetween(a, b) { return a + Math.random() * (b - a); }

function hideLoading() {
  const bar = document.getElementById('loading-bar');
  bar.style.width = '100%';
  setTimeout(() => {
    document.getElementById('loading-overlay').classList.add('hide');
  }, 400);
}

/* ── Refresh Cycle ──────────────────────────────────────────── */
function startRefreshCycle() {
  clearInterval(state.refreshTimer);
  clearInterval(state.countdownTimer);

  const interval = (state.settings.refreshInterval || 60) * 1000;
  state.countdown = state.settings.refreshInterval || 60;
  updateCountdown();

  state.countdownTimer = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    updateCountdown();
  }, 1000);

  state.refreshTimer = setInterval(async () => {
    state.countdown = state.settings.refreshInterval || 60;
    const { data, source } = await fetchMarketData();
    state.data       = data;
    state.dataSource = source;
    applyFilters();
    renderAll();
    showToast(`Market data refreshed (${source === 'mock' ? 'demo mode' : 'live'})`, 'info');
  }, interval);
}

function updateCountdown() {
  const el = document.getElementById('refresh-countdown');
  if (el) el.textContent = state.countdown + 's';
}

/* ── Bind Events ────────────────────────────────────────────── */
function bindEvents() {
  // Timeframe buttons (all groups)
  document.querySelectorAll('.tf-btn[data-tf]').forEach(btn => {
    btn.addEventListener('click', () => selectTimeframe(btn.dataset.tf));
  });

  // Filter chips
  document.querySelectorAll('.chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => setFilter(chip.dataset.filter));
  });

  // Dashboard search
  const dSearch = document.getElementById('dash-search');
  if (dSearch) dSearch.addEventListener('input', () => {
    state.dashSearch = dSearch.value.trim().toUpperCase();
    applyFilters();
    renderDashboardTables();
  });

  // Ranking search
  const rSearch = document.getElementById('ranking-search');
  if (rSearch) rSearch.addEventListener('input', () => {
    renderRankingTable(rSearch.value.trim().toUpperCase());
  });

  // Nav search
  const navInput = document.getElementById('nav-search-input');
  const dropdown = document.getElementById('search-dropdown');
  if (navInput) {
    navInput.addEventListener('input', () => updateSearchDropdown(navInput.value));
    navInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { dropdown.classList.remove('open'); navInput.value = ''; }
    });
    document.addEventListener('click', e => {
      if (!navInput.closest('.nav-search-wrap').contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });
  }

  // Table sort headers
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const tbl = th.dataset.tbl;
      const key = th.dataset.sort;
      sortTable(tbl, key, th);
    });
  });

  // Chart timeframe
  document.querySelectorAll('.tf-btn[data-ctf]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn[data-ctf]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadTradingViewChart(state.currentCoin, btn.dataset.ctf);
    });
  });

  // Settings inputs
  document.getElementById('s-timeframe')?.addEventListener('change', e => {
    state.settings = saveSettings({ timeframe: e.target.value });
    selectTimeframe(e.target.value);
  });
  document.getElementById('s-refresh')?.addEventListener('change', e => {
    state.settings = saveSettings({ refreshInterval: parseInt(e.target.value) });
    startRefreshCycle();
    showToast('Refresh interval updated', 'success');
  });
  document.getElementById('s-dark')?.addEventListener('change', e => {
    state.settings = saveSettings({ darkMode: e.target.checked });
  });
  document.getElementById('s-reversals')?.addEventListener('change', e => {
    state.settings = saveSettings({ reversals: e.target.checked });
  });
}

/* ── Navigation ─────────────────────────────────────────────── */
function navigateTo(page, coinSymbol) {
  const pages = document.querySelectorAll('.page');
  pages.forEach(p => p.classList.remove('active'));

  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');

  // Update nav links
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

  if (page === 'ranking') renderRankingTable('');
  if (page === 'settings') populateSettingsPage();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleMobileMenu() {
  document.getElementById('mobile-drawer').classList.toggle('open');
  document.getElementById('drawer-overlay').classList.toggle('open');
}

/* ── Timeframe ──────────────────────────────────────────────── */
function selectTimeframe(tf) {
  state.timeframe = tf;
  state.settings  = saveSettings({ timeframe: tf });

  document.querySelectorAll('.tf-btn[data-tf]').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === tf);
  });

  if (state.currentPage === 'coin' && state.currentCoin) {
    loadTradingViewChart(state.currentCoin, tfToTV(tf));
  }
  showToast(`Timeframe set to ${tf}`, 'info');
}

function tfToTV(tf) {
  const map = { '5m': '5', '15m': '15', '1h': '60', '4h': '240' };
  return map[tf] || '15';
}

/* ── Filters ────────────────────────────────────────────────── */
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
    result = result.filter(d => d.symbol.replace('/USDT','').includes(state.dashSearch));
  }

  state.filtered = result;
}

/* ── Render All ─────────────────────────────────────────────── */
function renderAll() {
  applyFilters();
  updateOverviewCards();
  renderDashboardTables();
  renderReversalCards();
  document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
}

/* ── Overview Cards ─────────────────────────────────────────── */
function updateOverviewCards() {
  const d = state.data;
  const bullish = d.filter(x => x.trend === 'Bullish' || x.trend === 'Strong Bullish').length;
  const bearish = d.filter(x => x.trend === 'Bearish' || x.trend === 'Strong Bearish').length;
  const neutral = d.filter(x => x.trend === 'Neutral').length;

  animateCount('ov-total',   d.length);
  animateCount('ov-bull',    bullish);
  animateCount('ov-bear',    bearish);
  animateCount('ov-neutral', neutral);
}

function animateCount(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const dur   = 600;
  const step  = 16;
  let elapsed = 0;
  const iv = setInterval(() => {
    elapsed += step;
    const progress = Math.min(elapsed / dur, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (progress >= 1) clearInterval(iv);
  }, step);
}

/* ── Dashboard Tables ───────────────────────────────────────── */
function renderDashboardTables() {
  const source = state.filtered.length ? state.filtered : state.data;

  // Apply search if filtered is from activeFilter but no search yet
  let bullData = source.filter(d => d.trend === 'Strong Bullish' || d.trend === 'Bullish');
  let bearData = source.filter(d => d.trend === 'Strong Bearish' || d.trend === 'Bearish');

  // Sort
  const bs = state.sortState.bull;
  const ss = state.sortState.bear;
  bullData = sortArr(bullData, bs.key, bs.dir);
  bearData = sortArr(bearData, ss.key, ss.dir);

  document.getElementById('bull-count').textContent = bullData.length;
  document.getElementById('bear-count').textContent = bearData.length;

  renderTableBody('bull-tbody', bullData, 'bull');
  renderTableBody('bear-tbody', bearData, 'bear');
}

function renderTableBody(tbodyId, rows, type) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:24px">No data</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.slice(0, 25).map((row, i) => `
    <tr onclick="navigateTo('coin','${row.symbol}')">
      <td class="rank-cell">${i + 1}</td>
      <td class="sym-cell">
        <span class="sym-base">${row.symbol.replace('/USDT','')}</span>
        <span class="sym-quote">/USDT</span>
      </td>
      <td class="score-cell">
        <div class="score-wrap">
          <span class="score-num" style="color:${scoreColor(row.score)}">${row.score}</span>
          <div class="score-mini-bar">
            <div class="score-mini-fill" style="width:${row.score}%;background:${scoreColor(row.score)}"></div>
          </div>
        </div>
      </td>
      <td><span class="trend-badge ${trendClass(row.trend)}">${trendArrow(row.trend)} ${row.trend}</span></td>
      <td class="price-cell">${fmtPrice(row.price)}</td>
      <td class="rsi-cell" style="color:${rsiColor(row.rsi)}">${row.rsi}</td>
      <td class="adx-cell">${row.adx}</td>
      <td><span class="vol-chip vol-${row.volumeStrength.toLowerCase()}">${row.volumeStrength}</span></td>
    </tr>
  `).join('');
}

/* ── Ranking Table ──────────────────────────────────────────── */
function renderRankingTable(search) {
  const tbody = document.getElementById('ranking-tbody');
  if (!tbody) return;

  const rs = state.sortState.ranking;
  let rows = sortArr([...state.data], rs.key, rs.dir);

  if (search) {
    rows = rows.filter(d => d.symbol.replace('/USDT','').includes(search));
  }

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

/* ── Reversal Cards ─────────────────────────────────────────── */
function renderReversalCards() {
  const grid = document.getElementById('reversal-grid');
  if (!grid) return;

  if (!state.settings.reversals) {
    grid.innerHTML = '<div class="rev-placeholder">Reversal alerts disabled in Settings.</div>';
    document.getElementById('rev-count').textContent = '0';
    return;
  }

  // Reversals: RSI moving toward opposite trend
  const reversals = state.data.filter(d => {
    if (d.trend === 'Strong Bullish' && d.rsi < 50) return true;
    if (d.trend === 'Strong Bearish' && d.rsi > 50) return true;
    if (d.trend === 'Bearish' && d.rsi > 55 && d.adx > 20) return true;
    if (d.trend === 'Bullish' && d.rsi < 45 && d.adx > 20) return true;
    return false;
  }).slice(0, 20);

  document.getElementById('rev-count').textContent = reversals.length;

  if (reversals.length === 0) {
    grid.innerHTML = '<div class="rev-placeholder">No reversal signals detected at this time.</div>';
    return;
  }

  grid.innerHTML = reversals.map(d => {
    const isFlip = (d.trend.includes('Bullish') && d.rsi < 50) || (d.trend.includes('Bearish') && d.rsi > 50);
    const fromTrend = d.trend;
    const toTrend   = d.trend.includes('Bullish') ? 'Bearish' : 'Bullish';
    return `
      <div class="rev-card" onclick="navigateTo('coin','${d.symbol}')">
        <div class="rev-sym">${d.symbol.replace('/USDT','')} <span style="color:var(--text3);font-weight:400;font-size:0.8em">/USDT</span></div>
        <div class="rev-info">
          <span class="trend-badge ${trendClass(fromTrend)}" style="padding:2px 7px;font-size:0.72rem">${fromTrend}</span>
          <span class="rev-arrow">⇒</span>
          <span style="font-size:0.8rem;font-weight:600;color:var(--neutral)">${toTrend}?</span>
        </div>
        <div class="rev-score">
          <span>RSI: <span style="color:${rsiColor(d.rsi)};font-family:'JetBrains Mono',monospace">${d.rsi}</span></span>
          <span>Score: <span class="rev-score-val">${d.score}</span></span>
        </div>
      </div>
    `;
  }).join('');
}

/* ── Coin Detail ────────────────────────────────────────────── */
function renderCoinDetail(symbol) {
  const coin = state.data.find(d => d.symbol === symbol);
  if (!coin) return;

  const base = symbol.replace('/USDT','');

  // Hero
  document.getElementById('coin-avatar').textContent   = base.slice(0, 3);
  document.getElementById('coin-name').textContent      = symbol;
  document.getElementById('coin-price').textContent     = fmtPrice(coin.price);
  document.getElementById('coin-price-sub').textContent = 'USDT';

  const trendChip = document.getElementById('coin-trend-chip');
  trendChip.textContent  = trendArrow(coin.trend) + ' ' + coin.trend;
  trendChip.className    = `coin-trend-chip trend-badge ${trendClass(coin.trend)}`;

  // Metrics
  const scoreEl = document.getElementById('m-score');
  scoreEl.textContent = coin.score;
  scoreEl.style.color = scoreColor(coin.score);
  const fill = document.getElementById('score-fill');
  fill.style.width      = coin.score + '%';
  fill.style.background = `linear-gradient(90deg, ${scoreColor(coin.score)}, ${scoreColorBright(coin.score)})`;

  const rsiEl = document.getElementById('m-rsi');
  rsiEl.textContent = coin.rsi;
  rsiEl.style.color = rsiColor(coin.rsi);
  setTag('rsi-tag', rsiLabel(coin.rsi), rsiColor(coin.rsi));

  document.getElementById('m-adx').textContent = coin.adx;
  setTag('adx-tag', adxLabel(coin.adx), adxColor(coin.adx));

  document.getElementById('m-vol').textContent = coin.volumeStrength;
  setTag('vol-tag', fmtVolume(coin.volume), 'var(--text3)');

  // EMAs
  const p = coin.price;
  const e20  = parseFloat(coin.ema20);
  const e50  = parseFloat(coin.ema50);
  const e200 = parseFloat(coin.ema200);

  document.getElementById('ema20').textContent   = fmtPrice(e20);
  document.getElementById('ema50').textContent   = fmtPrice(e50);
  document.getElementById('ema200').textContent  = fmtPrice(e200);

  setSig('ema20-sig',  p > e20  ? 'Price Above EMA20' : 'Price Below EMA20',  p > e20);
  setSig('ema50-sig',  p > e50  ? 'Price Above EMA50' : 'Price Below EMA50',  p > e50);
  setSig('ema200-sig', p > e200 ? 'Above Long-Term MA' : 'Below Long-Term MA', p > e200);

  // Analysis sections
  document.getElementById('a-trend').innerHTML     = buildTrendAnalysis(coin);
  document.getElementById('a-sr').innerHTML        = buildSupportResistance(coin);
  document.getElementById('a-momentum').innerHTML  = buildMomentumAnalysis(coin);
  document.getElementById('a-strength').innerHTML  = buildStrengthAnalysis(coin);

  // Risk
  const { level, desc, pct, cls } = buildRisk(coin);
  const rbadge = document.getElementById('risk-badge');
  rbadge.textContent = level;
  rbadge.className   = `risk-badge ${cls}`;
  const rbar = document.getElementById('risk-bar');
  rbar.style.width      = pct + '%';
  rbar.style.background = cls === 'risk-low' ? 'var(--bull)' : cls === 'risk-medium' ? 'var(--neutral)' : cls === 'risk-high' ? '#ff6d00' : 'var(--bear)';
  document.getElementById('risk-desc').textContent = desc;

  // Chart
  setTimeout(() => loadTradingViewChart(symbol, tfToTV(state.timeframe)), 50);
}

function setTag(id, text, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent       = text;
  el.style.color       = color;
  el.style.background  = color.replace(')', ', 0.12)').replace('var(', 'rgba(').replace('--','');
  // fallback inline
  el.style.background  = hexToRgba(color, 0.12) || 'rgba(255,255,255,0.06)';
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

/* ── TradingView Chart ──────────────────────────────────────── */
function loadTradingViewChart(symbol, interval) {
  const container = document.getElementById('tv-chart-container');
  if (!container) return;

  container.innerHTML = '';

  const tvSymbol = 'BINANCE:' + symbol.replace('/','');

  if (typeof TradingView !== 'undefined') {
    try {
      state.tvWidget = new TradingView.widget({
        container_id: 'tv-chart-container',
        width:        '100%',
        height:       500,
        symbol:       tvSymbol,
        interval:     interval || '15',
        timezone:     'Etc/UTC',
        theme:        'dark',
        style:        '1',
        locale:       'en',
        toolbar_bg:   '#0d1017',
        enable_publishing: false,
        allow_symbol_change: true,
        hide_top_toolbar: false,
        hide_side_toolbar: false,
        withdateranges: true,
        save_image: false,
        studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
        overrides: {
          'paneProperties.background':          '#0d1017',
          'paneProperties.backgroundType':      'solid',
          'scalesProperties.textColor':         '#94a3b8',
          'mainSeriesProperties.candleStyle.upColor':      '#00e676',
          'mainSeriesProperties.candleStyle.downColor':    '#ff1744',
          'mainSeriesProperties.candleStyle.borderUpColor':'#00e676',
          'mainSeriesProperties.candleStyle.borderDownColor':'#ff1744',
          'mainSeriesProperties.candleStyle.wickUpColor':  '#00e676',
          'mainSeriesProperties.candleStyle.wickDownColor':'#ff1744',
        },
      });
    } catch(e) {
      renderFallbackChart(container, symbol);
    }
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
        <div style="font-size:0.95rem;font-weight:600;color:var(--text2);margin-bottom:6px">Chart Unavailable</div>
        <div style="font-size:0.8rem">TradingView script not loaded — check network connection</div>
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${base}USDT"
           target="_blank" rel="noopener"
           style="display:inline-block;margin-top:14px;padding:8px 18px;background:var(--blue-dim);color:var(--blue);
                  border:1px solid rgba(0,212,255,0.3);border-radius:8px;font-size:0.85rem;font-weight:600;">
          Open on TradingView ↗
        </a>
      </div>
    </div>
  `;
}

/* ── Analysis Builders ──────────────────────────────────────── */
function buildTrendAnalysis(coin) {
  const isBull = coin.score >= 60;
  const isBear = coin.score < 40;
  const e20 = parseFloat(coin.ema20), e50 = parseFloat(coin.ema50), e200 = parseFloat(coin.ema200);
  const p   = coin.price;

  const rows = [
    ['Overall Trend', `<span style="color:${scoreColor(coin.score)}">${coin.trend}</span>`],
    ['Trend Score',   `<span style="color:${scoreColor(coin.score)}">${coin.score}/100</span>`],
    ['EMA Stack',     p > e20 && e20 > e50 && e50 > e200 ? '<span class="text-bull">Bullish stack ↑</span>' :
                      p < e20 && e20 < e50 && e50 < e200 ? '<span class="text-bear">Bearish stack ↓</span>' :
                      '<span class="text-neutral">Mixed signals</span>'],
    ['Signal Summary', isBull ? '<span class="text-bull">Buy bias — momentum supports upside</span>' :
                       isBear ? '<span class="text-bear">Sell bias — momentum supports downside</span>' :
                       '<span class="text-neutral">Wait for clearer directional signal</span>'],
  ];
  return buildRows(rows);
}

function buildSupportResistance(coin) {
  const p  = coin.price;
  const s1 = formatPrice(p * 0.965);
  const s2 = formatPrice(p * 0.93);
  const r1 = formatPrice(p * 1.035);
  const r2 = formatPrice(p * 1.07);
  const rows = [
    ['Support 1',    `<span style="color:var(--bull)">${fmtPrice(s1)}</span>`],
    ['Support 2',    `<span style="color:var(--bull)">${fmtPrice(s2)}</span>`],
    ['Resistance 1', `<span style="color:var(--bear)">${fmtPrice(r1)}</span>`],
    ['Resistance 2', `<span style="color:var(--bear)">${fmtPrice(r2)}</span>`],
    ['Range Width',  `${((r1 - s1) / p * 100).toFixed(1)}%`],
  ];
  return buildRows(rows);
}

function buildMomentumAnalysis(coin) {
  const rows = [
    ['RSI (14)',      `<span style="color:${rsiColor(coin.rsi)}">${coin.rsi} — ${rsiLabel(coin.rsi)}</span>`],
    ['Momentum',     `<span style="color:${coin.momentum >= 0 ? 'var(--bull)' : 'var(--bear)'}">
                       ${coin.momentum >= 0 ? '+' : ''}${coin.momentum}</span>`],
    ['Signal',       coin.rsi > 70 ? '<span class="text-bear">Overbought — pullback risk</span>' :
                     coin.rsi < 30 ? '<span class="text-bull">Oversold — bounce potential</span>' :
                     coin.rsi > 55 ? '<span class="text-bull">Bullish momentum building</span>' :
                     coin.rsi < 45 ? '<span class="text-bear">Bearish momentum building</span>' :
                     '<span class="text-neutral">Neutral zone</span>'],
    ['Divergence',   'No clear divergence detected'],
  ];
  return buildRows(rows);
}

function buildStrengthAnalysis(coin) {
  const rows = [
    ['ADX',          `<span style="color:${adxColor(coin.adx)}">${coin.adx} — ${adxLabel(coin.adx)}</span>`],
    ['Volume',       `<span class="${coin.volumeStrength === 'High' ? 'text-blue' : 'text-neutral'}">${coin.volumeStrength}</span>`],
    ['Trend Strength', coin.adx > 30 ? '<span class="text-bull">Strong trend in effect</span>' :
                       coin.adx > 20 ? '<span class="text-neutral">Moderate trend developing</span>' :
                       '<span class="text-bear">Weak or ranging market</span>'],
    ['Volume 24h',   fmtVolume(coin.volume)],
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
    level = 'Low Risk'; cls = 'risk-low';
    desc = 'Market conditions are stable with moderate volatility. Position sizing within normal parameters is appropriate.';
  } else if (total < 55) {
    level = 'Medium Risk'; cls = 'risk-medium';
    desc = 'Elevated but manageable risk. Consider reducing position size and placing tighter stop-losses.';
  } else if (total < 75) {
    level = 'High Risk'; cls = 'risk-high';
    desc = 'High volatility environment. RSI or trend score at extremes suggests caution. Use strict risk management.';
  } else {
    level = 'Extreme Risk'; cls = 'risk-extreme';
    desc = 'Extreme market conditions detected. RSI severely overbought/oversold. Avoid large positions; wait for consolidation.';
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

/* ── Settings Page ──────────────────────────────────────────── */
function populateSettingsPage() {
  const s = loadSettings();
  const sel = v => id => { const el = document.getElementById(id); if (el) el.value = v; };

  sel(s.timeframe)('s-timeframe');
  sel(String(s.refreshInterval))('s-refresh');

  const dark = document.getElementById('s-dark');
  if (dark) dark.checked = s.darkMode !== false;

  const rev = document.getElementById('s-reversals');
  if (rev) rev.checked = s.reversals !== false;

  const apiUrl = document.getElementById('s-api-url');
  if (apiUrl) apiUrl.value = s.apiUrl || 'http://127.0.0.1:8000/scan';

  const bull = document.getElementById('s-bull-threshold');
  if (bull) { bull.value = s.bullThreshold || 60; document.getElementById('bull-thr-val').textContent = bull.value; }

  const bear = document.getElementById('s-bear-threshold');
  if (bear) { bear.value = s.bearThreshold || 40; document.getElementById('bear-thr-val').textContent = bear.value; }
}

function saveAllSettings() {
  const apiUrlInput = document.getElementById('s-api-url');
  const patch = {
    timeframe:       document.getElementById('s-timeframe')?.value       || '15m',
    refreshInterval: parseInt(document.getElementById('s-refresh')?.value) || 60,
    darkMode:        document.getElementById('s-dark')?.checked            ?? true,
    reversals:       document.getElementById('s-reversals')?.checked       ?? true,
    apiUrl:          apiUrlInput?.value?.replace('/scan','')                || 'http://127.0.0.1:8000',
    bullThreshold:   parseInt(document.getElementById('s-bull-threshold')?.value) || 60,
    bearThreshold:   parseInt(document.getElementById('s-bear-threshold')?.value) || 40,
  };
  state.settings = saveSettings(patch);
  startRefreshCycle();
  showToast('Settings saved successfully', 'success');
}

function resetAllSettings() {
  localStorage.removeItem('csp_settings');
  state.settings = loadSettings();
  populateSettingsPage();
  showToast('Settings reset to defaults', 'info');
}

async function testApiConnection() {
  const dot  = document.getElementById('api-dot');
  const txt  = document.getElementById('api-status-txt');
  if (!dot || !txt) return;

  dot.className = 'api-dot checking';
  txt.textContent = 'Testing...';

  const url = (document.getElementById('s-api-url')?.value || 'http://127.0.0.1:8000/scan');
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    if (res.ok) {
      dot.className  = 'api-dot online';
      txt.textContent = 'Connected';
      showToast('API connection successful', 'success');
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch(e) {
    dot.className  = 'api-dot offline';
    txt.textContent = 'Offline';
    showToast(`API unavailable: ${e.message}`, 'error');
  }
}

function checkApiStatus() {
  const dot = document.getElementById('api-dot');
  const txt = document.getElementById('api-status-txt');
  if (!dot || !txt) return;

  if (state.dataSource === 'api') {
    dot.className  = 'api-dot online';
    txt.textContent = 'Connected (Live)';
  } else {
    dot.className  = 'api-dot offline';
    txt.textContent = 'Demo Mode (API offline)';
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

/* ── Sort ───────────────────────────────────────────────────── */
function sortTable(tblKey, sortKey, thEl) {
  const ss = state.sortState[tblKey];
  if (ss.key === sortKey) {
    ss.dir = ss.dir === 'asc' ? 'desc' : 'asc';
  } else {
    ss.key = sortKey;
    ss.dir = sortKey === 'score' ? (tblKey === 'bear' ? 'asc' : 'desc') : 'asc';
  }

  // Update header classes
  const tbl = tblKey === 'bull' ? 'bull-tbl' : tblKey === 'bear' ? 'bear-tbl' : 'ranking-tbl';
  document.querySelectorAll(`#${tbl} th[data-sort]`).forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
  });
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
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function trendOrder(t) {
  return { 'Strong Bullish': 5, 'Bullish': 4, 'Neutral': 3, 'Bearish': 2, 'Strong Bearish': 1 }[t] || 3;
}

/* ── Search Dropdown ────────────────────────────────────────── */
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
    <div class="search-item" onclick="navigateTo('coin','${d.symbol}');document.getElementById('nav-search-input').value='';document.getElementById('search-dropdown').classList.remove('open')">
      <span class="search-item-sym">${d.symbol}</span>
      <span class="search-item-trend trend-badge ${trendClass(d.trend)}" style="font-size:0.72rem;padding:2px 7px">${d.trend}</span>
    </div>
  `).join('');
  dropdown.classList.add('open');
}

/* ── Toast ──────────────────────────────────────────────────── */
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
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg">${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* ── Helpers ────────────────────────────────────────────────── */
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
    'Strong Bullish': 'trend-strong-bullish',
    'Bullish':        'trend-bullish',
    'Neutral':        'trend-neutral',
    'Bearish':        'trend-bearish',
    'Strong Bearish': 'trend-strong-bearish',
  };
  return map[trend] || 'trend-neutral';
}

function trendArrow(trend) {
  if (trend.includes('Strong Bullish')) return '▲▲';
  if (trend.includes('Bullish'))        return '▲';
  if (trend.includes('Strong Bearish')) return '▼▼';
  if (trend.includes('Bearish'))        return '▼';
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
  if (rsi > 70) return 'Overbought';
  if (rsi > 60) return 'Bullish';
  if (rsi < 30) return 'Oversold';
  if (rsi < 40) return 'Bearish';
  return 'Neutral';
}

function adxColor(adx) {
  if (adx > 40) return 'var(--bull)';
  if (adx > 25) return 'var(--neutral)';
  return 'var(--text3)';
}
function adxLabel(adx) {
  if (adx > 40) return 'Strong Trend';
  if (adx > 25) return 'Trending';
  return 'Weak/Ranging';
}

function fmtPrice(p) {
  if (p === undefined || p === null) return '--';
  const n = parseFloat(p);
  if (n >= 1000)  return '$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)     return '$' + n.toFixed(3);
  if (n >= 0.001) return '$' + n.toFixed(5);
  return '$' + n.toFixed(8);
}

function fmtVolume(v) {
  if (!v) return '--';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toString();
}

function formatPrice(p) {
  if (p >= 1000)  return parseFloat(p.toFixed(2));
  if (p >= 1)     return parseFloat(p.toFixed(3));
  if (p >= 0.001) return parseFloat(p.toFixed(5));
  return parseFloat(p.toFixed(8));
}
