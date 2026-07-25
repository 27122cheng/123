/* ── 訊號主機雲端仲裁（Vercel Serverless Function）─────────────────
   問題：訊號主機原本存在 localStorage，只能協調「同一個瀏覽器的分頁」。
   手機與電腦各開一份時，兩邊各自有自己的主機，訊號仍會重複發送。
   解法：把「誰是主機」放到雲端 KV，所有裝置共用同一份、以最新宣告時間
   為準，真正做到全裝置只有一台會建單與發訊號。

   儲存後端：Vercel KV / Upstash Redis（REST API）。
   環境變數（Vercel KV 建立後會自動注入，Upstash 則用 UPSTASH_* 那組）：
     KV_REST_API_URL / KV_REST_API_TOKEN
     或 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
   未設定時回 503 並附說明，前端會自動退回單機（localStorage）模式，
   不會因此壞掉。

   GET  /api/master        → 讀取目前主機 { id, ts, ua }
   POST /api/master {id,ua}→ 宣告主機（最新宣告覆蓋前者），回傳存入的值 */

const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'csp:signal_master';

async function redis(command) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`KV ${r.status}`);
  const j = await r.json();
  return j && j.result;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!KV_URL || !KV_TOKEN) {
    res.status(503).json({
      ok: false,
      reason: 'kv_not_configured',
      hint: '尚未設定雲端儲存。請在 Vercel 專案新增 KV（Storage → Create Database → KV），'
          + '建立後環境變數會自動注入，重新部署即生效。前端目前以單機模式運作。',
    });
    return;
  }
  try {
    if (req.method === 'POST') {
      // body 可能已被平台解析為物件，也可能仍是字串
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_e) { body = {}; } }
      const id = body && body.id;
      if (!id) { res.status(400).json({ ok: false, reason: 'missing_id' }); return; }
      const info = { id: String(id), ts: Date.now(), ua: String((body && body.ua) || '') };
      await redis(['SET', KEY, JSON.stringify(info)]);
      res.status(200).json({ ok: true, master: info });
      return;
    }
    const raw = await redis(['GET', KEY]);
    let master = null;
    if (raw) { try { master = JSON.parse(raw); } catch (_e) { master = null; } }
    res.status(200).json({ ok: true, master });
  } catch (e) {
    res.status(502).json({ ok: false, reason: String((e && e.message) || e) });
  }
};
