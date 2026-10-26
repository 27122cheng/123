import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
// 模擬上次開頁沒走完：留下一份沒有 done 的軌跡
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('csp_boot_trace', JSON.stringify(['start@0.1s', '掃描 60%@4.4s', '掃描 80%@5.5s'])); localStorage.removeItem('csp_boot_fail_n'); });
await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
const early = await p.evaluate(() => ({ auto: AUTO_SAFE, htmlLite: document.documentElement.classList.contains('lite'), failN: localStorage.getItem('csp_boot_fail_n'), started: _postBootStarted }));
await p.waitForFunction(() => _bootTraceArr.some(x => x.startsWith('done')), { timeout: 60000 });
const trace = await p.evaluate(() => _bootTraceArr.slice());
const chip = await p.evaluate(() => document.getElementById('err-chip-body')?.textContent || '');
await p.waitForFunction(() => _postBootStarted === true, { timeout: 20000 });
const hl = await p.evaluate(() => JSON.parse(localStorage.getItem('csp_health_log') || '[]').map(x => x.kind));
const late = await p.evaluate(() => ({ failN: localStorage.getItem('csp_boot_fail_n'), worker: !!_hbWorker, keep: _keepAlive.lock, health: !!_healthTimer, bodyLite: document.body.classList.contains('lite'), htmlLite: document.documentElement.classList.contains('lite') }));
console.log('early', JSON.stringify(early));
console.log('trace', trace.join(' → '));
console.log('chip', chip.slice(0, 120));
console.log('healthLog kinds', hl.join(','));
console.log('late', JSON.stringify(late));
if (!early.auto || !early.htmlLite || early.started) throw new Error('自動安全模式開頭狀態錯誤');
if (early.failN !== '1') throw new Error('boot-fail 計數應為 1');
if (late.failN !== null) throw new Error('done 後 boot-fail 計數應清除');
if (late.worker || late.keep || !late.health) throw new Error('安全模式下不該啟動工作執行緒／保活，但健康監視要在');
// 自動安全模式：資訊卡延後到 done 之後載入（不是整輪停在「載入…」）
await p.waitForFunction(() => !document.querySelector('#market-outlook-body .adv-loading') && !document.querySelector('#capital-flow-body .adv-loading'), { timeout: 40000 });
const cards = await p.evaluate(() => ['market-outlook-body', 'news-body', 'capital-flow-body'].map(id => document.getElementById(id).textContent.trim().slice(0, 14)));
console.log('safe cards', JSON.stringify(cards));
if (!trace.some(x => x.startsWith('現貨價/幣種表')) || !trace.some(x => x.startsWith('持倉更新'))) throw new Error('細粒度標記缺失');
if (!chip.includes('載入線索') || !hl.includes('boot-fail') || !hl.includes('boot-safe')) throw new Error('線索／健康日誌缺失');
// 第二次（正常模式）：模組在 done 後啟動，含工作執行緒與保活
await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
const n2 = await p.evaluate(() => ({ auto: AUTO_SAFE, started: _postBootStarted }));
await p.waitForFunction(() => _postBootStarted === true, { timeout: 80000 });
const n2late = await p.evaluate(() => ({ worker: !!_hbWorker, health: !!_healthTimer, trace: _bootTraceArr.length }));
console.log('normal', JSON.stringify(n2), JSON.stringify(n2late));
if (n2.auto || n2.started || !n2late.worker || !n2late.health) throw new Error('正常模式啟動順序錯誤');
const realErrs = errs.filter(e => !/fetch|network|Failed to load/i.test(e));
if (realErrs.length) throw new Error('頁面錯誤：' + realErrs.join(' | '));
// 主執行緒卡死線索：index.html 行內腳本先留住上次最後步驟 → 下次開頁紅條顯示凍結線索；腳本 defer；done 後麵包屑歸 idle
const idle = await p.evaluate(() => JSON.parse(localStorage.getItem('csp_last_step') || '{}').n);
// 模擬被強制結束：正常離開會寫 unload，所以在 pagehide 之後再覆寫成「卡在 K 線分析」
await p.evaluate(() => window.addEventListener('pagehide', () => localStorage.setItem('csp_last_step', JSON.stringify({ n: 'K線分析 ZZ/USDT', t: Date.now() - 120e3, v: 'x' }))));
await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof _bootErrHook === 'function' && !!document.getElementById('err-chip-body'), { timeout: 30000 });
const hang = await p.evaluate(() => ({ prev: window._cspPrevStep && window._cspPrevStep.n, chip: (JSON.parse(localStorage.getItem('csp_err_log') || '[]').find(x => x.kind === '凍結線索') || {}).msg || '', deferred: !!document.querySelector('script[src*="app.js"]').defer, tvAsync: !!document.querySelector('script[src*="tv.js"]').async }));
console.log('idle', idle, 'hang', JSON.stringify(hang).slice(0, 200));
if (idle.startsWith('開頁 ') || hang.prev !== 'K線分析 ZZ/USDT' ||  !hang.chip.includes('K線分析 ZZ/USDT') || !hang.deferred || !hang.tvAsync) throw new Error('卡死線索錯誤');
await p.waitForFunction(() => _bootTraceArr.some(x => x.startsWith('done')), { timeout: 60000 });
// 繪製麵包屑：開頁後應出現「首頁 繪製中」→「首頁 已繪製」與「資訊卡 繪製中／已繪製」
await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { window.__marks = []; const o = _stepMark; _stepMark = n => { window.__marks.push(n); return o(n); }; });
await p.waitForFunction(() => window.__marks.includes('首頁 已繪製') && window.__marks.includes('資訊卡 已繪製'), { timeout: 90000 });
const pm = await p.evaluate(() => ({ a: window.__marks.indexOf('首頁 繪製中') < window.__marks.indexOf('首頁 已繪製'), b: window.__marks.indexOf('資訊卡 繪製中') < window.__marks.indexOf('資訊卡 已繪製'), n: window.__marks.length }));
if (!pm.a || !pm.b) throw new Error('繪製麵包屑順序錯誤：' + JSON.stringify(pm));
console.log('繪製麵包屑 OK（' + pm.n + ' 個步驟）');
// ?nocards=1：四張卡顯示停用說明、loadDashboardMacro 不抓
await p.goto('http://127.0.0.1:8765/index.html?nocards=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof AUTO_NOCARDS !== 'undefined' && (document.getElementById('news-body')?.textContent || '').includes('資訊卡已停用'), { timeout: 60000 });
// 連續兩次「心跳與步驟同時停」→ 自動停用資訊卡
const arm = () => p.evaluate(() => window.addEventListener('pagehide', () => { const t = Date.now() - 120e3; localStorage.setItem('csp_last_step', JSON.stringify({ n: '新聞元件', t, v: 'x' })); localStorage.setItem('csp_hb', JSON.stringify({ t: t + 2000 })); }));
await p.evaluate(() => localStorage.removeItem('csp_freeze_n'));
await arm(); await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
const f1 = await p.evaluate(() => ({ n: localStorage.getItem('csp_freeze_n'), auto: _autoNoCards }));
await arm(); await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!document.getElementById('err-chip-body'), { timeout: 30000 });
const f2 = await p.evaluate(() => ({ n: localStorage.getItem('csp_freeze_n'), auto: _autoNoCards, chip: (JSON.parse(localStorage.getItem('csp_err_log') || '[]').find(x => x.kind === '凍結線索') || {}).msg || '', note: document.getElementById('news-body')?.textContent || '' }));
console.log('freeze', JSON.stringify(f1), JSON.stringify(f2).slice(0, 160));
if (f1.n !== '1' || f1.auto || f2.n !== '2' || !f2.auto || !(f2.chip.includes('自動停用') || f2.chip.includes('自動二分')) ) throw new Error('連續卡死自動停用資訊卡錯誤');
await p.waitForFunction(() => (document.getElementById('news-body')?.textContent || '').includes('資訊卡已停用'), { timeout: 60000 });
// 正常關閉（unload）→ 計數歸零（先清掉二分狀態，它會持續到有結論）
await p.evaluate(() => localStorage.removeItem('csp_bisect'));
await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
const f3 = await p.evaluate(() => ({ n: localStorage.getItem('csp_freeze_n'), auto: _autoNoCards }));
if (f3.n !== null || f3.auto) throw new Error('正常關閉後計數應歸零：' + JSON.stringify(f3));
await p.waitForFunction(() => _bootTraceArr.some(x => x.startsWith('done')), { timeout: 60000 });
// 寫入序號：cookie 的「準備寫入」序號與 localStorage 的序號同步；?nols=1 時不寫 csp_hb／csp_last_step
const sq = await p.evaluate(() => { _stepMark('序號測試'); const pend = _readPendCookie(); const ls = JSON.parse(localStorage.getItem('csp_last_step') || '{}'); return { pend, ls: { n: ls.n, seq: ls.seq } }; });
if (!sq.pend || sq.pend.n !== '序號測試' || sq.pend.seq !== sq.ls.seq || sq.ls.n !== '序號測試') throw new Error('寫入序號錯誤：' + JSON.stringify(sq));
// 模擬「寫入卡住」：cookie 序號比 localStorage 大 → 下次開頁有「寫入卡住線索」
await p.evaluate(() => window.addEventListener('pagehide', () => { const t = Date.now() - 120e3; localStorage.setItem('csp_last_step', JSON.stringify({ n: '新聞元件', t, v: 'x', seq: 40 })); localStorage.setItem('csp_hb', JSON.stringify({ t: t + 2000 })); document.cookie = 'csp_pend=' + encodeURIComponent('41|資訊卡 繪製中') + ';path=/;max-age=600;SameSite=Lax'; }));
await p.goto('http://127.0.0.1:8765/index.html?nols=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!document.getElementById('err-chip-body'), { timeout: 30000 });
const lh = await p.evaluate(async () => { await new Promise(r => setTimeout(r, 6000)); return { hang: (JSON.parse(localStorage.getItem('csp_health_log') || '[]')).some(x => x.kind === 'ls-hang') || _healthLog.some(x => x.kind === 'ls-hang'), noLs: NO_LS, hbT: JSON.parse(localStorage.getItem('csp_hb') || '{}').t, ls: JSON.parse(localStorage.getItem('csp_last_step') || '{}').n }; });
console.log('ls-hang', JSON.stringify(lh));
if (!lh.hang || !lh.noLs || !(Date.now() - lh.hbT > 60000) || lh.ls !== '載入腳本') throw new Error('寫入卡住線索／nols 錯誤：' + JSON.stringify(lh));
await p.evaluate(() => { localStorage.removeItem('csp_freeze_n'); localStorage.removeItem('csp_bisect'); document.cookie = 'csp_pend=;path=/;max-age=0'; });
// 自動二分：連續兩次卡死 → 第 1 組 none；活過（ok）→ env；env 卡死 → 結論 env、全停
const armFreeze = () => p.evaluate(() => window.addEventListener('pagehide', () => { const t = Date.now() - 120e3; localStorage.setItem('csp_last_step', JSON.stringify({ n: '新聞元件', t, v: 'x', seq: 1 })); localStorage.setItem('csp_hb', JSON.stringify({ t: t + 2000 })); document.cookie = 'csp_pend=' + encodeURIComponent('1|新聞元件') + ';path=/;max-age=600;SameSite=Lax'; }));
await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
await armFreeze(); await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
await armFreeze(); await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
const b1 = await p.evaluate(() => ({ b: JSON.parse(localStorage.getItem('csp_bisect') || 'null'), nocards: AUTO_NOCARDS, allow: _cardsAllow }));
await p.evaluate(() => { const b = JSON.parse(localStorage.getItem('csp_bisect')); b.ok = true; localStorage.setItem('csp_bisect', JSON.stringify(b)); });   // 模擬活過 90 秒
await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
const b2 = await p.evaluate(() => ({ b: JSON.parse(localStorage.getItem('csp_bisect') || 'null'), nocards: AUTO_NOCARDS, allow: _cardsAllow, txt: _bisectText() }));
await armFreeze(); await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!document.getElementById('err-chip-body'), { timeout: 30000 });
const b3 = await p.evaluate(() => ({ b: JSON.parse(localStorage.getItem('csp_bisect') || 'null'), nocards: AUTO_NOCARDS, txt: _bisectText(), chip: document.getElementById('err-chip-body').textContent }));
console.log('bisect', JSON.stringify(b1), JSON.stringify(b2.allow), b3.b.done, b3.txt.slice(0, 40));
if (!b1.b || b1.b.i !== 0 || !b1.nocards || b2.b.i !== 1 || !Array.isArray(b2.allow) || b2.allow[0] !== 'env' || b2.nocards || b3.b.done !== 'env' || !b3.nocards || !b3.txt.includes('兇手是')) throw new Error('自動二分錯誤：' + JSON.stringify({ b1, b2, b3: { b: b3.b, nocards: b3.nocards } }));
await p.goto('http://127.0.0.1:8765/index.html?bisect=0', { waitUntil: 'domcontentloaded' });
const b4 = await p.evaluate(() => ({ b: localStorage.getItem('csp_bisect'), nocards: AUTO_NOCARDS }));
if (b4.b !== null || b4.nocards) throw new Error('?bisect=0 應清除：' + JSON.stringify(b4));
await p.evaluate(() => { localStorage.removeItem('csp_freeze_n'); document.cookie = 'csp_pend=;path=/;max-age=0'; });
// 真兇回歸測試：已公布的 BLS 事件有快取但沒有實際值 → 舊版會在 buildTodayEconWidget 的 .then 鏈裡無限重建（主執行緒卡死）
await p.goto('http://127.0.0.1:8765/index.html?safe=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof buildTodayEconWidget === 'function' && typeof getMonthEconEvents === 'function', { timeout: 30000 });
const econ = await Promise.race([p.evaluate(async () => {
  const now = new Date(); const evs = getMonthEconEvents(now.getFullYear(), now.getMonth()).filter(ev => BLS_SERIES_MAP[ev.name] && ev.eventTime.getTime() < Date.now());
  if (!evs.length) return { skip: true };
  const ev = evs[0]; const dateKey = `${ev.eventTime.getFullYear()}-${ev.eventTime.getMonth()}-${ev.eventTime.getDate()}`;
  localStorage.removeItem(`econ_actual_${ev.name}_${dateKey}`); localStorage.setItem(`econ_bls_cache_${ev.name}_${dateKey}`, '+2.9%'); _econFetchFailed.delete(`${ev.name}_${dateKey}`); _econRebuildN = 0;
  const host = document.getElementById('market-outlook-body'); host.innerHTML = buildTodayEconWidget();
  await new Promise(r => setTimeout(r, 800));
  const r = { name: ev.name, rebuilds: _econRebuildN, actual: getEconActualValue(ev.name, dateKey), hasWidget: !!document.getElementById('econMonthWidget'), inflight: _econFetchInflight.size };
  localStorage.removeItem(`econ_actual_${ev.name}_${dateKey}`); localStorage.removeItem(`econ_bls_cache_${ev.name}_${dateKey}`);
  return r;
}), new Promise((_, rej) => setTimeout(() => rej(new Error('頁面在月曆元件重建中卡死（真兇未修）')), 20000))]);
console.log('econ', JSON.stringify(econ));
if (!econ.skip && (econ.rebuilds > 1 || econ.actual !== '+2.9%' || econ.inflight !== 0)) throw new Error('月曆元件重建迴圈未修好：' + JSON.stringify(econ));
console.log('ALL PASS t_boot');
await b.close();
