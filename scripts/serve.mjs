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
 *   - writes one structured JSON line per request and per failure, so a blank
 *     page and a refused request are never the same mystery again
 *
 * Observability: every request is logged as {event:"request", method, target,
 * status, bytes, durationMs}; refusals are logged with the reason; stream and
 * socket errors are logged with their errno code instead of being swallowed.
 * See scripts/log.mjs for the format and for why logging cannot throw.
 *
 * Usage: npm start [-- --port 8080] [-- --host 0.0.0.0]
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createLogger, silentLogger } from './log.mjs';

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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Body text per status, so a curl in a terminal says something useful. */
const STATUS_TEXT = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
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

/** Never log a full filesystem path: it is the visitor's home directory. */
function repoRelative(root, file) {
  const rel = relative(root, file);
  return (rel && !rel.startsWith('..') ? rel : file).split(sep).join('/');
}

/**
 * Create the development server.
 *
 * `logger` and `openStream` are injectable so the tests can observe the
 * observability and drive a read failure, which is otherwise impossible to
 * produce deterministically. Both default to the real implementations.
 *
 * @param {string} [root] document root
 * @param {Object} [options]
 * @param {{debug: Function, info: Function, warn: Function, error: Function}} [options.logger]
 * @param {(path: string) => NodeJS.ReadableStream} [options.openStream]
 * @returns {import('node:http').Server}
 */
export function createStaticServer(root = ROOT, options = {}) {
  const logger = options.logger ?? silentLogger;
  const openStream = options.openStream ?? createReadStream;

  // Counters exist so a shutdown summary can answer "did anything go wrong"
  // without anybody having to remember to grep the log.
  const metrics = { requests: 0, served: 0, refused: 0, errors: 0, bytes: 0 };

  const server = createServer((req, res) => {
    metrics.requests += 1;
    const startedAt = process.hrtime.bigint();
    const method = req.method ?? 'GET';
    const target = req.url ?? '/';
    /** Set once a file is accepted for serving; 0 for every other outcome. */
    let contentLength = 0;

    res.on('finish', () => {
      logger.info('request', {
        method,
        target,
        status: res.statusCode,
        bytes: contentLength,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1000000n),
      });
    });

    /**
     * Refuse a request, and say why in the log rather than in the dark.
     * @param {number} status @param {string} reason @param {string} [detail]
     */
    function refuse(status, reason, detail) {
      metrics.refused += 1;
      logger.warn('request_refused', { reason, status, method, target, ...(detail ? { detail } : {}) });
      res
        .writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
        .end(STATUS_TEXT[status] ?? 'Error');
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      refuse(405, 'method_not_allowed', method);
      return;
    }

    const targetPath = resolveRequestPath(root, target);
    if (!targetPath) {
      refuse(403, 'path_outside_document_root', target);
      return;
    }

    let file = targetPath;
    let size;
    try {
      size = statSync(file);
      if (size.isDirectory()) {
        file = join(file, 'index.html');
        size = statSync(file);
      }
    } catch {
      file = null;
    }

    if (!file) {
      refuse(404, 'not_found', repoRelative(root, targetPath));
      return;
    }
    if (!size.isFile()) {
      refuse(403, 'not_a_regular_file', repoRelative(root, file));
      return;
    }

    metrics.served += 1;
    metrics.bytes += size.size;
    contentLength = size.size;

    const logStreamError = (err) => {
      metrics.errors += 1;
      logger.error('stream_error', {
        path: repoRelative(root, file),
        method,
        code: err && err.code ? err.code : null,
        message: err && err.message ? err.message : String(err),
      });
      // If the response has not started, the request can still be failed
      // honestly with a 500. If it has started, the status line is already on
      // the wire and truncating the body is the only thing left to do - either
      // way the visitor gets a broken response, never a silently short one.
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(STATUS_TEXT[500]);
        return;
      }
      res.destroy();
    };

    const headers = {
      'content-type': contentType(file),
      'content-length': contentLength,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };

    if (method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }

    let stream;
    try {
      stream = openStream(file);
    } catch (err) {
      // A synchronous throw (an unreadable path, an fd limit) is as much a
      // server failure as a stream 'error' event, and used to escape here.
      logStreamError(err);
      return;
    }

    stream.on('error', logStreamError);
    res.on('error', (err) => {
      metrics.errors += 1;
      logger.warn('response_error', { method, target, code: err && err.code ? err.code : null });
    });
    res.writeHead(200, headers);
    stream.pipe(res);
  });

  // A malformed request line never reaches the request handler, so without this
  // it is the one failure mode that would still vanish without a trace.
  server.on('clientError', (err, socket) => {
    metrics.errors += 1;
    logger.warn('client_error', { code: err && err.code ? err.code : null, message: err && err.message });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  /** Counters for the shutdown summary; a snapshot, not live state. */
  server.metrics = () => ({ ...metrics });
  /** Document root this instance was created with. */
  server.root = root;
  return server;
}

// Only listen when invoked directly, so the tests can import this module.
if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) {
  const args = process.argv.slice(2);
  const portFlag = args.indexOf('--port');
  const hostFlag = args.indexOf('--host');
  const port = portFlag === -1 ? 8080 : Number(args[portFlag + 1]);
  const host = hostFlag === -1 ? '127.0.0.1' : args[hostFlag + 1];
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
  const server = createStaticServer(ROOT, { logger });

  const shutdown = (signal) => {
    logger.info('server_stop', { signal, ...server.metrics() });
    server.close(() => process.exit(0));
    // Do not hang forever on a keep-alive connection a browser is holding open.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.on('error', (err) => {
    logger.error('server_error', { message: err.message, code: err.code ?? null });
    process.exit(1);
  });

  server.listen(port, host, () => {
    logger.info('server_start', { url: `http://${host}:${port}/`, documentRoot: ROOT });
  });
}