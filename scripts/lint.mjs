#!/usr/bin/env node
/**
 * scripts/lint.mjs
 *
 * Dependency-free quality gate for first-party code.
 *
 * Why not ESLint? This repository ships a static site with zero third-party
 * runtime code, and adding a linter that nobody can run offline would trade a
 * real gate for a theoretical one. Everything below is implemented with the
 * Node.js standard library, so `npm ci && npm run lint` works on a fresh clone
 * with no downloads and no install scripts.
 *
 * What it checks:
 *   error  E101 syntax error (node --check)                     .js / .mjs
 *   error  E102 plaintext http:// subresource or redirect      .js / .html
 *   error  E103 innerHTML assignment (DOM XSS sink)             .js / .html
 *   error  E104 eval() / new Function() / document.write()      .js / .html
 *   error  E105 duplicate element id                            .html
 *   warn   W101 protocol-relative subresource                   .html
 *   warn   W102 console.log in shipped browser code             .js
 *   warn   W103 removed jQuery API (.bind/.load/.size)          .js
 *
 * Per-file opt-out for the pattern rules: add `lint:ignore-file` plus a reason
 * on its own line (JS: `// lint:ignore-file - reason`,
 * HTML: `<!-- lint:ignore-file - reason -->`). An ignored file is still
 * syntax-checked; only the pattern rules are skipped.
 *
 * Exit codes: 0 = no errors, 1 = errors found, 2 = usage error.
 */

// lint:ignore-file - this file is the rule table, so it necessarily contains the patterns it looks for
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'coverage', '.jekyll-cache', '_site', 'res', 'img', 'smilies']);
const LINTABLE = new Set(['.js', '.mjs', '.html', '.htm']);

/** @returns {{file: string, abs: string, text: string}[]} */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...collect(abs));
    } else if (entry.isFile() && LINTABLE.has(extname(entry.name).toLowerCase())) {
      out.push({ file: relative(ROOT, abs).split(sep).join('/'), abs, text: readFileSync(abs, 'utf8') });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

const isHtml = (file) => extname(file).toLowerCase() === '.html' || extname(file).toLowerCase() === '.htm';

/** Rules that are one regex + one message, applied per line. */
const LINE_RULES = [
  {
    id: 'E102',
    severity: 'error',
    re: /(?:src|href|action|formaction|poster|data-src)\s*=\s*["']\s*http:\/\/[^"']+/gi,
    only: 'html',
    message: (m) => `plaintext http:// subresource (mixed content / downgradeable): ${m[0].slice(0, 90)}`,
  },
  {
    id: 'E102',
    severity: 'error',
    re: /(?:src|href|action|formaction|poster|data-src)\s*=\s*["']\s*http:\/\/[^"']+/gi,
    only: 'js',
    message: (m) => `plaintext http:// URL in code (interceptable in transit): ${m[0].slice(0, 90)}`,
  },
  {
    id: 'E102',
    severity: 'error',
    re: /(?:window\.)?location(?:\.href)?\s*=\s*["']\s*http:\/\/[^"']+/g,
    only: 'js',
    message: (m) => `redirect to plaintext http:// (open redirect over cleartext): ${m[0].slice(0, 90)}`,
  },
  {
    id: 'E103',
    severity: 'error',
    re: /\.innerHTML\s*(?:\+)?=(?!=)/g,
    only: 'both',
    message: (m) => `innerHTML assignment is a DOM XSS sink, use textContent: ${m[0]}`,
  },
  {
    id: 'E103',
    severity: 'error',
    re: /insertAdjacentHTML\s*\(/g,
    only: 'both',
    message: () => 'insertAdjacentHTML() is a DOM XSS sink, use textContent',
  },
  {
    id: 'E104',
    severity: 'error',
    re: /[^.\w]eval\s*\(|new\s+Function\s*\(|document\.write(?:ln)?\s*\(/g,
    only: 'both',
    message: (m) => `dynamic code execution sink: ${m[0]}`,
  },
  {
    id: 'W101',
    severity: 'warning',
    re: /(?:src|href|action|poster)\s*=\s*["']\/\/[^"']+/g,
    only: 'html',
    message: (m) => `protocol-relative subresource inherits the page scheme: ${m[0].slice(0, 90)}`,
  },
  {
    id: 'W102',
    severity: 'warning',
    re: /console\.(log|debug|info)\s*\(/g,
    only: 'js',
    notUnder: ['scripts/', 'test/'],
    message: (m) => `debug logging shipped to visitors: ${m[0]}`,
  },
  {
    id: 'W103',
    severity: 'warning',
    re: /\.bind\s*\(|\.delegate\s*\(|\.size\s*\(\s*\)(\s*[;),]|$)/g,
    only: 'js',
    message: (m) => `jQuery API removed in 3.x: ${m[0]}`,
  },
];

const errors = [];
const warnings = [];
const add = (severity, file, line, message) =>
  (severity === 'error' ? errors : warnings).push(`${file}:${line}  ${message}`);

const files = collect(ROOT);
let checked = 0;

for (const { file, abs, text } of files) {
  const html = isHtml(file);

  // An opt-out marker must be a whole comment line, so this file's own
  // documentation of the marker does not silence it.
  const ignoreMatch = text.match(/^\s*(?:\/\/|#|<!--|\*)?\s*(lint:ignore-file)\s*[-:]\s*(.+)$/m);
  const skipPatterns = Boolean(ignoreMatch);
  if (skipPatterns) console.log(`  -- ${file}  pattern rules skipped (${ignoreMatch[2].trim()})`);
  checked += 1;

  // E101: authoritative syntax check via the very runtime that CI uses.
  if (!html) {
    const result = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    if (result.status !== 0) {
      const detail = (result.stderr || '').split(/\r?\n/).find((l) => l.trim()) ?? 'syntax error';
      errors.push(`${file}  E101 syntax error: ${detail.trim()}`);
    }
  }

  if (skipPatterns) continue;

  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    const lineNo = index + 1;
    for (const rule of LINE_RULES) {
      if (rule.only === 'html' && !html) continue;
      if (rule.only === 'js' && html) continue;
      if (rule.notUnder?.some((prefix) => file.startsWith(prefix))) continue;
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(lineText)) !== null) {
        add(rule.severity, file, lineNo, `${rule.id} ${rule.message(match)}`);
      }
    }
  });

  // E105: duplicate ids make getElementById() and label/for ambiguous.
  if (html) {
    const seen = new Map();
    const idRe = /\sid\s*=\s*["']([^"']+)["']/g;
    let id;
    while ((id = idRe.exec(text)) !== null) {
      const name = id[1].trim();
      const idLine = text.slice(0, id.index).split(/\r?\n/).length;
      if (seen.has(name)) add('error', file, idLine, `E105 duplicate id "${name}" (first seen on line ${seen.get(name)})`);
      else seen.set(name, idLine);
    }
  }
}

for (const warning of warnings) console.warn(`lint: warn  ${warning}`);
if (errors.length) {
  console.error(`\nlint: FAILED - ${errors.length} error(s)\n`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`lint: ${checked} first-party file(s) checked, 0 errors, ${warnings.length} warning(s)`);
if (!files.some((f) => !f.file.startsWith('vendor/'))) {
  console.error('lint: nothing was checked - refusing to report success on an empty file set');
  process.exit(2);
}
