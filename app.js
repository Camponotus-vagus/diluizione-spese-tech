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

// ---- STATE ----
let items = [];
let editingId = null;
let filterStatus = 'all';
let filterCategory = localStorage.getItem('filterCategory') || 'all';
let sortBy = localStorage.getItem('sortBy') || 'cpd_asc';
let confirmResolve = null;
let dataLastModified = null;
let deleted = Object.create(null); // id -> deletion time, see normalizeDeleted
let pushTimer = null, pushPending = false;

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
function nowIso() { return new Date().toISOString(); }
function touchData() { dataLastModified = nowIso(); }
const MAX_PRICE = 1e7;
const ID_RE = /^[\w-]{1,64}$/;
// A parseable timestamp, normalised and clamped (see clampTimestamp), or ''
function validIso(s) { return typeof s === 'string' && s.length <= 40 ? (clampTimestamp(s) || '') : ''; }
function normalizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  const todayMs = Date.parse(today());
  const seenIds = new Set();
  return arr.map(i => {
    i = i || {};
    const price = Number(i.price);
    const dateOk = typeof i.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.date) && !isNaN(Date.parse(i.date));
    const rdOk = typeof i.retiredDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.retiredDate) && !isNaN(Date.parse(i.retiredDate));
    const retired = !!i.retired;
    // A retired item must keep a retiredDate, or its cost/day starts ageing again
    // with today(). Allow one day ahead (retired in a timezone east of this one),
    // clamp anything else into [date, today] instead of dropping it.
    let retiredDate = null;
    if (retired && dateOk) {
      retiredDate = rdOk ? i.retiredDate : today();
      if (Date.parse(retiredDate) > todayMs + 86400000) retiredDate = today();
      if (retiredDate < i.date) retiredDate = i.date;
    }
    let id = (typeof i.id === 'string' && ID_RE.test(i.id)) ? i.id : uuid();
    if (seenIds.has(id)) id = uuid();
    seenIds.add(id);
    return {
      id,
      product: i.product != null ? String(i.product) : '',
      date: dateOk ? i.date : null,
      price: (isFinite(price) && price > 0 && price <= MAX_PRICE) ? price : null,
      category: CATEGORIES.includes(i.category) ? i.category : 'Altro',
      retired,
      retiredDate,
      notes: i.notes != null ? String(i.notes) : '',
      // Last edit of this item: lets two devices' changes be merged item by item
      updatedAt: validIso(i.updatedAt)
    };
  }).filter(i => i.date && i.price != null);
}
// Deleted items ("tombstones", id -> deletion time) so a merge does not bring
// them back from another device. Kept for a year.
const DELETED_TTL = 365 * 86400000;
function normalizeDeleted(obj) {
  const out = Object.create(null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const cutoff = Date.now() - DELETED_TTL;
  for (const [id, t] of Object.entries(obj)) {
    const iso = ID_RE.test(id) ? validIso(t) : '';
    if (iso && Date.parse(iso) > cutoff) out[id] = iso;
  }
  return out;
}
function localPayload() { return { items, deleted, lastModified: dataLastModified }; }
function save() {
  if (!dataLastModified) dataLastModified = nowIso();
  try {
    localStorage.setItem('diluizione_data', JSON.stringify(localPayload()));
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
      const arr = parsed.items || parsed;
      items = normalizeItems(arr);
      deleted = normalizeDeleted(parsed.deleted);
      backupIfDropped(raw, arr, items, 'locali');
      dataLastModified = parsed.lastModified || nowIso();
      return true;
    } catch(e) {
      // Keep the unreadable data instead of silently overwriting it with defaults
      saveBackup(raw, 'illeggibile');
      notify('Dati locali illeggibili: una copia è stata salvata, recuperala con "Scarica ultimo backup".', 'error', 8000);
    }
  }
  return false;
}
function getLastModified() { return dataLastModified; }

