#!/usr/bin/env node
/**
 * scripts/check-secrets.mjs
 *
 * Fails the build when a credential is committed to the repository.
 *
 * Why this exists on a static site: the site loads third-party SDKs (Facebook,
 * Google Maps/CSE) and historically carried a hardcoded key plus a 540 kB
 * unreferenced vendor bundle that tripped every secret scanner. Secrets must be
 * caught by the pipeline, not by a customer's audit six months later.
 *
 * Design notes:
 *  - Binary and vendored code is skipped; vendored code is covered by the
 *    sha256 pins in vendor/manifest.json instead.
 *  - Anything that is a genuine, publicly-exposed, referrer-restricted browser
 *    credential must be declared in scripts/secret-scan-allowlist.json with a
 *    reason. Allowlisted hits are still printed, as warnings, so they never
 *    disappear silently.
 *
 * Exit codes: 0 = clean, 1 = finding, 2 = usage error.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = join(ROOT, 'scripts', 'secret-scan-allowlist.json');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'coverage', '.jekyll-cache', '_site']);
/** The allowlist holds the very patterns it documents, so it cannot scan itself. */
const SELF_REFERENTIAL = new Set(['scripts/secret-scan-allowlist.json']);
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.html', '.htm', '.css', '.md', '.yml', '.yaml',
  '.txt', '.xml', '.sh', '.pl', '.csv', '.svg',
]);
/** Extensions that must never be committed, whatever they contain. */
const FORBIDDEN_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.asc', '.gpg', '.ppk', '.kdbx', '.ovpn',
]);

const RULES = [
  { id: 'private-key', severity: 'critical', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { id: 'aws-access-key-id', severity: 'critical', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', severity: 'critical', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat', severity: 'critical', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'npm-token', severity: 'critical', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'slack-token', severity: 'critical', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-secret-key', severity: 'critical', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'twilio-key', severity: 'critical', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { id: 'sendgrid-key', severity: 'critical', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google-api-key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'firebase-url', severity: 'high', re: /https:\/\/[a-z0-9-]+\.firebaseio\.com/g },
  { id: 'json-web-token', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'basic-auth-url', severity: 'high', re: /\bhttps?:\/\/[^\/\s:@]+:[^\/\s:@]+@/g },
  {
    id: 'assigned-credential',
    severity: 'high',
    re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|pwd)\b\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  },
];

/** @returns {string[]} repo-relative POSIX paths of scannable text files */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(abs));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(relative(ROOT, abs).split(sep).join('/'));
    }
  }
  return out.sort();
}

let allowlist;
try {
  allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
} catch (err) {
  console.error(`check-secrets: cannot read scripts/secret-scan-allowlist.json: ${err.message}`);
  process.exit(2);
}

const findings = [];
const warnings = [];
const skipped = [];

for (const file of collectFiles(ROOT)) {
  if (SELF_REFERENTIAL.has(file)) {
    skipped.push(file);
    continue;
  }
  if (FORBIDDEN_EXTENSIONS.has(extname(file).toLowerCase())) {
    findings.push({ file, line: 0, rule: 'forbidden-file-type', detail: 'credential/key material must not be committed' });
    continue;
  }

  const text = readFileSync(join(ROOT, ...file.split('/')), 'utf8');
  const lines = text.split(/\r?\n/);
  const exemptions = allowlist.entries?.[file] ?? [];

  lines.forEach((lineText, index) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(lineText)) !== null) {
        const excerpt = match[0].length > 24 ? `${match[0].slice(0, 24)}...` : match[0];
        const hit = {
          file,
          line: index + 1,
          rule: rule.id,
          severity: rule.severity,
          detail: excerpt,
        };
        const exemption = exemptions.find((e) => e.rule === rule.id && (!e.pattern || lineText.includes(e.pattern)));
        if (exemption) {
          warnings.push({ ...hit, reason: exemption.reason });
        } else {
          findings.push(hit);
        }
      }
    }
  });
}

for (const warning of warnings) {
  console.warn(`check-secrets: ALLOWED  ${warning.file}:${warning.line}  ${warning.rule}  (${warning.reason})`);
}

if (findings.length) {
  console.error(`\ncheck-secrets: FAILED - ${findings.length} potential secret(s)\n`);
  for (const f of findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))) {
    console.error(`  ${f.severity.padEnd(8)} ${f.file}:${f.line}  ${f.rule}  ${f.detail}`);
  }
  console.error('\nIf a finding is a false positive, declare it in scripts/secret-scan-allowlist.json with a reason.');
  console.error('If it is real: revoke the credential first, then remove it from the code and the git history.');
  process.exit(1);
}

console.log(
  `check-secrets: clean - no credentials found in first-party files` +
    (warnings.length ? ` (${warnings.length} documented, allowlisted credential(s))` : '') +
    (skipped.length ? ` (${skipped.length} self-referential file(s) skipped)` : ''),
);
