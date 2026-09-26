/**
 * Tests for gotourl.js - the campaign tracking link builder.
 *
 * This is the most security-relevant file in the repository: it moves personal
 * data (subscriber number, name, order id) from the query string to a third
 * party. The tests pin the transport, the allowlist and the rejection of
 * anything that could change where the link points.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeJQuery, loadScript } from './harness.mjs';

function load() {
  return loadScript('gotourl.js', { location: { search: '' } });
}

const api = (sandbox) => sandbox.precogTracking;

test('the tracking endpoint is https, never http', () => {
  const tracking = api(load());

  assert.match(tracking.TRACKING_ENDPOINT, /^https:\/\//);
});

test('refuses to build a URL for a plaintext endpoint', () => {
  const tracking = api(load());

  assert.throws(
    () => tracking.buildTrackingUrl('?xc=abc', 'http://trckingnow.com/click'),
    /must be an absolute https/,
  );
  assert.throws(() => tracking.buildTrackingUrl('?xc=abc', '//trckingnow.com/click'), /https/);
  assert.throws(() => tracking.buildTrackingUrl('?xc=abc', 'javascript:alert(1)'), /https/);
});

test('maps the allowlisted source parameters to the documented names', () => {
  const tracking = api(load());

  const url = tracking.buildTrackingUrl('?xc=abc123&oid=ORD-9&poid=ORD-8&s1=sub1&msisdn=27721234567&fname=Thandi');
  assert.equal(
    url,
    'https://trckingnow.com/click?c=abc123&po=ORD-9&poid=ORD-8&s1=sub1&msisdn=27721234567&fname=Thandi',
  );
});

test('drops parameters that are not allowlisted', () => {
  const tracking = api(load());

  const url = tracking.buildTrackingUrl('?xc=abc123&email=victim@example.com&token=secret&password=hunter2');
  assert.equal(url, 'https://trckingnow.com/click?c=abc123');
});

test('rejects values carrying URL syntax instead of forwarding them (regression)', () => {
  const tracking = api(load());

  // Raw concatenation used to turn `?xc=a&admin=1` into a second parameter on
  // the tracking URL. Validation drops the value outright, and the encoder
  // below is the second line of defence.
  for (const attack of [
    '?xc=a%26admin%3D1%26b%3D2',
    '?xc=a%3Fb%3D2',
    '?xc=a%23fragment',
    '?xc=%3Cscript%3E',
  ]) {
    assert.equal(tracking.buildTrackingUrl(attack), null, `forwarded ${attack}`);
  }
});

test('accepted values survive the round trip through the built URL', () => {
  const tracking = api(load());

  const cases = [
    ['?xc=abc123', 'c', 'abc123'],
    ['?fname=Anne%20Marie', 'fname', 'Anne Marie'],
    ["?fname=Anne-Marie%20O%27Brien", 'fname', "Anne-Marie O'Brien"],
    ['?msisdn=%2B27721234567', 'msisdn', '+27721234567'],
    ['?s1=sub.1~2-3', 's1', 'sub.1~2-3'],
  ];

  for (const [search, key, expected] of cases) {
    const url = tracking.buildTrackingUrl(search);
    assert.ok(url, `nothing forwarded for ${search}`);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get(key), expected, `round trip failed for ${search}`);
    assert.equal(parsed.searchParams.getAll(key).length, 1, `${key} appeared more than once`);
    assert.equal(
      `${parsed.origin}${parsed.pathname}`,
      'https://trckingnow.com/click',
      'the destination never changes',
    );
  }
});

test('encodes values on the way out', () => {
  const tracking = api(load());

  // A space is legal in a name and illegal in a query string: if this ever
  // stops being encoded, the URL is malformed.
  assert.equal(
    tracking.buildTrackingUrl('?fname=Anne%20Marie'),
    'https://trckingnow.com/click?fname=Anne%20Marie',
  );
  assert.ok(!tracking.buildTrackingUrl('?fname=Anne%20Marie').includes(' '));
});

test('cannot be used to change the destination host (regression)', () => {
  const tracking = api(load());

  for (const attack of [
    '?xc=@evil.example.com',
    '?xc=//evil.example.com',
    '?xc=https%3A%2F%2Fevil.example.com',
    '?xc=a%23@evil.example.com',
  ]) {
    const url = tracking.buildTrackingUrl(attack);
    if (url === null) continue;
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'trckingnow.com', `host was changed by ${attack}`);
    assert.equal(parsed.protocol, 'https:');
  }
});

test('validates the subscriber number', () => {
  const tracking = api(load());

  assert.equal(api(load()).sanitizeValue('msisdn', '27721234567'), '27721234567');
  assert.equal(tracking.sanitizeValue('msisdn', '+27721234567'), '+27721234567');
  assert.equal(tracking.sanitizeValue('msisdn', '12345'), null, 'too short to be a real number');
  assert.equal(tracking.sanitizeValue('msisdn', '2772123456789012'), null, 'longer than E.164 allows');
  assert.equal(tracking.sanitizeValue('msisdn', "277'; DROP TABLE--"), null);
  assert.equal(tracking.sanitizeValue('msisdn', 'not-a-number'), null);
});

test('validates the visitor name', () => {
  const tracking = api(load());

  assert.equal(tracking.sanitizeValue('fname', "Anne-Marie O'Brien"), "Anne-Marie O'Brien");
  assert.equal(tracking.sanitizeValue('fname', '<script>alert(1)</script>'), null);
  assert.equal(tracking.sanitizeValue('fname', '1234'), null, 'must start with a letter');
  assert.equal(tracking.sanitizeValue('fname', 'A'.repeat(200)), null, 'bounded by length');
});

test('bounds every value it will forward', () => {
  const tracking = api(load());

  assert.equal(tracking.MAX_VALUE_LENGTH, 64);
  assert.equal(tracking.sanitizeValue('c', 'a'.repeat(33)), null, 'over the pattern bound');
  assert.equal(tracking.sanitizeValue('c', 'a'.repeat(65)), null, 'over MAX_VALUE_LENGTH');
  assert.equal(tracking.sanitizeValue('c', 'a'.repeat(32)), 'a'.repeat(32));
  assert.equal(tracking.sanitizeValue('c', ''), null);
  assert.equal(tracking.sanitizeValue('c', null), null);
  assert.equal(tracking.sanitizeValue('c', undefined), null);
  assert.equal(tracking.sanitizeValue('unknown-target', 'value'), null);
});

test('returns null when there is nothing safe to forward', () => {
  const tracking = api(load());

  assert.equal(tracking.buildTrackingUrl(''), null);
  assert.equal(tracking.buildTrackingUrl('?unrelated=1'), null);
  assert.equal(tracking.buildTrackingUrl('?xc='), null);
  assert.equal(tracking.buildTrackingUrl('?msisdn=nope'), null, 'all values rejected');
});

test('survives malformed percent-encoding', () => {
  const tracking = api(load());

  for (const search of ['?xc=%zz', '?%E0%A4%A=1', '?xc=%', '?=%', '?&&&', '?a=1&a=2']) {
    assert.doesNotThrow(() => tracking.buildTrackingUrl(search), `threw on ${search}`);
  }
  assert.equal(tracking.buildTrackingUrl('?xc=%zz'), null, 'a malformed value is dropped');
});

test('init() points .gotoURL at the safe URL from the current query string', () => {
  const jQuery = createFakeJQuery();
  const link = {};
  jQuery.register('.gotoURL', [link]);

  const tracking = api(loadScript('gotourl.js', { location: { search: '?xc=live1' } }));

  assert.equal(tracking.buildTrackingUrl(), 'https://trckingnow.com/click?c=live1');
  assert.equal(tracking.init(jQuery), 1);
  assert.equal(link.attrs.href, 'https://trckingnow.com/click?c=live1');
});

test('init() leaves the page untouched when the query string is unusable', () => {
  const jQuery = createFakeJQuery();
  const link = {};
  jQuery.register('.gotoURL', [link]);

  const tracking = api(loadScript('gotourl.js', { location: { search: '?email=victim@example.com' } }));

  assert.equal(tracking.init(jQuery), 0, 'nothing is updated');
  assert.equal(link.attrs, undefined, 'no href is written, so no unexpected navigation');
});

test('init() tolerates being called without jQuery', () => {
  const tracking = api(load());

  assert.equal(tracking.init(undefined), 0);
  assert.equal(tracking.init(null), 0);
});
