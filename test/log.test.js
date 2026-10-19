/**
 * Tests for scripts/log.mjs, the development server's structured logger.
 *
 * The properties that matter here are not cosmetic. A logger runs on the error
 * path, so the cases worth pinning are the ones where a naive implementation
 * takes the program down while reporting that something went wrong: a circular
 * object, an Error (which JSON.stringify renders as `{}`), a BigInt, and a sink
 * that throws.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger, formatRecord, silentLogger, toLogValue } from '../scripts/log.mjs';

/** Collects whatever is written to it, one entry per write() call. */
function createSink() {
  const writes = [];
  return {
    writes,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    records() {
      return writes.map((line) => JSON.parse(line));
    },
  };
}

test('a record is one JSON object per line, with ts, level and event first', () => {
  const line = formatRecord('info', 'request', { method: 'GET', status: 200 });

  assert.ok(line.endsWith('\n'));
  assert.equal(line.trim().includes('\n'), false, 'a record must be a single line');

  const record = JSON.parse(line);
  assert.equal(record.level, 'info');
  assert.equal(record.event, 'request');
  assert.equal(record.method, 'GET');
  assert.equal(record.status, 200);
  assert.ok(!Number.isNaN(Date.parse(record.ts)), 'ts must be an ISO timestamp');
  assert.deepEqual(Object.keys(record).slice(0, 3), ['ts', 'level', 'event']);
});

test('an Error keeps its message and errno code instead of becoming {}', () => {
  const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const record = JSON.parse(formatRecord('error', 'stream_error', { err }));

  assert.equal(record.err.name, 'Error');
  assert.equal(record.err.message, 'permission denied');
  assert.equal(record.err.code, 'EACCES');
});

test('logging a circular object does not throw', () => {
  // The realistic case: an error handler that logs the request or socket it was
  // given. JSON.stringify would throw here, and it would throw *inside* the
  // error path, taking the server with it.
  const request = { url: '/index.html' };
  request.self = request;

const record = JSON.parse(formatRecord('warn', 'request_refused', { request }));
  assert.equal(record.request.url, '/index.html');
  assert.equal(record.request.self.self, '[max depth]', 'the cycle is cut, not followed');
  assert.equal(record.request.self.url, '/index.html', 'and it stops there');
});

test('values that JSON.stringify cannot handle are coerced, not propagated', () => {
  assert.deepEqual(toLogValue(10n), '10n');
  assert.equal(toLogValue(Number.NaN), 'NaN');
  assert.equal(toLogValue(Infinity), 'Infinity');
  assert.equal(toLogValue(undefined), undefined);
  assert.equal(toLogValue(Symbol('x')), 'Symbol(x)');
  assert.equal(toLogValue(() => {}), '[function anonymous]');
  assert.equal(toLogValue({ long: 'x'.repeat(1000) }).long.length, 512 + '...[truncated]'.length);

  // A deeply nested structure is cut off rather than walked without bound: the
  // walker gives up four levels down, and reports where it stopped.
  const nest = (levels) => (levels === 0 ? 'leaf' : { a: nest(levels - 1) });
  assert.equal(toLogValue(nest(3)).a.a.a, 'leaf');
  assert.equal(toLogValue(nest(5)).a.a.a.a, '[max depth]');

  // A getter that throws must not be able to break logging.
  const hostile = {
    get boom() {
      throw new Error('nope');
    },
  };
  assert.equal(toLogValue(hostile).boom, '[unserialisable]');
});

test('levels below the threshold are dropped, errors go to stderr', () => {
  const stdout = createSink();
  const stderr = createSink();
  const logger = createLogger({ stdout, stderr, level: 'warn' });

  logger.debug('noisy', {});
  logger.info('also_noisy', {});
  logger.warn('refused', { status: 403 });
  logger.error('stream_error', { code: 'EACCES' });

  assert.deepEqual(stdout.writes, [], 'nothing below the threshold is written');
  assert.deepEqual(
    stderr.records().map((r) => r.event),
    ['refused', 'stream_error'],
  );
});

test('a child logger carries its context into every record', () => {
  const sink = createSink();
  const logger = createLogger({ stdout: sink, stderr: sink }).child({ port: 8080 });

  logger.info('request', { status: 200 });
  logger.child({ path: '/index.html' }).info('opened', {});

  assert.equal(sink.records()[0].port, 8080);
  assert.equal(sink.records()[0].status, 200);
  assert.equal(sink.records()[1].port, 8080, 'a grandchild keeps its parent context');
  assert.equal(sink.records()[1].path, '/index.html');
});

test('a sink that throws does not take the caller down', () => {
  const logger = createLogger({
    stdout: {
      write() {
        throw new Error('EPIPE');
      },
    },
    level: 'debug',
  });

  assert.doesNotThrow(() => logger.info('request', { status: 200 }));

  const sink = createSink();
  createLogger({ stdout: sink, stderr: sink, enabled: false }).error('ignored', {});
  assert.deepEqual(sink.writes, [], 'a disabled logger writes nothing at all');
  assert.doesNotThrow(() => silentLogger.error('ignored', {}));
});