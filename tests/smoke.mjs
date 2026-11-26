// Smoke test: serve the static app and check layout, robustness guards and the easter egg.
// Usage: node tests/smoke.mjs   (requires the `playwright` package and Chromium)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.woff2': 'font/woff2', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  // Like GitHub Pages, a directory serves its index.html (the worker precaches './')
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!(file === ROOT || file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok, extra });
// CHROMIUM_PATH lets a preinstalled browser be used when its version differs from the pinned one
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// Privacy: the app may only talk to its own origin and the GitHub API (mocked per test).
// Anything else is recorded and blocked.
const thirdParty = [];
const newCtx = opts => browser.newContext({ serviceWorkers: 'block', ...opts }).then(async c => {
  await c.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return r.continue();
    if (u.hostname !== 'api.github.com') thirdParty.push(u.href);
    return r.abort();
  });
  return c;
});
// Page errors plus Content Security Policy violations reported by the browser
const watchErrors = p => {
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errs.push(m.text()); });
  return errs;
};

// Contents of the local backups
const BACKUPS = () => Object.keys(localStorage).filter(k => k.startsWith('diluizione_backup_')).sort().map(k => localStorage.getItem(k));
const SAMPLE = [
  { id: 's1', product: 'Prodotto di prova con un nome piuttosto lungo', date: '2020-03-01', price: 1234.56, category: 'Laptop' },
  { id: 's2', product: 'Cuffie', date: '2022-06-15', price: 99, category: 'Audio' },
  { id: 's3', product: 'Telefono', date: '2021-01-10', price: 650, category: 'Smartphone', retired: true, retiredDate: '2024-01-10' }
];

