/**
 * Tests for scripts/serve.mjs, the local development server.
 *
 * The path resolution is the security-relevant part: it is the only thing
 * standing between a request and the filesystem, so traversal attempts are
 * tested explicitly rather than assumed to be handled.
 *
 * The observability half is tested the same way. A server that fails silently
 * cannot be told apart from a server that is working, so every refusal and
 * every failure has to leave a structured trace - these tests pin that.
 */

import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { REPO_ROOT } from './harness.mjs';
import { createLogger } from '../scripts/log.mjs';
import { createStaticServer, resolveRequestPath } from '../scripts/serve.mjs';

/** Collects the server's structured log lines for assertions. */
function createLogCapture() {
  const writes = [];
  const sink = { write: (chunk) => writes.push(chunk) };
  const logger = createLogger({ stdout: sink, stderr: sink, level: 'debug' });
  logger.records = () => writes.map((line) => JSON.parse(line));
  logger.events = () => logger.records().map((record) => record.event);
  return logger;
}

/** Listen on an ephemeral port, hand the port to `body`, always close. */
async function withServer(server, body) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    return await body(server.address().port);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

test('resolves a normal request to a file inside the document root', () => {
  assert.equal(resolveRequestPath(REPO_ROOT, '/index.html'), join(REPO_ROOT, 'index.html'));
  assert.equal(resolveRequestPath(REPO_ROOT, '/vendor/manifest.json'), join(REPO_ROOT, 'vendor', 'manifest.json'));
  assert.equal(resolveRequestPath(REPO_ROOT, '/'), REPO_ROOT);
});

test('ignores query strings, fragments and redundant separators', () => {
  const expected = join(REPO_ROOT, 'index.html');
  assert.equal(resolveRequestPath(REPO_ROOT, '/index.html?utm_source=x'), expected);
  assert.equal(resolveRequestPath(REPO_ROOT, '/index.html#chat'), expected);
  assert.equal(resolveRequestPath(REPO_ROOT, '//index.html'), expected);
  assert.equal(resolveRequestPath(REPO_ROOT, '/./index.html'), expected);
});

test('refuses path traversal', () => {
  for (const attack of [
    '/../package.json',
    '/../../../../../../etc/passwd',
    '/..%2f..%2fpackage.json',
    '/..\\..\\package.json',
    '/./../package.json',
    '/vendor/../../package.json',
  ]) {
    const result = resolveRequestPath(REPO_ROOT, attack);
    assert.ok(
      result === null || result.startsWith(REPO_ROOT),
      `traversal escaped the document root: ${attack} -> ${result}`,
    );
    assert.equal(result, null, `expected an outright rejection for ${attack}`);
  }
});

test('refuses NUL bytes and empty paths', () => {
  assert.equal(resolveRequestPath(REPO_ROOT, '/index.html\0.png'), null);
  assert.equal(resolveRequestPath(REPO_ROOT, ''), null);
  assert.equal(resolveRequestPath(REPO_ROOT, undefined), null);
  // Malformed percent-encoding never decodes, so it can never be a real file.
  assert.equal(resolveRequestPath(REPO_ROOT, '/%zz.html'), null);
  assert.equal(resolveRequestPath(REPO_ROOT, '/img/%'), null);
});

test('an absolute-looking path stays inside the document root', () => {
  // Browsers may send a full URL as the request target.
  const result = resolveRequestPath(REPO_ROOT, 'http://evil.example.com/index.html');
  assert.ok(result === null || result.startsWith(REPO_ROOT));
});

