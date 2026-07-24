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
/* 幣種表上限：OKX 行情限速 40 次/2 秒，每幣每輪約 5 個週期請求，
   100 個幣 ≈ 500 次請求 ≈ 30 秒掃完一輪，是掃描節奏與覆蓋面的平衡點。
   同步時依 24h 成交額由高到低補到此上限為止。 */
const MAX_PAIRS = 100;

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

/* ---------- OKX 顯示價格快取 ---------- */
let _okxPrices = {};
let _okxVol24  = {};   // { BTCUSDT: 24h 計價幣成交額 } 供幣種表同步時依流動性排序

/* OKX 現貨行情：GET /api/v5/market/tickers?instType=SPOT
   回應 { code:"0", data:[{ instId:"BTC-USDT", last:"...", ... }] } */
async function refreshOkxPrices() {
  try {
    const r = await okxApiFetch('market/tickers', { instType: 'SPOT' });
    if (!r || !r.json) return;   // 通道全部不可用（診斷已於 okxApiFetch 輸出）
    const arr = r.json?.data;
    if (!Array.isArray(arr) || !arr.length) {
      console.warn('[OKX] 行情回應格式異常');
      return;
    }
    for (const tk of arr) {
      const inst = String(tk.instId || '');
      if (!inst) continue;
      const px = parseFloat(tk.last);
      if (!isFinite(px) || px <= 0) continue;
      const key = inst.replace(/-/g, '');          // BTC-USDT → BTCUSDT
      _okxPrices[key] = px;
      const vq = parseFloat(tk.volCcy24h);          // 24h 計價幣(USDT)成交額
      if (isFinite(vq) && vq >= 0) _okxVol24[key] = vq;
    }
  } catch(e) {
    console.warn('[OKX] 價格取得失敗:', e?.message || e);
  }
}

function toOkx(sym, binanceCur, level) {
  if (!level || !binanceCur) return level;
  const key = sym.replace('/', '').toUpperCase();
  const px = _okxPrices[key];
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

/* ═══════════════════ OKX K 線引擎（優先數據源）═══════════════
   實體交易在 OKX 成交 → 用 OKX 自己的 K 棒計算進場/止損/支撐壓力
   與插針判定，和實際成交所完全一致（不再靠幣安價 × 比例換算近似）。
   OKX 公開 API 沒有的數據（合約費率/OI/多空比、aggTrades 巨鯨、
   K棒內主動買量）維持使用幣安。
   任何失敗（限速/格式/斷線）自動降級走幣安，行為等同原版。
   註：OKX 的 bar 參數大小寫有意義——分鐘小寫(1m/15m)，時/日/週/月大寫
   (1H/4H/1D/1W/1M)，且原生支援週線與月線（Pionex 時期需退回幣安）。 */
const OKX_BAR_MAP = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m',
  '1h':'1H','2h':'2H','4h':'4H','6h':'6H','12h':'12H','1d':'1D','1w':'1W','1M':'1M' };
const _INTERVAL_MS = { '1m':60e3,'3m':18e4,'5m':3e5,'15m':9e5,'30m':18e5,'1h':36e5,'2h':72e5,
  '4h':144e5,'6h':216e5,'12h':432e5,'1d':864e5,'1w':6048e5,'1M':2592e6 };
let _okxKFails = 0, _okxKDisabledUntil = 0;
let _klineSrcCount = { okx: 0, binance: 0, cache: 0 };  // 每輪掃描數據源統計

/* ── OKX 智慧通道：直連 → 同源代理 /api/okx → 放棄 ──────────
   OKX 公開 API 通常不帶 CORS 標頭，瀏覽器直連會被擋（表現為
   TypeError: Failed to fetch）。部署在 Vercel 時，同源代理由
   api/okx.js serverless function 轉發，繞過 CORS。
   通道探測結果記憶於 _okxChannel：'direct' | 'proxy' | null(未定) */
let _okxChannel = null;
let _okxDirectFails = 0;
let _okxDiagShown = false;

