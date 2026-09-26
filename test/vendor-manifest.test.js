/**
 * Tests for the vendored dependency integrity manifest.
 *
 * vendor/manifest.json is the supply-chain control for this repository: it
 * states, for every third-party file on disk, which version it is, where it came
 * from, and the SHA-256 it must have. `npm run verify:vendor` enforces it in
 * CI; these tests enforce it in `npm test`, so a tampered or unpinned file
 * cannot get through either door.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from './harness.mjs';

const VENDOR = join(REPO_ROOT, 'vendor');
const manifest = JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf8'));

const sha256 = (abs) => `sha256-${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(relative(base, abs).split(sep).join('/'));
  }
  return out.sort();
}

test('the manifest is a non-empty, versioned document', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.libraries));
  assert.ok(manifest.libraries.length > 0);
});

test('every vendored file matches its recorded SHA-256 pin', () => {
  const mismatched = [];

  for (const library of manifest.libraries) {
    const abs = join(VENDOR, ...library.file.split('/'));
    assert.ok(existsSync(abs), `${library.file} is pinned but missing from vendor/`);
    const actual = sha256(abs);
    if (library.sha256 !== actual) {
      mismatched.push(`${library.file}\n      pinned ${library.sha256}\n      actual ${actual}`);
    }
  }

  assert.deepEqual(mismatched, [], `vendored files were modified:\n  ${mismatched.join('\n  ')}`);
});

test('no file sits in vendor/ without a pin and provenance', () => {
  const pinned = new Set(manifest.libraries.map((library) => library.file));
  const unpinned = listFiles(VENDOR).filter((file) => file !== 'manifest.json' && !pinned.has(file));

  assert.deepEqual(
    unpinned,
    [],
    `third-party code without a manifest entry: ${unpinned.join(', ')}. Add it to vendor/manifest.json, or delete it.`,
  );
});

test('every manifest entry records where the code came from and under what licence', () => {
  for (const library of manifest.libraries) {
    assert.ok(library.package, `${library.file}: no package name`);
    assert.ok(library.license, `${library.file}: no licence`);
    assert.ok(library.source, `${library.file}: no source URL`);
    assert.match(library.sha256 ?? '', /^sha256-[0-9a-f]{64}$/, `${library.file}: malformed pin`);
  }
});

test('the pinned jQuery is the version the pages load', () => {
  const jquery = manifest.libraries.find((library) => /jquery/i.test(library.package) && library.version);
  assert.ok(jquery, 'no versioned jQuery entry in the manifest');
  assert.match(jquery.version, /^\d+\./);

  const indexHtml = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
  assert.ok(
    indexHtml.includes(`vendor/jquery-${jquery.version}/`),
    `index.html does not load the pinned jQuery ${jquery.version}`,
  );
});

test('the removed end-of-life libraries are not back', () => {
  const paths = [
    'js/jquery-1.7.2.js',
    'js/jquery.1.8.3.min.js',
    'jquery.min.js',
    'snipcart.js',
    'backfix.min.js',
  ];
  const present = paths.filter((path) => existsSync(join(REPO_ROOT, ...path.split('/'))));

  assert.deepEqual(present, [], `unpinned, unreferenced blobs are back: ${present.join(', ')}`);
});
