/**
 * Tests for the integrity of the static site itself.
 *
 * The site is served straight off a disk by GitHub Pages, so a reference to a
 * file that does not exist is a 404 in production and nothing at all locally -
 * which is how the page came to load `js/jquery.min.js`, a file that was never
 * committed, while the real jQuery sat further down the document.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from './harness.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'coverage', '.jekyll-cache', '_site']);

/**
 * Files that are legitimately absent from the repository because the toolchain
 * that consumes them injects them at build time. Each entry needs a reason.
 */
const KNOWN_ABSENT = {
  'cordova.js': 'injected into www/ by the Apache Cordova CLI at build time',
};

function htmlFiles(dir = REPO_ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) htmlFiles(abs, found);
    } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      found.push(abs);
    }
  }
  return found.sort();
}

const relative = (abs) => abs.slice(REPO_ROOT.length + 1).split(sep).join('/');
const isExternal = (url) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(url);

test('every local asset referenced by a page exists in the repository', () => {
  const missing = [];

  for (const file of htmlFiles()) {
    const text = readFileSync(file, 'utf8');
    // src / href / poster / data-src on any element.
    const references = text.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi);

    for (const [, raw] of references) {
      const url = raw.trim();
      if (url === '' || isExternal(url)) continue;

      // Browsers normalise backslashes in URLs; the site should not rely on it.
      const clean = decodeURIComponent(url.replace(/\\/g, '/'));
      const target = resolve(dirname(file), clean.split('#')[0]);
      const reason = KNOWN_ABSENT[clean.split('/').pop()];

      if (!existsSync(target) && !reason) {
        missing.push(`${relative(file)} -> ${url}`);
      }
    }
  }

  assert.deepEqual(missing, [], `broken local references:\n  ${missing.join('\n  ')}`);
});

test('the site does not reference an end-of-life jQuery', () => {
  const offenders = [];

  for (const file of htmlFiles()) {
    const text = readFileSync(file, 'utf8');
    if (/jquery[-.]?(?:1\.|2\.)/i.test(text)) offenders.push(relative(file));
  }

  assert.deepEqual(offenders, [], `pages still loading EOL jQuery: ${offenders.join(', ')}`);
});

test('third-party scripts are loaded from vendor/', () => {
  const offenders = [];
  const thirdParty = /jquery|bootstrap|isotope|scrolltofixed|wow|classie|respond|html5shiv|html5element|easing/;

  for (const file of htmlFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const [, src] of text.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const url = src.trim();
      if (isExternal(url) || !thirdParty.test(url)) continue;
      if (!url.startsWith('vendor/')) offenders.push(`${relative(file)} -> ${url}`);
    }
  }

  assert.deepEqual(offenders, [], `third-party code outside vendor/: ${offenders.join(', ')}`);
});

test('the vendored jQuery is a supported release', () => {
  const file = join(REPO_ROOT, 'vendor', 'jquery-3.7.1', 'jquery.min.js');
  const header = readFileSync(file, 'utf8').slice(0, 200);
  const version = header.match(/jQuery v(\d+)\.(\d+)\.(\d+)/);

  assert.ok(version, 'could not read the jQuery version from the vendored file');
  const major = Number(version[1]);
  assert.ok(major >= 3, `vendored jQuery is ${version[0]}, which carries known XSS issues`);
});

test('no page loads a script or stylesheet over plaintext http', () => {
  const offenders = [];

  for (const file of htmlFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const [, url] of text.matchAll(/\b(?:src|href|poster)\s*=\s*["'](http:\/\/[^"']+)["']/gi)) {
      offenders.push(`${relative(file)} -> ${url.slice(0, 60)}`);
    }
  }

  assert.deepEqual(offenders, [], `plaintext subresources: ${offenders.join(', ')}`);
});

test('no element id is used twice on a page', () => {
  const offenders = [];

  for (const file of htmlFiles()) {
    const text = readFileSync(file, 'utf8');
    const seen = new Map();
    for (const match of text.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) {
      const name = match[1].trim();
      if (seen.has(name)) offenders.push(`${relative(file)}: "${name}"`);
      else seen.set(name, true);
    }
  }

  assert.deepEqual(offenders, [], `duplicate ids: ${offenders.join(', ')}`);
});

test('the site entry point is a real file, not a directory', () => {
  const entry = join(REPO_ROOT, 'index.html');
  assert.ok(statSync(entry).isFile());
  assert.match(readFileSync(entry, 'utf8'), /^<!DOCTYPE html>/i);
});

test('the site loads exactly one copy of jQuery', () => {
  const text = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
  // jQuery plugins (jquery.isotope.js, jquery.easing-1.3.js, ...) also contain
  // "jquery", so match the core library specifically.
  const isCoreJQuery = (src) => /jquery[-/.]\d/.test(src) || /(^|\/)jquery\.min\.js$/.test(src);
  const scripts = [...text.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
    .map(([, src]) => src)
    .filter(isCoreJQuery);

  assert.deepEqual(scripts, ['vendor/jquery-3.7.1/jquery.min.js'], 'one jQuery, from vendor/');
});
