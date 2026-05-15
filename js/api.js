/* ============================================================
   api.js — API 集成 & 幣安實時數據引擎
   ============================================================ */

const DEFAULT_PAIRS = [
  { s: 'BTC/USDT',   p: 65000  }, { s: 'ETH/USDT',   p: 3500   },
  { s: 'BNB/USDT',   p: 580    }, { s: 'SOL/USDT',   p: 170    },
  { s: 'XRP/USDT',   p: 0.62   }, { s: 'ADA/USDT',   p: 0.48   },
  { s: 'AVAX/USDT',  p: 38     }, { s: 'DOT/USDT',   p: 7.8    },
  { s: 'MATIC/USDT', p: 0.85   }, { s: 'LINK/USDT',  p: 14.5   },
  { s: 'LTC/USDT',   p: 82     }, { s: 'UNI/USDT',   p: 10.2   },
  { s: 'ATOM/USDT',  p: 9.4    }, { s: 'ALGO/USDT',  p: 0.18   },
  { s: 'NEAR/USDT',  p: 5.6    }, { s: 'FIL/USDT',   p: 5.9    },
  { s: 'VET/USDT',   p: 0.035  }, { s: 'ICP/USDT',   p: 12.5   },
  { s: 'THETA/USDT', p: 1.65   }, { s: 'TRX/USDT',   p: 0.125  },
  { s: 'EOS/USDT',   p: 0.82   }, { s: 'XLM/USDT',   p: 0.12   },
  { s: 'FTM/USDT',   p: 0.72   }, { s: 'SAND/USDT',  p: 0.42   },
  { s: 'MANA/USDT',  p: 0.38   }, { s: 'AXS/USDT',   p: 7.2    },
  { s: 'GALA/USDT',  p: 0.028  }, { s: 'ENJ/USDT',   p: 0.32   },
  { s: 'CHZ/USDT',   p: 0.085  }, { s: 'BAT/USDT',   p: 0.22   },
  { s: 'ZEC/USDT',   p: 29     }, { s: 'DASH/USDT',  p: 31     },
  { s: 'XMR/USDT',   p: 148    }, { s: 'WAVES/USDT', p: 2.1    },
  { s: 'NEO/USDT',   p: 12     }, { s: 'QTUM/USDT',  p: 3.2    },
  { s: 'ONT/USDT',   p: 0.21   }, { s: 'ZIL/USDT',   p: 0.018  },
  { s: 'ICX/USDT',   p: 0.19   }, { s: 'CAKE/USDT',  p: 2.6    },
  { s: 'SUSHI/USDT', p: 1.2    }, { s: 'COMP/USDT',  p: 55     },
  { s: 'MKR/USDT',   p: 1650   }, { s: 'AAVE/USDT',  p: 92     },
  { s: 'SNX/USDT',   p: 2.8    }, { s: 'CRV/USDT',   p: 0.38   },
  { s: 'YFI/USDT',   p: 6800   }, { s: 'BAL/USDT',   p: 2.9    },
  { s: 'REN/USDT',   p: 0.058  }, { s: 'KNC/USDT',   p: 0.68   },
  { s: 'ZRX/USDT',   p: 0.41   }, { s: 'STORJ/USDT', p: 0.55   },
  { s: 'GRT/USDT',   p: 0.175  }, { s: 'OCEAN/USDT', p: 0.82   },
  { s: 'FET/USDT',   p: 1.65   }, { s: 'AGIX/USDT',  p: 0.92   },
  { s: 'RNDR/USDT',  p: 7.4    }, { s: 'STX/USDT',   p: 1.85   },
  { s: 'OP/USDT',    p: 1.72   }, { s: 'ARB/USDT',   p: 0.88   },
  { s: 'SUI/USDT',   p: 1.52   }, { s: 'APT/USDT',   p: 8.9    },
  { s: 'SEI/USDT',   p: 0.38   }, { s: 'INJ/USDT',   p: 24     },
  { s: 'TIA/USDT',   p: 6.5    }, { s: 'PYTH/USDT',  p: 0.38   },
  { s: 'JTO/USDT',   p: 2.85   }, { s: 'WIF/USDT',   p: 1.95   },
  { s: 'BONK/USDT',  p: 0.000025  }, { s: 'PEPE/USDT',  p: 0.0000088 },
  { s: 'SHIB/USDT',  p: 0.0000235 }, { s: 'DOGE/USDT',  p: 0.14  },
  { s: 'FLOKI/USDT', p: 0.000185  }, { s: 'MEME/USDT',  p: 0.0082 },
  { s: 'LDO/USDT',   p: 1.82   }, { s: 'RPL/USDT',   p: 18.5   },
  { s: 'FXS/USDT',   p: 3.9    }, { s: 'CVX/USDT',   p: 2.8    },
  { s: 'PENDLE/USDT',p: 3.65   }, { s: 'GMX/USDT',   p: 22     },
  { s: 'GNS/USDT',   p: 1.65   }, { s: 'PERP/USDT',  p: 0.68   },
  { s: 'DYDX/USDT',  p: 1.42   }, { s: 'IMX/USDT',   p: 1.65   },
  { s: 'LRC/USDT',   p: 0.22   }, { s: 'CELO/USDT',  p: 0.56   },
  { s: 'SKL/USDT',   p: 0.048  }, { s: 'ANKR/USDT',  p: 0.035  },
  { s: 'OGN/USDT',   p: 0.12   }, { s: 'NKN/USDT',   p: 0.065  },
  { s: 'CKB/USDT',   p: 0.012  }, { s: 'IOTA/USDT',  p: 0.21   },
  { s: 'BTT/USDT',   p: 0.00000085 }, { s: 'WIN/USDT', p: 0.000058 },
  { s: 'BAND/USDT',  p: 1.42   }, { s: 'SXP/USDT',   p: 0.28   },
  { s: 'AEVO/USDT',  p: 0.82   }, { s: 'RDNT/USDT',  p: 0.065  },
];

