/**
 * Tests for timer.js - the countdown and sticky-element plugins.
 *
 * The two bugs these pin down were shipped live:
 *   - settings were shared across every element matched by one call, so one
 *     element's options leaked into the others and a second call with different
 *     options silently overwrote the first;
 *   - stayVisible() read `.offset().top` without a null check, which threw
 *     ten times a second for any element whose parent was not laid out.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, createFakeClock, createFakeJQuery, loadScript } from './harness.mjs';

function setup() {
  const clock = createFakeClock();
  const jQuery = createFakeJQuery();
  const window = { jQuery, scrollTop: 0 };
  const sandbox = loadScript('timer.js', {
    jQuery,
    window,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  return { clock, jQuery, sandbox, helpers: sandbox.module.exports };
}

test('formatCountdown renders zero padded minutes and seconds', () => {
  const { helpers } = setup();
  const { formatCountdown } = helpers;

  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(9), '00:09');
  assert.equal(formatCountdown(59), '00:59');
  assert.equal(formatCountdown(60), '01:00');
  assert.equal(formatCountdown(90), '01:30');
  assert.equal(formatCountdown(600), '10:00');
  assert.equal(formatCountdown(3600), '60:00');
});

test('formatCountdown never renders a negative or non-numeric time', () => {
  const { helpers } = setup();
  const { formatCountdown } = helpers;

  assert.equal(formatCountdown(-1), '00:00');
  assert.equal(formatCountdown(-600), '00:00');
  assert.equal(formatCountdown('nonsense'), '00:00');
  assert.equal(formatCountdown(undefined), '00:00');
  assert.equal(formatCountdown(Number.NaN), '00:00');
  assert.equal(formatCountdown(Number.POSITIVE_INFINITY), '00:00');
});

test('toSeconds rejects values that would produce a broken countdown', () => {
  const { helpers } = setup();
  const { toSeconds } = helpers;

  assert.equal(toSeconds(30, 10), 30);
  assert.equal(toSeconds('30', 10), 30);
  assert.equal(toSeconds(30.9, 10), 30);
  assert.equal(toSeconds(-1, 10), 10);
  assert.equal(toSeconds('abc', 10), 10);
  assert.equal(toSeconds(null, 10), 10);
  assert.equal(toSeconds(undefined, 10), 10);
  assert.equal(toSeconds(Number.NaN, 10), 10);
});

test('simpleCountdown writes the formatted time immediately', () => {
  const { clock, jQuery } = setup();
  const element = createElement('timer');

  jQuery.set([element]).simpleCountdown({ timeLeft: 90 });

  assert.equal(element.htmlValue, '01:30');
  assert.equal(clock.activeCount, 1);
});

test('simpleCountdown counts down once per tick and completes at zero', () => {
  const { clock, jQuery } = setup();
  const element = createElement('timer');
  let completions = 0;

  jQuery.set([element]).simpleCountdown({
    timeLeft: 3,
    onComplete: () => {
      completions += 1;
    },
  });

  clock.tick();
  assert.equal(element.htmlValue, '00:02');
  clock.tick();
  assert.equal(element.htmlValue, '00:01');
  clock.tick();
  assert.equal(element.htmlValue, '00:00');
  assert.equal(completions, 0);

  clock.tick();
  assert.equal(completions, 1, 'onComplete fires once the countdown passes zero');

  clock.tick(5);
  assert.equal(completions, 1, 'onComplete does not fire again');
  assert.equal(clock.activeCount, 0, 'the interval is cleared');
});

test('simpleCountdown falls back to the default duration for bad input', () => {
  const { clock, jQuery } = setup();
  const element = createElement('timer');

  jQuery.set([element]).simpleCountdown({ timeLeft: 'ten' });

  assert.equal(element.htmlValue, '00:10');
  clock.tick();
  assert.equal(element.htmlValue, '00:09');
});

test('simpleCountdown calls onAlert exactly once, at the requested moment', () => {
  const { clock, jQuery } = setup();
  const element = createElement('timer');
  let alerts = 0;

  jQuery.set([element]).simpleCountdown({
    timeLeft: 10,
    alertPeriod: 7,
    onAlert: () => {
      alerts += 1;
    },
  });

  clock.tick(2);
  assert.equal(alerts, 0, 'not yet');
  clock.tick();
  assert.equal(alerts, 1, 'fires when 7 seconds remain');
  assert.equal(element.htmlValue, '00:07');
  clock.tick(20);
  assert.equal(alerts, 1, 'fires once only');
});

test('simpleCountdown turns the display red at the warning threshold', () => {
  const { clock, jQuery } = setup();
  const element = createElement('timer');

  jQuery.set([element]).simpleCountdown({ timeLeft: 62 });

  clock.tick(1);
  assert.deepEqual(element.cssValue, {}, 'still above the threshold');

  clock.tick(1);
  assert.deepEqual(element.cssValue, { color: '#f00' }, 'red once 60 seconds remain');
  assert.equal(element.htmlValue, '01:00');
});

test('simpleCountdown does not leak options between elements (regression)', () => {
  const { clock, jQuery } = setup();
  const first = createElement('first');
  const second = createElement('second');

  // One call, two elements: each gets its own countdown, not one shared state.
  jQuery.set([first, second]).simpleCountdown({ timeLeft: 10 });
  clock.tick(3);

  assert.equal(first.htmlValue, '00:07');
  assert.equal(second.htmlValue, '00:07');
});

test('simpleCountdown keeps separate calls independent (regression)', () => {
  const { jQuery } = setup();
  const first = createElement('first');
  const second = createElement('second');

  jQuery.set([first]).simpleCountdown({ timeLeft: 30 });
  jQuery.set([second]).simpleCountdown({ timeLeft: 5 });

  assert.equal(first.htmlValue, '00:30', 'the first timer keeps its own duration');
  assert.equal(second.htmlValue, '00:05');
});

test('simpleCountdown stops when the element leaves the document', () => {
  const { clock, jQuery } = setup();
  const element = createElement('timer', { inDocument: false });
  let completions = 0;

  jQuery.set([element]).simpleCountdown({
    timeLeft: 5,
    onComplete: () => {
      completions += 1;
    },
  });

  clock.tick(1);
  assert.equal(clock.activeCount, 0, 'the interval is released, not leaked');
  assert.equal(completions, 0);
});

test('stayVisible survives a parent with no layout (regression)', () => {
  const { jQuery } = setup();
  const element = createElement('sticky', { parentOffset: null });

  // jQuery returns null from offset() here; the old code threw a TypeError
  // ten times a second and took the rest of the page with it.
  assert.doesNotThrow(() => jQuery.set([element]).stayVisible());
  assert.deepEqual(element.cssValue, {});
});

test('stayVisible pins the element below the top of the viewport', () => {
  // scrolled 400px down the page, parent sits at 100px: pin 300px from the top.
  const scrolled = createElement('sticky', { parentOffset: 100 });
  const pinned = setupWithScroll(400);

  pinned.jQuery.set([scrolled]).stayVisible();
  pinned.clock.tick();
  assert.deepEqual(scrolled.cssValue, { top: 300 });

  pinned.clock.tick();
  assert.deepEqual(scrolled.cssValue, { top: 300 }, 'recomputed, not accumulated');
});

test('stayVisible clamps at the top of the viewport', () => {
  // The parent has scrolled past the top of the window, so pinning stops at 0.
  const element = createElement('sticky', { parentOffset: 900 });
  const pinned = setupWithScroll(400);

  pinned.jQuery.set([element]).stayVisible();
  pinned.clock.tick();
  assert.deepEqual(element.cssValue, { top: 0 });
});

function setupWithScroll(scrollTop) {
  const clock = createFakeClock();
  const jQuery = createFakeJQuery();
  loadScript('timer.js', {
    jQuery,
    window: { jQuery, scrollTop },
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  });
  return { clock, jQuery };
}
