/**
 * Tests for js/chat-bot.js.
 *
 * The rules, their order and their replies are product behaviour and are
 * pinned here so the hardening cannot change what the bot says. The regression
 * cases are the input handling: respondTo() used to throw a TypeError on
 * null/undefined, which index.js called straight from a keydown handler.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadScript } from './harness.mjs';

function newBot() {
  const sandbox = loadScript('js/chat-bot.js');
  const ChatBot = sandbox.module.exports;
  return new ChatBot();
}

test('greets the visitor and offers the four categories', () => {
  const bot = newBot();
  const greeting = 'Welcome To Precog Security. Choose 1 DOMESTIC 2 LEGAL 3 BUSINESS 4 COMMUNITY';

  assert.equal(bot.respondTo('hello'), greeting);
  assert.equal(bot.respondTo('HELLO'), greeting, 'matching is case insensitive');
  assert.equal(bot.respondTo('hi'), greeting);
  assert.equal(bot.respondTo('help'), greeting);
  assert.equal(bot.respondTo('howzit'), greeting);
  // The patterns require the keyword to be followed by a word character or the
  // end of input, so a trailing space does not match. Unchanged behaviour.
  assert.equal(bot.respondTo('hello '), null);
});

test('routes each of the four categories', () => {
  const bot = newBot();

  assert.equal(bot.respondTo('1'), 'Your DISPUTE is DOMESTIC. How is home and family?');
  assert.equal(
    bot.respondTo('2'),
    'Your ISSUE is LEGAL. Proceed A LAWYER B REPORT to POLICE C SEEK ADVICE D CONTINUE CHAT',
  );
  assert.equal(
    bot.respondTo('3'),
    'Your CONCERN is BUSINESS. Investing in work or business always has positive effects on other areas of Life :)',
  );
  assert.equal(bot.respondTo('4'), 'Your STAKES are within COMMUNITY where important things happen');
});

test('the first matching rule wins, in table order', () => {
  const bot = newBot();

  // "2" matches both the category rule and (later) the legal/business rules.
  // The category reply must win.
  assert.equal(
    bot.respondTo('2'),
    'Your ISSUE is LEGAL. Proceed A LAWYER B REPORT to POLICE C SEEK ADVICE D CONTINUE CHAT',
  );
});

test('replies for the substantive topics', () => {
  const bot = newBot();

  // The patterns require the keyword to end the input or be followed by a word
  // character, so each probe puts the keyword last.
  assert.equal(bot.respondTo('my family'), 'I understand! LEGALLY, what would you propose?');
  assert.equal(bot.respondTo('about the household'), 'There is PRESSURE upon YOU or RESOURCES.');
  assert.equal(bot.respondTo('landlord'), 'How would your COMMUNITY view that scenario?');
  assert.equal(bot.respondTo('i need a court'), 'Who do you SUSPECT');
  assert.equal(bot.respondTo('business'), 'Stand by for best BUSINESS Recommendations');
  assert.equal(bot.respondTo('the environment'), 'You must SURVEY and INFLUENCE the COMMUNITY');
});

test('upper-case keywords in the rule set now match regardless of case', () => {
  const bot = newBot();

  // respondTo() lower-cases the input, while many patterns list their keywords
  // in upper case ("LAWYER", "MURDER", "CASH"). The patterns are now compiled
  // case insensitively, so those branches are reachable instead of dead.
  assert.equal(bot.respondTo('LAWYER'), 'Who do you SUSPECT');
  assert.equal(bot.respondTo('lawyer'), 'Who do you SUSPECT');
  assert.equal(bot.respondTo('Lawyer'), 'Who do you SUSPECT');
  assert.equal(bot.respondTo('DEBT'), 'Who do you SUSPECT');
  assert.equal(bot.respondTo('debt'), 'Who do you SUSPECT');
  assert.equal(bot.respondTo('murder'), 'Who do you SUSPECT');
  assert.equal(bot.respondTo('cash'), 'Who do you SUSPECT');
});

test('matching stays case insensitive for the lower-case keywords too', () => {
  const bot = newBot();

  assert.equal(bot.respondTo('FAMILY'), 'I understand! LEGALLY, what would you propose?');
  assert.equal(bot.respondTo('Family'), 'I understand! LEGALLY, what would you propose?');
  assert.equal(bot.respondTo('business'), 'Stand by for best BUSINESS Recommendations');
  assert.equal(bot.respondTo('BUSINESS'), 'Stand by for best BUSINESS Recommendations');
});

test('returns null when nothing matches, so the UI can stay quiet', () => {
  const bot = newBot();

  assert.equal(bot.respondTo('zzzz qqqq'), null);
  assert.equal(bot.respondTo(''), null);
});

test('survives non-string and hostile input (regression)', () => {
  const bot = newBot();

  // These all threw a TypeError before: input.toLowerCase() on null/undefined.
  assert.equal(bot.respondTo(null), null);
  assert.equal(bot.respondTo(undefined), null);
  assert.doesNotThrow(() => bot.respondTo(42));
  assert.doesNotThrow(() => bot.respondTo({}));
  assert.doesNotThrow(() => bot.respondTo([]));
  assert.doesNotThrow(() => bot.respondTo(NaN));
});

test('regular expression metacharacters in input are inert', () => {
  const bot = newBot();

  // The rules are literal patterns; user input must never be compiled as one.
  for (const input of ['((((', '[a-z]+', '(?<=x)', '\\', '.*', 'hello(', 'a{999999999}']) {
    assert.doesNotThrow(() => bot.respondTo(input), `threw on ${JSON.stringify(input)}`);
  }
  assert.equal(bot.respondTo('.*'), null, 'a wildcard is not a rule');
});

test('bounds the input it will match against', () => {
  const bot = newBot();

  // A huge paste must not become a CPU sink, and must not throw.
  const huge = 'a'.repeat(200000);
  const started = process.hrtime.bigint();
  assert.doesNotThrow(() => bot.respondTo(huge));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(bot.input.length, 256, 'input is truncated to the documented bound');
  assert.ok(elapsedMs < 1000, `matching took ${elapsedMs.toFixed(1)}ms, expected well under a second`);
});

test('match() reports against the last normalised input', () => {
  const bot = newBot();

  bot.respondTo('Hello World');
  assert.equal(bot.input, 'hello world');
  assert.equal(bot.match('^hello'), true);
  assert.equal(bot.match('^bye'), false);
  assert.equal(bot.match('(unclosed'), false, 'an unusable pattern is a non-match, not an exception');
});