/* ── OKX 限速閘門（根治「只有 40 筆走 OKX」）────────────────────
   OKX 公開行情端點限速為 40 次 / 2 秒 / IP。掃描時每幣 5 個週期並發，
   數十個請求瞬間湧出 → 第 41 個起回 429 → 舊版直接熔斷 5 分鐘，
   於是每輪固定只有約 40 筆走 OKX、其餘全部退回幣安（使用者看到的症狀）。
   改為主動排隊：所有 OKX 請求間隔至少 OKX_MIN_GAP_MS，換算約 33 次/2 秒，
   留約 17% 餘裕，從源頭避免觸發 429。
   _okxNextSlot 於 await 前同步預約時槽，並發呼叫也能正確排隊不重疊。 */
const OKX_MIN_GAP_MS = 60;
let _okxNextSlot = 0;
async function _okxGate() {
  const now  = Date.now();
  const slot = Math.max(now, _okxNextSlot);
  _okxNextSlot = slot + OKX_MIN_GAP_MS;   // 同步預約，避免並發搶同一時槽
  const wait = slot - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

async function okxApiFetch(path, params, timeoutMs = 8000) {
  const qs = new URLSearchParams(params).toString();
  const candidates = [];
  // 直連連續失敗 3 次後不再嘗試（典型 CORS 封鎖），只走代理
  if (_okxChannel !== 'proxy' && _okxDirectFails < 3) {
    candidates.push({ ch: 'direct', url: `https://www.okx.com/api/v5/${path}?${qs}` });
  }
  if (_okxChannel !== 'direct') {
    candidates.push({ ch: 'proxy', url: `/api/okx?path=${encodeURIComponent(path)}&${qs}` });
  }
  for (const c of candidates) {
    try {
      await _okxGate();                    // 限速排隊
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(c.url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.status === 429) {
        // 仍被限速：把後續時槽整體往後推 1 秒讓速率自然降下來，不再長時間熔斷
        _okxNextSlot = Math.max(_okxNextSlot, Date.now() + 1000);
        return { status: 429, json: null };
      }
      if (!r.ok) { if (c.ch === 'direct') _okxDirectFails++; continue; }
      const j = await r.json().catch(() => null);
      // OKX 統一回應格式 { code:"0", msg:"", data:[...] }；code 非 "0" 即為業務錯誤
      if (!j || j.data === undefined) {
        if (c.ch === 'direct') _okxDirectFails++;
        continue;  // 404 頁面 / 非 JSON（代理不存在等）→ 換下一通道
      }
      if (String(j.code) !== '0') {
        console.warn(`[OKX] API 錯誤 code=${j.code} msg=${j.msg || ''}`);
        return { status: 200, json: null };
      }
      if (_okxChannel !== c.ch) {
        _okxChannel = c.ch;
        console.info(`[OKX] 數據通道：${c.ch === 'direct' ? '直連' : '同源代理 /api/okx'}`);
        try { if (typeof showToast === 'function' && !_okxDiagShown) { _okxDiagShown = true; showToast(`✅ OKX 數據源已啟用（${c.ch === 'direct' ? '直連' : '代理'}）`, 'success'); } } catch(_t) {}
      }
      return { status: 200, json: j };
    } catch (e) {
      if (c.ch === 'direct') _okxDirectFails++;  // CORS 擋下即落此處
    }
  }
  if (!_okxDiagShown && _okxDirectFails >= 3) {
    _okxDiagShown = true;
    console.warn('[OKX] 直連被擋（CORS）且同源代理不可用。部署到 Vercel 後 /api/okx 代理會自動生效；目前自動改用幣安。');
    try { if (typeof showToast === 'function') showToast('ℹ️ OKX 不可直連（CORS），已自動改用幣安數據。部署 Vercel 代理後將自動切換', 'info'); } catch(_t) {}
  }
  return null;
}

/* OKX 現貨 K 線：GET /api/v5/market/candles?instId=BTC-USDT&bar=15m&limit=300
   回應 data 為「新→舊」倒序陣列，每筆 [ts,o,h,l,vol,volCcy,volCcyQuote,confirm]
   （ts=開盤毫秒字串）。單次上限 300 根，超過需改走 history-candles。 */
const OKX_MAX_LIMIT = 300;
async function fetchOkxKlines(symbol, interval, limit = 220) {
  const bar = OKX_BAR_MAP[interval];
  if (!bar) return null;                             // 不支援的週期 → 幣安
  if (Date.now() < _okxKDisabledUntil) return null;  // 熔斷中 → 幣安
  const instId = toOkxInstId(symbol);                // BTCUSDT → BTC-USDT
  if (!instId) return null;
  try {
    const r = await okxApiFetch('market/candles',
      { instId, bar, limit: Math.min(OKX_MAX_LIMIT, limit) });
    if (!r) throw new Error('unreachable');
    if (r.status === 429) {
      // 限速閘門已把速率壓在額度內；偶發 429 只讓「這一筆」退回幣安，
      // 不再熔斷 5 分鐘（舊行為會讓整輪掃描剩下的幣全部退回幣安）
      return null;
    }
    const arr = r.json?.data;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const ms = _INTERVAL_MS[interval] || 6e4;
    const rows = [];
    for (const k of arr) {
      if (!Array.isArray(k) || k.length < 6) return null;   // 格式不符 → 幣安
      const t0 = parseFloat(k[0]);
      const o  = parseFloat(k[1]);
      const h  = parseFloat(k[2]);
      const l  = parseFloat(k[3]);
      const c  = parseFloat(k[4]);
      const v  = parseFloat(k[5]) || 0;                     // 基礎幣成交量
      if (!isFinite(t0) || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c) || c <= 0) return null;
      // volCcyQuote(k[7]) 為計價幣成交額；缺值時以 v*c 估算
      const qv = parseFloat(k[7]);
      const quoteVol = isFinite(qv) && qv > 0 ? qv : v * c;
      // 對齊幣安陣列格式 [openTime,o,h,l,c,vol,closeTime,quoteVol,trades,takerBuyBase,takerBuyQuote,ignore]
      // [9] 主動買量 OKX K線無此欄位，以 v/2 佔位——需要真實 taker 買量的足跡圖不走 OKX
      rows.push([t0, String(o), String(h), String(l), String(c), String(v),
                 t0 + ms - 1, String(quoteVol), 0, String(v / 2), String(quoteVol / 2), '0']);
    }
    rows.sort((a, b) => a[0] - b[0]);   // OKX 回傳新→舊，統一轉為舊→新（同幣安）
    _okxKFails = 0;
    return rows.slice(-limit);
  } catch (e) {
    if (++_okxKFails >= 8) {  // 連續失敗（斷線等）→ 熔斷 10 分鐘
      _okxKDisabledUntil = Date.now() + 10 * 60 * 1000;
      _okxKFails = 0;
      console.warn('[OKX] K線連續失敗，10 分鐘內改走幣安');
    }
    return null;
  }
}

