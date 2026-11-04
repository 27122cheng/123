import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
/* 守護頁：彈出權限探測；主機心跳停 150 秒且最後一步不是 unload → 另開主機（?revived=）→ 主機立即接手；
   使用者關掉主機（unload）不重開；3 分鐘冷卻；第二個守護頁待命；彈出被封鎖 → 守護頁自己轉為主機 → 主機顯示「開啟守護頁」橫幅；
   主機側看守護頁心跳、守護頁死了把它重開；電腦守護程式開的主機（?revived=ps…）；診斷包附 guard */
const BASE = 'http://127.0.0.1:8765/';
const b = await chromium.launch(); const ctx = await b.newContext();
const errs = []; ctx.on('page', p => p.on('pageerror', e => errs.push(p.url().slice(0, 40) + ': ' + String(e.message))));
// 等「網址含 pattern」的新分頁（探測用的 about:blank 小視窗不算）
const waitPage = (re, timeout = 15000) => new Promise((res, rej) => { const t0 = Date.now(); const h = async p => { try { await p.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch (e) {} if (re.test(p.url())) { ctx.off('page', h); res(p); } else if (Date.now() - t0 > timeout) { ctx.off('page', h); rej(new Error('timeout')); } }; ctx.on('page', h); setTimeout(() => { ctx.off('page', h); rej(new Error('waitPage timeout ' + re)); }, timeout); });
const guard = await ctx.newPage();
await guard.goto(BASE + 'guard.html', { waitUntil: 'domcontentloaded' });
const stText = () => guard.evaluate(() => document.getElementById('st').textContent);
const ls = (k, v) => guard.evaluate(([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); }, [k, v]);
const lsGet = k => guard.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);

// ① 沒有主機心跳 → 提示；彈出權限探測（Playwright 不封鎖彈出 → 允許）
await guard.evaluate(() => { localStorage.clear(); localStorage.setItem('csp_full_reset_v2', '1'); localStorage.setItem('csp_riskctl_reset_v1', '1'); });   // 清空但保留一次性重置標記，否則主機開頁時 fullDataResetV2 會把守護紀錄一起清掉
await guard.waitForTimeout(5500);
let st = await stText();
if (!st.includes('尚未偵測到主機心跳')) throw new Error('① 無心跳狀態錯誤：' + st);
const gh = await lsGet('csp_guard_hb');
if (!gh || !gh.t || !gh.id || gh.popup !== true) throw new Error('① 守護頁心跳／彈出探測錯誤：' + JSON.stringify(gh));
const c1 = await guard.evaluate(() => document.getElementById('c1-txt').textContent);
if (!c1.includes('已允許')) throw new Error('① 彈出權限檢查文字錯誤：' + c1);
for (const p of ctx.pages()) if (p !== guard) await p.close();   // 探測小視窗若還在就關掉
console.log('✓ ① 無主機心跳 → 「' + st + '」；彈出權限「' + c1 + '」');

// ② 心跳停 200 秒、最後一步是掃描 → 另開主機
const t0 = Date.now();
const revivedP = waitPage(/index\.html\?revived=\d+/);
await ls('csp_hb', { t: t0 - 200e3, hid: true, on: true, scanning: true });
await ls('csp_last_step', { n: '掃描候選 MANA/USDT', t: t0 - 200e3, v: 'test', seq: 9 });
const revived = await revivedP;
let glog = await lsGet('csp_guard_log');
if (!glog || glog.length !== 1 || glog[0].step !== '掃描候選 MANA/USDT' || glog[0].gapS < 195) throw new Error('② 重啟紀錄錯誤：' + JSON.stringify(glog));
console.log(`✓ ② 心跳停 ${glog[0].gapS} 秒 → 另開 ${revived.url().replace(BASE, '/')}`);