// ---- LOCAL BACKUPS ----
// Up to MAX_BACKUPS copies, taken before anything replaces the local data
const BACKUP_PREFIX = 'diluizione_backup_';
const LEGACY_BACKUP = 'diluizione_data_backup';
const MAX_BACKUPS = 5;
function backupKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(BACKUP_PREFIX)) keys.push(k);
  }
  return keys.sort(); // ISO timestamps: oldest first
}
function saveBackup(raw, reason) {
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
  try {
    const keys = backupKeys();
    // Same content as the newest backup: nothing new to keep
    if (!keys.length || localStorage.getItem(keys[keys.length - 1]) !== content) {
      localStorage.setItem(BACKUP_PREFIX + nowIso() + '_' + reason, content);
      backupKeys().slice(0, -MAX_BACKUPS).forEach(k => localStorage.removeItem(k));
    }
  } catch(_) { /* storage full: the notice still tells the user */ }
  updateBackupUI();
}
function latestBackup() {
  const keys = backupKeys();
  const key = keys.length ? keys[keys.length - 1] : (localStorage.getItem(LEGACY_BACKUP) != null ? LEGACY_BACKUP : null);
  return key ? { key, content: localStorage.getItem(key) } : null;
}
function updateBackupUI() {
  const btn = document.getElementById('backupBtn');
  if (btn) btn.hidden = !latestBackup();
}
function exportBackup() {
  const b = latestBackup();
  if (!b) { notify('Nessun backup disponibile', 'info'); return; }
  const stamp = b.key === LEGACY_BACKUP ? today() : b.key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
  const blob = new Blob([b.content], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'diluizione_backup_' + stamp + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  notify('Backup scaricato: puoi ripristinarlo con "Importa JSON".', 'success', 5000);
}
// Invalid records are filtered out by normalizeItems and would vanish for good
// at the next save/push: keep the original payload and tell the user
function backupIfDropped(raw, arr, kept, source) {
  const dropped = Array.isArray(arr) ? arr.length - kept.length : 0;
  if (dropped <= 0) return;
  saveBackup(raw, 'scartati');
  notify(dropped + (dropped === 1 ? ' record non valido scartato' : ' record non validi scartati') + ' dai dati ' + source + ': originale salvato, recuperalo con "Scarica ultimo backup".', 'error', 8000);
}
// A fresh, untouched dataset starts at the epoch so it never beats real data in a sync
const SEED_TIMESTAMP = new Date(0).toISOString();

// ---- SYNC ----
// Data lives in one file of a secret Gist. A sync reads the Gist first and then:
// - only the remote changed since the last sync  -> take the remote data
// - only the local data changed                   -> write it to the Gist
// - both changed                                  -> merge item by item, then write
// "sync_base" is the remote lastModified seen at the last successful sync.
const GIST_FILE = 'diluizione_data.json';
// Validate a remote payload: never let a malformed Gist wipe local data
function parseRemoteItems(parsed) {
  const arr = Array.isArray(parsed) ? parsed : parsed && parsed.items;
  if (!Array.isArray(arr)) throw new Error('Dati remoti non validi');
  const normalized = normalizeItems(arr);
  if (arr.length && !normalized.length) throw new Error('Nessun record valido nei dati remoti');
  backupIfDropped(parsed, arr, normalized, 'remoti');
  return normalized;
}
// All GitHub calls go through here: a timeout (a captive portal must not hang
// the sync forever) and clear messages for a bad token or a rate limit
async function ghFetch(url, cfg, opts = {}) {
  const headers = { 'Authorization': 'token ' + cfg.token, 'Accept': 'application/vnd.github+json' };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  let res;
  try {
    res = await fetch(url, { ...opts, headers, signal });
  } catch(_) {
    const err = new Error('Rete non disponibile');
    err.network = true;
    throw err;
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    const err = new Error('Limite di richieste GitHub raggiunto: riprova tra qualche minuto');
    err.rate = true;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Token GitHub non valido, scaduto o senza permesso sui Gist: riconfigura la sincronizzazione');
    err.auth = true;
    throw err;
  }
  return res;
}
// Every failure gets a message, except a missing connection: the red badge is
// enough and the change is retried when the browser is back online
function reportSyncError(e, what) {
  if (e && e.network) { pushPending = true; return; }
  notify(what + ': ' + (e && e.message ? e.message : 'errore sconosciuto'), 'error', 8000);
}
// Timestamps from the future (bad clock or tampering) must not win every sync
function clampTimestamp(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return new Date(Math.min(t, Date.now() + 600000)).toISOString();
}
const tsNum = iso => { const t = Date.parse(iso); return isNaN(t) ? -Infinity : t; };
function getSyncConfig() {
  const token = localStorage.getItem('sync_token');
  const gistId = localStorage.getItem('sync_gist_id');
  return token && gistId ? { token, gistId } : null;
}
const gistUrl = cfg => 'https://api.github.com/gists/' + encodeURIComponent(cfg.gistId);

// ---- ENCRYPTION (optional) ----
// A secret Gist can be read by anyone who has its link. With a passphrase the
// file holds only AES-GCM ciphertext; the key is derived with PBKDF2-SHA256.
const KDF_ITER = 600000;
const ENC_NAME = 'AES-GCM-PBKDF2-SHA256';
function getPassphrase() { return localStorage.getItem('sync_passphrase') || ''; }
function setPassphraseValue(pass) {
  if (pass) localStorage.setItem('sync_passphrase', pass); else localStorage.removeItem('sync_passphrase');
}
const b64 = {
  enc: bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); },
  dec: str => Uint8Array.from(atob(str), c => c.charCodeAt(0))
};
let keyCache = null; // { pass, salt, iter, key }: deriving a key is slow on purpose
async function getKey(pass, salt, iter) {
  if (keyCache && keyCache.pass === pass && keyCache.salt === salt && keyCache.iter === iter) return keyCache.key;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64.dec(salt), iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache = { pass, salt, iter, key };
  return key;
}
async function encryptPayload(obj, pass) {
  const reuse = keyCache && keyCache.pass === pass && keyCache.iter === KDF_ITER;
  const salt = reuse ? keyCache.salt : b64.enc(crypto.getRandomValues(new Uint8Array(16)));
  const key = await getKey(pass, salt, KDF_ITER);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // never reused: new for every write
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return { enc: ENC_NAME, v: 1, iter: KDF_ITER, salt, iv: b64.enc(iv), data: b64.enc(data) };
}
async function decryptPayload(o, pass) {
  if (!pass) {
    const err = new Error('i dati del Gist sono cifrati: inserisci la passphrase nelle impostazioni sync');
    err.needPass = true;
    throw err;
  }
  if (o.enc !== ENC_NAME || o.v !== 1 || !Number.isInteger(o.iter) || o.iter < 100000 || o.iter > 5000000 ||
      typeof o.salt !== 'string' || typeof o.iv !== 'string' || typeof o.data !== 'string') {
    throw new Error('Formato cifrato dei dati remoti non valido');
  }
  let plain;
  try {
    const key = await getKey(pass, o.salt, o.iter);
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(o.iv) }, key, b64.dec(o.data));
  } catch(_) {
    const err = new Error('passphrase errata: impossibile decifrare i dati del Gist');
    err.badPass = true;
    throw err;
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---- GIST I/O ----
async function readRemote(cfg) {
  const res = await ghFetch(gistUrl(cfg), cfg);
  if (res.status === 404) throw new Error('Gist non trovato: controlla il Gist ID e i permessi del token');
  if (!res.ok) throw new Error('GitHub ha risposto con errore ' + res.status);
  const data = await res.json();
  const owner = data && data.owner && data.owner.login;
  const file = data && data.files && data.files[GIST_FILE];
  if (!file) return { exists: false, owner };
  if (file.truncated) throw new Error('Dati remoti troppo grandi per essere letti');
  let parsed;
  try { parsed = JSON.parse(file.content); } catch(_) { throw new Error('Dati remoti illeggibili (JSON non valido)'); }
  const encrypted = !!(parsed && parsed.enc);
  if (encrypted) parsed = await decryptPayload(parsed, getPassphrase());
  return {
    exists: true, encrypted, owner,
    items: parseRemoteItems(parsed),
    deleted: normalizeDeleted(parsed && parsed.deleted),
    lastModified: clampTimestamp(parsed && parsed.lastModified)
  };
}
async function encodePayload() {
  const pass = getPassphrase();
  return JSON.stringify(pass ? await encryptPayload(localPayload(), pass) : localPayload());
}
async function writeRemote(cfg) {
  setSyncStatus('🔄', 'Push…');
  const content = await encodePayload();
  const res = await ghFetch(gistUrl(cfg), cfg, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content } } }) });
  if (!res.ok) throw new Error(res.status === 404 ? 'Gist non trovato o token senza permesso di scrittura' : 'Push fallito (errore ' + res.status + ')');
  markSynced(dataLastModified);
}
function markSynced(base) {
  if (base) localStorage.setItem('sync_base', base);
  pushPending = false;
  localStorage.setItem('sync_last', nowIso());
  updateSyncUI();
}
// Replace the local data with the remote one (a backup is kept first).
// Returns false if the user chose to keep the local data instead.
async function adoptRemote(remote, { guardEmpty = true } = {}) {
  if (guardEmpty && !remote.items.length && items.length && !items.every(i => remote.deleted[i.id])) {
    const ok = await showConfirm('Il Gist non contiene prodotti, mentre qui ne hai ' + items.length + '. Svuotare anche questo dispositivo? (Annulla = mantieni i dati locali e caricali sul Gist)');
    if (!ok) { touchData(); save(); return false; }
  }
  if (items.length) saveBackup(localPayload(), 'prima-del-sync');
  items = remote.items;
  deleted = remote.deleted;
  dataLastModified = remote.lastModified || nowIso();
  save();
  render();
  return true;
}
// Item-level merge: the most recent edit of each item wins, a deletion wins
// over older edits of the same item
function mergeData(localItems, localDel, remoteItems, remoteDel) {
  const del = Object.create(null);
  for (const src of [remoteDel, localDel]) for (const id in src) if (!del[id] || src[id] > del[id]) del[id] = src[id];
  const ts = i => i.updatedAt || SEED_TIMESTAMP;
  const byId = new Map();
  for (const i of remoteItems) byId.set(i.id, i);
  for (const i of localItems) { const r = byId.get(i.id); if (!r || ts(i) >= ts(r)) byId.set(i.id, i); }
  const merged = [...byId.values()].filter(i => !(del[i.id] && del[i.id] >= ts(i)));
  for (const i of merged) delete del[i.id];
  return { items: merged, deleted: del };
}

