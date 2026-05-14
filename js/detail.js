/* ============================================================
   CRYPTO SCANNER PRO — Coin Detail Page
   ============================================================ */

let detailCoin = null;
let tvWidget = null;

async function initDetail() {
  const params = new URLSearchParams(window.location.search);
  const symbol = params.get('symbol') || 'BTC/USDT';
  const tf = params.get('tf') || getSettings().defaultTimeframe || '15m';

  const { data } = await fetchMarketData(tf);
  detailCoin = data.find(c => c.symbol === symbol || c.sym === symbol.replace('/USDT', ''));

  if (!detailCoin) {
    document.getElementById('coinContent').innerHTML = `
      <a href="index.html" class="back-link">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Back to Dashboard
      </a>
      <div class="section-card" style="padding:48px;text-align:center">
        <div style="font-size:48px;margin-bottom:12px">🔍</div>
        <div style="color:var(--text-muted)">Coin not found: ${symbol}</div>
      </div>`;
    hideLoader();
    return;
  }

  renderDetailHeader();
  renderMetrics();
  renderAnalysis();
  initTradingViewChart(detailCoin.sym, tf);
  bindDetailEvents(tf, data);
}

function renderDetailHeader() {
  const c = detailCoin;
  const tc = trendClass(c.trend);
  const changeSign = c.change24h >= 0 ? '+' : '';
  const changeClass = c.change24h >= 0 ? 'pos' : 'neg';
  const sym = c.sym;

  document.getElementById('detailAvatar').textContent = sym.length > 4 ? sym.slice(0, 3) : sym;
  document.getElementById('detailSymbol').textContent = sym;
  document.getElementById('detailPair').textContent = `${sym}/USDT • Binance`;
  document.getElementById('detailTrendBadge').innerHTML = trendBadgeHTML(c.trend);
  document.getElementById('detailPrice').textContent = `$${formatPrice(c.price)}`;
  document.getElementById('detailChange').className = `detail-change ${changeClass}`;
  document.getElementById('detailChange').textContent = `${changeSign}${c.change24h}% (24h)`;
  document.getElementById('detailScore').textContent = c.score;
  document.getElementById('detailScoreBar').style.width = `${c.score}%`;
  document.getElementById('detailScoreBar').style.background = scoreColor(c.score);

  // Glowing accent on header based on trend
  const headerCard = document.getElementById('detailHeader');
  if (headerCard) {
    const colors = {
      'strong-bullish': 'rgba(0,255,163,0.07)',
      bullish: 'rgba(16,185,129,0.06)',
      neutral: 'rgba(245,158,11,0.06)',
      bearish: 'rgba(239,68,68,0.06)',
      'strong-bearish': 'rgba(255,34,85,0.07)'
    };
    headerCard.style.background = `${colors[tc] || 'var(--bg-card)'}`;
  }
}

function renderMetrics() {
  const c = detailCoin;

  const rsiCls = rsiClass(c.rsi);
  const rsiColors = { overbought: 'var(--bearish)', oversold: 'var(--bullish)', neutral: 'var(--neutral)', normal: 'var(--text-primary)' };
  const rsiColor = rsiColors[rsiCls] || 'var(--text-primary)';
  const rsiLabel = { overbought: 'Overbought', oversold: 'Oversold', neutral: 'Approaching Level', normal: 'Normal Range' }[rsiCls] || '';

  setElHTML('rsiValue', `<span style="color:${rsiColor}">${c.rsi}</span>`);
  setElHTML('rsiLabel', rsiLabel);
  document.getElementById('rsiBar').style.width = `${c.rsi}%`;
  document.getElementById('rsiBar').style.background = rsiColor;

  const adxColor = c.adx >= 25 ? 'var(--accent-light)' : 'var(--text-muted)';
  const adxLabel = c.adx >= 40 ? 'Very Strong' : c.adx >= 25 ? 'Strong' : c.adx >= 15 ? 'Moderate' : 'Weak';
  setElHTML('adxValue', `<span style="color:${adxColor}">${c.adx}</span>`);
  setElHTML('adxLabel', adxLabel);
  document.getElementById('adxBar').style.width = `${Math.min(100, c.adx * 1.5)}%`;
  document.getElementById('adxBar').style.background = adxColor;

  const volColor = { High: 'var(--bullish)', Normal: 'var(--accent-light)', Low: 'var(--bearish)' }[c.volume_strength] || 'var(--text-primary)';
  setElHTML('volValue', `<span style="color:${volColor}">${c.volume_strength || '—'}</span>`);
  const volPct = { High: 80, Normal: 50, Low: 20 }[c.volume_strength] || 50;
  document.getElementById('volBar').style.width = `${volPct}%`;
  document.getElementById('volBar').style.background = volColor;

  setEl('ema20Value', `$${formatPrice(c.ema20)}`);
  setEl('ema50Value', `$${formatPrice(c.ema50)}`);
  setEl('ema200Value', `$${formatPrice(c.ema200)}`);

  // EMA alignment color
  const emaOk = c.ema20 > c.ema50 && c.ema50 > c.ema200;
  const emaBad = c.ema20 < c.ema50 && c.ema50 < c.ema200;
  const emaColor = emaOk ? 'var(--bullish)' : emaBad ? 'var(--bearish)' : 'var(--neutral)';
  document.getElementById('ema20Value').style.color = emaColor;
}