/* ── 交易對格式轉換：BTCUSDT / BTC/USDT → BTC-USDT（OKX instId）────
   只處理 USDT 計價（本系統清單皆為 USDT 交易對）。 */
function toOkxInstId(symbol) {
  const s = String(symbol || '').replace('/', '').toUpperCase();
  if (!s.endsWith('USDT') || s.length <= 4) return null;
  return s.slice(0, -4) + '-USDT';
}

/* ── OKX 上架幣種表 + 價格精度（public/instruments，6 小時快取）────
   用途：① 未上架的幣直接走幣安，不浪費失敗請求
        ② 顯示價格依 OKX 的報價精度（由 tickSz 推導）修整小數位
        ③ 設定頁標示「OKX 未上架」並提供一鍵移除
   只收 state==='live' 的現貨交易對（暫停/下架的不算上架）。 */
let _okxSymbolSet = null;      // Set('BTCUSDT', ...)
let _okxPrecision = {};        // { BTCUSDT: 2, ... } 報價小數位
let _okxSymbolsAt = 0;

/* tickSz("0.001") → 小數位數 3；("1") → 0；科學記號亦支援 */
function _tickSzToDecimals(tickSz) {
  const t = String(tickSz || '');
  if (!t) return null;
  if (t.includes('e') || t.includes('E')) {
    const n = Number(t);
    if (!isFinite(n) || n <= 0) return null;
    return Math.max(0, Math.ceil(-Math.log10(n)));
  }
  const dot = t.indexOf('.');
  if (dot < 0) return 0;
  return t.length - dot - 1;
}