/* ═══════════════════ 自定義幣種管理 ═══════════════════════ */
const PAIRS_KEY = 'csp_pairs';

function loadPairs() {
  try {
    const raw = localStorage.getItem(PAIRS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch {}
  return [...DEFAULT_PAIRS];
}

function savePairs(pairs) {
  localStorage.setItem(PAIRS_KEY, JSON.stringify(pairs));
}

function removePairBySymbol(symbol) {
  savePairs(loadPairs().filter(p => p.s !== symbol));
}

function resetToDefaultPairs() {
  localStorage.removeItem(PAIRS_KEY);
}

/* ---------- 偽隨機數（離線備用）---------- */
let _seed = Date.now();
function seededRand() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
  return ((_seed >>> 0) / 0xffffffff);
}
function randRange(min, max) { return min + seededRand() * (max - min); }
function randInt(min, max)   { return Math.floor(randRange(min, max + 1)); }
function pick(arr)           { return arr[randInt(0, arr.length - 1)]; }

/* ---------- 評分→趨勢 ---------- */
function scoreToTrend(score) {
  if (score >= 78) return '強勢看漲';
  if (score >= 58) return '看漲';
  if (score >= 42) return '中性';
  if (score >= 22) return '看跌';
  return '強勢看跌';
}

/* ---------- 成交量強度 ---------- */
function getVolStr(vol) {
  if (!vol) return '中';
  if (vol > 500_000_000) return '高';
  if (vol > 50_000_000)  return '中';
  return '低';
}

/* ---------- 時間框架映射 ---------- */
function tfToBinanceInterval(tf) {
  return { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h' }[tf] || '15m';
}

/* ---------- 幣安 API 端點（依序嘗試）---------- */
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

/* ---------- 認證請求頭 ---------- */
function buildHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (apiKey) { h['Authorization'] = `Bearer ${apiKey}`; h['X-API-Key'] = apiKey; }
  return h;
}

/* ═══════════════════ 幣安 K 線引擎 ═══════════════════════ */

/* 獲取單個幣對的 K 線數據（依序嘗試多個端點）*/
async function fetchKlines(symbol, interval, limit = 220) {
  for (const host of BINANCE_HOSTS) {
    const url = `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 400) return null; // 交易對不存在，不再重試
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') continue; // 超時換端點重試
    }
  }
  return null;
}

/* 一次性批量獲取所有現貨即時價格（作為 kline 失敗時的備用）*/
async function fetchAllSpotPrices() {
  const syms = JSON.stringify(loadPairs().map(p => p.s.replace('/', '')));
  for (const host of BINANCE_HOSTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `${host}/api/v3/ticker/price?symbols=${encodeURIComponent(syms)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      const map = {};
      list.forEach(t => { map[t.symbol] = parseFloat(t.price); });
      return map;
    } catch { continue; }
  }
  return {};
}

/* 並行批次獲取所有交易對 K 線，並即時計算技術指標 */
async function fetchAllFromBinance(timeframe) {
  const interval  = tfToBinanceInterval(timeframe);
  const batchSize = 20;
  const pairs     = loadPairs();
  const results   = new Array(pairs.length).fill(null);

  /* 先批量獲取所有現貨即時價格，作為 kline 失敗時的精確備用 */
  if (typeof updateScanProgress === 'function') updateScanProgress(0);
  const spotPrices = await fetchAllSpotPrices();

  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map(pair => fetchKlines(pair.s.replace('/', ''), interval, 220))
    );

    batchResults.forEach((r, j) => {
      const idx  = i + j;
      const pair = pairs[idx];
      const sym  = pair.s.replace('/', '');
      const raw  = r.status === 'fulfilled' ? r.value : null;
      const analysed = raw ? analyzeKlines(pair.s, raw) : null;

      if (analysed) {
        results[idx] = {
          ...analysed,
          trend:          scoreToTrend(analysed.score),
          volumeStrength: getVolStr(analysed.volume),
        };
      } else {
        /* 優先使用幣安即時現貨價格，無法獲取才退回靜態基準 */
        const fallbackPrice = spotPrices[sym] || pair.p;
        results[idx] = {
          symbol: pair.s, trend: '中性', score: 50,
          price:  fmtPrice(fallbackPrice),
          rsi: 50, adx: 20,
          ema20:  fmtPrice(fallbackPrice * 0.99),
          ema50:  fmtPrice(fallbackPrice * 0.97),
          ema200: fmtPrice(fallbackPrice * 0.90),
          volume: 0, volumeStrength: '中',
          momentum: 0, strength: 20, macdHist: 0,
        };
      }
    });

    /* 通知進度（若 app.js 已定義 updateScanProgress） */
    const pct = Math.min(Math.round(((i + batchSize) / pairs.length) * 100), 100);
    if (typeof updateScanProgress === 'function') updateScanProgress(pct);

    /* 批次間短暫停頓，避免觸發幣安限速 */
    if (i + batchSize < pairs.length) await new Promise(r => setTimeout(r, 80));
  }

  return results;
}

