# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/) in the loose sense that matters here:
the shipped site is versioned with the commit, so "breaking" means "a visitor
sees something different or a caller has to change".

The entries below record *why* a change was made, not just what changed - a
reader deciding whether to roll something back needs the reason more than the
diff.

## [Unreleased]

### Added

- **Enforced coverage floor.** `npm run test:coverage`
  ([`scripts/coverage-gate.mjs`](scripts/coverage-gate.mjs)) runs the suite with
  V8 coverage and fails below 90% lines. It is part of `npm run verify`, so it
  gates every pull request. `test/harness.mjs` now executes the browser scripts
  by absolute path, which is what makes `timer.js`, `js/chat-bot.js` and
  `js/index.js` count towards that number.
- **Tests for the chat widget** (`test/chat-widget.test.js`) - `js/index.js` was
  the one first-party file with no coverage. The regression it pins: visitor
  input is rendered with `.text()`, never `.html()`.
- **Tests for the logger and the test doubles** (`test/log.test.js`,
  additions to `test/harness.test.js`).
- **CodeQL** over the first-party JavaScript, on every push and pull request and
  weekly ([`.github/workflows/codeql.yml`](.github/workflows/codeql.yml)).
- **Dependabot** for npm and GitHub Actions, weekly
  ([`.github/dependabot.yml`](.github/dependabot.yml)).
- **Structured logging** for the development server
  ([`scripts/log.mjs`](scripts/log.mjs)): one JSON object per line for every
  request, refusal, stream failure and malformed request line, plus counters in
  the shutdown record. `LOG_LEVEL` selects the verbosity.

### Changed

- **GitHub Actions are pinned to commit SHAs.** A tag can move; a SHA cannot.
  Both workflows record the release each SHA corresponds to.
- **`.npmrc` sets `ignore-scripts=true`.** The one dev dependency ships no
  install scripts, so refusing to run them costs nothing and makes the supply
  chain claim in the README enforceable rather than aspirational.
- **Lint reads stylesheets.** `url(http://...)` and `@import` over plaintext are
  now errors, in `.css` as well as in HTML and JavaScript.
- `npm run verify` runs the coverage gate instead of a bare `npm test`, so local
  and CI runs are the same command.

### Fixed

- **Plaintext third-party image in `style2.css`.** The Facebook social-plugin
  chrome was loaded from a dead `http://` Rackspace CDN: mixed content on the
  https page, and a third-party fetch from the visitor's browser. Removed.
- **The development server failed silently.** A read error called
  `res.destroy()` and logged nothing; a synchronous throw from opening the file
  escaped the handler entirely. Both are now logged with their errno code, and a
  failure before the response starts returns a 500 instead of a truncated 200.
- **Malformed request lines vanished.** Node rejects them before the request
  handler runs, so they were the one failure the server could not report; a
  `clientError` handler now does.
- **A `console.log` shipped to visitors** in the Cordova wrapper's starter code.

## [1.0.0] - 2026-09-13

The hardening pass described in [`SECURITY.md`](SECURITY.md): plaintext personal
data in the tracking redirect replaced with an https-only, allowlisted, encoded
builder; end-of-life jQuery replaced with a pinned, checksummed 3.7.1; DOM XSS
sinks removed; location data moved behind an explicit click; the back-button trap
and a forced off-site redirect removed; and a dependency-free quality gate
(lint, secret scan, vendor integrity, tests) enforced in CI.

## [0.x]

Before that: the site as originally published, plus the vendored libraries and
the Cordova wrapper under `www/`.