async function fetchOkxSymbolSet() {
  if (_okxSymbolSet && Date.now() - _okxSymbolsAt < 6 * 3600 * 1000) return _okxSymbolSet;
  try {
    const r = await okxApiFetch('public/instruments', { instType: 'SPOT' });
    const arr = r?.json?.data;
    if (Array.isArray(arr) && arr.length > 0) {
      const set = new Set();
      const prec = {};
      for (const it of arr) {
        if (it.state && it.state !== 'live') continue;     // 非交易中不算上架
        const inst = String(it.instId || '');
        if (!inst.endsWith('-USDT')) continue;             // 只收 USDT 交易對
        const sym = inst.replace(/-/g, '');                // BTC-USDT → BTCUSDT
        set.add(sym);
        const d = _tickSzToDecimals(it.tickSz);
        if (d != null && d >= 0 && d <= 12) prec[sym] = d;
      }
      if (set.size > 0) {
        _okxSymbolSet = set;
        _okxPrecision = prec;
        _okxSymbolsAt = Date.now();
        console.info(`[OKX] 幣種表已更新：${set.size} 個上架交易對`);
      }
    }
  } catch (_e) {}
  return _okxSymbolSet;
}

/* 智慧路由：OKX 優先（與實際交易所一致），不支援/未上架/失敗 → 幣安
   trackKey：傳入 'BTC/USDT' 時記錄該幣主數據源（供 UI 逐幣標示） */
let _klineSrcBySymbol = {};       // { 'BTC/USDT': 'okx'|'binance' }
/* ── K 線快取（大幅降低每輪重複請求）──────────────────────────
   問題：每 15 秒一輪掃描，每幣要 5 個週期，日線/週線在一輪之間根本不會變，
   卻每輪都重抓 → 請求量爆炸、頁面卡在載入畫面。
   解法：依週期長度給快取效期——短週期效期短（不影響即時偵測），
   高階週期效期長（1 小時內日線不可能變出新意義）。 */
const _KLINE_TTL = { '1m':15e3, '3m':30e3, '5m':30e3, '15m':45e3, '30m':90e3,
  '1h':24e4, '2h':6e5, '4h':6e5, '6h':12e5, '12h':12e5, '1d':18e5, '1w':108e5, '1M':216e5 };
const _klineCache = new Map();   // key: sym|interval|limit → { ts, rows }
function _klineCacheGet(key, interval) {
  const hit = _klineCache.get(key);
  if (!hit) return null;
  const ttl = _KLINE_TTL[interval] || 3e4;
  if (Date.now() - hit.ts > ttl) { _klineCache.delete(key); return null; }
  return hit.rows;
}
function _klineCacheSet(key, rows) {
  if (!rows || !rows.length) return;
  // 上限保護：避免長時間執行後 Map 無限增長（100 幣 × 13 週期 ≈ 1300）
  if (_klineCache.size > 2000) _klineCache.clear();
  _klineCache.set(key, { ts: Date.now(), rows });
}

/* 只有「交易關鍵週期」走 OKX（進場/止損/插針判定需與實際成交所一致）。
   1h 以上僅用於判斷趨勢方向，交易所間的微小價差無影響 → 一律走幣安。
   這讓每輪 OKX 請求由「幣數×5」降為「幣數×1」，在 40 次/2 秒的硬限制下
   把掃描時間從約 30 秒壓到約 6 秒（此前頁面卡在載入畫面的主因）。 */
