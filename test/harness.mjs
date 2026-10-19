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
  const sandbox = createSandbox(globals);
  runInSandbox(sandbox, relativePath);
  return sandbox;
}

/**
 * Execute several shipped files in one sandbox, in order.
 *
 * Needed whenever one file depends on a global another file declares - the
 * chat widget calls the chat bot, and testing that wiring is the point.
 *
 * @param {string[]} relativePaths
 * @param {Object} [globals]
 * @returns {Object} the sandbox, after every script has run
 */
export function loadScripts(relativePaths, globals = {}) {
  const sandbox = createSandbox(globals);
  for (const path of relativePaths) runInSandbox(sandbox, path);
  return sandbox;
}

/** @returns {Object} a fresh sandbox; `runInSandbox` fills it with code. */
export function createSandbox(globals = {}) {
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
  return sandbox;
}

/** Run one repository file inside an existing sandbox. */
export function runInSandbox(sandbox, relativePath) {
  const filename = join(REPO_ROOT, ...relativePath.split('/'));
  const code = readFileSync(filename, 'utf8');
  // The absolute path (not the repo-relative one) is what the coverage runner
  // keys off, so passing it here is what lets `npm run test:coverage` account
  // for the shipped browser code instead of only the Node modules.
  vm.runInContext(code, sandbox, { filename });
  return sandbox;
}

/**
 * Controllable setInterval/clearInterval and setTimeout/clearTimeout pairs: no
 * test ever waits on a real clock, and the tests can assert that a timer was
 * actually stopped.
 */
export function createFakeClock() {
  const timers = new Map();
  const timeouts = new Map();
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
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
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
    /**
     * Run everything currently queued on the timeout queue, including work
     * those callbacks queue themselves. Bounded, so a runaway retry loop fails
     * the test instead of hanging it.
     */
    flush(maxRounds = 50) {
      let fired = 0;
      while (timeouts.size > 0 && fired < maxRounds) {
        for (const [id, timeout] of [...timeouts.entries()]) {
          timeouts.delete(id);
          timeout.fn();
          fired += 1;
        }
      }
      return fired;
    },
    /** How many timeouts are still queued. */
    get pendingTimeouts() {
      return timeouts.size;
    },
  };
}

/** A stand-in for a DOM element that records what the script did to it. */
export function createElement(name, options = {}) {
  return {
    name,
    htmlValue: '',
    textValue: '',
    cssValue: {},
    /** false models an element that has left the document. */
    inDocument: options.inDocument ?? true,
    /** null models a parent with no layout, i.e. jQuery's offset() -> null. */
    parentOffset: options.parentOffset === undefined ? 0 : options.parentOffset,
    scrollTop: options.scrollTop ?? 0,
    scrollHeight: options.scrollHeight ?? 0,
    /** Value of the wrapped <input>, for .val(). */
    value: options.value ?? '',
    /** Classes added with .addClass(). */
    classes: [],
    /** Children looked up with .find(), keyed by selector without the dot. */
    children: {},
    /** Everything passed to .append(). */
    appended: [],
    /** Handlers registered with .on(), keyed by event name. */
    handlers: {},
    /** Animation property maps passed to .animate(). */
    animations: [],
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

  Wrapper.prototype.text = function text(value) {
    if (value === undefined) return this.nodes[0]?.textValue;
    this.nodes.forEach((node) => {
      node.textValue = String(value);
    });
    return this;
  };

  Wrapper.prototype.val = function val(value) {
    if (value === undefined) return this.nodes[0]?.value;
    this.nodes.forEach((node) => {
      node.value = String(value);
    });
    return this;
  };

  Wrapper.prototype.prop = function prop(name, value) {
    if (value === undefined) return this.nodes[0]?.[name];
    this.nodes.forEach((node) => {
      node[name] = value;
    });
    return this;
  };

  /** css({color: 'red'}) and css('display', 'block') are both used. */
  Wrapper.prototype.css = function css(name, value) {
    if (typeof name === 'object') {
      this.nodes.forEach((node) => Object.assign(node.cssValue, name));
      return this;
    }
    this.nodes.forEach((node) => {
      node.cssValue[name] = value;
    });
    return this;
  };

  Wrapper.prototype.addClass = function addClass(name) {
    this.nodes.forEach((node) => node.classes.push(name));
    return this;
  };

  /** Lazily creates the child a selector names, so find('.text') works. */
  Wrapper.prototype.find = function find(selector) {
    const parent = this.nodes[0];
    if (!parent) return new Wrapper([]);
    parent.children = parent.children ?? {};
    const key = selector.replace(/^[.#]/, '');
    parent.children[key] = parent.children[key] ?? createElement(key);
    return new Wrapper([parent.children[key]]);
  };

  Wrapper.prototype.append = function append(child) {
    const nodes = child instanceof Wrapper ? child.nodes : [child];
    this.nodes.forEach((node) => node.appended.push(...nodes));
    return this;
  };

  Wrapper.prototype.on = function on(event, handler) {
    this.nodes.forEach((node) => {
      node.handlers[event] = handler;
    });
    return this;
  };

  Wrapper.prototype.stop = function stop() {
    return this;
  };

  Wrapper.prototype.animate = function animate(properties) {
    this.nodes.forEach((node) => node.animations.push(properties));
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
      // A leading '<' is an HTML literal, the way the chat widget builds a
      // transcript line; anything else is a selector lookup.
      if (target.trim().startsWith('<')) {
        const tag = target.trim().slice(1).split(/[\s>/]/)[0] || 'div';
        return new Wrapper([createElement(tag)]);
      }
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
