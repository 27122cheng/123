import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* 守護頁：主機心跳停 150 秒且最後一步不是 unload → 另開主機（?revived=）→ 主機立即接手；
   使用者關掉主機（unload）不重開；3 分鐘冷卻；主機側看守護頁心跳、守護頁死了把它重開；診斷包附守護資訊 */
const BASE = 'http://127.0.0.1:8765/';
const b = await chromium.launch(); const ctx = await b.newContext();
const errs = []; ctx.on('page', p => p.on('pageerror', e => errs.push(p.url().slice(0, 40) + ': ' + String(e.message))));
const guard = await ctx.newPage();
await guard.goto(BASE + 'guard.html', { waitUntil: 'domcontentloaded' });
const stText = () => guard.evaluate(() => document.getElementById('st').textContent);
const ls = (k, v) => guard.evaluate(([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); }, [k, v]);
const lsGet = k => guard.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);

// ① 沒有主機心跳 → 提示
await guard.evaluate(() => { localStorage.clear(); });
await guard.waitForTimeout(5500);
let st = await stText();
if (!st.includes('尚未偵測到主機心跳')) throw new Error('① 無心跳狀態錯誤：' + st);
const gh = await lsGet('csp_guard_hb');
if (!gh || !gh.t || !gh.id) throw new Error('① 守護頁心跳未寫入：' + JSON.stringify(gh));
console.log('✓ ① 無主機心跳 → 「' + st + '」；守護頁心跳已寫');

// ② 心跳停 200 秒、最後一步是掃描 → 另開主機
const t0 = Date.now();
await ls('csp_hb', { t: t0 - 200e3, hid: true, on: true, scanning: true });
await ls('csp_last_step', { n: '掃描候選 MANA/USDT', t: t0 - 200e3, v: 'test', seq: 9 });
const revivedP = ctx.waitForEvent('page', { timeout: 15000 });
const revived = await revivedP;
const rUrl = revived.url();
if (!/index\.html\?revived=\d+/.test(rUrl)) throw new Error('② 另開的網址錯誤：' + rUrl);
let glog = await lsGet('csp_guard_log');
if (!glog || glog.length !== 1 || glog[0].step !== '掃描候選 MANA/USDT' || glog[0].gapS < 195) throw new Error('② 重啟紀錄錯誤：' + JSON.stringify(glog));
console.log(`✓ ② 心跳停 ${glog[0].gapS} 秒 → 另開 ${rUrl.replace(BASE, '/')}`);

// ③ 被開起來的主機：記錄 revived、拿掉網址參數、立即成為單機主機；守護頁確認心跳恢復
await revived.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('csp_health_log') || '[]').some(x => x.kind === 'revived'); } catch (e) { return false; } }, null, { timeout: 60000 });
const r3 = await revived.evaluate(() => ({ url: location.search, master: (() => { try { const m = getSignalMasterInfo(); return m && m.id === _TAB_ID; } catch (e) { return 'err:' + e.message; } })(), note: (JSON.parse(localStorage.getItem('csp_health_log') || '[]').find(x => x.kind === 'revived') || {}).text }));
if (/revived/.test(r3.url) || r3.master !== true || !/MANA/.test(r3.note)) throw new Error('③ 主機接手錯誤：' + JSON.stringify(r3));
await guard.waitForFunction(() => { const a = JSON.parse(localStorage.getItem('csp_guard_log') || '[]'); return a[0] && a[0].ok === true; }, null, { timeout: 20000 });
st = await stText();
if (!st.includes('主機活著')) throw new Error('③ 守護頁未確認心跳恢復：' + st);
console.log(`✓ ③ 主機：網址參數已清、已接手主機、紀錄「${r3.note.slice(0, 40)}…」；守護頁「${st}」`);

