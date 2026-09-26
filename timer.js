/**
 * timer.js - jQuery plugins for the countdown and the sticky "stay visible"
 * element used by the offer pages.
 *
 * Fixed defects (all of them shipped broken before):
 *
 *   1. `settings` was allocated once, outside the `.each()` loop, so
 *      `$.extend(settings, options)` leaked options from one element into
 *      every other element on the page and the countdown could never be
 *      restarted with different options. Settings are now per element.
 *   2. `stayVisible` read `$this.parent().offset().top` without a null check.
 *      jQuery returns null from offset() for a detached or display:none
 *      parent, which threw a TypeError ten times a second and took the rest of
 *      the page's JavaScript down with it.
 *   3. `timeLeft` was never validated, so a negative, fractional or non-numeric
 *      value produced "0:-1" style output and never reached onComplete.
 *   4. Loose equality on numeric comparisons, and a detached element left the
 *      interval running.
 */
(function ($) {
  'use strict';

  var DEFAULTS = {
    // Seconds remaining. Validated to a non-negative integer.
    timeLeft: 10,
    // When to fire onAlert, in seconds remaining. 0 disables it.
    alertPeriod: 0,
    // Remaining seconds at which the display turns red.
    warningAt: 60,
    onAlert: null,
    onComplete: null
  };

  /**
   * Coerce to a non-negative integer, falling back to the default.
   * @param {*} value @param {number} fallback @returns {number}
   */
  function toSeconds(value, fallback) {
    var number = typeof value === 'number' ? value : parseInt(value, 10);
    if (isNaN(number) || !isFinite(number) || number < 0) return fallback;
    return Math.floor(number);
  }

  /**
   * "M:SS", zero padded, e.g. 90 -> "01:30".
   * @param {number} seconds @returns {string}
   */
  function formatCountdown(seconds) {
    var value = toSeconds(seconds, 0);
    var minutes = Math.floor(value / 60);
    var remaining = value % 60;
    return (minutes < 10 ? '0' + minutes : String(minutes)) + ':' +
      (remaining < 10 ? '0' + remaining : String(remaining));
  }

  /**
   * Countdown timer that writes into the matched element.
   * @param {Object} [options] @returns {jQuery}
   */
  $.fn.simpleCountdown = function (options) {
    return this.each(function () {
      var settings = {
        timeLeft: toSeconds(options && options.timeLeft, DEFAULTS.timeLeft),
        alertPeriod: toSeconds(options && options.alertPeriod, DEFAULTS.alertPeriod),
        warningAt: toSeconds(options && options.warningAt, DEFAULTS.warningAt),
        onAlert: (options && options.onAlert) || DEFAULTS.onAlert,
        onComplete: (options && options.onComplete) || DEFAULTS.onComplete
      };

      var $container = $(this);
      var interval = null;

      function write() {
        $container.html(formatCountdown(settings.timeLeft));
      }

      function doCountdown() {
        // Decrement first, so every check below refers to the value that is
        // about to be displayed (this is the behaviour callers rely on).
        settings.timeLeft -= 1;

        if (settings.alertPeriod > 0 && settings.timeLeft === settings.alertPeriod) {
          if (typeof settings.onAlert === 'function') settings.onAlert();
        }
        if (settings.timeLeft === settings.warningAt) {
          $container.css({ color: '#f00' });
        }

        if (settings.timeLeft < 0) {
          stop();
          if (typeof settings.onComplete === 'function') settings.onComplete();
        } else if (!$container.closest('body').length) {
          // The element left the document: stop the timer instead of leaking it.
          stop();
        } else {
          write();
        }
      }

      function stop() {
        if (interval !== null) {
          clearInterval(interval);
          interval = null;
        }
      }

      write();
      interval = setInterval(doCountdown, 1000);
    });
  };

  /**
   * Keeps the matched element pinned below the top of the viewport while its
   * parent is on screen.
   * @returns {jQuery}
   */
  $.fn.stayVisible = function () {
    return this.each(function () {
      var $this = $(this);
      var interval = setInterval(checkPosition, 100);

      function checkPosition() {
        var parentOffset = $this.parent().offset();

        // offset() is null while the parent is detached or not laid out.
        if (!parentOffset) return;

        var newTop = ($(window).scrollTop() || 0) - parentOffset.top;
        if (newTop < 0) newTop = 0;
        $this.css({ top: newTop });
      }
    });
  };

  // Exposed for the unit tests; harmless in the browser.
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { formatCountdown: formatCountdown, toSeconds: toSeconds };
  }
}(typeof jQuery !== 'undefined' ? jQuery : (typeof window !== 'undefined' ? window.jQuery : null)));