const OKX_PRECISION_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m']);

async function fetchKlinesSmart(symbol, interval, limit = 220, trackKey = null) {
  const _ck = `${symbol}|${interval}|${limit}`;
  const _cached = _klineCacheGet(_ck, interval);
  if (_cached) {
    _klineSrcCount.cache++;   // 快取命中也要計數，否則徽章數字對不起來
    if (trackKey && _klineSrcBySymbol[trackKey] == null) _klineSrcBySymbol[trackKey] = 'cache';
    return _cached;
  }
  const _fin = (rows, src) => {
    if (rows) {
      _klineCacheSet(_ck, rows);
      _klineSrcCount[src]++;
      if (trackKey) _klineSrcBySymbol[trackKey] = src;
    }
    return rows;
  };
  // 已知 OKX 未上架 → 直接幣安（OKX 抓不到，不浪費請求）
  if (_okxSymbolSet && !_okxSymbolSet.has(symbol)) {
    return _fin(await fetchKlines(symbol, interval, limit), 'binance');
  }
  // 非交易關鍵週期 → 優先幣安（限速寬鬆）；但幣種表已與 OKX 同步，清單中會有
  // 「OKX 有、幣安沒有」的幣（例如 XMU），這類幣幣安會回 null → 必須退回 OKX，
  // 否則該幣完全沒有 1H 以上資料，趨勢判斷全部失效。
  if (!OKX_PRECISION_INTERVALS.has(interval)) {
    const bh = await fetchKlines(symbol, interval, limit);
    if (bh && bh.length) return _fin(bh, 'binance');
    return _fin(await fetchOkxKlines(symbol, interval, limit), 'okx');
  }
  const p = await fetchOkxKlines(symbol, interval, limit);
  if (p && p.length >= Math.min(30, limit)) return _fin(p, 'okx');
  return _fin(await fetchKlines(symbol, interval, limit), 'binance');
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

/* 幣安 24h 成交額批量查詢（成交量強度分類維持幣安口徑）
   OKX 是小所，成交量遠小於幣安；量能分類（高/中/低）與巨鯨門檻
   都以幣安流動性校準，K 線改用 OKX 後，24h 成交額仍取幣安數值 */
async function fetchAll24hQuoteVols() {
  const syms = JSON.stringify(loadPairs().map(p => p.s.replace('/', '')));
  for (const host of BINANCE_HOSTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(
        `${host}/api/v3/ticker/24hr?symbols=${encodeURIComponent(syms)}&type=MINI`,
        { signal: ctrl.signal }
      );
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      const map = {};
      list.forEach(tk => { map[tk.symbol] = parseFloat(tk.quoteVolume); });
      return map;
    } catch { continue; }
  }
  return {};
}

