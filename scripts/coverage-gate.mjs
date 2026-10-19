#!/usr/bin/env node
/**
 * scripts/coverage-gate.mjs - runs the test suite with V8 coverage and fails
 * the build if line coverage drops below the floor.
 *
 * Why a coverage gate rather than a coverage report: a number nobody acts on is
 * decoration. The number only has value if a regression *fails* something, and
 * the only way that is true for everyone is if the gate lives in `npm run
 * verify` and therefore in CI, on every push.
 *
 * Why it is not a coverage *tool*: the rest of this repository's quality gate is
 * standard library only, so a fresh clone runs it with no downloads and no
 * install scripts. `node --test --experimental-test-coverage` gives the same
 * number for free. The trade-off is that this gate measures line coverage, not
 * branch coverage, and only what the test run actually loads - the browser
 * scripts count because test/harness.mjs executes them by absolute path.
 *
 * Rules:
 *   - an unparseable or empty coverage report is a FAILURE, never a pass. A
 *     gate that reports success when it measured nothing is worse than no gate,
 *     because it is believed.
 *   - the floor is the floor: `--min-lines=NN` or COVERAGE_MIN_LINES.
 *
 * Exit codes: 0 = at or above the floor, 1 = below the floor or tests failed,
 *             2 = usage or parse error.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The floor. 90% is chosen because the suite genuinely sits above it: this is
 * a floor to stop a regression, not an aspiration to be re-negotiated each
 * week. Lower it deliberately, in a commit, with a reason.
 */
const DEFAULT_MIN_LINES = 90;

const flag = process.argv.find((arg) => arg.startsWith('--min-lines='));
const requested = flag ? flag.slice('--min-lines='.length) : process.env.COVERAGE_MIN_LINES;
const minLines = requested === undefined ? DEFAULT_MIN_LINES : Number(requested);

if (!Number.isFinite(minLines) || minLines < 0 || minLines > 100) {
  console.error(`coverage-gate: --min-lines must be a number between 0 and 100, got "${requested}"`);
  process.exit(2);
}

const child = spawnSync(process.execPath, ['--test', '--experimental-test-coverage'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
});

const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
process.stdout.write(output);

if (child.error) {
  console.error(`coverage-gate: could not start the test runner: ${child.error.message}`);
  process.exit(2);
}

if (child.status !== 0) {
  console.error(`coverage-gate: FAILED - the test suite did not pass (exit ${child.status})`);
  process.exit(1);
}

/**
 * The runner prints a summary row:
 *   `all files  |  95.37 |    86.00 |   92.59 |`
 * matching `all files` keeps this independent of the box-drawing characters
 * and of the column set, which has changed between Node.js releases.
 */
const summary = output.match(/all files\s*\|\s*([0-9]+(?:\.[0-9]+)?)/);

if (!summary) {
  console.error(
    'coverage-gate: FAILED - no coverage summary in the test runner output.\n' +
      'A gate that reports success when it measured nothing is worse than no gate.',
  );
  process.exit(2);
}

const lineCoverage = Number(summary[1]);
const ok = lineCoverage >= minLines;

console.log(
  `coverage-gate: ${ok ? 'PASS' : 'FAIL'} - line coverage ${lineCoverage.toFixed(2)}% ` +
    `(floor ${minLines}%) over the first-party sources the suite loads`,
);

if (!ok) {
  console.error(
    '\ncoverage-gate: FAILED - add a test that pins the new behaviour, or lower the floor ' +
      'deliberately with --min-lines and a reason.',
  );
  process.exit(1);
}