// One GitHub operation at a time: a push never races a pull
let syncChain = Promise.resolve(), syncRunning = 0;
function queueSync(fn) {
  const run = async () => { syncRunning++; try { return await fn(); } finally { syncRunning--; } };
  const p = syncChain.then(run, run);
  syncChain = p.catch(() => {});
  return p;
}
async function syncCore(cfg) {
  setSyncStatus('🔄', 'Sync…');
  const remote = await readRemote(cfg);
  if (!remote.exists) {
    // Gist without our file (new or emptied by hand): upload the local data
    if (dataLastModified !== SEED_TIMESTAMP) await writeRemote(cfg); else markSynced(null);
    return;
  }
  // Read after the request: an edit made while it was in flight counts as local change
  const base = localStorage.getItem('sync_base');
  let mustWrite = !!getPassphrase() && !remote.encrypted; // encryption just turned on
  if (dataLastModified === SEED_TIMESTAMP) {
    await adoptRemote(remote, { guardEmpty: false });
  } else if (!base) {
    // First sync on this device/version: the newer side wins as a whole
    const r = tsNum(remote.lastModified), l = tsNum(dataLastModified);
    if (r > l) { if (!(await adoptRemote(remote))) mustWrite = true; }
    else if (l > r) mustWrite = true;
  } else {
    const remoteChanged = remote.lastModified !== base;
    const localChanged = dataLastModified !== base;
    if (remoteChanged && localChanged) {
      const m = mergeData(items, deleted, remote.items, remote.deleted);
      saveBackup(localPayload(), 'prima-del-merge');
      items = m.items;
      deleted = m.deleted;
      touchData();
      save();
      render();
      mustWrite = true;
    } else if (remoteChanged) {
      if (!(await adoptRemote(remote))) mustWrite = true;
    } else if (localChanged) {
      mustWrite = true;
    }
  }
  if (mustWrite) await writeRemote(cfg); else markSynced(remote.lastModified);
}
function doSync() {
  return queueSync(async () => {
    const cfg = getSyncConfig();
    if (!cfg) return;
    try { await syncCore(cfg); }
    catch(e) { setSyncStatus('🔴', 'Errore sync'); reportSyncError(e, 'Sync non riuscito'); }
  });
}