test('serves the site over HTTP and rejects traversal', async () => {
  const server = createStaticServer(REPO_ROOT);
  await withServer(server, async (port) => {
    const base = `http://127.0.0.1:${port}`;

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(index.headers.get('x-content-type-options') ?? '', /nosniff/);
    assert.match(await index.text(), /<!DOCTYPE html>/i);

    const manifest = await fetch(`${base}/vendor/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') ?? '', /application\/json/);

    const missing = await fetch(`${base}/definitely-not-here.html`);
    assert.equal(missing.status, 404);

    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('allow'), null, 'a served request advertises nothing');

    const post = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});

test('refuses traversal on a raw request line', async () => {
  // fetch() normalises `..` out of the URL before it leaves the client, so the
  // interesting cases have to go out over a socket exactly as an attacker would
  // send them.
  const server = createStaticServer(REPO_ROOT);

  await withServer(server, async (port) => {
    for (const target of [
      '/../package.json',
      '/../../../../etc/passwd',
      '/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/..\\..\\package.json',
      '/vendor/../../package.json',
    ]) {
      const response = await rawRequest(port, target);
      const status = Number(response.split(' ')[1]);
      assert.ok(status >= 400, `${target} was served with ${status}`);
      assert.ok(
        !response.includes('"name": "tim-precog-site"'),
        `${target} leaked a file from outside the document root`,
      );
    }
  });
});

/* ---------------------------------------------------------------------------
 * Observability: every outcome leaves a structured trace.
 * ------------------------------------------------------------------------- */

test('logs one structured record per request', async () => {
  const logger = createLogCapture();
  const server = createStaticServer(REPO_ROOT, { logger });

  await withServer(server, async (port) => {
    await fetch(`http://127.0.0.1:${port}/index.html`);
    await fetch(`http://127.0.0.1:${port}/nope.html`);
    await fetch(`http://127.0.0.1:${port}/`, { method: 'DELETE' });
    await new Promise((done) => setTimeout(done, 25)); // let the responses flush
  });

  const records = logger.records();
  const served = records.find((r) => r.event === 'request' && r.status === 200);
  assert.ok(served, `no access record for the served request:\n${JSON.stringify(records)}`);
  assert.equal(served.method, 'GET');
  assert.equal(served.target, '/index.html');
  assert.ok(served.bytes > 0, 'the access record carries the response size');
  assert.equal(typeof served.durationMs, 'number');

  const refused = records.filter((r) => r.event === 'request_refused');
  assert.deepEqual(
    refused.map((r) => r.reason).sort(),
    ['method_not_allowed', 'not_found'],
    'each refusal states why it happened',
  );
  assert.ok(refused.every((r) => r.status >= 400 && r.target));
});

test('a refused traversal is logged as a refusal, not as a 404', async () => {
  const logger = createLogCapture();
  const server = createStaticServer(REPO_ROOT, { logger });

  await withServer(server, async (port) => {
    const response = await rawRequest(port, '/../../../../etc/passwd');
    assert.equal(Number(response.split(' ')[1]), 403);
  });

  const refusal = logger.records().find((r) => r.event === 'request_refused');
  assert.ok(refusal, 'the refusal must be visible in the log');
  assert.equal(refusal.reason, 'path_outside_document_root');
  assert.equal(refusal.status, 403);
  assert.equal(server.metrics().refused, 1);
});

test('a read failure is logged with its errno code instead of vanishing', async () => {
  const logger = createLogCapture();
  // A stream that fails the way a permission or I/O error really does: the
  // response has already started, so the only thing left to do is truncate it -
  // and say so.
  const openStream = () => {
    const stream = new Readable({ read() {} });
    setImmediate(() => stream.destroy(Object.assign(new Error('permission denied'), { code: 'EACCES' })));
    return stream;
  };
  const server = createStaticServer(REPO_ROOT, { logger, openStream });

  await withServer(server, async (port) => {
    // The connection is cut mid-body: fetch must fail rather than hang or
    // quietly hand back a truncated page.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/index.html`));
    await new Promise((done) => setTimeout(done, 25));
  });

  const record = logger.records().find((r) => r.event === 'stream_error');
  assert.ok(record, 'a stream error must leave a record');
  assert.equal(record.code, 'EACCES');
  assert.equal(record.path, 'index.html', 'the log records a repo-relative path, not a home directory');
  assert.equal(server.metrics().errors, 1);
});

test('a synchronous open failure is handled like a stream error', async () => {
  const logger = createLogCapture();
  const server = createStaticServer(REPO_ROOT, {
    logger,
    openStream: () => {
      throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
    },
  });

  await withServer(server, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(response.status, 500);
  });

  const record = logger.records().find((r) => r.event === 'stream_error');
  assert.ok(record, 'a synchronous throw must be reported like a stream error');
  assert.equal(record.code, 'EMFILE');
});

test('a malformed request line is logged instead of silently dropped', async () => {
  const logger = createLogCapture();
  const server = createStaticServer(REPO_ROOT, { logger });

  await withServer(server, async (port) => {
    const response = await rawRequest(port, '/index.html bad');
    await new Promise((done) => setTimeout(done, 25));
    assert.ok(response.length === 0 || Number(response.split(' ')[1]) >= 400);
  });

  // A malformed target is either rejected by the HTTP parser (clientError) or
  // refused by resolveRequestPath (request_refused). Either is acceptable;
  // silence is not.
  const events = logger.events();
  assert.ok(
    events.includes('client_error') || events.includes('request_refused'),
    `expected a logged failure, saw: ${events.join(', ')}`,
  );
});

test('counters summarise the run for the shutdown log', async () => {
  const server = createStaticServer(REPO_ROOT, { logger: createLogCapture() });
  let size = 0;

  assert.deepEqual(server.metrics(), { requests: 0, served: 0, refused: 0, errors: 0, bytes: 0 });
  assert.equal(server.root, REPO_ROOT);

  await withServer(server, async (port) => {
    const index = await fetch(`http://127.0.0.1:${port}/index.html`);
    size = Number(index.headers.get('content-length'));
    await index.arrayBuffer();
    await fetch(`http://127.0.0.1:${port}/missing.html`);
  });

  assert.deepEqual(server.metrics(), {
    requests: 2,
    served: 1,
    refused: 1,
    errors: 0,
    bytes: size,
  });
});

/** Send a request line verbatim, with no client-side URL normalisation. */
function rawRequest(port, target) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => resolvePromise(response));
    socket.on('error', () => resolvePromise(response));
  });
}
