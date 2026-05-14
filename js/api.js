/* ============================================================
   CRYPTO SCANNER PRO — API & Data Layer
   ============================================================ */

const API_URL = 'http://127.0.0.1:8000/scan';

const SETTINGS_KEY = 'csp_settings';
const DEFAULT_SETTINGS = {
  defaultTimeframe: '15m',
  refreshInterval: 60,
  darkMode: true,
  apiUrl: 'http://127.0.0.1:8000',
  showVolume: true,
  compactMode: false
};

// 100 Binance USDT pairs
const COIN_SYMBOLS = [
  'BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOGE','DOT','MATIC',
  'LINK','UNI','ATOM','LTC','BCH','ETC','ALGO','XLM','VET','ICP',
  'FIL','THETA','TRX','FTM','NEAR','ONE','HBAR','EGLD','ROSE','ENJ',
  'MANA','SAND','AXS','GALA','FLOW','IMX','CHZ','CRV','COMP','AAVE',
  'MKR','SNX','YFI','SUSHI','1INCH','LRC','ZRX','GRT','DYDX','OCEAN',
  'FET','BAND','STX','CELO','IOTA','QTUM','ZIL','WAVES','KNC','BAL',
  'API3','SKL','KLAY','ICX','ONT','SC','RVN','ZEC','DASH','NANO',
  'XEM','DGB','LSK','ANKR','SFP','MTL','ALICE','TLM','DENT','HOT',
  'WIN','BTT','REEF','CELR','STORJ','COTI','PERP','RUNE','INJ','AR',
  'MASK','GMT','APT','OP','ARB','SUI','SEI','TIA','JUP','WIF'
];

const BASE_PRICES = {
  BTC:67200,ETH:3510,BNB:582,SOL:172,XRP:0.623,ADA:0.481,AVAX:38.4,DOGE:0.183,
  DOT:8.55,MATIC:0.924,LINK:14.6,UNI:11.3,ATOM:9.85,LTC:86.2,BCH:524,ETC:28.3,
  ALGO:0.221,XLM:0.132,VET:0.0454,ICP:12.6,FIL:6.82,THETA:2.42,TRX:0.121,
  FTM:0.684,NEAR:6.24,ONE:0.0184,HBAR:0.112,EGLD:42.3,ROSE:0.112,ENJ:0.384,
  MANA:0.481,SAND:0.523,AXS:8.24,GALA:0.0484,FLOW:0.954,IMX:2.12,CHZ:0.122,
  CRV:0.553,COMP:68.4,AAVE:95.6,MKR:2820,SNX:2.82,YFI:6840,SUSHI:1.21,
  '1INCH':0.452,LRC:0.281,ZRX:0.483,GRT:0.222,DYDX:2.12,OCEAN:0.954,
  FET:2.41,BAND:1.82,STX:2.22,CELO:0.882,IOTA:0.222,QTUM:3.52,ZIL:0.0282,
  WAVES:2.82,KNC:0.682,BAL:3.22,API3:2.82,SKL:0.0452,KLAY:0.222,ICX:0.282,
  ONT:0.182,SC:0.00582,RVN:0.0282,ZEC:25.2,DASH:32.4,NANO:1.12,XEM:0.0382,
  DGB:0.0122,LSK:1.52,ANKR:0.0482,SFP:0.682,MTL:1.82,ALICE:0.882,TLM:0.0282,
  DENT:0.00182,HOT:0.00252,WIN:0.0000852,BTT:0.00000122,REEF:0.00352,
  CELR:0.0182,STORJ:0.552,COTI:0.0952,PERP:0.882,RUNE:5.82,INJ:28.2,
  AR:38.2,MASK:3.22,GMT:0.222,APT:8.52,OP:2.82,ARB:1.22,SUI:1.82,
  SEI:0.582,TIA:8.22,JUP:0.852,WIF:2.22
};

/* ─── Seeded random (deterministic per time window) ─── */
function seededRand(seed) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

