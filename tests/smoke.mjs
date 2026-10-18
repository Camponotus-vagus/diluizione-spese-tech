// Smoke test: serve the static app and check layout, robustness guards and the easter egg.
// Usage: node tests/smoke.mjs   (requires the `playwright` package and Chromium)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok, extra });
const browser = await chromium.launch();
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
} finally {
  await browser.close();
  server.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.extra ? '' : '  → ' + r.extra}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
