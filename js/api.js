/* ==========================================
   STOCK SCANNER PRO - API MODULE
   台股/美股 Handles real API calls with mock fallback
   ========================================== */

const API = (() => {

  const TW_STOCKS = [
    { sym:'2330', name:'台積電',   base:870,   market:'TW' },
    { sym:'2317', name:'鴻海',     base:165,   market:'TW' },
    { sym:'2454', name:'聯發科',   base:1285,  market:'TW' },
    { sym:'2308', name:'台達電',   base:295,   market:'TW' },
    { sym:'2881', name:'富邦金',   base:88,    market:'TW' },
    { sym:'2882', name:'國泰金',   base:62,    market:'TW' },
    { sym:'2412', name:'中華電',   base:118,   market:'TW' },
    { sym:'2002', name:'中鋼',     base:28,    market:'TW' },
    { sym:'1301', name:'台塑',     base:82,    market:'TW' },
    { sym:'1303', name:'南亞',     base:68,    market:'TW' },
    { sym:'2886', name:'兆豐金',   base:44,    market:'TW' },
    { sym:'2891', name:'中信金',   base:32,    market:'TW' },
    { sym:'3711', name:'日月光投控', base:145, market:'TW' },
    { sym:'2303', name:'聯電',     base:52,    market:'TW' },
    { sym:'2345', name:'智邦',     base:385,   market:'TW' },
    { sym:'2379', name:'瑞昱',     base:518,   market:'TW' },
    { sym:'2395', name:'研華',     base:342,   market:'TW' },
    { sym:'2408', name:'南亞科',   base:95,    market:'TW' },
    { sym:'2357', name:'華碩',     base:428,   market:'TW' },
    { sym:'2382', name:'廣達',     base:295,   market:'TW' },
    { sym:'3034', name:'聯詠',     base:420,   market:'TW' },
    { sym:'2301', name:'光寶科',   base:88,    market:'TW' },
    { sym:'2327', name:'國巨',     base:1480,  market:'TW' },
    { sym:'5871', name:'中租-KY',  base:195,   market:'TW' },
    { sym:'2207', name:'和泰車',   base:798,   market:'TW' },
  ];

  const US_STOCKS = [
    { sym:'AAPL',  name:'Apple',      base:215,   market:'US' },
    { sym:'MSFT',  name:'Microsoft',  base:415,   market:'US' },
    { sym:'GOOGL', name:'Alphabet',   base:175,   market:'US' },
    { sym:'AMZN',  name:'Amazon',     base:195,   market:'US' },
    { sym:'NVDA',  name:'NVIDIA',     base:875,   market:'US' },
    { sym:'META',  name:'Meta',       base:505,   market:'US' },
    { sym:'TSLA',  name:'Tesla',      base:245,   market:'US' },
    { sym:'TSM',   name:'TSMC',       base:148,   market:'US' },
    { sym:'AVGO',  name:'Broadcom',   base:1485,  market:'US' },
    { sym:'JPM',   name:'JPMorgan',   base:225,   market:'US' },
    { sym:'V',     name:'Visa',       base:285,   market:'US' },
    { sym:'JNJ',   name:'J&J',        base:145,   market:'US' },
    { sym:'WMT',   name:'Walmart',    base:68,    market:'US' },
    { sym:'MA',    name:'Mastercard', base:478,   market:'US' },
    { sym:'PG',    name:'P&G',        base:168,   market:'US' },
    { sym:'AMD',   name:'AMD',        base:152,   market:'US' },
    { sym:'INTC',  name:'Intel',      base:30,    market:'US' },
    { sym:'NFLX',  name:'Netflix',    base:668,   market:'US' },
    { sym:'DIS',   name:'Disney',     base:98,    market:'US' },
    { sym:'PYPL',  name:'PayPal',     base:62,    market:'US' },
  ];

  let _seed = Date.now();

  function seededRand(min, max) {
    _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
    const r = ((_seed >>> 0) / 0xffffffff);
    return min + r * (max - min);
  }

  function rand(min, max) { return Math.random() * (max - min) + min; }
  function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function formatPrice(p, market) {
    if (market === 'US') {
      if (p >= 1000) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return '$' + p.toFixed(2);
    }
    // TW: no dollar sign, comma separators, 1-2 decimal places
    if (p >= 1000) return p.toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return p.toFixed(1);
  }

  function classifySignal(score) {
    if (score >= 75) return '強力買進';
    if (score >= 55) return '買進';
    if (score >= 40) return '觀望';
    if (score >= 25) return '賣出';
    return '強力賣出';
  }

  function getVolumeStrength(vol) {
    if (vol > 70) return '高';
    if (vol > 35) return '中';
    return '低';
  }

  function generateStockData(stock, timeframe) {
    const tfFactor = { '1D': 1, '1W': 1.2, '1M': 1.5, '3M': 2 }[timeframe] || 1;
    const score = Math.min(100, Math.max(0, Math.round(seededRand(5, 95))));
    const signal = classifySignal(score);

    // RSI correlated with signal but with noise
    let rsiBase;
    if (score >= 75) rsiBase = seededRand(58, 82);
    else if (score >= 55) rsiBase = seededRand(50, 72);
    else if (score >= 40) rsiBase = seededRand(38, 62);
    else if (score >= 25) rsiBase = seededRand(28, 50);
    else rsiBase = seededRand(15, 40);
    const rsi = Math.round(Math.min(98, Math.max(2, rsiBase)));

    // ADX correlated with strength
    const adxBase = score >= 75 || score <= 25
      ? seededRand(28, 62)
      : score >= 55 || score <= 40
        ? seededRand(18, 42)
        : seededRand(8, 32);
    const adx = Math.round(adxBase);

    // Price with small random variation
    const priceVariation = seededRand(0.92, 1.08);
    const price = stock.base * priceVariation;

    // Volume (0-100 scale)
    const volume = Math.round(seededRand(5, 100));

    // MA values derived from price
    const ma20  = price * seededRand(0.97, 1.03);
    const ma50  = price * seededRand(0.94, 1.06);
    const ma200 = price * seededRand(0.88, 1.12);

    // Daily change percentage
    const change1d = (seededRand(-8, 8) * tfFactor).toFixed(2);
    const high1d = price * seededRand(1.005, 1.06);
    const low1d  = price * seededRand(0.94, 0.995);

    return {
      symbol:    stock.sym,
      sym:       stock.sym,
      name:      stock.name,
      market:    stock.market,
      signal,
      score,
      price,
      priceStr:  formatPrice(price, stock.market),
      rsi,
      adx,
      volume,
      volumeStr: getVolumeStrength(volume),
      ma20,
      ma50,
      ma200,
      change1d,
      high1d,
      low1d,
    };
  }

  function generateMockData(market = 'TW', timeframe = '1D') {
    _seed = Math.floor(Date.now() / 60000); // Stable within same minute
    let list;
    if (market === 'TW') list = TW_STOCKS;
    else if (market === 'US') list = US_STOCKS;
    else list = [...TW_STOCKS, ...US_STOCKS];
    return list.map(s => generateStockData(s, timeframe));
  }

  async function fetchData(endpoint, market, timeframe) {
    try {
      const url = `${endpoint}?market=${market}&timeframe=${timeframe}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      // Normalize API response
      return raw.map(item => ({
        symbol:    item.symbol || item.sym || 'UNKNOWN',
        sym:       item.sym || item.symbol || 'UNKNOWN',
        name:      item.name || item.sym || 'Unknown',
        market:    item.market || market,
        signal:    item.signal || classifySignal(item.score || 50),
        score:     item.score  || 50,
        price:     item.price  || 0,
        priceStr:  formatPrice(item.price || 0, item.market || market),
        rsi:       item.rsi   || 50,
        adx:       item.adx   || 20,
        volume:    item.volume || 50,
        volumeStr: getVolumeStrength(item.volume || 50),
        ma20:      item.ma20  || (item.price * 0.99) || 0,
        ma50:      item.ma50  || (item.price * 0.97) || 0,
        ma200:     item.ma200 || (item.price * 0.92) || 0,
        change1d:  item.change1d || '0.00',
        high1d:    item.high1d || item.price || 0,
        low1d:     item.low1d  || item.price || 0,
      }));
    } catch (e) {
      console.warn('[API] Using mock data:', e.message);
      return null;
    }
  }

  async function testConnection(endpoint) {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 4000);
      const resp = await fetch(endpoint, { signal: controller.signal });
      return resp.ok;
    } catch {
      return false;
    }
  }

  return { fetchData, generateMockData, classifySignal, formatPrice, testConnection };

})();
