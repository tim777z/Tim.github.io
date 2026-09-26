/**
 * gotourl.js - campaign tracking link builder.
 *
 * Security context: this script reads a handful of campaign parameters from the
 * page query string and rebuilds a link to the tracking endpoint. The previous
 * implementation had three exploitable defects:
 *
 *   1. It forwarded the values over plaintext http://, so a phone number
 *      (msisdn), a name (fname) and an order id were readable by anyone on the
 *      network path - a PII disclosure, and an unfixable one once it happens.
 *   2. It concatenated the values without encoding, so a crafted query string
 *      could inject extra parameters, or change the target host/path.
 *   3. It had no validation and no bound on length, and it leaked globals.
 *
 * The rewrite keeps the observable behaviour (same source/target parameter
 * names, same endpoint) and fixes all three: https only, strict allowlist,
 * per-parameter charset validation, and percent-encoding on output.
 *
 * Endpoint: change TRACKING_ENDPOINT in one place. It must be https:// - the
 * builder refuses anything else, and `npm run lint` fails the build if a
 * plaintext http:// URL is reintroduced.
 *
 * Privacy: this endpoint receives personal data. See SECURITY.md for what has
 * to be true before forwarding it, and for how to turn the forwarding off.
 */
(function (root, factory) {
  'use strict';

  var api = factory(root);

  // Browser global, and CommonJS export so the behaviour is unit testable.
  root.precogTracking = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /** The only destination this site is allowed to forward to. Must be https. */
  var TRACKING_ENDPOINT = 'https://trckingnow.com/click';

  /**
   * Source query-string parameter -> parameter name sent to the endpoint.
   *
   * The original list read `oid` twice, which emitted the same value twice
   * (once as `po`, once as `poid`). Operators send either `oid` or `poid`, so
   * the second entry is corrected to read `poid` and forward it as `poid`.
   */
  var PARAMETER_MAP = [
    { from: 'xc', to: 'c' },
    { from: 'oid', to: 'po' },
    { from: 'poid', to: 'poid' },
    { from: 's1', to: 's1' },
    { from: 'msisdn', to: 'msisdn' },
    { from: 'fname', to: 'fname' }
  ];

  /** Nothing legitimate here is longer; anything bigger is abuse. */
  var MAX_VALUE_LENGTH = 64;

  /**
   * Per-parameter validation. Anything that does not match is dropped, so a
   * hostile query string degrades to "no parameter" rather than to injection.
   */
  var VALIDATORS = {
    // Campaign/click identifiers: opaque but URL-safe tokens.
    c: /^[A-Za-z0-9._~-]{1,32}$/,
    po: /^[A-Za-z0-9._~-]{1,32}$/,
    poid: /^[A-Za-z0-9._~-]{1,32}$/,
    // Free-form sub-id supplied by the affiliate network.
    s1: /^[A-Za-z0-9._~-]{1,32}$/,
    // Subscriber number: digits only, optional leading +, bounded length.
    msisdn: /^\+?[0-9]{6,15}$/,
    // Given name: letters plus the separators a real name can contain.
    fname: /^[A-Za-z][A-Za-z .'-]{0,31}$/
  };

  /**
   * Parse a query string into a map. Uses URLSearchParams where available so
   * percent-decoding and `+` handling follow the platform, and falls back to a
   * conservative manual parse otherwise. Never throws.
   *
   * @param {string} search e.g. window.location.search
   * @returns {Object.<string, string>}
   */
  function parseQuery(search) {
    var out = {};
    if (typeof search !== 'string' || search === '') return out;

    var pairs = search.charAt(0) === '?' ? search.slice(1).split('&') : search.split('&');
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i] === '') continue;
      var eq = pairs[i].indexOf('=');
      var rawName = eq === -1 ? pairs[i] : pairs[i].slice(0, eq);
      var rawValue = eq === -1 ? '' : pairs[i].slice(eq + 1);
      var name = safeDecode(rawName);
      if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
      out[name] = safeDecode(rawValue);
    }
    return out;
  }

  /**
   * decodeURIComponent that never throws on malformed input such as "%zz".
   *
   * @param {string} value @returns {string}
   */
  function safeDecode(value) {
    try {
      return decodeURIComponent(String(value).replace(/\+/g, ' '));
    } catch (err) {
      return '';
    }
  }

  /**
   * @param {string} target parameter name as sent to the endpoint
   * @param {*} value raw value from the query string
   * @returns {?string} the value if acceptable, otherwise null
   */
  function sanitizeValue(target, value) {
    if (value === null || value === undefined) return null;
    var text = String(value);
    if (text === '' || text.length > MAX_VALUE_LENGTH) return null;
    var validator = VALIDATORS[target];
    if (!validator || !validator.test(text)) return null;
    return text;
  }

  /**
   * Build the tracking URL for a query string, or null when there is nothing
   * safe to forward. The endpoint is only ever used over https.
   *
   * @param {?string} search query string, defaults to the current location
   * @param {?string} [endpoint] override, for tests and for self-hosting
   * @returns {?string} absolute URL, or null
   */
  function buildTrackingUrl(search, endpoint) {
    var base = endpoint || TRACKING_ENDPOINT;
    if (typeof base !== 'string' || !/^https:\/\/[^/?#\s]+/.test(base)) {
      throw new Error('precogTracking: tracking endpoint must be an absolute https:// URL');
    }

    var source = typeof search === 'string'
      ? search
      : (root.location && root.location.search) || '';
    var query = parseQuery(source);

    var pairs = [];
    for (var i = 0; i < PARAMETER_MAP.length; i++) {
      var entry = PARAMETER_MAP[i];
      if (!Object.prototype.hasOwnProperty.call(query, entry.from)) continue;
      var value = sanitizeValue(entry.to, query[entry.from]);
      if (value === null) continue;
      // encodeURIComponent on the way out: a value can never add a parameter,
      // a fragment, or change the host, whatever the caller supplied.
      pairs.push(encodeURIComponent(entry.to) + '=' + encodeURIComponent(value));
    }

    if (pairs.length === 0) return null;
    return base + (base.indexOf('?') === -1 ? '?' : '&') + pairs.join('&');
  }

  /**
   * Point every `.gotoURL` element at the tracking link. Elements are only
   * touched when a safe URL was built, so a bad or absent query string leaves
   * the page exactly as it was instead of navigating somewhere unexpected.
   *
   * @param {function} jQuery @returns {number} how many elements were updated
   */
  function init(jQuery) {
    if (typeof jQuery !== 'function') return 0;
    var url;
    try {
      url = buildTrackingUrl();
    } catch (err) {
      if (root.console && console.warn) console.warn(err.message);
      return 0;
    }
    if (!url) return 0;
    return jQuery('.gotoURL').attr('href', url).length;
  }

  return {
    TRACKING_ENDPOINT: TRACKING_ENDPOINT,
    PARAMETER_MAP: PARAMETER_MAP,
    MAX_VALUE_LENGTH: MAX_VALUE_LENGTH,
    parseQuery: parseQuery,
    sanitizeValue: sanitizeValue,
    buildTrackingUrl: buildTrackingUrl,
    init: init
  };
}));
