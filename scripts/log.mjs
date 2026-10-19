#!/usr/bin/env node
/**
 * scripts/log.mjs - one-line JSON logging for the development server.
 *
 * Why this exists: the server used to fail silently. A read stream that errored
 * called `res.destroy()` and nothing was written anywhere, so "the page is
 * blank" and "the server is broken" were indistinguishable. Silent failure in a
 * tool is a security problem as well as a debugging one - a request that was
 * refused, and a request that was served, looked identical from the outside.
 *
 * The format is one JSON object per line (logfmt-shaped, JSON-encoded) because
 * that is the one shape that is greppable by a human, parseable by `jq`, and
 * ingestible by a log shipper without a parser.
 *
 * Two properties matter more than the format:
 *   - Logging must never throw. JSON.stringify() throws on a circular object,
 *     on a BigInt, and it renders an Error as `{}`. An error logger that can
 *     crash the thing it is logging is worse than no logger, so values are
 *     normalised defensively and a field that cannot be serialised is replaced
 *     rather than propagated.
 *   - Values are logged as they are, but access logs record the request target,
 *     not the request body. This server never has a body; that is asserted by
 *     the 405 on everything except GET/HEAD.
 *
 * Standard library only.
 */

/** Fields that are always present, in this order, whatever the caller logs. */
const LEVELS = ['debug', 'info', 'warn', 'error'];

const LEVEL_RANK = LEVELS.reduce((rank, level, index) => {
  rank[level] = index;
  return rank;
}, /** @type {Record<string, number>} */ ({}));

/**
 * Coerce an arbitrary value into something JSON.stringify can handle.
 *
 * @param {*} value
 * @param {number} [depth] recursion guard for self-referential structures
 * @returns {*} something serialisable
 */
export function toLogValue(value, depth = 0) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string') return value.length > 512 ? `${value.slice(0, 512)}...[truncated]` : value;
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'undefined') return undefined;

  if (type === 'bigint') return `${value}n`;
  if (type === 'symbol') return value.toString();
  if (type === 'function') return `[function ${value.name || 'anonymous'}]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      // An Error's own enumerable properties are lost by JSON.stringify, and
      // `code` is the field that actually identifies a filesystem problem.
      message: value.message,
      code: value.code,
      stack: value.stack,
    };
  }
  if (value instanceof Date) return value.toISOString();

  // Depth and cycle guard: a socket or a request object is a cycle, and an
  // uncaught TypeError here would take down the error path that reported it.
  if (depth > 3) return '[max depth]';
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => toLogValue(entry, depth + 1));

  const out = {};
  for (const key of Object.keys(value).slice(0, 32)) {
    let normalised;
    try {
      normalised = toLogValue(value[key], depth + 1);
    } catch {
      normalised = '[unserialisable]';
    }
    if (normalised !== undefined) out[key] = normalised;
  }
  return out;
}

/**
 * Render one log record. Never throws.
 *
 * @param {string} level
 * @param {string} event stable, greppable name e.g. 'request'
 * @param {Object} [fields]
 * @returns {string} one line, terminated by \n
 */
export function formatRecord(level, event, fields = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields && typeof fields === 'object' ? toLogValue(fields, 1) : { detail: toLogValue(fields, 1) }),
  };
  try {
    return `${JSON.stringify(record)}\n`;
  } catch {
    // Last resort: hand-built, guaranteed serialisable.
    return `${JSON.stringify({ ts: record.ts, level, event, note: 'fields were not serialisable' })}\n`;
  }
}

/**
 * Create a logger.
 *
 * @param {Object} [options]
 * @param {{write: (chunk: string) => unknown}} [options.stdout] sink for info and below
 * @param {{write: (chunk: string) => unknown}} [options.stderr] sink for warn and error
 * @param {string} [options.level] minimum level to emit
 * @param {boolean} [options.enabled] set false to silence the logger entirely
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: Function}}
 */
export function createLogger(options = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    level = 'info',
    enabled = true,
  } = options;

  const minimum = LEVEL_RANK[level] ?? LEVEL_RANK.info;

  /**
   * @param {string} recordLevel
   * @param {string} event
   * @param {Object} [fields]
   */
  function emit(recordLevel, event, fields) {
    if (!enabled || LEVEL_RANK[recordLevel] < minimum) return;
    const sink = LEVEL_RANK[recordLevel] >= LEVEL_RANK.warn ? stderr : stdout;
    try {
      sink.write(formatRecord(recordLevel, event, fields));
    } catch {
      // A logger that throws while reporting a failure is a liability.
    }
  }

  const logger = {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    /**
     * A logger with extra permanent fields, e.g. the port a server bound to.
     * @param {Object} context @returns {ReturnType<typeof createLogger>}
     */
    child(context) {
      const parent = logger;
      const wrap = (recordLevel) => (event, fields) => parent[recordLevel](event, { ...context, ...fields });
      return {
        debug: wrap('debug'),
        info: wrap('info'),
        warn: wrap('warn'),
        error: wrap('error'),
        child: (extra) => parent.child({ ...context, ...extra }),
      };
    },
  };

  return logger;
}

/** A logger that discards everything; the default for library callers. */
export const silentLogger = createLogger({ enabled: false });