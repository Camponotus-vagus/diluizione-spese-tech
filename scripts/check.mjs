// Static checks: inline script and service worker parse, manifest is valid and its icons exist.
import fs from 'node:fs';
import vm from 'node:vm';

let failed = false;
const fail = msg => { console.error('FAIL  ' + msg); failed = true; };
const parse = (code, name) => { try { new vm.Script(code, { filename: name }); console.log('ok    ' + name); } catch (e) { fail(`${name}: ${e.message}`); } };

const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) fail('index.html: no inline script found');
scripts.forEach((s, i) => parse(s, `index.html <script #${i + 1}>`));
parse(fs.readFileSync('sw.js', 'utf8'), 'sw.js');

try {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  for (const icon of manifest.icons || []) if (!fs.existsSync(icon.src.replace(/^\.\//, ''))) fail(`manifest icon missing: ${icon.src}`);
  console.log('ok    manifest.json');
} catch (e) { fail('manifest.json: ' + e.message); }

// Every precached asset must exist, or the service worker install fails
const sw = fs.readFileSync('sw.js', 'utf8');
for (const [, asset] of sw.matchAll(/'\.\/([^']+)'/g)) if (!fs.existsSync(asset)) fail(`sw.js precaches missing file: ${asset}`);

process.exit(failed ? 1 : 0);