// ③ 被開起來的主機：記錄 revived、拿掉網址參數、立即成為單機主機；守護頁確認心跳恢復；守護頁活著 → 不出現「開啟守護頁」橫幅
await revived.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('csp_health_log') || '[]').some(x => x.kind === 'revived'); } catch (e) { return false; } }, null, { timeout: 60000 });
const r3 = await revived.evaluate(() => ({ url: location.search, master: (() => { try { const m = getSignalMasterInfo(); return m && m.id === _TAB_ID; } catch (e) { return 'err:' + e.message; } })(), note: (JSON.parse(localStorage.getItem('csp_health_log') || '[]').find(x => x.kind === 'revived') || {}).text }));
if (/revived/.test(r3.url) || r3.master !== true || !/MANA/.test(r3.note)) throw new Error('③ 主機接手錯誤：' + JSON.stringify(r3));
await guard.waitForFunction(() => { const a = JSON.parse(localStorage.getItem('csp_guard_log') || '[]'); return a[0] && a[0].ok === true; }, null, { timeout: 20000 });
st = await stText();
if (!st.includes('主機活著')) throw new Error('③ 守護頁未確認心跳恢復：' + st);
await revived.waitForTimeout(3500);
if (await revived.$('#guard-offer')) throw new Error('③ 守護頁活著卻出現「開啟守護頁」橫幅');
console.log(`✓ ③ 主機：網址參數已清、已接手主機、紀錄「${r3.note.slice(0, 40)}…」；守護頁「${st}」；無橫幅`);

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

// ⑤ 3 分鐘冷卻：剛重啟過就再死 → 等待，不連開（紅色按鈕可手動）
await ls('csp_last_step', { n: 'K線分析 PUMP/USDT', t: Date.now() - 190e3, v: 'test', seq: 11 });
await guard.waitForTimeout(6000);
st = await stText(); glog = await lsGet('csp_guard_log');
const fb = await guard.evaluate(() => document.getElementById('open-fallback').style.display);
if (!st.includes('再自動試一次') || glog.length !== 1 || ctx.pages().length !== 1 || fb === 'none') throw new Error('⑤ 冷卻失效：' + st + ' / ' + glog.length + ' / ' + fb);
console.log('✓ ⑤ 冷卻中 → 「' + st + '」，紅色手動按鈕可見');

// ⑥ 第二個守護頁 → 待命
const guard2 = await ctx.newPage();
await guard2.goto(BASE + 'guard.html', { waitUntil: 'domcontentloaded' });
await guard2.waitForTimeout(1200);
const st2 = await guard2.evaluate(() => document.getElementById('st').textContent);
if (!st2.includes('待命')) throw new Error('⑥ 第二個守護頁未待命：' + st2);
await guard2.close();
for (const p of ctx.pages()) if (p !== guard) await p.close();
console.log('✓ ⑥ 第二個守護頁 → 「' + st2 + '」');
// ⑦ 的前置：清掉重啟紀錄（冷卻是讀開頁時載入的紀錄）、放一個已死的主機心跳，再關掉本守護頁
await guard.evaluate(() => { localStorage.removeItem('csp_guard_log'); localStorage.setItem('csp_hb', JSON.stringify({ t: Date.now() - 200e3, hid: true, on: true })); localStorage.setItem('csp_last_step', JSON.stringify({ n: '掃描候選 CHZ/USDT', t: Date.now() - 200e3, v: 'test', seq: 12 })); });
await guard.close();

// ⑦ 彈出被封鎖（?nopopup=1）→ 守護頁自己轉為主機（location.replace …&from=guard）→ 主機接手並顯示「開啟守護頁」橫幅
const g3 = await ctx.newPage();
await g3.goto(BASE + 'guard.html?nopopup=1', { waitUntil: 'domcontentloaded' });
const c1b = await g3.evaluate(() => (document.getElementById('c1-txt') || {}).textContent || '（已跳轉）');   // 探測在第一次 tick 前完成，800ms 後就跳轉

