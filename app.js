// ---- THEME ----
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
  document.querySelector('meta[name="theme-color"]').content = resolved === 'light' ? '#f8fafc' : '#0c0f1a';
}
function setTheme(mode) {
  localStorage.setItem('theme', mode);
  applyTheme(mode === 'auto' ? getSystemTheme() : mode);
  updateThemeToggle(mode);
}
function updateThemeToggle(mode) {
  const btns = document.querySelectorAll('#themeToggle button');
  const modes = ['light', 'auto', 'dark'];
  btns.forEach((b, i) => {
    const on = modes[i] === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
}
function initTheme() {
  const saved = localStorage.getItem('theme') || 'auto';
  applyTheme(saved === 'auto' ? getSystemTheme() : saved);
  updateThemeToggle(saved);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((localStorage.getItem('theme') || 'auto') === 'auto') applyTheme(getSystemTheme());
  });
}
initTheme();

// ---- CONSTANTS ----
const CAT_COLORS = {Audio:'#f59e0b',Laptop:'#3b82f6',Wearable:'#ec4899',Tablet:'#8b5cf6',Desktop:'#10b981',Smartphone:'#ef4444',Drone:'#06b6d4',Fotografia:'#a855f7',Gaming:'#f97316',Altro:'#6b7280'};
const CATEGORIES = Object.keys(CAT_COLORS);
const THRESHOLDS = [1, 0.50, 0.25];
const DEFAULT_DATA = [
  {"product":"Airpods 3 gen.","date":"2021-12-21","price":179.99,"category":"Audio"},
  {"product":"Chuwi LapBook Air 14\"","date":"2018-06-23","price":333.35,"category":"Laptop"},
  {"product":"Apple Watch Series 6","date":"2021-10-21","price":389.00,"category":"Wearable"},
  {"product":"iPad mini 5","date":"2019-09-12","price":412.82,"category":"Tablet"},
  {"product":"Intel NUC + comp.","date":"2021-01-15","price":670.57,"category":"Desktop"},
  {"product":"iPad Air 4","date":"2022-02-05","price":687.64,"category":"Tablet"},
  {"product":"iPhone 11 + batt.","date":"2019-09-23","price":988.00,"category":"Smartphone"},
  {"product":"DJI Magic 2 Zoom + kit","date":"2019-06-15","price":1590.30,"category":"Drone"},
  {"product":"HP Omen 880-190nl","date":"2019-05-28","price":1999.99,"category":"Desktop"},
  {"product":"MacBook Pro 16\"","date":"2019-12-31","price":3510.18,"category":"Laptop"},
  {"product":"Mac Mini M1","date":"2022-12-01","price":1279.00,"category":"Desktop"},
  {"product":"Lomi Composter","date":"2024-04-22","price":399.00,"category":"Altro"}
];

// ---- STATE ----
let items = [];
let editingId = null;
let filterStatus = 'all';
let filterCategory = localStorage.getItem('filterCategory') || 'all';
let sortBy = localStorage.getItem('sortBy') || 'cpd_asc';
let confirmResolve = null;
let dataLastModified = null;
let pushTimer = null, pushInFlight = false, pushQueued = false;

