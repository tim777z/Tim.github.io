/**
 * Tests for scripts/serve.mjs, the local development server.
 *
 * The path resolution is the security-relevant part: it is the only thing
 * standing between a request and the filesystem, so traversal attempts are
 * tested explicitly rather than assumed to be handled.
 */

import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from './harness.mjs';
import { createStaticServer, resolveRequestPath } from '../scripts/serve.mjs';

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
});

test('an absolute-looking path stays inside the document root', () => {
  // Browsers may send a full URL as the request target.
  const result = resolveRequestPath(REPO_ROOT, 'http://evil.example.com/index.html');
  assert.ok(result === null || result.startsWith(REPO_ROOT));
});

test('serves the site over HTTP and rejects traversal', async () => {
  const server = createStaticServer(REPO_ROOT);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
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

    const post = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('refuses traversal on a raw request line', async () => {
  // fetch() normalises `..` out of the URL before it leaves the client, so the
  // interesting cases have to go out over a socket exactly as an attacker would
  // send them.
  const server = createStaticServer(REPO_ROOT);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();

  try {
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
  } finally {
    await new Promise((done) => server.close(done));
  }
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
    socket.on('error', rejectPromise);
  });
}