async function configureSync() {
  const token = document.getElementById('inputToken').value.trim();
  const gistId = document.getElementById('inputGistId').value.trim();
  const pass = document.getElementById('inputPassphrase').value;
  if (!token) { notify('Inserisci il token PAT', 'error'); return; }
  if (gistId && !/^[a-f0-9]{1,64}$/i.test(gistId)) { notify('Gist ID non valido (sono ammessi solo caratteri esadecimali)', 'error'); return; }
  if (pass && pass.length < 8) { notify('La passphrase deve avere almeno 8 caratteri', 'error'); return; }
  setSyncStatus('🔄', 'Configurazione…');
  const cfg = { token, gistId };
  const prevPass = getPassphrase();
  let stored = false;
  try {
    setPassphraseValue(pass); // needed to read (or write) an encrypted Gist
    let remote = null;
    if (gistId) {
      remote = await readRemote(cfg);
      // A Gist of another account can be read but never written: refuse it now
      const me = await ghFetch('https://api.github.com/user', cfg).then(r => r.ok ? r.json() : null).catch(() => null);
      if (me && me.login && remote.owner && me.login !== remote.owner) throw new Error('il Gist appartiene a un altro account GitHub');
    } else {
      const content = await encodePayload();
      const res = await ghFetch('https://api.github.com/gists', cfg, {
        method: 'POST',
        body: JSON.stringify({ description: 'Diluizione Spese Tech - Data', public: false, files: { [GIST_FILE]: { content } } })
      });
      if (!res.ok) throw new Error('impossibile creare il Gist (errore ' + res.status + '): il token ha il permesso sui Gist?');
      const data = await res.json();
      if (!data || typeof data.id !== 'string' || !/^[a-f0-9]{1,64}$/i.test(data.id)) throw new Error('risposta di GitHub non valida');
      cfg.gistId = data.id;
    }
    localStorage.setItem('sync_token', token);
    localStorage.setItem('sync_gist_id', cfg.gistId);
    localStorage.removeItem('sync_base');
    stored = true;
    document.getElementById('inputToken').value = '';
    document.getElementById('inputPassphrase').value = '';
    document.getElementById('inputGistId').value = cfg.gistId;
    if (!gistId) { markSynced(dataLastModified); return; }
    updateSyncUI();
    await queueSync(async () => {
      if (!remote.exists) {
        if (dataLastModified !== SEED_TIMESTAMP) await writeRemote(cfg); else markSynced(null);
      } else if (dataLastModified === SEED_TIMESTAMP ||
          await showConfirm('Gist collegato. Scaricare i dati remoti sostituendo quelli locali? (Annulla = mantieni i dati locali e caricali sul Gist)')) {
        // Fresh, untouched data here: the Gist always wins, never ask to overwrite it
        await adoptRemote(remote, { guardEmpty: false });
        markSynced(remote.lastModified);
      } else {
        // Honour the choice now instead of leaving it to timestamps at the next sync
        touchData();
        save();
        await writeRemote(cfg);
      }
    });
  } catch(e) {
    if (!stored) setPassphraseValue(prevPass);
    setSyncStatus('🔴', 'Errore');
    notify('Errore configurazione: ' + e.message, 'error', 8000);
  }
}