// ---- UTILS ----
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxx-xxxx-xxxx'.replace(/x/g,()=>(Math.random()*16|0).toString(16));
}
function daysBetween(a, b) {
  return Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000));
}
function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) { if (!iso) return '?'; const [y,m,d] = iso.split('-'); return `${d}-${m}-${y}`; }
function fmt(n, d=2) {
  return n.toLocaleString('it-IT', {minimumFractionDigits:d, maximumFractionDigits:d});
}
function fmtEur(n) {
  return '€\u00A0' + fmt(n);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function getCPD(item) {
  const end = item.retired && item.retiredDate ? item.retiredDate : today();
  const days = daysBetween(item.date, end);
  return item.price / days;
}
function getDays(item) {
  const end = item.retired && item.retiredDate ? item.retiredDate : today();
  return daysBetween(item.date, end);
}
function getThresholdReached(item, threshold) {
  const daysNeeded = item.price / threshold;
  const daysUsed = getDays(item);
  return daysUsed >= daysNeeded;
}
function getProgressPct(item) {
  const daysNeeded = item.price / 0.25;
  const daysUsed = getDays(item);
  return Math.min(100, (daysUsed / daysNeeded) * 100);
}
function getCPDColor(cpd) {
  if (cpd <= 0.25) return 'var(--green)';
  if (cpd <= 0.50) return 'var(--amber)';
  if (cpd <= 1.00) return 'var(--orange)';
  return 'var(--red)';
}
function getMilestoneDate(item, threshold) {
  const daysNeeded = Math.ceil(item.price / threshold);
  const t = new Date(item.date).getTime() + daysNeeded * 86400000;
  if (!isFinite(t) || Math.abs(t) > 8.64e15) return null;
  return new Date(t).toISOString().slice(0, 10);
}
function getMilestonesTooltip(item) {
  return THRESHOLDS.map(t => {
    const reached = getThresholdReached(item, t);
    const date = fmtDate(getMilestoneDate(item, t));
    return `${fmt(t,2)}€/g: ${reached ? '✓ ' + date : date}`;
  }).join('\n');
}

// ---- PERSISTENCE ----
function touchData() { dataLastModified = new Date().toISOString(); }
const MAX_PRICE = 1e7;
function normalizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  const todayMs = Date.parse(today());
  const seenIds = new Set();
  return arr.map(i => {
    i = i || {};
    const price = Number(i.price);
    const dateOk = typeof i.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.date) && !isNaN(Date.parse(i.date));
    const rdOk = typeof i.retiredDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.retiredDate) && !isNaN(Date.parse(i.retiredDate));
    const rdValid = rdOk && dateOk && Date.parse(i.retiredDate) >= Date.parse(i.date) && Date.parse(i.retiredDate) <= todayMs;
    const retired = !!i.retired;
    let id = (typeof i.id === 'string' && /^[\w-]{1,64}$/.test(i.id)) ? i.id : uuid();
    if (seenIds.has(id)) id = uuid();
    seenIds.add(id);
    return {
      id,
      product: i.product != null ? String(i.product) : '',
      date: dateOk ? i.date : null,
      price: (isFinite(price) && price > 0 && price <= MAX_PRICE) ? price : null,
      category: CATEGORIES.includes(i.category) ? i.category : 'Altro',
      retired,
      retiredDate: retired && rdValid ? i.retiredDate : null,
      notes: i.notes != null ? String(i.notes) : ''
    };
  }).filter(i => i.date && i.price != null);
}
function save() {
  if (!dataLastModified) dataLastModified = new Date().toISOString();
  try {
    localStorage.setItem('diluizione_data', JSON.stringify({ items, lastModified: dataLastModified }));
    return true;
  } catch(e) {
    notify('Salvataggio non riuscito: spazio di archiviazione esaurito o non disponibile.', 'error');
    return false;
  }
}
function load() {
  const raw = localStorage.getItem('diluizione_data');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      items = normalizeItems(parsed.items || parsed);
      dataLastModified = parsed.lastModified || new Date().toISOString();
      return true;
    } catch(e) {
      // Keep the unreadable data instead of silently overwriting it with defaults
      try { localStorage.setItem('diluizione_data_backup', raw); } catch(_) {}
      notify('Dati locali illeggibili: copia salvata in "diluizione_data_backup".', 'error');
    }
  }
  return false;
}
function getLastModified() { return dataLastModified; }

// ---- SYNC ----
// Validate a remote payload: never let a malformed Gist wipe local data
function parseRemoteItems(parsed) {
  const arr = Array.isArray(parsed) ? parsed : parsed && parsed.items;
  if (!Array.isArray(arr)) throw new Error('Dati remoti non validi');
  const normalized = normalizeItems(arr);
  if (arr.length && !normalized.length) throw new Error('Nessun record valido nei dati remoti');
  return normalized;
}
// Timestamps from the future (bad clock or tampering) must not win every sync
function clampTimestamp(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return new Date(Math.min(t, Date.now() + 86400000)).toISOString();
}
function getSyncConfig() {
  const token = localStorage.getItem('sync_token');
  const gistId = localStorage.getItem('sync_gist_id');
  return token && gistId ? { token, gistId } : null;
}
function setSyncStatus(emoji, text) {
  const badge = document.getElementById('syncBadge');
  badge.textContent = emoji + ' ' + text;
  badge.hidden = false;
}
function updateSyncUI() {
  const cfg = getSyncConfig();
  const configForm = document.getElementById('syncConfigForm');
  const statusPanel = document.getElementById('syncStatusPanel');
  if (cfg) {
    configForm.hidden = true;
    statusPanel.hidden = false;
    document.getElementById('syncStatusText').textContent = '🟢 Connesso';
    document.getElementById('syncGistLink').innerHTML = '<a href="https://gist.github.com/' + encodeURIComponent(cfg.gistId) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(cfg.gistId.slice(0,12)) + '…</a>';
    const lastSync = localStorage.getItem('sync_last');
    document.getElementById('syncLastTime').textContent = lastSync ? 'Ultimo sync: ' + new Date(lastSync).toLocaleString('it-IT') : '';
    setSyncStatus('🟢', 'Sync');
  } else {
    configForm.hidden = false;
    statusPanel.hidden = true;
    document.getElementById('syncBadge').hidden = true;
  }
}

