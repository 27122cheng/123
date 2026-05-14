/* ============================================================
   api.js — API Integration & Mock Data Generator
   ============================================================ */

const PAIRS = [
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
  { s: 'BONK/USDT',  p: 0.000025 }, { s: 'PEPE/USDT', p: 0.0000088 },
  { s: 'SHIB/USDT',  p: 0.0000235 }, { s: 'DOGE/USDT', p: 0.14  },
  { s: 'FLOKI/USDT', p: 0.000185 }, { s: 'MEME/USDT', p: 0.0082 },
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

/* ---------- seeded pseudo-random for stable mock data ---------- */
let _seed = Date.now();
function seededRand() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
  return ((_seed >>> 0) / 0xffffffff);
}
function randRange(min, max) { return min + seededRand() * (max - min); }
function randInt(min, max)   { return Math.floor(randRange(min, max + 1)); }
function pick(arr)           { return arr[randInt(0, arr.length - 1)]; }

/* ---------- trend helper ---------- */
function scoreToTrend(score) {
  if (score >= 78) return 'Strong Bullish';
  if (score >= 58) return 'Bullish';
  if (score >= 42) return 'Neutral';
  if (score >= 22) return 'Bearish';
  return 'Strong Bearish';
}

/* ---------- mock data generator ---------- */
function generateMockData() {
  _seed = 987654321; // fixed seed → stable data on each refresh simulation
  return PAIRS.map((pair, i) => {
    const priceVar = 0.96 + seededRand() * 0.08;
    const price    = pair.p * priceVar;
    const score    = randInt(5, 95);
    const rsi      = parseFloat(randRange(18, 78).toFixed(1));
    const adx      = parseFloat(randRange(8, 52).toFixed(1));
    const ema20    = price * (0.978 + seededRand() * 0.044);
    const ema50    = price * (0.945 + seededRand() * 0.11);
    const ema200   = price * (0.82  + seededRand() * 0.36);
    const volB     = randInt(1_000_000, 2_000_000_000);
    const volS     = pick(['High', 'Medium', 'Low']);

    return {
      symbol:       pair.s,
      trend:        scoreToTrend(score),
      score,
      price:        formatPrice(price),
      rsi,
      adx,
      volume:       volB,
      volumeStrength: volS,
      ema20:        formatPrice(ema20),
      ema50:        formatPrice(ema50),
      ema200:       formatPrice(ema200),
      momentum:     parseFloat((rsi - 50).toFixed(1)),
      strength:     Math.round(adx),
    };
  });
}

function formatPrice(p) {
  if (p >= 1000)  return parseFloat(p.toFixed(2));
  if (p >= 1)     return parseFloat(p.toFixed(3));
  if (p >= 0.001) return parseFloat(p.toFixed(5));
  return parseFloat(p.toFixed(8));
}

/* ---------- enrich real API data ---------- */
function enrichData(raw) {
  return raw.map((item, i) => {
    const price  = item.price || 0;
    const score  = item.score ?? 50;
    const rsi    = item.rsi ?? 50;
    const adx    = item.adx ?? 20;
    const trend  = item.trend || scoreToTrend(score);

    return {
      symbol:         item.symbol,
      trend,
      score,
      price,
      rsi,
      adx,
      volume:         item.volume || randInt(1e6, 2e9),
      volumeStrength: item.volumeStrength || getVolStr(item.volume),
      ema20:          item.ema20  || formatPrice(price * 0.99),
      ema50:          item.ema50  || formatPrice(price * 0.97),
      ema200:         item.ema200 || formatPrice(price * 0.90),
      momentum:       item.momentum ?? parseFloat((rsi - 50).toFixed(1)),
      strength:       item.strength ?? Math.round(adx),
    };
  });
}

function getVolStr(vol) {
  if (!vol) return 'Medium';
  if (vol > 500_000_000) return 'High';
  if (vol > 50_000_000)  return 'Medium';
  return 'Low';
}

/* ---------- main fetch function ---------- */
async function fetchMarketData() {
  const settings = loadSettings();
  const url      = (settings.apiUrl || 'http://127.0.0.1:8000') + '/scan';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res   = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) throw new Error('Empty response');
    return { data: enrichData(json), source: 'api' };
  } catch (err) {
    console.warn('[CryptoScanner] API unavailable — using demo data:', err.message);
    return { data: generateMockData(), source: 'mock' };
  }
}

/* ---------- settings store ---------- */
const SETTINGS_KEY = 'csp_settings';

const DEFAULT_SETTINGS = {
  timeframe:       '15m',
  refreshInterval: 60,
  darkMode:        true,
  reversals:       true,
  sound:           false,
  apiUrl:          'http://127.0.0.1:8000',
  bullThreshold:   60,
  bearThreshold:   40,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(patch) {
  const current = loadSettings();
  const next    = { ...current, ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function resetSettings() {
  localStorage.removeItem(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS };
}
