/* ============================================================
   api.js — API 集成 & 幣安實時數據引擎
   ============================================================ */

const DEFAULT_PAIRS = [
  { s: 'AAVE/USDT',      p: 100        }, { s: 'ACH/USDT',       p: 0.02       },
  { s: 'ADA/USDT',       p: 0.5        }, { s: 'AERO/USDT',      p: 1.5        },
  { s: 'ALGO/USDT',      p: 0.18       }, { s: 'APE/USDT',       p: 1.2        },
  { s: 'APT/USDT',       p: 12         }, { s: 'ARB/USDT',       p: 0.88       },
  { s: 'ARC/USDT',       p: 0.1        }, { s: 'ARPA/USDT',      p: 0.05       },
  { s: 'ATOM/USDT',      p: 8          }, { s: 'AVAX/USDT',      p: 38         },
  { s: 'AXS/USDT',       p: 7          }, { s: 'BCH/USDT',       p: 380        },
  { s: 'BEAMX/USDT',     p: 0.02       }, { s: 'BLUR/USDT',      p: 0.18       },
  { s: 'BNB/USDT',       p: 580        }, { s: 'TON/USDT',       p: 3.2        },
  { s: 'BTC/USDT',       p: 65000      }, { s: 'CAKE/USDT',      p: 2.6        },
  { s: 'CHZ/USDT',       p: 0.085      }, { s: 'COMP/USDT',      p: 55         },
  { s: 'COTI/USDT',      p: 0.08       }, { s: 'CRV/USDT',       p: 0.38       },
  { s: 'CVX/USDT',       p: 2.8        }, { s: 'DUSK/USDT',      p: 0.12       },
  { s: 'EDU/USDT',       p: 0.35       }, { s: 'EGLD/USDT',      p: 35         },
  { s: 'ENA/USDT',       p: 0.45       }, { s: 'ETC/USDT',       p: 20         },
  { s: 'ETH/USDT',       p: 3500       }, { s: 'FET/USDT',       p: 1.65       },
  { s: 'FIL/USDT',       p: 5.9        }, { s: 'FLOKI/USDT',     p: 0.000185   },
  { s: 'GALA/USDT',      p: 0.028      }, { s: 'GMX/USDT',       p: 22         },
  { s: 'GPS/USDT',       p: 0.05       }, { s: 'HBAR/USDT',      p: 0.07       },
  { s: 'HFT/USDT',       p: 0.15       }, { s: 'HMSTR/USDT',     p: 0.003      },
  { s: 'ICP/USDT',       p: 12.5       }, { s: 'IMX/USDT',       p: 1.65       },
  { s: 'INJ/USDT',       p: 24         }, { s: 'IOST/USDT',      p: 0.008      },
  { s: 'JUP/USDT',       p: 0.55       }, { s: 'KNC/USDT',       p: 0.68       },
  { s: 'LINK/USDT',      p: 14.5       }, { s: 'LQTY/USDT',      p: 1.5        },
  { s: 'LTC/USDT',       p: 82         }, { s: 'LUNC/USDT',      p: 0.00008    },
  { s: 'MANA/USDT',      p: 0.38       }, { s: 'MASK/USDT',      p: 2.5        },
  { s: 'MOVE/USDT',      p: 0.5        }, { s: 'NAV/USDT',       p: 0.1        },
  { s: 'NEO/USDT',       p: 12         }, { s: 'NOT/USDT',       p: 0.006      },
  { s: 'OGN/USDT',       p: 0.1        }, { s: 'ONE/USDT',       p: 0.015      },
  { s: 'ONDO/USDT',      p: 1.4        }, { s: 'ONT/USDT',       p: 0.21       },
  { s: 'OP/USDT',        p: 1.72       }, { s: 'ORDI/USDT',      p: 35         },
  { s: 'PARTI/USDT',     p: 0.1        }, { s: 'PEPE/USDT',      p: 0.0000088  },
  { s: 'QNT/USDT',       p: 80         }, { s: 'RSR/USDT',       p: 0.008      },
  { s: 'RUNE/USDT',      p: 8          }, { s: 'SAND/USDT',      p: 0.42       },
  { s: 'SCR/USDT',       p: 0.5        }, { s: 'SEI/USDT',       p: 0.38       },
  { s: 'SHELL/USDT',     p: 0.05       }, { s: 'SHIB/USDT',      p: 0.000025   },
  { s: 'SLP/USDT',       p: 0.003      }, { s: 'SNX/USDT',       p: 2.8        },
  { s: 'SOL/USDT',       p: 170        }, { s: 'STX/USDT',       p: 1.85       },
  { s: 'SUI/USDT',       p: 1.52       }, { s: 'T/USDT',         p: 0.05       },
  { s: 'TAO/USDT',       p: 350        }, { s: 'THE/USDT',       p: 2.0        },
  { s: 'THETA/USDT',     p: 1.65       }, { s: 'TRB/USDT',       p: 60         },
  { s: 'TURBO/USDT',     p: 0.000012   }, { s: 'TURTLE/USDT',    p: 0.02       },
  { s: 'UNI/USDT',       p: 10.2       }, { s: 'VANRY/USDT',     p: 0.05       },
  { s: 'VELODROME/USDT', p: 0.08       }, { s: 'VET/USDT',       p: 0.035      },
  { s: 'WIF/USDT',       p: 2.5        }, { s: 'XAUT/USDT',      p: 2400       },
  { s: 'XEC/USDT',       p: 0.00003    }, { s: 'XLM/USDT',       p: 0.12       },
  { s: 'XRP/USDT',       p: 0.62       }, { s: 'XTZ/USDT',       p: 0.8        },
  { s: 'YB/USDT',        p: 0.1        }, { s: 'YFI/USDT',       p: 6800       },
  { s: 'ZEC/USDT',       p: 29         }, { s: 'ZETA/USDT',      p: 0.5        },
  { s: 'ZRX/USDT',       p: 0.41       }, { s: 'ALPINE/USDT',    p: 2.5        },
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

/* ---------- Pionex 顯示價格快取 ---------- */
let _pionexPrices = {};

async function refreshPionexPrices() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://api.pionex.com/api/v1/market/tickers', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { console.warn('[Pionex] API 回應錯誤:', r.status); return; }
    const j = await r.json();
    if (j.result && Array.isArray(j.data?.tickers)) {
      j.data.tickers.forEach(tk => {
        // 支援 BTC_USDT → BTCUSDT 及 BTC_USDT_PERP 等格式
        _pionexPrices[tk.symbol.replace(/_/g, '')] = parseFloat(tk.close);
        _pionexPrices[tk.symbol.replace('_USDT', 'USDT').replace(/_/g, '')] = parseFloat(tk.close);
      });
    } else {
      console.warn('[Pionex] 回應格式異常，嘗試備用解析');
      // 備用：若 result 不在預期位置，嘗試直接找 tickers 陣列
      const tickers = j.tickers || j.data || [];
      if (Array.isArray(tickers)) {
        tickers.forEach(tk => {
          if (tk.symbol) _pionexPrices[tk.symbol.replace(/_/g, '')] = parseFloat(tk.close || tk.last || tk.price || 0);
        });
      }
    }
  } catch(e) {
    console.warn('[Pionex] 價格取得失敗:', e?.message || e);
  }
}

