/* ============================================================
   api.js — API 集成 & 幣安實時數據引擎
   ============================================================ */

const DEFAULT_PAIRS = [
  { s: 'AAVE/USDT',     p: 100        }, { s: 'ACH/USDT',      p: 0.02       },
  { s: 'ADA/USDT',      p: 0.5        }, { s: 'AERO/USDT',     p: 1.5        },
  { s: 'AKRO/USDT',     p: 0.005      }, { s: 'ALDT/USDT',     p: 0.1        },
  { s: 'ALGO/USDT',     p: 0.18       }, { s: 'AL/USDT',       p: 0.1        },
  { s: 'AN/USDT',       p: 0.05       }, { s: 'APE/USDT',      p: 1.2        },
  { s: 'ARB/USDT',      p: 0.88       }, { s: 'ARC/USDT',      p: 0.1        },
  { s: 'ATOM/USDT',     p: 8          }, { s: 'AVAX/USDT',     p: 38         },
  { s: 'AXS/USDT',      p: 7          }, { s: 'BALANCER/USDT', p: 3          },
  { s: 'BCH/USDT',      p: 380        }, { s: 'BLUR/USDT',     p: 0.18       },
  { s: 'BNB/USDT',      p: 580        }, { s: 'BONK/USDT',     p: 0.000025   },
  { s: 'BTC/USDT',      p: 65000      }, { s: 'BUSD/USDT',     p: 1          },
  { s: 'CAKE/USDT',     p: 2.6        }, { s: 'CELO/USDT',     p: 0.56       },
  { s: 'CHZ/USDT',      p: 0.085      }, { s: 'COMP/USDT',     p: 55         },
  { s: 'COTI/USDT',     p: 0.08       }, { s: 'CRV/USDT',      p: 0.38       },
  { s: 'CVX/USDT',      p: 2.8        }, { s: 'DAI/USDT',      p: 1          },
  { s: 'DUSK/USDT',     p: 0.12       }, { s: 'DYDX/USDT',     p: 1.42       },
  { s: 'EDU/USDT',      p: 0.35       }, { s: 'EGLD/USDT',     p: 35         },
  { s: 'ENA/USDT',      p: 0.45       }, { s: 'EOS/USDT',      p: 0.82       },
  { s: 'ETC/USDT',      p: 20         }, { s: 'ETH/USDT',      p: 3500       },
  { s: 'FET/USDT',      p: 1.65       }, { s: 'FIL/USDT',      p: 5.9        },
  { s: 'FLOKI/USDT',    p: 0.000185   }, { s: 'FTM/USDT',      p: 0.72       },
  { s: 'GALA/USDT',     p: 0.028      }, { s: 'GMX/USDT',      p: 22         },
  { s: 'GTC/USDT',      p: 0.8        }, { s: 'HBAR/USDT',     p: 0.07       },
  { s: 'ICP/USDT',      p: 12.5       }, { s: 'IMX/USDT',      p: 1.65       },
  { s: 'INJ/USDT',      p: 24         }, { s: 'IOST/USDT',     p: 0.008      },
  { s: 'JUMP/USDT',     p: 0.02       }, { s: 'JUP/USDT',      p: 0.55       },
  { s: 'KCS/USDT',      p: 10         }, { s: 'KNC/USDT',      p: 0.68       },
  { s: 'LENDO/USDT',    p: 0.1        }, { s: 'LEVER/USDT',    p: 0.001      },
  { s: 'LINK/USDT',     p: 14.5       }, { s: 'LOOKS/USDT',    p: 0.05       },
  { s: 'LTC/USDT',      p: 82         }, { s: 'LUNA/USDT',     p: 0.5        },
  { s: 'LUNC/USDT',     p: 0.00008    }, { s: 'MANA/USDT',     p: 0.38       },
  { s: 'MASK/USDT',     p: 2.5        }, { s: 'MKR/USDT',      p: 1650       },
  { s: 'MOVE/USDT',     p: 0.5        }, { s: 'NEAR/USDT',     p: 5.6        },
  { s: 'NEO/USDT',      p: 12         }, { s: 'NOT/USDT',      p: 0.006      },
  { s: 'ONT/USDT',      p: 0.21       }, { s: 'OP/USDT',       p: 1.72       },
  { s: 'ORDI/USDT',     p: 35         }, { s: 'PEPE/USDT',     p: 0.0000088  },
  { s: 'PY/USDT',       p: 0.38       }, { s: 'QNT/USDT',      p: 80         },
  { s: 'RAYS/USDT',     p: 2.5        }, { s: 'RSR/USDT',      p: 0.008      },
  { s: 'SAND/USDT',     p: 0.42       }, { s: 'SEI/USDT',      p: 0.38       },
  { s: 'SNX/USDT',      p: 2.8        }, { s: 'SOL/USDT',      p: 170        },
  { s: 'STX/USDT',      p: 1.85       }, { s: 'SUI/USDT',      p: 1.52       },
  { s: 'TAO/USDT',      p: 350        }, { s: 'THEA/USDT',     p: 0.5        },
  { s: 'THETA/USDT',    p: 1.65       }, { s: 'TRB/USDT',      p: 60         },
  { s: 'TUSD/USDT',     p: 1          }, { s: 'UNI/USDT',      p: 10.2       },
  { s: 'USDC/USDT',     p: 1          }, { s: 'VET/USDT',      p: 0.035      },
  { s: 'WAVES/USDT',    p: 2.1        }, { s: 'WBTC/USDT',     p: 65000      },
  { s: 'XEC/USDT',      p: 0.00003    }, { s: 'XLM/USDT',      p: 0.12       },
  { s: 'XRP/USDT',      p: 0.62       }, { s: 'XTZ/USDT',      p: 0.8        },
  { s: 'YFI/USDT',      p: 6800       }, { s: 'ZEC/USDT',      p: 29         },
  { s: 'ZETA/USDT',     p: 0.5        }, { s: 'ZRX/USDT',      p: 0.41       },
];