// Explicit push: overwrite the Gist with the local data. The Gist is read first,
// so an encrypted Gist is never replaced by plaintext without its passphrase.
function pushToGist() {
  return queueSync(async () => {
    const cfg = getSyncConfig();
    if (!cfg) return;
    try {
      await readRemote(cfg);
      await writeRemote(cfg);
    } catch(e) {
      setSyncStatus('🔴', 'Errore push');
      reportSyncError(e, 'Push non riuscito');
    }
  });
}

async function confirmPull() {
  const ok = await showConfirm('Scaricare i dati dal Gist? I dati locali non sincronizzati verranno sostituiti (ne resta una copia: "Scarica ultimo backup").');
  if (ok) return pullFromGist();
}

function pullFromGist() {
  return queueSync(async () => {
    const cfg = getSyncConfig();
    if (!cfg) return;
    setSyncStatus('🔄', 'Pull…');
    try {
      const remote = await readRemote(cfg);
      if (!remote.exists) throw new Error('il Gist non contiene ancora dati');
      await adoptRemote(remote, { guardEmpty: false });
      markSynced(remote.lastModified);
    } catch(e) {
      setSyncStatus('🔴', 'Errore pull');
      reportSyncError(e, 'Pull dal Gist non riuscito');
    }
  });
}

