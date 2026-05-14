/* ============================================================
   CRYPTO SCANNER PRO — Dashboard Logic
   ============================================================ */

let allCoins = [];
let activeFilter = 'all';
let activeTimeframe = '15m';
let searchTerm = '';
let isMockData = false;
let refreshTimer = null;
let countdownTimer = null;
let countdownSecs = 60;
let sortConfig = { table: null, col: null, dir: 'asc' };

async function initDashboard() {
  const settings = getSettings();
  activeTimeframe = settings.defaultTimeframe || '15m';
  countdownSecs = settings.refreshInterval || 60;

  // Set active timeframe btn
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tf === activeTimeframe);
  });

  await loadData();
  setupAutoRefresh();
  bindEvents();
}

async function loadData() {
  setStatus('loading');
  setRefreshSpin(true);

  const { data, isMock } = await fetchMarketData(activeTimeframe);
  allCoins = data;
  isMockData = isMock;

  renderAll();
  setStatus(isMock ? 'mock' : 'live');
  setRefreshSpin(false);
  updateLastRefreshed();

  const banner = document.getElementById('mockBanner');
  if (banner) banner.style.display = isMock ? 'flex' : 'none';
}

function renderAll() {
  renderStats();
  renderBullishTable();
  renderBearishTable();
  renderReversals();
  renderMainTable();
}

/* ─── Market Overview Stats ─── */
function renderStats() {
  const total = allCoins.length;
  const bullishCount = allCoins.filter(c => {
    const tc = trendClass(c.trend);
    return tc === 'bullish' || tc === 'strong-bullish';
  }).length;
  const bearishCount = allCoins.filter(c => {
    const tc = trendClass(c.trend);
    return tc === 'bearish' || tc === 'strong-bearish';
  }).length;
  const neutralCount = total - bullishCount - bearishCount;

  setEl('statTotal', total);
  setEl('statBullish', bullishCount);
  setEl('statBearish', bearishCount);
  setEl('statNeutral', neutralCount);
}

/* ─── Bullish Ranking Table ─── */
function renderBullishTable() {
  const sorted = allCoins
    .filter(c => { const tc = trendClass(c.trend); return tc === 'bullish' || tc === 'strong-bullish'; })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const tbody = document.getElementById('bullishTbody');
  if (!tbody) return;

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">No bullish coins found</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map((c, i) => buildRow(c, i + 1)).join('');
}

/* ─── Bearish Ranking Table ─── */
function renderBearishTable() {
  const sorted = allCoins
    .filter(c => { const tc = trendClass(c.trend); return tc === 'bearish' || tc === 'strong-bearish'; })
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);

  const tbody = document.getElementById('bearishTbody');
  if (!tbody) return;

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">No bearish coins found</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map((c, i) => buildRow(c, i + 1)).join('');
}

/* ─── Build a single table row ─── */
function buildRow(c, rank) {
  const rankCls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  const rsiCls = rsiClass(c.rsi);
  const adxCls = c.adx >= 25 ? 'strong' : 'weak';
  const changeSign = c.change24h >= 0 ? '+' : '';
  const changeColor = c.change24h >= 0 ? 'var(--bullish)' : 'var(--bearish)';

  return `<tr onclick="goToCoin('${c.symbol}')">
    <td><span class="rank-num ${rankCls}">#${rank}</span></td>
    <td>${coinCellHTML(c.sym)}</td>
    <td>${scoreCellHTML(c.score)}</td>
    <td>${trendBadgeHTML(c.trend)}</td>
    <td><span class="price-mono">$${formatPrice(c.price)}</span><br>
        <span style="font-size:10.5px;color:${changeColor};font-family:var(--font-mono)">${changeSign}${c.change24h}%</span></td>
    <td><span class="rsi-val ${rsiCls}">${c.rsi}</span></td>
    <td><span class="adx-val ${adxCls}">${c.adx}</span></td>
    <td>${volBarsHTML(c.volume_strength)}</td>
  </tr>`;
}

/* ─── Reversal Opportunities ─── */
function renderReversals() {
  const reversals = findReversals(allCoins);
  const container = document.getElementById('reversalGrid');
  if (!container) return;

  if (reversals.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">No reversal signals detected</div></div>`;
    return;
  }

  container.innerHTML = reversals.map(c => {
    const tc = trendClass(c.trend);
    const toBull = tc === 'bearish' || (tc === 'neutral' && c.rsi < 50);
    const cls = toBull ? 'to-bull' : 'to-bear';
    const fromColor = toBull ? 'var(--bearish)' : 'var(--bullish)';
    const toColor = toBull ? 'var(--bullish)' : 'var(--bearish)';
    const fromLabel = toBull ? 'Bearish' : 'Bullish';
    const toLabel = toBull ? 'Bullish' : 'Bearish';

    return `<div class="reversal-card ${cls}" onclick="goToCoin('${c.symbol}')">
      <div class="rev-sym">${c.sym}</div>
      <div class="rev-signal">Reversal Signal • RSI ${c.rsi} • ADX ${c.adx}</div>
      <div class="rev-arrow">
        <span style="color:${fromColor};font-weight:700">${fromLabel}</span>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7H12M9 4L12 7L9 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span style="color:${toColor};font-weight:700">${toLabel}</span>
      </div>
    </div>`;
  }).join('');
}