function toPionex(sym, binanceCur, level) {
  if (!level || !binanceCur) return level;
  const key = sym.replace('/', '').toUpperCase();
  const px = _pionexPrices[key];
  if (!px || px <= 0) return level;
  return level * (px / binanceCur);
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
      batch.map(pair => {
        const sym = pair.s.replace('/', '');
        // 5 timeframes in parallel: 15m(primary), 1D, 1W, 4H, 1H
        return Promise.allSettled([
          fetchKlines(sym, interval, 220),
          fetchKlines(sym, '1d', 100),
          fetchKlines(sym, '1w', 52),
          fetchKlines(sym, '4h', 100),
          fetchKlines(sym, '1h', 100),
        ]);
      })
    );

    batchResults.forEach((r, j) => {
      const idx  = i + j;
      const pair = pairs[idx];
      const sym  = pair.s.replace('/', '');
      // r.value 是三個 SettledResult；r.status 永遠 'fulfilled'（allSettled 不 reject）
      const settled  = r.status === 'fulfilled' ? r.value : [];
      const mainRaw  = settled[0]?.status === 'fulfilled' ? settled[0].value : null;
      const dayRaw   = settled[1]?.status === 'fulfilled' ? settled[1].value : null;
      const wkRaw    = settled[2]?.status === 'fulfilled' ? settled[2].value : null;
      const h4Raw    = settled[3]?.status === 'fulfilled' ? settled[3].value : null;
      const h1Raw    = settled[4]?.status === 'fulfilled' ? settled[4].value : null;
      const analysed = mainRaw ? analyzeKlines(pair.s, mainRaw) : null;
      const sig15m   = mainRaw && mainRaw.length >= 30 ? analyzeTimeframeSignal(mainRaw) : null;
      const daySig   = dayRaw  && dayRaw.length  >= 30 ? analyzeTimeframeSignal(dayRaw)  : null;
      const wkSig    = wkRaw   && wkRaw.length   >= 30 ? analyzeTimeframeSignal(wkRaw)   : null;
      const h4Sig    = h4Raw   && h4Raw.length   >= 30 ? analyzeTimeframeSignal(h4Raw)   : null;
      const h1Sig    = h1Raw   && h1Raw.length   >= 30 ? analyzeTimeframeSignal(h1Raw)   : null;

      if (analysed) {
        results[idx] = {
          ...analysed,
          trend:          scoreToTrend(analysed.score),
          volumeStrength: getVolStr(analysed.volume),
          signal15m:      sig15m?.signal    || null,
          dailySignal:    daySig?.signal    || null,
          weeklySignal:   wkSig?.signal     || null,
          h4Signal:       h4Sig?.signal     || null,
          h1Signal:       h1Sig?.signal     || null,
          h4SwingHigh:    h4Sig?.swingHigh  || null,
          h4SwingLow:     h4Sig?.swingLow   || null,
          h4Rsi:          h4Sig?.rsi        || null,
          h1Rsi:          h1Sig?.rsi        || null,
        };
      } else {
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
          signal15m: null, dailySignal: null, weeklySignal: null,
          h4Signal: null, h1Signal: null,
          h4SwingHigh: null, h4SwingLow: null, h4Rsi: null, h1Rsi: null,
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
      atr:             item.atr             ?? null,
      wickSupports:    item.wickSupports     ?? [],
      wickResistances: item.wickResistances  ?? [],
      signal15m:       item.signal15m         ?? null,
      dailySignal:     item.dailySignal       ?? null,
      weeklySignal:    item.weeklySignal      ?? null,
      h4Signal:        item.h4Signal          ?? null,
      h1Signal:        item.h1Signal          ?? null,
      h4SwingHigh:     item.h4SwingHigh       ?? null,
      h4SwingLow:      item.h4SwingLow        ?? null,
      h4Rsi:           item.h4Rsi             ?? null,
      h1Rsi:           item.h1Rsi             ?? null,
      bb:              item.bb                ?? null,
      patterns:        item.patterns          ?? null,
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

    const frRaw = frR.status === 'fulfilled' && Array.isArray(frR.value) ? parseFloat(frR.value[0]?.fundingRate) : null;
    const fr    = (frRaw != null && !isNaN(frRaw)) ? frRaw : null;
    const oi    = oiR.status === 'fulfilled' && oiR.value?.openInterest  ? parseFloat(oiR.value.openInterest) : null;
    const ls    = lsR.status === 'fulfilled' && Array.isArray(lsR.value)  ? lsR.value[0] : null;
    const top   = topR.status === 'fulfilled' && Array.isArray(topR.value) ? topR.value[0] : null;
    const taker = tkR.status === 'fulfilled' && Array.isArray(tkR.value)  ? tkR.value[0] : null;

    if (fr === null && oi === null) return null; // 現貨幣種無合約數據

    return {
      fundingRate:      fr,
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
  // 長線單判斷：日線 + 週線 OR 月線同向才觸發；月線加入供進一步確認
  const tfs  = ['15m', '1h', '4h', '1d', '1w', '1M'];
  const out  = {};

  await Promise.allSettled(tfs.map(async tf => {
    const limit = tf === '1w' ? 60 : tf === '1M' ? 24 : 100;
    const minBars = tf === '1w' ? 8 : tf === '1M' ? 6 : 30;
    const raw = await fetchKlines(base, tf, limit);
    if (raw && raw.length >= minBars) {
      out[tf] = {
        signal:    analyzeTimeframeSignal(raw),
        orderFlow: analyzeOrderFlow(raw),
        volAI:     tf === '1h' ? analyzeVolumeAI(raw) : undefined,
        vp:        (tf === '1h' || tf === '4h') ? computeVolumeProfile(raw) : undefined,
        traps:     (tf === '1h' || tf === '15m') ? detectTrapPatterns(raw) : undefined,
        bb:        (tf === '1h' || tf === '15m') ? computeBBSignal(raw)    : undefined,
        raw:       (tf === '1h' || tf === '4h')  ? raw.slice(-60)          : undefined,
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
  if (buyPct > 70 && bigBuyCount >= 3) {
    pattern = 'accumulation'; strength = Math.min(95, Math.round(buyPct * 0.9));
    label = `強力吸籌`; color = 'var(--bull)';
  } else if (sellPct > 70 && bigSellCount >= 3) {
    pattern = 'distribution'; strength = Math.min(95, Math.round(sellPct * 0.9));
    label = `主動出貨`; color = 'var(--bear)';
  } else if (buyPct > 58 && bigBuyCount >= 2) {
    pattern = 'light_buy'; strength = Math.round(buyPct * 0.7);
    label = `溫和吸籌`; color = 'var(--bull)';
  } else if (sellPct > 58 && bigSellCount >= 2) {
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
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return res.ok;
  } catch { return false; }
}


/* buildTelegramText 已移至 app.js（單一定義來源）。
   此處原有的舊版重複定義已刪除——兩份同名函式會互相覆蓋，
   修改到失效的那份不會有任何效果，是維護陷阱。 */
/* ── 交易建議取消通知（原始信號夠強，但扣分後低於推薦門檻，且尚未入場）── */
function buildWeakenedSignalText(coin, direction, setup, siteUrl = '') {
  const isLong  = direction === 'long';
  const icon    = isLong ? '▲' : '▼';
  const dirTx   = isLong ? '做多（Long）' : '做空（Short）';
  const sym     = coin.symbol.replace('/USDT','').replace('USDT','');
  const time    = new Date().toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const rawConf = setup.rawConf ?? Math.min(90, coin.score ?? 60);
  const finalConf = setup.conf ?? 0;
  const totalDrop = rawConf - finalConf;

  let msg = `🚫 <b>交易建議已取消</b>\n\n`;
  msg += `${icon} <b>${dirTx}：${coin.symbol}</b>\n`;
  msg += `📶 信心度：<b>${rawConf}%</b> → 降至 <b>${finalConf}%</b>（扣 -${totalDrop}%${finalConf < 65 ? '，未達推薦門檻' : ''}）\n\n`;

  // 逐項取消原因
  const deducts = [];
  if (setup.hardAdxPenalty > 0)
    deducts.push(`ADX 過低 -${setup.hardAdxPenalty}%`);
  if (setup.macroOpposePenalty > 0) {
    const detail = (setup.macroReasons || []).slice(0, 2).join('、');
    deducts.push(`宏觀環境逆風 -${setup.macroOpposePenalty}%${detail ? `（${detail}）` : ''}`);
  }
  if ((setup.aiTrendReasons || []).length) {
    setup.aiTrendReasons.forEach(r => deducts.push(r));
  } else if (setup.aiTrendPenalty > 0) {
    deducts.push(`AI 趨勢預測逆向 -${setup.aiTrendPenalty}%`);
  }
  if (setup.learnPenalty > 0) {
    deducts.push(`止損歷史記憶觸發 -${setup.learnPenalty}%`);
    (setup.learnWarn || []).slice(0, 2).forEach(w => deducts.push(`  ↳ ${w.slice(0, 55)}`));
  }

  if (deducts.length) {
    msg += `📋 <b>取消原因</b>\n`;
    deducts.forEach(d => { msg += `  • ${d}\n`; });
    msg += `\n`;
  }

  msg += `⏰ ${time}\n`;
  msg += `#${sym} #${isLong ? 'long' : 'short'} #取消`;
  if (siteUrl) {
    msg += `\n\n🔗 <a href="${siteUrl}">查看 ${sym} 詳細分析 →</a>`;
  }
  return msg;
}

/* ── 巨鯨偵測（大額現貨成交，不顯示，僅用於多空分析）────────── */
async function _fetchSpotWhaleTrades(sym) {
  for (const host of BINANCE_HOSTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch(`${host}/api/v3/aggTrades?symbol=${sym}&limit=1000`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const trades = await res.json();
      if (!Array.isArray(trades) || trades.length === 0) return null;

      const price = parseFloat(trades[trades.length - 1]?.p) || 1;
      // 動態門檻：依幣價決定「巨鯨」最低成交額（放寬以確保有資料）
      const threshold = price > 10000 ? 150000
        : price > 1000 ? 40000
        : price > 10   ? 10000
        : 2000;

      let buyVol = 0, sellVol = 0, bigBuyCount = 0, bigSellCount = 0;
      let bigBuyWeightedPrice = 0, bigSellWeightedPrice = 0;
      for (const tr of trades) {
        const p   = parseFloat(tr.p);
        const val = p * parseFloat(tr.q);
        if (val < threshold) continue;
        // m=true 表示主動賣出（maker 是買方），m=false 表示主動買入
        if (!tr.m) { buyVol += val; bigBuyCount++;  bigBuyWeightedPrice  += p * val; }
        else        { sellVol += val; bigSellCount++; bigSellWeightedPrice += p * val; }
      }

      const total  = buyVol + sellVol;
      if (total === 0) return null;
      const buyPct = buyVol / total * 100;
      const bias   = buyPct > 60 ? 'bull' : buyPct < 40 ? 'bear' : 'neutral';
      // 大單加權均價（掛單价格参考）
      const bigBuyAvgPrice  = buyVol  > 0 ? bigBuyWeightedPrice  / buyVol  : 0;
      const bigSellAvgPrice = sellVol > 0 ? bigSellWeightedPrice / sellVol : 0;
      return {
        buyVol, sellVol, total,
        buyPct:      parseFloat(buyPct.toFixed(1)),
        netFlow:     buyVol - sellVol,
        bias,
        bigBuyCount, bigSellCount,
        bigBuyAvgPrice:  parseFloat(bigBuyAvgPrice.toFixed(6)),
        bigSellAvgPrice: parseFloat(bigSellAvgPrice.toFixed(6)),
        threshold,
      };
    } catch { continue; }
  }
  return null;
}

async function _fetchFuturesWhaleData(sym) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    // 使用 allSettled 確保任一端點失敗不影響另一個
    const [takerSettled, oiSettled] = await Promise.allSettled([
      fetch(`https://fapi.binance.com/futures/data/takerBuySellVol?symbol=${sym}&period=5m&limit=24`, { signal: ctrl.signal }),
      fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=24`, { signal: ctrl.signal }),
    ]);
    clearTimeout(t);

    let takerBuyPct = null, takerSellPct = null, takerBias = null, takerBuyVol = null, takerSellVol = null;
    if (takerSettled.status === 'fulfilled' && takerSettled.value.ok) {
      try {
        const takerData = await takerSettled.value.json();
        if (Array.isArray(takerData) && takerData.length > 0) {
          let totalBuyVol = 0, totalSellVol = 0;
          for (const rec of takerData) {
            totalBuyVol  += parseFloat(rec.buyVol)  || 0;
            totalSellVol += parseFloat(rec.sellVol) || 0;
          }
          const totalVol = totalBuyVol + totalSellVol;
          if (totalVol > 0) {
            const buyPctNum = totalBuyVol / totalVol * 100;
            takerBuyPct  = buyPctNum.toFixed(1);
            takerSellPct = (100 - buyPctNum).toFixed(1);
            takerBias    = buyPctNum > 55 ? 'bull' : buyPctNum < 45 ? 'bear' : 'neutral';
            takerBuyVol  = totalBuyVol;
            takerSellVol = totalSellVol;
          }
        }
      } catch { /* json parse 失敗，忽略 */ }
    }

    let oiChange = null, oiTrend = null, oiCurrent = null;
    if (oiSettled.status === 'fulfilled' && oiSettled.value.ok) {
      try {
        const oiData = await oiSettled.value.json();
        if (Array.isArray(oiData) && oiData.length >= 2) {
          const firstOI = parseFloat(oiData[0].sumOpenInterest) || 0;
          const lastOI  = parseFloat(oiData[oiData.length - 1].sumOpenInterest) || 0;
          oiCurrent = lastOI;
          if (firstOI > 0) {
            const changePct = (lastOI - firstOI) / firstOI * 100;
            oiChange = parseFloat(changePct.toFixed(2));
            oiTrend  = changePct > 0.5 ? 'increasing' : changePct < -0.5 ? 'decreasing' : 'stable';
          }
        }
      } catch { /* json parse 失敗，忽略 */ }
    }

    if (takerBuyPct === null && oiChange === null) return null;

    return {
      takerBuyPct,
      takerSellPct,
      takerBias,
      takerBuyVol,
      takerSellVol,
      oiChange,
      oiTrend,
      oiCurrent,
    };
  } catch {
    return null;
  }
}

async function fetchWhaleTrades(symbol) {
  const sym = symbol.replace('/', '').replace('USDT', '') + 'USDT';

  // Run spot aggTrades and futures data in parallel
  const [spotResult, futuresWhale] = await Promise.all([
    _fetchSpotWhaleTrades(sym),
    _fetchFuturesWhaleData(sym),
  ]);

  if (!spotResult && !futuresWhale) return null;

  // If only futures data available (no spot whale trades), create minimal base
  const base = spotResult || {
    buyVol: 0, sellVol: 0, total: 0,
    buyPct: futuresWhale ? parseFloat(futuresWhale.takerBuyPct) : 50,
    netFlow: 0,
    bias: futuresWhale?.takerBias || 'neutral',
    bigBuyCount: 0, bigSellCount: 0, threshold: 0,
  };

  return { ...base, futuresWhale };
}

/* ═══════════════════ 市場足跡圖數據 ══════════════════════ */
async function fetchFootprintData(symbol) {
  const base = symbol.replace('/', '').replace('USDT', '') + 'USDT';
  // 雙時框並行：5m（主交易邏輯）+ 1m（快進快出信號專用）
  const [raw5m, raw1m] = await Promise.all([
    fetchKlines(base, '5m', 60),   // 5小時 5m K棒 → 主邏輯（deltaDir、POC、VWAP、吸籌）
    fetchKlines(base, '1m', 120),  // 2小時 1m K棒 → 快進快出信號偵測專用
  ]);
  if (!raw5m || raw5m.length < 10) return null;
  try {
    // ── 通用 K棒處理（供兩個時框共用）──
    const processRaw = raw => raw.map(bar => {
      const ts     = parseFloat(bar[0]);
      const open   = parseFloat(bar[1]);
      const high   = parseFloat(bar[2]);
      const low    = parseFloat(bar[3]);
      const close  = parseFloat(bar[4]);
      const vol    = parseFloat(bar[5]);
      const buyVol = parseFloat(bar[9]);  // takerBuyBaseAssetVolume
      const sellVol = Math.max(0, vol - buyVol);
      const delta   = buyVol - sellVol;
      return { ts, open, high, low, close, buyVol, sellVol, total: vol, delta,
               priceChange: close - open, buyRatio: vol > 0 ? buyVol / vol : 0.5 };
    });

    // ── 5m 主邏輯計算（雜訊少，適合1H/4H交易決策）──
    const candles5m       = processRaw(raw5m);
    const priceVolMap     = new Map();
    let _vwapPV = 0, _vwapV = 0, _totalBuyVol = 0, _totalSellVol = 0;

    candles5m.forEach(c => {
      const tp = (c.high + c.low + c.close) / 3;
      _vwapPV += tp * c.total;
      _vwapV  += c.total;
      _totalBuyVol  += c.buyVol;
      _totalSellVol += c.sellVol;
      const pLvl = parseFloat(c.close.toPrecision(4));
      if (!priceVolMap.has(pLvl)) priceVolMap.set(pLvl, { price: pLvl, buyVol: 0, sellVol: 0 });
      const lv = priceVolMap.get(pLvl);
      lv.buyVol  += c.buyVol;
      lv.sellVol += c.sellVol;
    });

    let cum = 0;
    const cumDeltas = candles5m.map(c => { cum += c.delta; return cum; });
    const nc = cumDeltas.length;
    // 累積 Delta 有正負號，不能用「×1.02」百分比比較（負值時門檻反而變低，
    // 賣壓加重會被誤判成 bull）。改用差值對規模的比例判斷。
    const _dRef   = nc >= 3 ? cumDeltas[Math.floor(nc / 3)] : 0;
    const _dLast  = nc > 0 ? cumDeltas[nc - 1] : 0;
    const _dScale = Math.max(Math.abs(_dLast), Math.abs(_dRef), 1e-9);
    const deltaDir = nc < 3 ? 'neutral'
      : (_dLast - _dRef) >  _dScale * 0.02 ? 'bull'
      : (_dLast - _dRef) < -_dScale * 0.02 ? 'bear' : 'neutral';

    const recentDelta = candles5m.slice(-5).reduce((s, c) => s + c.delta, 0);
    const firstClose  = candles5m[0]?.close || 0;
    const lastClose   = candles5m[candles5m.length-1]?.close || firstClose;
    const priceDir    = lastClose > firstClose * 1.002 ? 'bull'
                      : lastClose < firstClose * 0.998 ? 'bear' : 'neutral';
    const deltaDiv    = priceDir !== 'neutral' && deltaDir !== 'neutral' && priceDir !== deltaDir;

    const priceVols      = [...priceVolMap.values()]
      .map(lv => ({ ...lv, total: lv.buyVol + lv.sellVol, delta: lv.buyVol - lv.sellVol }))
      .sort((a, b) => b.total - a.total);
    const poc            = priceVols[0]?.price || lastClose;
    const lastFew        = candles5m.slice(-4);
    const absorption     = lastFew.length >= 3
      && lastFew.filter(c => c.priceChange < 0).length >= 2
      && lastFew.reduce((s, c) => s + c.delta, 0) > 0;
    const sorted         = [...priceVols].filter(l => l.total > 0);
    const highBuyLevels  = [...sorted].sort((a, b) => b.delta - a.delta).slice(0, 5);
    const highSellLevels = [...sorted].sort((a, b) => a.delta - b.delta).slice(0, 5);
    const vwap           = _vwapV > 0 ? _vwapPV / _vwapV : lastClose;
    const totalVol       = _totalBuyVol + _totalSellVol;
    const takerBuyRatio  = totalVol > 0 ? _totalBuyVol / totalVol : 0.5;

    // 5m 微結構（雜訊較少，1m 噪音不會影響主訊號）
    let _altCount5m = 0;
    for (let i = 1; i < candles5m.length; i++) {
      if ((candles5m[i].delta >= 0) !== (candles5m[i-1].delta >= 0)) _altCount5m++;
    }
    const bidAskBounceScore    = candles5m.length > 1 ? Math.round(_altCount5m / (candles5m.length-1) * 100) : 0;
    const microstructureQuality = Math.max(0, 100 - bidAskBounceScore);

    // ── 1m 快進快出信號（只用於 scalpSignal，不影響主邏輯）──
    const candles1m   = (raw1m && raw1m.length >= 20) ? processRaw(raw1m) : null;
    const scalpSignal = (candles1m && typeof detectScalpSignal === 'function')
      ? detectScalpSignal(candles1m, lastClose, vwap, poc) : null;

    return {
      candles:            candles5m.slice(-20),   // 5m K棒供足跡面板顯示
      cumulativeDelta:    cum,
      deltaDir, recentDelta, priceDir, deltaDiv,
      poc, vwap, bidAskBounceScore, microstructureQuality, takerBuyRatio,
      priceVols:          priceVols.slice(0, 20),
      highBuyLevels, highSellLevels,
      absorption, lastClose,
      scalpSignal,        // 來自 1m 資料，主邏輯不受影響
    };
  } catch { return null; }
}

/* ═══════════════════ 爆倉地圖 API ══════════════════════ */
async function fetchLiquidationMap(symbol) {
  const base = symbol.replace('/USDT', '').replace('USDT', '');
  // Try CoinGlass public API
  try {
    const url = `https://open-api.coinglass.com/public/v2/liquidation_chart?symbol=${base}&time_type=m5`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      if (json && json.data) {
        const longLiqs  = [];
        const shortLiqs = [];
        if (Array.isArray(json.data.longLiquidationData)) {
          json.data.longLiquidationData.forEach(d => {
            if (d.price && d.amount) longLiqs.push({ price: parseFloat(d.price), strength: parseFloat(d.amount) });
          });
        }
        if (Array.isArray(json.data.shortLiquidationData)) {
          json.data.shortLiquidationData.forEach(d => {
            if (d.price && d.amount) shortLiqs.push({ price: parseFloat(d.price), strength: parseFloat(d.amount) });
          });
        }
        if (longLiqs.length || shortLiqs.length) {
          return { longLiqs, shortLiqs, rawData: json.data, source: 'coinglass' };
        }
      }
    }
  } catch (_e) { /* fallback to estimated */ }

  // Fallback: generate estimated liquidation levels from common leverage multiples
  // Returns source='estimated' with leverages array; app.js will compute prices using current price
  return { longLiqs: null, shortLiqs: null, rawData: null, source: 'estimated', leverages: [3, 5, 10, 20, 50, 100] };
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
  apiKey:          '',  // 勿在前端源碼寫死金鑰（公開部署等於公開金鑰），請於設定頁填入
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

/* ── 真實加密貨幣新聞抓取（RSS via rss2json + CoinGecko fallback）── */
let _cryptoNewsCache = null;
let _cryptoNewsFetchAt = 0;

async function fetchCryptoNews() {
  const TTL = 25 * 60 * 1000; // 25 分鐘快取
  if (_cryptoNewsCache && Date.now() - _cryptoNewsFetchAt < TTL) return _cryptoNewsCache;

  const RSS_SOURCES = [
    { url: 'https://cointelegraph.com/rss',                             name: 'CoinTelegraph' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',           name: 'CoinDesk'      },
    { url: 'https://decrypt.co/feed',                                   name: 'Decrypt'       },
    { url: 'https://thedefiant.io/api/feed',                            name: 'The Defiant'   },
    { url: 'https://bitcoinmagazine.com/.rss/full/',                    name: 'Bitcoin Mag'   },
  ];

  const strip = html => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);

  for (const src of RSS_SOURCES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(src.url)}&count=10`;
      const r = await fetch(apiUrl, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status !== 'ok' || !Array.isArray(j.items) || j.items.length === 0) continue;
      const items = j.items.slice(0, 8).map(item => ({
        title:       (item.title || '').trim(),
        body:        strip(item.description || item.content || ''),
        url:         item.link  || '',
        source:      src.name,
        publishedAt: item.pubDate ? new Date(item.pubDate).getTime() : null,
      })).filter(it => it.title.length > 10);
      if (items.length < 3) continue;
      _cryptoNewsCache  = items;
      _cryptoNewsFetchAt = Date.now();
      console.log(`[fetchCryptoNews] 取得 ${items.length} 則來自 ${src.name}`);
      return items;
    } catch(e) {
      console.warn(`[fetchCryptoNews] ${src.name} 失敗:`, e?.message);
    }
  }

  // 最終 fallback：CoinGecko news
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://api.coingecko.com/api/v3/news?per_page=12', { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.data || []);
      if (arr.length > 0) {
        const items = arr.slice(0, 8).map(it => ({
          title:       (it.title || '').trim(),
          body:        strip(it.description || ''),
          url:         it.url  || '',
          source:      it.news_site || 'CoinGecko',
          publishedAt: it.created_at ? new Date(it.created_at).getTime() : null,
        })).filter(it => it.title.length > 10);
        if (items.length >= 3) {
          _cryptoNewsCache  = items;
          _cryptoNewsFetchAt = Date.now();
          return items;
        }
      }
    }
  } catch(e) {
    console.warn('[fetchCryptoNews] CoinGecko fallback 失敗:', e?.message);
  }

  return null;
}