// Turn encryption on, or unlock an encrypted Gist on a new device
function setPassphrase() {
  const input = document.getElementById('inputNewPassphrase');
  const pass = input.value;
  if (pass.length < 8) { notify('La passphrase deve avere almeno 8 caratteri', 'error'); input.focus(); return; }
  return queueSync(async () => {
    const cfg = getSyncConfig();
    if (!cfg) return;
    setPassphraseValue(pass);
    try {
      await syncCore(cfg); // decrypts an encrypted Gist, or rewrites a plaintext one encrypted
      input.value = '';
      updateSyncUI();
      notify('Cifratura attiva: sul Gist ora ci sono solo dati cifrati. Le versioni precedenti restano nella cronologia del Gist: per eliminarle crea un nuovo Gist.', 'success', 10000);
    } catch(e) {
      if (e.badPass || e.needPass) setPassphraseValue('');
      updateSyncUI();
      setSyncStatus('🔴', 'Errore');
      reportSyncError(e, 'Cifratura non attivata');
    }
  });
}

async function removePassphrase() {
  const ok = await showConfirm('Disattivare la cifratura? I dati sul Gist torneranno leggibili da chiunque abbia il link.');
  if (!ok) return;
  return queueSync(async () => {
    const cfg = getSyncConfig();
    if (!cfg) return;
    try {
      await syncCore(cfg); // bring in remote changes while they can still be decrypted
      setPassphraseValue('');
      await writeRemote(cfg);
      notify('Cifratura disattivata', 'info');
    } catch(e) {
      setSyncStatus('🔴', 'Errore');
      reportSyncError(e, 'Cifratura non disattivata');
    }
    updateSyncUI();
  });
}

function disconnectSync() {
  ['sync_token', 'sync_gist_id', 'sync_last', 'sync_base', 'sync_passphrase'].forEach(k => localStorage.removeItem(k));
  keyCache = null;
  updateSyncUI();
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
    const encrypted = !!getPassphrase();
    document.getElementById('syncEncState').textContent = encrypted
      ? '🔒 Dati cifrati sul Gist'
      : '⚠️ Dati in chiaro sul Gist: chiunque abbia il link del Gist può leggerli';
    document.getElementById('encSetRow').hidden = encrypted;
    document.getElementById('encRemoveBtn').hidden = !encrypted;
    setSyncStatus('🟢', 'Sync');
  } else {
    configForm.hidden = false;
    statusPanel.hidden = true;
    document.getElementById('syncBadge').hidden = true;
  }
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
// Local edits go through a full sync (read, then merge or write): never a blind
// overwrite of changes made on another device
function runPush() {
  pushTimer = null;
  return doSync();
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
    // A second dialog (e.g. a sync prompt during a delete) cancels the first
    // instead of leaving its promise pending forever
    if (confirmResolve) confirmResolve(false);
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
    // Validate everything before touching the item: a rejected edit must leave it intact
    const retired = document.getElementById('fStatus').value === 'retired';
    let retiredDate = null;
    if (retired) {
      retiredDate = document.getElementById('fRetiredDate').value || today();
      if (retiredDate < date) { notify('La data di ritiro non può precedere la data di acquisto', 'error'); document.getElementById('fRetiredDate').focus(); return; }
      // An unchanged date may be a day ahead (retired in a timezone further east)
      if (retiredDate > today() && retiredDate !== item.retiredDate) { notify('La data di ritiro non può essere nel futuro', 'error'); document.getElementById('fRetiredDate').focus(); return; }
    }
    Object.assign(item, { product, category, date, price, notes, retired, retiredDate, updatedAt: nowIso() });
  } else {
    items.push({ id: uuid(), product, date, price, category, retired: false, retiredDate: null, notes, updatedAt: nowIso() });
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
  item.updatedAt = nowIso();
  afterModification();
}

