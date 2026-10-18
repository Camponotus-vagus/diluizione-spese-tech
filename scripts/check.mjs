// Static checks: scripts parse, the CSP stays strict, manifest is valid and precached assets exist.
import fs from 'node:fs';
import vm from 'node:vm';

let failed = false;
const fail = msg => { console.error('FAIL  ' + msg); failed = true; };
const ok = msg => console.log('ok    ' + msg);
const parse = file => { try { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }); ok(file); } catch (e) { fail(`${file}: ${e.message}`); } };

parse('app.js');
parse('sw.js');

// CSP without 'unsafe-inline': no inline scripts, handlers or style attributes may come back
const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('app.js', 'utf8');
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
if (!csp) fail('index.html: CSP meta tag missing');
else if (csp.includes("'unsafe-inline'")) fail("CSP contains 'unsafe-inline'");
else ok('CSP is strict');
if (/<script(?![^>]*\ssrc=)[^>]*>/.test(html)) fail('index.html: inline <script> (blocked by CSP)');
if (/<style[\s>]/.test(html)) fail('index.html: inline <style> (blocked by CSP), use app.css');
for (const [name, src] of [['index.html', html], ['app.js', js]]) {
  const handler = src.match(/\son[a-z]+=["']/);
  if (handler) fail(`${name}: inline event handler "${handler[0].trim()}" (blocked by CSP), use data-action`);
  const style = src.match(/\sstyle=["']/);
  if (style) fail(`${name}: style attribute (blocked by CSP), use a class, hidden or data-css`);
}

try {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  for (const icon of manifest.icons || []) if (!fs.existsSync(icon.src.replace(/^\.\//, ''))) fail(`manifest icon missing: ${icon.src}`);
  ok('manifest.json');
} catch (e) { fail('manifest.json: ' + e.message); }

// Every precached asset must exist, or the service worker install fails
const sw = fs.readFileSync('sw.js', 'utf8');
for (const [, asset] of sw.matchAll(/'\.\/([^']+)'/g)) if (!fs.existsSync(asset)) fail(`sw.js precaches missing file: ${asset}`);
for (const asset of ['app.js', 'app.css']) if (!sw.includes(`'./${asset}'`)) fail(`sw.js does not precache ${asset}`);

process.exit(failed ? 1 : 0);
