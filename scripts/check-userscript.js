'use strict';
// Static checks for the Tampermonkey userscript (run in CI):
//  · it is ONE self-contained file (no import / require / extra local files)
//  · the ==UserScript== header is complete and consistent with package.json and CHANGELOG.md
//  · every GM_* API the code uses is granted, and nothing is granted that is not used
//  · @require is pinned to an exact version with a sha256 integrity hash
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const file = path.join(root, 'ag-trade-widget.user.js');
const src = fs.readFileSync(file, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const errors = [];
const fail = (m) => errors.push(m);

// ---- header
const hm = src.match(/^\/\/ ==UserScript==\n([\s\S]*?)\n\/\/ ==\/UserScript==\n/);
if (!hm) { console.error('✗ missing or malformed ==UserScript== header at the top of the file'); process.exit(1); }
const meta = {};
for (const line of hm[1].split('\n')) {
  const m = line.match(/^\/\/ @(\S+)\s+(.*)$/);
  if (!m) { fail(`header: unexpected line "${line}"`); continue; }
  (meta[m[1]] = meta[m[1]] || []).push(m[2].trim());
}
const one = (k) => (meta[k] || [])[0];
for (const k of ['name', 'namespace', 'version', 'description', 'match', 'grant', 'run-at', 'updateURL', 'downloadURL']) if (!meta[k]) fail(`header: @${k} is missing`);

const ver = one('version');
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) fail(`header: @version "${ver}" is not semver`);
if (ver !== pkg.version) fail(`version mismatch: header ${ver} vs package.json ${pkg.version}`);
if (!new RegExp(`^## ${String(ver).replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) fail(`CHANGELOG.md has no "## ${ver}" section`);

const raw = 'https://raw.githubusercontent.com/roman-t3a/ag-trade-widget/main/ag-trade-widget.user.js';
for (const k of ['updateURL', 'downloadURL']) if (one(k) && one(k) !== raw) fail(`header: @${k} should be ${raw}`);
for (const m of meta.match || []) if (!/^https:\/\//.test(m)) fail(`header: @match "${m}" must be https`);
if (!(meta.connect || []).includes('backtester.alphagardeners.xyz')) fail('header: @connect backtester.alphagardeners.xyz is required for direct calls');

for (const r of meta.require || []) {
  if (!/@\d+\.\d+\.\d+\//.test(r)) fail(`@require must pin an exact version: ${r}`);
  if (!/#sha256=[A-Za-z0-9+/=]{44}$/.test(r)) fail(`@require needs a #sha256= integrity hash: ${r}`);
}

// ---- grants: used ⇔ granted
const body = src.slice(hm[0].length);
const used = new Set(body.match(/\bGM_[A-Za-z]+\b|\bunsafeWindow\b/g) || []);
used.delete('GM_info'); // always available, no grant
const granted = new Set(meta.grant || []);
for (const g of used) if (!granted.has(g)) fail(`${g} is used but not granted (@grant ${g})`);
for (const g of granted) if (!used.has(g)) fail(`@grant ${g} is not used: remove it`);

// ---- single file
if (/^\s*import\s/m.test(body) || /\bimport\(/.test(body)) fail('ES module import found: Tampermonkey needs a single classic script');
const reqs = (body.match(/\brequire\(/g) || []).length;
if (reqs) fail(`require( found ${reqs}×: the userscript must stay a single file`);
if (!/^\(function \(\) \{\n {2}'use strict';/m.test(body.trimStart())) fail('the code should be one strict-mode IIFE');
const kb = Buffer.byteLength(src) / 1024;
if (kb > 1024) fail(`file is ${kb.toFixed(0)} KB: keep it under 1 MB`);

if (errors.length) { console.error(errors.map((e) => '✗ ' + e).join('\n')); process.exit(1); }
console.log(`✓ ${path.basename(file)} v${ver} · ${kb.toFixed(0)} KB · grants: ${[...granted].join(', ')}`);
