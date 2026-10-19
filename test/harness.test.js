/**
 * Tests for the test doubles in harness.mjs.
 *
 * The doubles are load-bearing for every other test in this directory: a
 * silently broken double makes tests pass without testing anything, so the
 * doubles are verified like everything else.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, createFakeClock, createFakeJQuery, loadScript, loadScripts } from './harness.mjs';

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

test('the fake clock also runs and cancels deferred work', () => {
  const clock = createFakeClock();
  const ran = [];

  clock.setTimeout(() => ran.push('kept'), 400);
  const cancelled = clock.setTimeout(() => ran.push('cancelled'), 400);
  clock.clearTimeout(cancelled);

  assert.equal(clock.pendingTimeouts, 1);
  assert.equal(clock.flush(), 1);
  assert.deepEqual(ran, ['kept']);
  assert.equal(clock.pendingTimeouts, 0, 'a drained queue is empty');

  // Work queued by the callback itself still runs, and a self-requeueing
  // callback stops instead of hanging the test.
  clock.setTimeout(() => {
    ran.push('outer');
    clock.setTimeout(() => ran.push('inner'), 0);
  }, 0);
  assert.equal(clock.flush(), 2);
  assert.deepEqual(ran, ['kept', 'outer', 'inner']);

  const forever = createFakeClock();
  forever.setTimeout(function loop() {
    forever.setTimeout(loop, 0);
  }, 0);
  assert.equal(forever.flush(5), 5, 'flush is bounded');
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

test('several shipped files can share one sandbox', () => {
  // js/index.js calls the global chatBot declared by js/chat-bot.js; testing
  // that wiring needs both files in the same context.
  const sandbox = loadScripts(['js/chat-bot.js', 'js/index.js'], { jQuery: () => {} });

  assert.equal(typeof sandbox.chatBot, 'function');
});

test('the double records the DOM writes the chat widget makes', () => {
  const jQuery = createFakeJQuery();

  // css() takes both an object and a name/value pair.
  const element = createElement('x');
  const wrapper = jQuery.set([element]);
  wrapper.css({ color: '#f00' }).css('display', 'block');
  assert.deepEqual(element.cssValue, { color: '#f00', display: 'block' });

  // .text() and .val() are distinct sinks: one writes text, the other a value.
  wrapper.text('hello').val('typed');
  assert.equal(element.textValue, 'hello');
  assert.equal(element.value, 'typed');

  // An HTML literal becomes an element, and find() lazily exposes its children.
  const line = jQuery('<div><span class="text"></span></div>');
  line.find('.text').addClass('reply').text('hi');
  assert.equal(line.nodes[0].classes.length, 0, 'classes land on the child, not the line');
  assert.deepEqual(line.nodes[0].children.text.classes, ['reply']);
  assert.equal(line.nodes[0].children.text.textValue, 'hi');

  // append() records the node, and event handlers can be invoked afterwards.
  const chat = createElement('chat');
  let seen = null;
  jQuery.set([chat]).on('click', () => (seen = 'clicked')).append(line);
  chat.handlers.click();
  assert.equal(seen, 'clicked');
  assert.equal(chat.appended[0], line.nodes[0]);

  assert.equal(chat.animations.length, 0);
  jQuery.set([chat]).stop().animate({ scrollTop: 42 });
  assert.deepEqual(chat.animations, [{ scrollTop: 42 }]);
  assert.equal(jQuery.set([createElement('y')]).prop('scrollHeight', 7).prop('scrollHeight'), 7);
});
