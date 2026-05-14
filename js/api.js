/* ==========================================
   CRYPTO SCANNER PRO - API MODULE
   Handles real API calls with mock fallback
   ========================================== */

const API = (() => {

  const TOP_100 = [
    { sym:'BTC',  base:64000  }, { sym:'ETH',   base:3200   }, { sym:'BNB',  base:420    },
    { sym:'SOL',  base:145    }, { sym:'XRP',   base:0.62   }, { sym:'ADA',  base:0.48   },
    { sym:'AVAX', base:38     }, { sym:'DOGE',  base:0.16   }, { sym:'DOT',  base:7.8    },
    { sym:'MATIC',base:0.78   }, { sym:'LINK',  base:15.2   }, { sym:'SHIB', base:0.0000245 },
    { sym:'TRX',  base:0.124  }, { sym:'UNI',   base:8.9    }, { sym:'ATOM', base:9.8    },
    { sym:'LTC',  base:82     }, { sym:'ETC',   base:28     }, { sym:'XLM',  base:0.115  },
    { sym:'NEAR', base:6.4    }, { sym:'ALGO',  base:0.19   }, { sym:'FIL',  base:5.8    },
    { sym:'VET',  base:0.038  }, { sym:'HBAR',  base:0.092  }, { sym:'ICP',  base:11.2   },
    { sym:'SAND', base:0.42   }, { sym:'MANA',  base:0.38   }, { sym:'AXS',  base:7.6    },
    { sym:'THETA',base:1.12   }, { sym:'FTM',   base:0.52   }, { sym:'EGLD', base:41     },
    { sym:'FLOW', base:0.78   }, { sym:'EOS',   base:0.71   }, { sym:'CAKE', base:2.8    },
    { sym:'AAVE', base:92     }, { sym:'GRT',   base:0.18   }, { sym:'RUNE', base:4.8    },
    { sym:'KSM',  base:28     }, { sym:'CHZ',   base:0.082  }, { sym:'ENJ',  base:0.26   },
    { sym:'GALA', base:0.028  }, { sym:'ROSE',  base:0.088  }, { sym:'KLAY', base:0.19   },
    { sym:'ONE',  base:0.018  }, { sym:'CELO',  base:0.62   }, { sym:'ZIL',  base:0.024  },
    { sym:'ICX',  base:0.21   }, { sym:'HOT',   base:0.00182}, { sym:'WIN',  base:0.000087},
    { sym:'BTT',  base:0.0000012}, { sym:'REEF', base:0.0025 }, { sym:'DENT',base:0.00068},
    { sym:'ANKR', base:0.032  }, { sym:'CELR',  base:0.018  }, { sym:'BAND', base:1.42   },
    { sym:'KNC',  base:0.68   }, { sym:'OCEAN', base:0.38   }, { sym:'SXP',  base:0.32   },
    { sym:'SKL',  base:0.042  }, { sym:'ALPHA', base:0.058  }, { sym:'BAT',  base:0.23   },
    { sym:'ZRX',  base:0.38   }, { sym:'STORJ', base:0.48   }, { sym:'OMG',  base:0.54   },
    { sym:'PERP', base:0.78   }, { sym:'DODO',  base:0.092  }, { sym:'QUICK',base:0.058  },
    { sym:'TLM',  base:0.012  }, { sym:'IOTX',  base:0.038  }, { sym:'ARDR', base:0.072  },
    { sym:'LSK',  base:1.12   }, { sym:'QTUM',  base:2.8    }, { sym:'ONT',  base:0.22   },
    { sym:'NEO',  base:11.8   }, { sym:'WAVES', base:2.4    }, { sym:'XMR',  base:162    },
    { sym:'DASH', base:28     }, { sym:'ZEC',   base:22     }, { sym:'DCR',  base:14.8   },
    { sym:'RVN',  base:0.022  }, { sym:'DGB',   base:0.0088 }, { sym:'HNT',  base:4.2    },
    { sym:'AR',   base:28     }, { sym:'LRC',   base:0.22   }, { sym:'COMP', base:52     },
    { sym:'MKR',  base:1820   }, { sym:'YFI',   base:6200   }, { sym:'SNX',  base:2.4    },
    { sym:'CRV',  base:0.38   }, { sym:'BAL',   base:2.8    }, { sym:'1INCH',base:0.38   },
    { sym:'SUSHI',base:0.92   }, { sym:'LUNC',  base:0.000082}, { sym:'SC',  base:0.0062 },
    { sym:'XVG',  base:0.0042 }, { sym:'IOTA',  base:0.18   }, { sym:'BCH',  base:384    },
    { sym:'FLM',  base:0.072  }, { sym:'WAN',   base:0.18   }, { sym:'NKN',  base:0.082  },
    { sym:'CTSI', base:0.092  }
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

  function formatPrice(p) {
    if (p >= 1000)    return '$' + p.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    if (p >= 1)       return '$' + p.toFixed(4);
    if (p >= 0.0001)  return '$' + p.toFixed(6);
    return '$' + p.toExponential(4);
  }

  function classifyTrend(score) {
    if (score >= 75) return 'Strong Bullish';
    if (score >= 55) return 'Bullish';
    if (score >= 40) return 'Neutral';
    if (score >= 25) return 'Bearish';
    return 'Strong Bearish';
  }

  function getVolumeStrength(vol) {
    if (vol > 70) return 'High';
    if (vol > 35) return 'Medium';
    return 'Low';
  }

  function generateCoinData(coin, timeframe) {
    const tfFactor = { '5m': 1, '15m': 1.2, '1h': 1.5, '4h': 2 }[timeframe] || 1;
    const score = Math.min(100, Math.max(0, Math.round(rand(5, 95))));
    const trend = classifyTrend(score);

    // RSI correlated with trend but with noise
    let rsiBase;
    if (score >= 75) rsiBase = rand(58, 82);
    else if (score >= 55) rsiBase = rand(50, 72);
    else if (score >= 40) rsiBase = rand(38, 62);
    else if (score >= 25) rsiBase = rand(28, 50);
    else rsiBase = rand(15, 40);
    const rsi = Math.round(Math.min(98, Math.max(2, rsiBase)));

    // ADX correlated with strength
    const adxBase = score >= 75 || score <= 25
      ? rand(28, 62)
      : score >= 55 || score <= 40
        ? rand(18, 42)
        : rand(8, 32);
    const adx = Math.round(adxBase);

    // Price with small random variation
    const priceVariation = rand(0.92, 1.08);
    const price = coin.base * priceVariation;

    // Volume (0-100 scale)
    const volume = Math.round(rand(5, 100));

    // EMA values derived from price
    const ema20  = price * rand(0.97, 1.03);
    const ema50  = price * rand(0.94, 1.06);
    const ema200 = price * rand(0.88, 1.12);

    return {
      symbol:   coin.sym + '/USDT',
      sym:      coin.sym,
      trend,
      score,
      price,
      priceStr: formatPrice(price),
      rsi,
      adx,
      volume,
      volumeStr: getVolumeStrength(volume),
      ema20,  ema50, ema200,
      change24h: rand(-12, 12).toFixed(2),
      high24h: price * rand(1.01, 1.08),
      low24h:  price * rand(0.92, 0.99),
    };
  }

  function generateMockData(timeframe = '15m') {
    _seed = Math.floor(Date.now() / 60000); // Stable within same minute
    return TOP_100.map(coin => generateCoinData(coin, timeframe));
  }

  async function fetchData(endpoint, timeframe = '15m') {
    try {
      const url = `${endpoint}?timeframe=${timeframe}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      // Normalize API response
      return raw.map(item => ({
        symbol:    item.symbol || item.sym || 'UNKNOWN/USDT',
        sym:       (item.symbol || item.sym || 'UNKNOWN').replace('/USDT',''),
        trend:     item.trend || classifyTrend(item.score || 50),
        score:     item.score  || 50,
        price:     item.price  || 0,
        priceStr:  formatPrice(item.price || 0),
        rsi:       item.rsi   || 50,
        adx:       item.adx   || 20,
        volume:    item.volume || 50,
        volumeStr: getVolumeStrength(item.volume || 50),
        ema20:     item.ema20  || item.price * 0.99 || 0,
        ema50:     item.ema50  || item.price * 0.97 || 0,
        ema200:    item.ema200 || item.price * 0.92 || 0,
        change24h: item.change24h || '0.00',
        high24h:   item.high24h || item.price || 0,
        low24h:    item.low24h  || item.price || 0,
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

  return { fetchData, generateMockData, classifyTrend, formatPrice, testConnection };

})();