/* ─── 本地 API 數據補全 ─────────────────────────────────── */
function enrichData(raw) {
  return raw.map(item => {
    const price = item.price || 0;
    const score = item.score ?? 50;
    const rsi   = item.rsi   ?? 50;
    const adx   = item.adx   ?? 20;
    const trend = item.trend  ? mapTrendZh(item.trend) : scoreToTrend(score);
    return {
      symbol: item.symbol, trend, score, price, rsi, adx,
      volume:         item.volume         || 0,
      volumeStrength: item.volumeStrength ? mapVolZh(item.volumeStrength) : getVolStr(item.volume),
      ema20:  item.ema20  || fmtPrice(price * 0.99),
      ema50:  item.ema50  || fmtPrice(price * 0.97),
      ema200: item.ema200 || fmtPrice(price * 0.90),
      momentum: item.momentum ?? parseFloat((rsi - 50).toFixed(1)),
      strength: item.strength ?? Math.round(adx),
      macdHist: item.macdHist ?? 0,
    };
  });
}

function mapTrendZh(t) {
  return { 'Strong Bullish':'強勢看漲','Bullish':'看漲','Neutral':'中性','Bearish':'看跌','Strong Bearish':'強勢看跌' }[t] || t;
}
function mapVolZh(v) {
  return { 'High':'高','Medium':'中','Low':'低' }[v] || v;
}

