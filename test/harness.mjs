/**
 * test/harness.mjs - test doubles for the browser scripts.
 *
 * The site has no build step and no dependencies, so there is nothing to
 * import the browser code with. Instead these helpers execute the real,
 * shipped source files inside a `node:vm` context with fake jQuery and fake
 * timers. That means the tests exercise the exact bytes that go to production
 * rather than a copy that can drift.
 *
 * Standard library only.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Execute a repository file as a classic script in a sandbox.
 *
 * The sandbox provides `module` so the files that guard their exports with
 * `typeof module === 'object'` can be read back, which keeps the production
 * files free of test-only branches.
 *
 * @param {string} relativePath e.g. 'timer.js'
 * @param {Object} [globals] extra globals, e.g. { jQuery }
 * @returns {Object} the sandbox, after the script has run
 */
export function loadScript(relativePath, globals = {}) {
  const filename = join(REPO_ROOT, ...relativePath.split('/'));
  const code = readFileSync(filename, 'utf8');
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    module: { exports: {} },
    ...globals,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relativePath });
  return sandbox;
}

/**
 * Controllable setInterval/clearInterval pair: no test ever waits on a real
 * clock, and the tests can assert that a timer was actually stopped.
 */
export function createFakeClock() {
  const timers = new Map();
  let nextId = 1;

  return {
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    /** How many intervals are still running. */
    get activeCount() {
      return timers.size;
    },
    /** Fire every running interval once, `times` times. */
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const timer of [...timers.values()]) timer.fn();
      }
    },
  };
}

/** A stand-in for a DOM element that records what the script did to it. */
export function createElement(name, options = {}) {
  return {
    name,
    htmlValue: '',
    cssValue: {},
    /** false models an element that has left the document. */
    inDocument: options.inDocument ?? true,
    /** null models a parent with no layout, i.e. jQuery's offset() -> null. */
    parentOffset: options.parentOffset === undefined ? 0 : options.parentOffset,
    scrollTop: options.scrollTop ?? 0,
  };
}

/**
 * The smallest jQuery surface the first-party scripts actually use.
 * Anything not implemented here is a bug in a script, not a gap in the double.
 */
export function createFakeJQuery() {
  function Wrapper(nodes) {
    this.nodes = nodes;
    this.length = nodes.length;
  }

  Wrapper.prototype.each = function each(callback) {
    this.nodes.forEach((node, index) => callback.call(node, index, node));
    return this;
  };

  Wrapper.prototype.html = function html(value) {
    if (value === undefined) return this.nodes[0]?.htmlValue;
    this.nodes.forEach((node) => {
      node.htmlValue = value;
    });
    return this;
  };

  Wrapper.prototype.css = function css(value) {
    this.nodes.forEach((node) => Object.assign(node.cssValue, value));
    return this;
  };

  Wrapper.prototype.closest = function closest(selector) {
    const inDocument = this.nodes[0]?.inDocument ?? false;
    return new Wrapper(selector === 'body' && inDocument ? [createElement('body')] : []);
  };

  Wrapper.prototype.parent = function parent() {
    const offset = this.nodes[0]?.parentOffset;
    return new Wrapper([{ name: 'parent', parentOffset: offset }]);
  };

  Wrapper.prototype.offset = function offset() {
    const top = this.nodes[0]?.parentOffset;
    return top === null || top === undefined ? null : { top };
  };

  Wrapper.prototype.scrollTop = function scrollTop() {
    return this.nodes[0]?.scrollTop ?? 0;
  };

  Wrapper.prototype.attr = function attr(name, value) {
    if (value === undefined) return this.nodes[0]?.attrs?.[name];
    this.nodes.forEach((node) => {
      node.attrs = node.attrs ?? {};
      node.attrs[name] = value;
    });
    return this;
  };

  function jQuery(target) {
    if (target && target.__fakeJQuerySet) return new Wrapper(target.__fakeJQuerySet);
    if (typeof target === 'function') {
      target(jQuery);
      return new Wrapper([]);
    }
    if (typeof target === 'string') {
      const elements = jQuery.registry.get(target);
      return new Wrapper(elements ? [...elements] : []);
    }
    if (target === undefined || target === null) return new Wrapper([]);
    return new Wrapper([target]);
  }

  jQuery.fn = Wrapper.prototype;
  /** Selectors the fake resolves, e.g. '.gotoURL' -> [element]. */
  jQuery.registry = new Map();
  /** jQuery(elements) - build a set from existing fakes. */
  jQuery.set = (elements) => {
    const set = [...elements];
    set.__fakeJQuerySet = set;
    return jQuery(set);
  };
  /** Register the elements a selector should resolve to. */
  jQuery.register = (selector, elements) => jQuery.registry.set(selector, [...elements]);

  return jQuery;
}

// This module deliberately contains no test() calls: it is imported by every
// test file, and node:test would then run those tests once per importer. Its
// own tests live in test/harness.test.js.
