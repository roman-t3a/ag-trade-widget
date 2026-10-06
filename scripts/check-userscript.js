'use strict';
// Static checks for the Tampermonkey userscripts in this repo (run in CI):
//  · each is ONE self-contained file (no import / require / extra local files), one strict-mode IIFE, < 1 MB
//  · the ==UserScript== header is complete: version is semver and has a CHANGELOG.md section, auto-update URLs point
//    at this repo, every @match is https, @noframes is set
//  · every GM_* API the code uses is granted, and nothing is granted that is not used
//  · @require is pinned to an exact version with a sha256 integrity hash
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const RAW = 'https://raw.githubusercontent.com/roman-t3a/ag-trade-widget/main/';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// version: package.json follows the trade widget; the changelog heading is "## <version>" or "## <prefix> <version>"
const SCRIPTS = [
  { file: 'ag-trade-widget.user.js', pkgVersion: true, heading: '', connect: ['backtester.alphagardeners.xyz'] },
  { file: 'ag-intel.user.js', pkgVersion: false, heading: 'AG Intel ', connect: [] },
];

let failed = 0;
for (const S of SCRIPTS) {
  const errors = [];
  const fail = (m) => errors.push(m);
  const src = fs.readFileSync(path.join(root, S.file), 'utf8');
  const hm = src.match(/^\/\/ ==UserScript==\n([\s\S]*?)\n\/\/ ==\/UserScript==\n/);
  if (!hm) { console.error(`✗ ${S.file}: missing or malformed ==UserScript== header at the top of the file`); failed++; continue; }
  const meta = {};
  for (const line of hm[1].split('\n')) {
    const m = line.match(/^\/\/ @(\S+)(?:\s+(.*))?$/);
    if (!m) { fail(`header: unexpected line "${line}"`); continue; }
    (meta[m[1]] = meta[m[1]] || []).push((m[2] || '').trim());
  }
  const one = (k) => (meta[k] || [])[0];
  for (const k of ['name', 'namespace', 'version', 'description', 'match', 'grant', 'run-at', 'updateURL', 'downloadURL', 'noframes']) if (!meta[k]) fail(`header: @${k} is missing`);

  const ver = one('version');
  if (!/^\d+\.\d+\.\d+$/.test(ver || '')) fail(`header: @version "${ver}" is not semver`);
  if (S.pkgVersion && ver !== pkg.version) fail(`version mismatch: header ${ver} vs package.json ${pkg.version}`);
  const heading = `## ${S.heading}${ver}`;
  if (!new RegExp(`^${esc(heading)}\\b`, 'm').test(changelog)) fail(`CHANGELOG.md has no "${heading}" section`);

  for (const k of ['updateURL', 'downloadURL']) if (one(k) && one(k) !== RAW + S.file) fail(`header: @${k} should be ${RAW + S.file}`);
  for (const m of meta.match || []) if (!/^https:\/\//.test(m)) fail(`header: @match "${m}" must be https`);
  for (const c of S.connect) if (!(meta.connect || []).includes(c)) fail(`header: @connect ${c} is required`);
  if ((meta.connect || []).includes('*')) fail('header: @connect * lets the script reach any site: list the hosts instead');

  for (const r of meta.require || []) {
    if (!/@\d+\.\d+\.\d+\//.test(r)) fail(`@require must pin an exact version: ${r}`);
    if (!/#sha256=[A-Za-z0-9+/=]{44}$/.test(r)) fail(`@require needs a #sha256= integrity hash: ${r}`);
  }

  // grants: used ⇔ granted
  const body = src.slice(hm[0].length);
  const used = new Set(body.match(/\bGM_[A-Za-z]+\b|\bunsafeWindow\b/g) || []);
  used.delete('GM_info'); // always available, no grant
  const granted = new Set(meta.grant || []);
  for (const g of used) if (!granted.has(g)) fail(`${g} is used but not granted (@grant ${g})`);
  for (const g of granted) if (!used.has(g)) fail(`@grant ${g} is not used: remove it`);

  // single file
  if (/^\s*import\s/m.test(body) || /\bimport\(/.test(body)) fail('ES module import found: Tampermonkey needs a single classic script');
  const reqs = (body.match(/\brequire\(/g) || []).length;
  if (reqs) fail(`require( found ${reqs}×: the userscript must stay a single file`);
  if (!/^\(function \(\) \{\n {2}'use strict';/m.test(body.trimStart())) fail('the code should be one strict-mode IIFE');
  const kb = Buffer.byteLength(src) / 1024;
  if (kb > 1024) fail(`file is ${kb.toFixed(0)} KB: keep it under 1 MB`);

  if (errors.length) { console.error(errors.map((e) => `✗ ${S.file}: ${e}`).join('\n')); failed++; }
  else console.log(`✓ ${S.file} v${ver} · ${kb.toFixed(0)} KB · grants: ${[...granted].join(', ')}`);
}
if (failed) process.exit(1);