/* ─── 純離線備用（無網路時）──────────────────────────────── */
function generateMockData() {
  _seed = 987654321;
  return loadPairs().map(pair => {
    const priceVar = 0.96 + seededRand() * 0.08;
    const price    = pair.p * priceVar;
    const score    = randInt(5, 95);
    const rsi      = parseFloat(randRange(18, 78).toFixed(1));
    const adx      = parseFloat(randRange(8, 52).toFixed(1));
    return {
      symbol: pair.s, trend: scoreToTrend(score), score,
      price:  fmtPrice(price), rsi, adx,
      ema20:  fmtPrice(price * (0.978 + seededRand() * 0.044)),
      ema50:  fmtPrice(price * (0.945 + seededRand() * 0.11)),
      ema200: fmtPrice(price * (0.82  + seededRand() * 0.36)),
      volume: randInt(1_000_000, 2_000_000_000),
      volumeStrength: pick(['高','中','低']),
      momentum: parseFloat((rsi - 50).toFixed(1)),
      strength: Math.round(adx), macdHist: 0,
    };
  });
}

function fmtPrice(p) {
  if (p >= 1000)  return parseFloat(p.toFixed(2));
  if (p >= 1)     return parseFloat(p.toFixed(4));
  if (p >= 0.001) return parseFloat(p.toFixed(6));
  return parseFloat(p.toFixed(8));
}

/* ═══════════════════ 多週期 & 情緒數據 ══════════════════ */

/* 衍生品合約數據（幣安 Futures API，替代 CoinGlass）*/
async function fetchDerivativesData(symbol) {
  const sym = symbol.replace('/', '');
  const base = 'https://fapi.binance.com';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const [frR, oiR, lsR, topR, tkR] = await Promise.allSettled([
      fetch(`${base}/fapi/v1/fundingRate?symbol=${sym}&limit=1`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : null),
      fetch(`${base}/fapi/v1/openInterest?symbol=${sym}`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : null),
      fetch(`${base}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=2`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : null),
      fetch(`${base}/futures/data/topLongShortAccountRatio?symbol=${sym}&period=5m&limit=2`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : null),
      fetch(`${base}/futures/data/takerlongshortRatio?symbol=${sym}&period=5m&limit=2`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : null),
    ]);
    clearTimeout(t);

    const fr    = frR.status === 'fulfilled' && Array.isArray(frR.value) ? parseFloat(frR.value[0]?.fundingRate) : null;
    const oi    = oiR.status === 'fulfilled' && oiR.value?.openInterest  ? parseFloat(oiR.value.openInterest) : null;
    const ls    = lsR.status === 'fulfilled' && Array.isArray(lsR.value)  ? lsR.value[0] : null;
    const top   = topR.status === 'fulfilled' && Array.isArray(topR.value) ? topR.value[0] : null;
    const taker = tkR.status === 'fulfilled' && Array.isArray(tkR.value)  ? tkR.value[0] : null;

    if (fr === null && oi === null) return null; // 現貨幣種無合約數據

    return {
      fundingRate:      fr ?? 0,
      openInterest:     oi ?? 0,
      longRatio:        ls  ? parseFloat(ls.longAccount)       : null,
      shortRatio:       ls  ? parseFloat(ls.shortAccount)      : null,
      lsRatio:          ls  ? parseFloat(ls.longShortRatio)    : null,
      topLongRatio:     top ? parseFloat(top.longAccount)      : null,
      topShortRatio:    top ? parseFloat(top.shortAccount)     : null,
      topLSRatio:       top ? parseFloat(top.longShortRatio)   : null,
      takerBuySell:     taker ? parseFloat(taker.buySellRatio) : null,
    };
  } catch { return null; }
}

/* 獲取單幣多時間框架 K 線並分析 */
async function fetchMTFKlines(symbol) {
  const base = symbol.replace('/', '');
  const tfs  = ['15m', '1h', '4h', '1d'];
  const out  = {};

  await Promise.allSettled(tfs.map(async tf => {
    const raw = await fetchKlines(base, tf, 100);
    if (raw && raw.length >= 30) {
      out[tf] = {
        signal:    analyzeTimeframeSignal(raw),
        orderFlow: analyzeOrderFlow(raw),
      };
    }
  }));

  return out;
}

/* 恐慌貪婪指數 (alternative.me) */
async function fetchFearGreed() {
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch('https://api.alternative.me/fng/?limit=1', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error();
    return (await res.json()).data[0];
  } catch { return null; }
}

/* 加密貨幣新聞 (CryptoPanic free) */
async function fetchCryptoNews() {
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 7000);
    const res  = await fetch(
      'https://cryptopanic.com/api/free/v1/posts/?auth_token=free&kind=news&filter=hot&public=true',
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!res.ok) throw new Error();
    return ((await res.json()).results || []).slice(0, 8);
  } catch { return []; }
}