/* ─── Generate rich mock data for all 100 coins ─── */
function generateMockData() {
  const timeSeed = Math.floor(Date.now() / (5 * 60 * 1000)); // refreshes every 5 min

  return COIN_SYMBOLS.map((sym, i) => {
    const r = seededRand(timeSeed * 137 + i * 31);
    const r2 = seededRand(timeSeed * 97 + i * 53);
    const r3 = seededRand(timeSeed * 61 + i * 79);

    const score = Math.round(r * 100);

    let trend;
    if (score >= 80) trend = 'Strong Bullish';
    else if (score >= 60) trend = 'Bullish';
    else if (score >= 40) trend = 'Neutral';
    else if (score >= 20) trend = 'Bearish';
    else trend = 'Strong Bearish';

    const basePrice = BASE_PRICES[sym] || 1;
    const priceMult = 0.97 + r2 * 0.06;
    const price = basePrice * priceMult;

    // RSI — bullish coins tend toward higher RSI
    const rsiBase = 30 + r3 * 50;
    const rsiTrend = (score - 50) * 0.35;
    const rsi = Math.min(85, Math.max(15, Math.round(rsiBase + rsiTrend)));

    // ADX — stronger trend = higher ADX
    const adx = Math.min(60, Math.max(10, Math.round(15 + Math.abs(score - 50) * 0.9)));

    const volumeRaw = seededRand(timeSeed * 43 + i * 67);
    let volumeStrength;
    if (volumeRaw > 0.65) volumeStrength = 'High';
    else if (volumeRaw > 0.35) volumeStrength = 'Normal';
    else volumeStrength = 'Low';

    const scorePct = score / 100;
    const ema20 = price * (1 - (0.5 - scorePct) * 0.005);
    const ema50 = price * (1 - (0.5 - scorePct) * 0.012);
    const ema200 = price * (1 - (0.5 - scorePct) * 0.022);

    const support = price * (0.93 + seededRand(timeSeed + i) * 0.03);
    const resistance = price * (1.03 + seededRand(timeSeed + i + 1) * 0.04);

    let risk;
    if (score >= 70 || score <= 30) risk = 'High';
    else if (score >= 55 || score <= 45) risk = 'Medium';
    else risk = 'Low';

    const momentumRaw = seededRand(timeSeed * 23 + i * 41);
    let momentum;
    if (momentumRaw > 0.65) momentum = 'Strong';
    else if (momentumRaw > 0.35) momentum = 'Moderate';
    else momentum = 'Weak';

    const change24h = parseFloat(((score - 50) * 0.15 + (r2 - 0.5) * 3).toFixed(2));

    const fmt = (v) => {
      if (v < 0.0001) return parseFloat(v.toFixed(8));
      if (v < 0.01) return parseFloat(v.toFixed(6));
      if (v < 1) return parseFloat(v.toFixed(5));
      if (v < 10) return parseFloat(v.toFixed(4));
      if (v < 1000) return parseFloat(v.toFixed(2));
      return parseFloat(v.toFixed(1));
    };

    return {
      symbol: `${sym}/USDT`,
      sym,
      trend,
      score,
      price: fmt(price),
      rsi,
      adx,
      volume_strength: volumeStrength,
      ema20: fmt(ema20),
      ema50: fmt(ema50),
      ema200: fmt(ema200),
      support: fmt(support),
      resistance: fmt(resistance),
      risk,
      momentum,
      change24h,
      _isMock: true
    };
  });
}

/* ─── Enrich bare API data with computed fields ─── */
function enrichCoin(raw, index) {
  const sym = raw.symbol.replace('/USDT', '');
  const score = raw.score ?? 50;

  let trend = raw.trend || 'Neutral';

  const rsi = raw.rsi ?? Math.round(30 + Math.abs(score - 50));
  const adx = raw.adx ?? Math.round(15 + Math.abs(score - 50) * 0.8);

  const price = raw.price ?? (BASE_PRICES[sym] || 1);
  const volumeStrength = raw.volume_strength || (score > 60 ? 'High' : score > 40 ? 'Normal' : 'Low');
  const ema20 = raw.ema20 || price * 0.998;
  const ema50 = raw.ema50 || price * 0.993;
  const ema200 = raw.ema200 || price * 0.985;
  const support = raw.support || price * 0.95;
  const resistance = raw.resistance || price * 1.05;
  const risk = raw.risk || (score >= 70 || score <= 30 ? 'High' : score >= 55 ? 'Medium' : 'Low');
  const momentum = raw.momentum || (score > 60 ? 'Strong' : score > 40 ? 'Moderate' : 'Weak');
  const change24h = raw.change24h ?? parseFloat(((score - 50) * 0.1).toFixed(2));

  return {
    ...raw,
    symbol: raw.symbol,
    sym,
    trend,
    score,
    price,
    rsi,
    adx,
    volume_strength: volumeStrength,
    ema20, ema50, ema200, support, resistance, risk, momentum, change24h
  };
}

