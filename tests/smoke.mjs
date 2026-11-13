// Smoke test: serve the static app and check layout, robustness guards and the easter egg.
// Usage: node tests/smoke.mjs   (requires the `playwright` package and Chromium)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  // Like GitHub Pages, a directory serves its index.html (the worker precaches './')
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok, extra });
// CHROMIUM_PATH lets a preinstalled browser be used when its version differs from the pinned one
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// Google Fonts is external: block it so the test doesn't depend on the network
const newCtx = opts => browser.newContext({ serviceWorkers: 'block', ...opts }).then(async c => {
  await c.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return c;
});
// Page errors plus Content Security Policy violations reported by the browser
const watchErrors = p => {
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errs.push(m.text()); });
  return errs;
};

try {
  for (const [w, h] of [[320, 640], [360, 740], [1280, 900]]) for (const colorScheme of ['light', 'dark']) {
    const ctx = await newCtx({ viewport: { width: w, height: h }, colorScheme });
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
  check('corrupt storage is backed up', await p.evaluate(() => localStorage.getItem('diluizione_data_backup')) === '{oops');

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
  await p.evaluate(() => localStorage.clear());
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
      if (req.method() === 'PATCH') {
        gist.content = JSON.parse(req.postData()).files['diluizione_data.json'].content;
        return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      const files = gist.content ? { 'diluizione_data.json': { content: gist.content } } : {};
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'abc123', files }) });
    });
    return { c, log };
  };
  const configure = async q => {
    await q.click('[data-action="toggleSettings"]');
    await q.fill('#inputToken', 'tok'); await q.fill('#inputGistId', 'abc123');
    await q.click('[data-action="configureSync"]');
  };
  {
    // New device with demo data linking an existing Gist: the Gist wins, no prompt, no overwrite
    const gist = { content: JSON.stringify(REMOTE) };
    const { c, log } = await syncCtx(gist);
    const q = await c.newPage(); const qerrs = watchErrors(q);
    await q.goto(URL_); await q.waitForSelector('#tableWrap table');
    await configure(q);
    await q.waitForFunction(() => items.length === 1 && items[0].id === 'real');
    await q.reload(); await q.waitForSelector('#tableWrap table');
    await q.waitForTimeout(300);
    check('demo data never overwrites the Gist', !log.some(l => l.method === 'PATCH') && JSON.parse(gist.content).items[0].id === 'real');
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
    // Remote with an invalid record: kept in a backup and reported
    const gist = { content: JSON.stringify({ items: [...REMOTE.items, { product: 'rotto', date: 'x', price: -1 }], lastModified: REMOTE.lastModified }) };
    const { c } = await syncCtx(gist);
    const q = await c.newPage();
    await q.goto(URL_);
    await q.evaluate(() => { localStorage.setItem('sync_token', 'tok'); localStorage.setItem('sync_gist_id', 'abc123'); });
    await q.reload();
    await q.waitForFunction(() => items.length === 1 && items[0].id === 'real');
    check('dropped remote records are backed up', (await q.evaluate(() => localStorage.getItem('diluizione_data_backup') || '')).includes('rotto'));
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
  await sp.goto(URL_); await sp.waitForSelector('#tableWrap table');
  await sp.evaluate(() => navigator.serviceWorker.ready);
  await sp.waitForFunction(async () => {
    const keys = await caches.keys();
    if (!keys.length) return false;
    for (const a of ['./index.html', './theme.js', './app.js', './app.css']) if (!(await caches.match(a))) return false;
    return true;
  });
  await sp.reload(); await sp.waitForSelector('#tableWrap table');
  check('service worker controls the page', await sp.evaluate(() => !!navigator.serviceWorker.controller));
  await sctx.setOffline(true);
  await sp.reload(); await sp.waitForSelector('#tableWrap table');
  check('app shell served offline from cache', await sp.evaluate(() =>
    document.documentElement.hasAttribute('data-theme') &&
    [...document.styleSheets].some(s => s.href && s.href.endsWith('/app.css') && s.cssRules.length > 0)));
  check('no JS errors in service worker run', !serrs.length, serrs.join(' | '));
} finally {
  await browser.close();
  server.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.extra ? '' : '  → ' + r.extra}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
