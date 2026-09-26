#!/usr/bin/env node
/**
 * scripts/serve.mjs - static file server for local development.
 *
 * GitHub Pages serves this repository as static files, so local development
 * needs nothing more than a file server. Rather than telling every contributor
 * to `npx serve` (a download, and an unpinned version of someone else's code),
 * this is a ~100 line server built on the Node.js standard library.
 *
 * It is deliberately small and deliberately boring:
 *   - binds to 127.0.0.1 by default, so it is not exposed to the network
 *   - resolves and then *verifies* every path stays inside the document root,
 *     so `..%2f..%2fetc/passwd` cannot escape
 *   - serves index.html for directories, never a directory listing
 *   - correct content types and no caching during development
 *
 * Usage: npm start [-- --port 8080] [-- --host 0.0.0.0]
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.amr': 'audio/amr',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Map a request path to a file inside `root`, or null if it escapes.
 *
 * The path is percent-decoded *before* it is validated, because the interesting
 * attacks are encoded: `..%2f..%2f`, `%2e%2e%2f`. Decoding first and then
 * rejecting any `..` segment, any backslash traversal, any NUL byte and anything
 * that normalises outside the root closes all of them at once.
 *
 * @param {string} root absolute document root
 * @param {string} requestPath raw request target, e.g. '/img/a%20b.png?v=2'
 * @returns {?string} absolute path inside root, or null
 */
export function resolveRequestPath(root, requestPath) {
  if (typeof requestPath !== 'string' || requestPath === '') return null;
  if (requestPath.includes('\0')) return null;

  // Split off query/fragment defensively; the HTTP parser usually does this.
  const pathOnly = requestPath.split(/[?#]/, 1)[0];

  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null; // malformed percent-encoding is never a legitimate request
  }
  if (decoded.includes('\0')) return null;

  const segments = decoded.split(/[/\\]+/);
  const safe = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null; // no traversal, no guessing
    safe.push(segment);
  }

  const absolute = resolve(root, ...safe);
  const boundary = root.endsWith(sep) ? root : root + sep;
  if (absolute !== root && !absolute.startsWith(boundary)) return null;
  return absolute;
}

function contentType(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function createStaticServer(root = ROOT) {
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end('Method Not Allowed');
      return;
    }

    const target = resolveRequestPath(root, req.url ?? '/');
    if (!target) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }

    let file = target;
    try {
      const stat = statSync(file);
      if (stat.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = null;
    }

    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }

    let size;
    try {
      size = statSync(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    if (!size.isFile()) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }

    res.writeHead(200, {
      'content-type': contentType(file),
      'content-length': size.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

// Only listen when invoked directly, so the tests can import this module.
if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) {
  const args = process.argv.slice(2);
  const portFlag = args.indexOf('--port');
  const hostFlag = args.indexOf('--host');
  const port = portFlag === -1 ? 8080 : Number(args[portFlag + 1]);
  const host = hostFlag === -1 ? '127.0.0.1' : args[hostFlag + 1];

  createStaticServer(ROOT).listen(port, host, () => {
    console.log(`precog site: http://${host}:${port}/  (document root ${ROOT})`);
    console.log('press ctrl+c to stop');
  });
}
