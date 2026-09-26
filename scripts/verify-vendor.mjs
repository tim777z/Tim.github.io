#!/usr/bin/env node
/**
 * scripts/verify-vendor.mjs
 *
 * Supply-chain gate for the third-party code in `vendor/`.
 *
 * Every vendored file must be listed in `vendor/manifest.json` and must match
 * the SHA-256 pin recorded there. That gives us three properties a plain
 * `<script src="...">` tag cannot:
 *
 *   1. Integrity  - a swapped or tampered asset fails CI instead of shipping.
 *   2. Coverage   - an un-pinned file dropped into vendor/ fails CI, so
 *                   third-party code can never be added without provenance.
 *   3. Intent     - `--update` re-pins deliberately and loudly, so adding or
 *                   upgrading a library shows up as an explicit diff.
 *
 * Exit codes: 0 = all pins match, 1 = drift or coverage failure,
 *             2 = usage error.
 *
 * No third-party dependencies: standard library only.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = join(ROOT, 'vendor');
const MANIFEST = join(VENDOR_DIR, 'manifest.json');
const updateMode = process.argv.includes('--update');

/** @param {string} abs absolute path @returns {string} `sha256-<hex>` */
function sha256(abs) {
  return `sha256-${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
}

/** Every file below `dir`, as repo-relative POSIX paths, sorted. */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join('/'));
  }
  return out;
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (err) {
    console.error(`verify-vendor: cannot read ${relative(ROOT, MANIFEST)}: ${err.message}`);
    process.exit(2);
  }
}

const manifest = readManifest();
const pinned = new Map((manifest.libraries ?? []).map((lib) => [lib.file, lib]));
const problems = [];
const report = [];

// 1. Coverage: nothing may sit in vendor/ without a pin.
const onDisk = listFiles(VENDOR_DIR);
const expected = new Set([...pinned.keys(), 'manifest.json']);
for (const file of onDisk) {
  if (!expected.has(file)) {
    problems.push(`${file}: present in vendor/ but not listed in vendor/manifest.json - add it with provenance and an sha256 pin`);
  }
}

// 2. Presence + integrity, in a stable order for readable CI output.
for (const [file, lib] of [...pinned.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const abs = join(VENDOR_DIR, ...file.split('/'));
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    problems.push(`${file}: listed in vendor/manifest.json but missing from vendor/`);
    continue;
  }
  if (!stat.isFile()) {
    problems.push(`${file}: is not a regular file`);
    continue;
  }
  if (stat.size === 0) {
    problems.push(`${file}: is empty`);
    continue;
  }

  const actual = sha256(abs);
  const version = lib.version ? ` v${lib.version}` : ' (unversioned local copy)';
  if (!lib.sha256) {
    problems.push(`${file}: no sha256 pin recorded - run \`npm run verify:vendor -- --update\``);
    report.push(`  ?  ${file}${version}  NOT PINNED`);
  } else if (lib.sha256 !== actual) {
    problems.push(`${file}: sha256 mismatch\n      expected ${lib.sha256}\n      actual   ${actual}`);
    report.push(`  !! ${file}${version}  MISMATCH`);
  } else {
    report.push(`  ok ${file}${version}  ${lib.sha256.slice(0, 19)}...`);
  }
}

// 3. Metadata completeness: provenance we cannot audit is not provenance.
for (const [file, lib] of pinned) {
  for (const field of ['package', 'license', 'source']) {
    if (!lib[field]) problems.push(`${file}: manifest entry is missing "${field}"`);
  }
}

if (updateMode) {
  for (const lib of manifest.libraries ?? []) {
    const abs = join(VENDOR_DIR, ...lib.file.split('/'));
    lib.sha256 = sha256(abs);
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`verify-vendor: re-pinned ${manifest.libraries.length} libraries in vendor/manifest.json`);
  if (problems.some((p) => p.includes('sha256 pin'))) {
    console.log('verify-vendor: review the diff - pins changed, that is the point.');
  }
  process.exit(0);
}

if (problems.length) {
  console.error('verify-vendor: FAILED\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nVendored third-party code must stay byte-identical to vendor/manifest.json.');
  console.error('If an upgrade is intended, run `npm run verify:vendor -- --update` and commit the manifest.');
  process.exit(1);
}

console.log(`verify-vendor: ${pinned.size} vendored libraries match vendor/manifest.json`);
for (const line of report) console.log(line);
