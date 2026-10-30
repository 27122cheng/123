// api/report.js：POST 崩潰回報進記憶體＋GET 取回
const h = (await import('../api/report.js')).default || (await import('module')).createRequire(import.meta.url)('../api/report.js');
const mk = (method, body, q) => { const res = { _h: {}, setHeader(k, v) { this._h[k] = v; }, status(c) { this._c = c; return this; }, json(o) { this._j = o; }, end() {} };
  return [{ method, query: q || {}, headers: { 'user-agent': 'UA' }, body }, res]; };
let [req, res] = mk('POST', JSON.stringify([{ type: 'crash', url: 'https://x/', age: 10, body: { reason: 'oom' } }]));
await h(req, res); if (res._c !== 204) throw new Error('POST 應回 204');
[req, res] = mk('GET', undefined, { recent: '1' });
await h(req, res); if (res._c !== 200 || !res._j.ok || res._j.reports.length !== 1 || res._j.reports[0].body.reason !== 'oom') throw new Error('GET 錯誤：' + JSON.stringify(res._j));
console.log('✓ report：POST 204 入庫、GET 取回 reason=oom');
console.log('ALL PASS t_report');
