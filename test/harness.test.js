/**
 * Tests for the test doubles in harness.mjs.
 *
 * The doubles are load-bearing for every other test in this directory: a
 * silently broken double makes tests pass without testing anything, so the
 * doubles are verified like everything else.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, createFakeClock, createFakeJQuery, loadScript } from './harness.mjs';

test('the fake clock fires and clears intervals on demand', () => {
  const clock = createFakeClock();
  let fired = 0;
  const id = clock.setInterval(() => {
    fired += 1;
  }, 1000);

  assert.equal(clock.activeCount, 1);
  clock.tick(3);
  assert.equal(fired, 3);

  clock.clearInterval(id);
  assert.equal(clock.activeCount, 0);
  clock.tick(2);
  assert.equal(fired, 3, 'a cleared interval never fires again');
});

test('the jQuery double records what a script does to an element', () => {
  const jQuery = createFakeJQuery();
  const element = createElement('timer', { inDocument: true, parentOffset: 40 });
  const wrapper = jQuery.set([element]);

  assert.equal(wrapper.html(), '');
  wrapper.html('01:30');
  assert.equal(element.htmlValue, '01:30');

  wrapper.css({ color: '#f00' });
  assert.deepEqual(element.cssValue, { color: '#f00' });

  assert.equal(wrapper.closest('body').length, 1, 'attached elements find their body');
  assert.deepEqual(wrapper.parent().offset(), { top: 40 });

  const detached = createElement('timer', { inDocument: false });
  assert.equal(jQuery.set([detached]).closest('body').length, 0, 'detached elements do not');

  const unlaid = createElement('timer', { parentOffset: null });
  assert.equal(jQuery.set([unlaid]).parent().offset(), null, 'no layout means a null offset');
});

test('the double exposes plugins on $.fn the way jQuery does', () => {
  const jQuery = createFakeJQuery();
  jQuery.fn.examplePlugin = function () {
    return this.each(function () {
      this.htmlValue = 'plugged';
    });
    return this;
  };

  const element = createElement('x');
  jQuery.set([element]).examplePlugin();
  assert.equal(element.htmlValue, 'plugged');
});

test('the sandbox executes the shipped file and exposes its exports', () => {
  const sandbox = loadScript('js/chat-bot.js');

  assert.equal(typeof sandbox.module.exports, 'function');
  const bot = new sandbox.module.exports();
  assert.equal(
    bot.respondTo('hello'),
    'Welcome To Precog Security. Choose 1 DOMESTIC 2 LEGAL 3 BUSINESS 4 COMMUNITY',
  );
});