/* ─── Main filtered table ─── */
function renderMainTable() {
  let coins = [...allCoins];

  // Apply filter
  if (activeFilter !== 'all') {
    coins = coins.filter(c => {
      const tc = trendClass(c.trend);
      if (activeFilter === 'strong-bullish') return tc === 'strong-bullish';
      if (activeFilter === 'bullish') return tc === 'bullish' || tc === 'strong-bullish';
      if (activeFilter === 'neutral') return tc === 'neutral';
      if (activeFilter === 'bearish') return tc === 'bearish' || tc === 'strong-bearish';
      if (activeFilter === 'strong-bearish') return tc === 'strong-bearish';
      return true;
    });
  }

  // Apply search
  if (searchTerm) {
    const q = searchTerm.toUpperCase();
    coins = coins.filter(c => c.sym.includes(q) || c.symbol.includes(q));
  }

  // Sort by score desc by default
  if (!sortConfig.col) {
    coins.sort((a, b) => b.score - a.score);
  } else {
    coins = sortCoins(coins, sortConfig.col, sortConfig.dir);
  }

  const tbody = document.getElementById('mainTbody');
  const countEl = document.getElementById('mainTableCount');
  if (countEl) countEl.textContent = `${coins.length} coins`;
  if (!tbody) return;

  if (coins.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">No coins match your filters</div>
    </div></td></tr>`;
    return;
  }

  tbody.innerHTML = coins.map((c, i) => buildRow(c, i + 1)).join('');
  animateRows(tbody);
}

function sortCoins(coins, col, dir) {
  return coins.sort((a, b) => {
    let av = a[col]; let bv = b[col];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function animateRows(tbody) {
  tbody.querySelectorAll('tr').forEach((row, i) => {
    row.style.opacity = '0';
    row.style.transform = 'translateY(4px)';
    setTimeout(() => {
      row.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      row.style.opacity = '1';
      row.style.transform = 'translateY(0)';
    }, i * 15);
  });
}

/* ─── Auto-refresh ─── */
function setupAutoRefresh() {
  const settings = getSettings();
  const interval = (settings.refreshInterval || 60) * 1000;
  countdownSecs = settings.refreshInterval || 60;

  clearInterval(refreshTimer);
  clearInterval(countdownTimer);

  let remaining = countdownSecs;
  const cdEl = document.getElementById('countdown');

  countdownTimer = setInterval(() => {
    remaining--;
    if (cdEl) cdEl.textContent = `${remaining}s`;
    if (remaining <= 0) {
      remaining = countdownSecs;
      loadData();
    }
  }, 1000);
}

/* ─── Bind UI events ─── */
function bindEvents() {
  // Timeframe
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTimeframe = btn.dataset.tf;
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadData();
    });
  });

  // Search
  const searchEl = document.getElementById('searchInput');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      searchTerm = e.target.value.trim();
      renderMainTable();
    });
  }

  // Filter chips
  document.querySelectorAll('.chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      activeFilter = activeFilter === f ? 'all' : f;
      document.querySelectorAll('.chip[data-filter]').forEach(c => {
        c.classList.toggle('active', c.dataset.filter === activeFilter);
      });
      renderMainTable();
    });
  });

  // Manual refresh
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadData();
      // Reset countdown
      clearInterval(countdownTimer);
      setupAutoRefresh();
    });
  }

  // Table column sorting (main table)
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortConfig.col === col) {
        sortConfig.dir = sortConfig.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortConfig.col = col;
        sortConfig.dir = 'desc';
      }
      // Update sort classes
      document.querySelectorAll('th[data-sort]').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(`sort-${sortConfig.dir}`);
      renderMainTable();
    });
  });

  // Mobile sidebar
  const mobileBtn = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (mobileBtn && sidebar && overlay) {
    mobileBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('active');
    });
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
    });
  }
}

/* ─── Helpers ─── */
function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setStatus(state) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  if (!dot || !label) return;
  dot.className = 'status-dot';
  if (state === 'live') { label.textContent = 'Live'; }
  else if (state === 'mock') { dot.classList.add('loading'); label.textContent = 'Mock Data'; }
  else if (state === 'loading') { dot.classList.add('loading'); label.textContent = 'Loading…'; }
  else if (state === 'error') { dot.classList.add('error'); label.textContent = 'Error'; }
}

function setRefreshSpin(on) {
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.classList.toggle('spinning', on);
}

function updateLastRefreshed() {
  const el = document.getElementById('lastUpdated');
  if (el) el.textContent = new Date().toLocaleTimeString();
}

/* ─── Hide loading overlay ─── */
function hideLoader() {
  const el = document.getElementById('loadingOverlay');
  if (el) {
    setTimeout(() => el.classList.add('hide'), 400);
    setTimeout(() => el.remove(), 900);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initDashboard();
  hideLoader();
});