/* ── 全球加密貨幣市場數據（CoinGecko 免費）──────────────────── */
async function fetchGlobalMarket() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch('https://api.coingecko.com/api/v3/global', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const { data } = await res.json();
    return {
      btcDominance:   parseFloat((data.market_cap_percentage?.btc || 0).toFixed(1)),
      ethDominance:   parseFloat((data.market_cap_percentage?.eth || 0).toFixed(1)),
      totalMarketCap: data.total_market_cap?.usd || null,
      marketCapChange: parseFloat((data.market_cap_change_percentage_24h_usd || 0).toFixed(2)),
      totalVolume:    data.total_volume?.usd || null,
      activeCryptos:  data.active_cryptocurrencies || null,
    };
  } catch { return null; }
}

/* ── 比特幣區塊高度（mempool.space，用於計算減半倒數）──────── */
async function fetchHalvingInfo() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('https://mempool.space/api/blocks/tip/height', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const height = await res.json();
    const nextHalving  = Math.ceil(height / 210000) * 210000;
    const blocksLeft   = nextHalving - height;
    const daysLeft     = Math.round(blocksLeft * 10 / 1440);
    const halvingCount = Math.floor(height / 210000) + 1;
    const reward       = 3.125 / Math.pow(2, halvingCount - 4); // 從第4次減半後計算
    return { height, nextHalving, blocksLeft, daysLeft, halvingCount };
  } catch { return null; }
}

/* ── Telegram Bot 通知（直接從瀏覽器呼叫，不需後端）────────── */
async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return res.ok;
  } catch { return false; }
}

function buildTelegramText(coin, direction) {
  const isLong  = direction === 'long';
  const icon    = isLong ? '▲' : '▼';
  const dirTx   = isLong ? '做多（Long）' : '做空（Short）';
  const time    = new Date().toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  return `🚨 <b>交易信號提醒</b>

${icon} <b>${dirTx}：${coin.symbol}</b>
📊 綜合評分：<b>${coin.score}</b> / 100
📈 趨勢判斷：${coin.trend}
💰 現價：<b>$${coin.price}</b>
📉 RSI：${coin.rsi} ｜ ADX：${coin.adx}

⏰ ${time}
#${coin.symbol.replace('/USDT','')} #crypto #${isLong ? 'long' : 'short'}`;
}

/* ═══════════════════ 主數據獲取函數 ══════════════════════ */
async function fetchMarketData(timeframe = '15m') {
  const settings = loadSettings();
  const url      = (settings.apiUrl || 'http://127.0.0.1:8000') + '/scan';
  const apiKey   = settings.apiKey  || '';

  /* 1. 優先嘗試本地 API */
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal, headers: buildHeaders(apiKey) });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) throw new Error('空響應');
    console.info('[掃描專家] 使用本地 API 數據');
    return { data: enrichData(json), source: 'api' };
  } catch (err) {
    console.warn('[掃描專家] 本地 API 不可用，切換至幣安 K 線實時分析：', err.message);
  }

  /* 2. 幣安 K 線 + 即時技術指標計算 */
  try {
    const data = await fetchAllFromBinance(timeframe);
    console.info('[掃描專家] 幣安實時 K 線分析完成');
    return { data, source: 'binance' };
  } catch (err) {
    console.warn('[掃描專家] 幣安 K 線獲取失敗，使用離線演示數據：', err.message);
    return { data: generateMockData(), source: 'mock' };
  }
}

/* ═══════════════════ 設置存儲 ═══════════════════════════ */
const SETTINGS_KEY = 'csp_settings';

const DEFAULT_SETTINGS = {
  timeframe:       '15m',
  refreshInterval: 60,
  darkMode:        true,
  reversals:       true,
  sound:           false,
  apiUrl:          'http://127.0.0.1:8000',
  apiKey:          '6bD4UNcdb8wfkHVa3Zd2D4hfsEmcEwtqMBxr2GZe2XFQ2jvdCjT4vtg5cSD4BWcPtV',
  bullThreshold:   60,
  bearThreshold:   40,
  notifBrowser:    false,
  notifTelegram:   false,
  tgToken:         '',
  tgChatId:        '',
  notifBullScore:  65,
  notifBearScore:  35,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
