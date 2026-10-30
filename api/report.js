/* ── Chrome Reporting API 崩潰回報接收端（2026-10-30）────────────────────────
   使用者兩台 Windows 機器上，分頁跑幾小時後「變黑」、主執行緒與工作執行緒同時停、沒有錯誤頁；
   頁面自己無法記錄自己的死亡。Chrome 的 Reporting API 會在分頁的渲染程序被結束時，由瀏覽器把
   { type: "crash", body: { reason: "oom" | "unreachable" } } 送到文件回應標頭 Reporting-Endpoints 指定的端點
   （vercel.json 已對 / 與 /index.html 加上該標頭）。oom＝記憶體超限被結束；unreachable＝無回應被結束。
   這裡：① 寫進 Vercel 函式日誌（專案 → Logs 可查）；② 保留最近 50 筆在記憶體（同一個暖實例內），
   前端開頁時 GET ?recent=1 取回顯示在紅條與診斷包。 */
const MAX = 50;
function store() { if (!globalThis.__cspReports) globalThis.__cspReports = []; return globalThis.__cspReports; }
function readBody(req) {
  return new Promise(resolve => {
    if (req.body !== undefined && req.body !== null && req.body !== '') { resolve(req.body); return; }
    let data = ''; req.on('data', c => { data += c; if (data.length > 200000) data = data.slice(0, 200000); }); req.on('end', () => resolve(data)); req.on('error', () => resolve(''));
  });
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST') {
    let raw = await readBody(req);
    let arr = [];
    try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_e) { arr = []; }
    if (!Array.isArray(arr)) arr = [arr];
    const at = Date.now(); const s = store();
    for (const r of arr.slice(0, 20)) {
      const item = { at, type: r && r.type, url: r && r.url, age: r && r.age, body: r && r.body, ua: String(req.headers['user-agent'] || '').slice(0, 160) };
      s.unshift(item); if (s.length > MAX) s.length = MAX;
      console.log('[crash-report]', JSON.stringify(item));
    }
    res.status(204).end(); return;
  }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.status(204).end(); return; }
  res.status(200).json({ ok: true, reports: store() });
};