async function deleteProduct(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  const ok = await showConfirm('Vuoi eliminare "' + item.product + '"?');
  if (!ok) return;
  items = items.filter(i => i.id !== id);
  deleted[id] = nowIso(); // so a sync does not bring it back from another device
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
      // The file replaces everything: products missing from it count as deleted,
      // and the imported ones as just edited, so a sync keeps the import
      const now = nowIso();
      const keep = new Set(normalized.map(i => i.id));
      for (const i of items) if (!keep.has(i.id)) deleted[i.id] = now;
      for (const i of normalized) { i.updatedAt = now; delete deleted[i.id]; }
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
    // Decimal comma: with ';' as separator, Italian Excel reads '179.99' as text/date
    return [i.product, i.category, fmtDate(i.date), i.price.toFixed(2).replace('.', ','), days, cpd.toFixed(2).replace('.', ','), i.retired?'Ritirato':'Attivo', i.retiredDate?fmtDate(i.retiredDate):'', i.notes||''].map(csvCell).join(';');
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
  // A saved filter whose category no longer exists would hide every row
  // behind a select that shows "Tutte"
  if (filterCategory !== 'all' && !cats.includes(filterCategory)) {
    filterCategory = 'all';
    localStorage.setItem('filterCategory', 'all');
  }
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
  setPassphrase: () => setPassphrase(),
  removePassphrase: () => removePassphrase(),
  exportBackup: () => exportBackup(),
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
// Own-property lookup only: an attribute value like "constructor" must not hit
// Object.prototype, and a misspelled action is reported instead of ignored
function lookupAction(table, kind, name) {
  if (Object.hasOwn(table, name)) return table[name];
  console.warn('Unknown ' + kind + ': ' + name);
  return null;
}
function handleClickAction(e) {
  const el = e.target.closest('[data-action]');
  const fn = el && lookupAction(CLICK_ACTIONS, 'data-action', el.dataset.action);
  if (fn) fn(el, e);
}
function handleChangeAction(e) {
  const name = e.target.dataset && e.target.dataset.change;
  const fn = name !== undefined && lookupAction(CHANGE_ACTIONS, 'data-change', name);
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
    // No local data: start empty. The epoch timestamp marks this untouched
    // state so a sync configured later never pushes it over a real Gist
    if (!getSyncConfig()) {
      items = [];
      dataLastModified = SEED_TIMESTAMP;
      save();
    }
  }
  updateSyncUI();
  updateBackupUI();
  render();

  // Reconcile with remote if sync configured (takes the newer side). Not awaited:
  // a slow or captive network must not delay the listeners and the service worker
  if (getSyncConfig()) doSync();

  // Coming back to a PWA left open: refresh day counts and pick up changes made
  // on other devices before the next local edit pushes over them
  let lastResumeSync = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    render();
    if (getSyncConfig() && !pushTimer && !syncRunning && Date.now() - lastResumeSync > 60000) {
      lastResumeSync = Date.now();
      doSync();
    }
  });
  window.addEventListener('online', () => {
    if (getSyncConfig()) doSync(); // also retries a push that failed offline
  });

  // Keep multiple tabs in sync
  window.addEventListener('storage', (e) => {
    if (e.key !== 'diluizione_data' || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue);
      if (document.getElementById('modalOverlay').classList.contains('active')) closeModal();
      items = normalizeItems(parsed.items || parsed);
      deleted = normalizeDeleted(parsed.deleted);
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