try {
  {
    // A fresh install ships no personal data: empty state, nothing seeded
    const ctx = await newCtx({ viewport: { width: 360, height: 740 } });
    const p = await ctx.newPage(); const errs = watchErrors(p);
    await p.goto(URL_); await p.waitForSelector('#tableWrap .empty');
    check('fresh install starts empty', await p.evaluate(() => items.length === 0 && JSON.parse(localStorage.getItem('diluizione_data')).items.length === 0));
    check('no JS errors on empty start', !errs.length, errs.join(' | '));
    await ctx.close();
  }
  for (const [w, h] of [[320, 640], [360, 740], [1280, 900]]) for (const colorScheme of ['light', 'dark']) {
    const ctx = await newCtx({ viewport: { width: w, height: h }, colorScheme });
    // The app starts empty: load fictitious sample rows so the table layout is exercised
    await ctx.addInitScript(rows => { if (!localStorage.getItem('diluizione_data')) localStorage.setItem('diluizione_data', JSON.stringify({ items: rows, lastModified: '2024-01-01T00:00:00.000Z' })); }, SAMPLE);
    const p = await ctx.newPage(); const errs = watchErrors(p);
    await p.goto(URL_); await p.waitForSelector('#tableWrap table');
    const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    check(`no horizontal scroll ${w}px ${colorScheme}`, sw <= iw, `${sw}>${iw}`);
    check(`no JS errors ${w}px ${colorScheme}`, !errs.length, errs.join(' | '));
    await ctx.close();
  }

  const ctx = await newCtx({ viewport: { width: 360, height: 740 } });
  const p = await ctx.newPage(); const errs = watchErrors(p);
  await p.goto(URL_);

  check('milestone guard on huge price', await p.evaluate(() => getMilestoneDate({ price: 3e7, date: '2024-01-01' }, 0.25) === null));
  await p.evaluate(() => localStorage.setItem('diluizione_data', JSON.stringify({ items: [
    { id: 'a', product: 'Big', date: '2024-01-01', price: 3e7, category: 'Altro' },
    { id: 'b', product: 'Ok', date: '2024-01-01', price: 100, category: 'Audio' }] })));
  await p.reload();
  check('app renders with oversized price stored', await p.$$eval('#tableWrap tbody tr', r => r.length) === 1);

  await p.evaluate(() => localStorage.setItem('diluizione_data', '{oops'));
  await p.reload();
  check('corrupt storage is backed up', (await p.evaluate(BACKUPS)).includes('{oops'));

  check('duplicate ids are regenerated', await p.evaluate(() => {
    const ids = normalizeItems([{ id: 'x', product: 'a', date: '2024-01-01', price: 1 }, { id: 'x', product: 'b', date: '2024-01-01', price: 2 }]).map(i => i.id);
    return ids[0] !== ids[1];
  }));
  check('malformed remote payload rejected', await p.evaluate(() => { try { parseRemoteItems({ items: 'x' }); return false; } catch { return true; } }));
  check('future remote timestamp clamped', await p.evaluate(() => clampTimestamp('9999-12-31T00:00:00Z') < '2100'));
  check('quota error rolls back', await p.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    const n = items.length;
    items.push({ id: 'z', product: 'z', date: '2024-01-01', price: 5, category: 'Altro' });
    const ok = afterModification();
    Storage.prototype.setItem = orig;
    return ok === false && items.length === n;
  }));

  // Data integrity fixes (batch 11)
  check('retired date one day ahead is kept', await p.evaluate(() => {
    const t = new Date(Date.parse(today()) + 86400000).toISOString().slice(0, 10);
    return normalizeItems([{ product: 'x', date: '2024-01-01', price: 10, retired: true, retiredDate: t }])[0].retiredDate === t;
  }));
  check('retired item without date gets one (no ageing)', await p.evaluate(() =>
    normalizeItems([{ product: 'x', date: '2024-01-01', price: 10, retired: true }])[0].retiredDate === today()));
  check('retired date far in the future clamped to today', await p.evaluate(() =>
    normalizeItems([{ product: 'x', date: '2024-01-01', price: 10, retired: true, retiredDate: '2999-01-01' }])[0].retiredDate === today()));
  check('rejected edit leaves item intact', await p.evaluate(() => {
    items = normalizeItems([{ id: 'r', product: 'Old', date: '2020-01-01', price: 100, category: 'Audio', retired: true, retiredDate: '2021-01-01' }]);
    openModal('r');
    document.getElementById('fDate').value = '2022-06-01';
    document.getElementById('fPrice').value = '5';
    saveProduct();
    closeModal();
    const i = items[0];
    return i.date === '2020-01-01' && i.price === 100 && i.retiredDate === '2021-01-01';
  }));
  check('stale category filter resets', await p.evaluate(() => {
    filterCategory = 'Drone';
    items = normalizeItems([{ product: 'a', date: '2024-01-01', price: 10, category: 'Audio' }]);
    render();
    return filterCategory === 'all' && document.querySelectorAll('#tableWrap tbody tr').length === 1;
  }));
  check('second confirm cancels the first', await p.evaluate(async () => {
    const first = showConfirm('a');
    showConfirm('b');
    const r = await first;
    closeConfirm(false);
    return r === false;
  }));

  // UI wiring: every control now goes through delegated listeners instead of inline handlers
  await p.evaluate(rows => {
    localStorage.clear();
    localStorage.setItem('diluizione_data', JSON.stringify({ items: [...rows, { id: 'd', product: 'Drone di prova', date: '2021-05-01', price: 800, category: 'Drone' }], lastModified: '2024-01-01T00:00:00.000Z' }));
  }, SAMPLE);
  await p.reload(); await p.waitForSelector('#tableWrap table');
  await p.click('[data-action="setTheme"][data-arg="light"]');
  check('theme button works', await p.getAttribute('html', 'data-theme') === 'light');
  await p.click('[data-action="toggleSettings"]');
  check('settings toggle works', await p.isVisible('#settingsPanel'));
  await p.click('[data-action="toggleSettings"]');
  check('settings toggle hides again', !(await p.isVisible('#settingsPanel')));
  await p.click('header [data-action="openModal"]');
  check('add button opens modal', await p.isVisible('#modalOverlay.active') && !(await p.isVisible('#editFields')));
  await p.fill('#fProduct', 'Test CSP'); await p.fill('#fPrice', '42');
  await p.click('[data-action="saveProduct"]');
  check('save adds product', !(await p.isVisible('#modalOverlay.active')) && (await p.textContent('#tableWrap')).includes('Test CSP'));
  await p.click('tbody tr:has-text("Test CSP") [data-action="edit"]');
  check('edit opens modal with edit fields', await p.isVisible('#editFields'));
  await p.mouse.click(5, 5);
  check('click on overlay closes modal', !(await p.isVisible('#modalOverlay.active')));
  await p.click('tbody tr:has-text("Test CSP") [data-action="delete"]');
  await p.click('[data-action="closeConfirm"][data-arg="true"]');
  check('delete via confirm dialog', !(await p.textContent('#tableWrap')).includes('Test CSP'));
  await p.selectOption('[data-change="filterCategory"]', 'Drone');
  check('category filter works', await p.$$eval('#tableWrap tbody tr', r => r.length) === 1);
  await p.selectOption('[data-change="filterCategory"]', 'all');
  check('dynamic styles applied via CSSOM', await p.$eval('.progress-fill', el => el.style.width !== '' && !el.hasAttribute('data-css')));

  for (let i = 0; i < 7; i++) await p.click('header h1 .logo');
  check('easter egg after 7 logo taps', (await p.textContent('#toastWrap').catch(() => '') || '').includes('caffè'));
  check('no JS errors in robustness run', !errs.length, errs.join(' | '));

  // Gist sync against a mocked GitHub API
  const REMOTE = { items: [{ id: 'real', product: 'Dato vero', date: '2024-01-01', price: 100, category: 'Audio' }], lastModified: '2025-01-01T00:00:00.000Z' };
  const syncCtx = async (gist, status = 200) => {
    const c = await newCtx({ viewport: { width: 360, height: 740 } });
    const log = [];
    await c.route('https://api.github.com/**', async r => {
      const req = r.request();
      log.push({ method: req.method(), body: req.postData() });
      if (status !== 200) return r.fulfill({ status, body: '{}' });
      if (req.method() === 'PATCH' || req.method() === 'POST') {
        gist.content = JSON.parse(req.postData()).files['diluizione_data.json'].content;
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'abc123' }) });
      }
      const files = gist.content ? { 'diluizione_data.json': { content: gist.content } } : {};
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'abc123', files }) });
    });
    return { c, log };
  };
  const configure = async (q, { gistId = 'abc123', pass = '' } = {}) => {
    if (!(await q.isVisible('#inputToken'))) await q.click('[data-action="toggleSettings"]');
    await q.fill('#inputToken', 'tok'); await q.fill('#inputGistId', gistId); await q.fill('#inputPassphrase', pass);
    await q.click('[data-action="configureSync"]');
  };
  const synced = q => q.waitForFunction(() => document.getElementById('syncBadge').textContent.includes('🟢') && !syncRunning);
  // A device already linked to the Gist, with the given local data and last-sync point
  const linkedDevice = async (c, local, base) => {
    const q = await c.newPage(); const qerrs = watchErrors(q);
    await q.addInitScript(([local, base]) => {
      if (localStorage.getItem('test_init')) return;
      localStorage.setItem('test_init', '1');
      localStorage.setItem('diluizione_data', JSON.stringify(local));
      localStorage.setItem('sync_token', 'tok'); localStorage.setItem('sync_gist_id', 'abc123');
      if (base) localStorage.setItem('sync_base', base);
    }, [local, base]);
    await q.goto(URL_);
    await synced(q);
    return { q, qerrs };
  };
  const ids = gist => JSON.parse(gist.content).items.map(i => i.id).sort().join(',');
  {
    // New, empty device linking an existing Gist: the Gist wins, no prompt, no overwrite
    const gist = { content: JSON.stringify(REMOTE) };
    const { c, log } = await syncCtx(gist);
    const q = await c.newPage(); const qerrs = watchErrors(q);
    await q.goto(URL_); await q.waitForSelector('#tableWrap .empty');
    await configure(q);
    await q.waitForFunction(() => items.length === 1 && items[0].id === 'real');
    await q.reload(); await q.waitForSelector('#tableWrap table');
    await q.waitForTimeout(300);
    check('empty fresh data never overwrites the Gist', !log.some(l => l.method === 'PATCH') && JSON.parse(gist.content).items[0].id === 'real');
    check('no JS errors in sync run', !qerrs.length, qerrs.join(' | '));
    await c.close();
  }
  {
    // Real local data + "Annulla": local data is uploaded right away, as the prompt says
    const gist = { content: JSON.stringify(REMOTE) };
    const { c, log } = await syncCtx(gist);
    const q = await c.newPage();
    await q.goto(URL_);
    await q.evaluate(() => localStorage.setItem('diluizione_data', JSON.stringify({ items: [{ id: 'mine', product: 'Locale', date: '2024-01-01', price: 50, category: 'Audio' }], lastModified: '2024-06-01T00:00:00.000Z' })));
    await q.reload(); await q.waitForSelector('#tableWrap table');
    await configure(q);
    await q.click('[data-action="closeConfirm"][data-arg="false"]');
    await q.waitForFunction(() => document.getElementById('syncBadge').textContent.includes('🟢'));
    check('"Annulla" pushes local data to the Gist', log.some(l => l.method === 'PATCH') && JSON.parse(gist.content).items[0].id === 'mine');
    await c.close();
  }
  {
    // Two devices edit at the same time: the stale one merges instead of overwriting
    const T1 = new Date(Date.now() - 2 * 86400000).toISOString(), T2 = new Date(Date.now() - 86400000).toISOString();
    const real = { ...REMOTE.items[0], updatedAt: T1 };
    const gist = { content: JSON.stringify({ items: [real], lastModified: T1 }) };
    const { c, log } = await syncCtx(gist);
    const { q, qerrs } = await linkedDevice(c, { items: [real], lastModified: T1 }, T1);
    check('in-sync device does not write', !log.some(l => l.method === 'PATCH'));
    // Meanwhile another device deletes "real" and adds "other"
    gist.content = JSON.stringify({ items: [{ id: 'other', product: 'Altro device', date: '2024-02-01', price: 30, category: 'Audio', updatedAt: T2 }], deleted: { real: T2 }, lastModified: T2 });
    // ...and this stale device adds a product
    await q.evaluate(() => { items.push({ id: 'mine', product: 'Nuovo', date: '2024-03-01', price: 20, category: 'Audio', retired: false, retiredDate: null, notes: '', updatedAt: nowIso() }); afterModification(); });
    await q.waitForFunction(() => items.some(i => i.id === 'other'));
    await synced(q);
    check('concurrent edits merged, nothing overwritten', ids(gist) === 'mine,other', ids(gist));
    check('deletion from the other device kept', !(await q.evaluate(() => items.some(i => i.id === 'real'))));
    check('local data backed up before the merge', (await q.evaluate(BACKUPS)).some(b => b.includes('"real"')));

    // An emptied Gist does not silently wipe this device
    gist.content = JSON.stringify({ items: [], lastModified: new Date().toISOString() });
    await q.evaluate(() => { localStorage.setItem('sync_base', JSON.parse(localStorage.getItem('diluizione_data')).lastModified); doSync(); });
    await q.waitForSelector('#confirmOverlay.active');
    await q.click('[data-action="closeConfirm"][data-arg="false"]');
    await synced(q);
    check('empty Gist asks before wiping local data', ids(gist) === 'mine,other', ids(gist));
    check('no JS errors in merge run', !qerrs.length, qerrs.join(' | '));
    await c.close();
  }
  {
    // Upgrade from the previous version (old format, no sync_base): data already
    // in sync is left exactly as it is, nothing is written or lost
    const T = '2025-05-01T10:00:00.000Z';
    const old = { items: [REMOTE.items[0], { id: 'x2', product: 'Secondo', date: '2023-01-01', price: 10, category: 'Audio' }], lastModified: T };
    const gist = { content: JSON.stringify(old) };
    const { c, log } = await syncCtx(gist);
    const { q, qerrs } = await linkedDevice(c, old, null);
    check('upgrade: synced data untouched', !log.some(l => l.method === 'PATCH') && (await q.evaluate(() => items.length)) === 2 && gist.content === JSON.stringify(old));
    check('upgrade: sync point recorded', (await q.evaluate(() => localStorage.getItem('sync_base'))) === T);
    check('no JS errors in upgrade run', !qerrs.length, qerrs.join(' | '));
    await c.close();
  }
  {
    // Encryption: the Gist only ever holds ciphertext, and a device without
    // (or with the wrong) passphrase can neither read nor overwrite it
    const gist = {};
    const { c, log } = await syncCtx(gist);
    const q = await c.newPage(); const qerrs = watchErrors(q);
    await q.goto(URL_);
    await q.evaluate(() => localStorage.setItem('diluizione_data', JSON.stringify({ items: [{ id: 'secret', product: 'Acquisto segreto', date: '2024-01-01', price: 50, category: 'Audio' }], lastModified: '2024-06-01T00:00:00.000Z' })));
    await q.reload(); await q.waitForSelector('#tableWrap table');
    await configure(q, { gistId: '', pass: 'passphrase-di-prova' });
    await synced(q);
    check('new Gist is created encrypted', !!gist.content && JSON.parse(gist.content).enc && !gist.content.includes('segreto') && !gist.content.includes('2024-01-01'));
    await q.evaluate(() => { items[0].product = 'Modificato'; items[0].updatedAt = nowIso(); afterModification(); });
    await q.waitForFunction(() => document.getElementById('syncBadge').textContent.includes('🟡'));
    await synced(q);
    check('edits are pushed encrypted', !gist.content.includes('Modificato'));
    check('encryption state shown', (await q.textContent('#syncEncState')).includes('cifrati'));
    await c.close();

    const { c: c2, log: log2 } = await syncCtx(gist);
    const d = await c2.newPage(); const derrs = watchErrors(d);
    await d.goto(URL_);
    await configure(d, { pass: 'passphrase-sbagliata' });
    await d.waitForSelector('.toast-error');
    check('wrong passphrase is refused', (await d.textContent('#toastWrap')).includes('passphrase errata') && !(await d.evaluate(() => localStorage.getItem('sync_token'))));
    await configure(d, { pass: 'passphrase-di-prova' });
    await d.waitForFunction(() => items.length === 1 && items[0].product === 'Modificato');
    check('right passphrase decrypts on another device', !log2.some(l => l.method === 'PATCH'));
    // Same device without the passphrase: refuses to sync or push plaintext over it
    await d.evaluate(() => { localStorage.removeItem('sync_passphrase'); keyCache = null; });
    await d.reload();
    await d.waitForSelector('.toast-error');
    await d.evaluate(() => pushToGist());
    check('no passphrase: no plaintext written over the encrypted Gist', !log2.some(l => l.method === 'PATCH') && JSON.parse(gist.content).enc);
    check('no JS errors in encryption run', !qerrs.length && !derrs.length, [...qerrs, ...derrs].join(' | '));
    await c2.close();
  }
  {
    // Remote with an invalid record: kept in a backup and reported
    const gist = { content: JSON.stringify({ items: [...REMOTE.items, { product: 'rotto', date: 'x', price: -1 }], lastModified: REMOTE.lastModified }) };
    const { c } = await syncCtx(gist);
    const q = await c.newPage();
    await q.goto(URL_);
    await q.evaluate(() => { localStorage.setItem('sync_token', 'tok'); localStorage.setItem('sync_gist_id', 'abc123'); });
    await q.reload();
    await q.waitForFunction(() => items.length === 1 && items[0].id === 'real');
    check('dropped remote records are backed up', (await q.evaluate(BACKUPS)).some(b => b.includes('rotto')));
    await c.close();
  }
  {
    // Expired token: the user is told, not just a red badge
    const { c } = await syncCtx({}, 401);
    const q = await c.newPage();
    await q.goto(URL_);
    await q.evaluate(() => { localStorage.setItem('sync_token', 'tok'); localStorage.setItem('sync_gist_id', 'abc123'); });
    await q.reload();
    await q.waitForSelector('.toast-error');
    check('expired token is reported', (await q.textContent('#toastWrap')).includes('Token GitHub'));
    await c.close();
  }

  // Service worker: precaches the app shell, takes control on the next load and
  // serves page, scripts and styles from its cache when the network is gone
  const sctx = await newCtx({ serviceWorkers: 'allow', viewport: { width: 360, height: 740 } });
  const sp = await sctx.newPage(); const serrs = watchErrors(sp);
  await sp.goto(URL_); await sp.waitForSelector('#tableWrap .empty');
  await sp.evaluate(() => navigator.serviceWorker.ready);
  await sp.waitForFunction(async () => {
    const keys = await caches.keys();
    if (!keys.length) return false;
    for (const a of ['./index.html', './theme.js', './app.js', './app.css']) if (!(await caches.match(a))) return false;
    return true;
  });
  await sp.reload(); await sp.waitForSelector('#tableWrap .empty');
  check('service worker controls the page', await sp.evaluate(() => !!navigator.serviceWorker.controller));
  await sctx.setOffline(true);
  await sp.reload(); await sp.waitForSelector('#tableWrap .empty');
  check('app shell served offline from cache', await sp.evaluate(() =>
    document.documentElement.hasAttribute('data-theme') &&
    [...document.styleSheets].some(s => s.href && s.href.endsWith('/app.css') && s.cssRules.length > 0)));
  check('no JS errors in service worker run', !serrs.length, serrs.join(' | '));
  check('fonts served from the cache offline', await sp.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px "DM Sans"') && [...document.fonts].some(f => f.family.includes('DM Sans') && f.status === 'loaded');
  }));

  check('no third-party requests', !thirdParty.length, thirdParty.join(' | '));
} finally {
  await browser.close();
  server.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.extra ? '' : '  → ' + r.extra}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