/* ═══════════════════ 自定義幣種管理 ═══════════════════════ */
const PAIRS_KEY = 'csp_pairs';

function loadPairs() {
  try {
    const raw = localStorage.getItem(PAIRS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
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
          momentum: 0, strength: 20, macdHist: 0, change24h: 0,
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
      change24h: item.change24h ?? 0,
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
        volAI:     tf === '1h' ? analyzeVolumeAI(raw) : undefined,
        vp:        (tf === '1h' || tf === '4h') ? computeVolumeProfile(raw) : undefined,
      };
    }
  }));

  return out;
}

/* ── 巨鯨行為模式分析 ─────────────────────────────────────── */
function analyzeWhalePattern(whale) {
  if (!whale || whale.total === 0) return null;
  const { buyPct, bigBuyCount, bigSellCount, netFlow } = whale;
  const sellPct = 100 - buyPct;

  let pattern, strength, label, color;
  if (buyPct > 72 && bigBuyCount >= 5) {
    pattern = 'accumulation'; strength = Math.min(95, Math.round(buyPct * 0.9));
    label = `強力吸籌`; color = 'var(--bull)';
  } else if (sellPct > 72 && bigSellCount >= 5) {
    pattern = 'distribution'; strength = Math.min(95, Math.round(sellPct * 0.9));
    label = `主動出貨`; color = 'var(--bear)';
  } else if (buyPct > 60 && bigBuyCount >= 3) {
    pattern = 'light_buy'; strength = Math.round(buyPct * 0.7);
    label = `溫和吸籌`; color = 'var(--bull)';
  } else if (sellPct > 60 && bigSellCount >= 3) {
    pattern = 'light_sell'; strength = Math.round(sellPct * 0.7);
    label = `溫和出貨`; color = 'var(--bear)';
  } else {
    pattern = 'neutral'; strength = 50;
    label = `多空均衡`; color = 'var(--text3)';
  }

  return { pattern, strength, label, color, buyPct, sellPct: parseFloat(sellPct.toFixed(1)), bigBuyCount, bigSellCount, netFlow };
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

function buildTelegramText(coin, direction, setup, macro) {
  const isLong = direction === 'long';
  const icon   = isLong ? '▲' : '▼';
  const dirTx  = isLong ? '做多（Long）' : '做空（Short）';
  const time   = new Date().toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const sym    = coin.symbol.replace('/USDT','').replace('USDT','');

  const p = parseFloat(coin.price) || 1;
  const fmt = v => {
    if (!v && v !== 0) return '--';
    return p >= 1000 ? v.toFixed(1) : p >= 1 ? v.toFixed(3) : v.toFixed(6);
  };
  const pct = (a, b) => {
    const d = ((b - a) / Math.abs(a) * 100);
    return (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
  };

  let msg = `🚨 <b>加密掃描 Pro — 交易信號</b>\n\n`;
  msg += `${icon} <b>${dirTx}：${coin.symbol}</b>\n`;
  msg += `📊 評分 <b>${coin.score}</b>/100 ｜ RSI <b>${coin.rsi}</b> ｜ ADX <b>${coin.adx}</b>\n\n`;

  if (setup) {
    if (setup.conf) {
      msg += `📶 信號強度：<b>${setup.conf}%</b>\n\n`;
    }
    const reasonLines = (setup.entryReason || '').split('，').filter(Boolean).map(r => `   • ${r}`).join('\n');
    msg += `📍 <b>進場：$${fmt(setup.entry)}</b>\n`;
    msg += `${reasonLines || '   • 多重信號共振'}\n\n`;

    const tp1Pct = pct(setup.entry, setup.tp1);
    msg += `🎯 <b>止盈一：$${fmt(setup.tp1)}</b>  (${tp1Pct} | R:R ${setup.rr1}:1)\n`;
    msg += `   ↳ ${setup.tp1Reason}\n\n`;

    const tp2Pct = pct(setup.entry, setup.tp2);
    msg += `🚀 <b>止盈二：$${fmt(setup.tp2)}</b>  (${tp2Pct} | R:R ${setup.rr2}:1)\n`;
    msg += `   ↳ ${setup.tp2Reason}\n\n`;

    const slPct = pct(setup.entry, setup.sl);
    msg += `🛑 <b>止損：$${fmt(setup.sl)}</b>  (${slPct})\n`;
    msg += `   ↳ ${setup.slReason}\n\n`;
  } else {
    msg += `💰 現價：<b>$${coin.price}</b>  ｜  趨勢：${coin.trend}\n\n`;
  }

  if (macro) {
    const parts = [];
    if (macro.marketCapChange != null)
      parts.push(`市值 ${macro.marketCapChange > 0 ? '+' : ''}${macro.marketCapChange}%`);
    if (macro.btcDominance)
      parts.push(`BTC 佔比 ${macro.btcDominance}%`);
    if (macro.fg?.value)
      parts.push(`F&G ${macro.fg.value}（${macro.fg.value_classification || ''}）`);
    if (parts.length) msg += `🌐 宏觀：${parts.join(' ｜ ')}\n\n`;
  }

  msg += `⏰ ${time}\n`;
  msg += `#${sym} #crypto #${isLong ? 'long' : 'short'}`;
  return msg;
}

/* ── 巨鯨偵測（大額現貨成交，不顯示，僅用於多空分析）────────── */
async function fetchWhaleTrades(symbol) {
  const sym = symbol.replace('/', '').replace('USDT', '') + 'USDT';
  for (const host of BINANCE_HOSTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch(`${host}/api/v3/aggTrades?symbol=${sym}&limit=500`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const trades = await res.json();
      if (!Array.isArray(trades) || trades.length === 0) return null;

      const price = parseFloat(trades[trades.length - 1]?.p) || 1;
      // 動態門檻：依幣價決定「巨鯨」最低成交額
      const threshold = price > 10000 ? 500000
        : price > 1000 ? 100000
        : price > 10   ? 30000
        : 5000;

      let buyVol = 0, sellVol = 0, bigBuyCount = 0, bigSellCount = 0;
      for (const tr of trades) {
        const val = parseFloat(tr.p) * parseFloat(tr.q);
        if (val < threshold) continue;
        // m=true 表示主動賣出（maker 是買方），m=false 表示主動買入
        if (!tr.m) { buyVol += val; bigBuyCount++; }
        else        { sellVol += val; bigSellCount++; }
      }

      const total  = buyVol + sellVol;
      if (total === 0) return null;
      const buyPct = buyVol / total * 100;
      const bias   = buyPct > 60 ? 'bull' : buyPct < 40 ? 'bear' : 'neutral';
      return {
        buyVol, sellVol, total,
        buyPct:      parseFloat(buyPct.toFixed(1)),
        netFlow:     buyVol - sellVol,
        bias,
        bigBuyCount, bigSellCount,
        threshold,
      };
    } catch { continue; }
  }
  return null;
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
