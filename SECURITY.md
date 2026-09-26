# Security

## The threat model, in one paragraph

This is a static site. There is no application server, no database, no session,
no authentication and no authorisation code to get wrong, because none of it
exists: GitHub Pages serves files from a CDN. The realistic risks are therefore
(a) a secret committed to the repository, (b) a vulnerable or swapped third-party
script, (c) a browser-side flaw in the first-party JavaScript, and (d) content or
flows that mislead visitors. Everything below addresses one of those four.

## Current posture

| Area | State |
| --- | --- |
| Secrets in the repository | One, and it is a public browser API key. See the inventory below. |
| Third-party code | Pinned in `vendor/manifest.json` with SHA-256, verified on every push. |
| jQuery | 3.7.1 (was 1.7.2 from 2011). |
| Plaintext transport | None in first-party code. `npm run lint` fails the build if any returns. |
| DOM XSS sinks | None. All dynamic text is written with `.text()` / `textContent`. |
| Redirects | One, and it is https-only with a parameter allowlist and per-parameter validation. |
| Location data | Requested only after an explicit click, never on page load. |
| CI | Least-privilege permissions, no credential persistence, six gates. |

## Public credential inventory

| What | Where | Why it is public | Required restriction |
| --- | --- | --- | --- |
| Google Maps JavaScript API key `AIzaSyC4O0Iet5tltzWO8zjwKmOgo1pgvRKMmKM` | `index.html`, in the `data-maps-key` attribute of the map button | Google browser API keys are delivered to every visitor by design; the security boundary is *restriction*, not secrecy | HTTP referrer allowlist limited to the site's own hosts, and the Maps JavaScript API only. No " unrestricted key. |

That key was previously loaded on every page view, on an https page, via a
`https://maps.googleapis.com/...&signed_in=true` URL. It is now requested only
when a visitor clicks the map button, and the script refuses any Maps endpoint
that is not `https://maps.googleapis.com/`.

**To rotate it:** create a new key in the Google Cloud console, restrict it as
above, update `data-maps-key` in `index.html`, and update the two allowlist
entries in `scripts/secret-scan-allowlist.json` plus this table.

## Nothing else belongs here

- Do not add a `.env` file. It is in `.gitignore`, and `npm run check:secrets`
  fails the build if a key, certificate or keystore file is committed.
- Do not add a server-side secret to a static site. If a feature needs a
  credential, it needs a server that holds it, and that server needs its own
  review.
- `scripts/secret-scan-allowlist.json` is the only place a finding may be
  waved through, and every entry needs a reason. Entries are printed on every run
  as warnings, so an allowlisted credential is never invisible.

## What the pipeline enforces

`npm run verify` — and every CI run — fails on:

1. a syntax error in any first-party script;
2. a plaintext `http://` subresource, redirect or URL literal in first-party code;
3. an `innerHTML`, `insertAdjacentHTML`, `eval`, `new Function` or
   `document.write` in first-party code;
4. a duplicate element `id` in any page;
5. a credential pattern in a first-party file that is not declared in the
   allowlist;
6. a vendored file whose SHA-256 does not match `vendor/manifest.json`, a
   vendored file with no manifest entry, or a manifest entry with no provenance;
7. a failing test, including the regression tests for the bugs listed below;
8. a dependency advisory at high or critical (`npm audit --audit-level=high`).

## Content-Security-Policy

GitHub Pages cannot set response headers, so `index.html` carries the three
directives that are safe to set from a `<meta>` tag and cannot break rendering:

```
object-src 'none'; base-uri 'self'; form-action 'self'
```

If this site is ever fronted by something that can set headers (Cloudflare Pages,
Netlify, Fastly, a reverse proxy), add the full policy. The page needs, at
minimum:

```
default-src 'self';
script-src 'self' 'unsafe-inline' https://connect.facebook.net https://cse.google.com https://maps.googleapis.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: https:;
frame-src https://www.facebook.com https://cse.google.com;
connect-src 'self' https://*.googleapis.com https://*.facebook.net;
object-src 'none'; base-uri 'self'; form-action 'self'
```

Ship it as `Content-Security-Policy-Report-Only` first, read the violations, then
enforce. Note that `'unsafe-inline'` is still required for `script-src` until the
four inline `<script>` blocks in `index.html` are moved into files under `js/`;
that refactor is the prerequisite for a policy without it, and it is the natural
next piece of work on this page.

## Fixed in this pass

Recorded because they were live, not because they are interesting:

- **Personal data forwarded over plaintext HTTP.** `gotourl.js` copied
  `msisdn`, `fname`, `oid`, `poid` and `s1` from the query string into a
  `http://trckingnow.com/click` link with no encoding and no validation. Now:
  https only, an allowlist of six parameters, a per-parameter character and
  length validator, and `encodeURIComponent` on output.
- **End-of-life jQuery.** 1.7.2 (2011) and 1.8.3 were on the page, both with
  known cross-site scripting issues. Replaced with 3.7.1, pinned and checksummed.
- **DOM XSS sinks.** Three `innerHTML` assignments in `index.html` wrote
  third-party and geolocation data into the page. All now `textContent`.
- **Location requested without consent.** The page called
  `navigator.geolocation.getCurrentPosition()` on load. Now behind a button.
- **The visitor could not leave.** `stay.js` trapped the back button by rewriting
  history state, and played an "alert" sound fetched from a third-party bucket
  named after Facebook's verification domain. Removed.
- **A forced off-site redirect.** Dismissing the prize dialog in `script.js`
  cleared `onbeforeunload` and navigated to a hardcoded external address. Removed.
- **A script tag pointing at a file that was never committed.** `index.html`
  loaded `js/jquery.min.js`; the real jQuery loaded further down. One jQuery now,
  from `vendor/`, and a test asserts it.
- **45 broken audio elements with duplicate ids**, all `preload="auto"`, so the
  browser began downloading media nobody had asked to play. Removed; the four
   working clips are `preload="none"`.
- **A chat bot that could not answer half its own questions.** The input was
  lower-cased but half the keywords were upper-case, so those rules were
  unreachable; and `respondTo(null)` threw. Both fixed, both pinned by tests.

## Known, accepted and documented

- `script.js` is not referenced by any page in this repository. It is retained
  because the offer page is deployed separately, and it is still linted and
  syntax-checked.
- `www/` is an Apache Cordova wrapper. `www/cordova.js` is absent by design: the
  Cordova CLI injects it at build time. The asset test declares this explicitly.
- `Precog.html` is a LibreOffice export. It is generated, not hand-maintained;
  only its `http://` Dublin Core metadata links were changed to `https://`.
- The Facebook embed requests `public_profile` only. The previous version also
  requested `email` and then called `FB.api('/me')`, which needed an access token
  and pulled the visitor's profile into the page for no benefit.
- GitHub Actions are referenced by major version tag (`actions/checkout@v4`).
  Pinning them to a commit SHA is the correct next step and needs a network
  lookup to do safely; it is not done here rather than done with a guess.

## Reporting a vulnerability

Open a GitHub issue for anything that is not yet fixed, or email the address in
the site footer. For something exploitable today, please report it privately
first and give the maintainer a reasonable window to ship a fix before it becomes
public.
