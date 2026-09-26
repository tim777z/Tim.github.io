# Contributing

## The short version

One change per pull request. Tests in the same commit as the behaviour they pin.
`npm run verify` green before you push.

```bash
npm ci          # zero runtime dependencies; installs the pinned jQuery source
npm run verify  # lint + secret scan + vendor integrity + tests
npm start       # http://127.0.0.1:8080/
```

Node.js >= 20 (`.nvmrc` pins the version CI uses). No other tooling is needed, and
none should be introduced without a note in the README explaining what it buys.

## Where to put things

- **First-party browser code** belongs next to the page that uses it: `js/` for
  the chat widget, the repo root for the long-standing entry points
  (`timer.js`, `script.js`, `gotourl.js`).
- **Third-party code** belongs in `vendor/`, with an entry in
  `vendor/manifest.json` carrying package, version, licence, source and SHA-256.
  Copy it in with `npm run vendor:sync` where that is possible, then
  `npm run verify:vendor -- --update` to re-pin, and commit the manifest change
  with the file.
- **Tooling** belongs in `scripts/`, written against the Node.js standard library.
- **Tests** belong in `test/`, named `*.test.js`, and are run by `node --test`.
  There is no test framework to configure.

## House style

The site still ships IE shims, so first-party browser code stays ES5-compatible
(`var`, `function` expressions) and uses two-space indentation. See
`.editorconfig`; your editor will do it for you.

Every non-obvious function gets a short comment saying *why*, not *what*. When you
fix a defect, say in the comment which defect, because the next reader needs to
know whether the code is load-bearing or accidental.

## Tests

Write a test with the fix, in the same commit. A pull request that changes
behaviour without changing or adding a test will be asked for one.

The browser code is loaded into a `node:vm` context with a jQuery double and a
fake clock:

```js
import { createElement, createFakeClock, createFakeJQuery, loadScript } from './harness.mjs';

const clock = createFakeClock();
const jQuery = createFakeJQuery();
loadScript('timer.js', {
  jQuery,
  window: { jQuery },
  setInterval: clock.setInterval,
  clearInterval: clock.clearInterval,
});
```

`loadScript` runs the file that ships, not a copy, so a test cannot drift away
from production. Extend the double in `test/harness.mjs` if you need a new jQuery
method; if a first-party script needs a method the double does not have, that is
usually a sign the script is reaching for something it does not need.

A regression test is named after the bug it pins, and the comment says what used
to happen. That is the part a future reader values.

## Before you push

```bash
npm run verify
```

That is exactly what CI runs. If a lint rule fires and the code is genuinely
fine, the rule is wrong or too broad: fix the rule, or scope the file out with a
`lint:ignore-file` comment that gives a reason. Do not delete a rule to make a
build green.

## Dependencies

The project has one dev dependency, jQuery, which exists so the vendored copy can
be reproduced from a lockfile-verified download. Adding a runtime dependency to a
static site is almost always the wrong answer. If you add one:

- pin it exactly (`--save-exact`), commit `package-lock.json`, and
- make sure `npm audit --audit-level=high` still passes.

## Commits and pull requests

- One logical change per commit; keep the history readable rather than tidy.
- Say what was broken and what now happens, in the message body.
- Reference the issue the change closes.
- A pull request description should let a reviewer check the change without
  running it: what changed, why, and how it was verified.