function renderAnalysis() {
  const c = detailCoin;
  const tc = trendClass(c.trend);

  // Trend analysis
  const trendReasons = buildTrendReason(c, tc);
  setEl('trendVerdict', trendReasons.verdict);
  setEl('trendExplanation', trendReasons.explanation);

  // Support/Resistance
  setEl('supportLevel', `$${formatPrice(c.support)}`);
  setEl('resistanceLevel', `$${formatPrice(c.resistance)}`);
  const midRange = (c.support + c.resistance) / 2;
  const posInRange = c.price > midRange ? 'Upper half' : 'Lower half';
  setEl('rangePosition', posInRange);
  const riskReward = ((c.resistance - c.price) / (c.price - c.support)).toFixed(2);
  setEl('riskReward', isFinite(riskReward) ? `${riskReward}:1` : '—');

  // Momentum
  const momentumColor = { Strong: 'var(--bullish)', Moderate: 'var(--neutral)', Weak: 'var(--bearish)' }[c.momentum] || 'var(--text-primary)';
  setElHTML('momentumStrength', `<span style="color:${momentumColor};font-weight:700">${c.momentum}</span>`);
  const macdSignal = tc === 'bullish' || tc === 'strong-bullish' ? 'Bullish Cross' : tc === 'bearish' || tc === 'strong-bearish' ? 'Bearish Cross' : 'Flat / No Signal';
  setEl('macdSignal', macdSignal);
  const bbPos = c.rsi > 60 ? 'Near Upper Band' : c.rsi < 40 ? 'Near Lower Band' : 'Within Bands';
  setEl('bbandsPos', bbPos);

  // Market Strength
  const trendStrength = c.adx >= 40 ? 'Extreme' : c.adx >= 25 ? 'Strong' : c.adx >= 15 ? 'Moderate' : 'Weak';
  setEl('mktStrength', trendStrength);
  setEl('mktADX', c.adx);
  setEl('mktTrend', trendLabel(c.trend));
  const volSignal = c.volume_strength === 'High' && (tc === 'bullish' || tc === 'strong-bullish') ? 'Bullish Confirmation' :
    c.volume_strength === 'High' && (tc === 'bearish' || tc === 'strong-bearish') ? 'Bearish Confirmation' :
    c.volume_strength === 'Low' ? 'Weak Participation' : 'Average Participation';
  setEl('mktVolSignal', volSignal);

  // Risk
  const riskColor = { Low: 'var(--bullish)', Medium: 'var(--neutral)', High: 'var(--bearish)' }[c.risk] || 'var(--text-primary)';
  setElHTML('riskLevel', `<span class="risk-pill ${c.risk.toLowerCase()}">${c.risk} Risk</span>`);
  const stopLoss = formatPrice(c.price * (tc.includes('bull') ? 0.95 : 1.05));
  const takeProfit = formatPrice(c.price * (tc.includes('bull') ? 1.08 : 0.93));
  setEl('stopLoss', `$${stopLoss}`);
  setEl('takeProfit', `$${takeProfit}`);
  const posSize = c.risk === 'High' ? 'Reduce position size' : c.risk === 'Medium' ? 'Standard position' : 'Can increase allocation';
  setEl('positionSize', posSize);
}