async function configureSync() {
  const token = document.getElementById('inputToken').value.trim();
  const gistId = document.getElementById('inputGistId').value.trim();
  if (!token) { notify('Inserisci il token PAT', 'error'); return; }
  if (gistId && !/^[a-f0-9]+$/i.test(gistId)) { notify('Gist ID non valido (sono ammessi solo caratteri esadecimali)', 'error'); return; }
  setSyncStatus('🔄', 'Configurazione…');
  try {
    if (gistId) {
      const res = await fetch('https://api.github.com/gists/' + gistId, {
        headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
      });
      if (!res.ok) throw new Error('Gist non trovato o token non valido');
    } else {
      const res = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Diluizione Spese Tech - Data', public: false, files: { 'diluizione_data.json': { content: JSON.stringify({ items: items, lastModified: dataLastModified }) } } })
      });
      if (!res.ok) throw new Error('Impossibile creare il Gist');
      const data = await res.json();
      document.getElementById('inputGistId').value = data.id;
      localStorage.setItem('sync_gist_id', data.id);
    }
    localStorage.setItem('sync_token', token);
    if (gistId) localStorage.setItem('sync_gist_id', gistId);
    localStorage.setItem('sync_last', new Date().toISOString());
    document.getElementById('inputToken').value = '';
    updateSyncUI();
    if (gistId && await showConfirm('Gist collegato. Scaricare i dati remoti sostituendo quelli locali? (Annulla = mantieni i dati locali, verranno caricati al prossimo salvataggio)')) {
      await pullFromGist();
    }
  } catch(e) {
    setSyncStatus('🔴', 'Errore');
    notify('Errore configurazione: ' + e.message, 'error');
  }
}

async function pushToGist() {
  const cfg = getSyncConfig();
  if (!cfg) return;
  setSyncStatus('🔄', 'Push…');
  try {
    const res = await fetch('https://api.github.com/gists/' + cfg.gistId, {
      method: 'PATCH',
      headers: { 'Authorization': 'token ' + cfg.token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'diluizione_data.json': { content: JSON.stringify({ items, lastModified: dataLastModified }) } } })
    });
    if (!res.ok) throw new Error('Push fallito');
    localStorage.setItem('sync_last', new Date().toISOString());
    setSyncStatus('🟢', 'Sync');
    updateSyncUI();
  } catch(e) {
    setSyncStatus('🔴', 'Errore push');
  }
}

async function confirmPull() {
  const ok = await showConfirm('Scaricare i dati dal Gist? I dati locali non sincronizzati verranno sostituiti.');
  if (ok) pullFromGist();
}

