/* ============================================================
   CRYPTO SCANNER PRO — Settings Page
   ============================================================ */

function initSettings() {
  const s = getSettings();

  setSelectVal('tfSelect', s.defaultTimeframe);
  setSelectVal('intervalSelect', String(s.refreshInterval));
  setSelectVal('apiUrlInput', s.apiUrl);
  setToggle('darkModeToggle', s.darkMode !== false);
  setToggle('volumeToggle', s.showVolume !== false);
  setToggle('compactToggle', s.compactMode === true);
  setToggle('notifToggle', s.notifications === true);

  document.getElementById('apiUrlInput').value = s.apiUrl || 'http://127.0.0.1:8000';

  bindSettingsEvents();
  bindMobileNav();
  hideLoader();
}

function setSelectVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  if (el) el.checked = on;
}

function bindSettingsEvents() {
  document.getElementById('saveBtn')?.addEventListener('click', saveAll);
  document.getElementById('resetBtn')?.addEventListener('click', resetAll);
  document.getElementById('testApiBtn')?.addEventListener('click', testApi);
}

async function saveAll() {
  const patch = {
    defaultTimeframe: document.getElementById('tfSelect')?.value,
    refreshInterval: parseInt(document.getElementById('intervalSelect')?.value || '60'),
    darkMode: document.getElementById('darkModeToggle')?.checked,
    showVolume: document.getElementById('volumeToggle')?.checked,
    compactMode: document.getElementById('compactToggle')?.checked,
    notifications: document.getElementById('notifToggle')?.checked,
    apiUrl: document.getElementById('apiUrlInput')?.value?.trim() || 'http://127.0.0.1:8000'
  };

  saveSettings(patch);
  showToast('Settings saved successfully', 'success');

  // Animate button
  const btn = document.getElementById('saveBtn');
  if (btn) {
    btn.textContent = '✓ Saved';
    btn.style.background = 'var(--bullish)';
    setTimeout(() => {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Save Settings`;
      btn.style.background = '';
    }, 2000);
  }
}

function resetAll() {
  if (!confirm('Reset all settings to defaults?')) return;
  localStorage.removeItem('csp_settings');
  initSettings();
  showToast('Settings reset to defaults', 'info');
}

async function testApi() {
  const url = document.getElementById('apiUrlInput')?.value?.trim() || 'http://127.0.0.1:8000';
  const btn = document.getElementById('testApiBtn');
  const resultEl = document.getElementById('apiTestResult');

  if (btn) { btn.textContent = 'Testing…'; btn.disabled = true; }

  try {
    const res = await fetch(`${url}/scan?timeframe=15m`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = Array.isArray(data) ? data.length : '?';
    if (resultEl) {
      resultEl.textContent = `✓ Connected — ${count} coins received`;
      resultEl.style.color = 'var(--bullish)';
    }
    showToast(`API connected — ${count} coins received`, 'success');
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = `✕ Failed: ${err.message}`;
      resultEl.style.color = 'var(--bearish)';
    }
    showToast(`API unreachable: ${err.message}`, 'error', 5000);
  }

  if (btn) { btn.textContent = 'Test Connection'; btn.disabled = false; }
}

function bindMobileNav() {
  const mobileBtn = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (mobileBtn && sidebar && overlay) {
    mobileBtn.addEventListener('click', () => { sidebar.classList.toggle('open'); overlay.classList.toggle('active'); });
    overlay.addEventListener('click', () => { sidebar.classList.remove('open'); overlay.classList.remove('active'); });
  }
}

function showToast(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  container.appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 350); }, duration);
}

function hideLoader() {
  const el = document.getElementById('loadingOverlay');
  if (el) { setTimeout(() => el.classList.add('hide'), 200); setTimeout(() => el.remove(), 700); }
}

document.addEventListener('DOMContentLoaded', initSettings);
