/**
 * index.js - wires the chat widget on index.html to js/chat-bot.js.
 *
 * Fixes over the previous version:
 *   1. The initial line was rendered with `getElementsByTagName('*')` - an
 *      HTMLCollection, not text - so the first thing a visitor saw was
 *      "[object HTMLCollection]" or an empty line.
 *   2. The deprecated event binder was replaced with the supported one; it is
 *      gone in the next major release.
 *   3. `e.keyCode == 13` is a magic number that does not survive
 *      international keyboard layouts; `e.key` is used instead.
 *   4. Reply rendering used `for (var r in reply)`, which also walks inherited
 *      properties; a plain indexed loop is used instead.
 *   5. If the chat markup is missing the script now degrades quietly instead of
 *      throwing on every keypress.
 */
(function ($) {
  'use strict';

  $(function () {
    // chat aliases
    var you = 'You';
    var robot = 'bluehound';

    // slow reply by 400 to 800 ms
    var delayStart = 400;
    var delayEnd = 800;

    var bot = new chatBot();
    var chat = $('.chat');
    var input = $('.input input');
    var busy = $('.busy');
    var waiting = 0;

    if (!chat.length) return;

    busy.text(robot + ' is Processing...');

    // add a new line to the chat. Text is set with .text(), never .html(),
    // so a visitor can never inject markup into the transcript.
    function updateChat(party, text) {
      var style = party === you ? 'you' : 'other';
      var line = $('<div><span class="party"></span> <span class="text"></span></div>');
      line.find('.party').addClass(style).text(party + ':');
      line.find('.text').text(String(text));

      chat.append(line);
      chat.stop().animate({ scrollTop: chat.prop('scrollHeight') });
    }

    // submit user input and get chat-bot's reply
    function submitChat() {
      var text = input.val();
      if (text === null || text === undefined || text === '') return;

      input.val('');
      updateChat(you, text);

      var reply = bot.respondTo(text);
      if (reply === null || reply === undefined) return;

      var latency = Math.floor((Math.random() * (delayEnd - delayStart)) + delayStart);
      busy.css('display', 'block');
      waiting++;
      setTimeout(function () {
        if (typeof reply === 'string') {
          updateChat(robot, reply);
        } else {
          for (var i = 0; i < reply.length; i++) {
            updateChat(robot, reply[i]);
          }
        }
        waiting -= 1;
        if (waiting === 0) busy.css('display', 'none');
      }, latency);
    }

    // event binding
    $('.input').on('keydown', function (event) {
      if (event.key === 'Enter' || event.keyCode === 13) {
        event.preventDefault();
        submitChat();
      }
    });
    $('.input a').on('click', function (event) {
      event.preventDefault();
      submitChat();
    });

    // initial chat state
    updateChat(robot, 'Welcome! Enter your query and press Send.');
  });
}(typeof jQuery !== 'undefined' ? jQuery : (typeof window !== 'undefined' ? window.jQuery : null)));