/* ─── Fetch from real API, fall back to mock ─── */
async function fetchMarketData(timeframe = '15m') {
  const settings = getSettings();
  const url = `${settings.apiUrl || API_URL}?timeframe=${timeframe}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty response');
    return { data: raw.map(enrichCoin), isMock: false };
  } catch (err) {
    console.warn('[CryptoScanner] API unavailable, using mock data:', err.message);
    return { data: generateMockData(), isMock: true };
  }
}

/* ─── Settings helpers ─── */
function getSettings() {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const current = getSettings();
  const updated = { ...current, ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  return updated;
}

/* ─── Number formatting helpers ─── */
function formatPrice(price) {
  if (price === undefined || price === null) return '—';
  if (price < 0.000001) return price.toFixed(8);
  if (price < 0.001) return price.toFixed(6);
  if (price < 0.1) return price.toFixed(5);
  if (price < 1) return price.toFixed(4);
  if (price < 10) return price.toFixed(3);
  if (price < 100) return price.toFixed(2);
  if (price < 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return price.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function trendClass(trend) {
  if (!trend) return 'neutral';
  const t = trend.toLowerCase().replace(/\s+/g, '-');
  if (t.includes('strong-bullish') || t === 'strongbullish') return 'strong-bullish';
  if (t.includes('bullish')) return 'bullish';
  if (t.includes('strong-bearish') || t === 'strongbearish') return 'strong-bearish';
  if (t.includes('bearish')) return 'bearish';
  return 'neutral';
}

function trendLabel(trend) {
  if (!trend) return 'Neutral';
  const t = trend.toLowerCase();
  if (t.includes('strong') && t.includes('bull')) return 'Strong Bullish';
  if (t.includes('bull')) return 'Bullish';
  if (t.includes('strong') && t.includes('bear')) return 'Strong Bearish';
  if (t.includes('bear')) return 'Bearish';
  return 'Neutral';
}

function trendEmoji(trend) {
  const tc = trendClass(trend);
  return { 'strong-bullish': '🚀', bullish: '📈', neutral: '➡️', bearish: '📉', 'strong-bearish': '💥' }[tc] || '➡️';
}

function scoreColor(score) {
  if (score >= 75) return '#00ffa3';
  if (score >= 55) return '#10b981';
  if (score >= 40) return '#f59e0b';
  if (score >= 25) return '#ef4444';
  return '#ff2255';
}

function rsiClass(rsi) {
  if (rsi >= 70) return 'overbought';
  if (rsi <= 30) return 'oversold';
  if (rsi >= 55 || rsi <= 45) return 'neutral';
  return 'normal';
}

function volBarsHTML(strength) {
  const levels = { High: 4, Normal: 3, Low: 1 };
  const lit = levels[strength] || 2;
  const cls = { High: 'high', Normal: '', Low: 'low' }[strength] || '';
  let html = '<div class="vol-bars">';
  for (let i = 1; i <= 4; i++) {
    const h = 4 + i * 2;
    html += `<div class="vol-bar${i <= lit ? ` lit ${cls}` : ''}" style="height:${h}px"></div>`;
  }
  html += `</div><span class="vol-label ${cls.toLowerCase()}">${strength || '—'}</span>`;
  return html;
}

function trendBadgeHTML(trend) {
  const tc = trendClass(trend);
  const lbl = trendLabel(trend);
  const icons = {
    'strong-bullish': '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M4.5 1L8 8H1L4.5 1Z" fill="currentColor"/></svg>',
    bullish: '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 7L4.5 2L8 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    neutral: '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 4.5H8M6 2.5L8 4.5L6 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bearish: '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 2L4.5 7L8 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'strong-bearish': '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M4.5 8L1 1H8L4.5 8Z" fill="currentColor"/></svg>'
  };
  return `<span class="trend-badge ${tc}">${icons[tc] || ''}${lbl}</span>`;
}

function scoreCellHTML(score) {
  const color = scoreColor(score);
  const pct = score;
  return `<div class="score-cell">
    <span class="score-num" style="color:${color}">${score}</span>
    <div class="score-track"><div class="score-fill" style="width:${pct}%;background:${color}"></div></div>
  </div>`;
}

function coinAvatarHTML(sym) {
  const abbr = sym.length > 4 ? sym.slice(0, 3) : sym;
  return `<div class="coin-avatar">${abbr}</div>`;
}

function coinCellHTML(sym) {
  return `<div class="coin-cell">${coinAvatarHTML(sym)}
    <div><div class="coin-sym">${sym}</div><div class="coin-pair">USDT</div></div>
  </div>`;
}

/* ─── Identify reversal coins ─── */
function findReversals(data) {
  return data.filter(c => {
    const tc = trendClass(c.trend);
    if (tc === 'bullish' && c.rsi < 50 && c.adx > 20) return true;
    if (tc === 'bearish' && c.rsi > 50 && c.adx > 20) return true;
    if (tc === 'neutral' && c.adx > 25) return true;
    return false;
  }).slice(0, 12);
}

/* ─── Toast notification ─── */
function showToast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade-out');
    setTimeout(() => t.remove(), 350);
  }, duration);
}

/* ─── Navigate to coin detail ─── */
function goToCoin(symbol) {
  const enc = encodeURIComponent(symbol);
  window.location.href = `coin-detail.html?symbol=${enc}`;
}
