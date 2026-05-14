/* ============================================================
   CRYPTO SCANNER PRO — Market Ranking Page
   ============================================================ */

let rankingData = [];
let rankSort = { col: 'score', dir: 'desc' };
let rankSearch = '';
let rankFilter = 'all';
let rankTimeframe = '15m';
const PAGE_SIZE = 25;
let currentPage = 1;

async function initRanking() {
  const settings = getSettings();
  rankTimeframe = settings.defaultTimeframe || '15m';

  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tf === rankTimeframe);
  });

  await loadRanking();
  bindRankingEvents();
}

async function loadRanking() {
  setRankStatus('loading');
  setRefreshSpin(true);

  const { data, isMock } = await fetchMarketData(rankTimeframe);
  rankingData = data;

  renderRanking();
  setRankStatus(isMock ? 'mock' : 'live');
  setRefreshSpin(false);
  updateLastRefreshed();

  const banner = document.getElementById('mockBanner');
  if (banner) banner.style.display = isMock ? 'flex' : 'none';
}

function renderRanking() {
  let coins = [...rankingData];

  if (rankSearch) {
    const q = rankSearch.toUpperCase();
    coins = coins.filter(c => c.sym.includes(q) || c.symbol.includes(q));
  }

  if (rankFilter !== 'all') {
    coins = coins.filter(c => {
      const tc = trendClass(c.trend);
      if (rankFilter === 'strong-bullish') return tc === 'strong-bullish';
      if (rankFilter === 'bullish') return tc === 'bullish' || tc === 'strong-bullish';
      if (rankFilter === 'neutral') return tc === 'neutral';
      if (rankFilter === 'bearish') return tc === 'bearish' || tc === 'strong-bearish';
      if (rankFilter === 'strong-bearish') return tc === 'strong-bearish';
      return true;
    });
  }

  // Sort
  coins.sort((a, b) => {
    let av = a[rankSort.col]; let bv = b[rankSort.col];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return rankSort.dir === 'asc' ? -1 : 1;
    if (av > bv) return rankSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  // Pagination
  const total = coins.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const paged = coins.slice(start, start + PAGE_SIZE);

  const tbody = document.getElementById('rankTbody');
  if (!tbody) return;

  if (paged.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">No coins match your search</div>
    </div></td></tr>`;
  } else {
    tbody.innerHTML = paged.map((c, i) => buildRankRow(c, start + i + 1)).join('');
    animateRankRows(tbody);
  }

  renderPagination(totalPages);
  setEl('resultCount', `${total} coins`);
}

function buildRankRow(c, rank) {
  const rankCls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  const changeSign = c.change24h >= 0 ? '+' : '';
  const changeColor = c.change24h >= 0 ? 'var(--bullish)' : 'var(--bearish)';
  const adxCls = c.adx >= 25 ? 'strong' : 'weak';

  return `<tr onclick="goToCoin('${c.symbol}')">
    <td><span class="rank-num ${rankCls}">#${rank}</span></td>
    <td>${coinCellHTML(c.sym)}</td>
    <td>
      <span class="price-mono">$${formatPrice(c.price)}</span><br>
      <span style="font-size:10.5px;color:${changeColor};font-family:var(--font-mono)">${changeSign}${c.change24h}%</span>
    </td>
    <td>${trendBadgeHTML(c.trend)}</td>
    <td>${scoreCellHTML(c.score)}</td>
    <td>
      <span class="rsi-val ${rsiClass(c.rsi)}" style="margin-right:4px">${c.rsi}</span>
      <span style="font-size:10px;color:var(--text-muted)">${c.rsi >= 70 ? 'OB' : c.rsi <= 30 ? 'OS' : ''}</span>
    </td>
    <td>${volBarsHTML(c.volume_strength)}</td>
    <td><span class="adx-val ${adxCls}">${c.adx} <span style="font-size:10px;opacity:.6">${c.adx >= 25 ? '●' : '○'}</span></span></td>
  </tr>`;
}

function animateRankRows(tbody) {
  tbody.querySelectorAll('tr').forEach((row, i) => {
    row.style.opacity = '0';
    row.style.transform = 'translateY(4px)';
    setTimeout(() => {
      row.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
      row.style.opacity = '1';
      row.style.transform = 'none';
    }, i * 12);
  });
}

function renderPagination(totalPages) {
  const pag = document.getElementById('pagination');
  if (!pag || totalPages <= 1) { if (pag) pag.innerHTML = ''; return; }

  let html = '';
  const addBtn = (label, page, active = false, disabled = false) => {
    html += `<button class="page-btn${active ? ' active' : ''}" ${disabled ? 'disabled' : ''} onclick="changePage(${page})">${label}</button>`;
  };

  addBtn('‹', currentPage - 1, false, currentPage === 1);

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);

  if (start > 1) { addBtn(1, 1); if (start > 2) html += `<span class="page-btn" style="border:none;background:none;cursor:default">…</span>`; }
  for (let p = start; p <= end; p++) addBtn(p, p, p === currentPage);
  if (end < totalPages) { if (end < totalPages - 1) html += `<span class="page-btn" style="border:none;background:none;cursor:default">…</span>`; addBtn(totalPages, totalPages); }

  addBtn('›', currentPage + 1, false, currentPage === totalPages);
  pag.innerHTML = html;
}

function changePage(page) {
  currentPage = page;
  renderRanking();
  document.getElementById('rankTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindRankingEvents() {
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      rankTimeframe = btn.dataset.tf;
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPage = 1;
      loadRanking();
    });
  });

  const searchEl = document.getElementById('searchInput');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      rankSearch = e.target.value.trim();
      currentPage = 1;
      renderRanking();
    });
  }

  document.querySelectorAll('.chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      rankFilter = rankFilter === f ? 'all' : f;
      document.querySelectorAll('.chip[data-filter]').forEach(c => {
        c.classList.toggle('active', c.dataset.filter === rankFilter);
      });
      currentPage = 1;
      renderRanking();
    });
  });

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (rankSort.col === col) {
        rankSort.dir = rankSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        rankSort.col = col;
        rankSort.dir = 'desc';
      }
      document.querySelectorAll('th[data-sort]').forEach(h => h.classList.remove('sort-asc','sort-desc'));
      th.classList.add(`sort-${rankSort.dir}`);
      currentPage = 1;
      renderRanking();
    });
  });

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadRanking());
  }

  const mobileBtn = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (mobileBtn && sidebar && overlay) {
    mobileBtn.addEventListener('click', () => { sidebar.classList.toggle('open'); overlay.classList.toggle('active'); });
    overlay.addEventListener('click', () => { sidebar.classList.remove('open'); overlay.classList.remove('active'); });
  }

  // Auto refresh
  const settings = getSettings();
  setInterval(() => loadRanking(), (settings.refreshInterval || 60) * 1000);
}

function setRankStatus(state) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  if (!dot || !label) return;
  dot.className = 'status-dot';
  if (state === 'live') { label.textContent = 'Live'; }
  else if (state === 'mock') { dot.classList.add('loading'); label.textContent = 'Mock Data'; }
  else if (state === 'loading') { dot.classList.add('loading'); label.textContent = 'Loading…'; }
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setRefreshSpin(on) {
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.classList.toggle('spinning', on);
}
function updateLastRefreshed() {
  const el = document.getElementById('lastUpdated');
  if (el) el.textContent = new Date().toLocaleTimeString();
}
function hideLoader() {
  const el = document.getElementById('loadingOverlay');
  if (el) { setTimeout(() => el.classList.add('hide'), 300); setTimeout(() => el.remove(), 800); }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initRanking();
  hideLoader();
});
