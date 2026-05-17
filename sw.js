/* ── 加密掃描 Pro — Background Service Worker ───────────────── */
const DB_NAME  = 'csp-bg-db';
const DB_VER   = 1;
const KV_STORE = 'kv';
const COOLDOWN = 2 * 60 * 60 * 1000; // 2h，與前台相同

/* ── IndexedDB helpers（SW 無法存取 localStorage）─────────── */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(KV_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).put(val, key);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

/* ── SW 生命週期 ────────────────────────────────────────────── */
self.addEventListener('install',  e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* ── 後台週期同步（Chrome PWA / Android）───────────────────── */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'csp-check') {
    event.waitUntil(bgCheck());
  }
});

/* ── 接收前台訊息（同步設定 / 手動觸發）──────────────────────── */
self.addEventListener('message', event => {
  const { type, settings, pairs, cache } = event.data || {};
  if (type === 'SYNC_SETTINGS') {
    Promise.all([
      idbSet('settings', settings),
      idbSet('pairs',    pairs),
    ]);
  }
  if (type === 'SYNC_CACHE') {
    idbSet('signalCache', cache);
  }
  if (type === 'TRIGGER_CHECK') {
    event.waitUntil(bgCheck());
  }
});

/* ── 核心後台掃描邏輯 ───────────────────────────────────────── */
async function bgCheck() {
  const settings = await idbGet('settings');
  if (!settings?.notifTelegram || !settings?.tgToken || !settings?.tgChatId) return;

  const pairs  = (await idbGet('pairs')) || [];
  const apiUrl = (settings.apiUrl || 'http://127.0.0.1:8000') + '/scan';
  const apiKey = settings.apiKey || '';

  /* 呼叫掃描 API */
  let data;
  try {
    const hdrs = { 'Content-Type': 'application/json' };
    if (apiKey) { hdrs['Authorization'] = `Bearer ${apiKey}`; hdrs['X-API-Key'] = apiKey; }
    const res = await fetch(apiUrl, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ pairs }),
    });
    data = await res.json();
    if (!Array.isArray(data)) return;
  } catch {
    return; // API 不可用時靜默退出
  }

  const prev     = (await idbGet('signalCache')) || {};
  const now      = Date.now();
  const next     = { ...prev };
  const bullThr  = settings.notifBullScore || 65;
  const bearThr  = settings.notifBearScore || 35;

  for (const coin of data) {
    const isLong  = coin.score >= bullThr && (coin.trend === '強勢看漲' || coin.trend === '看漲');
    const isShort = coin.score <= bearThr && (coin.trend === '強勢看跌' || coin.trend === '看跌');
    if (!isLong && !isShort) continue;

    const dir    = isLong ? 'long' : 'short';
    const cached = prev[coin.symbol];
    if (cached && cached.dir === dir && (now - (cached.sentAt || 0)) < COOLDOWN) continue;

    const conf = Math.min(90, isLong ? coin.score : 100 - coin.score);
    if (conf < 60) continue;

    /* 發送 Telegram 通知 */
    const msg =
      `🚨 <b>${isLong ? '▲ 做多' : '▼ 做空'} 信號：${coin.symbol}</b>\n\n` +
      `📊 評分 <b>${coin.score}</b> | ${coin.trend}\n` +
      `💰 現價：$${coin.price}\n` +
      `📶 信號強度：<b>${conf}%</b>\n\n` +
      `⚡ <i>後台監控自動通知</i>`;
    try {
      await fetch(`https://api.telegram.org/bot${settings.tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.tgChatId, text: msg, parse_mode: 'HTML' }),
      });
    } catch {}

    next[coin.symbol] = { dir, sentAt: now };
  }

  await idbSet('signalCache', next);
}