async function pullFromGist() {
  const cfg = getSyncConfig();
  if (!cfg) return;
  setSyncStatus('🔄', 'Pull…');
  try {
    const res = await fetch('https://api.github.com/gists/' + cfg.gistId, {
      headers: { 'Authorization': 'token ' + cfg.token, 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error('Pull fallito');
    const data = await res.json();
    const file = data.files['diluizione_data.json'];
    if (file) {
      const parsed = JSON.parse(file.content);
      items = parseRemoteItems(parsed);
      dataLastModified = clampTimestamp(parsed && parsed.lastModified) || new Date().toISOString();
      save();
      render();
    }
    localStorage.setItem('sync_last', new Date().toISOString());
    setSyncStatus('🟢', 'Sync');
    updateSyncUI();
  } catch(e) {
    setSyncStatus('🔴', 'Errore pull');
    notify('Pull dal Gist non riuscito', 'error');
  }
}

async function doSync() {
  const cfg = getSyncConfig();
  if (!cfg) return;
  setSyncStatus('🔄', 'Sync…');
  try {
    // Pull first to check remote lastModified
    const res = await fetch('https://api.github.com/gists/' + cfg.gistId, {
      headers: { 'Authorization': 'token ' + cfg.token, 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error('Sync fallito');
    const data = await res.json();
    const file = data.files['diluizione_data.json'];
    if (file) {
      const remote = JSON.parse(file.content);
      const remoteT = Date.parse(clampTimestamp(remote && remote.lastModified));
      const localT = Date.parse(dataLastModified);
      const r = isNaN(remoteT) ? -Infinity : remoteT;
      const l = isNaN(localT) ? -Infinity : localT;
      if (r > l) {
        items = parseRemoteItems(remote);
        dataLastModified = clampTimestamp(remote.lastModified) || new Date().toISOString();
        save();
        render();
      } else if (l > r) {
        await pushToGist();
        return;
      }
    }
    localStorage.setItem('sync_last', new Date().toISOString());
    setSyncStatus('🟢', 'Sync');
    updateSyncUI();
  } catch(e) {
    setSyncStatus('🔴', 'Errore sync');
    if (e.message && e.message.includes('remoti')) notify('Sync annullato: ' + e.message, 'error');
  }
}

function disconnectSync() {
  localStorage.removeItem('sync_token');
  localStorage.removeItem('sync_gist_id');
  localStorage.removeItem('sync_last');
  updateSyncUI();
}

function afterModification() {
  touchData();
  if (!save()) {
    // Roll back to the last state that was actually persisted
    load();
    render();
    return false;
  }
  render();
  schedulePush();
  return true;
}

function schedulePush() {
  if (!getSyncConfig()) return;
  setSyncStatus('🟡', 'Non sincronizzato');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(runPush, 2000);
}
async function runPush() {
  if (pushInFlight) { pushQueued = true; return; }
  pushInFlight = true;
  try {
    await pushToGist();
  } finally {
    pushInFlight = false;
    if (pushQueued) { pushQueued = false; runPush(); }
  }
}

// ---- TOAST ----
function notify(msg, type = 'info', duration) {
  let wrap = document.getElementById('toastWrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toastWrap'; wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 300); }, duration || (type === 'error' ? 5000 : 3000));
}

// ---- FOCUS MANAGEMENT (modal/confirm a11y) ----
let lastFocused = null;
function getFocusable(container) {
  return Array.from(container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter(el => el.offsetParent !== null);
}
function trapFocus(e, container) {
  if (e.key !== 'Tab') return;
  const f = getFocusable(container);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function handleGlobalKeydown(e) {
  const confirmOv = document.getElementById('confirmOverlay');
  const modalOv = document.getElementById('modalOverlay');
  if (confirmOv.classList.contains('active')) {
    if (e.key === 'Escape') closeConfirm(false);
    else trapFocus(e, confirmOv);
  } else if (modalOv.classList.contains('active')) {
    if (e.key === 'Escape') closeModal();
    else trapFocus(e, modalOv);
  }
}

// ---- CONFIRM ----
function showConfirm(msg) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    lastFocused = document.activeElement;
    document.getElementById('confirmMsg').textContent = msg;
    document.getElementById('confirmOverlay').classList.add('active');
    const cancelBtn = document.querySelector('#confirmOverlay .confirm-actions button');
    if (cancelBtn) cancelBtn.focus();
  });
}
function closeConfirm(result) {
  document.getElementById('confirmOverlay').classList.remove('active');
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
  if (lastFocused && lastFocused.focus) { lastFocused.focus(); lastFocused = null; }
}

// ---- MODAL ----
function openModal(id) {
  editingId = id || null;
  lastFocused = document.activeElement;
  const modal = document.getElementById('modalOverlay');
  document.getElementById('modalTitle').textContent = id ? 'Modifica prodotto' : 'Aggiungi prodotto';
  document.getElementById('editFields').hidden = !id;
  if (id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    document.getElementById('fProduct').value = item.product;
    document.getElementById('fCategory').value = item.category;
    document.getElementById('fDate').value = item.date;
    document.getElementById('fPrice').value = item.price;
    document.getElementById('fNotes').value = item.notes || '';
    document.getElementById('fStatus').value = item.retired ? 'retired' : 'active';
    document.getElementById('fRetiredDate').value = item.retiredDate || '';
  } else {
    document.getElementById('fProduct').value = '';
    document.getElementById('fCategory').value = 'Audio';
    document.getElementById('fDate').value = today();
    document.getElementById('fPrice').value = '';
    document.getElementById('fNotes').value = '';
    document.getElementById('fStatus').value = 'active';
    document.getElementById('fRetiredDate').value = '';
  }
  modal.classList.add('active');
  document.getElementById('fProduct').focus();
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
  editingId = null;
  if (lastFocused && lastFocused.focus) { lastFocused.focus(); lastFocused = null; }
}

function saveProduct() {
  const product = document.getElementById('fProduct').value.trim();
  const category = document.getElementById('fCategory').value;
  const date = document.getElementById('fDate').value;
  const price = parseFloat(document.getElementById('fPrice').value);
  const notes = document.getElementById('fNotes').value.trim();
  if (!product || !date || isNaN(price) || price <= 0) {
    notify('Compila tutti i campi obbligatori', 'error');
    (!product ? document.getElementById('fProduct') : !date ? document.getElementById('fDate') : document.getElementById('fPrice')).focus();
    return;
  }
  if (price > MAX_PRICE) { notify('Prezzo troppo alto (max ' + fmtEur(MAX_PRICE) + ')', 'error'); document.getElementById('fPrice').focus(); return; }
  if (date > today()) { notify('La data di acquisto non può essere nel futuro', 'error'); document.getElementById('fDate').focus(); return; }
  if (editingId) {
    const item = items.find(i => i.id === editingId);
    if (!item) return;
    item.product = product;
    item.category = category;
    item.date = date;
    item.price = price;
    item.notes = notes;
    const status = document.getElementById('fStatus').value;
    if (status === 'retired') {
      const rd = document.getElementById('fRetiredDate').value || today();
      if (rd < date) { notify('La data di ritiro non può precedere la data di acquisto', 'error'); document.getElementById('fRetiredDate').focus(); return; }
      if (rd > today()) { notify('La data di ritiro non può essere nel futuro', 'error'); document.getElementById('fRetiredDate').focus(); return; }
      item.retired = true;
      item.retiredDate = rd;
    } else {
      item.retired = false;
      item.retiredDate = null;
    }
  } else {
    items.push({ id: uuid(), product, date, price, category, retired: false, retiredDate: null, notes });
  }
  if (afterModification()) closeModal();
}

async function retireProduct(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  if (!item.retired) {
    const ok = await showConfirm('Vuoi ritirare "' + item.product + '"?');
    if (!ok) return;
    item.retired = true;
    item.retiredDate = today();
  } else {
    item.retired = false;
    item.retiredDate = null;
  }
  afterModification();
}

async function deleteProduct(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  const ok = await showConfirm('Vuoi eliminare "' + item.product + '"?');
  if (!ok) return;
  items = items.filter(i => i.id !== id);
  afterModification();
}

// ---- IMPORT/EXPORT ----
function exportJSON() {
  const blob = new Blob([JSON.stringify({ items, lastModified: dataLastModified || new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'diluizione_spese_' + today() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function importJSON() {
  document.getElementById('fileInput').click();
}
function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const parsed = JSON.parse(e.target.result);
      const arr = parsed.items || parsed;
      if (!Array.isArray(arr)) throw new Error('Formato non valido');
      const normalized = normalizeItems(arr);
      if (!normalized.length) throw new Error('Nessun record valido nel file');
      const dropped = arr.length - normalized.length;
      const ok = await showConfirm('Sostituire i ' + items.length + ' prodotti attuali con i ' + normalized.length + ' del file? (Consiglio: esporta prima un backup)');
      if (!ok) return;
      items = normalized;
      if (!afterModification()) return;
      notify('Import completato: ' + normalized.length + ' prodotti importati' + (dropped > 0 ? ', ' + dropped + ' record non validi scartati' : '') + '.', 'success');
    } catch(err) {
      notify('Errore importazione: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                       // neutralizza formula injection
  if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; // quoting RFC 4180
  return s;
}
function exportCSV() {
  const header = ['Prodotto','Categoria','Acquisto','Prezzo','Giorni','Euro/Giorno','Stato','Data Ritiro','Note'].map(csvCell).join(';') + '\n';
  const rows = items.map(i => {
    const cpd = getCPD(i);
    const days = getDays(i);
    return [i.product, i.category, fmtDate(i.date), i.price.toFixed(2), days, cpd.toFixed(2), i.retired?'Ritirato':'Attivo', i.retiredDate?fmtDate(i.retiredDate):'', i.notes||''].map(csvCell).join(';');
  }).join('\n');
  const blob = new Blob(['\uFEFF' + header + rows], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'diluizione_spese_' + today() + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- SETTINGS TOGGLE ----
function toggleSettings() {
  const p = document.getElementById('settingsPanel');
  p.hidden = !p.hidden;
}

// ---- RENDER ----
function getFilteredItems() {
  let list = items.filter(i => !i.retired);
  if (filterCategory !== 'all') list = list.filter(i => i.category === filterCategory);
  switch(sortBy) {
    case 'cpd_asc': list.sort((a,b) => getCPD(a) - getCPD(b)); break;
    case 'price_desc': list.sort((a,b) => b.price - a.price); break;
    case 'days_desc': list.sort((a,b) => getDays(b) - getDays(a)); break;
    case 'progress_desc': list.sort((a,b) => getProgressPct(b) - getProgressPct(a)); break;
  }
  return list;
}

function renderKPIs() {
  const active = items.filter(i => !i.retired);
  const totalActive = active.reduce((s,i) => s + i.price, 0);
  const totalDays = active.reduce((s,i) => s + getDays(i), 0);
  const avgCPD = totalDays ? totalActive / totalDays : 0;
  const amortized = active.filter(i => getCPD(i) <= 0.25);
  const amortPct = active.length ? (amortized.length / active.length * 100) : 0;

  // Next milestone
  const notAmortized = active.filter(i => getCPD(i) > 0.25);
  let nextMilestone = null;
  if (notAmortized.length) {
    const msTime = i => Date.parse(getMilestoneDate(i, 0.25)) || Infinity;
    notAmortized.sort((a,b) => msTime(a) - msTime(b));
    const closest = notAmortized[0];
    const mDate = getMilestoneDate(closest, 0.25);
    const daysLeft = mDate ? Math.max(0, Math.round((new Date(mDate) - new Date(today())) / 86400000)).toLocaleString('it-IT') : '?';
    nextMilestone = { product: closest.product, date: fmtDate(mDate), daysLeft };
  }

  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Spesa attiva totale</div>
      <div class="kpi-value">${fmtEur(totalActive)}</div>
      <div class="kpi-sub">${active.length} prodott${active.length===1?'o':'i'} attiv${active.length===1?'o':'i'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Costo medio/giorno</div>
      <div class="kpi-value" data-css="color:${getCPDColor(avgCPD)}">${fmt(avgCPD,2)} €/g</div>
      <div class="kpi-sub">media ponderata (spesa/giorni)</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Ammortizzati &le;0,25€/g</div>
      <div class="kpi-value" data-css="color:var(--green)">${amortized.length}/${active.length}</div>
      <div class="kpi-sub">${fmt(amortPct,1)}% del totale attivi</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Prossimo traguardo</div>
      <div class="kpi-value kpi-value-text">${nextMilestone ? escapeHtml(nextMilestone.product) : '—'}</div>
      <div class="kpi-sub">${nextMilestone ? nextMilestone.date + ' · tra ' + nextMilestone.daysLeft + ' g' : 'Tutti ammortizzati!'}</div>
    </div>
  `;
}

function renderCharts() {
  const active = items.filter(i => !i.retired);
  if (!active.length) {
    document.getElementById('chartsGrid').innerHTML = '';
    return;
  }

  // Ranking chart
  const ranked = [...active].sort((a,b) => getCPD(a) - getCPD(b));
  const maxCPD = Math.max(...ranked.map(i => getCPD(i)), 0.01);

  let rankHTML = '<div class="chart-card"><h3>Ranking costo/giorno (attivi)</h3>';
  ranked.forEach(item => {
    const cpd = getCPD(item);
    const pct = Math.max(3, (cpd / maxCPD) * 100);
    const color = getCPDColor(cpd);
    rankHTML += `<div class="chart-bar-row">
      <span class="bar-label">${escapeHtml(item.product)}</span>
      <span class="bar-track"><span class="bar-fill" data-css="width:${pct}%;background:${color}">${pct >= 15 ? fmt(cpd,2) : ''}</span></span>
      <span class="bar-value">${fmt(cpd,2)} €/g</span>
    </div>`;
  });
  rankHTML += '</div>';

  // Category chart
  const catTotals = {};
  active.forEach(i => { catTotals[i.category] = (catTotals[i.category]||0) + i.price; });
  const totalPrice = active.reduce((s,i) => s + i.price, 0);
  const catEntries = Object.entries(catTotals).sort((a,b) => b[1] - a[1]);

  let catHTML = '<div class="chart-card"><h3>Spesa per categoria (attivi)</h3>';
  catEntries.forEach(([cat, total]) => {
    const pct = (total / totalPrice) * 100;
    const color = CAT_COLORS[cat] || CAT_COLORS.Altro;
    catHTML += `<div class="chart-bar-row">
      <span class="bar-label">${escapeHtml(cat)}</span>
      <span class="bar-track"><span class="bar-fill" data-css="width:${pct}%;background:${color}">${pct >= 15 ? fmt(pct,1) + '%' : ''}</span></span>
      <span class="bar-value">${fmtEur(total)}</span>
    </div>`;
  });
  catHTML += '</div>';

  document.getElementById('chartsGrid').innerHTML = rankHTML + catHTML;
}

function renderFilters() {
  const cats = [...new Set(items.map(i => i.category))].sort();
  document.getElementById('filtersBar').innerHTML = `
    <div class="filter-group">
      <label>Categoria</label>
      <select aria-label="Filtra per categoria" data-change="filterCategory">
        <option value="all"${filterCategory==='all'?' selected':''}>Tutte</option>
        ${cats.map(c => `<option value="${escapeHtml(c)}"${filterCategory===c?' selected':''}>${escapeHtml(c)}</option>`).join('')}
      </select>
    </div>
    <div class="spacer"></div>
    <div class="filter-group">
      <label>Ordina per</label>
      <select aria-label="Ordina per" data-change="sortBy">
        <option value="cpd_asc"${sortBy==='cpd_asc'?' selected':''}>€/giorno ↑</option>
        <option value="price_desc"${sortBy==='price_desc'?' selected':''}>Prezzo ↓</option>
        <option value="days_desc"${sortBy==='days_desc'?' selected':''}>Durata ↓</option>
        <option value="progress_desc"${sortBy==='progress_desc'?' selected':''}>Progresso ↓</option>
      </select>
    </div>
  `;
}

function renderTable() {
  const list = getFilteredItems();
  if (!list.length) {
    const hasActive = items.some(i => !i.retired);
    document.getElementById('tableWrap').innerHTML = hasActive
      ? '<div class="empty">Nessun prodotto corrisponde al filtro.</div>'
      : '<div class="empty"><p>Ancora nessun prodotto.</p><button type="button" class="btn btn-primary" data-action="openModal">+ Aggiungi il primo prodotto</button></div>';
    return;
  }
  let html = `<table>
    <thead><tr>
      <th>Prodotto</th><th>Categoria</th><th>Acquisto</th><th>Prezzo</th>
      <th>Giorni</th><th>€/giorno</th><th>Soglie</th><th>Progresso → 0,25€/g</th><th>Azioni</th>
    </tr></thead><tbody>`;

  list.forEach(item => {
    const cpd = getCPD(item);
    const days = getDays(item);
    const progress = getProgressPct(item);
    const catColor = CAT_COLORS[item.category] || CAT_COLORS.Altro;
    const thresholds = THRESHOLDS.map(t => {
      const ok = getThresholdReached(item, t);
      return `<span class="threshold-badge ${ok?'threshold-ok':'threshold-no'}" title="${fmt(t,2)}€/g">${ok?'✓':'✗'}${fmt(t,2)}</span>`;
    }).join(' ');

    const progressColor = getCPDColor(cpd);
    const tooltip = getMilestonesTooltip(item);

    html += `<tr>
      <td class="product-name">${escapeHtml(item.product)}</td>
      <td><span class="badge-cat" data-css="background:${catColor}22;color:color-mix(in srgb,${catColor} 65%,var(--text))">${escapeHtml(item.category)}</span></td>
      <td class="mono">${fmtDate(item.date)}</td>
      <td class="mono">${fmtEur(item.price)}</td>
      <td class="mono">${days.toLocaleString('it-IT')}</td>
      <td class="mono" data-css="color:${getCPDColor(cpd)}">${fmt(cpd,2)}</td>
      <td>${thresholds}</td>
      <td>
        <span class="progress-wrap" tabindex="0" role="img" aria-label="Traguardi: ${escapeHtml(tooltip.replace(/\n/g, '; '))}">
          <span class="progress-track"><span class="progress-fill" data-css="width:${progress}%;background:${progressColor}"></span></span>
          <span class="progress-text">${fmt(progress,1)}%</span>
          <span class="progress-tooltip">${escapeHtml(tooltip)}</span>
        </span>
      </td>
      <td><div class="row-actions">
        <button type="button" title="Modifica" aria-label="Modifica ${escapeHtml(item.product)}" data-action="edit" data-id="${escapeHtml(item.id)}">✏️</button>
        <button type="button" title="Ritira" aria-label="Ritira ${escapeHtml(item.product)}" data-action="retire" data-id="${escapeHtml(item.id)}">⏸</button>
        <button type="button" title="Elimina" aria-label="Elimina ${escapeHtml(item.product)}" data-action="delete" data-id="${escapeHtml(item.id)}">🗑️</button>
      </div></td>
    </tr>`;
  });

  html += '</tbody></table>';
  document.getElementById('tableWrap').innerHTML = html;
}

function renderRetiredSection() {
  const retired = items.filter(i => i.retired);
  const section = document.getElementById('retiredSection');
  if (!retired.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const totalSpent = retired.reduce((s,i) => s + i.price, 0);
  const avgDays = retired.reduce((s,i) => s + getDays(i), 0) / retired.length;
  const avgYears = avgDays / 365.25;
  const retiredDays = retired.reduce((s,i) => s + getDays(i), 0);
  const avgCPD = retiredDays ? totalSpent / retiredDays : 0;
  const best = [...retired].sort((a,b) => getCPD(a) - getCPD(b))[0];

  let html = `<h3>📦 Prodotti ritirati (${retired.length})</h3>
    <div class="retired-stats">
      <div class="retired-stat"><div class="rs-val">${fmtEur(totalSpent)}</div><div class="rs-label">Spesa totale</div></div>
      <div class="retired-stat"><div class="rs-val">${fmt(avgDays,0)} g</div><div class="rs-label">Durata media (${fmt(avgYears,1)} anni)</div></div>
      <div class="retired-stat"><div class="rs-val">${fmt(avgCPD,2)} €/g</div><div class="rs-label">Costo medio/giorno</div></div>
      <div class="retired-stat"><div class="rs-val">${best ? escapeHtml(best.product) : '—'}</div><div class="rs-label">Miglior ammortamento${best ? ' (' + fmt(getCPD(best),2) + ' €/g)' : ''}</div></div>
    </div>
    <div class="retired-list">`;

  retired.sort((a,b) => getCPD(a) - getCPD(b)).forEach(item => {
    const cpd = getCPD(item);
    const days = getDays(item);
    html += `<div class="retired-item">
      <span class="ri-name">${escapeHtml(item.product)}</span>
      <span class="ri-period">${fmtDate(item.date)} → ${fmtDate(item.retiredDate)}</span>
      <span class="ri-cost mono" data-css="color:${getCPDColor(cpd)}">${fmt(cpd,2)} €/g</span>
      <span class="ri-days">${days} giorni</span>
      <span class="row-actions">
        <button type="button" title="Modifica" aria-label="Modifica ${escapeHtml(item.product)}" data-action="edit" data-id="${escapeHtml(item.id)}">✏️</button>
        <button type="button" title="Riattiva" aria-label="Riattiva ${escapeHtml(item.product)}" data-action="retire" data-id="${escapeHtml(item.id)}">▶️</button>
        <button type="button" title="Elimina" aria-label="Elimina ${escapeHtml(item.product)}" data-action="delete" data-id="${escapeHtml(item.id)}">🗑️</button>
      </span>
    </div>`;
  });

  html += '</div>';
  section.innerHTML = html;
}

// The CSP forbids inline style attributes, so rendered markup carries data-css
// and the styles are applied through the CSSOM, which the CSP allows
function applyDataStyles(root) {
  root.querySelectorAll('[data-css]').forEach(el => {
    el.style.cssText = el.getAttribute('data-css');
    el.removeAttribute('data-css');
  });
}

function render() {
  // Each section renders independently: one bad record must not blank the whole app
  let failed = false;
  for (const fn of [renderKPIs, renderCharts, renderFilters, renderTable, renderRetiredSection]) {
    try { fn(); } catch(e) { failed = true; console.error(e); }
  }
  applyDataStyles(document);
  if (failed) notify('Errore di visualizzazione: alcuni dati potrebbero non essere mostrati.', 'error');
}

// ---- EASTER EGG: 7 tap veloci sul logo ----
let logoTaps = 0, logoTapTimer = null;
function handleLogoTap() {
  clearTimeout(logoTapTimer);
  logoTapTimer = setTimeout(() => { logoTaps = 0; }, 600);
  if (++logoTaps < 7) return;
  logoTaps = 0;
  const logo = document.querySelector('header h1 .logo');
  logo.classList.remove('spin');
  void logo.offsetWidth; // restart the animation
  logo.classList.add('spin');
  const total = items.reduce((s,i) => s + i.price, 0);
  const coffees = Math.floor(total / 1.2);
  const best = [...items].sort((a,b) => getCPD(a) - getCPD(b))[0];
  notify('☕ Con i tuoi acquisti tech avresti comprato ' + coffees.toLocaleString('it-IT') + ' caffè al bar.' +
    (best ? ' 🏆 Campione di ammortamento: "' + best.product + '" a ' + fmt(getCPD(best),2) + ' €/g.' : ''), 'success', 7000);
}

// ---- UI EVENTS (delegation: the CSP forbids inline on* handlers) ----
const CLICK_ACTIONS = {
  setTheme: el => setTheme(el.dataset.arg),
  toggleSettings: () => toggleSettings(),
  openModal: () => openModal(),
  configureSync: () => configureSync(),
  doSync: () => doSync(),
  confirmPull: () => confirmPull(),
  pushToGist: () => pushToGist(),
  disconnectSync: () => disconnectSync(),
  exportJSON: () => exportJSON(),
  importJSON: () => importJSON(),
  exportCSV: () => exportCSV(),
  closeModal: () => closeModal(),
  saveProduct: () => saveProduct(),
  closeConfirm: el => closeConfirm(el.dataset.arg === 'true'),
  edit: el => openModal(el.dataset.id),
  retire: el => retireProduct(el.dataset.id),
  delete: el => deleteProduct(el.dataset.id),
};
const CHANGE_ACTIONS = {
  filterCategory: el => { filterCategory = el.value; localStorage.setItem('filterCategory', el.value); render(); },
  sortBy: el => { sortBy = el.value; localStorage.setItem('sortBy', el.value); render(); },
};
function handleClickAction(e) {
  const el = e.target.closest('[data-action]');
  const fn = el && CLICK_ACTIONS[el.dataset.action];
  if (fn) fn(el, e);
}
function handleChangeAction(e) {
  const fn = CHANGE_ACTIONS[e.target.dataset && e.target.dataset.change];
  if (fn) fn(e.target, e);
}
// Touch devices have no hover: a tap shows the milestone tooltip for 2s
function handleProgressTouch(e) {
  const wrap = e.target.closest('.progress-wrap');
  if (!wrap) return;
  if (e.type === 'touchstart') wrap.classList.toggle('touched');
  else setTimeout(() => wrap.classList.remove('touched'), 2000);
}

// ---- UPDATE NOTIFICATION ----
function showUpdateToast(reg) {
  if (document.getElementById('updateToast')) return;
  const toast = document.createElement('div');
  toast.id = 'updateToast';
  toast.className = 'update-toast';
  const msg = document.createElement('span');
  msg.textContent = 'Nuova versione disponibile';
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = 'Aggiorna';
  btn.addEventListener('click', () => {
    if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
    toast.remove();
  });
  toast.append(msg, btn);
  document.body.appendChild(toast);
}

// ---- INIT ----
async function init() {
  document.addEventListener('click', handleClickAction);
  document.addEventListener('change', handleChangeAction);
  document.addEventListener('touchstart', handleProgressTouch, { passive: true });
  document.addEventListener('touchend', handleProgressTouch, { passive: true });
  document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  document.getElementById('fileInput').addEventListener('change', handleImport);
  document.addEventListener('keydown', handleGlobalKeydown);
  document.querySelector('header h1 .logo').addEventListener('click', handleLogoTap);
  const loaded = load();
  if (!loaded) {
    // No local data; use defaults if no sync configured
    if (!getSyncConfig()) {
      items = normalizeItems(DEFAULT_DATA);
      save();
    }
  }
  updateSyncUI();
  render();

  // Reconcile with remote if sync configured (takes the newer side, no data loss)
  if (getSyncConfig()) {
    try { await doSync(); } catch(e) { /* offline, use local */ }
  }

  // Keep multiple tabs in sync
  window.addEventListener('storage', (e) => {
    if (e.key !== 'diluizione_data' || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue);
      if (document.getElementById('modalOverlay').classList.contains('active')) closeModal();
      items = normalizeItems(parsed.items || parsed);
      dataLastModified = parsed.lastModified || dataLastModified;
      render();
    } catch(_) {}
  });

  // Register service worker + new-version notification
  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(reg);
          }
        });
      });
    }).catch(() => {});
  }
}

init();