// ④ 主機被正常關閉（pagehide 寫 unload）→ 不重開
await revived.close();
await guard.waitForTimeout(1000);
const step4 = await lsGet('csp_last_step');
if (!step4 || step4.n !== 'unload') throw new Error('④ 關閉主機後最後一步不是 unload：' + JSON.stringify(step4));
await ls('csp_hb', { t: Date.now() - 200e3, hid: false, on: true, scanning: false });
await ls('csp_last_step', { n: 'unload', t: Date.now() - 199e3, seq: 10 });
await guard.waitForTimeout(6000);
st = await stText(); glog = await lsGet('csp_guard_log');
if (!st.includes('正常關閉') || glog.length !== 1 || ctx.pages().length !== 1) throw new Error('④ 正常關閉卻重開：' + st + ' / ' + glog.length + ' / ' + ctx.pages().length);
console.log('✓ ④ 主機正常關閉（unload）→ 「' + st.slice(0, 30) + '…」，不重開');

// ⑤ 3 分鐘冷卻：剛重啟過就再死 → 等待，不連開
await ls('csp_last_step', { n: 'K線分析 PUMP/USDT', t: Date.now() - 190e3, v: 'test', seq: 11 });
await guard.waitForTimeout(6000);
st = await stText(); glog = await lsGet('csp_guard_log');
if (!st.includes('再試一次') || glog.length !== 1 || ctx.pages().length !== 1) throw new Error('⑤ 冷卻失效：' + st + ' / ' + glog.length);
console.log('✓ ⑤ 冷卻中 → 「' + st + '」');

// ⑥ 第二個守護頁 → 待命
const guard2 = await ctx.newPage();
await guard2.goto(BASE + 'guard.html', { waitUntil: 'domcontentloaded' });
await guard2.waitForTimeout(800);
const st2 = await guard2.evaluate(() => document.getElementById('st').textContent);
if (!st2.includes('待命')) throw new Error('⑥ 第二個守護頁未待命：' + st2);
await guard2.close();
console.log('✓ ⑥ 第二個守護頁 → 「' + st2 + '」');
await guard.close();

// ⑦ 主機側：守護頁心跳停了（不是被關閉）→ 重開守護頁；被關閉（closed）→ 不開；診斷包附 guard
const app = await ctx.newPage();
await app.goto(BASE + 'index.html?safe=1', { waitUntil: 'domcontentloaded' });
await app.waitForFunction(() => typeof _guardTick === 'function' && typeof _diagBundle === 'function', null, { timeout: 20000 });
await app.evaluate(() => { localStorage.setItem('csp_guard_hb', JSON.stringify({ t: Date.now() - 200e3, id: 'x', born: Date.now() - 3600e3, closed: true })); _guardTick(); });
await app.waitForTimeout(800);
if (ctx.pages().length !== 1) throw new Error('⑦ 守護頁被使用者關閉卻重開');
const guardOpenP = ctx.waitForEvent('page', { timeout: 10000 });
await app.evaluate(() => { localStorage.setItem('csp_guard_hb', JSON.stringify({ t: Date.now() - 200e3, id: 'x', born: Date.now() - 3600e3 })); _guardTick(); });
const g2 = await guardOpenP;
if (!/guard\.html$/.test(g2.url())) throw new Error('⑦ 重開的不是守護頁：' + g2.url());
const r7 = await app.evaluate(() => { _guardTick(); const hl = JSON.parse(localStorage.getItem('csp_health_log') || '[]'); return { reopen: hl.filter(x => x.kind === 'guard-reopen').length, diag: _diagBundle().includes('"guard": {') && _diagBundle().includes('"log": ['), status: (() => { try { renderSignalMasterStatus(); return (document.getElementById('signal-master-status') || {}).textContent || ''; } catch (e) { return 'err:' + e.message; } })() }; });
if (r7.reopen !== 1 || !r7.diag) throw new Error('⑦ 主機側錯誤：' + JSON.stringify(r7));
await g2.waitForTimeout(600);
const g2st = await g2.evaluate(() => document.getElementById('st').textContent);
console.log(`✓ ⑦ 主機側：守護頁停止 → 重開 1 次（冷卻內不重複）、closed 不開；診斷包含 guard；重開的守護頁「${g2st.slice(0, 24)}…」`);

if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_guard');
await b.close();
