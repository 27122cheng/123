/* 新聞路徑重現（GitHub Actions 用）：主機筆電每次開頁在「新聞元件」步驟後主執行緒卡死。
   此沙盒連不到 RSS，所以在 Actions 上：跑 api/news.js 取得真實新聞 → 用 app.js 內同一批函式逐則處理，
   每一步同步寫 stdout（卡住時最後一行就是兇手）。父行程 60 秒逾時殺掉子行程並回報。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = s => fs.writeSync(1, s + '\n');

function extractFn(src, name) {
  const re = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\s*\\(`);
  const m = re.exec(src); if (!m) throw new Error('找不到函式 ' + name);
  let i = src.indexOf('{', m.index + m[0].length); let depth = 0, j = i;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } }
  return src.slice(m.index, j + 1);
}
function extractConst(src, name) {
  const re = new RegExp(`\\nconst ${name} = \\[`); const m = re.exec(src); if (!m) throw new Error('找不到常數 ' + name);
  const end = src.indexOf('\n];', m.index); return src.slice(m.index + 1, end + 3);
}

if (process.argv[2] === 'child') {
  const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const code = [
    'var _newsBiasNow = null; var _macroCache = null;',
    extractConst(app, '_INSIGHT_THEMES'), extractConst(app, 'CAPITAL_FLOW_EVENTS'),
    ...['aiProcessNews', 'buildNewsWidget', '_newsFreshnessLine', 'aiGenerateMarketInsights', 'computeCapitalFlowAIPred', 'buildCapitalFlowEventsWidget'].map(n => extractFn(app, n)),
    'globalThis.__f = { aiProcessNews, buildNewsWidget, _newsFreshnessLine, aiGenerateMarketInsights, buildCapitalFlowEventsWidget };',
  ].join('\n');
  (0, eval)(code);
  const f = globalThis.__f;
  out('step 本地AI新聞'); const ai = f.aiGenerateMarketInsights(); out('step buildNewsWidget(AI) ' + f.buildNewsWidget(ai).length + ' 字元');
  const _3mAgo = Date.now() - 90 * 86400000;
  const filtered = items.filter(it => !it.publishedAt || it.publishedAt >= _3mAgo);
  const toProcess = filtered.length >= 3 ? filtered : items;
  const processed = [];
  toProcess.forEach((item, i) => {
    out(`step aiProcessNews ${i + 1}/${toProcess.length} title=${JSON.stringify(item.title).slice(0, 120)} bodyLen=${(item.body || '').length}`);
    const t0 = Date.now();
    const ai = f.aiProcessNews(item.title, item.body);
    out(`  ok ${Date.now() - t0}ms zh=${ai.zhTitle.slice(0, 30)}`);
    processed.push({ ...ai, originalTitle: item.title, url: item.url, source: `📰 ${item.source}`, publishedAt: item.publishedAt });
  });
  out('step _newsFreshnessLine'); out('  ' + f._newsFreshnessLine(processed).length);
  out('step buildNewsWidget(real)'); out('  ' + f.buildNewsWidget(processed).length + ' 字元');
  out('step buildCapitalFlowEventsWidget'); out('  ' + f.buildCapitalFlowEventsWidget().length + ' 字元');
  out('ALL DONE');
  process.exit(0);
}

// 父行程：取新聞 → 存檔 → 子行程跑處理（60 秒逾時）
const handler = require(path.join(ROOT, 'api/news.js'));
const res = { _h: {}, setHeader(k, v) { this._h[k] = v; }, status(c) { this._c = c; return this; }, json(o) { this._body = o; }, send(b) { this._body = b; } };
await handler({ query: {}, headers: {} }, res);
const body = res._body || {};
out(`api/news → ok=${body.ok} items=${(body.items || []).length} src=${JSON.stringify(body.src || {})}`);
const items = body.items || [];
const tmp = path.join(process.env.RUNNER_TEMP || '/tmp', 'news_items.json');
fs.writeFileSync(tmp, JSON.stringify(items));
out('ITEMS_JSON_BEGIN'); out(JSON.stringify(items)); out('ITEMS_JSON_END');
if (items.length < 3) { out('新聞不足 3 則，無法重現'); process.exit(0); }
const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child', tmp], { timeout: 60000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
out(r.stdout || ''); if (r.stderr) out('STDERR: ' + r.stderr.slice(0, 2000));
if (r.error && r.error.code === 'ETIMEDOUT') { out('>>> 子行程 60 秒逾時：主執行緒卡死重現，最後一步見上方最後的 step 行'); process.exit(2); }
out('exit ' + r.status);
process.exit(r.status === 0 ? 0 : 1);
