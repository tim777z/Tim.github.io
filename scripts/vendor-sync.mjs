#!/usr/bin/env node
/**
 * scripts/vendor-sync.mjs - (re)materialise the pinned jQuery copy in vendor/.
 *
 * The site is served as plain files, so jQuery has to live in the repository.
 * The way to keep that honest is to make the copy reproducible and reviewable:
 *
 *   1. the version comes from package.json, pinned exactly, and package-lock.json
 *      records the resolved tarball and the integrity hash npm verified when it
 *      installed it;
 *   2. this script checks that what is installed is what was asked for, in the
 *      lockfile and in the file's own version banner, so a stale or hand-placed
 *      node_modules cannot be copied into the repository;
 *   3. the file is copied into vendor/jquery-<version>/ and the SHA-256 in
 *      vendor/manifest.json is re-pinned;
 *   4. the re-pin is a deliberate diff: if the bytes changed, the diff shows it,
 *      and a reviewer can compare the new hash against the published release.
 *
 * Note on integrity: `integrity` in package-lock.json is the hash of the
 * *tarball*, which npm verifies at download time. There is no per-file hash for
 * the extracted tree, so the byte-level control for the file in the repository is
 * the SHA-256 pin in vendor/manifest.json, enforced by `npm run verify:vendor`
 * and by test/vendor-manifest.test.js.
 *
 * Run it after bumping the jquery version in package.json:
 *
 *     npm install && npm run vendor:sync
 *
 * Exit codes: 0 = synced, 1 = failed, 2 = usage error.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules', 'jquery', 'dist', 'jquery.min.js');
const LOCKFILE = join(ROOT, 'package-lock.json');
const MANIFEST = join(ROOT, 'vendor', 'manifest.json');

function fail(message) {
  console.error(`vendor-sync: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.devDependencies?.jquery;
if (!version) fail('jquery is not declared in devDependencies');
if (!existsSync(SOURCE)) {
  fail(`node_modules/jquery is missing - run \`npm install\` first (declared version ${version})`);
}

const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
const locked = lock.packages?.['node_modules/jquery'];
if (!locked) fail('package-lock.json has no node_modules/jquery entry');
if (locked.version !== version) {
  fail(`package.json asks for jquery ${version} but the lockfile pins ${locked.version} - run \`npm install\``);
}
if (!locked.resolved || !locked.integrity) {
  fail('package-lock.json has no resolved URL or integrity hash for jquery; the install is not reproducible');
}

// The file's own banner is the last check that this is the version that was
// asked for, and not something that was dropped into node_modules by hand.
const bytes = readFileSync(SOURCE);
const declaredVersion = bytes.subarray(0, 200).toString('utf8').match(/jQuery v(\d+\.\d+\.\d+)/)?.[1];
if (declaredVersion !== version) {
  fail(`node_modules/jquery/dist/jquery.min.js is jQuery ${declaredVersion}, but package.json declares ${version}`);
}

const target = join(ROOT, 'vendor', `jquery-${version}`);
const targetFile = join(target, 'jquery.min.js');
const relativeTarget = `jquery-${version}/jquery.min.js`;

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const entry = manifest.libraries.find((library) => library.file === relativeTarget);
if (!entry) {
  fail(`vendor/manifest.json has no entry for ${relativeTarget} - add it with package, licence and source`);
}

const previousPin = entry.sha256;
mkdirSync(target, { recursive: true });
writeFileSync(targetFile, bytes);

// Re-pin the manifest so the new bytes are the pinned bytes.
const repin = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verify-vendor.mjs'), '--update'], {
  stdio: 'inherit',
});
if (repin.status !== 0) fail('re-pinning vendor/manifest.json failed');

const updated = JSON.parse(readFileSync(MANIFEST, 'utf8')).libraries.find(
  (library) => library.file === relativeTarget,
);
console.log(`vendor-sync: wrote vendor/${relativeTarget} (${bytes.length} bytes, jQuery ${declaredVersion})`);
if (previousPin && previousPin !== updated.sha256) {
  console.log(`vendor-sync: the pin changed, which is the point - review it before committing:`);
  console.log(`             was ${previousPin}`);
  console.log(`             now ${updated.sha256}`);
  console.log('             Confirm the new hash against the published jQuery 3.7.1 release.');
} else {
  console.log(`vendor-sync: pin unchanged (${updated.sha256})`);
}
console.log('vendor-sync: commit the vendored file together with the manifest change.');