if (!c1b.includes('被封鎖') && c1b !== '（已跳轉）') throw new Error('⑦ 封鎖探測錯誤：' + c1b);
await g3.waitForURL(/index\.html\?revived=\d+&from=guard/, { timeout: 15000 });
await g3.waitForFunction(() => !!document.getElementById('guard-offer'), null, { timeout: 60000 });
const r7 = await g3.evaluate(() => ({ url: location.search, bar: document.getElementById('guard-offer').textContent, hb: JSON.parse(localStorage.getItem('csp_guard_hb') || 'null'), log: JSON.parse(localStorage.getItem('csp_guard_log') || '[]')[0], note: (JSON.parse(localStorage.getItem('csp_health_log') || '[]').find(x => x.kind === 'revived') || {}).text }));
if (/revived|from=/.test(r7.url) || !r7.bar.includes('開啟守護頁') || !r7.hb || !r7.hb.handoff || !r7.hb.closed || !r7.log || r7.log.how !== 'handoff' || !/原本的守護頁/.test(r7.note)) throw new Error('⑦ 轉為主機錯誤：' + JSON.stringify(r7));
// 橫幅按鈕（使用者手勢）→ 開出守護頁
const g4P = waitPage(/guard\.html$/);
await g3.click('#guard-offer button');
const g4 = await g4P;
await g4.waitForTimeout(1200);
const st4 = await g4.evaluate(() => document.getElementById('st').textContent);
if (!st4.includes('主機活著')) throw new Error('⑦ 橫幅開出的守護頁狀態錯誤：' + st4);
console.log(`✓ ⑦ 彈出被封鎖 → 守護頁轉為主機（紀錄 how=handoff）→ 橫幅「${r7.bar.slice(0, 20)}…」→ 按鈕開出守護頁「${st4.slice(0, 16)}…」`);
await g4.close(); await g3.close();

// ⑧ 主機側：守護頁心跳停了（不是被關閉）→ 重開守護頁；被關閉（closed）→ 不開；電腦守護程式開的（?revived=ps…）→ 記錄＋橫幅；診斷包附 guard
const app = await ctx.newPage();
await app.goto(BASE + 'index.html?safe=1&revived=ps' + Date.now(), { waitUntil: 'domcontentloaded' });
await app.waitForFunction(() => typeof _guardTick === 'function' && typeof _diagBundle === 'function', null, { timeout: 20000 });
await app.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('csp_health_log') || '[]').some(x => x.kind === 'revived' && /host-watchdog/.test(x.text)); } catch (e) { return false; } }, null, { timeout: 60000 });
await app.waitForFunction(() => !!document.getElementById('guard-offer'), null, { timeout: 10000 });
await app.evaluate(() => { document.getElementById('guard-offer').remove(); localStorage.setItem('csp_guard_hb', JSON.stringify({ t: Date.now() - 200e3, id: 'x', born: Date.now() - 3600e3, closed: true })); _guardTick(); });
await app.waitForTimeout(800);
if (ctx.pages().length !== 1) throw new Error('⑧ 守護頁被使用者關閉卻重開');
const guardOpenP = waitPage(/guard\.html$/, 10000);
await app.evaluate(() => { localStorage.setItem('csp_guard_hb', JSON.stringify({ t: Date.now() - 200e3, id: 'x', born: Date.now() - 3600e3 })); _guardTick(); });
const g5 = await guardOpenP;
const r8 = await app.evaluate(() => { _guardTick(); const hl = JSON.parse(localStorage.getItem('csp_health_log') || '[]'); return { reopen: hl.filter(x => x.kind === 'guard-reopen').length, diag: _diagBundle().includes('"guard": {') && _diagBundle().includes('"log": ['), url: location.search }; });
if (r8.reopen !== 1 || !r8.diag || /revived/.test(r8.url)) throw new Error('⑧ 主機側錯誤：' + JSON.stringify(r8));
await g5.waitForTimeout(600);
console.log(`✓ ⑧ 主機側：電腦守護程式開的主機有紀錄＋橫幅；守護頁停止 → 重開 1 次（冷卻內不重複）、closed 不開；診斷包含 guard`);

if (errs.length) throw new Error('頁面錯誤：' + errs.join(' | '));
console.log('ALL PASS t_guard');
await b.close();