/* 並行批次獲取所有交易對 K 線，並即時計算技術指標 */
async function fetchAllFromBinance(timeframe) {
  const interval  = tfToBinanceInterval(timeframe);
  const batchSize = 20;
  _klineSrcCount = { okx: 0, binance: 0, cache: 0 };

  /* 先批量獲取所有現貨即時價格，作為 kline 失敗時的精確備用；
     同時更新 OKX 上架幣種表（未上架的幣直接走幣安，價格精度對齊 OKX） */
  if (typeof updateScanProgress === 'function') updateScanProgress(0);
  const [spotPrices, quoteVols24] = await Promise.all([
    fetchAllSpotPrices(), fetchAll24hQuoteVols(), fetchOkxSymbolSet().catch(() => null),
  ]);

  /* ── 清單自動同步 OKX 官方幣種表（每月一次；設定頁可手動觸發）──
     實體交易在 OKX：清單只保留官方上架的幣（含未來下架自動清除）。
     防呆：官方表需 ≥50 個交易對才可信；同步後至少剩 10 個幣才執行，
     避免半殘回應誤刪整份清單。OKX 不可用時不動作（維持原清單）。 */
  try {
    const _syncKey  = 'csp_okx_sync_at';
    const _lastSync = parseInt(localStorage.getItem(_syncKey)) || 0;
    if (_okxSymbolSet && _okxSymbolSet.size >= 50
        && Date.now() - _lastSync > 30 * 24 * 3600 * 1000) {
      const _all  = loadPairs();
      const _keep = _all.filter(p => _okxSymbolSet.has(p.s.replace('/', '')));
      if (_keep.length < _all.length && _keep.length >= 10) {
        const _removed = _all.filter(p => !_okxSymbolSet.has(p.s.replace('/', '')));
        savePairs(_keep);
        _removed.forEach(p => { try { if (typeof purgeSymbolData === 'function') purgeSymbolData(p.s); } catch(_e) {} });
        console.info(`[OKX月度同步] 自動移除 ${_removed.length} 個未上架幣種：${_removed.map(p => p.s.replace('/USDT', '')).join('、')}`);
        try { if (typeof showToast === 'function') showToast(`✂ 月度同步：移除 ${_removed.length} 個 OKX 未上架幣種`, 'info'); } catch(_t) {}
        try { if (typeof renderPairsList === 'function') renderPairsList(); } catch(_r) {}
      }
      localStorage.setItem(_syncKey, String(Date.now()));  // 無論有無移除都記錄本次同步
    }
  } catch(_syncE) {}

  const pairs   = loadPairs();
  const results = new Array(pairs.length).fill(null);

  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map(pair => {
        const sym = pair.s.replace('/', '');
        // 5 timeframes in parallel: 15m(primary), 1D, 1W, 4H, 1H
        // 價格類 K 線 OKX 優先（與實際成交所一致）
        return Promise.allSettled([
          fetchKlinesSmart(sym, interval, 220, pair.s),  // 主時框記錄逐幣數據源
          fetchKlinesSmart(sym, '1d', 100),
          fetchKlinesSmart(sym, '1w', 52),
          fetchKlinesSmart(sym, '4h', 100),
          fetchKlinesSmart(sym, '1h', 100),
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
        // 24h 成交額以幣安為準（量能分類口徑不變）；幣安批量失敗時退回 K 線估算
        const _bQV = quoteVols24[sym];
        const _volFinal = (_bQV != null && isFinite(_bQV)) ? Math.round(_bQV) : analysed.volume;
        // 數據源標記 + 價格小數位對齊 OKX 報價精度（quotePrecision）
        const _src  = _klineSrcBySymbol[pair.s] || 'binance';
        const _prec = _okxPrecision[sym];
        const _pxFinal = (_src === 'okx' && _prec != null)
          ? parseFloat((+analysed.price).toFixed(_prec)) : analysed.price;
        results[idx] = {
          ...analysed,
          price:          _pxFinal,
          dataSrc:        _src,
          onOkx:       _okxSymbolSet ? _okxSymbolSet.has(sym) : null,
          volume:         _volFinal,
          trend:          scoreToTrend(analysed.score),
          volumeStrength: getVolStr(_volFinal),
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
          dataSrc: 'binance',
          onOkx: _okxSymbolSet ? _okxSymbolSet.has(sym) : null,
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

  if (_klineSrcCount.okx || _klineSrcCount.binance) {
    console.info(`[數據源] K線 OKX ${_klineSrcCount.okx} 筆 / 幣安 ${_klineSrcCount.binance} 筆`);
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
      strictTrend:     item.strictTrend       ?? null,
      dataSrc:         item.dataSrc           ?? null,
      onOkx:        item.onOkx          ?? null,
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
    // OKX 原生支援週線(1W)/月線(1M)，全週期一律 OKX 優先、失敗自動降級幣安
    const raw = await fetchKlinesSmart(base, tf, limit);
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
    // 顯示記憶嚴重度；實際扣分有上限（見上方信心度變化），避免「嚴重度 52% 但風控分卻 75」的誤會
    deducts.push(`止損歷史記憶觸發（嚴重度 ${setup.learnPenalty}，實扣分以上方信心度變化為準）`);
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
