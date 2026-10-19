/**
 * Tests for js/index.js, the chat widget wiring on index.html.
 *
 * This file was the one piece of first-party JavaScript with no test at all,
 * and it is the piece that turns visitor input into DOM. The assertions below
 * are chosen for what could actually go wrong there:
 *
 *   - a reply has to appear at all (the widget is wired to the bot correctly)
 *   - the input has to be cleared, or Enter spams the transcript
 *   - markup in the input has to be rendered as text. The widget builds its
 *     transcript with `.text()`, never `.html()`; this is the regression pin
 *     for that, since swapping one for the other would be invisible otherwise.
 *   - a page without the chat markup must not throw on every keystroke.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, createFakeClock, createFakeJQuery, loadScripts } from './harness.mjs';

/** Build the page the widget expects, and load the widget into it. */
function mountChatWidget(options = {}) {
  const clock = createFakeClock();
  const jQuery = createFakeJQuery();

  const chat = createElement('chat');
  const input = createElement('input');
  const busy = createElement('busy');
  const form = createElement('div');
  const sendLink = createElement('a');

  if (options.withoutMarkup !== true) {
    jQuery.register('.chat', [chat]);
    jQuery.register('.input input', [input]);
    jQuery.register('.busy', [busy]);
    jQuery.register('.input', [form]);
    jQuery.register('.input a', [sendLink]);
  }

  loadScripts(['js/chat-bot.js', 'js/index.js'], {
    jQuery,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  return { clock, chat, input, busy, form, sendLink };
}

/** The transcript line at `index`: what was written, and how. */
function lineAt(chat, index) {
  const line = chat.appended[index];
  return {
    party: line.children.party.classes,
    text: line.children.text.textValue,
    // htmlValue is only ever set if something reached for .html().
    html: line.children.text.htmlValue,
  };
}

/** Press a key in the chat input; reports whether the default was prevented. */
function pressKey(form, key) {
  let prevented = false;
  form.handlers.keydown({ key, preventDefault: () => (prevented = true) });
  return prevented;
}

/** Click the Send link. */
function clickSend(sendLink) {
  let prevented = false;
  sendLink.handlers.click({ preventDefault: () => (prevented = true) });
  return prevented;
}

test('the widget greets the visitor on load', () => {
  const { chat } = mountChatWidget();

  assert.equal(chat.appended.length, 1);
  assert.deepEqual(lineAt(chat, 0).party, ['other']);
  assert.match(lineAt(chat, 0).text, /^Welcome!/);
});

test('Enter submits, shows the question, then answers it', () => {
  const { clock, chat, input, busy, form } = mountChatWidget();

  input.value = 'hello';
  assert.equal(pressKey(form, 'Enter'), true, 'Enter must not submit the surrounding form');
  assert.equal(input.value, '', 'the input is cleared after submitting');

  // The question appears immediately; the reply is deliberately delayed so the
  // bot looks like it is typing, so nothing else is on screen until it fires.
  assert.equal(chat.appended.length, 2);
  assert.deepEqual(lineAt(chat, 1).party, ['you']);
  assert.equal(lineAt(chat, 1).text, 'hello');
  assert.equal(busy.cssValue.display, 'block', 'the busy indicator is shown');

  clock.flush();

  assert.equal(chat.appended.length, 3);
  assert.deepEqual(lineAt(chat, 2).party, ['other']);
  assert.match(lineAt(chat, 2).text, /Welcome To Precog Security/);
  assert.equal(busy.cssValue.display, 'none', 'the busy indicator is cleared afterwards');
});

test('a key that is not Enter does nothing', () => {
  const { chat, input, form } = mountChatWidget();
  input.value = 'hello';

  assert.equal(pressKey(form, 'a'), false, 'the default is left alone');
  assert.equal(chat.appended.length, 1, 'only the greeting is on screen');
  assert.equal(input.value, 'hello', 'the input is left alone');
});

test('empty input is not submitted', () => {
  const { chat, input, form } = mountChatWidget();

  input.value = '';
  pressKey(form, 'Enter');

  assert.equal(chat.appended.length, 1);
  assert.equal(input.value, '');
});

test('the Send link submits without a keypress', () => {
  const { clock, chat, input, sendLink } = mountChatWidget();

  input.value = '1';
  assert.equal(clickSend(sendLink), true, 'the link does not navigate');
  clock.flush();

  assert.equal(chat.appended.length, 3);
  assert.match(lineAt(chat, 2).text, /DOMESTIC/);
});

test('visitor input is rendered as text, never as markup (regression)', () => {
  const { clock, chat, input, form } = mountChatWidget();
  // The trailing keyword is what makes the bot answer, so this pins both sides
  // of the exchange: the payload is echoed, and the reply lands underneath it.
  const payload = '<img src=x onerror="alert(1)"> hello';

  input.value = payload;
  pressKey(form, 'Enter');
  clock.flush();

  const question = lineAt(chat, 1);
  assert.equal(question.text, payload, 'the payload survives as literal text');
  assert.equal(question.html, '', 'the visitor line is never written through .html()');

  const reply = lineAt(chat, 2);
  assert.match(reply.text, /Welcome To Precog Security/);
  assert.equal(reply.html, '', 'including the reply');
  assert.equal(lineAt(chat, 0).html, '', 'and the static greeting');
});

test('an unmatched question leaves the transcript alone', () => {
  const { clock, chat, input, form } = mountChatWidget();

  input.value = 'zzzz qqqq';
  pressKey(form, 'Enter');
  clock.flush();

  assert.equal(chat.appended.length, 2, 'the question is shown, no reply is invented');
  assert.deepEqual(lineAt(chat, 1).party, ['you']);
});

test('a page without the chat markup degrades quietly', () => {
  // No selectors registered: index.html with the chat section removed.
  const { chat, form, clock } = mountChatWidget({ withoutMarkup: true });

  assert.equal(chat.appended.length, 0);
  assert.equal(form.handlers.keydown, undefined, 'nothing was bound to a missing element');
  assert.equal(clock.flush(), 0);
});

test('the transcript is scrolled into view after each line', () => {
  const { chat } = mountChatWidget();

  assert.ok(chat.animations.length > 0, 'the widget scrolls the transcript');
  assert.equal(chat.animations[0].scrollTop, chat.scrollHeight);
});