function buildTrendReason(c, tc) {
  const reasons = [];
  if (c.rsi > 60) reasons.push(`RSI ${c.rsi} shows bullish momentum`);
  else if (c.rsi < 40) reasons.push(`RSI ${c.rsi} shows bearish pressure`);
  else reasons.push(`RSI ${c.rsi} is in neutral territory`);

  if (c.adx >= 25) reasons.push(`ADX ${c.adx} confirms a strong trend`);
  else reasons.push(`ADX ${c.adx} indicates a weak/choppy trend`);

  if (c.ema20 > c.ema50) reasons.push(`EMA20 above EMA50 — short-term uptrend`);
  else if (c.ema20 < c.ema50) reasons.push(`EMA20 below EMA50 — short-term downtrend`);

  if (c.volume_strength === 'High') reasons.push(`High volume confirms the move`);
  else if (c.volume_strength === 'Low') reasons.push(`Low volume — potential lack of conviction`);

  const verdictText = {
    'strong-bullish': 'Strongly Bullish — All signals aligned upward',
    bullish: 'Bullish — Most indicators favour buyers',
    neutral: 'Neutral — Market indecision, wait for breakout',
    bearish: 'Bearish — Most indicators favour sellers',
    'strong-bearish': 'Strongly Bearish — All signals aligned downward'
  }[tc] || 'Neutral';

  return { verdict: verdictText, explanation: reasons.join('. ') + '.' };
}

/* ─── TradingView Widget ─── */
function initTradingViewChart(sym, tf) {
  const container = document.getElementById('tvChart');
  if (!container) return;

  const tvSym = `BINANCE:${sym}USDT`;
  const intervalMap = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
  const interval = intervalMap[tf] || '15';

  container.innerHTML = '';

  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/tv.js';
  script.onload = () => {
    try {
      new TradingView.widget({
        container_id: 'tvChart',
        symbol: tvSym,
        interval,
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: '#0d1017',
        enable_publishing: false,
        allow_symbol_change: true,
        save_image: false,
        hide_side_toolbar: false,
        studies: ['RSI@tv-basicstudies', 'MASimple@tv-basicstudies'],
        width: '100%',
        height: 480,
        backgroundColor: '#080a0f',
        gridColor: 'rgba(255,255,255,0.04)',
      });
    } catch (e) {
      container.innerHTML = `<div style="height:480px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);flex-direction:column;gap:8px">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M3 17L9 11L13 15L21 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div style="font-size:13px">TradingView chart unavailable in this environment.</div>
        <div style="font-size:11px;color:var(--text-muted)">Chart requires an internet connection.</div>
      </div>`;
    }
  };
  script.onerror = () => {
    container.innerHTML = `<div style="height:480px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);flex-direction:column;gap:10px">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M3 17L9 11L13 15L21 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M19 7H21V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <div style="font-size:13px">TradingView chart unavailable</div>
      <a href="https://www.tradingview.com/chart/?symbol=${tvSym}" target="_blank" style="color:var(--accent-light);font-size:12px;text-decoration:none">Open on TradingView ↗</a>
    </div>`;
  };
  document.head.appendChild(script);
}

function bindDetailEvents(tf, allData) {
  // Timeframe buttons
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tf === tf);
    btn.addEventListener('click', () => {
      const newTf = btn.dataset.tf;
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const sym = new URLSearchParams(window.location.search).get('symbol') || 'BTC/USDT';
      window.location.href = `coin-detail.html?symbol=${encodeURIComponent(sym)}&tf=${newTf}`;
    });
  });

  // Mobile nav
  const mobileBtn = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (mobileBtn && sidebar && overlay) {
    mobileBtn.addEventListener('click', () => { sidebar.classList.toggle('open'); overlay.classList.toggle('active'); });
    overlay.addEventListener('click', () => { sidebar.classList.remove('open'); overlay.classList.remove('active'); });
  }
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setElHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
function hideLoader() {
  const el = document.getElementById('loadingOverlay');
  if (el) { setTimeout(() => el.classList.add('hide'), 300); setTimeout(() => el.remove(), 800); }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initDetail();
  hideLoader();
});
